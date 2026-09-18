import type {
  DocumentSnapshot,
  DocumentId,
  DocumentVersion,
  LineIndex,
  Result,
  Utf16Offset,
} from '../../document/src/index.ts';
import {
  createVimMotionCursor,
  type VimMotionCursor,
  type VimMotionFailure,
  type VimMotionOptions,
} from './index';

export type VimFindKey = 'f' | 'F' | 't' | 'T' | ';' | ',';
export type VimFindDirectKey = 'f' | 'F' | 't' | 'T';
export type VimFindContext = 'normal' | 'operator-pending' | 'visual';

/** The last direct literal find attempt, including attempts with no match. */
export interface VimLastFind {
  readonly key: VimFindDirectKey;
  readonly target: string;
  /** Last matched target location is used only to avoid repeating a till target under the cursor. */
  readonly lastMatch?: {
    readonly documentId: DocumentId;
    readonly documentVersion: DocumentVersion;
    readonly offset: Utf16Offset;
  };
}

export interface VimFindInvocation {
  readonly key: VimFindKey;
  /** Exactly one grapheme target for f/F/t/T; omitted for ;/,. */
  readonly target?: string;
  /** Omitted means one. */
  readonly count?: number;
}

export interface VimFindOptions extends VimMotionOptions {
  readonly context?: VimFindContext;
}

export interface VimFindMotion {
  readonly kind: 'characterwise';
  /** The resolved cursor endpoint is included in operator ranges for all four find keys. */
  readonly inclusive: true;
  readonly key: VimFindDirectKey;
  readonly target: string;
}

export type VimFindRecovery = 'none' | 'cancel-operator' | 'preserve-visual-selection';

export type VimFindOutcome =
  | {
      readonly kind: 'found';
      readonly cursor: VimMotionCursor;
      readonly lastFind: VimLastFind;
      readonly motion: VimFindMotion;
      readonly moved: boolean;
    }
  | {
      readonly kind: 'no-match';
      readonly reason: 'target-not-found' | 'no-last-find';
      readonly cursor: VimMotionCursor;
      readonly lastFind: VimLastFind | null;
      readonly recovery: Exclude<VimFindRecovery, 'none'> | 'none';
    };

export type VimFindFailure = VimMotionFailure
  | { readonly kind: 'invalid-key' }
  | { readonly kind: 'invalid-character' }
  | { readonly kind: 'invalid-last-find' }
  | { readonly kind: 'invalid-context' };

interface Grapheme {
  readonly text: string;
  readonly offset: number;
}

const SEGMENTER = (Intl as typeof Intl & {
  readonly Segmenter?: new (locales?: string | readonly string[], options?: { readonly granularity: 'grapheme' }) => {
    segment(input: string): Iterable<{ readonly segment: string; readonly index: number }>;
  };
}).Segmenter;

/**
 * Resolve an f/F/t/T or repeat-find motion without mutating the document or editor state.
 * A direct find becomes the repeat target even when it has no match, matching Neovim 0.12.4.
 * The caller applies the returned context-specific recovery to operator and Visual state.
 */
