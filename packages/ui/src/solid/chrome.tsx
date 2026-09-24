/** @jsxImportSource @opentui/solid */
import { useTerminalDimensions } from '@opentui/solid';
import type { JSX } from '@opentui/solid';
import type { MouseEvent } from '@opentui/core/renderer';
import { Index, createSignal, onCleanup } from 'solid-js';
import { readableTextColor } from '../../theme/readability';
import { sidebarTheme } from '../../theme/sidebar';
import type { Disposable } from '../../../contracts/src/index';
import type { WorkbenchReadPort } from '../../../workbench/src/index';
import type { SidebarReadModel, WorkbenchTabSnapshot } from '../../../workbench/src/entrypoints/launch';
import type { DocumentId } from '../../../contracts/src/index';
import type { Problem } from '../../problems/index';
import { calculateWorkbenchLayout, computeSidebarSectionLayout, computeSidebarTabLayout, computeTabLayout, helixTextAttributes, helixThemeColor, helixThemeStyle, type SidebarTabId, type ThemeColor, type WorkbenchTheme } from '../workbench';
import { resolvePaintColor } from '../../theme/motion-tokens';

export interface ChromeSurfaceSpec {
  readonly workbench: WorkbenchReadPort;
  readonly theme: WorkbenchTheme;
  readonly fileLabel: string;
  readonly ascii?: boolean;
  readonly gitBranch?: () => string | undefined;
  readonly statusline?: { readonly left: readonly string[]; readonly center: readonly string[]; readonly right: readonly string[]; readonly separator: string; readonly mode: { readonly normal: string; readonly insert: string; readonly select: string }; readonly diagnostics: readonly ('hint' | 'info' | 'warning' | 'error')[]; readonly workspaceDiagnostics: readonly ('hint' | 'info' | 'warning' | 'error')[] };
  readonly workspaceRoot?: string;
  readonly statuslineFileType?: () => string | undefined;
  readonly statuslineIndentStyle?: () => string | undefined;
  readonly statuslineLspActivity?: () => boolean;
  readonly statuslineRegister?: () => string | undefined;
  readonly statuslineCodeActionHints?: () => number;
  readonly workspaceTrustRestricted?: () => boolean;
  readonly colorModes?: boolean;
  readonly colorMode?: 'truecolor' | 'ansi256' | 'no-color';
  readonly bufferline?: 'always' | 'never' | 'multiple';
  readonly editorDiagnostics?: (documentId: DocumentId) => readonly Problem[];
  readonly workspaceDiagnostics?: () => readonly Problem[];
  readonly sidebar?: () => SidebarReadModel;
  readonly tabStrips?: (width: number, height: number) => readonly { readonly viewId: string; readonly x: number; readonly y: number; readonly width: number }[];
  readonly tabs?: (viewId?: string) => readonly WorkbenchTabSnapshot[];
  readonly showBottomPanel: boolean;
  readonly subscribe?: (listener: () => void) => Disposable;
  readonly onPointer?: (event: MouseEvent) => void;
}

const SIDEBAR_SECTION_IDS = ['files', 'outline'] as const;

