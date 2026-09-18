import type {
  CellColumn,
  DocumentSnapshot,
  DocumentVersion,
  LineIndex,
  Result,
  Utf16Offset,
  Utf8ByteOffset,
} from '../../document/src/index.ts';
import { defaultCellWidthPolicy, type CellWidthPolicy, type FoldRegion } from '../../layout/src/index';

export {
  ensureVimCursorVisible,
  resolveVimViewportMotion,
  type VimViewportCursor,
  type VimViewportFailure,
  type VimViewportInvocation,
  type VimViewportMotionKey,
  type VimViewportMotionCursor,
  type VimViewportOptions,
  type VimViewportOutcome,
  type VimViewportScrollKey,
} from './viewport';

export {
  resolveVimStructuralMotion,
  type VimStructuralMotionCursor,
  type VimStructuralMotionFailure,
  type VimStructuralMotionInvocation,
  type VimStructuralMotionKey,
  type VimStructuralMotionOptions,
  type VimStructuralMotionOutcome,
} from './structural';

/** Neovim's sentinel for a cursor whose desired display column is the line end. */
export const VIM_END_OF_LINE_COLUMN = 0x7fffffff as CellColumn;

export type VimMotionKey =
  | 'h' | 'l' | 'j' | 'k' | '0' | '^' | '$' | 'g_' | '|' | '+' | '-' | '_' | 'gg' | 'G'
  | 'H' | 'M' | 'L'
  | '<Left>' | '<Right>' | '<Up>' | '<Down>' | '<Home>' | '<End>'
  | '<C-Home>' | '<C-End>'
  | 'go'
  | '<BS>' | '<C-H>' | '<Space>' | '<NL>' | '<CR>' | '<C-M>' | '<C-J>' | '<C-N>' | '<C-P>';

export interface VimMotionCursor {
  /** Cursor boundary and desired column are valid only for this document version. */
  readonly documentVersion: DocumentVersion;
  /** Start boundary of the Normal-mode character, or the start of an empty line, in UTF-16 units. */
  readonly offset: Utf16Offset;
  /** Zero-based terminal display cell requested by the last vertical or column motion; null means initialize from `offset`. */
  readonly desiredDisplayCellColumn: CellColumn | null;
}

export interface VimMotionInvocation {
  readonly key: VimMotionKey;
  /** Omitted means the command had no explicit count. Count values must be positive safe integers. */
  readonly count?: number;
}

export interface VimMotionOptions {
  /** Comma-free Neovim `whichwrap` character set; defaults to the pinned strict profile `b,s`. */
  readonly whichWrap?: string;
  /** `startofline` affects gg/G only in this resolver. Defaults to the pinned profile `false`. */
  readonly startOfLine?: boolean;
  /** Vim tabstop, in terminal cells. Defaults to 8. */
  readonly tabSize?: number;
  /** Shared terminal grapheme width policy supplied by layout. */
  readonly widthPolicy?: CellWidthPolicy;
  /** Closed folds supplied by the view; vertical motions skip hidden body lines. */
  readonly folds?: readonly FoldRegion[];
  /** Host-reported visible line range for H/M/L. Zero-based, inclusive. Defaults to the
   * whole document (topLine 0, bottomLine lineCount-1) when the host has no viewport. */
  readonly viewport?: { readonly topLine: number; readonly bottomLine: number };
}

export type VimMotionKind = 'characterwise' | 'linewise';

export interface VimMotionOutcome {
  readonly cursor: VimMotionCursor;
  readonly kind: VimMotionKind;
  readonly moved: boolean;
}

export type VimMotionFailure =
  | { readonly kind: 'stale-document-version' }
  | { readonly kind: 'invalid-cursor' }
  | { readonly kind: 'invalid-count' }
  | { readonly kind: 'invalid-option' }
  | { readonly kind: 'invalid-width-policy' }
  | { readonly kind: 'document-read-failed' };

interface MotionLine {
  readonly index: number;
  readonly start: number;
  readonly length: number;
  readonly printableAscii: boolean;
  readonly text: string;
  readonly graphemeStarts: readonly number[];
  readonly graphemeIndexByOffset: ReadonlyMap<number, number>;
  /** Each terminal display cell maps to the UTF-16 start of its grapheme. */
  readonly cellToUtf16: readonly number[];
  /** Vim's desired column for a cursor on a tab is its final occupied cell. */
  readonly tabEndCellByOffset: ReadonlyMap<number, number>;
  readonly displayWidth: number;
}

interface MotionLineReference {
  readonly index: number;
  readonly start: number;
  /** Exclusive content end; the LF separator is not part of a Vim line. */
  readonly end: number;
}

interface ResolvedOptions {
  readonly whichWrap: string;
  readonly startOfLine: boolean;
  readonly tabSize: number;
  readonly widthPolicy: CellWidthPolicy;
  readonly folds: readonly FoldRegion[];
}

interface DisplayCellMeasure {
  readonly cells: readonly number[];
  readonly width: number;
  readonly lastCluster: string;
  readonly graphemeStarts: readonly number[];
  readonly tabEndCellByOffset: ReadonlyMap<number, number>;
}

interface LocalGraphemeStep {
  readonly targetLocalOffset: number;
  readonly cluster: string;
  readonly targetCluster: string;
}

const MAX_TAB_SIZE = 1000;
const GRAPHEME_SEGMENTER = (Intl as typeof Intl & {
  readonly Segmenter?: new (locales?: string | readonly string[], options?: { readonly granularity: 'grapheme' }) => {
    segment(input: string): Iterable<{ readonly segment: string; readonly index: number }>;
  };
}).Segmenter;

/**
 * Create an initial motion cursor for an immutable document snapshot. The cursor is at a
 * grapheme-start boundary represented in UTF-16 units; desired columns use layout's cell policy.
 */
export function createVimMotionCursor(
  snapshot: DocumentSnapshot,
  offset: Utf16Offset,
  options: VimMotionOptions = {},
): Result<VimMotionCursor, VimMotionFailure> {
  const resolved = resolveOptions(options);
  if (!resolved.ok) return resolved;
  const lineIndex = snapshot.lineIndexAt(offset);
  if (!lineIndex.ok) return motionFailure('invalid-cursor');
  const bounds = readLineReference(snapshot, lineIndex.value as number);
  if (!bounds.ok) return bounds;
  const lineOffset = (offset as number) - bounds.value.start;
  const lineLength = bounds.value.end - bounds.value.start;
  if (lineOffset < 0 || lineOffset > lineLength || (lineLength > 0 && lineOffset === lineLength)) {
    return motionFailure('invalid-cursor');
  }
  const prefixStart = validUtf16Offset(bounds.value.start);
  if (prefixStart === null) return motionFailure('invalid-cursor');
  const asciiPrefix = snapshot.isPrintableAsciiRange?.(prefixStart, offset);
  let displayColumn: number;
  let prefixLastCluster = '';
  if (asciiPrefix?.ok && asciiPrefix.value && resolved.value.widthPolicy.id === 'xi-default-terminal-width') {
    displayColumn = lineOffset;
    prefixLastCluster = lineOffset === 0 ? '' : 'x';
  } else {
    const prefixCells = measureDisplayPrefix(snapshot, bounds.value.start, offset as number,
      resolved.value.tabSize, resolved.value.widthPolicy);
    if (!prefixCells.ok) return prefixCells;
    displayColumn = prefixCells.value.width;
    prefixLastCluster = prefixCells.value.lastCluster;
  }
  if (lineOffset > 0 && lineOffset < lineLength) {
    const scalar = scalarAt(snapshot, bounds.value.start + lineOffset, bounds.value.end);
    if (!scalar.ok) return scalar;
    if (continuesPreviousGrapheme(prefixLastCluster, scalar.value)) {
      const line = readLine(snapshot, lineIndex.value as number, resolved.value);
      if (!line.ok) return line;
      if (!line.value.graphemeIndexByOffset.has(lineOffset)) return motionFailure('invalid-cursor');
      displayColumn = displayCellForOffset(line.value, lineOffset);
    }
  }
  if (lineOffset < lineLength) {
    const currentScalar = scalarAt(snapshot, bounds.value.start + lineOffset, bounds.value.end);
    if (!currentScalar.ok) return currentScalar;
    if (currentScalar.value === '\t') {
      const tabWidth = resolved.value.tabSize - (displayColumn % resolved.value.tabSize);
      displayColumn += tabWidth - 1;
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      documentVersion: snapshot.version,
      offset,
      desiredDisplayCellColumn: cellColumn(displayColumn),
    }),
  };
}

