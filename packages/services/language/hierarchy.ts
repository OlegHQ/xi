import type { Disposable, Result } from '../../contracts/src/index';
import { requestIsSupported, type LanguageProviderSession } from './provider-session';
import type { LanguageLocation, NavigationFailure, NavigationRequest } from './navigation';

export type HierarchyKind = 'call' | 'type';
export type HierarchyRelation = 'incoming' | 'outgoing' | 'supertypes' | 'subtypes';

export interface HierarchyItem {
  readonly id?: string;
  readonly name: string;
  readonly detail?: string;
  readonly kind: number;
  readonly uri: string;
  readonly range: LanguageLocation;
  readonly selectionRange: LanguageLocation;
  readonly children: readonly HierarchyItem[];
  readonly hierarchyKind?: HierarchyKind;
  readonly cycle?: boolean;
  readonly data?: unknown;
}

export interface DocumentLink {
  readonly target?: string;
  readonly range: LanguageLocation;
  readonly tooltip?: string;
  readonly data?: unknown;
}

export interface HierarchyProvider {
  prepare(request: NavigationRequest): Promise<Result<readonly HierarchyItem[], NavigationFailure>>;
  links(request: NavigationRequest): Promise<Result<readonly DocumentLink[], NavigationFailure>>;
  children?(request: NavigationRequest, item: HierarchyItem, relation: HierarchyRelation): Promise<Result<readonly HierarchyItem[], NavigationFailure>>;
  resolveLink?(request: NavigationRequest, link: DocumentLink): Promise<Result<DocumentLink, NavigationFailure>>;
}

export type HierarchyFailure = NavigationFailure
  | { readonly kind: 'unsafe-link'; readonly message: string }
  | { readonly kind: 'unsupported'; readonly message: string }
  | { readonly kind: 'invalid'; readonly message: string };

export type HierarchyReadState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';

export interface HierarchyReadModel {
  readonly state: HierarchyReadState;
  readonly generation: number;
  readonly items: readonly HierarchyItem[];
  readonly links: readonly DocumentLink[];
  readonly origin: NavigationRequest | undefined;
  readonly message: string | undefined;
}

/** Owns lazy hierarchy/link requests and never treats a URI as an executable command. */
export class HierarchyController implements Disposable {
  readonly #provider: HierarchyProvider;
  #generation = 0;
  #disposed = false;
  #items: readonly HierarchyItem[] = Object.freeze([]);
  #links: readonly DocumentLink[] = Object.freeze([]);
  #origin: NavigationRequest | undefined;
  #model: HierarchyReadModel = Object.freeze({ state: 'idle', generation: 0, items: Object.freeze([]), links: Object.freeze([]), origin: undefined, message: undefined });

