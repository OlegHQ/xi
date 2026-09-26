/** @jsxImportSource @opentui/solid */
import { useTerminalDimensions } from '@opentui/solid';
import type { JSX } from '@opentui/solid';
import { createSignal, onCleanup } from 'solid-js';
import type { Disposable } from '../../../contracts/src/index.ts';
import { readableTextColor } from '../../theme/readability';
import type { StatusMessageReadPort } from '../../status/index.ts';
import { helixTextAttributes, helixThemeColor, helixThemeStyle, type WorkbenchTheme } from '../workbench';

export interface StatusSurfaceSpec {
  readonly read: StatusMessageReadPort;
  readonly theme: WorkbenchTheme;
  readonly commandLineOpen: () => boolean;
  readonly aboveStatusLine?: () => boolean;
  readonly subscribe?: ((listener: () => void) => Disposable) | undefined;
  readonly setTheme: (setter: (theme: WorkbenchTheme) => void) => Disposable;
}

export function StatusSurface(props: StatusSurfaceSpec): JSX.Element {
  const dimensions = useTerminalDimensions();
  const [theme, setTheme] = createSignal(props.theme);
  const [message, setMessage] = createSignal(props.read.model);
  const [version, setVersion] = createSignal(0);
  const subscription: Disposable = props.read.subscribe(() => setMessage(props.read.model));
  const surfaceSubscription = props.subscribe?.(() => setVersion(value => value + 1));
  const themeSubscription = props.setTheme(nextTheme => setTheme(nextTheme));
  const visible = () => {
    version();
    return !props.commandLineOpen() && message() !== undefined;
  };
  const row = () => { version(); return Math.max(0, dimensions().height - (props.aboveStatusLine?.() === true ? 2 : 1)); };
  onCleanup(() => { themeSubscription.dispose(); subscription.dispose(); surfaceSubscription?.dispose(); });

  return (
    <box position="absolute" left={0} top={row()} width="100%" height={1}
      zIndex={130} visible={visible()} backgroundColor={helixThemeColor(theme(), 'ui.statusline', 'bg', theme().background)}>
      <text width="100%" height={1} wrapMode="none"
        fg={readableTextColor(message()?.kind === 'error' ? helixThemeColor(theme(), 'error', 'fg', theme().error) : helixThemeColor(theme(), 'ui.statusline', 'fg', theme().foreground), helixThemeColor(theme(), 'ui.statusline', 'bg', theme().background), theme().foreground)}>
        <span style={helixTextAttributes(helixThemeStyle(theme(), message()?.kind === 'error' ? 'error' : 'ui.statusline'))}>{message()?.text ?? ''}</span>
      </text>
    </box>
  );
}
