import type { Disposable, Result } from '../../contracts/src/index';
import { requestIsSupported, type LanguageProviderSession } from './provider-session';

export interface LanguageLocation { readonly uri: string; readonly startLine: number; readonly startUtf16: number; readonly endLine: number; readonly endUtf16: number; }
export interface LanguageSymbol { readonly id: string; readonly name: string; readonly detail?: string; readonly kind: number; readonly range: LanguageLocation; readonly children: readonly LanguageSymbol[]; }
export interface NavigationRequest { readonly documentId: string; readonly documentVersion: number; readonly selectionGeneration: number; readonly uri?: string; readonly position: { readonly line: number; readonly utf16: number }; readonly hierarchyKind?: 'call' | 'type'; }
export type NavigationFailure = { readonly kind: 'stale' | 'unavailable' | 'cancelled' | 'external-uri'; readonly message: string };
export interface NavigationProvider {
  definition(request: NavigationRequest): Promise<Result<readonly LanguageLocation[], NavigationFailure>>;
  references(request: NavigationRequest, includeDeclaration: boolean): Promise<Result<readonly LanguageLocation[], NavigationFailure>>;
  hover(request: NavigationRequest): Promise<Result<{ readonly markdown: string }, NavigationFailure>>;
  symbols(request: NavigationRequest): Promise<Result<readonly LanguageSymbol[], NavigationFailure>>;
}
export interface NavigationReadModel { readonly state: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'; readonly generation: number; readonly symbols: readonly LanguageSymbol[]; readonly hover: string | undefined; readonly message: string | undefined; readonly origin: NavigationRequest | undefined; }

/** Converts validated LSP responses into Xi's bounded, UTF-16 navigation DTOs. */
export class LanguageServerNavigationProvider implements NavigationProvider {
  readonly #session: LanguageProviderSession;

