import { CancellationSource, type Disposable, type Result } from '../../contracts/src/index';
import type { LanguageProviderSession } from './provider-session';

interface DecorationSession extends LanguageProviderSession {
  supportsRequest(method: string, uri?: string): boolean;
  waitForReady(uri?: string): Promise<Result<unknown, unknown>>;
}

interface DecorationDocument { readonly id: string; readonly uri: string; readonly version: number; readonly lineCount: number; }

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

export interface DocumentColorSwatch {
  readonly id: string;
  readonly line: number;
  readonly utf16: number;
  readonly color: string;
}

export interface DocumentHighlightRange {
  readonly startLine: number;
  readonly startUtf16: number;
  readonly endLine: number;
  readonly endUtf16: number;
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

export interface ColorResult {
  readonly documentId: string;
  readonly documentVersion: number;
  readonly generation: number;
  readonly colors: readonly DocumentColorSwatch[];
}

export interface DocumentHighlightResult {
  readonly documentId: string;
  readonly documentVersion: number;
  readonly generation: number;
  readonly ranges: readonly DocumentHighlightRange[];
}

export type FoldingFailure = {
  readonly kind: 'invalid-range' | 'overlap' | 'stale' | 'disposed' | 'invalid-result' | 'not-found' | 'execution-failed';
  readonly message: string;
};

export type PresentationResolve<T> = (value: T) => Promise<Result<T, FoldingFailure>>;
export type PresentationExecute = (command: string) => Promise<Result<void, FoldingFailure>>;

/** Decode the LSP `textDocument/inlayHint` result at the protocol boundary. */
export function decodeInlayHints(value: unknown, documentId: string, documentVersion: number, generation: number, lengthLimit?: number): Result<HintResult, FoldingFailure> {
  if (!Array.isArray(value) && value !== null) return failure('invalid-result', 'inlay hint result must be an array or null');
  const hints: InlayHint[] = [];
  const values = value === null ? [] : value;
  if (values.length > MAX_PRESENTATION_ITEMS) return failure('invalid-result', 'hint result exceeds the presentation limit');
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!isRecord(item)) return failure('invalid-result', 'inlay hint is not an object');
    const position = isRecord(item.position) ? item.position : undefined;
    const line = position?.line;
    const utf16 = position?.character;
    const label = inlayLabel(item.label);
    if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 0 || typeof utf16 !== 'number' || !Number.isSafeInteger(utf16) || utf16 < 0 || label === undefined) return failure('invalid-result', 'inlay hint position or label is invalid');
    const text = lengthLimit === undefined ? label : label.slice(0, lengthLimit);
    if (text.length === 0) continue;
    hints.push(Object.freeze({ id: `${documentId}:inlay:${String(documentVersion)}:${String(index)}`, line, utf16, label: text }));
  }
  return { ok: true, value: Object.freeze({ documentId, documentVersion, generation, hints: Object.freeze(hints), lenses: Object.freeze([]) }) };
}

/** Decode the LSP `textDocument/documentColor` result at the protocol boundary. */
export function decodeDocumentColors(value: unknown, documentId: string, documentVersion: number, generation: number): Result<ColorResult, FoldingFailure> {
  if (!Array.isArray(value) && value !== null) return failure('invalid-result', 'document color result must be an array or null');
  const colors: DocumentColorSwatch[] = [];
  const values = value === null ? [] : value;
  if (values.length > MAX_PRESENTATION_ITEMS) return failure('invalid-result', 'document color result exceeds the presentation limit');
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!isRecord(item)) return failure('invalid-result', 'document color entry is not an object');
    const range = isRecord(item.range) ? item.range : undefined;
    const start = lspPosition(range?.start);
    const end = lspPosition(range?.end);
    const color = colorHex(item.color);
    if (start === undefined || end === undefined || color === undefined
      || comparePosition(start.line, start.utf16, end.line, end.utf16) > 0) {
      return failure('invalid-result', 'document color range or color is invalid');
    }
    colors.push(Object.freeze({ id: `${documentId}:color:${String(documentVersion)}:${String(index)}`, line: start.line, utf16: start.utf16, color }));
  }
  return { ok: true, value: Object.freeze({ documentId, documentVersion, generation, colors: Object.freeze(colors) }) };
}

/** Decode the LSP `textDocument/documentHighlight` result at the protocol boundary. */
export function decodeDocumentHighlights(value: unknown, documentId: string, documentVersion: number, generation: number): Result<DocumentHighlightResult, FoldingFailure> {
  if (!Array.isArray(value) && value !== null) return failure('invalid-result', 'document highlight result must be an array or null');
  const ranges: DocumentHighlightRange[] = [];
  const values = value === null ? [] : value;
  if (values.length > MAX_PRESENTATION_ITEMS) return failure('invalid-result', 'document highlight result exceeds the presentation limit');
  for (const item of values) {
    if (!isRecord(item)) return failure('invalid-result', 'document highlight entry is not an object');
    const range = isRecord(item.range) ? item.range : undefined;
    const start = lspPosition(range?.start);
    const end = lspPosition(range?.end);
    if (start === undefined || end === undefined || comparePosition(start.line, start.utf16, end.line, end.utf16) >= 0) {
      return failure('invalid-result', 'document highlight range is invalid');
    }
    ranges.push(Object.freeze({ startLine: start.line, startUtf16: start.utf16, endLine: end.line, endUtf16: end.utf16 }));
  }
  return { ok: true, value: Object.freeze({ documentId, documentVersion, generation, ranges: Object.freeze(ranges) }) };
}

