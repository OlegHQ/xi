import type {
  CellColumn,
  DocumentSnapshot,
  DocumentVersion,
  LineIndex,
  Utf16Offset,
} from '../../document/src/index.ts';
import { defaultCellWidthPolicy, type CellWidthPolicy, type FoldRegion, type ScreenRow, type ViewportAnchor, type VisibleFrame } from '../../layout/src/index';

export interface VimViewportMotionCursor {
  readonly documentVersion: DocumentVersion;
  readonly offset: Utf16Offset;
  readonly desiredDisplayCellColumn: CellColumn | null;
}

export type VimViewportMotionKey = 'gj' | 'gk' | 'g0' | 'g^' | 'g$' | 'gm' | 'gM' | 'H' | 'M' | 'L';
export type VimViewportScrollKey = 'zt' | 'zz' | 'zb' | '<C-E>' | '<C-Y>' | '<C-D>' | '<C-U>' | '<C-F>' | '<C-B>';

export interface VimViewportCursor {
  readonly cursor: VimViewportMotionCursor;
  /** Sticky column measured from the text area's left edge, in terminal cells. */
  readonly desiredScreenCellColumn: CellColumn | null;
}

export interface VimViewportInvocation {
  readonly key: VimViewportMotionKey | VimViewportScrollKey;
  readonly count?: number;
}

export interface VimViewportOptions {
  readonly scrolloff?: number;
  readonly sidescrolloff?: number;
  readonly scrollAmount?: number;
  readonly tabSize?: number;
  readonly widthPolicy?: CellWidthPolicy;
  readonly folds?: readonly FoldRegion[];
}

export interface VimViewportOutcome {
  readonly cursor: VimViewportMotionCursor;
  readonly desiredScreenCellColumn: CellColumn | null;
  readonly viewportAnchor: ViewportAnchor;
  readonly horizontalScrollCells: CellColumn;
  readonly kind: 'characterwise' | 'linewise';
  readonly moved: boolean;
  readonly viewportOnly: boolean;
}

export type VimViewportFailure =
  | { readonly kind: 'stale-document-version' }
  | { readonly kind: 'stale-layout-frame' }
  | { readonly kind: 'invalid-cursor' }
  | { readonly kind: 'invalid-count' }
  | { readonly kind: 'invalid-option' }
  | { readonly kind: 'invalid-frame' }
  | { readonly kind: 'cursor-not-visible' }
  | { readonly kind: 'destination-not-visible' }
  | { readonly kind: 'document-read-failed' };

interface LocatedCursor {
  readonly point: { readonly row: number; readonly column: number };
  readonly target: Candidate;
}

interface Candidate {
  readonly offset: Utf16Offset;
  readonly lineIndex: LineIndex;
  readonly displayCellColumn: CellColumn;
  readonly point: { readonly row: number; readonly column: number };
  readonly cellText: string;
  readonly cellPart: string;
}

interface LineMetrics {
  readonly text: string;
  readonly starts: readonly number[];
  readonly cellToOffset: readonly number[];
}

const Segmenter = (Intl as typeof Intl & {
  readonly Segmenter?: new (locales?: string | readonly string[], options?: { readonly granularity: 'grapheme' }) => {
    segment(input: string): Iterable<{ readonly segment: string; readonly index: number }>;
  };
}).Segmenter;

/**
 * Resolve display-line and viewport row motions against the immutable rows shown by Xi's
 * current layout frame. The returned anchor is a view intent; this function publishes no frame.
 */
