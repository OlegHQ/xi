import type { CancellationToken, Disposable, Result } from '../../contracts/src/index.ts';

/** Public contract version for workspace file tree read models. */
export const EXPLORER_CONTRACT_VERSION = 1 as const;

export type ExplorerNodeKind = 'root' | 'directory' | 'file' | 'symlink' | 'other' | 'state';
export type ExplorerLoadState = 'unloaded' | 'loading' | 'ready' | 'empty' | 'permission-denied' | 'symlink-cycle' | 'overflow' | 'error';

export interface ExplorerRoot {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly stableIdentity?: string;
}

/** One entry returned by a lazy directory enumeration. Paths are root-relative. */
export interface ExplorerDirectoryEntry {
  readonly name: string;
  readonly relativePath: string;
  readonly kind: Exclude<ExplorerNodeKind, 'root' | 'state'>;
  readonly stableIdentity?: string;
  readonly hidden?: boolean;
  readonly ignored?: boolean;
  readonly sizeBytes?: number;
  readonly modifiedMilliseconds?: number;
  readonly symlinkTarget?: string;
  /** A directory may be known to be a cycle before it is expanded. */
  readonly symlinkCycle?: boolean;
  readonly git?: ExplorerGitDecoration;
}

export type ExplorerWatchEvent =
  | { readonly kind: 'created'; readonly rootId: string; readonly relativePath: string; readonly entry?: ExplorerDirectoryEntry }
  | { readonly kind: 'changed'; readonly rootId: string; readonly relativePath: string; readonly entry?: ExplorerDirectoryEntry }
  | { readonly kind: 'removed'; readonly rootId: string; readonly relativePath: string }
  | { readonly kind: 'renamed'; readonly rootId: string; readonly previousRelativePath: string; readonly relativePath: string; readonly entry?: ExplorerDirectoryEntry }
  | { readonly kind: 'overflow'; readonly rootId: string; readonly relativePath: string };

export type ExplorerFailure =
  | { readonly kind: 'cancelled'; readonly message: string }
  | { readonly kind: 'root-not-found'; readonly rootId: string }
  | { readonly kind: 'invalid-path'; readonly message: string }
  | { readonly kind: 'permission-denied'; readonly path: string; readonly message: string }
  | { readonly kind: 'symlink-cycle'; readonly path: string; readonly message: string }
  | { readonly kind: 'watch-overflow'; readonly path: string; readonly message: string }
  | { readonly kind: 'filesystem'; readonly path: string; readonly message: string };

/** Filesystem work is injected. The explorer never calls synchronous filesystem APIs. */
export interface ExplorerFilesystemPort {
  enumerateDirectory(path: string, cancellation: CancellationToken): Promise<Result<readonly ExplorerDirectoryEntry[], ExplorerFailure>>;
  watchDirectory(path: string, listener: (event: ExplorerWatchEvent) => void, cancellation: CancellationToken): Promise<Result<Disposable, ExplorerFailure>>;
}

export interface ExplorerMetadata {
  readonly sizeBytes: number | undefined;
  readonly modifiedMilliseconds: number | undefined;
  readonly permissions: string | undefined;
}

export interface ExplorerMetadataPort {
  read(path: string, cancellation: CancellationToken): Promise<Result<ExplorerMetadata, ExplorerFailure>>;
}

export type ExplorerGitState = 'clean' | 'modified' | 'staged' | 'untracked' | 'ignored' | 'conflicted';

export interface ExplorerGitDecoration {
  readonly state: ExplorerGitState;
  readonly label: string;
  readonly colorToken: string;
}

export interface ExplorerGitDecorationPort {
  read(path: string, cancellation: CancellationToken): Promise<Result<ExplorerGitDecoration | undefined, ExplorerFailure>>;
}

export interface ExplorerNode {
  readonly id: string;
  readonly rootId: string;
  readonly parentId: string | undefined;
  readonly name: string;
  readonly relativePath: string;
  readonly path: string;
  readonly kind: ExplorerNodeKind;
  readonly depth: number;
  readonly expanded: boolean;
  readonly hidden: boolean;
  readonly ignored: boolean;
  readonly loadState: ExplorerLoadState;
  readonly children: readonly string[];
  readonly stableIdentity: string;
  readonly sizeBytes: number | undefined;
  readonly modifiedMilliseconds: number | undefined;
  readonly permissions: string | undefined;
  readonly symlinkTarget: string | undefined;
  readonly git: ExplorerGitDecoration | undefined;
  readonly message: string | undefined;
}

export interface ExplorerVisibleRow {
  readonly nodeId: string;
  readonly depth: number;
  readonly kind: ExplorerNodeKind;
  readonly selected: boolean;
}

export interface ExplorerReadModel {
  readonly contractVersion: 1;
  readonly generation: number;
  readonly roots: readonly string[];
  readonly nodes: readonly ExplorerNode[];
  readonly visibleRows: readonly ExplorerVisibleRow[];
  readonly selectedId: string | undefined;
  readonly filter: string;
  readonly includeHidden: boolean;
  readonly includeIgnored: boolean;
  readonly focused: boolean;
  readonly state: 'ready' | 'loading' | 'empty' | 'error';
  readonly message: string | undefined;
}

