/** @jsxImportSource @opentui/solid */
import { useTerminalDimensions, type JSX } from '@opentui/solid';
import type { MouseEvent } from '@opentui/core/renderer';
import { createSignal, onCleanup } from 'solid-js';
import type { Disposable } from '../../../contracts/src/index.ts';
import type { WorkbenchReadPort, ExCommandLineReadModel } from '../../../workbench/src/index.ts';
import type { WorkbenchRenderable } from '../workbench';
import { ASCII_WORKBENCH_THEME, type WorkbenchTheme } from '../workbench';
import { formatPrefixHelpLines } from '../../help/index';
import { formatPickerLines, pickerRowIds, type PickerReadPort } from '../../picker/index';
import { formatExplorerLines, type ExplorerReadModel, type ExplorerReadPort } from '../../explorer/index';
import { resolveFileIcon, type IconColorToken } from '../../explorer/icons';
import { formatSearchLines, searchRowIds, type SearchReadPort } from '../../search/index';
import { formatGitLines, gitRowIds, type GitReadPort } from '../../git/index';
import { formatProblemsLines, type ProblemsReadPort } from '../../problems/index';
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
  readonly viewport: Pick<WorkbenchRenderable, 'cursorCell' | 'forwardPointerEvent'>;
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

function iconColor(theme: WorkbenchTheme, token: IconColorToken): string {
  switch (token) {
    case 'foreground': return theme.foreground;
    case 'muted': return theme.muted;
    case 'accent': return theme.accent;
    case 'gitAdded': return '#367C4A';
    case 'gitModified': return '#9B6A16';
    case 'gitConflict': return theme.error;
    case 'error': return theme.error;
  }
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
  const title = ({ file: 'Files', buffer: 'Buffers', command: 'Commands', theme: 'Themes', config: 'Config', git: 'Git' } as const)[model.mode];
  const rows: SurfaceRow[] = [{
    segments: clipSegments([
      { text: `${title}  > `, foreground: theme.accent, bold: true },
      { text: model.query.length === 0 ? 'Type to filter…' : model.query, foreground: model.query.length === 0 ? theme.muted : theme.foreground, italic: model.query.length === 0 },
    ], width),
    background: theme.surface,
  }];
  const entries = model.entries.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, maxRows - 2));
  for (const entry of entries) {
    const selected = entry.id === model.selectedId;
    const slash = Math.max(entry.label.lastIndexOf('/'), entry.label.lastIndexOf('\\'));
    const parent = slash < 0 ? '' : entry.label.slice(0, slash + 1);
    const label = slash < 0 ? entry.label : entry.label.slice(slash + 1);
    rows.push({
      segments: clipSegments([
        { text: selected ? '▸ ' : '  ', foreground: selected ? theme.accent : theme.muted },
        ...(parent.length === 0 ? [] : [{ text: parent, foreground: theme.muted }]),
        { text: label, foreground: theme.foreground, bold: selected },
        ...(entry.detail.length === 0 ? [] : [{ text: `  ${entry.detail}`, foreground: theme.muted }]),
      ], width),
      background: selected ? theme.surfaceActive : entry.id === hoveredId ? theme.selectionSecondary ?? theme.surfaceActive : theme.surface,
    });
  }
  if (rows.length < maxRows) rows.push({
    text: model.message ?? `${model.totalMatches}${model.truncated ? '+' : ''} matches  ·  ↑↓/Ctrl-NP move  ·  Enter open  ·  Esc cancel`,
    foreground: model.state === 'error' ? theme.error : theme.muted,
    background: theme.surface,
  });
  return rows;
}

function gitStateColor(state: GitReadPort['model']['sections'][number]['entries'][number]['state'], theme: WorkbenchTheme): string {
  if (state === 'conflicted' || state === 'deleted') return theme.error;
  if (state === 'modified') return '#C4872B';
  if (state === 'added' || state === 'untracked') return '#3F9A5F';
  return theme.accent;
}

