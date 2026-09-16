import type {
  CancellationToken,
  Result,
} from '../../contracts/src/index';
import type {
  DocumentEdit,
  DocumentSnapshot,
  LineIndex,
  Utf16Offset,
} from '../../document/src/index';
import type { VimNormalizedOperatorRange } from '../ranges/normalize';

/** Native keys owned by the text-transform operator family. */
export type VimTextTransformOperator = 'gu' | 'gU' | 'g~' | 'g?' | 'J' | 'gJ' | '>' | '<' | '=' | 'gq' | 'gw';

export type VimTextTransformProviderKind = 'indent' | 'format';

export interface VimTextTransformOptions {
  readonly joinspaces?: boolean;
  readonly shiftwidth?: number;
  readonly tabstop?: number;
  readonly expandtab?: boolean;
}

export interface VimTextTransformProviderContext {
  readonly snapshot: DocumentSnapshot;
  readonly range: VimNormalizedOperatorRange;
  readonly operator: '=' | 'gq' | 'gw';
  readonly options: VimTextTransformOptions;
}

export type VimTextTransformProviderFailure =
  | { readonly kind: 'unavailable'; readonly provider: VimTextTransformProviderKind }
  | { readonly kind: 'failed'; readonly provider: VimTextTransformProviderKind; readonly message: string };

export interface VimTextTransformProvider {
  readonly id: string;
  readonly provide: (context: VimTextTransformProviderContext) => Result<readonly DocumentEdit[], VimTextTransformProviderFailure>;
}

export interface VimTextTransformProviders {
  readonly indent?: VimTextTransformProvider;
  readonly format?: VimTextTransformProvider;
}

export interface VimTextTransformInput {
  readonly snapshot: DocumentSnapshot;
  readonly range: VimNormalizedOperatorRange;
  readonly operator: VimTextTransformOperator;
  /** Optional source version guard when a resolver carries an older range. */
  readonly expectedVersion?: DocumentSnapshot['version'];
  readonly options?: VimTextTransformOptions;
  readonly providers?: VimTextTransformProviders;
  readonly cancellation?: CancellationToken;
  readonly isCancelled?: () => boolean;
}

export interface VimTextTransformHistoryEffect {
  readonly kind: 'single-command';
  readonly breaksInsert: true;
}

export interface VimTextTransformCursorIntent {
  readonly offset: Utf16Offset;
  readonly placement: 'preserve' | 'normal-after-edit';
}

export interface VimTextTransformPlan {
  readonly kind: 'prepared';
  readonly operator: VimTextTransformOperator;
  readonly transaction: {
    readonly documentId: DocumentSnapshot['id'];
    readonly expectedVersion: DocumentSnapshot['version'];
    readonly edits: readonly DocumentEdit[];
  } | null;
  readonly registerEffect: null;
  readonly historyEffect: VimTextTransformHistoryEffect;
  readonly cursorIntent: VimTextTransformCursorIntent;
}

export type VimTextTransformFailure =
  | { readonly kind: 'invalid-operator' }
  | { readonly kind: 'invalid-option' }
  | { readonly kind: 'stale-document-version' }
  | { readonly kind: 'invalid-range' }
  | { readonly kind: 'unsupported-range'; readonly operator: VimTextTransformOperator; readonly range: VimNormalizedOperatorRange['kind'] }
  | { readonly kind: 'provider-unavailable'; readonly provider: VimTextTransformProviderKind }
  | { readonly kind: 'provider-failed'; readonly provider: VimTextTransformProviderKind; readonly message: string }
  | { readonly kind: 'provider-invalid-edit'; readonly provider: VimTextTransformProviderKind }
  | { readonly kind: 'document-read-failed' }
  | { readonly kind: 'cancelled' };

export type VimTextTransformResult<T> = Result<T, VimTextTransformFailure>;

const TRANSFORM_OPERATORS: ReadonlySet<string> = new Set(['gu', 'gU', 'g~', 'g?', 'J', 'gJ', '>', '<', '=', 'gq', 'gw']);
const MAX_INDENT_CELLS = 1000;

