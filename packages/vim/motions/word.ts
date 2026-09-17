import type {
  CellColumn,
  DocumentSnapshot,
  DocumentVersion,
  LineIndex,
  Result,
  Utf16Offset,
} from '../../document/src/index.ts';
import { defaultCellWidthPolicy, type CellWidthPolicy } from '../../layout/src/index';

export type VimWordMotionKey = 'w' | 'W' | 'b' | 'B' | 'e' | 'E' | 'ge' | 'gE';

export interface VimWordMotionCursor {
  readonly documentVersion: DocumentVersion;
  readonly offset: Utf16Offset;
  readonly desiredDisplayCellColumn: CellColumn | null;
}

export interface VimWordMotionInvocation {
  readonly key: VimWordMotionKey;
  readonly count?: number;
}

export interface VimWordMotionOptions {
  /** Current buffer-local Neovim `iskeyword` value; defaults to `@,48-57,_,192-255`. */
  readonly isKeyword?: string;
  readonly tabSize?: number;
  readonly widthPolicy?: CellWidthPolicy;
}

export interface VimWordMotionOutcome {
  readonly cursor: VimWordMotionCursor;
  readonly kind: 'characterwise';
  readonly moved: boolean;
}

export type VimWordMotionFailure =
  | { readonly kind: 'stale-document-version' }
  | { readonly kind: 'invalid-cursor' }
  | { readonly kind: 'invalid-count' }
  | { readonly kind: 'invalid-option' }
  | { readonly kind: 'invalid-width-policy' }
  | { readonly kind: 'document-read-failed' };

interface LineBounds {
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

type WordUnit =
  | {
    readonly kind: 'text';
    readonly line: LineBounds;
    readonly start: number;
    readonly end: number;
    readonly wordClass: string;
  }
  | {
    readonly kind: 'empty';
    readonly line: LineBounds;
    readonly start: number;
    readonly end: number;
    readonly wordClass: 'empty';
  }
  | {
    readonly kind: 'newline';
    readonly line: LineBounds;
    readonly start: number;
    readonly end: number;
    readonly wordClass: 'blank';
  };

interface KeywordRule {
  readonly include: boolean;
  readonly kind: 'alpha' | 'range';
  readonly start: number;
  readonly end: number;
}

interface KeywordClasses {
  readonly rules: readonly KeywordRule[];
}

interface ResolvedWordOptions {
  readonly keywordValue: string;
  readonly tabSize: number;
  readonly widthPolicy: CellWidthPolicy;
  readonly keywords: KeywordClasses;
}

interface GraphemeWindowCacheEntry {
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly clusters: readonly { readonly start: number; readonly end: number; readonly text: string }[];
}

interface WordContext {
  readonly snapshot: DocumentSnapshot;
  readonly options: ResolvedWordOptions;
  readonly lineCache: Map<number, LineBounds>;
  readonly unitCache: Map<string, WordUnit>;
  /** Cache for `readGraphemeBefore`'s bounded backward scan, keyed by line index. */
  readonly graphemeWindowCache: Map<number, GraphemeWindowCacheEntry>;
}

interface GraphemeAt {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const DEFAULT_ISKEYWORD = '@,48-57,_,192-255';
const MAX_TAB_SIZE = 1000;
const GRAPHEME_SEGMENTER = (Intl as typeof Intl & {
  readonly Segmenter?: new (locales?: string | readonly string[], options?: { readonly granularity: 'grapheme' }) => {
    segment(input: string): Iterable<{ readonly segment: string; readonly index: number }>;
  };
}).Segmenter;
/** One reusable instance instead of constructing a new `Intl.Segmenter` on every call. */
const GRAPHEME_SEGMENTER_INSTANCE = GRAPHEME_SEGMENTER === undefined ? undefined : new GRAPHEME_SEGMENTER('und', { granularity: 'grapheme' });
const UNICODE_LETTER = /^\p{L}$/u;
const UNICODE_NUMBER = /^\p{N}$/u;
const UNICODE_EMOJI = /\p{Extended_Pictographic}/u;

/**
 * Resolve one Vim word/WORD motion against a versioned document snapshot. The scanner lazily
 * reads only the line/ranges crossed by the requested motion; it never flattens the document.
 */
export function resolveVimWordMotion(
  snapshot: DocumentSnapshot,
  cursor: VimWordMotionCursor,
  invocation: VimWordMotionInvocation,
  options: VimWordMotionOptions = {},
): Result<VimWordMotionOutcome, VimWordMotionFailure> {
  if (cursor.documentVersion !== snapshot.version) return wordFailure('stale-document-version');
  if (!Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 0
    || (cursor.offset as number) > snapshot.lengthUtf16
    || (cursor.desiredDisplayCellColumn !== null
      && (!Number.isSafeInteger(cursor.desiredDisplayCellColumn) || (cursor.desiredDisplayCellColumn as number) < 0))) {
    return wordFailure('invalid-cursor');
  }
  const count = invocation.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1) return wordFailure('invalid-count');
  const resolvedOptions = resolveWordOptions(options);
  if (!resolvedOptions.ok) return resolvedOptions;

