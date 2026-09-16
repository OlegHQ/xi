import type { CancellationToken, Result } from '../../contracts/src/index';
import type { DocumentEdit, DocumentSnapshot, LineIndex, Utf16Offset } from '../../document/src/index';
import type { VimNormalizedOperatorRange } from '../ranges/normalize';

/** Operators whose effects are supplied by a typed host/provider boundary. */
export type VimFilterOperator = '!';
export type VimFoldOperator = 'zf' | 'zF' | 'zD' | 'zE';
export type VimNumericOperator = '<C-A>' | '<C-X>';
export type VimAdvancedOperator = VimFilterOperator | VimFoldOperator | VimNumericOperator;

export interface VimAdvancedHistoryEffect {
  readonly kind: 'single-command';
  readonly breaksInsert: true;
}

export interface VimAdvancedRegisterEffect {
  readonly kind: 'preserve';
}

export interface VimAdvancedTransaction {
  readonly documentId: DocumentSnapshot['id'];
  readonly expectedVersion: DocumentSnapshot['version'];
  readonly edits: readonly DocumentEdit[];
}

export interface VimAdvancedCursorIntent {
  readonly offset: Utf16Offset;
  readonly placement: 'preserve' | 'normal-after-edit';
}

export interface VimFilterOutput {
  /** Normalized UTF-16 text returned by the provider. */
  readonly text: string;
  /** A nonzero command exit is a provider failure; it never becomes an edit. */
  readonly exitCode?: number;
}

export type VimFilterProviderFailure =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed'; readonly message: string };

export interface VimFilterProviderContext {
  readonly snapshot: DocumentSnapshot;
  readonly range: VimNormalizedOperatorRange;
  /** An argv tuple keeps shell parsing outside the Vim owner. */
  readonly argv: readonly [string, ...string[]];
  readonly outputLimitBytes: number;
}

export interface VimFilterProvider {
  readonly id: string;
  readonly provide: (
    context: VimFilterProviderContext,
  ) => Result<VimFilterOutput, VimFilterProviderFailure> | Promise<Result<VimFilterOutput, VimFilterProviderFailure>>;
}

export interface VimFilterInput {
  readonly operator: VimFilterOperator;
  readonly snapshot: DocumentSnapshot;
  readonly range: VimNormalizedOperatorRange;
  readonly argv: readonly [string, ...string[]];
  readonly provider?: VimFilterProvider;
  readonly outputLimitBytes?: number;
  readonly expectedVersion?: DocumentSnapshot['version'];
  readonly cancellation?: CancellationToken;
  readonly isCancelled?: () => boolean;
}

export type VimFoldChange =
  | {
    readonly kind: 'create' | 'delete' | 'open' | 'close';
    readonly startLine: LineIndex;
    readonly endLineExclusive: LineIndex;
  }
  | { readonly kind: 'clear' };

export interface VimFoldProviderContext {
  readonly snapshot: DocumentSnapshot;
  readonly range: VimNormalizedOperatorRange;
  readonly operator: VimFoldOperator;
  readonly count: number;
}

export type VimFoldProviderFailure =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed'; readonly message: string };

export interface VimFoldProviderOutput {
  readonly changes: readonly VimFoldChange[];
}

export interface VimFoldProvider {
  readonly id: string;
  readonly provide: (
    context: VimFoldProviderContext,
  ) => Result<VimFoldProviderOutput, VimFoldProviderFailure> | Promise<Result<VimFoldProviderOutput, VimFoldProviderFailure>>;
}

export interface VimFoldInput {
  readonly operator: VimFoldOperator;
  readonly snapshot: DocumentSnapshot;
  readonly range: VimNormalizedOperatorRange;
  readonly provider?: VimFoldProvider;
  readonly count?: number;
  readonly expectedVersion?: DocumentSnapshot['version'];
  readonly cancellation?: CancellationToken;
  readonly isCancelled?: () => boolean;
}

export interface VimNumericOptions {
  /** Vim's comma-separated nrformats option; defaults to `bin,hex`. */
  readonly nrformats?: string;
}

export interface VimNumericInput {
  readonly operator: VimNumericOperator;
  readonly snapshot: DocumentSnapshot;
  readonly cursorOffset: Utf16Offset;
  readonly count?: number;
  readonly options?: VimNumericOptions;
  readonly expectedVersion?: DocumentSnapshot['version'];
  readonly cancellation?: CancellationToken;
  readonly isCancelled?: () => boolean;
}

