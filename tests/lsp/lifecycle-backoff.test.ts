#!/usr/bin/env bun
// Regression coverage for two lifecycle bugs during retry backoff:
// 1. activate() called while a startCycle() is asleep in its own retry backoff (state
//    'failed' but the cycle has not finished) must not start a second concurrent cycle
//    (which would leak a second process).
// 2. restart() called during 'starting' or during a backoff sleep must resolve promptly,
//    not hang until the full backoff delay elapses.
import type { ClockPort, Disposable, PlatformFailure, ProcessPort, ProcessSpec, Result } from '../../packages/contracts/src/index';
import { LanguageServerSession } from '../../packages/services/language';
import type { LanguageServerConfig } from '../../packages/services/config';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** A clock whose sleep() stays pending until releaseNext() is called, or resolves early on
 * cancellation, mirroring the real clock's cancellable sleep contract. */
class HoldableClock implements ClockPort {
  now = 0;
  #pending: ((result: Result<void, { readonly kind: 'cancelled' }>) => void)[] = [];
  monotonicMilliseconds(): number { return this.now; }
  schedule(_delayMilliseconds: number, callback: () => void): Disposable { callback(); return { dispose() {} }; }
  sleep(delayMilliseconds: number, cancellation: { readonly isCancelled: boolean; readonly onCancel: (listener: () => void) => Disposable }): Promise<Result<void, { readonly kind: 'cancelled' }>> {
    this.now += delayMilliseconds;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: Result<void, { readonly kind: 'cancelled' }>) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      if (cancellation.isCancelled) { finish({ ok: false, error: { kind: 'cancelled' } }); return; }
      cancellation.onCancel(() => finish({ ok: false, error: { kind: 'cancelled' } }));
      this.#pending.push(finish);
    });
  }
  releaseNext(): void {
    const next = this.#pending.shift();
    next?.({ ok: true, value: undefined });
  }
}

function alwaysFailingSpawnPort(callCount: { value: number }): ProcessPort {
  return {
    async spawn(_spec: ProcessSpec): Promise<Result<never, PlatformFailure>> {
      callCount.value += 1;
      return { ok: false, error: { code: 'ECONNREFUSED', message: 'injected spawn failure', retryable: true } };
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMilliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMilliseconds); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const config: LanguageServerConfig = Object.freeze({ name: 'fake', command: 'fake-lsp', args: [], rootMarkers: ['package.json', '.git'] });

async function testActivateDuringBackoffDoesNotDoubleSpawn(): Promise<void> {
  const callCount = { value: 0 };
  const clock = new HoldableClock();
  const session = new LanguageServerSession({
    process: alwaysFailingSpawnPort(callCount),
    clock,
    config,
    root: '/workspace/backoff-a',
    workspaceId: 'backoff-a',
    retry: { maxRetries: 5, baseDelayMilliseconds: 1000, maxDelayMilliseconds: 2000 },
  });
  session.activate();
  // Let the first (synchronous-failure) spawn attempt run and reach its backoff sleep.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert(callCount.value === 1, `T-BACKOFF-01 exactly one spawn before backoff, got ${callCount.value}`);
  assert(session.state === 'failed', `T-BACKOFF-02 session is backing off (state 'failed'), got ${session.state}`);

  session.activate();
  session.activate();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert(callCount.value === 1, `T-BACKOFF-03 activate() during backoff must not start a second concurrent cycle, got ${callCount.value} spawns`);

  clock.releaseNext();
  await session.dispose();
}

async function testRestartDuringBackoffResolves(): Promise<void> {
  const callCount = { value: 0 };
  const clock = new HoldableClock();
  const session = new LanguageServerSession({
    process: alwaysFailingSpawnPort(callCount),
    clock,
    config,
    root: '/workspace/backoff-b',
    workspaceId: 'backoff-b',
    retry: { maxRetries: 5, baseDelayMilliseconds: 5_000, maxDelayMilliseconds: 10_000 },
  });
  session.activate();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert(session.state === 'failed', 'T-BACKOFF-04 session reaches its backoff before restart is requested');

  // restart() must not need the 5s backoff to elapse (nor a manual clock.releaseNext()) to
  // resolve: it cancels the pending backoff itself.
  await withTimeout(session.restart().catch(() => {}), 2_000, 'T-BACKOFF-05 restart() hung during retry backoff instead of resolving');

  await session.dispose();
}

async function main(): Promise<void> {
  await testActivateDuringBackoffDoesNotDoubleSpawn();
  await testRestartDuringBackoffResolves();
  console.log('T-LIFECYCLE-BACKOFF passed: activate() cannot double-spawn during backoff and restart() resolves during backoff');
}

await main();
