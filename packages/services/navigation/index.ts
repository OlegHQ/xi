import {
  asIdentifier,
  CancellationSource,
  cloneSerializedSelectionValue,
  defineCommandRegistration,
  type CancellationToken,
  type CommandId,
  type CommandSchema,
  type ContributionModuleContext,
  type ContributionValue,
  type Disposable,
  type FeatureContributionModule,
  type Result,
  type ValidationIssue,
} from '../../contracts/src/index';

/** Stable public contract version for navigation read models and picker providers. */
export const NAVIGATION_CONTRACT_VERSION = 1 as const;

export type PickerMode = 'file' | 'buffer' | 'command' | 'theme' | 'config' | 'git' | 'diagnostic';
export type PickerEntryKind = PickerMode;

export interface PickerEntry {
  /** Stable identity. Selection is retained by this value, never by row index. */
  readonly id: string;
  readonly mode: PickerMode;
  readonly kind: PickerEntryKind;
  readonly label: string;
  readonly detail: string;
  readonly value: string;
  readonly rootId: string | undefined;
  readonly relativePath: string | undefined;
  readonly hidden: boolean;
  readonly score: number;
  readonly severity?: 1 | 2 | 3 | 4;
}

export interface PickerQueryRequest {
  readonly mode: PickerMode;
  readonly query: string;
  readonly limit?: number;
  readonly includeHidden?: boolean;
  readonly generation?: number;
}

export interface PickerReadModel {
  readonly contractVersion: 1;
  readonly mode: PickerMode;
  readonly query: string;
  readonly generation: number;
  readonly state: 'loading' | 'ready' | 'empty' | 'stale' | 'error';
  readonly entries: readonly PickerEntry[];
  readonly selectedId: string | undefined;
  readonly totalMatches: number;
  readonly truncated: boolean;
  readonly message: string | undefined;
}

export type PickerFailure =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'stale'; readonly generation: number }
  | { readonly kind: 'not-ready'; readonly mode: PickerMode; readonly message: string }
  | { readonly kind: 'provider'; readonly message: string };

export interface PickerProvider {
  readonly id: string;
  readonly mode: PickerMode;
  query(
    request: PickerQueryRequest,
    cancellation: CancellationToken,
  ): Promise<Result<readonly PickerEntry[], PickerFailure>>;
}

export interface PickerQueryOptions {
  readonly cancellation?: CancellationToken;
  readonly limit?: number;
  readonly includeHidden?: boolean;
}

/**
 * Immutable multi-root path identity. Relative names can repeat across roots;
 * rootId remains part of every item identity and display detail.
 */
export interface WorkspaceRoot {
  readonly id: string;
  readonly label: string;
  readonly path: string;
}

export interface IndexedPath {
  readonly rootId: string;
  readonly relativePath: string;
  readonly absolutePath?: string;
  readonly hidden?: boolean;
  readonly ignored?: boolean;
}

export interface FilePathIndexOptions {
  readonly maxEntries?: number;
  readonly includeIgnored?: boolean;
  readonly includeHidden?: boolean;
}

export interface FileIndexSnapshot {
  readonly generation: number;
  readonly ready: boolean;
  readonly roots: readonly WorkspaceRoot[];
  readonly entries: number;
}

export type FileIndexFailure =
  | { readonly kind: 'unknown-root'; readonly rootId: string }
  | { readonly kind: 'duplicate-root'; readonly rootId: string }
  | { readonly kind: 'capacity'; readonly maxEntries: number }
  | { readonly kind: 'invalid-path'; readonly message: string };

export interface FilePickerQueryOptions extends PickerQueryOptions {
  readonly includeIgnored?: boolean;
}

export interface FilePickerQueryResult {
  readonly entries: readonly PickerEntry[];
  readonly generation: number;
  readonly totalMatches: number;
  readonly truncated: boolean;
}

/**
 * Incremental filename index. Enumeration is supplied by a filesystem worker;
 * this owner only stores bounded metadata and performs a pure fuzzy query.
 */