/** Resolve one built-in line/file motion without mutating document, selection, or register state. */
export function resolveVimMotion(
  snapshot: DocumentSnapshot,
  cursor: VimMotionCursor,
  invocation: VimMotionInvocation,
  options: VimMotionOptions = {},
): Result<VimMotionOutcome, VimMotionFailure> {
  if (cursor.documentVersion !== snapshot.version) return motionFailure('stale-document-version');
  if (snapshot.lineCount < 1 || (cursor.offset as number) > snapshot.lengthUtf16) return motionFailure('invalid-cursor');
  if (cursor.desiredDisplayCellColumn !== null
    && (!Number.isSafeInteger(cursor.desiredDisplayCellColumn) || (cursor.desiredDisplayCellColumn as number) < 0)) {
    return motionFailure('invalid-cursor');
  }
  const count = invocation.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1) return motionFailure('invalid-count');
  const resolvedOptions = resolveOptions(options);
  if (!resolvedOptions.ok) return resolvedOptions;
  const lineResult = snapshot.lineIndexAt(cursor.offset);
  if (!lineResult.ok) return motionFailure('invalid-cursor');
  const currentLineIndex = lineResult.value as number;
  const key = invocation.key;
  if (key === 'go') return resolveByteMotion(snapshot, cursor, count, resolvedOptions.value);
  const simpleHorizontal = tryResolveSimpleHorizontal(
    snapshot,
    cursor,
    invocation,
    currentLineIndex,
    resolvedOptions.value,
  );
  if (simpleHorizontal !== null) return simpleHorizontal;
  if (key === '$' || key === '<End>') {
    return resolveLineEnd(snapshot, cursor, currentLineIndex, count, resolvedOptions.value);
  }
  const currentLineResult = readLine(snapshot, currentLineIndex, resolvedOptions.value);
  if (!currentLineResult.ok) return currentLineResult;
  const currentLine = currentLineResult.value;
  const localOffset = (cursor.offset as number) - currentLine.start;
  if (!isGraphemeStartOrEmptyEnd(currentLine, localOffset)) return motionFailure('invalid-cursor');
  const desired = cursor.desiredDisplayCellColumn === null
    ? displayCellForOffset(currentLine, localOffset)
    : cursor.desiredDisplayCellColumn as number;
  if (isHorizontalLeft(key) || isHorizontalRight(key)) {
    const direction = isHorizontalLeft(key) ? -1 : 1;
    const wrapFlag = wrapFlagFor(key);
    const mayWrap = resolvedOptions.value.whichWrap.includes(wrapFlag);
    let targetLine = currentLine;
    let targetOffset = localOffset;
    let moved = false;
    for (let step = 0; step < count; step += 1) {
      const next = stepHorizontal(snapshot, targetLine, targetOffset, direction, mayWrap, resolvedOptions.value);
      if (!next.ok) return next;
      if (!next.value.moved) break;
      targetLine = next.value.line;
      targetOffset = next.value.offset;
      moved = true;
    }
    const targetCell = moved ? displayCellForOffset(targetLine, targetOffset) : desired;
    return makeOutcome(snapshot, cursor, targetLine, targetOffset, targetCell, 'characterwise', moved);
  }

  if (key === 'j' || key === 'k' || key === '<Down>' || key === '<Up>'
    || key === '<NL>' || key === '<C-J>' || key === '<C-N>' || key === '<C-P>') {
    const direction = key === 'j' || key === '<Down>' || key === '<NL>' || key === '<C-J>' || key === '<C-N>' ? 1 : -1;
    const targetLineIndex = stepVisibleLine(snapshot, currentLine.index, direction, count, resolvedOptions.value.folds);
    if (targetLineIndex === null) return motionFailure('invalid-option');
    const targetLineResult = readLine(snapshot, targetLineIndex, resolvedOptions.value, false);
    if (!targetLineResult.ok) return targetLineResult;
    const targetOffset = offsetForDisplayCell(targetLineResult.value, desired);
    const moved = targetLineIndex !== currentLine.index || targetOffset !== localOffset;
    return makeOutcome(snapshot, cursor, targetLineResult.value, targetOffset, desired, 'linewise', moved);
  }

  if (key === '0' || key === '<Home>') {
    const target = firstGraphemeOffset(currentLine);
    return makeOutcome(snapshot, cursor, currentLine, target, 0, 'characterwise', localOffset !== target);
  }
  if (key === '^') {
    const target = firstNonblankOffset(snapshot, currentLine);
    if (!target.ok) return target;
    return makeOutcome(snapshot, cursor, currentLine, target.value, displayCellForOffset(currentLine, target.value), 'characterwise', localOffset !== target.value);
  }
  if (key === '|' ) {
    const requestedCell = count - 1;
    const target = offsetForDisplayCell(currentLine, requestedCell);
    return makeOutcome(snapshot, cursor, currentLine, target, requestedCell, 'characterwise', localOffset !== target);
  }
  if (key === 'g_') {
    const targetLineIndex = clampLineIndex(currentLine.index + count - 1, snapshot.lineCount);
    const targetLineResult = readLine(snapshot, targetLineIndex, resolvedOptions.value);
    if (!targetLineResult.ok) return targetLineResult;
    const targetLine = targetLineResult.value;
    const target = lastNonblankOffset(snapshot, targetLine);
    if (!target.ok) return target;
    const targetIsPhysicalEol = lineLength(targetLine) > 0 && target.value === lastGraphemeOffset(targetLine);
    const desiredColumn = cursor.desiredDisplayCellColumn === VIM_END_OF_LINE_COLUMN
      && targetLineIndex === currentLine.index && targetIsPhysicalEol
      ? VIM_END_OF_LINE_COLUMN as number
      : displayCellForOffset(targetLine, target.value);
    return makeOutcome(snapshot, cursor, targetLine, target.value, desiredColumn, 'characterwise', targetLineIndex !== currentLine.index || localOffset !== target.value);
  }
  if (key === '+' || key === '<CR>' || key === '<C-M>') {
    const targetLineIndex = clampLineIndex(currentLine.index + count, snapshot.lineCount);
    return toFirstNonblank(snapshot, cursor, targetLineIndex, resolvedOptions.value, 'linewise');
  }
  if (key === '-' ) {
    const targetLineIndex = clampLineIndex(currentLine.index - count, snapshot.lineCount);
    return toFirstNonblank(snapshot, cursor, targetLineIndex, resolvedOptions.value, 'linewise');
  }
  if (key === '_') {
    const targetLineIndex = clampLineIndex(currentLine.index + count - 1, snapshot.lineCount);
    return toFirstNonblank(snapshot, cursor, targetLineIndex, resolvedOptions.value, 'linewise');
  }
  if (key === 'gg' || key === '<C-Home>') {
    const targetLineIndex = invocation.count === undefined ? 0 : clampLineIndex(count - 1, snapshot.lineCount);
    return toFileLine(snapshot, cursor, targetLineIndex, resolvedOptions.value, resolvedOptions.value.startOfLine);
  }
  if (key === '<C-End>') {
    const targetLineIndex = invocation.count === undefined ? snapshot.lineCount - 1 : clampLineIndex(count - 1, snapshot.lineCount);
    const targetLine = readLine(snapshot, targetLineIndex, resolvedOptions.value, false);
    if (!targetLine.ok) return targetLine;
    const targetOffset = lastGraphemeOffset(targetLine.value);
    return makeOutcome(snapshot, cursor, targetLine.value, targetOffset, VIM_END_OF_LINE_COLUMN as number, 'linewise',
      targetLineIndex !== currentLine.index || targetOffset !== localOffset);
  }
  if (key === 'G') {
    const targetLineIndex = invocation.count === undefined ? snapshot.lineCount - 1 : clampLineIndex(count - 1, snapshot.lineCount);
    return toFileLine(snapshot, cursor, targetLineIndex, resolvedOptions.value, resolvedOptions.value.startOfLine);
  }
  if (key === 'H' || key === 'M' || key === 'L') {
    const viewport = options.viewport ?? { topLine: 0, bottomLine: snapshot.lineCount - 1 };
    const topLine = clampLineIndex(viewport.topLine, snapshot.lineCount);
    const bottomLine = clampLineIndex(viewport.bottomLine, snapshot.lineCount);
    let targetLineIndex: number;
    if (key === 'H') targetLineIndex = topLine + count - 1;
    else if (key === 'L') targetLineIndex = bottomLine - count + 1;
    else targetLineIndex = Math.floor((topLine + bottomLine) / 2);
    return toFileLine(snapshot, cursor, clampLineIndex(targetLineIndex, snapshot.lineCount), resolvedOptions.value, true);
  }
  return motionFailure('invalid-option');
}

