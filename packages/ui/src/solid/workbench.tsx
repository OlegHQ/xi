/** @jsxImportSource @opentui/solid */
import { useTerminalDimensions, type JSX } from '@opentui/solid';
import type { MouseEvent } from '@opentui/core/renderer';
import { createSignal, onCleanup } from 'solid-js';
import type { Disposable } from '../../../contracts/src/index.ts';
import type { WorkbenchReadPort, ExCommandLineReadModel } from '../../../workbench/src/index.ts';
import type { WorkbenchRenderable } from '../workbench';
import { ASCII_WORKBENCH_THEME, helixThemeColor, helixThemeStyle, type WorkbenchTheme } from '../workbench';
import { formatPrefixHelpLines, type PrefixHelpReadPort } from '../../help/index';
import { formatPickerLines, pickerRowIds, type PickerReadPort } from '../../picker/index';
import { formatExplorerLines, type ExplorerReadModel, type ExplorerReadPort } from '../../explorer/index';
import { resolveFileIcon, type IconColorToken } from '../../explorer/icons';
import { formatSearchLines, searchRowIds, type SearchReadPort } from '../../search/index';
import { formatGitLines, gitRowIds, type GitReadPort } from '../../git/index';
import { diagnosticColor, formatProblemsLines, type ProblemsReadPort } from '../../problems/index';
import { formatGitDiffLines, type GitDiffReadPort } from '../../git/diff';
import { formatTaskOutputLines, type TaskOutputReadPort } from '../../output/index';
import { formatHierarchyLines, formatOutlineLines, formatHoverLines, measureHover, type OutlineReadPort, type HierarchyReadPort, type HoverReadPort } from '../../navigation/index';
import { formatCompletionLines, formatSignatureLines, type CompletionReadPort, type SignatureReadPort } from '../../completion/index';
import { formatExCommandLineLines, type ExCommandLineReadPort } from '../../commandline/index';
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

