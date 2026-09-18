/** Last-resort crash handling: OpenTUI's own uncaughtException handler only logs and leaves
 * raw mode/the alt screen on (docs/plan/01-architecture.md, ARCH-TERMINAL-RESTORE-01). Any
 * error that escapes every local try/catch and promise chain still needs the terminal restored
 * before the process exits, so this installs a process-wide last resort. */

export interface CrashRestorableRenderer {
  readonly isDestroyed: boolean;
  destroy(): void;
}

export function installCrashHandlers(renderer: Promise<CrashRestorableRenderer>): void {
  let terminalCrashRestored = false;
  const restoreTerminalOnCrash = async (): Promise<void> => {
    if (terminalCrashRestored) return;
    terminalCrashRestored = true;
    const created = await renderer.catch(() => undefined);
    if (created !== undefined && !created.isDestroyed) created.destroy();
  };
  const crashExit = (label: string, error: unknown): void => {
    void restoreTerminalOnCrash().finally(() => {
      process.stderr.write(`xi: ${label}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
      process.exit(1);
    });
  };
  process.on('uncaughtException', (error) => crashExit('uncaught exception', error));
  process.on('unhandledRejection', (reason) => crashExit('unhandled rejection', reason));
}
