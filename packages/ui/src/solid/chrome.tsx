/** @jsxImportSource @opentui/solid */
import { useTerminalDimensions } from '@opentui/solid';
import type { JSX } from '@opentui/solid';
import type { MouseEvent } from '@opentui/core/renderer';
import { createSignal, onCleanup } from 'solid-js';
import { readableTextColor } from '../../theme/readability';
import { sidebarTheme } from '../../theme/sidebar';
import type { Disposable } from '../../../contracts/src/index';
import type { WorkbenchReadPort } from '../../../workbench/src/index';
import type { SidebarReadModel, WorkbenchTabSnapshot } from '../../../workbench/src/entrypoints/launch';
import { calculateWorkbenchLayout, computeSidebarTabLayout, computeTabLayout, helixTextAttributes, helixThemeColor, helixThemeStyle, themeColor, type SidebarTabId, type ThemeColor, type WorkbenchTheme } from '../workbench';

export interface ChromeSurfaceSpec {
  readonly workbench: WorkbenchReadPort;
  readonly theme: WorkbenchTheme;
  readonly fileLabel: string;
  readonly ascii?: boolean;
  readonly gitBranch?: () => string | undefined;
  readonly sidebar?: () => SidebarReadModel;
  readonly tabStrips?: (width: number, height: number) => readonly { readonly viewId: string; readonly x: number; readonly y: number; readonly width: number }[];
  readonly tabs?: (viewId?: string) => readonly WorkbenchTabSnapshot[];
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
  const color = (scope: string, channel: 'fg' | 'bg', fallback: ThemeColor): ThemeColor => helixThemeColor(theme(), scope, channel, fallback);
  const sidebar = () => sidebarTheme(theme());
  const attributes = (scope: string) => helixTextAttributes(helixThemeStyle(theme(), scope));

