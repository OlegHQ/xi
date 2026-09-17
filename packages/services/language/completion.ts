import type { CancellationToken, Disposable, Result } from '../../contracts/src/index';
import { requestIsSupported, type LanguageProviderSession } from './provider-session';

export interface CompletionPosition { readonly line: number; readonly utf16: number; }
export interface CompletionTextEdit { readonly start: CompletionPosition; readonly end: CompletionPosition; readonly newText: string; }
export interface CompletionItem { readonly id: string; readonly label: string; readonly detail?: string; readonly documentation?: string; readonly textEdit?: CompletionTextEdit; readonly additionalTextEdits?: readonly CompletionTextEdit[]; readonly commitCharacters?: readonly string[]; readonly insertTextFormat?: 'plain' | 'snippet'; readonly resolveData?: unknown; }
export interface CompletionRequest { readonly documentId: string; readonly documentVersion: number; readonly selectionGeneration: number; readonly position: CompletionPosition; readonly trigger: 'invoked' | 'character' | 'retrigger'; readonly uri?: string; }
export interface CompletionList { readonly isIncomplete: boolean; readonly items: readonly CompletionItem[]; }
export type CompletionFailure = { readonly kind: 'stale' | 'invalid-edit' | 'overlap' | 'disposed' | 'unavailable'; readonly message: string };
export type CompletionAction =
  | { readonly kind: 'newline' }
  | { readonly kind: 'insert'; readonly item: CompletionItem; readonly edits: readonly CompletionTextEdit[] }
  | { readonly kind: 'move'; readonly delta: -1 | 1 }
  | { readonly kind: 'cancel' };

export interface CompletionReadModel { readonly state: 'idle' | 'loading' | 'ready' | 'error'; readonly request: CompletionRequest | undefined; readonly items: readonly CompletionItem[]; readonly isIncomplete: boolean; readonly selectedId: string | undefined; readonly documentation: string | undefined; readonly documentationOffset: number; readonly message: string | undefined; }

export interface CompletionProvider {
  complete(request: CompletionRequest, cancellation?: CancellationToken): Promise<Result<CompletionList, CompletionFailure>>;
  resolve?(item: CompletionItem): Promise<Result<CompletionItem, CompletionFailure>>;
}