  const lineAtCursor = snapshot.lineIndexAt(cursor.offset);
  if (!lineAtCursor.ok) return wordFailure('invalid-cursor');
  const lineIndex = lineAtCursor.value as number;
  const lineResult = readLineBounds(snapshot, lineIndex);
  if (!lineResult.ok) return lineResult;
  const line = lineResult.value;
  const offset = cursor.offset as number;
  if (offset < line.start || offset > line.end || (line.end > line.start && offset === line.end)) {
    return wordFailure('invalid-cursor');
  }
  if (line.end > line.start) {
    const validCursor = isGraphemeStart(snapshot, line, offset);
    if (!validCursor.ok) return validCursor;
    if (!validCursor.value) return wordFailure('invalid-cursor');
  }

  const context: WordContext = {
    snapshot,
    options: resolvedOptions.value,
    graphemeWindowCache: new Map(),
    lineCache: new Map([[line.index, line]]),
    unitCache: new Map(),
  };
  const current = unitAt(context, line, offset);
  if (!current.ok) return current;

  let target = current.value;
  for (let step = 0; step < count; step += 1) {
    const next = stepWord(context, target, invocation.key);
    if (!next.ok) return next;
    if (next.value.start === target.start && next.value.line.index === target.line.index
      && next.value.kind === target.kind) break;
    target = next.value;
  }