/** Prepare one atomic case, join, indentation or format transaction. */
export function prepareVimTextTransform(input: VimTextTransformInput): VimTextTransformResult<VimTextTransformPlan> {
  if (!TRANSFORM_OPERATORS.has(input.operator as string)) return failure({ kind: 'invalid-operator' });
  if (input.expectedVersion !== undefined && input.expectedVersion !== input.snapshot.version) {
    return failure({ kind: 'stale-document-version' });
  }
  if ((input.range.start as number) < 0 || (input.range.end as number) < (input.range.start as number)
    || (input.range.end as number) > input.snapshot.lengthUtf16) return failure({ kind: 'invalid-range' });
  if (input.range.ranges.length === 0) return failure({ kind: 'invalid-range' });
  for (const item of input.range.ranges) {
    if ((item.start as number) < (input.range.start as number)
      || (item.end as number) < (item.start as number)
      || (item.end as number) > (input.range.end as number)
      || input.snapshot.slice(item.start, item.end).ok === false) return failure({ kind: 'invalid-range' });
  }
  if ((input.range.start as number) !== (input.range.end as number)
    && input.snapshot.slice(input.range.start, input.range.end).ok === false) return failure({ kind: 'invalid-range' });
  if (input.cancellation?.isCancelled === true || input.isCancelled?.() === true) return failure({ kind: 'cancelled' });
  const options = normalizeOptions(input.options ?? {});
  if (!options.ok) return options;

  let edits: readonly DocumentEdit[];
  if (input.operator === 'gu' || input.operator === 'gU' || input.operator === 'g~' || input.operator === 'g?') {
    const result = caseEdits(input.snapshot, input.range, input.operator, input);
    if (!result.ok) return result;
    edits = result.value;
  } else if (input.operator === 'J' || input.operator === 'gJ') {
    const result = joinEdits(input.snapshot, input.range, input.operator, options.value.joinspaces, input);
    if (!result.ok) return result;
    edits = result.value;
  } else if (input.operator === '>' || input.operator === '<') {
    const result = indentEdits(input.snapshot, input.range, input.operator, options.value, input);
    if (!result.ok) return result;
    edits = result.value;
  } else {
    const providerKind: VimTextTransformProviderKind = input.operator === '=' ? 'indent' : 'format';
    const provider = providerKind === 'indent' ? input.providers?.indent : input.providers?.format;
    if (provider === undefined) return failure({ kind: 'provider-unavailable', provider: providerKind });
    if (isCancelled(input)) return failure({ kind: 'cancelled' });
    const result = provider.provide(Object.freeze({
      snapshot: input.snapshot,
      range: input.range,
      operator: input.operator,
      options: options.value,
    }));
    if (isCancelled(input)) return failure({ kind: 'cancelled' });
    if (!result.ok) return providerFailure(result.error);
    const checked = validateProviderEdits(input.snapshot, input.range, result.value, providerKind);
    if (!checked.ok) return checked;
    edits = checked.value;
  }

  const transaction = edits.length === 0 ? null : Object.freeze({
    documentId: input.snapshot.id,
    expectedVersion: input.snapshot.version,
    edits: Object.freeze(edits),
  });
  return {
    ok: true,
    value: Object.freeze({
      kind: 'prepared',
      operator: input.operator,
      transaction,
      registerEffect: null,
      historyEffect: Object.freeze({ kind: 'single-command', breaksInsert: true }),
      cursorIntent: Object.freeze({
        offset: input.range.start,
        placement: input.operator === 'gw' ? 'preserve' : 'normal-after-edit',
      }),
    }),
  };
}

function caseEdits(
  snapshot: DocumentSnapshot,
  range: VimNormalizedOperatorRange,
  operator: 'gu' | 'gU' | 'g~' | 'g?',
  input: VimTextTransformInput,
): VimTextTransformResult<readonly DocumentEdit[]> {
  const edits: DocumentEdit[] = [];
  for (const item of range.ranges) {
    if (isCancelled(input)) return failure({ kind: 'cancelled' });
    const text = item.text;
    const transformed = operator === 'gu' ? text.toLocaleLowerCase('en-US')
      : operator === 'gU' ? text.toLocaleUpperCase('en-US')
        : operator === 'g~' ? swapCase(text) : rot13(text);
    const replacement = `${item.replacementPrefix ?? ''}${transformed}${item.replacementSuffix ?? ''}`;
    const original = `${item.replacementPrefix ?? ''}${text}${item.replacementSuffix ?? ''}`;
    if (replacement !== original) edits.push(makeEdit(item.start, item.end, replacement));
  }
  return { ok: true, value: Object.freeze(edits) };
}

