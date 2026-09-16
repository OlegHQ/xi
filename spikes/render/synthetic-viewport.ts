import {
  RGBA,
  type RenderContext,
  type OptimizedBuffer,
  Renderable,
  type RenderableOptions,
  parseColor,
} from "@opentui/core";

export interface SyntheticCursor {
  row: number;
  col: number;
  visible: boolean;
}

export interface DirtySpan {
  row: number;
  startCol: number;
  endCol: number;
}

export interface SyntheticViewportOptions extends RenderableOptions<SyntheticViewportRenderable> {
  rows?: readonly string[];
  fg?: string | RGBA;
  bg?: string | RGBA;
  attributes?: number;
  cursor?: SyntheticCursor;
}

/**
 * Disposable render spike for visible rows. Text is owned by this fixture and
 * deliberately has no connection to an editable widget or document buffer.
 */
export class SyntheticViewportRenderable extends Renderable {
  #rows: string[];
  #fg: RGBA;
  #bg: RGBA;
  #attributes: number;
  #cursorRow = 0;
  #cursorCol = 0;
  #cursorVisible = false;
  #dirtySpans = new Map<number, { startCol: number; endCol: number }>();
  #fullRepaint = true;
  #frameCounter = 0;
  #lastPaintedRows: number[] = [];
  #nextError: Error | undefined;

  constructor(ctx: RenderContext, options: SyntheticViewportOptions = {}) {
    const viewportOptions: RenderableOptions<SyntheticViewportRenderable> = {
      width: options.width ?? "100%",
      height: options.height ?? "100%",
      buffered: options.buffered ?? true,
    };
    if (options.id !== undefined) {
      viewportOptions.id = options.id;
    }
    if (options.overflow !== undefined) {
      viewportOptions.overflow = options.overflow;
    }
    if (options.position !== undefined) {
      viewportOptions.position = options.position;
    }
    if (options.visible !== undefined) {
      viewportOptions.visible = options.visible;
    }
    if (options.live !== undefined) {
      viewportOptions.live = options.live;
    }
    if (options.padding !== undefined) {
      viewportOptions.padding = options.padding;
    }
    if (options.paddingX !== undefined) {
      viewportOptions.paddingX = options.paddingX;
    }
    if (options.paddingY !== undefined) {
      viewportOptions.paddingY = options.paddingY;
    }
    if (options.margin !== undefined) {
      viewportOptions.margin = options.margin;
    }
    if (options.marginX !== undefined) {
      viewportOptions.marginX = options.marginX;
    }
    if (options.marginY !== undefined) {
      viewportOptions.marginY = options.marginY;
    }
    super(ctx, viewportOptions);

    this.#fg = parseColor(options.fg ?? "#ffffff");
    this.#bg = parseColor(options.bg ?? "#000000");
    this.#attributes = options.attributes ?? 0;
    // Percentage dimensions resolve during the first layout pass. Keep the
    // supplied fixture until onResize can fit it to those resolved bounds.
    this.#rows = [...(options.rows ?? [])];

    if (options.cursor !== undefined) {
      this.setCursor(options.cursor.row, options.cursor.col, options.cursor.visible);
    }

    this.requestRender();
  }

  private fitRows(rows: readonly string[]): string[] {
    return Array.from({ length: Math.max(this.height, 0) }, (_, row) => rows[row] ?? "");
  }

