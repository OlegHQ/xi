import type { DocumentEdit, DocumentSnapshot, Result, Utf16Offset } from '../../document/src/index';
import type { VimOperatorSessionState } from './core';
import {
  prepareVimOperator,
  type VimOperatorMotionFailure,
  type VimOperatorPlan,
  type VimOperatorRegisterEffect,
} from './core';
import type { VimOperatorRangeInput } from '../ranges/normalize';
import { calculateVimVirtualReplace } from '../insert/index';

/** Direct change commands whose range is implied by the current cursor. */
export type VimDirectChangeKey = 's' | 'S' | 'C' | 'r' | 'x' | 'X' | 'D' | '~' | 'gr';

export interface VimDirectChangeInput {
  readonly snapshot: DocumentSnapshot;
  readonly key: VimDirectChangeKey;
  /** Zero-based UTF-16 cursor boundary in `snapshot`. */
  readonly cursorOffset: Utf16Offset;
  readonly count?: number;
  /** Replacement grapheme for `r` and `gr`; omitted for commands that enter Insert. */
  readonly replacement?: string;
  readonly state: VimOperatorSessionState;
  readonly expectedVersion?: DocumentSnapshot['version'];
}

export interface VimDirectChangePlan {
  readonly kind: 'prepared';
  readonly key: VimDirectChangeKey;
  readonly transaction: {
    readonly documentId: DocumentSnapshot['id'];
    readonly expectedVersion: DocumentSnapshot['version'];
    readonly edits: readonly DocumentEdit[];
  } | null;
  readonly mode: 'normal' | 'insert';
  readonly cursorOffset: Utf16Offset;
  readonly cursorIntent: {
    readonly offset: Utf16Offset;
    readonly placement: 'normal-after-edit' | 'insert-gap';
  };
  /** Register metadata for deleting/changing commands; `r` and no-ops write none. */
  readonly registerEffect: VimOperatorRegisterEffect | null;
  readonly state: VimOperatorSessionState;
  readonly count: number;
}

export type VimDirectChangeFailure =
  | { readonly kind: 'invalid-key' }
  | { readonly kind: 'invalid-count' }
  | { readonly kind: 'count-overflow' }
  | { readonly kind: 'invalid-state' }
  | { readonly kind: 'invalid-operator' }
  | { readonly kind: 'invalid-cursor' }
  | { readonly kind: 'invalid-replacement' }
  | { readonly kind: 'stale-document-version' }
  | { readonly kind: 'document-read-failed' }
  | { readonly kind: 'no-target' }
  | VimOperatorMotionFailure;

export type VimDirectChangeResult = Result<VimDirectChangePlan, VimDirectChangeFailure>;

/**
 * Prepare direct Normal-mode changes without publishing text or mode state.
 * Ranges and edits are expressed in UTF-16 boundaries on the supplied
 * immutable snapshot; the document owner commits the returned transaction.
 */
export function prepareVimDirectChange(input: VimDirectChangeInput): VimDirectChangeResult {
  if (!isDirectChangeKey(input.key)) return failure({ kind: 'invalid-key' });
  if (input.expectedVersion !== undefined && input.expectedVersion !== input.snapshot.version) {
    return failure({ kind: 'stale-document-version' });
  }
  if (input.state.mode !== 'normal') return failure({ kind: 'invalid-state' });
  const count = input.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1) return failure({ kind: 'invalid-count' });
  const cursor = input.cursorOffset as number;
  if (!isSafeOffset(input.snapshot, cursor)) return failure({ kind: 'invalid-cursor' });

  if (input.key === 'r') return prepareReplace(input, count, cursor);
  if (input.key === '~') return prepareToggle(input, count, cursor);
  if (input.key === 'gr') return prepareVirtualReplace(input, count, cursor);

  // `C`/`D` change/delete to end of line and genuinely need every boundary up
  // to it; `X` only looks backward; everything else only needs `count`
  // boundaries forward of the cursor.
  const forwardNeed = input.key === 'C' || input.key === 'D' ? Number.POSITIVE_INFINITY
    : input.key === 'X' || input.key === 'S' ? 0
      : count;
  const backwardNeed = input.key === 'X' ? count : 0;
  const boundaries = graphemeBoundariesOnLine(input.snapshot, cursor, forwardNeed, backwardNeed);
  if (!boundaries.ok) return failure(boundaries.error);
  const forward = boundaries.value.filter((boundary) => boundary.start >= cursor);
  if (input.key !== 'S' && input.key !== 'x' && input.key !== 'X' && input.key !== 'D' && forward.length === 0) {
    return emptyInsertPlan(input, count, cursor);
  }

  const motion = impliedMotion(input.snapshot, input.key, cursor, count, boundaries.value);
  if (!motion.ok) return failure(motion.error);
  if (motion.value === null) return noOpPlan(input, count, cursor);
  const prepared = prepareVimOperator(input.snapshot, {
    operator: input.key === 'x' || input.key === 'X' || input.key === 'D' ? 'delete' : 'change',
    motion: { ok: true, value: motion.value },
    operatorCount: 1,
    motionCount: count,
    doubled: input.key === 'S',
    state: input.state,
  });
  if (!prepared.ok) return failure(prepared.error);
  if (prepared.value.kind === 'failed') return failure(prepared.value.failure);
  return success(fromCorePlan(input.key, count, prepared.value));
}