/** Vim's g? is ASCII ROT13; non-ASCII code points are retained byte-for-byte. */
function rot13(value: string): string {
  return [...value].map((character) => {
    const code = character.codePointAt(0);
    if (code === undefined) return character;
    if (code >= 0x41 && code <= 0x5a) return String.fromCodePoint(((code - 0x41 + 13) % 26) + 0x41);
    if (code >= 0x61 && code <= 0x7a) return String.fromCodePoint(((code - 0x61 + 13) % 26) + 0x61);
    return character;
  }).join('');
}

function joinEdits(
  snapshot: DocumentSnapshot,
  range: VimNormalizedOperatorRange,
  operator: 'J' | 'gJ',
  joinspaces: boolean,
  input: VimTextTransformInput,
): VimTextTransformResult<readonly DocumentEdit[]> {
  if (range.kind !== 'linewise' || range.ranges.length !== 1) return failure({ kind: 'unsupported-range', operator, range: range.kind });
  if (isCancelled(input)) return failure({ kind: 'cancelled' });
  const item = range.ranges[0];
  if (item === undefined) return failure({ kind: 'invalid-range' });
  const joined = joinLines(item.text, operator === 'gJ', joinspaces);
  return joined === item.text ? { ok: true, value: Object.freeze([]) }
    : { ok: true, value: Object.freeze([makeEdit(item.start, item.end, joined)]) };
}

function indentEdits(
  snapshot: DocumentSnapshot,
  range: VimNormalizedOperatorRange,
  operator: '>' | '<',
  options: Required<VimTextTransformOptions>,
  input: VimTextTransformInput,
): VimTextTransformResult<readonly DocumentEdit[]> {
  const lines = touchedLines(snapshot, range);
  if (!lines.ok) return lines;
  const unit = indentUnit(options);
  const edits: DocumentEdit[] = [];
  for (const line of lines.value) {
    if (isCancelled(input)) return failure({ kind: 'cancelled' });
    const start = snapshot.lineStartOffset(line as LineIndex);
    if (!start.ok) return failure({ kind: 'document-read-failed' });
    const end = nextLineContentEnd(snapshot, line);
    if (!end.ok) return end;
    const text = snapshot.slice(start.value, end.value);
    if (!text.ok) return failure({ kind: 'document-read-failed' });
    const indentLength = /^[\t ]*/u.exec(text.value)?.[0].length ?? 0;
    const current = text.value.slice(0, indentLength);
    const next = operator === '>' ? `${current}${unit}` : removeIndent(current, options.shiftwidth, options.tabstop);
    if (next !== current) edits.push(makeEdit(start.value, (start.value as number + indentLength) as Utf16Offset, next));
  }
  return { ok: true, value: Object.freeze(edits) };
}

function touchedLines(snapshot: DocumentSnapshot, range: VimNormalizedOperatorRange): VimTextTransformResult<readonly number[]> {
  if (range.ranges.length === 0) return failure({ kind: 'invalid-range' });
  let first = Number.MAX_SAFE_INTEGER;
  let last = -1;
  for (const item of range.ranges) {
    const start = snapshot.lineIndexAt(item.start);
    const endOffset = item.end > item.start ? (item.end as number - 1) as Utf16Offset : item.start;
    const end = snapshot.lineIndexAt(endOffset);
    if (!start.ok || !end.ok) return failure({ kind: 'document-read-failed' });
    first = Math.min(first, start.value as number);
    last = Math.max(last, end.value as number);
  }
  const lines: number[] = [];
  for (let line = first; line <= last; line += 1) lines.push(line);
  return { ok: true, value: Object.freeze(lines) };
}

function nextLineContentEnd(snapshot: DocumentSnapshot, line: number): VimTextTransformResult<Utf16Offset> {
  const next = snapshot.lineStartOffset((line + 1) as LineIndex);
  if (next.ok) return { ok: true, value: ((next.value as number) - 1) as Utf16Offset };
  if (line === snapshot.lineCount - 1) return { ok: true, value: snapshot.lengthUtf16 as Utf16Offset };
  return failure({ kind: 'document-read-failed' });
}

