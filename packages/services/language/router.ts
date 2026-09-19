import type { CancellationToken, Disposable, Result } from '../../contracts/src/index';
import type { CommittedDocumentChange as DocumentCommittedChange } from '../../document/src/index';
import type { LanguageServerConfig } from '../config/index';
import type {
  LanguageDocumentSnapshot,
  LanguageServerHealth,
  LanguageServerSession,
  LanguageServerSessionState,
  LanguageServerStateChange,
  LanguageSessionFailure,
} from './lifecycle';

/** The `LanguageServerSession` surface the workbench/provider adapters actually consume; the
 * router implements exactly this so it can stand in for one session. */
export type RoutedLanguageSession = Pick<LanguageServerSession,
  'request' | 'notify' | 'supportsRequest' | 'waitForReady' | 'state' | 'onStateChange' | 'openDocument' | 'changeDocument' | 'closeDocument' | 'dispose' | 'activate'>;

export interface LanguageServerRouterOptions {
  /** Which server (if any) serves a language id; undefined means "Xi only highlights it". */
  readonly resolveServer: (languageId: string) => LanguageServerConfig | undefined;
  /** Constructs (and owns the platform wiring of) one session per distinct server config. */
  readonly createSession: (config: LanguageServerConfig) => LanguageServerSession;
}

/**
 * One language-server session per configured server, keyed by the server's name, created
 * lazily the first time a document of a language that server serves is opened. Requests are
 * routed by `params.textDocument.uri`; requests without a URI (`completionItem/resolve`,
 * `codeAction/resolve`) go to the session that served the most recent routed request, which
 * is the one the resolve follows up. `state`/`waitForReady` describe the session of the most
 * recently opened document (the buffer the user is acting in).
 */
export class LanguageServerRouter implements Disposable {
  readonly #options: LanguageServerRouterOptions;
  readonly #sessions = new Map<string, LanguageServerSession>();
  readonly #sessionByUri = new Map<string, LanguageServerSession>();
  readonly #uriByDocumentId = new Map<string, string>();
  readonly #stateListeners = new Set<(change: LanguageServerStateChange) => void>();
  readonly #stateSubscriptions: Disposable[] = [];
  #active: LanguageServerSession | undefined;
  #lastRouted: LanguageServerSession | undefined;
  #disposed = false;

  constructor(options: LanguageServerRouterOptions) {
    this.#options = options;
  }

  get size(): number { return this.#sessions.size; }
  sessions(): readonly LanguageServerSession[] { return Object.freeze([...this.#sessions.values()]); }
  /** The session serving `uri`, if any document under it was opened. */
  sessionFor(uri: string): LanguageServerSession | undefined { return this.#sessionByUri.get(uri); }

  get state(): LanguageServerSessionState { return this.#active?.state ?? 'stopped'; }
  /** Health of the active session; a stopped placeholder (no capabilities) before any
   * document with a server was opened, so capability checks read as "unsupported". */
  get health(): LanguageServerHealth { return this.#active?.health ?? NO_SESSION_HEALTH; }

  onStateChange(listener: (change: LanguageServerStateChange) => void): Disposable {
    this.#stateListeners.add(listener);
    return { dispose: () => { this.#stateListeners.delete(listener); } };
  }

  activate(): void { this.#active?.activate(); }

  supportsRequest(method: string, uri?: string): boolean {
    const session = uri === undefined ? this.#lastRouted ?? this.#active : this.#sessionByUri.get(uri);
    return session?.supportsRequest(method, uri) ?? false;
  }

  request<Response>(method: string, params?: unknown, cancellation?: CancellationToken): Promise<Response> {
    const session = this.#route(params);
    if (session === undefined) return Promise.reject(new Error('no language server for this document'));
    return session.request<Response>(method, params, cancellation);
  }

  notify(method: string, params?: unknown): Promise<void> {
    const session = this.#route(params);
    if (session === undefined) return Promise.reject(new Error('no language server for this document'));
    return session.notify(method, params);
  }

  /** With `uri`, waits on the session serving that document; otherwise on the active one. */
  waitForReady(uri?: string): Promise<Result<LanguageServerHealth, LanguageSessionFailure>> {
    const session = uri === undefined ? this.#active : this.#sessionByUri.get(uri);
    if (session === undefined) return Promise.resolve({ ok: false, error: { kind: 'unavailable', message: 'no language server for this document' } });
    return session.waitForReady();
  }

  openDocument(document: LanguageDocumentSnapshot): Result<void, LanguageSessionFailure> {
    if (this.#disposed) return { ok: false, error: { kind: 'unavailable', message: 'language server router is disposed' } };
    const config = this.#options.resolveServer(document.languageId);
    if (config === undefined) return { ok: false, error: { kind: 'unavailable', message: `no language server configured for ${document.languageId}` } };
    let session = this.#sessions.get(config.name);
    if (session === undefined) {
      session = this.#options.createSession(config);
      this.#sessions.set(config.name, session);
      const owned = session;
      this.#stateSubscriptions.push(owned.onStateChange((change) => { if (owned === this.#active) for (const listener of this.#stateListeners) listener(change); }));
    }
    this.#sessionByUri.set(document.uri, session);
    if (document.documentId !== undefined) this.#uriByDocumentId.set(document.documentId, document.uri);
    this.#active = session;
    return session.openDocument(document);
  }

  changeDocument(change: DocumentCommittedChange): Result<void, LanguageSessionFailure> {
    const uri = this.#uriByDocumentId.get(String(change.documentId));
    const session = uri === undefined ? undefined : this.#sessionByUri.get(uri);
    if (session === undefined) return { ok: false, error: { kind: 'invalid-options', message: 'language change targets a closed document' } };
    return session.changeDocument(change);
  }

  closeDocument(uri: string): Result<void, LanguageSessionFailure> {
    const session = this.#sessionByUri.get(uri);
    this.#sessionByUri.delete(uri);
    for (const [documentId, documentUri] of this.#uriByDocumentId) if (documentUri === uri) this.#uriByDocumentId.delete(documentId);
    if (session === undefined) return { ok: true, value: undefined };
    return session.closeDocument(uri);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const subscription of this.#stateSubscriptions) subscription.dispose();
    this.#stateListeners.clear();
    for (const session of this.#sessions.values()) await session.dispose();
    this.#sessions.clear();
    this.#sessionByUri.clear();
    this.#uriByDocumentId.clear();
  }

  #route(params: unknown): LanguageServerSession | undefined {
    const uri = requestUri(params);
    if (uri !== undefined) {
      const session = this.#sessionByUri.get(uri);
      if (session !== undefined) this.#lastRouted = session;
      return session;
    }
    return this.#lastRouted ?? this.#active;
  }
}

const NO_SESSION_HEALTH: LanguageServerHealth = Object.freeze({
  identity: Object.freeze({ configName: '', command: '', root: '', workspaceId: '', environment: Object.freeze({}), workspaceFolders: Object.freeze([]), key: '' }),
  state: 'stopped',
  attempts: 0,
  retries: 0,
  lastFailure: null,
  disabledReason: null,
  capabilities: null,
  registeredCapabilities: Object.freeze([]),
  progress: Object.freeze([]),
  openDocumentCount: 0,
  replayCount: 0,
});

function requestUri(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const textDocument = (params as { readonly textDocument?: unknown }).textDocument;
  if (typeof textDocument !== 'object' || textDocument === null) return undefined;
  const uri = (textDocument as { readonly uri?: unknown }).uri;
  return typeof uri === 'string' ? uri : undefined;
}