/** Resolve `go`, whose count addresses an absolute UTF-8 byte in the buffer. */
function resolveByteMotion(
  snapshot: DocumentSnapshot,
  cursor: VimMotionCursor,
  count: number,
  options: ResolvedOptions,
): Result<VimMotionOutcome, VimMotionFailure> {
  const length = snapshot.utf8OffsetAt(snapshot.lengthUtf16 as Utf16Offset);
  if (!length.ok) return motionFailure('document-read-failed');
  const totalBytes = length.value as number;
  const requested = count - 1;
  if (requested >= totalBytes) {
    return resolveLineEnd(snapshot, cursor, snapshot.lineCount - 1, 1, options);
  }

  // A byte count may point into a UTF-8 scalar. Vim lands on that scalar's
  // start, so walk back only the at-most-three continuation bytes until the
  // document's coordinate mapper accepts a boundary.
  let byteOffset = requested;
  let target: Utf16Offset | undefined;
  for (let attempts = 0; attempts < 4 && byteOffset >= 0; attempts += 1, byteOffset -= 1) {
    const mapped = snapshot.offsetAtUtf8(byteOffset as Utf8ByteOffset);
    if (mapped.ok) {
      target = mapped.value;
      break;
    }
    if (mapped.error.kind !== 'invalid-encoded-offset') return motionFailure('document-read-failed');
  }
  if (target === undefined) return motionFailure('document-read-failed');
  const lineResult = snapshot.lineIndexAt(target);
  if (!lineResult.ok) return motionFailure('invalid-cursor');
  const lineResultValue = readLine(snapshot, lineResult.value as number, options);
  if (!lineResultValue.ok) return lineResultValue;
  const line = lineResultValue.value;
  const local = (target as number) - line.start;
  // Newline bytes are addressable in the absolute byte stream but are not
  // Normal-mode characters; land on the preceding line's final grapheme.
  if (local >= line.length && line.length > 0) {
    const final = lastGraphemeOffset(line);
    return makeOutcome(snapshot, cursor, line, final, displayCellForOffset(line, final), 'characterwise', true);
  }
  if (!isGraphemeStartOrEmptyEnd(line, local)) return motionFailure('invalid-cursor');
  return makeOutcome(snapshot, cursor, line, local, displayCellForOffset(line, local), 'characterwise', true);
}

function isHorizontalLeft(key: VimMotionKey): boolean {
  return key === 'h' || key === '<Left>' || key === '<C-H>' || key === '<BS>';
}

function isHorizontalRight(key: VimMotionKey): boolean {
  return key === 'l' || key === '<Right>' || key === '<Space>';
}

function wrapFlagFor(key: VimMotionKey): string {
  if (key === 'h') return 'h';
  if (key === 'l') return 'l';
  if (key === '<Left>') return '<';
  if (key === '<Right>') return '>';
  if (key === '<C-H>' || key === '<BS>') return 'b';
  return 's';
}

/** Keep ordinary single-step motion bounded; complex left and wrap edges use the complete line map. */
function tryResolveSimpleHorizontal(
  snapshot: DocumentSnapshot,
  cursor: VimMotionCursor,
  invocation: VimMotionInvocation,
  lineIndex: number,
  options: ResolvedOptions,
): Result<VimMotionOutcome, VimMotionFailure> | null {
  if (invocation.count !== undefined && invocation.count !== 1) return null;
  const key = invocation.key;
  if (!isHorizontalLeft(key) && !isHorizontalRight(key)) return null;
  const boundsResult = readLineReference(snapshot, lineIndex);
  if (!boundsResult.ok) return boundsResult;
  const line = boundsResult.value;
  const localOffset = (cursor.offset as number) - line.start;
  const lineLength = line.end - line.start;
  if (localOffset < 0 || localOffset > lineLength) return null;
  if (lineLength === 0) {
    if (options.whichWrap.includes(wrapFlagFor(key))) return null;
    if (localOffset !== 0 || cursor.desiredDisplayCellColumn === null) return null;
    return makeOutcome(snapshot, cursor, line, 0, cursor.desiredDisplayCellColumn as number,
      'characterwise', false);
  }
  if (localOffset === lineLength) return null;
  const printableAsciiLine = isPrintableAsciiLine(snapshot, line, options.widthPolicy);
  if (printableAsciiLine && cursor.desiredDisplayCellColumn !== localOffset) return null;
  if (!printableAsciiLine && (cursor.desiredDisplayCellColumn === null
    || cursor.desiredDisplayCellColumn === VIM_END_OF_LINE_COLUMN)) return null;
  const direction = isHorizontalLeft(key) ? -1 : 1;
  const targetLocalOffset = localOffset + direction;
  const mayWrap = options.whichWrap.includes(wrapFlagFor(key));
  // At a wrapped line edge the full grapheme/cell map is unnecessary. Resolve
  // the adjacent line using its bounds and only scan its tail when Unicode
  // grapheme state requires it. Printable ASCII, including the long-line
  // benchmark corpus, stays constant-allocation on this path.
  if ((targetLocalOffset < 0 || targetLocalOffset >= lineLength) && mayWrap) {
    const adjacent = lineIndex + direction;
    if (adjacent < 0 || adjacent >= snapshot.lineCount) {
      return makeOutcome(snapshot, cursor, line, localOffset, localOffset, 'characterwise', false);
    }
    const adjacentReference = readLineReference(snapshot, adjacent);
    if (!adjacentReference.ok) return adjacentReference;
    if (direction > 0) {
      return makeOutcome(snapshot, cursor, adjacentReference.value, 0, 0, 'characterwise', true);
    }
    const edge = lastGraphemeEdge(snapshot, adjacentReference.value, options);
    if (!edge.ok) return edge;
    return makeOutcome(snapshot, cursor, adjacentReference.value, edge.value.offset, edge.value.displayCell, 'characterwise', true);
  }
  if (printableAsciiLine && direction > 0) {
    const next = nextGraphemeStart(snapshot, line, localOffset);
    if (!next.ok) return next;
    if (next.value === null) {
      if (mayWrap) return null;
      return makeOutcome(snapshot, cursor, line, localOffset, localOffset, 'characterwise', false);
    }
    if ('fallback' in next.value) return null;
    let width: number;
    if (next.value.cluster === '\t') {
      width = options.tabSize - (localOffset % options.tabSize);
    } else {
      const measuredWidth = widthOfCluster(next.value.cluster, options.widthPolicy);
      if (!measuredWidth.ok) return measuredWidth;
      width = measuredWidth.value;
    }
    const occupiedCells = width === 0 ? 1 : width;
    const targetCell = next.value.targetCluster === '\t'
      ? localOffset + occupiedCells + (options.tabSize - ((localOffset + occupiedCells) % options.tabSize)) - 1
      : localOffset + occupiedCells;
    return makeOutcome(snapshot, cursor, line, next.value.targetLocalOffset, targetCell,
      'characterwise', true);
  }
  if (printableAsciiLine && (targetLocalOffset < 0 || targetLocalOffset >= lineLength)) {
    if (mayWrap) return null;
    return makeOutcome(snapshot, cursor, line, localOffset, localOffset, 'characterwise', false);
  }
  if (printableAsciiLine) {
    const currentIsAscii = readSimpleScalar(snapshot, line.start + localOffset, options.widthPolicy);
    if (!currentIsAscii.ok) return currentIsAscii;
    const targetIsAscii = readSimpleScalar(snapshot, line.start + targetLocalOffset, options.widthPolicy);
    if (!targetIsAscii.ok) return targetIsAscii;
    if (!currentIsAscii.value || !targetIsAscii.value) return null;
    return makeOutcome(snapshot, cursor, line, targetLocalOffset, targetLocalOffset, 'characterwise', true);
  }
  if (direction < 0) {
    const currentScalar = scalarAt(snapshot, line.start + localOffset, line.end);
    if (!currentScalar.ok) return currentScalar;
    // A tab's desired column is its final occupied cell, which cannot be
    // inverted to its start cell without measuring the preceding prefix.
    if (currentScalar.value === '\t') return null;
  }
  const next = direction > 0
    ? nextGraphemeStart(snapshot, line, localOffset)
    : previousGraphemeStart(snapshot, line, localOffset);
  if (!next.ok) return next;
  if (next.value === null) {
    if (mayWrap) return null;
    return makeOutcome(snapshot, cursor, line, localOffset,
      cursor.desiredDisplayCellColumn as number, 'characterwise', false);
  }
  if ('fallback' in next.value) return null;
  const currentCell = cursor.desiredDisplayCellColumn as number;
  const targetWidth = graphemeCellWidth(next.value.targetCluster, options.widthPolicy);
  if (!targetWidth.ok) return targetWidth;
  const currentWidth = graphemeCellWidth(next.value.cluster, options.widthPolicy);
  if (!currentWidth.ok) return currentWidth;
  const nextStartCell = currentCell + (next.value.cluster === '\t' ? 1 : currentWidth.value);
  const targetCell = direction > 0
    ? next.value.targetCluster === '\t'
      ? nextStartCell + options.tabSize - (nextStartCell % options.tabSize) - 1
      : nextStartCell
    : currentCell - (next.value.targetCluster === '\t' ? 1 : targetWidth.value);
  return makeOutcome(snapshot, cursor, line, next.value.targetLocalOffset, targetCell, 'characterwise', true);
}