function joinLines(text: string, noSpace: boolean, joinspaces: boolean): string {
  const parts = text.split('\n');
  const hasTrailingNewline = parts.length > 1 && parts[parts.length - 1] === '';
  const content = hasTrailingNewline ? parts.slice(0, -1) : parts;
  if (content.length < 2) return text;
  let result = content[0]?.replace(/[\t ]+$/u, '') ?? '';
  for (let index = 1; index < content.length; index += 1) {
    const right = (content[index] ?? '').replace(/^[\t ]+/u, '');
    const sentence = /[.!?]$/u.test(result);
    const separator = noSpace ? '' : sentence && joinspaces ? '  ' : ' ';
    result += separator + right;
  }
  return hasTrailingNewline ? `${result}\n` : result;
}

function indentUnit(options: Required<VimTextTransformOptions>): string {
  if (options.expandtab) return ' '.repeat(options.shiftwidth);
  const tabs = Math.floor(options.shiftwidth / options.tabstop);
  const spaces = options.shiftwidth % options.tabstop;
  return '\t'.repeat(tabs) + ' '.repeat(spaces);
}

function removeIndent(value: string, shiftwidth: number, tabstop: number): string {
  let remaining = shiftwidth;
  let index = 0;
  while (index < value.length && remaining > 0) {
    if (value[index] === '\t') remaining -= tabstop;
    else if (value[index] === ' ') remaining -= 1;
    else break;
    index += 1;
  }
  return value.slice(index);
}

function swapCase(text: string): string {
  const parts: string[] = [];
  for (const character of text) {
    const upper = character.toLocaleUpperCase('en-US');
    const lower = character.toLocaleLowerCase('en-US');
    parts.push(character === upper ? lower : upper);
  }
  return parts.join('');
}

function makeEdit(start: Utf16Offset, end: Utf16Offset, text: string): DocumentEdit {
  return Object.freeze({ start, end, text, ...(text.includes('\r') ? { textIntent: 'literal-control' as const } : {}) });
}

function normalizeOptions(options: VimTextTransformOptions): VimTextTransformResult<Required<VimTextTransformOptions>> {
  const joinspaces = options.joinspaces ?? true;
  const shiftwidth = options.shiftwidth ?? 8;
  const tabstop = options.tabstop ?? 8;
  const expandtab = options.expandtab ?? false;
  if (typeof joinspaces !== 'boolean' || typeof expandtab !== 'boolean'
    || !Number.isSafeInteger(shiftwidth) || shiftwidth < 1 || shiftwidth > MAX_INDENT_CELLS
    || !Number.isSafeInteger(tabstop) || tabstop < 1 || tabstop > MAX_INDENT_CELLS) {
    return failure({ kind: 'invalid-option' });
  }
  return { ok: true, value: Object.freeze({ joinspaces, shiftwidth, tabstop, expandtab }) };
}

function validateProviderEdits(
  snapshot: DocumentSnapshot,
  range: VimNormalizedOperatorRange,
  edits: readonly DocumentEdit[],
  provider: VimTextTransformProviderKind,
): VimTextTransformResult<readonly DocumentEdit[]> {
  let previousEnd = -1;
  for (const edit of edits) {
    const start = edit.start as number;
    const end = edit.end as number;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < (range.start as number)
      || end < start || end > (range.end as number) || start < previousEnd
      || snapshot.slice(edit.start, edit.end).ok === false || typeof edit.text !== 'string'
      || !isWellFormedText(edit.text) || (edit.text.includes('\r') && edit.textIntent !== 'literal-control')) {
      return failure({ kind: 'provider-invalid-edit', provider });
    }
    previousEnd = end;
  }
  return { ok: true, value: Object.freeze(edits.map((edit) => Object.freeze({ ...edit }))) };
}

function providerFailure(error: VimTextTransformProviderFailure): VimTextTransformResult<never> {
  return error.kind === 'unavailable'
    ? failure({ kind: 'provider-unavailable', provider: error.provider })
    : failure({ kind: 'provider-failed', provider: error.provider, message: error.message });
}

function isCancelled(input: VimTextTransformInput): boolean {
  return input.cancellation?.isCancelled === true || input.isCancelled?.() === true;
}

function isWellFormedText(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function failure(error: VimTextTransformFailure): VimTextTransformResult<never> {
  return { ok: false, error };
}
