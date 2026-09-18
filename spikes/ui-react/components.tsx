import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { useTerminalDimensions } from '@opentui/react';
import type { Disposable } from '../../packages/contracts/src/index';
import type { ProblemsReadPort } from '../../packages/ui/problems/index';
import type { StatusMessageReadPort } from '../../packages/ui/status/index';
import { LIGHT_WORKBENCH_THEME, type WorkbenchTheme } from '../../packages/ui/theme/workbench-themes';

const Theme = createContext<WorkbenchTheme>(LIGHT_WORKBENCH_THEME);

// Xi controllers remain the state owners. Unchanged reads must retain snapshot identity.
function useModel<T>(source: { readonly model: T; subscribe(listener: (model: T) => void): Disposable }): T {
  const subscribe = useCallback((notify: () => void) => {
    const subscription = source.subscribe(notify);
    return () => subscription.dispose();
  }, [source]);
  const read = useCallback(() => source.model, [source]);
  return useSyncExternalStore(subscribe, read);
}

export function Panel({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const theme = useContext(Theme);
  return <box width="100%" flexDirection="column" border borderColor={theme.border} backgroundColor={theme.surface} paddingX={1}>
    <text height={1} fg={theme.accent}>{title}</text>
    {children}
  </box>;
}

function Row({ children, error = false, onSelect }: { readonly children: string; readonly error?: boolean; readonly onSelect?: (() => void) | undefined }) {
  const theme = useContext(Theme);
  return <text height={1} width="100%" wrapMode="none" fg={error ? theme.error : theme.foreground}
    onMouseDown={() => onSelect?.()}>{children}</text>;
}

export function ProblemsPanel({ source, offset, rows, onSelect }: {
  readonly source: ProblemsReadPort;
  readonly offset: number;
  readonly rows: number;
  readonly onSelect: (id: string) => void;
}) {
  const model = useModel(source);
  // Only visible rows become React nodes, regardless of diagnostics collection size.
  const start = Math.max(0, Math.min(offset, model.all.length - rows));
  return <Panel title={`Problems ${model.all.length}`}>
    {model.all.length === 0 ? <Row>No problems</Row> : model.all.slice(start, start + rows).map(problem =>
      <Row key={problem.id} error={problem.severity === 1} onSelect={() => onSelect(problem.id)}>
        {`${problem.uri}:${problem.range.startLine + 1} ${problem.message}`}
      </Row>)}
  </Panel>;
}

export function MessagesPanel({ source }: { readonly source: StatusMessageReadPort }) {
  const model = useModel(source);
  return <Panel title="Messages">
    <Row error={model?.kind === 'error'}>{model?.text ?? 'No messages'}</Row>
  </Panel>;
}

export function Shell({ theme, problems, messages, offset, onSelect, children }: {
  readonly theme: WorkbenchTheme;
  readonly problems: ProblemsReadPort;
  readonly messages: StatusMessageReadPort;
  readonly offset: number;
  readonly onSelect: (id: string) => void;
  readonly children: ReactNode;
}) {
  const { width, height } = useTerminalDimensions();
  return <Theme.Provider value={theme}>
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background}>
      <text height={1} fg={theme.accent}>Xi · declarative UI evaluation</text>
      <box flexGrow={1} flexDirection={width < 80 ? 'column' : 'row'}>
        <box flexGrow={1} minHeight={1}>{children}</box>
        <box width={width < 80 ? '100%' : 48} flexDirection="column">
          <ProblemsPanel source={problems} offset={offset} rows={Math.max(1, Math.min(8, height - 11))} onSelect={onSelect} />
          <MessagesPanel source={messages} />
        </box>
      </box>
      <text height={1} fg={theme.muted}>j/k scroll · t theme · m message · q quit</text>
    </box>
  </Theme.Provider>;
}
