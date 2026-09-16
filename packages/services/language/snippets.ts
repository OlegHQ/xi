import type { Disposable, Result } from '../../contracts/src/index';

const MAX_SNIPPET_UTF16 = 256 * 1024;
const MAX_TABSTOPS = 10_000;

export interface SnippetEdit { readonly start: number; readonly end: number; readonly text: string; }
export interface SnippetTransform { readonly regex: string; readonly format: string; readonly options: string; }
export interface SnippetTabstop {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly defaultText: string;
  /** Repeated occurrences and transformed mirrors are anchors, not Tab stops. */
  readonly mirror?: boolean;
  readonly transform?: SnippetTransform;
}
export interface SnippetExpansion { readonly text: string; readonly tabstops: readonly SnippetTabstop[]; }
export type SnippetFailure = { readonly kind: 'invalid' | 'stale' | 'disposed' | 'outside-edit'; readonly message: string };

/** Parse the supported LSP snippet grammar without retaining a second document buffer. */
export function expandSnippet(template: string): Result<SnippetExpansion, SnippetFailure> {
  if (template.length > MAX_SNIPPET_UTF16) return failure('invalid', 'snippet exceeds the size limit');
  const state: ParseState = { source: template, index: 0, tabstops: [], defaults: new Map() };
  const text = parseSequence(state, undefined, 0);
  if (!text.ok || state.index !== template.length || state.tabstops.length > MAX_TABSTOPS) {
    return text.ok ? failure('invalid', 'snippet contains an incomplete construct') : text;
  }
  const sorted = state.tabstops.slice().sort((left, right) => tabstopOrder(left, right));
  return { ok: true, value: Object.freeze({ text: text.value, tabstops: Object.freeze(sorted.map((tabstop) => Object.freeze(tabstop))) }) };
}

export class SnippetSession implements Disposable {
  readonly #expansion: SnippetExpansion;
  readonly #occurrences: MutableTabstop[];
  readonly #tabstops: MutableTabstop[];
  #generation: number;
  #disposed = false;
  #tabstopPosition = 0;

  constructor(expansion: SnippetExpansion, generation: number) {
    this.#expansion = expansion;
    this.#occurrences = expansion.tabstops.map((tabstop) => ({ ...tabstop }));
    this.#tabstops = this.#occurrences.filter((tabstop) => tabstop.mirror !== true);
    this.#generation = generation;
  }

