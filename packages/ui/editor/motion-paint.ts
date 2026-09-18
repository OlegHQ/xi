import { TextAttributes, type OptimizedBuffer, type RGBA } from '@opentui/core/renderer';
import type { CellPoint, ProjectedSelection, ScreenRow, VisibleFrame } from '../../layout/src/index';
import type { MotionPaintTokens, EditorColorMode } from '../theme/motion-tokens';
import { resolvePaintColor, pickCursorForeground } from '../theme/motion-tokens';
import type { SyntaxRead, SyntaxSpan, SyntaxTokenKind } from '../../contracts/src/index';

/** Structural read of Vim's immutable presentation output. The UI never imports Vim. */
export interface MotionPreviewRead {
  readonly documentId: string;
  readonly documentVersion: number;
  readonly selectionGeneration: number;
  readonly operatorKey: string;
  readonly count: number;
  readonly members: readonly MotionPreviewMemberRead[];
}

export interface MotionPreviewMemberRead {
  readonly memberId: string;
  readonly source: number;
  readonly destination: number;
  readonly moved: boolean;
  readonly extent: {
    readonly kind: 'characterwise' | 'linewise';
    readonly start: number;
    readonly end: number;
  };
}

/** A complete operator range supplied by an engine read model. It is never inferred by paint. */
export interface OperatorPreviewRead {
  readonly documentId: string;
  readonly documentVersion: number;
  readonly selectionGeneration: number;
  readonly members: readonly OperatorPreviewMemberRead[];
}

export interface OperatorPreviewMemberRead {
  readonly memberId: string;
  readonly kind: 'characterwise' | 'linewise' | 'blockwise';
  readonly start: number;
  readonly end: number;
}

export interface EditorPresentationRead {
  readonly motionPreview?: MotionPreviewRead | null;
  readonly operatorPreview?: OperatorPreviewRead | null;
  readonly motionTrail?: 'off' | 'last-motion';
  readonly reducedMotion?: boolean;
  readonly colorMode?: EditorColorMode;
}

export interface EditorPresentationReadPort {
  readPresentation(viewId: string): EditorPresentationRead | undefined;
}

export interface MotionPaintOptions {
  readonly frame: VisibleFrame;
  readonly presentation?: EditorPresentationRead;
  readonly mode: 'normal' | 'insert' | 'visual' | string;
  readonly theme: MotionPaintTokens;
  readonly foreground: RGBA;
  readonly muted: RGBA;
  readonly background: RGBA;
  readonly accent: RGBA;
  readonly colorMode: EditorColorMode;
  readonly ascii: boolean;
  readonly x: number;
  readonly y: number;
  /** Painted when `syntax.documentVersion` matches `frame.identity.documentVersion`, or --
   * for a row whose `syntaxFallbackRows` entry proves its text hasn't changed -- reused
   * from a still-stale read (see `SyntaxFallbackRow`). */
  readonly syntax?: SyntaxRead;
  readonly syntaxColors?: Partial<Record<SyntaxTokenKind, string>>;
  /** Per-row (indexed like `frame.rows`) last-known-current syntax snapshot; see `SyntaxFallbackRow`. */
  readonly syntaxFallbackRows?: readonly (SyntaxFallbackRow | undefined)[];
  /** Optional half-open visible row range for damage-limited repainting. */
  readonly rows?: { readonly start: number; readonly end: number };
}

export interface MotionPaintStats {
  readonly selectedCells: number;
  readonly secondarySelectedCells: number;
  readonly trailCells: number;
  readonly operatorPreviewCells: number;
  readonly primaryCursor: CellPoint | null;
  readonly secondaryCursors: number;
  readonly trailPainted: boolean;
  readonly rejectedStalePreview: boolean;
}

function resolveSyntaxColors(colors: Partial<Record<SyntaxTokenKind, string>> | undefined, colorMode: EditorColorMode): Map<SyntaxTokenKind, RGBA> {
  const resolved = new Map<SyntaxTokenKind, RGBA>();
  if (colors === undefined) return resolved;
  for (const [kind, value] of Object.entries(colors)) {
    if (value !== undefined) resolved.set(kind as SyntaxTokenKind, resolvePaintColor(value, colorMode));
  }
  return resolved;
}

