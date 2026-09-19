import { CancellationSource, type CancellationToken, type ClockPort, type Disposable, type DocumentId, type PlatformFailure, type Result, type ViewId } from '../../contracts/src/index';
import type { OwnedVimKeyEvent } from '../vim-session';
import type { BufferHost } from '../host';

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
}

export interface ExplorerTreeModel {
  readonly generation: number;
  readonly roots: readonly string[];
  readonly selectedId: string | undefined;
  readonly filter: string;
  readonly state: string;
  readonly visibleRows: readonly unknown[];
}

/** Narrow port onto `packages/services/files`'s `ExplorerTree`: only the members `main()`
 * used to call, kept structural so workbench never imports the services package. */
export interface ExplorerTreePort {
  readonly model: ExplorerTreeModel;
  subscribe(listener: (model: ExplorerTreeModel) => void): Disposable;
  focus(): void;
  blur(): void;
  setFilter(filter: string): void;
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
}

/** Mirrors `packages/services/files/directory-draft`'s `DirectoryOperation`/`DirectoryOperationPlan`
 * shapes structurally -- workbench cannot import `packages/services`, not even types. */
export type ExplorerDirectoryOperation =
  | { readonly kind: 'rename'; readonly rowId: string; readonly sourceId: string; readonly from: string; readonly to: string; readonly sourcePath: string; readonly destinationPath: string }
  | { readonly kind: 'trash'; readonly rowId: string; readonly sourceId: string; readonly sourcePath: string }
  | { readonly kind: 'copy'; readonly rowId: string; readonly sourceId: string; readonly sourcePath: string; readonly destinationPath: string };

export interface ExplorerDirectoryOperationPlan {
  readonly contractVersion: 1;
  readonly directoryPath: string;
  readonly baseGeneration: number;
  readonly operations: readonly ExplorerDirectoryOperation[];
}

/** Narrow port onto `packages/services/files`'s `JournaledFilesystemOperations`: the
 * durable, crash-recoverable move/copy/trash executor already used by
 * `packages/workbench/directory` and `main.ts`, so explorer file operations get the same
 * journal-before-disk-step guarantee instead of a private undo log. */
export interface ExplorerJournaledOperationsPort {
  apply(plan: ExplorerDirectoryOperationPlan, cancellation: CancellationToken): Promise<Result<{ readonly journal: unknown }, { readonly kind: string; readonly message?: string }>>;
  restoreApplied(journal: unknown, cancellation: CancellationToken): Promise<Result<unknown, { readonly kind: string; readonly message?: string }>>;
}

export interface ExplorerControllerOptions {
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
  /** `zc` on the tree: collapse the sidebar's Files section (focus returns to the editor). */
  readonly onCollapse?: () => void;
  /** Tab on the tree: move keyboard focus to the Outline section. */
  readonly focusOutline?: () => void;
}

interface ExplorerDraft {
  readonly nodeId: string;
  readonly text: string;
}

/**
 * Owns the Explorer panel's state and key handling: open/filtering/pending-`g`/rename-copy-
 * delete drafts and the in-memory undo journal. Moved out of `apps/xi/src/main.ts`'s `main()`
 * closure; the tree's data (`ExplorerTree`) and its navigation controller still live in
 * `packages/services/files` and are only ever reached through `ExplorerTreePort` /
 * `ExplorerNavigationPort`, bound once by `attachTree` after the composition root constructs
 * them (they are loaded lazily, on first use of any panel).
 */
export class ExplorerController {
  #open = false;
  #visible = false;
  #filtering = false;
  #pendingG = false;
  #pendingGTimer: Disposable | undefined;
  #openGeneration = 0;
  #renameDraft: ExplorerDraft | undefined;
  #copyDraft: ExplorerDraft | undefined;
  #createDraft: { readonly parentPath: string; readonly text: string } | undefined;
  #pendingCtrlW = false;
  #pendingZ = false;
  #deleteConfirm: { readonly nodeId: string } | undefined;
  readonly #undoJournal: { readonly kind: 'rename' | 'copy' | 'delete'; readonly from: string; readonly to: string; readonly journal: unknown }[] = [];
  #tree: ExplorerTreePort | undefined;
  #navigation: ExplorerNavigationPort | undefined;
  readonly #cancellation = new CancellationSource();
  readonly #options: ExplorerControllerOptions;

