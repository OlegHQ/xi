import type { Disposable } from '../../primitives/src/index';

/** Wires SIGTSTP/SIGCONT to the workbench's own suspend/resume hooks (restoring cooked
 * terminal mode etc.) before actually stopping/continuing the process. Idempotent: calling
 * this twice on the same `control` registers the handlers once and disposing either handle
 * removes them both, since `process.on` would otherwise stack duplicate listeners. */
export function installJobControl(control: { readonly suspend: () => void; readonly resume: () => void }): Disposable {
  let disposed = false;
  const handleStop = (): void => {
    control.suspend();
    process.kill(process.pid, 'SIGSTOP');
  };
  const handleContinue = (): void => {
    control.resume();
  };
  process.on('SIGTSTP', handleStop);
  process.on('SIGCONT', handleContinue);
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      process.off('SIGTSTP', handleStop);
      process.off('SIGCONT', handleContinue);
    },
  };
}