// `options.syntaxColors` is the same object reference for as long as the theme doesn't
// change (it comes straight from `theme.syntax`), so resolving it is memoized by
// (colors, colorMode) instead of rebuilt on every `drawFrame` call -- one call per paint
// range, several ranges per frame, every frame.
const syntaxColorCache = new WeakMap<Partial<Record<SyntaxTokenKind, string>>, Map<EditorColorMode, Map<SyntaxTokenKind, RGBA>>>();

function resolveSyntaxColorsCached(colors: Partial<Record<SyntaxTokenKind, string>> | undefined, colorMode: EditorColorMode): Map<SyntaxTokenKind, RGBA> {
  if (colors === undefined) return resolveSyntaxColors(colors, colorMode);
  let byMode = syntaxColorCache.get(colors);
  if (byMode === undefined) { byMode = new Map(); syntaxColorCache.set(colors, byMode); }
  let resolved = byMode.get(colorMode);
  if (resolved === undefined) { resolved = resolveSyntaxColors(colors, colorMode); byMode.set(colorMode, resolved); }
  return resolved;
}

/** True when the active syntax read's version matches the painted frame's document version. */
function syntaxIsCurrent(frame: VisibleFrame, syntax: SyntaxRead | undefined): boolean {
  return syntax !== undefined && (frame.identity.documentVersion as unknown as number) === (syntax.documentVersion as unknown as number);
}

