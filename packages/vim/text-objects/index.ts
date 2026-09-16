import type { CellColumn, DocumentSnapshot, DocumentVersion, LineIndex, Result, Utf16Offset } from '../../document/src/index';
import { resolveVimWordMotion, type VimWordMotionCursor, type VimWordMotionKey } from '../motions/word';
import type { VimOperatorRangeInput } from '../ranges/normalize';

export type VimTextObjectKey =
  | 'iw' | 'aw' | 'iW' | 'aW' | 'is' | 'as' | 'ip' | 'ap'
  | 'i"' | 'a"' | "i'" | "a'" | 'i`' | 'a`'
  | 'i(' | 'a(' | 'i)' | 'a)' | 'ib' | 'ab'
  | 'i[' | 'a[' | 'i]' | 'a]' | 'i{' | 'a{' | 'i}' | 'a}' | 'iB' | 'aB'
  | 'i<' | 'a<' | 'i>' | 'a>' | 'it' | 'at';

export type VimTextObjectRangeKind = 'characterwise' | 'linewise';
export type VimTextObjectDirection = 'forward' | 'backward';

export interface VimTextObjectCursor {
  readonly documentVersion: DocumentVersion;
  /** Normal-mode semantic character start in zero-based UTF-16 units. */
  readonly offset: Utf16Offset;
  /** Current logical terminal-cell column, retained for post-linewise operator cursor placement. */
  readonly displayCellColumn?: CellColumn;
}

export interface VimTextObjectInvocation {
  readonly key: VimTextObjectKey;
  readonly count?: number;
}

export interface VimTextObjectOptions {
  /** Buffer-local Neovim `iskeyword`; `@,48-57,_,192-255` is the pinned default. */
  readonly isKeyword?: string;
  /** Characters that escape a quote delimiter; backslash is the pinned default. */
  readonly quoteEscape?: string;
  /** Neovim `cpoptions`; `M` controls whether backslashes escape bracket delimiters. */
  readonly cpOptions?: string;
  /** Neovim `paragraphs` macro pairs. Defaults to the pinned help default. */
  readonly paragraphs?: string;
  /** Maximum UTF-16 units inspected by a delimiter/sentence search. Defaults to 65,536. */
  readonly maxScanUtf16?: number;
}

export interface VimTextObjectRange {
  readonly documentVersion: DocumentVersion;
  readonly key: VimTextObjectKey;
  readonly count: number;
  readonly kind: VimTextObjectRangeKind;
  /** Original cursor cell column used when a linewise operator preserves the user's column. */
  readonly originDisplayCellColumn: CellColumn | null;
  /** Half-open source-version range in UTF-16 units. */
  readonly start: Utf16Offset;
  readonly end: Utf16Offset;
}

export type VimTextObjectFailure =
  | { readonly kind: 'stale-document-version' }
  | { readonly kind: 'invalid-cursor' }
  | { readonly kind: 'invalid-count' }
  | { readonly kind: 'invalid-key' }
  | { readonly kind: 'invalid-option' }
  | { readonly kind: 'object-not-found' }
  | { readonly kind: 'empty-object' }
  | { readonly kind: 'scan-limit-exceeded' }
  | { readonly kind: 'document-read-failed' };

export interface VimVisualTextSelectionInput {
  readonly documentVersion: DocumentVersion;
  readonly anchor: Utf16Offset;
  readonly head: Utf16Offset;
  readonly direction: VimTextObjectDirection;
  readonly kind: VimTextObjectRangeKind;
}

export interface VimVisualTextSelection extends VimVisualTextSelectionInput {
  readonly start: Utf16Offset;
  readonly end: Utf16Offset;
}

interface ParsedKey {
  readonly around: boolean;
  readonly family: 'word' | 'sentence' | 'paragraph' | 'quote' | 'bracket' | 'tag';
  readonly key: VimTextObjectKey;
  readonly big: boolean;
  readonly delimiter?: string;
}

interface TextLine {
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

interface ParagraphLine extends TextLine { readonly boundary: boolean }

interface TextContext {
  readonly snapshot: DocumentSnapshot;
  readonly options: ResolvedOptions;
  readonly lineCache: Map<number, ParagraphLine>;
}

interface ResolvedOptions {
  readonly isKeyword: string;
  readonly quoteEscape: string;
  readonly cpOptions: string;
  readonly paragraphs: string;
  readonly maxScanUtf16: number;
}

interface Range {
  readonly start: number;
  readonly end: number;
  readonly kind: VimTextObjectRangeKind;
}

interface ScanWindow {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly truncatedLeft: boolean;
  readonly truncatedRight: boolean;
}

interface DelimiterPair {
  readonly openStart: number;
  readonly openEnd: number;
  readonly closeStart: number;
  readonly closeEnd: number;
}

interface TagPair {
  readonly name: string;
  readonly openStart: number;
  readonly contentStart: number;
  readonly closeStart: number;
  readonly closeEnd: number;
}

interface SentenceRange { readonly start: number; readonly end: number }
interface ParagraphRange { readonly firstLine: number; readonly lastLine: number }

const DEFAULT_ISKEYWORD = '@,48-57,_,192-255';
const DEFAULT_PARAGRAPHS = 'IPLPPPQPP TPHPLIPpLpItpplpipbp';
const DEFAULT_SCAN_UTF16 = 65_536;
const MAX_SCAN_UTF16 = 1_000_000;
const MAX_OBJECT_COUNT = 10_000;
const GRAPHEME_SEGMENTER = (Intl as typeof Intl & {
  readonly Segmenter?: new (locales?: string | readonly string[], options?: { readonly granularity: 'grapheme' }) => {
    segment(input: string): Iterable<{ readonly segment: string; readonly index: number }>;
  };
}).Segmenter;

/** Resolve an inner/around built-in object to a versioned half-open range. */
export function resolveVimTextObject(
  snapshot: DocumentSnapshot,
  cursor: VimTextObjectCursor,
  invocation: VimTextObjectInvocation,
  options: VimTextObjectOptions = {},
): Result<VimTextObjectRange, VimTextObjectFailure> {
  if (cursor.documentVersion !== snapshot.version) return failure('stale-document-version');
  if (!validOffset(snapshot, cursor.offset)) return failure('invalid-cursor');
  const count = invocation.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_OBJECT_COUNT) return failure('invalid-count');
  const parsed = parseKey(invocation.key);
  if (parsed === null) return failure('invalid-key');
  const resolvedOptions = resolveOptions(options);
  if (!resolvedOptions.ok) return resolvedOptions;
  const context: TextContext = { snapshot, options: resolvedOptions.value, lineCache: new Map() };

