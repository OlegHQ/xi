import type { DocumentEdit, DocumentSnapshot, LineIndex, Result, Utf16Offset } from '../../document/src/index';
import { defaultCellWidthPolicy } from '../../layout/src/index';
import {
  normalizeVimOperatorRange,
  type VimNormalizedOperatorRange,
  type VimOperatorRangeFailure,
  type VimOperatorRangeInput,
} from '../ranges/normalize';

export type VimCoreOperator = 'delete' | 'change' | 'yank';

export interface VimRepeatTarget {
  readonly operator: Exclude<VimCoreOperator, 'yank'>;
  readonly motionKey: string;
  readonly count: number;
  readonly forcedKind?: 'characterwise' | 'linewise' | 'blockwise';
}

export interface VimOperatorSessionState {
  readonly mode: 'normal' | 'insert';
  readonly repeatTarget: VimRepeatTarget | null;
}

export interface VimOperatorPreparationInput {
  readonly operator: VimCoreOperator;
  /** Range data from a successfully resolved motion, in the same source version. */
  readonly motion: Result<Omit<VimOperatorRangeInput, 'operator'>, VimOperatorMotionFailure>;
  readonly operatorCount?: number;
  readonly motionCount?: number;
  /** Doubled forms (`dd`, `cc`, `yy`) turn the multiplied count into line count. */
  readonly doubled?: boolean;
  readonly register?: string;
  readonly state: VimOperatorSessionState;
}

export type VimOperatorMotionFailure =
  | VimOperatorRangeFailure
  | { readonly kind: 'motion-failed'; readonly reason: string };

export interface VimOperatorRegisterEffect {
  readonly operation: 'delete' | 'change' | 'yank';
  readonly destination: string;
  readonly alsoUnnamed: boolean;
  readonly rotateNumbered: boolean;
  readonly lines: readonly string[];
  readonly type: string;
  /** True when an empty inner text-object change enters Insert without writing any register. */
  readonly noOp?: boolean;
}

export interface VimOperatorCursorIntent {
  /** Versioned UTF-16 anchor in the source snapshot; resolve after applying the edit plan. */
  readonly offset: Utf16Offset;
  readonly placement: 'normal-after-edit' | 'insert-gap' | 'preserve';
}

export interface VimOperatorPlan {
  readonly kind: 'prepared';
  readonly operator: VimCoreOperator;
  readonly range: VimNormalizedOperatorRange;
  /** UTF-16 document edits against `expectedVersion`; the document layer commits them. */
  readonly transaction: {
    readonly documentId: DocumentSnapshot['id'];
    readonly expectedVersion: DocumentSnapshot['version'];
    readonly edits: readonly DocumentEdit[];
  } | null;
  readonly registerEffect: VimOperatorRegisterEffect;
  readonly mode: 'normal' | 'insert';
  readonly cursorOffset: Utf16Offset;
  readonly cursorIntent: VimOperatorCursorIntent;
  readonly state: VimOperatorSessionState;
  readonly effectiveCount: number;
}

export interface VimFailedOperatorPlan {
  readonly kind: 'failed';
  readonly failure: VimOperatorMotionFailure;
  readonly transaction: null;
  readonly registerEffect: null;
  readonly state: VimOperatorSessionState;
}

export type VimOperatorPreparation = VimOperatorPlan | VimFailedOperatorPlan;

const EMPTY_INNER_TEXT_OBJECT_KEYS: ReadonlySet<string> = new Set([
  'iw', 'iW', 'is', 'ip', 'it', 'i"', "i'", 'i`', 'i(', 'i)', 'ib',
  'i[', 'i]', 'i{', 'i}', 'iB', 'i<', 'i>',
]);

/**
 * Prepare d/c/y effects without publishing text or editor state. A missing
 * motion is a no-op plan: the exact prior state/repeat object is retained.
 */