function pickerRows(model: PickerReadPort['model'], width: number, maxRows: number, offset: number, hoveredId: string | undefined, theme: WorkbenchTheme): readonly SurfaceRow[] {
  const background = helixThemeColor(theme, 'ui.menu', 'bg', theme.surface);
  const selectedBackground = helixThemeColor(theme, 'ui.text.focus', 'bg', helixThemeColor(theme, 'ui.menu.selected', 'bg', theme.surfaceActive));
  const foreground = helixThemeColor(theme, 'ui.menu', 'fg', theme.foreground);
  const selectedForeground = helixThemeColor(theme, 'ui.text.focus', 'fg', helixThemeColor(theme, 'ui.menu.selected', 'fg', foreground));
  const headerBackground = helixThemeColor(theme, 'ui.picker.header', 'bg', background);
  const headerForeground = helixThemeColor(theme, 'ui.picker.header', 'fg', foreground);
  const directoryStyle = helixThemeStyle(theme, 'ui.text.directory');
  const title = ({ file: 'Files', buffer: 'Buffers', command: 'Commands', theme: 'Themes', config: 'Config', git: 'Git', diagnostic: 'Diagnostics' } as const)[model.mode];
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
  while (rows.length < maxRows - 1) rows.push({ text: '', background });
  if (rows.length < maxRows) rows.push({
    text: model.message ?? (model.mode === 'theme'
      ? width < 80
        ? `${model.totalMatches} themes · C-n/p C-u/d · Enter apply · Esc restore`
        : `${model.totalMatches}${model.truncated ? '+' : ''} themes · ↑↓/C-n/p move · C-u/d half page · Hover preview · Enter apply · Esc restore`
      : `${model.totalMatches}${model.truncated ? '+' : ''} matches  ·  ↑↓/Ctrl-N/P move  ·  Enter open  ·  Esc cancel`),
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

function commandLineRows(model: ExCommandLineReadModel | undefined, width: number, maxRows: number, theme: WorkbenchTheme): readonly SurfaceRow[] {
  if (model === undefined) return [];
  const background = helixThemeColor(theme, 'ui.popup', 'bg', theme.surface);
  const foreground = helixThemeColor(theme, 'ui.popup', 'fg', theme.foreground);
  const selectedBackground = helixThemeColor(theme, 'ui.menu.selected', 'bg', theme.surfaceActive);
  const rows: SurfaceRow[] = [{ segments: clipSegments([{ text: ':', foreground: theme.accent, bold: true }, { text: model.source.startsWith(':') ? model.source.slice(1) : model.source, foreground, bold: true }], width), background }];
  if (model.parseFailure !== undefined && rows.length < maxRows) {
    const detail = 'reason' in model.parseFailure ? model.parseFailure.reason : model.parseFailure.kind;
    rows.push({ text: detail, foreground: theme.error, background });
  } else if (rows.length < maxRows) rows.push({ text: model.acceptanceHint, foreground: theme.muted, background });
  const selectedCandidate = model.candidates[model.selectedIndex];
  if (model.position.typedName.length > 0 && selectedCandidate !== undefined && rows.length < maxRows) {
    rows.push({
      segments: clipSegments([
        { text: `${selectedCandidate.label}  `, foreground: theme.accent, bold: true },
        { text: selectedCandidate.detail, foreground: selectedCandidate.available ? foreground : theme.error },
      ], width),
      background: selectedBackground,
    });
  }
  for (let index = 0; index < model.candidates.length && rows.length < maxRows; index += 1) {
    const candidate = model.candidates[index];
    if (candidate === undefined) continue;
    const selected = index === model.selectedIndex;
    rows.push({
      segments: clipSegments([
        { text: selected ? '▸ ' : '  ', foreground: selected ? theme.accent : theme.muted },
        { text: candidate.label, foreground: candidate.available ? foreground : theme.muted, bold: selected && candidate.available },
        ...(candidate.alias === undefined ? [] : [{ text: `  → ${String(candidate.commandId ?? '')}`, foreground: theme.muted }]),
      ], width),
      background: selected ? selectedBackground : background,
    });
  }
  return rows;
}

function prefixHelpRows(model: PrefixHelpReadPort['model'], width: number, maxRows: number, theme: WorkbenchTheme): readonly SurfaceRow[] {
  if (model === undefined || width <= 0 || maxRows <= 0) return [];
  const background = helixThemeColor(theme, 'ui.popup.info', 'bg', theme.surface);
  const foreground = helixThemeColor(theme, 'ui.popup.info', 'fg', theme.foreground);
  const keyForeground = helixThemeColor(theme, 'ui.text.info', 'fg', theme.accent);
  const keyStyle = helixThemeStyle(theme, 'ui.text.info');
  const prefix = model.pendingKeys.length === 0 ? 'Prefix' : `Prefix ${model.pendingKeys.join(' ')}`;
  if (width < 48 || maxRows === 1) return [{ text: (model.compactHint ?? `${prefix}: no legal continuation`).slice(0, width), foreground, background }];
  const rows: SurfaceRow[] = [{
    segments: clipSegments([{ text: prefix, foreground: keyForeground, bold: true, ...(keyStyle === undefined ? {} : { style: keyStyle }) }, { text: `  (${model.hints.length} hints)`, foreground }], width),
    background,
  }];
  for (const hint of model.hints) {
    if (rows.length >= maxRows) break;
    const alias = hint.aliases.length === 0 ? '' : ` (${hint.aliases.join(', ')})`;
    const state = hint.available ? '' : ` [${hint.disabledReason ?? 'unavailable'}]`;
    rows.push({
      segments: clipSegments([
        { text: `  ${hint.keyLabel}  `, foreground: keyForeground, ...(keyStyle === undefined ? {} : { style: keyStyle }) },
        { text: `${hint.title}${alias} — ${hint.description}`, foreground: hint.available ? foreground : theme.muted },
        ...(state.length === 0 ? [] : [{ text: state, foreground: helixThemeColor(theme, 'error', 'fg', theme.error) }]),
      ], width),
      background,
    });
  }
  return rows;
}

function explorerRows(model: ExplorerReadModel, width: number, maxRows: number, offset: number, hoveredId: string | undefined, ascii: boolean, theme: WorkbenchTheme): readonly SurfaceRow[] {
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
    const background = selected ? theme.surfaceActive : visible.nodeId === hoveredId ? theme.selectionSecondary ?? theme.surfaceActive : theme.surface;
    if (node.kind === 'state') {
      rows.push({ text: `${'  '.repeat(visible.depth)}${node.message ?? node.name}`, foreground: theme.error, background });
      continue;
    }
    const expandable = node.kind === 'directory' || node.kind === 'root' || node.kind === 'symlink';
    const disclosure = expandable ? node.loadState === 'loading' ? '·' : node.expanded ? (ascii ? 'v' : '▾') : (ascii ? '>' : '▸') : ' ';
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
        { text: `${'  '.repeat(visible.depth)}${disclosure} `, foreground: theme.muted },
        { text: `${icon.glyph} `, foreground: iconColor(theme, icon.color) },
        { text: node.name, foreground: selected ? theme.foreground : (node.kind === 'directory' || node.kind === 'root' ? helixThemeColor(theme, 'ui.text.directory', 'fg', theme.foreground) : theme.foreground), bold: selected, ...(directoryStyle === undefined ? {} : { style: directoryStyle }) },
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
    const highlightStyle = helixThemeStyle(theme, 'ui.highlight');
    rows.push({
      segments: clipSegments([
        { text: location, foreground: theme.muted },
        ...(matchAt < 0 ? [{ text: match.snippet, foreground: theme.foreground }] : [
          { text: match.snippet.slice(0, matchAt), foreground: theme.foreground },
          { text: match.snippet.slice(matchAt, matchAt + query.length), foreground: helixThemeColor(theme, 'ui.highlight', 'fg', theme.accent), bold: true, ...(highlightStyle === undefined ? {} : { style: highlightStyle }) },
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
        tabStrips={(width, height) => props.viewport.getTabStrips(width, height)}
        {...(options.gitBranch === undefined ? {} : { gitBranch: options.gitBranch })}
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
        subscribe={options.subscribeSurfaceChanges}
        setTheme={props.themeBridge.bind}
      />}
      {rows({
        read: explorerSurface.read,
        isOpen: () => options.sidebar?.().visible !== false && explorerSurface.isOpen() && (dimensions().width >= 100 || options.explorer?.isFocused?.() !== false),
        format: (model, width, maxRows, offset) => formatExplorerLines(model, width, maxRows, false, offset, props.themeBridge.current() === ASCII_WORKBENCH_THEME),
        formatRows: (model, width, maxRows, offset, hoveredId) => explorerRows(model, width, maxRows, offset, hoveredId, props.themeBridge.current() === ASCII_WORKBENCH_THEME, sidebarTheme(props.themeBridge.current())),
        maxRows: Number.MAX_SAFE_INTEGER,
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
        onViewportRows: count => options.picker?.onViewportRows?.(count),
        onPointer: event => forwardPanelPointer(options.picker?.onPointer, event, props.requestFrame),
        headerRows: 1,
        footerRows: 1,
        totalRows: model => model.entries.length,
        selectedId: model => model.selectedId,
        selectedIndex: model => model.entries.findIndex(entry => entry.id === model.selectedId),
        zIndex: 100,
        border: true,
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
        border: true,
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
        totalRows: model => model.all.length,
        ...(options.problems.selectedId === undefined ? {} : {
          selectedId: () => options.problems?.selectedId?.(),
          selectedIndex: model => model.all.findIndex((problem: ProblemsReadPort['model']['all'][number]) => problem.id === options.problems?.selectedId?.()),
        }),
      }, scopeColors('ui.popup'))}
      {options.outline !== undefined && rows({
        read: options.outline.read,
        isOpen: options.outline.isOpen,
        format: formatOutlineLines,
        maxRows: Number.MAX_SAFE_INTEGER,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => getSidebarOutlineBounds(width, height, options.sidebar?.()),
        zIndex: 70,
      }, scopeColors('ui.popup'))}
      {options.hierarchy !== undefined && rows({
        read: options.hierarchy.read,
        isOpen: options.hierarchy.isOpen,
        format: formatHierarchyLines,
        maxRows: 14,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: getOutlineBounds,
        zIndex: 75,
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
      }, scopeColors('ui.popup'))}
      {options.completion !== undefined && rows({
        read: options.completion.read,
        isOpen: options.completion.isOpen,
        format: formatCompletionLines,
        maxRows: 10,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => popupBoundsInEditor(width, height, props.viewport.cursorCell, { width: Math.max(1, Math.min(60, width - 2)), height: 10 }, 'below', options.sidebar?.().width, options.sidebar?.().visible !== false),
        rowIds: model => [undefined, ...model.items.map(item => item.id)],
        headerRows: 1,
        totalRows: model => model.items.length,
        selectedId: model => model.selectedId,
        selectedIndex: model => model.items.findIndex(item => item.id === model.selectedId),
        zIndex: 120,
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
      }, scopeColors('ui.popup'))}
      {options.prefixHelp !== undefined && rows({
        read: options.prefixHelp,
        isOpen: () => options.prefixHelp?.model !== undefined,
        format: formatPrefixHelpLines,
        formatRows: (model, width, maxRows) => prefixHelpRows(model, width, maxRows, themeForScope(props.themeBridge.current(), 'ui.popup.info')),
        maxRows: Number.MAX_SAFE_INTEGER,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => getPrefixHelpBounds(width, height, options.prefixHelp?.model?.hints.length ?? 0),
        zIndex: 125,
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
        rowIds: state => state?.items.map(item => item.id) ?? [],
        selectedId: state => state?.items[state.selectedIndex]?.id,
        onMouse: (event, row) => {
          if (event.type !== 'down') return false;
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
      }, scopeColors('ui.popup'))}
    </box>
  );
}

export function createWorkbenchAppNode(props: WorkbenchAppProps): SolidNode {
  return () => <WorkbenchApp {...props} />;
}
