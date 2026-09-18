/** Real CLI evaluation adapter. Only the status surface is replaced; no alternate engine. */
import { useCallback, useState, useSyncExternalStore } from 'react';
import { createRoot, flushSync, useTerminalDimensions } from '@opentui/react';
import { createOpenTuiRenderer, runOpenTuiWorkbench as runCore, type OpenTuiWorkbenchOptions } from '../../packages/ui/src/terminal';
import type { WorkbenchReadPort } from '../../packages/workbench/src/index';
import { LIGHT_WORKBENCH_THEME, type WorkbenchTheme } from '../../packages/ui/theme/workbench-themes';
export { createOpenTuiRenderer } from '../../packages/ui/src/terminal';
export { ContextMenuStore } from '../../packages/ui/src/context-menu';

export async function runOpenTuiWorkbench(workbench: WorkbenchReadPort, label: string, options: OpenTuiWorkbenchOptions): Promise<void> {
  const renderer = await (options.renderer ?? createOpenTuiRenderer());
  const { statusMessage, registerThemeSwitch, ...coreOptions } = options;
  let applyTheme: (theme: WorkbenchTheme) => void = () => {};
  function StatusSurface() {
    const { width, height } = useTerminalDimensions();
    const [theme, setTheme] = useState(options.theme ?? LIGHT_WORKBENCH_THEME);
    applyTheme = setTheme;
    const subscribeStatus = useCallback((notify: () => void) => {
      const subscription = statusMessage?.read.subscribe(notify);
      return () => subscription?.dispose();
    }, []);
    const subscribeCommand = useCallback((notify: () => void) => {
      const command = options.commandLine?.read.subscribe?.(notify);
      const surfaces = options.subscribeSurfaceChanges?.(notify);
      return () => { command?.dispose(); surfaces?.dispose(); };
    }, []);
    const message = useSyncExternalStore(subscribeStatus, () => statusMessage?.read.model);
    const commandOpen = useSyncExternalStore(subscribeCommand, () => options.commandLine?.isOpen() ?? false);
    return <box visible={message !== undefined && !commandOpen} position="absolute" left={0} top={Math.max(0, height - 1)} width={width} height={1} zIndex={130} backgroundColor={theme.background}>
      <text width="100%" height={1} wrapMode="none" fg={message?.kind === 'error' ? theme.error : theme.foreground}>{message?.text ?? ''}</text>
    </box>;
  }
  const root = createRoot(renderer);
  // Mount the same stable, initially hidden surface as Solid before Core attaches
  // the editor/panels. Subsequent commits only change the owned surface.
  flushSync(() => root.render(<StatusSurface />));
  try {
    await runCore(workbench, label, {
      ...coreOptions,
      renderer: Promise.resolve(renderer),
      registerThemeSwitch: (setTheme) => registerThemeSwitch?.((theme) => {
        setTheme(theme);
        applyTheme(theme);
      }),
    });
  } finally {
    root.unmount();
  }
}