  let rangeResult: Result<Range, VimTextObjectFailure>;
  switch (parsed.family) {
    case 'word': rangeResult = resolveWord(context, cursor.offset as number, parsed, count); break;
    case 'sentence': rangeResult = resolveSentence(context, cursor.offset as number, parsed, count); break;
    case 'paragraph': rangeResult = resolveParagraph(context, cursor.offset as number, parsed, count); break;
    case 'quote': rangeResult = resolveQuote(context, cursor.offset as number, parsed); break;
    case 'bracket': rangeResult = resolveBracket(context, cursor.offset as number, parsed, count); break;
    case 'tag': rangeResult = resolveTag(context, cursor.offset as number, parsed, count); break;
  }
  if (!rangeResult.ok) return rangeResult;
  const start = asOffset(rangeResult.value.start);
  const end = asOffset(rangeResult.value.end);
  if (start === null || end === null) return failure('document-read-failed');
  return {
    ok: true,
    value: Object.freeze({
      documentVersion: snapshot.version,
      key: invocation.key,
      count,
      kind: rangeResult.value.kind,
      originDisplayCellColumn: cursor.displayCellColumn ?? null,
      start,
      end,
    }),
  };
}

/** Adapt an already resolved object range to the central operator range normalizer. */
export function vimTextObjectMotion(
  snapshot: DocumentSnapshot,
  objectRange: VimTextObjectRange,
): Result<Omit<VimOperatorRangeInput, 'operator'>, VimTextObjectFailure> {
  if (objectRange.documentVersion !== snapshot.version) return failure('stale-document-version');
  const start = objectRange.start as number;
  const end = objectRange.end as number;
  if (!validOffset(snapshot, objectRange.start) || !validOffset(snapshot, objectRange.end) || end < start) {
    return failure('invalid-cursor');
  }
  const target = end === start ? objectRange.start : objectRange.kind === 'linewise'
    ? asOffset(end - 1)
    : previousGraphemeStart(snapshot, end);
  if (target === null) return failure('document-read-failed');
  return {
    ok: true,
    value: Object.freeze({
      origin: Object.freeze({
        documentVersion: snapshot.version,
        offset: objectRange.start,
        ...(objectRange.originDisplayCellColumn === null ? {} : { displayCellColumn: objectRange.originDisplayCellColumn }),
      }),
      target: Object.freeze({ documentVersion: snapshot.version, offset: target }),
      direction: 'forward',
      motionKind: objectRange.kind,
      inclusive: end > start,
      motionKey: objectRange.key,
    }),
  };
}

/**
 * Extend an existing visual selection by one text object. The anchor and
 * forward/backward direction remain stable while the active head expands.
 */
export function extendVimVisualTextObject(
  snapshot: DocumentSnapshot,
  selection: VimVisualTextSelectionInput,
  invocation: VimTextObjectInvocation,
  options: VimTextObjectOptions = {},
): Result<VimVisualTextSelection, VimTextObjectFailure> {
  if (selection.documentVersion !== snapshot.version) return failure('stale-document-version');
  if (!validOffset(snapshot, selection.anchor) || !validOffset(snapshot, selection.head)) return failure('invalid-cursor');
  if (selection.direction !== 'forward' && selection.direction !== 'backward') return failure('invalid-cursor');
  const object = resolveVimTextObject(snapshot, { documentVersion: snapshot.version, offset: selection.head }, invocation, options);
  if (!object.ok) return object;
  const objectStart = object.value.start as number;
  const objectEnd = object.value.end as number;
  const samePoint = selection.anchor === selection.head;
  if (samePoint) {
    const head = object.value.kind === 'linewise'
      ? selection.direction === 'forward' ? lastLineStartBefore(snapshot, objectEnd) : asOffset(objectStart)
      : selection.direction === 'forward' ? previousGraphemeStart(snapshot, objectEnd) : asOffset(objectStart);
    if (head === null) return failure('document-read-failed');
    return visualSelection(snapshot, selection.anchor, head, selection.direction, object.value.kind, objectStart, objectEnd);
  }

  const current = selectionRange(snapshot, selection);
  if (!current.ok) return current;
  let start = Math.min(current.value.start, objectStart);
  let end = Math.max(current.value.end, objectEnd);
  const parsed = parseKey(invocation.key);
  if (parsed === null) return failure('invalid-key');

  // In a backwards Visual selection an inner word at the active word start
  // extends through the whitespace immediately before it, matching Neovim's
  // directional text-object expansion rule.
  if (selection.direction === 'backward' && parsed.family === 'word' && !parsed.around
    && objectStart === (selection.head as number)) {
    const leading = scanWhitespace(snapshot, objectStart, 'backward', options.maxScanUtf16 ?? DEFAULT_SCAN_UTF16);
    if (!leading.ok) return leading;
    start = Math.min(start, leading.value);
  }
  const anchor = selection.anchor;
  const resultKind = object.value.kind === 'linewise' || selection.kind === 'linewise' ? 'linewise' : 'characterwise';
  const head = resultKind === 'linewise'
    ? selection.direction === 'forward' ? lastLineStartBefore(snapshot, end) : asOffset(start)
    : selection.direction === 'forward' ? previousGraphemeStart(snapshot, end) : firstGraphemeStart(snapshot, start);
  if (head === null) return failure('document-read-failed');
  return visualSelection(snapshot, anchor, head, selection.direction, resultKind, start, end);
}

function lastLineStartBefore(snapshot: DocumentSnapshot, end: number): Utf16Offset | null {
  const offset = asOffset(end);
  if (offset === null) return null;
  const line = snapshot.lineIndexAt(offset);
  if (!line.ok) return null;
  let lastLine = line.value as number;
  const start = lineStart(snapshot, lastLine);
  if (!start.ok) return null;
  if (start.value === end && lastLine > 0) lastLine -= 1;
  const result = lineStart(snapshot, lastLine);
  return result.ok ? asOffset(result.value) : null;
}

function visualSelection(
  snapshot: DocumentSnapshot,
  anchor: Utf16Offset,
  head: Utf16Offset,
  direction: VimTextObjectDirection,
  kind: VimTextObjectRangeKind,
  start: number,
  end: number,
): Result<VimVisualTextSelection, VimTextObjectFailure> {
  const startOffset = asOffset(start);
  const endOffset = asOffset(end);
  if (startOffset === null || endOffset === null) return failure('document-read-failed');
  return {
    ok: true,
    value: Object.freeze({
      documentVersion: snapshot.version,
      anchor,
      head,
      direction,
      kind,
      start: startOffset,
      end: endOffset,
    }),
  };
}

