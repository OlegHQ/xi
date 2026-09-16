import type { Disposable, Result } from '../../contracts/src/index';

const EMPTY_FOLDS: readonly FoldRange[] = Object.freeze([]);
const EMPTY_SELECTION_RANGES: readonly SelectionRange[] = Object.freeze([]);
const MAX_PRESENTATION_ITEMS = 10_000;
const MAX_LABEL_UTF16 = 16 * 1024;
const MAX_SELECTION_RANGE_DEPTH = 128;

export interface FoldRange {
  /** Zero-based logical lines; endLine is exclusive. */
  readonly startLine: number;
  readonly endLine: number;
  readonly collapsed?: boolean;
}

export interface SelectionRange {
  /** Zero-based UTF-16 line/column positions; end is exclusive. */
  readonly startLine: number;
  readonly startUtf16: number;
  readonly endLine: number;
  readonly endUtf16: number;
  readonly parent?: SelectionRange;
}

export interface InlayHint {
  readonly id: string;
  readonly line: number;
  readonly utf16: number;
  readonly label: string;
  readonly resolveData?: unknown;
}

export interface CodeLens {
  readonly id: string;
  readonly line: number;
  readonly command: string;
  readonly title: string;
  readonly resolveData?: unknown;
}

export interface FoldingResult {
  readonly documentId: string;
  readonly documentVersion: number;
  readonly generation: number;
  readonly folds: readonly FoldRange[];
}

export interface SelectionRangeResult {
  readonly documentId: string;
  readonly documentVersion: number;
  readonly generation: number;
  /** One nested range tree for each requested source position, in request order. */
  readonly ranges: readonly SelectionRange[];
}

export interface HintResult {
  readonly documentId: string;
  readonly documentVersion: number;
  readonly generation: number;
  readonly hints: readonly InlayHint[];
  readonly lenses: readonly CodeLens[];
}

export type FoldingFailure = {
  readonly kind: 'invalid-range' | 'overlap' | 'stale' | 'disposed' | 'invalid-result' | 'not-found' | 'execution-failed';
  readonly message: string;
};

export type PresentationResolve<T> = (value: T) => Promise<Result<T, FoldingFailure>>;
export type PresentationExecute = (command: string) => Promise<Result<void, FoldingFailure>>;

/** Owns versioned language decorations; layout consumes only immutable read results. */
export class LanguagePresentationFeatures implements Disposable {
  #folds = new Map<string, FoldingResult>();
  #selectionRanges = new Map<string, SelectionRangeResult>();
  #hints = new Map<string, HintResult>();
  #resolutionTokens = new Map<string, number>();
  #disposed = false;

