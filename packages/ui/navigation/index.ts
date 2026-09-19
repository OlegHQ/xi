import type { Disposable } from '../../contracts/src/index';

export interface OutlineSymbolRead { readonly id: string; readonly name: string; readonly detail?: string; readonly kind: number; readonly children: readonly OutlineSymbolRead[]; }
export interface OutlineReadModel { readonly state: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'; readonly symbols: readonly OutlineSymbolRead[]; readonly message: string | undefined; }
export interface OutlineReadPort { readonly model: OutlineReadModel; subscribe(listener: (model: OutlineReadModel) => void): Disposable; }

export function formatOutlineLines(model: OutlineReadModel, width: number, maxRows = 12): readonly string[] {
  const rows = [model.message ?? (model.state === 'loading' ? 'Outline loading…' : model.state === 'unavailable' ? 'Outline unavailable' : 'Outline')];
  const visit = (symbols: readonly OutlineSymbolRead[], depth: number): void => {
    for (const symbol of symbols) {
      if (rows.length >= maxRows) return;
      rows.push(`${'  '.repeat(depth)}${symbol.name}${symbol.detail === undefined ? '' : ` — ${symbol.detail}`}`.slice(0, Math.max(1, width)));
      visit(symbol.children, depth + 1);
    }
  };
  visit(model.symbols, 0);
  return Object.freeze(rows);
}

export interface HierarchyNodeRead { readonly id: string; readonly name: string; readonly detail?: string; readonly kind: number; readonly children: readonly HierarchyNodeRead[]; readonly cycle?: boolean; }
export interface HierarchyLinkRead { readonly target?: string; readonly tooltip?: string; }
export interface HierarchyReadModel { readonly state: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'; readonly nodes: readonly HierarchyNodeRead[]; readonly links: readonly HierarchyLinkRead[]; readonly message: string | undefined; }
export interface HierarchyReadPort { readonly model: HierarchyReadModel; subscribe(listener: (model: HierarchyReadModel) => void): Disposable; }

export function formatHierarchyLines(model: HierarchyReadModel, width: number, maxRows = 14): readonly string[] {
  const title = model.message ?? (model.state === 'loading' ? 'Hierarchy loading…' : model.state === 'unavailable' ? 'Hierarchy unavailable' : 'Hierarchy');
  const rows = [title];
  const visit = (nodes: readonly HierarchyNodeRead[], depth: number): void => {
    for (const node of nodes) {
      if (rows.length >= Math.max(1, Math.trunc(maxRows))) return;
      rows.push(`${'  '.repeat(depth)}${node.cycle === true ? '↻ ' : ''}${node.name}${node.detail === undefined ? '' : ` — ${node.detail}`}`.slice(0, Math.max(1, width)));
      visit(node.children, depth + 1);
    }
  };
  visit(model.nodes, 0);
  return Object.freeze(rows);
}

export interface HoverReadModel { readonly state: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'; readonly hover: string | undefined; readonly message: string | undefined; }
export interface HoverReadPort { readonly model: HoverReadModel; subscribe(listener: (model: HoverReadModel) => void): Disposable; }
export interface PopupTheme { readonly background: string; readonly foreground: string; readonly muted: string; readonly accent: string; }
export const DEFAULT_POPUP_THEME: PopupTheme = Object.freeze({ background: '#F1F0EC', foreground: '#24292E', muted: '#60666D', accent: '#245A88' });

export function formatHoverLines(model: HoverReadModel, width: number, maxRows = 12): readonly string[] {
  const safeWidth = Math.max(1, Math.trunc(width));
  const safeRows = Math.max(1, Math.trunc(maxRows));
  if (model.state !== 'ready' || model.hover === undefined || model.hover.length === 0) {
    return Object.freeze([(model.message ?? (model.state === 'loading' ? 'Hover loading…' : model.state === 'unavailable' ? 'Hover unavailable' : 'No hover information')).slice(0, safeWidth)]);
  }
  const rows: string[] = [];
  for (const line of model.hover.split(/\r?\n/u)) {
    if (rows.length >= safeRows) break;
    if (line.trimStart().startsWith('```') || (rows.length === 0 && line.trim() === '')) continue;
    rows.push(line.slice(0, safeWidth));
  }
  while (rows.length > 0 && rows[rows.length - 1]?.trim() === '') rows.pop();
  return Object.freeze(rows.length === 0 ? [''] : rows);
}

export function measureHover(model: HoverReadModel, maxWidth: number, maxRows = 12): { readonly width: number; readonly height: number } {
  const safeRows = Math.max(3, Math.trunc(maxRows));
  const rows = formatHoverLines(model, Math.max(1, Math.min(80, maxWidth - 4)), safeRows - 2);
  const widest = rows.reduce((max, row) => Math.max(max, [...row].length), 0);
  return { width: Math.max(1, Math.min(maxWidth, widest + 4)), height: Math.min(safeRows, rows.length + 2) };
}