  const targetOffset = target.start;
  const desiredColumn = displayColumnForTarget(context, cursor, line, target);
  if (!desiredColumn.ok) return desiredColumn;
  const moved = targetOffset !== offset || desiredColumn.value !== (cursor.desiredDisplayCellColumn as number | null);
  return {
    ok: true,
    value: {
      cursor: Object.freeze({
        documentVersion: snapshot.version,
        offset: targetOffset as Utf16Offset,
        desiredDisplayCellColumn: desiredColumn.value as CellColumn,
      }),
      kind: 'characterwise',
      moved,
    },
  };
}

function stepWord(
  context: WordContext,
  current: WordUnit,
  key: VimWordMotionKey,
): Result<WordUnit, VimWordMotionFailure> {
  if (key === 'w' || key === 'W') return forwardStart(context, current, key === 'W');
  if (key === 'e' || key === 'E') return forwardEnd(context, current, key === 'E');
  if (key === 'b' || key === 'B') return backwardStart(context, current, key === 'B');
  return backwardEnd(context, current, key === 'gE');
}

function forwardStart(
  context: WordContext,
  origin: WordUnit,
  bigWord: boolean,
): Result<WordUnit, VimWordMotionFailure> {
  const originIsBlank = isBlank(origin);
  let lastInCurrentWord = origin;
  let probe = nextUnit(context, origin);
  if (!probe.ok) return probe;

  if (!originIsBlank) {
    while (probe.value !== null && !isBlank(probe.value) && sameWordClass(origin, probe.value, bigWord)) {
      lastInCurrentWord = probe.value;
      probe = nextUnit(context, probe.value);
      if (!probe.ok) return probe;
    }
  }

  let candidate = probe.value;
  while (candidate !== null && isBlank(candidate)) {
    const following = nextUnit(context, candidate);
    if (!following.ok) return following;
    candidate = following.value;
  }
  if (candidate !== null) return { ok: true, value: candidate };
  return { ok: true, value: originIsBlank ? origin : lastInCurrentWord };
}

function forwardEnd(
  context: WordContext,
  origin: WordUnit,
  bigWord: boolean,
): Result<WordUnit, VimWordMotionFailure> {
  let candidate = origin;
  if (isBlank(candidate)) {
    const nextWord = nextNonblank(context, candidate);
    if (!nextWord.ok) return nextWord;
    if (nextWord.value === null) return { ok: true, value: origin };
    candidate = nextWord.value;
  } else {
    const after = nextUnit(context, candidate);
    if (!after.ok) return after;
    if (after.value === null || isBlank(after.value) || !sameWordClass(candidate, after.value, bigWord)) {
      const nextWord = after.value === null
        ? { ok: true as const, value: null }
        : isBlank(after.value)
          ? nextNonblank(context, after.value)
          : { ok: true as const, value: after.value };
      if (!nextWord.ok) return nextWord;
      if (nextWord.value === null) return lastInClass(context, candidate, bigWord);
      candidate = nextWord.value;
    }
  }
  return lastInClass(context, candidate, bigWord);
}

function lastInClass(
  context: WordContext,
  origin: WordUnit,
  bigWord: boolean,
): Result<WordUnit, VimWordMotionFailure> {
  let last = origin;
  let probe = nextUnit(context, origin);
  if (!probe.ok) return probe;
  while (probe.value !== null && !isBlank(probe.value) && sameWordClass(origin, probe.value, bigWord)) {
    last = probe.value;
    probe = nextUnit(context, probe.value);
    if (!probe.ok) return probe;
  }
  return { ok: true, value: last };
}

function backwardStart(
  context: WordContext,
  origin: WordUnit,
  bigWord: boolean,
): Result<WordUnit, VimWordMotionFailure> {
  const previous = previousUnit(context, origin);
  if (!previous.ok) return previous;
  if (!isBlank(origin) && previous.value !== null && !isBlank(previous.value)
    && sameWordClass(origin, previous.value, bigWord)) {
    return firstInClass(context, origin, bigWord);
  }
  let candidate = previous.value;
  while (candidate !== null && isBlank(candidate)) {
    const earlier = previousUnit(context, candidate);
    if (!earlier.ok) return earlier;
    candidate = earlier.value;
  }
  if (candidate === null) return { ok: true, value: origin };
  return firstInClass(context, candidate, bigWord);
}

function firstInClass(
  context: WordContext,
  origin: WordUnit,
  bigWord: boolean,
): Result<WordUnit, VimWordMotionFailure> {
  let first = origin;
  let probe = previousUnit(context, origin);
  if (!probe.ok) return probe;
  while (probe.value !== null && !isBlank(probe.value) && sameWordClass(origin, probe.value, bigWord)) {
    first = probe.value;
    probe = previousUnit(context, probe.value);
    if (!probe.ok) return probe;
  }
  return { ok: true, value: first };
}

function backwardEnd(
  context: WordContext,
  origin: WordUnit,
  bigWord: boolean,
): Result<WordUnit, VimWordMotionFailure> {
  let probe = previousUnit(context, origin);
  if (!probe.ok) return probe;
  if (!isBlank(origin)) {
    while (probe.value !== null && !isBlank(probe.value) && sameWordClass(origin, probe.value, bigWord)) {
      probe = previousUnit(context, probe.value);
      if (!probe.ok) return probe;
    }
  }
  while (probe.value !== null && isBlank(probe.value)) {
    probe = previousUnit(context, probe.value);
    if (!probe.ok) return probe;
  }
  return { ok: true, value: probe.value ?? origin };
}

function nextNonblank(
  context: WordContext,
  origin: WordUnit,
): Result<WordUnit | null, VimWordMotionFailure> {
  let probe = nextUnit(context, origin);
  if (!probe.ok) return probe;
  while (probe.value !== null && isBlank(probe.value)) {
    probe = nextUnit(context, probe.value);
    if (!probe.ok) return probe;
  }
  return probe;
}

function nextUnit(context: WordContext, current: WordUnit): Result<WordUnit | null, VimWordMotionFailure> {
  if (current.kind === 'newline') {
    const followingLine = current.line.index + 1;
    if (followingLine >= context.snapshot.lineCount) return { ok: true, value: null };
    const bounds = getLineBounds(context, followingLine);
    if (!bounds.ok) return bounds;
    return firstUnit(context, bounds.value);
  }
  if (current.kind === 'empty') {
    if (current.line.index + 1 >= context.snapshot.lineCount) return { ok: true, value: null };
    return newlineUnit(context, current.line);
  }
  if (current.end < current.line.end) return unitAt(context, current.line, current.end);
  if (current.line.index + 1 >= context.snapshot.lineCount) return { ok: true, value: null };
  return newlineUnit(context, current.line);
}

function previousUnit(context: WordContext, current: WordUnit): Result<WordUnit | null, VimWordMotionFailure> {
  if (current.kind === 'newline') {
    const prior = current.line;
    return lastUnit(context, prior);
  }
  if (current.kind === 'empty') {
    if (current.line.index === 0) return { ok: true, value: null };
    const priorLine = getLineBounds(context, current.line.index - 1);
    if (!priorLine.ok) return priorLine;
    return newlineUnit(context, priorLine.value);
  }
  if (current.start > current.line.start) {
    return previousTextUnit(context, current.line, current.start);
  }
  if (current.line.index === 0) return { ok: true, value: null };
  const priorLine = getLineBounds(context, current.line.index - 1);
  if (!priorLine.ok) return priorLine;
  return newlineUnit(context, priorLine.value);
}

function firstUnit(context: WordContext, line: LineBounds): Result<WordUnit, VimWordMotionFailure> {
  return line.end === line.start
    ? { ok: true, value: emptyUnit(line) }
    : unitAt(context, line, line.start);
}

function lastUnit(context: WordContext, line: LineBounds): Result<WordUnit, VimWordMotionFailure> {
  if (line.end === line.start) return { ok: true, value: emptyUnit(line) };
  const prior = previousTextUnit(context, line, line.end);
  if (!prior.ok) return prior;
  if (prior.value === null) return wordFailure('document-read-failed');
  return { ok: true, value: prior.value };
}

function newlineUnit(context: WordContext, line: LineBounds): Result<WordUnit | null, VimWordMotionFailure> {
  if (line.index + 1 >= context.snapshot.lineCount) return { ok: true, value: null };
  return {
    ok: true,
    value: { kind: 'newline', line, start: line.end, end: line.end + 1, wordClass: 'blank' },
  };
}

function emptyUnit(line: LineBounds): WordUnit {
  return { kind: 'empty', line, start: line.start, end: line.end, wordClass: 'empty' };
}

function unitAt(
  context: WordContext,
  line: LineBounds,
  offset: number,
): Result<WordUnit, VimWordMotionFailure> {
  if (line.end === line.start) return { ok: true, value: emptyUnit(line) };
  if (offset < line.start || offset >= line.end) return wordFailure('invalid-cursor');
  const key = `${line.index}:${offset}`;
  const cached = context.unitCache.get(key);
  if (cached !== undefined) return { ok: true, value: cached };
  const grapheme = readGraphemeAt(context.snapshot, line, offset);
  if (!grapheme.ok) return grapheme;
  const unit: WordUnit = {
    kind: 'text',
    line,
    start: grapheme.value.start,
    end: grapheme.value.end,
    wordClass: wordClassFor(grapheme.value.text, context.options.keywords),
  };
  context.unitCache.set(key, unit);
  return { ok: true, value: unit };
}

function previousTextUnit(
  context: WordContext,
  line: LineBounds,
  end: number,
): Result<WordUnit | null, VimWordMotionFailure> {
  if (end <= line.start) return { ok: true, value: null };
  const grapheme = readGraphemeBefore(context, line, end);
  if (!grapheme.ok) return grapheme;
  return unitAt(context, line, grapheme.value.start);
}

function readGraphemeAt(
  snapshot: DocumentSnapshot,
  line: LineBounds,
  offset: number,
): Result<GraphemeAt, VimWordMotionFailure> {
  // @xi-perf H1 DOC-COORDINATES -- Bounded geometric-window grapheme scan; window text/segment allocation is bounded, not per-scalar.
  const graphemes = GRAPHEME_SEGMENTER_INSTANCE;
  if (graphemes === undefined) return wordFailure('invalid-width-policy');
  if (offset >= line.end) return wordFailure('document-read-failed');
  const start = asUtf16Offset(offset);
  if (start === null) return wordFailure('document-read-failed');
  let windowSize = 8;
  try {
    // Geometric windows preserve arbitrarily long clusters with linear total
    // read work, instead of rebuilding and segmenting every scalar prefix.
    while (true) {
      let end = Math.min(line.end, offset + windowSize);
      let text = snapshot.slice(start, end as Utf16Offset);
      if (!text.ok && text.error.kind === 'surrogate-split' && end < line.end) {
        end -= 1;
        text = snapshot.slice(start, end as Utf16Offset);
      }
      if (!text.ok) return wordFailure('document-read-failed');
      const iterator = graphemes.segment(text.value)[Symbol.iterator]();
      const first = iterator.next();
      if (first.done) return wordFailure('document-read-failed');
      const second = iterator.next();
      if (!second.done) {
        return { ok: true, value: { start: offset, end: offset + second.value.index, text: first.value.segment } };
      }
      if (end === line.end) return { ok: true, value: { start: offset, end, text: first.value.segment } };
      windowSize *= 2;
    }
  } catch {
    return wordFailure('invalid-width-policy');
  }
}

/**
 * Grapheme immediately before `end` on `line`. A `b`/`B`/`ge`/`gE` motion
 * calls this once per grapheme walked backward; re-reading and re-segmenting
 * a fresh (mostly overlapping) 64-unit window from the snapshot on every one
 * of those steps redid up to ~64x the real work. The window's full cluster
 * list is cached on `context` so consecutive backward steps are served from
 * memory until the cached window is exhausted.
 */
function readGraphemeBefore(
  context: WordContext,
  line: LineBounds,
  end: number,
): Result<GraphemeAt, VimWordMotionFailure> {
  // @xi-perf H1 DOC-COORDINATES -- Backward grapheme scan; cached-window hits are scalar, cold refill allocation is bounded geometric growth.
  const cached = context.graphemeWindowCache.get(line.index);
  if (cached !== undefined && end > cached.windowStart && end <= cached.windowEnd) {
    for (let index = cached.clusters.length - 1; index >= 0; index -= 1) {
      const cluster = cached.clusters[index];
      if (cluster === undefined) break;
      if (cluster.end === end) return { ok: true, value: { start: cluster.start, end: cluster.end, text: cluster.text } };
      if (cluster.end < end) break;
    }
  }
  const segmenter = GRAPHEME_SEGMENTER_INSTANCE;
  if (segmenter === undefined) return wordFailure('invalid-width-policy');
  const snapshot = context.snapshot;
  let windowSize = 64;
  try {
    while (true) {
      let start = Math.max(line.start, end - windowSize);
      if (start > line.start) {
        const preceding = readScalarBefore(snapshot, line.start, start);
        if (!preceding.ok) return preceding;
        start = preceding.value.start;
      }
      const safeStart = asUtf16Offset(start);
      const safeEnd = asUtf16Offset(end);
      if (safeStart === null || safeEnd === null) return wordFailure('document-read-failed');
      const textResult = snapshot.slice(safeStart, safeEnd);
      if (!textResult.ok) return wordFailure('document-read-failed');
      const segments = [...segmenter.segment(textResult.value)];
      const last = segments.at(-1);
      if (last === undefined) return wordFailure('document-read-failed');
      if (segments.length > 1 || start === line.start) {
        const clusters = segments.map((part) => ({
          start: start + part.index,
          end: start + part.index + part.segment.length,
          text: part.segment,
        }));
        context.graphemeWindowCache.set(line.index, { windowStart: start, windowEnd: end, clusters });
        return { ok: true, value: { start: start + last.index, end, text: last.segment } };
      }
      windowSize *= 2;
    }
  } catch {
    return wordFailure('invalid-width-policy');
  }
}

function isGraphemeStart(
  snapshot: DocumentSnapshot,
  line: LineBounds,
  offset: number,
): Result<boolean, VimWordMotionFailure> {
  if (offset === line.start) return { ok: true, value: true };
  const segmenter = GRAPHEME_SEGMENTER_INSTANCE;
  if (segmenter === undefined) return wordFailure('invalid-width-policy');
  const start = Math.max(line.start, offset - 64);
  const end = Math.min(line.end, offset + 64);
  const safeStart = asUtf16Offset(start);
  const safeEnd = asUtf16Offset(end);
  if (safeStart === null || safeEnd === null) return wordFailure('document-read-failed');
  const text = snapshot.slice(safeStart, safeEnd);
  if (!text.ok) return wordFailure('document-read-failed');
  try {
    const localOffset = offset - start;
    for (const part of segmenter.segment(text.value)) {
      if (part.index === localOffset) return { ok: true, value: true };
    }
    return { ok: true, value: false };
  } catch {
    return wordFailure('invalid-width-policy');
  }
}

function readScalarAt(snapshot: DocumentSnapshot, offset: number, end: number): Result<string, VimWordMotionFailure> {
  const start = asUtf16Offset(offset);
  const oneEnd = asUtf16Offset(offset + 1);
  if (start === null || oneEnd === null || offset >= end) return wordFailure('document-read-failed');
  const one = snapshot.slice(start, oneEnd);
  if (one.ok) return { ok: true, value: one.value };
  if (one.error.kind !== 'surrogate-split' || offset + 2 > end) return wordFailure('document-read-failed');
  const twoEnd = asUtf16Offset(offset + 2);
  if (twoEnd === null) return wordFailure('document-read-failed');
  const pair = snapshot.slice(start, twoEnd);
  return pair.ok && pair.value.length === 2 ? { ok: true, value: pair.value } : wordFailure('document-read-failed');
}

function readScalarBefore(
  snapshot: DocumentSnapshot,
  lineStart: number,
  end: number,
): Result<{ readonly start: number; readonly text: string }, VimWordMotionFailure> {
  if (end <= lineStart) return wordFailure('document-read-failed');
  const safeStart = asUtf16Offset(end - 1);
  const safeEnd = asUtf16Offset(end);
  if (safeStart === null || safeEnd === null) return wordFailure('document-read-failed');
  const one = snapshot.slice(safeStart, safeEnd);
  if (one.ok) return { ok: true, value: { start: end - 1, text: one.value } };
  if (one.error.kind !== 'surrogate-split' || end - 2 < lineStart) return wordFailure('document-read-failed');
  const pairStart = asUtf16Offset(end - 2);
  if (pairStart === null) return wordFailure('document-read-failed');
  const pair = snapshot.slice(pairStart, safeEnd);
  return pair.ok && pair.value.length === 2
    ? { ok: true, value: { start: end - 2, text: pair.value } }
    : wordFailure('document-read-failed');
}

function readLineBounds(snapshot: DocumentSnapshot, index: number): Result<LineBounds, VimWordMotionFailure> {
  if (!Number.isSafeInteger(index) || index < 0 || index >= snapshot.lineCount) return wordFailure('invalid-cursor');
  const lineIndex = index as LineIndex;
  const start = snapshot.lineStartOffset(lineIndex);
  if (!start.ok) return wordFailure('document-read-failed');
  let end = snapshot.lengthUtf16;
  if (index + 1 < snapshot.lineCount) {
    const next = snapshot.lineStartOffset((index + 1) as LineIndex);
    if (!next.ok) return wordFailure('document-read-failed');
    end = (next.value as number) - 1;
  }
  const lineStart = start.value as number;
  return end >= lineStart
    ? { ok: true, value: { index, start: lineStart, end } }
    : wordFailure('document-read-failed');
}

function getLineBounds(context: WordContext, index: number): Result<LineBounds, VimWordMotionFailure> {
  const cached = context.lineCache.get(index);
  if (cached !== undefined) return { ok: true, value: cached };
  const read = readLineBounds(context.snapshot, index);
  if (read.ok) context.lineCache.set(index, read.value);
  return read;
}

function wordClassFor(text: string, keywords: KeywordClasses): string {
  if (text === ' ' || text === '\t') return 'blank';
  const first = text.codePointAt(0) ?? 0;
  const included = isKeyword(first, keywords);
  if (first <= 0xff) return included ? 'keyword' : 'punctuation';
  const scalar = String.fromCodePoint(first);
  if (included) {
    if (UNICODE_EMOJI.test(scalar)) return 'keyword:emoji';
    if (UNICODE_NUMBER.test(scalar)) return 'keyword:number';
    return 'keyword';
  }
  return 'punctuation';
}

function isKeyword(codePoint: number, classes: KeywordClasses): boolean {
  let included = false;
  for (const rule of classes.rules) {
    const matches = rule.kind === 'alpha'
      ? isAlphaKeyword(codePoint)
      : codePoint >= rule.start && codePoint <= rule.end;
    if (matches) included = rule.include;
  }
  return included;
}

function isAlphaKeyword(codePoint: number): boolean {
  const scalar = String.fromCodePoint(codePoint);
  return UNICODE_LETTER.test(scalar) || (codePoint > 0xff && UNICODE_EMOJI.test(scalar));
}

function sameWordClass(left: WordUnit, right: WordUnit, bigWord: boolean): boolean {
  if (left.kind === 'empty' || right.kind === 'empty') return left.kind === right.kind;
  return bigWord || left.kind === 'newline' || right.kind === 'newline'
    ? left.kind !== 'newline' && right.kind !== 'newline'
    : left.wordClass === right.wordClass;
}

function isBlank(unit: WordUnit): boolean {
  return unit.kind === 'newline' || (unit.kind === 'text' && unit.wordClass === 'blank');
}

function displayColumnForTarget(
  context: WordContext,
  prior: VimWordMotionCursor,
  priorLine: LineBounds,
  target: WordUnit,
): Result<number, VimWordMotionFailure> {
  if (target.kind === 'empty') return { ok: true, value: 0 };
  const currentLineResult = context.snapshot.lineIndexAt(prior.offset);
  if (!currentLineResult.ok) return wordFailure('invalid-cursor');
  const currentLineIndex = currentLineResult.value as number;
  if (currentLineIndex === target.line.index && target.start >= (prior.offset as number)
    && prior.desiredDisplayCellColumn !== null && prior.desiredDisplayCellColumn !== 0x7fffffff) {
    const currentScalar = readScalarAt(context.snapshot, prior.offset as number, priorLine.end);
    if (!currentScalar.ok) return currentScalar;
    if (currentScalar.value !== '\t') {
      const start = asUtf16Offset(prior.offset as number);
      const end = asUtf16Offset(target.start);
      if (start === null || end === null) return wordFailure('document-read-failed');
      const text = context.snapshot.slice(start, end);
      if (!text.ok) return wordFailure('document-read-failed');
      return measureCellAdvance(text.value, prior.desiredDisplayCellColumn as number, context.options);
    }
  }

  if (currentLineIndex === target.line.index && target.start < (prior.offset as number)
    && prior.desiredDisplayCellColumn !== null && prior.desiredDisplayCellColumn !== 0x7fffffff) {
    const start = asUtf16Offset(target.start);
    const end = asUtf16Offset(prior.offset as number);
    if (start === null || end === null) return wordFailure('document-read-failed');
    const text = context.snapshot.slice(start, end);
    if (!text.ok) return wordFailure('document-read-failed');
    if (!text.value.includes('\t')) {
      const width = measureCellAdvance(text.value, 0, context.options);
      if (!width.ok) return width;
      return { ok: true, value: Math.max(0, (prior.desiredDisplayCellColumn as number) - width.value) };
    }
  }

  const prefixEnd = asUtf16Offset(target.start);
  const prefixStart = asUtf16Offset(target.line.start);
  if (prefixEnd === null || prefixStart === null) return wordFailure('document-read-failed');
  // ASCII fast path: single-width, no tabs, so the column is just the length
  // -- avoids segmenting (and reading) a potentially huge line prefix.
  if (typeof context.snapshot.isPrintableAsciiRange === 'function') {
    const asciiRange = context.snapshot.isPrintableAsciiRange(prefixStart, prefixEnd);
    if (!asciiRange.ok) return wordFailure('document-read-failed');
    if (asciiRange.value) return { ok: true, value: (prefixEnd as number) - (prefixStart as number) };
  }
  const prefix = context.snapshot.slice(prefixStart, prefixEnd);
  if (!prefix.ok) return wordFailure('document-read-failed');
  return measureCellAdvance(prefix.value, 0, context.options);
}

function measureCellAdvance(
  text: string,
  initialCell: number,
  options: ResolvedWordOptions,
): Result<number, VimWordMotionFailure> {
  const segmenter = GRAPHEME_SEGMENTER_INSTANCE;
  if (segmenter === undefined) return wordFailure('invalid-width-policy');
  let cell = initialCell;
  try {
    for (const grapheme of segmenter.segment(text)) {
      const width = grapheme.segment === '\t'
        ? options.tabSize - (cell % options.tabSize)
        : options.widthPolicy.widthOfCluster(grapheme.segment);
      if (!Number.isSafeInteger(width) || width < 0 || (grapheme.segment !== '\t' && width > 2)) {
        return wordFailure('invalid-width-policy');
      }
      cell += width === 0 ? 1 : width;
    }
  } catch {
    return wordFailure('invalid-width-policy');
  }
  return { ok: true, value: cell };
}

function resolveWordOptions(options: VimWordMotionOptions): Result<ResolvedWordOptions, VimWordMotionFailure> {
  const keywordValue = options.isKeyword ?? DEFAULT_ISKEYWORD;
  const tabSize = options.tabSize ?? 8;
  const widthPolicy = options.widthPolicy ?? defaultCellWidthPolicy();
  if (typeof keywordValue !== 'string' || !Number.isSafeInteger(tabSize) || tabSize < 1 || tabSize > MAX_TAB_SIZE) {
    return wordFailure('invalid-option');
  }
  if (typeof widthPolicy.widthOfCluster !== 'function') return wordFailure('invalid-width-policy');
  const keywords = parseIsKeyword(keywordValue);
  if (!keywords.ok) return keywords;
  return { ok: true, value: { keywordValue, tabSize, widthPolicy, keywords: keywords.value } };
}

function parseIsKeyword(value: string): Result<KeywordClasses, VimWordMotionFailure> {
  const rules: KeywordRule[] = [];
  if (value.length === 0) return { ok: true, value: { rules } };
  const parts = value.split(',');
  for (const part of parts) {
    if (part.length === 0) {
      rules.push({ include: true, kind: 'range', start: 0x2c, end: 0x2c });
      continue;
    }
    let include = true;
    let item = part;
    if (item.startsWith('^')) {
      include = false;
      item = item.slice(1);
    }
    if (item.length === 0) return wordFailure('invalid-option');
    if (item === '@') {
      rules.push({ include, kind: 'alpha', start: 0, end: 0x10ffff });
      continue;
    }
    if (item === '@-@') {
      rules.push({ include, kind: 'range', start: 0x40, end: 0x40 });
      continue;
    }
    const rangeSeparator = item.indexOf('-');
    if (rangeSeparator > 0 && rangeSeparator < item.length - 1) {
      const start = parseIsKeywordEndpoint(item.slice(0, rangeSeparator));
      const end = parseIsKeywordEndpoint(item.slice(rangeSeparator + 1));
      if (start === null || end === null || start > end) return wordFailure('invalid-option');
      rules.push({ include, kind: 'range', start, end });
      continue;
    }
    const point = parseIsKeywordEndpoint(item);
    if (point === null) return wordFailure('invalid-option');
    rules.push({ include, kind: 'range', start: point, end: point });
  }
  return { ok: true, value: { rules } };
}

function parseIsKeywordEndpoint(value: string): number | null {
  if (/^\d+$/u.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 && number <= 255 ? number : null;
  }
  const scalars = [...value];
  return scalars.length === 1 ? scalars[0]?.codePointAt(0) ?? null : null;
}

function asUtf16Offset(value: number): Utf16Offset | null {
  return Number.isSafeInteger(value) && value >= 0 ? value as Utf16Offset : null;
}

function wordFailure(kind: VimWordMotionFailure['kind']): Result<never, VimWordMotionFailure> {
  return { ok: false, error: { kind } };
}
