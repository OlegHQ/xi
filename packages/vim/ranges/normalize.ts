import type { DocumentSnapshot, LineIndex, Result, Utf16Offset } from '../../document/src/index';
import { defaultCellWidthPolicy, type CellWidthPolicy } from '../../layout/src/index';

export type VimOperatorRangeKind = 'characterwise' | 'linewise' | 'blockwise';
export type VimOperatorForceKind = 'characterwise' | 'linewise' | 'blockwise';
export type VimOperatorMotionDirection = 'forward' | 'backward';

export interface VimOperatorEndpoint {
  readonly documentVersion: DocumentSnapshot['version'];
  /** Zero-based UTF-16 semantic character start (or an empty-line start). */
  readonly offset: Utf16Offset;
  /** Optional logical terminal cell column, required when a block endpoint is virtual. */
  readonly displayCellColumn?: number;
}

export interface VimOperatorRangeInput {
  readonly origin: VimOperatorEndpoint;
  readonly target: VimOperatorEndpoint;
  readonly direction: VimOperatorMotionDirection;
  readonly motionKind: Exclude<VimOperatorRangeKind, 'blockwise'>;
  readonly inclusive: boolean;
  readonly motionKey: string;
  readonly operator: 'delete' | 'change' | 'yank';
  readonly forceKind?: VimOperatorForceKind;
  /** Visual-mode blocks can select individual tab cells; operator-pending blocks expand a tab edge. */
  readonly blockTabPolicy?: 'expand' | 'preserve';
  /** `dd`/`cc`/`yy` supply the already-multiplied doubled-operator count here. */
  readonly lineCount?: number;
  /**
   * An exclusive forward target landing exactly at column 0 normally keeps
   * the preceding line separator (Neovim's exclusive-motion quirk). A
   * synthesized multi-line range (e.g. `{count}D`) that genuinely wants that
   * whole further line removed, separator included, sets this to skip it.
   */
  readonly consumeTrailingNewline?: boolean;
  readonly tabSize?: number;
  readonly widthPolicy?: CellWidthPolicy;
}

export interface VimOperatorTextRange {
  readonly start: Utf16Offset;
  readonly end: Utf16Offset;
  readonly text: string;
  /** Replacement text for cell-preserving block edits (for example a partial tab). */
  readonly replacementText?: string;
  /** Unselected cells on the left/right block edges, kept apart for row-wise insertion. */
  readonly replacementPrefix?: string;
  readonly replacementSuffix?: string;
  /** Selected display cells, used only when reconstructing a block register. */
  readonly blockText?: string;
}

export interface VimNormalizedOperatorRange {
  readonly kind: VimOperatorRangeKind;
  readonly start: Utf16Offset;
  readonly end: Utf16Offset;
  readonly ranges: readonly VimOperatorTextRange[];
  readonly registerLines: readonly string[];
  readonly registerType: string;
  readonly blockWidth?: number;
  /** A change at a word-start enters Insert at this source-version insertion gap. */
  readonly insertionOffset: Utf16Offset;
}

export type VimOperatorRangeFailure =
  | { readonly kind: 'stale-document-version' }
  | { readonly kind: 'invalid-endpoint' }
  | { readonly kind: 'invalid-count' }
  | { readonly kind: 'invalid-option' }
  | { readonly kind: 'empty-range' }
  | { readonly kind: 'document-read-failed' };