export function resolveVimViewportMotion(
  snapshot: DocumentSnapshot,
  frame: VisibleFrame,
  state: VimViewportCursor,
  invocation: VimViewportInvocation,
  options: VimViewportOptions = {},
): { readonly ok: true; readonly value: VimViewportOutcome } | { readonly ok: false; readonly error: VimViewportFailure } {
  const valid = validateContext(snapshot, frame, state, invocation, options);
  if (!valid.ok) return valid;
  if (isScrollKey(invocation.key)) return resolveScroll(snapshot, frame, state, invocation, options);

  const current = locateCursor(snapshot, frame, state.cursor);
  if (current === null) return viewportFailure('cursor-not-visible');
  const count = invocation.count ?? 1;
  let rowIndex = current.point.row;
  let candidate: Candidate | null = null;
  let kind: VimViewportOutcome['kind'] = 'characterwise';
  let preserveScreenColumn = false;

  switch (invocation.key) {
    case 'gj':
    case 'gk': {
      kind = 'linewise';
      preserveScreenColumn = true;
      rowIndex += (invocation.key === 'gj' ? 1 : -1) * count;
      const row = frame.rows[rowIndex];
      if (row === undefined || row.kind === 'filler' || row.kind === 'diff-filler') return viewportFailure('destination-not-visible');
      const desired = state.desiredScreenCellColumn === null
        ? screenColumnFor(frame.rows[current.point.row]!, current.point.column)
        : state.desiredScreenCellColumn as number;
      candidate = nearestByScreenColumn(row, rowIndex, desired, frame.widthCells);
      break;
    }
    case 'g0':
      candidate = firstTextCandidate(frame.rows[rowIndex], rowIndex);
      break;
    case 'g^':
      candidate = firstNonblankCandidate(snapshot, frame.rows[rowIndex], rowIndex);
      break;
    case 'g$': {
      rowIndex += count - 1;
      const row = frame.rows[rowIndex];
      if (row === undefined || row.kind === 'filler' || row.kind === 'diff-filler') return viewportFailure('destination-not-visible');
      candidate = lastTextCandidate(row, rowIndex);
      break;
    }
    case 'gm': {
      const row = frame.rows[rowIndex];
      if (row === undefined) return viewportFailure('destination-not-visible');
      const desired = Math.floor(textWidth(frame, row) / 2);
      candidate = nearestByScreenColumn(row, rowIndex, desired, frame.widthCells);
      break;
    }
    case 'gM': {
      const line = current.target.lineIndex;
      const rows = frame.rows.map((row, index) => ({ row, index })).filter(({ row }) => row.lineIndex === line && row.kind === 'text');
      if (rows.length === 0) return viewportFailure('destination-not-visible');
      const lastRow = rows.at(-1)?.row;
      if (lastRow === undefined || frame.truncatedLongLine) return viewportFailure('destination-not-visible');
      const totalCells = lastRow.displayEndCell;
      const requestedCell = Math.min(totalCells === 0 ? 0 : totalCells - 1, Math.floor(totalCells * (count === 1 && invocation.count === undefined ? 50 : count) / 100));
      const byDisplay = candidateForDisplayCell(rows.map(({ row, index }) => ({ row, index })), line, requestedCell);
      candidate = byDisplay;
      break;
    }
    case 'H':
    case 'M':
    case 'L': {
      kind = 'linewise';
      const height = frame.heightCells;
      const scrolloff = effectiveScrolloff(options.scrolloff ?? 0, height);
      const screenRow = invocation.key === 'H' ? count - 1
        : invocation.key === 'L' ? height - count
          : Math.floor((height - 1) / 2);
      rowIndex = clamp(screenRow, scrolloff, Math.max(scrolloff, height - 1 - scrolloff));
      const row = frame.rows[rowIndex];
      if (row === undefined || row.kind === 'filler' || row.kind === 'diff-filler') return viewportFailure('destination-not-visible');
      const desired = state.cursor.desiredDisplayCellColumn === null
        ? current.target.displayCellColumn as number
        : state.cursor.desiredDisplayCellColumn as number;
      candidate = nearestByDisplayColumn(row, rowIndex, desired);
      break;
    }
  }

  if (candidate === null) return viewportFailure('destination-not-visible');
  const nextScreenColumn = preserveScreenColumn
    ? state.desiredScreenCellColumn ?? (candidate.point.column - contentStartColumn(frame.rows[rowIndex]!)) as CellColumn
    : (candidate.point.column - contentStartColumn(frame.rows[rowIndex]!)) as CellColumn;
  const nextCursor: VimViewportMotionCursor = Object.freeze({
    documentVersion: snapshot.version,
    offset: candidate.offset,
    desiredDisplayCellColumn: candidate.displayCellColumn,
  });
  return {
    ok: true,
    value: Object.freeze({
      cursor: nextCursor,
      desiredScreenCellColumn: nextScreenColumn,
      viewportAnchor: frame.anchor,
      horizontalScrollCells: (frame.rows[0]?.displayStartCell ?? 0) as CellColumn,
      kind,
      moved: (nextCursor.offset as number) !== (state.cursor.offset as number),
      viewportOnly: false,
    }),
  };
}