function lastGraphemeEdge(
  snapshot: DocumentSnapshot,
  line: MotionLineReference,
  options: ResolvedOptions,
): Result<{ readonly offset: number; readonly displayCell: number }, VimMotionFailure> {
  const finalScalarStart = lastScalarStart(snapshot, line);
  if (!finalScalarStart.ok) return finalScalarStart;
  let offset = finalScalarStart.value;
  if (offset !== line.start) {
    const finalScalar = scalarAt(snapshot, offset, line.end);
    if (!finalScalar.ok) return finalScalar;
    const previousStart = previousScalarStart(snapshot, line, offset);
    if (!previousStart.ok) return previousStart;
    if (previousStart.value !== null) {
      const previousScalar = scalarAt(snapshot, previousStart.value, line.end);
      if (!previousScalar.ok) return previousScalar;
      if (continuesPreviousGrapheme(previousScalar.value, finalScalar.value)) {
        const completeLine = readLine(snapshot, line.index, options);
        if (!completeLine.ok) return completeLine;
        offset = line.start + lastGraphemeOffset(completeLine.value);
      }
    }
  }
  const width = edgeDisplayWidth(snapshot, line, options);
  if (!width.ok) return width;
  return { ok: true, value: { offset: offset - line.start, displayCell: Math.max(0, width.value - 1) } };
}

function edgeDisplayWidth(
  snapshot: DocumentSnapshot,
  line: MotionLineReference,
  options: ResolvedOptions,
): Result<number, VimMotionFailure> {
  const length = line.end - line.start;
  if (length === 0) return { ok: true, value: 0 };
  const start = validUtf16Offset(line.start);
  const end = validUtf16Offset(line.end);
  if (start === null || end === null) return motionFailure('document-read-failed');
  const ascii = snapshot.isPrintableAsciiRange?.(start, end);
  if (ascii?.ok && ascii.value && options.widthPolicy.id === 'xi-default-terminal-width') {
    return { ok: true, value: length };
  }
  const text = snapshot.slice(start, end);
  if (!text.ok) return motionFailure('document-read-failed');
  let printableAscii = true;
  for (let offset = 0; offset < text.value.length; offset += 1) {
    const code = text.value.charCodeAt(offset);
    if (code < 0x20 || code > 0x7e) {
      printableAscii = false;
      break;
    }
  }
  if (printableAscii && options.widthPolicy.id === 'xi-default-terminal-width') {
    return { ok: true, value: length };
  }
  const measured = measureDisplayCells(text.value, options.tabSize, options.widthPolicy);
  return measured.ok ? { ok: true, value: measured.value.width } : measured;
}

function resolveLineEnd(
  snapshot: DocumentSnapshot,
  cursor: VimMotionCursor,
  currentLineIndex: number,
  count: number,
  options: ResolvedOptions,
): Result<VimMotionOutcome, VimMotionFailure> {
  const targetLineIndex = count >= snapshot.lineCount - currentLineIndex
    ? snapshot.lineCount - 1
    : currentLineIndex + count - 1;
  const bounds = readLineReference(snapshot, targetLineIndex);
  if (!bounds.ok) return bounds;
  const targetOffset = lastGraphemeStart(snapshot, bounds.value, options);
  if (!targetOffset.ok) return targetOffset;
  return makeOutcome(snapshot, cursor, bounds.value, targetOffset.value - bounds.value.start,
    VIM_END_OF_LINE_COLUMN as number, 'characterwise',
    targetLineIndex !== currentLineIndex || targetOffset.value !== (cursor.offset as number));
}

function readLineReference(
  snapshot: DocumentSnapshot,
  index: number,
): Result<MotionLineReference, VimMotionFailure> {
  if (!Number.isSafeInteger(index) || index < 0 || index >= snapshot.lineCount) return motionFailure('invalid-cursor');
  const line = validLineIndex(index);
  if (line === null) return motionFailure('invalid-cursor');
  const start = snapshot.lineStartOffset(line);
  if (!start.ok) return motionFailure('document-read-failed');
  let end = snapshot.lengthUtf16;
  if (index + 1 < snapshot.lineCount) {
    const next = snapshot.lineStartOffset(validLineIndex(index + 1) as LineIndex);
    if (!next.ok) return motionFailure('document-read-failed');
    end = (next.value as number) - 1;
  }
  if (end < (start.value as number)) return motionFailure('document-read-failed');
  return { ok: true, value: { index, start: start.value as number, end } };
}

function readSimpleScalar(
  snapshot: DocumentSnapshot,
  offset: number,
  widthPolicy: CellWidthPolicy,
): Result<boolean, VimMotionFailure> {
  const start = validUtf16Offset(offset);
  const end = validUtf16Offset(offset + 1);
  if (start === null || end === null) return motionFailure('document-read-failed');
  const result = snapshot.slice(start, end);
  if (!result.ok) {
    return result.error.kind === 'surrogate-split'
      ? { ok: true, value: false }
      : motionFailure('document-read-failed');
  }
  if (result.value.length !== 1) return { ok: true, value: false };
  const codePoint = result.value.codePointAt(0) ?? 128;
  if (codePoint < 0x20 || codePoint > 0x7e) return { ok: true, value: false };
  try {
    return { ok: true, value: widthPolicy.widthOfCluster(result.value) === 1 };
  } catch {
    return motionFailure('invalid-width-policy');
  }
}

