import type { Disposable, Result } from '../../contracts/src/index';
import type { SearchMatch, SearchQuery } from './index';

/** A target is bound to the exact source used to build the preview. */
export interface ReplaceTarget { readonly path: string; readonly rootId: string; readonly text: string; readonly version?: number; readonly diskHash?: string; readonly source: 'disk' | 'buffer'; }
export interface ReplacementEdit { readonly path: string; /** Absolute UTF-16 offsets in the target text. */ readonly startUtf16: number; readonly endUtf16: number; readonly replacement: string; readonly original: string; }
export interface ReplacePlan { readonly query: SearchQuery; readonly replacement: string; readonly edits: readonly ReplacementEdit[]; readonly targets: readonly ReplaceTarget[]; readonly generation: number; }
export interface ReplaceJournalEntry { readonly path: string; readonly source: ReplaceTarget['source']; readonly before: string; readonly after: string; readonly applied: boolean; readonly error?: string; }
export interface ReplaceJournal { readonly schemaVersion: 1; readonly operationId: string; readonly generation: number; readonly entries: readonly ReplaceJournalEntry[]; readonly status: 'applied' | 'partial' | 'restored'; }
export interface ReplaceApplyResult { readonly journal: ReplaceJournal; readonly restored: boolean; }
export interface ReplaceApplyPort { apply(plan: ReplacePlan): Promise<Result<ReplaceApplyResult, ReplaceFailure>>; readTarget(path: string): Promise<Result<ReplaceTarget, ReplaceFailure>>; restore(journal: ReplaceJournal): Promise<Result<void, ReplaceFailure>>; }
export type ReplaceFailure = { readonly kind: 'invalid-regex' | 'invalid-replacement' | 'stale' | 'conflict' | 'overlap' | 'failed' | 'disposed'; readonly message: string; readonly path?: string; readonly journal?: ReplaceJournal };

/** Applies a validated, non-overlapping preview without changing the source. */
export function applyReplacementEdits(text: string, edits: readonly ReplacementEdit[]): Result<string, ReplaceFailure> {
  const ordered = edits.slice().sort((left, right) => right.startUtf16 - left.startUtf16 || right.endUtf16 - left.endUtf16);
  let output = text;
  let nextStart = text.length + 1;
  for (const edit of ordered) {
    if (!Number.isSafeInteger(edit.startUtf16) || !Number.isSafeInteger(edit.endUtf16) || edit.startUtf16 < 0 || edit.endUtf16 < edit.startUtf16 || edit.endUtf16 > text.length || edit.endUtf16 > nextStart) {
      return failure('overlap', `replacement range is invalid for ${edit.path}`, edit.path);
    }
    if (text.slice(edit.startUtf16, edit.endUtf16) !== edit.original) return failure('stale', `replacement source changed in ${edit.path}`, edit.path);
    output = `${output.slice(0, edit.startUtf16)}${edit.replacement}${output.slice(edit.endUtf16)}`;
    nextStart = edit.startUtf16;
  }
  return { ok: true, value: output };
}