function selectionRange(
  snapshot: DocumentSnapshot,
  selection: VimVisualTextSelectionInput,
): Result<Range, VimTextObjectFailure> {
  const anchor = selection.anchor as number;
  const head = selection.head as number;
  if (selection.kind === 'linewise') {
    const anchorLine = snapshot.lineIndexAt(selection.anchor);
    const headLine = snapshot.lineIndexAt(selection.head);
    if (!anchorLine.ok || !headLine.ok) return failure('invalid-cursor');
    const first = Math.min(anchorLine.value as number, headLine.value as number);
    const last = Math.max(anchorLine.value as number, headLine.value as number);
    const start = lineStart(snapshot, first);
    const end = lineStart(snapshot, last + 1);
    if (!start.ok || !end.ok) return failure('document-read-failed');
    return { ok: true, value: { start: start.value, end: end.value, kind: 'linewise' } };
  }
  const start = Math.min(anchor, head);
  const last = Math.max(anchor, head);
  const end = nextGraphemeBoundary(snapshot, last);
  if (!end.ok) return end;
  return { ok: true, value: { start, end: end.value, kind: 'characterwise' } };
}

function resolveWord(
  context: TextContext,
  cursor: number,
  parsed: ParsedKey,
  count: number,
): Result<Range, VimTextObjectFailure> {
  const current = scalarAt(context.snapshot, cursor);
  if (!current.ok) return current;
  const bigWord = parsed.big;
  const onWhitespace = /^\s$/u.test(current.value);
  let start: number;
  let end: number;

  if (onWhitespace) {
    const whitespace = whitespaceRegion(context.snapshot, cursor, context.options.maxScanUtf16);
    if (!whitespace.ok) return whitespace;
    start = whitespace.value.start;
    end = whitespace.value.end;
    if (parsed.around) {
      const next = wordRunAtOrAfter(context, end, bigWord);
      if (next.ok) {
        end = next.value.end;
      } else if (next.error.kind === 'object-not-found') {
        const previous = wordRunBefore(context, start, bigWord);
        if (!previous.ok) return previous;
        start = previous.value.start;
      } else return next;
    }
  } else {
    const word = wordRunAt(context.snapshot, cursor, bigWord, context.options.isKeyword);
    if (!word.ok) return word;
    start = word.value.start;
    end = word.value.end;
    const selectedWordCount = parsed.around ? count : Math.floor((count + 1) / 2);
    if (selectedWordCount > 1) {
      const next = wordMotion(context.snapshot, start, bigWord ? 'W' : 'w', selectedWordCount - 1, context.options.isKeyword);
      if (!next.ok) return next;
      const nextWord = wordRunAt(context.snapshot, next.value.offset as number, bigWord, context.options.isKeyword);
      if (!nextWord.ok) return nextWord;
      end = nextWord.value.end;
    }
    if (parsed.around) {
      const trailing = scanLineWhitespace(context.snapshot, end, 'forward');
      if (!trailing.ok) return trailing;
      if (trailing.value > end) end = trailing.value;
      else {
        const leading = scanLineWhitespace(context.snapshot, start, 'backward');
        if (!leading.ok) return leading;
        start = leading.value;
      }
    } else if (count > 1 && count % 2 === 0) {
      const trailing = scanLineWhitespace(context.snapshot, end, 'forward');
      if (!trailing.ok) return trailing;
      if (trailing.value > end) end = trailing.value;
    }
  }

  if (start === end) return failure('empty-object');
  return { ok: true, value: { start, end, kind: 'characterwise' } };
}

function wordRunAt(
  snapshot: DocumentSnapshot,
  offset: number,
  bigWord: boolean,
  isKeyword: string,
): Result<{ readonly start: number; readonly end: number }, VimTextObjectFailure> {
  const backward = wordMotion(snapshot, offset, bigWord ? 'B' : 'b', 1, isKeyword);
  if (!backward.ok) return backward;
  const nextFromCursor = wordMotion(snapshot, offset, bigWord ? 'W' : 'w', 1, isKeyword);
  if (!nextFromCursor.ok) return nextFromCursor;
  const nextFromBackward = wordMotion(snapshot, backward.value.offset as number, bigWord ? 'W' : 'w', 1, isKeyword);
  if (!nextFromBackward.ok) return nextFromBackward;
  const start = nextFromBackward.value.offset === nextFromCursor.value.offset
    ? backward.value.offset as number
    : offset;
  const ending = wordMotion(snapshot, start, bigWord ? 'E' : 'e', 1, isKeyword);
  if (!ending.ok) return ending;
  const end = nextGraphemeBoundary(snapshot, ending.value.offset as number);
  if (!end.ok) return end;
  return { ok: true, value: { start, end: end.value } };
}

function wordRunAtOrAfter(
  context: TextContext,
  offset: number,
  bigWord: boolean,
): Result<{ readonly start: number; readonly end: number }, VimTextObjectFailure> {
  let cursor = offset;
  while (cursor < context.snapshot.lengthUtf16) {
    const scalar = scalarAt(context.snapshot, cursor);
    if (!scalar.ok) return scalar;
    if (!/^\s$/u.test(scalar.value)) return wordRunAt(context.snapshot, cursor, bigWord, context.options.isKeyword);
    cursor += scalar.value.length;
  }
  return failure('object-not-found');
}

function wordRunBefore(
  context: TextContext,
  offset: number,
  bigWord: boolean,
): Result<{ readonly start: number; readonly end: number }, VimTextObjectFailure> {
  let cursor = offset;
  while (cursor > 0) {
    const scalar = scalarBefore(context.snapshot, cursor);
    if (!scalar.ok) return scalar;
    cursor = scalar.value.start;
    if (!/^\s$/u.test(scalar.value.text)) return wordRunAt(context.snapshot, cursor, bigWord, context.options.isKeyword);
  }
  return failure('object-not-found');
}

function wordMotion(
  snapshot: DocumentSnapshot,
  offset: number,
  key: VimWordMotionKey,
  count: number,
  isKeyword: string,
): Result<VimTextObjectCursor, VimTextObjectFailure> {
  const safeOffset = asOffset(offset);
  if (safeOffset === null) return failure('invalid-cursor');
  const cursor: VimWordMotionCursor = {
    documentVersion: snapshot.version,
    offset: safeOffset,
    desiredDisplayCellColumn: null,
  };
  const result = resolveVimWordMotion(snapshot, cursor, { key, count }, { isKeyword });
  if (!result.ok) {
    return result.error.kind === 'invalid-option' ? failure('invalid-option')
      : result.error.kind === 'invalid-cursor' ? failure('invalid-cursor')
        : result.error.kind === 'stale-document-version' ? failure('stale-document-version')
          : result.error.kind === 'invalid-count' ? failure('invalid-count')
            : failure('document-read-failed');
  }
  return { ok: true, value: { documentVersion: snapshot.version, offset: result.value.cursor.offset } };
}