export function resolveVimFind(
  snapshot: DocumentSnapshot,
  cursor: VimMotionCursor,
  invocation: VimFindInvocation,
  lastFind: VimLastFind | null,
  options: VimFindOptions = {},
): Result<VimFindOutcome, VimFindFailure> {
  if (cursor.documentVersion !== snapshot.version) return failure('stale-document-version');
  if (!Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 0
    || (cursor.offset as number) > snapshot.lengthUtf16
    || (cursor.desiredDisplayCellColumn !== null
      && (!Number.isSafeInteger(cursor.desiredDisplayCellColumn) || cursor.desiredDisplayCellColumn < 0))) {
    return failure('invalid-cursor');
  }
  if (!isFindKey(invocation.key)) return failure('invalid-key');
  const count = invocation.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1) return failure('invalid-count');
  const context = options.context ?? 'normal';
  if (context !== 'normal' && context !== 'operator-pending' && context !== 'visual') return failure('invalid-context');
  const resolvedLastFind = validateLastFind(lastFind);
  if (!resolvedLastFind.ok) return resolvedLastFind;

  let directKey: VimFindDirectKey;
  let target: string;
  let nextLastFind: VimLastFind;
  if (isDirectKey(invocation.key)) {
    if (typeof invocation.target !== 'string' || !isOneGrapheme(invocation.target)) return failure('invalid-character');
    directKey = invocation.key;
    target = invocation.target;
    nextLastFind = Object.freeze({ key: directKey, target });
  } else {
    if (invocation.target !== undefined) return failure('invalid-character');
    if (resolvedLastFind.value === null) {
      return {
        ok: true,
        value: Object.freeze({
          kind: 'no-match',
          reason: 'no-last-find',
          cursor,
          lastFind: null,
          recovery: recoveryFor(context),
        }),
      };
    }
    const opposite = invocation.key === ',';
    directKey = opposite ? reverseDirection(resolvedLastFind.value.key) : resolvedLastFind.value.key;
    target = resolvedLastFind.value.target;
    nextLastFind = resolvedLastFind.value;
  }

  const lineIndex = snapshot.lineIndexAt(cursor.offset);
  if (!lineIndex.ok) return failure('invalid-cursor');
  const startResult = snapshot.lineStartOffset(lineIndex.value as LineIndex);
  if (!startResult.ok) return failure('document-read-failed');
  const lineStart = startResult.value as number;
  let lineEnd = snapshot.lengthUtf16;
  if ((lineIndex.value as number) + 1 < snapshot.lineCount) {
    const nextLine = snapshot.lineStartOffset(((lineIndex.value as number) + 1) as LineIndex);
    if (!nextLine.ok) return failure('document-read-failed');
    lineEnd = (nextLine.value as number) - 1;
  }
  const localCursor = (cursor.offset as number) - lineStart;
  const lineLength = lineEnd - lineStart;
  if (localCursor < 0 || localCursor > lineLength) return failure('invalid-cursor');
  const cursorValid = validateGraphemeBoundary(snapshot, lineStart, lineLength, localCursor);
  if (!cursorValid.ok) return cursorValid;
  if (!cursorValid.value) return failure('invalid-cursor');

  const direction: 1 | -1 = directKey === 'f' || directKey === 't' ? 1 : -1;
  const previousMatchOffset = nextLastFind.lastMatch?.documentId === snapshot.id
    && nextLastFind.lastMatch.documentVersion === snapshot.version
    ? nextLastFind.lastMatch.offset as number
    : null;
  // Neovim only skips the immediately-adjacent till-target for a bare `;`/`,`
  // repeat (count 1); an explicit count finds the Nth match plainly,
  // including that adjacent one, and fails outright if fewer than N remain.
  const skipLastTillTarget = (invocation.key === ';' || invocation.key === ',') && count === 1
    && previousMatchOffset !== null && previousMatchOffset >= lineStart && previousMatchOffset < lineEnd
    ? previousMatchOffset - lineStart
    : null;
  const matchResult = direction === 1
    ? findNthMatchForward(snapshot, lineStart, lineLength, localCursor, target, skipLastTillTarget, count)
    : findNthMatchBackward(snapshot, lineStart, localCursor, target, skipLastTillTarget, count);
  if (!matchResult.ok) return matchResult;
  const match = matchResult.value;
  if (match === null) {
    return {
      ok: true,
      value: Object.freeze({
        kind: 'no-match',
        reason: 'target-not-found',
        cursor,
        lastFind: nextLastFind,
        recovery: recoveryFor(context),
      }),
    };
  }

  // Till motions stop immediately beside the found character. At a line boundary
  // Neovim's cursor remains on the closest valid grapheme.
  let localTargetResult: Result<number, VimFindFailure> = { ok: true, value: match.offset };
  if (directKey === 't') localTargetResult = previousGraphemeOffset(snapshot, lineStart, match.offset);
  else if (directKey === 'T') {
    const nextOffset = match.offset + match.text.length;
    localTargetResult = { ok: true, value: nextOffset < lineLength ? nextOffset : match.offset };
  }
  if (!localTargetResult.ok) return localTargetResult;
  const localTarget = localTargetResult.value;
  const absoluteTarget = safeOffset(lineStart + localTarget);
  if (absoluteTarget === null) return failure('invalid-cursor');
  const initialized = createVimMotionCursor(snapshot, absoluteTarget, options);
  if (!initialized.ok) return { ok: false, error: initialized.error };
  const nextCursor = initialized.value;
  nextLastFind = Object.freeze({
    key: nextLastFind.key,
    target: nextLastFind.target,
    lastMatch: Object.freeze({ documentId: snapshot.id, documentVersion: snapshot.version, offset: (match.offset + lineStart) as Utf16Offset }),
  });
  return {
    ok: true,
    value: Object.freeze({
      kind: 'found',
      cursor: nextCursor,
      lastFind: nextLastFind,
      motion: Object.freeze({ kind: 'characterwise', inclusive: true, key: directKey, target }),
      moved: nextCursor.offset !== cursor.offset,
    }),
  };
}

