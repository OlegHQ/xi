import type { CellPoint } from './types';

/**
 * Private numeric hit geometry. The public frame exposes CellPoint values at
 * request boundaries, while retained indexes keep only packed row/column
 * integers and never allocate a string key per visible cell.
 */
export class PackedPositionIndex {
  readonly #offsets = new Map<number, number>();
  /**
   * Keyed by `packDisplayKey(line, column)` instead of a `Map<line, Map<column,
   * packed>>`. `project()`/`rebaseMaterializedRows` call `setDisplay` once per
   * visible text cell every frame (profiled with `bun --cpu-prof`: this was one of
   * the two largest remaining self-time contributors in the production-shape typing
   * scenario, see bench/layout/t014-viewport.ts), and a nested map allocates and
   * hashes into an inner `Map` for every distinct line in addition to the outer
   * lookup; a single flat map with one combined numeric key needs one hash per call.
   */
  readonly #display = new Map<number, number>();

  setOffset(offset: number, row: number, column: number): void {
    this.#offsets.set(offset, packPoint(row, column));
  }

  hasOffset(offset: number): boolean {
    return this.#offsets.has(offset);
  }

  getOffset(offset: number): CellPoint | undefined {
    const packed = this.#offsets.get(offset);
    return packed === undefined ? undefined : unpackPoint(packed);
  }

  setDisplay(line: number, column: number, row: number, screenColumn: number): void {
    this.#display.set(packDisplayKey(line, column), packPoint(row, screenColumn));
  }

  getDisplay(line: number, column: number): CellPoint | undefined {
    const packed = this.#display.get(packDisplayKey(line, column));
    return packed === undefined ? undefined : unpackPoint(packed);
  }

  hasDisplay(line: number, column: number): boolean {
    return this.#display.has(packDisplayKey(line, column));
  }
}

const PACKED_POINT_STRIDE = 2_048;
/**
 * Display-column keys can exceed `PACKED_POINT_STRIDE` for long unwrapped lines
 * (bounded by `MAX_SOURCE_PREFIX_UTF16` UTF-16 units at up to 2 display cells each),
 * so this uses a wider, independent stride; both stay far under
 * `Number.MAX_SAFE_INTEGER` for any valid `LineIndex`.
 */
const DISPLAY_KEY_STRIDE = 1_048_576;

function packDisplayKey(line: number, column: number): number {
  return line * DISPLAY_KEY_STRIDE + column;
}

function packPoint(row: number, column: number): number {
  return row * PACKED_POINT_STRIDE + column;
}

function unpackRow(packed: number): number {
  return Math.floor(packed / PACKED_POINT_STRIDE);
}

function unpackColumn(packed: number): number {
  return packed % PACKED_POINT_STRIDE;
}

function unpackPoint(packed: number): CellPoint {
  return Object.freeze({ row: unpackRow(packed), column: unpackColumn(packed) });
}