  private markSpanDirty(row: number, startCol: number, endCol: number): void {
    if (row < 0 || row >= this.height || startCol >= endCol) {
      return;
    }

    const nextStart = Math.max(0, Math.min(startCol, this.width));
    const nextEnd = Math.max(nextStart, Math.min(endCol, this.width));
    const existing = this.#dirtySpans.get(row);
    if (existing !== undefined) {
      existing.startCol = Math.min(existing.startCol, nextStart);
      existing.endCol = Math.max(existing.endCol, nextEnd);
    } else {
      this.#dirtySpans.set(row, { startCol: nextStart, endCol: nextEnd });
    }
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  get rows(): readonly string[] {
    return [...this.#rows];
  }

  peekDirtySpans(): DirtySpan[] {
    return [...this.#dirtySpans.entries()].map(([row, span]) => ({ row, ...span }));
  }

  takeAndClearDirtySpans(): DirtySpan[] {
    const spans = this.peekDirtySpans();
    this.#dirtySpans.clear();
    return spans;
  }

  get frameCounter(): number {
    return this.#frameCounter;
  }

  get lastPaintedRows(): readonly number[] {
    return [...this.#lastPaintedRows];
  }

  setRows(rows: readonly string[]): void {
    this.#rows = this.height > 0 ? this.fitRows(rows) : [...rows];
    this.#dirtySpans.clear();
    this.#fullRepaint = true;
    this.requestRender();
  }

  /** Update one printable ASCII cell; use setRowText for arbitrary Unicode. */
  setCell(row: number, col: number, value: string): void {
    if (!Number.isInteger(row) || !Number.isInteger(col)) {
      return;
    }
    if (row < 0 || row >= this.height || col < 0 || col >= this.width) {
      return;
    }
    if (value !== "" && !/^[\x20-\x7e]$/.test(value)) {
      throw new RangeError("setCell accepts one printable ASCII character; use setRowText for Unicode");
    }

    const before = this.#rows[row] ?? "";
    if ([...before].some((char) => char.codePointAt(0)! > 0x7e)) {
      throw new RangeError("setCell requires an ASCII row; use setRowText for Unicode");
    }
    const nextValue = value === "" ? " " : value;
    if ((before[col] ?? " ") === nextValue) {
      return;
    }

    this.#rows[row] = before.padEnd(col + 1, " ").slice(0, col) + nextValue + before.slice(col + 1);
    this.markSpanDirty(row, col, col + 1);
    this.requestRender();
  }

  setRowText(row: number, text: string): void {
    if (!Number.isInteger(row) || row < 0 || row >= this.height || this.#rows[row] === text) {
      return;
    }
    this.#rows[row] = text;
    this.markSpanDirty(row, 0, this.width);
    this.requestRender();
  }

  setCursor(row: number, col: number, visible: boolean): void {
    if (this.#cursorRow === row && this.#cursorCol === col && this.#cursorVisible === visible) {
      return;
    }
    this.#cursorRow = row;
    this.#cursorCol = col;
    this.#cursorVisible = visible;
    this.requestRender();
  }

  requestErrorOnNextRender(message = "synthetic viewport test error"): void {
    this.#nextError = new Error(message);
    this.requestRender();
  }

  override onResize(width: number, height: number): void {
    super.onResize(width, height);
    this.#rows = this.fitRows(this.#rows);
    this.#dirtySpans.clear();
    this.#fullRepaint = true;
    this.#cursorRow = Math.min(this.#cursorRow, Math.max(this.height - 1, 0));
    this.#cursorCol = Math.min(this.#cursorCol, Math.max(this.width - 1, 0));
    this.requestRender();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    this.#frameCounter += 1;
    const nextError = this.#nextError;
    if (nextError !== undefined) {
      this.#nextError = undefined;
      throw nextError;
    }

    const paintRows = new Set<number>();
    if (this.#fullRepaint) {
      for (let row = 0; row < this.height; row += 1) {
        paintRows.add(row);
      }
    }
    for (const row of this.#dirtySpans.keys()) {
      paintRows.add(row);
    }

    for (const row of paintRows) {
      const text = this.#rows[row] ?? "";
      buffer.fillRect(0, row, this.width, 1, this.#bg);
      if (text.length > 0) {
        buffer.drawText(text, 0, row, this.#fg, this.#bg, this.#attributes);
      }
    }

    if (
      this.#cursorVisible &&
      this.#cursorRow >= 0 && this.#cursorRow < this.height &&
      this.#cursorCol >= 0 && this.#cursorCol < this.width
    ) {
      // RenderContext uses one-based terminal coordinates; viewport state is zero-based.
      this.ctx.setCursorPosition(this.#cursorCol + 1, this.#cursorRow + 1, true);
    } else {
      this.ctx.setCursorPosition(0, 0, false);
    }

    this.#lastPaintedRows = [...paintRows].sort((left, right) => left - right);
    this.#dirtySpans.clear();
    this.#fullRepaint = false;
  }
}