/** Keep a cursor moved by an ordinary Vim motion inside the visible frame and scrolloff band. */
export function ensureVimCursorVisible(
  snapshot: DocumentSnapshot,
  frame: VisibleFrame,
  cursor: VimViewportMotionCursor,
  options: VimViewportOptions = {},
): { readonly ok: true; readonly value: { readonly viewportAnchor: ViewportAnchor; readonly horizontalScrollCells: CellColumn } } | { readonly ok: false; readonly error: VimViewportFailure } {
  if (frame.identity.documentVersion !== snapshot.version) return viewportFailure('stale-document-version');
  if (frame.identity.documentId !== snapshot.id) return viewportFailure('stale-layout-frame');
  if (cursor.documentVersion !== snapshot.version) return viewportFailure('stale-document-version');
  const scrolloff = options.scrolloff ?? 0;
  const sidescrolloff = options.sidescrolloff ?? 0;
  if (!Number.isSafeInteger(scrolloff) || scrolloff < 0 || !Number.isSafeInteger(sidescrolloff) || sidescrolloff < 0) return viewportFailure('invalid-option');
  const located = locateCursor(snapshot, frame, cursor);
  if (located !== null) {
    const effective = effectiveScrolloff(scrolloff, frame.heightCells);
    if (located.point.row >= effective && located.point.row < frame.heightCells - effective) {
      const row = frame.rows[located.point.row];
      const contentStart = row === undefined ? 0 : contentStartColumn(row);
      const visibleColumn = located.point.column - contentStart;
      const width = Math.max(1, frame.widthCells - contentStart);
      let horizontalScroll = row?.displayStartCell ?? 0;
      if (visibleColumn < sidescrolloff) horizontalScroll = Math.max(0, horizontalScroll + visibleColumn - sidescrolloff);
      else if (visibleColumn >= width - sidescrolloff) horizontalScroll += visibleColumn - (width - 1 - sidescrolloff);
      return { ok: true, value: Object.freeze({ viewportAnchor: frame.anchor, horizontalScrollCells: horizontalScroll as CellColumn }) };
    }
  }
  const line = snapshot.lineIndexAt(cursor.offset);
  if (!line.ok) return viewportFailure('invalid-cursor');
  const effective = effectiveScrolloff(scrolloff, frame.heightCells);
  const visibleRows = frame.rows.map((row, index) => ({ row, index }))
    .filter(({ row }) => row.kind === 'text' && row.lineIndex === line.value);
  if (visibleRows.length > 0) {
    const desiredCell = cursor.desiredDisplayCellColumn ?? 0 as CellColumn;
    const rowEntry = visibleRows.find(({ row }) => (desiredCell as number) >= row.displayStartCell
      && (desiredCell as number) <= row.displayEndCell) ?? visibleRows[0];
    if (rowEntry !== undefined) {
      const contentStart = contentStartColumn(rowEntry.row);
      const visibleWidth = Math.max(1, frame.widthCells - contentStart);
      let horizontal = rowEntry.row.displayStartCell;
      const cell = desiredCell as number;
      if (cell < horizontal + sidescrolloff) horizontal = Math.max(0, cell - sidescrolloff);
      else if (cell >= horizontal + visibleWidth - sidescrolloff) horizontal = Math.max(0, cell - (visibleWidth - 1 - sidescrolloff));
      if (rowEntry.index >= effective && rowEntry.index < frame.heightCells - effective) {
        return { ok: true, value: Object.freeze({ viewportAnchor: frame.anchor, horizontalScrollCells: horizontal as CellColumn }) };
      }
    }
  }
  const preferredRow = located?.point.row ?? Math.floor((frame.heightCells - 1) / 2);
  const targetRow = clamp(preferredRow, effective, Math.max(effective, frame.heightCells - 1 - effective));
  const topLine = Math.max(0, (line.value as number) - targetRow);
  const anchor = anchorForLine(snapshot, topLine, 0, options);
  if (anchor === null) return viewportFailure('document-read-failed');
  return { ok: true, value: Object.freeze({ viewportAnchor: anchor, horizontalScrollCells: frame.rows[0]?.displayStartCell as CellColumn ?? 0 as CellColumn }) };
}