  constructor(session: LanguageProviderSession) { this.#session = session; }

  async definition(request: NavigationRequest): Promise<Result<readonly LanguageLocation[], NavigationFailure>> {
    if (request.uri === undefined) return unavailable('navigation request has no document URI');
    if (!requestIsSupported(this.#session, 'textDocument/definition', request.uri)) return unavailable('language server does not provide definitions');
    try {
      const response = await this.#session.request<unknown>('textDocument/definition', lspPositionParams(request));
      const locations = response === null ? [] : Array.isArray(response) ? response : [response];
      const parsed = locations.map(parseLocation);
      if (parsed.some((location) => location === undefined)) return unavailable('language server returned an invalid definition location');
      return { ok: true, value: Object.freeze(parsed as LanguageLocation[]) };
    } catch (error: unknown) { return unavailable(errorMessage(error)); }
  }

  async references(request: NavigationRequest, includeDeclaration: boolean): Promise<Result<readonly LanguageLocation[], NavigationFailure>> {
    if (request.uri === undefined) return unavailable('navigation request has no document URI');
    if (!requestIsSupported(this.#session, 'textDocument/references', request.uri)) return unavailable('language server does not provide references');
    try {
      const response = await this.#session.request<unknown>('textDocument/references', {
        ...lspPositionParams(request),
        context: { includeDeclaration },
      });
      const locations = response === null ? [] : Array.isArray(response) ? response : [response];
      const parsed = locations.map(parseLocation);
      if (parsed.some((location) => location === undefined)) return unavailable('language server returned an invalid reference location');
      return { ok: true, value: Object.freeze(parsed as LanguageLocation[]) };
    } catch (error: unknown) { return unavailable(errorMessage(error)); }
  }

  async hover(request: NavigationRequest): Promise<Result<{ readonly markdown: string }, NavigationFailure>> {
    if (request.uri === undefined) return unavailable('navigation request has no document URI');
    if (!requestIsSupported(this.#session, 'textDocument/hover', request.uri)) return unavailable('language server does not provide hover');
    try {
      const response = await this.#session.request<unknown>('textDocument/hover', lspPositionParams(request));
      return { ok: true, value: Object.freeze({ markdown: hoverText(response) }) };
    } catch (error: unknown) { return unavailable(errorMessage(error)); }
  }

  async symbols(request: NavigationRequest): Promise<Result<readonly LanguageSymbol[], NavigationFailure>> {
    if (request.uri === undefined) return unavailable('navigation request has no document URI');
    if (!requestIsSupported(this.#session, 'textDocument/documentSymbol', request.uri)) return unavailable('language server does not provide document symbols');
    try {
      const response = await this.#session.request<unknown>('textDocument/documentSymbol', { textDocument: { uri: request.uri } });
      if (response === null) return { ok: true, value: Object.freeze([]) };
      if (!Array.isArray(response)) return unavailable('language server returned an invalid symbol list');
      const symbols: LanguageSymbol[] = [];
      for (let index = 0; index < response.length; index += 1) {
        const parsed = parseSymbol(response[index], `${request.uri}:${index}`, request.uri);
        if (parsed === undefined) return unavailable('language server returned an invalid symbol');
        symbols.push(parsed);
      }
      return { ok: true, value: Object.freeze(symbols) };
    } catch (error: unknown) { return unavailable(errorMessage(error)); }
  }
}

export class LanguageNavigationController implements Disposable {
  readonly #provider: NavigationProvider;
  readonly #listeners = new Set<(model: NavigationReadModel) => void>();
  #generation = 0;
  #model: NavigationReadModel = Object.freeze({ state: 'idle', generation: 0, symbols: Object.freeze([]), hover: undefined, message: undefined, origin: undefined });
  #disposed = false;
  #origin: NavigationRequest | undefined;

  constructor(provider: NavigationProvider) { this.#provider = provider; }
  get model(): NavigationReadModel { return this.#model; }

  subscribe(listener: (model: NavigationReadModel) => void): Disposable {
    if (this.#disposed) throw new Error('navigation-controller-disposed');
    this.#listeners.add(listener);
    return Object.freeze({ dispose: () => { this.#listeners.delete(listener); } });
  }

  async loadOutline(request: NavigationRequest): Promise<Result<readonly LanguageSymbol[], NavigationFailure>> {
    if (this.#disposed) return { ok: false, error: { kind: 'cancelled', message: 'navigation controller disposed' } };
    const generation = ++this.#generation;
    this.#origin = request;
    this.publish({ state: 'loading', generation, symbols: this.#model.symbols, hover: undefined, message: undefined, origin: request });
    const result = await this.#provider.symbols(request);
    if (generation !== this.#generation || this.#disposed) return { ok: false, error: { kind: 'stale', message: 'outline response is stale' } };
    if (!result.ok) {
      this.publish({ ...this.#model, state: result.error.kind === 'unavailable' ? 'unavailable' : 'error', message: result.error.message });
      return result;
    }
    this.publish({ ...this.#model, state: 'ready', symbols: Object.freeze([...result.value]), message: result.value.length === 0 ? 'No symbols' : undefined });
    return result;
  }

  async requestHover(request: NavigationRequest): Promise<Result<string, NavigationFailure>> {
    if (this.#disposed) return { ok: false, error: { kind: 'cancelled', message: 'navigation controller disposed' } };
    const generation = ++this.#generation;
    this.#origin = request;
    const result = await this.#provider.hover(request);
    if (generation !== this.#generation || this.#disposed) return { ok: false, error: { kind: 'stale', message: 'hover response is stale' } };
    if (!result.ok) {
      this.publish({ ...this.#model, state: result.error.kind === 'unavailable' ? 'unavailable' : 'error', message: result.error.message });
      return result;
    }
    this.publish({ ...this.#model, state: 'ready', hover: result.value.markdown, origin: request, message: undefined });
    return { ok: true, value: result.value.markdown };
  }

  async definition(request: NavigationRequest): Promise<Result<readonly LanguageLocation[], NavigationFailure>> {
    if (this.#disposed) return { ok: false, error: { kind: 'cancelled', message: 'navigation controller disposed' } };
    const generation = ++this.#generation;
    this.#origin = request;
    const result = await this.#provider.definition(request);
    if (generation !== this.#generation || this.#disposed) return { ok: false, error: { kind: 'stale', message: 'definition response is stale' } };
    if (!result.ok) return result;
    for (const location of result.value) if (!location.uri.startsWith('file://')) return { ok: false, error: { kind: 'external-uri', message: 'navigation target is outside the workspace' } };
    return result;
  }

  async references(request: NavigationRequest, includeDeclaration: boolean): Promise<Result<readonly LanguageLocation[], NavigationFailure>> {
    if (this.#disposed) return { ok: false, error: { kind: 'cancelled', message: 'navigation controller disposed' } };
    const generation = ++this.#generation;
    this.#origin = request;
    const result = await this.#provider.references(request, includeDeclaration);
    if (generation !== this.#generation || this.#disposed) return { ok: false, error: { kind: 'stale', message: 'reference response is stale' } };
    if (!result.ok) return result;
    for (const location of result.value) if (!location.uri.startsWith('file://')) return { ok: false, error: { kind: 'external-uri', message: 'reference target is outside the workspace' } };
    return result;
  }

  returnToOrigin(): NavigationRequest | undefined { const origin = this.#origin; this.#generation += 1; return origin; }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.#generation += 1; this.#listeners.clear(); }

  private publish(model: NavigationReadModel): void {
    this.#model = Object.freeze(model);
    for (const listener of [...this.#listeners]) {
      try { listener(this.#model); } catch { /* observers cannot break language request handling */ }
    }
  }
}

function lspPositionParams(request: NavigationRequest): { readonly textDocument: { readonly uri: string }; readonly position: { readonly line: number; readonly character: number } } {
  return { textDocument: { uri: request.uri ?? '' }, position: { line: request.position.line, character: request.position.utf16 } };
}

function parseLocation(value: unknown): LanguageLocation | undefined {
  const record = asRecord(value);
  const location = record?.targetUri === undefined ? record : { uri: record?.targetUri, range: record?.targetSelectionRange ?? record?.range };
  const uri = typeof location?.uri === 'string' ? location.uri : undefined;
  const range = parseRange(location?.range);
  return uri === undefined || range === undefined ? undefined : Object.freeze({ uri, ...range });
}

function parseSymbol(value: unknown, id: string, defaultUri: string): LanguageSymbol | undefined {
  const record = asRecord(value);
  const location = asRecord(record?.location);
  const range = parseRange(record?.range ?? location?.range);
  const name = typeof record?.name === 'string' ? record.name : undefined;
  const kind = integer(record?.kind);
  if (name === undefined || kind === undefined || range === undefined) return undefined;
  const children: LanguageSymbol[] = [];
  if (record?.children !== undefined) {
    if (!Array.isArray(record.children)) return undefined;
    for (let index = 0; index < record.children.length; index += 1) {
      const child = parseSymbol(record.children[index], `${id}.${index}`, defaultUri);
      if (child === undefined) return undefined;
      children.push(child);
    }
  }
  const detail = typeof record?.detail === 'string' ? record.detail : typeof record?.containerName === 'string' ? record.containerName : undefined;
  const symbolUri = typeof record?.uri === 'string' ? record.uri : typeof location?.uri === 'string' ? location.uri : defaultUri;
  return Object.freeze({ id, name, ...(detail === undefined ? {} : { detail }), kind, range: Object.freeze({ uri: symbolUri, ...range }), children: Object.freeze(children) });
}

function parseRange(value: unknown): Omit<LanguageLocation, 'uri'> | undefined {
  const record = asRecord(value); const start = asRecord(record?.start); const end = asRecord(record?.end);
  const startLine = integer(start?.line); const startUtf16 = integer(start?.character); const endLine = integer(end?.line); const endUtf16 = integer(end?.character);
  if (startLine === undefined || startUtf16 === undefined || endLine === undefined || endUtf16 === undefined || endLine < startLine || endLine === startLine && endUtf16 < startUtf16) return undefined;
  return { startLine, startUtf16, endLine, endUtf16 };
}

function hoverText(value: unknown): string {
  const contents = asRecord(value)?.contents;
  if (typeof contents === 'string') return sanitizeMarkdown(contents);
  if (Array.isArray(contents)) return sanitizeMarkdown(contents.map((item) => {
    if (typeof item === 'string') return item;
    const record = asRecord(item);
    return typeof record?.value === 'string' ? record.value : '';
  }).filter((item) => item.length > 0).join('\n'));
  const record = asRecord(contents);
  return sanitizeMarkdown(typeof record?.value === 'string' ? record.value : '');
}

function sanitizeMarkdown(value: string): string { return value.replaceAll(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu, '').slice(0, 64 * 1024); }
function asRecord(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function integer(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function unavailable(message: string): Result<never, NavigationFailure> { return { ok: false, error: { kind: 'unavailable', message } }; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'language request failed'; }