export interface VimFilterPlan {
  readonly kind: 'prepared';
  readonly operator: VimFilterOperator;
  readonly transaction: VimAdvancedTransaction;
  readonly registerEffect: VimAdvancedRegisterEffect;
  readonly historyEffect: VimAdvancedHistoryEffect;
  readonly cursorIntent: VimAdvancedCursorIntent;
}

export interface VimFoldPlan {
  readonly kind: 'prepared';
  readonly operator: VimFoldOperator;
  readonly transaction: null;
  readonly foldChanges: readonly VimFoldChange[];
  readonly registerEffect: VimAdvancedRegisterEffect;
  readonly historyEffect: VimAdvancedHistoryEffect;
  readonly cursorIntent: VimAdvancedCursorIntent;
}

export interface VimNumericPlan {
  readonly kind: 'prepared';
  readonly operator: VimNumericOperator;
  readonly transaction: VimAdvancedTransaction | null;
  readonly registerEffect: VimAdvancedRegisterEffect;
  readonly historyEffect: VimAdvancedHistoryEffect;
  readonly cursorIntent: VimAdvancedCursorIntent;
}

export type VimAdvancedPlan = VimFilterPlan | VimFoldPlan | VimNumericPlan;

export type VimAdvancedFailure =
  | { readonly kind: 'invalid-operator' }
  | { readonly kind: 'invalid-input' }
  | { readonly kind: 'invalid-range' }
  | { readonly kind: 'stale-document-version' }
  | { readonly kind: 'document-read-failed' }
  | { readonly kind: 'provider-unavailable'; readonly provider: 'filter' | 'fold' }
  | { readonly kind: 'provider-failed'; readonly provider: 'filter' | 'fold'; readonly message: string }
  | { readonly kind: 'provider-invalid-output'; readonly provider: 'filter' | 'fold' }
  | { readonly kind: 'provider-output-limit'; readonly limitBytes: number }
  | { readonly kind: 'invalid-fold-region' }
  | { readonly kind: 'invalid-option' }
  | { readonly kind: 'numeric-not-found' }
  | { readonly kind: 'numeric-overflow' }
  | { readonly kind: 'cancelled' };

export type VimAdvancedResult<T> = Result<T, VimAdvancedFailure>;

const MAX_FILTER_OUTPUT_BYTES = 1_048_576;
const MAX_FILTER_ARGUMENTS = 256;
const MAX_FILTER_ARGUMENT_UNITS = 4096;
const MAX_FOLD_CHANGES = 4096;
const MAX_NUMERIC_DIGITS = 256;
const MAX_COUNT = 1_000_000;
const HISTORY = Object.freeze({ kind: 'single-command' as const, breaksInsert: true as const });
const REGISTER = Object.freeze({ kind: 'preserve' as const });
const CANCELLED = Symbol('cancelled');

/** Prepare one provider-backed filter/fold/numeric operator without mutating a document. */
export async function prepareVimAdvancedOperator(input: VimFilterInput | VimFoldInput | VimNumericInput): Promise<VimAdvancedResult<VimAdvancedPlan>> {
  if (input.operator === '!') return prepareVimFilterOperator(input);
  if (input.operator === 'zf' || input.operator === 'zF' || input.operator === 'zD' || input.operator === 'zE') {
    return prepareVimFoldOperator(input);
  }
  if (input.operator === '<C-A>' || input.operator === '<C-X>') return prepareVimNumericOperator(input);
  return { ok: false, error: { kind: 'invalid-operator' } };
}