/** Bounded, run-based per-row cursor over one row's sorted syntax spans (no per-cell allocation). */
class RowSyntaxCursor {
  readonly #spans: readonly SyntaxSpan[];
  #index = 0;
  constructor(spans: readonly SyntaxSpan[]) { this.#spans = spans; }
  kindAt(offset: number): SyntaxTokenKind | undefined {
    while (this.#index < this.#spans.length && (this.#spans[this.#index] as SyntaxSpan).end <= offset) this.#index += 1;
    const span = this.#spans[this.#index];
    return span !== undefined && span.start <= offset && offset < span.end ? span.kind : undefined;
  }
}

/**
 * A row's own offsets/text as they were the last time syntax was confirmed current
 * for it, kept by the caller (see `WorkbenchRenderable`'s `#lastCurrentSyntaxRows`)
 * so a still-stale read can keep coloring rows an edit elsewhere didn't touch.
 */
export interface SyntaxFallbackRow {
  readonly startOffset: number | null;
  readonly endOffset: number | null;
  readonly text: string;
}

function rowSyntaxCursor(frame: VisibleFrame, row: ScreenRow, syntax: SyntaxRead | undefined, fallback?: SyntaxFallbackRow): RowSyntaxCursor | undefined {
  if (syntax === undefined) return undefined;
  const start = row.startOffset as number | null;
  const end = row.endOffset as number | null;
  if (start === null || end === null || end <= start) return undefined;
  if (syntaxIsCurrent(frame, syntax)) return new RowSyntaxCursor(syntax.spansInRange(start, end));
  // The read is behind this frame's edit (e.g. the keystroke frame painted before the
  // background parse catches up). Rather than dropping color from every row, reuse the
  // stale read's spans for exactly the rows an edit elsewhere didn't touch: `fallback`
  // is this same read's own view of this row the last time it was current, so an exact
  // offset+text match proves the row's underlying text -- and therefore its spans --
  // has not changed since. A row whose offset shifted (later lines, after an edit) or
  // whose text changed (the edited row itself) fails the match and stays uncolored for
  // this one frame, exactly like today, until the next parse lands.
  if (fallback !== undefined && fallback.startOffset === start && fallback.endOffset === end && fallback.text === row.text) {
    return new RowSyntaxCursor(syntax.spansInRange(start, end));
  }
  return undefined;
}

function syntaxForeground(cell: ScreenRow['cells'][number], cursor: RowSyntaxCursor | undefined, colors: Map<SyntaxTokenKind, RGBA> | undefined, base: RGBA): RGBA {
  if (cursor === undefined || colors === undefined || cell.role === 'padding' || cell.role === 'gutter') return base;
  const target = cell.target;
  if (target === null || target.kind !== 'text') return base;
  const kind = cursor.kindAt(target.offset as unknown as number);
  if (kind === undefined) return base;
  return colors.get(kind) ?? base;
}

const PAINT_PRIMARY_SELECTION = 1;
const PAINT_SECONDARY_SELECTION = 2;
const PAINT_TRAIL = 4;
const PAINT_OPERATOR = 8;

/**
 * Paint one visible frame in strict layer order. All range work is bounded by
 * frame.rows/cells, so a long document or off-screen selection is never scanned.
 */
export function paintEditorFrame(buffer: OptimizedBuffer, options: MotionPaintOptions): MotionPaintStats {
  // @xi-perf H1 RENDER-120 -- Per-cell damage paint issuing native buffer writes; mask lookups are scalar, no retained per-cell object.
  const colorMode = options.presentation?.colorMode ?? options.colorMode;
  const rowRange = paintRowRange(options.frame, options.rows);
  if (canPaintPlainFrameCached(options.frame, options.presentation)) {
    return paintPlainFrame(buffer, options, rowRange);
  }
  const masks = buildPaintMasks(options.frame, options.presentation, options.mode, colorMode, rowRange);
  const syntaxColors = colorMode === 'no-color' ? undefined : resolveSyntaxColorsCached(options.syntaxColors, colorMode);
  const colors = {
    trail: resolvePaintColor(options.theme.motionTrail, colorMode),
    operator: resolvePaintColor(options.theme.operatorPreview, colorMode),
    primarySelection: resolvePaintColor(options.theme.selectionPrimary, colorMode),
    secondarySelection: resolvePaintColor(options.theme.selectionSecondary, colorMode),
    cursorPrimary: resolvePaintColor(options.theme.cursorPrimary, colorMode),
    cursorSecondary: resolvePaintColor(options.theme.cursorSecondary, colorMode),
    cursorOnSelection: resolvePaintColor(options.theme.cursorOnSelection, colorMode),
  };
  // Cursor heads within the painted range, keyed like `masks.cells`, so the per-cell loop
  // below can paint the real glyph under the cursor (instead of a second pass stomping it
  // with a marker) while still seeing that cell's own selection/trail/operator state.
  const cursorCells = new Map<number, { readonly primary: boolean }>();
  for (const selection of options.frame.selections) {
    const point = selection.head.position;
    if (point === null || point.row < rowRange.start || point.row >= rowRange.end) continue;
    cursorCells.set(cellKey(point.row, point.column), { primary: selection.primary });
  }
  let selectedCells = 0;
  let secondarySelectedCells = 0;
  let trailCells = 0;
  let operatorPreviewCells = 0;
  for (let rowIndex = rowRange.start; rowIndex < rowRange.end; rowIndex += 1) {
    const row = options.frame.rows[rowIndex];
    if (row === undefined) continue;
    const rowY = options.y + rowIndex;
    const syntaxCursor = syntaxColors === undefined ? undefined : rowSyntaxCursor(options.frame, row, options.syntax, options.syntaxFallbackRows?.[rowIndex]);
    for (let column = 0; column < row.cells.length; column += 1) {
      const cell = row.cells[column];
      if (cell === undefined) continue;
      const key = cellKey(rowIndex, column);
      const mask = masks.cells.get(key) ?? 0;
      const primarySelection = (mask & PAINT_PRIMARY_SELECTION) !== 0;
      const secondarySelection = (mask & PAINT_SECONDARY_SELECTION) !== 0;
      const trail = (mask & PAINT_TRAIL) !== 0;
      const operator = (mask & PAINT_OPERATOR) !== 0;
      if (primarySelection) selectedCells += 1;
      if (secondarySelection) secondarySelectedCells += 1;
      if (trail) trailCells += 1;
      if (operator) operatorPreviewCells += 1;
      let background = options.background;
      let attributes = 0;
      if (trail) background = colors.trail;
      if (operator) { background = colors.operator; attributes = TextAttributes.UNDERLINE; }
      if (secondarySelection) { background = colors.secondarySelection; attributes = TextAttributes.BOLD; }
      if (primarySelection) { background = colors.primarySelection; attributes = TextAttributes.BOLD; }
      if (colorMode === 'no-color') {
        background = options.background;
        if (trail) attributes |= TextAttributes.DIM;
        if (operator) attributes |= TextAttributes.UNDERLINE;
        if (secondarySelection) attributes |= TextAttributes.UNDERLINE;
        if (primarySelection) attributes |= TextAttributes.INVERSE;
      }
      let foreground = cell.role === 'gutter' ? options.muted : syntaxForeground(cell, syntaxCursor, syntaxColors, options.foreground);
      const cursorInfo = cursorCells.get(key);
      if (cursorInfo !== undefined) {
        if (colorMode === 'no-color') {
          attributes |= cursorInfo.primary ? TextAttributes.INVERSE : TextAttributes.UNDERLINE;
        } else if (options.mode === 'insert') {
          // Thin bar-style caret: keep the real glyph and its color, only mark the
          // position, so it reads as distinct from the solid Normal/Visual block below.
          attributes |= TextAttributes.UNDERLINE;
        } else {
          const onSelection = primarySelection || secondarySelection;
          const cursorBackground = onSelection ? colors.cursorOnSelection : (cursorInfo.primary ? colors.cursorPrimary : colors.cursorSecondary);
          foreground = pickCursorForeground(foreground, cursorBackground, options.foreground, options.background);
          background = cursorBackground;
          attributes = TextAttributes.BOLD;
        }
      }
      buffer.fillRect(options.x + column, rowY, 1, 1, background);
      if (cell.text.length > 0) {
        buffer.setCell(options.x + column, rowY, cell.text, foreground, background, attributes);
      }
    }
  }
  let primaryCursor: CellPoint | null = null;
  let secondaryCursors = 0;
  for (const selection of options.frame.selections) {
    const point = selection.head.position;
    if (point === null || point.row < rowRange.start || point.row >= rowRange.end) continue;
    if (selection.primary) primaryCursor = Object.freeze({ row: point.row, column: point.column });
    else secondaryCursors += 1;
  }
  return Object.freeze({
    selectedCells,
    secondarySelectedCells,
    trailCells,
    operatorPreviewCells,
    primaryCursor,
    secondaryCursors,
    trailPainted: masks.trailPainted,
    rejectedStalePreview: masks.rejectedStalePreview,
  });
}

/**
 * The common idle frame is already fully materialized by layout. Drawing its
 * contiguous ASCII runs avoids one native call per terminal cell. Decorated
 * frames and rows containing a multi-cell grapheme retain the precise path.
 */
// `paintEditorFrame` is called once per damage-limited paint range within the same
// render (see workbench.ts's per-range loop); `frame`/`presentation` are identical
// across those calls, so a full rows*cells scan per range is pure waste. Memoize
// by frame identity, one entry per rendered frame object.
const plainFrameCache = new WeakMap<VisibleFrame, { readonly presentation: EditorPresentationRead | undefined; readonly result: boolean }>();

function canPaintPlainFrameCached(frame: VisibleFrame, presentation: EditorPresentationRead | undefined): boolean {
  const cached = plainFrameCache.get(frame);
  if (cached !== undefined && cached.presentation === presentation) return cached.result;
  const result = canPaintPlainFrame(frame, presentation);
  plainFrameCache.set(frame, { presentation, result });
  return result;
}

// `canPaintPlainFrame` is checked once per key, but `frame` (and therefore the WeakMap
// keyed on it, above) is a new object every render, so that memo never actually hits.
// A row's `contentKey` -- unlike the row object -- is stable across an edit that didn't
// touch that row (see its doc comment in packages/layout/src/index.ts), so per-row
// plain-ness is cached by contentKey instead: an edit only pays the per-cell scan for
// the rows it actually touched, not the whole ~4800-cell visible frame every keystroke.
const ROW_PLAIN_CACHE_CAP = 4096;
const rowPlainCache = new Map<string, boolean>();

function isRowPlain(row: ScreenRow): boolean {
  const key = row.contentKey;
  if (key !== null) {
    const cached = rowPlainCache.get(key);
    if (cached !== undefined) return cached;
  }
  let plain = true;
  for (const cell of row.cells) {
    if (cell.text.length !== 1) { plain = false; break; }
  }
  if (key !== null) {
    if (rowPlainCache.size >= ROW_PLAIN_CACHE_CAP) {
      const oldest = rowPlainCache.keys().next().value;
      if (oldest !== undefined) rowPlainCache.delete(oldest);
    }
    rowPlainCache.set(key, plain);
  }
  return plain;
}

/** Exported for direct unit testing of the plain-paint fast path (see tests/ui). */
export function canPaintPlainFrame(frame: VisibleFrame, presentation: EditorPresentationRead | undefined): boolean {
  if (presentation?.motionPreview != null || presentation?.operatorPreview != null) return false;
  for (const selection of frame.selections) {
    // Only a visual-* selection ever populates `buildPaintMasks`' cell map (see
    // `markSelectionCells`); a plain cursor -- normal mode's block or insert mode's
    // caret, drawn afterward by `paintPlainFrame` itself -- never does, so both are
    // safe to run through the plain per-row path with an empty mask set.
    if (selection.kind !== 'normal-cursor' && selection.kind !== 'insert-caret') return false;
  }
  for (const row of frame.rows) {
    if (!isRowPlain(row)) return false;
  }
  return true;
}

/** The glyph and its own (non-cursor) resolved foreground at a cursor's cell, so the
 * cursor overlay paints the real character instead of stomping it with a marker glyph. */
function cursorGlyphAndForeground(
  frame: VisibleFrame,
  column: number,
  row: ScreenRow | undefined,
  syntax: SyntaxRead | undefined,
  fallback: SyntaxFallbackRow | undefined,
  syntaxColors: Map<SyntaxTokenKind, RGBA> | undefined,
  muted: RGBA,
  base: RGBA,
): { readonly glyph: string; readonly foreground: RGBA } {
  const cell = row?.cells[column];
  if (row === undefined || cell === undefined) return { glyph: ' ', foreground: base };
  const cursor = syntaxColors === undefined ? undefined : rowSyntaxCursor(frame, row, syntax, fallback);
  return { glyph: cell.text, foreground: cell.role === 'gutter' ? muted : syntaxForeground(cell, cursor, syntaxColors, base) };
}

function paintPlainFrame(buffer: OptimizedBuffer, options: MotionPaintOptions, rowRange: PaintRowRange): MotionPaintStats {
  // @xi-perf H1 RENDER-120 -- Per-cell run-coalesced plain paint; run buffers are bounded per row, not per cell.
  const colors = {
    cursorPrimary: resolvePaintColor(options.theme.cursorPrimary, options.colorMode),
    cursorSecondary: resolvePaintColor(options.theme.cursorSecondary, options.colorMode),
  };
  const syntaxColors = options.colorMode === 'no-color' ? undefined : resolveSyntaxColorsCached(options.syntaxColors, options.colorMode);
  for (let rowIndex = rowRange.start; rowIndex < rowRange.end; rowIndex += 1) {
    const row = options.frame.rows[rowIndex];
    if (row === undefined || row.cells.length === 0) continue;
    const syntaxCursor = syntaxColors === undefined ? undefined : rowSyntaxCursor(options.frame, row, options.syntax, options.syntaxFallbackRows?.[rowIndex]);
    let runStart = 0;
    let runForeground = options.foreground;
    const runText: string[] = [];
    const flush = (column: number): void => {
      if (runText.length > 0) buffer.drawText(runText.join(''), options.x + runStart, options.y + rowIndex, runForeground, options.background, 0);
      runStart = column;
      runText.length = 0;
    };
    for (let column = 0; column < row.cells.length; column += 1) {
      const cell = row.cells[column];
      if (cell === undefined) continue;
      const foreground = cell.role === 'gutter' ? options.muted : syntaxForeground(cell, syntaxCursor, syntaxColors, options.foreground);
      if (foreground !== runForeground) {
        flush(column);
        runForeground = foreground;
      }
      runText.push(cell.text);
    }
    flush(row.cells.length);
  }
  let primaryCursor: CellPoint | null = null;
  let secondaryCursors = 0;
  for (const selection of options.frame.selections) {
    const point = selection.head.position;
    if (point === null || point.row < rowRange.start || point.row >= rowRange.end) continue;
    const row = options.frame.rows[point.row];
    const { glyph, foreground: tokenForeground } = cursorGlyphAndForeground(
      options.frame, point.column, row, options.syntax, options.syntaxFallbackRows?.[point.row], syntaxColors, options.muted, options.foreground,
    );
    if (options.colorMode === 'no-color') {
      const attributes = selection.primary ? TextAttributes.INVERSE : TextAttributes.UNDERLINE;
      buffer.setCell(options.x + point.column, options.y + point.row, glyph, tokenForeground, options.background, attributes);
    } else if (options.mode === 'insert') {
      // Thin bar-style caret: real glyph, its own color, just underlined -- distinct
      // from the solid Normal/Visual block cursor below.
      buffer.setCell(options.x + point.column, options.y + point.row, glyph, tokenForeground, options.background, TextAttributes.UNDERLINE);
    } else {
      const cursorBackground = selection.primary ? colors.cursorPrimary : colors.cursorSecondary;
      const foreground = pickCursorForeground(tokenForeground, cursorBackground, options.foreground, options.background);
      buffer.setCell(options.x + point.column, options.y + point.row, glyph, foreground, cursorBackground, TextAttributes.BOLD);
    }
    if (selection.primary) primaryCursor = Object.freeze({ row: point.row, column: point.column });
    else secondaryCursors += 1;
  }
  return Object.freeze({
    selectedCells: 0,
    secondarySelectedCells: 0,
    trailCells: 0,
    operatorPreviewCells: 0,
    primaryCursor,
    secondaryCursors,
    trailPainted: false,
    rejectedStalePreview: false,
  });
}

interface PaintMaskResult {
  readonly cells: Map<number, number>;
  readonly trailPainted: boolean;
  readonly rejectedStalePreview: boolean;
}

function buildPaintMasks(
  frame: VisibleFrame,
  presentation: EditorPresentationRead | undefined,
  mode: string,
  colorMode: EditorColorMode,
  rowRange: PaintRowRange,
): PaintMaskResult {
  const cells = new Map<number, number>();
  const setMask = (row: number, column: number, bit: number): void => {
    const key = cellKey(row, column);
    cells.set(key, (cells.get(key) ?? 0) | bit);
  };
  for (const selection of frame.selections) {
    const isVisual = selection.kind === 'visual-character' || selection.kind === 'visual-line' || selection.kind === 'visual-block';
    if (!isVisual) continue;
    markSelectionCells(frame, selection, selection.primary ? PAINT_PRIMARY_SELECTION : PAINT_SECONDARY_SELECTION, setMask, rowRange);
  }
  const identity = frame.identity;
  let rejectedStalePreview = false;
  const motion = presentation?.motionPreview;
  const trailMode = presentation?.motionTrail ?? 'off';
  const trailAllowed = trailMode === 'last-motion' && mode === 'normal' && presentation?.reducedMotion !== false && colorMode !== 'no-color';
  if (motion !== undefined && motion !== null) {
    const valid = motion.documentId === identity.documentId
      && motion.documentVersion === identity.documentVersion
      && motion.selectionGeneration === identity.selectionGeneration;
    if (!valid) rejectedStalePreview = true;
    if (valid && trailAllowed) {
      for (const member of motion.members) {
        paintOffsetRange(frame, member.extent.start, member.extent.end, (row, column) => setMask(row, column, PAINT_TRAIL), rowRange);
      }
    }
  }
  const operator = presentation?.operatorPreview;
  if (operator !== undefined && operator !== null) {
    const valid = operator.documentId === identity.documentId
      && operator.documentVersion === identity.documentVersion
      && operator.selectionGeneration === identity.selectionGeneration;
    if (!valid) rejectedStalePreview = true;
    if (valid) {
      for (const member of operator.members) {
        paintOffsetRange(frame, member.start, member.end, (row, column) => setMask(row, column, PAINT_OPERATOR), rowRange);
      }
    }
  }
  return Object.freeze({ cells, trailPainted: trailAllowed && motion !== undefined && motion !== null && !rejectedStalePreview, rejectedStalePreview });
}

function markSelectionCells(
  frame: VisibleFrame,
  selection: ProjectedSelection,
  bit: number,
  setMask: (row: number, column: number, bit: number) => void,
  rowRange: PaintRowRange,
): void {
  const anchor = selection.anchor.position;
  const head = selection.head.position;
  if (selection.kind === 'visual-line') {
    const firstLine = Math.min(selection.anchor.lineIndex as number, selection.head.lineIndex as number);
    const lastLine = Math.max(selection.anchor.lineIndex as number, selection.head.lineIndex as number);
    for (let rowIndex = rowRange.start; rowIndex < rowRange.end; rowIndex += 1) {
      const row = frame.rows[rowIndex];
      if (row === undefined || row.lineIndex === null || (row.lineIndex as number) < firstLine || (row.lineIndex as number) > lastLine) continue;
      for (let column = 0; column < row.cells.length; column += 1) {
        if (row.cells[column]?.role !== 'gutter') setMask(rowIndex, column, bit);
      }
    }
    return;
  }
  if (anchor === null || head === null) return;
  if (selection.kind === 'visual-block') {
    const firstRow = Math.min(anchor.row, head.row);
    const lastRow = Math.max(anchor.row, head.row);
    const firstColumn = Math.min(anchor.column, head.column);
    const lastColumn = Math.max(anchor.column, head.column);
    for (let row = Math.max(firstRow, rowRange.start); row <= Math.min(lastRow, rowRange.end - 1); row += 1) {
      const frameRow = frame.rows[row];
      if (frameRow === undefined) continue;
      for (let column = firstColumn; column <= lastColumn && column < frameRow.cells.length; column += 1) {
        if (column >= 0 && frameRow.cells[column]?.role !== 'gutter') setMask(row, column, bit);
      }
    }
    return;
  }
  const start = Math.min(selection.anchor.requestedOffset as number, selection.head.requestedOffset as number);
  const end = Math.max(selection.anchor.requestedOffset as number, selection.head.requestedOffset as number);
  for (let rowIndex = rowRange.start; rowIndex < rowRange.end; rowIndex += 1) {
    const row = frame.rows[rowIndex];
    if (row === undefined) continue;
    for (let column = 0; column < row.cells.length; column += 1) {
      const cell = row.cells[column];
      const target = cell?.target;
      if (cell?.role !== 'gutter' && cell?.role !== 'padding' && target?.kind === 'text' && (target.offset as number) >= start && (target.offset as number) <= end) {
        setMask(rowIndex, column, bit);
      }
    }
    // Keep the explicit EOL cell selected when the endpoint names the line end.
    if ((row.endOffset as number | null) !== null && end >= (row.endOffset as number) && start <= (row.endOffset as number)) {
      const eolColumn = eolColumnForRow(row);
      if (eolColumn >= 0) setMask(rowIndex, eolColumn, bit);
    }
  }
}

function paintOffsetRange(frame: VisibleFrame, start: number, end: number, paint: (row: number, column: number) => void, rowRange: PaintRowRange): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return;
  for (let rowIndex = rowRange.start; rowIndex < rowRange.end; rowIndex += 1) {
    const row = frame.rows[rowIndex];
    if (row === undefined || row.kind !== 'text') continue;
    const rowStart = row.startOffset as number | null;
    const rowEnd = row.endOffset as number | null;
    if (rowStart === null || rowEnd === null || end <= rowStart || start >= rowEnd) continue;
    for (let column = 0; column < row.cells.length; column += 1) {
      const cell = row.cells[column];
      if (cell === undefined) continue;
      const target = cell.target;
      if (cell.role !== 'gutter' && cell.role !== 'padding' && target?.kind === 'text' && (target.offset as number) >= start && (target.offset as number) < end) paint(rowIndex, column);
    }
    if (start <= rowEnd && end >= rowEnd && rowEnd > rowStart) {
      const eolColumn = eolColumnForRow(row);
      if (eolColumn >= 0) paint(rowIndex, eolColumn);
    }
  }
}

function eolColumnForRow(row: ScreenRow): number {
  let contentStart = 0;
  while (contentStart < row.cells.length && row.cells[contentStart]?.role === 'gutter') contentStart += 1;
  return Math.min(row.cells.length - 1, Math.max(contentStart, contentStart + Math.floor(row.displayEndCell)));
}

interface PaintRowRange {
  readonly start: number;
  readonly end: number;
}

function paintRowRange(frame: VisibleFrame, requested: MotionPaintOptions['rows']): PaintRowRange {
  if (requested === undefined) return { start: 0, end: frame.rows.length };
  return {
    start: Math.max(0, Math.min(frame.rows.length, Math.trunc(requested.start))),
    end: Math.max(0, Math.min(frame.rows.length, Math.trunc(requested.end))),
  };
}

function cellKey(row: number, column: number): number { return row * 2_048 + column; }
