/** @jsxImportSource @opentui/solid */
import { useTerminalDimensions, type JSX } from '@opentui/solid';
import type { MouseEvent } from '@opentui/core/renderer';
import { createSignal, onCleanup } from 'solid-js';
import type { Disposable } from '../../../contracts/src/index.ts';
import type { WorkbenchReadPort, ExCommandLineReadModel } from '../../../workbench/src/index.ts';
import type { WorkbenchRenderable } from '../workbench';
import { ASCII_WORKBENCH_THEME, helixThemeColor, helixThemeStyle, type WorkbenchTheme } from '../workbench';
import { formatPrefixHelpLines, measurePrefixHelp, prefixHelpEntries, prefixHelpTitle, type PrefixHelpReadPort } from '../../help/index';
import { formatPickerLines, pickerRowIds, type PickerReadPort } from '../../picker/index';
import { formatExplorerLines, type ExplorerReadModel, type ExplorerReadPort } from '../../explorer/index';
import { resolveFileIcon, type IconColorToken } from '../../explorer/icons';
import { formatSearchLines, searchRowIds, type SearchReadPort } from '../../search/index';
import { formatGitLines, gitRowIds, type GitReadPort } from '../../git/index';
import { diagnosticColor, formatProblemsLines, type ProblemsReadPort } from '../../problems/index';
import { formatGitDiffLines, type GitDiffReadPort } from '../../git/diff';
import { formatTaskOutputLines, type TaskOutputReadPort } from '../../output/index';
import { formatHierarchyLines, formatOutlineLines, formatHoverLines, measureHover, outlineEmptyMessage, outlineKindIcon, type OutlineReadPort, type HierarchyReadPort, type HoverReadPort } from '../../navigation/index';
import { formatCompletionLines, formatSignatureLines, type CompletionReadPort, type SignatureReadPort } from '../../completion/index';
import { exCommandDoc, exCompletionGrid, wrapDocLines, formatExCommandLineLines, type ExCommandLineReadPort } from '../../commandline/index';
import { formatDirectoryReviewLines, type DirectoryDraftReadPort } from '../../directory/index';
import { contextMenuBounds, formatContextMenuLines } from '../context-menu';
import type { WorkbenchPanelPointerEvent } from '../panel-pointer';
import type { OpenTuiWorkbenchOptions } from '../options';
import { ChromeSurface } from './chrome';
import { readableTextColor } from '../../theme/readability';
import { readableSidebarForeground, sidebarTheme } from '../../theme/sidebar';
import { StatusSurface } from './status';
import { ThemedRowsSurface, type SolidThemeBridge } from './composition';
import type { RowsSurfaceSpec, SurfaceRow, SurfaceRowSegment } from './panel';
import type { SolidNode } from './root';
import {
  getCommandLineBounds,
  getCommandDocBounds,
  getDirectoryReviewBounds,
  getExplorerBounds,
  getGitBounds,
  getGitDiffBounds,
  getOutlineBounds,
  getPickerBounds,
  getPrefixHelpBounds,
  getProblemsBounds,
  getSearchBounds,
  getSidebarOutlineBounds,
  popupBoundsInEditor,
} from './layout';

export interface WorkbenchAppProps {
  readonly workbench: WorkbenchReadPort;
  readonly fileLabel: string;
  readonly viewport: Pick<WorkbenchRenderable, 'cursorCell' | 'forwardPointerEvent' | 'getTabStrips'>;
  readonly options: OpenTuiWorkbenchOptions;
  readonly theme: WorkbenchTheme;
  readonly themeBridge: SolidThemeBridge<WorkbenchTheme>;
  readonly requestFrame: () => void;
}

export function popupBorderVisible(policy: 'none' | 'popup' | 'menu' | 'all' | undefined, kind: 'popup' | 'menu'): boolean {
  return policy === 'all' || policy === kind;
}

const EMPTY_EXPLORER_MODEL: ExplorerReadPort['model'] = Object.freeze({
  contractVersion: 1,
  generation: 0,
  roots: Object.freeze([]),
  nodes: Object.freeze([]),
  visibleRows: Object.freeze([]),
  selectedId: undefined,
  filter: '',
  includeHidden: false,
  includeIgnored: false,
  followSymlinks: false,
  flattenDirs: true,
  focused: false,
  state: 'empty',
  message: undefined,
});
const EMPTY_SEARCH_MODEL: SearchReadPort['model'] = Object.freeze({
  contractVersion: 1,
  query: Object.freeze({ rootId: 'workspace', rootPath: '', query: '' }),
  generation: 0,
  state: 'idle',
  matches: Object.freeze([]),
  totalMatches: 0,
  truncated: false,
  message: undefined,
});
const EMPTY_OUTPUT_MODEL: TaskOutputReadPort['model'] = Object.freeze({
  taskId: '',
  stdout: '',
  stderr: '',
  bytes: 0,
  truncated: false,
  state: 'idle',
  exitCode: null,
});

function deferredRead<T>(
  resolve: () => { readonly model: T; readonly subscribe: (listener: (model: T) => void) => Disposable } | undefined,
  empty: T,
  wake: OpenTuiWorkbenchOptions['subscribeSurfaceChanges'],
): { readonly model: T; subscribe(listener: (model: T) => void): Disposable } {
  const read = {
    get model(): T { return resolve()?.model ?? empty; },
    subscribe(listener: (model: T) => void): Disposable {
      const current = resolve();
      const dataSubscription = current?.subscribe(listener);
      const wakeSubscription = wake?.(() => listener(read.model));
      return { dispose: () => { dataSubscription?.dispose(); wakeSubscription?.dispose(); } };
    },
  };
  return read;
}

function forwardPanelPointer(
  route: ((event: WorkbenchPanelPointerEvent) => boolean) | undefined,
  event: WorkbenchPanelPointerEvent,
  requestFrame: () => void,
): boolean {
  const handled = route?.(event) ?? false;
  if (handled) requestFrame();
  return handled;
}

function visibilitySubscription(options: OpenTuiWorkbenchOptions): { readonly subscribeVisibility?: (listener: () => void) => Disposable } {
  return options.subscribeSurfaceChanges === undefined ? {} : { subscribeVisibility: options.subscribeSurfaceChanges };
}

function iconColor(theme: WorkbenchTheme, token: IconColorToken): import('../workbench').ThemeColor {
  switch (token) {
    case 'foreground': return theme.foreground;
    case 'muted': return theme.muted;
    case 'accent': return theme.accent;
    case 'gitAdded': return helixThemeColor(theme, 'diff.plus', 'fg', '#367C4A');
    case 'gitModified': return helixThemeColor(theme, 'diff.delta', 'fg', '#9B6A16');
    case 'gitConflict': return theme.error;
    case 'error': return theme.error;
  }
}

function themeForScope(theme: WorkbenchTheme, scope: string): WorkbenchTheme {
  const selected = scope === 'ui.menu' ? 'ui.menu.selected' : 'ui.selection.primary';
  return {
    ...theme,
    surface: helixThemeColor(theme, scope, 'bg', theme.surface),
    surfaceActive: helixThemeColor(theme, selected, 'bg', theme.surfaceActive),
    foreground: readableTextColor(helixThemeColor(theme, scope, 'fg', theme.foreground), helixThemeColor(theme, scope, 'bg', theme.surface), theme.foreground),
    muted: helixThemeColor(theme, 'ui.text.inactive', 'fg', theme.muted),
    accent: helixThemeColor(theme, selected, 'fg', theme.accent),
    error: helixThemeColor(theme, 'error', 'fg', theme.error),
  };
}

function clipSegments(segments: readonly SurfaceRowSegment[], width: number): readonly SurfaceRowSegment[] {
  let remaining = Math.max(0, width);
  const clipped: SurfaceRowSegment[] = [];
  for (const segment of segments) {
    if (remaining === 0) break;
    const points = [...segment.text];
    if (points.length <= remaining) {
      clipped.push(segment);
      remaining -= points.length;
      continue;
    }
    clipped.push({ ...segment, text: remaining === 1 ? '…' : `${points.slice(0, remaining - 1).join('')}…` });
    break;
  }
  return clipped;
}

