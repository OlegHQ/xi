import type { Disposable, DocumentId, Result, UndoGroupId, ViewId } from '../../contracts/src/index';
import type { DocumentEdit, EditOrigin } from '../../document/src/index';
import type { WorkbenchViewSnapshot } from '../src/read-model';
import type { WorkbenchBufferSnapshot, WorkbenchViewStateSnapshot } from '../session';
import type { OwnedVimKeyEvent } from '../vim-session';
import type { BufferHost } from '../host';

export type { OwnedVimKeyEvent as LanguageOverlayKeyEvent };

/** Read-only/edit subset of the workbench session this whole language feature (overlays,
 * completion/signature/snippet, workspace edits) needs to build a request and to apply edits
 * back through the document/edit coordinator -- never straight to a document. Real workbench
 * types (not mirrored -- workbench may reference its own sibling modules directly; only
 * `packages/services` types are forbidden). */
export interface LanguageWorkbenchSessionPort {
  readonly activeViewId: ViewId | undefined;
  readView(viewId: ViewId): WorkbenchViewSnapshot | undefined;
  views(): readonly WorkbenchViewStateSnapshot[];
  buffer(bufferId: DocumentId): WorkbenchBufferSnapshot | undefined;
  buffers(): readonly WorkbenchBufferSnapshot[];
  applyTextEdits(viewId: ViewId, edits: readonly DocumentEdit[], undoGroup: UndoGroupId, origin: EditOrigin, focus?: boolean): Promise<Result<{ readonly version: unknown; readonly editCount: number }, { readonly kind: string }>>;
  beginUndoGroup(viewId: ViewId, undoGroup: UndoGroupId, origin: EditOrigin): Result<void, { readonly kind: string }>;
  endUndoGroup(viewId: ViewId, undoGroup: UndoGroupId): Result<void, { readonly kind: string }>;
  applyDocumentEdits(documentId: DocumentId, edits: readonly DocumentEdit[], undoGroup: UndoGroupId, origin: EditOrigin): Promise<Result<{ readonly version: unknown; readonly editCount: number }, { readonly kind: string }>>;
}

/** Mirrors `packages/services/language`'s `NavigationRequest` structurally -- workbench cannot
 * import `packages/services`, not even types. Shared by overlays, completion/signature and
 * workspace edits (code actions, rename): every request they send the language server starts
 * from the same "where is the cursor" read. */
export interface WorkbenchNavigationRequest {
  readonly documentId: string;
  readonly documentVersion: number;
  readonly selectionGeneration: number;
  readonly uri?: string;
  readonly position: { readonly line: number; readonly utf16: number };
}

/** Builds the current navigation request from the active view's primary selection, or
 * `undefined` when there is no active view/buffer/selection to build one from. Moved out of
 * `apps/xi/src/main.ts`'s `currentNavigationRequest`, unchanged: pure over the real workbench
 * session type and the composition root's `fileUri` function value. */
export function buildNavigationRequest(session: LanguageWorkbenchSessionPort, fileUri: (path: string) => string): WorkbenchNavigationRequest | undefined {
  const activeViewId = session.activeViewId;
  if (activeViewId === undefined) return undefined;
  const view = session.readView(activeViewId);
  const layoutView = session.views().find((candidate) => candidate.viewId === activeViewId);
  const buffer = layoutView === undefined ? undefined : session.buffer(layoutView.bufferId);
  const primary = view === undefined ? undefined : (view.selections.members.find((member) => member.id === view.selections.primaryId) ?? view.selections.members[0]);
  if (view === undefined || buffer === undefined || primary === undefined) return undefined;
  const line = view.document.lineIndexAt(primary.head.at.offset);
  if (!line.ok) return undefined;
  const start = view.document.lineStartOffset(line.value);
  if (!start.ok) return undefined;
  const uri = buffer.path === undefined ? undefined : fileUri(buffer.path);
  return {
    documentId: String(view.document.id),
    documentVersion: view.document.version,
    selectionGeneration: view.selections.selectionGeneration as number,
    ...(uri === undefined ? {} : { uri }),
    position: { line: line.value as number, utf16: (primary.head.at.offset as number) - (start.value as number) },
  };
}

/** Mirrors `packages/services/language`'s `LanguageServerSession`, subset used by overlays,
 * completion/signature and workspace edits. */
export interface LanguageServerSessionPort {
  waitForReady(): Promise<Result<unknown, { readonly message: string }>>;
  supportsRequest(method: string, uri?: string): boolean;
}

