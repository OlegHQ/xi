import type {
  CommittedDocumentChange,
  DocumentEdit,
  DocumentReadPort,
  DocumentSnapshot,
  DocumentTransactionFailure,
  EditOrigin,
  TextFileDocument,
} from '../../document/src/index.ts';
import { createSelectionSet, mapSelectionSet, type EndpointInput, type SelectionMember, type SelectionMemberInput, type SelectionSet } from '../../selections/src/index';
import { asIdentifier, asLineIndex, asUtf16Offset, type DocumentId, type DocumentVersion, type Result, type SelectionId, type UndoGroupId, type ViewId } from '../../contracts/src/index';
import type { VimMode, VimSessionReader, VimSessionSnapshot } from '../../vim/src/index.ts';
import { ViewSelectionPersistence, type PersistedViewSelection, type SelectionPersistenceFailure, type SelectionPersistenceSnapshot } from './selection-persistence';
import {
  AtomicCommandCoordinator,
  createAtomicWorkbenchState,
  type AtomicViewState,
  type AtomicWorkbenchState,
} from '../editing/atomic-command';
import type { WorkbenchLayoutRead } from '../src/read-model';

export type SplitOrientation = 'horizontal' | 'vertical';
export type WorkbenchWindowDirection = 'left' | 'right' | 'up' | 'down' | 'next' | 'previous' | 'first' | 'last';
export type CloseDecision = 'save' | 'keep-open' | 'discard' | 'cancel';

export type WorkbenchSessionFailure =
  | { readonly kind: 'session-disposed' }
  | { readonly kind: 'duplicate-buffer'; readonly bufferId: DocumentId }
  | { readonly kind: 'buffer-not-found'; readonly bufferId: DocumentId }
  | { readonly kind: 'view-not-found'; readonly viewId: ViewId }
  | { readonly kind: 'duplicate-view'; readonly viewId: ViewId }
  | { readonly kind: 'dirty-buffer'; readonly bufferId: DocumentId; readonly choices: readonly ['save', 'keep-open', 'discard'] }
  | { readonly kind: 'dirty-preview-replacement'; readonly bufferId: DocumentId }
  | { readonly kind: 'save-unavailable'; readonly bufferId: DocumentId }
  | { readonly kind: 'save-failed'; readonly bufferId: DocumentId; readonly message: string }
  | { readonly kind: 'invalid-layout'; readonly message: string }
  | { readonly kind: 'missing-restored-buffer'; readonly bufferId: string; readonly path: string }
  | { readonly kind: 'missing-restored-view'; readonly viewId: string }
  | { readonly kind: 'split-too-small'; readonly nodeId: string; readonly firstSize: number; readonly secondSize: number; readonly minimum: number }
  | { readonly kind: 'invalid-edit'; readonly cause: DocumentTransactionFailure };

export interface BufferOpenOptions {
  readonly path?: string;
  readonly preview?: boolean;
  readonly previewSlot?: string;
  readonly pinned?: boolean;
  readonly viewId?: ViewId;
}

export interface WorkbenchBufferSnapshot {
  readonly bufferId: DocumentId;
  readonly path: string | undefined;
  readonly documentId: DocumentId;
  readonly documentVersion: DocumentVersion;
  readonly revisionId: DocumentSnapshot['revisionId'];
  readonly dirty: boolean;
  readonly preview: boolean;
  readonly pinned: boolean;
  readonly viewIds: readonly ViewId[];
}

/** Read model for a tab strip: one row per open buffer, in open order. */
export interface WorkbenchTabSnapshot {
  readonly id: DocumentId;
  readonly label: string;
  readonly dirty: boolean;
  readonly preview: boolean;
  readonly pinned: boolean;
  readonly active: boolean;
}

export interface WorkbenchViewStateSnapshot {
  readonly viewId: ViewId;
  readonly bufferId: DocumentId;
  readonly paneId: string;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly session: VimSessionSnapshot;
}

export interface SplitLeaf {
  readonly kind: 'leaf';
  readonly nodeId: string;
  readonly viewId: ViewId;
}

export interface SplitBranch {
  readonly kind: 'split';
  readonly nodeId: string;
  readonly orientation: SplitOrientation;
  readonly ratio: number;
  readonly first: SplitNode;
  readonly second: SplitNode;
}

export type SplitNode = SplitLeaf | SplitBranch;

export interface WorkbenchSplitSnapshot {
  readonly root: SplitNode | undefined;
  readonly minimumPaneSize: number;
}

export interface WorkbenchLayoutSnapshot {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly activeViewId?: ViewId;
  readonly buffers: readonly WorkbenchLayoutBuffer[];
  readonly viewStates: readonly WorkbenchLayoutViewState[];
  readonly split: WorkbenchSplitSnapshot;
}

export interface WorkbenchLayoutViewState {
  readonly viewId: ViewId;
  readonly bufferId: DocumentId;
  readonly scrollTop: number;
  readonly scrollLeft: number;
}

export interface WorkbenchLayoutBuffer {
  readonly bufferId: DocumentId;
  readonly path: string;
  readonly preview: boolean;
  readonly pinned: boolean;
  readonly viewIds: readonly ViewId[];
}

export interface WorkbenchLayoutStore {
  write(layout: WorkbenchLayoutSnapshot): Result<void, string> | Promise<Result<void, string>>;
  read(): Result<unknown, string> | Promise<Result<unknown, string>>;
}

export interface WorkbenchSessionOptions {
  readonly workspaceId?: string;
  readonly minimumPaneSize?: number;
  readonly layoutStore?: WorkbenchLayoutStore;
  readonly saveBuffer?: (buffer: WorkbenchBufferSnapshot) => Result<void, string> | Promise<Result<void, string>>;
  /** Observe every committed document change after all workbench views are mapped. */
  readonly onDocumentChange?: (change: CommittedDocumentChange) => void;
}

interface BufferRecord {
  readonly bufferId: DocumentId;
  path: string | undefined;
  readonly document: TextFileDocument;
  readonly coordinator: AtomicCommandCoordinator;
  readonly viewIds: Set<ViewId>;
  readonly previewSlot: string | undefined;
  preview: boolean;
  pinned: boolean;
  changeSubscription: { dispose(): void };
}

interface ViewRecord {
  readonly viewId: ViewId;
  readonly bufferId: DocumentId;
  readonly paneId: string;
  scrollTop: number;
  scrollLeft: number;
  /** Rows the UI last laid this view out with; undefined until the first frame. */
  viewportHeight?: number;
  readonly returnViewId?: ViewId;
}

const DEFAULT_MINIMUM_PANE_SIZE = 12;
const LAYOUT_SCHEMA_VERSION = 1 as const;

interface WorkbenchReadView {
  readonly session: VimSessionSnapshot;
  readonly document: DocumentSnapshot;
  readonly selections: SelectionSet;
  /** Viewport scroll offset, in document line index (0-based). */
  readonly scrollTop: number;
  /** Viewport scroll offset, in terminal cell columns (0-based). */
  readonly scrollLeft: number;
}

/**
 * Owns buffers, views, split geometry and per-buffer engine coordinators.
 * Documents remain the only writable text owner; every view stores only its
 * immutable selection/session state and viewport position.
 */
export class WorkbenchSession implements VimSessionReader {
  readonly #workspaceId: string;
  readonly #minimumPaneSize: number;
  readonly #layoutStore: WorkbenchLayoutStore | undefined;
  readonly #saveBuffer: ((buffer: WorkbenchBufferSnapshot) => Result<void, string> | Promise<Result<void, string>>) | undefined;
  readonly #onDocumentChange: ((change: CommittedDocumentChange) => void) | undefined;
  readonly #buffers = new Map<DocumentId, BufferRecord>();
  readonly #views = new Map<ViewId, ViewRecord>();
  #root: SplitNode | undefined;
  #layoutReadCache: WorkbenchLayoutRead | undefined;
  /** Per-view read cache, self-validating on the coordinator state/document identity that produced it. */
  readonly #readViewCache = new Map<ViewId, { readonly state: AtomicWorkbenchState; readonly document: DocumentSnapshot; readonly scrollTop: number; readonly scrollLeft: number; readonly result: WorkbenchReadView }>();
  readonly #viewSnapshotCache = new Map<ViewId, { readonly read: WorkbenchReadView; readonly paneId: string; readonly scrollTop: number; readonly scrollLeft: number; readonly result: WorkbenchViewStateSnapshot }>();
  #alternateBufferId: DocumentId | undefined;
  #activeViewId: ViewId | undefined;
  #nextNode = 1;
  #nextView = 1;
  #disposed = false;
  readonly #selectionPersistence = new ViewSelectionPersistence();

