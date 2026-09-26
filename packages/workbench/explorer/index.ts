import type { ExplorerDirectoryOperationPlan } from './operations';
import { CancellationSource, type CancellationToken, type ClockPort, type Disposable, type DocumentId, type PlatformFailure, type Result, type ViewId } from '../../contracts/src/index';
import type { OwnedVimKeyEvent } from '../vim-session';
import type { BufferHost } from '../host';
import type { ExplorerBufferController } from './buffer';

export type { OwnedVimKeyEvent as ExplorerKeyEvent };

/** Mirrors `packages/services/files`'s `ExplorerNode` shape structurally -- workbench cannot
 * import `packages/services`, not even types, so only the fields this controller actually
 * reads are declared here. */
export type ExplorerTreeNodeKind = 'root' | 'directory' | 'file' | 'symlink' | 'other' | 'state';

export interface ExplorerTreeNode {
  readonly id: string;
  readonly kind: ExplorerTreeNodeKind;
  readonly name: string;
  readonly path: string;
  readonly relativePath: string;
  readonly expanded: boolean;
  readonly children?: readonly string[];
  readonly parentId?: string | undefined;
}

export interface ExplorerTreeModel {
  readonly generation: number;
  readonly roots: readonly string[];
  readonly selectedId: string | undefined;
  readonly filter: string;
  readonly includeHidden?: boolean;
  readonly includeIgnored?: boolean;
  readonly state: string;
  readonly visibleRows: readonly { readonly nodeId: string }[];
}

/** Narrow port onto `packages/services/files`'s `ExplorerTree`: only the members `main()`
 * used to call, kept structural so workbench never imports the services package. */
export interface ExplorerTreePort {
  readonly model: ExplorerTreeModel;
  subscribe(listener: (model: ExplorerTreeModel) => void): Disposable;
  focus(): void;
  blur(): void;
  setFilter(filter: string): void;
  setIncludeHidden?(include: boolean): void;
  setIncludeIgnored?(include: boolean): void;
  expand(nodeId: string, force: boolean, cancellation: CancellationToken): Promise<unknown>;
  watchRoot(rootId: string, cancellation: CancellationToken): Promise<unknown>;
  reveal(rootId: string, relativePath: string, cancellation: CancellationToken): Promise<unknown>;
  readNode(nodeId: string): ExplorerTreeNode | undefined;
  select(nodeId: string): boolean;
}

/** Narrow port onto `packages/services/files`'s `ExplorerNavigationController`. */
export interface ExplorerNavigationPort {
  handle(action: 'up' | 'down' | 'left' | 'right' | 'toggle' | 'open' | 'filter-clear' | 'first' | 'last'): Promise<boolean>;
  dispose(): void;
}

/** Narrow port onto the workbench session's buffer bookkeeping: rename-on-disk needs every
 * open buffer's display path kept in step, and delete needs to refuse when an unsaved buffer
 * is still open under the deleted path. */
export interface ExplorerSessionPort {
  readonly activeViewId: ViewId | undefined;
  views(): readonly { readonly viewId: ViewId; readonly bufferId: DocumentId }[];
  buffer(bufferId: DocumentId): { readonly path: string | undefined } | undefined;
  buffers(): readonly { readonly bufferId: DocumentId; readonly path: string | undefined; readonly dirty: boolean }[];
  renameBufferPath(bufferId: DocumentId, path: string): unknown;
}

/** Narrow port onto the platform filesystem adapter's mutating operations (rename/copy/delete
 * and the trash directory's `stat`/`makeDirectory` checks); reading/watching stays inside the
 * services-owned `ExplorerTree`. */