/** Native LSP completion adapter. Validation happens before the controller publishes items. */
export class LanguageServerCompletionProvider implements CompletionProvider {
  readonly #session: LanguageProviderSession;
  constructor(session: LanguageProviderSession) { this.#session = session; }

  async complete(request: CompletionRequest, cancellation?: CancellationToken): Promise<Result<CompletionList, CompletionFailure>> {
    if (request.uri === undefined) return { ok: false, error: { kind: 'unavailable', message: 'completion request has no document URI' } };
    if (!requestIsSupported(this.#session, 'textDocument/completion', request.uri)) return { ok: false, error: { kind: 'unavailable', message: 'language server does not provide completion' } };
    try {
      const response = await this.#session.request<unknown>('textDocument/completion', {
        textDocument: { uri: request.uri },
        position: { line: request.position.line, character: request.position.utf16 },
        context: { triggerKind: request.trigger === 'character' ? 2 : request.trigger === 'retrigger' ? 3 : 1 },
      }, cancellation);
      const record = asRecord(response);
      const values = Array.isArray(response) ? response : Array.isArray(record?.items) ? record.items : response === null ? [] : undefined;
      if (values === undefined) return { ok: false, error: { kind: 'unavailable', message: 'language server returned invalid completions' } };
      const items: CompletionItem[] = [];
      for (let index = 0; index < values.length; index += 1) {
        const item = parseCompletionItem(values[index], `${request.documentId}:${request.documentVersion}:${index}`, request.position);
        if (item === undefined) return { ok: false, error: { kind: 'unavailable', message: 'language server returned an invalid completion item' } };
        items.push(item);
      }
      return { ok: true, value: Object.freeze({ isIncomplete: record?.isIncomplete === true, items: Object.freeze(items) }) };
    } catch (error: unknown) { return { ok: false, error: { kind: 'unavailable', message: errorMessage(error) } }; }
  }

  async resolve(item: CompletionItem): Promise<Result<CompletionItem, CompletionFailure>> {
    if (!requestIsSupported(this.#session, 'completionItem/resolve')) return { ok: false, error: { kind: 'unavailable', message: 'language server does not provide completion item resolution' } };
    try {
      const resolved = await this.#session.request<unknown>('completionItem/resolve', { label: item.label, ...(item.detail === undefined ? {} : { detail: item.detail }), ...(item.resolveData === undefined ? {} : { data: item.resolveData }) });
      const parsed = parseCompletionItem(resolved, item.id);
      const completed = parsed === undefined ? undefined : Object.freeze({ ...item, ...parsed, ...(parsed.textEdit === undefined && item.textEdit !== undefined ? { textEdit: item.textEdit } : {}), ...(parsed.additionalTextEdits === undefined && item.additionalTextEdits !== undefined ? { additionalTextEdits: item.additionalTextEdits } : {}) });
      return completed === undefined ? { ok: false, error: { kind: 'unavailable', message: 'language server returned an invalid resolved completion' } } : { ok: true, value: completed };
    } catch (error: unknown) { return { ok: false, error: { kind: 'unavailable', message: errorMessage(error) } }; }
  }
}

export class CompletionController implements Disposable {
  readonly #listeners = new Set<(model: CompletionReadModel) => void>();
  #model: CompletionReadModel = Object.freeze({ state: 'idle', request: undefined, items: Object.freeze([]), isIncomplete: false, selectedId: undefined, documentation: undefined, documentationOffset: 0, message: undefined });
  #disposed = false;
  #serial = 0;
  get model(): CompletionReadModel { return this.#model; }

  subscribe(listener: (model: CompletionReadModel) => void): Disposable {
    if (this.#disposed) throw new Error('completion-controller-disposed');
    this.#listeners.add(listener);
    return Object.freeze({ dispose: () => { this.#listeners.delete(listener); } });
  }

  begin(request: CompletionRequest): number {
    if (this.#disposed) return 0;
    const serial = ++this.#serial;
    this.setModel({ state: 'loading', request, items: Object.freeze([]), isIncomplete: false, selectedId: undefined, documentation: undefined, documentationOffset: 0, message: undefined });
    return serial;
  }

  publish(serial: number, request: CompletionRequest, list: CompletionList): boolean {
    if (this.#disposed || serial !== this.#serial || this.#model.request?.documentVersion !== request.documentVersion || this.#model.request?.selectionGeneration !== request.selectionGeneration) return false;
    const items = Object.freeze([...list.items]);
    this.setModel({ state: items.length === 0 ? 'idle' : 'ready', request, items, isIncomplete: list.isIncomplete, selectedId: undefined, documentation: undefined, documentationOffset: 0, message: items.length === 0 ? 'No completions' : undefined });
    return true;
  }

  fail(serial: number, request: CompletionRequest, failure: CompletionFailure): boolean {
    if (this.#disposed || serial !== this.#serial || this.#model.request?.documentVersion !== request.documentVersion || this.#model.request?.selectionGeneration !== request.selectionGeneration) return false;
    this.setModel({ state: 'error', request, items: Object.freeze([]), isIncomplete: false, selectedId: undefined, documentation: undefined, documentationOffset: 0, message: failure.message });
    return true;
  }

  publishResolved(request: CompletionRequest, item: CompletionItem): boolean {
    if (this.#disposed || this.#model.request?.documentVersion !== request.documentVersion || this.#model.request?.selectionGeneration !== request.selectionGeneration) return false;
    const index = this.#model.items.findIndex((candidate) => candidate.id === item.id);
    if (index < 0) return false;
    const items = [...this.#model.items];
    items[index] = item;
    this.setModel({ ...this.#model, items: Object.freeze(items), documentation: this.#model.selectedId === item.id ? item.documentation : this.#model.documentation, documentationOffset: this.#model.selectedId === item.id ? 0 : this.#model.documentationOffset });
    return true;
  }

  move(delta: -1 | 1): CompletionAction {
    if (this.#model.state !== 'ready' || this.#model.items.length === 0) return { kind: 'move', delta };
    const index = this.#model.selectedId === undefined ? (delta > 0 ? -1 : this.#model.items.length) : this.#model.items.findIndex((item) => item.id === this.#model.selectedId);
    const next = (index + delta + this.#model.items.length) % this.#model.items.length;
    const item = this.#model.items[next];
    if (item === undefined) return { kind: 'move', delta };
    this.setModel({ ...this.#model, selectedId: item.id, documentation: item.documentation, documentationOffset: 0 });
    return { kind: 'move', delta };
  }

  scrollDocumentation(delta: -1 | 1): void {
    if (this.#model.documentation === undefined) return;
    const lines = this.#model.documentation.split('\n').length;
    const offset = Math.max(0, Math.min(Math.max(0, lines - 1), this.#model.documentationOffset + delta * 5));
    if (offset !== this.#model.documentationOffset) this.setModel({ ...this.#model, documentationOffset: offset });
  }

  accept(key: 'enter' | 'tab'): Result<CompletionAction, CompletionFailure> {
    if (this.#disposed) return { ok: false, error: { kind: 'disposed', message: 'completion controller is disposed' } };
    if (key === 'enter' && this.#model.selectedId === undefined) return { ok: true, value: { kind: 'newline' } };
    if (this.#model.selectedId === undefined) return { ok: true, value: { kind: 'cancel' } };
    const item = this.#model.items.find((candidate) => candidate.id === this.#model.selectedId);
    if (item === undefined) return { ok: false, error: { kind: 'stale', message: 'selected completion no longer exists' } };
    const edits = [item.textEdit, ...(item.additionalTextEdits ?? [])].filter((edit): edit is CompletionTextEdit => edit !== undefined);
    const valid = validateEdits(edits);
    if (!valid.ok) return valid;
    this.setModel({ state: 'idle', request: undefined, items: Object.freeze([]), isIncomplete: false, selectedId: undefined, documentation: undefined, documentationOffset: 0, message: undefined });
    return { ok: true, value: { kind: 'insert', item, edits: Object.freeze(edits) } };
  }

  cancel(): CompletionAction { this.#serial += 1; this.setModel({ state: 'idle', request: undefined, items: Object.freeze([]), isIncomplete: false, selectedId: undefined, documentation: undefined, documentationOffset: 0, message: undefined }); return { kind: 'cancel' }; }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.#serial += 1; this.#model = Object.freeze({ state: 'idle', request: undefined, items: Object.freeze([]), isIncomplete: false, selectedId: undefined, documentation: undefined, documentationOffset: 0, message: undefined }); this.#listeners.clear(); }

  private setModel(model: CompletionReadModel): void {
    this.#model = Object.freeze(model);
    for (const listener of [...this.#listeners]) {
      try { listener(this.#model); } catch { /* observers cannot break completion dispatch */ }
    }
  }
}

function validateEdits(edits: readonly CompletionTextEdit[]): Result<void, CompletionFailure> {
  const sorted = [...edits].sort((a, b) => a.start.line - b.start.line || a.start.utf16 - b.start.utf16 || a.end.line - b.end.line || a.end.utf16 - b.end.utf16);
  for (const edit of sorted) {
    if (edit.start.line < 0 || edit.end.line < edit.start.line || (edit.end.line === edit.start.line && edit.end.utf16 < edit.start.utf16) || edit.start.utf16 < 0 || edit.end.utf16 < 0) return { ok: false, error: { kind: 'invalid-edit', message: 'completion edit range is invalid' } };
  }
  for (let index = 1; index < sorted.length; index += 1) { const prior = sorted[index - 1]; const current = sorted[index]; if (prior !== undefined && current !== undefined && comparePosition(current.start, prior.end) < 0) return { ok: false, error: { kind: 'overlap', message: 'completion edits overlap' } }; }
  return { ok: true, value: undefined };
}
function comparePosition(a: CompletionPosition, b: CompletionPosition): number { return a.line - b.line || a.utf16 - b.utf16; }

function parseCompletionItem(value: unknown, id: string, fallbackPosition?: CompletionPosition): CompletionItem | undefined {
  const record = asRecord(value);
  if (typeof record?.label !== 'string') return undefined;
  const insertTextFormat = record.insertTextFormat === undefined ? undefined : record.insertTextFormat === 1 ? 'plain' : record.insertTextFormat === 2 ? 'snippet' : null;
  if (insertTextFormat === null) return undefined;
  const fallbackText = typeof record.insertText === 'string' ? record.insertText : typeof record.label === 'string' ? record.label : undefined;
  const textEdit = parseTextEdit(record.textEdit) ?? (fallbackPosition !== undefined && fallbackText !== undefined ? { start: fallbackPosition, end: fallbackPosition, newText: fallbackText } : undefined);
  const additional = record.additionalTextEdits === undefined ? undefined : Array.isArray(record.additionalTextEdits) ? record.additionalTextEdits.map(parseTextEdit) : null;
  if (additional === null || additional?.some((edit) => edit === undefined)) return undefined;
  const documentation = typeof record.documentation === 'string' ? record.documentation : asRecord(record.documentation)?.value;
  const commitCharacters = Array.isArray(record.commitCharacters) && record.commitCharacters.every((item) => typeof item === 'string') ? Object.freeze(record.commitCharacters as string[]) : undefined;
  return Object.freeze({ id, label: record.label, ...(typeof record.detail === 'string' ? { detail: record.detail } : {}), ...(typeof documentation === 'string' ? { documentation: documentation.slice(0, 64 * 1024) } : {}), ...(textEdit === undefined ? {} : { textEdit }), ...(additional === undefined ? {} : { additionalTextEdits: Object.freeze(additional as CompletionTextEdit[]) }), ...(commitCharacters === undefined ? {} : { commitCharacters }), ...(insertTextFormat === undefined ? {} : { insertTextFormat }), ...(record.data === undefined ? {} : { resolveData: record.data }) });
}

function parseTextEdit(value: unknown): CompletionTextEdit | undefined {
  const record = asRecord(value); const range = asRecord(record?.range ?? record?.insert); const end = asRecord(range?.end); const start = asRecord(range?.start);
  if (start === undefined || end === undefined || typeof record?.newText !== 'string') return undefined;
  const startLine = integer(start.line); const startUtf16 = integer(start.character); const endLine = integer(end.line); const endUtf16 = integer(end.character);
  if (startLine === undefined || startUtf16 === undefined || endLine === undefined || endUtf16 === undefined) return undefined;
  return Object.freeze({ start: { line: startLine, utf16: startUtf16 }, end: { line: endLine, utf16: endUtf16 }, newText: record.newText });
}

function asRecord(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function integer(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'language completion request failed'; }