  constructor(options: WorkbenchSessionOptions = {}) {
    this.#workspaceId = options.workspaceId ?? 'default';
    this.#minimumPaneSize = Number.isSafeInteger(options.minimumPaneSize) && (options.minimumPaneSize as number) >= 1
      ? options.minimumPaneSize as number
      : DEFAULT_MINIMUM_PANE_SIZE;
    this.#layoutStore = options.layoutStore;
    this.#saveBuffer = options.saveBuffer;
    this.#onDocumentChange = options.onDocumentChange;
  }

  get workspaceId(): string { return this.#workspaceId; }
  get activeViewId(): ViewId | undefined { return this.#activeViewId; }
  get minimumPaneSize(): number { return this.#minimumPaneSize; }
  get disposed(): boolean { return this.#disposed; }

  /** Register a document and create its first view. A preview can be promoted later. */
  openBuffer(document: TextFileDocument, options: BufferOpenOptions = {}): Result<WorkbenchBufferSnapshot, WorkbenchSessionFailure> {
    const live = this.ensureLive();
    if (!live.ok) return live;
    if (this.#buffers.has(document.id)) return { ok: false, error: { kind: 'duplicate-buffer', bufferId: document.id } };
    const viewId = options.viewId ?? this.newViewId(document.id);
    if (this.#views.has(viewId)) return { ok: false, error: { kind: 'duplicate-view', viewId } };
    const initialSelection = createInitialSelection(document.snapshot(), viewId);
    if (!initialSelection.ok) return { ok: false, error: { kind: 'invalid-layout', message: `initial selection: ${initialSelection.error.kind}` } };
    const atomicState = createAtomicWorkbenchState(document.snapshot(), {
      activeViewId: viewId,
      views: [{ viewId, selections: initialSelection.value, mode: 'normal', repeatTarget: null }],
    });
    if (!atomicState.ok) return { ok: false, error: { kind: 'invalid-layout', message: `initial state: ${atomicState.error.kind}` } };
    const coordinator = new AtomicCommandCoordinator(document, atomicState.value);
    const buffer: BufferRecord = {
      bufferId: document.id,
      path: options.path,
      document,
      coordinator,
      viewIds: new Set([viewId]),
      previewSlot: options.preview === true ? options.previewSlot ?? 'default' : undefined,
      preview: options.preview === true,
      pinned: options.pinned === true,
      changeSubscription: { dispose() {} },
    };
    buffer.changeSubscription = document.subscribeChanges((change) => this.mapExternalChange(buffer, change));
    this.#buffers.set(buffer.bufferId, buffer);
    const previousViewId = this.#activeViewId;
    this.#views.set(viewId, {
      viewId,
      bufferId: buffer.bufferId,
      paneId: this.newNodeId('pane'),
      scrollTop: 0,
      scrollLeft: 0,
      ...(previousViewId === undefined ? {} : { returnViewId: previousViewId }),
    });
    if (this.#root === undefined) {
      this.#root = { kind: 'leaf', nodeId: this.newNodeId('leaf'), viewId };
    } else if (previousViewId !== undefined) {
      this.#root = replaceLeafView(this.#root, previousViewId, viewId);
    } else {
      this.#root = { kind: 'leaf', nodeId: this.newNodeId('leaf'), viewId };
    }
    this.invalidateLayoutRead();
    this.#activeViewId = viewId;
    return { ok: true, value: this.bufferSnapshot(buffer) };
  }

  /** Alias kept for composition roots that call the operation an add. */
  addBuffer(document: TextFileDocument, options: BufferOpenOptions = {}): Result<WorkbenchBufferSnapshot, WorkbenchSessionFailure> {
    return this.openBuffer(document, options);
  }

  /** Open a new preview slot, replacing only a clean, unpinned prior preview. */
  replacePreview(document: TextFileDocument, options: Omit<BufferOpenOptions, 'preview' | 'pinned'> = {}): Result<WorkbenchBufferSnapshot, WorkbenchSessionFailure> {
    const slot = options.previewSlot ?? 'default';
    for (const buffer of this.#buffers.values()) {
      if (buffer.preview && !buffer.pinned && buffer.previewSlot === slot) {
        if (buffer.document.isDirty) return { ok: false, error: { kind: 'dirty-preview-replacement', bufferId: buffer.bufferId } };
        const closed = this.closeBuffer(buffer.bufferId, 'discard');
        if (!closed.ok) return closed;
      }
    }
    return this.openBuffer(document, { ...options, preview: true, previewSlot: slot });
  }

  buffer(bufferId: DocumentId): WorkbenchBufferSnapshot | undefined {
    const record = this.#buffers.get(bufferId);
    return record === undefined ? undefined : this.bufferSnapshot(record);
  }

  buffers(): readonly WorkbenchBufferSnapshot[] {
    return Object.freeze([...this.#buffers.values()].map((buffer) => this.bufferSnapshot(buffer)));
  }

  views(): readonly WorkbenchViewStateSnapshot[] {
    return Object.freeze([...this.#views.values()].map((view) => this.viewSnapshot(view)).filter((item): item is WorkbenchViewStateSnapshot => item !== undefined));
  }

  /** Publish the immutable split tree and view identities to the UI adapter. */
  readLayout(): WorkbenchLayoutRead {
    this.#layoutReadCache ??= Object.freeze({ split: this.splitSnapshot() });
    return this.#layoutReadCache;
  }

  /** Pinning is the explicit preview promotion operation. First edit also promotes it. */
  promoteBuffer(bufferId: DocumentId): Result<WorkbenchBufferSnapshot, WorkbenchSessionFailure> {
    const buffer = this.#buffers.get(bufferId);
    if (buffer === undefined) return { ok: false, error: { kind: 'buffer-not-found', bufferId } };
    buffer.preview = false;
    buffer.pinned = true;
    return { ok: true, value: this.bufferSnapshot(buffer) };
  }

  pinBuffer(bufferId: DocumentId): Result<WorkbenchBufferSnapshot, WorkbenchSessionFailure> {
    return this.promoteBuffer(bufferId);
  }

  /** Activate (focus) a buffer for a tab-strip click: focuses one of its existing views,
   * preferring the currently active view if it already shows the buffer. */
  activateBuffer(bufferId: DocumentId): Result<void, WorkbenchSessionFailure> {
    const buffer = this.#buffers.get(bufferId);
    if (buffer === undefined) return { ok: false, error: { kind: 'buffer-not-found', bufferId } };
    const activeView = this.#activeViewId === undefined ? undefined : this.#views.get(this.#activeViewId);
    const viewId = activeView?.bufferId === bufferId ? this.#activeViewId : [...buffer.viewIds][0];
    if (viewId === undefined) return { ok: false, error: { kind: 'buffer-not-found', bufferId } };
    return this.focus(viewId);
  }

  /** Ordered read model for a tab strip; another agent's UI renders it. */
  readTabs(): readonly WorkbenchTabSnapshot[] {
    const activeBufferId = this.#activeViewId === undefined ? undefined : this.#views.get(this.#activeViewId)?.bufferId;
    return Object.freeze([...this.#buffers.values()].map((buffer) => Object.freeze({
      id: buffer.bufferId,
      label: buffer.path === undefined ? '[No Name]' : (buffer.path.split('/').pop() ?? buffer.path),
      dirty: buffer.document.isDirty,
      preview: buffer.preview,
      pinned: buffer.pinned,
      active: buffer.bufferId === activeBufferId,
    })));
  }

  /** Update an open buffer's display/save path after a coordinated file rename. */
  renameBufferPath(bufferId: DocumentId, path: string): Result<WorkbenchBufferSnapshot, WorkbenchSessionFailure> {
    const buffer = this.#buffers.get(bufferId);
    if (buffer === undefined) return { ok: false, error: { kind: 'buffer-not-found', bufferId } };
    if (path.length === 0 || path.includes('\0')) return { ok: false, error: { kind: 'invalid-layout', message: 'buffer path must be nonempty and NUL-free' } };
    buffer.path = path;
    return { ok: true, value: this.bufferSnapshot(buffer) };
  }

  /** Create a second view sharing the same coordinator, document and undo tree. */
  splitView(viewId: ViewId, orientation: SplitOrientation, requestedViewId?: ViewId): Result<WorkbenchViewStateSnapshot, WorkbenchSessionFailure> {
    const source = this.#views.get(viewId);
    if (source === undefined) return { ok: false, error: { kind: 'view-not-found', viewId } };
    const buffer = this.#buffers.get(source.bufferId);
    if (buffer === undefined) return { ok: false, error: { kind: 'buffer-not-found', bufferId: source.bufferId } };
    const newViewId = requestedViewId ?? this.newViewId(source.bufferId);
    if (this.#views.has(newViewId)) return { ok: false, error: { kind: 'duplicate-view', viewId: newViewId } };
    const oldState = buffer.coordinator.readState();
    const sourceState = oldState.views.find((view) => view.viewId === viewId);
    if (sourceState === undefined) return { ok: false, error: { kind: 'view-not-found', viewId } };
    const stateResult = buffer.coordinator.replaceState({
      activeViewId: oldState.activeViewId,
      views: [...oldState.views, Object.freeze({ ...sourceState, viewId: newViewId })],
      registers: oldState.registers,
    });
    if (!stateResult.ok) return { ok: false, error: { kind: 'invalid-layout', message: stateResult.error.kind } };
    const paneId = this.newNodeId('pane');
    this.#views.set(newViewId, { viewId: newViewId, bufferId: source.bufferId, paneId, scrollTop: source.scrollTop, scrollLeft: source.scrollLeft });
    buffer.viewIds.add(newViewId);
    const leaf = findLeaf(this.#root, viewId);
    if (leaf === undefined) return { ok: false, error: { kind: 'invalid-layout', message: `view ${viewId} is not in split tree` } };
    this.#root = replaceNode(this.#root, leaf.nodeId, {
      kind: 'split', nodeId: this.newNodeId('split'), orientation, ratio: 0.5,
      first: leaf, second: { kind: 'leaf', nodeId: this.newNodeId('leaf'), viewId: newViewId },
    });
    this.invalidateLayoutRead();
    this.#activeViewId = newViewId;
    return { ok: true, value: this.viewSnapshot(this.#views.get(newViewId) as ViewRecord) as WorkbenchViewStateSnapshot };
  }

  createSplit(viewId: ViewId, orientation: SplitOrientation, requestedViewId?: ViewId): Result<WorkbenchViewStateSnapshot, WorkbenchSessionFailure> {
    return this.splitView(viewId, orientation, requestedViewId);
  }

  focus(viewId: ViewId): Result<void, WorkbenchSessionFailure> {
    const view = this.#views.get(viewId);
    if (view === undefined) return { ok: false, error: { kind: 'view-not-found', viewId } };
    if (findLeaf(this.#root, viewId) === undefined && this.#activeViewId !== undefined) {
      this.#root = replaceLeafView(this.#root, this.#activeViewId, viewId);
      this.invalidateLayoutRead();
    }
    const buffer = this.#buffers.get(view.bufferId);
    if (buffer === undefined) return { ok: false, error: { kind: 'buffer-not-found', bufferId: view.bufferId } };
    const state = buffer.coordinator.readState();
    if (state.activeViewId !== viewId) {
      const focused = buffer.coordinator.replaceState({ activeViewId: viewId, views: state.views, registers: state.registers });
      if (!focused.ok) return { ok: false, error: { kind: 'invalid-layout', message: focused.error.kind } };
    }
    if (this.#activeViewId !== undefined && this.#activeViewId !== viewId) {
      const previous = this.#views.get(this.#activeViewId);
      if (previous !== undefined && previous.bufferId !== view.bufferId) this.#alternateBufferId = previous.bufferId;
    }
    this.#activeViewId = viewId;
    return { ok: true, value: undefined };
  }

  /** Vim's alternate file (`#`, Ctrl-^): the buffer that was active before the current one. */
  alternateBufferPath(): string | undefined {
    const id = this.#alternateBufferId;
    if (id === undefined) return undefined;
    const buffer = this.#buffers.get(id);
    return buffer?.path;
  }

  /** Focus an editor window using the split tree, never a panel focus target. */
  focusAdjacent(viewId: ViewId, direction: WorkbenchWindowDirection): Result<ViewId, WorkbenchSessionFailure> {
    if (!this.#views.has(viewId)) return { ok: false, error: { kind: 'view-not-found', viewId } };
    const leaves = collectLeaves(this.#root);
    if (leaves.length === 0) return { ok: false, error: { kind: 'view-not-found', viewId } };
    const index = leaves.findIndex((leaf) => leaf.viewId === viewId);
    if (index < 0) return { ok: false, error: { kind: 'view-not-found', viewId } };
    let target: ViewId | undefined;
    if (direction === 'next' || direction === 'previous') {
      const delta = direction === 'next' ? 1 : -1;
      target = leaves[(index + delta + leaves.length) % leaves.length]?.viewId;
    } else if (direction === 'first') {
      target = leaves[0]?.viewId;
    } else if (direction === 'last') {
      target = leaves.at(-1)?.viewId;
    } else {
      target = directionalLeaf(this.#root, viewId, direction)?.viewId;
    }
    const focused = this.focus(target ?? viewId);
    return focused.ok ? { ok: true, value: target ?? viewId } : focused as Result<ViewId, WorkbenchSessionFailure>;
  }

  /** Keep one native editor window and close its siblings with the caller's decision. */
  closeOtherViews(viewId: ViewId, decision: CloseDecision = 'discard'): Result<void, WorkbenchSessionFailure> {
    if (!this.#views.has(viewId)) return { ok: false, error: { kind: 'view-not-found', viewId } };
    for (const candidate of [...this.#views.keys()]) {
      if (candidate === viewId) continue;
      const closed = this.closeView(candidate, decision);
      if (!closed.ok) return closed;
    }
    return this.focus(viewId);
  }

  /** The UI reports each view's laid-out height so H/M/L and page scrolling address the real
   * viewport; the height is read-only state, never a layout input, so no read cache keys on it. */
  setViewViewportHeight(viewId: ViewId, viewportHeight: number): void {
    const view = this.#views.get(viewId);
    if (view === undefined || !Number.isSafeInteger(viewportHeight) || viewportHeight < 1) return;
    view.viewportHeight = viewportHeight;
  }

  viewViewportHeight(viewId: ViewId): number | undefined {
    return this.#views.get(viewId)?.viewportHeight;
  }

  setViewScroll(viewId: ViewId, scrollTop: number, scrollLeft = 0): Result<WorkbenchViewStateSnapshot, WorkbenchSessionFailure> {
    const view = this.#views.get(viewId);
    if (view === undefined) return { ok: false, error: { kind: 'view-not-found', viewId } };
    if (!Number.isSafeInteger(scrollTop) || scrollTop < 0 || !Number.isSafeInteger(scrollLeft) || scrollLeft < 0) {
      return { ok: false, error: { kind: 'invalid-layout', message: 'scroll positions must be nonnegative safe integers' } };
    }
    view.scrollTop = scrollTop;
    view.scrollLeft = scrollLeft;
    const snapshot = this.viewSnapshot(view);
    return snapshot === undefined ? { ok: false, error: { kind: 'view-not-found', viewId } } : { ok: true, value: snapshot };
  }

  closeView(viewId: ViewId, decision?: CloseDecision): Result<{ readonly closed: boolean; readonly activeViewId: ViewId | undefined }, WorkbenchSessionFailure> {
    const view = this.#views.get(viewId);
    if (view === undefined) return { ok: false, error: { kind: 'view-not-found', viewId } };
    const buffer = this.#buffers.get(view.bufferId);
    if (buffer === undefined) return { ok: false, error: { kind: 'buffer-not-found', bufferId: view.bufferId } };
    if (buffer.document.isDirty && decision === undefined) {
      return { ok: false, error: { kind: 'dirty-buffer', bufferId: buffer.bufferId, choices: ['save', 'keep-open', 'discard'] } };
    }
    if (decision === 'cancel' || decision === 'keep-open') return { ok: true, value: { closed: false, activeViewId: this.#activeViewId } };
    if (decision === 'save') {
      if (this.#saveBuffer === undefined) return { ok: false, error: { kind: 'save-unavailable', bufferId: buffer.bufferId } };
      const saved = this.#saveBuffer(this.bufferSnapshot(buffer));
      if (saved instanceof Promise) return { ok: false, error: { kind: 'save-unavailable', bufferId: buffer.bufferId } };
      if (!saved.ok) return { ok: false, error: { kind: 'save-failed', bufferId: buffer.bufferId, message: saved.error } };
    }
    if (buffer.viewIds.size > 1) {
      buffer.viewIds.delete(viewId);
      const state = buffer.coordinator.readState();
      const replaced = buffer.coordinator.replaceState({ activeViewId: state.activeViewId === viewId ? (state.views.find((candidate) => candidate.viewId !== viewId)?.viewId as ViewId) : state.activeViewId, views: state.views.filter((candidate) => candidate.viewId !== viewId), registers: state.registers });
      if (!replaced.ok) return { ok: false, error: { kind: 'invalid-layout', message: replaced.error.kind } };
      this.#views.delete(viewId);
    this.#root = removeViewFromTree(this.#root, viewId, view.returnViewId, this.#views);
    this.invalidateLayoutRead();
      if (this.#activeViewId === viewId) this.#activeViewId = view.returnViewId !== undefined && this.#views.has(view.returnViewId)
        ? view.returnViewId
        : firstView(this.#views);
      return { ok: true, value: { closed: true, activeViewId: this.#activeViewId } };
    }
    return this.closeBuffer(view.bufferId, decision === undefined ? 'discard' : decision);
  }

  async closeViewAsync(viewId: ViewId, decision: CloseDecision = 'cancel'): Promise<Result<{ readonly closed: boolean; readonly activeViewId: ViewId | undefined }, WorkbenchSessionFailure>> {
    if (decision !== 'save') return this.closeView(viewId, decision);
    const view = this.#views.get(viewId);
    if (view === undefined) return { ok: false, error: { kind: 'view-not-found', viewId } };
    const buffer = this.#buffers.get(view.bufferId);
    if (buffer === undefined) return { ok: false, error: { kind: 'buffer-not-found', bufferId: view.bufferId } };
    if (this.#saveBuffer === undefined) return { ok: false, error: { kind: 'save-unavailable', bufferId: buffer.bufferId } };
    const saved = await this.#saveBuffer(this.bufferSnapshot(buffer));
    if (!saved.ok) return { ok: false, error: { kind: 'save-failed', bufferId: buffer.bufferId, message: saved.error } };
    return this.closeView(viewId, 'discard');
  }

  closeBuffer(bufferId: DocumentId, decision?: CloseDecision): Result<{ readonly closed: boolean; readonly activeViewId: ViewId | undefined }, WorkbenchSessionFailure> {
    const buffer = this.#buffers.get(bufferId);
    if (buffer === undefined) return { ok: false, error: { kind: 'buffer-not-found', bufferId } };
    if (buffer.document.isDirty && decision === undefined) return { ok: false, error: { kind: 'dirty-buffer', bufferId, choices: ['save', 'keep-open', 'discard'] } };
    if (decision === 'cancel' || decision === 'keep-open') return { ok: true, value: { closed: false, activeViewId: this.#activeViewId } };
    if (decision === 'save') {
      if (this.#saveBuffer === undefined) return { ok: false, error: { kind: 'save-unavailable', bufferId } };
      const saved = this.#saveBuffer(this.bufferSnapshot(buffer));
      if (saved instanceof Promise) return { ok: false, error: { kind: 'save-unavailable', bufferId } };
      if (!saved.ok) return { ok: false, error: { kind: 'save-failed', bufferId, message: saved.error } };
    }
    for (const viewId of buffer.viewIds) {
      const view = this.#views.get(viewId);
      this.#views.delete(viewId);
      this.#root = removeViewFromTree(this.#root, viewId, view?.returnViewId, this.#views);
    }
    buffer.changeSubscription.dispose();
    buffer.coordinator.dispose();
    this.#buffers.delete(bufferId);
    this.#activeViewId = firstView(this.#views);
    return { ok: true, value: { closed: true, activeViewId: this.#activeViewId } };
  }

  async closeBufferAsync(bufferId: DocumentId, decision: CloseDecision = 'cancel'): Promise<Result<{ readonly closed: boolean; readonly activeViewId: ViewId | undefined }, WorkbenchSessionFailure>> {
    if (decision !== 'save') return this.closeBuffer(bufferId, decision);
    const buffer = this.#buffers.get(bufferId);
    if (buffer === undefined) return { ok: false, error: { kind: 'buffer-not-found', bufferId } };
    if (this.#saveBuffer === undefined) return { ok: false, error: { kind: 'save-unavailable', bufferId } };
    const saved = await this.#saveBuffer(this.bufferSnapshot(buffer));
    if (!saved.ok) return { ok: false, error: { kind: 'save-failed', bufferId, message: saved.error } };
    return this.closeBuffer(bufferId, 'discard');
  }

  /** Apply one versioned batch through the owned coordinator. Every view maps through the same change map. */
  async applyTextEdits(viewId: ViewId, edits: readonly DocumentEdit[], undoGroup: UndoGroupId = defaultUndoGroup(), origin: EditOrigin = 'vim', focus = true): Promise<Result<{ readonly version: DocumentVersion; readonly editCount: number }, WorkbenchSessionFailure>> {
    const view = this.#views.get(viewId);
    if (view === undefined) return { ok: false, error: { kind: 'view-not-found', viewId } };
    const buffer = this.#buffers.get(view.bufferId);
    if (buffer === undefined) return { ok: false, error: { kind: 'buffer-not-found', bufferId: view.bufferId } };
    if (focus && this.#activeViewId !== viewId) {
      const focused = this.focus(viewId);
      if (!focused.ok) return focused;
    }
    const wasPreview = buffer.preview;
    const activeState = buffer.coordinator.readState();
    const active = activeState.views.find((candidate) => candidate.viewId === viewId);
    if (active === undefined) return { ok: false, error: { kind: 'view-not-found', viewId } };
    const result = await buffer.coordinator.execute({
      intent: Object.freeze({ kind: 'workbench-text-edits' }),
      undoGroup,
      origin,
      mapActiveSelectionThroughChange: origin !== 'vim',
      resolveMember: (_base, member, index) => ({ nextSelection: selectionInput(member), edits: index === 0 ? edits : [] }),
    });
    if (!result.ok) {
      const cause = result.error.kind === 'document-commit-failed' && typeof result.error.cause === 'object' ? result.error.cause : { kind: 'invalid-proposal' } as DocumentTransactionFailure;
      return { ok: false, error: { kind: 'invalid-edit', cause } };
    }
    if (wasPreview && result.value.editCount > 0) this.promoteBuffer(buffer.bufferId);
    return { ok: true, value: { version: result.value.documentVersion, editCount: result.value.editCount } };
  }

  /** Open a persistent document undo group for a service edit sequence, such as completion plus snippet typing. */
  beginUndoGroup(viewId: ViewId, undoGroup: UndoGroupId, origin: EditOrigin = 'lsp'): Result<void, WorkbenchSessionFailure> {
    const view = this.#views.get(viewId);
    const buffer = view === undefined ? undefined : this.#buffers.get(view.bufferId);
    if (view === undefined) return { ok: false, error: { kind: 'view-not-found', viewId } };
    if (buffer === undefined) return { ok: false, error: { kind: 'buffer-not-found', bufferId: view.bufferId } };
    const opened = buffer.document.beginUndoGroup(undoGroup, origin);
    return opened.ok ? { ok: true, value: undefined } : { ok: false, error: { kind: 'invalid-layout', message: `undo group could not open: ${opened.error.kind}` } };
  }

  /** Close a persistent service edit group; callers may safely ignore a stale close after an external origin took over. */
  endUndoGroup(viewId: ViewId, undoGroup: UndoGroupId): Result<void, WorkbenchSessionFailure> {
    const view = this.#views.get(viewId);
    const buffer = view === undefined ? undefined : this.#buffers.get(view.bufferId);
    if (view === undefined) return { ok: false, error: { kind: 'view-not-found', viewId } };
    if (buffer === undefined) return { ok: false, error: { kind: 'buffer-not-found', bufferId: view.bufferId } };
    const closed = buffer.document.endUndoGroup(undoGroup);
    return closed.ok ? { ok: true, value: undefined } : { ok: false, error: { kind: 'invalid-layout', message: `undo group could not close: ${closed.error.kind}` } };
  }

  /** Apply a service proposal to an open buffer without stealing editor focus. */
  async applyDocumentEdits(documentId: DocumentId, edits: readonly DocumentEdit[], undoGroup: UndoGroupId = defaultUndoGroup(), origin: EditOrigin = 'lsp'): Promise<Result<{ readonly version: DocumentVersion; readonly editCount: number }, WorkbenchSessionFailure>> {
    const buffer = this.#buffers.get(documentId);
    if (buffer === undefined) return { ok: false, error: { kind: 'buffer-not-found', bufferId: documentId } };
    const viewId = buffer.viewIds.values().next().value;
    if (viewId === undefined) return { ok: false, error: { kind: 'invalid-layout', message: 'buffer has no view' } };
    return this.applyTextEdits(viewId, edits, undoGroup, origin, false);
  }

  /** Read-only workbench boundary consumed by the UI adapter. Cached until the coordinator state or document snapshot changes. */
  readView(viewId: ViewId): WorkbenchReadView | undefined {
    const view = this.#views.get(viewId);
    if (view === undefined) return undefined;
    const buffer = this.#buffers.get(view.bufferId);
    if (buffer === undefined) return undefined;
    const coordinatorState = buffer.coordinator.readState();
    const document = buffer.document.snapshot();
    const cached = this.#readViewCache.get(viewId);
    if (cached !== undefined && cached.state === coordinatorState && cached.document === document
      && cached.scrollTop === view.scrollTop && cached.scrollLeft === view.scrollLeft) return cached.result;
    const target = coordinatorState.views.find((candidate) => candidate.viewId === viewId);
    if (target === undefined) { this.#readViewCache.delete(viewId); return undefined; }
    const result: WorkbenchReadView = Object.freeze({
      session: Object.freeze({ viewId, documentId: document.id, documentVersion: document.version, selections: target.selections, mode: publicMode(target.mode) }),
      document,
      selections: target.selections,
      scrollTop: view.scrollTop,
      scrollLeft: view.scrollLeft,
    });
    this.#readViewCache.set(viewId, { state: coordinatorState, document, scrollTop: view.scrollTop, scrollLeft: view.scrollLeft, result });
    return result;
  }

  /** Install the engine-owned state for one view without taking ownership of text or parsing. */
  syncViewSession(
    viewId: ViewId,
    selections: SelectionSet,
    mode: VimMode,
  ): Result<void, WorkbenchSessionFailure> {
    const view = this.#views.get(viewId);
    if (view === undefined) return { ok: false, error: { kind: 'view-not-found', viewId } };
    const buffer = this.#buffers.get(view.bufferId);
    if (buffer === undefined) return { ok: false, error: { kind: 'buffer-not-found', bufferId: view.bufferId } };
    const state = buffer.coordinator.readState();
    const target = state.views.find((candidate) => candidate.viewId === viewId);
    if (target === undefined) return { ok: false, error: { kind: 'view-not-found', viewId } };
    if (target.selections === selections && target.mode === mode) return { ok: true, value: undefined };
    const replaced = buffer.coordinator.replaceState({
      activeViewId: state.activeViewId,
      views: state.views.map((candidate) => candidate.viewId === viewId
        ? Object.freeze({ ...candidate, selections, mode })
        : candidate),
      registers: state.registers,
    });
    return replaced.ok ? { ok: true, value: undefined } : { ok: false, error: { kind: 'invalid-layout', message: replaced.error.kind } };
  }

  readDocument(viewId: ViewId): DocumentReadPort | undefined {
    const view = this.#views.get(viewId);
    return view === undefined ? undefined : this.#buffers.get(view.bufferId)?.document;
  }

  snapshot(viewId: ViewId): VimSessionSnapshot | undefined {
    return this.readView(viewId)?.session;
  }

  /** Capture each live view's selection and scroll state without copying text. */
  captureSelectionPersistence(contentHashes: ReadonlyMap<string, string>): Result<SelectionPersistenceSnapshot, SelectionPersistenceFailure> {
    const views: PersistedViewSelection[] = [];
    for (const view of this.#views.values()) {
      const read = this.readView(view.viewId);
      if (read === undefined) return { ok: false, error: { kind: 'closed-view', message: `view ${view.viewId} is no longer open` } };
      const documentId = String(read.document.id);
      const contentHash = contentHashes.get(documentId);
      if (contentHash === undefined) return { ok: false, error: { kind: 'changed-content', message: `document ${documentId} has no content identity` } };
      views.push(Object.freeze({
        viewId: String(view.viewId),
        documentId,
        contentHash,
        documentVersion: Number(read.document.version),
        scrollTop: view.scrollTop,
        scrollLeft: view.scrollLeft,
        primaryId: String(read.selections.primaryId),
        members: Object.freeze(read.selections.members.map((member) => Object.freeze({
          id: String(member.id),
          anchor: Number(member.anchor.at.offset),
          head: Number(member.head.at.offset),
          kind: member.kind,
        }))),
      }));
    }
    return { ok: true, value: Object.freeze({ schemaVersion: 1, views: Object.freeze(views) }) };
  }

  /** Decode, validate and install selection values only after content identities match. */
  restoreSelectionPersistence(input: Uint8Array | SelectionPersistenceSnapshot, contentHashes: ReadonlyMap<string, string>): Result<SelectionPersistenceSnapshot, SelectionPersistenceFailure | WorkbenchSessionFailure> {
    const decoded = input instanceof Uint8Array ? this.#selectionPersistence.decode(input) : { ok: true as const, value: input };
    if (!decoded.ok) return decoded;
    const valid = this.#selectionPersistence.restore(decoded.value, {
      openViewIds: new Set([...this.#views.keys()].map(String)),
      contentHashes,
    });
    if (!valid.ok) return valid;
    const nextStates: Array<{ readonly view: ViewRecord; readonly selections: SelectionSet }> = [];
    for (const persisted of valid.value) {
      const view = this.#views.get(persisted.viewId as ViewId);
      if (view === undefined) return { ok: false, error: { kind: 'missing-restored-view', viewId: persisted.viewId } };
      const buffer = this.#buffers.get(view.bufferId);
      if (buffer === undefined) return { ok: false, error: { kind: 'missing-restored-buffer', bufferId: String(view.bufferId), path: '' } };
      const state = buffer.coordinator.readState().views.find((candidate) => candidate.viewId === view.viewId);
      if (state === undefined) return { ok: false, error: { kind: 'missing-restored-view', viewId: persisted.viewId } };
      if (String(buffer.document.id) !== persisted.documentId) return { ok: false, error: { kind: 'invalid-layout', message: `view ${persisted.viewId} document identity changed` } };
      const restoredMembers: SelectionMemberInput[] = [];
      for (const member of persisted.members) {
        const current = state.selections.members.find((candidate) => String(candidate.id) === member.id);
        if (current === undefined || current.kind !== member.kind) return { ok: false, error: { kind: 'invalid-layout', message: `selection ${member.id} is not compatible with view ${persisted.viewId}` } };
        const anchor = restoreEndpoint(buffer.document.snapshot(), current.anchor, member.anchor);
        const head = restoreEndpoint(buffer.document.snapshot(), current.head, member.head);
        if (anchor === undefined || head === undefined) return { ok: false, error: { kind: 'invalid-layout', message: `selection ${member.id} has invalid coordinates` } };
        restoredMembers.push({ ...selectionInput(current), anchor, head });
      }
      const rebuilt = createSelectionSet(buffer.document.snapshot(), {
        primaryId: memberId(persisted.primaryId),
        members: restoredMembers,
        selectionGeneration: Number(state.selections.selectionGeneration) + 1,
      });
      if (!rebuilt.ok) return { ok: false, error: { kind: 'invalid-layout', message: `selection restore failed: ${rebuilt.error.kind}` } };
      nextStates.push({ view, selections: rebuilt.value.selectionSet });
    }
    for (const restored of nextStates) {
      const buffer = this.#buffers.get(restored.view.bufferId);
      if (buffer === undefined) continue;
      const state = buffer.coordinator.readState();
      const replaced = buffer.coordinator.replaceState({
        activeViewId: state.activeViewId,
        views: state.views.map((candidate) => candidate.viewId === restored.view.viewId ? Object.freeze({ ...candidate, selections: restored.selections }) : candidate),
        registers: state.registers,
      });
      if (!replaced.ok) return { ok: false, error: { kind: 'invalid-layout', message: replaced.error.kind } };
      const persisted = valid.value.find((candidate) => candidate.viewId === String(restored.view.viewId));
      if (persisted !== undefined) { restored.view.scrollTop = persisted.scrollTop; restored.view.scrollLeft = persisted.scrollLeft; }
    }
    return { ok: true, value: decoded.value };
  }

  splitSnapshot(): WorkbenchSplitSnapshot {
    return Object.freeze({ root: cloneSplit(this.#root), minimumPaneSize: this.#minimumPaneSize });
  }

  resizeSplit(nodeId: string, ratio: number, availableCells: number): Result<WorkbenchSplitSnapshot, WorkbenchSessionFailure> {
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1 || !Number.isSafeInteger(availableCells) || availableCells < 2) return { ok: false, error: { kind: 'invalid-layout', message: 'split ratio and available cells are invalid' } };
    const branch = findBranch(this.#root, nodeId);
    if (branch === undefined) return { ok: false, error: { kind: 'invalid-layout', message: `split node ${nodeId} not found` } };
    const firstSize = Math.floor(availableCells * ratio);
    const secondSize = availableCells - firstSize;
    if (firstSize < this.#minimumPaneSize || secondSize < this.#minimumPaneSize) return { ok: false, error: { kind: 'split-too-small', nodeId, firstSize, secondSize, minimum: this.#minimumPaneSize } };
    this.#root = replaceNode(this.#root, nodeId, { ...branch, ratio });
    this.invalidateLayoutRead();
    return { ok: true, value: this.splitSnapshot() };
  }

  layoutSnapshot(): WorkbenchLayoutSnapshot {
    const buffers: WorkbenchLayoutBuffer[] = [...this.#buffers.values()].map((buffer) => Object.freeze({ bufferId: buffer.bufferId, path: buffer.path ?? '', preview: buffer.preview, pinned: buffer.pinned, viewIds: Object.freeze([...buffer.viewIds]) }));
    const viewStates: WorkbenchLayoutViewState[] = [...this.#views.values()].map((view) => Object.freeze({ viewId: view.viewId, bufferId: view.bufferId, scrollTop: view.scrollTop, scrollLeft: view.scrollLeft }));
    return Object.freeze({ schemaVersion: LAYOUT_SCHEMA_VERSION, workspaceId: this.#workspaceId, ...(this.#activeViewId === undefined ? {} : { activeViewId: this.#activeViewId }), buffers: Object.freeze(buffers), viewStates: Object.freeze(viewStates), split: this.splitSnapshot() });
  }

  serializeLayout(): string { return JSON.stringify(this.layoutSnapshot()); }

  async saveLayout(): Promise<Result<void, WorkbenchSessionFailure>> {
    if (this.#layoutStore === undefined) return { ok: false, error: { kind: 'save-unavailable', bufferId: '' as DocumentId } };
    const result = await this.#layoutStore.write(this.layoutSnapshot());
    return result.ok ? result : { ok: false, error: { kind: 'save-failed', bufferId: '' as DocumentId, message: result.error } };
  }

  async loadLayout(): Promise<Result<WorkbenchLayoutSnapshot, WorkbenchSessionFailure>> {
    if (this.#layoutStore === undefined) return { ok: false, error: { kind: 'invalid-layout', message: 'no layout store configured' } };
    const result = await this.#layoutStore.read();
    if (!result.ok) return { ok: false, error: { kind: 'invalid-layout', message: result.error } };
    return this.restoreLayout(result.value);
  }

  /** Restore geometry and identities only. Recovery text is never read or replaced here. */
  restoreLayout(input: unknown): Result<WorkbenchLayoutSnapshot, WorkbenchSessionFailure> {
    const decoded = decodeLayout(input);
    if (!decoded.ok) return decoded;
    if (decoded.value.workspaceId !== this.#workspaceId) return { ok: false, error: { kind: 'invalid-layout', message: 'workspace identity mismatch' } };
    for (const item of decoded.value.buffers) {
      const existing = this.#buffers.get(item.bufferId);
      if (existing === undefined) return { ok: false, error: { kind: 'missing-restored-buffer', bufferId: item.bufferId, path: item.path } };
      for (const viewId of item.viewIds) if (!this.#views.has(viewId)) return { ok: false, error: { kind: 'missing-restored-view', viewId } };
    }
    const leaves = collectLeaves(decoded.value.split.root);
    for (const leaf of leaves) if (!this.#views.has(leaf.viewId)) return { ok: false, error: { kind: 'missing-restored-view', viewId: leaf.viewId } };
    const viewIds = new Set(leaves.map((leaf) => leaf.viewId));
    if (decoded.value.activeViewId !== undefined && !this.#views.has(decoded.value.activeViewId)) return { ok: false, error: { kind: 'missing-restored-view', viewId: decoded.value.activeViewId } };
    if (decoded.value.activeViewId !== undefined && !viewIds.has(decoded.value.activeViewId)) return { ok: false, error: { kind: 'invalid-layout', message: 'active view is hidden from the split tree' } };
    for (const viewState of decoded.value.viewStates) {
      const view = this.#views.get(viewState.viewId);
      if (view === undefined) return { ok: false, error: { kind: 'missing-restored-view', viewId: viewState.viewId } };
      if (view.bufferId !== viewState.bufferId) return { ok: false, error: { kind: 'invalid-layout', message: `view ${viewState.viewId} belongs to a different buffer` } };
    }
    for (const item of decoded.value.buffers) {
      const buffer = this.#buffers.get(item.bufferId);
      if (buffer === undefined) continue;
      buffer.preview = item.preview;
      buffer.pinned = item.pinned;
    }
    for (const viewState of decoded.value.viewStates) {
      const view = this.#views.get(viewState.viewId);
      if (view !== undefined) { view.scrollTop = viewState.scrollTop; view.scrollLeft = viewState.scrollLeft; }
    }
    this.#root = cloneSplit(decoded.value.split.root);
    this.invalidateLayoutRead();
    this.#activeViewId = decoded.value.activeViewId;
    return { ok: true, value: this.layoutSnapshot() };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const buffer of this.#buffers.values()) {
      buffer.changeSubscription.dispose();
      buffer.coordinator.dispose();
    }
    this.#buffers.clear();
    this.#views.clear();
    this.#root = undefined;
    this.invalidateLayoutRead();
    this.#activeViewId = undefined;
  }

  private ensureLive(): Result<void, WorkbenchSessionFailure> {
    return this.#disposed ? { ok: false, error: { kind: 'session-disposed' } } : { ok: true, value: undefined };
  }

  private invalidateLayoutRead(): void { this.#layoutReadCache = undefined; }

  private bufferSnapshot(buffer: BufferRecord): WorkbenchBufferSnapshot {
    const snapshot = buffer.document.snapshot();
    return Object.freeze({ bufferId: buffer.bufferId, path: buffer.path, documentId: snapshot.id, documentVersion: snapshot.version, revisionId: snapshot.revisionId, dirty: buffer.document.isDirty, preview: buffer.preview, pinned: buffer.pinned, viewIds: Object.freeze([...buffer.viewIds]) });
  }

  private viewSnapshot(view: ViewRecord): WorkbenchViewStateSnapshot | undefined {
    const read = this.readView(view.viewId);
    if (read === undefined) { this.#viewSnapshotCache.delete(view.viewId); return undefined; }
    const cached = this.#viewSnapshotCache.get(view.viewId);
    if (cached !== undefined && cached.read === read && cached.paneId === view.paneId && cached.scrollTop === view.scrollTop && cached.scrollLeft === view.scrollLeft) {
      return cached.result;
    }
    const result = Object.freeze({ viewId: view.viewId, bufferId: view.bufferId, paneId: view.paneId, scrollTop: view.scrollTop, scrollLeft: view.scrollLeft, session: read.session });
    this.#viewSnapshotCache.set(view.viewId, { read, paneId: view.paneId, scrollTop: view.scrollTop, scrollLeft: view.scrollLeft, result });
    return result;
  }

  private mapExternalChange(buffer: BufferRecord, change: CommittedDocumentChange): void {
    if (this.#disposed || this.#buffers.get(buffer.bufferId) !== buffer) return;
    const state = buffer.coordinator.readState();
    // A vim-origin commit on a buffer with exactly one view is about to be
    // followed, synchronously within the same handleKey call, by that view's
    // own syncViewSession publishing the authoritative post-command
    // selections/mode. Mapping and replacing state here would just be
    // discarded work (see docs/plan/15-keystroke-latency.md). A buffer with
    // more than one view still needs every stale view mapped below, since
    // only the active view gets an authoritative sync.
    if (change.origin === 'vim' && state.views.length <= 1) {
      this.#onDocumentChange?.(change);
      return;
    }
    const views: AtomicViewState[] = [];
    let changed = false;
    for (const view of state.views) {
      if (view.selections.documentVersion === change.after) { views.push(view); continue; }
      if (view.selections.documentVersion !== change.before) { views.push(view); continue; }
      const mapped = mapSelectionSet(view.selections, change.changeMap, change.snapshot);
      if (!mapped.ok) { views.push(view); continue; }
      views.push(Object.freeze({ ...view, selections: mapped.value.selectionSet }));
      changed = true;
    }
    if (changed) buffer.coordinator.replaceState({ activeViewId: state.activeViewId, views, registers: state.registers });
    this.#onDocumentChange?.(change);
  }

  private newViewId(bufferId: DocumentId): ViewId {
    let candidate = `${bufferId}:view-${this.#nextView++}`;
    while (this.#views.has(candidate as ViewId)) candidate = `${bufferId}:view-${this.#nextView++}`;
    return candidate as ViewId;
  }

  private newNodeId(prefix: string): string { return `${prefix}-${this.#nextNode++}`; }
}

/** Buffer registry name used by integrations that do not need split methods. */
export { WorkbenchSession as BufferRegistry };

// Monotonic, not wall-clock: two edits applied within the same millisecond must still get
// distinct default undo groups.
let nextUndoGroupSequence = 0;
function defaultUndoGroup(): UndoGroupId {
  nextUndoGroupSequence += 1;
  return `workbench-${nextUndoGroupSequence}` as UndoGroupId;
}

function createInitialSelection(snapshot: DocumentSnapshot, viewId: ViewId): Result<SelectionSet, { readonly kind: string }> {
  const id = `${viewId}:primary` as SelectionId;
  const first = snapshot.lengthUtf16 === 0 ? { kind: 'eof' as const } : { kind: 'character' as const, offset: 0 as never, after: firstScalarEnd(snapshot) as never };
  const selection = createSelectionSet(snapshot, { primaryId: id, members: [{ id, kind: 'normal-cursor', direction: 'forward', anchor: first, head: first }] });
  return selection.ok ? { ok: true, value: selection.value.selectionSet } : { ok: false, error: { kind: selection.error.kind } };
}

function firstScalarEnd(snapshot: DocumentSnapshot): number {
  const first = snapshot.slice(0 as never, 1 as never);
  if (!first.ok || first.value.length === 0) return 1;
  const unit = first.value.charCodeAt(0);
  return unit >= 0xd800 && unit <= 0xdbff ? 2 : 1;
}

function selectionInput(member: SelectionMember): SelectionMemberInput {
  const endpoint = (value: SelectionMember['anchor']): SelectionMemberInput['anchor'] => {
    const common = { affinity: value.at.affinity };
    switch (value.kind) {
      case 'character': return { kind: 'character', offset: value.at.offset, after: value.after.offset, afterAffinity: value.after.affinity, ...common };
      case 'empty-line': return { kind: 'empty-line', lineIndex: value.lineIndex, ...common };
      case 'eof': return { kind: 'eof', ...common };
      case 'gap': return { kind: 'gap', offset: value.at.offset, ...common };
      case 'line': return { kind: 'line', lineIndex: value.lineIndex, ...common };
      case 'block-cell': return { kind: 'block-cell', offset: value.at.offset, logicalUtf16Column: value.logicalUtf16Column, displayCellColumn: value.displayCellColumn, virtualCells: value.virtualCells, ...common };
    }
  };
  const base = { id: member.id, kind: member.kind, direction: member.direction, anchor: endpoint(member.anchor), head: endpoint(member.head), desiredColumn: member.desiredColumn, creationOrdinal: member.creationOrdinal as number } as SelectionMemberInput;
  if (member.kind === 'visual-character') return { ...base, inclusive: member.inclusive, anchorDesiredColumn: member.anchorDesiredColumn } as SelectionMemberInput;
  if (member.kind === 'visual-line' || member.kind === 'visual-block') return { ...base, anchorDesiredColumn: member.anchorDesiredColumn } as SelectionMemberInput;
  return base;
}

function memberId(value: string): SelectionId { return value as SelectionId; }

/** Rebuild a persisted coordinate against the current immutable snapshot. */
function restoreEndpoint(snapshot: DocumentSnapshot, template: SelectionMember['anchor'], rawOffset: number): EndpointInput | undefined {
  const checked = asUtf16Offset(Math.min(rawOffset, snapshot.lengthUtf16));
  if (!checked.ok) return undefined;
  const offset = checked.value;
  const affinity = template.at.affinity;
  if (template.kind === 'gap') return { kind: 'gap', offset, affinity };
  if (template.kind === 'line') {
    const line = snapshot.lineIndexAt(offset);
    return line.ok ? { kind: 'line', lineIndex: line.value, affinity } : undefined;
  }
  if (template.kind === 'block-cell') {
    const line = snapshot.lineIndexAt(offset);
    return line.ok ? { kind: 'block-cell', offset, logicalUtf16Column: template.logicalUtf16Column, displayCellColumn: template.displayCellColumn, virtualCells: template.virtualCells, affinity } : undefined;
  }
  if (template.kind === 'eof' && (offset as number) === snapshot.lengthUtf16) return { kind: 'eof', affinity };
  return semanticEndpoint(snapshot, offset, affinity);
}

function semanticEndpoint(snapshot: DocumentSnapshot, offset: import('../../contracts/src/index').Utf16Offset, affinity: 'left' | 'right'): EndpointInput | undefined {
  if ((offset as number) >= snapshot.lengthUtf16) return { kind: 'eof', affinity };
  const line = snapshot.lineIndexAt(offset);
  if (!line.ok) return undefined;
  const probeEnd = asUtf16Offset(Math.min(snapshot.lengthUtf16, (offset as number) + 2));
  if (!probeEnd.ok) return undefined;
  const probe = snapshot.slice(offset, probeEnd.value);
  if (!probe.ok) return undefined;
  if (probe.value.startsWith('\n')) return { kind: 'empty-line', lineIndex: line.value, affinity };
  const first = probe.value.charCodeAt(0);
  const width = first >= 0xd800 && first <= 0xdbff ? 2 : 1;
  const after = asUtf16Offset(Math.min(snapshot.lengthUtf16, (offset as number) + width));
  if (!after.ok) return undefined;
  return { kind: 'character', offset, after: after.value, affinity, afterAffinity: affinity };
}

function publicMode(mode: VimMode): VimSessionSnapshot['mode'] {
  return mode === 'visual-character' || mode === 'visual-line' || mode === 'visual-block' || mode === 'select-character' || mode === 'select-line' || mode === 'select-block' ? 'visual' : mode === 'virtual-replace' ? 'replace' : mode;
}

function findLeaf(node: SplitNode | undefined, viewId: ViewId): SplitLeaf | undefined {
  if (node === undefined) return undefined;
  if (node.kind === 'leaf') return node.viewId === viewId ? node : undefined;
  return findLeaf(node.first, viewId) ?? findLeaf(node.second, viewId);
}
function findBranch(node: SplitNode | undefined, nodeId: string): SplitBranch | undefined {
  if (node === undefined) return undefined;
  if (node.kind === 'split' && node.nodeId === nodeId) return node;
  return node.kind === 'split' ? findBranch(node.first, nodeId) ?? findBranch(node.second, nodeId) : undefined;
}
function replaceNode(node: SplitNode | undefined, nodeId: string, replacement: SplitNode): SplitNode | undefined {
  if (node === undefined) return undefined;
  if (node.nodeId === nodeId) return replacement;
  if (node.kind === 'leaf') return node;
  return { ...node, first: replaceNode(node.first, nodeId, replacement) ?? node.first, second: replaceNode(node.second, nodeId, replacement) ?? node.second };
}
function replaceLeafView(node: SplitNode | undefined, oldViewId: ViewId, newViewId: ViewId): SplitNode | undefined {
  if (node === undefined) return undefined;
  if (node.kind === 'leaf') return node.viewId === oldViewId ? Object.freeze({ ...node, viewId: newViewId }) : node;
  return Object.freeze({ ...node, first: replaceLeafView(node.first, oldViewId, newViewId) ?? node.first, second: replaceLeafView(node.second, oldViewId, newViewId) ?? node.second });
}
function removeViewFromTree(node: SplitNode | undefined, viewId: ViewId, returnViewId: ViewId | undefined, liveViews: ReadonlyMap<ViewId, ViewRecord>): SplitNode | undefined {
  if (returnViewId !== undefined && liveViews.has(returnViewId)) return replaceLeafView(node, viewId, returnViewId);
  return removeLeaf(node, viewId);
}

function removeLeaf(node: SplitNode | undefined, viewId: ViewId): SplitNode | undefined {
  if (node === undefined) return undefined;
  if (node.kind === 'leaf') return node.viewId === viewId ? undefined : node;
  const first = removeLeaf(node.first, viewId);
  const second = removeLeaf(node.second, viewId);
  if (first === undefined) return second;
  if (second === undefined) return first;
  return { ...node, first, second };
}
function removeBufferLeaves(node: SplitNode | undefined, viewIds: ReadonlySet<ViewId>): SplitNode | undefined {
  if (node === undefined) return undefined;
  if (node.kind === 'leaf') return viewIds.has(node.viewId) ? undefined : node;
  const first = removeBufferLeaves(node.first, viewIds);
  const second = removeBufferLeaves(node.second, viewIds);
  if (first === undefined) return second;
  if (second === undefined) return first;
  return { ...node, first, second };
}
function firstView(views: ReadonlyMap<ViewId, ViewRecord>): ViewId | undefined { return views.keys().next().value as ViewId | undefined; }
function cloneSplit(node: SplitNode | undefined): SplitNode | undefined {
  if (node === undefined) return undefined;
  return node.kind === 'leaf' ? Object.freeze({ ...node }) : Object.freeze({ ...node, first: cloneSplit(node.first) as SplitNode, second: cloneSplit(node.second) as SplitNode });
}
function collectLeaves(node: SplitNode | undefined): readonly SplitLeaf[] {
  if (node === undefined) return [];
  return node.kind === 'leaf' ? [node] : [...collectLeaves(node.first), ...collectLeaves(node.second)];
}

interface SplitPathStep { readonly branch: SplitBranch; readonly side: 'first' | 'second'; }

function directionalLeaf(node: SplitNode | undefined, viewId: ViewId, direction: Exclude<WorkbenchWindowDirection, 'next' | 'previous' | 'first' | 'last'>): SplitLeaf | undefined {
  const path = splitPath(node, viewId);
  if (path === undefined) return undefined;
  const vertical = direction === 'left' || direction === 'right';
  const towardFirst = direction === 'left' || direction === 'up';
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const step = path[index];
    if (step === undefined || (step.branch.orientation === 'vertical') !== vertical) continue;
    if (towardFirst && step.side === 'second') return edgeLeaf(step.branch.first, false, vertical);
    if (!towardFirst && step.side === 'first') return edgeLeaf(step.branch.second, true, vertical);
  }
  return undefined;
}

function splitPath(node: SplitNode | undefined, viewId: ViewId, path: SplitPathStep[] = []): readonly SplitPathStep[] | undefined {
  if (node === undefined) return undefined;
  if (node.kind === 'leaf') return node.viewId === viewId ? path : undefined;
  const first = splitPath(node.first, viewId, [...path, { branch: node, side: 'first' }]);
  return first ?? splitPath(node.second, viewId, [...path, { branch: node, side: 'second' }]);
}

function edgeLeaf(node: SplitNode, towardEnd: boolean, _vertical: boolean): SplitLeaf {
  if (node.kind === 'leaf') return node;
  return edgeLeaf(towardEnd ? node.second : node.first, towardEnd, _vertical);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function decodeLayout(input: unknown): Result<WorkbenchLayoutSnapshot, WorkbenchSessionFailure> {
  if (typeof input !== 'object' || input === null) return { ok: false, error: { kind: 'invalid-layout', message: 'layout must be an object' } };
  const value = input as Record<string, unknown>;
  if (!hasOnlyKeys(value, ['schemaVersion', 'workspaceId', 'activeViewId', 'buffers', 'viewStates', 'split']) || value.schemaVersion !== LAYOUT_SCHEMA_VERSION || typeof value.workspaceId !== 'string' || !Array.isArray(value.buffers) || typeof value.split !== 'object' || value.split === null) return { ok: false, error: { kind: 'invalid-layout', message: 'unsupported layout schema' } };
  const buffers: WorkbenchLayoutBuffer[] = [];
  for (const candidate of value.buffers) {
    if (typeof candidate !== 'object' || candidate === null) return { ok: false, error: { kind: 'invalid-layout', message: 'invalid layout buffer' } };
    const item = candidate as Record<string, unknown>;
    if (!hasOnlyKeys(item, ['bufferId', 'path', 'preview', 'pinned', 'viewIds']) || typeof item.bufferId !== 'string' || typeof item.path !== 'string' || typeof item.preview !== 'boolean' || typeof item.pinned !== 'boolean' || !Array.isArray(item.viewIds) || !item.viewIds.every((id): id is string => typeof id === 'string')) return { ok: false, error: { kind: 'invalid-layout', message: 'invalid layout buffer fields' } };
    const bufferId = asIdentifier<DocumentId>(item.bufferId, 'bufferId');
    if (!bufferId.ok) return { ok: false, error: { kind: 'invalid-layout', message: bufferId.error.message } };
    buffers.push(Object.freeze({ bufferId: bufferId.value, path: item.path, preview: item.preview, pinned: item.pinned, viewIds: Object.freeze(item.viewIds.map((id) => id as ViewId)) }));
  }
  const viewStates: WorkbenchLayoutViewState[] = [];
  if (value.viewStates !== undefined) {
    if (!Array.isArray(value.viewStates)) return { ok: false, error: { kind: 'invalid-layout', message: 'viewStates must be an array' } };
    for (const candidate of value.viewStates) {
      if (typeof candidate !== 'object' || candidate === null) return { ok: false, error: { kind: 'invalid-layout', message: 'invalid layout view state' } };
      const item = candidate as Record<string, unknown>;
      if (!hasOnlyKeys(item, ['viewId', 'bufferId', 'scrollTop', 'scrollLeft']) || typeof item.viewId !== 'string' || typeof item.bufferId !== 'string' || !Number.isSafeInteger(item.scrollTop) || (item.scrollTop as number) < 0 || !Number.isSafeInteger(item.scrollLeft) || (item.scrollLeft as number) < 0) return { ok: false, error: { kind: 'invalid-layout', message: 'invalid layout view state fields' } };
      const viewId = asIdentifier<ViewId>(item.viewId, 'viewId'); const bufferId = asIdentifier<DocumentId>(item.bufferId, 'bufferId');
      if (!viewId.ok || !bufferId.ok) return { ok: false, error: { kind: 'invalid-layout', message: 'invalid layout view identity' } };
      viewStates.push(Object.freeze({ viewId: viewId.value, bufferId: bufferId.value, scrollTop: item.scrollTop as number, scrollLeft: item.scrollLeft as number }));
    }
  }
  const splitInput = value.split as Record<string, unknown>;
  if (!hasOnlyKeys(splitInput, ['root', 'minimumPaneSize'])) return { ok: false, error: { kind: 'invalid-layout', message: 'invalid split snapshot' } };
  const split = decodeSplit(splitInput.root);
  if (!split.ok) return split;
  const active = value.activeViewId === undefined ? undefined : asIdentifier<ViewId>(value.activeViewId, 'activeViewId');
  if (active !== undefined && !active.ok) return { ok: false, error: { kind: 'invalid-layout', message: active.error.message } };
  return { ok: true, value: Object.freeze({ schemaVersion: 1, workspaceId: value.workspaceId, ...(active === undefined ? {} : { activeViewId: active.value }), buffers: Object.freeze(buffers), viewStates: Object.freeze(viewStates), split: Object.freeze({ root: split.value, minimumPaneSize: 1 }) }) };
}
function decodeSplit(input: unknown): Result<SplitNode | undefined, WorkbenchSessionFailure> {
  if (input === null || input === undefined) return { ok: true, value: undefined };
  if (typeof input !== 'object') return { ok: false, error: { kind: 'invalid-layout', message: 'split must be an object' } };
  const value = input as Record<string, unknown>;
  if (value.kind === 'leaf' && hasOnlyKeys(value, ['kind', 'nodeId', 'viewId']) && typeof value.nodeId === 'string' && typeof value.viewId === 'string') return { ok: true, value: Object.freeze({ kind: 'leaf', nodeId: value.nodeId, viewId: value.viewId as ViewId }) };
  if (!hasOnlyKeys(value, ['kind', 'nodeId', 'orientation', 'ratio', 'first', 'second']) || value.kind !== 'split' || typeof value.nodeId !== 'string' || (value.orientation !== 'horizontal' && value.orientation !== 'vertical') || typeof value.ratio !== 'number') return { ok: false, error: { kind: 'invalid-layout', message: 'invalid split node' } };
  const first = decodeSplit(value.first); const second = decodeSplit(value.second);
  if (!first.ok) return first; if (!second.ok || first.value === undefined || second.value === undefined) return { ok: false, error: { kind: 'invalid-layout', message: 'split children are required' } };
  if (!Number.isFinite(value.ratio) || !(value.ratio > 0 && value.ratio < 1)) return { ok: false, error: { kind: 'invalid-layout', message: 'split ratio must be between zero and one' } };
  return { ok: true, value: Object.freeze({ kind: 'split', nodeId: value.nodeId, orientation: value.orientation, ratio: value.ratio, first: first.value, second: second.value }) };
}