function validateLastFind(value: VimLastFind | null): Result<VimLastFind | null, VimFindFailure> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'object' || !isDirectKey(value.key) || !isOneGrapheme(value.target)) return failure('invalid-last-find');
  if (value.lastMatch !== undefined
    && (typeof value.lastMatch !== 'object'
      || typeof value.lastMatch.documentId !== 'string'
      || value.lastMatch.documentId.length === 0
      || !Number.isSafeInteger(value.lastMatch.documentVersion)
      || !Number.isSafeInteger(value.lastMatch.offset)
      || (value.lastMatch.offset as number) < 0)) return failure('invalid-last-find');
  return { ok: true, value: Object.freeze({
    key: value.key,
    target: value.target,
    ...(value.lastMatch === undefined ? {} : { lastMatch: Object.freeze({ ...value.lastMatch }) }),
  }) };
}

function isFindKey(value: unknown): value is VimFindKey {
  return value === 'f' || value === 'F' || value === 't' || value === 'T' || value === ';' || value === ',';
}

function isDirectKey(value: unknown): value is VimFindDirectKey {
  return value === 'f' || value === 'F' || value === 't' || value === 'T';
}

function reverseDirection(key: VimFindDirectKey): VimFindDirectKey {
  if (key === 'f') return 'F';
  if (key === 'F') return 'f';
  if (key === 't') return 'T';
  return 't';
}

function isOneGrapheme(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\n') || value.includes('\r')
    || hasUnpairedSurrogate(value) || SEGMENTER === undefined) return false;
  try {
    const segments = [...new SEGMENTER('und', { granularity: 'grapheme' }).segment(value)];
    return segments.length === 1 && segments[0]?.segment === value;
  } catch {
    return false;
  }
}

function segment(value: string): readonly Grapheme[] | null {
  if (SEGMENTER === undefined) return null;
  try {
    return [...new SEGMENTER('und', { granularity: 'grapheme' }).segment(value)]
      .map((entry) => ({ text: entry.segment, offset: entry.index }));
  } catch {
    return null;
  }
}

const INITIAL_FIND_WINDOW = 256;

/** Segments only `[absStart, absEnd)`, offsets relative to `absStart`. Uses a plain per-code-unit split for a printable-ASCII window. */
function segmentWindow(snapshot: DocumentSnapshot, absStart: number, absEnd: number): readonly Grapheme[] | null {
  if (absEnd <= absStart) return [];
  const asciiCheck = snapshot.isPrintableAsciiRange?.(absStart as Utf16Offset, absEnd as Utf16Offset);
  const sliceResult = snapshot.slice(absStart as Utf16Offset, absEnd as Utf16Offset);
  if (!sliceResult.ok) return null;
  if (asciiCheck !== undefined && asciiCheck.ok && asciiCheck.value) {
    const text = sliceResult.value;
    const graphemes: Grapheme[] = [];
    for (let index = 0; index < text.length; index += 1) graphemes.push({ text: text[index] as string, offset: index });
    return graphemes;
  }
  return segment(sliceResult.value);
}

/**
 * Nudges an absolute window boundary so it never splits a surrogate pair.
 * `min`/`max` are boundaries already known safe (line starts and line/document
 * ends never split a pair). When `candidate` would split one, this rounds down
 * by one unit: a shrinking upper bound loses only the trailing low surrogate
 * (picked up on the next, larger window), and a growing lower bound gains the
 * leading high surrogate, so the pair stays intact either way.
 */
function safeBoundary(snapshot: DocumentSnapshot, candidate: number, min: number, max: number): number {
  const clamped = Math.max(min, Math.min(max, candidate));
  if (clamped <= min || clamped >= max) return clamped;
  const check = snapshot.slice((clamped - 1) as Utf16Offset, (clamped + 1) as Utf16Offset);
  if (check.ok && check.value.length === 2) {
    const high = check.value.charCodeAt(0);
    const low = check.value.charCodeAt(1);
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) return clamped - 1;
  }
  return clamped;
}

/** Confirms `localOffset` sits on a grapheme boundary within the line, growing the checked window outward as needed. */
function validateGraphemeBoundary(
  snapshot: DocumentSnapshot,
  lineStart: number,
  lineLength: number,
  localOffset: number,
): Result<boolean, VimFindFailure> {
  if (localOffset === 0 && lineLength === 0) return { ok: true, value: true };
  const lineEndAbs = lineStart + lineLength;
  let windowSize = 64;
  for (;;) {
    const start = safeBoundary(snapshot, lineStart + Math.max(0, localOffset - windowSize), lineStart, lineEndAbs) - lineStart;
    const end = safeBoundary(snapshot, lineStart + Math.min(lineLength, localOffset + windowSize), lineStart, lineEndAbs) - lineStart;
    const graphemes = segmentWindow(snapshot, lineStart + start, lineStart + end);
    if (graphemes === null) return failure('invalid-width-policy');
    if (graphemes.some((part) => start + part.offset === localOffset)) return { ok: true, value: true };
    if (start === 0 && end === lineLength) return { ok: true, value: false };
    windowSize *= 2;
  }
}