  constructor(provider: HierarchyProvider) { this.#provider = provider; }
  get items(): readonly HierarchyItem[] { return this.#items; }
  get links(): readonly DocumentLink[] { return this.#links; }
  get model(): HierarchyReadModel { return this.#model; }

  async load(request: NavigationRequest): Promise<Result<readonly HierarchyItem[], HierarchyFailure>> {
    if (this.#disposed) return cancelled('hierarchy disposed');
    const generation = ++this.#generation;
    this.#origin = request;
    this.publish('loading', generation, undefined);
    const result = await this.#provider.prepare(request);
    if (this.#disposed || generation !== this.#generation) return stale('hierarchy response is stale');
    if (!result.ok) { this.publish(result.error.kind === 'unavailable' ? 'unavailable' : 'error', generation, result.error.message); return result; }
    const normalized = normalizeItems(result.value, new Set(), request.uri ?? '');
    if (!normalized.ok) { this.publish('error', generation, normalized.error.message); return normalized; }
    this.#items = normalized.value;
    this.publish('ready', generation, normalized.value.length === 0 ? 'No hierarchy items' : undefined);
    return { ok: true, value: this.#items };
  }

  /** Expand one identity-stable node. The provider is queried only for that node. */
  async expand(itemId: string, request: NavigationRequest, relation: HierarchyRelation = 'incoming'): Promise<Result<readonly HierarchyItem[], HierarchyFailure>> {
    if (this.#disposed) return cancelledHierarchy('hierarchy disposed');
    const provider = this.#provider.children;
    if (provider === undefined) return unsupported('hierarchy expansion is unavailable for this server');
    const located = findItem(this.#items, itemId);
    if (located === undefined) return { ok: false, error: { kind: 'invalid', message: 'hierarchy item is no longer present' } };
    const generation = ++this.#generation;
    this.#origin = request;
    this.publish('loading', generation, undefined);
    const result = await provider.call(this.#provider, request, located.item, relation);
    if (this.#disposed || generation !== this.#generation) return staleHierarchy('hierarchy expansion is stale');
    if (!result.ok) { this.publish(result.error.kind === 'unavailable' ? 'unavailable' : 'error', generation, result.error.message); return result; }
    const normalized = normalizeItems(result.value, new Set(located.ancestors), request.uri ?? '');
    if (!normalized.ok) { this.publish('error', generation, normalized.error.message); return normalized; }
    this.#items = replaceChildren(this.#items, itemId, normalized.value);
    this.publish('ready', generation, undefined);
    return { ok: true, value: normalized.value };
  }

  async loadChildren(request: NavigationRequest, itemId: string, relation: HierarchyRelation = 'incoming'): Promise<Result<readonly HierarchyItem[], HierarchyFailure>> {
    return this.expand(itemId, request, relation);
  }

  async loadLinks(request: NavigationRequest): Promise<Result<readonly DocumentLink[], HierarchyFailure>> {
    if (this.#disposed) return cancelledHierarchy('hierarchy disposed');
    const generation = ++this.#generation;
    this.#origin = request;
    this.publish('loading', generation, undefined);
    const result = await this.#provider.links(request);
    if (this.#disposed || generation !== this.#generation) return staleHierarchy('document links are stale');
    if (!result.ok) { this.publish(result.error.kind === 'unavailable' ? 'unavailable' : 'error', generation, result.error.message); return result; }
    for (const link of result.value) if (link.target !== undefined && !safeLink(link.target)) {
      this.publish('error', generation, 'document link is not a safe file or HTTPS URI');
      return { ok: false, error: { kind: 'unsafe-link', message: 'document link is not a file or https URI' } };
    }
    this.#links = Object.freeze(result.value.map((link) => Object.freeze({ ...link })));
    this.publish('ready', generation, this.#links.length === 0 ? 'No document links' : undefined);
    return { ok: true, value: this.#links };
  }

  async resolveLink(link: DocumentLink, request: NavigationRequest): Promise<Result<DocumentLink, HierarchyFailure>> {
    if (this.#disposed) return cancelledHierarchy('hierarchy disposed');
    if (this.#provider.resolveLink === undefined) {
      if (link.target === undefined) return unsupported('document-link resolution is unavailable');
      return safeLink(link.target) ? { ok: true, value: link } : { ok: false, error: { kind: 'unsafe-link', message: 'document link is not a file or https URI' } };
    }
    const generation = ++this.#generation;
    const result = await this.#provider.resolveLink(request, link);
    if (this.#disposed || generation !== this.#generation) return staleHierarchy('document-link resolution is stale');
    if (!result.ok) return result;
    if (result.value.target === undefined || !safeLink(result.value.target)) return { ok: false, error: { kind: 'unsafe-link', message: 'resolved document link is not a file or https URI' } };
    const resolved = Object.freeze({ ...result.value });
    const index = this.#links.indexOf(link);
    if (index >= 0) {
      const links = [...this.#links]; links[index] = resolved; this.#links = Object.freeze(links);
      this.publish('ready', generation, undefined);
    }
    return { ok: true, value: resolved };
  }

  /** Explicit caller action: return a safe target for the host to open. */
  openLink(link: DocumentLink): Result<string, HierarchyFailure> {
    if (link.target === undefined) return { ok: false, error: { kind: 'invalid', message: 'document link has no resolved target' } };
    return safeLink(link.target) ? { ok: true, value: link.target } : { ok: false, error: { kind: 'unsafe-link', message: 'document link is not a file or https URI' } };
  }

  /** Returns the saved source request so the host can restore its original view/focus. */
  cancel(): NavigationRequest | undefined {
    const origin = this.#origin;
    this.#generation += 1;
    this.publish('idle', this.#generation, 'Hierarchy cancelled');
    return origin;
  }

  returnToOrigin(): NavigationRequest | undefined { return this.cancel(); }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.#generation += 1; this.#items = Object.freeze([]); this.#links = Object.freeze([]); this.publish('idle', this.#generation, 'Hierarchy disposed'); }

  private publish(state: HierarchyReadState, generation: number, message: string | undefined): void {
    this.#model = Object.freeze({ state, generation, items: this.#items, links: this.#links, origin: this.#origin, message });
  }
}

/** Native LSP call/type hierarchy and document-link adapter. */
export class LanguageServerHierarchyProvider implements HierarchyProvider {
  readonly #session: LanguageProviderSession;
  constructor(session: LanguageProviderSession) { this.#session = session; }

  async prepare(request: NavigationRequest): Promise<Result<readonly HierarchyItem[], NavigationFailure>> {
    if (request.uri === undefined) return unavailable('hierarchy request has no document URI');
    const type = request.hierarchyKind === 'type';
    const method = type ? 'textDocument/prepareTypeHierarchy' : 'textDocument/prepareCallHierarchy';
    if (!requestIsSupported(this.#session, method, request.uri)) return unavailable(`language server does not provide ${type ? 'type' : 'call'} hierarchy`);
    try {
      const response = await this.#session.request<unknown>(method, positionParams(request));
      const values = response === null ? [] : Array.isArray(response) ? response : [response];
      const items = values.map((value, index) => parseHierarchyItem(value, `${request.uri}:${type ? 'type' : 'call'}:${index}`, type ? 'type' : 'call'));
      if (items.some((item) => item === undefined)) return unavailable('language server returned an invalid hierarchy item');
      return { ok: true, value: Object.freeze(items as HierarchyItem[]) };
    } catch (error: unknown) { return unavailable(errorMessage(error)); }
  }

  async children(request: NavigationRequest, item: HierarchyItem, relation: HierarchyRelation): Promise<Result<readonly HierarchyItem[], NavigationFailure>> {
    const method = relation === 'incoming' ? 'callHierarchy/incomingCalls' : relation === 'outgoing' ? 'callHierarchy/outgoingCalls' : relation === 'supertypes' ? 'typeHierarchy/supertypes' : 'typeHierarchy/subtypes';
    if (!requestIsSupported(this.#session, method, request.uri)) return unavailable('language server does not provide this hierarchy relation');
    try {
      const response = await this.#session.request<unknown>(method, { item: lspHierarchyItem(item) });
      if (!Array.isArray(response)) return response === null ? { ok: true, value: Object.freeze([]) } : unavailable('language server returned invalid hierarchy children');
      const children: HierarchyItem[] = [];
      for (let index = 0; index < response.length; index += 1) {
        const record = asRecord(response[index]);
        const candidate = relation === 'incoming' ? record?.from : relation === 'outgoing' ? record?.to : response[index];
        const parsed = parseHierarchyItem(candidate, `${item.id ?? item.name}:${relation}:${index}`, relation === 'supertypes' || relation === 'subtypes' ? 'type' : 'call');
        if (parsed === undefined) return unavailable('language server returned an invalid hierarchy child');
        children.push(parsed);
      }
      return { ok: true, value: Object.freeze(children) };
    } catch (error: unknown) { return unavailable(errorMessage(error)); }
  }

  async links(request: NavigationRequest): Promise<Result<readonly DocumentLink[], NavigationFailure>> {
    if (request.uri === undefined) return unavailable('document-link request has no document URI');
    if (!requestIsSupported(this.#session, 'textDocument/documentLink', request.uri)) return unavailable('language server does not provide document links');
    try {
      const response = await this.#session.request<unknown>('textDocument/documentLink', { textDocument: { uri: request.uri } });
      if (response === null) return { ok: true, value: Object.freeze([]) };
      if (!Array.isArray(response)) return unavailable('language server returned invalid document links');
      const links: DocumentLink[] = [];
      for (let index = 0; index < response.length; index += 1) {
        const parsed = parseDocumentLink(response[index], `${request.uri}:link:${index}`, undefined, request.uri);
        if (parsed === undefined) return unavailable('language server returned an invalid document link');
        links.push(parsed);
      }
      return { ok: true, value: Object.freeze(links) };
    } catch (error: unknown) { return unavailable(errorMessage(error)); }
  }

  async resolveLink(request: NavigationRequest, link: DocumentLink): Promise<Result<DocumentLink, NavigationFailure>> {
    if (!requestIsSupported(this.#session, 'documentLink/resolve', request.uri)) return unavailable('language server does not provide document link resolution');
    try {
      const response = await this.#session.request<unknown>('documentLink/resolve', { range: lspRange(link.range), ...(link.target === undefined ? {} : { target: link.target }), ...(link.data === undefined ? {} : { data: link.data }) });
      const parsed = parseDocumentLink(response, `${link.range.uri}:resolved`, link);
      return parsed === undefined ? unavailable('language server returned an invalid resolved document link') : { ok: true, value: parsed };
    } catch (error: unknown) { return unavailable(errorMessage(error)); }
  }
}

function normalizeItems(items: readonly HierarchyItem[], ancestors: ReadonlySet<string>, defaultUri: string, depth = 0): Result<readonly HierarchyItem[], HierarchyFailure> {
  if (items.length > 10_000) return { ok: false, error: { kind: 'invalid', message: 'hierarchy result exceeds the item limit' } };
  if (depth > 256) return { ok: false, error: { kind: 'invalid', message: 'hierarchy nesting exceeds the depth limit' } };
  const seen = new Set<string>();
  const normalized: HierarchyItem[] = [];
  for (const item of items) {
    const id = item.id ?? hierarchyId(item);
    if (seen.has(id)) continue;
    seen.add(id);
    const cycle = ancestors.has(id);
    const childResult = cycle ? { ok: true as const, value: Object.freeze([]) } : normalizeItems(item.children, new Set([...ancestors, id]), defaultUri, depth + 1);
    if (!childResult.ok) return childResult;
    normalized.push(Object.freeze({ ...item, id, uri: item.uri || defaultUri, children: childResult.value, ...(cycle ? { cycle: true } : {}) }));
  }
  return { ok: true, value: Object.freeze(normalized) };
}

function findItem(items: readonly HierarchyItem[], id: string, ancestors: readonly string[] = []): { readonly item: HierarchyItem; readonly ancestors: readonly string[] } | undefined {
  for (const item of items) {
    const itemId = item.id ?? hierarchyId(item);
    if (itemId === id) return { item, ancestors };
    const found = findItem(item.children, id, [...ancestors, itemId]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function replaceChildren(items: readonly HierarchyItem[], id: string, children: readonly HierarchyItem[]): readonly HierarchyItem[] {
  return Object.freeze(items.map((item) => {
    const itemId = item.id ?? hierarchyId(item);
    if (itemId === id) return Object.freeze({ ...item, children: Object.freeze([...children]) });
    if (item.children.length === 0) return item;
    return Object.freeze({ ...item, children: replaceChildren(item.children, id, children) });
  }));
}

function parseHierarchyItem(value: unknown, id: string, hierarchyKind: HierarchyKind): HierarchyItem | undefined {
  const record = asRecord(value);
  const name = typeof record?.name === 'string' ? record.name : undefined;
  const uri = typeof record?.uri === 'string' ? record.uri : undefined;
  const range = parseLocationRange(record?.range, uri);
  const selectionRange = parseLocationRange(record?.selectionRange, uri);
  const kind = integer(record?.kind);
  if (name === undefined || uri === undefined || range === undefined || selectionRange === undefined || kind === undefined) return undefined;
  const generated = hierarchyId({ name, kind, uri, range, selectionRange });
  return Object.freeze({ id: `${id}:${generated}`, name, kind, uri, range, selectionRange, children: Object.freeze([]), hierarchyKind, ...(typeof record?.detail === 'string' ? { detail: record.detail } : {}), ...(record?.data === undefined ? {} : { data: record.data }) });
}

function parseDocumentLink(value: unknown, id: string, fallback?: DocumentLink, fallbackUri?: string): DocumentLink | undefined {
  const record = asRecord(value);
  const range = parseLocationRange(record?.range, fallback?.range.uri ?? fallbackUri);
  if (range === undefined) return undefined;
  const target = record?.target === undefined ? fallback?.target : typeof record.target === 'string' ? record.target : null;
  if (target === null) return undefined;
  const tooltip = typeof record?.tooltip === 'string' ? record.tooltip.slice(0, 4 * 1024) : fallback?.tooltip;
  const data = record?.data === undefined ? fallback?.data : record.data;
  return Object.freeze({ ...(target === undefined ? {} : { target }), range: Object.freeze({ ...range }), ...(tooltip === undefined ? {} : { tooltip }), ...(data === undefined ? {} : { data }) });
}

function lspHierarchyItem(item: HierarchyItem): Record<string, unknown> {
  return { name: item.name, kind: item.kind, uri: item.uri, range: lspRange(item.range), selectionRange: lspRange(item.selectionRange), ...(item.detail === undefined ? {} : { detail: item.detail }), ...(item.data === undefined ? {} : { data: item.data }) };
}

function positionParams(request: NavigationRequest): Record<string, unknown> {
  return { textDocument: { uri: request.uri ?? '' }, position: { line: request.position.line, character: request.position.utf16 } };
}
function lspRange(range: LanguageLocation): Record<string, unknown> { return { start: { line: range.startLine, character: range.startUtf16 }, end: { line: range.endLine, character: range.endUtf16 } }; }
function parseLocationRange(value: unknown, fallbackUri?: string): LanguageLocation | undefined {
  const record = asRecord(value); const start = asRecord(record?.start); const end = asRecord(record?.end);
  const uri = typeof record?.uri === 'string' ? record.uri : fallbackUri;
  const startLine = integer(start?.line); const startUtf16 = integer(start?.character); const endLine = integer(end?.line); const endUtf16 = integer(end?.character);
  if (uri === undefined || startLine === undefined || startUtf16 === undefined || endLine === undefined || endUtf16 === undefined || endLine < startLine || endLine === startLine && endUtf16 < startUtf16) return undefined;
  return { uri, startLine, startUtf16, endLine, endUtf16 };
}
function hierarchyId(item: Pick<HierarchyItem, 'name' | 'kind' | 'uri' | 'range' | 'selectionRange'>): string { return `${item.uri}:${item.name}:${item.kind}:${item.range.startLine}:${item.range.startUtf16}:${item.selectionRange.startLine}:${item.selectionRange.startUtf16}`; }
function safeLink(target: string): boolean {
  if (/[\u0000-\u001F\u007F]/u.test(target) || /%1b|%00/i.test(target)) return false;
  try { const url = new URL(target); return (url.protocol === 'file:' || url.protocol === 'https:') && url.username.length === 0 && url.password.length === 0; } catch { return false; }
}
function asRecord(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function integer(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'language hierarchy request failed'; }
function unavailable(message: string): Result<never, NavigationFailure> { return { ok: false, error: { kind: 'unavailable', message } }; }
function cancelled(message: string): Result<never, NavigationFailure> { return { ok: false, error: { kind: 'cancelled', message } }; }
function stale(message: string): Result<never, NavigationFailure> { return { ok: false, error: { kind: 'stale', message } }; }
function cancelledHierarchy(message: string): Result<never, HierarchyFailure> { return { ok: false, error: { kind: 'cancelled', message } }; }
function staleHierarchy(message: string): Result<never, HierarchyFailure> { return { ok: false, error: { kind: 'stale', message } }; }
function unsupported(message: string): Result<never, HierarchyFailure> { return { ok: false, error: { kind: 'unsupported', message } }; }