export async function prepareVimFilterOperator(input: VimFilterInput): Promise<VimAdvancedResult<VimFilterPlan>> {
  const common = validateCommon(input.snapshot, input.expectedVersion, input.cancellation, input.isCancelled);
  if (!common.ok) return common;
  if (input.operator !== '!') return failure({ kind: 'invalid-operator' });
  if (!validRange(input.snapshot, input.range)) return failure({ kind: 'invalid-range' });
  if (!validArgv(input.argv)) return failure({ kind: 'invalid-input' });
  const limit = input.outputLimitBytes ?? MAX_FILTER_OUTPUT_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FILTER_OUTPUT_BYTES) {
    return failure({ kind: 'invalid-option' });
  }
  if (input.provider === undefined) return failure({ kind: 'provider-unavailable', provider: 'filter' });
  if (cancelled(input.cancellation, input.isCancelled)) return failure({ kind: 'cancelled' });

  let result: Result<VimFilterOutput, VimFilterProviderFailure> | typeof CANCELLED;
  try {
    result = await awaitCancellation(input.provider.provide(Object.freeze({
      snapshot: input.snapshot,
      range: input.range,
      argv: Object.freeze([...input.argv]) as unknown as readonly [string, ...string[]],
      outputLimitBytes: limit,
    })), input.cancellation);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'filter provider threw';
    return failure({ kind: 'provider-failed', provider: 'filter', message });
  }
  if (result === CANCELLED || cancelled(input.cancellation, input.isCancelled)) return failure({ kind: 'cancelled' });
  if (!result.ok) {
    return result.error.kind === 'unavailable'
      ? failure({ kind: 'provider-unavailable', provider: 'filter' })
      : failure({ kind: 'provider-failed', provider: 'filter', message: result.error.message });
  }
  if (!isWellFormedUtf16(result.value.text)) return failure({ kind: 'provider-invalid-output', provider: 'filter' });
  if (result.value.exitCode !== undefined
    && (!Number.isSafeInteger(result.value.exitCode) || result.value.exitCode !== 0)) {
    return failure({ kind: 'provider-failed', provider: 'filter', message: `command exited ${String(result.value.exitCode)}` });
  }
  if (new TextEncoder().encode(result.value.text).byteLength > limit) {
    return failure({ kind: 'provider-output-limit', limitBytes: limit });
  }
  const transaction = Object.freeze({
    documentId: input.snapshot.id,
    expectedVersion: input.snapshot.version,
    edits: Object.freeze([Object.freeze({ start: input.range.start, end: input.range.end, text: result.value.text })]),
  });
  return {
    ok: true,
    value: Object.freeze({
      kind: 'prepared',
      operator: input.operator,
      transaction,
      registerEffect: REGISTER,
      historyEffect: HISTORY,
      cursorIntent: Object.freeze({ offset: input.range.start, placement: 'normal-after-edit' as const }),
    }),
  };
}

export async function prepareVimFoldOperator(input: VimFoldInput): Promise<VimAdvancedResult<VimFoldPlan>> {
  const common = validateCommon(input.snapshot, input.expectedVersion, input.cancellation, input.isCancelled);
  if (!common.ok) return common;
  if (input.operator !== 'zf' && input.operator !== 'zF' && input.operator !== 'zD' && input.operator !== 'zE') {
    return failure({ kind: 'invalid-operator' });
  }
  if (!validRange(input.snapshot, input.range)) return failure({ kind: 'invalid-range' });
  const count = input.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_COUNT) return failure({ kind: 'invalid-option' });
  if (input.provider === undefined) return failure({ kind: 'provider-unavailable', provider: 'fold' });
  if (cancelled(input.cancellation, input.isCancelled)) return failure({ kind: 'cancelled' });
  let result: Result<VimFoldProviderOutput, VimFoldProviderFailure> | typeof CANCELLED;
  try {
    result = await awaitCancellation(input.provider.provide(Object.freeze({
      snapshot: input.snapshot, range: input.range, operator: input.operator, count,
    })), input.cancellation);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'fold provider threw';
    return failure({ kind: 'provider-failed', provider: 'fold', message });
  }
  if (result === CANCELLED || cancelled(input.cancellation, input.isCancelled)) return failure({ kind: 'cancelled' });
  if (!result.ok) {
    return result.error.kind === 'unavailable'
      ? failure({ kind: 'provider-unavailable', provider: 'fold' })
      : failure({ kind: 'provider-failed', provider: 'fold', message: result.error.message });
  }
  const checked = validateFoldChanges(input.snapshot, result.value.changes);
  if (!checked.ok) return checked;
  return {
    ok: true,
    value: Object.freeze({
      kind: 'prepared', operator: input.operator, transaction: null,
      foldChanges: checked.value, registerEffect: REGISTER, historyEffect: HISTORY,
      cursorIntent: Object.freeze({ offset: input.range.start, placement: 'preserve' as const }),
    }),
  };
}