interface LineBounds {
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

interface GraphemePart {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly cellStart: number;
  readonly cellEnd: number;
}

const SEGMENTER = (Intl as typeof Intl & {
  readonly Segmenter?: new (locales?: string | readonly string[], options?: { readonly granularity: 'grapheme' }) => {
    segment(input: string): Iterable<{ readonly segment: string; readonly index: number }>;
  };
}).Segmenter;
const MAX_TAB_SIZE = 1000;
const GRAPHEME_SEGMENTER = SEGMENTER !== undefined ? new SEGMENTER(undefined, { granularity: 'grapheme' }) : undefined;

/**
 * Convert an operator motion into one canonical half-open UTF-16 selection.
 * This is the only module that applies forced kinds, linewise spans, the
 * exclusive next-line column-zero exception, and the `cw` range adjustment.
 */
export function normalizeVimOperatorRange(
  snapshot: DocumentSnapshot,
  input: VimOperatorRangeInput,
): Result<VimNormalizedOperatorRange, VimOperatorRangeFailure> {
  if (input.origin.documentVersion !== snapshot.version || input.target.documentVersion !== snapshot.version) {
    return rangeFailure('stale-document-version');
  }
  if (!validOffset(snapshot, input.origin.offset) || !validOffset(snapshot, input.target.offset)) {
    return rangeFailure('invalid-endpoint');
  }
  const tabSize = input.tabSize ?? 8;
  if (!Number.isSafeInteger(tabSize) || tabSize < 1 || tabSize > MAX_TAB_SIZE) return rangeFailure('invalid-option');
  const widthPolicy = input.widthPolicy ?? defaultCellWidthPolicy();
  if (typeof widthPolicy.id !== 'string' || !Number.isSafeInteger(widthPolicy.generation)
    || typeof widthPolicy.widthOfCluster !== 'function') return rangeFailure('invalid-option');
  if (input.direction !== 'forward' && input.direction !== 'backward') return rangeFailure('invalid-endpoint');
  if (typeof input.inclusive !== 'boolean' || typeof input.motionKey !== 'string') return rangeFailure('invalid-endpoint');

  const kind = input.forceKind ?? input.motionKind;
  if (kind === 'linewise') return normalizeLinewise(snapshot, input);
  if (kind === 'blockwise') return normalizeBlockwise(snapshot, input, tabSize, widthPolicy);
  if (kind !== 'characterwise') return rangeFailure('invalid-endpoint');
  return normalizeCharacterwise(snapshot, input);
}

function normalizeCharacterwise(
  snapshot: DocumentSnapshot,
  input: VimOperatorRangeInput,
): Result<VimNormalizedOperatorRange, VimOperatorRangeFailure> {
  const origin = input.origin.offset as number;
  const target = input.target.offset as number;
  let start = Math.min(origin, target);
  let end = Math.max(origin, target);
  const forward = input.direction === 'forward';
  if (input.inclusive) {
    const included = forward ? target : origin;
    const next = nextGraphemeBoundary(snapshot, included);
    if (!next.ok) return next;
    end = Math.max(end, next.value);
  }

  // Neovim's exclusive forward range ending at column zero does not consume
  // the preceding line separator.  The post-motion cursor stays on that row.
  if (forward && !input.inclusive && target > origin && input.consumeTrailingNewline !== true) {
    const targetLine = lineBoundsAt(snapshot, asOffset(target));
    if (!targetLine.ok) return targetLine;
    if (target === targetLine.value.start && targetLine.value.index > 0) {
      end = Math.max(start, target - 1);
      // :help exclusive-linewise rule 2: if the start was at or before the
      // first non-blank of its line, the motion becomes linewise (not just
      // an adjusted charwise end), pulling in leading blanks too.
      // nvim: :call setline(1,['foo','','bar']) | normal! d} -> deletes line 1 linewise, leaving ['', 'bar']
      // Word motions ('w'/'W') never reach this upgrade: :help word's earlier
      // special case ("the end of that word becomes the end of the operated
      // text, not the first word in the next line") already fixes the end at
      // the previous line, so the linewise check never sees column 0 there.
      // nvim: printf 'first\nsecond tail\n' | nvim --headless --clean -u NONE -
      //   -c 'call cursor(1,1)' -c 'normal! dw' -c '%p' -c 'q!' -> '', 'second tail'
      if (input.motionKey !== 'w' && input.motionKey !== 'W') {
        const startLine = lineBoundsAt(snapshot, asOffset(start));
        if (!startLine.ok) return startLine;
        const firstNonBlank = firstNonBlankOffset(snapshot, startLine.value);
        if (!firstNonBlank.ok) return firstNonBlank;
        if (start <= firstNonBlank.value) {
          const endLine = lineBoundsAt(snapshot, asOffset(end));
          if (!endLine.ok) return endLine;
          return buildLinewiseRange(snapshot, input, startLine.value.index, endLine.value.index);
        }
      }
    }
  }

  // In Change mode, cw/cW stop at the end of the current word rather than
  // consuming the whitespace reached by the corresponding forward motion.
  // The oracle fixture set pins this contextual behavior, including counts.
  if (input.operator === 'change' && forward && (input.motionKey === 'w' || input.motionKey === 'W')
    && isNonblankAt(snapshot, origin)) {
    while (end > start) {
      const previous = previousGrapheme(snapshot, end);
      if (!previous.ok) return previous;
      if (previous.value === null || !/^\s+$/u.test(previous.value.text)) break;
      end = previous.value.start;
    }
  }

  // `l` is normally clamped at end-of-line in Normal mode, but Vim allows it
  // to reach one past the last character when driving an operator, so `dl`
  // on the last character of a line still deletes that character.
  if (start === end && input.motionKey === 'l') {
    const extended = nextGraphemeBoundary(snapshot, end);
    if (!extended.ok) return extended;
    end = extended.value;
  }
  if (start === end) return rangeFailure('empty-range');
  const range = readTextRange(snapshot, start, end);
  if (!range.ok) return range;
  const lines = registerLines(range.value.text);
  return {
    ok: true,
    value: Object.freeze({
      kind: 'characterwise',
      start: asOffset(start),
      end: asOffset(end),
      ranges: Object.freeze([range.value]),
      registerLines: Object.freeze(lines),
      registerType: 'v',
      insertionOffset: asOffset(start),
    }),
  };
}

function normalizeLinewise(
  snapshot: DocumentSnapshot,
  input: VimOperatorRangeInput,
): Result<VimNormalizedOperatorRange, VimOperatorRangeFailure> {
  const count = input.lineCount ?? 1;
  if (!Number.isSafeInteger(count) || count < 1) return rangeFailure('invalid-count');
  const originLine = lineBoundsAt(snapshot, input.origin.offset);
  const targetLine = lineBoundsAt(snapshot, input.target.offset);
  if (!originLine.ok) return originLine;
  if (!targetLine.ok) return targetLine;
  const first = Math.min(originLine.value.index, targetLine.value.index);
  const last = Math.max(originLine.value.index, targetLine.value.index, first + count - 1);
  return buildLinewiseRange(snapshot, input, first, last);
}

function firstNonBlankOffset(snapshot: DocumentSnapshot, line: LineBounds): Result<number, VimOperatorRangeFailure> {
  const text = readText(snapshot, line.start, line.end);
  if (!text.ok) return text;
  const match = /[^\t ]/u.exec(text.value);
  return { ok: true, value: match ? line.start + match.index : line.end };
}

function buildLinewiseRange(
  snapshot: DocumentSnapshot,
  input: VimOperatorRangeInput,
  first: number,
  last: number,
): Result<VimNormalizedOperatorRange, VimOperatorRangeFailure> {
  const firstStart = lineStart(snapshot, first);
  if (!firstStart.ok) return firstStart;
  const afterLine = lineStart(snapshot, last + 1);
  const end = afterLine.ok ? afterLine.value : snapshot.lengthUtf16;
  let start = firstStart.value;
  let adjustedEnd = end;
  if (start === adjustedEnd) {
    // Deleting the empty final Vim line removes its preceding separator while
    // retaining the buffer's final-EOL marker at the document layer.
    if (start > 0) start -= 1;
  }
  if (start === adjustedEnd) return rangeFailure('empty-range');
  const range = readTextRange(snapshot, start, adjustedEnd);
  if (!range.ok) return range;
  const content = range.value.text;
  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const normalizedLines = lines.length === 0 ? [''] : lines;
  let insertionOffset = start;
  if (input.operator === 'change') {
    const firstBounds = readLineBounds(snapshot, first);
    if (!firstBounds.ok) return firstBounds;
    const firstContent = readText(snapshot, firstBounds.value.start, firstBounds.value.end);
    if (!firstContent.ok) return firstContent;
    const indentLength = /^[\t ]*/u.exec(firstContent.value)?.[0].length ?? 0;
    insertionOffset = firstBounds.value.start + indentLength;
  }
  return {
    ok: true,
    value: Object.freeze({
      kind: 'linewise',
      start: asOffset(start),
      end: asOffset(adjustedEnd),
      ranges: Object.freeze([range.value]),
      registerLines: Object.freeze(normalizedLines),
      registerType: 'V',
      insertionOffset: asOffset(insertionOffset),
    }),
  };
}

function normalizeBlockwise(
  snapshot: DocumentSnapshot,
  input: VimOperatorRangeInput,
  tabSize: number,
  widthPolicy: CellWidthPolicy,
): Result<VimNormalizedOperatorRange, VimOperatorRangeFailure> {
  const originLine = lineBoundsAt(snapshot, input.origin.offset);
  const targetLine = lineBoundsAt(snapshot, input.target.offset);
  if (!originLine.ok) return originLine;
  if (!targetLine.ok) return targetLine;
  const originColumn = input.origin.displayCellColumn;
  const targetColumn = input.target.displayCellColumn;
  if (originColumn === undefined || targetColumn === undefined
    || !Number.isSafeInteger(originColumn) || !Number.isSafeInteger(targetColumn)
    || originColumn < 0 || targetColumn < 0) return rangeFailure('invalid-endpoint');
  const left = Math.min(originColumn, targetColumn);
  const right = Math.max(originColumn, targetColumn);
  const height = Math.abs(targetLine.value.index - originLine.value.index) + 1;
  const blockLines: { readonly line: LineBounds; readonly parts: readonly GraphemePart[] }[] = [];
  let expandedLeft = left;
  let expandedRight = right;
  const expandTabEdges = input.blockTabPolicy !== 'preserve';
  for (let step = 0; step < height; step += 1) {
    const lineIndex = Math.min(originLine.value.index, targetLine.value.index) + step;
    const line = readLineBounds(snapshot, lineIndex);
    if (!line.ok) return line;
    const parts = graphemeParts(snapshot, line.value, tabSize, widthPolicy);
    if (!parts.ok) return parts;
    blockLines.push({ line: line.value, parts: parts.value });
    for (const part of parts.value) {
      const overlaps = Math.max(left, part.cellStart) < Math.min(right + 1, part.cellEnd);
      // A wide grapheme cannot be split, but a tab is a run of virtual cells
      // whose unselected prefix/suffix can be preserved as spaces by the edit.
      if (overlaps && (part.text !== '\t' || expandTabEdges) && part.cellEnd - part.cellStart > 1) {
        expandedLeft = Math.min(expandedLeft, part.cellStart);
        expandedRight = Math.max(expandedRight, part.cellEnd - 1);
      }
    }
  }
  const lines: string[] = [];
  const ranges: VimOperatorTextRange[] = [];
  const blockWidth = expandedRight - expandedLeft + 1;
  for (const row of blockLines) {
    const selectedParts: string[] = [];
    let selectedCellCount = 0;
    let editStart: number | null = null;
    let editEnd: number | null = null;
    let replacementPrefixCells = 0;
    let replacementSuffixCells = 0;
    for (const part of row.parts) {
      const overlapStart = Math.max(expandedLeft, part.cellStart);
      const overlapEnd = Math.min(expandedRight + 1, part.cellEnd);
      if (overlapStart >= overlapEnd) continue;
      const selectedCells = overlapEnd - overlapStart;
      selectedCellCount += selectedCells;
      selectedParts.push(part.text === '\t'
        ? selectedCells === part.cellEnd - part.cellStart ? '\t' : ' '.repeat(selectedCells)
        : part.text);
      editStart = editStart === null ? part.start : Math.min(editStart, part.start);
      editEnd = part.end;
      if (part.text === '\t') {
        const prefix = Math.max(0, overlapStart - part.cellStart);
        const suffix = Math.max(0, part.cellEnd - overlapEnd);
        replacementPrefixCells += prefix;
        replacementSuffixCells += suffix;
      }
    }
    const selected = selectedParts.join('');
    const replacementPrefix = ' '.repeat(replacementPrefixCells);
    const replacementSuffix = ' '.repeat(replacementSuffixCells);
    const start = editStart ?? row.line.end;
    const end = editEnd ?? row.line.end;
    // Vim pads a block register row when the selected rectangle contains no
    // source cells on that row. When some real cells were captured it keeps
    // the shorter payload; the register type carries the rectangle width.
    // Padding affects only the register, never the edit ranges.
    lines.push(selectedCellCount === 0 ? ' '.repeat(blockWidth) : selected);
    if (start !== end || replacementPrefix.length > 0 || replacementSuffix.length > 0) {
      ranges.push(Object.freeze({
        start: asOffset(start), end: asOffset(end), text: selected, blockText: selected,
        ...(replacementPrefix.length + replacementSuffix.length === 0 ? {} : {
          replacementText: replacementPrefix + replacementSuffix,
          ...(replacementPrefix.length === 0 ? {} : { replacementPrefix }),
          ...(replacementSuffix.length === 0 ? {} : { replacementSuffix }),
        }),
      }));
    }
  }
  if (ranges.length === 0) return rangeFailure('empty-range');
  const firstRange = ranges[0];
  const lastRange = ranges[ranges.length - 1];
  if (firstRange === undefined || lastRange === undefined) return rangeFailure('empty-range');
  return {
    ok: true,
    value: Object.freeze({
      kind: 'blockwise',
      start: firstRange.start,
      end: lastRange.end,
      ranges: Object.freeze(ranges),
      registerLines: Object.freeze(lines),
      registerType: `\x16${expandedRight - expandedLeft + 1}`,
      blockWidth,
      insertionOffset: firstRange.start,
    }),
  };
}

function readLineBounds(snapshot: DocumentSnapshot, index: number): Result<LineBounds, VimOperatorRangeFailure> {
  if (!Number.isSafeInteger(index) || index < 0 || index >= snapshot.lineCount) return rangeFailure('invalid-endpoint');
  const start = lineStart(snapshot, index);
  if (!start.ok) return start;
  const next = index + 1 < snapshot.lineCount ? lineStart(snapshot, index + 1) : null;
  if (next !== null && !next.ok) return next;
  const nextStart = next?.ok === true ? next.value : snapshot.lengthUtf16;
  let end = next === null ? snapshot.lengthUtf16 : Math.max(start.value, nextStart - 1);
  if (next === null && end > start.value) {
    const final = readText(snapshot, end - 1, end);
    if (!final.ok) return final;
    if (final.value === '\n') end -= 1;
  }
  return { ok: true, value: { index, start: start.value, end } };
}

function lineBoundsAt(snapshot: DocumentSnapshot, offset: Utf16Offset): Result<LineBounds, VimOperatorRangeFailure> {
  const line = snapshot.lineIndexAt(offset);
  if (!line.ok) return rangeFailure('invalid-endpoint');
  return readLineBounds(snapshot, line.value as number);
}

function lineStart(snapshot: DocumentSnapshot, index: number): Result<number, VimOperatorRangeFailure> {
  if (!Number.isSafeInteger(index) || index < 0 || index >= snapshot.lineCount) return rangeFailure('invalid-endpoint');
  const start = snapshot.lineStartOffset(index as LineIndex);
  return start.ok ? { ok: true, value: start.value as number } : rangeFailure('document-read-failed');
}

function readTextRange(snapshot: DocumentSnapshot, start: number, end: number): Result<VimOperatorTextRange, VimOperatorRangeFailure> {
  const text = readText(snapshot, start, end);
  if (!text.ok) return text;
  return { ok: true, value: Object.freeze({ start: asOffset(start), end: asOffset(end), text: text.value }) };
}

function readText(snapshot: DocumentSnapshot, start: number, end: number): Result<string, VimOperatorRangeFailure> {
  const safeStart = asOffsetResult(start);
  const safeEnd = asOffsetResult(end);
  if (!safeStart.ok || !safeEnd.ok) return rangeFailure('invalid-endpoint');
  const text = snapshot.slice(safeStart.value, safeEnd.value);
  return text.ok ? { ok: true, value: text.value } : rangeFailure('document-read-failed');
}

/** Base window size (UTF-16 units) for the bounded grapheme scans below; doubles toward the line bounds. */
const GRAPHEME_WINDOW_BASE = 64;

/**
 * Boundary one grapheme after `offset`. Reads only a small window instead of
 * the rest of the (possibly huge) line: a single grapheme is confirmed once a
 * second one is visible after it in the window, or the window reaches the
 * true line end, matching the doubling pattern in motions/index.ts.
 */
function nextGraphemeBoundary(snapshot: DocumentSnapshot, offset: number): Result<number, VimOperatorRangeFailure> {
  const bounds = lineBoundsAt(snapshot, asOffset(offset));
  if (!bounds.ok) return bounds;
  if (offset >= bounds.value.end) return { ok: true, value: offset };
  let window = GRAPHEME_WINDOW_BASE;
  for (;;) {
    const windowEnd = Math.min(bounds.value.end, offset + window);
    const text = readText(snapshot, offset, windowEnd);
    if (!text.ok) return text;
    let first: { readonly segment: string; readonly index: number } | undefined;
    let second: { readonly segment: string; readonly index: number } | undefined;
    for (const part of graphemes(text.value)) {
      if (first === undefined) { first = part; continue; }
      second = part;
      break;
    }
    if (first === undefined) return { ok: true, value: offset };
    if (second !== undefined || windowEnd >= bounds.value.end) return { ok: true, value: offset + first.segment.length };
    window *= 2;
  }
}

/**
 * The grapheme immediately before `offset`. Mirrors `nextGraphemeBoundary`:
 * the last cluster found is trusted once there is another one before it
 * within the window, or the window reaches the true line start.
 */
function previousGrapheme(snapshot: DocumentSnapshot, offset: number): Result<{ readonly start: number; readonly text: string } | null, VimOperatorRangeFailure> {
  if (offset <= 0) return { ok: true, value: null };
  const bounds = lineBoundsAt(snapshot, asOffset(offset));
  if (!bounds.ok) return bounds;
  if (offset > bounds.value.end) return rangeFailure('invalid-endpoint');
  let window = GRAPHEME_WINDOW_BASE;
  for (;;) {
    const windowStart = Math.max(bounds.value.start, offset - window);
    const text = readText(snapshot, windowStart, offset);
    if (!text.ok) return text;
    let previous: { readonly segment: string; readonly index: number } | undefined;
    let last: { readonly segment: string; readonly index: number } | undefined;
    for (const part of graphemes(text.value)) { previous = last; last = part; }
    if (last === undefined) return { ok: true, value: null };
    if (previous !== undefined || windowStart <= bounds.value.start) {
      return { ok: true, value: { start: windowStart + last.index, text: last.segment } };
    }
    window *= 2;
  }
}

function isNonblankAt(snapshot: DocumentSnapshot, offset: number): boolean {
  const next = nextGraphemeBoundary(snapshot, offset);
  if (!next.ok || next.value <= offset) return false;
  const text = readText(snapshot, offset, next.value);
  return text.ok && !/^\s+$/u.test(text.value);
}

function graphemeParts(
  snapshot: DocumentSnapshot,
  line: LineBounds,
  tabSize: number,
  widthPolicy: CellWidthPolicy,
): Result<readonly GraphemePart[], VimOperatorRangeFailure> {
  const text = readText(snapshot, line.start, line.end);
  if (!text.ok) return text;
  const result: GraphemePart[] = [];
  let cell = 0;
  for (const part of graphemes(text.value)) {
    let width: number;
    if (part.segment === '\t') {
      width = tabSize - (cell % tabSize);
    } else {
      try {
        width = Math.max(1, Math.trunc(widthPolicy.widthOfCluster(part.segment)));
      } catch {
        return rangeFailure('invalid-option');
      }
    }
    if (!Number.isSafeInteger(width) || width < 1) return rangeFailure('invalid-option');
    result.push(Object.freeze({
      start: line.start + part.index,
      end: line.start + part.index + part.segment.length,
      text: part.segment,
      cellStart: cell,
      cellEnd: cell + width,
    }));
    cell += width;
  }
  return { ok: true, value: Object.freeze(result) };
}

function* graphemes(text: string): Iterable<{ readonly segment: string; readonly index: number }> {
  if (GRAPHEME_SEGMENTER !== undefined) {
    for (const part of GRAPHEME_SEGMENTER.segment(text)) yield part;
    return;
  }
  let index = 0;
  for (const scalar of text) {
    yield { segment: scalar, index };
    index += scalar.length;
  }
}

function registerLines(text: string): string[] {
  return text.split('\n');
}

function validOffset(snapshot: DocumentSnapshot, offset: Utf16Offset): boolean {
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > snapshot.lengthUtf16) return false;
  const result = snapshot.slice(offset, offset);
  return result.ok;
}

function asOffset(value: number): Utf16Offset { return value as Utf16Offset; }
function asOffsetResult(value: number): Result<Utf16Offset, VimOperatorRangeFailure> {
  return Number.isSafeInteger(value) && value >= 0 ? { ok: true, value: asOffset(value) } : rangeFailure('invalid-endpoint');
}
function rangeFailure(kind: VimOperatorRangeFailure['kind']): Result<never, VimOperatorRangeFailure> {
  return { ok: false, error: { kind } };
}
