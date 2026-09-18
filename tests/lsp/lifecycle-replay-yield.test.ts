#!/usr/bin/env bun
// F1-7 regression: `LanguageServerSession#replayState` materialized and sent every open
// document's `didOpen` back-to-back on a restart, with no macrotask boundary between them. With
// many open documents this stalls the event loop (and the keystroke path) for the whole batch.
// The fix yields (`clock.sleep(0, ...)`) after each document. This test counts sleep(0, ...)
// calls made during replay and asserts one per open document -- 0 before the fix, N after.
import type { ClockPort, Disposable, PlatformFailure, ProcessHandle, ProcessInput, ProcessPort, ProcessSpec, Result } from '../../packages/contracts/src/index';
import { ContentLengthFrameDecoder, encodeContentLengthFrame } from '../../packages/services/language/framing';
import { LanguageServerSession } from '../../packages/services/language';
import type { LanguageServerConfig } from '../../packages/services/config';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type JsonRecord = Record<string, unknown>;

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
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> { return { next: () => this.next() }; }
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
  readonly writes: JsonRecord[] = [];
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
            this.writes.push(message as JsonRecord);
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
  async spawn(_spec: ProcessSpec): Promise<Result<ProcessHandle, PlatformFailure>> {
    const process = new FakeLanguageProcess((message, active) => {
      if (message.method === 'initialize' && Object.hasOwn(message, 'id')) void active.send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
      if (message.method === 'shutdown' && Object.hasOwn(message, 'id')) void active.send({ jsonrpc: '2.0', id: message.id, result: null });
    });
    this.processes.push(process);
    return { ok: true, value: process };
  }
}

class CountingClock implements ClockPort {
  now = 0;
  zeroDelaySleeps = 0;
  monotonicMilliseconds(): number { return this.now; }
  schedule(_delayMilliseconds: number, callback: () => void): Disposable { callback(); return { dispose() {} }; }
  async sleep(delayMilliseconds: number, cancellation: { readonly isCancelled: boolean }): Promise<Result<void, { readonly kind: 'cancelled' }>> {
    if (delayMilliseconds === 0) this.zeroDelaySleeps += 1;
    this.now += delayMilliseconds;
    return cancellation.isCancelled ? { ok: false, error: { kind: 'cancelled' } } : { ok: true, value: undefined };
  }
}

async function waitFor(predicate: () => boolean, message: string, timeoutMilliseconds = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

const config: LanguageServerConfig = Object.freeze({ name: 'fake', command: 'fake-lsp', args: [], rootMarkers: [] });

async function main(): Promise<void> {
  const documentCount = 12;
  const port = new FakeLanguageProcessPort();
  const clock = new CountingClock();
  const session = new LanguageServerSession({ process: port, clock, config, root: '/workspace/f1-7', workspaceId: 'f1-7' });

  for (let i = 0; i < documentCount; i += 1) {
    const admitted = session.openDocument({ uri: `file:///workspace/f1-7/doc-${i}.ts`, languageId: 'typescript', version: 1, text: `const doc${i} = ${i};\n` });
    assert(admitted.ok, `F1-7a document ${i} is admitted before activation`);
  }

  session.activate();
  const ready = await session.waitForReady();
  assert(ready.ok, 'F1-7b session reaches ready with every document replayed');
  assert(session.health.openDocumentCount === documentCount, `F1-7c all ${documentCount} documents are retained`);

  const first = port.processes[0];
  assert(first !== undefined, 'F1-7d the first process exists');
  await waitFor(() => first.writes.filter((message) => message.method === 'textDocument/didOpen').length === documentCount, 'F1-7e every document was replayed via didOpen');

  assert(
    clock.zeroDelaySleeps >= documentCount,
    `F1-7f replayState must yield (clock.sleep(0, ...)) at least once per open document (${documentCount}); observed ${clock.zeroDelaySleeps} zero-delay sleeps -- a restart with many open documents must not stall the event loop for the whole batch`,
  );

  await session.dispose();
  console.log(`F1-7 lifecycle-replay-yield: PASS (documents=${documentCount}, zeroDelaySleeps=${clock.zeroDelaySleeps})`);
}

await main();