export function prepareVimNumericOperator(input: VimNumericInput): VimAdvancedResult<VimNumericPlan> {
  const common = validateCommon(input.snapshot, input.expectedVersion, input.cancellation, input.isCancelled);
  if (!common.ok) return common;
  if (input.operator !== '<C-A>' && input.operator !== '<C-X>') return failure({ kind: 'invalid-operator' });
  const cursor = input.cursorOffset as number;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= input.snapshot.lengthUtf16) return failure({ kind: 'invalid-input' });
  const count = input.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_COUNT) return failure({ kind: 'invalid-option' });
  const options = parseNrformats(input.options?.nrformats);
  if (!options.ok) return options;
  if (cancelled(input.cancellation, input.isCancelled)) return failure({ kind: 'cancelled' });
  const lineResult = readLineAt(input.snapshot, input.cursorOffset);
  if (!lineResult.ok) return lineResult;
  const candidate = findNumber(lineResult.value.text, cursor - lineResult.value.start, options.value);
  if (candidate === null) return failure({ kind: 'numeric-not-found' });
  const changed = changeNumber(candidate, input.operator === '<C-A>' ? count : -count, options.value);
  if (!changed.ok) return changed;
  if (changed.value.text === candidate.text) {
    return {
      ok: true,
      value: Object.freeze({
        kind: 'prepared', operator: input.operator, transaction: null,
        registerEffect: REGISTER, historyEffect: HISTORY,
        cursorIntent: Object.freeze({ offset: input.cursorOffset, placement: 'preserve' as const }),
      }),
    };
  }
  const absoluteStart = (lineResult.value.start + candidate.start) as Utf16Offset;
  const absoluteEnd = (lineResult.value.start + candidate.end) as Utf16Offset;
  const edit = Object.freeze({ start: absoluteStart, end: absoluteEnd, text: changed.value.text });
  const newCursor = (lineResult.value.start + candidate.start + changed.value.cursorDelta) as Utf16Offset;
  return {
    ok: true,
    value: Object.freeze({
      kind: 'prepared', operator: input.operator,
      transaction: Object.freeze({ documentId: input.snapshot.id, expectedVersion: input.snapshot.version, edits: Object.freeze([edit]) }),
      registerEffect: REGISTER, historyEffect: HISTORY,
      cursorIntent: Object.freeze({ offset: newCursor, placement: 'normal-after-edit' as const }),
    }),
  };
}

function validateCommon(
  snapshot: DocumentSnapshot,
  expectedVersion: DocumentSnapshot['version'] | undefined,
  token: CancellationToken | undefined,
  predicate: (() => boolean) | undefined,
): VimAdvancedResult<null> {
  if (expectedVersion !== undefined && expectedVersion !== snapshot.version) return failure({ kind: 'stale-document-version' });
  if (snapshot.readOnly) return failure({ kind: 'document-read-failed' });
  if (cancelled(token, predicate)) return failure({ kind: 'cancelled' });
  return { ok: true, value: null };
}

function validRange(snapshot: DocumentSnapshot, range: VimNormalizedOperatorRange): boolean {
  const start = range.start as number;
  const end = range.end as number;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > snapshot.lengthUtf16) return false;
  if (range.ranges.length === 0) return false;
  for (const item of range.ranges) {
    if ((item.start as number) < start || (item.end as number) < (item.start as number)
      || (item.end as number) > end || !snapshot.slice(item.start, item.end).ok) return false;
  }
  return (start === end || snapshot.slice(range.start, range.end).ok);
}

function validArgv(argv: readonly [string, ...string[]]): boolean {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_FILTER_ARGUMENTS) return false;
  return argv.every((arg) => typeof arg === 'string' && arg.length > 0 && arg.length <= MAX_FILTER_ARGUMENT_UNITS)
    && isWellFormedUtf16(argv.join(''));
}