function resolveSentence(
  context: TextContext,
  cursor: number,
  parsed: ParsedKey,
  count: number,
): Result<Range, VimTextObjectFailure> {
  const window = scanWindow(context.snapshot, cursor, context.options.maxScanUtf16);
  if (!window.ok) return window;
  const sentences = sentenceRanges(window.value, context.options.cpOptions);
  if (sentences.length === 0) return failure(window.value.truncatedLeft || window.value.truncatedRight ? 'scan-limit-exceeded' : 'object-not-found');
  let index = sentences.findIndex((item) => item.start <= cursor && cursor <= item.end);
  if (index < 0) index = sentences.findIndex((item) => item.start > cursor);
  if (index < 0) index = sentences.length - 1;
  const current = sentences[index];
  if (current === undefined) return failure('object-not-found');
  let start = current.start;
  let end = current.end;
  if (count > 1) {
    const next = sentences[index + count - 1];
    if (next !== undefined) end = next.start;
    else if (window.value.truncatedRight) return failure('scan-limit-exceeded');
  }
  if (parsed.around) {
    if (count === 1) {
      const trailing = whitespaceEnd(window.value, end);
      if (trailing > end) end = trailing;
      else start = whitespaceStart(window.value, start);
    } else if (end === current.end) {
      const trailing = whitespaceEnd(window.value, end);
      if (trailing > end) end = trailing;
      else start = whitespaceStart(window.value, start);
    }
  }
  if (window.value.truncatedLeft && start === window.value.start) return failure('scan-limit-exceeded');
  if (window.value.truncatedRight && end === window.value.end) return failure('scan-limit-exceeded');
  return { ok: true, value: { start, end, kind: 'characterwise' } };
}

function sentenceRanges(window: ScanWindow, cpOptions: string): SentenceRange[] {
  const text = window.text;
  const ranges: SentenceRange[] = [];
  let start = skipSpacesForward(text, 0);
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char !== '.' && char !== '!' && char !== '?') { index += 1; continue; }
    let after = index + 1;
    while (after < text.length && isSentenceCloser(text[after] ?? '')) after += 1;
    let whitespaceEndAt = after;
    while (whitespaceEndAt < text.length && (text[whitespaceEndAt] === ' ' || text[whitespaceEndAt] === '\t' || text[whitespaceEndAt] === '\n')) whitespaceEndAt += 1;
    const atLineEnd = after === text.length || text[after] === '\n';
    const hasSpace = after < text.length && (text[after] === ' ' || text[after] === '\t' || text[after] === '\n');
    let validBreak = atLineEnd || hasSpace;
    if (cpOptions.includes('J')) {
      validBreak = after === text.length || text[after] === '\n'
        || (text[after] === ' ' && whitespaceEndAt - after >= 2);
    }
    if (!validBreak) { index += 1; continue; }
    const absoluteEnd = window.start + after;
    if (absoluteEnd > window.start + start) ranges.push({ start: window.start + start, end: absoluteEnd });
    start = skipSpacesForward(text, whitespaceEndAt);
    index = Math.max(whitespaceEndAt, start);
  }
  if (start < text.length) ranges.push({ start: window.start + start, end: window.end });
  else if (ranges.length === 0 && text.length > 0) ranges.push({ start: window.start, end: window.end });
  return ranges;
}

function isSentenceCloser(char: string): boolean { return char === ')' || char === ']' || char === '"' || char === "'"; }
function skipSpacesForward(text: string, index: number): number {
  let result = index;
  while (result < text.length && /\s/u.test(text[result] ?? '')) result += 1;
  return result;
}
function whitespaceStart(window: ScanWindow, offset: number): number {
  let index = Math.max(0, offset - window.start);
  while (index > 0 && /\s/u.test(window.text[index - 1] ?? '')) index -= 1;
  return window.start + index;
}
function whitespaceEnd(window: ScanWindow, offset: number): number {
  let index = Math.max(0, offset - window.start);
  while (index < window.text.length && /\s/u.test(window.text[index] ?? '')) index += 1;
  return window.start + index;
}

function resolveParagraph(
  context: TextContext,
  cursor: number,
  parsed: ParsedKey,
  count: number,
): Result<Range, VimTextObjectFailure> {
  const cursorLineResult = context.snapshot.lineIndexAt(asOffset(cursor) as Utf16Offset);
  if (!cursorLineResult.ok) return failure('invalid-cursor');
  const cursorLine = cursorLineResult.value as number;
  let candidate = cursorLine;
  let candidateBoundary = isBoundaryIndex(context, candidate);
  if (!candidateBoundary.ok) return candidateBoundary;
  if (candidateBoundary.value) {
    const following = findParagraphStart(context, candidate + 1, 1);
    if (!following.ok) return following;
    if (following.value !== null) candidate = following.value;
    else {
      const prior = findParagraphStart(context, candidate - 1, -1);
      if (!prior.ok) return prior;
      if (prior.value === null) return failure('object-not-found');
      candidate = prior.value;
    }
  }
  const first = paragraphBoundsAt(context, candidate);
  if (!first.ok) return first;
  let last = first.value;
  for (let step = 1; step < count; step += 1) {
    const next = findParagraphStart(context, last.lastLine + 1, 1);
    if (!next.ok) return next;
    if (next.value === null) break;
    const bounds = paragraphBoundsAt(context, next.value);
    if (!bounds.ok) return bounds;
    last = bounds.value;
  }
  const startLine = first.value.firstLine;
  let endLineExclusive = last.lastLine + 1;
  if (parsed.around) {
    const followingBoundary = endLineExclusive < context.snapshot.lineCount
      ? isBoundaryIndex(context, endLineExclusive) : { ok: true as const, value: false };
    if (!followingBoundary.ok) return followingBoundary;
    if (followingBoundary.value) {
      endLineExclusive += 1;
    } else if (startLine > 0) {
      const leadingBoundary = isBoundaryIndex(context, startLine - 1);
      if (!leadingBoundary.ok) return leadingBoundary;
      if (!leadingBoundary.value) return rangeFromLines(context.snapshot, startLine, endLineExclusive, 'linewise');
      // Around objects prefer following whitespace; otherwise consume the preceding blank line.
      let leading = startLine - 1;
      while (leading > 0) {
        const earlierBoundary = isBoundaryIndex(context, leading - 1);
        if (!earlierBoundary.ok) return earlierBoundary;
        if (!earlierBoundary.value) break;
        leading -= 1;
      }
      return rangeFromLines(context.snapshot, leading, endLineExclusive, 'linewise');
    }
  }
  return rangeFromLines(context.snapshot, startLine, endLineExclusive, 'linewise');
}

function isBoundaryIndex(context: TextContext, index: number): Result<boolean, VimTextObjectFailure> {
  if (index < 0 || index >= context.snapshot.lineCount) return { ok: true, value: false };
  const line = inspectParagraphLine(context, index);
  if (!line.ok) return line;
  return { ok: true, value: line.value.boundary };
}