export function pickerRows(model: PickerReadPort['model'], width: number, maxRows: number, offset: number, hoveredId: string | undefined, theme: WorkbenchTheme): readonly SurfaceRow[] {
  const background = helixThemeColor(theme, 'ui.menu', 'bg', theme.surface);
  const selectedBackground = helixThemeColor(theme, 'ui.text.focus', 'bg', helixThemeColor(theme, 'ui.menu.selected', 'bg', theme.surfaceActive));
  const foreground = helixThemeColor(theme, 'ui.menu', 'fg', theme.foreground);
  const selectedForeground = helixThemeColor(theme, 'ui.text.focus', 'fg', helixThemeColor(theme, 'ui.menu.selected', 'fg', foreground));
  const headerBackground = helixThemeColor(theme, 'ui.picker.header', 'bg', background);
  const headerForeground = helixThemeColor(theme, 'ui.picker.header', 'fg', foreground);
  const directoryStyle = helixThemeStyle(theme, 'ui.text.directory');
  const title = ({ file: 'Files', buffer: 'Buffers', command: 'Commands', theme: 'Themes', config: 'Config', git: 'Git', diagnostic: 'Diagnostics', recovery: 'Recovery' } as const)[model.mode];
  const rows: SurfaceRow[] = [{
    segments: clipSegments([
      { text: `${title}${model.mode === 'theme' ? '  ·  Live preview' : ''}  > `, foreground: headerForeground, bold: true },
      { text: model.query.length === 0 ? 'Type to filter…' : model.query, foreground: model.query.length === 0 ? theme.muted : headerForeground, italic: model.query.length === 0 },
    ], width),
    background: headerBackground,
  }];
  const entries = model.entries.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, maxRows - 2));
  for (const entry of entries) {
    const selected = entry.id === model.selectedId;
    const slash = entry.mode === 'diagnostic' ? -1 : Math.max(entry.label.lastIndexOf('/'), entry.label.lastIndexOf('\\'));
    const parent = slash < 0 ? '' : entry.label.slice(0, slash + 1);
    const label = slash < 0 ? entry.label : entry.label.slice(slash + 1);
    rows.push({
      segments: clipSegments([
        { text: selected ? '▸ ' : '  ', foreground: selected ? theme.accent : theme.muted },
        ...(parent.length === 0 ? [] : [{ text: parent, foreground: helixThemeColor(theme, 'ui.text.directory', 'fg', theme.muted), ...(directoryStyle === undefined ? {} : { style: directoryStyle }) }]),
        { text: label, foreground: entry.severity === undefined ? selected ? selectedForeground : foreground : diagnosticColor(theme, entry.severity), bold: selected },
        ...(entry.detail.length === 0 ? [] : [{ text: `  ${entry.detail}`, foreground: theme.muted }]),
      ], width),
      background: selected ? selectedBackground : entry.id === hoveredId ? theme.selectionSecondary ?? selectedBackground : background,
    });
  }
  if (rows.length < maxRows) rows.push({
    top: maxRows - 1,
    text: model.message ?? (model.mode === 'command'
      ? width < 64
        ? `${model.totalMatches}${model.truncated ? '+' : ''} commands · ↑↓ move · Enter run · Esc`
        : `${model.totalMatches}${model.truncated ? '+' : ''} commands  ·  ↑↓/Ctrl-N/P move  ·  Enter run  ·  Esc cancel`
      : model.mode === 'theme'
      ? width < 80
        ? `${model.totalMatches} themes · C-n/p C-u/d · Enter apply · Esc restore`
        : `${model.totalMatches}${model.truncated ? '+' : ''} themes · ↑↓/C-n/p move · C-u/d half page · Hover preview · Enter apply · Esc restore`
      : `${model.totalMatches}${model.truncated ? '+' : ''} matches  ·  ↑↓/Ctrl-N/P move  ·  Enter ${model.mode === 'recovery' ? 'load' : 'open'}  ·  Esc cancel`),
    foreground: model.state === 'error' ? theme.error : theme.muted,
    background,
  });
  return rows;
}

function pickerPaneBounds(width: number, height: number, preview: boolean, mode: string | undefined): ReturnType<typeof getPickerBounds> {
  const bounds = getPickerBounds(width, height);
  const split = width >= 100 && (mode === 'diagnostic' || mode === 'file');
  if (!split) return preview ? { ...bounds, width: 0, height: 0 } : bounds;
  const leftWidth = Math.floor(bounds.width / 2);
  return preview ? { ...bounds, left: bounds.left + leftWidth, width: bounds.width - leftWidth } : { ...bounds, width: leftWidth };
}

function gitStateColor(state: GitReadPort['model']['sections'][number]['entries'][number]['state'], theme: WorkbenchTheme): import('../workbench').ThemeColor {
  if (state === 'conflicted' || state === 'deleted') return theme.error;
  if (state === 'modified') return helixThemeColor(theme, 'diff.delta', 'fg', '#C4872B');
  if (state === 'added' || state === 'untracked') return helixThemeColor(theme, 'diff.plus', 'fg', '#3F9A5F');
  return theme.accent;
}

function gitStateScope(state: GitReadPort['model']['sections'][number]['entries'][number]['state']): 'diff.plus' | 'diff.minus' | 'diff.delta' {
  return state === 'added' || state === 'untracked' ? 'diff.plus' : state === 'deleted' ? 'diff.minus' : 'diff.delta';
}

export function gitRows(model: GitReadPort['model'], width: number, maxRows: number, offset: number, hoveredId: string | undefined, theme: WorkbenchTheme): readonly SurfaceRow[] {
  const total = model.sections.reduce((sum, section) => sum + section.count, 0);
  const rows: SurfaceRow[] = [
    { segments: clipSegments([{ text: model.branch ?? 'detached', foreground: theme.accent, bold: true }, { text: `  ${total} change${total === 1 ? '' : 's'}`, foreground: theme.muted }], width), background: theme.surface },
    { text: 'Enter diff  ·  s stage  ·  u unstage  ·  r refresh', foreground: theme.muted, background: theme.surface },
  ];
  const items: Array<{ readonly section: GitReadPort['model']['sections'][number]; readonly row?: GitReadPort['model']['sections'][number]['entries'][number] }> = [];
  for (const section of model.sections) {
    items.push({ section });
    if (!section.collapsed) for (const row of section.entries) items.push({ section, row });
  }
  for (const item of items.slice(Math.max(0, offset))) {
    if (rows.length >= maxRows) break;
    if (item.row === undefined) {
      rows.push({ segments: clipSegments([
        { text: item.section.collapsed ? '▸ ' : '▾ ', foreground: theme.muted },
        { text: item.section.label, foreground: theme.foreground, bold: item.section.count > 0 },
        { text: `  ${item.section.count}`, foreground: theme.muted },
      ], width), background: `git-section:${item.section.id}` === model.selectedId ? theme.surfaceActive : theme.surface });
      continue;
    }
    const selected = item.row.id === model.selectedId;
    const slash = item.row.path.lastIndexOf('/');
    const { fg: _stateForeground, ...stateStyle } = helixThemeStyle(theme, gitStateScope(item.row.state)) ?? {};
    rows.push({
      segments: clipSegments([
        { text: '  ' },
        { text: `${item.row.letter} `, foreground: readableSidebarForeground(gitStateColor(item.row.state, theme), theme.foreground, [theme.surface, theme.surfaceActive, theme.selectionSecondary ?? theme.surfaceActive]), bold: true, style: stateStyle },
        ...(slash < 0 ? [] : [{ text: item.row.path.slice(0, slash + 1), foreground: theme.muted }]),
        { text: item.row.path.slice(slash + 1), foreground: theme.foreground, bold: selected },
      ], width),
      background: selected ? theme.surfaceActive : item.row.id === hoveredId ? theme.selectionSecondary ?? theme.surfaceActive : theme.surface,
    });
  }
  return rows;
}

function gitDiffRows(model: ReturnType<GitDiffReadPort['readModel']>, width: number, maxRows: number, offset: number, _hoveredId: string | undefined, theme: WorkbenchTheme): readonly SurfaceRow[] {
  const header = model.state === 'loading' ? `Diff  ${model.path}  ·  loading…` : model.state === 'unavailable' ? `Diff  ${model.path}  ·  ${model.message ?? 'unavailable'}` : `${model.path}   ${model.leftLabel} ↔ ${model.rightLabel}   hunk ${model.hunks.length === 0 ? 0 : model.selectedHunk + 1}/${model.hunks.length}`;
  const rows: SurfaceRow[] = [{ text: header, foreground: model.state === 'unavailable' ? theme.error : theme.accent, background: theme.surface, bold: true }];
  const start = Math.max(0, model.scrollTop + offset);
  for (const line of model.lines.slice(start, start + Math.max(0, maxRows - 1))) {
    const added = line.kind === 'added';
    const removed = line.kind === 'removed';
    const diffStyle = !added && !removed ? undefined : helixThemeStyle(theme, added ? 'diff.plus' : 'diff.minus');
    const oldNumber = line.oldLine === undefined ? '    ' : String(line.oldLine).padStart(4);
    const newNumber = line.newLine === undefined ? '    ' : String(line.newLine).padStart(4);
    rows.push({
      segments: clipSegments([
        { text: `${oldNumber} ${newNumber} `, foreground: theme.muted },
        { text: added ? '+ ' : removed ? '- ' : '  ', foreground: added ? helixThemeColor(theme, 'diff.plus', 'fg', '#3F9A5F') : removed ? helixThemeColor(theme, 'diff.minus', 'fg', theme.error) : theme.muted, bold: added || removed },
        { text: line.text.replace(/[\r\n]+$/u, ''), foreground: theme.foreground },
      ], width),
      background: added ? helixThemeColor(theme, 'diff.plus', 'bg', theme.diffAdded ?? '#E4F3E8') : removed ? helixThemeColor(theme, 'diff.minus', 'bg', theme.diffRemoved ?? '#F8E5E8') : theme.background,
      ...(diffStyle === undefined ? {} : { style: diffStyle }),
    });
  }
  return rows;
}