export interface ExplorerReadPort {
  readonly model: ExplorerReadModel;
  subscribe(listener: (model: ExplorerReadModel) => void): Disposable;
}

export interface ExplorerOptions {
  readonly includeHidden?: boolean;
  readonly includeIgnored?: boolean;
  readonly followSymlinks?: boolean;
  readonly metadata?: ExplorerMetadataPort;
  readonly git?: ExplorerGitDecorationPort;
}

type MutableNode = {
  id: string;
  rootId: string;
  parentId: string | undefined;
  name: string;
  relativePath: string;
  path: string;
  kind: ExplorerNodeKind;
  depth: number;
  expanded: boolean;
  hidden: boolean;
  ignored: boolean;
  loadState: ExplorerLoadState;
  children: string[];
  stableIdentity: string;
  sizeBytes: number | undefined;
  modifiedMilliseconds: number | undefined;
  permissions: string | undefined;
  symlinkTarget: string | undefined;
  git: ExplorerGitDecoration | undefined;
  message: string | undefined;
};

/**
 * Lazily reconciled workspace tree. Selection is an opaque node ID and is
 * therefore independent of visible row indexes. A rename event retains the
 * old ID, while an inode/stableIdentity supplied by the filesystem survives a
 * full directory refresh as well.
 */
export class ExplorerTree implements ExplorerReadPort, Disposable {
  readonly #filesystem: ExplorerFilesystemPort;
  readonly #metadata: ExplorerMetadataPort | undefined;
  readonly #git: ExplorerGitDecorationPort | undefined;
  readonly #followSymlinks: boolean;
  readonly #nodes = new Map<string, MutableNode>();
  readonly #roots: string[] = [];
  readonly #rootPaths = new Map<string, ExplorerRoot>();
  readonly #stableIds = new Map<string, string>();
  readonly #loadGenerations = new Map<string, number>();
  readonly #watchers = new Map<string, Disposable>();
  readonly #listeners = new Set<(model: ExplorerReadModel) => void>();
  #decorationPublishTimer: ReturnType<typeof setTimeout> | undefined;
  /** Per-parent-directory in-flight guard for `applyWatchEvent`: at most one run per key is
   * ever active. An event for a key already running is coalesced (only the latest is kept) and
   * runs once the active one finishes, instead of two overlapping reconcile/publish sequences
   * racing for the same parent. */
  readonly #inFlightWatch = new Map<string, { promise: Promise<void>; queued: ExplorerWatchEvent | undefined }>();
  #model: ExplorerReadModel;
  #generation = 0;
  #selectedId: string | undefined;
  #filter = '';
  #includeHidden: boolean;
  #includeIgnored: boolean;
  #focused = false;
  #disposed = false;

  constructor(filesystem: ExplorerFilesystemPort, options: ExplorerOptions = {}) {
    this.#filesystem = filesystem;
    this.#metadata = options.metadata;
    this.#git = options.git;
    this.#followSymlinks = options.followSymlinks === true;
    this.#includeHidden = options.includeHidden === true;
    this.#includeIgnored = options.includeIgnored === true;
    this.#model = this.buildModel('ready', undefined);
  }

