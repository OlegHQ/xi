import { parseColor, type OptimizedBuffer } from '@opentui/core/renderer';
import { projectComparisonSide, ViewportLayout, type ComparisonRow, type VisibleFrame } from '../../layout/src/index';
import type { DiffViewReadModel } from '../../workbench/src/entrypoints/launch';
import type { WorkbenchViewSnapshot } from '../../workbench/src/index';
import type { SyntaxReadPort } from '../../contracts/src/index';
import { paintEditorFrame } from '../editor/motion-paint';
import { resolveMotionPaintTokens, type EditorColorMode } from '../theme/motion-tokens';
import type { WorkbenchTheme } from '../theme/workbench-themes';
import { helixThemeColor, themeColor } from '../theme/color-input';

export interface ComparisonReadPort {
  readComparison(): DiffViewReadModel | undefined;
  onPointer(delta: number): void;
}
export interface ComparisonPaint {
  readonly frame: VisibleFrame | undefined;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly gutter: number;
  readonly cursor: { readonly x: number; readonly y: number } | undefined;
}

/** Uses normal document layout and syntax painting on both sides. Only the current-file
 * frame is published for editing; removed/alignment rows never have an editable hit. */
export class ComparisonEditor {
  readonly #left = new ViewportLayout();
  readonly #right = new ViewportLayout();
  readonly #positions = new Map<string, { top: number; cursor: number; requestedTop: number; split: boolean }>();