function validateFoldChanges(snapshot: DocumentSnapshot, changes: readonly VimFoldChange[]): VimAdvancedResult<readonly VimFoldChange[]> {
  if (!Array.isArray(changes) || changes.length > MAX_FOLD_CHANGES) return failure({ kind: 'provider-invalid-output', provider: 'fold' });
  const checked: VimFoldChange[] = [];
  let clearCount = 0;
  for (const change of changes) {
    if (typeof change !== 'object' || change === null) return failure({ kind: 'provider-invalid-output', provider: 'fold' });
    if (change.kind === 'clear') {
      clearCount += 1;
      if (clearCount > 1) return failure({ kind: 'invalid-fold-region' });
      checked.push(Object.freeze({ kind: 'clear' }));
      continue;
    }
    if (change.kind !== 'create' && change.kind !== 'delete' && change.kind !== 'open' && change.kind !== 'close') {
      return failure({ kind: 'provider-invalid-output', provider: 'fold' });
    }
    const start = change.startLine as number;
    const end = change.endLineExclusive as number;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > snapshot.lineCount) {
      return failure({ kind: 'invalid-fold-region' });
    }
    checked.push(Object.freeze({ kind: change.kind, startLine: change.startLine, endLineExclusive: change.endLineExclusive }));
  }
  return { ok: true, value: Object.freeze(checked) };
}

function readLineAt(snapshot: DocumentSnapshot, offset: Utf16Offset): Result<{ readonly start: number; readonly text: string }, VimAdvancedFailure> {
  const line = snapshot.lineIndexAt(offset);
  if (!line.ok) return failure({ kind: 'document-read-failed' });
  const start = snapshot.lineStartOffset(line.value);
  if (!start.ok) return failure({ kind: 'document-read-failed' });
  const nextLine = (line.value as number) + 1;
  const end = nextLine < snapshot.lineCount
    ? snapshot.lineStartOffset(nextLine as LineIndex)
    : { ok: true as const, value: snapshot.lengthUtf16 as Utf16Offset };
  if (!end.ok) return failure({ kind: 'document-read-failed' });
  const contentEnd = nextLine < snapshot.lineCount ? (end.value as number - 1) as Utf16Offset : end.value;
  const text = snapshot.slice(start.value, contentEnd);
  return text.ok ? { ok: true, value: { start: start.value as number, text: text.value } }
    : failure({ kind: 'document-read-failed' });
}

interface NumberCandidate {
  readonly kind: 'number' | 'alpha';
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly base: 2 | 8 | 10 | 16 | null;
  readonly prefix: string;
  readonly digitText: string;
  readonly sign: string;
  readonly alphaIndex: number;
}

interface Nrformats { readonly bin: boolean; readonly hex: boolean; readonly octal: boolean; readonly alpha: boolean; readonly unsigned: boolean }

function findNumber(line: string, cursor: number, options: Nrformats): NumberCandidate | null {
  const candidates: NumberCandidate[] = [];
  const numeric = /[+-]?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|[0-9]+)/gu;
  for (const match of line.matchAll(numeric)) {
    const start = match.index ?? 0;
    const text = match[0];
    if (start > 0 && /[A-Za-z0-9_]/u.test(line[start - 1] ?? '')) continue;
    if (start + text.length <= cursor) continue;
    const parsed = parseCandidate(text, start, options);
    if (parsed !== null) candidates.push(parsed);
  }
  if (options.alpha) {
    const alpha = /[A-Za-z]/gu;
    for (const match of line.matchAll(alpha)) {
      const start = match.index ?? 0;
      if (start >= cursor) candidates.push({ kind: 'alpha', text: match[0], start, end: start + 1, base: null, prefix: '', digitText: '', sign: '', alphaIndex: start });
    }
  }
  candidates.sort((left, right) => left.start - right.start || left.end - right.end);
  return candidates[0] ?? null;
}

function parseCandidate(text: string, start: number, options: Nrformats): NumberCandidate | null {
  const sign = text.startsWith('-') || text.startsWith('+') ? (text[0] ?? '') : '';
  const body = text.slice(sign.length);
  let base: 2 | 8 | 10 | 16 = 10;
  let prefix = '';
  let digitText = body;
  if (/^0[xX]/u.test(body) && options.hex) { base = 16; prefix = body.slice(0, 2); digitText = body.slice(2); }
  else if (/^0[bB]/u.test(body) && options.bin) { base = 2; prefix = body.slice(0, 2); digitText = body.slice(2); }
  else if (/^0[oO][0-7]+$/u.test(body) && options.octal) { base = 8; prefix = body.slice(0, 1); digitText = body.slice(1); }
  if (digitText.length === 0) return null;
  return { kind: 'number', text, start, end: start + text.length, base, prefix, digitText, sign, alphaIndex: -1 };
}