/** Mirrors `packages/services/language`'s recursive `LanguageSymbol`. */
export interface WorkbenchNavigationSymbol {
  readonly id: string;
  readonly name: string;
  readonly detail?: string;
  readonly kind: number;
  readonly children: readonly WorkbenchNavigationSymbol[];
}

/** Mirrors `packages/services/language`'s `NavigationReadModel`: one model shared by both the
 * outline and hover overlays (matching `apps/xi/src/main.ts`'s original `outlineRead`/`hoverRead`,
 * which both read `navigationController.model`). */
export interface WorkbenchNavigationModel {
  readonly state: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
  readonly generation: number;
  readonly symbols: readonly WorkbenchNavigationSymbol[];
  readonly hover: string | undefined;
  readonly message: string | undefined;
}

/** Mirrors `packages/services/language`'s `LanguageNavigationController`. */
export interface NavigationControllerPort {
  readonly model: WorkbenchNavigationModel;
  subscribe(listener: (model: WorkbenchNavigationModel) => void): Disposable;
  loadOutline(request: WorkbenchNavigationRequest): Promise<unknown>;
  requestHover(request: WorkbenchNavigationRequest): Promise<unknown>;
  returnToOrigin(): unknown;
}

/** Structural shapes matching `packages/ui/src/entrypoints/launch`'s `OutlineReadPort`/
 * `HoverReadPort` -- workbench cannot import those either, so this controller exposes read
 * objects whose shape structurally satisfies them (`apps/xi/src/main.ts` asserts assignability
 * when wiring the UI options). */
export interface LanguageOverlayReadPort<Model> {
  readonly model: Model;
  subscribe(listener: (model: Model) => void): Disposable;
}
export interface OutlineOverlayModel { readonly state: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'; readonly symbols: readonly WorkbenchNavigationSymbol[]; readonly message: string | undefined; }
export interface HoverOverlayModel { readonly state: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'; readonly hover: string | undefined; readonly message: string | undefined; }

export interface LanguageOverlayControllerOptions {
  readonly host: BufferHost;
  readonly session: LanguageWorkbenchSessionPort;
  readonly fileUri: (path: string) => string;
  readonly marker: (name: string, payload?: unknown) => void;
  /** Lazily constructs (memoized) the language session/navigation controller -- composition-root
   * work, never duplicated here; a no-op (already-resolved) promise when no language server
   * applies to the current file, matching the original `ensureLanguage`'s own early return. */
  readonly ensureLanguage: () => Promise<void>;
  /** Tab from the Outline section moves keyboard focus to the Files tree. */
  readonly focusExplorer?: () => void;
}

const UNAVAILABLE_OUTLINE_MODEL: OutlineOverlayModel = Object.freeze({ state: 'unavailable', symbols: Object.freeze([]), message: 'No language server available' });
const UNAVAILABLE_HOVER_MODEL: HoverOverlayModel = Object.freeze({ state: 'unavailable', hover: undefined, message: 'No language server available' });
const NOOP_DISPOSABLE: Disposable = Object.freeze({ dispose: () => {} });

/**
 * Owns the Outline and Hover overlay panels: open/close/keypress and the language-navigation
 * request/response plumbing shared by both (they read the same `NavigationReadModel`). Moved out
 * of `apps/xi/src/main.ts`'s `main()` closure; `attachNavigation` binds the lazily-constructed
 * `LanguageNavigationController`/`LanguageServerSession` once the composition root constructs
 * them (mirrors S5/S6's `attachTree`/`attachServices`), and owns the resulting model subscription.
 */
export class LanguageOverlayController {
  #outlineOpen = false;
  #hoverOpen = false;
  #pendingCtrlW = false;
  #navigation: NavigationControllerPort | undefined;
  #session: LanguageServerSessionPort | undefined;
  #outlineRead: LanguageOverlayReadPort<OutlineOverlayModel> | undefined;
  #hoverRead: LanguageOverlayReadPort<HoverOverlayModel> | undefined;
  readonly #options: LanguageOverlayControllerOptions;

  constructor(options: LanguageOverlayControllerOptions) {
    this.#options = options;
  }