export class FilePathIndex implements Disposable {
  readonly #maxEntries: number;
  readonly #includeIgnored: boolean;
  readonly #includeHidden: boolean;
  readonly #roots = new Map<string, WorkspaceRoot>();
  readonly #entries = new Map<string, IndexedPath>();
  readonly #normalizedEntries = new Map<string, string>();
  #generation = 0;
  #ready = false;
  #disposed = false;

  constructor(options: FilePathIndexOptions = {}) {
    const maxEntries = options.maxEntries ?? 250_000;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('navigation-index-max-entries-must-be-positive');
    this.#maxEntries = maxEntries;
    this.#includeIgnored = options.includeIgnored === true;
    this.#includeHidden = options.includeHidden ?? true;
  }

  get snapshot(): FileIndexSnapshot {
    return Object.freeze({
      generation: this.#generation,
      ready: this.#ready,
      roots: Object.freeze([...this.#roots.values()]),
      entries: this.#entries.size,
    });
  }

  addRoot(root: WorkspaceRoot): Result<Disposable, FileIndexFailure> {
    if (this.#disposed) return { ok: false, error: { kind: 'invalid-path', message: 'filename index is disposed' } };
    if (!validIdentifier(root.id) || root.path.length === 0 || root.label.length === 0) {
      return { ok: false, error: { kind: 'invalid-path', message: 'root id, label and path are required' } };
    }
    if (this.#roots.has(root.id)) return { ok: false, error: { kind: 'duplicate-root', rootId: root.id } };
    this.#roots.set(root.id, Object.freeze({ ...root }));
    this.#generation += 1;
    return { ok: true, value: Object.freeze({ dispose: () => { this.removeRoot(root.id); } }) };
  }

  addPaths(rootId: string, paths: readonly IndexedPath[]): Result<number, FileIndexFailure> {
    if (this.#disposed) return { ok: false, error: { kind: 'invalid-path', message: 'filename index is disposed' } };
    if (!this.#roots.has(rootId)) return { ok: false, error: { kind: 'unknown-root', rootId } };
    const pending: IndexedPath[] = [];
    const pendingIdentities = new Set<string>();
    for (const path of paths) {
      const checked = normalizeIndexedPath(rootId, path);
      if (!checked.ok) return checked;
      const identity = pathIdentity(checked.value.rootId, checked.value.relativePath);
      if (!this.#entries.has(identity) && !pendingIdentities.has(identity)) {
        pending.push(checked.value);
        pendingIdentities.add(identity);
      }
    }
    if (this.#entries.size + pending.length > this.#maxEntries) {
      return { ok: false, error: { kind: 'capacity', maxEntries: this.#maxEntries } };
    }
    for (const path of pending) {
      const identity = pathIdentity(path.rootId, path.relativePath);
      this.#entries.set(identity, Object.freeze(path));
      this.#normalizedEntries.set(identity, normalizeForSearch(path.relativePath));
    }
    if (pending.length > 0) this.#generation += 1;
    this.#ready = true;
    return { ok: true, value: pending.length };
  }

  removePath(rootId: string, relativePath: string): boolean {
    if (!this.#roots.has(rootId)) return false;
    const identity = pathIdentity(rootId, relativePath);
    const deleted = this.#entries.delete(identity);
    this.#normalizedEntries.delete(identity);
    if (deleted) this.#generation += 1;
    return deleted;
  }

  removeRoot(rootId: string): boolean {
    if (!this.#roots.delete(rootId)) return false;
    let removed = false;
    for (const identity of this.#entries.keys()) {
      if (identity.startsWith(`${rootId}\u0000`)) {
        this.#entries.delete(identity);
        this.#normalizedEntries.delete(identity);
        removed = true;
      }
    }
    this.#generation += 1;
    this.#ready = this.#entries.size > 0;
    return removed || true;
  }

  markReady(): void {
    if (this.#disposed) return;
    this.#ready = true;
    this.#generation += 1;
  }

  /**
   * Time-sliced counterpart to `query()`: scores entries in bounded chunks and
   * yields to the event loop between them so a query over a large index (up to
   * 250k entries) never holds the thread for one long synchronous pass. Honors
   * cancellation and the index's own generation (bumped by any mutation) between
   * slices so a query never scores against a store that changed underneath it.
   */
  async queryAsync(query: string, options: FilePickerQueryOptions = {}): Promise<Result<FilePickerQueryResult, PickerFailure>> {
    const cancellation = options.cancellation;
    if (cancellation?.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
    if (this.#disposed) return { ok: false, error: { kind: 'provider', message: 'filename index is disposed' } };
    if (!this.#ready) return { ok: false, error: { kind: 'not-ready', mode: 'file', message: 'filename index is still warming' } };
    const generation = this.#generation;
    const limit = boundedLimit(options.limit);
    const includeHidden = options.includeHidden ?? this.#includeHidden;
    const includeIgnored = options.includeIgnored ?? this.#includeIgnored;
    const normalizedQuery = normalizeForSearch(query);
    const anchor = normalizedQuery.length >= 3 && !normalizedQuery.includes(' ')
      ? normalizedQuery
      : longestLiteralAnchor(normalizedQuery);
    // Bounded top-N: kept sorted (best first) and capped at `candidateCap`
    // rather than pushing every match into an unbounded array and sorting it
    // all at the end. A query that matches most of a 250k-entry index only
    // ever pays a full-array sort/shift cost for the (small, capped) surviving
    // set, not for every match.
    const candidateCap = Math.max(limit, 500);
    const matches: PickerEntry[] = [];
    let totalMatches = 0;
    // A fixed-size chunk (tuned to land near a 4ms slice for typical fuzzy-score
    // costs) yields unconditionally rather than gating on elapsed time, so the
    // pause cadence -- and therefore cancellation/generation responsiveness --
    // stays deterministic across hardware instead of degrading to zero yields
    // on a fast machine.
    const CHUNK_SIZE = 2_000;
    let scanned = 0;
    for (const [identity, path] of this.#entries) {
      // Count and yield on every visited entry, not only matches that pass every
      // filter -- otherwise a query with a selective anchor (mostly `continue`s)
      // could scan the whole index in one synchronous pass without ever yielding.
      scanned += 1;
      if (scanned % CHUNK_SIZE === 0) {
        await yieldToEventLoop();
        if (cancellation?.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
        if (this.#generation !== generation) return { ok: false, error: { kind: 'stale', generation } };
      }
      if (!includeHidden && path.hidden === true) continue;
      if (!includeIgnored && path.ignored === true) continue;
      const root = this.#roots.get(path.rootId);
      if (root === undefined) continue;
      const normalizedPath = this.#normalizedEntries.get(identity) ?? '';
      if (anchor.length >= 3 && !normalizedPath.includes(anchor)) continue;
      const score = scoreFuzzyNormalized(normalizedQuery, normalizedPath);
      if (score === undefined) continue;
      totalMatches += 1;
      insertTopN(matches, makeFileEntry(root, path, score), candidateCap);
    }
    if (cancellation?.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
    if (this.#generation !== generation) return { ok: false, error: { kind: 'stale', generation } };
    const entries = Object.freeze(matches.slice(0, limit));
    return { ok: true, value: Object.freeze({ entries, generation: this.#generation, totalMatches, truncated: totalMatches > entries.length }) };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#entries.clear();
    this.#normalizedEntries.clear();
    this.#roots.clear();
    this.#generation += 1;
    this.#ready = false;
  }
}

/** Provider adapter used by the bounded model and contribution registry. */
export class FilePickerProvider implements PickerProvider {
  readonly id = 'xi.navigation.files';
  readonly mode = 'file' as const;
  readonly #index: FilePathIndex;

  constructor(index: FilePathIndex) { this.#index = index; }

  async query(request: PickerQueryRequest, cancellation: CancellationToken): Promise<Result<readonly PickerEntry[], PickerFailure>> {
    if (cancellation.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
    const queryOptions: FilePickerQueryOptions = { cancellation, ...(request.limit === undefined ? {} : { limit: request.limit }), ...(request.includeHidden === undefined ? {} : { includeHidden: request.includeHidden }) };
    const result = await this.#index.queryAsync(request.query, queryOptions);
    if (!result.ok) return result;
    return { ok: true, value: result.value.entries };
  }
}

export interface StaticPickerEntry {
  readonly id: string;
  readonly mode: Exclude<PickerMode, 'file'>;
  readonly label: string;
  readonly detail?: string;
  readonly value?: string;
  readonly hidden?: boolean;
}

/** Bounded immutable provider for buffers, commands, themes and config actions. */
export class StaticPickerProvider implements PickerProvider {
  readonly id: string;
  readonly mode: Exclude<PickerMode, 'file'>;
  readonly #entries: readonly PickerEntry[];

  constructor(id: string, mode: Exclude<PickerMode, 'file'>, entries: readonly StaticPickerEntry[]) {
    if (!validIdentifier(id)) throw new TypeError('picker-provider-id-must-be-nonempty');
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!validIdentifier(entry.id) || ids.has(entry.id)) throw new TypeError('picker-entry-ids-must-be-unique');
      ids.add(entry.id);
    }
    this.id = id;
    this.mode = mode;
    this.#entries = Object.freeze(entries.map((entry) => Object.freeze({
      id: entry.id,
      mode,
      kind: mode,
      label: entry.label,
      detail: entry.detail ?? '',
      value: entry.value ?? entry.id,
      rootId: undefined,
      relativePath: undefined,
      hidden: entry.hidden === true,
      score: 0,
    })));
  }

  async query(request: PickerQueryRequest, cancellation: CancellationToken): Promise<Result<readonly PickerEntry[], PickerFailure>> {
    if (cancellation.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
    const normalized = normalizeForSearch(request.query);
    const found: PickerEntry[] = [];
    for (const entry of this.#entries) {
      if (cancellation.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
      if (request.includeHidden === false && entry.hidden) continue;
      const score = scoreFuzzy(normalized, `${entry.label} ${entry.detail}`);
      if (score === undefined) continue;
      found.push(Object.freeze({ ...entry, score }));
    }
    found.sort(compareEntries);
    return { ok: true, value: Object.freeze(found.slice(0, boundedLimit(request.limit))) };
  }
}

export interface BufferPickerEntry {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly value: string;
  readonly severity?: 1 | 2 | 3 | 4;
}

/** Picker provider over an in-memory buffer list supplied by `source()` on every query (open
 * buffers change independently of the picker). Uses plain NFKC-normalized, locale-lowercased
 * substring matching rather than `StaticPickerProvider`'s fuzzy score, matching how buffer
 * switching is expected to behave: a literal substring of the path, not a fuzzy path match. */
export class BufferPickerProvider implements PickerProvider {
  readonly id: string;
  readonly mode: Exclude<PickerMode, 'file'>;
  readonly #source: () => readonly BufferPickerEntry[];

  /** `mode` defaults to buffers; any other non-file mode (e.g. themes discovered after startup) reuses the same live-source matching. */
  constructor(id: string, source: () => readonly BufferPickerEntry[], mode: Exclude<PickerMode, 'file'> = 'buffer') {
    if (!validIdentifier(id)) throw new TypeError('picker-provider-id-must-be-nonempty');
    this.id = id;
    this.#source = source;
    this.mode = mode;
  }

  async query(request: PickerQueryRequest, cancellation: CancellationToken): Promise<Result<readonly PickerEntry[], PickerFailure>> {
    const query = normalizeForSearch(request.query);
    const entries: PickerEntry[] = [];
    for (const entry of this.#source()) {
      if (cancellation.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
      if (query.length > 0 && !normalizeForSearch(this.mode === 'diagnostic' ? `${entry.label} ${entry.detail}` : entry.label).includes(query)) continue;
      entries.push(Object.freeze({
        id: entry.id, mode: this.mode, kind: this.mode, label: entry.label, detail: entry.detail, value: entry.value,
        rootId: undefined, relativePath: undefined, hidden: false, score: query.length === 0 ? 0 : 1,
        ...(entry.severity === undefined ? {} : { severity: entry.severity }),
      }));
    }
    return { ok: true, value: Object.freeze(entries.slice(0, request.limit ?? 100)) };
  }
}

export interface BoundedPickerModelOptions {
  readonly providers: readonly PickerProvider[];
  readonly maxResults?: number;
}

/**
 * Query coordinator for all picker modes. Every query captures a generation;
 * cancellation and late responses can never publish stale rows.
 */
export class BoundedPickerModel implements Disposable {
  readonly #providers: ReadonlyMap<PickerMode, PickerProvider>;
  readonly #maxResults: number;
  readonly #listeners = new Set<(model: PickerReadModel) => void>();
  #source: CancellationSource | undefined;
  #generation = 0;
  #model: PickerReadModel;
  #disposed = false;

  constructor(options: BoundedPickerModelOptions) {
    const maxResults = options.maxResults ?? 10_000;
    if (!Number.isSafeInteger(maxResults) || maxResults < 1) throw new TypeError('picker-max-results-must-be-positive');
    const providers = new Map<PickerMode, PickerProvider>();
    for (const provider of options.providers) {
      if (providers.has(provider.mode)) throw new TypeError(`duplicate-picker-mode:${provider.mode}`);
      providers.set(provider.mode, provider);
    }
    this.#providers = providers;
    this.#maxResults = maxResults;
    this.#model = emptyModel('file', '', 0, 'loading');
  }

  get model(): PickerReadModel { return this.#model; }

  subscribe(listener: (model: PickerReadModel) => void): Disposable {
    if (this.#disposed) throw new Error('picker-model-disposed');
    this.#listeners.add(listener);
    return Object.freeze({ dispose: () => { this.#listeners.delete(listener); } });
  }

  async query(mode: PickerMode, query: string, options: PickerQueryOptions = {}): Promise<Result<PickerReadModel, PickerFailure>> {
    if (this.#disposed) return { ok: false, error: { kind: 'provider', message: 'picker model is disposed' } };
    this.#source?.cancel();
    this.#source?.dispose();
    const source = new CancellationSource();
    this.#source = source;
    const generation = ++this.#generation;
    this.#model = emptyModel(mode, query, generation, 'loading');
    this.notify();
    const provider = this.#providers.get(mode);
    if (provider === undefined) {
      const error: PickerFailure = { kind: 'not-ready', mode, message: 'picker mode has no provider' };
      this.#model = emptyModel(mode, query, generation, error.kind === 'not-ready' ? 'stale' : 'error', error.message);
      this.notify();
      return { ok: false, error };
    }
    const parent = options.cancellation?.onCancel(() => source.cancel());
    if (options.cancellation?.isCancelled === true) source.cancel();
    try {
      const providerRequest: PickerQueryRequest = { mode, query, limit: Math.min(options.limit ?? this.#maxResults, this.#maxResults), ...(options.includeHidden === undefined ? {} : { includeHidden: options.includeHidden }) };
      const cancellationRace = new Promise<Result<readonly PickerEntry[], PickerFailure>>((resolve) => {
        source.token.onCancel(() => resolve({ ok: false, error: { kind: 'cancelled' } }));
      });
      const pending = await Promise.race([
        Promise.resolve().then(() => provider.query(Object.freeze(providerRequest), source.token)),
        cancellationRace,
      ]);
      if (generation !== this.#generation) return { ok: false, error: { kind: 'stale', generation } };
      if (source.token.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
      if (!pending.ok) {
        this.#model = emptyModel(mode, query, generation, pending.error.kind === 'not-ready' ? 'stale' : 'error', failureMessage(pending.error));
        this.notify();
        return pending;
      }
      const entries = Object.freeze([...pending.value].slice(0, this.#maxResults));
      this.#model = Object.freeze({
        contractVersion: NAVIGATION_CONTRACT_VERSION,
        mode,
        query,
        generation,
        state: entries.length === 0 ? 'empty' : 'ready',
        entries,
        selectedId: entries[0]?.id,
        totalMatches: pending.value.length,
        truncated: pending.value.length > entries.length,
        message: entries.length === 0 ? 'No matches' : undefined,
      });
      this.notify();
      return { ok: true, value: this.#model };
    } finally {
      parent?.dispose();
      if (this.#source === source) this.#source = undefined;
      source.dispose();
    }
  }

  cancel(): void {
    this.#generation += 1;
    this.#source?.cancel();
    this.#source?.dispose();
    this.#source = undefined;
    this.#model = Object.freeze({ ...this.#model, state: 'stale', message: 'Cancelled', generation: this.#generation });
    this.notify();
  }

  select(id: string): boolean {
    if (!this.#model.entries.some((entry) => entry.id === id)) return false;
    this.#model = Object.freeze({ ...this.#model, selectedId: id });
    this.notify();
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.cancel();
    this.#listeners.clear();
  }

  private notify(): void {
    for (const listener of [...this.#listeners]) listener(this.#model);
  }
}

export interface NavigationContributionOptions {
  readonly fileIndex?: FilePathIndex;
  readonly buffers?: readonly StaticPickerEntry[];
  readonly commands?: readonly StaticPickerEntry[];
  readonly themes?: readonly StaticPickerEntry[];
  readonly configs?: readonly StaticPickerEntry[];
}

/**
 * Public built-in consumer seam. Apps install this module through the normal
 * contribution registry; picker UIs consume its inert models and command IDs.
 */
export function createNavigationContributionModule(options: NavigationContributionOptions = {}): FeatureContributionModule {
  const fileIndex = options.fileIndex;
  const providers: readonly PickerProvider[] = [
    ...(fileIndex === undefined ? [] : [new FilePickerProvider(fileIndex)]),
    new StaticPickerProvider('xi.navigation.buffers', 'buffer', options.buffers ?? []),
    new StaticPickerProvider('xi.navigation.commands', 'command', options.commands ?? []),
    new StaticPickerProvider('xi.navigation.themes', 'theme', options.themes ?? []),
    new StaticPickerProvider('xi.navigation.config', 'config', options.configs ?? []),
  ];
  return {
    id: 'xi.navigation',
    contractVersion: NAVIGATION_CONTRACT_VERSION,
    owner: 'services.navigation',
    priority: 0,
    scope: 'workspace',
    activate(context) {
      const commandsResult = context.registerCommands({ commands: pickerCommands() });
      if (!commandsResult.ok) return;
      for (const provider of providers) {
        const modelResult = context.registerModel({
          id: `xi.navigation.${provider.mode}`,
          contractVersion: NAVIGATION_CONTRACT_VERSION,
          owner: 'services.navigation',
          kind: 'picker',
          priority: 0,
          scope: 'workspace',
          read: () => ({
            id: provider.id,
            mode: provider.mode,
            ready: provider.mode !== 'file' || fileIndex?.snapshot.ready === true,
          }),
        });
        if (!modelResult.ok) return;
      }
    },
  };
}

function pickerCommands() {
  const schema: CommandSchema<ContributionValue> = {
    decode(input: unknown): Result<ContributionValue, readonly ValidationIssue[]> {
      const decoded = cloneSerializedSelectionValue(input);
      return decoded.ok ? decoded : { ok: false, error: [decoded.error] };
    },
  };
  return [
    command('files.pick', 'File picker', 'Open the multi-root file picker.', schema),
    command('buffers.pick', 'Buffer picker', 'Open the open-buffer picker.', schema),
    command('diagnostics.pick', 'Diagnostics', 'Search diagnostics and jump to their source.', schema),
    command('command.pick', 'Command picker', 'Search every available command and alias.', schema),
    command('theme.pick', 'Theme picker', 'Preview and choose a theme.', schema),
    command('config.open', 'Open config', 'Open a configuration document.', schema),
    command('config.reload', 'Reload config', 'Reload configuration after validation.', schema),
  ];
}

function command(id: string, title: string, help: string, schema: CommandSchema<ContributionValue>) {
  const identifier = asIdentifier<CommandId>(id, 'commandId');
  if (!identifier.ok) throw new Error(identifier.error.message);
  return defineCommandRegistration<ContributionValue, ContributionValue>({
    descriptor: {
      id: identifier.value,
      contractVersion: NAVIGATION_CONTRACT_VERSION,
      priority: 0,
      owner: 'services.navigation',
      title,
      help,
      category: 'navigation',
      arguments: schema,
      output: schema,
      selectionPolicy: 'workspace-once',
      effect: 'read',
      undoPolicy: 'none',
      replayPolicy: 'never',
      cancellationPolicy: 'cancellable',
      availability: { contexts: [], requiredCapabilities: [], unavailableReason: `${title} is unavailable.` },
    },
    handler: (value, context) => context.cancellation.isCancelled ? null : value,
  });
}

function makeFileEntry(root: WorkspaceRoot, path: IndexedPath, score: number): PickerEntry {
  const detail = root.label === root.path ? root.label : `${root.label} · ${root.path}`;
  return Object.freeze({
    id: pathIdentity(root.id, path.relativePath), mode: 'file', kind: 'file',
    label: truncatePathForDisplay(path.relativePath, 160), detail, value: path.absolutePath ?? joinPath(root.path, path.relativePath),
    rootId: root.id, relativePath: path.relativePath, hidden: path.hidden === true, score,
  });
}

function normalizeIndexedPath(rootId: string, path: IndexedPath): Result<IndexedPath, FileIndexFailure> {
  if (path.rootId !== rootId || path.relativePath.length === 0 || path.relativePath.includes('\u0000')) {
    return { ok: false, error: { kind: 'invalid-path', message: 'indexed path must have a nonempty NUL-free relative path and matching root' } };
  }
  const relativePath = path.relativePath.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (relativePath.length === 0 || relativePath.split('/').some((part) => part === '..')) {
    return { ok: false, error: { kind: 'invalid-path', message: 'indexed path must remain beneath its root' } };
  }
  return { ok: true, value: { ...path, rootId, relativePath, hidden: path.hidden === true, ignored: path.ignored === true } };
}

function pathIdentity(rootId: string, relativePath: string): string { return `${rootId}\u0000${relativePath}`; }
function validIdentifier(value: string): boolean { return value.length > 0 && value.length <= 512 && !value.includes('\u0000'); }
function joinPath(root: string, relative: string): string { return root.endsWith('/') ? `${root}${relative}` : `${root}/${relative}`; }
function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 10_000;
  if (!Number.isSafeInteger(value) || value < 1) return 1;
  return Math.min(value, 10_000);
}
function normalizeForSearch(value: string): string { return value.normalize('NFKC').toLocaleLowerCase('en-US'); }
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
function scoreFuzzy(query: string, candidate: string): number | undefined {
  return scoreFuzzyNormalized(normalizeForSearch(query), normalizeForSearch(candidate));
}

/** ASCII paths use indexed code units to avoid 100k temporary arrays. Unicode
 * paths take the scalar-safe branch so surrogate pairs remain indivisible. */
function scoreFuzzyNormalized(normalizedQuery: string, normalizedCandidate: string): number | undefined {
  if (normalizedQuery.length === 0) return 0;
  const unicode = /[^\u0000-\u007f]/u.test(normalizedQuery) || /[^\u0000-\u007f]/u.test(normalizedCandidate);
  const queryChars = unicode ? [...normalizedQuery] : undefined;
  const candidateChars = unicode ? [...normalizedCandidate] : undefined;
  const queryLength = queryChars?.length ?? normalizedQuery.length;
  const candidateLength = candidateChars?.length ?? normalizedCandidate.length;
  let queryIndex = 0;
  let candidateIndex = 0;
  let score = 0;
  let previous = -2;
  while (queryIndex < queryLength) {
    const wanted = queryChars?.[queryIndex] ?? normalizedQuery[queryIndex];
    if (wanted === undefined) break;
    let found = -1;
    for (; candidateIndex < candidateLength; candidateIndex += 1) {
      const current = candidateChars?.[candidateIndex] ?? normalizedCandidate[candidateIndex];
      if (current === wanted) { found = candidateIndex; break; }
    }
    if (found < 0) return undefined;
    const previousCharacter = candidateChars?.[found - 1] ?? normalizedCandidate[found - 1];
    const boundary = found === 0 || '/\\_- .'.includes(previousCharacter ?? '');
    score += boundary ? 16 : 4;
    score += found === previous + 1 ? 10 : 0;
    score -= found;
    previous = found;
    candidateIndex = found + 1;
    queryIndex += 1;
  }
  if (normalizedCandidate.startsWith(normalizedQuery)) score += 80;
  if (normalizedCandidate === normalizedQuery) score += 160;
  score -= Math.max(0, candidateLength - queryLength) / 1000;
  return score;
}

function longestLiteralAnchor(query: string): string {
  let best = '';
  let current = '';
  for (const character of query) {
    if (' /\\_-'.includes(character)) {
      if (current.length > best.length) best = current;
      current = '';
    } else {
      current += character;
    }
  }
  return current.length > best.length ? current : best;
}

function compareEntries(left: PickerEntry, right: PickerEntry): number {
  return right.score - left.score || left.label.localeCompare(right.label, 'en-US') || left.id.localeCompare(right.id, 'en-US');
}

/**
 * Inserts `entry` into `list` (kept sorted best-first by `compareEntries`),
 * bounded at `cap` entries. Once `list` is full, an entry no better than the
 * current worst-kept is rejected in O(1) rather than appended and sorted
 * away later, so scoring a query that matches most of a 250k-entry index
 * only ever maintains a small, capped candidate set instead of an unbounded
 * one.
 */
function insertTopN(list: PickerEntry[], entry: PickerEntry, cap: number): void {
  if (list.length >= cap) {
    const worst = list[list.length - 1]!;
    if (compareEntries(entry, worst) >= 0) return;
  }
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compareEntries(list[mid]!, entry) <= 0) low = mid + 1; else high = mid;
  }
  list.splice(low, 0, entry);
  if (list.length > cap) list.pop();
}
function failureMessage(failure: PickerFailure): string {
  switch (failure.kind) {
    case 'cancelled': return 'Cancelled';
    case 'stale': return 'Stale query';
    case 'not-ready': return failure.message;
    case 'provider': return failure.message;
  }
}
function emptyModel(mode: PickerMode, query: string, generation: number, state: PickerReadModel['state'], message?: string): PickerReadModel {
  return Object.freeze({ contractVersion: NAVIGATION_CONTRACT_VERSION, mode, query, generation, state, entries: Object.freeze([]), selectedId: undefined, totalMatches: 0, truncated: false, message });
}

export function truncatePathForDisplay(value: string, maxCodePoints: number): string {
  if (!Number.isSafeInteger(maxCodePoints) || maxCodePoints < 1) return '';
  const points = [...value];
  if (points.length <= maxCodePoints) return value;
  if (maxCodePoints === 1) return '…';
  const tail = Math.max(1, Math.floor((maxCodePoints - 1) * 0.58));
  const head = maxCodePoints - 1 - tail;
  return `${points.slice(0, head).join('')}…${points.slice(-tail).join('')}`;
}