function findParagraphStart(
  context: TextContext,
  fromLine: number,
  direction: 1 | -1,
): Result<number | null, VimTextObjectFailure> {
  let line = fromLine;
  let scanned = 0;
  while (line >= 0 && line < context.snapshot.lineCount) {
    const info = inspectParagraphLine(context, line);
    if (!info.ok) return info;
    scanned += Math.max(1, info.value.end - info.value.start) + 1;
    if (scanned > context.options.maxScanUtf16) return failure('scan-limit-exceeded');
    if (!info.value.boundary) return { ok: true, value: line };
    line += direction;
  }
  return { ok: true, value: null };
}

function paragraphBoundsAt(context: TextContext, lineIndex: number): Result<ParagraphRange, VimTextObjectFailure> {
  const initial = isBoundaryIndex(context, lineIndex);
  if (!initial.ok) return initial;
  if (initial.value) return failure('object-not-found');
  let firstLine = lineIndex;
  let lastLine = lineIndex;
  let scanned = 0;
  for (let line = lineIndex - 1; line >= 0; line -= 1) {
    const info = inspectParagraphLine(context, line);
    if (!info.ok) return info;
    scanned += Math.max(1, info.value.end - info.value.start) + 1;
    if (scanned > context.options.maxScanUtf16) return failure('scan-limit-exceeded');
    if (info.value.boundary) break;
    firstLine = line;
  }
  for (let line = lineIndex + 1; line < context.snapshot.lineCount; line += 1) {
    const info = inspectParagraphLine(context, line);
    if (!info.ok) return info;
    scanned += Math.max(1, info.value.end - info.value.start) + 1;
    if (scanned > context.options.maxScanUtf16) return failure('scan-limit-exceeded');
    if (info.value.boundary) break;
    lastLine = line;
  }
  return { ok: true, value: { firstLine, lastLine } };
}

function isParagraphMacro(text: string, option: string): boolean {
  if (text.length < 3 || text[0] !== '.') return false;
  const macro = text.slice(1, 3);
  for (let i = 0; i + 1 < option.length; i += 2) {
    if (option.slice(i, i + 2) === macro) return true;
  }
  return false;
}

function rangeFromLines(
  snapshot: DocumentSnapshot,
  firstLine: number,
  endLineExclusive: number,
  kind: VimTextObjectRangeKind,
): Result<Range, VimTextObjectFailure> {
  const start = lineStart(snapshot, firstLine);
  const end = lineStart(snapshot, Math.min(endLineExclusive, snapshot.lineCount));
  if (!start.ok || !end.ok) return failure('document-read-failed');
  return { ok: true, value: { start: start.value, end: end.value, kind } };
}

function resolveQuote(
  context: TextContext,
  cursor: number,
  parsed: ParsedKey,
): Result<Range, VimTextObjectFailure> {
  const lineIndex = context.snapshot.lineIndexAt(asOffset(cursor) as Utf16Offset);
  if (!lineIndex.ok) return failure('invalid-cursor');
  const line = textObjectLineBounds(context, lineIndex.value as number);
  if (!line.ok) return line;
  const localCursor = cursor - line.value.start;
  let pair: DelimiterPair | null = null;
  let open: number | null = null;
  let escapeRun = 0;
  for (let at = line.value.start; at < line.value.end && pair === null;) {
    const window = textObjectWindow(context.snapshot, at, line.value.end);
    if (!window.ok) return window;
    for (let index = 0; index < window.value.length; index += 1) {
      const character = window.value[index] ?? '';
      const local = at - line.value.start + index;
      if (character === parsed.delimiter && escapeRun % 2 === 0) {
        if (open === null) open = local;
        else {
          // Quote pairs are disjoint: the first pair closing at/after the
          // cursor is the containing pair, or the first following pair.
          if (local >= localCursor) {
            pair = { openStart: open, openEnd: open + 1, closeStart: local, closeEnd: local + 1 };
            break;
          }
          open = null;
        }
      }
      escapeRun = context.options.quoteEscape.includes(character) ? escapeRun + 1 : 0;
    }
    at += window.value.length;
  }
  if (pair === null) return failure('object-not-found');
  let start = line.value.start + pair.openEnd;
  let end = line.value.start + pair.closeStart;
  if (parsed.around) {
    start = line.value.start + pair.openStart;
    end = line.value.start + pair.closeEnd;
    const trailing = scanWhitespace(context.snapshot, end, 'forward', context.options.maxScanUtf16);
    if (!trailing.ok) return trailing;
    if (trailing.value > end) end = trailing.value;
    else {
      const leading = scanWhitespace(context.snapshot, start, 'backward', context.options.maxScanUtf16);
      if (!leading.ok) return leading;
      start = leading.value;
    }
  }
  return { ok: true, value: { start, end, kind: 'characterwise' } };
}

function resolveBracket(
  context: TextContext,
  cursor: number,
  parsed: ParsedKey,
  count: number,
): Result<Range, VimTextObjectFailure> {
  const delimiter = parsed.delimiter;
  if (delimiter === undefined) return failure('invalid-key');
  const pairMap: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}', '<': '>' };
  const closer = pairMap[delimiter];
  if (closer === undefined) return failure('invalid-key');
  const window = scanWindow(context.snapshot, cursor, context.options.maxScanUtf16);
  if (!window.ok) return window;
  const pairs = bracketPairs(window.value, delimiter, closer, !context.options.cpOptions.includes('M'));
  let pair = choosePair(pairs, cursor - window.value.start);
  if (pair === null) {
    if (window.value.truncatedLeft || window.value.truncatedRight) return failure('scan-limit-exceeded');
    return failure('object-not-found');
  }
  if (count > 1) {
    let from = pair;
    for (let level = 1; level < count; level += 1) {
      const parent = pairs
        .filter((candidate) => candidate.openStart < from.openStart && candidate.closeEnd > from.closeEnd)
        .sort((left, right) => (left.closeEnd - left.openStart) - (right.closeEnd - right.openStart))[0];
      if (parent === undefined) break;
      from = parent;
    }
    pair = from;
  }
  const start = window.value.start + (parsed.around ? pair.openStart : pair.openEnd);
  const end = window.value.start + (parsed.around ? pair.closeEnd : pair.closeStart);
  if (!parsed.around && start === end) return failure('empty-object');
  if (window.value.truncatedLeft && start === window.value.start) return failure('scan-limit-exceeded');
  if (window.value.truncatedRight && end === window.value.end) return failure('scan-limit-exceeded');
  return { ok: true, value: { start, end, kind: 'characterwise' } };
}