  get isOutlineOpen(): boolean { return this.#outlineOpen; }
  get isHoverOpen(): boolean { return this.#hoverOpen; }

  get outlineRead(): LanguageOverlayReadPort<OutlineOverlayModel> {
    const self = this;
    this.#outlineRead ??= {
      get model(): OutlineOverlayModel { return self.#navigation?.model ?? UNAVAILABLE_OUTLINE_MODEL; },
      subscribe: (listener) => self.#navigation?.subscribe(() => listener(self.outlineRead.model)) ?? NOOP_DISPOSABLE,
    };
    return this.#outlineRead;
  }

  get hoverRead(): LanguageOverlayReadPort<HoverOverlayModel> {
    const self = this;
    this.#hoverRead ??= {
      get model(): HoverOverlayModel { return self.#navigation?.model ?? UNAVAILABLE_HOVER_MODEL; },
      subscribe: (listener) => self.#navigation?.subscribe(() => listener(self.hoverRead.model)) ?? NOOP_DISPOSABLE,
    };
    return this.#hoverRead;
  }

  /** Binds the lazily-constructed navigation controller/session, and starts forwarding
   * outline/hover state as `XI_OUTLINE_STATE`/`XI_HOVER_STATE` markers while their panel is
   * open -- the returned `Disposable` is held and disposed by `apps/xi/src/main.ts` at the exact
   * point the original `navigationSubscription?.dispose()` teardown line already ran. */
  attachNavigation(navigation: NavigationControllerPort, session: LanguageServerSessionPort): Disposable {
    this.#navigation = navigation;
    this.#session = session;
    return navigation.subscribe((model) => {
      this.#options.host.notifySurfaceChange();
      if (this.#outlineOpen) this.#options.marker('XI_OUTLINE_STATE', { state: model.state, generation: model.generation, symbols: model.symbols.length, message: model.message });
      if (this.#hoverOpen) this.#options.marker('XI_HOVER_STATE', { state: model.state, generation: model.generation, hasText: model.hover !== undefined && model.hover.length > 0, message: model.message });
    });
  }

  openOutline(): void {
    this.#options.host.closeAllPanels('outline');
    this.#outlineOpen = true;
    if (this.#navigation === undefined) void this.#options.ensureLanguage().then(() => { if (this.#outlineOpen) this.#requestOutline(); });
    else this.#requestOutline();
    this.#options.marker('XI_OUTLINE_OPEN', { state: 'loading' });
  }

  closeOutline(): void {
    this.#outlineOpen = false;
    this.#navigation?.returnToOrigin();
    this.#options.marker('XI_OUTLINE_CLOSED');
  }

  openHover(): void {
    this.#options.host.closeAllPanels('hover');
    this.#hoverOpen = true;
    if (this.#navigation === undefined) void this.#options.ensureLanguage().then(() => { if (this.#hoverOpen) this.#requestHover(); });
    else this.#requestHover();
    this.#options.marker('XI_HOVER_OPEN', { state: 'loading' });
  }

  closeHover(): void {
    this.#hoverOpen = false;
    this.#navigation?.returnToOrigin();
    this.#options.marker('XI_HOVER_CLOSED');
  }

  handleOutlineKeypress(event: OwnedVimKeyEvent): boolean {
    const key = event.name.toLowerCase();
    if (key === 'escape' || event.raw === '') {
      this.closeOutline();
      return true;
    }
    // Sidebar section cycling: Tab hands focus to the Files tree; Ctrl-W + w/h/j/k/l/p returns
    // to the editor (mirrors the explorer's own chords).
    if (key === 'tab' || event.raw === '\t') { this.closeOutline(); this.#options.focusExplorer?.(); return true; }
    if (this.#pendingCtrlW) { this.#pendingCtrlW = false; if ('whjklp'.includes(key)) this.closeOutline(); return true; }
    if (event.ctrl && key === 'w') { this.#pendingCtrlW = true; return true; }
    return true;
  }

  /** The hover popup is transient: Escape just closes it; any other key closes it and is
   * reported unhandled so the router forwards it to the editor (the motion still happens). */
  handleHoverKeypress(event: OwnedVimKeyEvent): boolean {
    this.closeHover();
    return event.name.toLowerCase() === 'escape' || event.raw === '\x1b';
  }

  dispose(): void {
    this.#navigation = undefined;
    this.#session = undefined;
  }

  #requestOutline(): void {
    const request = buildNavigationRequest(this.#options.session, this.#options.fileUri);
    const navigation = this.#navigation;
    const session = this.#session;
    if (navigation === undefined || request === undefined || session === undefined) return;
    void session.waitForReady().then((ready) => {
      if (this.#outlineOpen && ready.ok === true) void navigation.loadOutline(request);
    });
  }

  #requestHover(): void {
    const request = buildNavigationRequest(this.#options.session, this.#options.fileUri);
    const navigation = this.#navigation;
    const session = this.#session;
    if (navigation === undefined || request === undefined || session === undefined) return;
    void session.waitForReady().then((ready) => {
      if (this.#hoverOpen && ready.ok === true) void navigation.requestHover(request);
    });
  }
}