function changeNumber(candidate: NumberCandidate, delta: number, options: Nrformats): VimAdvancedResult<{ readonly text: string; readonly cursorDelta: number }> {
  if (candidate.kind === 'alpha') {
    const code = candidate.text.charCodeAt(0);
    const next = code + delta;
    if ((code >= 65 && code <= 90 && (next < 65 || next > 90)) || (code >= 97 && code <= 122 && (next < 97 || next > 122))) {
      return { ok: true, value: { text: candidate.text, cursorDelta: 0 } };
    }
    return { ok: true, value: { text: String.fromCharCode(next), cursorDelta: 0 } };
  }
  if (candidate.digitText.length > MAX_NUMERIC_DIGITS) return failure({ kind: 'numeric-overflow' });
  let value: bigint;
  try {
    const literal = candidate.base === 16 ? `0x${candidate.digitText}`
      : candidate.base === 2 ? `0b${candidate.digitText}`
        : candidate.base === 8 ? `0o${candidate.digitText}` : candidate.digitText;
    const magnitude = BigInt(literal);
    value = candidate.sign === '-' ? -magnitude : magnitude;
  } catch {
    return failure({ kind: 'numeric-overflow' });
  }
  const next = value + BigInt(delta);
  const negative = next < 0n;
  const magnitude = negative ? -next : next;
  const digits = magnitude.toString(candidate.base ?? 10);
  if (digits.length > MAX_NUMERIC_DIGITS) return failure({ kind: 'numeric-overflow' });
  const padded = digits.length < candidate.digitText.length ? digits.padStart(candidate.digitText.length, '0') : digits;
  if (padded.length > MAX_NUMERIC_DIGITS) return failure({ kind: 'numeric-overflow' });
  const upper = candidate.base === 16 && candidate.digitText.length > 0
    && candidate.digitText === candidate.digitText.toUpperCase();
  const renderedDigits = upper ? padded.toUpperCase() : padded;
  const renderedSign = negative ? '-' : (candidate.sign === '+' && !negative ? '+' : '');
  const text = `${renderedSign}${candidate.prefix}${renderedDigits}`;
  return { ok: true, value: { text, cursorDelta: Math.max(0, text.length - 1) } };
}

function parseNrformats(value: string | undefined): VimAdvancedResult<Nrformats> {
  const raw = value ?? 'bin,hex';
  if (typeof raw !== 'string' || raw.length > 256) return failure({ kind: 'invalid-option' });
  const result = { bin: false, hex: false, octal: false, alpha: false, unsigned: false };
  for (const item of raw.split(',')) {
    if (item === '') continue;
    if (item === 'bin') result.bin = true;
    else if (item === 'hex') result.hex = true;
    else if (item === 'octal') result.octal = true;
    else if (item === 'alpha') result.alpha = true;
    else if (item === 'unsigned') result.unsigned = true;
    else return failure({ kind: 'invalid-option' });
  }
  return { ok: true, value: Object.freeze(result) };
}

function cancelled(token: CancellationToken | undefined, predicate: (() => boolean) | undefined): boolean {
  return token?.isCancelled === true || predicate?.() === true;
}

async function awaitCancellation<T>(operation: T | Promise<T>, token: CancellationToken | undefined): Promise<T | typeof CANCELLED> {
  const promise = Promise.resolve(operation);
  if (token === undefined) return promise;
  if (token.isCancelled) return CANCELLED;
  return new Promise<T | typeof CANCELLED>((resolve, reject) => {
    let finished = false;
    let disposable: { dispose(): void | Promise<void> } | undefined;
    const complete = (value: T | typeof CANCELLED): void => {
      if (finished) return;
      finished = true;
      disposable?.dispose();
      resolve(value);
    };
    disposable = token.onCancel(() => complete(CANCELLED));
    void promise.then((value) => complete(value), (error: unknown) => {
      if (finished) return;
      finished = true;
      disposable?.dispose();
      reject(error);
    });
  });
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function failure<T>(error: VimAdvancedFailure): VimAdvancedResult<T> {
  return { ok: false, error };
}