function resolveScroll(
  snapshot: DocumentSnapshot,
  frame: VisibleFrame,
  state: VimViewportCursor,
  invocation: VimViewportInvocation,
  options: VimViewportOptions,
): { readonly ok: true; readonly value: VimViewportOutcome } | { readonly ok: false; readonly error: VimViewportFailure } {
  const located = locateCursor(snapshot, frame, state.cursor);
  if (located === null) return viewportFailure('cursor-not-visible');
  const key = invocation.key as VimViewportScrollKey;
  const count = invocation.count ?? 1;
  const amount = invocation.count ?? ((key === '<C-D>' || key === '<C-U>')
    ? options.scrollAmount ?? Math.max(1, Math.floor(frame.heightCells / 2))
    : 1);
  const page = Math.max(1, frame.heightCells - 2);
  let anchor: ViewportAnchor | null = frame.anchor;
  let cursor: VimViewportMotionCursor = state.cursor;
  let desiredScreenCellColumn = state.desiredScreenCellColumn;
  let kind: VimViewportOutcome['kind'] = 'linewise';
  let viewportOnly = true;

  if (key === 'zt' || key === 'zz' || key === 'zb') {
    const scrolloff = effectiveScrolloff(options.scrolloff ?? 0, frame.heightCells);
    const desiredRow = key === 'zt' ? scrolloff
      : key === 'zb' ? frame.heightCells - 1 - scrolloff
        : clamp(Math.floor((frame.heightCells - 1) / 2), scrolloff, frame.heightCells - 1 - scrolloff);
    anchor = anchorAtRelativeRow(snapshot, frame, located.point.row - desiredRow, options);
  } else if (key === '<C-E>' || key === '<C-Y>') {
    const delta = key === '<C-E>' ? amount : -amount;
    anchor = shiftedAnchor(snapshot, frame, delta, options);
    const nextTop = anchor?.lineIndex as number | undefined;
    const currentTop = frame.anchor.lineIndex as number;
    const currentLine = snapshot.lineIndexAt(cursor.offset);
    if (!currentLine.ok) return viewportFailure('invalid-cursor');
    if (nextTop !== undefined && delta < 0 && located.point.row >= frame.heightCells - 1 && nextTop < currentTop) {
      // CTRL-Y keeps the cursor on the bottom screen row when the viewport
      // is scrolled upward. Move it by the rows that were removed above.
      const targetLine = Math.max(0, (currentLine.value as number) - Math.min(currentTop - nextTop, currentLine.value as number));
      const moved = cursorAtLine(snapshot, targetLine, state, options);
      if (moved === null) return viewportFailure('destination-not-visible');
      cursor = moved.cursor;
      desiredScreenCellColumn = moved.desiredScreenCellColumn;
      viewportOnly = false;
    } else if (nextTop !== undefined && ((currentLine.value as number) < nextTop || (currentLine.value as number) >= nextTop + frame.heightCells)) {
      const row = clamp((currentLine.value as number) - nextTop, 0, frame.heightCells - 1);
      const moved = cursorAtScreenRow(snapshot, frame, currentLine.value as number, row, state, options);
      if (moved === null) return viewportFailure('destination-not-visible');
      cursor = moved.cursor;
      desiredScreenCellColumn = moved.desiredScreenCellColumn;
      viewportOnly = false;
    }
  } else {
    const direction = key === '<C-D>' || key === '<C-F>' ? 1 : -1;
    const lineAmount = key === '<C-D>' || key === '<C-U>' ? amount : page * count;
    const currentTop = frame.anchor.lineIndex as number;
    const targetTop = clamp(currentTop + direction * lineAmount, 0, Math.max(0, snapshot.lineCount - 1));
    // Page motions move the viewport first, then place the cursor at the
    // leading/trailing row of that new page (matching Vim's CTRL-F/CTRL-B).
    // CTRL-D/CTRL-U retain the cursor's logical line and use the requested
    // scroll amount instead.
    const line = snapshot.lineIndexAt(cursor.offset);
    if (!line.ok) return viewportFailure('invalid-cursor');
    const targetLine = key === '<C-F>'
      ? targetTop
      : key === '<C-B>'
        ? clamp(targetTop + frame.heightCells - 1, 0, snapshot.lineCount - 1)
        : clamp((line.value as number) + direction * lineAmount, 0, snapshot.lineCount - 1);
    const metrics = readLineMetrics(snapshot, targetLine, options.tabSize ?? 8, options.widthPolicy ?? defaultCellWidthPolicy());
    if (metrics === null) return viewportFailure('document-read-failed');
    const desiredCell = cursor.desiredDisplayCellColumn === null
      ? displayColumnForOffset(metrics, 0)
      : cursor.desiredDisplayCellColumn as number;
    const nextOffset = offsetAtCell(metrics, desiredCell);
    const start = snapshot.lineStartOffset(targetLine as LineIndex);
    if (!start.ok) return viewportFailure('document-read-failed');
    const nextOffsetAbsolute = ((start.value as number) + nextOffset) as Utf16Offset;
    cursor = Object.freeze({ documentVersion: snapshot.version, offset: nextOffsetAbsolute, desiredDisplayCellColumn: (desiredCell as CellColumn) });
    kind = 'linewise';
    viewportOnly = false;
    const effective = effectiveScrolloff(options.scrolloff ?? 0, frame.heightCells);
    const keepRow = clamp(located.point.row, effective, Math.max(effective, frame.heightCells - 1 - effective));
    const pageAnchorLine = key === '<C-F>' || key === '<C-B>' ? targetTop : targetLine - keepRow;
    anchor = anchorForLine(snapshot, Math.max(0, pageAnchorLine), 0, options);
    if (anchor === null) return viewportFailure('document-read-failed');
  }
  if (anchor === null) return viewportFailure('destination-not-visible');
  return {
    ok: true,
    value: Object.freeze({
      cursor,
      desiredScreenCellColumn,
      viewportAnchor: anchor,
      horizontalScrollCells: (frame.rows[0]?.displayStartCell ?? 0) as CellColumn,
      kind,
      moved: (cursor.offset as number) !== (state.cursor.offset as number) || !sameAnchor(anchor, frame.anchor),
      viewportOnly,
    }),
  };
}