export function prepareVimOperator(
  snapshot: DocumentSnapshot,
  input: VimOperatorPreparationInput,
): Result<VimOperatorPreparation, VimOperatorCountFailure> {
  if (input.operator !== 'delete' && input.operator !== 'change' && input.operator !== 'yank') {
    return { ok: false, error: { kind: 'invalid-operator' } };
  }
  const operatorCount = input.operatorCount ?? 1;
  const motionCount = input.motionCount ?? 1;
  const product = multiplyVimOperatorCounts(operatorCount, motionCount);
  if (!product.ok) return product;
  if (input.state.mode !== 'normal' && input.state.mode !== 'insert') {
    return { ok: false, error: { kind: 'invalid-state' } };
  }

  if (!input.motion.ok) {
    return {
      ok: true,
      value: Object.freeze({
        kind: 'failed',
        failure: input.motion.error,
        transaction: null,
        registerEffect: null,
        state: input.state,
      }),
    };
  }

  const baseRange = input.motion.value;
  if (isEmptyInnerTextObjectMotion(baseRange)) {
    const endpointFailure = baseRange.origin.documentVersion !== snapshot.version
      || baseRange.target.documentVersion !== snapshot.version
      ? { kind: 'stale-document-version' as const }
      : !validMotionOffset(snapshot, baseRange.origin.offset) || !validMotionOffset(snapshot, baseRange.target.offset)
        ? { kind: 'invalid-endpoint' as const }
        : null;
    if (endpointFailure !== null) {
      return {
        ok: true,
        value: Object.freeze({
          kind: 'failed',
          failure: endpointFailure,
          transaction: null,
          registerEffect: null,
          state: input.state,
        }),
      };
    }
    const offset = baseRange.origin.offset;
    const range: VimNormalizedOperatorRange = Object.freeze({
      kind: 'characterwise',
      start: offset,
      end: offset,
      ranges: Object.freeze([]),
      registerLines: Object.freeze([]),
      registerType: 'v',
      insertionOffset: offset,
    });
    const mode = input.operator === 'change' ? 'insert' : 'normal';
    const nextRepeat = input.operator === 'yank' ? input.state.repeatTarget : Object.freeze({
      operator: input.operator,
      motionKey: baseRange.motionKey,
      count: product.value,
      ...(baseRange.forceKind === undefined ? {} : { forcedKind: baseRange.forceKind }),
    });
    const nextState = Object.freeze({ mode, repeatTarget: nextRepeat });
    const registerEffect: VimOperatorRegisterEffect = input.operator === 'yank'
      ? Object.freeze({
        operation: 'yank',
        destination: input.register ?? '0',
        alsoUnnamed: (input.register ?? '0') !== '_',
        rotateNumbered: false,
        lines: Object.freeze(['']),
        type: 'v',
        ...((input.register ?? '0') === '_' ? { noOp: true } : {}),
      })
      : Object.freeze({
        operation: input.operator,
        destination: '_',
        alsoUnnamed: false,
        rotateNumbered: false,
        lines: Object.freeze([]),
        type: 'v',
        noOp: true,
      });
    return {
      ok: true,
      value: Object.freeze({
        kind: 'prepared',
        operator: input.operator,
        range,
        transaction: null,
        registerEffect,
        mode,
        cursorOffset: offset,
        cursorIntent: Object.freeze({
          offset,
          placement: input.operator === 'change' ? 'insert-gap' as const
            : input.operator === 'yank' ? 'preserve' as const : 'normal-after-edit' as const,
        }),
        state: nextState,
        effectiveCount: product.value,
      }),
    };
  }

  const normalized = normalizeVimOperatorRange(snapshot, {
    ...baseRange,
    operator: input.operator,
    ...(input.doubled === true ? { lineCount: product.value } : {}),
  });
  if (!normalized.ok) {
    return {
      ok: true,
      value: Object.freeze({
        kind: 'failed',
        failure: normalized.error,
        transaction: null,
        registerEffect: null,
        state: input.state,
      }),
    };
  }

  const range = normalized.value;
  const editResult = input.operator === 'yank' ? [] : makeEdits(snapshot, range, input.operator);
  if (editResult === null) {
    return {
      ok: true,
      value: Object.freeze({
        kind: 'failed',
        failure: { kind: 'document-read-failed' } as VimOperatorMotionFailure,
        transaction: null,
        registerEffect: null,
        state: input.state,
      }),
    };
  }

  const registerEffect = makeRegisterEffect(input.operator, input.register, range);
  const mode = input.operator === 'change' ? 'insert' : 'normal';
  const nextRepeat = input.operator === 'yank'
    ? input.state.repeatTarget
    : Object.freeze({
      operator: input.operator,
      motionKey: baseRange.motionKey,
      count: product.value,
      ...(baseRange.forceKind === undefined ? {} : { forcedKind: baseRange.forceKind }),
    });
  const nextState = Object.freeze({ mode, repeatTarget: nextRepeat });
  const cursorOffset = cursorAfterOperator(snapshot, baseRange, range, input.operator);
  return {
    ok: true,
    value: Object.freeze({
      kind: 'prepared',
      operator: input.operator,
      range,
      transaction: editResult.length === 0 ? null : Object.freeze({
        documentId: snapshot.id,
        expectedVersion: snapshot.version,
        edits: Object.freeze(editResult),
      }),
      registerEffect,
      mode,
      cursorOffset,
      cursorIntent: Object.freeze({
        offset: cursorOffset,
        placement: input.operator === 'yank' ? 'preserve'
          : input.operator === 'change' ? 'insert-gap' : 'normal-after-edit',
      }),
      state: nextState,
      effectiveCount: product.value,
    }),
  };
}