  const layout = () => {
    version();
    const size = dimensions();
    return calculateWorkbenchLayout(size.width, size.height, spec.showBottomPanel, spec.sidebar?.().width, spec.sidebar?.().visible !== false);
  };
  const sidebarSections = () => {
    version();
    const model = spec.sidebar?.();
    const chevron = (expanded: boolean): string => (spec.ascii === true ? (expanded ? 'v' : '>') : (expanded ? '▾' : '▸'));
    if (model === undefined) return `${spec.ascii === true ? '> ' : '▾ '}${spec.fileLabel}\n${spec.ascii === true ? '> ' : '  '}Outline`;
    return <>
      {model.sections.map((section, index) => {
        const style = attributes('ui.sidebar');
        return <span style={{
          ...style,
          fg: themeColor(sidebar().foreground),
          bg: themeColor(sidebar().surface, 'bg'),
          bold: section.expanded || style.bold,
        }}>{`${chevron(section.expanded)} ${section.label}${index + 1 < model.sections.length ? '\n' : ''}`}</span>;
      })}
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
      const background = selected ? themeColor(sidebar().surfaceActive, 'bg') : hovered ? themeColor(theme().surfaceActive, 'bg') : themeColor(sidebar().surface, 'bg');
      const foreground = readableTextColor(themeColor(sidebar().foreground), background, themeColor(theme().foreground));
      const style = attributes(selected ? 'ui.sidebar.selected' : 'ui.sidebar');
      return <box position="absolute" left={entry.x} top={0} width={entry.width} height={1} backgroundColor={background}>
        <text fg={foreground}>
          <span style={{ ...style, fg: foreground, bg: background, bold: true }}>{` ${icons[entry.id]} `}</span>
          <span style={{ ...style, fg: foreground, bg: background, bold: selected || style.bold }}>{labels[entry.id]}</span>
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
  const statusScope = () => {
    const mode = spec.workbench.activeViewId === undefined ? undefined : spec.workbench.readView(spec.workbench.activeViewId)?.session.mode;
    return mode === 'insert' ? 'ui.statusline.insert' : mode === 'visual' ? 'ui.statusline.select' : 'ui.statusline.normal';
  };
  const strips = () => { version(); return spec.tabStrips?.(dimensions().width, dimensions().height) ?? [{ viewId: undefined, x: layout().editorX, y: 0, width: layout().editorWidth }]; };
  const tabContent = (width: number, viewId?: string) => {
    version();
    const tabs = spec.tabs?.(viewId);
    if (tabs === undefined) return `  ${spec.fileLabel}`;
    return computeTabLayout(tabs, width).map(entry => {
      if (entry.tab === undefined) return <span style={{ fg: themeColor(theme().muted), bg: themeColor(theme().surface, 'bg') }}>…</span>;
      const tab = entry.tab;
      const closeWidth = entry.hasClose ? 3 : 0;
      const labelWidth = Math.max(0, entry.width - closeWidth);
      const label = `${tab.label}${tab.dirty ? ' ●' : ''}`.slice(0, labelWidth).padEnd(labelWidth);
      const close = entry.hasClose ? ` ${spec.ascii === true ? 'x' : '×'} ` : '';
      const background = tab.active ? color('ui.bufferline.active', 'bg', theme().accent) : hoveredTabId() === `${viewId}:${tab.id}` ? themeColor(theme().surfaceActive, 'bg') : color('ui.bufferline', 'bg', theme().surface);
      const foreground = tab.active ? color('ui.bufferline.active', 'fg', theme().background) : tab.preview ? themeColor(theme().muted) : color('ui.bufferline', 'fg', theme().foreground);
      const style = attributes(tab.active ? 'ui.bufferline.active' : 'ui.bufferline');
      return <span style={{ ...style, fg: readableTextColor(foreground, background, theme().foreground), bg: background, bold: tab.active || style.bold, italic: tab.preview || style.italic }}>{`${label}${close}`}</span>;
    });
  };
  const onMouse = (event: MouseEvent): void => {
    if (event.type === 'move' || event.type === 'over') {
      const current = layout();
      const sidebarEntry = event.y === 0 && event.x >= 0 && event.x < current.sidebarWidth
        ? computeSidebarTabLayout(current.sidebarWidth).find(candidate => event.x >= candidate.x && event.x < candidate.x + candidate.width)
        : undefined;
      setHoveredSidebarTabId(sidebarEntry?.id);
      const strip = strips().find(candidate => event.y === candidate.y && event.x >= candidate.x && event.x < candidate.x + candidate.width);
      const column = event.x - (strip?.x ?? 0);
      const entry = strip === undefined ? undefined : computeTabLayout(spec.tabs?.(strip.viewId) ?? [], strip.width).find(candidate => candidate.tab !== undefined && column >= candidate.x && column < candidate.x + candidate.width);
      setHoveredTabId(entry?.tab === undefined ? undefined : `${strip?.viewId}:${entry.tab.id}`);
    } else if (event.type === 'out') {
      setHoveredTabId(undefined);
      setHoveredSidebarTabId(undefined);
    }
    spec.onPointer?.(event);
  };

  return (
    <box position="absolute" left={0} top={0} width="100%" height="100%" zIndex={2} onMouse={onMouse}>
      <box position="absolute" left={0} top={0} width={layout().sidebarWidth} height={layout().statusRow}
        visible={layout().sidebarVisible} backgroundColor={themeColor(sidebar().surface, 'bg')}>
        {sidebarTabs()}
        <text position="absolute" left={0} top={1} fg={themeColor(sidebar().foreground)}>{sidebarSections()}</text>
      </box>
      <box position="absolute" left={layout().sidebarWidth} top={0} width={1} height={layout().statusRow}
        visible={layout().sidebarVisible} backgroundColor={color('ui.background.separator', 'fg', color('ui.window', 'fg', theme().border))} />
      {strips().map(strip => <box position="absolute" left={strip.x} top={strip.y} width={strip.width} height={1} backgroundColor={color('ui.bufferline.background', 'bg', theme().surfaceActive)}>
        <text fg={readableTextColor(color('ui.bufferline', 'fg', theme().foreground), color('ui.bufferline', 'bg', theme().surface), theme().foreground)}>{tabContent(strip.width, strip.viewId)}</text>
      </box>)}
      <box position="absolute" left={layout().editorX} top={layout().bottomTop} width={layout().editorWidth} height={layout().bottomHeight}
        visible={layout().bottomHeight > 0} backgroundColor={color('ui.popup', 'bg', theme().surface)}>
        <text fg={color('ui.popup', 'fg', theme().foreground)}><span style={attributes('ui.popup')}>Problems 0   Output   Tasks</span></text>
      </box>
      <box position="absolute" left={0} top={layout().statusRow} width="100%" height={1} backgroundColor={color(statusScope(), 'bg', color('ui.statusline', 'bg', theme().surface))}>
        <text fg={readableTextColor(color(statusScope(), 'fg', color('ui.statusline', 'fg', theme().foreground)), color(statusScope(), 'bg', color('ui.statusline', 'bg', theme().surface)), theme().foreground)}><span style={attributes(statusScope())}>{statusLine()}</span></text>
      </box>
    </box>
  );
}