function bracketPairs(window: ScanWindow, openChar: string, closeChar: string, honorEscapes: boolean): DelimiterPair[] {
  const stack: number[] = [];
  const pairs: DelimiterPair[] = [];
  for (let index = 0; index < window.text.length; index += 1) {
    const char = window.text[index];
    if (char !== openChar && char !== closeChar) continue;
    if (honorEscapes && isEscaped(window.text, index, '\\')) continue;
    if (char === openChar) stack.push(index);
    else {
      const opening = stack.pop();
      if (opening !== undefined) pairs.push({
        openStart: opening,
        openEnd: opening + 1,
        closeStart: index,
        closeEnd: index + 1,
      });
    }
  }
  return pairs;
}

function resolveTag(
  context: TextContext,
  cursor: number,
  parsed: ParsedKey,
  count: number,
): Result<Range, VimTextObjectFailure> {
  const window = scanWindow(context.snapshot, cursor, context.options.maxScanUtf16);
  if (!window.ok) return window;
  const pairs = tagPairs(window.value.text);
  let pair = chooseTagPair(pairs, cursor - window.value.start);
  if (pair === null) {
    if (window.value.truncatedLeft || window.value.truncatedRight) return failure('scan-limit-exceeded');
    return failure('object-not-found');
  }
  if (count > 1) {
    let from = pair;
    for (let level = 1; level < count; level += 1) {
      const parent = pairs
        .filter((candidate) => candidate.openStart < from.openStart && candidate.closeEnd > from.closeEnd)
        .sort((left, right) => (left.closeEnd - left.openStart) - (right.closeEnd - right.openStart))[0];
      if (parent === undefined) break;
      from = parent;
    }
    pair = from;
  }
  let start = window.value.start + (parsed.around ? pair.openStart : pair.contentStart);
  let end = window.value.start + (parsed.around ? pair.closeEnd : pair.closeStart);
  if (start === end) start = pair.openStart + window.value.start;
  if (window.value.truncatedLeft && start === window.value.start) return failure('scan-limit-exceeded');
  if (window.value.truncatedRight && end === window.value.end) return failure('scan-limit-exceeded');
  return { ok: true, value: { start, end, kind: 'characterwise' } };
}

function tagPairs(text: string): TagPair[] {
  const stack: { readonly name: string; readonly openStart: number; readonly contentStart: number }[] = [];
  const pairs: TagPair[] = [];
  let index = 0;
  while (index < text.length) {
    const opening = text.indexOf('<', index);
    if (opening < 0) break;
    const token = parseTag(text, opening);
    if (token === null) { index = opening + 1; continue; }
    index = token.end;
    if (token.selfClosing || VOID_TAGS.has(token.name)) continue;
    if (!token.closing) {
      stack.push({ name: token.name, openStart: opening, contentStart: token.end });
      continue;
    }
    let match = -1;
    for (let candidate = stack.length - 1; candidate >= 0; candidate -= 1) {
      if (stack[candidate]?.name === token.name) { match = candidate; break; }
    }
    if (match < 0) continue;
    const opener = stack[match];
    if (opener !== undefined) pairs.push({
      name: opener.name,
      openStart: opener.openStart,
      contentStart: opener.contentStart,
      closeStart: opening,
      closeEnd: token.end,
    });
    stack.length = match;
  }
  return pairs;
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function parseTag(text: string, start: number): { readonly name: string; readonly end: number; readonly closing: boolean; readonly selfClosing: boolean } | null {
  let index = start + 1;
  if (text[index] === '!' || text[index] === '?' || text[index] === undefined) return null;
  let closing = false;
  if (text[index] === '/') { closing = true; index += 1; }
  const nameStart = index;
  while (index < text.length && /[A-Za-z0-9:_-]/u.test(text[index] ?? '')) index += 1;
  if (index === nameStart || !/[A-Za-z]/u.test(text[nameStart] ?? '')) return null;
  const name = text.slice(nameStart, index).toLowerCase();
  let quote: string | null = null;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (quote !== null) {
      if (char === quote && !isEscaped(text, index, '\\')) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '>') {
      let prior = index - 1;
      while (prior > start && /\s/u.test(text[prior] ?? '')) prior -= 1;
      return { name, end: index + 1, closing, selfClosing: !closing && text[prior] === '/' };
    }
    index += 1;
  }
  return null;
}

function chooseTagPair(pairs: readonly TagPair[], cursor: number): TagPair | null {
  const containing = pairs
    .filter((pair) => pair.openStart <= cursor && cursor <= pair.closeEnd)
    .sort((left, right) => (left.closeEnd - left.openStart) - (right.closeEnd - right.openStart));
  if (containing[0] !== undefined) return containing[0];
  return [...pairs].filter((pair) => pair.openStart >= cursor)
    .sort((left, right) => left.openStart - right.openStart)[0] ?? null;
}

function choosePair(pairs: readonly DelimiterPair[], cursor: number): DelimiterPair | null {
  const containing = pairs
    .filter((pair) => pair.openStart <= cursor && cursor <= pair.closeStart)
    .sort((left, right) => (left.closeEnd - left.openStart) - (right.closeEnd - right.openStart));
  if (containing[0] !== undefined) return containing[0];
  return [...pairs].filter((pair) => pair.openStart >= cursor)
    .sort((left, right) => left.openStart - right.openStart)[0] ?? null;
}

function resolveOptions(options: VimTextObjectOptions): Result<ResolvedOptions, VimTextObjectFailure> {
  const isKeyword = options.isKeyword ?? DEFAULT_ISKEYWORD;
  const quoteEscape = options.quoteEscape ?? '\\';
  const cpOptions = options.cpOptions ?? 'aABceFs_';
  const paragraphs = options.paragraphs ?? DEFAULT_PARAGRAPHS;
  const maxScanUtf16 = options.maxScanUtf16 ?? DEFAULT_SCAN_UTF16;
  if (typeof isKeyword !== 'string' || typeof quoteEscape !== 'string'
    || typeof cpOptions !== 'string' || typeof paragraphs !== 'string'
    || !Number.isSafeInteger(maxScanUtf16) || maxScanUtf16 < 64 || maxScanUtf16 > MAX_SCAN_UTF16) {
    return failure('invalid-option');
  }
  return { ok: true, value: { isKeyword, quoteEscape, cpOptions, paragraphs, maxScanUtf16 } };
}

function parseKey(key: VimTextObjectKey): ParsedKey | null {
  if (typeof key !== 'string' || key.length !== 2) return null;
  const around = key[0] === 'a';
  if (!around && key[0] !== 'i') return null;
  const object = key[1];
  if (object === 'w' || object === 'W') return { around, family: 'word', key, big: object === 'W' };
  if (object === 's') return { around, family: 'sentence', key, big: false };
  if (object === 'p') return { around, family: 'paragraph', key, big: false };
  if (object === 't') return { around, family: 'tag', key, big: false };
  if (object === '"' || object === "'" || object === '`') return { around, family: 'quote', key, big: false, delimiter: object };
  const delimiter = object === 'b' || object === '(' || object === ')' ? '('
    : object === 'B' || object === '{' || object === '}' ? '{'
      : object === '[' || object === ']' ? '['
        : object === '<' || object === '>' ? '<' : undefined;
  return delimiter === undefined ? null : { around, family: 'bracket', key, big: false, delimiter };
}

