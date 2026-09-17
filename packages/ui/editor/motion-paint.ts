import { TextAttributes, type OptimizedBuffer, type RGBA } from '@opentui/core/renderer';
import type { CellPoint, ProjectedSelection, ScreenRow, VisibleFrame } from '../../layout/src/index';
import type { MotionPaintTokens, EditorColorMode } from '../theme/motion-tokens';
import { resolvePaintColor } from '../theme/motion-tokens';

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

const PAINT_PRIMARY_SELECTION = 1;
const PAINT_SECONDARY_SELECTION = 2;
const PAINT_TRAIL = 4;
const PAINT_OPERATOR = 8;

/**
 * Paint one visible frame in strict layer order. All range work is bounded by
 * frame.rows/cells, so a long document or off-screen selection is never scanned.
 */
export function paintEditorFrame(buffer: OptimizedBuffer, options: MotionPaintOptions): MotionPaintStats {
  const colorMode = options.presentation?.colorMode ?? options.colorMode;
  const rowRange = paintRowRange(options.frame, options.rows);
  if (canPaintPlainFrameCached(options.frame, options.presentation)) {
    return paintPlainFrame(buffer, options, rowRange);
  }
  const masks = buildPaintMasks(options.frame, options.presentation, options.mode, colorMode, rowRange);
  const colors = {
    trail: resolvePaintColor(options.theme.motionTrail, colorMode),
    operator: resolvePaintColor(options.theme.operatorPreview, colorMode),
    primarySelection: resolvePaintColor(options.theme.selectionPrimary, colorMode),
    secondarySelection: resolvePaintColor(options.theme.selectionSecondary, colorMode),
    cursorPrimary: resolvePaintColor(options.theme.cursorPrimary, colorMode),
    cursorSecondary: resolvePaintColor(options.theme.cursorSecondary, colorMode),
  };
  let selectedCells = 0;
  let secondarySelectedCells = 0;
  let trailCells = 0;
  let operatorPreviewCells = 0;
  for (let rowIndex = rowRange.start; rowIndex < rowRange.end; rowIndex += 1) {
    const row = options.frame.rows[rowIndex];
    if (row === undefined) continue;
    const rowY = options.y + rowIndex;
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
      const foreground = cell.role === 'gutter' ? options.muted : options.foreground;
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
    const color = colorMode === 'no-color'
      ? options.background
      : (selection.primary ? colors.cursorPrimary : colors.cursorSecondary);
    const attributes = colorMode === 'no-color'
      ? (selection.primary ? TextAttributes.INVERSE : TextAttributes.UNDERLINE)
      : (selection.primary ? TextAttributes.BOLD : TextAttributes.UNDERLINE);
    const marker = options.ascii ? '|' : '▌';
    // Cursor tokens are dark by default. Use the editor canvas foreground
    // only for no-color reverse/underline mode; a light canvas foreground on
    // the dark software cursor keeps the glyph visible in truecolor/256 mode.
    const markerForeground = colorMode === 'no-color' ? options.foreground : options.background;
    buffer.setCell(options.x + point.column, options.y + point.row, marker, markerForeground, color, attributes);
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

function canPaintPlainFrame(frame: VisibleFrame, presentation: EditorPresentationRead | undefined): boolean {
  if (presentation?.motionPreview != null || presentation?.operatorPreview != null) return false;
  for (const selection of frame.selections) {
    if (selection.kind !== 'normal-cursor') return false;
  }
  for (const row of frame.rows) {
    for (const cell of row.cells) {
      if (cell.text.length !== 1) return false;
    }
  }
  return true;
}

function paintPlainFrame(buffer: OptimizedBuffer, options: MotionPaintOptions, rowRange: PaintRowRange): MotionPaintStats {
  const colors = {
    cursorPrimary: resolvePaintColor(options.theme.cursorPrimary, options.colorMode),
    cursorSecondary: resolvePaintColor(options.theme.cursorSecondary, options.colorMode),
  };
  for (let rowIndex = rowRange.start; rowIndex < rowRange.end; rowIndex += 1) {
    const row = options.frame.rows[rowIndex];
    if (row === undefined || row.cells.length === 0) continue;
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
      const foreground = cell.role === 'gutter' ? options.muted : options.foreground;
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
    const color = options.colorMode === 'no-color'
      ? options.background
      : (selection.primary ? colors.cursorPrimary : colors.cursorSecondary);
    const attributes = options.colorMode === 'no-color' ? TextAttributes.INVERSE : TextAttributes.BOLD;
    const foreground = options.colorMode === 'no-color' ? options.foreground : options.background;
    buffer.setCell(options.x + point.column, options.y + point.row, options.ascii ? '|' : '▌', foreground, color, attributes);
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
