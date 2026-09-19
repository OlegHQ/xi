/** @jsxImportSource @opentui/solid */
import { useTerminalDimensions } from '@opentui/solid';
import type { JSX } from '@opentui/solid';
import type { MouseEvent } from '@opentui/core/renderer';
import { createSignal, onCleanup } from 'solid-js';
import type { Disposable } from '../../../contracts/src/index';
import type { WorkbenchReadPort } from '../../../workbench/src/index';
import type { SidebarReadModel, WorkbenchTabSnapshot } from '../../../workbench/src/entrypoints/launch';
import { calculateWorkbenchLayout, computeSidebarTabLayout, computeTabLayout, type SidebarTabId, type WorkbenchTheme } from '../workbench';

export interface ChromeSurfaceSpec {
  readonly workbench: WorkbenchReadPort;
  readonly theme: WorkbenchTheme;
  readonly fileLabel: string;
  readonly ascii?: boolean;
  readonly gitBranch?: () => string | undefined;
  readonly sidebar?: () => SidebarReadModel;
  readonly tabs?: () => readonly WorkbenchTabSnapshot[];
  readonly showBottomPanel: boolean;
  readonly subscribe?: (listener: () => void) => Disposable;
  readonly onPointer?: (event: MouseEvent) => void;
}

export function ChromeSurface(spec: ChromeSurfaceSpec & { readonly setTheme: (setter: (theme: WorkbenchTheme) => void) => Disposable }): JSX.Element {
  const dimensions = useTerminalDimensions();
  const [theme, setTheme] = createSignal(spec.theme);
  const [version, setVersion] = createSignal(0);
  const [hoveredTabId, setHoveredTabId] = createSignal<string>();
  const [hoveredSidebarTabId, setHoveredSidebarTabId] = createSignal<SidebarTabId>();
  const themeSubscription = spec.setTheme(nextTheme => setTheme(nextTheme));
  const subscription = spec.subscribe?.(() => setVersion(value => value + 1));
  onCleanup(() => { themeSubscription.dispose(); subscription?.dispose(); });

  const layout = () => {
    version();
    const size = dimensions();
    return calculateWorkbenchLayout(size.width, size.height, spec.showBottomPanel, spec.sidebar?.().width);
  };
  const sidebarSections = () => {
    version();
    const sidebar = spec.sidebar?.();
    const chevron = (expanded: boolean): string => (spec.ascii === true ? (expanded ? 'v' : '>') : (expanded ? '▾' : '▸'));
    if (sidebar === undefined) return `${spec.ascii === true ? '> ' : '▾ '}${spec.fileLabel}\n${spec.ascii === true ? '> ' : '  '}Outline`;
    return <>
      {sidebar.sections.map((section, index) => <span style={{
        fg: section.expanded ? theme().foreground : theme().muted,
        bg: theme().surface,
        bold: section.expanded,
      }}>{`${chevron(section.expanded)} ${section.label}${index + 1 < sidebar.sections.length ? '\n' : ''}`}</span>)}
    </>;
  };
  const sidebarTabs = () => {
    version();
    const active = spec.sidebar?.().panel ?? 'files';
    const icons: Record<SidebarTabId, string> = spec.ascii === true
      ? { files: 'F', search: '/', git: 'G' }
      : { files: '󰉋', search: '', git: '' };
    const labels: Record<SidebarTabId, string> = { files: 'Files', search: 'Search', git: 'Git' };
    return computeSidebarTabLayout(layout().sidebarWidth).map(entry => {
      const selected = entry.id === active;
      const hovered = entry.id === hoveredSidebarTabId();
      const background = selected ? theme().accent : hovered ? theme().surfaceActive : theme().surface;
      const foreground = selected ? theme().background : theme().foreground;
      return <box position="absolute" left={entry.x} top={0} width={entry.width} height={1} backgroundColor={background}>
        <text fg={foreground}>
          <span style={{ fg: selected ? theme().background : theme().accent, bg: background, bold: true }}>{` ${icons[entry.id]} `}</span>
          <span style={{ fg: foreground, bg: background, bold: selected }}>{labels[entry.id]}</span>
        </text>
      </box>;
    });
  };
  const statusLine = () => {
    version();
    const view = spec.workbench.activeViewId === undefined ? undefined : spec.workbench.readView(spec.workbench.activeViewId);
    const count = view?.selections.members.length ?? 0;
    const mode = view?.session.mode.toUpperCase() ?? 'NORMAL';
    const branch = spec.gitBranch?.();
    const line = ` ${mode}   ${spec.fileLabel}${branch === undefined ? '' : ` (${branch})`}   ${count} cursor${count === 1 ? '' : 's'}`;
    return line;
  };
  const tabContent = () => {
    version();
    const tabs = spec.tabs?.();
    if (tabs === undefined) return `  ${spec.fileLabel}`;
    const width = Math.max(1, layout().editorWidth);
    return computeTabLayout(tabs, width).map(entry => {
      if (entry.tab === undefined) return <span style={{ fg: theme().muted, bg: theme().surface }}>…</span>;
      const tab = entry.tab;
      const closeWidth = entry.hasClose ? 3 : 0;
      const labelWidth = Math.max(0, entry.width - closeWidth);
      const label = `${tab.label}${tab.dirty ? ' ●' : ''}`.slice(0, labelWidth).padEnd(labelWidth);
      const close = entry.hasClose ? ` ${spec.ascii === true ? 'x' : '×'} ` : '';
      const background = tab.active ? theme().accent : hoveredTabId() === String(tab.id) ? theme().surfaceActive : theme().surface;
      const foreground = tab.active ? theme().background : tab.preview ? theme().muted : theme().foreground;
      return <span style={{ fg: foreground, bg: background, bold: tab.active, italic: tab.preview }}>{`${label}${close}`}</span>;
    });
  };
  const onMouse = (event: MouseEvent): void => {
    if (event.type === 'move' || event.type === 'over') {
      const current = layout();
      const sidebarEntry = event.y === 0 && event.x >= 0 && event.x < current.sidebarWidth
        ? computeSidebarTabLayout(current.sidebarWidth).find(candidate => event.x >= candidate.x && event.x < candidate.x + candidate.width)
        : undefined;
      setHoveredSidebarTabId(sidebarEntry?.id);
      const column = event.x - current.editorX;
      const entry = event.y === 0
        ? computeTabLayout(spec.tabs?.() ?? [], Math.max(1, current.editorWidth)).find(candidate => candidate.tab !== undefined && column >= candidate.x && column < candidate.x + candidate.width)
        : undefined;
      setHoveredTabId(entry?.tab === undefined ? undefined : String(entry.tab.id));
    } else if (event.type === 'out') {
      setHoveredTabId(undefined);
      setHoveredSidebarTabId(undefined);
    }
    spec.onPointer?.(event);
  };

  return (
    <box position="absolute" left={0} top={0} width="100%" height="100%" zIndex={2} onMouse={onMouse}>
      <box position="absolute" left={0} top={0} width={layout().sidebarWidth} height={layout().statusRow}
        visible={layout().sidebarVisible} backgroundColor={theme().surface}>
        {sidebarTabs()}
        <text position="absolute" left={0} top={1} fg={theme().foreground}>{sidebarSections()}</text>
      </box>
      <box position="absolute" left={layout().sidebarWidth} top={0} width={1} height={layout().statusRow}
        visible={layout().sidebarVisible} backgroundColor={theme().border} />
      <box position="absolute" left={layout().editorX} top={0} width={layout().editorWidth} height={1} backgroundColor={theme().surfaceActive}>
        <text fg={theme().foreground}>{tabContent()}</text>
      </box>
      <box position="absolute" left={layout().editorX} top={layout().bottomTop} width={layout().editorWidth} height={layout().bottomHeight}
        visible={layout().bottomHeight > 0} backgroundColor={theme().surface}>
        <text fg={theme().foreground}>Problems 0   Output   Tasks</text>
      </box>
      <box position="absolute" left={0} top={layout().statusRow} width="100%" height={1} backgroundColor={theme().surface}>
        <text fg={theme().foreground}>{statusLine()}</text>
      </box>
    </box>
  );
}
