import type { ClockPort } from '../../contracts/src/index.ts';

/** Node's `ClockPort` implementation: `setTimeout`/`performance.now()`, with cancellation
 * (`CancellationSource`) able to wake a pending `sleep` and clear its timer -- otherwise a
 * long sleep (e.g. the language session's healthy-window reset) would keep the event loop
 * alive after quit. */
export function createNodeClock(): ClockPort {
  return {
    monotonicMilliseconds: () => performance.now(),
    schedule: (delayMilliseconds, callback) => {
      const timer = setTimeout(callback, Math.max(0, delayMilliseconds));
      return { dispose: () => clearTimeout(timer) };
    },
    sleep: async (delayMilliseconds, cancellation) => {
      if (cancellation.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { subscription.dispose(); resolve(); }, Math.max(0, delayMilliseconds));
        const subscription = cancellation.onCancel(() => { clearTimeout(timer); resolve(); });
      });
      return cancellation.isCancelled ? { ok: false, error: { kind: 'cancelled' } } : { ok: true, value: undefined };
    },
  };
}