  paint(buffer: OptimizedBuffer, model: DiffViewReadModel, view: WorkbenchViewSnapshot, rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }, theme: WorkbenchTheme, syntax?: SyntaxReadPort, ascii = false, colorMode: EditorColorMode = 'truecolor'): ComparisonPaint {
    const split = rect.width >= 110;
    const height = Math.max(1, rect.height - 1);
    const gutter = Math.max(5, String(Math.max(model.left.lineCount, model.right.lineCount)).length + 2);
    const leftWidth = split ? Math.floor((rect.width - 1) / 2) : rect.width;
    const rightX = split ? rect.x + leftWidth + 1 : rect.x;
    const rightWidth = split ? rect.width - leftWidth - 1 : rect.width;
    const alignment = split ? model.split : model.unified;
    const rows = alignment.rows;
    const primary = view.selections.members.find(member => member.id === view.selections.primaryId);
    const cursorOffset = primary?.head.at.offset;
    const cursorLine = cursorOffset === undefined ? undefined : model.right.lineIndexAt(cursorOffset);
    const line = cursorLine?.ok ? cursorLine.value : 0;
    const pending = model.state !== 'ready';
    let cursorRow = pending ? line : alignment.rowForRightLine[line] ?? rows.length;
    if (cursorRow < 0) cursorRow = rows.length;
    let state = this.#positions.get(model.viewId);
    if (state === undefined || state.split !== split || state.requestedTop !== model.scrollTop) {
      const mappedTop = pending ? model.scrollTop : alignment.rowForRightLine[model.scrollTop] ?? rows.length - height;
      state = { top: Math.max(0, mappedTop), cursor: -1, requestedTop: model.scrollTop, split };
      this.#positions.set(model.viewId, state);
    }
    if (model.editable && state.cursor !== cursorOffset) {
      if (cursorRow < state.top + 2) state.top = Math.max(0, cursorRow - 2);
      if (cursorRow >= state.top + height - 2) state.top = Math.max(0, cursorRow - height + 3);
      state.cursor = cursorOffset ?? 0;
    }
    const visible: ComparisonRow[] = [];
    for (let index = state.top; index < state.top + height; index += 1) {
      const row = pending ? { left: index < model.left.lineCount ? index : null, right: index < model.right.lineCount ? index : null, removed: false, added: false } : rows[index];
      // A trailing empty logical line is editable even when Git's diff has no final row.
      visible.push(row ?? { left: null, right: index === rows.length && alignment.rowForRightLine[model.right.lineCount - 1] === undefined ? model.right.lineCount - 1 : null, removed: false, added: false });
    }
    const input = { viewId: model.viewId, snapshot: model.right, selection: { ...view.selections, documentId: model.right.id, documentVersion: model.right.version }, widthCells: rightWidth, heightCells: height, options: { wrap: false, gutterWidthCells: gutter, horizontalScrollCells: view.scrollLeft } };
    const right = projectComparisonSide(this.#right, input, visible, 'right');
    const left = projectComparisonSide(this.#left, { ...input, snapshot: model.left, widthCells: leftWidth }, visible, 'left');
    const foreground = parseColor(themeColor(theme.foreground));
    const background = parseColor(themeColor(theme.background, 'bg'));
    const muted = parseColor(themeColor(theme.muted));
    const accent = parseColor(themeColor(theme.accent));
    const added = parseColor(helixThemeColor(theme, 'diff.plus', 'bg', theme.diffAdded ?? (background.r < 0.5 ? '#243D2B' : '#E4F3E8')));
    const removed = parseColor(helixThemeColor(theme, 'diff.minus', 'bg', theme.diffRemoved ?? (background.r < 0.5 ? '#48282D' : '#F8E5E8')));
    const paint = (frame: VisibleFrame | undefined, side: 'left' | 'right', x: number): void => {
      if (frame === undefined) return;
      const source = side === 'left' ? model.left : model.right;
      const syntaxRead = syntax?.readSyntax(source.id);
      for (let row = 0; row < visible.length; row += 1) {
        const mapping = visible[row]!;
        if (!split && (side === 'left' ? mapping.right !== null : mapping.right === null)) continue;
        const change = side === 'left' ? mapping.removed : mapping.added;
        const color = change ? side === 'left' ? removed : added : background;
        buffer.fillRect(x, rect.y + row + 1, frame.widthCells, 1, color);
        if (mapping[side] === null) {
          if (split && mapping[side === 'left' ? 'right' : 'left'] !== null) buffer.drawText((ascii ? '/' : '╱').repeat(frame.widthCells), x, rect.y + row + 1, muted, parseColor(themeColor(theme.surface, 'bg')));
          continue;
        }
        paintEditorFrame(buffer, { frame: model.editable && side === 'right' ? frame : { ...frame, selections: [] }, mode: view.session.mode, theme: resolveMotionPaintTokens(theme), foreground, muted, background: color, accent, colorMode, ascii, x, y: rect.y + 1, rows: { start: row, end: row + 1 }, ...(syntaxRead === undefined ? {} : { syntax: syntaxRead }), ...(theme.syntax === undefined ? {} : { syntaxColors: theme.syntax }), ...(theme.styles === undefined && theme.syntaxStyles === undefined ? {} : { syntaxStyles: theme.styles ?? theme.syntaxStyles! }) });
        buffer.drawText(change ? side === 'left' ? ascii ? '-' : '−' : '+' : ' ', x + gutter - 1, rect.y + row + 1, change ? accent : muted, color);
      }
    };
    buffer.fillRect(rect.x, rect.y, rect.width, rect.height, background);
    paint(left, 'left', rect.x);
    paint(right, 'right', rightX);
    const header = `${model.path}  ${model.leftLabel} (read-only) ${ascii ? '<->' : '↔'} ${model.rightLabel}${pending ? ' · updating diff…' : ''}`;
    buffer.drawText(header.slice(0, rect.width), rect.x, rect.y, accent, parseColor(themeColor(theme.surface, 'bg')));
    if (split) {
      for (let row = 1; row < rect.height; row += 1) buffer.drawText(ascii ? '|' : '│', rect.x + leftWidth, rect.y + row, muted, background);
    }
    const point = right?.selections.find(selection => selection.primary)?.head.position;
    return { frame: model.editable ? right : undefined, x: rightX, y: rect.y + 1, width: rightWidth, height, gutter, cursor: point == null ? undefined : { x: rightX + point.column, y: rect.y + 1 + point.row } };
  }
  dispose(): void { this.#left.dispose(); this.#right.dispose(); this.#positions.clear(); }
}