function gitRows(model: GitReadPort['model'], width: number, maxRows: number, offset: number, hoveredId: string | undefined, theme: WorkbenchTheme): readonly SurfaceRow[] {
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
    rows.push({
      segments: clipSegments([
        { text: '  ' },
        { text: `${item.row.letter} `, foreground: gitStateColor(item.row.state, theme), bold: true },
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
    const oldNumber = line.oldLine === undefined ? '    ' : String(line.oldLine).padStart(4);
    const newNumber = line.newLine === undefined ? '    ' : String(line.newLine).padStart(4);
    rows.push({
      segments: clipSegments([
        { text: `${oldNumber} ${newNumber} `, foreground: theme.muted },
        { text: added ? '+ ' : removed ? '- ' : '  ', foreground: added ? '#3F9A5F' : removed ? theme.error : theme.muted, bold: added || removed },
        { text: line.text.replace(/[\r\n]+$/u, ''), foreground: theme.foreground },
      ], width),
      background: added ? theme.diffAdded ?? '#E4F3E8' : removed ? theme.diffRemoved ?? '#F8E5E8' : theme.background,
    });
  }
  return rows;
}

function hoverRows(model: HoverReadPort['model'], width: number, maxRows: number, _offset: number, _hoveredId: string | undefined, theme: WorkbenchTheme): readonly SurfaceRow[] {
  const padding = (): SurfaceRow => ({ text: '', background: theme.surface });
  if (model.state !== 'ready' || model.hover === undefined || model.hover.length === 0) {
    return [padding(), ...formatHoverLines(model, Math.max(1, width - 4), Math.max(1, maxRows - 2)).map(text => ({ text: `  ${text}`, foreground: theme.muted, background: theme.surface })), padding()];
  }
  const rows: SurfaceRow[] = [padding()];
  let code = false;
  for (const source of model.hover.split(/\r?\n/u)) {
    if (rows.length >= maxRows - 1) break;
    if (source.trimStart().startsWith('```')) { code = !code; continue; }
    if (rows.length === 1 && source.trim() === '') continue;
    const heading = /^#{1,6}\s+(.+)$/u.exec(source);
    const segments = code ? highlightHoverCode(source, theme) : heading === null
      ? [{ text: `  ${source}`, foreground: theme.foreground }]
      : [{ text: `  ${heading[1] ?? ''}`, foreground: theme.accent, bold: true }];
    rows.push({ segments: clipSegments(segments, width), background: theme.surface });
  }
  while (rows.length > 1 && rows.at(-1)?.segments?.every(segment => segment.text.trim() === '') === true) rows.pop();
  rows.push(padding());
  return rows;
}

function highlightHoverCode(source: string, theme: WorkbenchTheme): readonly SurfaceRowSegment[] {
  const segments: SurfaceRowSegment[] = [{ text: '  ', foreground: theme.foreground }];
  const token = /(\/\/.*$|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:async|await|class|const|else|extends|function|if|import|interface|let|new|return|type|typeof|var)\b|\b\d+(?:\.\d+)?\b)/gu;
  let offset = 0;
  for (const match of source.matchAll(token)) {
    const index = match.index;
    if (index > offset) segments.push({ text: source.slice(offset, index), foreground: theme.foreground });
    const value = match[0];
    const foreground = value.startsWith('//') || value.startsWith('/*') ? theme.muted
      : /^["'`]/u.test(value) ? '#B56A3B'
        : /^\d/u.test(value) ? '#8A5CB5' : theme.accent;
    segments.push({ text: value, foreground, italic: value.startsWith('/') });
    offset = index + value.length;
  }
  if (offset < source.length) segments.push({ text: source.slice(offset), foreground: theme.foreground });
  return segments;
}

function commandLineRows(model: ExCommandLineReadModel | undefined, width: number, maxRows: number, theme: WorkbenchTheme): readonly SurfaceRow[] {
  if (model === undefined) return [];
  const rows: SurfaceRow[] = [{ segments: clipSegments([{ text: ':', foreground: theme.accent, bold: true }, { text: model.source.startsWith(':') ? model.source.slice(1) : model.source, foreground: theme.foreground, bold: true }], width), background: theme.surface }];
  if (model.parseFailure !== undefined && rows.length < maxRows) {
    const detail = 'reason' in model.parseFailure ? model.parseFailure.reason : model.parseFailure.kind;
    rows.push({ text: detail, foreground: theme.error, background: theme.surface });
  } else if (rows.length < maxRows) rows.push({ text: model.acceptanceHint, foreground: theme.muted, background: theme.surface });
  const selectedCandidate = model.candidates[model.selectedIndex];
  if (model.position.typedName.length > 0 && selectedCandidate !== undefined && rows.length < maxRows) {
    rows.push({
      segments: clipSegments([
        { text: `${selectedCandidate.label}  `, foreground: theme.accent, bold: true },
        { text: selectedCandidate.detail, foreground: selectedCandidate.available ? theme.foreground : theme.error },
      ], width),
      background: theme.surfaceActive,
    });
  }
  for (let index = 0; index < model.candidates.length && rows.length < maxRows; index += 1) {
    const candidate = model.candidates[index];
    if (candidate === undefined) continue;
    const selected = index === model.selectedIndex;
    rows.push({
      segments: clipSegments([
        { text: selected ? '▸ ' : '  ', foreground: selected ? theme.accent : theme.muted },
        { text: candidate.label, foreground: candidate.available ? theme.foreground : theme.muted, bold: selected && candidate.available },
        ...(candidate.alias === undefined ? [] : [{ text: `  → ${String(candidate.commandId ?? '')}`, foreground: theme.muted }]),
      ], width),
      background: selected ? theme.surfaceActive : theme.surface,
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
    const gitColor = node.git?.state === 'conflicted' ? theme.error : node.git?.state === 'modified' ? '#9B6A16' : '#367C4A';
    const suffix = node.loadState === 'permission-denied' ? '  [permission denied]'
      : node.loadState === 'symlink-cycle' ? '  [symlink cycle]'
        : node.loadState === 'empty' && expandable ? '  [empty]'
          : node.message === undefined ? '' : `  ${node.message}`;
    rows.push({
      background,
      segments: clipSegments([
        { text: `${'  '.repeat(visible.depth)}${disclosure} `, foreground: theme.muted },
        { text: `${icon.glyph} `, foreground: iconColor(theme, icon.color) },
        { text: node.name, foreground: selected ? theme.foreground : theme.muted, bold: selected },
        ...(node.git === undefined ? [] : [{ text: ` ${node.git.label}`, foreground: gitColor }]),
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
    rows.push({
      segments: clipSegments([
        { text: location, foreground: theme.muted },
        ...(matchAt < 0 ? [{ text: match.snippet, foreground: theme.foreground }] : [
          { text: match.snippet.slice(0, matchAt), foreground: theme.foreground },
          { text: match.snippet.slice(matchAt, matchAt + query.length), foreground: theme.accent, bold: true },
          { text: match.snippet.slice(matchAt + query.length), foreground: theme.foreground },
        ]),
      ], width),
      background,
    });
  }
  if (model.truncated && rows.length < maxRows) rows.push({ text: `… ${model.totalMatches - model.matches.length} more matches`, foreground: theme.muted, background: theme.surface });
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
  const rows = <T,>(spec: RowsSurfaceSpec<T>, colors?: (theme: WorkbenchTheme) => { readonly background: string; readonly foreground: string }): JSX.Element => (
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
        isOpen: () => explorerSurface.isOpen() && (dimensions().width >= 100 || options.explorer?.isFocused?.() !== false),
        format: (model, width, maxRows, offset) => formatExplorerLines(model, width, maxRows, false, offset, props.themeBridge.current() === ASCII_WORKBENCH_THEME),
        formatRows: (model, width, maxRows, offset, hoveredId) => explorerRows(model, width, maxRows, offset, hoveredId, props.themeBridge.current() === ASCII_WORKBENCH_THEME, props.themeBridge.current()),
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
      })}
      {options.picker !== undefined && rows({
        read: options.picker.read,
        isOpen: options.picker.isOpen,
        format: formatPickerLines,
        formatRows: (model, width, maxRows, offset, hoveredId) => pickerRows(model, width, maxRows, offset, hoveredId, props.themeBridge.current()),
        maxRows: 20,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: getPickerBounds,
        panel: 'picker',
        generation: model => model.generation,
        rowIds: pickerRowIds,
        onPointer: event => forwardPanelPointer(options.picker?.onPointer, event, props.requestFrame),
        headerRows: 1,
        totalRows: model => model.entries.length,
        selectedId: model => model.selectedId,
        selectedIndex: model => model.entries.findIndex(entry => entry.id === model.selectedId),
        zIndex: 100,
      })}
      {rows<SearchReadPort['model']>({
        read: searchSurface.read,
        isOpen: searchSurface.isOpen,
        format: (model, width, maxRows, offset) => formatSearchLines(model, width, maxRows, searchSurface.selectedId(), offset, searchSurface.state()?.replaceInput ?? ''),
        formatRows: (model, width, maxRows, offset, hoveredId) => searchRows(model, width, maxRows, offset, hoveredId, searchSurface.selectedId(), searchSurface.state()?.replaceInput ?? '', props.themeBridge.current()),
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
      })}
      {options.git !== undefined && rows<GitReadPort['model']>({
        read: options.git.read,
        isOpen: options.git.isOpen,
        format: formatGitLines,
        formatRows: (model, width, maxRows, offset, hoveredId) => gitRows(model, width, maxRows, offset, hoveredId, props.themeBridge.current()),
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
      })}
      {options.gitDiff !== undefined && gitDiffRead !== undefined && rows<ReturnType<GitDiffReadPort['readModel']>>({
        read: gitDiffRead,
        isOpen: options.gitDiff.isOpen,
        format: formatGitDiffLines,
        formatRows: (model, width, maxRows, offset, hoveredId) => gitDiffRows(model, width, maxRows, offset, hoveredId, props.themeBridge.current()),
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
      }, current => ({ background: current.background, foreground: current.foreground }))}
      {options.problems !== undefined && rows<ProblemsReadPort['model']>({
        read: options.problems.read,
        isOpen: options.problems.isOpen,
        format: formatProblemsLines,
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
      })}
      {options.outline !== undefined && rows({
        read: options.outline.read,
        isOpen: options.outline.isOpen,
        format: formatOutlineLines,
        maxRows: Number.MAX_SAFE_INTEGER,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => getSidebarOutlineBounds(width, height, options.sidebar?.()),
        zIndex: 70,
      })}
      {options.hierarchy !== undefined && rows({
        read: options.hierarchy.read,
        isOpen: options.hierarchy.isOpen,
        format: formatHierarchyLines,
        maxRows: 14,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: getOutlineBounds,
        zIndex: 75,
      })}
      {options.hover !== undefined && rows({
        read: options.hover.read,
        isOpen: options.hover.isOpen,
        format: (model, width, maxRows) => formatHoverLines(model, Math.max(1, width - 4), Math.max(1, maxRows - 2)),
        formatRows: (model, width, maxRows, offset, hoveredId) => hoverRows(model, width, maxRows, offset, hoveredId, props.themeBridge.current()),
        maxRows: 12,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => popupBoundsInEditor(width, height, props.viewport.cursorCell, measureHover(options.hover!.read.model, Math.max(1, width - 2), 12), 'below', options.sidebar?.().width),
        zIndex: 110,
      })}
      {options.directoryReview !== undefined && rows({
        read: options.directoryReview.read,
        isOpen: options.directoryReview.isOpen,
        format: formatDirectoryReviewLines,
        maxRows: 16,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: getDirectoryReviewBounds,
        zIndex: 105,
      })}
      {options.completion !== undefined && rows({
        read: options.completion.read,
        isOpen: options.completion.isOpen,
        format: formatCompletionLines,
        maxRows: 10,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => popupBoundsInEditor(width, height, props.viewport.cursorCell, { width: Math.max(1, Math.min(60, width - 2)), height: 10 }, 'below', options.sidebar?.().width),
        zIndex: 120,
      })}
      {options.signature !== undefined && rows({
        read: options.signature.read,
        isOpen: options.signature.isOpen,
        format: formatSignatureLines,
        maxRows: 10,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => popupBoundsInEditor(width, height, props.viewport.cursorCell, { width: Math.max(1, Math.min(100, width - 2)), height: 8 }, 'above', options.sidebar?.().width),
        zIndex: 115,
      })}
      {options.commandLine !== undefined && commandLineRead !== undefined && rows({
        read: commandLineRead,
        isOpen: options.commandLine.isOpen,
        format: (model, width) => model === undefined ? [] : formatExCommandLineLines(model, width, 10),
        formatRows: (model, width, maxRows) => commandLineRows(model, width, maxRows, props.themeBridge.current()),
        maxRows: 18,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => getCommandLineBounds(width, height, options.commandLine!.read.model),
        zIndex: 130,
      })}
      {options.prefixHelp !== undefined && rows({
        read: options.prefixHelp,
        isOpen: () => options.prefixHelp?.model !== undefined,
        format: formatPrefixHelpLines,
        maxRows: Number.MAX_SAFE_INTEGER,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: (width, height) => getPrefixHelpBounds(width, height, options.prefixHelp?.model?.hints.length ?? 0),
        zIndex: 125,
      })}
      {options.contextMenu !== undefined && <ContextMenuBackdrop store={options.contextMenu} />}
      {options.contextMenu !== undefined && contextMenuRead !== undefined && rows({
        read: contextMenuRead,
        isOpen: () => options.contextMenu?.open === true,
        format: (state, width) => state === undefined ? [] : formatContextMenuLines(state, width),
        formatRows: (state, width) => state === undefined ? [] : state.items.map((item, index) => ({
          text: `${index === state.selectedIndex ? '› ' : '  '}${item.label}`.slice(0, width),
          foreground: index === state.selectedIndex ? props.themeBridge.current().background : item.enabled ? props.themeBridge.current().foreground : props.themeBridge.current().muted,
          background: index === state.selectedIndex ? props.themeBridge.current().accent : props.themeBridge.current().surface,
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
        onMouse: (event, row) => {
          if (event.type !== 'down') return false;
          const item = options.contextMenu?.state?.items[row];
          if (item === undefined) options.contextMenu?.dismiss();
          else options.contextMenu?.activate(item.id);
          return true;
        },
      }, current => ({ background: current.background, foreground: current.foreground }))}
      {rows({
        read: outputSurface.read,
        isOpen: outputSurface.isOpen,
        format: formatTaskOutputLines,
        maxRows: 10,
        background: props.theme.surface,
        foreground: props.theme.foreground,
        bounds: getProblemsBounds,
        zIndex: 80,
      })}
    </box>
  );
}

export function createWorkbenchAppNode(props: WorkbenchAppProps): SolidNode {
  return () => <WorkbenchApp {...props} />;
}
