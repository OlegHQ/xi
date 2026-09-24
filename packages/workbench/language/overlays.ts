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
  signatureTriggerCharacters?(uri: string): readonly string[];
}

export interface WorkbenchSymbolRange { readonly startLine: number; readonly startUtf16: number; readonly endLine: number; readonly endUtf16: number; }

/** Mirrors `packages/services/language`'s recursive `LanguageSymbol`. */
export interface WorkbenchNavigationSymbol {
  readonly id: string;
  readonly name: string;
  readonly detail?: string;
  readonly kind: number;
  readonly range: WorkbenchSymbolRange;
  readonly selection: WorkbenchSymbolRange;
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
  references(request: WorkbenchNavigationRequest, includeDeclaration: boolean): Promise<unknown>;
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
/** One visible outline tree row, in display order. */
export interface OutlineOverlayRow { readonly id: string; readonly name: string; readonly detail?: string; readonly kind: number; readonly depth: number; readonly expandable: boolean; readonly expanded: boolean; }
/** `activeId` is the innermost symbol containing the cursor (VS Code's follow-cursor);
 * `selectedId` is the keyboard selection while focused and follows `activeId` otherwise. */
export interface OutlineOverlayModel {
  readonly state: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
  readonly symbols: readonly WorkbenchNavigationSymbol[];
  readonly message: string | undefined;
  readonly generation: number;
  readonly rows: readonly OutlineOverlayRow[];
  readonly selectedId: string | undefined;
  readonly activeId: string | undefined;
  readonly focused: boolean;
}
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
  /** Whether the sidebar currently shows the Outline section; symbols load only while it does. */
  readonly isOutlineVisible?: () => boolean;
  /** `zc`/`za` in the Outline: collapse its sidebar section (Files' own zc does the same). */
  readonly onCollapse?: () => void;
  /** Makes the Outline section visible (sidebar shown, Files tab, section expanded) before focusing it. */
  readonly revealOutline?: () => void;
}

/** Background refresh after an edit: coalesces a burst of document versions into one request. */
const OUTLINE_REFRESH_MS = 300;

const UNAVAILABLE_HOVER_MODEL: HoverOverlayModel = Object.freeze({ state: 'unavailable', hover: undefined, message: 'No language server available' });
/**
 * Owns the Outline tree and Hover popup: open/close/keypress and the language-navigation
 * request/response plumbing. The Outline reads its own navigation controller so a background
 * symbol refresh never cancels a hover, definition or reference request. `attachNavigation`
 * binds the lazily-constructed controllers/session once the composition root constructs them.
 */
export class LanguageOverlayController {
  #outlineOpen = false;
  #hoverOpen = false;
  #pendingPrefix: 'g' | 'z' | undefined;
  #navigation: NavigationControllerPort | undefined;
  #outlineNavigation: NavigationControllerPort | undefined;
  #session: LanguageServerSessionPort | undefined;
  #outlineRead: LanguageOverlayReadPort<OutlineOverlayModel> | undefined;
  #hoverRead: LanguageOverlayReadPort<HoverOverlayModel> | undefined;
  readonly #outlineListeners = new Set<(model: OutlineOverlayModel) => void>();
  readonly #hoverListeners = new Set<(model: HoverOverlayModel) => void>();
  readonly #options: LanguageOverlayControllerOptions;
  readonly #collapsed = new Set<string>();
  #selectedId: string | undefined;
  #activeId: string | undefined;
  #cursorLine = -1;
  #requestedKey = '';
  #outlineGeneration = 0;
  #sortSource: readonly WorkbenchNavigationSymbol[] = [];
  #sorted: readonly WorkbenchNavigationSymbol[] = [];
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #outlineModel: OutlineOverlayModel = Object.freeze({ state: 'unavailable', symbols: Object.freeze([]), message: 'No language server available', generation: 0, rows: Object.freeze([]), selectedId: undefined, activeId: undefined, focused: false });