function validateContext(
  snapshot: DocumentSnapshot,
  frame: VisibleFrame,
  state: VimViewportCursor,
  invocation: VimViewportInvocation,
  options: VimViewportOptions,
): { readonly ok: true } | { readonly ok: false; readonly error: VimViewportFailure } {
  if (frame.identity.documentVersion !== snapshot.version || state.cursor.documentVersion !== snapshot.version) return viewportFailure('stale-document-version');
  if (frame.identity.documentId !== snapshot.id) return viewportFailure('stale-layout-frame');
  if (!Number.isSafeInteger(frame.widthCells) || frame.widthCells < 1 || !Number.isSafeInteger(frame.heightCells)
    || frame.heightCells < 1 || frame.rows.length !== frame.heightCells) return viewportFailure('invalid-frame');
  if (!Number.isSafeInteger(state.cursor.offset as number) || (state.cursor.offset as number) < 0
    || (state.cursor.offset as number) > snapshot.lengthUtf16) return viewportFailure('invalid-cursor');
  if (state.desiredScreenCellColumn !== null && (!Number.isSafeInteger(state.desiredScreenCellColumn as number) || (state.desiredScreenCellColumn as number) < 0)) return viewportFailure('invalid-cursor');
  if (invocation.count !== undefined && (!Number.isSafeInteger(invocation.count) || invocation.count < 1)) return viewportFailure('invalid-count');
  for (const value of [options.scrolloff ?? 0, options.sidescrolloff ?? 0, options.scrollAmount ?? 1, options.tabSize ?? 8]) {
    if (!Number.isSafeInteger(value) || value < 0) return viewportFailure('invalid-option');
  }
  if ((options.tabSize ?? 8) < 1 || (options.tabSize ?? 8) > 32
    || (options.scrollAmount !== undefined && options.scrollAmount < 1)) return viewportFailure('invalid-option');
  return { ok: true };
}

function locateCursor(snapshot: DocumentSnapshot, frame: VisibleFrame, cursor: VimViewportMotionCursor): LocatedCursor | null {
  const line = snapshot.lineIndexAt(cursor.offset);
  if (!line.ok) return null;
  for (let rowIndex = 0; rowIndex < frame.rows.length; rowIndex += 1) {
    const row = frame.rows[rowIndex];
    if (row === undefined) continue;
    for (let column = 0; column < row.cells.length; column += 1) {
      const cell = row.cells[column];
      const target = cell?.target;
      if (cell !== undefined && target?.kind === 'text' && target.offset === cursor.offset && target.cellPart !== 'wide-continuation') {
        return { point: { row: rowIndex, column }, target: {
          offset: target.offset,
          lineIndex: target.lineIndex,
          displayCellColumn: target.displayCellColumn,
          point: { row: rowIndex, column },
          cellText: cell.text,
          cellPart: target.cellPart,
        } };
      }
      if (target?.kind === 'fold' && (target.startLine as number) <= (line.value as number)
        && (line.value as number) < (target.endLineExclusive as number)) {
        return { point: { row: rowIndex, column }, target: {
          offset: target.offset,
          lineIndex: target.startLine,
          displayCellColumn: 0 as CellColumn,
          point: { row: rowIndex, column },
          cellText: cell?.text ?? '',
          cellPart: 'fold',
        } };
      }
    }
  }
  return null;
}

function firstTextCandidate(row: ScreenRow | undefined, rowIndex: number): Candidate | null {
  if (row === undefined) return null;
  const candidates = textCandidates(row, rowIndex);
  return candidates[0] ?? null;
}

function lastTextCandidate(row: ScreenRow, rowIndex: number): Candidate | null {
  const candidates = textCandidates(row, rowIndex).filter((candidate) => candidate.cellPart !== 'padding');
  return candidates.at(-1) ?? textCandidates(row, rowIndex)[0] ?? null;
}

function firstNonblankCandidate(snapshot: DocumentSnapshot, row: ScreenRow | undefined, rowIndex: number): Candidate | null {
  if (row === undefined) return null;
  for (const candidate of textCandidates(row, rowIndex)) {
    if (candidate.cellPart === 'padding') continue;
    const char = scalarAt(snapshot, candidate.offset as number);
    if (char !== null && char !== ' ' && char !== '\t') return candidate;
  }
  return textCandidates(row, rowIndex).at(-1) ?? null;
}

function nearestByScreenColumn(row: ScreenRow, rowIndex: number, desired: number, width: number): Candidate | null {
  const candidates = textCandidates(row, rowIndex).filter((candidate) => candidate.cellPart !== 'padding');
  const available = candidates.length > 0 ? candidates : textCandidates(row, rowIndex);
  const contentStart = contentStartColumn(row);
  return nearest(available, (candidate) => candidate.point.column - contentStart, desired, width);
}

function nearestByDisplayColumn(row: ScreenRow, rowIndex: number, desired: number): Candidate | null {
  const candidates = textCandidates(row, rowIndex).filter((candidate) => candidate.cellPart !== 'padding');
  const available = candidates.length > 0 ? candidates : textCandidates(row, rowIndex);
  return nearest(available, (candidate) => candidate.displayCellColumn as number, desired, Number.MAX_SAFE_INTEGER);
}

function candidateForDisplayCell(
  rows: readonly { readonly row: ScreenRow; readonly index: number }[],
  line: LineIndex,
  displayCell: number,
): Candidate | null {
  let nearestCandidate: Candidate | null = null;
  let nearestDistance = Number.MAX_SAFE_INTEGER;
  for (const entry of rows) {
    for (const candidate of textCandidates(entry.row, entry.index)) {
      if (candidate.lineIndex !== line || candidate.cellPart === 'padding') continue;
      const distance = Math.abs((candidate.displayCellColumn as number) - displayCell);
      if (distance < nearestDistance) {
        nearestCandidate = candidate;
        nearestDistance = distance;
      }
    }
  }
  return nearestCandidate;
}

