import type { Disposable } from '../../contracts/src/index';

/** One visible outline tree row in display order (the host owns expansion and selection). */
export interface OutlineRowRead { readonly id: string; readonly name: string; readonly detail?: string; readonly kind: number; readonly depth: number; readonly expandable: boolean; readonly expanded: boolean; }
export interface OutlineReadModel {
  readonly state: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
  readonly message: string | undefined;
  readonly generation: number;
  readonly rows: readonly OutlineRowRead[];
  readonly selectedId: string | undefined;
  /** Innermost symbol at the editor cursor. */
  readonly activeId: string | undefined;
  readonly focused: boolean;
}
export interface OutlineReadPort { readonly model: OutlineReadModel; subscribe(listener: (model: OutlineReadModel) => void): Disposable; }

/** Placeholder shown instead of rows (VS Code's wording), or undefined when rows exist. */
export function outlineEmptyMessage(model: OutlineReadModel): string | undefined {
  if (model.rows.length > 0) return undefined;
  if (model.state === 'loading' || model.state === 'idle') return 'Loading document symbols…';
  if (model.state === 'ready') return 'No symbols found in document';
  return model.state === 'unavailable' ? 'The active editor cannot provide outline information.' : model.message ?? 'Outline failed';
}

/** Leading cells of a row before its icon: two per depth, then the disclosure chevron and a gap. */
export function outlineRowIndent(row: OutlineRowRead): number { return row.depth * 2 + 2; }

export function formatOutlineLines(model: OutlineReadModel, width: number, maxRows = 12, offset = 0): readonly string[] {
  const empty = outlineEmptyMessage(model);
  if (empty !== undefined) return Object.freeze([empty.slice(0, Math.max(1, width))]);
  return Object.freeze(model.rows.slice(offset, offset + maxRows).map((row) => `${'  '.repeat(row.depth)}${row.expandable ? (row.expanded ? 'v' : '>') : ' '} ${row.name}`.slice(0, Math.max(1, width))));
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

/** LSP `SymbolKind` → Material Design glyph (Nerd Font v3 `nf-md-*`, the set the Files tab
 * icons use; verified against upstream `glyphnames.json`; VS Code's shapes where one exists), an ASCII stand-in, and the syntax scope whose theme color tints it; the hex
 * is VS Code's `symbolIcon.*Foreground` default, used when the theme lacks that scope. */
export interface OutlineKindIcon { readonly glyph: string; readonly ascii: string; readonly scope: string; readonly fallback: string | undefined; }
const ORANGE = '#D67E00'; const PURPLE = '#8A4FB8'; const BLUE = '#1A85C8';
const kind = (glyph: string, ascii: string, scope: string, fallback?: string): OutlineKindIcon => Object.freeze({ glyph, ascii, scope, fallback });
const OUTLINE_KIND_ICONS: Readonly<Record<number, OutlineKindIcon>> = Object.freeze({
  1: kind('\u{f0224}', 'f', 'ui.text'), // File: nf-md-file_outline
  2: kind('\u{f0169}', 'm', 'namespace'), // Module: nf-md-code_braces
  3: kind('\u{f0169}', 'n', 'namespace'), // Namespace: nf-md-code_braces
  4: kind('\u{f03d3}', 'p', 'namespace'), // Package: nf-md-package
  5: kind('\u{f0bf1}', 'C', 'type', ORANGE), // Class: nf-md-alpha_c_box_outline
  6: kind('\u{f01a7}', 'M', 'function.method', PURPLE), // Method: nf-md-cube_outline
  7: kind('\u{f05b7}', 'p', 'variable.other.member', BLUE), // Property: nf-md-wrench
  8: kind('\u{f04f9}', 'f', 'variable.other.member', BLUE), // Field: nf-md-tag
  9: kind('\u{f01a6}', 'c', 'constructor', PURPLE), // Constructor: nf-md-cube
  10: kind('\u{f027a}', 'E', 'type.enum', ORANGE), // Enum: nf-md-format_list_bulleted_type
  11: kind('\u{f0c03}', 'I', 'type', BLUE), // Interface: nf-md-alpha_i_box_outline
  12: kind('\u{f0295}', 'F', 'function', PURPLE), // Function: nf-md-function
  13: kind('\u{f0ae7}', 'v', 'variable', BLUE), // Variable: nf-md-variable
  14: kind('\u{f0423}', 'K', 'constant'), // Constant: nf-md-pound
  15: kind('\u{f027e}', 's', 'string'), // String: nf-md-format_quote_close
  16: kind('\u{f03a0}', '#', 'constant.numeric'), // Number: nf-md-numeric
  17: kind('\u{f0a1a}', 'b', 'constant.builtin.boolean'), // Boolean: nf-md-toggle_switch_outline
  18: kind('\u{f016a}', 'a', 'punctuation.bracket'), // Array: nf-md-code_brackets
  19: kind('\u{f0169}', 'o', 'namespace'), // Object: nf-md-code_braces
  20: kind('\u{f030b}', 'k', 'variable.other.member'), // Key: nf-md-key_variant
  21: kind('\u{f07e2}', '0', 'constant.builtin'), // Null: nf-md-null
  22: kind('\u{f027b}', 'e', 'type.enum.variant', BLUE), // EnumMember: nf-md-format_list_numbered
  23: kind('\u{f0c21}', 'S', 'type', ORANGE), // Struct: nf-md-alpha_s_box_outline
  24: kind('\u{f140b}', 'e', 'type', ORANGE), // Event: nf-md-lightning_bolt
  25: kind('\u{f0992}', 'o', 'operator'), // Operator: nf-md-plus_minus
  26: kind('\u{f0c24}', 'T', 'type.parameter'), // TypeParameter: nf-md-alpha_t_box_outline
});
const UNKNOWN_KIND_ICON = kind('\u{f0625}', '?', 'ui.text'); // nf-md-help_circle_outline

export function outlineKindIcon(symbolKind: number): OutlineKindIcon { return OUTLINE_KIND_ICONS[symbolKind] ?? UNKNOWN_KIND_ICON; }