function textObjectLineBounds(context: TextContext, index: number): Result<TextLine, VimTextObjectFailure> {
  if (!Number.isSafeInteger(index) || index < 0 || index >= context.snapshot.lineCount) return failure('invalid-cursor');
  const start = context.snapshot.lineStartOffset(index as LineIndex);
  if (!start.ok) return failure('document-read-failed');
  let end = context.snapshot.lengthUtf16;
  if (index + 1 < context.snapshot.lineCount) {
    const next = context.snapshot.lineStartOffset((index + 1) as LineIndex);
    if (!next.ok) return failure('document-read-failed');
    end = (next.value as number) - 1;
  }
  if (end - (start.value as number) > context.options.maxScanUtf16) return failure('scan-limit-exceeded');
  return { ok: true, value: { index, start: start.value as number, end } };
}

/** Small Unicode-safe reads; no retained whole-line strings for text objects. */
function textObjectWindow(snapshot: DocumentSnapshot, start: number, end: number): Result<string, VimTextObjectFailure> {
  const stop = Math.min(end, start + 256);
  let text = snapshot.slice(start as Utf16Offset, stop as Utf16Offset);
  if (!text.ok && text.error.kind === 'surrogate-split' && stop < end) {
    text = snapshot.slice(start as Utf16Offset, (stop - 1) as Utf16Offset);
  }
  return text.ok ? text : failure('document-read-failed');
}

function inspectParagraphLine(context: TextContext, index: number): Result<ParagraphLine, VimTextObjectFailure> {
  const cached = context.lineCache.get(index);
  if (cached !== undefined) return { ok: true, value: cached };
  const bounds = textObjectLineBounds(context, index);
  if (!bounds.ok) return bounds;
  let boundary = true;
  for (let at = bounds.value.start; at < bounds.value.end;) {
    const window = textObjectWindow(context.snapshot, at, bounds.value.end);
    if (!window.ok) return window;
    if (at === bounds.value.start && isParagraphMacro(window.value, context.options.paragraphs)) break;
    if (!/^\s*$/u.test(window.value)) { boundary = false; break; }
    at += window.value.length;
  }
  const result = Object.freeze({ ...bounds.value, boundary });
  context.lineCache.set(index, result);
  return { ok: true, value: result };
}

function lineStart(snapshot: DocumentSnapshot, index: number): Result<number, VimTextObjectFailure> {
  if (index === snapshot.lineCount) return { ok: true, value: snapshot.lengthUtf16 };
  if (!Number.isSafeInteger(index) || index < 0 || index >= snapshot.lineCount) return failure('document-read-failed');
  const result = snapshot.lineStartOffset(index as LineIndex);
  return result.ok ? { ok: true, value: result.value as number } : failure('document-read-failed');
}

function scanWindow(snapshot: DocumentSnapshot, center: number, limit: number): Result<ScanWindow, VimTextObjectFailure> {
  let start = Math.max(0, center - Math.floor(limit / 2));
  let end = Math.min(snapshot.lengthUtf16, start + limit);
  if (end === snapshot.lengthUtf16 && end - start < limit) start = Math.max(0, end - limit);
  while (start < end) {
    const startOffset = asOffset(start);
    const endOffset = asOffset(end);
    if (startOffset === null || endOffset === null) return failure('document-read-failed');
    const text = snapshot.slice(startOffset, endOffset);
    if (text.ok) return {
      ok: true,
      value: {
        start,
        end,
        text: text.value,
        truncatedLeft: start > 0,
        truncatedRight: end < snapshot.lengthUtf16,
      },
    };
    if (text.error.kind !== 'surrogate-split') return failure('document-read-failed');
    if (start > 0) start += 1;
    if (end < snapshot.lengthUtf16) end -= 1;
  }
  return failure('document-read-failed');
}

function whitespaceRegion(
  snapshot: DocumentSnapshot,
  offset: number,
  budget: number,
): Result<{ readonly start: number; readonly end: number }, VimTextObjectFailure> {
  const window = scanWindow(snapshot, offset, budget);
  if (!window.ok) return window;
  let start = offset - window.value.start;
  let end = start;
  while (start > 0 && isWhitespaceScalarBefore(window.value.text, start)) start -= previousScalarLength(window.value.text, start);
  while (end < window.value.text.length && isWhitespaceScalarAt(window.value.text, end)) end += scalarLength(window.value.text, end);
  if (start === 0 && window.value.truncatedLeft || end === window.value.text.length && window.value.truncatedRight) {
    return failure('scan-limit-exceeded');
  }
  return { ok: true, value: { start: window.value.start + start, end: window.value.start + end } };
}

function scanWhitespace(
  snapshot: DocumentSnapshot,
  offset: number,
  direction: 'forward' | 'backward',
  budget: number,
): Result<number, VimTextObjectFailure> {
  const window = scanWindow(snapshot, offset, budget);
  if (!window.ok) return window;
  let index = Math.max(0, Math.min(window.value.text.length, offset - window.value.start));
  if (direction === 'forward') {
    while (index < window.value.text.length && isWhitespaceScalarAt(window.value.text, index)) index += scalarLength(window.value.text, index);
    if (index === window.value.text.length && window.value.truncatedRight) return failure('scan-limit-exceeded');
  } else {
    while (index > 0 && isWhitespaceScalarBefore(window.value.text, index)) index -= previousScalarLength(window.value.text, index);
    if (index === 0 && window.value.truncatedLeft) return failure('scan-limit-exceeded');
  }
  return { ok: true, value: window.value.start + index };
}

function scanLineWhitespace(
  snapshot: DocumentSnapshot,
  offset: number,
  direction: 'forward' | 'backward',
): Result<number, VimTextObjectFailure> {
  const safeOffset = asOffset(offset);
  if (safeOffset === null) return failure('invalid-cursor');
  const lineIndex = snapshot.lineIndexAt(safeOffset);
  if (!lineIndex.ok) return failure('invalid-cursor');
  const bounds = lineBounds(snapshot, lineIndex.value as number);
  if (!bounds.ok) return bounds;
  let cursor = Math.max(bounds.value.start, Math.min(bounds.value.end, offset));
  if (direction === 'forward') {
    while (cursor < bounds.value.end) {
      const scalar = scalarAt(snapshot, cursor);
      if (!scalar.ok) return scalar;
      if (!/^\s$/u.test(scalar.value) || scalar.value === '\n' || scalar.value === '\r') break;
      cursor += scalar.value.length;
    }
  } else {
    while (cursor > bounds.value.start) {
      const scalar = scalarBefore(snapshot, cursor);
      if (!scalar.ok) return scalar;
      if (!/^\s$/u.test(scalar.value.text) || scalar.value.text === '\n' || scalar.value.text === '\r') break;
      cursor = scalar.value.start;
    }
  }
  return { ok: true, value: cursor };
}