export interface ExplorerFileOperationsPort {
  stat(path: string, cancellation: CancellationToken): Promise<Result<unknown, PlatformFailure>>;
  renamePath(from: string, to: string, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
  copyPath(from: string, to: string, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
  removePath(path: string, recursive: boolean, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
  makeDirectory(path: string, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
  writeFileAtomic(path: string, contents: Uint8Array, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
  createFileExclusive(path: string, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
  isWithinRealWorkspace(root: string, path: string, cancellation: CancellationToken): Promise<Result<boolean, PlatformFailure>>;
}

export type { ExplorerDirectoryOperation, ExplorerDirectoryOperationPlan } from './operations';
/** Narrow port onto `packages/services/files`'s `JournaledFilesystemOperations`: the
 * durable, crash-recoverable move/copy/trash executor already used by
 * `packages/workbench/directory` and `main.ts`, so explorer file operations get the same
 * journal-before-disk-step guarantee instead of a private undo log. */
export interface ExplorerJournaledOperationsPort {
  apply(plan: ExplorerDirectoryOperationPlan, cancellation: CancellationToken): Promise<Result<{ readonly journal: unknown }, { readonly kind: string; readonly message?: string }>>;
  restoreApplied(journal: unknown, cancellation: CancellationToken): Promise<Result<unknown, { readonly kind: string; readonly message?: string }>>;
}

export interface ExplorerControllerOptions {
  readonly editing?: ExplorerBufferController;
  readonly host: BufferHost;
  readonly session: ExplorerSessionPort;
  readonly filesystem: ExplorerFileOperationsPort;
  readonly fileOperations: ExplorerJournaledOperationsPort;
  readonly clock: ClockPort;
  readonly marker: (name: string, payload?: unknown) => void;
  /** PTY-visible stderr sink; never writes to `process.stderr` itself. */
  readonly onError: (message: string) => void;
  readonly workspaceRelativePath: (path: string) => string | undefined;
  readonly trashDirectory: string;
  /** Lazily constructs the services-owned `ExplorerTree`/`ExplorerNavigationController`
   * (composition-root work, never duplicated here) and resolves once `attachTree` has run. */
  readonly ensureServices: () => Promise<void>;
  /** Runs once the tree is bound and the panel is opening (e.g. expand the sidebar's Files section). */
  readonly onOpen?: () => void;
  readonly isPanelSelected?: () => boolean;
  /** `zc` on the tree: collapse the sidebar's Files section (focus returns to the editor). */
  readonly onCollapse?: () => void;
  /** Tab on the tree: move keyboard focus to the Outline section. */
  readonly focusOutline?: () => void;
}

interface ExplorerDraft {
  readonly nodeId: string;
  readonly text: string;
  readonly generation: number;
}

const EMPTY_VISUAL_IDS: readonly string[] = Object.freeze([]);

/**
 * Owns the Explorer panel's state and key handling: open/filtering/pending-`g`/rename-copy-
 * delete drafts and the in-memory undo journal. Moved out of `apps/xi/src/main.ts`'s `main()`
 * closure; the tree's data (`ExplorerTree`) and its navigation controller still live in
 * `packages/services/files` and are only ever reached through `ExplorerTreePort` /
 * `ExplorerNavigationPort`, bound once by `attachTree` after the composition root constructs
 * them (they are loaded lazily, on first use of any panel).
 */
export class ExplorerController {
  #editingReady: Promise<void> | undefined;
  #open = false;
  #visible = false;
  #loadError: string | undefined;
  #filtering = false;
  #pendingG = false;
  #pendingGTimer: Disposable | undefined;
  #openGeneration = 0;
  #renameDraft: ExplorerDraft | undefined;
  #copyDraft: ExplorerDraft | undefined;
  #createDraft: { readonly parentPath: string; readonly text: string; readonly generation: number; readonly directory: boolean } | undefined;
  #moveDraft: ExplorerDraft | undefined;
  #pendingCtrlW = false;
  #pendingZ = false;
  #deleteConfirm: { readonly nodeIds: readonly string[]; readonly generation: number } | undefined;
  #visualAnchorId: string | undefined;
  #fileClipboard: { readonly nodeId: string; readonly path: string; readonly name: string; readonly cut: boolean } | undefined;
  readonly #undoJournal: { readonly kind: 'rename' | 'copy' | 'delete'; readonly from: string; readonly to: string; readonly journal: unknown }[] = [];
  #tree: ExplorerTreePort | undefined;
  #navigation: ExplorerNavigationPort | undefined;
  readonly #cancellation = new CancellationSource();
  readonly #options: ExplorerControllerOptions;

  constructor(options: ExplorerControllerOptions) {
    this.#options = options;
  }

  #ensureEditing(): Promise<void> {
    if (this.#options.editing === undefined || this.#options.editing.active) return Promise.resolve();
    this.#editingReady ??= (async () => {
      const rootId = this.#tree?.model.roots[0];
      const root = rootId === undefined ? undefined : this.#tree?.readNode(rootId);
      const view = this.#options.session.views().find((value) => value.viewId === this.#options.session.activeViewId);
      const path = view === undefined ? undefined : this.#options.session.buffer(view.bufferId)?.path;
      if (root !== undefined) await this.#options.editing?.open(path === undefined || !path.startsWith(`${root.path}/`) ? root.path : path.slice(0, path.lastIndexOf('/')), path);
    })().finally(() => { this.#editingReady = undefined; });
    return this.#editingReady;
  }

  get editing(): ExplorerBufferController | undefined { return this.#options.editing?.active === true ? this.#options.editing : undefined; }

  get isOpen(): boolean { return this.#open; }
  get isVisible(): boolean { return this.#visible; }
  toggleIncludeHidden(): void { if (this.#tree?.setIncludeHidden !== undefined) this.#tree.setIncludeHidden(!(this.#tree.model.includeHidden ?? false)); }
  toggleIncludeIgnored(): void { if (this.#tree?.setIncludeIgnored !== undefined) this.#tree.setIncludeIgnored(!(this.#tree.model.includeIgnored ?? false)); }
  get loadError(): string | undefined { return this.#loadError; }
  get visualSelectionIds(): readonly string[] {
    const rows = this.#tree?.model.visibleRows;
    const anchor = this.#visualAnchorId;
    const current = this.#tree?.model.selectedId;
    if (rows === undefined || anchor === undefined || current === undefined) return EMPTY_VISUAL_IDS;
    const from = rows.findIndex((row) => row.nodeId === anchor);
    const to = rows.findIndex((row) => row.nodeId === current);
    return from < 0 || to < 0 ? EMPTY_VISUAL_IDS : rows.slice(Math.min(from, to), Math.max(from, to) + 1).map((row) => row.nodeId);
  }
  /** True while a filter/rename/copy/delete prompt owns typed characters, so `:` must stay here. */
  get capturesTextInput(): boolean { return this.editing !== undefined || this.#filtering || this.#renameDraft !== undefined || this.#copyDraft !== undefined || this.#moveDraft !== undefined || this.#createDraft !== undefined || this.#deleteConfirm !== undefined; }
  /** The in-progress rename/copy/create/delete prompt, painted on the panel's footer row. */
  get promptText(): string | undefined {
    if (this.#renameDraft !== undefined) return `Rename: ${this.#renameDraft.text}`;
    if (this.#copyDraft !== undefined) return `Copy as sibling name: ${this.#copyDraft.text}`;
    if (this.#moveDraft !== undefined) return `Move to (workspace path): ${this.#moveDraft.text}`;
    if (this.#createDraft !== undefined) return `New ${this.#createDraft.directory ? 'folder' : 'file'}: ${this.#createDraft.text}`;
    if (this.#deleteConfirm !== undefined) return this.#deleteConfirm.nodeIds.length === 1
      ? `Move ${this.#tree?.readNode(this.#deleteConfirm.nodeIds[0] ?? '')?.name ?? 'entry'} to trash? y/n`
      : `Move ${this.#deleteConfirm.nodeIds.length} entries to trash? y/n`;
    if (this.#visualAnchorId !== undefined) return `VISUAL · ${this.visualSelectionIds.length} rows`;
    return undefined;
  }

  /** Binds the lazily-constructed tree/navigation controller once the composition root has
   * created them, and starts forwarding tree refreshes as `XI_EXPLORER_REFRESH` markers.
   * Returns the subscription so the caller retains teardown ordering. */
  attachTree(tree: ExplorerTreePort, navigation: ExplorerNavigationPort): Disposable {
    this.#tree = tree;
    this.#navigation = navigation;
    this.#openGeneration = tree.model.generation;
    return tree.subscribe((model) => {
      this.#options.host.notifySurfaceChange();
      if (this.#open && model.generation > this.#openGeneration) {
        const selected = model.selectedId === undefined ? undefined : tree.readNode(model.selectedId);
        const explorerModel = model as ExplorerTreeModel & { readonly includeHidden?: boolean; readonly followSymlinks?: boolean; readonly flattenDirs?: boolean };
        this.#options.marker('XI_EXPLORER_REFRESH', { generation: model.generation, selectedId: model.selectedId, selectedPath: selected?.relativePath, state: model.state, filter: model.filter, visibleRowCount: model.visibleRows.length, visibleLabels: model.visibleRows.map((rawRow) => { const row = rawRow as { readonly nodeId: string; readonly label?: string }; const node = tree.readNode(row.nodeId); return row.label ?? node?.name; }).filter((label): label is string => label !== undefined), ...(explorerModel.includeHidden === undefined ? {} : { includeHidden: explorerModel.includeHidden }), ...(explorerModel.includeIgnored === undefined ? {} : { includeIgnored: explorerModel.includeIgnored }), ...(explorerModel.followSymlinks === undefined ? {} : { followSymlinks: explorerModel.followSymlinks }), ...(explorerModel.flattenDirs === undefined ? {} : { flattenDirs: explorerModel.flattenDirs }) });
      }
    });
  }

  /** Loads and shows the tree in the sidebar without taking keyboard focus (startup default). */
  show(): void {
    this.#visible = true;
    this.#loadError = undefined;
    this.#options.onOpen?.();
    this.#options.host.notifySurfaceChange();
    if (this.#tree === undefined) {
      void this.#options.ensureServices().then(() => { if (this.#visible && !this.#open && this.#options.isPanelSelected?.() !== false) this.#showTree(); }).catch((error: unknown) => {
        this.#loadError = `xi: explorer failed to load: ${error instanceof Error ? error.message : String(error)}`;
        this.#options.onError(`${this.#loadError}\n`);
        this.#options.host.notifySurfaceChange();
      });
      return;
    }
    this.#showTree();
  }

  #showTree(): void {
    const tree = this.#tree;
    if (tree === undefined) return;
    const rootId = tree.model.roots[0];
    const root = rootId === undefined ? undefined : tree.readNode(rootId);
    if (rootId !== undefined && root !== undefined && !root.expanded) {
      void tree.expand(rootId, false, this.#cancellation.token);
      void tree.watchRoot('workspace', this.#cancellation.token);
    }
    this.#options.host.notifySurfaceChange();
  }

  open(): void {
    this.#options.host.closeAllPanels('explorer');
    this.#open = true;
    this.#visible = true;
    if (this.#tree === undefined) {
      void this.#options.ensureServices().then(() => { if (this.#open) this.open(); }).catch((error: unknown) => {
        this.#open = false;
        this.#visible = false;
        this.#options.onError(`xi: explorer failed to load: ${error instanceof Error ? error.message : String(error)}\n`);
      });
      return;
    }
    this.#filtering = false;
    this.#clearPendingG();
    this.#options.onOpen?.();
    const tree = this.#tree;
    this.#openGeneration = tree.model.generation;
    tree.focus();
    const root = tree.model.roots[0];
    if (root !== undefined) {
      // Sequenced, not fired concurrently: reveal() only re-expands a node whose
      // `expanded`/`loadState` looks incomplete, and expand()'s own synchronous state
      // mutation (before its first await) makes a still-in-flight concurrent expand of
      // the same node look "already expanded" to reveal() -- which then reads the root's
      // (still-empty) children before this expand's own directory listing resolves.
      void tree.expand(root, false, this.#cancellation.token).then(() => {
        if (!this.#open) return;
        const activeViewId = this.#options.session.activeViewId;
        const activeView = activeViewId === undefined ? undefined : this.#options.session.views().find((view) => view.viewId === activeViewId);
        const activeBuffer = activeView === undefined ? undefined : this.#options.session.buffer(activeView.bufferId);
        const activeRelativePath = activeBuffer?.path === undefined ? undefined : this.#options.workspaceRelativePath(activeBuffer.path);
        if (activeRelativePath !== undefined) void tree.reveal('workspace', activeRelativePath, this.#cancellation.token);
      });
      void tree.watchRoot('workspace', this.#cancellation.token);
    }
    void this.#ensureEditing().catch((error: unknown) => this.#options.onError(`xi: Files could not open: ${String(error)}\n`));
    this.#options.marker('XI_EXPLORER_OPEN', { selectedId: tree.model.selectedId });
  }

  close(): void {
    this.#open = false;
    this.#filtering = false;
    this.#createDraft = undefined;
    this.#visualAnchorId = undefined;
    this.#pendingCtrlW = false;
    this.#pendingZ = false;
    this.#clearPendingG();
    this.#tree?.blur();
  }

  /** Explicitly collapses the Files section. Losing keyboard focus only calls `close()` so
   * the tree remains visible beside the editor. */
  hide(): void {
    this.#visible = false;
    this.close();
    this.#options.host.notifySurfaceChange();
  }

  async handleKeypress(event: OwnedVimKeyEvent): Promise<boolean> {
    if (this.#tree === undefined || this.#navigation === undefined) {
      await this.#options.ensureServices();
      return this.#tree === undefined || this.#navigation === undefined ? true : this.handleKeypress(event);
    }
    const tree = this.#tree;
    const navigation = this.#navigation;
    const key = event.name.toLowerCase();
    if (this.#options.editing !== undefined) {
      await this.#ensureEditing();
      if (await this.#options.editing.handleKey(event) === 'close') this.close();
      return true;
    }
    if (this.#deleteConfirm !== undefined) {
      const confirmed = key === 'y' || key === 'd';
      const nodeIds = this.#deleteConfirm.nodeIds;
      const generation = this.#deleteConfirm.generation;
      this.#deleteConfirm = undefined;
      if (confirmed) await this.#applyDelete(nodeIds, generation);
      return true;
    }
    if (this.#createDraft !== undefined) {
      const draft = this.#createDraft;
      if (key === 'escape' || event.raw === '') { this.#createDraft = undefined; return true; }
      if (key === 'enter' || key === 'return' || event.raw === '\r' || event.raw === '\n') {
        this.#createDraft = undefined;
        await this.#applyCreate(draft.parentPath, draft.text, draft.directory, draft.generation);
        return true;
      }
      if (key === 'backspace' || key === 'backspace2' || event.raw === '') { this.#createDraft = { ...draft, text: draft.text.slice(0, -1) }; return true; }
      if (!event.ctrl && !event.meta && !event.option && event.raw.length === 1 && event.raw >= ' ' && event.raw !== '') this.#createDraft = { ...draft, text: `${draft.text}${event.raw}` };
      return true;
    }
    if (this.#renameDraft !== undefined || this.#copyDraft !== undefined || this.#moveDraft !== undefined) {
      const isCopy = this.#copyDraft !== undefined;
      const isMove = this.#moveDraft !== undefined;
      const draft = isCopy ? this.#copyDraft : isMove ? this.#moveDraft : this.#renameDraft;
      if (draft === undefined) return true;
      if (key === 'escape' || event.raw === '') {
        this.#renameDraft = undefined;
        this.#copyDraft = undefined;
        this.#moveDraft = undefined;
        return true;
      }
      if (key === 'enter' || key === 'return' || event.raw === '\r' || event.raw === '\n') {
        this.#renameDraft = undefined;
        this.#copyDraft = undefined;
        this.#moveDraft = undefined;
        if (isCopy) await this.#applyCopy(draft.nodeId, draft.text, draft.generation);
        else if (isMove) await this.#applyMove(draft.nodeId, draft.text, draft.generation);
        else await this.#applyRename(draft.nodeId, draft.text, draft.generation);
        return true;
      }
      if (key === 'backspace' || key === 'backspace2' || event.raw === '') {
        const next = { ...draft, text: draft.text.slice(0, -1) };
        if (isCopy) this.#copyDraft = next; else if (isMove) this.#moveDraft = next; else this.#renameDraft = next;
        return true;
      }
      if (!event.ctrl && !event.meta && !event.option && event.raw.length === 1 && event.raw >= ' ' && event.raw !== '') {
        const next = { ...draft, text: `${draft.text}${event.raw}` };
        if (isCopy) this.#copyDraft = next; else if (isMove) this.#moveDraft = next; else this.#renameDraft = next;
      }
      return true;
    }
    if (key === 'escape' || event.raw === '') {
      if (this.#visualAnchorId !== undefined) {
        this.#visualAnchorId = undefined;
        this.#options.host.notifySurfaceChange();
      } else if (this.#filtering || tree.model.filter.length > 0) {
        this.#filtering = false;
        tree.setFilter('');
      } else {
        this.close();
      }
      return true;
    }
    if (this.#filtering) {
      if (key === 'backspace' || key === 'backspace2' || event.raw === '') {
        tree.setFilter(tree.model.filter.slice(0, -1));
        return true;
      }
      if (key === 'enter' || key === 'return' || event.raw === '\r' || event.raw === '\n') {
        this.#filtering = false;
        await navigation.handle('open');
        return true;
      }
      if (!event.ctrl && !event.meta && !event.option && event.raw.length === 1 && event.raw >= ' ' && event.raw !== '') {
        tree.setFilter(`${tree.model.filter}${event.raw}`);
      }
      return true;
    }
    if (key === 'v' && !event.ctrl && !event.meta && !event.option) {
      this.#visualAnchorId = this.#visualAnchorId === undefined ? tree.model.selectedId : undefined;
      this.#options.host.notifySurfaceChange();
      return true;
    }
    if (this.#visualAnchorId !== undefined && (key === 'x' || key === 'd') && !event.ctrl && !event.meta && !event.option) {
      const ids = this.visualSelectionIds;
      this.#visualAnchorId = undefined;
      this.#options.host.notifySurfaceChange();
      if (ids.length > 0) await this.#applyDelete(ids, tree.model.generation);
      return true;
    }
    if (key === '/' || event.raw === '/') {
      this.#filtering = true;
      tree.setFilter('');
      return true;
    }
    if (event.ctrl && key === 'd') {
      for (let index = 0; index < 5; index += 1) await navigation.handle('down');
      return true;
    }
    if (event.ctrl && key === 'u') {
      for (let index = 0; index < 5; index += 1) await navigation.handle('up');
      return true;
    }
    if (key === 'g' && !event.shift) {
      if (this.#pendingG) {
        this.#clearPendingG();
        await navigation.handle('first');
      } else {
        this.#pendingG = true;
        this.#pendingGTimer = this.#options.clock.schedule(500, () => { this.#pendingG = false; this.#pendingGTimer = undefined; });
      }
      return true;
    }
    if (event.shift && key === 'g') {
      this.#clearPendingG();
      await navigation.handle('last');
      return true;
    }
    // Ctrl-W + w/h/j/k/l/p: back to the editor, like leaving a Vim window.
    if (this.#pendingCtrlW) { this.#pendingCtrlW = false; if ('whjklp'.includes(key)) this.close(); return true; }
    if (event.ctrl && key === 'w') { this.#pendingCtrlW = true; return true; }
    // Tab: hand focus to the Outline section; zc/zo/za: collapse/expand/toggle the Files section.
    if (key === 'tab' || event.raw === '\t') { this.#options.focusOutline?.(); return true; }
    if (this.#pendingZ) {
      this.#pendingZ = false;
      if (key === 'c' || key === 'a') { this.close(); this.#options.onCollapse?.(); this.#options.host.notifySurfaceChange(); }
      return true;
    }
    if (key === 'z' && !event.ctrl && !event.meta && !event.shift) { this.#pendingZ = true; return true; }
    if (key === 'a' && !event.ctrl && !event.meta) {
      const node = tree.model.selectedId === undefined ? undefined : tree.readNode(tree.model.selectedId);
      const rootId = tree.model.roots[0];
      const parentPath = node === undefined ? (rootId === undefined ? undefined : tree.readNode(rootId)?.path) : node.kind === 'file' ? node.path.slice(0, node.path.length - node.name.length).replace(/\/$/u, '') : node.path;
      if (parentPath !== undefined) this.#createDraft = { parentPath, text: '', generation: tree.model.generation, directory: false };
      return true;
    }
    if (event.shift && key === 'a') {
      const node = tree.model.selectedId === undefined ? undefined : tree.readNode(tree.model.selectedId);
      const rootId = tree.model.roots[0];
      const parentPath = node === undefined ? (rootId === undefined ? undefined : tree.readNode(rootId)?.path) : node.kind === 'file' ? node.path.slice(0, node.path.length - node.name.length).replace(/\/$/u, '') : node.path;
      if (parentPath !== undefined) this.#createDraft = { parentPath, text: '', generation: tree.model.generation, directory: true };
      return true;
    }
    if (key === 'r' && !event.ctrl && !event.meta) {
      const node = tree.model.selectedId === undefined ? undefined : tree.readNode(tree.model.selectedId);
      if (node !== undefined && node.kind !== 'root') this.#renameDraft = { nodeId: node.id, text: node.name, generation: tree.model.generation };
      return true;
    }
    if (key === 'y' && !event.shift && !event.ctrl && !event.meta) {
      const node = tree.model.selectedId === undefined ? undefined : tree.readNode(tree.model.selectedId);
      if (node !== undefined && node.kind !== 'root') this.#copyDraft = { nodeId: node.id, text: node.name, generation: tree.model.generation };
      return true;
    }
    if (!event.ctrl && !event.meta && !event.option && ((event.shift && key === 'y') || (key === 'x' && !event.shift))) {
      const node = tree.model.selectedId === undefined ? undefined : tree.readNode(tree.model.selectedId);
      if (node !== undefined && node.kind !== 'root' && node.kind !== 'state' && node.kind !== 'symlink') {
        this.#fileClipboard = { nodeId: node.id, path: node.path, name: node.name, cut: key === 'x' };
        this.#options.marker('XI_EXPLORER_CLIPBOARD', { path: node.path, cut: key === 'x' });
      }
      return true;
    }
    if (key === 'p' && !event.ctrl && !event.meta) {
      const copied = this.#fileClipboard;
      const source = copied === undefined ? undefined : tree.readNode(copied.nodeId);
      const selected = tree.model.selectedId === undefined ? undefined : tree.readNode(tree.model.selectedId);
      if (copied === undefined || source?.path !== copied.path || selected === undefined) return true;
      const parent = selected.kind === 'root' || selected.kind === 'directory'
        ? selected.path : selected.path.slice(0, selected.path.length - selected.name.length).replace(/\/$/u, '');
      if (parent === copied.path || parent.startsWith(`${copied.path}/`)) {
        this.#options.onError('xi: paste refused: destination is inside the source\n');
        return true;
      }
      const name = !copied.cut && parent === copied.path.slice(0, copied.path.length - copied.name.length).replace(/\/$/u, '') ? `${copied.name} copy` : copied.name;
      const destination = `${parent}/${name}`;
      if (destination === copied.path) return true;
      if (copied.cut) {
        const relative = this.#options.workspaceRelativePath(destination);
        if (relative !== undefined) await this.#applyMove(copied.nodeId, relative, tree.model.generation);
      } else await this.#applyCopy(copied.nodeId, name, tree.model.generation, parent);
      return true;
    }
    if (key === 'm' && !event.ctrl && !event.meta) {
      const node = tree.model.selectedId === undefined ? undefined : tree.readNode(tree.model.selectedId);
      if (node !== undefined && node.kind !== 'root' && node.kind !== 'symlink') this.#moveDraft = { nodeId: node.id, text: '', generation: tree.model.generation };
      return true;
    }
    if (event.shift && key === 'd') {
      const node = tree.model.selectedId === undefined ? undefined : tree.readNode(tree.model.selectedId);
      if (node !== undefined && node.kind !== 'root' && node.kind !== 'symlink') this.#copyDraft = { nodeId: node.id, text: `${node.name} copy`, generation: tree.model.generation };
      return true;
    }
    if (key === 'd' && !event.ctrl && !event.meta) {
      const node = tree.model.selectedId === undefined ? undefined : tree.readNode(tree.model.selectedId);
      if (node !== undefined && node.kind !== 'root') this.#deleteConfirm = { nodeIds: [node.id], generation: tree.model.generation };
      return true;
    }
    if (key === 'u' && !event.ctrl && !event.meta) {
      await this.#restoreLast();
      return true;
    }
    this.#clearPendingG();
    const selected = tree.model.selectedId === undefined ? undefined : tree.readNode(tree.model.selectedId);
    if ((key === 'right' || key === 'l') && selected?.kind === 'file') {
      await this.previewNode(selected);
      return true;
    }
    const action = key === 'up' || key === 'k' ? 'up'
      : key === 'down' || key === 'j' ? 'down'
      : key === 'left' || key === 'h' ? 'left'
      : key === 'right' || key === 'l' ? 'right'
      : key === 'space' || event.raw === ' ' ? 'toggle'
      : key === 'enter' || key === 'return' || event.raw === '\r' || event.raw === '\n' ? 'open'
      : undefined;
    if (action !== undefined) await navigation.handle(action);
    return true;
  }

  /** Expands each discovered directory in sequence; filesystem reads stay cancellable and
   * never fan out into unbounded concurrent directory scans. */
  async expandAll(): Promise<void> {
    if (this.#tree === undefined) {
      await this.#options.ensureServices();
      if (this.#tree === undefined) return;
    }
    const tree = this.#tree;
    const stack: { readonly ids: readonly string[]; index: number }[] = [{ ids: tree.model.roots, index: 0 }];
    while (stack.length > 0 && !this.#cancellation.token.isCancelled) {
      const frame = stack.at(-1);
      if (frame === undefined) break;
      const id = frame.ids[frame.index++];
      if (id === undefined) { stack.pop(); continue; }
      const node = tree.readNode(id);
      if (node === undefined || (node.kind !== 'root' && node.kind !== 'directory')) continue;
      if (!node.expanded) await tree.expand(id, false, this.#cancellation.token);
      const expanded = tree.readNode(id);
      if (expanded !== undefined && expanded.children !== undefined) stack.push({ ids: expanded.children, index: 0 });
    }
  }

  async openNode(node: ExplorerTreeNode): Promise<void> {
    if (node.kind === 'directory' || node.kind === 'root') return;
    const opened = await this.#options.host.openBufferAtPath(node.path);
    if (opened === undefined) return;
    this.#options.host.promoteBuffer(opened.bufferId, opened.viewId);
    this.close();
  }

  async previewNode(node: ExplorerTreeNode): Promise<void> {
    if (node.kind === 'directory' || node.kind === 'root') return;
    const opened = await this.#options.host.openBufferAtPath(node.path, { preview: true });
    if (opened === undefined) return;
    this.#options.marker('XI_EXPLORER_PREVIEW', { path: node.relativePath });
    this.#options.host.notifySurfaceChange();
  }

  /** Selects `absolutePath` in the visible tree (expanding its parents) without taking
   * keyboard focus -- the Files section follows whatever the picker/search just opened. */
  revealPath(absolutePath: string): void {
    const relative = this.#options.workspaceRelativePath(absolutePath);
    if (relative === undefined || this.#tree === undefined) return;
    void this.#tree.reveal('workspace', relative, this.#cancellation.token);
  }

  /** Takes keyboard focus for the already-visible tree without `open()`'s expand/reveal work:
   * a click on the sidebar must leave the cursor there (VS Code semantics). */
  focus(): void {
    if (this.#open || this.#tree === undefined) return;
    this.#options.host.closeAllPanels('explorer');
    this.#open = true;
    this.#filtering = false;
    this.#clearPendingG();
    this.#options.onOpen?.();
    this.#openGeneration = this.#tree.model.generation;
    this.#tree.focus();
    this.#options.marker('XI_EXPLORER_OPEN', { selectedId: this.#tree.model.selectedId });
  }

  /** Shared body of `handlePanelPointer`'s explorer branch: focus the tree, select the clicked
   * row, then either toggle a container open or preview the file it names. Focus stays in the
   * tree after a click (VS Code single-click semantics); Enter still opens and returns focus. */
  handlePointerActivate(itemId: string, generation: number): boolean {
    const editing = this.editing;
    if (editing !== undefined) {
      const match = /^directory-row-(\d+)$/u.exec(itemId);
      if (match !== null && editing.model.generation === generation) { this.focus(); editing.selectRow(Number(match[1])); }
      return true;
    }
    const tree = this.#tree;
    if (tree === undefined || tree.model.generation !== generation) return true;
    const node = tree.readNode(itemId);
    if (node === undefined || node.kind === 'state') return true;
    this.focus();
    if (!tree.select(node.id)) return true;
    if (node.kind === 'directory' || node.kind === 'root') void this.#navigation?.handle('open');
    else void this.#options.host.openBufferAtPath(node.path, { preview: true });
    return true;
  }

  /** Right-click equivalent of `handlePointerActivate`: resolves the target row (without
   * selecting it yet -- selection happens only once a menu item is actually chosen) for the
   * caller to build a context menu from. */
  selectForContextMenu(itemId: string, generation: number): { readonly nodeId: string; readonly isContainer: boolean; readonly mutable: boolean; readonly expanded: boolean; readonly generation: number } | undefined {
    const tree = this.#tree;
    if (tree === undefined || tree.model.generation !== generation) return undefined;
    const node = tree.readNode(itemId);
    if (node === undefined || node.kind === 'state') return undefined;
    return { nodeId: node.id, isContainer: node.kind === 'directory' || node.kind === 'root', mutable: node.kind !== 'root' && node.kind !== 'symlink', expanded: node.expanded, generation };
  }

  /** `action` is the menu item chosen for `selectForContextMenu`'s target; `'toggle'` reuses
   * the navigation controller's own `'open'` action (which already toggles a directory/root),
   * matching the keyboard and pointer paths exactly. */
  activateContextMenuAction(nodeId: string, action: 'open' | 'toggle' | 'new-file' | 'new-folder' | 'rename' | 'move' | 'copy' | 'duplicate' | 'trash' | 'undo', expectedGeneration?: number): void {
    const tree = this.#tree;
    if (tree !== undefined && expectedGeneration !== undefined && tree.model.generation !== expectedGeneration) { this.#options.onError('xi: file operation cancelled: Files tree changed; open the menu again\n'); return; }
    if (tree === undefined || !tree.select(nodeId)) return;
    const node = tree.readNode(nodeId);
    if (action === 'open') {
      if (node !== undefined) void this.openNode(node);
    } else if (action === 'toggle') {
      void this.#navigation?.handle('open');
    } else if (action === 'undo') {
      void this.#restoreLast();
    } else if (action === 'new-file' || action === 'new-folder') {
      if (node === undefined || (node.kind !== 'root' && node.kind !== 'directory')) return;
      this.#createDraft = { parentPath: node.path, text: '', generation: tree.model.generation, directory: action === 'new-folder' };
    } else if (node !== undefined && node.kind !== 'root' && node.kind !== 'state') {
      if (action === 'rename') this.#renameDraft = { nodeId, text: node.name, generation: tree.model.generation };
      else if (action === 'move' && node.kind !== 'symlink') this.#moveDraft = { nodeId, text: '', generation: tree.model.generation };
      else if (action === 'copy' && node.kind !== 'symlink') this.#copyDraft = { nodeId, text: node.name, generation: tree.model.generation };
      else if (action === 'duplicate' && node.kind !== 'symlink') this.#copyDraft = { nodeId, text: `${node.name} copy`, generation: tree.model.generation };
      else if (action === 'trash') this.#deleteConfirm = { nodeIds: [nodeId], generation: tree.model.generation };
    }
  }

  dispose(): void {
    this.#options.editing?.dispose();
    this.#clearPendingG();
    this.#cancellation.dispose();
  }

  handlePaste(bytes: Uint8Array): void { this.editing?.handlePaste(bytes); }

  #clearPendingG(): void {
    this.#pendingG = false;
    if (this.#pendingGTimer !== undefined) { this.#pendingGTimer.dispose(); this.#pendingGTimer = undefined; }
  }

  #operationNode(node: ExplorerTreeNode | undefined, generation: number): node is ExplorerTreeNode {
    if (this.#tree === undefined || this.#tree.model.generation !== generation) {
      this.#options.onError('xi: file operation cancelled: Files tree changed; start again\n');
      return false;
    }
    if (node === undefined || node.kind === 'root' || node.kind === 'state') return false;
    if (node.kind === 'symlink') { this.#options.onError(`xi: file operation refused: ${node.name} is a symbolic link\n`); return false; }
    if (this.#options.workspaceRelativePath(node.path) === undefined) { this.#options.onError('xi: file operation refused: path is outside the workspace\n'); return false; }
    return true;
  }

  async #confirmRealWorkspacePath(path: string, cancellation: CancellationToken, action: string): Promise<boolean> {
    const tree = this.#tree;
    const rootId = tree?.model.roots[0];
    const root = rootId === undefined ? undefined : tree?.readNode(rootId);
    if (root === undefined) { this.#options.onError(`xi: ${action} refused: workspace root is unavailable\n`); return false; }
    const result = await this.#options.filesystem.isWithinRealWorkspace(root.path, path, cancellation);
    if (result.ok && result.value) return true;
    this.#options.onError(result.ok
      ? `xi: ${action} refused: path resolves outside the workspace\n`
      : `xi: ${action} refused: cannot verify path containment: ${result.error.message}\n`);
    return false;
  }

  #isWorkspaceRoot(path: string): boolean {
    const tree = this.#tree;
    const rootId = tree?.model.roots[0];
    return rootId !== undefined && tree?.readNode(rootId)?.path === path;
  }

  /** Explorer file-management (T131): rename/copy/delete each go through an explicit draft
   * (pending text or pending confirmation) before any filesystem mutation, so a cancelled or
   * failed draft never touches disk. Every applied operation is journaled in-memory (session-
   * scoped, not persisted) so 'u' can reverse the most recent one. Trash lives under the
   * workspace root (`trashDirectory`) so a delete's rename onto the same filesystem stays
   * atomic and genuinely restorable, unlike a real permanent removal. */
  /** Create one entry in the selected directory; names cannot introduce path traversal. */
  async #applyCreate(parentPath: string, rawName: string, directory: boolean, generation: number): Promise<void> {
    const name = rawName.trim();
    if (this.#tree === undefined || this.#tree.model.generation !== generation) { this.#options.onError('xi: create cancelled: Files tree changed; start again\n'); return; }
    if (name.length === 0 || name === '.' || name === '..' || name.includes('/') || (this.#options.workspaceRelativePath(parentPath) === undefined && !this.#isWorkspaceRoot(parentPath))) { this.#options.onError('xi: create cancelled: enter one name inside the workspace\n'); return; }
    const target = `${parentPath}/${name}`;
    if (this.#options.workspaceRelativePath(target) === undefined) { this.#options.onError('xi: create cancelled: destination is outside the workspace\n'); return; }
    const cancellation = new CancellationSource();
    try {
      if (!await this.#confirmRealWorkspacePath(parentPath, cancellation.token, 'create')) return;
      const existing = await this.#options.filesystem.stat(target, cancellation.token);
      if (existing.ok) { this.#options.onError(`xi: create failed: ${name} already exists\n`); return; }
      if (existing.error.code !== 'ENOENT' && existing.error.code !== 'ENOTDIR') { this.#options.onError(`xi: create failed: ${existing.error.message}\n`); return; }
      if (this.#tree?.model.generation !== generation) { this.#options.onError('xi: create cancelled: Files tree changed; start again\n'); return; }
      if (directory) {
        const made = await this.#options.filesystem.makeDirectory(target, cancellation.token);
        if (!made.ok) { this.#options.onError(`xi: create failed: ${made.error.message}\n`); return; }
      } else {
        const written = await this.#options.filesystem.createFileExclusive(target, cancellation.token);
        if (!written.ok) {
          this.#options.onError(written.error.code === 'EEXIST' ? `xi: create failed: ${name} already exists\n` : `xi: create failed: ${written.error.message}\n`);
          return;
        }
      }
      this.#options.marker('XI_EXPLORER_CREATE_APPLIED', { path: target, directory });
      const relative = this.#options.workspaceRelativePath(target);
      if (relative !== undefined && this.#tree !== undefined) void this.#tree.reveal('workspace', relative, this.#cancellation.token);
    } finally {
      cancellation.dispose();
    }
  }

  async #applyRename(nodeId: string, newName: string, generation: number): Promise<void> {
    const tree = this.#tree;
    if (tree === undefined) return;
    const node = tree.readNode(nodeId);
    const trimmed = newName.trim();
    if (!this.#operationNode(node, generation) || trimmed.length === 0 || trimmed === node.name || trimmed === '.' || trimmed === '..' || trimmed.includes('/')) return;
    const parentPath = node.path.slice(0, node.path.length - node.name.length).replace(/\/$/u, '');
    const to = `${parentPath}/${trimmed}`;
    if (this.#options.workspaceRelativePath(to) === undefined) { this.#options.onError('xi: rename cancelled: destination is outside the workspace\n'); return; }
    if (this.#options.session.buffers().some((buffer) => buffer.path === to)) { this.#options.onError(`xi: rename failed: ${trimmed} is open in a buffer\n`); return; }
    const cancellation = new CancellationSource();
    try {
      if (!await this.#confirmRealWorkspacePath(node.path, cancellation.token, 'rename') || !await this.#confirmRealWorkspacePath(parentPath, cancellation.token, 'rename')) return;
      const existingTarget = await this.#options.filesystem.stat(to, cancellation.token);
      if (existingTarget.ok) { this.#options.onError(`xi: rename failed: ${trimmed} already exists\n`); return; }
      if (existingTarget.error.code !== 'ENOENT' && existingTarget.error.code !== 'ENOTDIR') { this.#options.onError(`xi: rename failed: ${existingTarget.error.message}\n`); return; }
      if (tree.model.generation !== generation) { this.#options.onError('xi: rename cancelled: Files tree changed; start again\n'); return; }
      const plan: ExplorerDirectoryOperationPlan = { contractVersion: 1, directoryPath: parentPath, baseGeneration: generation, operations: [
        { kind: 'rename', rowId: node.id, sourceId: node.id, from: node.name, to: trimmed, sourcePath: node.path, destinationPath: to },
      ] };
      const result = await this.#options.fileOperations.apply(plan, cancellation.token);
      if (!result.ok) { this.#options.onError(`xi: rename failed: ${result.error.message ?? result.error.kind}\n`); return; }
      this.#undoJournal.push({ kind: 'rename', from: node.path, to, journal: result.value.journal });
      this.#renameOpenBuffers(node.path, to);
      this.#options.marker('XI_EXPLORER_RENAME_APPLIED', { from: node.path, to });
      const relative = this.#options.workspaceRelativePath(to);
      if (relative !== undefined) void tree.reveal('workspace', relative, this.#cancellation.token);
    } finally {
      cancellation.dispose();
    }
  }

  async #applyCopy(nodeId: string, newName: string, generation: number, destinationParent?: string): Promise<void> {
    const tree = this.#tree;
    if (tree === undefined) return;
    const node = tree.readNode(nodeId);
    const trimmed = newName.trim();
    if (!this.#operationNode(node, generation) || node.kind === 'symlink' || trimmed.length === 0 || trimmed === '.' || trimmed === '..' || trimmed.includes('/')) return;
    const parentPath = destinationParent ?? node.path.slice(0, node.path.length - node.name.length).replace(/\/$/u, '');
    const to = `${parentPath}/${trimmed}`;
    if (this.#options.workspaceRelativePath(to) === undefined) { this.#options.onError('xi: copy cancelled: destination is outside the workspace\n'); return; }
    const cancellation = new CancellationSource();
    try {
      if (!await this.#confirmRealWorkspacePath(node.path, cancellation.token, 'copy') || !await this.#confirmRealWorkspacePath(parentPath, cancellation.token, 'copy')) return;
      const plan: ExplorerDirectoryOperationPlan = { contractVersion: 1, directoryPath: parentPath, baseGeneration: generation, operations: [
        { kind: 'copy', rowId: node.id, sourceId: node.id, sourcePath: node.path, destinationPath: to },
      ] };
      const result = await this.#options.fileOperations.apply(plan, cancellation.token);
      if (!result.ok) { this.#options.onError(`xi: copy failed: ${result.error.message ?? result.error.kind}\n`); return; }
      this.#undoJournal.push({ kind: 'copy', from: node.path, to, journal: result.value.journal });
      this.#options.marker('XI_EXPLORER_COPY_APPLIED', { from: node.path, to });
      const relative = this.#options.workspaceRelativePath(to);
      if (relative !== undefined) void tree.reveal('workspace', relative, this.#cancellation.token);
    } finally {
      cancellation.dispose();
    }
  }

  /** Move into a workspace-relative destination path. Journal preflight rejects occupied
   * destinations; the tree and open buffer labels update only after the journal applies. */
  async #applyMove(nodeId: string, destination: string, generation: number): Promise<void> {
    const tree = this.#tree;
    const node = tree?.readNode(nodeId);
    if (tree === undefined || !this.#operationNode(node, generation)) return;
    const relative = destination.trim().replace(/^\/+|\/+$/gu, '');
    if (relative.length === 0 || relative.split('/').some((part) => part === '.' || part === '..')) {
      this.#options.onError('xi: move cancelled: enter a workspace-relative destination path\n');
      return;
    }
    const root = tree.model.roots[0] === undefined ? undefined : tree.readNode(tree.model.roots[0]);
    if (root === undefined) return;
    const to = `${root.path}/${relative}`;
    const parentPath = to.slice(0, to.lastIndexOf('/'));
    if (this.#options.workspaceRelativePath(to) === undefined || (this.#options.workspaceRelativePath(parentPath) === undefined && !this.#isWorkspaceRoot(parentPath))) {
      this.#options.onError('xi: move cancelled: destination is outside the workspace\n');
      return;
    }
    if (this.#options.session.buffers().some((buffer) => buffer.path === to)) {
      this.#options.onError('xi: move failed: destination is open in a buffer\n');
      return;
    }
    const cancellation = new CancellationSource();
    try {
      if (!await this.#confirmRealWorkspacePath(node.path, cancellation.token, 'move') || !await this.#confirmRealWorkspacePath(parentPath, cancellation.token, 'move')) return;
      const plan: ExplorerDirectoryOperationPlan = { contractVersion: 1, directoryPath: root.path, baseGeneration: generation, operations: [
        { kind: 'rename', rowId: node.id, sourceId: node.id, from: node.name, to: relative.slice(relative.lastIndexOf('/') + 1), sourcePath: node.path, destinationPath: to },
      ] };
      const result = await this.#options.fileOperations.apply(plan, cancellation.token);
      if (!result.ok) { this.#options.onError(`xi: move failed: ${result.error.message ?? result.error.kind}\n`); return; }
      this.#undoJournal.push({ kind: 'rename', from: node.path, to, journal: result.value.journal });
      this.#renameOpenBuffers(node.path, to);
      this.#options.marker('XI_EXPLORER_MOVE_APPLIED', { from: node.path, to });
      const reveal = this.#options.workspaceRelativePath(to);
      if (reveal !== undefined) void tree.reveal('workspace', reveal, this.#cancellation.token);
    } finally { cancellation.dispose(); }
  }

  async #applyDelete(nodeIds: readonly string[], generation: number): Promise<void> {
    const tree = this.#tree;
    if (tree === undefined) return;
    // ponytail: keep one filesystem journal bounded; split larger selections into smaller
    // batches if users need more than 256 entries at once.
    if (nodeIds.length > 256) { this.#options.onError('xi: delete refused: select at most 256 entries\n'); return; }
    const candidates = nodeIds.map((id) => tree.readNode(id)).filter((node) => node?.kind !== 'root' && node?.kind !== 'state');
    if (candidates.some((node) => !this.#operationNode(node, generation))) return;
    const nodes = candidates.filter((node): node is ExplorerTreeNode => node !== undefined);
    const selectedPaths = new Set(nodes.map((node) => node.path));
    const roots = nodes.filter((node) => {
      let parent = node.parentId === undefined ? undefined : tree.readNode(node.parentId);
      while (parent !== undefined) {
        if (selectedPaths.has(parent.path)) return false;
        parent = parent.parentId === undefined ? undefined : tree.readNode(parent.parentId);
      }
      return true;
    });
    if (roots.length === 0) return;
    const dirtyUnder = roots.find((node) => this.#options.session.buffers().some((buffer) => buffer.dirty === true && buffer.path !== undefined && (buffer.path === node.path || buffer.path.startsWith(`${node.path}/`))));
    if (dirtyUnder !== undefined) { this.#options.onError(`xi: cannot delete ${dirtyUnder.name}: it has unsaved open buffers\n`); return; }
    const rootId = tree.model.roots[0];
    const workspacePath = rootId === undefined ? undefined : tree.readNode(rootId)?.path;
    if (workspacePath === undefined) return;
    const parentPath = roots[0]!.path.slice(0, roots[0]!.path.length - roots[0]!.name.length).replace(/\/$/u, '');
    const oneDirectory = roots.every((node) => node.path.slice(0, node.path.length - node.name.length).replace(/\/$/u, '') === parentPath);
    const directoryPath = oneDirectory ? parentPath : workspacePath;
    const cancellation = new CancellationSource();
    try {
      for (const node of roots) if (!await this.#confirmRealWorkspacePath(node.path, cancellation.token, 'delete')) return;
      if (tree.model.generation !== generation) { this.#options.onError('xi: delete cancelled: Files tree changed; start again\n'); return; }
      const plan: ExplorerDirectoryOperationPlan = { contractVersion: 1, directoryPath, baseGeneration: generation, operations: roots.map((node) =>
        ({ kind: 'trash', rowId: node.id, sourceId: node.id, sourcePath: node.path })) };
      const result = await this.#options.fileOperations.apply(plan, cancellation.token);
      if (!result.ok) { this.#options.onError(`xi: delete failed: ${result.error.message ?? result.error.kind}\n`); return; }
      this.#undoJournal.push({ kind: 'delete', from: roots[0]!.path, to: roots[0]!.path, journal: result.value.journal });
      for (const node of roots) this.#options.marker('XI_EXPLORER_DELETE_APPLIED', { from: node.path });
      const relative = this.#options.workspaceRelativePath(directoryPath);
      if (relative !== undefined) void tree.reveal('workspace', relative, this.#cancellation.token);
    } finally {
      cancellation.dispose();
    }
  }

  async #restoreLast(): Promise<void> {
    const entry = this.#undoJournal.pop();
    if (entry === undefined) return;
    const cancellation = new CancellationSource();
    try {
      const restored = await this.#options.fileOperations.restoreApplied(entry.journal, cancellation.token);
      if (!restored.ok) { this.#options.onError(`xi: restore failed: ${restored.error.message ?? restored.error.kind}\n`); this.#undoJournal.push(entry); return; }
      if (entry.kind === 'delete' || entry.kind === 'rename') this.#renameOpenBuffers(entry.to, entry.from);
      this.#options.marker('XI_EXPLORER_RESTORE_APPLIED', { kind: entry.kind, path: entry.from });
      const relative = this.#options.workspaceRelativePath(entry.from);
      if (relative !== undefined) void this.#tree?.reveal('workspace', relative, this.#cancellation.token);
    } finally {
      cancellation.dispose();
    }
  }

  /** Keep any open buffer's own path label in step with a rename/restore -- the underlying
   * document content is untouched, only the display/save path changes. */
  #renameOpenBuffers(from: string, to: string): void {
    for (const buffer of this.#options.session.buffers()) {
      if (buffer.path === undefined) continue;
      if (buffer.path === from) this.#options.session.renameBufferPath(buffer.bufferId, to);
      else if (buffer.path.startsWith(`${from}/`)) this.#options.session.renameBufferPath(buffer.bufferId, `${to}${buffer.path.slice(from.length)}`);
    }
  }
}