function nextGraphemeStart(
  snapshot: DocumentSnapshot,
  line: MotionLineReference,
  localOffset: number,
): Result<LocalGraphemeStep | { readonly fallback: true } | null, VimMotionFailure> {
  const segmenter = GRAPHEME_SEGMENTER;
  if (segmenter === undefined) return motionFailure('invalid-width-policy');
  const lineLength = line.end - line.start;
  if (localOffset >= lineLength) return { ok: true, value: null };
  try {
    let readOffset = line.start + localOffset;
    let windowSize = 8;
    let text = '';
    const graphemes = new segmenter('und', { granularity: 'grapheme' });
    while (readOffset < line.end) {
      const targetEnd = Math.min(line.end, line.start + localOffset + windowSize);
      const parts: string[] = [text];
      while (readOffset < targetEnd) {
        const chunk = readMotionChunk(snapshot, readOffset, Math.min(targetEnd, readOffset + MOTION_READ_WINDOW));
        if (!chunk.ok) return chunk;
        parts.push(chunk.value.text);
        readOffset = chunk.value.end;
      }
      text = parts.join('');
      const iterator = graphemes.segment(text)[Symbol.iterator]();
      const current = iterator.next();
      if (current.done) return motionFailure('document-read-failed');
      const following = iterator.next();
      if (!following.done) {
        return {
          ok: true,
          value: {
            targetLocalOffset: localOffset + following.value.index,
            cluster: current.value.segment,
            targetCluster: following.value.segment,
          },
        };
      }
      if (readOffset === line.end) return { ok: true, value: null };
      windowSize = Math.min(lineLength - localOffset, windowSize * 2);
    }
    return { ok: true, value: null };
  } catch {
    return motionFailure('invalid-width-policy');
  }
}

function previousGraphemeStart(
  snapshot: DocumentSnapshot,
  line: MotionLineReference,
  localOffset: number,
): Result<LocalGraphemeStep | null, VimMotionFailure> {
  const segmenter = GRAPHEME_SEGMENTER;
  if (segmenter === undefined) return motionFailure('invalid-width-policy');
  if (localOffset <= 0) return { ok: true, value: null };
  const absoluteEnd = line.start + localOffset;
  let readOffset = absoluteEnd;
  let windowSize = 8;
  let text = '';
  try {
    const graphemes = new segmenter('und', { granularity: 'grapheme' });
    while (readOffset > line.start) {
      const targetStart = Math.max(line.start, absoluteEnd - windowSize);
      const parts: string[] = [];
      while (readOffset > targetStart) {
        const chunkStart = Math.max(targetStart, readOffset - MOTION_READ_WINDOW);
        const chunk = readMotionChunk(snapshot, chunkStart, readOffset);
        if (!chunk.ok) return chunk;
        parts.push(chunk.value.text);
        readOffset = chunkStart;
      }
      parts.reverse();
      // @xi-perf-allow strings ENGINE-MOVE-ALLOC -- The window doubles on each retry, so total copied grapheme text stays below twice the discovered cluster; this preserves exact Unicode boundaries while each document read remains bounded.
      text = parts.join('') + text;
      const entries = graphemes.segment(text);
      let previous: { readonly segment: string; readonly index: number } | undefined;
      let last: { readonly segment: string; readonly index: number } | undefined;
      for (const entry of entries) {
        previous = last;
        last = entry;
      }
      if (last !== undefined && previous !== undefined) {
        return {
          ok: true,
          value: {
            targetLocalOffset: targetStart + last.index,
            cluster: last.segment,
            targetCluster: last.segment,
          },
        };
      }
      if (readOffset === line.start && last !== undefined) {
        return {
          ok: true,
          value: { targetLocalOffset: 0, cluster: last.segment, targetCluster: last.segment },
        };
      }
      windowSize = Math.min(localOffset, windowSize * 2);
    }
  } catch {
    return motionFailure('invalid-width-policy');
  }
  return { ok: true, value: null };
}

function widthOfCluster(cluster: string, widthPolicy: CellWidthPolicy): Result<number, VimMotionFailure> {
  try {
    const width = widthPolicy.widthOfCluster(cluster);
    if (!Number.isSafeInteger(width) || width < 0 || width > 2) return motionFailure('invalid-width-policy');
    return { ok: true, value: width };
  } catch {
    return motionFailure('invalid-width-policy');
  }
}

function graphemeCellWidth(cluster: string, widthPolicy: CellWidthPolicy): Result<number, VimMotionFailure> {
  const measured = widthOfCluster(cluster, widthPolicy);
  if (!measured.ok) return measured;
  return { ok: true, value: measured.value === 0 ? 1 : measured.value };
}

function isPrintableAsciiLine(
  snapshot: DocumentSnapshot,
  line: MotionLineReference,
  widthPolicy: CellWidthPolicy,
): boolean {
  if (widthPolicy.id !== 'xi-default-terminal-width') return false;
  const start = validUtf16Offset(line.start);
  const end = validUtf16Offset(line.end);
  if (start === null || end === null) return false;
  const result = snapshot.isPrintableAsciiRange?.(start, end);
  return result?.ok === true && result.value;
}

function scalarAt(
  snapshot: DocumentSnapshot,
  offset: number,
  lineEnd: number,
): Result<string, VimMotionFailure> {
  const start = validUtf16Offset(offset);
  const oneUnitEnd = validUtf16Offset(offset + 1);
  if (start === null || oneUnitEnd === null || offset >= lineEnd) return motionFailure('document-read-failed');
  const oneUnit = snapshot.slice(start, oneUnitEnd);
  if (oneUnit.ok) return { ok: true, value: oneUnit.value };
  if (oneUnit.error.kind !== 'surrogate-split' || offset + 2 > lineEnd) return motionFailure('document-read-failed');
  const twoUnitEnd = validUtf16Offset(offset + 2);
  if (twoUnitEnd === null) return motionFailure('document-read-failed');
  const pair = snapshot.slice(start, twoUnitEnd);
  return pair.ok && pair.value.length === 2
    ? { ok: true, value: pair.value }
    : motionFailure('document-read-failed');
}

function continuesPreviousGrapheme(previousCluster: string, scalar: string): boolean {
  if (previousCluster.length === 0) return false;
  const segmenter = GRAPHEME_SEGMENTER;
  if (segmenter === undefined) return true;
  const boundary = previousCluster.length;
  try {
    for (const cluster of new segmenter('und', { granularity: 'grapheme' }).segment(previousCluster + scalar)) {
      if (cluster.index === boundary) return false;
      if (cluster.index > boundary) return true;
    }
    return true;
  } catch {
    return true;
  }
}

/** Measure a UTF-16 prefix with bounded source windows and one pending grapheme. */
function measureDisplayPrefix(
  snapshot: DocumentSnapshot,
  start: number,
  end: number,
  tabSize: number,
  widthPolicy: CellWidthPolicy,
): Result<{ readonly width: number; readonly lastCluster: string }, VimMotionFailure> {
  if (start < 0 || end < start) return motionFailure('document-read-failed');
  const segmenter = GRAPHEME_SEGMENTER;
  if (segmenter === undefined) return motionFailure('invalid-width-policy');
  let offset = start;
  let pending = '';
  let displayWidth = 0;
  let lastCluster = '';
  const consume = (cluster: string): Result<void, VimMotionFailure> => {
    if (cluster === '\t') {
      displayWidth += tabSize - (displayWidth % tabSize);
    } else {
      const width = widthOfCluster(cluster, widthPolicy);
      if (!width.ok) return width;
      displayWidth += width.value === 0 ? 1 : width.value;
    }
    lastCluster = cluster;
    return { ok: true, value: undefined };
  };
  try {
    while (offset < end) {
      const chunk = readMotionChunk(snapshot, offset, Math.min(end, offset + MOTION_READ_WINDOW));
      if (!chunk.ok) return chunk;
      let nextPending = '';
      for (const entry of new segmenter('und', { granularity: 'grapheme' }).segment(pending + chunk.value.text)) {
        if (nextPending !== '') {
          const consumed = consume(nextPending);
          if (!consumed.ok) return consumed;
        }
        nextPending = entry.segment;
      }
      pending = nextPending;
      offset = chunk.value.end;
    }
    if (pending !== '') {
      const consumed = consume(pending);
      if (!consumed.ok) return consumed;
    }
  } catch {
    return motionFailure('invalid-width-policy');
  }
  return { ok: true, value: { width: displayWidth, lastCluster } };
}

