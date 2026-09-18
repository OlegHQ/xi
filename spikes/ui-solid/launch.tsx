/** Same real CLI status replacement as the React candidate, using compiled Solid JSX. */
import { createSignal, onCleanup } from 'solid-js';
import { render, useTerminalDimensions } from '@opentui/solid';
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
    const dimensions = useTerminalDimensions();
    const [theme, setTheme] = createSignal(options.theme ?? LIGHT_WORKBENCH_THEME);
    applyTheme = setTheme;
    const [message, setMessage] = createSignal(statusMessage?.read.model);
    const [commandOpen, setCommandOpen] = createSignal(options.commandLine?.isOpen() ?? false);
    const updateCommand = () => setCommandOpen(options.commandLine?.isOpen() ?? false);
    const status = statusMessage?.read.subscribe(() => setMessage(statusMessage.read.model));
    const command = options.commandLine?.read.subscribe?.(updateCommand);
    const surfaces = options.subscribeSurfaceChanges?.(updateCommand);
    onCleanup(() => { status?.dispose(); command?.dispose(); surfaces?.dispose(); });
    return <box visible={!commandOpen() && message() !== undefined} position="absolute" left={0} top={Math.max(0, dimensions().height - 1)} width={dimensions().width} height={1} zIndex={130} backgroundColor={theme().background}>
        <text width="100%" height={1} wrapMode="none" fg={message()?.kind === 'error' ? theme().error : theme().foreground}>{message()?.text ?? ''}</text>
      </box>;
  }
  // Mount before legacy children; both candidates include framework startup before
  // the usable editor frame. Solid's public render lifecycle disposes on destroy.
  await render(() => <StatusSurface />, renderer);
  try {
    await runCore(workbench, label, {
      ...coreOptions,
      renderer: Promise.resolve(renderer),
      registerThemeSwitch: setTheme => registerThemeSwitch?.(theme => {
        setTheme(theme);
        applyTheme(theme);
      }),
    });
  } finally {
    if (!renderer.isDestroyed) renderer.destroy();
  }
}