  get expansion(): SnippetExpansion {
    return Object.freeze({ text: this.#expansion.text, tabstops: Object.freeze(this.#occurrences.map((tabstop) => Object.freeze({ ...tabstop }))) });
  }
  get active(): SnippetTabstop | undefined {
    const active = this.#tabstops[this.#tabstopPosition];
    return active === undefined ? undefined : Object.freeze({ ...active });
  }

  next(generation: number): Result<SnippetTabstop | undefined, SnippetFailure> {
    const valid = this.checkGeneration(generation);
    if (!valid.ok) return valid;
    this.#tabstopPosition += 1;
    return { ok: true, value: this.active };
  }

  previous(generation: number): Result<SnippetTabstop | undefined, SnippetFailure> {
    const valid = this.checkGeneration(generation);
    if (!valid.ok) return valid;
    this.#tabstopPosition = Math.max(0, this.#tabstopPosition - 1);
    return { ok: true, value: this.active };
  }

  /** Selection-only movement changes the generation while the snippet remains the same document session. */
  reanchor(generation: number): Result<void, SnippetFailure> {
    if (this.#disposed) return failure('disposed', 'snippet disposed');
    if (!Number.isSafeInteger(generation) || generation < 0) return failure('stale', 'snippet selection generation is invalid');
    this.#generation = generation;
    return { ok: true, value: undefined };
  }

  /** Map every placeholder and mirror through one committed, base-relative edit batch. */
  mapExternalEdits(edits: readonly SnippetEdit[], generation: number): Result<void, SnippetFailure> {
    const valid = this.checkGeneration(generation);
    if (!valid.ok) return valid;
    const ordered = normalizedEdits(edits);
    if (!ordered.ok) return ordered;
    for (const tabstop of this.#occurrences) {
      const start = mapOffsetThroughBatch(tabstop.start, ordered.value, false);
      const end = mapOffsetThroughBatch(tabstop.end, ordered.value, true);
      tabstop.start = start;
      tabstop.end = Math.max(start, end);
    }
    return { ok: true, value: undefined };
  }

  /** Plan the primary replacement and all same-index mirror replacements as one atomic batch. */
  replaceActive(text: string, generation: number): Result<readonly SnippetEdit[], SnippetFailure> {
    const valid = this.checkGeneration(generation);
    if (!valid.ok) return valid;
    if (text.length > MAX_SNIPPET_UTF16) return failure('invalid', 'snippet replacement exceeds the size limit');
    const active = this.#tabstops[this.#tabstopPosition];
    if (active === undefined) return failure('outside-edit', 'snippet has no active placeholder');
    const edits = this.#occurrences
      .filter((tabstop) => tabstop.index === active.index)
      .map((tabstop) => ({ start: tabstop.start, end: tabstop.end, text: tabstop.transform === undefined ? text : applyTransform(tabstop.transform, text) }));
    const ordered = normalizedEdits(edits);
    if (!ordered.ok) return failure('invalid', 'snippet mirror transforms overlap');
    for (const tabstop of this.#occurrences) {
      if (tabstop.index !== active.index) continue;
      const replacement = tabstop.transform === undefined ? text : applyTransform(tabstop.transform, text);
      tabstop.end = tabstop.start + replacement.length;
      tabstop.defaultText = replacement;
    }
    return { ok: true, value: Object.freeze(ordered.value) };
  }

  /** An edit outside the active placeholder cancels the snippet instead of stealing the next Tab. */
  outsideEdit(generation: number): Result<never, SnippetFailure> {
    const valid = this.checkGeneration(generation);
    if (!valid.ok) return valid;
    this.stop();
    return failure('outside-edit', 'edit occurred outside the active snippet placeholder');
  }

  stop(): void { this.#tabstopPosition = this.#tabstops.length; }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.#occurrences.length = 0; this.#tabstops.length = 0; }

  private checkGeneration(generation: number): Result<void, SnippetFailure> {
    if (this.#disposed) return failure('disposed', 'snippet disposed');
    if (generation !== this.#generation) return failure('stale', 'snippet selection is stale');
    return { ok: true, value: undefined };
  }
}

interface MutableTabstop { index: number; start: number; end: number; defaultText: string; mirror?: boolean; transform?: SnippetTransform; }
interface ParseState { readonly source: string; index: number; readonly tabstops: MutableTabstop[]; readonly defaults: Map<number, string>; }

function parseSequence(state: ParseState, terminator: string | undefined, baseOffset: number): Result<string, SnippetFailure> {
  let output = '';
  while (state.index < state.source.length) {
    const character = state.source[state.index];
    if (character === terminator) { state.index += 1; return { ok: true, value: output }; }
    if (character === '\\') {
      const escaped = state.source[state.index + 1];
      if (escaped === undefined) return failure('invalid', 'snippet ends with an escape');
      output += escaped;
      state.index += 2;
      continue;
    }
    if (character !== '$') { output += character ?? ''; state.index += 1; continue; }
    const token = parseDollar(state, baseOffset + output.length);
    if (!token.ok) return token;
    output += token.value;
  }
  return terminator === undefined ? { ok: true, value: output } : failure('invalid', 'snippet placeholder is not closed');
}

function parseDollar(state: ParseState, startOffset: number): Result<string, SnippetFailure> {
  state.index += 1;
  const next = state.source[state.index];
  if (next === '{') {
    state.index += 1;
    const number = readDigits(state);
    if (number === undefined) return failure('invalid', 'snippet placeholder index is missing');
    const separator = state.source[state.index];
    if (separator === '}') {
      state.index += 1;
      return placeholder(state, number, '', startOffset);
    }
    if (separator === ':') {
      state.index += 1;
      const nested = parseSequence(state, '}', startOffset);
      if (!nested.ok) return nested;
      return placeholder(state, number, nested.value, startOffset);
    }
    if (separator === '|') return parseChoice(state, number, startOffset);
    if (separator === '/') return parseTransform(state, number, startOffset);
    return failure('invalid', 'snippet variable or construct is unsupported');
  }
  if (next !== undefined && /\d/u.test(next)) {
    const number = readDigits(state);
    return number === undefined ? failure('invalid', 'snippet placeholder index is invalid') : placeholder(state, number, state.defaults.get(number) ?? '', startOffset);
  }
  if (next !== undefined && /[A-Za-z_]/u.test(next)) return failure('invalid', 'snippet variables are unsupported; server must send a plain insertion');
  return { ok: true, value: '$' };
}

function parseChoice(state: ParseState, number: number, startOffset: number): Result<string, SnippetFailure> {
  state.index += 1;
  let choice = '';
  while (state.index < state.source.length) {
    const character = state.source[state.index];
    if (character === '\\') {
      const escaped = state.source[state.index + 1];
      if (escaped === undefined) return failure('invalid', 'snippet choice ends with an escape');
      choice += escaped;
      state.index += 2;
    } else if (character === ',') {
      state.index += 1;
      while (state.index < state.source.length && state.source[state.index] !== ',' && state.source[state.index] !== '|' && state.source[state.index] !== '}') state.index += 1;
    } else if (character === '|' && state.source[state.index + 1] === '}') {
      state.index += 2;
      return placeholder(state, number, choice, startOffset);
    } else {
      choice += character ?? '';
      state.index += 1;
    }
  }
  return failure('invalid', 'snippet choice is not closed');
}

function parseTransform(state: ParseState, number: number, startOffset: number): Result<string, SnippetFailure> {
  state.index += 1;
  const regex = readTransformPart(state);
  if (!regex.ok) return regex;
  const format = readTransformPart(state);
  if (!format.ok) return format;
  let options = '';
  while (state.index < state.source.length && state.source[state.index] !== '}') {
    const character = state.source[state.index];
    if (character === '\\') {
      const escaped = state.source[state.index + 1];
      if (escaped === undefined) return failure('invalid', 'snippet transform ends with an escape');
      options += escaped;
      state.index += 2;
      continue;
    }
    options += character ?? '';
    state.index += 1;
  }
  if (state.source[state.index] !== '}') return failure('invalid', 'snippet transform is not closed');
  state.index += 1;
  try { void new RegExp(regex.value, options); } catch { return failure('invalid', 'snippet transform regular expression is invalid'); }
  const transform = Object.freeze({ regex: regex.value, format: format.value, options });
  const source = state.defaults.get(number) ?? '';
  const value = applyTransform(transform, source);
  state.tabstops.push({ index: number, start: startOffset, end: startOffset + value.length, defaultText: value, mirror: true, transform });
  return { ok: true, value };
}

function readTransformPart(state: ParseState): Result<string, SnippetFailure> {
  let value = '';
  let braces = 0;
  while (state.index < state.source.length) {
    const character = state.source[state.index];
    if (character === '\\') {
      const escaped = state.source[state.index + 1];
      if (escaped === undefined) return failure('invalid', 'snippet transform ends with an escape');
      value += character + escaped;
      state.index += 2;
      continue;
    }
    if (character === '{') braces += 1;
    if (character === '}' && braces > 0) braces -= 1;
    if (character === '/' && braces === 0) { state.index += 1; return { ok: true, value }; }
    value += character ?? '';
    state.index += 1;
  }
  return failure('invalid', 'snippet transform is missing a delimiter');
}

function placeholder(state: ParseState, index: number, value: string, start: number): Result<string, SnippetFailure> {
  const primary = !state.defaults.has(index);
  const defaultText = state.defaults.get(index) ?? value;
  if (primary) state.defaults.set(index, value);
  state.tabstops.push({ index, start, end: start + defaultText.length, defaultText, ...(primary ? {} : { mirror: true }) });
  return { ok: true, value: defaultText };
}

function applyTransform(transform: SnippetTransform, source: string): string {
  const expression = new RegExp(transform.regex, transform.options);
  let output = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  do {
    match = expression.exec(source);
    if (match === null) break;
    output += source.slice(cursor, match.index) + renderTransformFormat(transform.format, match);
    cursor = match.index + match[0].length;
    if (!expression.global) break;
    if (match[0].length === 0) expression.lastIndex += 1;
  } while (true);
  return match === null && cursor === 0 ? source : output + source.slice(cursor);
}

function renderTransformFormat(format: string, match: RegExpExecArray): string {
  let output = '';
  for (let index = 0; index < format.length; index += 1) {
    const character = format[index];
    if (character === '\\') {
      const escaped = format[index + 1];
      if (escaped !== undefined) { output += escaped; index += 1; }
      continue;
    }
    if (character !== '$') { output += character ?? ''; continue; }
    const next = format[index + 1];
    if (next !== undefined && /\d/u.test(next)) {
      let end = index + 1;
      while (end < format.length && /\d/u.test(format[end] ?? '')) end += 1;
      output += capture(match, Number(format.slice(index + 1, end)));
      index = end - 1;
      continue;
    }
    if (next !== '{') { output += '$'; continue; }
    const close = findClosingBrace(format, index + 1);
    if (close === undefined) { output += '$'; continue; }
    output += renderTransformToken(format.slice(index + 2, close), match);
    index = close;
  }
  return output;
}

function renderTransformToken(token: string, match: RegExpExecArray): string {
  const separator = token.indexOf(':');
  const indexText = separator < 0 ? token : token.slice(0, separator);
  if (!/^\d+$/u.test(indexText)) return '';
  const value = capture(match, Number(indexText));
  if (separator < 0) return value;
  const operation = token.slice(separator + 1);
  if (operation.startsWith('/')) return transformCase(value, operation.slice(1));
  if (operation.startsWith('+')) return value.length === 0 ? '' : operation.slice(1);
  if (operation.startsWith('-')) return value.length === 0 ? operation.slice(1) : value;
  if (operation.startsWith('?')) {
    const branch = operation.slice(1);
    const split = branch.indexOf(':');
    return value.length === 0 ? (split < 0 ? '' : branch.slice(split + 1)) : split < 0 ? branch : branch.slice(0, split);
  }
  return operation;
}

function transformCase(value: string, operation: string): string {
  switch (operation) {
    case 'upcase': return value.toLocaleUpperCase();
    case 'downcase': return value.toLocaleLowerCase();
    case 'capitalize': return value.length === 0 ? value : value[0]!.toLocaleUpperCase() + value.slice(1);
    case 'camelcase': return value.replace(/[-_\s]+(.)?/gu, (_match, character: string | undefined) => character?.toLocaleUpperCase() ?? '');
    case 'pascalcase': { const camel = transformCase(value, 'camelcase'); return camel.length === 0 ? camel : camel[0]!.toLocaleUpperCase() + camel.slice(1); }
    default: return value;
  }
}

function capture(match: RegExpExecArray, index: number): string { return match[index] ?? ''; }

function findClosingBrace(value: string, opening: number): number | undefined {
  let depth = 0;
  for (let index = opening; index < value.length; index += 1) {
    if (value[index] === '{') depth += 1;
    else if (value[index] === '}' && --depth === 0) return index;
  }
  return undefined;
}

function readDigits(state: ParseState): number | undefined {
  const start = state.index;
  while (state.index < state.source.length && /\d/u.test(state.source[state.index] ?? '')) state.index += 1;
  if (state.index === start) return undefined;
  const value = Number(state.source.slice(start, state.index));
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function tabstopOrder(left: SnippetTabstop, right: SnippetTabstop): number {
  const leftIndex = left.index === 0 ? Number.MAX_SAFE_INTEGER : left.index;
  const rightIndex = right.index === 0 ? Number.MAX_SAFE_INTEGER : right.index;
  return leftIndex - rightIndex || left.start - right.start || Number(left.mirror === true) - Number(right.mirror === true);
}

function normalizedEdits(edits: readonly SnippetEdit[]): Result<readonly SnippetEdit[], SnippetFailure> {
  const ordered = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);
  let previousEnd = -1;
  for (const edit of ordered) {
    if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) || edit.start < 0 || edit.end < edit.start || typeof edit.text !== 'string' || edit.text.length > MAX_SNIPPET_UTF16 || edit.start < previousEnd) return failure('invalid', 'snippet edit ranges overlap or are invalid');
    previousEnd = edit.end;
  }
  return { ok: true, value: Object.freeze(ordered) };
}

function mapOffsetThroughBatch(offset: number, edits: readonly SnippetEdit[], right: boolean): number {
  let delta = 0;
  for (const edit of edits) {
    if (offset < edit.start) break;
    if (offset > edit.end) {
      delta += edit.text.length - (edit.end - edit.start);
      continue;
    }
    return edit.start + delta + (right ? edit.text.length : 0);
  }
  return offset + delta;
}

function failure(kind: SnippetFailure['kind'], message: string): Result<never, SnippetFailure> { return { ok: false, error: { kind, message } }; }