/** Finds the count-th matching grapheme after `localCursor`, growing the scan window outward until found or the line ends. */
function findNthMatchForward(
  snapshot: DocumentSnapshot,
  lineStart: number,
  lineLength: number,
  localCursor: number,
  target: string,
  skipLastTillTarget: number | null,
  count: number,
): Result<Grapheme | null, VimFindFailure> {
  const absCursor = lineStart + localCursor;
  const lineEndAbs = lineStart + lineLength;
  let windowSize = INITIAL_FIND_WINDOW;
  for (;;) {
    const end = safeBoundary(snapshot, Math.min(lineEndAbs, absCursor + windowSize), absCursor, lineEndAbs);
    const graphemes = segmentWindow(snapshot, absCursor, end);
    if (graphemes === null) return failure('invalid-width-policy');
    const matches = graphemes
      .map((part) => ({ text: part.text, offset: localCursor + part.offset }))
      .filter((part) => part.offset > localCursor && targetMatches(part.text, target) && part.offset !== skipLastTillTarget);
    if (matches.length >= count) return { ok: true, value: matches[count - 1] ?? null };
    if (end >= lineEndAbs) return { ok: true, value: null };
    windowSize *= 2;
  }
}

/** Finds the count-th matching grapheme before `localCursor`, growing the scan window outward until found or the line starts. */
function findNthMatchBackward(
  snapshot: DocumentSnapshot,
  lineStart: number,
  localCursor: number,
  target: string,
  skipLastTillTarget: number | null,
  count: number,
): Result<Grapheme | null, VimFindFailure> {
  const absCursor = lineStart + localCursor;
  let windowSize = INITIAL_FIND_WINDOW;
  for (;;) {
    const start = safeBoundary(snapshot, Math.max(lineStart, absCursor - windowSize), lineStart, absCursor);
    const graphemes = segmentWindow(snapshot, start, absCursor);
    if (graphemes === null) return failure('invalid-width-policy');
    const startLocal = start - lineStart;
    const matches = graphemes
      .map((part) => ({ text: part.text, offset: startLocal + part.offset }))
      .filter((part) => part.offset < localCursor && targetMatches(part.text, target) && part.offset !== skipLastTillTarget)
      .reverse();
    if (matches.length >= count) return { ok: true, value: matches[count - 1] ?? null };
    if (start <= lineStart) return { ok: true, value: null };
    windowSize *= 2;
  }
}

/** Local offset of the grapheme immediately before `matchLocalOffset`, growing the lookback window as needed. Falls back to the match itself if none exists. */
function previousGraphemeOffset(snapshot: DocumentSnapshot, lineStart: number, matchLocalOffset: number): Result<number, VimFindFailure> {
  const absMatch = lineStart + matchLocalOffset;
  let windowSize = 8;
  for (;;) {
    const start = safeBoundary(snapshot, Math.max(lineStart, absMatch - windowSize), lineStart, absMatch);
    const graphemes = segmentWindow(snapshot, start, absMatch);
    if (graphemes === null) return failure('invalid-width-policy');
    if (graphemes.length > 0) {
      const last = graphemes[graphemes.length - 1];
      return { ok: true, value: (start - lineStart) + (last?.offset ?? 0) };
    }
    if (start <= lineStart) return { ok: true, value: matchLocalOffset };
    windowSize *= 2;
  }
}

function targetMatches(candidate: string, target: string): boolean {
  if (candidate === target) return true;
  // Vim permits an uncomposed base-character argument to find a grapheme whose
  // composing marks follow that base. An explicitly composed argument is exact.
  const targetScalars = [...target];
  if (targetScalars.length !== 1 || !candidate.startsWith(target)) return false;
  const composingTail = candidate.slice(target.length);
  return composingTail.length > 0 && [...composingTail].every((scalar) => /\p{M}/u.test(scalar));
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function recoveryFor(context: VimFindContext): VimFindRecovery {
  if (context === 'operator-pending') return 'cancel-operator';
  if (context === 'visual') return 'preserve-visual-selection';
  return 'none';
}

function safeOffset(value: number): Utf16Offset | null {
  return Number.isSafeInteger(value) && value >= 0 ? value as Utf16Offset : null;
}

function failure(kind: VimFindFailure['kind']): Result<never, VimFindFailure> {
  return { ok: false, error: { kind } };
}