function nearest(
  candidates: readonly Candidate[],
  columnOf: (candidate: Candidate) => number,
  desired: number,
  maxColumn: number,
): Candidate | null {
  let best: Candidate | null = null;
  let bestDistance = Number.MAX_SAFE_INTEGER;
  for (const candidate of candidates) {
    const column = columnOf(candidate);
    if (column < 0 || column > maxColumn) continue;
    const distance = Math.abs(column - desired);
    if (distance < bestDistance || (distance === bestDistance && best !== null && column < columnOf(best))) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function textCandidates(row: ScreenRow, rowIndex: number): Candidate[] {
  if (row.kind === 'fold') {
    const column = row.cells.findIndex((cell) => cell.target?.kind === 'fold');
    const cell = row.cells[column];
    const target = cell?.target;
    return cell !== undefined && target?.kind === 'fold' && row.lineIndex !== null ? [{
      offset: target.offset,
      lineIndex: target.startLine,
      displayCellColumn: 0 as CellColumn,
      point: { row: rowIndex, column: Math.max(0, column) },
      cellText: cell.text,
      cellPart: 'fold',
    }] : [];
  }
  if (row.kind !== 'text') return [];
  const seen = new Set<number>();
  const candidates: Candidate[] = [];
  for (let column = 0; column < row.cells.length; column += 1) {
    const cell = row.cells[column];
    const target = cell?.target;
    if (cell === undefined || target?.kind !== 'text' || target.cellPart === 'wide-continuation') continue;
    const offset = target.offset as number;
    if (seen.has(offset) && target.cellPart !== 'padding') continue;
    seen.add(offset);
    candidates.push({
      offset: target.offset,
      lineIndex: target.lineIndex,
      displayCellColumn: target.displayCellColumn,
      point: { row: rowIndex, column },
      cellText: cell.text,
      cellPart: target.cellPart,
    });
  }
  return candidates;
}

function textWidth(frame: VisibleFrame, row: ScreenRow): number {
  const contentWidth = frame.widthCells - contentStartColumn(row);
  return Math.max(1, contentWidth);
}

function contentStartColumn(row: ScreenRow): number {
  const firstContent = row.cells.findIndex((cell) => cell.role !== 'gutter');
  return firstContent < 0 ? 0 : firstContent;
}

function screenColumnFor(row: ScreenRow, column: number): CellColumn {
  return Math.max(0, column - contentStartColumn(row)) as CellColumn;
}

function anchorAtRelativeRow(
  snapshot: DocumentSnapshot,
  frame: VisibleFrame,
  topRow: number,
  options: VimViewportOptions,
): ViewportAnchor | null {
  if (topRow >= 0 && topRow < frame.rows.length) {
    for (let index = topRow; index < frame.rows.length; index += 1) {
      const anchor = anchorAtRow(frame.rows[index], snapshot.version, options.folds ?? []);
      if (anchor !== null) return anchor;
    }
  }
  if (topRow < 0) return previousAnchor(snapshot, frame, frame.anchor, -topRow, options);
  return nextAnchor(snapshot, frame, topRow - frame.rows.length + 1, options);
}

function shiftedAnchor(snapshot: DocumentSnapshot, frame: VisibleFrame, rows: number, options: VimViewportOptions): ViewportAnchor | null {
  if (rows === 0) return frame.anchor;
  if (rows > 0) return anchorAtRelativeRow(snapshot, frame, rows, options);
  return previousAnchor(snapshot, frame, frame.anchor, -rows, options);
}

function anchorAtRow(row: ScreenRow | undefined, version: DocumentVersion, folds: readonly FoldRegion[]): ViewportAnchor | null {
  if (row === undefined) return null;
  if (row.kind === 'text' && row.lineIndex !== null && row.startOffset !== null) {
    return Object.freeze({ documentVersion: version, lineIndex: row.lineIndex, offset: row.startOffset, displayCellColumn: row.displayStartCell as CellColumn });
  }
  if (row.kind === 'fold') {
    const fold = folds.find((item) => item.startLine === row.lineIndex);
    const target = row.cells.find((cell) => cell.target?.kind === 'fold')?.target;
    if (fold !== undefined && target?.kind === 'fold') return Object.freeze({ documentVersion: version, lineIndex: fold.startLine, offset: target.offset, displayCellColumn: 0 as CellColumn });
  }
  return null;
}

function previousAnchor(
  snapshot: DocumentSnapshot,
  frame: VisibleFrame,
  current: ViewportAnchor,
  rows: number,
  options: VimViewportOptions,
): ViewportAnchor | null {
  if (rows < 1) return current;
  const currentRow = frame.rows.find((row) => row.lineIndex === current.lineIndex);
  const contentWidth = Math.max(1, frame.widthCells - (currentRow === undefined ? 0 : contentStartColumn(currentRow)));
  let line = current.lineIndex as number;
  let column = current.displayCellColumn as number;
  let offset = current.offset as number;
  for (let index = 0; index < rows; index += 1) {
    if (column > 0 && (currentRow?.wrapIndex ?? 0) > 0) {
      column = Math.max(0, column - contentWidth);
      const metrics = readLineMetrics(snapshot, line, options.tabSize ?? 8, options.widthPolicy ?? defaultCellWidthPolicy());
      if (metrics === null) return null;
      offset = offsetAtCell(metrics, column);
      continue;
    }
    if (line <= 0) return current;
    line -= 1;
    const fold = (options.folds ?? []).find((item) => (item.startLine as number) <= line && line < (item.endLineExclusive as number));
    if (fold !== undefined) line = fold.startLine as number;
    column = 0;
    const start = snapshot.lineStartOffset(line as LineIndex);
    if (!start.ok) return null;
    offset = start.value as number;
  }
  return Object.freeze({ documentVersion: snapshot.version, lineIndex: line as LineIndex, offset: offset as Utf16Offset, displayCellColumn: column as CellColumn });
}

function nextAnchor(snapshot: DocumentSnapshot, frame: VisibleFrame, rows: number, options: VimViewportOptions): ViewportAnchor | null {
  let current: ScreenRow | undefined = frame.rows.at(-1);
  if (current === undefined) return null;
  let line = current.lineIndex as number | null;
  let column = current.displayEndCell;
  let offset = current.endOffset as number | null;
  for (let index = 0; index < rows; index += 1) {
    if (current?.kind === 'text' && line !== null && offset !== null) {
      const metrics = readLineMetrics(snapshot, line, options.tabSize ?? 8, options.widthPolicy ?? defaultCellWidthPolicy());
      if (metrics === null) return null;
      if (column < metrics.cellToOffset.length) {
        const lineStart = snapshot.lineStartOffset(line as LineIndex);
        if (!lineStart.ok) return null;
        offset = ((lineStart.value as number) + offsetAtCell(metrics, column)) as number;
        current = undefined;
        continue;
      }
      line += 1;
    } else if (current?.kind === 'fold') {
      const target = current.cells.find((cell) => cell.target?.kind === 'fold')?.target;
      if (target?.kind !== 'fold') return null;
      line = target.endLineExclusive as number;
    } else if (line !== null) {
      line += 1;
    }
    if (line === null || line >= snapshot.lineCount) return null;
    const fold = (options.folds ?? []).find((item) => (item.startLine as number) <= line! && line! < (item.endLineExclusive as number));
    if (fold !== undefined) line = fold.startLine as number;
    const start = snapshot.lineStartOffset(line as LineIndex);
    if (!start.ok) return null;
    offset = start.value as number;
    column = 0;
    current = undefined;
  }
  if (line === null || offset === null) return null;
  return Object.freeze({ documentVersion: snapshot.version, lineIndex: line as LineIndex, offset: offset as Utf16Offset, displayCellColumn: column as CellColumn });
}

function anchorForLine(snapshot: DocumentSnapshot, line: number, column: number, options: VimViewportOptions): ViewportAnchor | null {
  if (line < 0 || line >= snapshot.lineCount) return null;
  const fold = (options.folds ?? []).find((item) => (item.startLine as number) <= line && line < (item.endLineExclusive as number));
  const anchorLine = fold === undefined ? line : fold.startLine as number;
  const start = snapshot.lineStartOffset(anchorLine as LineIndex);
  if (!start.ok) return null;
  const offset = fold === undefined
    ? offsetAtCell(readLineMetrics(snapshot, anchorLine, options.tabSize ?? 8, options.widthPolicy ?? defaultCellWidthPolicy()) ?? { text: '', starts: [], cellToOffset: [] }, column)
    : 0;
  return Object.freeze({
    documentVersion: snapshot.version,
    lineIndex: anchorLine as LineIndex,
    offset: ((start.value as number) + offset) as Utf16Offset,
    displayCellColumn: (fold === undefined ? column : 0) as CellColumn,
  });
}

function cursorAtScreenRow(
  snapshot: DocumentSnapshot,
  frame: VisibleFrame,
  line: number,
  row: number,
  state: VimViewportCursor,
  options: VimViewportOptions,
): { readonly cursor: VimViewportMotionCursor; readonly desiredScreenCellColumn: CellColumn | null } | null {
  const frameRow = frame.rows[row];
  if (frameRow === undefined) return null;
  const desired = state.desiredScreenCellColumn ?? 0;
  const candidate = nearestByScreenColumn(frameRow, row, desired, frame.widthCells);
  if (candidate !== null) return {
    cursor: Object.freeze({ documentVersion: snapshot.version, offset: candidate.offset, desiredDisplayCellColumn: candidate.displayCellColumn }),
    desiredScreenCellColumn: state.desiredScreenCellColumn,
  };
  const metrics = readLineMetrics(snapshot, line, options.tabSize ?? 8, options.widthPolicy ?? defaultCellWidthPolicy());
  if (metrics === null) return null;
  const start = snapshot.lineStartOffset(line as LineIndex);
  if (!start.ok) return null;
  const offset = offsetAtCell(metrics, state.cursor.desiredDisplayCellColumn as number ?? 0);
  return { cursor: Object.freeze({ documentVersion: snapshot.version, offset: ((start.value as number) + offset) as Utf16Offset, desiredDisplayCellColumn: state.cursor.desiredDisplayCellColumn }), desiredScreenCellColumn: state.desiredScreenCellColumn };
}

function cursorAtLine(
  snapshot: DocumentSnapshot,
  line: number,
  state: VimViewportCursor,
  options: VimViewportOptions,
): { readonly cursor: VimViewportMotionCursor; readonly desiredScreenCellColumn: CellColumn | null } | null {
  const metrics = readLineMetrics(snapshot, line, options.tabSize ?? 8, options.widthPolicy ?? defaultCellWidthPolicy());
  if (metrics === null) return null;
  const start = snapshot.lineStartOffset(line as LineIndex);
  if (!start.ok) return null;
  const desired = state.cursor.desiredDisplayCellColumn as number | null;
  const offset = offsetAtCell(metrics, desired ?? 0);
  return {
    cursor: Object.freeze({
      documentVersion: snapshot.version,
      offset: ((start.value as number) + offset) as Utf16Offset,
      desiredDisplayCellColumn: (desired ?? 0) as CellColumn,
    }),
    desiredScreenCellColumn: state.desiredScreenCellColumn,
  };
}

function readLineMetrics(snapshot: DocumentSnapshot, line: number, tabSize: number, widthPolicy: CellWidthPolicy): LineMetrics | null {
  const start = snapshot.lineStartOffset(line as LineIndex);
  if (!start.ok) return null;
  let end = snapshot.lengthUtf16;
  if (line + 1 < snapshot.lineCount) {
    const next = snapshot.lineStartOffset((line + 1) as LineIndex);
    if (!next.ok) return null;
    end = (next.value as number) - 1;
  }
  const content = snapshot.slice(start.value, end as Utf16Offset);
  if (!content.ok) return null;
  const starts: number[] = [];
  const cellToOffset: number[] = [];
  if (Segmenter === undefined) return null;
  let displayCell = 0;
  try {
    for (const segment of new Segmenter('und', { granularity: 'grapheme' }).segment(content.value)) {
      starts.push(segment.index);
      const width = segment.segment === '\t'
        ? tabSize - (displayCell % tabSize)
        : widthPolicy.widthOfCluster(segment.segment);
      if (!Number.isSafeInteger(width) || width < 0 || width > 2) return null;
      const occupied = Math.max(1, width);
      for (let cell = 0; cell < occupied; cell += 1) cellToOffset.push(segment.index);
      displayCell += occupied;
    }
  } catch {
    return null;
  }
  return { text: content.value, starts, cellToOffset };
}

function offsetAtCell(metrics: LineMetrics, cell: number): number {
  if (metrics.starts.length === 0) return 0;
  if (cell >= metrics.cellToOffset.length) return metrics.starts.at(-1) ?? 0;
  if (cell <= 0) return metrics.cellToOffset[0] ?? metrics.starts[0] ?? 0;
  return metrics.cellToOffset[cell] ?? metrics.starts.at(-1) ?? 0;
}

function displayColumnForOffset(metrics: LineMetrics, offset: number): number {
  const index = metrics.cellToOffset.findIndex((value) => value === offset);
  return index < 0 ? Math.max(0, metrics.cellToOffset.length - 1) : index;
}

function scalarAt(snapshot: DocumentSnapshot, offset: number): string | null {
  if (offset < 0 || offset >= snapshot.lengthUtf16) return null;
  const result = snapshot.slice(offset as Utf16Offset, Math.min(snapshot.lengthUtf16, offset + 2) as Utf16Offset);
  if (!result.ok) return null;
  return [...result.value][0] ?? null;
}

function effectiveScrolloff(requested: number, height: number): number {
  return Math.min(requested, Math.floor(Math.max(0, height - 1) / 2));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function sameAnchor(left: ViewportAnchor, right: ViewportAnchor): boolean {
  return left.documentVersion === right.documentVersion && left.lineIndex === right.lineIndex
    && left.offset === right.offset && left.displayCellColumn === right.displayCellColumn;
}

function isScrollKey(key: VimViewportInvocation['key']): key is VimViewportScrollKey {
  return ['zt', 'zz', 'zb', '<C-E>', '<C-Y>', '<C-D>', '<C-U>', '<C-F>', '<C-B>'].includes(key);
}

function viewportFailure<K extends VimViewportFailure['kind']>(kind: K): { readonly ok: false; readonly error: Extract<VimViewportFailure, { readonly kind: K }> } {
  return { ok: false, error: { kind } as Extract<VimViewportFailure, { readonly kind: K }> };
}