function hoverRows(model: HoverReadPort['model'], width: number, maxRows: number, _offset: number, _hoveredId: string | undefined, theme: WorkbenchTheme): readonly SurfaceRow[] {
  const background = helixThemeColor(theme, 'ui.popup', 'bg', theme.surface);
  const foreground = helixThemeColor(theme, 'markup.normal.hover', 'fg', helixThemeColor(theme, 'ui.popup', 'fg', theme.foreground));
  const padding = (): SurfaceRow => ({ text: '', background });
  if (model.state !== 'ready' || model.hover === undefined || model.hover.length === 0) {
    return [padding(), ...formatHoverLines(model, Math.max(1, width - 4), Math.max(1, maxRows - 2)).map(text => ({ text: `  ${text}`, foreground: theme.muted, background })), padding()];
  }
  const rows: SurfaceRow[] = [padding()];
  let code = false;
  for (const source of model.hover.split(/\r?\n/u)) {
    if (rows.length >= maxRows - 1) break;
    if (source.trimStart().startsWith('```')) { code = !code; continue; }
    if (rows.length === 1 && source.trim() === '') continue;
    const heading = /^#{1,6}\s+(.+)$/u.exec(source);
    const segments = code ? highlightHoverCode(source, theme) : heading === null
      ? [{ text: `  ${source}`, foreground }]
      : [{ text: `  ${heading[1] ?? ''}`, foreground: helixThemeColor(theme, 'markup.heading.hover', 'fg', theme.accent), bold: true }];
    const style = helixThemeStyle(theme, heading === null ? 'markup.normal.hover' : 'markup.heading.hover');
    rows.push({ segments: clipSegments(segments, width), background, ...(style === undefined ? {} : { style }) });
  }
  while (rows.length > 1 && rows.at(-1)?.segments?.every(segment => segment.text.trim() === '') === true) rows.pop();
  rows.push(padding());
  return rows;
}