function lastScalarStart(
  snapshot: DocumentSnapshot,
  line: MotionLineReference,
): Result<number, VimMotionFailure> {
  if (line.end === line.start) return { ok: true, value: line.start };
  const finalUnitStart = validUtf16Offset(line.end - 1);
  const lineEnd = validUtf16Offset(line.end);
  if (finalUnitStart === null || lineEnd === null) return motionFailure('document-read-failed');
  const finalUnit = snapshot.slice(finalUnitStart, lineEnd);
  if (!finalUnit.ok) return motionFailure('document-read-failed');
  const value = finalUnit.value.charCodeAt(0);
  if (value >= 0xdc00 && value <= 0xdfff) {
    const pairStart = validUtf16Offset(line.end - 2);
    if (pairStart === null) return motionFailure('document-read-failed');
    const pair = snapshot.slice(pairStart, lineEnd);
    if (!pair.ok || pair.value.length !== 2) return motionFailure('document-read-failed');
    return { ok: true, value: line.end - 2 };
  }
  return { ok: true, value: line.end - 1 };
}

function lastGraphemeStart(
  snapshot: DocumentSnapshot,
  line: MotionLineReference,
  options: ResolvedOptions,
): Result<number, VimMotionFailure> {
  const finalScalarStart = lastScalarStart(snapshot, line);
  if (!finalScalarStart.ok) return finalScalarStart;
  if (finalScalarStart.value === line.start) return finalScalarStart;
  const finalScalar = scalarAt(snapshot, finalScalarStart.value, line.end);
  if (!finalScalar.ok) return finalScalar;
  const previousStart = previousScalarStart(snapshot, line, finalScalarStart.value);
  if (!previousStart.ok) return previousStart;
  if (previousStart.value === null) return finalScalarStart;
  const previousScalar = scalarAt(snapshot, previousStart.value, line.end);
  if (!previousScalar.ok) return previousScalar;
  if (!continuesPreviousGrapheme(previousScalar.value, finalScalar.value)) return finalScalarStart;
  const completeLine = readLine(snapshot, line.index, options);
  if (!completeLine.ok) return completeLine;
  const graphemeStart = lastGraphemeOffset(completeLine.value);
  return { ok: true, value: line.start + graphemeStart };
}

function previousScalarStart(
  snapshot: DocumentSnapshot,
  line: MotionLineReference,
  offset: number,
): Result<number | null, VimMotionFailure> {
  if (offset <= line.start) return { ok: true, value: null };
  const end = validUtf16Offset(offset);
  const oneUnitStart = validUtf16Offset(offset - 1);
  if (end === null || oneUnitStart === null) return motionFailure('document-read-failed');
  const oneUnit = snapshot.slice(oneUnitStart, end);
  if (oneUnit.ok) return { ok: true, value: offset - 1 };
  if (oneUnit.error.kind !== 'surrogate-split' || offset - 2 < line.start) return motionFailure('document-read-failed');
  const pairStart = validUtf16Offset(offset - 2);
  if (pairStart === null) return motionFailure('document-read-failed');
  const pair = snapshot.slice(pairStart, end);
  return pair.ok && pair.value.length === 2
    ? { ok: true, value: offset - 2 }
    : motionFailure('document-read-failed');
}

function stepHorizontal(
  snapshot: DocumentSnapshot,
  line: MotionLine,
  offset: number,
  direction: -1 | 1,
  mayWrap: boolean,
  options: ResolvedOptions,
): Result<{ readonly line: MotionLine; readonly offset: number; readonly moved: boolean }, VimMotionFailure> {
  if (line.printableAscii) {
    const target = offset + direction;
    if (target >= 0 && target < line.length) {
      return { ok: true, value: { line, offset: target, moved: true } };
    }
    if (!mayWrap) return { ok: true, value: { line, offset, moved: false } };
    const adjacent = line.index + direction;
    if (adjacent < 0 || adjacent >= snapshot.lineCount) return { ok: true, value: { line, offset, moved: false } };
    const nextLine = readLine(snapshot, adjacent, options, false);
    if (!nextLine.ok) return nextLine;
    const nextOffset = direction < 0 ? lastGraphemeOffset(nextLine.value) : firstGraphemeOffset(nextLine.value);
    return { ok: true, value: { line: nextLine.value, offset: nextOffset, moved: true } };
  }
  const graphemeIndex = line.graphemeIndexByOffset.get(offset) ?? -1;
  if (line.graphemeStarts.length === 0) {
    if (!mayWrap) return { ok: true, value: { line, offset, moved: false } };
    const adjacent = line.index + direction;
    if (adjacent < 0 || adjacent >= snapshot.lineCount) return { ok: true, value: { line, offset, moved: false } };
    const nextLine = readLine(snapshot, adjacent, options);
    if (!nextLine.ok) return nextLine;
    const nextOffset = direction < 0 ? lastGraphemeOffset(nextLine.value) : firstGraphemeOffset(nextLine.value);
    return { ok: true, value: { line: nextLine.value, offset: nextOffset, moved: true } };
  }
  if (graphemeIndex < 0) return motionFailure('invalid-cursor');
  const nextIndex = graphemeIndex + direction;
  if (nextIndex >= 0 && nextIndex < line.graphemeStarts.length) {
    return { ok: true, value: { line, offset: line.graphemeStarts[nextIndex] ?? offset, moved: true } };
  }
  if (!mayWrap) return { ok: true, value: { line, offset, moved: false } };
  const adjacent = line.index + direction;
  if (adjacent < 0 || adjacent >= snapshot.lineCount) return { ok: true, value: { line, offset, moved: false } };
  const nextLine = readLine(snapshot, adjacent, options);
  if (!nextLine.ok) return nextLine;
  const nextOffset = direction < 0 ? lastGraphemeOffset(nextLine.value) : firstGraphemeOffset(nextLine.value);
  return { ok: true, value: { line: nextLine.value, offset: nextOffset, moved: true } };
}

function toFirstNonblank(
  snapshot: DocumentSnapshot,
  cursor: VimMotionCursor,
  targetLineIndex: number,
  options: ResolvedOptions,
  kind: VimMotionKind,
): Result<VimMotionOutcome, VimMotionFailure> {
  const line = readLine(snapshot, targetLineIndex, options);
  if (!line.ok) return line;
  const offset = firstNonblankOffset(snapshot, line.value);
  if (!offset.ok) return offset;
  const current = snapshot.lineIndexAt(cursor.offset);
  if (!current.ok) return motionFailure('invalid-cursor');
  return makeOutcome(snapshot, cursor, line.value, offset.value, displayCellForOffset(line.value, offset.value), kind,
    targetLineIndex !== (current.value as number) || line.value.start + offset.value !== (cursor.offset as number));
}

