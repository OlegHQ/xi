/** @jsxImportSource @opentui/solid */
import { useTerminalDimensions } from '@opentui/solid';
import type { JSX } from '@opentui/solid';
import { createSignal, onCleanup } from 'solid-js';
import type { Disposable } from '../../../contracts/src/index.ts';
import type { StatusMessageReadPort } from '../../status/index.ts';
import type { WorkbenchTheme } from '../workbench.ts';

export interface StatusSurfaceSpec {
  readonly read: StatusMessageReadPort;
  readonly theme: WorkbenchTheme;
  readonly commandLineOpen: () => boolean;
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
  onCleanup(() => { themeSubscription.dispose(); subscription.dispose(); surfaceSubscription?.dispose(); });

  return (
    <box position="absolute" left={0} top={Math.max(0, dimensions().height - 1)} width="100%" height={1}
      zIndex={130} visible={visible()} backgroundColor={theme().background}>
      <text width="100%" height={1} wrapMode="none" content={message()?.text ?? ''}
        fg={message()?.kind === 'error' ? theme().error : theme().foreground} />
    </box>
  );
}
