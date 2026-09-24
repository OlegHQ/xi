export type WorkbenchPanel = 'explorer' | 'picker' | 'search' | 'problems' | 'git' | 'git-diff' | 'outline';

/** Stable row identity from the immutable panel model actually painted. */
export interface WorkbenchPanelPointerEvent {
  readonly panel: WorkbenchPanel;
  /** Preview is a non-committing hover action (used by the theme picker). */
  readonly action: 'activate' | 'context' | 'preview';
  readonly itemId: string;
  readonly generation: number;
  readonly row: number;
  readonly column: number;
  readonly button: 0 | 2;
  /** Absolute terminal cell of the click, for positioning a context menu. */
  readonly screenX: number;
  readonly screenY: number;
}

/** Keeps pointer rows tied to the exact model generation used for painting. */
export class PanelHitMap {
  #generation = -1;
  #rows: readonly (string | undefined)[] = Object.freeze([]);

  get generation(): number { return this.#generation; }

  publish(generation: number, rows: readonly (string | undefined)[]): void {
    this.#generation = generation;
    this.#rows = Object.freeze([...rows]);
  }

  resolve(row: number, currentGeneration: number): string | undefined {
    if (this.#generation !== currentGeneration || !Number.isSafeInteger(row) || row < 0) return undefined;
    return this.#rows[row];
  }
}

/** Bounded vertical scroll/drag bookkeeping shared by every list-shaped panel. */
export class PanelScroll {
  #offset = 0;
  #dragAnchor: { readonly startRow: number; readonly startOffset: number } | undefined;
  #followedId: string | undefined;
  #viewport = 0;

  get offset(): number { return this.#offset; }
  get dragging(): boolean { return this.#dragAnchor !== undefined; }

  clamp(total: number, viewport: number): void {
    this.#offset = Math.min(Math.max(0, this.#offset), Math.max(0, total - viewport));
  }

  scrollBy(delta: number, total: number, viewport: number): boolean {
    const max = Math.max(0, total - viewport);
    const next = Math.min(Math.max(0, this.#offset + delta), max);
    const changed = next !== this.#offset;
    this.#offset = next;
    return changed;
  }

  /** Reveals the selected row only when the selection changes, so wheel/drag scrolling
   * away from it is not snapped back on the next paint. Always clamps. */
  follow(selectedId: string | undefined, indexOf: () => number, total: number, viewport: number): void {
    if (selectedId !== this.#followedId || viewport !== this.#viewport) {
      this.#followedId = selectedId;
      this.#viewport = viewport;
      const index = selectedId === undefined ? -1 : indexOf();
      if (index >= 0 && index < this.#offset) this.#offset = index;
      else if (index >= this.#offset + viewport) this.#offset = index - viewport + 1;
    }
    this.clamp(total, viewport);
  }

  beginDrag(row: number): void {
    this.#dragAnchor = { startRow: row, startOffset: this.#offset };
  }

  dragTo(row: number, total: number, viewport: number): boolean {
    if (this.#dragAnchor === undefined) return false;
    const max = Math.max(0, total - viewport);
    if (max === 0) return false;
    const rowsPerCell = total / Math.max(1, viewport);
    const next = Math.min(Math.max(0, this.#dragAnchor.startOffset + Math.round((row - this.#dragAnchor.startRow) * rowsPerCell)), max);
    const changed = next !== this.#offset;
    this.#offset = next;
    return changed;
  }

  endDrag(): void {
    this.#dragAnchor = undefined;
  }

  reset(): void {
    this.#offset = 0;
    this.#dragAnchor = undefined;
    this.#followedId = undefined;
    this.#viewport = 0;
  }

  /** Thumb bounds within the viewport track, or undefined when content fits without scrolling. */
  thumb(total: number, viewport: number): { readonly start: number; readonly size: number } | undefined {
    if (total <= viewport || viewport <= 0) return undefined;
    const size = Math.max(1, Math.floor((viewport * viewport) / total));
    const trackSpace = Math.max(0, viewport - size);
    const max = Math.max(1, total - viewport);
    const start = Math.round((this.#offset / max) * trackSpace);
    return { start, size };
  }
}

/** Lines to scroll for a wheel event; 0 for a horizontal one. A trackpad drag drifts sideways
 * and emits left/right wheel events, which must not move the view up and down. */
export function verticalWheelDelta(scroll: { readonly direction: string; readonly delta: number } | undefined): number {
  return scroll?.direction === 'up' ? -scroll.delta : scroll?.direction === 'down' ? scroll.delta : 0;
}
