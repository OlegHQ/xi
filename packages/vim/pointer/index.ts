import { defaultCellWidthPolicy } from '../../layout/src/index';
import { asUtf16Offset } from '../../contracts/src/index';
import type { DocumentSnapshot } from '../../document/src/index';
import type { Disposable, InputModifiers } from '../../contracts/src/index';

export type PointerGestureKind = 'click' | 'drag' | 'word' | 'line' | 'block' | 'add-caret' | 'wheel';
export interface PointerTextTarget {
  readonly lineIndex: number;
  readonly offset: number;
  readonly displayCellColumn: number;
  readonly virtualCell: number;
  readonly cellPart: 'glyph' | 'wide-continuation' | 'tab-fill' | 'clipped-glyph' | 'padding';
}
export interface PointerCell { readonly row: number; readonly column: number; readonly target?: PointerTextTarget; }
export interface PointerEvent {
  readonly phase: 'down' | 'move' | 'up' | 'wheel';
  readonly viewId: string;
  readonly cell: PointerCell;
  readonly button: number | null;
  readonly modifiers: InputModifiers;
  readonly wheelDelta: number;
  readonly frameId: number;
  readonly viewportHeight?: number;
  /** Monotonic clock reading (e.g. `performance.now()`) taken by the caller when the
   * event occurred. `packages/vim` owns no clock of its own -- multi-click detection
   * (see `handle` below) reads this instead of sampling time itself. */
  readonly timestampMilliseconds: number;
}
export interface PointerSelectionIntent { readonly kind: PointerGestureKind; readonly viewId: string; readonly anchor: PointerCell; readonly head: PointerCell; readonly modifiers: InputModifiers; }
export interface PointerEnginePort { cancelPendingOperator(): void; place(intent: PointerSelectionIntent): void; scroll(viewId: string, delta: number, viewportHeight: number | undefined): void; }

/** Captures a pointer gesture to its press view until release/cancellation. */
export class PointerGestureController implements Disposable {
  readonly #engine: PointerEnginePort;
  #capture: { readonly viewId: string; readonly anchor: PointerCell; readonly kind: PointerGestureKind; readonly modifiers: InputModifiers; readonly frameId: number } | undefined;
  #disposed = false;
  #lastClick: { readonly viewId: string; readonly button: number; readonly cell: PointerCell; readonly at: number; readonly count: number } | undefined;
  constructor(engine: PointerEnginePort) { this.#engine = engine; }
  get capturedViewId(): string | undefined { return this.#capture?.viewId; }
  handle(event: PointerEvent): boolean {
    if (this.#disposed) return false;
    if (event.phase === 'wheel') { this.#engine.scroll(event.viewId, event.wheelDelta, event.viewportHeight); return true; }
    if (event.phase === 'down' && event.button === 0) {
      const now = event.timestampMilliseconds;
      const previous = this.#lastClick;
      const sameCell = previous !== undefined && previous.viewId === event.viewId && previous.button === event.button
        && Math.abs(previous.cell.row - event.cell.row) <= 1 && Math.abs(previous.cell.column - event.cell.column) <= 1
        && now - previous.at <= 500;
      const clickCount = sameCell && previous !== undefined ? Math.min(3, previous.count + 1) : 1;
      this.#lastClick = Object.freeze({ viewId: event.viewId, button: event.button, cell: event.cell, at: now, count: clickCount });
      const kind = event.modifiers.alt && event.modifiers.shift ? 'block'
        : event.modifiers.alt ? 'add-caret'
          : clickCount >= 3 ? 'line' : clickCount === 2 ? 'word' : 'click';
      this.#engine.cancelPendingOperator();
      this.#capture = Object.freeze({ viewId: event.viewId, anchor: event.cell, kind, modifiers: event.modifiers, frameId: event.frameId });
      return true;
    }
    const capture = this.#capture;
    if (capture === undefined || capture.viewId !== event.viewId || capture.frameId !== event.frameId) return false;
    if (event.phase === 'move') {
      if (capture.kind === 'click' && (event.cell.row !== capture.anchor.row || event.cell.column !== capture.anchor.column)) this.#capture = Object.freeze({ ...capture, kind: capture.modifiers.alt && capture.modifiers.shift ? 'block' : 'drag' });
      const current = this.#capture;
      if (current !== undefined) {
        this.#engine.place({ kind: current.kind, viewId: current.viewId, anchor: current.anchor, head: event.cell, modifiers: current.modifiers });
        const viewportHeight = event.viewportHeight;
        if (viewportHeight !== undefined && Number.isSafeInteger(viewportHeight) && viewportHeight > 1) {
          if (event.cell.row === 0) this.#engine.scroll(event.viewId, -1, viewportHeight);
          else if (event.cell.row === viewportHeight - 1) this.#engine.scroll(event.viewId, 1, viewportHeight);
        }
      }
      return true;
    }
    if (event.phase === 'up') { const kind = capture.kind === 'click' && event.cell.row === capture.anchor.row && event.cell.column === capture.anchor.column ? 'click' : capture.kind; this.#engine.place({ kind, viewId: capture.viewId, anchor: capture.anchor, head: event.cell, modifiers: capture.modifiers }); this.#capture = undefined; return true; }
    return false;
  }
  cancel(reason: 'focus-loss' | 'resize' | 'escape' | 'dispose' = 'escape'): void { if (this.#capture === undefined) return; this.#capture = undefined; if (reason !== 'dispose') this.#engine.cancelPendingOperator(); }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.#lastClick = undefined; this.cancel('dispose'); }
}

/** Cell-column arithmetic delegates to the same owner as on-screen shaping
 * (`packages/layout/src/shaping.ts`'s tab-expansion formula and `defaultCellWidthPolicy`'s
 * grapheme-width table) instead of a second, pointer-only implementation. */
export function pointerDisplayColumn(snapshot: DocumentSnapshot, offsetValue: number, lineStartValue: number, tabSize = 8): number {
  const start = asUtf16Offset(lineStartValue);
  const end = asUtf16Offset(Math.max(lineStartValue, offsetValue));
  if (!start.ok || !end.ok) return 0;
  const prefix = snapshot.slice(start.value, end.value);
  if (!prefix.ok) return 0;
  const widthPolicy = defaultCellWidthPolicy();
  let column = 0;
  for (const cluster of prefix.value) column += cluster === '\t' ? tabSize - (column % tabSize) : widthPolicy.widthOfCluster(cluster);
  return column;
}