export function ChromeSurface(spec: ChromeSurfaceSpec & { readonly setTheme: (setter: (theme: WorkbenchTheme) => void) => Disposable }): JSX.Element {
  const dimensions = useTerminalDimensions();
  const [theme, setTheme] = createSignal(spec.theme);
  const [version, setVersion] = createSignal(0);
  const [hoveredTabId, setHoveredTabId] = createSignal<string>();
  const [hoveredSidebarTabId, setHoveredSidebarTabId] = createSignal<SidebarTabId>();
  const themeSubscription = spec.setTheme(nextTheme => setTheme(nextTheme));
  const subscription = spec.subscribe?.(() => setVersion(value => value + 1));
  onCleanup(() => { themeSubscription.dispose(); subscription?.dispose(); });
  const paint = (value: ThemeColor): ReturnType<typeof resolvePaintColor> => resolvePaintColor(value, spec.colorMode ?? 'truecolor');
  const color = (scope: string, channel: 'fg' | 'bg', fallback: ThemeColor): ReturnType<typeof resolvePaintColor> => paint(helixThemeColor(theme(), scope, channel, fallback));
  const sidebar = () => sidebarTheme(theme());
  const attributes = (scope: string) => helixTextAttributes(helixThemeStyle(theme(), scope));
  const bufferlineVisible = (): boolean => {
    if (spec.bufferline === 'never') return false;
    if (spec.bufferline !== 'multiple') return true;
    const viewId = spec.workbench.activeViewId;
    return spec.tabs?.(viewId === undefined ? undefined : String(viewId)).length !== 1;
  };

  const layout = () => {
    version();
    const size = dimensions();
    return calculateWorkbenchLayout(size.width, size.height, spec.showBottomPanel, spec.sidebar?.().width, spec.sidebar?.().visible !== false, bufferlineVisible());
  };
  const chevron = (expanded: boolean): string => (spec.ascii === true ? (expanded ? 'v' : '>') : (expanded ? '▾' : '▸'));
  const sidebarModel = () => { version(); return spec.sidebar?.(); };
  // Each header sits on its layout row, so an expanded Files section keeps Outline at the
  // bottom even before the Explorer surface paints the rows between them. `<Index>` keeps the
  // header nodes alive across renders: a drag on the Outline header (its resize splitter) stays
  // captured by the same node while the header moves.
  const sidebarSection = (id: 'files' | 'outline') => {
    const section = () => sidebarModel()?.sections.find(candidate => candidate.id === id);
    const top = () => {
      const model = sidebarModel();
      if (model === undefined) return 0;
      const rows = computeSidebarSectionLayout(model, layout().statusRow);
      return id === 'files' ? rows.filesHeaderRow : rows.outlineHeaderRow;
    };
    const style = () => attributes('ui.sidebar');
    // Not selectable: a press on the Outline header begins its resize drag, not a text selection.
    return <text position="absolute" left={0} top={top()} fg={paint(sidebar().foreground)} selectable={false}>
      <span style={{ ...style(), fg: paint(sidebar().foreground), bg: paint(sidebar().surface), bold: section()?.expanded === true || style().bold }}>
        {`${chevron(section()?.expanded === true)} ${section()?.label ?? ''}`}</span>
      {id === 'outline' && <span style={{ fg: color('ui.background.separator', 'fg', color('ui.window', 'fg', theme().border)), bg: paint(sidebar().surface) }}>
        {` ${(spec.ascii === true ? '-' : '─').repeat(Math.max(0, layout().sidebarWidth - (section()?.label.length ?? 0) - 3))}`}</span>}
    </text>;
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
      const background = selected ? paint(sidebar().surfaceActive) : hovered ? paint(theme().surfaceActive) : paint(sidebar().surface);
      const foreground = readableTextColor(paint(sidebar().foreground), background, paint(theme().foreground));
      const style = attributes(selected ? 'ui.sidebar.selected' : 'ui.sidebar');
      return <box position="absolute" left={entry.x} top={0} width={entry.width} height={1} backgroundColor={background}>
        <text fg={foreground}>
          <span style={{ ...style, fg: foreground, bg: background, bold: true }}>{` ${icons[entry.id]} `}</span>
          <span style={{ ...style, fg: foreground, bg: background, bold: selected || style.bold }}>{labels[entry.id]}</span>
        </text>
      </box>;
    });
  };
  const statuslineDiagnostics = (problems: readonly Problem[], severities: readonly ('hint' | 'info' | 'warning' | 'error')[], workspace: boolean): string => {
    const counts = new Map<string, number>();
    for (const problem of problems) {
      const severity = problem.severity === 1 ? 'error' : problem.severity === 2 ? 'warning' : problem.severity === 3 ? 'info' : 'hint';
      counts.set(severity, (counts.get(severity) ?? 0) + 1);
    }
    const values = severities.filter(severity => (counts.get(severity) ?? 0) > 0).map(severity => `● ${counts.get(severity) ?? 0}`);
    return values.length === 0 ? '' : `${workspace ? ' W ' : ' '}${values.join(' ')}`;
  };
  const statuslineElement = (element: string, view: ReturnType<WorkbenchReadPort['readView']>, modeLabel: string, branch: string | undefined): string => {
    const activeTab = view === undefined ? undefined : spec.tabs?.(String(view.session.viewId)).find(tab => tab.active);
    switch (element) {
      case 'mode': return ` ${modeLabel} `;
      case 'spinner': return spec.statuslineLspActivity?.() === true ? ' ⠋ ' : '';
      case 'file-name': return ` ${activeTab?.path ?? activeTab?.label ?? spec.fileLabel} `;
      case 'file-absolute-path': return ` ${activeTab?.path ?? activeTab?.label ?? spec.fileLabel} `;
      case 'file-base-name': return ` ${activeTab?.label ?? spec.fileLabel.split(/[\\/]/u).at(-1) ?? spec.fileLabel} `;
      case 'file-modification-indicator': {
        return activeTab?.dirty === true ? '[+]' : '   ';
      }
      case 'read-only-indicator': return view?.document.readOnly === true ? ' [readonly] ' : '';
      case 'file-encoding': return '';
      case 'file-line-ending': {
        const ending = view !== undefined && 'defaultLineEnding' in view.document ? view.document.defaultLineEnding : undefined;
        return ending === 'crlf' ? ' CRLF ' : ending === 'cr' ? ' CR ' : ending === 'lf' ? ' LF ' : ending === 'ff' ? ' FF ' : ending === 'nel' ? ' NEL ' : '';
      }
      case 'file-indent-style': {
        const style = spec.statuslineIndentStyle?.();
        return style === undefined ? '' : ` ${style} `;
      }
      case 'file-type': return spec.statuslineFileType?.() ?? '';
      case 'version-control': return branch ?? '';
      case 'selections': {
        const count = view?.selections.members.length ?? 0;
        if (count === 0) return '';
        const primary = view?.selections.members.findIndex(member => member.id === view.selections.primaryId) ?? 0;
        return count === 1 ? ' 1 sel ' : ` ${primary + 1}/${count} sels `;
      }
      case 'primary-selection-length': {
        const selection = view?.selections.members.find(member => member.id === view.selections.primaryId);
        if (selection === undefined) return '';
        const start = Number(selection.head.at.offset) < Number(selection.anchor.at.offset) ? selection.head.at.offset : selection.anchor.at.offset;
        const anchorEnd = selection.anchor.kind === 'character' ? selection.anchor.after.offset : selection.anchor.at.offset;
        const headEnd = selection.head.kind === 'character' ? selection.head.after.offset : selection.head.at.offset;
        const end = Number(headEnd) > Number(anchorEnd) ? headEnd : anchorEnd;
        const first = view?.document.utf32OffsetAt(start);
        const last = view?.document.utf32OffsetAt(end);
        if (first?.ok !== true || last?.ok !== true) return '';
        const length = Number(last.value) - Number(first.value);
        return ` ${length} char${length === 1 ? '' : 's'} `;
      }
      case 'total-line-numbers': return view === undefined ? '' : ` ${view.document.lineCount} `;
      case 'position': {
        if (view === undefined) return '';
        const head = view.selections.members.find(member => member.id === view.selections.primaryId)?.head;
        if (head === undefined) return '';
        const line = view.document.lineIndexAt(head.at.offset);
        const start = line.ok ? view.document.lineStartOffset(line.value) : undefined;
        const first = start?.ok === true ? view.document.utf32OffsetAt(start.value) : undefined;
        const last = view.document.utf32OffsetAt(head.at.offset);
        return line.ok && first?.ok === true && last.ok ? ` ${Number(line.value) + 1}:${Number(last.value) - Number(first.value) + 1} ` : '';
      }
      case 'position-percentage': {
        const head = view?.selections.members.find(member => member.id === view.selections.primaryId)?.head;
        const line = head === undefined ? undefined : view?.document.lineIndexAt(head.at.offset);
        return line?.ok === true && view !== undefined ? ` ${Math.round(((Number(line.value) + 1) / Math.max(1, view.document.lineCount)) * 100)}% ` : '';
      }
      case 'separator': return spec.statusline?.separator ?? '│';
      case 'spacer': return ' ';
      case 'diagnostics': return view === undefined ? '' : statuslineDiagnostics(spec.editorDiagnostics?.(view.document.id) ?? [], spec.statusline?.diagnostics ?? ['warning', 'error'], false);
      case 'workspace-diagnostics': return statuslineDiagnostics(spec.workspaceDiagnostics?.() ?? [], spec.statusline?.workspaceDiagnostics ?? ['warning', 'error'], true);
      case 'current-working-directory': return spec.workspaceRoot === undefined ? '' : ` ${spec.workspaceRoot} `;
      case 'register': return spec.statuslineRegister?.() === undefined ? '' : ` ${spec.statuslineRegister?.()} `;
      case 'code-action-hint': {
        const count = spec.statuslineCodeActionHints?.() ?? 0;
        return count > 0 ? ` C:${count} ` : '';
      }
      default: return '';
    }
  };
  const statuslineArea = (elements: readonly string[], view: ReturnType<WorkbenchReadPort['readView']>, modeLabel: string, branch: string | undefined): string => elements.map(element => statuslineElement(element, view, modeLabel, branch)).join('');
  const statusLine = () => {
    version();
    const view = spec.workbench.activeViewId === undefined ? undefined : spec.workbench.readView(spec.workbench.activeViewId);
    const mode = view?.session.mode;
    const modeLabel = mode === 'insert'
      ? spec.statusline?.mode.insert ?? 'INSERT'
      : mode === 'visual'
        ? spec.statusline?.mode.select ?? 'SELECT'
        : spec.statusline?.mode.normal ?? 'NORMAL';
    const branch = spec.gitBranch?.();
    const width = Math.max(1, dimensions().width);
    const statusline = spec.statusline;
    const left = statusline === undefined ? `${modeLabel}   ${spec.fileLabel}${branch === undefined ? '' : ` (${branch})`}` : statuslineArea(statusline.left, view, modeLabel, branch);
    const center = statusline === undefined ? '' : statuslineArea(statusline.center, view, modeLabel, branch);
    const rightContent = statusline === undefined ? `${view?.selections.members.length ?? 0} cursor${(view?.selections.members.length ?? 0) === 1 ? '' : 's'}` : statuslineArea(statusline.right, view, modeLabel, branch);
    const right = `${rightContent}${spec.workspaceTrustRestricted?.() === true ? spec.ascii === true ? ' [!] ' : ' [⚠] ' : ''}`;
    const cells = Array.from({ length: width }, () => ' ');
    const write = (text: string, start: number): void => { let index = Math.max(0, start); for (const cell of text) { if (index >= cells.length) break; cells[index] = cell; index += 1; } };
    write(` ${left}`, 0);
    write(center, Math.max(0, Math.floor((width - Array.from(center).length) / 2)));
    write(right, Math.max(0, width - Array.from(right).length - 1));
    return cells.join('');
  };
  const statusScope = () => statuslineThemeScope(spec.colorModes === true, spec.workbench.activeViewId === undefined ? undefined : spec.workbench.readView(spec.workbench.activeViewId)?.session.mode);
  const strips = () => { version(); return bufferlineVisible() ? spec.tabStrips?.(dimensions().width, dimensions().height) ?? [{ viewId: undefined, x: layout().editorX, y: 0, width: layout().editorWidth }] : []; };
  const tabContent = (width: number, viewId?: string) => {
    version();
    const tabs = spec.tabs?.(viewId);
    if (tabs === undefined) return `  ${spec.fileLabel}`;
    return computeTabLayout(tabs, width).map(entry => {
      if (entry.tab === undefined) return <span style={{ fg: paint(theme().muted), bg: paint(theme().surface) }}>…</span>;
      const tab = entry.tab;
      const closeWidth = entry.hasClose ? 3 : 0;
      const labelWidth = Math.max(0, entry.width - closeWidth);
      const label = `${tab.label}${tab.dirty ? ' ●' : ''}`.slice(0, labelWidth).padEnd(labelWidth);
      const close = entry.hasClose ? ` ${spec.ascii === true ? 'x' : '×'} ` : '';
      const background = tab.active ? color('ui.bufferline.active', 'bg', theme().accent) : hoveredTabId() === `${viewId}:${tab.id}` ? paint(theme().surfaceActive) : color('ui.bufferline', 'bg', theme().surface);
      const foreground = tab.active ? color('ui.bufferline.active', 'fg', theme().background) : tab.preview ? paint(theme().muted) : color('ui.bufferline', 'fg', theme().foreground);
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
        visible={layout().sidebarVisible} backgroundColor={paint(sidebar().surface)}>
        {sidebarTabs()}
        {spec.sidebar === undefined
          ? <text position="absolute" left={0} top={1} fg={paint(sidebar().foreground)}>{`${spec.ascii === true ? '> ' : '▾ '}${spec.fileLabel}\n${spec.ascii === true ? '> ' : '  '}Outline`}</text>
          : <Index each={SIDEBAR_SECTION_IDS}>{id => sidebarSection(id())}</Index>}
      </box>
      <box position="absolute" left={layout().sidebarWidth} top={0} width={1} height={layout().statusRow}
        visible={layout().sidebarVisible} backgroundColor={color('ui.background', 'bg', theme().background)}>
        <text selectable={false} content={(spec.ascii === true ? '|' : '│').repeat(layout().statusRow)}
          fg={color('ui.background.separator', 'fg', color('ui.window', 'fg', theme().border))} />
      </box>
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

export function statuslineThemeScope(colorModes: boolean, mode: string | undefined): string {
  if (!colorModes) return 'ui.statusline';
  return mode === 'insert' ? 'ui.statusline.insert' : mode === 'visual' ? 'ui.statusline.select' : 'ui.statusline.normal';
}