function toFileLine(
  snapshot: DocumentSnapshot,
  cursor: VimMotionCursor,
  targetLineIndex: number,
  options: ResolvedOptions,
  startOfLine: boolean,
): Result<VimMotionOutcome, VimMotionFailure> {
  const currentLineResult = snapshot.lineIndexAt(cursor.offset);
  if (!currentLineResult.ok) return motionFailure('invalid-cursor');
  const currentLine = readLine(snapshot, currentLineResult.value as number, options, false);
  const targetLine = readLine(snapshot, targetLineIndex, options);
  if (!currentLine.ok) return currentLine;
  if (!targetLine.ok) return targetLine;
  if (startOfLine) {
    const targetOffset = firstNonblankOffset(snapshot, targetLine.value);
    if (!targetOffset.ok) return targetOffset;
    return makeOutcome(snapshot, cursor, targetLine.value, targetOffset.value, displayCellForOffset(targetLine.value, targetOffset.value), 'linewise',
      targetLineIndex !== currentLineResult.value as number || targetOffset.value !== (cursor.offset as number) - currentLine.value.start);
  }
  const desired = cursor.desiredDisplayCellColumn === null
    ? displayCellForOffset(currentLine.value, (cursor.offset as number) - currentLine.value.start)
    : cursor.desiredDisplayCellColumn as number;
  const targetOffset = offsetForDisplayCell(targetLine.value, desired);
  return makeOutcome(snapshot, cursor, targetLine.value, targetOffset, desired, 'linewise',
    targetLineIndex !== currentLineResult.value as number || targetOffset !== (cursor.offset as number) - currentLine.value.start);
}

function makeOutcome(
  snapshot: DocumentSnapshot,
  prior: VimMotionCursor,
  line: Pick<MotionLine, 'start' | 'index'>,
  localOffset: number,
  desiredDisplayCellColumn: number,
  kind: VimMotionKind,
  moved: boolean,
): Result<VimMotionOutcome, VimMotionFailure> {
  const newOffset = line.start + localOffset;
  if (!isNonnegativeSafeInteger(newOffset) || !isNonnegativeSafeInteger(desiredDisplayCellColumn) || line.index >= snapshot.lineCount) {
    return motionFailure('invalid-cursor');
  }
  return {
    ok: true,
    value: Object.freeze({
      cursor: Object.freeze({
        documentVersion: snapshot.version,
        offset: newOffset as Utf16Offset,
        desiredDisplayCellColumn: desiredDisplayCellColumn as CellColumn,
      }),
      kind,
      moved: moved || newOffset !== (prior.offset as number)
        || desiredDisplayCellColumn !== (prior.desiredDisplayCellColumn as number | null),
    }),
  };
}

function readLine(
  snapshot: DocumentSnapshot,
  index: number,
  options: ResolvedOptions,
  materializeText = false,
): Result<MotionLine, VimMotionFailure> {
  if (!Number.isSafeInteger(index) || index < 0 || index >= snapshot.lineCount) return motionFailure('invalid-cursor');
  const lineIndex = validLineIndex(index);
  if (lineIndex === null) return motionFailure('invalid-cursor');
  const startResult = snapshot.lineStartOffset(lineIndex);
  if (!startResult.ok) return motionFailure('document-read-failed');
  let end = snapshot.lengthUtf16;
  if (index + 1 < snapshot.lineCount) {
    const nextIndex = validLineIndex(index + 1);
    if (nextIndex === null) return motionFailure('document-read-failed');
    const nextStart = snapshot.lineStartOffset(nextIndex);
    if (!nextStart.ok) return motionFailure('document-read-failed');
    end = (nextStart.value as number) - 1;
  }
  const start = startResult.value as number;
  if (end < start) return motionFailure('document-read-failed');
  const sliceStart = validUtf16Offset(start);
  const sliceEnd = validUtf16Offset(end);
  if (sliceStart === null || sliceEnd === null) return motionFailure('document-read-failed');
  const ascii = snapshot.isPrintableAsciiRange?.(sliceStart, sliceEnd);
  if (ascii?.ok && ascii.value && options.widthPolicy.id === 'xi-default-terminal-width') {
    let text = '';
    if (materializeText) {
      const textResult = snapshot.slice(sliceStart, sliceEnd);
      if (!textResult.ok || textResult.value.includes('\n')) return motionFailure('document-read-failed');
      text = textResult.value;
    }
    return {
      ok: true,
      value: {
        index,
        start,
        length: end - start,
        printableAscii: true,
        text,
        graphemeStarts: [],
        graphemeIndexByOffset: new Map(),
        cellToUtf16: [],
        tabEndCellByOffset: new Map(),
        displayWidth: end - start,
      },
    };
  }
  const textResult = snapshot.slice(sliceStart, sliceEnd);
  if (!textResult.ok || textResult.value.includes('\n')) return motionFailure('document-read-failed');
  const cellMap = measureDisplayCells(textResult.value, options.tabSize, options.widthPolicy);
  if (!cellMap.ok) return cellMap;
  return {
    ok: true,
    value: {
      index,
      start,
      length: textResult.value.length,
      printableAscii: false,
      text: textResult.value,
      graphemeStarts: cellMap.value.graphemeStarts,
      graphemeIndexByOffset: new Map(cellMap.value.graphemeStarts.map((cell, clusterIndex) => [cell, clusterIndex])),
      cellToUtf16: cellMap.value.cells,
      tabEndCellByOffset: cellMap.value.tabEndCellByOffset,
      displayWidth: cellMap.value.width,
    },
  };
}

function measureDisplayCells(
  text: string,
  tabSize: number,
  widthPolicy: CellWidthPolicy,
): Result<DisplayCellMeasure, VimMotionFailure> {
  // The common long-line case is printable single-width ASCII. Avoid creating
  // an Intl.Segmenter iterator for every scalar; this keeps edge motions on a
  // 100k/1 MiB line within the engine-step budget while preserving the same
  // grapheme and cell maps used by the general Unicode path.
  let printableAscii = true;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) {
      printableAscii = false;
      break;
    }
  }
  if (printableAscii && widthPolicy.id === 'xi-default-terminal-width') {
    const cells: number[] = new Array(text.length);
    const graphemeStarts: number[] = new Array(text.length);
    for (let index = 0; index < text.length; index += 1) {
      cells[index] = index;
      graphemeStarts[index] = index;
    }
    return {
      ok: true,
      value: {
        cells,
        width: text.length,
        lastCluster: text.at(-1) ?? '',
        graphemeStarts,
        tabEndCellByOffset: new Map(),
      },
    };
  }
  const segmenter = GRAPHEME_SEGMENTER;
  if (segmenter === undefined) return motionFailure('invalid-width-policy');
  const cells: number[] = [];
  const graphemeStarts: number[] = [];
  const tabEndCellByOffset = new Map<number, number>();
  let displayWidth = 0;
  let lastCluster = '';
  try {
    for (const cluster of new segmenter('und', { granularity: 'grapheme' }).segment(text)) {
      lastCluster = cluster.segment;
      graphemeStarts.push(cluster.index);
      const width = cluster.segment === '\t'
        ? tabSize - (displayWidth % tabSize)
        : widthPolicy.widthOfCluster(cluster.segment);
      if (!Number.isSafeInteger(width) || width < 0 || (cluster.segment !== '\t' && width > 2)) return motionFailure('invalid-width-policy');
      const occupiedCells = width === 0 ? 1 : width;
      if (cluster.segment === '\t') tabEndCellByOffset.set(cluster.index, displayWidth + occupiedCells - 1);
      for (let index = 0; index < occupiedCells; index += 1) cells.push(cluster.index);
      displayWidth += occupiedCells;
    }
  } catch {
    return motionFailure('invalid-width-policy');
  }
  return { ok: true, value: { cells, width: displayWidth, lastCluster, graphemeStarts, tabEndCellByOffset } };
}

function displayCellForOffset(line: MotionLine, offset: number): number {
  if (line.printableAscii) return line.length === 0 ? 0 : Math.min(Math.max(0, offset), line.length - 1);
  const tabEndCell = line.tabEndCellByOffset.get(offset);
  if (tabEndCell !== undefined) return tabEndCell;
  if (line.displayWidth === 0) return 0;
  const firstCell = line.cellToUtf16.findIndex((value) => value === offset);
  if (firstCell >= 0) return firstCell;
  return line.displayWidth - 1;
}

