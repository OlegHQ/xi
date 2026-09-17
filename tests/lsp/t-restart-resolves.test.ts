import {
  type ClockPort,
  type Disposable,
  type PlatformFailure,
  type ProcessHandle,
  type ProcessInput,
  type ProcessPort,
  type ProcessSpec,
  type Result,
} from '../../packages/contracts/src/index';
import {
  ContentLengthFrameDecoder,
  encodeContentLengthFrame,
} from '../../packages/services/language/framing';
import { LanguageServerSession } from '../../packages/services/language';
import type { LanguageServerConfig } from '../../packages/services/config';

type JsonRecord = Record<string, unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

class ByteQueue implements AsyncIterable<Uint8Array> {
  readonly #values: Uint8Array[] = [];
  readonly #readers: ((result: IteratorResult<Uint8Array>) => void)[] = [];
  #closed = false;

  async push(value: Uint8Array): Promise<void> {
    if (this.#closed) return;
    const reader = this.#readers.shift();
    if (reader !== undefined) reader({ done: false, value });
    else this.#values.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const reader of this.#readers.splice(0)) reader({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return { next: () => this.next() };
  }

  private async next(): Promise<IteratorResult<Uint8Array>> {
    const value = this.#values.shift();
    if (value !== undefined) return { done: false, value };
    if (this.#closed) return { done: true, value: undefined };
    return new Promise((resolve) => this.#readers.push(resolve));
  }
}

class FakeLanguageProcess implements ProcessHandle {
  readonly stdoutQueue = new ByteQueue();
  readonly stderrQueue = new ByteQueue();
  readonly stdout = this.stdoutQueue;
  readonly stderr = this.stderrQueue;
  readonly writes: unknown[] = [];
  readonly stdin: ProcessInput;
  readonly exit: Promise<Result<{ readonly code: number | null; readonly signal: string | null }, PlatformFailure>>;
  #resolveExit!: (result: Result<{ readonly code: number | null; readonly signal: string | null }, PlatformFailure>) => void;
  #finished = false;

  constructor(private readonly onMessage: (message: JsonRecord, process: FakeLanguageProcess) => void) {
    this.exit = new Promise((resolve) => { this.#resolveExit = resolve; });
    const decoder = new ContentLengthFrameDecoder();
    this.stdin = {
      write: async (bytes) => {
        for (const message of decoder.feed(bytes)) {
          if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
            this.writes.push(message);
            this.onMessage(message as JsonRecord, this);
          }
        }
        return { ok: true, value: undefined };
      },
      close: async () => ({ ok: true, value: undefined }),
      dispose() {},
    };
  }

  async send(message: JsonRecord): Promise<void> {
    await this.stdoutQueue.push(encodeContentLengthFrame(new TextEncoder().encode(JSON.stringify(message))));
  }

  finish(code = 1): void {
    if (this.#finished) return;
    this.#finished = true;
    this.stdoutQueue.close();
    this.stderrQueue.close();
    this.#resolveExit({ ok: true, value: { code, signal: null } });
  }

  async terminate(): Promise<void> { this.finish(); }
  dispose(): void { this.finish(); }
}

class FakeLanguageProcessPort implements ProcessPort {
  readonly processes: FakeLanguageProcess[] = [];
  constructor(private readonly capabilities: unknown = { hoverProvider: true }) {}

  async spawn(_spec: ProcessSpec): Promise<Result<ProcessHandle, PlatformFailure>> {
    const process = new FakeLanguageProcess((message, active) => {
      if (message.method === 'initialize' && Object.hasOwn(message, 'id')) {
        void active.send({ jsonrpc: '2.0', id: message.id, result: { capabilities: this.capabilities } });
      }
      if (message.method === 'shutdown' && Object.hasOwn(message, 'id')) {
        void active.send({ jsonrpc: '2.0', id: message.id, result: null });
      }
    });
    this.processes.push(process);
    return { ok: true, value: process };
  }
}

class FakeClock implements ClockPort {
  now = 0;
  delays: number[] = [];
  monotonicMilliseconds(): number { return this.now; }
  schedule(_delayMilliseconds: number, callback: () => void): Disposable { callback(); return { dispose() {} }; }
  async sleep(delayMilliseconds: number, cancellation: { readonly isCancelled: boolean }): Promise<Result<void, { readonly kind: 'cancelled' }>> {
    this.delays.push(delayMilliseconds);
    this.now += delayMilliseconds;
    return cancellation.isCancelled ? { ok: false, error: { kind: 'cancelled' } } : { ok: true, value: undefined };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMilliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMilliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const config: LanguageServerConfig = Object.freeze({ name: 'fake', command: 'fake-lsp', args: [], rootMarkers: ['package.json', '.git'] });

async function testRestartResolvesWithoutConsumingRetry(): Promise<void> {
  const process = new FakeLanguageProcessPort();
  const clock = new FakeClock();
  const session = new LanguageServerSession({
    process,
    clock,
    config,
    root: '/workspace/root-a',
    workspaceId: 'workspace-a',
    retry: { maxRetries: 1, baseDelayMilliseconds: 1, maxDelayMilliseconds: 2 },
    // The fake process never exits on its own; keep transport disposal's
    // exit-wait/terminate fallback short so restart() resolves promptly.
    shutdownTimeoutMilliseconds: 20,
  });
  session.activate();
  const ready = await session.waitForReady();
  assert(ready.ok, 'fake server reaches ready state before restart');
  equal(process.processes.length, 1, 'exactly one process before restart');

  await withTimeout(session.restart(), 3_000, 'restart() did not resolve within timeout');

  equal(session.state, 'ready', 'restart reaches ready again, not failed');
  equal(session.health.retries, 0, 'explicit restart does not consume a retry');
  equal(process.processes.length, 2, 'restart replaces the transport with a fresh process');

  await session.dispose();
}

await testRestartResolvesWithoutConsumingRetry();
console.log('t-restart-resolves passed: restart() resolves without a spurious failure/retry');