function highlightHoverCode(source: string, theme: WorkbenchTheme): readonly SurfaceRowSegment[] {
  const foreground = helixThemeColor(theme, 'markup.raw.inline.hover', 'fg', helixThemeColor(theme, 'ui.popup', 'fg', theme.foreground));
  const muted = helixThemeColor(theme, 'comment', 'fg', theme.muted);
  const string = helixThemeColor(theme, 'string', 'fg', theme.foreground);
  const number = helixThemeColor(theme, 'constant.numeric', 'fg', theme.foreground);
  const keyword = helixThemeColor(theme, 'keyword', 'fg', theme.accent);
  const rawStyle = helixThemeStyle(theme, 'markup.raw.inline.hover');
  const segments: SurfaceRowSegment[] = [{ text: '  ', foreground, ...(rawStyle === undefined ? {} : { style: rawStyle }) }];
  const token = /(\/\/.*$|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:async|await|class|const|else|extends|function|if|import|interface|let|new|return|type|typeof|var)\b|\b\d+(?:\.\d+)?\b)/gu;
  let offset = 0;
  for (const match of source.matchAll(token)) {
    const index = match.index;
    if (index > offset) segments.push({ text: source.slice(offset, index), foreground, ...(rawStyle === undefined ? {} : { style: rawStyle }) });
    const value = match[0];
    const color = value.startsWith('//') || value.startsWith('/*') ? muted
      : /^["'`]/u.test(value) ? string
        : /^\d/u.test(value) ? number : keyword;
    const scope = value.startsWith('//') || value.startsWith('/*') ? 'comment' : /^["'`]/u.test(value) ? 'string' : /^\d/u.test(value) ? 'constant.numeric' : 'keyword';
    const style = helixThemeStyle(theme, scope);
    segments.push({ text: value, foreground: color, italic: value.startsWith('/'), ...(style === undefined ? {} : { style }) });
    offset = index + value.length;
  }
  if (offset < source.length) segments.push({ text: source.slice(offset), foreground, ...(rawStyle === undefined ? {} : { style: rawStyle }) });
  return segments;
}

/** Helix prompt: column-major completion grid in `ui.menu` (the accepted item in
 * `ui.menu.selected`) above the `:` line in `ui.background`/`ui.text`. */
function commandLineRows(model: ExCommandLineReadModel | undefined, width: number, maxRows: number, theme: WorkbenchTheme): readonly SurfaceRow[] {
  if (model === undefined) return [];
  const grid = exCompletionGrid(model, width);
  const menuBackground = helixThemeColor(theme, 'ui.menu', 'bg', theme.surface);
  const menuForeground = readableTextColor(helixThemeColor(theme, 'ui.menu', 'fg', theme.foreground), menuBackground, theme.foreground);
  const selectedStyle = helixThemeStyle(theme, 'ui.menu.selected');
  const rows: SurfaceRow[] = [];
  for (let row = 0; row < grid.rows && rows.length < maxRows - 1; row += 1) {
    const segments: SurfaceRowSegment[] = [];
    for (let column = 0; column < grid.columns; column += 1) {
      const index = grid.offset + column * grid.rows + row;
      const candidate = model.candidates[index];
      if (candidate === undefined) break;
      const label = [...candidate.label].slice(0, Math.max(0, grid.columnWidth - 1)).join('');
      const selected = index === grid.highlighted;
      segments.push({ text: label, foreground: candidate.available ? menuForeground : theme.muted, ...(selected && selectedStyle !== undefined ? { style: selectedStyle } : {}) });
      segments.push({ text: ' '.repeat(grid.columnWidth + 1 - [...label].length), foreground: menuForeground });
    }
    rows.push({ segments: clipSegments(segments, width), background: menuBackground });
  }
  const background = helixThemeColor(theme, 'ui.background', 'bg', theme.background);
  const foreground = readableTextColor(helixThemeColor(theme, 'ui.text', 'fg', theme.foreground), background, theme.foreground);
  rows.push({ text: `:${model.source.startsWith(':') ? model.source.slice(1) : model.source}`.slice(0, width), foreground, background });
  return rows;
}

/** Helix info box body: `key  doc` rows (Helix pads keys to the widest one), text in `ui.text.info`. */
export function prefixHelpRows(model: PrefixHelpReadPort['model'], width: number, maxRows: number, theme: WorkbenchTheme): readonly SurfaceRow[] {
  if (model === undefined || width <= 0 || maxRows <= 0) return [];
  const background = helixThemeColor(theme, 'ui.popup.info', 'bg', theme.surface);
  const foreground = helixThemeColor(theme, 'ui.text.info', 'fg', helixThemeColor(theme, 'ui.popup.info', 'fg', theme.foreground));
  const style = helixThemeStyle(theme, 'ui.text.info');
  const entries = prefixHelpEntries(model);
  const { keyWidth } = measurePrefixHelp(entries, prefixHelpTitle(model));
  return entries.slice(0, maxRows).map(entry => ({
    segments: clipSegments([{ text: ` ${entry.key.padEnd(keyWidth)}  ${entry.doc}`, foreground: entry.available ? foreground : theme.muted, ...(style === undefined ? {} : { style }) }], width),
    background,
  }));
}

/** Tree disclosure glyph shared by the Files and Outline trees. */
function disclosure(expanded: boolean, ascii: boolean): string { return expanded ? (ascii ? 'v' : '▾') : (ascii ? '>' : '▸'); }

/** VS Code-style outline tree rows: indent, disclosure chevron, colored symbol-kind icon, name
 * and muted detail. The focused selection uses the active row color; unfocused, the row under the
 * editor cursor keeps a quieter highlight (follow-cursor). */
function outlineRows(model: OutlineReadPort['model'], width: number, maxRows: number, offset: number, hoveredId: string | undefined, ascii: boolean, theme: WorkbenchTheme): readonly SurfaceRow[] {
  const empty = outlineEmptyMessage(model);
  if (empty !== undefined) return [{ text: ` ${empty}`, foreground: theme.muted, background: theme.surface, italic: true }];
  const rows: SurfaceRow[] = [];
  const quiet = theme.selectionSecondary ?? theme.surfaceActive;
  for (const row of model.rows.slice(Math.max(0, offset), Math.max(0, offset) + maxRows)) {
    const selected = row.id === model.selectedId;
    const background = selected && model.focused ? theme.surfaceActive : selected || row.id === hoveredId ? quiet : theme.surface;
    const icon = outlineKindIcon(row.kind);
    const chevron = row.expandable ? disclosure(row.expanded, ascii) : ' ';
    const foreground = readableTextColor(theme.foreground, background, theme.foreground);
    rows.push({
      segments: clipSegments([
        { text: `${'  '.repeat(row.depth)}${chevron} `, foreground: theme.muted },
        { text: `${ascii ? icon.ascii : icon.glyph} `, foreground: helixThemeColor(theme, icon.scope, 'fg', icon.fallback ?? theme.foreground) },
        { text: row.name, foreground, bold: selected && model.focused },
        ...(row.detail === undefined || row.detail.length === 0 ? [] : [{ text: `  ${row.detail}`, foreground: theme.muted }]),
      ], width),
      background,
    });
  }
  return rows;
}

function directoryNameSegments(name: string, column: number, theme: WorkbenchTheme): readonly SurfaceRowSegment[] {
  const scalar = name.codePointAt(column);
  const cursor = scalar === undefined ? ' ' : String.fromCodePoint(scalar);
  return [{ text: name.slice(0, column), foreground: theme.foreground }, { text: cursor, style: { fg: theme.surfaceActive, bg: theme.foreground } }, { text: name.slice(column + (scalar === undefined ? 0 : cursor.length)), foreground: theme.foreground }];
}

function explorerRows(model: ExplorerReadModel, width: number, maxRows: number, offset: number, hoveredId: string | undefined, visualIds: ReadonlySet<string> | undefined, ascii: boolean, theme: WorkbenchTheme, focused: boolean): readonly SurfaceRow[] {
  const rows: SurfaceRow[] = [];
  if (model.visibleRows.length === 0 && rows.length < maxRows) {
    rows.push({
      text: model.state === 'error' ? model.message ?? 'Unable to read workspace' : model.state === 'loading' ? 'Loading…' : 'No files',
      foreground: model.state === 'error' ? theme.error : theme.muted,
      background: theme.surface,
    });
  }
  for (const visible of model.visibleRows.slice(Math.max(0, offset))) {
    if (rows.length >= maxRows) break;
    const node = model.nodes.find(candidate => candidate.id === visible.nodeId);
    if (node === undefined) continue;
    const selected = visible.nodeId === model.selectedId;
    const visual = visualIds?.has(visible.nodeId) === true || model.edit?.visualIds.includes(visible.nodeId) === true;
    const background = selected ? theme.surfaceActive : (visual || visible.nodeId === hoveredId) ? theme.selectionSecondary ?? theme.surfaceActive : theme.surface;
    if (node.kind === 'state') {
      rows.push({ text: `${'  '.repeat(visible.depth)}${node.message ?? node.name}`, foreground: model.edit === undefined ? theme.error : theme.muted, background });
      continue;
    }
    const expandable = node.kind === 'directory' || node.kind === 'root' || node.kind === 'symlink';
    const chevron = expandable ? node.loadState === 'loading' ? '·' : disclosure(node.expanded === true, ascii) : ' ';
    const icon = node.kind === 'root'
      ? { glyph: '⌂', color: 'accent' as const }
      : node.kind === 'symlink'
        ? { glyph: '↪', color: 'muted' as const }
        : node.kind === 'directory' || node.kind === 'file'
          ? resolveFileIcon(node.name, node.kind, node.expanded, ascii)
          : { glyph: '?', color: 'error' as const };
    const gitScope = node.git?.state === 'modified' || node.git?.state === 'conflicted' ? 'diff.delta' : 'diff.plus';
    const gitColor = node.git?.state === 'conflicted' ? theme.error : helixThemeColor(theme, gitScope, 'fg', node.git?.state === 'modified' ? '#9B6A16' : '#367C4A');
    const directoryStyle = node.kind === 'directory' || node.kind === 'root' ? helixThemeStyle(theme, 'ui.text.directory') : undefined;
    const gitStyle = helixThemeStyle(theme, gitScope);
    const suffix = node.loadState === 'permission-denied' ? '  [permission denied]'
      : node.loadState === 'symlink-cycle' ? '  [symlink cycle]'
        : node.loadState === 'empty' && expandable ? '  [empty]'
          : node.message === undefined ? '' : `  ${node.message}`;
    rows.push({
      background,
      segments: clipSegments([
        { text: `${'  '.repeat(visible.depth)}${chevron} `, foreground: theme.muted },
        { text: `${icon.glyph} `, foreground: iconColor(theme, icon.color) },
        ...(selected && focused && model.edit !== undefined ? directoryNameSegments(visible.label ?? node.name, model.edit.cursorColumn, theme) : [{ text: visible.label ?? node.name, foreground: model.edit?.pendingIds?.includes(node.id) ? helixThemeColor(theme, 'error', 'fg', theme.error) : selected ? theme.foreground : (node.kind === 'directory' || node.kind === 'root' ? helixThemeColor(theme, 'ui.text.directory', 'fg', theme.foreground) : theme.foreground), bold: selected || visual, ...(directoryStyle === undefined ? {} : { style: directoryStyle }) }]),
        ...(model.edit?.pendingIds?.includes(node.id) ? [{ text: ' *', foreground: helixThemeColor(theme, 'error', 'fg', theme.error) }] : []),
        ...(node.git === undefined ? [] : [{ text: ` ${node.git.label}`, foreground: gitColor, ...(gitStyle === undefined ? {} : { style: gitStyle }) }]),
        ...(suffix.length === 0 ? [] : [{ text: suffix, foreground: node.loadState === 'permission-denied' ? theme.error : theme.muted }]),
      ], width),
    });
  }
  return rows;
}

function searchRows(model: SearchReadPort['model'], width: number, maxRows: number, offset: number, hoveredId: string | undefined, selectedId: string | undefined, replaceInput: string, theme: WorkbenchTheme): readonly SurfaceRow[] {
  const rows: SurfaceRow[] = [
    {
      segments: clipSegments([
        { text: model.query.query.length === 0 ? 'Search' : model.query.query, foreground: theme.foreground, bold: true },
        { text: `  [${model.query.regex === true ? 'regex' : 'literal'} · ${model.query.caseSensitive === true ? 'case' : 'ignore-case'} · ${model.query.wholeWord === true ? 'word' : 'no-word'}]`, foreground: theme.muted },
      ], width),
      foreground: theme.accent,
      background: theme.surface,
    },
    { segments: clipSegments([{ text: 'Replace: ', foreground: theme.muted }, { text: replaceInput, foreground: theme.foreground }], width), background: theme.surface },
  ];
  const fileCount = new Set(model.matches.map(match => match.path)).size;
  const summary = model.message !== undefined && model.matches.length === 0
    ? model.message
    : model.state === 'loading'
      ? 'Searching…'
      : model.matches.length === 0
        ? 'No results'
        : `${model.totalMatches} result${model.totalMatches === 1 ? '' : 's'} in ${fileCount} file${fileCount === 1 ? '' : 's'}`;
  rows.push({ text: summary.slice(0, width), foreground: model.state === 'error' ? theme.error : theme.muted, background: theme.surface });

  const counts = new Map<string, number>();
  for (const match of model.matches) counts.set(match.path, (counts.get(match.path) ?? 0) + 1);
  const items: ({ readonly kind: 'heading'; readonly path: string } | { readonly kind: 'match'; readonly match: SearchReadPort['model']['matches'][number] })[] = [];
  let previousPath: string | undefined;
  for (const match of model.matches) {
    if (match.path !== previousPath) { items.push({ kind: 'heading', path: match.path }); previousPath = match.path; }
    items.push({ kind: 'match', match });
  }
  for (const item of items.slice(Math.max(0, offset))) {
    if (rows.length >= maxRows) break;
    const id = item.kind === 'heading' ? `file:${item.path}` : item.match.id;
    const background = id === selectedId ? theme.surfaceActive : id === hoveredId ? theme.selectionSecondary ?? theme.surfaceActive : theme.surface;
    if (item.kind === 'heading') {
      const split = item.path.lastIndexOf('/');
      const directory = split < 0 ? '' : item.path.slice(0, split + 1);
      const basename = split < 0 ? item.path : item.path.slice(split + 1);
      const count = ` (${counts.get(item.path) ?? 0})`;
      const labelWidth = directory.length + basename.length + 2;
      rows.push({
        segments: clipSegments([
          { text: '[', foreground: theme.foreground },
          { text: directory, foreground: theme.muted },
          { text: basename, foreground: theme.foreground, bold: true },
          { text: ']', foreground: theme.foreground },
          { text: ' '.repeat(Math.max(1, width - labelWidth - count.length)), foreground: theme.foreground },
          { text: count, foreground: theme.muted },
        ], width),
        background,
      });
      continue;
    }
    const match = item.match;
    const location = `${match.id === selectedId ? '▸ ' : '  '}${match.path}:${match.line + 1}:${match.range.startUtf16 + 1} `;
    const query = model.query.query;
    const matchAt = query.length === 0 ? -1 : match.snippet.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
    const current = match.id === selectedId;
    const highlightStyle = helixThemeStyle(theme, current ? 'ui.highlight.current' : 'ui.highlight')
      ?? (current ? { fg: String(readableTextColor(theme.foreground, theme.cursorOnSelection ?? theme.accent, theme.background)), bg: String(theme.cursorOnSelection ?? theme.accent) } : undefined);
    rows.push({
      segments: clipSegments([
        { text: location, foreground: theme.muted },
        ...(matchAt < 0 ? [{ text: match.snippet, foreground: theme.foreground }] : [
          { text: match.snippet.slice(0, matchAt), foreground: theme.foreground },
          { text: match.snippet.slice(matchAt, matchAt + query.length), foreground: helixThemeColor(theme, current ? 'ui.highlight.current' : 'ui.highlight', 'fg', theme.accent), bold: true, ...(highlightStyle === undefined ? {} : { style: highlightStyle }) },
          { text: match.snippet.slice(matchAt + query.length), foreground: theme.foreground },
        ]),
      ], width),
      background,
    });
  }
  if (model.truncated && rows.length < maxRows) rows.push({ text: `… ${model.totalMatches - model.matches.length} more matches`, foreground: theme.muted, background: theme.surface });
  return rows;
}

function problemsRows(model: ProblemsReadPort['model'], width: number, maxRows: number, offset: number, hoveredId: string | undefined, selectedId: string | undefined, theme: WorkbenchTheme): readonly SurfaceRow[] {
  const background = helixThemeColor(theme, 'ui.popup', 'bg', theme.surface);
  const foreground = helixThemeColor(theme, 'ui.popup', 'fg', theme.foreground);
  const selectedBackground = helixThemeColor(theme, 'ui.selection.primary', 'bg', theme.surfaceActive);
  const hoverBackground = helixThemeColor(theme, 'ui.selection', 'bg', theme.selectionSecondary ?? selectedBackground);
  const severity = (value: 1 | 2 | 3 | 4 | undefined): import('../workbench').ThemeColor => {
    const scope = value === 1 ? 'diagnostic.error' : value === 2 ? 'diagnostic.warning' : value === 3 ? 'diagnostic.info' : value === 4 ? 'diagnostic.hint' : 'ui.popup';
    const fallback = value === 1 ? theme.error : foreground;
    return helixThemeColor(theme, scope, 'fg', helixThemeColor(theme, value === 1 ? 'error' : value === 2 ? 'warning' : value === 3 ? 'info' : 'hint', 'fg', fallback));
  };
  const severityScope = (value: 1 | 2 | 3 | 4 | undefined): string => value === 1 ? 'diagnostic.error' : value === 2 ? 'diagnostic.warning' : value === 3 ? 'diagnostic.info' : value === 4 ? 'diagnostic.hint' : 'ui.popup';
  const rows: SurfaceRow[] = [{ text: `Problems ${model.all.length}`.slice(0, width), foreground: theme.accent, background, bold: true }];
  for (const problem of model.all.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, maxRows - 1))) {
    const selected = problem.id === selectedId;
    const style = helixThemeStyle(theme, severityScope(problem.severity));
    rows.push({
      text: `${problem.uri}:${problem.range.startLine + 1}:${problem.range.startUtf16 + 1} ${problem.message}`.slice(0, width),
      foreground: severity(problem.severity),
      background: selected ? selectedBackground : problem.id === hoveredId ? hoverBackground : background,
      bold: selected,
      ...(style === undefined ? {} : { style }),
    });
  }
  return rows;
}