function offsetForDisplayCell(line: MotionLine, cell: number): number {
  if (line.printableAscii) return line.length === 0 ? 0 : Math.min(Math.max(0, cell), line.length - 1);
  if (line.graphemeStarts.length === 0) return 0;
  if (cell >= line.displayWidth) return line.graphemeStarts.at(-1) ?? 0;
  if (cell < 0) return line.graphemeStarts[0] ?? 0;
  return line.cellToUtf16[cell] ?? line.graphemeStarts.at(-1) ?? 0;
}

function firstNonblankOffset(
  snapshot: DocumentSnapshot,
  line: MotionLine,
): Result<number, VimMotionFailure> {
  if (line.printableAscii) {
    for (let offset = 0; offset < line.length; offset += MOTION_READ_WINDOW) {
      const end = Math.min(line.length, offset + MOTION_READ_WINDOW);
      const text = sliceMotionWindow(snapshot, line.start + offset, line.start + end);
      if (!text.ok) return text;
      for (let index = 0; index < text.value.length; index += 1) {
        const code = text.value.charCodeAt(index);
        if (code !== 0x20 && code !== 0x09) return { ok: true, value: offset + index };
      }
    }
    return { ok: true, value: Math.max(0, line.length - 1) };
  }
  if (line.text.length === 0) return { ok: true, value: 0 };
  for (let index = 0; index < line.graphemeStarts.length; index += 1) {
    const start = line.graphemeStarts[index] ?? 0;
    const end = line.graphemeStarts[index + 1] ?? line.text.length;
    const value = line.text.slice(start, end);
    if (value !== ' ' && value !== '\t') return { ok: true, value: start };
  }
  return { ok: true, value: line.graphemeStarts.at(-1) ?? 0 };
}

function lastNonblankOffset(
  snapshot: DocumentSnapshot,
  line: MotionLine,
): Result<number, VimMotionFailure> {
  if (line.printableAscii) {
    for (let offset = line.length; offset > 0; offset -= MOTION_READ_WINDOW) {
      const start = Math.max(0, offset - MOTION_READ_WINDOW);
      const text = sliceMotionWindow(snapshot, line.start + start, line.start + offset);
      if (!text.ok) return text;
      for (let index = text.value.length - 1; index >= 0; index -= 1) {
        const code = text.value.charCodeAt(index);
        if (code !== 0x20 && code !== 0x09) return { ok: true, value: start + index };
      }
    }
    return { ok: true, value: 0 };
  }
  if (line.text.length === 0) return { ok: true, value: 0 };
  for (let index = line.graphemeStarts.length - 1; index >= 0; index -= 1) {
    const start = line.graphemeStarts[index] ?? 0;
    const end = line.graphemeStarts[index + 1] ?? line.text.length;
    const value = line.text.slice(start, end);
    if (value !== ' ' && value !== '\t') return { ok: true, value: start };
  }
  return { ok: true, value: 0 };
}

function isGraphemeStartOrEmptyEnd(line: MotionLine, offset: number): boolean {
  if (line.printableAscii) return line.length === 0 ? offset === 0 : offset >= 0 && offset < line.length;
  return line.graphemeIndexByOffset.has(offset) || (line.graphemeStarts.length === 0 && offset === 0);
}

function firstGraphemeOffset(line: MotionLine): number {
  return line.printableAscii ? 0 : line.graphemeStarts[0] ?? 0;
}

function lastGraphemeOffset(line: MotionLine): number {
  return line.printableAscii ? Math.max(0, line.length - 1) : line.graphemeStarts.at(-1) ?? 0;
}

function lineLength(line: MotionLine): number {
  return line.length;
}

const MOTION_READ_WINDOW = 256;

function sliceMotionWindow(
  snapshot: DocumentSnapshot,
  start: number,
  end: number,
): Result<string, VimMotionFailure> {
  const startOffset = validUtf16Offset(start);
  const endOffset = validUtf16Offset(end);
  if (startOffset === null || endOffset === null) return motionFailure('document-read-failed');
  const result = snapshot.slice(startOffset, endOffset);
  return result.ok ? result : motionFailure('document-read-failed');
}

function readMotionChunk(
  snapshot: DocumentSnapshot,
  start: number,
  requestedEnd: number,
): Result<{ readonly text: string; readonly end: number }, VimMotionFailure> {
  const startOffset = validUtf16Offset(start);
  if (startOffset === null || requestedEnd <= start) return motionFailure('document-read-failed');
  let end = requestedEnd;
  while (end > start) {
    const endOffset = validUtf16Offset(end);
    if (endOffset === null) return motionFailure('document-read-failed');
    const result = snapshot.slice(startOffset, endOffset);
    if (result.ok) return { ok: true, value: { text: result.value, end } };
    if (result.error.kind !== 'surrogate-split') return motionFailure('document-read-failed');
    end -= 1;
  }
  return motionFailure('document-read-failed');
}

function clampLineIndex(index: number, lineCount: number): number {
  return Math.min(Math.max(0, index), lineCount - 1);
}

function resolveOptions(options: VimMotionOptions): Result<ResolvedOptions, VimMotionFailure> {
  const whichWrap = options.whichWrap ?? 'b,s';
  const startOfLine = options.startOfLine ?? false;
  const tabSize = options.tabSize ?? 8;
  const widthPolicy = options.widthPolicy ?? defaultCellWidthPolicy();
  if (typeof whichWrap !== 'string' || typeof startOfLine !== 'boolean'
    || !Number.isSafeInteger(tabSize) || tabSize < 1 || tabSize > MAX_TAB_SIZE) return motionFailure('invalid-option');
  if (typeof widthPolicy.widthOfCluster !== 'function') return motionFailure('invalid-width-policy');
  const folds = options.folds ?? [];
  let lastFoldEnd = -1;
  for (const fold of folds) {
    const startLine = fold.startLine as number;
    const endLineExclusive = fold.endLineExclusive as number;
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLineExclusive)
      || startLine < 0 || endLineExclusive <= startLine || startLine < lastFoldEnd) return motionFailure('invalid-option');
    lastFoldEnd = endLineExclusive;
  }
  return { ok: true, value: { whichWrap, startOfLine, tabSize, widthPolicy, folds } };
}

function stepVisibleLine(
  snapshot: DocumentSnapshot,
  startLine: number,
  direction: number,
  count: number,
  folds: readonly FoldRegion[],
): number | null {
  for (const fold of folds) {
    if (fold.documentVersion !== snapshot.version || (fold.endLineExclusive as number) > snapshot.lineCount) return null;
  }
  let line = startLine;
  for (let step = 0; step < count; step += 1) {
    const target = clampLineIndex(line + direction, snapshot.lineCount);
    if (target === line) break;
    const hiddenFold = folds.find((fold) => (fold.startLine as number) < target && target < (fold.endLineExclusive as number));
    line = hiddenFold === undefined
      ? target
      : direction > 0
        ? clampLineIndex(hiddenFold.endLineExclusive as number, snapshot.lineCount)
        : hiddenFold.startLine as number;
  }
  return line;
}

function cellColumn(value: number): CellColumn {
  if (!isNonnegativeSafeInteger(value)) throw new Error('vim-motion-generated-invalid-cell-column');
  return value as CellColumn;
}

function validLineIndex(value: number): LineIndex | null {
  return isNonnegativeSafeInteger(value) ? value as LineIndex : null;
}

function validUtf16Offset(value: number): Utf16Offset | null {
  return isNonnegativeSafeInteger(value) ? value as Utf16Offset : null;
}

function isNonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function motionFailure(kind: VimMotionFailure['kind']): Result<never, VimMotionFailure> {
  return { ok: false, error: { kind } };
}