function scalarAt(snapshot: DocumentSnapshot, offset: number): Result<string, VimTextObjectFailure> {
  const start = asOffset(offset);
  const oneEnd = asOffset(offset + 1);
  if (start === null || oneEnd === null || offset >= snapshot.lengthUtf16) return failure('invalid-cursor');
  const one = snapshot.slice(start, oneEnd);
  if (one.ok) return { ok: true, value: one.value };
  if (one.error.kind !== 'surrogate-split') return failure('document-read-failed');
  const twoEnd = asOffset(offset + 2);
  if (twoEnd === null) return failure('document-read-failed');
  const pair = snapshot.slice(start, twoEnd);
  return pair.ok && pair.value.length === 2 ? { ok: true, value: pair.value } : failure('document-read-failed');
}

function scalarBefore(snapshot: DocumentSnapshot, offset: number): Result<{ readonly start: number; readonly text: string }, VimTextObjectFailure> {
  if (offset <= 0) return failure('invalid-cursor');
  const start = asOffset(offset - 1);
  const end = asOffset(offset);
  if (start === null || end === null) return failure('document-read-failed');
  const one = snapshot.slice(start, end);
  if (one.ok) return { ok: true, value: { start: offset - 1, text: one.value } };
  if (one.error.kind !== 'surrogate-split' || offset < 2) return failure('document-read-failed');
  const pairStart = asOffset(offset - 2);
  if (pairStart === null) return failure('document-read-failed');
  const pair = snapshot.slice(pairStart, end);
  return pair.ok && pair.value.length === 2 ? { ok: true, value: { start: offset - 2, text: pair.value } } : failure('document-read-failed');
}

function nextGraphemeBoundary(snapshot: DocumentSnapshot, offset: number): Result<number, VimTextObjectFailure> {
  if (offset >= snapshot.lengthUtf16) return { ok: true, value: offset };
  const lineIndex = snapshot.lineIndexAt(asOffset(offset) as Utf16Offset);
  if (!lineIndex.ok) return failure('invalid-cursor');
  const line = lineBounds(snapshot, lineIndex.value as number);
  if (!line.ok) return line;
  const end = Math.min(line.value.end, offset + 128);
  const text = safeSlice(snapshot, offset, end);
  if (!text.ok) return text;
  try {
    if (GRAPHEME_SEGMENTER !== undefined) {
      const first = new GRAPHEME_SEGMENTER('und', { granularity: 'grapheme' }).segment(text.value)[Symbol.iterator]().next();
      if (!first.done) return { ok: true, value: offset + first.value.segment.length };
    }
  } catch { return failure('invalid-option'); }
  const scalar = scalarAt(snapshot, offset);
  return scalar.ok ? { ok: true, value: offset + scalar.value.length } : scalar;
}

function previousGraphemeStart(snapshot: DocumentSnapshot, end: number): Utf16Offset | null {
  if (end <= 0) return null;
  const lineIndex = snapshot.lineIndexAt(asOffset(end) as Utf16Offset);
  if (!lineIndex.ok) return null;
  const line = lineBounds(snapshot, lineIndex.value as number);
  if (!line.ok) return null;
  const start = Math.max(line.value.start, end - 128);
  const text = safeSlice(snapshot, start, end);
  if (!text.ok) return null;
  try {
    if (GRAPHEME_SEGMENTER !== undefined) {
      let last = 0;
      for (const part of new GRAPHEME_SEGMENTER('und', { granularity: 'grapheme' }).segment(text.value)) last = part.index;
      return asOffset(start + last);
    }
  } catch { return null; }
  const scalar = scalarBefore(snapshot, end);
  return scalar.ok ? asOffset(scalar.value.start) : null;
}

function firstGraphemeStart(snapshot: DocumentSnapshot, start: number): Utf16Offset | null {
  return asOffset(start);
}

function lineBounds(snapshot: DocumentSnapshot, index: number): Result<{ readonly start: number; readonly end: number }, VimTextObjectFailure> {
  const start = lineStart(snapshot, index);
  if (!start.ok) return start;
  let end = snapshot.lengthUtf16;
  if (index + 1 < snapshot.lineCount) {
    const next = lineStart(snapshot, index + 1);
    if (!next.ok) return next;
    end = next.value - 1;
  }
  return { ok: true, value: { start: start.value, end } };
}

function safeSlice(snapshot: DocumentSnapshot, start: number, end: number): Result<string, VimTextObjectFailure> {
  const startOffset = asOffset(start);
  const endOffset = asOffset(end);
  if (startOffset === null || endOffset === null || end < start) return failure('document-read-failed');
  const text = snapshot.slice(startOffset, endOffset);
  return text.ok ? { ok: true, value: text.value } : failure('document-read-failed');
}

function isEscaped(text: string, index: number, escapeChars: string): boolean {
  if (escapeChars.length === 0) return false;
  let count = 0;
  for (let probe = index - 1; probe >= 0 && escapeChars.includes(text[probe] ?? ''); probe -= 1) count += 1;
  return count % 2 === 1;
}

function isWhitespaceScalarAt(text: string, index: number): boolean {
  return /^\s$/u.test(String.fromCodePoint(text.codePointAt(index) ?? 0));
}
function isWhitespaceScalarBefore(text: string, end: number): boolean {
  return end > 0 && /^\s$/u.test(String.fromCodePoint(text.codePointAt(end - previousScalarLength(text, end)) ?? 0));
}
function scalarLength(text: string, index: number): number { return (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1; }
function previousScalarLength(text: string, end: number): number {
  const unit = text.charCodeAt(end - 1);
  return unit >= 0xdc00 && unit <= 0xdfff && end >= 2 ? 2 : 1;
}

function validOffset(snapshot: DocumentSnapshot, offset: Utf16Offset): boolean {
  return Number.isSafeInteger(offset) && (offset as number) >= 0 && (offset as number) <= snapshot.lengthUtf16
    && snapshot.slice(offset, offset).ok;
}

function asOffset(value: number): Utf16Offset | null {
  return Number.isSafeInteger(value) && value >= 0 ? value as Utf16Offset : null;
}

function failure(kind: VimTextObjectFailure['kind']): Result<never, VimTextObjectFailure> {
  return { ok: false, error: { kind } };
}