  constructor(options: LanguageOverlayControllerOptions) {
    this.#options = options;
  }

  get isOutlineOpen(): boolean { return this.#outlineOpen; }
  get isHoverOpen(): boolean { return this.#hoverOpen; }

  get outlineRead(): LanguageOverlayReadPort<OutlineOverlayModel> {
    const self = this;
    this.#outlineRead ??= {
      get model(): OutlineOverlayModel { return self.#outlineModel; },
      subscribe: (listener) => {
        self.#outlineListeners.add(listener);
        return { dispose: () => { self.#outlineListeners.delete(listener); } };
      },
    };
    return this.#outlineRead;
  }

  get hoverRead(): LanguageOverlayReadPort<HoverOverlayModel> {
    const self = this;
    this.#hoverRead ??= {
      get model(): HoverOverlayModel { return self.#navigation?.model ?? UNAVAILABLE_HOVER_MODEL; },
      subscribe: (listener) => {
        self.#hoverListeners.add(listener);
        return { dispose: () => { self.#hoverListeners.delete(listener); } };
      },
    };
    return this.#hoverRead;
  }

  /** Binds the lazily-constructed navigation controllers/session and forwards hover and outline
   * state as `XI_HOVER_STATE`/`XI_OUTLINE_STATE` markers. `outline` defaults to `navigation`. */
  attachNavigation(navigation: NavigationControllerPort, session: LanguageServerSessionPort, outline: NavigationControllerPort = navigation): Disposable {
    this.#navigation = navigation;
    this.#outlineNavigation = outline;
    this.#session = session;
    this.#requestedKey = '';
    const hoverSubscription = navigation.subscribe((model) => {
      if (this.#hoverOpen && model.state === 'ready' && (model.hover?.trim().length ?? 0) === 0) this.#hoverOpen = false;
      for (const listener of this.#hoverListeners) listener(model);
      this.#options.host.notifySurfaceChange();
      if (this.#hoverOpen) this.#options.marker('XI_HOVER_STATE', { state: model.state, generation: model.generation, hasText: model.hover !== undefined && model.hover.length > 0, message: model.message });
    });
    const outlineSubscription = outline.subscribe((model) => {
      this.#publishOutline();
      if (this.#outlineOpen || this.#visible()) this.#options.marker('XI_OUTLINE_STATE', { state: model.state, generation: model.generation, symbols: model.symbols.length, message: model.message });
    });
    this.#publishOutline();
    return { dispose: () => { hoverSubscription.dispose(); outlineSubscription.dispose(); } };
  }

  detachNavigation(): void {
    this.closeOutline();
    this.closeHover();
    this.#navigation = undefined;
    this.#outlineNavigation = undefined;
    this.#session = undefined;
    this.#publishOutline();
  }

  /** Focuses the Outline tree (revealing its sidebar section first). */
  openOutline(): void {
    this.#options.host.closeAllPanels('outline');
    this.#options.revealOutline?.();
    this.#outlineOpen = true;
    this.#selectedId = this.#activeId ?? this.#selectedId ?? this.#outlineModel.rows[0]?.id;
    this.#requestedKey = '';
    this.syncOutline();
    this.#publishOutline();
    this.#options.marker('XI_OUTLINE_OPEN', { state: this.#outlineModel.state });
  }

  /** Returns keyboard focus to the editor; the section stays visible. */
  closeOutline(): void {
    this.#outlineOpen = false;
    this.#pendingPrefix = undefined;
    this.#publishOutline();
    this.#options.host.notifySurfaceChange();
    this.#options.marker('XI_OUTLINE_CLOSED');
  }

  /**
   * Keeps the visible Outline current: requests symbols when the active document or its
   * version changes (a burst of edits coalesces into one request) and tracks the innermost
   * symbol at the cursor. Cheap when nothing changed; called once per rendered frame.
   */
  syncOutline(): void {
    if (!this.#visible()) return;
    const request = buildNavigationRequest(this.#options.session, this.#options.fileUri);
    const key = request === undefined ? '' : `${request.documentId}@${request.documentVersion}`;
    if (key !== this.#requestedKey) {
      const sameDocument = request !== undefined && this.#requestedKey.startsWith(`${request.documentId}@`);
      this.#requestedKey = key;
      if (this.#refreshTimer !== undefined) clearTimeout(this.#refreshTimer);
      this.#refreshTimer = undefined;
      if (sameDocument) this.#refreshTimer = setTimeout(() => { this.#refreshTimer = undefined; this.#requestOutline(); }, OUTLINE_REFRESH_MS);
      else this.#requestOutline();
    }
    const line = request?.position.line ?? -1;
    if (line !== this.#cursorLine) {
      this.#cursorLine = line;
      this.#publishOutline();
    }
  }

  openHover(): void {
    void this.#openHoverWhenAvailable();
  }

  closeHover(): void {
    this.#hoverOpen = false;
    this.#navigation?.returnToOrigin();
    this.#options.host.notifySurfaceChange();
    this.#options.marker('XI_HOVER_CLOSED');
  }

  handleOutlineKeypress(event: OwnedVimKeyEvent): boolean {
    const key = event.name.toLowerCase();
    const raw = event.raw;
    if (key === 'escape' || raw === '\u001b' || (raw === 'q' && !event.ctrl)) {
      this.closeOutline();
      return true;
    }
    // Tab hands focus to the Files tree (Ctrl-W chords route through the host window commands).
    if (key === 'tab' || raw === '\t') { this.closeOutline(); this.#options.focusExplorer?.(); return true; }
    const prefix = this.#pendingPrefix;
    this.#pendingPrefix = undefined;
    const rows = this.#outlineModel.rows;
    const index = rows.findIndex((row) => row.id === this.#selectedId);
    const current = rows[index];
    if (prefix === 'g') { if (raw === 'g') this.#select(rows[0]?.id); return true; }
    if (prefix === 'z') {
      // As in the Files tree, zc/za fold the whole section; zM/zR fold every symbol.
      if (raw === 'c' || raw === 'a') { this.closeOutline(); this.#options.onCollapse?.(); return true; }
      if (raw === 'M') { this.#collapseAll(this.#outlineModel.symbols); this.#selectedId = this.#rootOf(this.#selectedId); }
      else if (raw === 'R') this.#collapsed.clear();
      this.#publishOutline();
      return true;
    }
    if (raw === 'g' || raw === 'z') { this.#pendingPrefix = raw; return true; }
    // Ctrl-D/Ctrl-U: five rows, as in the Files tree.
    if (event.ctrl && (key === 'd' || key === 'u')) this.#select(rows[Math.max(0, Math.min(rows.length - 1, index + (key === 'd' ? 5 : -5)))]?.id);
    else if (raw === 'j' || key === 'down' || (event.ctrl && key === 'n')) this.#select(rows[Math.min(rows.length - 1, index + 1)]?.id);
    else if (raw === 'k' || key === 'up' || (event.ctrl && key === 'p')) this.#select(rows[Math.max(0, index - 1)]?.id);
    else if (raw === 'G' || key === 'end') this.#select(rows.at(-1)?.id);
    else if (key === 'home') this.#select(rows[0]?.id);
    else if (raw === 'l' || key === 'right') {
      // Files-tree semantics: expand a collapsed row, otherwise preview (reveal, keep focus).
      if (current === undefined) return true;
      if (current.expandable && !current.expanded) { this.#collapsed.delete(current.id); this.#publishOutline(); }
      else this.#reveal(current.id, false);
    } else if (raw === 'h' || key === 'left') {
      if (current === undefined) return true;
      if (current.expandable && current.expanded) { this.#collapsed.add(current.id); this.#publishOutline(); }
      else this.#select(this.#parentOf(current.id));
    } else if (key === 'return' || key === 'enter' || raw === '\r' || raw === 'o') {
      if (current !== undefined) this.#reveal(current.id, true);
    }
    return true;
  }

  /** Pointer activation on an outline row: the disclosure column toggles, the rest reveals the
   * symbol in the editor and returns focus there (VS Code's single click). */
  handleOutlinePointer(itemId: string, column: number): boolean {
    const row = this.#outlineModel.rows.find((candidate) => candidate.id === itemId);
    if (row === undefined) return true;
    if (row.expandable && column <= row.depth * 2 + 1) {
      if (row.expanded) this.#collapsed.add(row.id); else this.#collapsed.delete(row.id);
      this.#selectedId = row.id;
      this.#publishOutline();
      return true;
    }
    this.#reveal(row.id, true);
    return true;
  }

  /** The hover popup is transient: Escape just closes it; any other key closes it and is
   * reported unhandled so the router forwards it to the editor (the motion still happens). */
  handleHoverKeypress(event: OwnedVimKeyEvent): boolean {
    this.closeHover();
    return event.name.toLowerCase() === 'escape' || event.raw === '\x1b';
  }

  dispose(): void {
    if (this.#refreshTimer !== undefined) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
    this.#navigation = undefined;
    this.#outlineNavigation = undefined;
    this.#session = undefined;
    this.#outlineListeners.clear();
    this.#hoverListeners.clear();
  }

  #visible(): boolean { return this.#outlineOpen || this.#options.isOutlineVisible?.() === true; }

  #select(id: string | undefined): void {
    if (id === undefined || id === this.#selectedId) return;
    this.#selectedId = id;
    this.#publishOutline();
  }

  /** Moves the editor cursor to the symbol's name; `focusEditor` also hands focus back. */
  #reveal(id: string, focusEditor: boolean): void {
    const symbol = findSymbol(this.#outlineModel.symbols, id);
    const viewId = this.#options.session.activeViewId;
    const vim = viewId === undefined ? undefined : this.#options.host.sessions.get(viewId);
    if (symbol === undefined || vim === undefined) return;
    this.#selectedId = id;
    vim.setCursorPosition(symbol.selection.startLine, symbol.selection.startUtf16);
    this.#options.marker('XI_OUTLINE_REVEAL', { id, line: symbol.selection.startLine, utf16: symbol.selection.startUtf16 });
    if (focusEditor) this.closeOutline();
    else this.#publishOutline();
    this.#options.host.notifySurfaceChange();
  }

  /** Symbol ids are `<uri>:<index>(.<child>)*` (the uri may contain dots), so walk the tree. */
  #parentOf(id: string): string | undefined {
    let parent: string | undefined;
    let level = this.#outlineModel.symbols;
    for (;;) {
      const next = level.find((symbol) => id.startsWith(`${symbol.id}.`));
      if (next === undefined) return parent;
      parent = next.id;
      level = next.children;
    }
  }

  #rootOf(id: string | undefined): string | undefined {
    return id === undefined ? undefined : this.#outlineModel.symbols.find((symbol) => symbol.id === id || id.startsWith(`${symbol.id}.`))?.id;
  }

  #collapseAll(symbols: readonly WorkbenchNavigationSymbol[]): void {
    for (const symbol of symbols) {
      if (symbol.children.length === 0) continue;
      this.#collapsed.add(symbol.id);
      this.#collapseAll(symbol.children);
    }
  }

  #publishOutline(): void {
    const navigation = this.#outlineNavigation?.model;
    const symbols = this.#sortedSymbols(navigation?.symbols ?? []);
    const rows: OutlineOverlayRow[] = [];
    const visit = (items: readonly WorkbenchNavigationSymbol[], depth: number): void => {
      for (const symbol of items) {
        const expandable = symbol.children.length > 0;
        const expanded = expandable && !this.#collapsed.has(symbol.id);
        rows.push(Object.freeze({ id: symbol.id, name: symbol.name, ...(symbol.detail === undefined ? {} : { detail: symbol.detail }), kind: symbol.kind, depth, expandable, expanded }));
        if (expanded) visit(symbol.children, depth + 1);
      }
    };
    visit(symbols, 0);
    this.#activeId = innermostSymbolAt(symbols, this.#cursorLine, this.#collapsed);
    if (!this.#outlineOpen || !rows.some((row) => row.id === this.#selectedId)) this.#selectedId = this.#outlineOpen ? this.#activeId ?? rows[0]?.id : this.#activeId;
    this.#outlineModel = Object.freeze({
      state: navigation?.state ?? 'unavailable',
      symbols,
      message: navigation === undefined ? 'No language server available' : navigation.message,
      generation: ++this.#outlineGeneration,
      rows: Object.freeze(rows),
      selectedId: this.#selectedId,
      activeId: this.#activeId,
      focused: this.#outlineOpen,
    });
    for (const listener of this.#outlineListeners) listener(this.#outlineModel);
  }

  /** VS Code's default "sort by position" (servers such as tsserver answer sorted by name);
   * memoized per response so cursor-driven republishes do not re-sort. */
  #sortedSymbols(symbols: readonly WorkbenchNavigationSymbol[]): readonly WorkbenchNavigationSymbol[] {
    if (symbols === this.#sortSource) return this.#sorted;
    const sort = (items: readonly WorkbenchNavigationSymbol[]): readonly WorkbenchNavigationSymbol[] => Object.freeze(items
      .map((symbol) => symbol.children.length === 0 ? symbol : { ...symbol, children: sort(symbol.children) })
      .sort((left, right) => left.range.startLine - right.range.startLine || left.range.startUtf16 - right.range.startUtf16));
    this.#sortSource = symbols;
    this.#sorted = sort(symbols);
    return this.#sorted;
  }

  #requestOutline(): void {
    if (this.#outlineNavigation === undefined) {
      void this.#options.ensureLanguage().then(() => { if (this.#outlineNavigation !== undefined && this.#visible()) this.#requestOutline(); });
      return;
    }
    const request = buildNavigationRequest(this.#options.session, this.#options.fileUri);
    const navigation = this.#outlineNavigation;
    const session = this.#session;
    if (request === undefined || session === undefined) return;
    void session.waitForReady().then((ready) => {
      if (this.#visible() && ready.ok === true) void navigation.loadOutline(request);
    });
  }

  async #openHoverWhenAvailable(): Promise<void> {
    await this.#options.ensureLanguage();
    const request = buildNavigationRequest(this.#options.session, this.#options.fileUri);
    const navigation = this.#navigation;
    const session = this.#session;
    if (navigation === undefined || request === undefined || session === undefined) return;
    const ready = await session.waitForReady();
    if (!ready.ok || !session.supportsRequest('textDocument/hover', request.uri)) return;
    this.#options.host.closeAllPanels('hover');
    this.#hoverOpen = true;
    this.#options.marker('XI_HOVER_OPEN', { state: 'loading' });
    void navigation.requestHover(request);
  }
}

function findSymbol(symbols: readonly WorkbenchNavigationSymbol[], id: string): WorkbenchNavigationSymbol | undefined {
  for (const symbol of symbols) {
    if (symbol.id === id) return symbol;
    if (id.startsWith(`${symbol.id}.`)) return findSymbol(symbol.children, id);
  }
  return undefined;
}

/** Innermost visible symbol whose declaration spans `line`; a collapsed ancestor stands in for
 * its hidden descendants, as in VS Code's follow-cursor. */
function innermostSymbolAt(symbols: readonly WorkbenchNavigationSymbol[], line: number, collapsed: ReadonlySet<string>): string | undefined {
  for (const symbol of symbols) {
    if (line < symbol.range.startLine || line > symbol.range.endLine) continue;
    return collapsed.has(symbol.id) ? symbol.id : innermostSymbolAt(symbol.children, line, collapsed) ?? symbol.id;
  }
  return undefined;
}
