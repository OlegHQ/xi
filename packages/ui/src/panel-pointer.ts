import type { MouseEvent, Renderable } from '@opentui/core/renderer';

export type WorkbenchPanel = 'explorer' | 'picker' | 'search' | 'problems';

/** Stable row identity from the immutable panel model actually painted. */
export interface WorkbenchPanelPointerEvent {
  readonly panel: WorkbenchPanel;
  readonly action: 'activate' | 'context';
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

export interface PanelScrollHooks {
  /** Column occupied by the scrollbar track, or undefined when no scrollbar is shown. */
  readonly scrollbarColumn: () => number | undefined;
  readonly isDragging: () => boolean;
  readonly scrollBy: (delta: number) => void;
  readonly beginDrag: (row: number) => void;
  readonly dragTo: (row: number) => void;
  readonly endDrag: () => void;
}

export function installPanelPointerHandler(
  renderable: Renderable,
  panel: WorkbenchPanel,
  hitMap: PanelHitMap,
  currentGeneration: () => number,
  onPointer: ((event: WorkbenchPanelPointerEvent) => boolean) | undefined,
  scroll?: PanelScrollHooks,
): void {
  if (onPointer === undefined && scroll === undefined) return;
  renderable.onMouse = (event: MouseEvent): void => {
    const row = event.y - renderable.screenY;
    const column = event.x - renderable.screenX;
    if (event.type === 'scroll') {
      if (scroll === undefined) return;
      const delta = event.scroll === undefined ? 0 : Math.max(1, event.scroll.delta) * (event.scroll.direction === 'up' ? -1 : 1);
      if (delta !== 0) scroll.scrollBy(delta);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (scroll !== undefined && scroll.isDragging() && (event.type === 'drag' || event.type === 'drag-end' || event.type === 'up') && event.target === renderable) {
      if (event.type === 'drag') scroll.dragTo(row);
      else scroll.endDrag();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.type !== 'down' || (event.button !== 0 && event.button !== 2)) return;
    if (scroll !== undefined && event.button === 0 && column === scroll.scrollbarColumn()) {
      scroll.beginDrag(row);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (onPointer === undefined) return;
    const itemId = hitMap.resolve(row, currentGeneration());
    if (itemId === undefined) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const handled = onPointer({
      panel,
      action: event.button === 0 ? 'activate' : 'context',
      itemId,
      generation: hitMap.generation,
      row,
      column,
      button: event.button,
      screenX: event.x,
      screenY: event.y,
    });
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
}