  applyFolds(result: FoldingResult): Result<FoldingResult, FoldingFailure> {
    if (this.#disposed) return failure('disposed', 'presentation features disposed');
    const checked = validateEnvelope(result);
    if (!checked.ok) return checked;
    const previous = this.#folds.get(result.documentId);
    if (isOlder(result, previous)) return failure('stale', 'fold result is stale');
    const folds = validateFolds(result.folds);
    if (!folds.ok) return folds;
    const value = Object.freeze({ ...result, folds: folds.value });
    this.#folds.set(result.documentId, value);
    return { ok: true, value };
  }

  applySelectionRanges(result: SelectionRangeResult): Result<SelectionRangeResult, FoldingFailure> {
    if (this.#disposed) return failure('disposed', 'presentation features disposed');
    const checked = validateEnvelope(result);
    if (!checked.ok) return checked;
    const previous = this.#selectionRanges.get(result.documentId);
    if (isOlder(result, previous)) return failure('stale', 'selection range result is stale');
    if (!Array.isArray(result.ranges) || result.ranges.length > MAX_PRESENTATION_ITEMS) return failure('invalid-result', 'selection range result exceeds the presentation limit');
    const ranges: SelectionRange[] = [];
    for (const range of result.ranges) {
      const checkedRange = cloneSelectionRange(range, new Set<SelectionRange>(), 0);
      if (!checkedRange.ok) return checkedRange;
      ranges.push(checkedRange.value);
    }
    const value = Object.freeze({ ...result, ranges: Object.freeze(ranges) });
    this.#selectionRanges.set(result.documentId, value);
    return { ok: true, value };
  }

  applyHints(result: HintResult): Result<HintResult, FoldingFailure> {
    if (this.#disposed) return failure('disposed', 'presentation features disposed');
    const checked = validateEnvelope(result);
    if (!checked.ok) return checked;
    const previous = this.#hints.get(result.documentId);
    if (isOlder(result, previous)) return failure('stale', 'hint result is stale');
    const hints = validateHints(result.hints);
    if (!hints.ok) return hints;
    const lenses = validateLenses(result.lenses);
    if (!lenses.ok) return lenses;
    const value = Object.freeze({ ...result, hints: hints.value, lenses: lenses.value });
    this.#hints.set(result.documentId, value);
    return { ok: true, value };
  }

  folds(documentId: string): readonly FoldRange[] { return this.#folds.get(documentId)?.folds ?? EMPTY_FOLDS; }

  selectionRanges(documentId: string): readonly SelectionRange[] {
    return this.#selectionRanges.get(documentId)?.ranges ?? EMPTY_SELECTION_RANGES;
  }

  hints(documentId: string): HintResult | undefined { return this.#hints.get(documentId); }

  /** Return only decorations in the visible logical-line window, with a hard cap. */
  visibleHints(documentId: string, startLine: number, endLine: number, limit = 256): HintResult | undefined {
    const result = this.#hints.get(documentId);
    if (result === undefined || !validWindow(startLine, endLine) || !Number.isSafeInteger(limit) || limit < 1) return undefined;
    const safeLimit = Math.min(limit, MAX_PRESENTATION_ITEMS);
    return Object.freeze({
      ...result,
      hints: Object.freeze(result.hints.filter((hint) => hint.line >= startLine && hint.line < endLine).slice(0, safeLimit)),
      lenses: Object.freeze(result.lenses.filter((lens) => lens.line >= startLine && lens.line < endLine).slice(0, safeLimit)),
    });
  }

  async resolveHint(documentId: string, id: string, generation: number, resolve: PresentationResolve<InlayHint>): Promise<Result<InlayHint, FoldingFailure>> {
    const current = this.#hints.get(documentId);
    if (this.#disposed) return failure('disposed', 'presentation features disposed');
    if (current === undefined || current.generation !== generation) return failure('stale', 'hint resolve target is stale');
    const hint = current.hints.find((candidate) => candidate.id === id);
    if (hint === undefined) return failure('not-found', `hint ${id} was not found`);
    const token = this.nextResolutionToken(`hint:${documentId}:${id}`);
    let resolved: Result<InlayHint, FoldingFailure>;
    try {
      resolved = await resolve(hint);
    } catch (error) {
      return failure('execution-failed', errorMessage(error));
    }
    if (!resolved.ok) return resolved;
    if (!this.isCurrentResolution(`hint:${documentId}:${id}`, token, current)) return failure('stale', 'hint resolve completed out of order');
    const next = Object.freeze({ ...current, hints: Object.freeze(current.hints.map((item) => item.id === id ? resolved.value : item)) });
    this.#hints.set(documentId, next);
    return { ok: true, value: resolved.value };
  }

  async resolveLens(documentId: string, id: string, generation: number, resolve: PresentationResolve<CodeLens>): Promise<Result<CodeLens, FoldingFailure>> {
    const current = this.#hints.get(documentId);
    if (this.#disposed) return failure('disposed', 'presentation features disposed');
    if (current === undefined || current.generation !== generation) return failure('stale', 'code lens resolve target is stale');
    const lens = current.lenses.find((candidate) => candidate.id === id);
    if (lens === undefined) return failure('not-found', `code lens ${id} was not found`);
    const token = this.nextResolutionToken(`lens:${documentId}:${id}`);
    let resolved: Result<CodeLens, FoldingFailure>;
    try {
      resolved = await resolve(lens);
    } catch (error) {
      return failure('execution-failed', errorMessage(error));
    }
    if (!resolved.ok) return resolved;
    if (!this.isCurrentResolution(`lens:${documentId}:${id}`, token, current)) return failure('stale', 'code lens resolve completed out of order');
    const next = Object.freeze({ ...current, lenses: Object.freeze(current.lenses.map((item) => item.id === id ? resolved.value : item)) });
    this.#hints.set(documentId, next);
    return { ok: true, value: resolved.value };
  }

  async executeLens(documentId: string, id: string, generation: number, execute: PresentationExecute): Promise<Result<void, FoldingFailure>> {
    const current = this.#hints.get(documentId);
    if (this.#disposed) return failure('disposed', 'presentation features disposed');
    if (current === undefined || current.generation !== generation) return failure('stale', 'code lens execution target is stale');
    const lens = current.lenses.find((candidate) => candidate.id === id);
    if (lens === undefined) return failure('not-found', `code lens ${id} was not found`);
    try {
      const result = await execute(lens.command);
      return result.ok ? result : failure('execution-failed', result.error.message);
    } catch (error) {
      return failure('execution-failed', errorMessage(error));
    }
  }

  clear(documentId: string): void {
    this.#folds.delete(documentId);
    this.#selectionRanges.delete(documentId);
    this.#hints.delete(documentId);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#folds.clear();
    this.#selectionRanges.clear();
    this.#hints.clear();
    this.#resolutionTokens.clear();
  }

  private nextResolutionToken(key: string): number {
    const token = (this.#resolutionTokens.get(key) ?? 0) + 1;
    this.#resolutionTokens.set(key, token);
    return token;
  }

  private isCurrentResolution(key: string, token: number, result: FoldingResult | HintResult): boolean {
    return this.#resolutionTokens.get(key) === token && this.#hints.get(result.documentId) === result && !this.#disposed;
  }
}

function validateEnvelope(result: unknown): Result<void, FoldingFailure> {
  if (!isRecord(result)) return failure('invalid-result', 'presentation result must be an object');
  const documentId = result['documentId'];
  const documentVersion = result['documentVersion'];
  const generation = result['generation'];
  return typeof documentId === 'string' && documentId.length > 0 && documentId.length <= MAX_LABEL_UTF16
    && typeof documentVersion === 'number' && Number.isSafeInteger(documentVersion) && documentVersion >= 0
    && typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0
    ? { ok: true, value: undefined }
    : failure('invalid-result', 'presentation result identity or generation is invalid');
}

function isOlder<T extends { readonly documentVersion: number; readonly generation: number }>(result: T, previous: T | undefined): boolean {
  return previous !== undefined && (result.generation < previous.generation || result.documentVersion < previous.documentVersion);
}

function validateFolds(folds: readonly FoldRange[]): Result<readonly FoldRange[], FoldingFailure> {
  if (!Array.isArray(folds) || folds.length > MAX_PRESENTATION_ITEMS) return failure('invalid-result', 'fold result exceeds the presentation limit');
  const candidates: FoldRange[] = [];
  for (const item of folds) {
    if (!isRecord(item)) return failure('invalid-range', 'fold ranges must be objects');
    const startLine = item['startLine'];
    const endLine = item['endLine'];
    const collapsed = item['collapsed'];
    if (typeof startLine !== 'number' || typeof endLine !== 'number' || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
      || typeof collapsed !== 'undefined' && typeof collapsed !== 'boolean') {
      return failure('invalid-range', 'fold ranges must span positive ordered lines');
    }
    candidates.push({ startLine, endLine, ...(typeof collapsed === 'undefined' ? {} : { collapsed }) });
  }
  const sorted = candidates.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  for (const fold of sorted) {
    if (fold.startLine < 0 || fold.endLine <= fold.startLine) {
      return failure('invalid-range', 'fold ranges must span positive ordered lines');
    }
  }
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    if (current === undefined) continue;
    for (let nextIndex = index + 1; nextIndex < sorted.length; nextIndex += 1) {
      const next = sorted[nextIndex];
      if (next === undefined || next.startLine >= current.endLine) break;
      if (next.endLine > current.endLine) return failure('overlap', 'crossing fold ranges are not supported');
    }
  }
  return { ok: true, value: Object.freeze(sorted.map((fold) => Object.freeze({ ...fold }))) };
}

function validateHints(hints: readonly InlayHint[]): Result<readonly InlayHint[], FoldingFailure> {
  if (!Array.isArray(hints) || hints.length > MAX_PRESENTATION_ITEMS) return failure('invalid-result', 'hint result exceeds the presentation limit');
  const ids = new Set<string>();
  const output: InlayHint[] = [];
  for (const hint of hints) {
    if (!isRecord(hint)) return failure('invalid-result', 'inlay hint is invalid or duplicated');
    const id = hint['id'];
    const line = hint['line'];
    const utf16 = hint['utf16'];
    const label = hint['label'];
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_LABEL_UTF16 || ids.has(id)
      || typeof line !== 'number' || !Number.isSafeInteger(line) || line < 0 || typeof utf16 !== 'number' || !Number.isSafeInteger(utf16) || utf16 < 0
      || typeof label !== 'string' || label.length > MAX_LABEL_UTF16) return failure('invalid-result', 'inlay hint is invalid or duplicated');
    ids.add(id);
    output.push(Object.freeze({ id, line, utf16, label, ...(Object.hasOwn(hint, 'resolveData') ? { resolveData: hint['resolveData'] } : {}) }));
  }
  return { ok: true, value: Object.freeze(output) };
}

function validateLenses(lenses: readonly CodeLens[]): Result<readonly CodeLens[], FoldingFailure> {
  if (!Array.isArray(lenses) || lenses.length > MAX_PRESENTATION_ITEMS) return failure('invalid-result', 'code lens result exceeds the presentation limit');
  const ids = new Set<string>();
  const output: CodeLens[] = [];
  for (const lens of lenses) {
    if (!isRecord(lens)) return failure('invalid-result', 'code lens is invalid or duplicated');
    const id = lens['id'];
    const line = lens['line'];
    const command = lens['command'];
    const title = lens['title'];
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_LABEL_UTF16 || ids.has(id)
      || typeof line !== 'number' || !Number.isSafeInteger(line) || line < 0 || typeof command !== 'string' || command.length === 0 || command.length > MAX_LABEL_UTF16
      || typeof title !== 'string' || title.length === 0 || title.length > MAX_LABEL_UTF16) return failure('invalid-result', 'code lens is invalid or duplicated');
    ids.add(id);
    output.push(Object.freeze({ id, line, command, title, ...(Object.hasOwn(lens, 'resolveData') ? { resolveData: lens['resolveData'] } : {}) }));
  }
  return { ok: true, value: Object.freeze(output) };
}

function cloneSelectionRange(range: SelectionRange, seen: Set<SelectionRange>, depth: number): Result<SelectionRange, FoldingFailure> {
  if (seen.has(range) || depth > MAX_SELECTION_RANGE_DEPTH || range === null || typeof range !== 'object') return failure('invalid-range', 'selection range nesting is cyclic or too deep');
  if (!Number.isSafeInteger(range.startLine) || !Number.isSafeInteger(range.startUtf16) || !Number.isSafeInteger(range.endLine) || !Number.isSafeInteger(range.endUtf16)
    || range.startLine < 0 || range.startUtf16 < 0 || range.endLine < range.startLine || range.endUtf16 < 0
    || range.startLine === range.endLine && range.endUtf16 < range.startUtf16) return failure('invalid-range', 'selection range coordinates are invalid');
  seen.add(range);
  let parent: SelectionRange | undefined;
  if (range.parent !== undefined) {
    const checked = cloneSelectionRange(range.parent, seen, depth + 1);
    if (!checked.ok) return checked;
    if (comparePosition(checked.value.startLine, checked.value.startUtf16, range.startLine, range.startUtf16) > 0
      || comparePosition(checked.value.endLine, checked.value.endUtf16, range.endLine, range.endUtf16) < 0) return failure('overlap', 'selection range parent does not contain its child');
    parent = checked.value;
  }
  seen.delete(range);
  return { ok: true, value: Object.freeze({ startLine: range.startLine, startUtf16: range.startUtf16, endLine: range.endLine, endUtf16: range.endUtf16, ...(parent === undefined ? {} : { parent }) }) };
}

function comparePosition(leftLine: number, leftUtf16: number, rightLine: number, rightUtf16: number): number {
  return leftLine - rightLine || leftUtf16 - rightUtf16;
}

function validWindow(startLine: number, endLine: number): boolean {
  return Number.isSafeInteger(startLine) && Number.isSafeInteger(endLine) && startLine >= 0 && endLine > startLine;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(kind: FoldingFailure['kind'], message: string): Result<never, FoldingFailure> {
  return { ok: false, error: { kind, message } };
}