/** Owns versioned language decorations; layout consumes only immutable read results. */
export class LanguagePresentationFeatures implements Disposable {
  #folds = new Map<string, FoldingResult>();
  #selectionRanges = new Map<string, SelectionRangeResult>();
  #hints = new Map<string, HintResult>();
  #colors = new Map<string, ColorResult>();
  #documentHighlights = new Map<string, DocumentHighlightResult>();
  #resolutionTokens = new Map<string, number>();
  #requestGenerations = new Map<string, number>();
  #pendingRequests = new Map<string, CancellationSource>();
  #disposed = false;

  refreshInlayHints(session: DecorationSession, document: DecorationDocument, lengthLimit: number | undefined, currentVersion: () => number | undefined, onApplied?: (result: HintResult) => void): Promise<void> {
    return this.requestDecoration('textDocument/inlayHint', session, document,
      { textDocument: { uri: document.uri }, range: { start: { line: 0, character: 0 }, end: { line: Math.max(0, document.lineCount), character: 0 } } },
      (value, generation) => decodeInlayHints(value, document.id, document.version, generation, lengthLimit),
      (result) => this.applyHints(result), currentVersion, onApplied);
  }

  refreshDocumentColors(session: DecorationSession, document: DecorationDocument, currentVersion: () => number | undefined, onApplied?: (result: ColorResult) => void): Promise<void> {
    return this.requestDecoration('textDocument/documentColor', session, document, { textDocument: { uri: document.uri } },
      (value, generation) => decodeDocumentColors(value, document.id, document.version, generation),
      (result) => this.applyColors(result), currentVersion, onApplied);
  }

