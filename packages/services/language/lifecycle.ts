import type {
  CancellationToken,
  ClockPort,
  Disposable,
  PlatformFailure,
  ProcessPort,
  ProcessSpec,
  Result,
  WorkspaceId,
} from '../../contracts/src/index';
import { CancellationSource } from '../../contracts/src/index';
import type { CommittedDocumentChange as DocumentCommittedChange, DocumentSnapshot } from '../../document/src/index';
import type { LanguageServerConfig } from '../config/index';
import {
  type InitializeParams,
  type InitializeResult,
  type Registration,
  type RegistrationParams,
  type UnregistrationParams,
} from 'vscode-languageserver-protocol/browser';
import {
  startLanguageTransport,
  type LanguageStartFailure,
  type LanguageTransport,
  type LanguageTransportState,
  type LanguageTransportStateChange,
} from './transport';
import { LanguageDocumentSync } from './sync';
import type { DiagnosticStore, LanguageDiagnostic } from './diagnostics';
import { PullDiagnosticStore } from './pull-diagnostics';
import type { PullDiagnosticFailure, PullDiagnosticProviderFailure, PullDiagnosticReport, PullDiagnosticSnapshot, PullDiagnosticWorkspaceReport } from './pull-diagnostics';

type PullDiagnosticItem = Omit<LanguageDiagnostic, 'id' | 'uri' | 'serverId' | 'documentVersion' | 'generation'>;

/** A probe is deliberately injected: language never reaches around the platform process/filesystem ports. */
export type RootMarkerProbe = (candidatePath: string, cancellation: CancellationToken) => Promise<Result<boolean, PlatformFailure>>;

export interface RootResolutionRequest {
  readonly filePath: string;
  readonly rootMarkers: readonly string[];
  readonly singleFileFallback?: boolean;
  readonly cancellation?: CancellationToken;
}

export interface ResolvedLanguageRoot {
  readonly root: string;
  readonly marker: string | null;
  readonly markerPath: string | null;
  readonly searchedDirectories: readonly string[];
}

export type RootResolutionFailure =
  | { readonly kind: 'invalid-path'; readonly message: string }
  | { readonly kind: 'ambiguous-marker'; readonly message: string; readonly markers: readonly string[] }
  | { readonly kind: 'probe-failed'; readonly failure: PlatformFailure; readonly path: string }
  | { readonly kind: 'cancelled'; readonly message: string }
  | { readonly kind: 'no-root'; readonly message: string };

const neverCancelled: CancellationToken = Object.freeze({
  isCancelled: false,
  onCancel: () => ({ dispose() {} }),
});

/**
 * Find the nearest configured root marker. Marker order is significant: the first
 * marker in a directory wins. Duplicate markers are rejected instead of making
 * root identity depend on configuration parsing order.
 */