  constructor(options: ExplorerControllerOptions) {
    this.#options = options;
  }

  get isOpen(): boolean { return this.#open; }
  get isVisible(): boolean { return this.#visible; }
  /** True while a filter/rename/copy/delete prompt owns typed characters, so `:` must stay here. */
  get capturesTextInput(): boolean { return this.#filtering || this.#renameDraft !== undefined || this.#copyDraft !== undefined || this.#createDraft !== undefined || this.#deleteConfirm !== undefined; }
  /** The in-progress rename/copy/create/delete prompt, painted on the panel's footer row. */
  get promptText(): string | undefined {
    if (this.#renameDraft !== undefined) return `Rename: ${this.#renameDraft.text}`;
    if (this.#copyDraft !== undefined) return `Copy to: ${this.#copyDraft.text}`;
    if (this.#createDraft !== undefined) return `New (dir: name/): ${this.#createDraft.text}`;
    if (this.#deleteConfirm !== undefined) return `Move ${this.#tree?.readNode(this.#deleteConfirm.nodeId)?.name ?? 'entry'} to trash? y/n`;
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
        this.#options.marker('XI_EXPLORER_REFRESH', { generation: model.generation, selectedId: model.selectedId, selectedPath: selected?.relativePath, state: model.state, filter: model.filter, visibleRowCount: model.visibleRows.length });
      }
    });
  }

  /** Loads and shows the tree in the sidebar without taking keyboard focus (startup default). */
  show(): void {
    if (this.#tree === undefined) {
      void this.#options.ensureServices().then(() => { if (!this.#open) this.show(); }).catch((error: unknown) => {
        this.#options.onError(`xi: explorer failed to load: ${error instanceof Error ? error.message : String(error)}\n`);
      });
      return;
    }
    this.#visible = true;
    this.#options.onOpen?.();
    const tree = this.#tree;
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
    this.#options.marker('XI_EXPLORER_OPEN', { selectedId: tree.model.selectedId });
  }

  close(): void {
    this.#open = false;
    this.#filtering = false;
    this.#createDraft = undefined;
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
    if (this.#deleteConfirm !== undefined) {
      const confirmed = key === 'y';
      const nodeId = this.#deleteConfirm.nodeId;
      this.#deleteConfirm = undefined;
      if (confirmed) await this.#applyDelete(nodeId);
      return true;
    }
    if (this.#createDraft !== undefined) {
      const draft = this.#createDraft;
      if (key === 'escape' || event.raw === '') { this.#createDraft = undefined; return true; }
      if (key === 'enter' || key === 'return' || event.raw === '\r' || event.raw === '\n') {
        this.#createDraft = undefined;
        await this.#applyCreate(draft.parentPath, draft.text);
        return true;
      }
      if (key === 'backspace' || key === 'backspace2' || event.raw === '') { this.#createDraft = { ...draft, text: draft.text.slice(0, -1) }; return true; }
      if (!event.ctrl && !event.meta && !event.option && event.raw.length === 1 && event.raw >= ' ' && event.raw !== '') this.#createDraft = { ...draft, text: `${draft.text}${event.raw}` };
      return true;
    }
    if (this.#renameDraft !== undefined || this.#copyDraft !== undefined) {
      const isCopy = this.#copyDraft !== undefined;
      const draft = isCopy ? this.#copyDraft : this.#renameDraft;
      if (draft === undefined) return true;
      if (key === 'escape' || event.raw === '') {
        this.#renameDraft = undefined;
        this.#copyDraft = undefined;
        return true;
      }
      if (key === 'enter' || key === 'return' || event.raw === '\r' || event.raw === '\n') {
        this.#renameDraft = undefined;
        this.#copyDraft = undefined;
        if (isCopy) await this.#applyCopy(draft.nodeId, draft.text);
        else await this.#applyRename(draft.nodeId, draft.text);
        return true;
      }
      if (key === 'backspace' || key === 'backspace2' || event.raw === '') {
        const next = { nodeId: draft.nodeId, text: draft.text.slice(0, -1) };
        if (isCopy) this.#copyDraft = next; else this.#renameDraft = next;
        return true;
      }
      if (!event.ctrl && !event.meta && !event.option && event.raw.length === 1 && event.raw >= ' ' && event.raw !== '') {
        const next = { nodeId: draft.nodeId, text: `${draft.text}${event.raw}` };
        if (isCopy) this.#copyDraft = next; else this.#renameDraft = next;
      }
      return true;
    }
    if (key === 'escape' || event.raw === '') {
      if (this.#filtering || tree.model.filter.length > 0) {
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
      if (parentPath !== undefined) this.#createDraft = { parentPath, text: '' };
      return true;
    }
    if (key === 'r' && !event.ctrl && !event.meta) {
      const node = tree.model.selectedId === undefined ? undefined : tree.readNode(tree.model.selectedId);
      if (node !== undefined && node.kind !== 'root') this.#renameDraft = { nodeId: node.id, text: node.name };
      return true;
    }
    if (key === 'y' && !event.ctrl && !event.meta) {
      const node = tree.model.selectedId === undefined ? undefined : tree.readNode(tree.model.selectedId);
      if (node !== undefined && node.kind !== 'root') this.#copyDraft = { nodeId: node.id, text: node.name };
      return true;
    }
    if (key === 'd' && !event.ctrl && !event.meta) {
      const node = tree.model.selectedId === undefined ? undefined : tree.readNode(tree.model.selectedId);
      if (node !== undefined && node.kind !== 'root') this.#deleteConfirm = { nodeId: node.id };
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
  selectForContextMenu(itemId: string, generation: number): { readonly nodeId: string; readonly isContainer: boolean; readonly expanded: boolean } | undefined {
    const tree = this.#tree;
    if (tree === undefined || tree.model.generation !== generation) return undefined;
    const node = tree.readNode(itemId);
    if (node === undefined || node.kind === 'state') return undefined;
    return { nodeId: node.id, isContainer: node.kind === 'directory' || node.kind === 'root', expanded: node.expanded };
  }

  /** `action` is the menu item chosen for `selectForContextMenu`'s target; `'toggle'` reuses
   * the navigation controller's own `'open'` action (which already toggles a directory/root),
   * matching the keyboard and pointer paths exactly. */
  activateContextMenuAction(nodeId: string, action: 'open' | 'toggle'): void {
    const tree = this.#tree;
    if (tree === undefined || !tree.select(nodeId)) return;
    if (action === 'open') {
      const node = tree.readNode(nodeId);
      if (node !== undefined) void this.openNode(node);
    } else {
      void this.#navigation?.handle('open');
    }
  }

  dispose(): void {
    this.#clearPendingG();
    this.#cancellation.dispose();
  }

  #clearPendingG(): void {
    this.#pendingG = false;
    if (this.#pendingGTimer !== undefined) { this.#pendingGTimer.dispose(); this.#pendingGTimer = undefined; }
  }

  /** Explorer file-management (T131): rename/copy/delete each go through an explicit draft
   * (pending text or pending confirmation) before any filesystem mutation, so a cancelled or
   * failed draft never touches disk. Every applied operation is journaled in-memory (session-
   * scoped, not persisted) so 'u' can reverse the most recent one. Trash lives under the
   * workspace root (`trashDirectory`) so a delete's rename onto the same filesystem stays
   * atomic and genuinely restorable, unlike a real permanent removal. */
  /** `a`: create `<parent>/<name>` (a trailing `/` makes a directory; missing parents are created). */
  async #applyCreate(parentPath: string, rawName: string): Promise<void> {
    const name = rawName.trim();
    if (name.length === 0 || name.includes('..') || name.startsWith('/')) return;
    const isDirectory = name.endsWith('/');
    const target = `${parentPath}/${name.replace(/\/+$/u, '')}`;
    const cancellation = new CancellationSource();
    try {
      if ((await this.#options.filesystem.stat(target, cancellation.token)).ok) { this.#options.onError(`xi: create failed: ${name} already exists\n`); return; }
      const directory = isDirectory ? target : target.slice(0, target.lastIndexOf('/'));
      if (directory.length > parentPath.length) {
        const made = await this.#options.filesystem.makeDirectory(directory, cancellation.token);
        if (!made.ok) { this.#options.onError(`xi: create failed: ${made.error.message}\n`); return; }
      }
      if (!isDirectory) {
        const written = await this.#options.filesystem.writeFileAtomic(target, new Uint8Array(), cancellation.token);
        if (!written.ok) { this.#options.onError(`xi: create failed: ${written.error.message}\n`); return; }
      }
      this.#options.marker('XI_EXPLORER_CREATE_APPLIED', { path: target, directory: isDirectory });
      const relative = this.#options.workspaceRelativePath(target);
      if (relative !== undefined && this.#tree !== undefined) void this.#tree.reveal('workspace', relative, this.#cancellation.token);
    } finally {
      cancellation.dispose();
    }
  }

  async #applyRename(nodeId: string, newName: string): Promise<void> {
    const tree = this.#tree;
    if (tree === undefined) return;
    const node = tree.readNode(nodeId);
    const trimmed = newName.trim();
    if (node === undefined || trimmed.length === 0 || trimmed === node.name || trimmed.includes('/')) return;
    const parentPath = node.path.slice(0, node.path.length - node.name.length).replace(/\/$/u, '');
    const to = `${parentPath}/${trimmed}`;
    const cancellation = new CancellationSource();
    try {
      const existingTarget = await this.#options.filesystem.stat(to, cancellation.token);
      if (existingTarget.ok) { this.#options.onError(`xi: rename failed: ${trimmed} already exists\n`); return; }
      const plan: ExplorerDirectoryOperationPlan = { contractVersion: 1, directoryPath: parentPath, baseGeneration: 0, operations: [
        { kind: 'rename', rowId: node.id, sourceId: node.id, from: node.name, to: trimmed, sourcePath: node.path, destinationPath: to },
      ] };
      const result = await this.#options.fileOperations.apply(plan, cancellation.token);
      if (!result.ok) { this.#options.onError(`xi: rename failed: ${result.error.message ?? result.error.kind}\n`); return; }
      this.#undoJournal.push({ kind: 'rename', from: node.path, to, journal: result.value.journal });
      this.#renameOpenBuffers(node.path, to);
      this.#options.marker('XI_EXPLORER_RENAME_APPLIED', { from: node.path, to });
    } finally {
      cancellation.dispose();
    }
  }

  async #applyCopy(nodeId: string, newName: string): Promise<void> {
    const tree = this.#tree;
    if (tree === undefined) return;
    const node = tree.readNode(nodeId);
    const trimmed = newName.trim();
    if (node === undefined || trimmed.length === 0 || trimmed.includes('/')) return;
    const parentPath = node.path.slice(0, node.path.length - node.name.length).replace(/\/$/u, '');
    const to = `${parentPath}/${trimmed}`;
    const cancellation = new CancellationSource();
    try {
      const plan: ExplorerDirectoryOperationPlan = { contractVersion: 1, directoryPath: parentPath, baseGeneration: 0, operations: [
        { kind: 'copy', rowId: node.id, sourceId: node.id, sourcePath: node.path, destinationPath: to },
      ] };
      const result = await this.#options.fileOperations.apply(plan, cancellation.token);
      if (!result.ok) { this.#options.onError(`xi: copy failed: ${result.error.message ?? result.error.kind}\n`); return; }
      this.#undoJournal.push({ kind: 'copy', from: node.path, to, journal: result.value.journal });
      this.#options.marker('XI_EXPLORER_COPY_APPLIED', { from: node.path, to });
    } finally {
      cancellation.dispose();
    }
  }

  async #applyDelete(nodeId: string): Promise<void> {
    const tree = this.#tree;
    if (tree === undefined) return;
    const node = tree.readNode(nodeId);
    if (node === undefined) return;
    const dirtyUnder = this.#options.session.buffers().some((buffer) => buffer.dirty === true && buffer.path !== undefined && (buffer.path === node.path || buffer.path.startsWith(`${node.path}/`)));
    if (dirtyUnder) { this.#options.onError(`xi: cannot delete ${node.name}: it has unsaved open buffers\n`); return; }
    const parentPath = node.path.slice(0, node.path.length - node.name.length).replace(/\/$/u, '');
    const cancellation = new CancellationSource();
    try {
      const plan: ExplorerDirectoryOperationPlan = { contractVersion: 1, directoryPath: parentPath, baseGeneration: 0, operations: [
        { kind: 'trash', rowId: node.id, sourceId: node.id, sourcePath: node.path },
      ] };
      const result = await this.#options.fileOperations.apply(plan, cancellation.token);
      if (!result.ok) { this.#options.onError(`xi: delete failed: ${result.error.message ?? result.error.kind}\n`); return; }
      this.#undoJournal.push({ kind: 'delete', from: node.path, to: node.path, journal: result.value.journal });
      this.#options.marker('XI_EXPLORER_DELETE_APPLIED', { from: node.path });
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
