#!/usr/bin/env bun
// F1-2 regression: `recordFailure`'s "was this session healthy long enough to reset the retry
// counter" check read `#readyAt` but never cleared it. Once a session had been ready for a full
// healthy window, every LATER failure -- even from a replacement process that never reaches
// 'ready' again -- kept reading that same stale `#readyAt`, so it stayed "just healthy" forever
// and reset `#retries` to 0 on every single failure. That bypasses `maxRetries` entirely: the
// session respawns at the minimum backoff forever instead of eventually giving up in state
// 'failed'. The capped process port below is the timeout guard the preamble asks for: instead of
// waiting on a real unbounded respawn storm, it freezes (never resolves) once attempts exceed a
// generous cap, so a regression fails a bounded `waitFor` instead of hanging the test process.
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
          if (message !== null && typeof message === 'object' && !Array.isArray(message)) this.onMessage(message as JsonRecord, this);
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

/** Spawns exactly one process that reaches 'ready'; every later attempt fails (retryable) up to
 * `cap`, then freezes (never resolves) so a still-runaway respawn loop cannot hang the test. */
class OnceThenCappedFailingProcessPort implements ProcessPort {
  attempts = 0;
  readonly processes: FakeLanguageProcess[] = [];
  constructor(private readonly cap: number) {}
  async spawn(_spec: ProcessSpec): Promise<Result<ProcessHandle, PlatformFailure>> {
    this.attempts += 1;
    if (this.attempts === 1) {
      const process = new FakeLanguageProcess((message, active) => {
        if (message.method === 'initialize' && Object.hasOwn(message, 'id')) void active.send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
        if (message.method === 'shutdown' && Object.hasOwn(message, 'id')) void active.send({ jsonrpc: '2.0', id: message.id, result: null });
      });
      this.processes.push(process);
      return { ok: true, value: process };
    }
    if (this.attempts <= this.cap) return { ok: false, error: { code: 'EAGAIN', message: 'injected launch failure', retryable: true } };
    return new Promise<Result<ProcessHandle, PlatformFailure>>(() => {});
  }
}

class FakeClock implements ClockPort {
  now = 0;
  monotonicMilliseconds(): number { return this.now; }
  schedule(_delayMilliseconds: number, callback: () => void): Disposable { callback(); return { dispose() {} }; }
  async sleep(delayMilliseconds: number, cancellation: { readonly isCancelled: boolean }): Promise<Result<void, { readonly kind: 'cancelled' }>> {
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
  const cap = 40;
  const port = new OnceThenCappedFailingProcessPort(cap);
  const clock = new FakeClock();
  const maxRetries = 3;
  const healthyWindowMilliseconds = 1_000;
  const session = new LanguageServerSession({
    process: port,
    clock,
    config,
    root: '/workspace/f1-2',
    workspaceId: 'f1-2',
    retry: { maxRetries, baseDelayMilliseconds: 1, maxDelayMilliseconds: 2, healthyWindowMilliseconds },
  });
  session.activate();
  await waitFor(() => session.state === 'ready', 'F1-2a session reaches ready on the first (only successful) process');
  // The background scheduleHealthyReset sleep advances the fake clock past healthyWindowMilliseconds
  // itself (its own legitimate "stayed healthy" reset); wait for it so the first failure below is
  // judged against a genuinely-old #readyAt, exactly like the real "healthy for 30s, then the
  // connection dies" scenario the finding describes.
  await waitFor(() => clock.now >= healthyWindowMilliseconds, 'F1-2b background healthy-reset sleep advances the clock past the healthy window');

  const first = port.processes[0];
  assert(first !== undefined, 'F1-2c the first process exists');
  first.finish(); // Crash the only process that ever reaches 'ready'; every replacement attempt
  // fails before ever reaching 'ready' again, so #readyAt (if never cleared) stays stuck at the
  // original stale timestamp for every later recordFailure() call.

  // Fixed: retries grow 1,2,3,4 and the session gives up once retries > maxRetries -- a bounded
  // total of 1 (success) + maxRetries (failed retries) = maxRetries + 1 spawns, then state
  // settles at 'failed' and stops. Buggy: every failure resets retries to 0 via the stale
  // #readyAt, so shouldRetry() is always true and the port is driven straight through its cap.
  await waitFor(() => port.attempts >= maxRetries + 1 || port.attempts > cap, 'F1-2d session never stops respawning (or never even reaches the expected bounded attempt count)');

  // Give any further (buggy, unbounded) retries a moment to pile up before asserting the bound.
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert(port.attempts <= maxRetries + 1, `F1-2e spawn attempts must be bounded by maxRetries (${maxRetries}); observed ${port.attempts} (cap was ${cap}) -- the stale #readyAt reset the retry counter on every failure`);
  assert(session.health.retries <= maxRetries + 1, `F1-2f health.retries must respect maxRetries (${maxRetries}); observed ${session.health.retries}`);
  assert(session.state === 'failed', `F1-2g session settles in terminal 'failed' state, observed ${session.state}`);

  await session.dispose();
  console.log(`F1-2 lifecycle-healthy-reset: PASS (attempts=${port.attempts}, retries=${session.health.retries})`);
}

await main();