export async function resolveLanguageRoot(
  request: RootResolutionRequest,
  probe: RootMarkerProbe,
): Promise<Result<ResolvedLanguageRoot, RootResolutionFailure>> {
  const filePath = pathFromUri(request.filePath);
  if (filePath === undefined || !isAbsolutePath(filePath)) {
    return { ok: false, error: { kind: 'invalid-path', message: 'root resolution requires an absolute file path or file URI' } };
  }
  const markers = request.rootMarkers.map((marker) => marker.trim());
  if (markers.some((marker) => marker.length === 0 || marker.includes('/') || marker.includes('\\'))) {
    return { ok: false, error: { kind: 'invalid-path', message: 'root markers must be nonempty file names' } };
  }
  const duplicateMarkers = markers.filter((marker, index) => markers.indexOf(marker) !== index);
  if (duplicateMarkers.length !== 0) {
    return {
      ok: false,
      error: { kind: 'ambiguous-marker', message: 'root marker configuration contains duplicate names', markers: Object.freeze([...new Set(duplicateMarkers)]) },
    };
  }

  const cancellation = request.cancellation ?? neverCancelled;
  const searchedDirectories: string[] = [];
  let directory = dirname(filePath);
  while (true) {
    searchedDirectories.push(directory);
    if (cancellation.isCancelled) return { ok: false, error: { kind: 'cancelled', message: 'root resolution was cancelled' } };
    for (const marker of markers) {
      const markerPath = joinPath(directory, marker);
      let result: Result<boolean, PlatformFailure>;
      try {
        result = await probe(markerPath, cancellation);
      } catch {
        return { ok: false, error: { kind: 'probe-failed', failure: { code: 'root-probe-threw', message: 'root marker probe failed', retryable: true }, path: markerPath } };
      }
      if (!result.ok) return { ok: false, error: { kind: 'probe-failed', failure: result.error, path: markerPath } };
      if (result.value) {
        return {
          ok: true,
          value: Object.freeze({
            root: directory,
            marker,
            markerPath,
            searchedDirectories: Object.freeze([...searchedDirectories]),
          }),
        };
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  if (request.singleFileFallback === true) {
    return {
      ok: true,
      value: Object.freeze({
        root: dirname(filePath),
        marker: null,
        markerPath: null,
        searchedDirectories: Object.freeze([...searchedDirectories]),
      }),
    };
  }
  return { ok: false, error: { kind: 'no-root', message: 'none of the configured root markers was found' } };
}

export interface LanguageWorkspaceFolder {
  readonly uri: string;
  readonly name: string;
}

export interface LanguageServerIdentityInput {
  readonly config: Pick<LanguageServerConfig, 'name' | 'command' | 'args'>;
  readonly root: string;
  readonly workspaceId: WorkspaceId | string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly workspaceFolders?: readonly LanguageWorkspaceFolder[];
}

export interface LanguageServerIdentity {
  readonly configName: string;
  readonly command: string;
  readonly root: string;
  readonly workspaceId: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly workspaceFolders: readonly LanguageWorkspaceFolder[];
  /** Stable, length-delimited identity; different roots/configs never share a session. */
  readonly key: string;
}

export function createLanguageServerIdentity(input: LanguageServerIdentityInput): LanguageServerIdentity {
  const environment = Object.freeze(Object.fromEntries(Object.entries(input.environment ?? {}).sort(([left], [right]) => left.localeCompare(right))));
  const workspaceFolders = Object.freeze((input.workspaceFolders ?? []).map((folder) => Object.freeze({ uri: folder.uri, name: folder.name })));
  const parts = [
    input.config.name,
    input.config.command,
    ...input.config.args,
    input.root,
    String(input.workspaceId),
    ...Object.entries(environment).flatMap(([key, value]) => [key, value]),
    ...workspaceFolders.flatMap((folder) => [folder.uri, folder.name]),
  ];
  const key = parts.map((part) => `${part.length}:${part}`).join('|');
  return Object.freeze({
    configName: input.config.name,
    command: input.config.command,
    root: input.root,
    workspaceId: String(input.workspaceId),
    environment,
    workspaceFolders,
    key,
  });
}

export interface LanguageDocumentSnapshot {
  readonly uri: string;
  /** Xi's stable document identity when it differs from the LSP URI. */
  readonly documentId?: string;
  readonly languageId: string;
  readonly version: number;
  /** Normalized LF document text at exactly version. */
  readonly text: string;
}

interface StoredLanguageDocument {
  readonly uri: string;
  readonly documentId?: string;
  readonly languageId: string;
  readonly version: number;
  /** Present for the initial/replayed snapshot; later versions use the root. */
  readonly text: string | undefined;
  readonly snapshot: DocumentSnapshot | undefined;
}

export interface LanguageConfigurationItem {
  readonly scopeUri?: string;
  readonly section?: string;
}

export interface LanguageProgressEvent {
  readonly token: string | number;
  readonly value: unknown;
}

export interface LanguageDynamicCapability {
  readonly id: string;
  readonly method: string;
  readonly registerOptions?: unknown;
}

export interface LanguageCapabilityChange {
  readonly generation: number;
  readonly capabilities: InitializeResult['capabilities'] | null;
  readonly registeredCapabilities: readonly LanguageDynamicCapability[];
}

export interface LanguageRetryPolicy {
  /** Number of retries after the initial start attempt. */
  readonly maxRetries?: number;
  readonly baseDelayMilliseconds?: number;
  readonly maxDelayMilliseconds?: number;
  /** A successful session must live this long before a crash clears its storm counter. */
  readonly healthyWindowMilliseconds?: number;
}

export interface LanguageServerSessionOptions {
  readonly process: ProcessPort;
  readonly clock: ClockPort;
  readonly config: LanguageServerConfig;
  readonly root: string;
  readonly workspaceId: WorkspaceId | string;
  readonly workspaceFolders?: readonly LanguageWorkspaceFolder[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly configuration?: unknown;
  readonly configurationProvider?: (item: LanguageConfigurationItem) => unknown | Promise<unknown>;
  readonly initializationOptions?: unknown;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly processTimeoutMilliseconds?: number;
  readonly requestTimeoutMilliseconds?: number;
  readonly shutdownTimeoutMilliseconds?: number;
  readonly retry?: LanguageRetryPolicy;
  /** Optional owner store for validated `textDocument/publishDiagnostics`. */
  readonly diagnostics?: DiagnosticStore;
}

export type LanguageServerSessionState = 'stopped' | 'starting' | 'initializing' | 'ready' | 'stopping' | 'failed' | 'disabled';

export interface LanguageServerHealth {
  readonly identity: LanguageServerIdentity;
  readonly state: LanguageServerSessionState;
  readonly attempts: number;
  readonly retries: number;
  readonly lastFailure: string | null;
  readonly disabledReason: string | null;
  readonly capabilities: InitializeResult['capabilities'] | null;
  readonly registeredCapabilities: readonly LanguageDynamicCapability[];
  readonly progress: readonly LanguageProgressEvent[];
  readonly openDocumentCount: number;
  readonly replayCount: number;
}

export interface LanguageServerStateChange {
  readonly previous: LanguageServerSessionState;
  readonly current: LanguageServerSessionState;
  readonly health: LanguageServerHealth;
}

export type LanguageSessionFailure =
  | { readonly kind: 'invalid-options'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string; readonly failure?: PlatformFailure }
  | { readonly kind: 'restart-limit'; readonly message: string }
  | { readonly kind: 'protocol'; readonly message: string };

const DEFAULT_RETRY: Required<LanguageRetryPolicy> = Object.freeze({
  maxRetries: 3,
  baseDelayMilliseconds: 100,
  maxDelayMilliseconds: 2_000,
  healthyWindowMilliseconds: 30_000,
});
const MAX_DYNAMIC_CAPABILITIES = 64;

/**
 * Owns one `(config, root, workspace, environment, folders)` LSP identity.
 * `activate()` is intentionally fire-and-forget, so opening a file and typing
 * can proceed while initialize/retry work happens in the background.
 */
export class LanguageServerSession implements Disposable {
  readonly identity: LanguageServerIdentity;
  readonly #options: LanguageServerSessionOptions;
  readonly #retry: Required<LanguageRetryPolicy>;
  readonly #documents = new Map<string, StoredLanguageDocument>();
  readonly #documentUrisById = new Map<string, string>();
  readonly #listeners = new Set<(change: LanguageServerStateChange) => void>();
  readonly #capabilityListeners = new Set<(change: LanguageCapabilityChange) => void>();
  readonly #progressListeners = new Set<(event: LanguageProgressEvent) => void>();
  readonly #dynamicCapabilities = new Map<string, LanguageDynamicCapability>();
  readonly #dynamicSelectors = new Map<string, DynamicSelectorMatcher>();
  readonly #progress = new Map<string, LanguageProgressEvent>();
  readonly #lifecycleCancellation = new CancellationSource();
  readonly #failureWaiters = new Set<(change: LanguageTransportStateChange) => void>();
  readonly #pullDiagnostics: PullDiagnosticStore<PullDiagnosticItem>;
  #state: LanguageServerSessionState = 'stopped';
  #transport: LanguageTransport | undefined;
  #sync: LanguageDocumentSync | undefined;
  #transportSubscription: Disposable | undefined;
  #attemptCancellation: CancellationSource | undefined;
  #runPromise: Promise<void> | undefined;
  #disposePromise: Promise<void> | undefined;
  #attempts = 0;
  #retries = 0;
  #restartRequested = false;
  #replayCount = 0;
  #lastFailure: string | null = null;
  #disabledReason: string | null = null;
  #capabilities: InitializeResult['capabilities'] | null = null;
  #configurationSet: boolean;
  #configuration: unknown;
  #readyAt: number | undefined;
  #capabilityGeneration = 0;

  constructor(options: LanguageServerSessionOptions) {
    this.#options = options;
    this.#retry = normalizeRetry(options.retry);
    this.identity = createLanguageServerIdentity({
      config: options.config,
      root: options.root,
      workspaceId: options.workspaceId,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.workspaceFolders === undefined ? {} : { workspaceFolders: options.workspaceFolders }),
    });
    this.#configuration = options.configuration;
    this.#configurationSet = options.configuration !== undefined;
    this.#pullDiagnostics = new PullDiagnosticStore({
      request: (uri, previousResultId, generation, cancellation) => this.requestPullDiagnostics(uri, previousResultId, generation, cancellation),
      requestWorkspace: (items, generation, cancellation) => this.requestWorkspacePullDiagnostics(items, generation, cancellation),
    });
  }

  get state(): LanguageServerSessionState { return this.#state; }

  get health(): LanguageServerHealth {
    return Object.freeze({
      identity: this.identity,
      state: this.#state,
      attempts: this.#attempts,
      retries: this.#retries,
      lastFailure: this.#lastFailure,
      disabledReason: this.#disabledReason,
      capabilities: this.#capabilities,
      registeredCapabilities: Object.freeze([...this.#dynamicCapabilities.values()]),
      progress: Object.freeze([...this.#progress.values()]),
      openDocumentCount: this.#documents.size,
      replayCount: this.#replayCount,
    });
  }

  onStateChange(listener: (change: LanguageServerStateChange) => void): Disposable {
    this.#listeners.add(listener);
    return { dispose: () => { this.#listeners.delete(listener); } };
  }

  onProgress(listener: (event: LanguageProgressEvent) => void): Disposable {
    this.#progressListeners.add(listener);
    return { dispose: () => { this.#progressListeners.delete(listener); } };
  }

  onCapabilitiesChange(listener: (change: LanguageCapabilityChange) => void): Disposable {
    this.#capabilityListeners.add(listener);
    return { dispose: () => { this.#capabilityListeners.delete(listener); } };
  }

  /** True only for a provider negotiated in initialize or currently registered dynamically. */
  supportsRequest(method: string, uri?: string): boolean {
    if (this.#state !== 'ready' || this.#transport === undefined) return false;
    const staticSupport = staticRequestSupport(method, this.#capabilities);
    if (staticSupport) return true;
    for (const capability of this.#dynamicCapabilities.values()) {
      if (!dynamicMethodMatches(method, capability.method, capability.registerOptions)) continue;
      if (uri !== undefined && !(this.#dynamicSelectors.get(capability.id)?.(uri, this.#documents.get(uri)?.languageId) ?? true)) continue;
      return true;
    }
    return false;
  }

  /** Pull one document's diagnostics through the active server and publish them into the shared Problems owner. */
  async refreshPullDiagnostics(uri: string, cancellation?: CancellationToken): Promise<Result<PullDiagnosticSnapshot<PullDiagnosticItem>, PullDiagnosticFailure>> {
    const result = await this.#pullDiagnostics.refresh(uri, cancellation);
    if (result.ok) this.publishPulledDiagnostics(result.value);
    return result;
  }

  /** Pull all open documents in one workspace request when the server advertises that capability. */
  async refreshWorkspacePullDiagnostics(cancellation?: CancellationToken): Promise<Result<readonly PullDiagnosticSnapshot<PullDiagnosticItem>[], PullDiagnosticFailure>> {
    const uris = Object.freeze([...this.#documents.keys()]);
    if (uris.length === 0) return { ok: true, value: Object.freeze([]) };
    if (!this.supportsRequest('workspace/diagnostic')) return { ok: false, error: { kind: 'unavailable', message: 'workspace diagnostic pull is not advertised' } };
    const result = await this.#pullDiagnostics.refreshWorkspace(uris, cancellation);
    if (result.ok) for (const snapshot of result.value) this.publishPulledDiagnostics(snapshot);
    return result;
  }

  /** Refresh all open documents without forcing a workspace capability. */
  async refreshAllPullDiagnostics(cancellation?: CancellationToken): Promise<Result<readonly PullDiagnosticSnapshot<PullDiagnosticItem>[], PullDiagnosticFailure>> {
    const uris = [...this.#documents.keys()];
    if (uris.length === 0) return { ok: true, value: Object.freeze([]) };
    if (this.supportsRequest('workspace/diagnostic')) return this.refreshWorkspacePullDiagnostics(cancellation);
    const snapshots: PullDiagnosticSnapshot<PullDiagnosticItem>[] = [];
    for (const uri of uris) {
      const result = await this.refreshPullDiagnostics(uri, cancellation);
      if (!result.ok) return result;
      snapshots.push(result.value);
    }
    return { ok: true, value: Object.freeze(snapshots) };
  }

  /** Start in the background. This method does not wait for process spawn or initialize. */
  activate(): void {
    if (this.#disposePromise !== undefined || this.#lifecycleCancellation.token.isCancelled) return;
    if (this.#state === 'ready' || this.#state === 'starting' || this.#state === 'initializing') return;
    if (this.#state === 'disabled') return;
    this.#runPromise = this.startCycle();
    void this.#runPromise.catch((error: unknown) => {
      this.recordFailure(`language lifecycle failed: ${safeErrorMessage(error)}`);
    });
  }

  /** Explicit user retry clears a disabled/restart-storm state and starts a new cycle. */
  async restart(): Promise<void> {
    if (this.#disposePromise !== undefined) return;
    this.#disabledReason = null;
    this.#lastFailure = null;
    this.#retries = 0;
    this.#attemptCancellation?.cancel();
    const transport = this.#transport;
    this.#transport = undefined;
    this.#sync = undefined;
    this.#transportSubscription?.dispose();
    this.#transportSubscription = undefined;
    this.#pullDiagnostics.restart();
    this.clearCapabilities();
    this.#options.diagnostics?.clearServer(this.identity.key);
    this.#restartRequested = true;
    this.wakeFailureWaiters({ previous: 'running', current: 'stopping', failure: 'explicit restart' });
    if (transport !== undefined) await transport.dispose();
    if (this.#runPromise !== undefined) await this.#runPromise.catch(() => {});
    if (this.#state !== 'stopped') this.transition('stopped');
    this.activate();
    const ready = await this.waitForReady();
    if (!ready.ok) throw new Error(ready.error.message);
  }

  /** Snapshot admission is synchronous; it remains available while the server starts or retries. */
  openDocument(document: LanguageDocumentSnapshot): Result<void, LanguageSessionFailure> {
    const valid = validateDocument(document);
    if (!valid.ok) return valid;
    this.#documents.set(document.uri, Object.freeze({ ...document, snapshot: undefined }));
    this.#options.diagnostics?.markDocumentGeneration(document.uri, document.version);
    if (document.documentId !== undefined) this.#documentUrisById.set(document.documentId, document.uri);
    if (this.#state === 'ready' && this.#transport !== undefined) {
      const sync = this.#sync;
      if (sync !== undefined) {
        void sync.openDocument(document).then((result) => {
          if (!result.ok) this.recordProtocolIssue(result.error.message);
        });
      }
    } else {
      this.activate();
    }
    return { ok: true, value: undefined };
  }

  /** Admit one committed document change without mutating the document owner. */
  changeDocument(change: DocumentCommittedChange): Result<void, LanguageSessionFailure>;
  changeDocument(uri: string, change: DocumentCommittedChange): Result<void, LanguageSessionFailure>;
  changeDocument(uriOrChange: string | DocumentCommittedChange, suppliedChange?: DocumentCommittedChange): Result<void, LanguageSessionFailure> {
    const change = typeof uriOrChange === 'string' ? suppliedChange : uriOrChange;
    const uri = typeof uriOrChange === 'string'
      ? uriOrChange
      : this.#documentUrisById.get(String(uriOrChange.documentId)) ?? String(uriOrChange.documentId);
    if (change === undefined) return { ok: false, error: { kind: 'invalid-options', message: 'language change is missing a document change payload' } };
    const document = this.#documents.get(uri);
    if (document === undefined) return { ok: false, error: { kind: 'invalid-options', message: 'language change targets a closed document' } };
    if (change.before !== document.version || change.after !== change.before + 1) {
      return { ok: false, error: { kind: 'protocol', message: 'language change version is stale or non-monotonic' } };
    }
    if (this.#state === 'ready' && this.#sync !== undefined) {
      const admitted = this.#sync.acceptChange(change, uri);
      if (!admitted.ok) return { ok: false, error: { kind: 'protocol', message: admitted.error.message } };
    }
    this.#documents.set(document.uri, Object.freeze({
      uri: document.uri,
      ...(document.documentId === undefined ? {} : { documentId: document.documentId }),
      languageId: document.languageId,
      version: change.after,
      text: undefined,
      snapshot: change.snapshot,
    }));
    this.#options.diagnostics?.markDocumentGeneration(uri, change.after);
    if (this.#state !== 'ready') this.activate();
    return { ok: true, value: undefined };
  }

  closeDocument(uri: string): Result<void, LanguageSessionFailure> {
    if (uri.length === 0) return { ok: false, error: { kind: 'invalid-options', message: 'document URI must be nonempty' } };
    const known = this.#documents.delete(uri);
    this.#pullDiagnostics.clear(uri);
    this.#options.diagnostics?.clearUri(uri);
    for (const [documentId, documentUri] of this.#documentUrisById) {
      if (documentUri === uri) this.#documentUrisById.delete(documentId);
    }
    if (known && this.#state === 'ready' && this.#transport !== undefined) {
      const sync = this.#sync;
      if (sync !== undefined) void sync.closeDocument(uri).then((result) => {
        if (!result.ok) this.recordProtocolIssue(result.error.message);
      });
    }
    return { ok: true, value: undefined };
  }

  setConfiguration(configuration: unknown): void {
    this.#configurationSet = true;
    this.#configuration = configuration;
    if (this.#state === 'ready' && this.#transport !== undefined) {
      void this.#transport.notify('workspace/didChangeConfiguration', { settings: configuration }).catch((error: unknown) => this.recordProtocolIssue(safeErrorMessage(error)));
    }
  }

  /** Request methods are available only after initialization; startup remains asynchronous. */
  request<Response>(method: string, params?: unknown, cancellation?: CancellationToken): Promise<Response> {
    if (this.#transport === undefined || this.#state !== 'ready') return Promise.reject(new Error('language server is not ready'));
    return this.#transport.request<Response>(method, params, cancellation);
  }

  /** Send a client notification only after the server has reached ready. */
  notify(method: string, params?: unknown): Promise<void> {
    if (this.#transport === undefined || this.#state !== 'ready') return Promise.reject(new Error('language server is not ready'));
    return this.#transport.notify(method, params);
  }

  waitForReady(): Promise<Result<LanguageServerHealth, LanguageSessionFailure>> {
    if (this.#state === 'ready') return Promise.resolve({ ok: true, value: this.health });
    if (this.#state === 'failed' || this.#state === 'disabled') {
      return Promise.resolve({ ok: false, error: this.failureForHealth() });
    }
    return new Promise((resolve) => {
      const listener = this.onStateChange((change) => {
        if (change.current === 'ready') {
          listener.dispose();
          resolve({ ok: true, value: change.health });
        } else if (change.current === 'failed' || change.current === 'disabled') {
          listener.dispose();
          resolve({ ok: false, error: this.failureForHealth() });
        }
      });
      this.activate();
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#disposePromise = this.shutdown();
    return this.#disposePromise;
  }

  private async shutdown(): Promise<void> {
    this.#lifecycleCancellation.cancel();
    this.#attemptCancellation?.cancel();
    if (this.#state !== 'stopped' && this.#state !== 'stopping') this.transition('stopping');
    this.wakeFailureWaiters({ previous: 'running', current: 'stopping', failure: 'session shutdown' });
    if (this.#runPromise !== undefined) await this.#runPromise.catch(() => {});
    const transport = this.#transport;
    this.#transport = undefined;
    this.#sync = undefined;
    this.#transportSubscription?.dispose();
    this.#transportSubscription = undefined;
    if (transport !== undefined) await transport.shutdown();
    this.clearCapabilities();
    if (this.#state !== 'stopped') this.transition('stopped');
    this.#options.diagnostics?.clearServer(this.identity.key);
  }

  private async startCycle(): Promise<void> {
    while (!this.#lifecycleCancellation.token.isCancelled) {
      this.#attempts += 1;
      this.transition('starting');
      const attempt = new CancellationSource();
      this.#attemptCancellation = attempt;
      const processSpec: ProcessSpec = {
        argv: [this.#options.config.command, ...this.#options.config.args],
        cwd: this.identity.root,
        env: this.identity.environment,
        // A language server is long-lived: it has no wall-clock lifetime unless the
        // caller explicitly opts into one. Omitting this leaves the process port
        // free of a forced-kill timer instead of SIGTERMing a healthy server.
        ...(this.#options.processTimeoutMilliseconds === undefined ? {} : { timeoutMilliseconds: this.#options.processTimeoutMilliseconds }),
        cancellation: attempt.token,
      };
      const transportOptions = {
        process: this.#options.process,
        spec: processSpec,
        ...(this.#options.requestTimeoutMilliseconds === undefined ? {} : { requestTimeoutMilliseconds: this.#options.requestTimeoutMilliseconds }),
        ...(this.#options.shutdownTimeoutMilliseconds === undefined ? {} : { shutdownTimeoutMilliseconds: this.#options.shutdownTimeoutMilliseconds }),
      };
      const started = await startLanguageTransport(transportOptions);
      this.#attemptCancellation = undefined;
      if (this.#lifecycleCancellation.token.isCancelled) {
        if (started.ok) await started.value.dispose();
        return;
      }
      if (!started.ok) {
        const retry = await this.handleStartFailure(started.error);
        if (!retry) return;
        continue;
      }

      const transport = started.value;
      this.#transport = transport;
      this.#transportSubscription = transport.onStateChange((change) => this.handleTransportState(change));
      this.installProtocolHandlers(transport);
      this.transition('initializing');
      try {
        const result = await transport.initialize(this.initializeParams());
        const serverCapabilities = asRecord(result.capabilities);
        if (serverCapabilities === undefined) throw new Error('language server returned invalid initialize capabilities');
        const selectedPositionEncoding = serverCapabilities.positionEncoding;
        if (selectedPositionEncoding !== undefined && selectedPositionEncoding !== 'utf-16') {
          throw new Error(`language server selected unsupported position encoding ${String(selectedPositionEncoding)}`);
        }
        this.#capabilities = result.capabilities;
        this.publishCapabilitiesChange();
        this.#sync = new LanguageDocumentSync({ transport, capabilities: result.capabilities });
        await transport.initialized();
        this.#readyAt = this.#options.clock.monotonicMilliseconds();
        await this.replayState(transport);
        this.transition('ready');
        void this.scheduleHealthyReset(this.#readyAt);
        const failure = await this.waitForTransportFailure();
        if (this.#lifecycleCancellation.token.isCancelled) return;
        if (this.#restartRequested) {
          this.#restartRequested = false;
          await this.finishTransport(transport);
          return;
        }
        await this.finishTransport(transport);
        this.recordFailure(failure.failure ?? 'language server stopped unexpectedly');
      } catch (error: unknown) {
        if (this.#lifecycleCancellation.token.isCancelled) return;
        await this.finishTransport(transport);
        this.recordFailure(safeErrorMessage(error));
      }
      if (this.#lifecycleCancellation.token.isCancelled) return;
      if (!this.shouldRetry()) {
        this.transition('failed');
        return;
      }
      this.transition('failed');
      const delay = retryDelay(this.#retries, this.#retry);
      const slept = await this.#options.clock.sleep(delay, this.#lifecycleCancellation.token);
      if (!slept.ok || this.#lifecycleCancellation.token.isCancelled) return;
    }
  }

  private initializeParams(): InitializeParams {
    return {
      processId: null,
      clientInfo: { name: this.#options.clientName ?? 'Xi', version: this.#options.clientVersion ?? '0.0.1' },
      rootUri: pathToUri(this.identity.root),
      capabilities: {
        workspace: { configuration: true, diagnostics: { refreshSupport: true } },
        window: { workDoneProgress: true },
        // Every current feature DTO uses UTF-16 coordinates. Advertising only this
        // encoding prevents a server selecting UTF-8/32 for providers that have not
        // yet been converted at their request boundary.
        general: { positionEncodings: ['utf-16'] },
        textDocument: {
          completion: { dynamicRegistration: true, completionItem: { snippetSupport: true } },
          // Without declaring this, a spec-compliant server (confirmed: typescript-language-server)
          // reads the absence of `textDocument.publishDiagnostics` as "this client does not want
          // diagnostics pushed" and never sends any `textDocument/publishDiagnostics` notification.
          // Only the minimal, honestly-supported shape is declared: DiagnosticPublish/LanguageDiagnostic
          // do not model relatedInformation, tagSupport or versionSupport, so none of those optional
          // sub-capabilities are claimed here.
          publishDiagnostics: {},
          diagnostic: { dynamicRegistration: true },
          callHierarchy: { dynamicRegistration: true },
          typeHierarchy: { dynamicRegistration: true },
          documentLink: { dynamicRegistration: true },
        },
      },
      initializationOptions: this.#options.initializationOptions,
      workspaceFolders: null,
    };
  }

  private installProtocolHandlers(transport: LanguageTransport): void {
    transport.onRequest('workspace/configuration', async (params: unknown) => this.configurationResponse(params));
    transport.onRequest('client/registerCapability', (params: unknown) => { this.registerCapabilities(params); return undefined; });
    transport.onRequest('client/unregisterCapability', (params: unknown) => { this.unregisterCapabilities(params); return undefined; });
    transport.onRequest('window/workDoneProgress/create', (params: unknown) => {
      const token = tokenFromRecord(params);
      if (token !== undefined) this.#progress.set(tokenKey(token), Object.freeze({ token, value: { kind: 'create' } }));
      return undefined;
    });
    transport.onNotification('$/progress', (params: unknown) => {
      const record = asRecord(params);
      const token = tokenFromUnknown(record?.token);
      if (token === undefined || !Object.hasOwn(record ?? {}, 'value')) return;
      const event = Object.freeze({ token, value: record?.value });
      // An 'end' event closes that progress token; without deleting it here the
      // map (and every future health snapshot copying it) grows without bound.
      if (asRecord(record?.value)?.kind === 'end') this.#progress.delete(tokenKey(token));
      else this.#progress.set(tokenKey(token), event);
      for (const listener of [...this.#progressListeners]) {
        try { listener(event); } catch { /* observers cannot break protocol dispatch */ }
      }
    });
    transport.onNotification('textDocument/publishDiagnostics', (params: unknown) => {
      const publish = decodeDiagnostics(params, this.#documents);
      if (publish === undefined) {
        this.recordProtocolIssue('language server sent invalid textDocument/publishDiagnostics parameters');
        return;
      }
      this.#options.diagnostics?.publish({ ...publish, serverId: this.identity.key });
    });
    transport.onRequest('workspace/diagnostic/refresh', async () => {
      if (this.supportsRequest('textDocument/diagnostic')) {
        try { await this.refreshAllPullDiagnostics(); }
        catch (error: unknown) { this.recordProtocolIssue(safeErrorMessage(error)); }
      }
      return null;
    });
  }

  private async requestPullDiagnostics(
    uri: string,
    previousResultId: string | undefined,
    _generation: number,
    cancellation: CancellationToken | undefined,
  ): Promise<Result<PullDiagnosticReport<PullDiagnosticItem>, PullDiagnosticProviderFailure>> {
    const transport = this.#transport;
    const document = this.#documents.get(uri);
    if (transport === undefined || this.#state !== 'ready') return { ok: false, error: { kind: 'unavailable', message: 'language server is not ready' } };
    if (document === undefined) return { ok: false, error: { kind: 'unavailable', message: 'diagnostic document is closed' } };
    if (!this.supportsRequest('textDocument/diagnostic', uri)) return { ok: false, error: { kind: 'unavailable', message: 'document diagnostic pull is not advertised' } };
    const version = document.version;
    let response: Result<unknown, PullDiagnosticProviderFailure>;
    try {
      response = { ok: true, value: await this.request<unknown>('textDocument/diagnostic', {
        textDocument: { uri },
        ...(previousResultId === undefined ? {} : { previousResultId }),
      }, cancellation) };
    } catch (error: unknown) {
      response = { ok: false, error: requestFailure(error, cancellation) };
    }
    if (!response.ok) return response;
    const current = this.#documents.get(uri);
    if (current === undefined || current.version !== version) return { ok: false, error: { kind: 'stale', message: 'document changed during diagnostic pull' } };
    return decodePullReport(response.value, uri, this.#documents);
  }

  private async requestWorkspacePullDiagnostics(
    items: readonly { readonly uri: string; readonly previousResultId?: string }[],
    _generation: number,
    cancellation: CancellationToken | undefined,
  ): Promise<Result<PullDiagnosticWorkspaceReport<PullDiagnosticItem>, PullDiagnosticProviderFailure>> {
    const transport = this.#transport;
    if (transport === undefined || this.#state !== 'ready') return { ok: false, error: { kind: 'unavailable', message: 'language server is not ready' } };
    if (!this.supportsRequest('workspace/diagnostic')) return { ok: false, error: { kind: 'unavailable', message: 'workspace diagnostic pull is not advertised' } };
    const versions = new Map<string, number>();
    for (const item of items) {
      const document = this.#documents.get(item.uri);
      if (document === undefined) return { ok: false, error: { kind: 'unavailable', message: `diagnostic document ${item.uri} is closed` } };
      versions.set(item.uri, document.version);
    }
    let response: Result<unknown, PullDiagnosticProviderFailure>;
    try {
      response = { ok: true, value: await this.request<unknown>('workspace/diagnostic', {
        previousResultIds: items.map((item) => ({ uri: item.uri, ...(item.previousResultId === undefined ? {} : { value: item.previousResultId }) })),
      }, cancellation) };
    } catch (error: unknown) {
      response = { ok: false, error: requestFailure(error, cancellation) };
    }
    if (!response.ok) return response;
    for (const [uri, version] of versions) {
      if (this.#documents.get(uri)?.version !== version) return { ok: false, error: { kind: 'stale', message: 'document changed during workspace diagnostic pull' } };
    }
    return decodePullWorkspaceReport(response.value, this.#documents);
  }

  private publishPulledDiagnostics(snapshot: PullDiagnosticSnapshot<PullDiagnosticItem>): void {
    const document = this.#documents.get(snapshot.uri);
    if (document === undefined) return;
    this.#options.diagnostics?.publish({
      serverId: this.identity.key,
      uri: snapshot.uri,
      generation: document.version,
      documentVersion: document.version,
      diagnostics: snapshot.items,
    });
  }

  private async configurationResponse(params: unknown): Promise<readonly unknown[]> {
    const record = asRecord(params);
    const items = record?.items;
    if (!Array.isArray(items)) return [];
    const output: unknown[] = [];
    for (const item of items) {
      const parsed = asRecord(item);
      if (parsed === undefined) { output.push(null); continue; }
      const value: LanguageConfigurationItem = {
        ...(typeof parsed.scopeUri === 'string' ? { scopeUri: parsed.scopeUri } : {}),
        ...(typeof parsed.section === 'string' ? { section: parsed.section } : {}),
      };
      output.push(this.#options.configurationProvider === undefined
        ? readConfiguration(this.#options.configuration, value.section)
        : await this.#options.configurationProvider(value));
    }
    return output;
  }

  private registerCapabilities(params: unknown): void {
    const parsed = asRegistrationParams(params);
    if (parsed === undefined) {
      this.recordProtocolIssue('language server sent invalid client/registerCapability parameters');
      return;
    }
    if (this.#dynamicCapabilities.size + parsed.registrations.length > MAX_DYNAMIC_CAPABILITIES) {
      this.recordProtocolIssue('language server exceeded the dynamic capability limit');
      return;
    }
    const ids = new Set<string>();
    for (const registration of parsed.registrations) {
      if (!isSupportedDynamicMethod(registration.method) || ids.has(registration.id) || this.#dynamicCapabilities.has(registration.id)) {
        this.recordProtocolIssue('language server registered an unsupported or duplicate capability');
        return;
      }
      ids.add(registration.id);
    }
    for (const registration of parsed.registrations) {
      const value = Object.freeze({ id: registration.id, method: registration.method, ...(registration.registerOptions === undefined ? {} : { registerOptions: registration.registerOptions }) });
      this.#dynamicCapabilities.set(registration.id, value);
      const selector = createDocumentSelectorMatcher(registration.registerOptions, this.identity.root);
      if (selector !== undefined) this.#dynamicSelectors.set(registration.id, selector);
    }
    this.publishCapabilitiesChange();
  }

  private unregisterCapabilities(params: unknown): void {
    const parsed = asUnregistrationParams(params);
    if (parsed === undefined) {
      this.recordProtocolIssue('language server sent invalid client/unregisterCapability parameters');
      return;
    }
    if (parsed.unregisterations.some((registration) => {
      const current = this.#dynamicCapabilities.get(registration.id);
      return current === undefined || current.method !== registration.method;
    })) {
      this.recordProtocolIssue('language server tried to unregister an unknown capability');
      return;
    }
    for (const registration of parsed.unregisterations) {
      this.#dynamicCapabilities.delete(registration.id);
      this.#dynamicSelectors.delete(registration.id);
    }
    this.publishCapabilitiesChange();
  }

  private async replayState(transport: LanguageTransport): Promise<void> {
    this.#replayCount += 1;
    if (this.#configurationSet) await transport.notify('workspace/didChangeConfiguration', { settings: this.#configuration });
    for (const stored of this.#documents.values()) {
      const document = materializeStoredDocument(stored);
      if (!document.ok) throw new Error(document.error.message);
      const admitted = await this.#sync?.openDocument(document.value);
      if (admitted !== undefined && !admitted.ok) throw new Error(admitted.error.message);
    }
  }

  private async waitForTransportFailure(): Promise<LanguageTransportStateChange> {
    if (this.#lifecycleCancellation.token.isCancelled) {
      return { previous: 'running', current: 'stopping', failure: 'session shutdown' };
    }
    return new Promise((resolve) => {
      let active = true;
      const finish = (change: LanguageTransportStateChange): void => {
        if (!active) return;
        active = false;
        cancellationSubscription.dispose();
        this.#failureWaiters.delete(finish);
        resolve(change);
      };
      const cancellationSubscription = this.#lifecycleCancellation.token.onCancel(() => finish({ previous: 'running', current: 'stopping', failure: 'session shutdown' }));
      this.#failureWaiters.add(finish);
      if (this.#lifecycleCancellation.token.isCancelled) finish({ previous: 'running', current: 'stopping', failure: 'session shutdown' });
    });
  }

  private handleTransportState(change: LanguageTransportStateChange): void {
    if (change.current === 'failed' || change.current === 'stopped') this.wakeFailureWaiters(change);
  }

  private wakeFailureWaiters(change: LanguageTransportStateChange): void {
    const waiters = [...this.#failureWaiters];
    this.#failureWaiters.clear();
    for (const waiter of waiters) waiter(change);
  }

  private async finishTransport(transport: LanguageTransport): Promise<void> {
    if (this.#transport === transport) this.#transport = undefined;
    if (this.#transport === undefined) this.#sync = undefined;
    this.#transportSubscription?.dispose();
    this.#transportSubscription = undefined;
    this.#pullDiagnostics.restart();
    this.clearCapabilities();
    this.#options.diagnostics?.clearServer(this.identity.key);
    await transport.dispose();
  }

  private async handleStartFailure(failure: LanguageStartFailure): Promise<boolean> {
    const message = startFailureMessage(failure);
    this.recordFailure(message);
    if (failure.kind === 'spawn-failed' && !failure.failure.retryable) {
      this.disable(`language server executable unavailable: ${failure.failure.message}`);
      return false;
    }
    if (!this.shouldRetry()) {
      this.transition('failed');
      return false;
    }
    this.transition('failed');
    const delay = retryDelay(this.#retries, this.#retry);
    const slept = await this.#options.clock.sleep(delay, this.#lifecycleCancellation.token);
    return slept.ok && !this.#lifecycleCancellation.token.isCancelled;
  }

  /** A genuine transport/process failure; consumes the bounded restart budget. */
  private recordFailure(message: string): void {
    this.#lastFailure = message;
    const readyAt = this.#readyAt;
    if (readyAt !== undefined && this.#options.clock.monotonicMilliseconds() - readyAt >= this.#retry.healthyWindowMilliseconds) this.#retries = 0;
    this.#retries += 1;
  }

  /** A protocol oddity (bad payload, unsupported/duplicate capability, a best-effort notify failing): recorded for health/diagnosis, but it never consumes the restart budget. */
  private recordProtocolIssue(message: string): void {
    this.#lastFailure = message;
  }

  /**
   * Clears the restart-storm counter once a session has stayed ready for the full
   * healthy window, instead of waiting for the next failure to notice retroactively.
   */
  private async scheduleHealthyReset(readyAt: number): Promise<void> {
    const slept = await this.#options.clock.sleep(this.#retry.healthyWindowMilliseconds, this.#lifecycleCancellation.token);
    if (!slept.ok || this.#lifecycleCancellation.token.isCancelled) return;
    if (this.#readyAt === readyAt && this.#state === 'ready') this.#retries = 0;
  }

  private shouldRetry(): boolean {
    return this.#retries <= this.#retry.maxRetries;
  }

  private disable(reason: string): void {
    this.#disabledReason = reason;
    this.#lastFailure = reason;
    this.transition('disabled');
  }

  private failureForHealth(): LanguageSessionFailure {
    return this.#state === 'disabled'
      ? { kind: 'unavailable', message: this.#disabledReason ?? this.#lastFailure ?? 'language server disabled' }
      : { kind: 'restart-limit', message: this.#lastFailure ?? 'language server retry limit reached' };
  }

  private transition(next: LanguageServerSessionState): void {
    if (this.#state === next) return;
    const previous = this.#state;
    this.#state = next;
    const change = Object.freeze({ previous, current: next, health: this.health });
    for (const listener of [...this.#listeners]) {
      try { listener(change); } catch { /* state observers cannot stop lifecycle cleanup */ }
    }
  }

  private publishCapabilitiesChange(): void {
    this.#capabilityGeneration += 1;
    const change = Object.freeze({
      generation: this.#capabilityGeneration,
      capabilities: this.#capabilities,
      registeredCapabilities: Object.freeze([...this.#dynamicCapabilities.values()]),
    });
    for (const listener of [...this.#capabilityListeners]) {
      try { listener(change); } catch { /* capability observers cannot break protocol dispatch */ }
    }
  }

  private clearCapabilities(): void {
    if (this.#capabilities === null && this.#dynamicCapabilities.size === 0) return;
    this.#capabilities = null;
    this.#dynamicCapabilities.clear();
    this.#dynamicSelectors.clear();
    this.publishCapabilitiesChange();
  }
}

/** Pool sessions by their complete identity, preserving isolation across roots and workspaces. */
export class LanguageServerPool implements Disposable {
  readonly #sessions = new Map<string, LanguageServerSession>();
  #disposePromise: Promise<void> | undefined;

  get size(): number { return this.#sessions.size; }

  getOrCreate(options: LanguageServerSessionOptions): LanguageServerSession {
    if (this.#disposePromise !== undefined) throw new Error('language server pool is disposed');
    const identity = createLanguageServerIdentity({
      config: options.config,
      root: options.root,
      workspaceId: options.workspaceId,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.workspaceFolders === undefined ? {} : { workspaceFolders: options.workspaceFolders }),
    });
    const existing = this.#sessions.get(identity.key);
    if (existing !== undefined) return existing;
    const session = new LanguageServerSession(options);
    this.#sessions.set(identity.key, session);
    return session;
  }

  get(identity: LanguageServerIdentity): LanguageServerSession | undefined { return this.#sessions.get(identity.key); }

  values(): readonly LanguageServerSession[] { return Object.freeze([...this.#sessions.values()]); }

  async dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#disposePromise = (async () => {
      for (const session of this.#sessions.values()) await session.dispose();
      this.#sessions.clear();
    })();
    return this.#disposePromise;
  }
}

function normalizeRetry(input: LanguageRetryPolicy | undefined): Required<LanguageRetryPolicy> {
  const value = { ...DEFAULT_RETRY, ...input };
  if (![value.maxRetries, value.baseDelayMilliseconds, value.maxDelayMilliseconds, value.healthyWindowMilliseconds].every((number) => Number.isSafeInteger(number) && number >= 0)) {
    throw new TypeError('language retry policy values must be non-negative safe integers');
  }
  if (value.maxDelayMilliseconds < value.baseDelayMilliseconds) throw new TypeError('language retry maximum must be at least its base delay');
  return value;
}

function retryDelay(retries: number, retry: Required<LanguageRetryPolicy>): number {
  const exponent = Math.max(0, Math.min(30, retries - 1));
  return Math.min(retry.maxDelayMilliseconds, retry.baseDelayMilliseconds * (2 ** exponent));
}

function validateDocument(document: LanguageDocumentSnapshot): Result<void, LanguageSessionFailure> {
  if (document.uri.length === 0 || document.languageId.length === 0 || !Number.isSafeInteger(document.version) || document.version < 0) {
    return { ok: false, error: { kind: 'invalid-options', message: 'document URI/language ID/version is invalid' } };
  }
  return { ok: true, value: undefined };
}

function materializeStoredDocument(stored: StoredLanguageDocument): Result<LanguageDocumentSnapshot, LanguageSessionFailure> {
  if (stored.text !== undefined) {
    return {
      ok: true,
      value: Object.freeze({
        uri: stored.uri,
        ...(stored.documentId === undefined ? {} : { documentId: stored.documentId }),
        languageId: stored.languageId,
        version: stored.version,
        text: stored.text,
      }),
    };
  }
  const snapshot = stored.snapshot;
  if (snapshot === undefined) return { ok: false, error: { kind: 'invalid-options', message: `language document ${stored.uri} has no replay snapshot` } };
  const chunks: string[] = [];
  let start = 0;
  while (start < snapshot.lengthUtf16) {
    let end = Math.min(snapshot.lengthUtf16, start + 64 * 1024);
    let read = false;
    while (end > start) {
      const result = snapshot.slice(start as never, end as never);
      if (result.ok) {
        chunks.push(result.value);
        start = end;
        read = true;
        break;
      }
      if (result.error.kind !== 'surrogate-split') return { ok: false, error: { kind: 'invalid-options', message: `language replay snapshot is unreadable: ${result.error.kind}` } };
      end -= 1;
    }
    if (!read) return { ok: false, error: { kind: 'invalid-options', message: 'language replay snapshot has no safe UTF-16 chunk' } };
  }
  return {
    ok: true,
    value: Object.freeze({
      uri: stored.uri,
      ...(stored.documentId === undefined ? {} : { documentId: stored.documentId }),
      languageId: stored.languageId,
      version: stored.version,
      text: chunks.join(''),
    }),
  };
}

function startFailureMessage(failure: LanguageStartFailure): string {
  if (failure.kind === 'spawn-failed') return `${failure.failure.code}: ${failure.failure.message}`;
  return failure.message;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: language server operation failed`;
  return 'language server operation failed';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function decodeDiagnostics(
  value: unknown,
  documents: ReadonlyMap<string, StoredLanguageDocument>,
): { readonly uri: string; readonly generation: number; readonly documentVersion?: number; readonly diagnostics: readonly Omit<import('./diagnostics').LanguageDiagnostic, 'id' | 'uri' | 'serverId' | 'documentVersion' | 'generation'>[] } | undefined {
  const record = asRecord(value);
  if (typeof record?.uri !== 'string' || !Array.isArray(record.diagnostics) || record.diagnostics.length > 10_000) return undefined;
  const document = documents.get(record.uri);
  if (document === undefined) return undefined;
  const publishedVersion = record.version === undefined ? undefined : integer(record.version);
  if (record.version !== undefined && publishedVersion === undefined) return undefined;
  const diagnostics: Omit<import('./diagnostics').LanguageDiagnostic, 'id' | 'uri' | 'serverId' | 'documentVersion' | 'generation'>[] = [];
  for (const candidate of record.diagnostics) {
    const item = asRecord(candidate);
    const range = asRecord(item?.range);
    const start = asRecord(range?.start);
    const end = asRecord(range?.end);
    if (item === undefined || start === undefined || end === undefined || typeof item.message !== 'string') return undefined;
    const startLine = integer(start.line); const startUtf16 = integer(start.character);
    const endLine = integer(end.line); const endUtf16 = integer(end.character);
    if (startLine === undefined || startUtf16 === undefined || endLine === undefined || endUtf16 === undefined || endLine < startLine || (endLine === startLine && endUtf16 < startUtf16)) return undefined;
    const severity = item.severity === undefined ? undefined : integer(item.severity);
    if (item.severity !== undefined && (severity === undefined || severity < 1 || severity > 4)) return undefined;
    if (item.source !== undefined && typeof item.source !== 'string') return undefined;
    if (item.code !== undefined && typeof item.code !== 'string' && typeof item.code !== 'number') return undefined;
    diagnostics.push(Object.freeze({
      range: Object.freeze({ startLine, startUtf16, endLine, endUtf16 }),
      message: item.message,
      severity: severity as 1 | 2 | 3 | 4 | undefined,
      source: item.source as string | undefined,
      code: item.code as string | number | undefined,
    }));
  }
  return {
    uri: record.uri,
    generation: publishedVersion ?? document.version,
    documentVersion: publishedVersion ?? document.version,
    diagnostics: Object.freeze(diagnostics),
  };
}

function decodePullReport(
  value: unknown,
  uri: string,
  documents: ReadonlyMap<string, StoredLanguageDocument>,
): Result<PullDiagnosticReport<PullDiagnosticItem>, PullDiagnosticProviderFailure> {
  const record = asRecord(value);
  const document = documents.get(uri);
  if (document === undefined || (record?.kind !== 'full' && record?.kind !== 'unchanged')) return { ok: false, error: { kind: 'failed', message: 'language server returned an invalid document diagnostic report' } };
  const rawItems = record.kind === 'unchanged' && record.items === undefined ? [] : record.items;
  if (!Array.isArray(rawItems)) return { ok: false, error: { kind: 'failed', message: 'language server returned invalid document diagnostic items' } };
  const items = decodePullItems(rawItems);
  if (items === undefined) return { ok: false, error: { kind: 'failed', message: 'language server returned an invalid document diagnostic item' } };
  const resultId = optionalResultId(record.resultId);
  if (record.resultId !== undefined && resultId === undefined) return { ok: false, error: { kind: 'failed', message: 'language server returned an invalid diagnostic result ID' } };
  return {
    ok: true,
    value: {
      kind: record.kind,
      ...(resultId === undefined ? {} : { resultId }),
      items,
    },
  };
}

function decodePullWorkspaceReport(
  value: unknown,
  documents: ReadonlyMap<string, StoredLanguageDocument>,
): Result<PullDiagnosticWorkspaceReport<PullDiagnosticItem>, PullDiagnosticProviderFailure> {
  const record = asRecord(value);
  if (record === undefined || !Array.isArray(record.items)) return { ok: false, error: { kind: 'failed', message: 'language server returned an invalid workspace diagnostic response' } };
  const output: PullDiagnosticWorkspaceReport<PullDiagnosticItem>['items'][number][] = [];
  for (const candidate of record.items) {
    const item = asRecord(candidate);
    const uri = item?.uri;
    if (item === undefined || typeof uri !== 'string') return { ok: false, error: { kind: 'failed', message: 'workspace diagnostic response contains an invalid URI' } };
    const decoded = decodePullReport({
      kind: item.kind,
      ...(Object.hasOwn(item, 'resultId') ? { resultId: item.resultId } : {}),
      ...(Object.hasOwn(item, 'items') ? { items: item.items } : {}),
    }, uri, documents);
    if (!decoded.ok) return decoded;
    output.push(Object.freeze({ uri, report: decoded.value }));
  }
  return { ok: true, value: Object.freeze({ items: Object.freeze(output) }) };
}

function decodePullItems(value: readonly unknown[]): readonly PullDiagnosticItem[] | undefined {
  if (value.length > 10_000) return undefined;
  const diagnostics: PullDiagnosticItem[] = [];
  for (const candidate of value) {
    const item = asRecord(candidate);
    const range = asRecord(item?.range);
    const start = asRecord(range?.start);
    const end = asRecord(range?.end);
    if (item === undefined || start === undefined || end === undefined || typeof item.message !== 'string') return undefined;
    const startLine = integer(start.line); const startUtf16 = integer(start.character);
    const endLine = integer(end.line); const endUtf16 = integer(end.character);
    if (startLine === undefined || startUtf16 === undefined || endLine === undefined || endUtf16 === undefined || endLine < startLine || (endLine === startLine && endUtf16 < startUtf16)) return undefined;
    const severity = item.severity === undefined ? undefined : integer(item.severity);
    if (item.severity !== undefined && (severity === undefined || severity < 1 || severity > 4)) return undefined;
    if (item.source !== undefined && typeof item.source !== 'string') return undefined;
    if (item.code !== undefined && typeof item.code !== 'string' && typeof item.code !== 'number') return undefined;
    diagnostics.push(Object.freeze({
      range: Object.freeze({ startLine, startUtf16, endLine, endUtf16 }),
      message: item.message,
      severity: severity as 1 | 2 | 3 | 4 | undefined,
      source: item.source as string | undefined,
      code: item.code as string | number | undefined,
    }));
  }
  return Object.freeze(diagnostics);
}

function requestFailure(error: unknown, cancellation: CancellationToken | undefined): PullDiagnosticProviderFailure {
  if (cancellation?.isCancelled || (error instanceof Error && /cancel/u.test(error.message))) return { kind: 'cancelled', message: 'language diagnostic request was cancelled' };
  return { kind: 'failed', message: error instanceof Error ? error.message : 'language diagnostic request failed' };
}

function optionalResultId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 16 * 1024 ? value : undefined;
}

const STATIC_CAPABILITY_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  'textDocument/completion': 'completionProvider',
  'textDocument/hover': 'hoverProvider',
  'textDocument/signatureHelp': 'signatureHelpProvider',
  'textDocument/definition': 'definitionProvider',
  'textDocument/documentSymbol': 'documentSymbolProvider',
  'textDocument/codeAction': 'codeActionProvider',
  'textDocument/rename': 'renameProvider',
  'textDocument/diagnostic': 'diagnosticProvider',
  'workspace/diagnostic': 'diagnosticProvider',
  'textDocument/prepareCallHierarchy': 'callHierarchyProvider',
  'textDocument/prepareTypeHierarchy': 'typeHierarchyProvider',
  'textDocument/documentLink': 'documentLinkProvider',
});

const SUPPORTED_DYNAMIC_METHODS: ReadonlySet<string> = new Set([
  'textDocument/completion', 'textDocument/hover', 'textDocument/signatureHelp',
  'textDocument/definition', 'textDocument/documentSymbol', 'textDocument/codeAction',
  'textDocument/rename', 'textDocument/diagnostic', 'textDocument/prepareCallHierarchy',
  'textDocument/prepareTypeHierarchy', 'textDocument/documentLink',
  'workspace/willCreateFiles', 'workspace/willRenameFiles', 'workspace/willDeleteFiles',
  'workspace/didCreateFiles', 'workspace/didRenameFiles', 'workspace/didDeleteFiles',
]);

function isSupportedDynamicMethod(method: string): boolean { return SUPPORTED_DYNAMIC_METHODS.has(method); }

function staticRequestSupport(method: string, capabilities: InitializeResult['capabilities'] | null): boolean {
  const capRecord = capabilities === null ? undefined : asRecord(capabilities);
  if (capRecord === undefined) return false;
  const directField = STATIC_CAPABILITY_FIELDS[method];
  if (directField !== undefined) {
    const value = capRecord[directField];
    if (!isCapabilityValue(value)) return false;
    if (method === 'workspace/diagnostic') return asRecord(value)?.workspaceDiagnostics === true;
    return true;
  }
  if (method === 'completionItem/resolve') return asRecord(capRecord.completionProvider)?.resolveProvider === true;
  if (method === 'codeAction/resolve') return asRecord(capRecord.codeActionProvider)?.resolveProvider === true;
  if (method === 'textDocument/prepareRename') return asRecord(capRecord.renameProvider)?.prepareProvider === true;
  if (method === 'documentLink/resolve') return asRecord(capRecord.documentLinkProvider)?.resolveProvider === true;
  if (method === 'callHierarchy/incomingCalls' || method === 'callHierarchy/outgoingCalls') return isCapabilityValue(capRecord.callHierarchyProvider);
  if (method === 'typeHierarchy/supertypes' || method === 'typeHierarchy/subtypes') return isCapabilityValue(capRecord.typeHierarchyProvider);
  if (method.startsWith('workspace/will') || method.startsWith('workspace/did')) {
    const operation = method.slice('workspace/'.length);
    return isCapabilityValue(asRecord(asRecord(capRecord.workspace)?.fileOperations)?.[operation]);
  }
  return false;
}

function dynamicMethodMatches(requestMethod: string, registrationMethod: string, options: unknown): boolean {
  const expectedMethod = requestMethod === 'callHierarchy/incomingCalls' || requestMethod === 'callHierarchy/outgoingCalls'
    ? 'textDocument/prepareCallHierarchy'
    : requestMethod === 'typeHierarchy/supertypes' || requestMethod === 'typeHierarchy/subtypes'
      ? 'textDocument/prepareTypeHierarchy'
      : requestMethod === 'completionItem/resolve'
        ? 'textDocument/completion'
        : requestMethod === 'codeAction/resolve'
          ? 'textDocument/codeAction'
          : requestMethod === 'documentLink/resolve'
            ? 'textDocument/documentLink'
          : requestMethod === 'textDocument/prepareRename'
              ? 'textDocument/rename'
              : requestMethod === 'workspace/diagnostic'
                ? 'textDocument/diagnostic'
              : requestMethod;
  if (registrationMethod !== expectedMethod) return false;
  const record = asRecord(options);
  if (requestMethod === 'completionItem/resolve' || requestMethod === 'codeAction/resolve' || requestMethod === 'documentLink/resolve') return record?.resolveProvider === true;
  if (requestMethod === 'textDocument/prepareRename') return record?.prepareProvider === true;
  if (requestMethod === 'workspace/diagnostic') return record?.workspaceDiagnostics === true;
  return true;
}

function isCapabilityValue(value: unknown): boolean { return value === true || asRecord(value) !== undefined; }

type DynamicSelectorMatcher = (uri: string, languageId: string | undefined) => boolean;

function createDocumentSelectorMatcher(options: unknown, workspaceRoot: string): DynamicSelectorMatcher | undefined {
  const selector = asRecord(options)?.documentSelector;
  if (selector === undefined || selector === null) return undefined;
  if (!Array.isArray(selector) || selector.length === 0) return () => false;
  const filters: { readonly language: string | undefined; readonly scheme: string | undefined; readonly pattern: ((parts: { readonly scheme: string; readonly path: string }) => boolean) | undefined }[] = [];
  for (const item of selector) {
    const filter = asRecord(item);
    if (filter === undefined) return () => false;
    const pattern = filter.pattern === undefined ? undefined : compileUriPattern(filter.pattern, workspaceRoot);
    if (filter.pattern !== undefined && pattern === undefined) return () => false;
    filters.push({
      language: typeof filter.language === 'string' ? filter.language : undefined,
      scheme: typeof filter.scheme === 'string' ? filter.scheme : undefined,
      pattern,
    });
  }
  return (uri, languageId) => {
    const uriParts = uriPartsForSelector(uri);
    if (uriParts === undefined) return false;
    return filters.some((filter) =>
      (filter.language === undefined || filter.language === languageId) &&
      (filter.scheme === undefined || filter.scheme === uriParts.scheme) &&
      (filter.pattern === undefined || filter.pattern(uriParts)),
    );
  };
}

function uriPartsForSelector(uri: string): { readonly scheme: string; readonly path: string } | undefined {
  try {
    const parsed = new URL(uri);
    return { scheme: parsed.protocol.slice(0, -1), path: decodeURIComponent(parsed.pathname) };
  } catch { return undefined; }
}

function compileUriPattern(value: unknown, workspaceRoot: string): ((parts: { readonly scheme: string; readonly path: string }) => boolean) | undefined {
  let pattern: string;
  let basePath: string;
  let baseScheme: string | undefined;
  if (typeof value === 'string') {
    pattern = value;
    basePath = workspaceRoot.replaceAll('\\', '/').replace(/\/$/u, '');
  }
  else {
    const record = asRecord(value);
    const baseValue = record?.baseUri;
    const baseUri = typeof baseValue === 'string' ? baseValue : asRecord(baseValue)?.uri;
    if (typeof baseUri !== 'string' || typeof record?.pattern !== 'string') return undefined;
    const base = uriPartsForSelector(baseUri);
    if (base === undefined) return undefined;
    basePath = base.path.replace(/\/$/u, '');
    baseScheme = base.scheme;
    pattern = record.pattern;
  }
  const source = globPatternSource(pattern);
  if (source === undefined) return undefined;
  let regex: RegExp;
  try { regex = new RegExp(`^${source}$`, 'u'); } catch { return undefined; }
  return (parts) => {
    if (baseScheme !== undefined && baseScheme !== parts.scheme) return false;
    const normalized = parts.path.replaceAll('\\', '/');
    if (!normalized.startsWith(`${basePath}/`)) return false;
    return regex.test(normalized.slice(basePath.length + 1));
  };
}

function globPatternSource(pattern: string): string | undefined {
  let output = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') { output += '(?:.*/)?'; index += 1; }
        else output += '.*';
      } else output += '[^/]*';
      continue;
    }
    if (character === '?') { output += '[^/]'; continue; }
    if (character === '[') {
      const close = pattern.indexOf(']', index + 1);
      if (close < 0) return undefined;
      const contents = pattern.slice(index + 1, close);
      if (contents.length === 0) return undefined;
      output += `[${contents.startsWith('!') ? `^${contents.slice(1)}` : contents}]`;
      index = close;
      continue;
    }
    if (character === '{') {
      let depth = 1;
      let close = index + 1;
      for (; close < pattern.length && depth > 0; close += 1) {
        if (pattern[close] === '{') depth += 1;
        else if (pattern[close] === '}') depth -= 1;
      }
      if (depth !== 0) return undefined;
      const parts = splitGlobAlternatives(pattern.slice(index + 1, close - 1));
      if (parts === undefined || parts.length < 2) return undefined;
      const alternatives = parts.map(globPatternSource);
      if (alternatives.some((part) => part === undefined)) return undefined;
      output += `(?:${alternatives.join('|')})`;
      index = close - 1;
      continue;
    }
    if (character === ']' || character === '}') return undefined;
    if (character !== undefined && '.+^$()|\\'.includes(character)) output += `\\${character}`;
    else if (character !== undefined) output += character;
  }
  return output;
}

function splitGlobAlternatives(value: string): readonly string[] | undefined {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    else if (character === ',' && depth === 0) { parts.push(value.slice(start, index)); start = index + 1; }
    if (depth < 0) return undefined;
  }
  if (depth !== 0) return undefined;
  parts.push(value.slice(start));
  return parts.some((part) => part.length === 0) ? undefined : parts;
}

function integer(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }

function tokenFromUnknown(value: unknown): string | number | undefined {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)) ? value : undefined;
}

function tokenFromRecord(value: unknown): string | number | undefined {
  return tokenFromUnknown(asRecord(value)?.token);
}

function tokenKey(token: string | number): string { return typeof token === 'string' ? `s:${token}` : `n:${token}`; }

function readConfiguration(configuration: unknown, section: string | undefined): unknown {
  if (section === undefined || section.length === 0) return configuration ?? null;
  const record = asRecord(configuration);
  return record?.[section] ?? null;
}

function asRegistrationParams(value: unknown): RegistrationParams | undefined {
  const record = asRecord(value);
  if (!Array.isArray(record?.registrations) || record.registrations.length > MAX_DYNAMIC_CAPABILITIES) return undefined;
  const registrations: Registration[] = [];
  for (const candidate of record.registrations) {
    const item = asRecord(candidate);
    if (item === undefined || typeof item.id !== 'string' || item.id.length === 0 || typeof item.method !== 'string' || item.method.length === 0 || (item.registerOptions !== undefined && !validRegistrationOptions(item.registerOptions))) return undefined;
    registrations.push({ id: item.id, method: item.method, registerOptions: item.registerOptions });
  }
  return { registrations };
}

function asUnregistrationParams(value: unknown): UnregistrationParams | undefined {
  const record = asRecord(value);
  const values = record?.unregisterations;
  if (!Array.isArray(values) || values.length > MAX_DYNAMIC_CAPABILITIES) return undefined;
  const unregisterations: { readonly id: string; readonly method: string }[] = [];
  for (const candidate of values) {
    const item = asRecord(candidate);
    if (item === undefined || typeof item.id !== 'string' || item.id.length === 0 || typeof item.method !== 'string' || item.method.length === 0) return undefined;
    unregisterations.push({ id: item.id, method: item.method });
  }
  return { unregisterations };
}

function validRegistrationOptions(value: unknown): boolean {
  const options = asRecord(value);
  if (options === undefined) return false;
  const selector = options.documentSelector;
  if (selector === undefined || selector === null) return true;
  if (!Array.isArray(selector) || selector.length > MAX_DYNAMIC_CAPABILITIES) return false;
  return selector.every((candidate) => {
    const filter = asRecord(candidate);
    if (filter === undefined) return false;
    if (filter.language !== undefined && (typeof filter.language !== 'string' || filter.language.length > 256)) return false;
    if (filter.scheme !== undefined && (typeof filter.scheme !== 'string' || filter.scheme.length > 256)) return false;
    if (filter.pattern === undefined) return true;
    if (typeof filter.pattern === 'string') return filter.pattern.length <= 2_048;
    const pattern = asRecord(filter.pattern);
    return pattern !== undefined && typeof pattern.pattern === 'string' && pattern.pattern.length <= 2_048 && (typeof pattern.baseUri === 'string' || asRecord(pattern.baseUri) !== undefined);
  });
}

function pathFromUri(value: string): string | undefined {
  if (!value.startsWith('file://')) return value;
  try {
    const parsed = decodeURIComponent(value.slice('file://'.length));
    return parsed.startsWith('/') ? parsed : `/${parsed}`;
  } catch {
    return undefined;
  }
}

function pathToUri(path: string): string {
  if (path.startsWith('file://')) return path;
  const normalized = path.replaceAll('\\', '/');
  const encoded = normalized.split('/').map((part) => encodeURIComponent(part)).join('/');
  return encoded.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^\/\/[A-Za-z0-9._-]+\//u.test(path) || /^[A-Za-z]:\//u.test(path);
}

function joinPath(directory: string, child: string): string {
  if (directory.endsWith('/')) return `${directory}${child}`;
  return `${directory}/${child}`;
}

function dirname(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/{2,}/gu, '/');
  if (normalized === '/') return '/';
  if (/^[A-Za-z]:\/$/u.test(normalized)) return normalized;
  const withoutTrailing = normalized.replace(/\/+$/u, '');
  const slash = withoutTrailing.lastIndexOf('/');
  if (slash < 0) return '.';
  if (slash === 0) return '/';
  if (slash === 2 && /^[A-Za-z]:/u.test(withoutTrailing)) return `${withoutTrailing.slice(0, 3)}`;
  return withoutTrailing.slice(0, slash);
}