export class WorkspaceReplaceService implements Disposable {
  readonly #port: ReplaceApplyPort; #disposed = false;
  constructor(port: ReplaceApplyPort) { this.#port = port; }
  preview(query: SearchQuery, replacement: string, targets: readonly ReplaceTarget[], matches: readonly SearchMatch[], generation: number): Result<ReplacePlan, ReplaceFailure> {
    if (this.#disposed) return failure('disposed', 'replace service disposed');
    const expression = compile(query); if (!expression.ok) return expression;
    const targetMap = new Map<string, ReplaceTarget>();
    for (const target of targets) {
      const key = `${target.rootId}\0${target.path}`;
      if (targetMap.has(key)) return failure('conflict', `duplicate replace target: ${target.path}`, target.path);
      targetMap.set(key, target);
    }
    const byPath = new Map<string, ReplacementEdit[]>();
    for (const match of matches) {
      if (match.generation !== generation) return failure('stale', `match generation is stale: ${match.path}`, match.path);
      const target = targetMap.get(`${match.rootId}\0${match.path}`);
      if (target === undefined) return failure('stale', `replace target missing: ${match.path}`, match.path);
      const start = lineOffset(target.text, match.line, match.range.startUtf16);
      const end = lineOffset(target.text, match.endLine ?? match.line, match.range.endUtf16);
      if (start === undefined || end === undefined || end < start) return failure('stale', `match range is invalid: ${match.path}`, match.path);
      const original = target.text.slice(start, end);
      // Re-run against the full text with lastIndex at the match start, not against the
      // isolated matched slice: a lookaround (`(?=...)`, `(?<=...)`) depends on context outside
      // [start, end), so exec-ing just that slice always reports "match changed" even when
      // nothing changed. `found.index === start` still verifies the match begins exactly here
      // (the 'g' flag does not anchor lastIndex, so a later match must be rejected).
      expression.value.lastIndex = start;
      const found = expression.value.exec(target.text);
      if (found === null || found.index !== start || found[0].length !== original.length) return failure('stale', `match changed in ${match.path}`, match.path);
      const expanded = expandReplacement(replacement, found); if (!expanded.ok) return expanded;
      const edit = Object.freeze({ path: match.path, startUtf16: start, endUtf16: end, replacement: expanded.value, original });
      (byPath.get(match.path) ?? (byPath.set(match.path, []), byPath.get(match.path)!)).push(edit);
    }
    const edits: ReplacementEdit[] = [];
    for (const [path, pathEdits] of byPath) {
      pathEdits.sort((left, right) => left.startUtf16 - right.startUtf16 || left.endUtf16 - right.endUtf16);
      for (let index = 1; index < pathEdits.length; index += 1) {
        const prior = pathEdits[index - 1]; const current = pathEdits[index]; if (prior === undefined || current === undefined) continue;
        if (current.startUtf16 < prior.endUtf16 || current.startUtf16 === prior.startUtf16) return failure('overlap', `replacement edits overlap in ${path}`, path);
      }
      edits.push(...pathEdits);
    }
    return { ok: true, value: Object.freeze({ query, replacement, edits: Object.freeze(edits), targets: Object.freeze([...targets]), generation }) };
  }
  async apply(plan: ReplacePlan): Promise<Result<ReplaceApplyResult, ReplaceFailure>> {
    if (this.#disposed) return failure('disposed', 'replace service disposed');
    for (const target of plan.targets) {
      const current = await this.#port.readTarget(target.path); if (!current.ok) return current;
      if (!sameTarget(current.value, target)) return failure('conflict', `replace target changed: ${target.path}`, target.path);
    }
    return this.#port.apply(plan);
  }
  restore(journal: ReplaceJournal): Promise<Result<void, ReplaceFailure>> { return this.#disposed ? Promise.resolve(failure('disposed', 'replace service disposed')) : this.#port.restore(journal); }
  dispose(): void { this.#disposed = true; }
}
function compile(query: SearchQuery): Result<RegExp, ReplaceFailure> { try { const source = query.regex === true ? query.query : escapeRegExp(query.query); const body = query.wholeWord === true ? `\\b(?:${source})\\b` : source; return { ok: true, value: new RegExp(body, `gu${query.caseSensitive === true ? '' : 'i'}m`) }; } catch (error: unknown) { return failure('invalid-regex', error instanceof Error ? error.message : 'invalid regex'); } }
function expandReplacement(value: string, match: RegExpExecArray): Result<string, ReplaceFailure> {
  let output = ''; let transform: 'lower' | 'upper' | undefined; let nextTransform: 'lower' | 'upper' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === undefined) continue;
    if (character === '$') {
      const next = value[index + 1];
      if (next === '$' || next === '&') { output += applyCase(next, transform, nextTransform); nextTransform = undefined; index += 1; continue; }
      if (next === '<') { const close = value.indexOf('>', index + 2); if (close < 0) return failure('invalid-replacement', 'unterminated named capture'); const name = value.slice(index + 2, close); if (match.groups === undefined || !(name in match.groups)) return failure('invalid-replacement', `unknown capture: ${name}`); output += applyCase(match.groups[name] ?? '', transform, nextTransform); nextTransform = undefined; index = close; continue; }
      if (next !== undefined && /[0-9]/u.test(next)) { let end = index + 1; while (end < value.length && end < index + 3 && /[0-9]/u.test(value[end] ?? '')) end += 1; const capture = Number(value.slice(index + 1, end)); if (capture > 99) return failure('invalid-replacement', 'numeric capture must be between 1 and 99'); output += applyCase(match[capture] ?? '', transform, nextTransform); nextTransform = undefined; index = end - 1; continue; }
      return failure('invalid-replacement', 'unsupported replacement dollar escape');
    }
    if (character === '\\') { const escaped = value[index + 1]; if (escaped === undefined) return failure('invalid-replacement', 'trailing replacement backslash'); if (escaped === 'L' || escaped === 'U') { transform = escaped === 'L' ? 'lower' : 'upper'; index += 1; continue; } if (escaped === 'E') { transform = undefined; index += 1; continue; } if (escaped === 'l' || escaped === 'u') { nextTransform = escaped === 'l' ? 'lower' : 'upper'; index += 1; continue; } if (escaped === '\\') { output += applyCase('\\', transform, nextTransform); nextTransform = undefined; index += 1; continue; } return failure('invalid-replacement', `unsupported replacement escape: \\${escaped}`); }
    output += applyCase(character, transform, nextTransform); nextTransform = undefined;
  }
  return { ok: true, value: output };
}
function applyCase(value: string, transform: 'lower' | 'upper' | undefined, next: 'lower' | 'upper' | undefined): string { const mode = next ?? transform; return mode === 'lower' ? value.toLocaleLowerCase('en-US') : mode === 'upper' ? value.toLocaleUpperCase('en-US') : value; }
function lineOffset(text: string, line: number, column: number): number | undefined { if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 0 || column < 0) return undefined; let currentLine = 0; let offset = 0; while (currentLine < line) { const newline = text.indexOf('\n', offset); if (newline < 0) return undefined; offset = newline + 1; currentLine += 1; } const nextNewline = text.indexOf('\n', offset); const lineEnd = nextNewline < 0 ? text.length : nextNewline; const logicalEnd = lineEnd > offset && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd; return offset + column <= logicalEnd ? offset + column : undefined; }
function sameTarget(actual: ReplaceTarget, expected: ReplaceTarget): boolean { return actual.rootId === expected.rootId && actual.path === expected.path && actual.text === expected.text && actual.source === expected.source && actual.version === expected.version && actual.diskHash === expected.diskHash; }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
function failure(kind: ReplaceFailure['kind'], message: string, path?: string): Result<never, ReplaceFailure> { return { ok: false, error: { kind, message, ...(path === undefined ? {} : { path }) } }; }