function isEmptyInnerTextObjectMotion(motion: Omit<VimOperatorRangeInput, 'operator'>): boolean {
  return motion.motionKind === 'characterwise'
    && motion.origin.offset === motion.target.offset
    && EMPTY_INNER_TEXT_OBJECT_KEYS.has(motion.motionKey);
}

function validMotionOffset(snapshot: DocumentSnapshot, offset: Utf16Offset): boolean {
  const value = offset as number;
  return Number.isSafeInteger(value) && value >= 0 && value <= snapshot.lengthUtf16
    && snapshot.slice(offset, offset).ok;
}

export interface VimOperatorCountFailure {
  readonly kind: 'invalid-count' | 'count-overflow' | 'invalid-operator' | 'invalid-state';
}

/** Multiply the two independently entered counts without overflow or rounding. */
export function multiplyVimOperatorCounts(operatorCount: number, motionCount: number): Result<number, VimOperatorCountFailure> {
  if (!Number.isSafeInteger(operatorCount) || operatorCount < 1
    || !Number.isSafeInteger(motionCount) || motionCount < 1) {
    return { ok: false, error: { kind: 'invalid-count' } };
  }
  const product = operatorCount * motionCount;
  if (!Number.isSafeInteger(product)) return { ok: false, error: { kind: 'count-overflow' } };
  return { ok: true, value: product };
}

function makeEdits(
  snapshot: DocumentSnapshot,
  range: VimNormalizedOperatorRange,
  operator: VimCoreOperator,
): DocumentEdit[] | null {
  const edits: DocumentEdit[] = [];
  for (const item of range.ranges) {
    let start = item.start as number;
    let end = item.end as number;
    if (operator === 'change' && range.kind === 'linewise') {
      start = range.insertionOffset as number;
      if (end > start) {
        const lastCharacter = snapshot.slice((end - 1) as Utf16Offset, end as Utf16Offset);
        if (!lastCharacter.ok) return null;
        // Keep the selected line's separator. Insert-mode text replaces line
        // content after preserved indentation without joining the next row.
        if (lastCharacter.value === '\n') end -= 1;
      }
    }
    if (start === end && (item.replacementText ?? '') === '') continue;
    const current = snapshot.slice(start as Utf16Offset, end as Utf16Offset);
    if (!current.ok) return null;
    edits.push(Object.freeze({ start: start as Utf16Offset, end: end as Utf16Offset, text: item.replacementText ?? '' }));
  }
  edits.sort((left, right) => (left.start as number) - (right.start as number));
  return edits;
}

