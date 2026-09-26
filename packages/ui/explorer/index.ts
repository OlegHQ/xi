import type { Disposable } from '../../contracts/src/index';
import { resolveFileIcon } from './icons';
export type ExplorerNodeKind = 'root' | 'directory' | 'file' | 'symlink' | 'other' | 'state';
export type ExplorerLoadState = 'unloaded' | 'loading' | 'ready' | 'empty' | 'permission-denied' | 'symlink-cycle' | 'overflow' | 'error';
export interface ExplorerNode { readonly id: string; readonly rootId: string; readonly parentId: string | undefined; readonly name: string; readonly relativePath: string; readonly path: string; readonly kind: ExplorerNodeKind; readonly depth: number; readonly expanded: boolean; readonly hidden: boolean; readonly ignored: boolean; readonly loadState: ExplorerLoadState; readonly children: readonly string[]; readonly stableIdentity: string; readonly sizeBytes: number | undefined; readonly modifiedMilliseconds: number | undefined; readonly permissions: string | undefined; readonly symlinkTarget: string | undefined; readonly git: ExplorerGitDecoration | undefined; readonly message: string | undefined; }
export type ExplorerGitState = 'clean' | 'modified' | 'staged' | 'untracked' | 'ignored' | 'conflicted';
export interface ExplorerGitDecoration { readonly state: ExplorerGitState; readonly label: string; readonly colorToken: string; }
export interface ExplorerVisibleRow { readonly nodeId: string; readonly depth: number; readonly kind: ExplorerNodeKind; readonly selected: boolean; readonly label?: string; }
export interface ExplorerReadModel { readonly edit?: { readonly mode: string; readonly cursorColumn: number; readonly visualIds: readonly string[]; readonly scroll?: { readonly generation: number; readonly offset: number }; readonly prompt?: string; readonly dirty?: boolean; readonly pendingIds?: readonly string[]; readonly review?: { readonly lines: readonly string[]; readonly selectedIndex: number; readonly confirm: boolean; readonly busy: boolean } }; readonly contractVersion: 1; readonly generation: number; readonly roots: readonly string[]; readonly nodes: readonly ExplorerNode[]; readonly visibleRows: readonly ExplorerVisibleRow[]; readonly selectedId: string | undefined; readonly filter: string; readonly includeHidden: boolean; readonly includeIgnored: boolean; readonly followSymlinks: boolean; readonly flattenDirs: boolean; readonly focused: boolean; readonly state: 'ready' | 'loading' | 'empty' | 'error'; readonly message: string | undefined; }
export interface ExplorerReadPort { readonly model: ExplorerReadModel; subscribe(listener: (model: ExplorerReadModel) => void): Disposable; }
export interface ExplorerTheme { readonly selected?: string; readonly background: string; readonly surface: string; readonly surfaceActive: string; readonly foreground: string; readonly muted: string; readonly border: string; readonly accent: string; readonly error: string; readonly gitModified: string; readonly gitAdded: string; readonly gitConflict: string; }
export const DEFAULT_EXPLORER_THEME: ExplorerTheme = Object.freeze({ background: '#FAF9F6', surface: '#F1F0EC', surfaceActive: '#E7EDF4', foreground: '#24292E', muted: '#60666D', border: '#D5D4CF', accent: '#245A88', error: '#A52A36', gitModified: '#9B6A16', gitAdded: '#367C4A', gitConflict: '#A52A36' });
function nodeLine(node: ExplorerNode, depth: number, ascii: boolean, label = node.name): string {
  if (node.kind === 'state') return `${'  '.repeat(depth)}${node.message ?? node.name}`;
  const disclosure = node.kind === 'directory' || node.kind === 'root' || node.kind === 'symlink'
    ? node.loadState === 'loading' ? '·' : node.expanded ? (ascii ? 'v' : '▾') : (ascii ? '>' : '▸')
    : ' ';
  const icon = node.kind === 'root' ? '⌂' : node.kind === 'symlink' ? '↪' : node.kind === 'directory' || node.kind === 'file'
    ? resolveFileIcon(node.name, node.kind, node.expanded, ascii).glyph
    : '?';
  const git = node.git === undefined ? '' : ` ${node.git.label}`;
  const suffix = node.loadState === 'permission-denied' ? '  [permission denied]'
    : node.loadState === 'symlink-cycle' ? '  [symlink cycle]'
      : node.loadState === 'empty' && (node.kind === 'directory' || node.kind === 'root') ? '  [empty]'
        : node.message === undefined ? '' : `  ${node.message}`;
  return `${'  '.repeat(depth)}${disclosure} ${icon} ${label}${git}${suffix}`;
}
export function formatExplorerLines(model: ExplorerReadModel, width: number, maxRows: number, showHeader = true, scrollOffset = 0, ascii = false): readonly string[] {
  const safeWidth = Math.max(1, Math.trunc(width)); const safeRows = Math.max(1, Math.trunc(maxRows)); const lines: string[] = [];
  if (showHeader && lines.length < safeRows) lines.push((model.filter.length > 0 ? `Files  /${model.filter}` : 'Files').slice(0, safeWidth));
  if (model.visibleRows.length === 0 && lines.length < safeRows) lines.push((model.state === 'error' ? (model.message ?? 'Unable to read workspace') : model.state === 'loading' ? 'Loading…' : 'No files').slice(0, safeWidth));
  for (const row of model.visibleRows.slice(Math.max(0, Math.trunc(scrollOffset)))) { if (lines.length >= safeRows) break; const node = model.nodes.find(candidate => candidate.id === row.nodeId); if (node !== undefined) lines.push(nodeLine(node, row.depth, ascii, row.label).slice(0, safeWidth)); }
  return Object.freeze(lines);
}
export function explorerRowIds(model: ExplorerReadModel, offset: number, rows: number): readonly (string | undefined)[] { return [undefined, ...model.visibleRows.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, rows - 1)).map(row => row.nodeId)].slice(0, Math.max(0, rows)); }