function ContextMenuBackdrop(props: { readonly store: NonNullable<OpenTuiWorkbenchOptions['contextMenu']> }): JSX.Element {
  const [open, setOpen] = createSignal(props.store.open);
  const subscription = props.store.subscribe(() => setOpen(props.store.open));
  onCleanup(() => subscription.dispose());
  return <box position="absolute" left={0} top={0} width="100%" height="100%" zIndex={199}
    visible={open()} onMouse={(event: MouseEvent) => {
      if (event.type !== 'down') return;
      props.store.dismiss();
      event.preventDefault();
      event.stopPropagation();
    }} />;
}

export function WorkbenchApp(props: WorkbenchAppProps): JSX.Element {
  const dimensions = useTerminalDimensions();
  const options = props.options;
  const panelProps = visibilitySubscription(options);
  const scopeColors = (scope: string, headerScope?: string, selectedScope?: string) => (theme: WorkbenchTheme) => {
    const selected = selectedScope ?? (scope === 'ui.menu' ? 'ui.menu.selected' : 'ui.selection.primary');
    const style = helixThemeStyle(theme, scope);
    const selectedStyle = helixThemeStyle(theme, selected);
    const headerStyle = headerScope === undefined ? undefined : helixThemeStyle(theme, headerScope);
    return {
      background: helixThemeColor(theme, scope, 'bg', theme.surface),
      foreground: readableTextColor(helixThemeColor(theme, scope, 'fg', theme.foreground), helixThemeColor(theme, scope, 'bg', theme.surface), theme.foreground),
      accent: helixThemeColor(theme, selected, 'fg', theme.accent),
      muted: helixThemeColor(theme, 'ui.text.inactive', 'fg', theme.muted),
      selectedBackground: helixThemeColor(theme, selected, 'bg', theme.surfaceActive),
      hoverBackground: helixThemeColor(theme, 'ui.selection', 'bg', theme.selectionSecondary ?? theme.surfaceActive),
      scrollForeground: helixThemeColor(theme, 'ui.menu.scroll', 'fg', theme.accent),
      scrollBackground: helixThemeColor(theme, 'ui.menu.scroll', 'bg', theme.surface),
      ...(style === undefined ? {} : { style }),
      ...(selectedStyle === undefined ? {} : { selectedStyle }),
      ...(headerStyle === undefined ? {} : { headerStyle }),
    };
  };
  const sidebarColors = (source: WorkbenchTheme) => {
    const theme = sidebarTheme(source);
    return { background: theme.surface, foreground: theme.foreground, muted: theme.muted,
      accent: theme.accent, selectedBackground: theme.surfaceActive,
      hoverBackground: theme.selectionSecondary ?? theme.surfaceActive };
  };
  const rows = <T,>(spec: RowsSurfaceSpec<T>, colors?: (theme: WorkbenchTheme) => {
    readonly background: import('../workbench').ThemeColor;
    readonly foreground: import('../workbench').ThemeColor;
    readonly accent?: import('../workbench').ThemeColor;
    readonly muted?: import('../workbench').ThemeColor;
    readonly selectedBackground?: import('../workbench').ThemeColor;
    readonly hoverBackground?: import('../workbench').ThemeColor;
    readonly scrollForeground?: import('../workbench').ThemeColor;
    readonly scrollBackground?: import('../workbench').ThemeColor;
    readonly style?: import('../workbench').HelixThemeStyle;
    readonly selectedStyle?: import('../workbench').HelixThemeStyle;
    readonly headerStyle?: import('../workbench').HelixThemeStyle;
  }): JSX.Element => (
    <ThemedRowsSurface {...spec} {...panelProps} theme={props.themeBridge} {...(colors === undefined ? {} : { colors })} />
  );

  const gitDiffRead = options.gitDiff === undefined ? undefined : {
    model: options.gitDiff.read.readModel(),
    subscribe: (listener: (model: ReturnType<NonNullable<OpenTuiWorkbenchOptions['gitDiff']>['read']['readModel']>) => void) => options.gitDiff!.read.subscribe(() => listener(options.gitDiff!.read.readModel())),
  };
  const commandLineRead = options.commandLine === undefined ? undefined : {
    model: options.commandLine.read.model,
    subscribe: (listener: (model: ExCommandLineReadModel | undefined) => void) => options.commandLine!.read.subscribe?.(listener) ?? { dispose: () => {} },
  };
  const contextMenuRead = options.contextMenu === undefined ? undefined : (() => {
    const menu = options.contextMenu!;
    return {
      model: menu.state,
      subscribe: (listener: (model: typeof menu.state) => void) => menu.subscribe(() => listener(menu.state)),
    };
  })();
  const explorerRead = deferredRead(() => options.explorer?.read, EMPTY_EXPLORER_MODEL, options.subscribeSurfaceChanges);
  const [explorerModel, setExplorerModel] = createSignal(explorerRead.model);
  const explorerSubscription = explorerRead.subscribe(model => setExplorerModel(model));
  onCleanup(() => explorerSubscription.dispose());
  const explorerSurface = {
    read: explorerRead,
    isOpen: () => options.explorer?.isOpen() === true,
    onPointer: (event: WorkbenchPanelPointerEvent) => options.explorer?.onPointer?.(event) ?? false,
  };
  const searchRead = deferredRead(() => options.search?.read, EMPTY_SEARCH_MODEL, options.subscribeSurfaceChanges);
  const searchSurface = {
    read: searchRead,
    isOpen: () => options.search?.isOpen() === true,
    selectedId: () => options.search?.selectedId?.(),
    state: () => options.search?.state?.(),
    onPointer: (event: WorkbenchPanelPointerEvent) => options.search?.onPointer?.(event) ?? false,
  };
  const outputSurface = {
    read: deferredRead(() => options.output?.read, EMPTY_OUTPUT_MODEL, options.subscribeSurfaceChanges),
    isOpen: () => options.output?.isOpen() === true,
  };

  return (
    <box position="absolute" left={0} top={0} width="100%" height="100%">
      <ChromeSurface
        workbench={props.workbench}
        theme={props.theme}
        fileLabel={props.fileLabel}
        filesStatus={() => { const edit = options.explorer?.read.model.edit; return edit === undefined ? undefined : { mode: edit.mode, prompt: edit.prompt ?? '', dirty: edit.dirty === true, focused: options.explorer?.isFocused?.() === true }; }}
        tabStrips={(width, height) => props.viewport.getTabStrips(width, height)}
        {...(options.gitBranch === undefined ? {} : { gitBranch: options.gitBranch })}
        {...(options.statusline === undefined ? {} : { statusline: options.statusline })}
        {...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot })}
        {...(options.statuslineFileType === undefined ? {} : { statuslineFileType: options.statuslineFileType })}
        {...(options.statuslineIndentStyle === undefined ? {} : { statuslineIndentStyle: options.statuslineIndentStyle })}
        {...(options.statuslineLspActivity === undefined ? {} : { statuslineLspActivity: options.statuslineLspActivity })}
        {...(options.statuslineRegister === undefined ? {} : { statuslineRegister: options.statuslineRegister })}
        {...(options.statuslineCodeActionHints === undefined ? {} : { statuslineCodeActionHints: options.statuslineCodeActionHints })}
        {...(options.workspaceTrustRestricted === undefined ? {} : { workspaceTrustRestricted: options.workspaceTrustRestricted })}
        {...(options.colorModes === undefined ? {} : { colorModes: options.colorModes })}
        {...(options.bufferline === undefined ? {} : { bufferline: options.bufferline })}
        {...(options.editorDiagnostics === undefined ? {} : { editorDiagnostics: options.editorDiagnostics })}
        {...(options.workspaceDiagnostics === undefined ? {} : { workspaceDiagnostics: options.workspaceDiagnostics })}
        {...(options.sidebar === undefined ? {} : { sidebar: options.sidebar })}
        {...(options.tabs === undefined ? {} : { tabs: options.tabs })}
        showBottomPanel={false}
        {...(options.subscribeSurfaceChanges === undefined ? {} : { subscribe: options.subscribeSurfaceChanges })}
        onPointer={props.viewport.forwardPointerEvent.bind(props.viewport)}
        setTheme={props.themeBridge.bind}
      />
      {options.statusMessage !== undefined && <StatusSurface
        read={options.statusMessage.read}
        theme={props.theme}
        commandLineOpen={() => options.commandLine?.isOpen() === true}
        aboveStatusLine={() => options.explorer?.isFocused?.() === true && options.explorer?.read.model.edit !== undefined}
        subscribe={options.subscribeSurfaceChanges}
        setTheme={props.themeBridge.bind}
      />}
      <box position="absolute" left={0} top={0} width="100%" height="100%" zIndex={105}
        visible={explorerModel().edit?.review !== undefined}
        onMouse={(event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); if (event.type === 'down' && event.button === 0) options.explorer?.onReviewAction?.('cancel'); }} />
      {rows({
        read: explorerSurface.read,
        isOpen: () => options.sidebar?.().visible !== false && explorerSurface.isOpen() && (dimensions().width >= 100 || options.explorer?.isFocused?.() !== false),
        format: (model, width, maxRows, offset) => formatExplorerLines(model, width, maxRows, false, offset, props.themeBridge.current() === ASCII_WORKBENCH_THEME),
        formatRows: (model, width, maxRows, offset, hoveredId) => {
          const visualIds = options.explorer?.visualIds?.();
          return explorerRows(model, width, maxRows, offset, hoveredId, visualIds === undefined || visualIds.length === 0 ? undefined : new Set(visualIds), props.themeBridge.current() === ASCII_WORKBENCH_THEME, sidebarTheme(props.themeBridge.current()), options.explorer?.isFocused?.() !== false);
        },
        maxRows: Number.MAX_SAFE_INTEGER,
        onViewportRows: (count, offset) => options.explorer?.onViewportRows?.(count, offset), scrollTo: model => model.edit?.scroll,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => getExplorerBounds(width, height, options.sidebar?.()),
        panel: 'explorer',
        generation: model => model.generation,
        rowIds: (model, offset, count) => model.visibleRows.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, count)).map(row => row.nodeId),
        onPointer: event => forwardPanelPointer(explorerSurface.onPointer, event, props.requestFrame),
        headerRows: 0,
        totalRows: model => model.visibleRows.length,
        selectedId: model => model.selectedId,
        selectedIndex: model => model.visibleRows.findIndex(row => row.nodeId === model.selectedId),
        zIndex: 20,
      }, sidebarColors)}
      {rows({
        read: explorerSurface.read,
        isOpen: () => explorerSurface.read.model.edit?.review !== undefined,
        format: () => [],
        formatRows: (model, width, height) => {
          const review = model.edit?.review;
          if (review === undefined) return [];
          const theme = props.themeBridge.current();
          const root = model.nodes.find(node => node.kind === 'root')?.path;
          const capacity = Math.max(0, height - 5);
          const start = Math.max(0, Math.min(review.selectedIndex, review.lines.length - capacity));
          return [
            { text: `Review ${review.lines.length} Files change${review.lines.length === 1 ? '' : 's'}`, foreground: theme.foreground, bold: true },
            { text: review.error === undefined ? 'Occupied names get a free name. Nothing is applied until you confirm.' : 'Resolve conflicts before applying. Existing files will not be overwritten.', foreground: theme.muted },
            ...review.lines.slice(start, start + capacity).map((line, index) => ({ text: (root === undefined ? line : line.replaceAll(`${root}/`, '')).slice(0, width), foreground: line.startsWith('Trash ') || line.startsWith('Conflict: ') ? helixThemeColor(theme, 'error', 'fg', theme.error) : theme.foreground, background: start + index === review.selectedIndex ? theme.surfaceActive : theme.surface })),
            { text: review.lines.length > capacity ? `Showing ${start + 1}–${Math.min(review.lines.length, start + capacity)} of ${review.lines.length} · j/k scroll` : '', foreground: theme.muted },
            { text: 'Tab / ← → choose · Enter confirm · Esc keep editing', foreground: theme.muted },
            { segments: [
              { text: '[ Cancel ]', foreground: review.choice === 'cancel' ? theme.accent : theme.foreground, style: { bg: review.choice === 'cancel' ? theme.surfaceActive : theme.surface }, bold: review.choice === 'cancel' },
              { text: '   ', foreground: theme.foreground },
              { text: '[ Discard all ]', foreground: helixThemeColor(theme, 'error', 'fg', theme.error), style: { bg: review.choice === 'discard' ? theme.surfaceActive : theme.surface }, bold: review.choice === 'discard' },
              { text: '   ', foreground: theme.foreground },
              { text: review.busy ? '[ Checking… ]' : review.error === undefined ? '[ Apply changes ]' : '[ Apply blocked ]', foreground: review.error === undefined ? theme.accent : theme.muted, style: { bg: review.choice === 'apply' ? theme.surfaceActive : theme.surface }, bold: review.choice === 'apply' },
            ] },
          ];
        },
        maxRows: 18,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => {
          const base = getDirectoryReviewBounds(width, height);
          const panelWidth = Math.min(88, base.width);
          const panelHeight = Math.min(base.height, (explorerSurface.read.model.edit?.review?.lines.length ?? 0) + 7);
          return { width: panelWidth, height: panelHeight, left: Math.max(0, Math.floor((width - panelWidth) / 2)), top: Math.max(0, Math.floor((height - panelHeight) / 2)) };
        },
        zIndex: 106,
        border: true,
        onMouse: (event, row, column) => {
          const review = explorerSurface.read.model.edit?.review;
          const height = Math.min(18, getDirectoryReviewBounds(dimensions().width, dimensions().height).height - 2, (review?.lines.length ?? 0) + 5);
          const buttonRow = Math.min(review?.lines.length ?? 0, Math.max(0, height - 5)) + 4;
          if (event.type === 'down' && event.button === 0 && row === buttonRow && !review?.busy) {
            if (column >= 0 && column < 10) options.explorer?.onReviewAction?.('cancel');
            else if (column >= 13 && column < 28) options.explorer?.onReviewAction?.('discard');
            else if (column >= 31 && column < 48 && review?.error === undefined) options.explorer?.onReviewAction?.('apply');
          }
          return true;
        },
      }, scopeColors('ui.popup'))}
      {options.picker !== undefined && rows({
        read: options.picker.read,
        isOpen: options.picker.isOpen,
        format: formatPickerLines,
        formatRows: (model, width, maxRows, offset, hoveredId) => pickerRows(model, width, maxRows, offset, hoveredId, themeForScope(props.themeBridge.current(), 'ui.menu')),
        maxRows: Number.POSITIVE_INFINITY,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => pickerPaneBounds(width, height, false, options.picker?.read.model.mode),
        panel: 'picker',
        generation: model => model.generation,
        rowIds: pickerRowIds,
        onViewportRows: (count, offset) => options.picker?.onViewportRows?.(count, offset),
        onPointer: event => forwardPanelPointer(options.picker?.onPointer, event, props.requestFrame),
        headerRows: 1,
        footerRows: 1,
        totalRows: model => model.entries.length,
        selectedId: model => model.selectedId,
        selectedIndex: model => model.entries.findIndex(entry => entry.id === model.selectedId),
        zIndex: 100,
        border: popupBorderVisible(options.popupBorder, 'menu'),
        previewOnHover: model => model.mode === 'theme',
      }, scopeColors('ui.menu', 'ui.picker.header'))}
      {options.picker !== undefined && rows({
        read: options.picker.read,
        isOpen: () => dimensions().width >= 100 && options.picker?.isOpen() === true && (options.picker.read.model.mode === 'diagnostic' || options.picker.read.model.mode === 'file'),
        format: () => [],
        formatRows: (_model, width, maxRows) => {
          const preview = options.picker?.preview?.();
          const theme = props.themeBridge.current();
          if (preview === undefined) return [{ text: 'No preview', foreground: theme.muted }];
          return [{ text: preview.title, foreground: theme.accent, bold: true }, ...preview.lines.slice(0, maxRows - 1).map((text, index) => ({
            text: `${String((preview.startLine ?? 0) + index + 1).padStart(4)} ${text}`,
            foreground: theme.foreground,
            background: index === preview.selectedLine ? theme.surfaceActive : theme.surface,
          }))];
        },
        maxRows: Number.POSITIVE_INFINITY,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => pickerPaneBounds(width, height, true, options.picker?.read.model.mode),
        zIndex: 100,
        border: popupBorderVisible(options.popupBorder, 'menu'),
      }, scopeColors('ui.menu', 'ui.picker.header'))}
      {rows<SearchReadPort['model']>({
        read: searchSurface.read,
        isOpen: () => options.sidebar?.().visible !== false && searchSurface.isOpen(),
        format: (model, width, maxRows, offset) => formatSearchLines(model, width, maxRows, searchSurface.selectedId(), offset, searchSurface.state()?.replaceInput ?? ''),
        formatRows: (model, width, maxRows, offset, hoveredId) => searchRows(model, width, maxRows, offset, hoveredId, searchSurface.selectedId(), searchSurface.state()?.replaceInput ?? '', sidebarTheme(props.themeBridge.current())),
        maxRows: Number.MAX_SAFE_INTEGER,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => getSearchBounds(width, height, options.sidebar?.()),
        panel: 'search',
        generation: model => model.generation,
        rowIds: searchRowIds,
        onPointer: event => forwardPanelPointer(searchSurface.onPointer, event, props.requestFrame),
        headerRows: 3,
        totalRows: model => searchRowIds(model, 0, Number.MAX_SAFE_INTEGER).length,
        selectedId: searchSurface.selectedId,
        selectedIndex: model => searchRowIds(model, 0, Number.MAX_SAFE_INTEGER).findIndex((id: string | undefined) => id === searchSurface.selectedId()),
        zIndex: 90,
      }, sidebarColors)}
      {options.git !== undefined && rows<GitReadPort['model']>({
        read: options.git.read,
        isOpen: () => options.sidebar?.().visible !== false && options.git!.isOpen(),
        format: formatGitLines,
        formatRows: (model, width, maxRows, offset, hoveredId) => gitRows(model, width, maxRows, offset, hoveredId, sidebarTheme(props.themeBridge.current())),
        maxRows: Number.MAX_SAFE_INTEGER,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => getGitBounds(width, height, options.sidebar?.()),
        panel: 'git',
        generation: model => model.generation,
        rowIds: gitRowIds,
        onPointer: event => forwardPanelPointer(options.git?.onPointer, event, props.requestFrame),
        headerRows: 2,
        totalRows: model => gitRowIds(model, 0, Number.MAX_SAFE_INTEGER).length,
        selectedId: model => model.selectedId,
        selectedIndex: model => gitRowIds(model, 0, Number.MAX_SAFE_INTEGER).findIndex((id: string | undefined) => id === model.selectedId),
        zIndex: 90,
      }, sidebarColors)}
      {options.gitDiff !== undefined && gitDiffRead !== undefined && rows<ReturnType<GitDiffReadPort['readModel']>>({
        read: gitDiffRead,
        isOpen: options.gitDiff.isOpen,
        format: formatGitDiffLines,
        formatRows: (model, width, maxRows, offset, hoveredId) => gitDiffRows(model, width, maxRows, offset, hoveredId, themeForScope(props.themeBridge.current(), 'ui.background')),
        maxRows: 30,
        background: props.theme.background,
        foreground: props.theme.foreground,
        bounds: (width, height) => {
          options.gitDiff?.onViewportChange?.(width, height);
          return getGitDiffBounds(width, height, options.sidebar?.());
        },
        panel: 'git-diff',
        generation: model => model.generation,
        totalRows: model => model.lines.length,
        onPointer: event => forwardPanelPointer(options.gitDiff?.onPointer, event, props.requestFrame),
        headerRows: 1,
        zIndex: 100,
      }, scopeColors('ui.background'))}
      {options.problems !== undefined && rows<ProblemsReadPort['model']>({
        read: options.problems.read,
        isOpen: options.problems.isOpen,
        format: formatProblemsLines,
        formatRows: (model, width, maxRows, offset, hoveredId) => problemsRows(model, width, maxRows, offset, hoveredId, options.problems?.selectedId?.(), themeForScope(props.themeBridge.current(), 'ui.popup')),
        maxRows: 10,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: getProblemsBounds,
        panel: 'problems',
        generation: model => model.generation,
        rowIds: (model, offset, count) => [undefined, ...model.all.slice(offset, offset + Math.max(0, count - 1)).map(problem => problem.id)],
        onPointer: event => forwardPanelPointer(options.problems?.onPointer, event, props.requestFrame),
        headerRows: 1,
        zIndex: 80,
        border: popupBorderVisible(options.popupBorder, 'popup'),
        totalRows: model => model.all.length,
        ...(options.problems.selectedId === undefined ? {} : {
          selectedId: () => options.problems?.selectedId?.(),
          selectedIndex: model => model.all.findIndex((problem: ProblemsReadPort['model']['all'][number]) => problem.id === options.problems?.selectedId?.()),
        }),
      }, scopeColors('ui.popup'))}
      {options.outline !== undefined && rows({
        read: options.outline.read,
        // Narrow terminals hide the sidebar; the outline then floats only while focused.
        isOpen: () => options.outline?.isOpen() === true && (dimensions().width >= 100 || options.outline.read.model.focused),
        format: formatOutlineLines,
        formatRows: (model, width, maxRows, offset, hoveredId) => outlineRows(model, width, maxRows, offset, hoveredId, props.themeBridge.current() === ASCII_WORKBENCH_THEME, sidebarTheme(props.themeBridge.current())),
        maxRows: Number.MAX_SAFE_INTEGER,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => getSidebarOutlineBounds(width, height, options.sidebar?.()),
        panel: 'outline',
        generation: model => model.generation,
        rowIds: (model, offset, count) => model.rows.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, count)).map(row => row.id),
        onPointer: event => forwardPanelPointer(options.outline?.onPointer, event, props.requestFrame),
        totalRows: model => model.rows.length,
        selectedId: model => model.selectedId,
        selectedIndex: model => model.rows.findIndex(row => row.id === model.selectedId),
        zIndex: 70,
      }, sidebarColors)}
      {options.hierarchy !== undefined && rows({
        read: options.hierarchy.read,
        isOpen: options.hierarchy.isOpen,
        format: formatHierarchyLines,
        maxRows: 14,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: getOutlineBounds,
        zIndex: 75,
        border: popupBorderVisible(options.popupBorder, 'popup'),
      }, scopeColors('ui.popup'))}
      {options.hover !== undefined && rows({
        read: options.hover.read,
        isOpen: () => options.hover!.isOpen() && options.hover!.read.model.state === 'ready' && (options.hover!.read.model.hover?.trim().length ?? 0) > 0,
        format: (model, width, maxRows) => formatHoverLines(model, Math.max(1, width - 4), Math.max(1, maxRows - 2)),
        formatRows: (model, width, maxRows, offset, hoveredId) => hoverRows(model, width, maxRows, offset, hoveredId, themeForScope(props.themeBridge.current(), 'ui.popup')),
        maxRows: 12,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => popupBoundsInEditor(width, height, props.viewport.cursorCell, measureHover(options.hover!.read.model, Math.max(1, width - 2), 12), 'below', options.sidebar?.().width, options.sidebar?.().visible !== false),
        zIndex: 110,
        border: popupBorderVisible(options.popupBorder, 'popup'),
      }, scopeColors('ui.popup'))}
      {options.directoryReview !== undefined && rows({
        read: options.directoryReview.read,
        isOpen: options.directoryReview.isOpen,
        format: formatDirectoryReviewLines,
        maxRows: 16,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: getDirectoryReviewBounds,
        zIndex: 105,
        border: popupBorderVisible(options.popupBorder, 'popup'),
      }, scopeColors('ui.popup'))}
      {options.completion !== undefined && rows({
        read: options.completion.read,
        isOpen: options.completion.isOpen,
        format: formatCompletionLines,
        maxRows: 10,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => {
          const model = options.completion!.read.model;
          const border = popupBorderVisible(options.popupBorder, 'menu') ? 2 : 0;
          const rows = formatCompletionLines(model, 60, 10);
          const contentWidth = Math.max(16, ...rows.map(row => [...row].length + 2));
          return popupBoundsInEditor(width, height, props.viewport.cursorCell, {
            width: Math.min(60, contentWidth + border),
            height: Math.min(10, Math.max(1, model.items.length + 1)) + border,
          }, 'below', options.sidebar?.().width, options.sidebar?.().visible !== false);
        },
        rowIds: model => [undefined, ...model.items.map(item => item.id)],
        headerRows: 1,
        totalRows: model => model.items.length,
        selectedId: model => model.selectedId,
        selectedIndex: model => model.items.findIndex(item => item.id === model.selectedId),
        zIndex: 120,
        border: popupBorderVisible(options.popupBorder, 'menu'),
      }, scopeColors('ui.menu'))}
      {options.signature !== undefined && rows({
        read: options.signature.read,
        isOpen: options.signature.isOpen,
        format: formatSignatureLines,
        maxRows: 10,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => popupBoundsInEditor(width, height, props.viewport.cursorCell, { width: Math.max(1, Math.min(100, width - 2)), height: 8 }, 'above', options.sidebar?.().width, options.sidebar?.().visible !== false),
        zIndex: 115,
        border: popupBorderVisible(options.popupBorder, 'popup'),
      }, scopeColors('ui.popup'))}
      {options.commandLine !== undefined && commandLineRead !== undefined && rows({
        read: commandLineRead,
        isOpen: options.commandLine.isOpen,
        format: (model, width) => model === undefined ? [] : formatExCommandLineLines(model, width, 10),
        formatRows: (model, width, maxRows) => commandLineRows(model, width, maxRows, themeForScope(props.themeBridge.current(), 'ui.popup')),
        maxRows: 18,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => getCommandLineBounds(width, height, options.commandLine!.read.model),
        zIndex: 130,
      }, scopeColors('ui.menu'))}
      {options.commandLine !== undefined && commandLineRead !== undefined && rows({
        read: commandLineRead,
        isOpen: () => options.commandLine?.isOpen() === true && exCommandDoc(options.commandLine.read.model) !== undefined,
        format: (model, width) => wrapDocLines(exCommandDoc(model)?.lines ?? [], Math.max(1, width - 2)),
        formatRows: (model, width) => {
          const doc = exCommandDoc(model);
          const theme = props.themeBridge.current();
          const foreground = doc?.error === true ? helixThemeColor(theme, 'error', 'fg', theme.error) : helixThemeColor(theme, 'ui.help', 'fg', theme.foreground);
          return wrapDocLines(doc?.lines ?? [], Math.max(1, width - 2)).map(text => ({ text: ` ${text}`, foreground }));
        },
        maxRows: 20,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => getCommandDocBounds(width, height, options.commandLine!.read.model),
        zIndex: 131,
        title: () => '',
      }, scopeColors('ui.help'))}
      {options.prefixHelp !== undefined && rows({
        read: options.prefixHelp,
        isOpen: () => options.prefixHelp?.model !== undefined,
        format: formatPrefixHelpLines,
        formatRows: (model, width, maxRows) => prefixHelpRows(model, width, maxRows, themeForScope(props.themeBridge.current(), 'ui.popup.info')),
        maxRows: Number.MAX_SAFE_INTEGER,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => {
          const model = options.prefixHelp?.model;
          return getPrefixHelpBounds(width, height, model === undefined ? { width: 1, height: 1 } : measurePrefixHelp(prefixHelpEntries(model), prefixHelpTitle(model)));
        },
        zIndex: 125,
        title: model => model === undefined ? '' : prefixHelpTitle(model),
      }, scopeColors('ui.popup.info'))}
      {options.contextMenu !== undefined && <ContextMenuBackdrop store={options.contextMenu} />}
      {options.contextMenu !== undefined && contextMenuRead !== undefined && rows({
        read: contextMenuRead,
        isOpen: () => options.contextMenu?.open === true,
        format: (state, width) => state === undefined ? [] : formatContextMenuLines(state, width),
        formatRows: (state, width) => state === undefined ? [] : state.items.map((item, index) => ({
          text: `${index === state.selectedIndex ? '› ' : '  '}${item.label}`.slice(0, width),
          foreground: index === state.selectedIndex ? helixThemeColor(props.themeBridge.current(), 'ui.popup.info', 'bg', props.themeBridge.current().background) : item.enabled ? helixThemeColor(props.themeBridge.current(), 'ui.popup.info', 'fg', props.themeBridge.current().foreground) : props.themeBridge.current().muted,
          background: index === state.selectedIndex ? helixThemeColor(props.themeBridge.current(), 'ui.menu.selected', 'bg', props.themeBridge.current().accent) : helixThemeColor(props.themeBridge.current(), 'ui.popup.info', 'bg', props.themeBridge.current().surface),
          bold: index === state.selectedIndex && item.enabled,
        })),
        maxRows: 20,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => {
          const state = options.contextMenu?.state;
          return state === undefined ? { width: 1, height: 1, left: 0, top: 0 } : contextMenuBounds(state.items, state.left, state.top, width, height);
        },
        zIndex: 200,
        border: popupBorderVisible(options.popupBorder, 'menu'),
        rowIds: state => state?.items.map(item => item.id) ?? [],
        selectedId: state => state?.items[state.selectedIndex]?.id,
        onMouse: (event, row) => {
          if ((event.type === 'move' || event.type === 'over') && event.source === undefined) { options.contextMenu?.select(row); return true; }
          if (event.type !== 'down' || event.button !== 0) return false;
          const item = options.contextMenu?.state?.items[row];
          if (item === undefined) options.contextMenu?.dismiss();
          else options.contextMenu?.activate(item.id);
          return true;
        },
      }, scopeColors('ui.popup.info', undefined, 'ui.menu.selected'))}
      {rows({
        read: outputSurface.read,
        isOpen: outputSurface.isOpen,
        format: formatTaskOutputLines,
        maxRows: 10,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: getProblemsBounds,
        zIndex: 80,
        border: popupBorderVisible(options.popupBorder, 'popup'),
      }, scopeColors('ui.popup'))}
    </box>
  );
}

export function createWorkbenchAppNode(props: WorkbenchAppProps): SolidNode {
  return () => <WorkbenchApp {...props} />;
}