  get model(): ExplorerReadModel { return this.#model; }

  subscribe(listener: (model: ExplorerReadModel) => void): Disposable {
    if (this.#disposed) throw new Error('explorer-disposed');
    this.#listeners.add(listener);
    return Object.freeze({ dispose: () => { this.#listeners.delete(listener); } });
  }

  addRoot(root: ExplorerRoot): Result<string, ExplorerFailure> {
    if (this.#disposed) return failure('filesystem', root.path, 'explorer is disposed');
    const checked = validateRoot(root);
    if (!checked.ok) return checked;
    if (this.#rootPaths.has(root.id)) return failure('invalid-path', root.path, 'duplicate explorer root');
    const rootId = nodeIdentity(root.id, '');
    const node = makeNode({
      id: rootId,
      rootId: root.id,
      parentId: undefined,
      name: root.label,
      relativePath: '',
      path: root.path,
      kind: 'root',
      depth: 0,
      expanded: false,
      hidden: false,
      ignored: false,
      loadState: 'unloaded',
      stableIdentity: root.stableIdentity ?? `root:${root.id}`,
      sizeBytes: undefined,
      modifiedMilliseconds: undefined,
      symlinkTarget: undefined,
      git: undefined,
      message: undefined,
    });
    this.#rootPaths.set(root.id, Object.freeze({ ...root }));
    this.#roots.push(rootId);
    this.#nodes.set(rootId, node);
    this.#stableIds.set(stableKey(root.id, ''), rootId);
    this.publish('ready');
    return { ok: true, value: rootId };
  }

  removeRoot(rootId: string): boolean {
    const rootNodeId = nodeIdentity(rootId, '');
    if (!this.#nodes.has(rootNodeId)) return false;
    this.#watchers.get(rootId)?.dispose();
    this.#watchers.delete(rootId);
    this.removeSubtree(rootNodeId);
    const index = this.#roots.indexOf(rootNodeId);
    if (index >= 0) this.#roots.splice(index, 1);
    this.#rootPaths.delete(rootId);
    if (this.#selectedId === rootNodeId) this.#selectedId = this.#roots[0];
    this.publish(this.#roots.length === 0 ? 'empty' : 'ready');
    return true;
  }

  async watchRoot(rootId: string, cancellation?: CancellationToken): Promise<Result<void, ExplorerFailure>> {
    const root = this.#rootPaths.get(rootId);
    if (root === undefined) return failure('root-not-found', rootId, 'explorer root does not exist');
    this.#watchers.get(rootId)?.dispose();
    // A raw filesystem watcher can fire a burst of 'changed' notifications for
    // the same directory (e.g. a multi-file save or `git checkout`); each one
    // without an attached entry re-runs a full enumerateDirectory of the
    // parent. Coalesce those bursts per parent path into one re-enumeration
    // (and therefore one reconcile/publish) instead of one per raw event.
    const pendingRefresh = new Map<string, ExplorerWatchEvent>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => {
      flushTimer = undefined;
      const events = [...pendingRefresh.values()];
      pendingRefresh.clear();
      if (this.#disposed) return;
      for (const event of events) this.dispatchWatchEvent(event);
    };
    const watched = await this.#filesystem.watchDirectory(root.path, (event) => {
      if (this.#disposed) return;
      if (event.kind === 'changed' && event.entry === undefined) {
        pendingRefresh.set(`${event.rootId} ${event.relativePath}`, event);
        flushTimer ??= setTimeout(flush, 50);
        return;
      }
      this.dispatchWatchEvent(event);
    }, cancellation ?? neverCancelledToken);
    if (!watched.ok) return watched;
    this.#watchers.set(rootId, Object.freeze({
      dispose() {
        if (flushTimer !== undefined) clearTimeout(flushTimer);
        flushTimer = undefined;
        pendingRefresh.clear();
        watched.value.dispose();
      },
    }));
    return { ok: true, value: undefined };
  }

  async expand(nodeId: string, force = false, cancellation?: CancellationToken): Promise<Result<void, ExplorerFailure>> {
    const node = this.#nodes.get(nodeId);
    if (node === undefined) return failure('invalid-path', nodeId, 'tree node does not exist');
    if (!isExpandable(node)) return { ok: true, value: undefined };
    node.expanded = true;
    if (node.kind === 'symlink' && !this.#followSymlinks) {
      node.loadState = 'symlink-cycle';
      node.message = node.message ?? 'Symlink traversal is disabled';
      this.publish('error');
      return { ok: false, error: { kind: 'symlink-cycle', path: node.path, message: node.message } };
    }
    if (!force && (node.loadState === 'ready' || node.loadState === 'empty' || node.loadState === 'permission-denied' || node.loadState === 'symlink-cycle')) {
      this.publish(node.loadState === 'permission-denied' || node.loadState === 'symlink-cycle' ? 'error' : 'ready');
      return { ok: true, value: undefined };
    }
    const loadGeneration = (this.#loadGenerations.get(nodeId) ?? 0) + 1;
    this.#loadGenerations.set(nodeId, loadGeneration);
    node.loadState = 'loading';
    node.message = undefined;
    this.publish('loading');
    const result = await this.#filesystem.enumerateDirectory(node.path, cancellation ?? neverCancelledToken);
    if (this.#disposed || this.#loadGenerations.get(nodeId) !== loadGeneration) return { ok: false, error: { kind: 'cancelled', message: 'directory load was superseded' } };
    if (!result.ok) {
      node.children = [];
      node.loadState = result.error.kind === 'permission-denied' ? 'permission-denied' : result.error.kind === 'symlink-cycle' ? 'symlink-cycle' : 'error';
      node.message = explorerFailureMessage(result.error);
      this.publish('error');
      return result;
    }
    const reconciled = await this.reconcile(node, result.value, cancellation ?? neverCancelledToken);
    if (!reconciled.ok) return reconciled;
    node.loadState = node.children.length === 0 ? 'empty' : 'ready';
    this.publish(node.children.length === 0 ? 'empty' : 'ready');
    return { ok: true, value: undefined };
  }

  collapse(nodeId: string): boolean {
    const node = this.#nodes.get(nodeId);
    if (node === undefined || !isExpandable(node)) return false;
    node.expanded = false;
    this.publish('ready');
    return true;
  }

  async toggleExpanded(nodeId: string, cancellation?: CancellationToken): Promise<Result<void, ExplorerFailure>> {
    const node = this.#nodes.get(nodeId);
    if (node?.expanded === true) { this.collapse(nodeId); return { ok: true, value: undefined }; }
    return this.expand(nodeId, false, cancellation);
  }

  select(nodeId: string): boolean {
    if (!this.#nodes.has(nodeId) || !this.isVisible(nodeId)) return false;
    this.#selectedId = nodeId;
    this.publish('ready');
    return true;
  }

  focus(): void { this.#focused = true; this.publishFocusOnly(); }
  blur(): void { this.#focused = false; this.publishFocusOnly(); }

  /**
   * Focus/blur change no node data, selection or visibility -- only the
   * `focused` flag -- so this republishes the existing frozen `nodes` and
   * `visibleRows` instead of `publish()`'s full `buildModel()`, which
   * rebuilds and re-freezes every node in the tree (an unbounded, O(node
   * count) rebuild for what is otherwise a no-op event).
   */
  private publishFocusOnly(): void {
    this.#generation += 1;
    this.#model = Object.freeze({ ...this.#model, generation: this.#generation, focused: this.#focused });
    for (const listener of [...this.#listeners]) listener(this.#model);
  }

  setFilter(filter: string): void {
    this.#filter = filter.normalize('NFKC');
    this.#selectedId = this.retainSelectionOrFirst();
    this.publish(this.#roots.length === 0 ? 'empty' : 'ready');
  }

  setIncludeHidden(include: boolean): void {
    this.#includeHidden = include;
    this.#selectedId = this.retainSelectionOrFirst();
    this.publish('ready');
  }

  setIncludeIgnored(include: boolean): void {
    this.#includeIgnored = include;
    this.#selectedId = this.retainSelectionOrFirst();
    this.publish('ready');
  }

  moveSelection(delta: -1 | 1): boolean {
    const rows = this.#model.visibleRows;
    if (rows.length === 0) return false;
    const index = rows.findIndex((row) => row.nodeId === this.#selectedId);
    const nextIndex = index < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, index + delta));
    const next = rows[nextIndex];
    return next === undefined ? false : this.select(next.nodeId);
  }

  async reveal(rootId: string, relativePath: string, cancellation?: CancellationToken): Promise<Result<string, ExplorerFailure>> {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized.ok) return normalized;
    const rootNode = this.#nodes.get(nodeIdentity(rootId, ''));
    if (rootNode === undefined) return failure('root-not-found', rootId, 'explorer root does not exist');
    const parts = normalized.value === '' ? [] : normalized.value.split('/');
    let parent = rootNode;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part === undefined) continue;
      if (!parent.expanded || parent.loadState === 'unloaded' || parent.loadState === 'overflow' || parent.loadState === 'error') {
        const loaded = await this.expand(parent.id, true, cancellation);
        if (!loaded.ok) return loaded;
      }
      const child = parent.children
        .map((id) => this.#nodes.get(id))
        .find((candidate) => candidate?.name === part);
      if (child === undefined) return failure('invalid-path', normalized.value, `path component is not present: ${part}`);
      parent = child;
    }
    this.#selectedId = parent.id;
    this.publish('ready');
    return { ok: true, value: parent.id };
  }

  /**
   * Queues a watcher event for `applyWatchEvent`, serialized per affected parent directory.
   * The watcher callback is fire-and-forget by nature (it cannot await), so without this guard
   * two 'changed'/'created'/'removed' events for the same parent arriving close together could
   * each start their own `reconcile`/`publish` concurrently and interleave. At most one run per
   * parent key is active; an event arriving while one is active replaces any already-queued
   * event for that key (only the latest matters) and runs once the active one finishes.
   */
  private dispatchWatchEvent(event: ExplorerWatchEvent): void {
    if (this.#disposed) return;
    const key = watchEventKey(event);
    const existing = this.#inFlightWatch.get(key);
    if (existing !== undefined) {
      existing.queued = event;
      return;
    }
    const entry: { promise: Promise<void>; queued: ExplorerWatchEvent | undefined } = { promise: Promise.resolve(), queued: undefined };
    entry.promise = this.runWatchEventChain(key, entry, event);
    this.#inFlightWatch.set(key, entry);
  }

  private async runWatchEventChain(key: string, entry: { promise: Promise<void>; queued: ExplorerWatchEvent | undefined }, event: ExplorerWatchEvent): Promise<void> {
    await this.applyWatchEvent(event);
    const queued = entry.queued;
    if (queued === undefined) {
      if (this.#inFlightWatch.get(key) === entry) this.#inFlightWatch.delete(key);
      return;
    }
    entry.queued = undefined;
    await this.runWatchEventChain(key, entry, queued);
  }

  /** Apply a normalized watcher event; public for deterministic E03 fixtures. */
  async applyWatchEvent(event: ExplorerWatchEvent): Promise<void> {
    if (this.#disposed) return;
    const rootNode = this.#nodes.get(nodeIdentity(event.rootId, ''));
    if (rootNode === undefined) return;
    if (event.kind === 'overflow') {
      const parent = this.findParentForPath(event.rootId, event.relativePath);
      if (parent !== undefined) {
        parent.loadState = 'overflow';
        parent.message = 'Workspace changes exceeded the watcher buffer; refreshing…';
        this.publish('loading');
        await this.expand(parent.id, true);
      } else {
        rootNode.loadState = 'overflow';
        rootNode.message = 'Workspace changes exceeded the watcher buffer; expand to refresh';
        this.publish('error');
      }
      return;
    }
    if (event.kind === 'renamed') {
      const oldNode = this.findByPath(event.rootId, event.previousRelativePath);
      if (oldNode !== undefined) {
        const parent = oldNode.parentId === undefined ? undefined : this.#nodes.get(oldNode.parentId);
        if (parent !== undefined) {
          const nextName = basename(event.relativePath);
          const nextStable = event.entry?.stableIdentity ?? oldNode.stableIdentity;
          const nextId = this.#stableIds.get(stableKey(event.rootId, event.relativePath)) ?? oldNode.id;
          if (this.#stableIds.get(stableKey(event.rootId, event.previousRelativePath)) === oldNode.id) {
            this.#stableIds.delete(stableKey(event.rootId, event.previousRelativePath));
          }
          this.#stableIds.set(stableKey(event.rootId, event.relativePath), nextId);
          oldNode.name = nextName;
          oldNode.relativePath = event.relativePath;
          oldNode.path = this.joinRoot(event.rootId, event.relativePath);
          oldNode.stableIdentity = nextStable;
          if (nextId !== oldNode.id) this.renameNodeId(oldNode, nextId);
          this.publish('ready');
          return;
        }
      }
      await this.applyWatchEvent({ kind: 'created', rootId: event.rootId, relativePath: event.relativePath, ...(event.entry === undefined ? {} : { entry: event.entry }) });
      await this.applyWatchEvent({ kind: 'removed', rootId: event.rootId, relativePath: event.previousRelativePath });
      return;
    }
    const parent = this.findParentForPath(event.rootId, event.relativePath);
    if (parent === undefined) return;
    if (event.kind === 'removed') {
      const target = this.findByPath(event.rootId, event.relativePath);
      if (target !== undefined) {
        const selected = this.#selectedId === target.id;
        this.removeSubtree(target.id);
        if (selected) this.#selectedId = this.retainSelectionOrFirst(parent.id);
        this.publish('ready');
      }
      return;
    }
    if (event.entry !== undefined) {
      await this.reconcile(parent, [event.entry], neverCancelledToken, true);
      this.publish('ready');
      return;
    }
    if (parent.expanded) await this.expand(parent.id, true);
  }

  /** Move focus to a stable node and return its current path without scrolling. */
  readNode(nodeId: string): ExplorerNode | undefined {
    const node = this.#nodes.get(nodeId);
    return node === undefined ? undefined : freezeNode(node);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#decorationPublishTimer !== undefined) clearTimeout(this.#decorationPublishTimer);
    this.#decorationPublishTimer = undefined;
    for (const watcher of this.#watchers.values()) watcher.dispose();
    this.#watchers.clear();
    this.#inFlightWatch.clear();
    this.#listeners.clear();
    this.#nodes.clear();
    this.#roots.length = 0;
    this.#generation += 1;
    this.#model = this.buildModel('empty', 'Disposed');
  }

  private async reconcile(parent: MutableNode, entries: readonly ExplorerDirectoryEntry[], cancellation: CancellationToken, merge = false): Promise<Result<void, ExplorerFailure>> {
    const nextIds: string[] = merge ? [...parent.children] : [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (cancellation.isCancelled) return { ok: false, error: { kind: 'cancelled', message: 'directory enumeration cancelled' } };
      const normalized = normalizeRelativePath(entry.relativePath);
      if (!normalized.ok || normalized.value === '' || basename(normalized.value) !== entry.name) continue;
      const stable = entry.stableIdentity ?? stableKey(parent.rootId, normalized.value);
      const existingId = this.#stableIds.get(stableKey(parent.rootId, normalized.value)) ?? this.#stableIds.get(stable);
      const id = existingId ?? nodeIdentity(parent.rootId, normalized.value, stable);
      const existing = this.#nodes.get(id);
      const child = existing ?? makeNode({
        id,
        rootId: parent.rootId,
        parentId: parent.id,
        name: entry.name,
        relativePath: normalized.value,
        path: this.joinRoot(parent.rootId, normalized.value),
        kind: entry.kind,
        depth: parent.depth + 1,
        expanded: false,
        hidden: entry.hidden === true,
        ignored: entry.ignored === true,
        loadState: entry.symlinkCycle === true ? 'symlink-cycle' : 'unloaded',
        stableIdentity: stable,
        sizeBytes: entry.sizeBytes,
        modifiedMilliseconds: entry.modifiedMilliseconds,
        symlinkTarget: entry.symlinkTarget,
        git: entry.git,
        message: entry.symlinkCycle === true ? 'Symlink cycle detected' : undefined,
      });
      child.parentId = parent.id;
      child.name = entry.name;
      child.relativePath = normalized.value;
      child.path = this.joinRoot(parent.rootId, normalized.value);
      child.kind = entry.kind;
      child.hidden = entry.hidden === true;
      child.ignored = entry.ignored === true;
      child.stableIdentity = stable;
      child.sizeBytes = entry.sizeBytes;
      child.modifiedMilliseconds = entry.modifiedMilliseconds;
      child.symlinkTarget = entry.symlinkTarget;
      child.git = entry.git;
      if (entry.symlinkCycle === true) {
        child.loadState = 'symlink-cycle';
        child.message = 'Symlink cycle detected';
      }
      this.#nodes.set(id, child);
      this.#stableIds.set(stableKey(parent.rootId, normalized.value), id);
      this.#stableIds.set(stable, id);
      if (!seen.has(id)) nextIds.push(id);
      seen.add(id);
      if (this.#metadata !== undefined || this.#git !== undefined) void this.refreshDecoration(child);
    }
    if (!merge) {
      for (const oldId of parent.children) if (!seen.has(oldId)) this.removeSubtree(oldId);
    }
    parent.children = unique(nextIds).filter((id) => this.#nodes.has(id));
    parent.children.sort((leftId, rightId) => compareNodes(this.#nodes.get(leftId), this.#nodes.get(rightId)));
    return { ok: true, value: undefined };
  }

  /** Re-read Git decorations for every loaded node without touching load state or
   * re-enumerating directories (a forced `expand` would supersede in-flight loads and
   * break `reveal`). Publishes once, coalesced, when the reads settle. */
  redecorate(): void {
    if (this.#disposed || this.#git === undefined) return;
    for (const node of this.#nodes.values()) {
      if (node.kind !== 'root' && node.kind !== 'state') void this.refreshGitDecoration(node);
    }
  }

  private async refreshGitDecoration(node: MutableNode): Promise<void> {
    const result = await (this.#git as ExplorerGitDecorationPort).read(node.path, neverCancelledToken);
    if (result.ok && this.#nodes.has(node.id)) node.git = result.value;
    this.scheduleDecorationPublish();
  }

  private async refreshDecoration(node: MutableNode): Promise<void> {
    const token = neverCancelledToken;
    if (this.#metadata !== undefined) {
      const result = await this.#metadata.read(node.path, token);
      if (result.ok && this.#nodes.has(node.id)) {
        node.sizeBytes = result.value.sizeBytes;
        node.modifiedMilliseconds = result.value.modifiedMilliseconds;
        node.permissions = result.value.permissions;
      }
    }
    if (this.#git !== undefined) {
      const result = await this.#git.read(node.path, token);
      if (result.ok && this.#nodes.has(node.id)) node.git = result.value;
    }
    // A directory reconcile can kick off decoration reads for many children at
    // once; publishing per completion rebuilds (and copies) the whole frozen
    // node list once per child. Coalesce same-tick completions into one publish.
    this.scheduleDecorationPublish();
  }

  private scheduleDecorationPublish(): void {
    if (this.#disposed || this.#decorationPublishTimer !== undefined) return;
    this.#decorationPublishTimer = setTimeout(() => {
      this.#decorationPublishTimer = undefined;
      if (!this.#disposed) this.publish('ready');
    }, 0);
  }

  private findParentForPath(rootId: string, relativePath: string): MutableNode | undefined {
    const parentPath = dirname(relativePath);
    return this.findByPath(rootId, parentPath);
  }

  private findByPath(rootId: string, relativePath: string): MutableNode | undefined {
    const id = this.#stableIds.get(stableKey(rootId, relativePath));
    return id === undefined ? undefined : this.#nodes.get(id);
  }

  private removeSubtree(nodeId: string): void {
    const node = this.#nodes.get(nodeId);
    if (node === undefined) return;
    for (const child of [...node.children]) this.removeSubtree(child);
    if (node.parentId !== undefined) {
      const parent = this.#nodes.get(node.parentId);
      if (parent !== undefined) parent.children = parent.children.filter((id) => id !== nodeId);
    }
    this.#nodes.delete(nodeId);
    this.#loadGenerations.delete(nodeId);
    if (this.#stableIds.get(stableKey(node.rootId, node.relativePath)) === nodeId) {
      this.#stableIds.delete(stableKey(node.rootId, node.relativePath));
    }
    if (this.#stableIds.get(node.stableIdentity) === nodeId) this.#stableIds.delete(node.stableIdentity);
  }

  private renameNodeId(node: MutableNode, nextId: string): void {
    if (node.id === nextId) return;
    const oldId = node.id;
    node.id = nextId;
    this.#nodes.delete(oldId);
    this.#nodes.set(nextId, node);
    if (node.parentId !== undefined) {
      const parent = this.#nodes.get(node.parentId);
      if (parent !== undefined) parent.children = parent.children.map((id) => id === oldId ? nextId : id);
    }
    if (this.#selectedId === oldId) this.#selectedId = nextId;
  }

  private isVisible(nodeId: string): boolean { return this.#model.visibleRows.some((row) => row.nodeId === nodeId); }

  private joinRoot(rootId: string, relativePath: string): string {
    const root = this.#rootPaths.get(rootId)?.path;
    return root === undefined || relativePath.length === 0 ? (root ?? relativePath) : `${root.replace(/\/$/u, '')}/${relativePath}`;
  }

  private retainSelectionOrFirst(preferred?: string): string | undefined {
    if (preferred !== undefined && this.isVisible(preferred)) return preferred;
    if (this.#selectedId !== undefined && this.isVisible(this.#selectedId)) return this.#selectedId;
    return this.#model.visibleRows[0]?.nodeId;
  }

  private buildModel(state: ExplorerReadModel['state'], message: string | undefined): ExplorerReadModel {
    const nodes = [...this.#nodes.values()].map(freezeNode);
    const visibleRows: ExplorerVisibleRow[] = [];
    for (const rootId of this.#roots) this.appendVisible(rootId, visibleRows);
    return Object.freeze({
      contractVersion: EXPLORER_CONTRACT_VERSION,
      generation: this.#generation,
      roots: Object.freeze([...this.#roots]),
      nodes: Object.freeze(nodes),
      visibleRows: Object.freeze(visibleRows),
      selectedId: this.#selectedId,
      filter: this.#filter,
      includeHidden: this.#includeHidden,
      includeIgnored: this.#includeIgnored,
      focused: this.#focused,
      state,
      message,
    });
  }

  private appendVisible(nodeId: string, rows: ExplorerVisibleRow[]): boolean {
    const node = this.#nodes.get(nodeId);
    if (node === undefined || !this.matchesPolicy(node)) return false;
    const descendants = node.children.some((childId) => this.hasMatchingDescendant(childId));
    const matches = this.matchesFilter(node);
    if (this.#filter.length > 0 && !matches && !descendants) return false;
    rows.push(Object.freeze({ nodeId, depth: node.depth, kind: node.kind, selected: node.id === this.#selectedId }));
    if (node.expanded) for (const childId of node.children) this.appendVisible(childId, rows);
    return true;
  }

  private hasMatchingDescendant(nodeId: string): boolean {
    const node = this.#nodes.get(nodeId);
    if (node === undefined || !this.matchesPolicy(node)) return false;
    return this.matchesFilter(node) || node.children.some((childId) => this.hasMatchingDescendant(childId));
  }

  private matchesPolicy(node: MutableNode): boolean {
    return this.#includeHidden || !node.hidden ? this.#includeIgnored || !node.ignored : false;
  }

  private matchesFilter(node: MutableNode): boolean {
    return this.#filter.length === 0 || normalizeSearch(node.name).includes(normalizeSearch(this.#filter)) || normalizeSearch(node.relativePath).includes(normalizeSearch(this.#filter));
  }

  private publish(state: ExplorerReadModel['state'], message?: string): void {
    this.#generation += 1;
    this.#model = this.buildModel(state, message);
    this.#selectedId = this.retainSelectionOrFirst();
    if (this.#model.selectedId !== this.#selectedId) this.#model = this.buildModel(state, message);
    for (const listener of [...this.#listeners]) listener(this.#model);
  }
}

export interface ExplorerNavigationControllerOptions {
  readonly tree: ExplorerTree;
  readonly onOpen?: (node: ExplorerNode) => void | Promise<void>;
}

/** Keyboard/panel policy kept beside the tree service, not in a render callback. */
export class ExplorerNavigationController implements Disposable {
  readonly #tree: ExplorerTree;
  readonly #onOpen: ((node: ExplorerNode) => void | Promise<void>) | undefined;
  #disposed = false;

  constructor(options: ExplorerNavigationControllerOptions) {
    this.#tree = options.tree;
    this.#onOpen = options.onOpen;
  }

  async handle(action: 'up' | 'down' | 'left' | 'right' | 'toggle' | 'open' | 'filter-clear' | 'first' | 'last'): Promise<boolean> {
    if (this.#disposed) return false;
    const selected = this.#tree.model.selectedId === undefined ? undefined : this.#tree.readNode(this.#tree.model.selectedId);
    if (action === 'up') return this.#tree.moveSelection(-1);
    if (action === 'down') return this.#tree.moveSelection(1);
    if (action === 'first' || action === 'last') {
      const rows = this.#tree.model.visibleRows;
      const row = action === 'first' ? rows[0] : rows[rows.length - 1];
      return row === undefined ? false : this.#tree.select(row.nodeId);
    }
    if (action === 'filter-clear') { this.#tree.setFilter(''); return true; }
    if (selected === undefined) return false;
    if (action === 'left') {
      if (selected.expanded) return this.#tree.collapse(selected.id);
      return selected.parentId === undefined ? false : this.#tree.select(selected.parentId);
    }
    if (action === 'right') return (await this.#tree.expand(selected.id)).ok;
    if (action === 'toggle') return (await this.#tree.toggleExpanded(selected.id)).ok;
    if (action === 'open') {
      if (selected.kind === 'directory' || selected.kind === 'root') return (await this.#tree.toggleExpanded(selected.id)).ok;
      await this.#onOpen?.(selected);
      return true;
    }
    return false;
  }

  dispose(): void { this.#disposed = true; }
}

function makeNode(input: Omit<MutableNode, 'permissions' | 'children'> & { readonly permissions?: string; readonly children?: readonly string[] }): MutableNode {
  return {
    ...input,
    permissions: input.permissions,
    children: [...(input.children ?? [])],
  };
}

function freezeNode(node: MutableNode): ExplorerNode {
  return Object.freeze({ ...node, children: Object.freeze([...node.children]) });
}

function validateRoot(root: ExplorerRoot): Result<void, ExplorerFailure> {
  if (root.id.length === 0 || root.id.includes('\u0000') || root.label.length === 0 || root.path.length === 0 || root.path.includes('\u0000')) return failure('invalid-path', root.path, 'root id, label and path must be nonempty and NUL-free');
  return { ok: true, value: undefined };
}

function normalizeRelativePath(path: string): Result<string, ExplorerFailure> {
  const value = path.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/{2,}/gu, '/');
  if (value === '' || value === '.') return { ok: true, value: '' };
  if (value.startsWith('/') || value.includes('\u0000') || value.split('/').some((part) => part === '..' || part === '')) return failure('invalid-path', path, 'relative path escapes its workspace root');
  return { ok: true, value };
}

function nodeIdentity(rootId: string, relativePath: string, stableIdentity?: string): string { return `explorer:${rootId}\u0000${stableIdentity ?? relativePath}`; }
function stableKey(rootId: string, relativePath: string): string { return `${rootId}\u0000${relativePath}`; }
function basename(path: string): string { const parts = path.split('/'); return parts[parts.length - 1] ?? ''; }

function parentDirectory(relativePath: string): string {
  const index = relativePath.lastIndexOf('/');
  return index === -1 ? '' : relativePath.slice(0, index);
}

/** Groups a watcher event by the parent directory it will reconcile, so overlapping events for
 * the same directory serialize through the in-flight guard above. */
function watchEventKey(event: ExplorerWatchEvent): string {
  const relativePath = event.kind === 'renamed' ? event.previousRelativePath : event.relativePath;
  return `${event.rootId}\0${parentDirectory(relativePath)}`;
}
function dirname(path: string): string { const index = path.lastIndexOf('/'); return index < 0 ? '' : path.slice(0, index); }
function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
function normalizeSearch(value: string): string { return value.normalize('NFKC').toLocaleLowerCase('en-US'); }
function compareNodes(left: MutableNode | undefined, right: MutableNode | undefined): number {
  if (left === undefined || right === undefined) return left === right ? 0 : left === undefined ? 1 : -1;
  const leftDirectory = left.kind === 'directory' || left.kind === 'root';
  const rightDirectory = right.kind === 'directory' || right.kind === 'root';
  return Number(rightDirectory) - Number(leftDirectory) || normalizeSearch(left.name).localeCompare(normalizeSearch(right.name), 'en-US') || left.id.localeCompare(right.id, 'en-US');
}
function isExpandable(node: MutableNode): boolean { return node.kind === 'root' || node.kind === 'directory' || node.kind === 'symlink'; }
function explorerFailureMessage(error: ExplorerFailure): string {
  switch (error.kind) {
    case 'root-not-found': return `Explorer root ${error.rootId} does not exist`;
    case 'invalid-path':
    case 'cancelled':
    case 'permission-denied':
    case 'symlink-cycle':
    case 'watch-overflow':
    case 'filesystem': return error.message;
  }
}
function failure(kind: ExplorerFailure['kind'], path: string, message: string): Result<never, ExplorerFailure> {
  if (kind === 'root-not-found') return { ok: false, error: { kind, rootId: path, message } } as Result<never, ExplorerFailure>;
  if (kind === 'invalid-path') return { ok: false, error: { kind, message } };
  if (kind === 'permission-denied') return { ok: false, error: { kind, path, message } };
  if (kind === 'symlink-cycle') return { ok: false, error: { kind, path, message } };
  if (kind === 'watch-overflow') return { ok: false, error: { kind, path, message } };
  if (kind === 'cancelled') return { ok: false, error: { kind, message } };
  return { ok: false, error: { kind: 'filesystem', path, message } };
}

const neverCancelledToken: CancellationToken = Object.freeze({ isCancelled: false, onCancel: () => Object.freeze({ dispose() {} }) });

export {
  DIRECTORY_DRAFT_CONTRACT_VERSION,
  DirectoryDraft,
  createDirectoryDraft,
  decodeDirectoryName,
  escapeDirectoryName,
} from './directory-draft';
export type {
  DirectoryDraftAnchor,
  DirectoryDraftEntryKind,
  DirectoryDraftError,
  DirectoryDraftMetadata,
  DirectoryDraftOptions,
  DirectoryDraftReadModel,
  DirectoryDraftReadPort,
  DirectoryDraftRow,
  DirectoryDraftRowOrigin,
  DirectoryDraftSourceEntry,
  DirectoryDraftValidationFailure,
  DirectoryOperation,
  DirectoryOperationPlan,
  DirectoryYankBuffer,
} from './directory-draft';
export {
  FILE_OPERATION_CONTRACT_VERSION,
  JournaledFilesystemOperations,
  decodeFileOperationJournal,
} from './journaled-operations';
export type {
  FileFingerprint,
  FileOperationFailure,
  FileOperationHooks,
  FileOperationJournal,
  FileOperationResult,
  FileOperationRecoveryResult,
  FileOperationStep,
  JournaledFileOperationOptions,
  JournaledFilesystemPort,
} from './journaled-operations';