function makeRegisterEffect(
  operator: VimCoreOperator,
  requestedRegister: string | undefined,
  range: VimNormalizedOperatorRange,
): VimOperatorRegisterEffect {
  const hasNewline = range.registerLines.length > 1;
  const destination = requestedRegister ?? (operator === 'yank'
    ? '0'
    : range.kind === 'linewise' || hasNewline ? '1' : '-');
  return Object.freeze({
    operation: operator,
    destination,
    alsoUnnamed: destination !== '_',
    rotateNumbered: requestedRegister === undefined && operator !== 'yank' && destination === '1',
    lines: range.registerLines,
    type: range.registerType,
  });
}

function cursorAfterOperator(
  snapshot: DocumentSnapshot,
  motion: Omit<VimOperatorRangeInput, 'operator'>,
  range: VimNormalizedOperatorRange,
  operator: VimCoreOperator,
): Utf16Offset {
  if (operator === 'yank') return motion.origin.offset;
  if (operator === 'change') return range.insertionOffset;
  if (range.kind === 'blockwise') return range.start;
  if (range.kind === 'linewise') {
    const originColumn = motion.origin.displayCellColumn ?? 0;
    if ((range.end as number) < snapshot.lengthUtf16) {
      const nextLine = snapshot.lineIndexAt(range.end);
      if (nextLine.ok) return offsetAtDisplayColumn(
        snapshot,
        nextLine.value as number,
        originColumn,
        motion.tabSize ?? 8,
        motion.widthPolicy ?? defaultCellWidthPolicy(),
      ) ?? range.start;
    }
    const originLine = snapshot.lineIndexAt(motion.origin.offset);
    if (originLine.ok && (originLine.value as number) > 0) {
      return offsetAtDisplayColumn(
        snapshot,
        (originLine.value as number) - 1,
        originColumn,
        motion.tabSize ?? 8,
        motion.widthPolicy ?? defaultCellWidthPolicy(),
      ) ?? range.start;
    }
    return range.start;
  }
  return range.start;
}

function offsetAtDisplayColumn(
  snapshot: DocumentSnapshot,
  line: number,
  requestedCell: number,
  tabSize: number,
  widthPolicy: ReturnType<typeof defaultCellWidthPolicy>,
): Utf16Offset | null {
  const start = snapshot.lineStartOffset(line as LineIndex);
  if (!start.ok) return null;
  let end = snapshot.lengthUtf16;
  if (line + 1 < snapshot.lineCount) {
    const next = snapshot.lineStartOffset((line + 1) as LineIndex);
    if (next.ok) end = (next.value as number) - 1;
  } else if (end > (start.value as number)) {
    const finalNewline = snapshot.slice(((end - 1) as number) as Utf16Offset, end as Utf16Offset);
    if (finalNewline.ok && finalNewline.value === '\n') end -= 1;
  }
  const text = snapshot.slice(start.value, end as Utf16Offset);
  if (!text.ok || text.value.length === 0) return start.value;
  let cell = 0;
  let lastOffset = 0;
  if (typeof Intl.Segmenter === 'function') {
    for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.value)) {
      let width: number;
      try {
        width = part.segment === '\t' ? tabSize - (cell % tabSize) : Math.max(1, widthPolicy.widthOfCluster(part.segment));
      } catch {
        return null;
      }
      if (requestedCell < cell + width) return ((start.value as number) + part.index) as Utf16Offset;
      lastOffset = part.index;
      cell += width;
    }
  } else {
    return null;
  }
  return ((start.value as number) + lastOffset) as Utf16Offset;
}