function prepareVirtualReplace(input: VimDirectChangeInput, count: number, cursor: number): VimDirectChangeResult {
  const replacement = input.replacement;
  if (replacement === undefined || !isOneGrapheme(replacement) || replacement.includes('\n')) {
    return failure({ kind: 'invalid-replacement' });
  }
  // Keep a pathological count from allocating an unbounded replacement
  // payload on the synchronous keypress path.
  if (count > Math.floor(1_000_000 / Math.max(1, replacement.length))) return failure({ kind: 'count-overflow' });
  const line = lineWindow(input.snapshot, cursor);
  if (!line.ok) return failure(line.error);
  const text = input.snapshot.slice(line.value.start as Utf16Offset, line.value.end as Utf16Offset);
  if (!text.ok) return failure({ kind: 'document-read-failed' });
  const lastBoundary = text.value.length === 0
    ? undefined
    : graphemeBoundariesOnLine(input.snapshot, cursor, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  if (lastBoundary !== undefined && !lastBoundary.ok) return failure(lastBoundary.error);
  // Normal mode represents the end-of-line cursor on the final grapheme. An
  // empty line is the sole case where `gr` appends at the physical end.
  const localCursor = cursor >= line.value.end && lastBoundary?.ok === true
    ? (lastBoundary.value.at(-1)?.start ?? cursor) - line.value.start
    : cursor - line.value.start;
  const prepared = calculateVimVirtualReplace(text.value, localCursor, replacement.repeat(count), 8);
  const edit = Object.freeze({
    start: (line.value.start + (prepared.edit.start as number)) as Utf16Offset,
    end: (line.value.start + (prepared.edit.end as number)) as Utf16Offset,
    text: prepared.edit.text,
  });
  const hasEdit = edit.start !== edit.end || edit.text.length > 0;
  const nextCursor = (line.value.start + prepared.cursorAfter) as Utf16Offset;
  return success(Object.freeze({
    kind: 'prepared' as const,
    key: input.key,
    transaction: hasEdit ? Object.freeze({
      documentId: input.snapshot.id,
      expectedVersion: input.snapshot.version,
      edits: Object.freeze([edit]),
    }) : null,
    mode: 'normal' as const,
    cursorOffset: nextCursor,
    cursorIntent: Object.freeze({ offset: nextCursor, placement: 'normal-after-edit' as const }),
    registerEffect: null,
    state: input.state,
    count,
  }));
}

function prepareReplace(input: VimDirectChangeInput, count: number, cursor: number): VimDirectChangeResult {
  const replacement = input.replacement;
  if (replacement === undefined || !isOneGrapheme(replacement) || replacement.includes('\n')) {
    return failure({ kind: 'invalid-replacement' });
  }
  const boundaries = graphemeBoundariesOnLine(input.snapshot, cursor, count, 0);
  if (!boundaries.ok) return failure(boundaries.error);
  const available = boundaries.value.filter((boundary) => boundary.start >= cursor);
  const first = available[0];
  if (first === undefined) return failure({ kind: 'no-target' });
  const selected = available.slice(0, count);
  // Vim refuses `{count}r` entirely when fewer than `count` characters
  // remain on the line, rather than replacing whatever is left.
  if (selected.length === 0 || selected.length < count) return failure({ kind: 'no-target' });
  const last = selected[selected.length - 1];
  if (last === undefined) return failure({ kind: 'no-target' });
  const edit = Object.freeze({
    start: first.start as Utf16Offset,
    end: last.end as Utf16Offset,
    text: replacement.repeat(selected.length),
  });
  const nextCursor = last.start as Utf16Offset;
  return success(Object.freeze({
    kind: 'prepared' as const,
    key: input.key,
    transaction: Object.freeze({
      documentId: input.snapshot.id,
      expectedVersion: input.snapshot.version,
      edits: Object.freeze([edit]),
    }),
    mode: 'normal' as const,
    cursorOffset: nextCursor,
    cursorIntent: Object.freeze({ offset: nextCursor, placement: 'normal-after-edit' as const }),
    registerEffect: null,
    state: input.state,
    count,
  }));
}

function prepareToggle(input: VimDirectChangeInput, count: number, cursor: number): VimDirectChangeResult {
  const boundaries = graphemeBoundariesOnLine(input.snapshot, cursor, count, 0);
  if (!boundaries.ok) return failure(boundaries.error);
  const selected = boundaries.value.filter((boundary) => boundary.start >= cursor).slice(0, count);
  const first = selected[0];
  const last = selected[selected.length - 1];
  if (first === undefined || last === undefined) return noOpPlan(input, count, cursor);
  const source = input.snapshot.slice(first.start as Utf16Offset, last.end as Utf16Offset);
  if (!source.ok) return failure({ kind: 'document-read-failed' });
  const replacement = swapCase(source.value);
  const edits = replacement === source.value ? [] : [Object.freeze({
    start: first.start as Utf16Offset,
    end: last.end as Utf16Offset,
    text: replacement,
  })];
  // `~` advances the cursor past the last toggled character, unless that
  // character was the last one on the line (then the cursor stays on it).
  const toggleLine = lineWindow(input.snapshot, cursor);
  if (!toggleLine.ok) return failure(toggleLine.error);
  const nextCursor = (last.end < toggleLine.value.end ? last.end : last.start) as Utf16Offset;
  return success(Object.freeze({
    kind: 'prepared' as const,
    key: input.key,
    transaction: edits.length === 0 ? null : Object.freeze({
      documentId: input.snapshot.id,
      expectedVersion: input.snapshot.version,
      edits: Object.freeze(edits),
    }),
    mode: 'normal' as const,
    cursorOffset: nextCursor,
    cursorIntent: Object.freeze({ offset: nextCursor, placement: 'normal-after-edit' as const }),
    registerEffect: null,
    state: input.state,
    count,
  }));
}

function emptyInsertPlan(input: VimDirectChangeInput, count: number, cursor: number): VimDirectChangeResult {
  const offset = cursor as Utf16Offset;
  return success(Object.freeze({
    kind: 'prepared' as const,
    key: input.key,
    transaction: null,
    mode: 'insert' as const,
    cursorOffset: offset,
    cursorIntent: Object.freeze({ offset, placement: 'insert-gap' as const }),
    registerEffect: null,
    state: Object.freeze({ mode: 'insert' as const, repeatTarget: Object.freeze({ operator: 'change' as const, motionKey: input.key, count }) }),
    count,
  }));
}

function impliedMotion(
  snapshot: DocumentSnapshot,
  key: Exclude<VimDirectChangeKey, 'r' | '~' | 'gr'>,
  cursor: number,
  count: number,
  boundaries: readonly GraphemeBoundary[],
): Result<Omit<VimOperatorRangeInput, 'operator'> | null, VimDirectChangeFailure> {
  const line = lineWindow(snapshot, cursor);
  if (!line.ok) return line;
  // `{count}D`/`{count}C` delete to end of line, plus every full line below
  // it for count-1 additional lines (matches d$ with a multi-line `$`).
  if ((key === 'D' || key === 'C') && count > 1) {
    const lineIndex = snapshot.lineIndexAt(cursor as Utf16Offset);
    if (!lineIndex.ok) return failure({ kind: 'document-read-failed' });
    const targetIndex = Math.min((lineIndex.value as number) + count - 1, snapshot.lineCount - 1);
    // Every full line consumed by the count is removed whole, including its
    // trailing newline (not merged with the following line).
    if (targetIndex + 1 < snapshot.lineCount) {
      const nextLineStart = snapshot.lineStartOffset((targetIndex + 1) as typeof lineIndex.value);
      if (!nextLineStart.ok) return failure({ kind: 'document-read-failed' });
      return {
        ok: true,
        value: {
          origin: endpoint(snapshot, cursor),
          target: endpoint(snapshot, nextLineStart.value as number),
          direction: 'forward',
          motionKind: 'characterwise',
          inclusive: false,
          consumeTrailingNewline: true,
          motionKey: '$',
        },
      };
    }
    const targetStart = snapshot.lineStartOffset(targetIndex as typeof lineIndex.value);
    if (!targetStart.ok) return failure({ kind: 'document-read-failed' });
    const targetBoundaries = graphemeBoundariesOnLine(snapshot, targetStart.value as number, Number.POSITIVE_INFINITY, 0);
    if (!targetBoundaries.ok) return targetBoundaries;
    const targetLast = targetBoundaries.value.at(-1);
    const targetOffset = targetLast === undefined ? (targetStart.value as number) : targetLast.start;
    return {
      ok: true,
      value: {
        origin: endpoint(snapshot, cursor),
        target: endpoint(snapshot, targetOffset),
        direction: 'forward',
        motionKind: 'characterwise',
        inclusive: true,
        motionKey: '$',
      },
    };
  }
  if (key === 'S') {
    return {
      ok: true,
      value: {
        origin: endpoint(snapshot, cursor),
        target: endpoint(snapshot, cursor),
        direction: 'forward',
        motionKind: 'linewise',
        inclusive: true,
        motionKey: 'S',
        forceKind: 'linewise',
        lineCount: count,
      },
    };
  }
  const forward = boundaries.filter((boundary) => boundary.start >= cursor);
  if (key === 'X') {
    const previous = boundaries.filter((boundary) => boundary.end <= cursor);
    if (previous.length === 0) return { ok: true, value: null };
    const selected = previous.slice(Math.max(0, previous.length - count));
    const first = selected[0];
    if (first === undefined) return { ok: true, value: null };
    return {
      ok: true,
      value: {
        origin: endpoint(snapshot, cursor),
        target: endpoint(snapshot, first.start),
        direction: 'backward',
        motionKind: 'characterwise',
        // X removes characters immediately before the cursor and excludes
        // the character under it.  The central normalizer therefore receives
        // an exclusive reverse range [target, origin).
        inclusive: false,
        motionKey: 'X',
      },
    };
  }
  if (forward.length === 0) {
    if (key === 'D' || key === 'x') return { ok: true, value: null };
    // Vim keeps an empty line and still enters Insert for `s`/`C`.
    return {
      ok: true,
      value: {
        origin: endpoint(snapshot, cursor), target: endpoint(snapshot, cursor),
        direction: 'forward', motionKind: 'characterwise', inclusive: false,
        motionKey: key === 'C' ? '$' : 'l',
      },
    };
  }
  const selected = key === 'C' || key === 'D' ? forward.slice(0) : forward.slice(0, count);
  const last = selected[selected.length - 1];
  if (last === undefined) return failure({ kind: 'no-target' });
  return {
    ok: true,
    value: {
      origin: endpoint(snapshot, cursor),
      target: endpoint(snapshot, last.start),
      direction: 'forward',
      motionKind: 'characterwise',
      inclusive: true,
      motionKey: key === 'C' || key === 'D' ? '$' : 'l',
    },
  };
}

function fromCorePlan(key: Exclude<VimDirectChangeKey, 'r'>, count: number, plan: VimOperatorPlan): VimDirectChangePlan {
  return Object.freeze({
    kind: 'prepared' as const,
    key,
    transaction: plan.transaction,
    mode: plan.mode,
    cursorOffset: plan.cursorOffset,
    cursorIntent: Object.freeze({
      offset: plan.cursorIntent.offset,
      placement: plan.cursorIntent.placement === 'insert-gap' ? 'insert-gap' as const : 'normal-after-edit' as const,
    }),
    registerEffect: plan.registerEffect,
    state: plan.state,
    count,
  });
}

function noOpPlan(input: VimDirectChangeInput, count: number, cursor: number): VimDirectChangeResult {
  return success(Object.freeze({
    kind: 'prepared' as const,
    key: input.key,
    transaction: null,
    mode: 'normal' as const,
    cursorOffset: cursor as Utf16Offset,
    cursorIntent: Object.freeze({ offset: cursor as Utf16Offset, placement: 'normal-after-edit' as const }),
    registerEffect: null,
    state: input.state,
    count,
  }));
}

interface GraphemeBoundary { readonly start: number; readonly end: number }

const GRAPHEME_BOUNDARY_SEGMENTER = (Intl as typeof Intl & {
  readonly Segmenter?: new (
    _locales?: string | readonly string[],
    _options?: { readonly granularity: 'grapheme' },
  ) => { segment(value: string): Iterable<{ readonly index: number; readonly segment: string }> };
}).Segmenter;
const GRAPHEME_BOUNDARY_SEGMENTER_INSTANCE = typeof GRAPHEME_BOUNDARY_SEGMENTER === 'function'
  ? new GRAPHEME_BOUNDARY_SEGMENTER(undefined, { granularity: 'grapheme' }) : undefined;

const GRAPHEME_WINDOW_BASE = 64;

/**
 * Grapheme boundaries near `position`, bounded to at most `forwardNeed`
 * boundaries at or after it and `backwardNeed` before it (either may be
 * `Number.POSITIVE_INFINITY` for "up to the line boundary", or `0` to skip
 * that side). Segmenting the whole line for every direct-change keystroke
 * made e.g. a single `x` cost O(line length); most keys only need a handful
 * of boundaries around the cursor, so this reads a small window and doubles
 * it (capped at the line bounds) only while it is short of what was asked.
 */
function graphemeBoundariesOnLine(
  snapshot: DocumentSnapshot,
  position: number,
  forwardNeed: number,
  backwardNeed: number,
): Result<readonly GraphemeBoundary[], VimDirectChangeFailure> {
  const line = lineWindow(snapshot, position);
  if (!line.ok) return line;
  const lineStart = line.value.start;
  const lineEnd = line.value.end;
  if (lineEnd === lineStart || (forwardNeed === 0 && backwardNeed === 0)) return success(Object.freeze([]));
  let isAsciiLine = false;
  if (typeof snapshot.isPrintableAsciiRange === 'function') {
    const asciiRange = snapshot.isPrintableAsciiRange(lineStart as Utf16Offset, lineEnd as Utf16Offset);
    if (!asciiRange.ok) return failure({ kind: 'document-read-failed' });
    isAsciiLine = asciiRange.value;
  }
  if (isAsciiLine) {
    // ASCII fast path: each code unit is its own single-width grapheme, so
    // boundaries are consecutive offsets and no text needs to be read.
    const from = backwardNeed === Number.POSITIVE_INFINITY ? lineStart : Math.max(lineStart, position - backwardNeed);
    const to = forwardNeed === Number.POSITIVE_INFINITY ? lineEnd : Math.min(lineEnd, position + forwardNeed);
    const result: GraphemeBoundary[] = [];
    for (let index = from; index < to; index += 1) result.push({ start: index, end: index + 1 });
    return success(Object.freeze(result));
  }
  const segmenter = GRAPHEME_BOUNDARY_SEGMENTER_INSTANCE;
  if (segmenter === undefined) return failure({ kind: 'document-read-failed' });
  let backwardWindow = backwardNeed === 0 ? 0 : GRAPHEME_WINDOW_BASE;
  let forwardWindow = forwardNeed === 0 ? 0 : GRAPHEME_WINDOW_BASE;
  for (;;) {
    const windowStart = backwardNeed === Number.POSITIVE_INFINITY ? lineStart : Math.max(lineStart, position - backwardWindow);
    const windowEnd = forwardNeed === Number.POSITIVE_INFINITY ? lineEnd : Math.min(lineEnd, position + forwardWindow);
    const text = snapshot.slice(windowStart as Utf16Offset, windowEnd as Utf16Offset);
    if (!text.ok) return failure({ kind: 'document-read-failed' });
    const result: GraphemeBoundary[] = [];
    for (const part of segmenter.segment(text.value)) {
      const start = windowStart + part.index;
      result.push({ start, end: start + part.segment.length });
    }
    const forwardCount = forwardNeed === 0 ? 0 : result.filter((boundary) => boundary.start >= position).length;
    const backwardCount = backwardNeed === 0 ? 0 : result.filter((boundary) => boundary.end <= position).length;
    const forwardSatisfied = forwardNeed === 0 || forwardCount >= forwardNeed || windowEnd >= lineEnd;
    const backwardSatisfied = backwardNeed === 0 || backwardCount >= backwardNeed || windowStart <= lineStart;
    if (forwardSatisfied && backwardSatisfied) return success(Object.freeze(result));
    if (!forwardSatisfied) forwardWindow *= 2;
    if (!backwardSatisfied) backwardWindow *= 2;
  }
}

// nvim (`.artifacts/oracle/nvim-linux-arm64/bin/nvim --headless --clean -u NONE -c
// 'normal g~~'` on "straße"): "STRAẞE" -- ß maps to U+1E9E (a single code point), never
// JS's full-mapping "SS", which would desync per-code-point offsets in the rest of the
// transformed range.
const UPPER_CASE_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({ ß: 'ẞ' });

function simpleUpperCase(character: string): string {
  const overridden = UPPER_CASE_OVERRIDES[character];
  if (overridden !== undefined) return overridden;
  const upper = character.toLocaleUpperCase('en-US');
  return [...upper].length === 1 ? upper : character;
}

function simpleLowerCase(character: string): string {
  const lower = character.toLocaleLowerCase('en-US');
  return [...lower].length === 1 ? lower : character;
}

function swapCase(value: string): string {
  const parts: string[] = [];
  for (const character of value) {
    const lower = simpleLowerCase(character);
    const upper = simpleUpperCase(character);
    parts.push(character === lower && character !== upper ? upper
      : character === upper && character !== lower ? lower
        : character);
  }
  return parts.join('');
}

function lineWindow(snapshot: DocumentSnapshot, cursor: number): Result<{ readonly start: number; readonly end: number }, VimDirectChangeFailure> {
  const index = snapshot.lineIndexAt(cursor as Utf16Offset);
  if (!index.ok) return failure({ kind: 'document-read-failed' });
  const start = snapshot.lineStartOffset(index.value);
  if (!start.ok) return failure({ kind: 'document-read-failed' });
  const next = index.value + 1 < snapshot.lineCount ? snapshot.lineStartOffset((index.value + 1) as typeof index.value) : null;
  if (next !== null && !next.ok) return failure({ kind: 'document-read-failed' });
  let end = next?.ok === true ? (next.value as number) - 1 : snapshot.lengthUtf16;
  if (end > (start.value as number)) {
    const final = snapshot.slice((end - 1) as Utf16Offset, end as Utf16Offset);
    if (!final.ok) return failure({ kind: 'document-read-failed' });
    if (final.value === '\n') end -= 1;
  }
  return success({ start: start.value as number, end });
}

function endpoint(snapshot: DocumentSnapshot, offset: number): VimOperatorRangeInput['origin'] {
  return { documentVersion: snapshot.version, offset: offset as Utf16Offset };
}

function isSafeOffset(snapshot: DocumentSnapshot, offset: number): boolean {
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= snapshot.lengthUtf16
    && snapshot.slice(offset as Utf16Offset, offset as Utf16Offset).ok;
}

function isOneGrapheme(value: string): boolean {
  if (GRAPHEME_BOUNDARY_SEGMENTER_INSTANCE === undefined || value.length === 0) return false;
  let count = 0;
  for (const _part of GRAPHEME_BOUNDARY_SEGMENTER_INSTANCE.segment(value)) count += 1;
  return count === 1;
}

function isDirectChangeKey(value: string): value is VimDirectChangeKey {
  return value === 's' || value === 'S' || value === 'C' || value === 'r'
    || value === 'x' || value === 'X' || value === 'D' || value === '~' || value === 'gr';
}

function success<T>(value: T): { readonly ok: true; readonly value: T } { return { ok: true, value }; }
function failure<E>(error: E): { readonly ok: false; readonly error: E } { return { ok: false, error }; }