  refreshDocumentHighlights(session: DecorationSession, document: DecorationDocument, line: number, utf16: number, currentVersion: () => number | undefined, onApplied?: (result: DocumentHighlightResult) => void): Promise<void> {
    if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(utf16) || utf16 < 0) return Promise.resolve();
    return this.requestDecoration('textDocument/documentHighlight', session, document,
      { textDocument: { uri: document.uri }, position: { line, character: utf16 } },
      (value, generation) => decodeDocumentHighlights(value, document.id, document.version, generation),
      (result) => this.applyDocumentHighlights(result), currentVersion, onApplied);
  }

  private async requestDecoration<T>(
    method: string, session: DecorationSession, document: DecorationDocument, params: unknown,
    decode: (value: unknown, generation: number) => Result<T, FoldingFailure>,
    apply: (result: T) => Result<T, FoldingFailure>, currentVersion: () => number | undefined, onApplied?: (result: T) => void,
  ): Promise<void> {
    const key = `${method}\0${document.id}`;
    this.#pendingRequests.get(key)?.cancel();
    if (this.#disposed || !session.supportsRequest(method, document.uri)) return;
    const cancellation = new CancellationSource();
    const generation = (this.#requestGenerations.get(key) ?? 0) + 1;
    this.#requestGenerations.set(key, generation);
    this.#pendingRequests.set(key, cancellation);
    try {
      const ready = await session.waitForReady(document.uri);
      if (!ready.ok || cancellation.token.isCancelled || this.#disposed || currentVersion() !== document.version || !session.supportsRequest(method, document.uri)) return;
      const value = await session.request<unknown>(method, params, cancellation.token);
      if (cancellation.token.isCancelled || this.#disposed || currentVersion() !== document.version) return;
      const decoded = decode(value, generation);
      if (decoded.ok) {
        const applied = apply(decoded.value);
        if (applied.ok) onApplied?.(applied.value);
      }
    } catch {
      // Optional providers may withdraw capability or stop while a request is in flight.
    } finally {
      if (this.#pendingRequests.get(key) === cancellation) this.#pendingRequests.delete(key);
      cancellation.dispose();
    }
  }

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

  applyColors(result: ColorResult): Result<ColorResult, FoldingFailure> {
    if (this.#disposed) return failure('disposed', 'presentation features disposed');
    const checked = validateEnvelope(result);
    if (!checked.ok) return checked;
    const previous = this.#colors.get(result.documentId);
    if (isOlder(result, previous)) return failure('stale', 'color result is stale');
    const colors = validateColors(result.colors);
    if (!colors.ok) return colors;
    const value = Object.freeze({ ...result, colors: colors.value });
    this.#colors.set(result.documentId, value);
    return { ok: true, value };
  }

  applyDocumentHighlights(result: DocumentHighlightResult): Result<DocumentHighlightResult, FoldingFailure> {
    if (this.#disposed) return failure('disposed', 'presentation features disposed');
    const checked = validateEnvelope(result);
    if (!checked.ok) return checked;
    const previous = this.#documentHighlights.get(result.documentId);
    if (isOlder(result, previous)) return failure('stale', 'document highlight result is stale');
    if (!Array.isArray(result.ranges) || result.ranges.length > MAX_PRESENTATION_ITEMS) return failure('invalid-result', 'document highlight result exceeds the presentation limit');
    for (const range of result.ranges) {
      if (!Number.isSafeInteger(range.startLine) || range.startLine < 0 || !Number.isSafeInteger(range.startUtf16) || range.startUtf16 < 0
        || !Number.isSafeInteger(range.endLine) || range.endLine < 0 || !Number.isSafeInteger(range.endUtf16) || range.endUtf16 < 0
        || comparePosition(range.startLine, range.startUtf16, range.endLine, range.endUtf16) >= 0) return failure('invalid-range', 'document highlight range is invalid');
    }
    const value = Object.freeze({ ...result, ranges: Object.freeze(result.ranges.map((range) => Object.freeze({ ...range }))) });
    this.#documentHighlights.set(result.documentId, value);
    return { ok: true, value };
  }

  folds(documentId: string): readonly FoldRange[] { return this.#folds.get(documentId)?.folds ?? EMPTY_FOLDS; }

  selectionRanges(documentId: string): readonly SelectionRange[] {
    return this.#selectionRanges.get(documentId)?.ranges ?? EMPTY_SELECTION_RANGES;
  }

  hints(documentId: string): HintResult | undefined { return this.#hints.get(documentId); }

  colors(documentId: string): ColorResult | undefined { return this.#colors.get(documentId); }

  documentHighlights(documentId: string): DocumentHighlightResult | undefined { return this.#documentHighlights.get(documentId); }

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
    for (const [key, cancellation] of this.#pendingRequests) if (key.endsWith(`\0${documentId}`)) { cancellation.cancel(); this.#pendingRequests.delete(key); }
    for (const key of this.#requestGenerations.keys()) if (key.endsWith(`\0${documentId}`)) this.#requestGenerations.delete(key);
    this.#folds.delete(documentId);
    this.#selectionRanges.delete(documentId);
    this.#hints.delete(documentId);
    this.#colors.delete(documentId);
    this.#documentHighlights.delete(documentId);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const cancellation of this.#pendingRequests.values()) cancellation.cancel();
    this.#pendingRequests.clear();
    this.#requestGenerations.clear();
    this.#folds.clear();
    this.#selectionRanges.clear();
    this.#hints.clear();
    this.#colors.clear();
    this.#documentHighlights.clear();
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

function validateColors(colors: readonly DocumentColorSwatch[]): Result<readonly DocumentColorSwatch[], FoldingFailure> {
  if (!Array.isArray(colors) || colors.length > MAX_PRESENTATION_ITEMS) return failure('invalid-result', 'document color result exceeds the presentation limit');
  const ids = new Set<string>();
  const output: DocumentColorSwatch[] = [];
  for (const color of colors) {
    if (!isRecord(color)) return failure('invalid-result', 'document color entry is invalid or duplicated');
    const id = color['id'];
    const line = color['line'];
    const utf16 = color['utf16'];
    const value = color['color'];
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_LABEL_UTF16 || ids.has(id)
      || typeof line !== 'number' || !Number.isSafeInteger(line) || line < 0
      || typeof utf16 !== 'number' || !Number.isSafeInteger(utf16) || utf16 < 0
      || typeof value !== 'string' || !/^#[0-9a-f]{6}$/u.test(value)) return failure('invalid-result', 'document color entry is invalid or duplicated');
    ids.add(id);
    output.push(Object.freeze({ id, line, utf16, color: value }));
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

function inlayLabel(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length <= MAX_LABEL_UTF16 ? value : undefined;
  if (!Array.isArray(value)) return undefined;
  let output = '';
  for (const part of value) {
    if (!isRecord(part) || typeof part.value !== 'string') return undefined;
    output += part.value;
    if (output.length > MAX_LABEL_UTF16) return undefined;
  }
  return output;
}

function lspPosition(value: unknown): { readonly line: number; readonly utf16: number } | undefined {
  if (!isRecord(value)) return undefined;
  const line = value['line'];
  const utf16 = value['character'];
  return typeof line === 'number' && Number.isSafeInteger(line) && line >= 0
    && typeof utf16 === 'number' && Number.isSafeInteger(utf16) && utf16 >= 0
    ? { line, utf16 } : undefined;
}

function colorHex(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const channels = ['red', 'green', 'blue', 'alpha'] as const;
  if (channels.some((channel) => typeof value[channel] !== 'number' || !Number.isFinite(value[channel]) || value[channel] < 0 || value[channel] > 1)) return undefined;
  const channel = (name: 'red' | 'green' | 'blue'): string => Math.round(value[name] as number * 255).toString(16).padStart(2, '0');
  return `#${channel('red')}${channel('green')}${channel('blue')}`;
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
