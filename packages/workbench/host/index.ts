import { asIdentifier, type ClipboardPort, type ClockPort, type DocumentId, type Disposable, type Result, type ViewId } from '../../contracts/src/index';
import type { SelectionSetSnapshot } from '../../selections/src/index';
import type { TextFileDocument } from '../../document/src/entrypoints/launch';
import type { VimHostCommand, VimInsertOptions } from '../../vim/src/index';
import { createOwnedVimSession } from '../vim-session';
import type { OwnedVimKeyEvent, OwnedVimSession, VimCommandLineState, VimPrefixHelpState } from '../vim-session';
import type { WorkbenchBufferSnapshot, WorkbenchSession, WorkbenchSessionFailure } from '../session';

export type { OwnedVimKeyEvent };

export type HostCommandPort = (command: VimHostCommand, viewId: ViewId) => void | Promise<void>;

/** H2-8: `notifySurfaceChange()`'s previously zero-payload broadcast (11 call sites across the
 * composition root/controllers, all telling every subscriber "something changed, re-read your
 * model" with no further detail). `kind` is a free-form tag (e.g. 'git-status', 'buffer-opened')
 * -- consumers that only need "repaint now" keep working unchanged since every existing
 * listener registered as `() => void` still matches this wider callback shape. */
export interface SurfaceChangePayload {
  readonly kind: string;
  readonly documentId?: DocumentId;
  readonly generation?: number;
}

export interface BufferHostOptions {
  /** Opens (or creates) the document for a workspace path, including persistence/recovery
   * and stderr reporting; owned by the composition root, not this module. */
  readonly openDocument: (path: string, documentId: DocumentId) => Promise<TextFileDocument | undefined>;
  /** Resolves an absolute path to a workspace-relative one for "already open" matching. */
  readonly workspaceRelativePath: (path: string) => string | undefined;
  /** PTY test marker sink; never reads `process.env` itself. */
  readonly marker: (name: string, payload?: unknown) => void;
  /** The view a freshly-opened document's initial cursor line is not already known for. */
  readonly launchViewId: ViewId;
  readonly launchInitialLine?: number;
  readonly motionGhost?: boolean;
  readonly selectionLimit?: number;
  readonly selectionHistoryLimit?: number;
  readonly defaultYankRegister?: string;
  readonly mouseYankRegister?: string;
  readonly clipboard?: ClipboardPort;
  readonly insertOptions?: VimInsertOptions;
  readonly insertOptionsForPath?: (path: string | undefined) => VimInsertOptions | undefined;
  readonly onMessage?: (message: string) => void;
  readonly onSave?: (document: TextFileDocument, viewId: ViewId, target: string | undefined) => Promise<boolean>;
  readonly onExCommand?: (source: string, viewId: ViewId) => Promise<'handled' | 'unhandled' | 'quit'> | 'handled' | 'unhandled' | 'quit';
  readonly onHostCommand?: HostCommandPort;
  readonly onPrefixStateChange?: (viewId: ViewId, state: VimPrefixHelpState) => void;
  readonly onCommandLineChange?: (state: VimCommandLineState | undefined) => void;
  readonly onStateChange?: (document: TextFileDocument, state: { readonly selections: SelectionSetSnapshot; readonly mode: string }) => void;
  /** Invoked whenever a buffer beyond the launch document is opened/closed, so the
   * composition root can register/unregister it with the language server -- the launch
   * document is registered separately by the composition root itself. */
  readonly onBufferOpened?: (buffer: { readonly documentId: DocumentId; readonly path: string; readonly document: TextFileDocument }) => void;
  readonly onBufferClosed?: (buffer: { readonly documentId: DocumentId; readonly path: string | undefined }) => void;
  /** Monotonic clock for the Vim session's key-timing state; defaults to a built-in one. */
  readonly clock?: Pick<ClockPort, 'monotonicMilliseconds'>;
}

export interface OpenBufferAtPathOptions {
  readonly preview?: boolean;
  readonly split?: ViewId;
  readonly line?: number;
}

export interface OpenBufferAtPathResult {
  readonly viewId: ViewId;
  readonly bufferId: DocumentId;
  /** False when an already-open buffer for this path was reused instead of opening a new one. */
  readonly created: boolean;
}

export interface BufferHostPanel {
  readonly isOpen: () => boolean;
  readonly close: () => void;
  /** Completion/signature today close whenever open, never excluded by `keep`. */
  readonly alwaysClose?: boolean;
}

/**
 * Owns the buffer/session substrate that used to live as closure state inside
 * `apps/xi/src/main.ts`'s `main()`: the `documents`/`sessions` maps, the shared
 * "open a file, reusing an already-open buffer" flow, preview-buffer discard, panel
 * exclusivity and the on-demand-render surface-change broadcast. Feature controllers
 * (search, explorer, problems, picker, ...) are constructed with a `BufferHost` and
 * never duplicate this bookkeeping themselves.
 */
export class BufferHost {
  readonly documents: Map<DocumentId, TextFileDocument>;
  readonly sessions = new Map<ViewId, OwnedVimSession>();
  previewViewId: ViewId | undefined;

  readonly #session: WorkbenchSession;
  readonly #options: BufferHostOptions;
  readonly #panels = new Map<string, BufferHostPanel>();
  // Guards overlapping `openBufferAtPath` calls for the same path (e.g. two rapid picker
  // selections, or a navigation racing a picker open): without this, both calls miss the
  // "already open" check, each opens its own document, and the buffer ends up with two
  // independent histories. Keyed by workspace-relative path; the second caller awaits the
  // first's in-flight open and then re-checks "already open" itself.
  readonly #openingByPath = new Map<string, Promise<OpenBufferAtPathResult | undefined>>();
  readonly #surfaceChangeListeners = new Set<(payloads: readonly SurfaceChangePayload[]) => void>();
  readonly #viewClosedListeners = new Set<(viewId: ViewId) => void>();
  readonly #bufferClosedListeners = new Set<(bufferId: DocumentId) => void>();
  #pendingSurfaceChanges: SurfaceChangePayload[] = [];
  #surfaceChangeScheduled = false;
  #documentSequence = 0;

  constructor(session: WorkbenchSession, launchDocument: TextFileDocument, options: BufferHostOptions) {
    this.#session = session;
    this.#options = options;
    this.documents = new Map([[launchDocument.id, launchDocument]]);
  }

  /** Allocates a fresh per-process document id for a buffer opened after launch. */
  nextDocumentId(): DocumentId {
    this.#documentSequence += 1;
    const result = asIdentifier<DocumentId>(`xi-picker-document-${this.#documentSequence}`, 'xi-buffer-host-document-id');
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  activeSession(): OwnedVimSession | undefined {
    return this.#session.activeViewId === undefined ? undefined : this.sessions.get(this.#session.activeViewId);
  }

  /** Picker identity for Helix's current/previous buffer start position. */
  bufferPickerSelection(position: 'current' | 'previous'): string | undefined {
    if (position === 'current') {
      const activeViewId = this.#session.activeViewId;
      return activeViewId === undefined
        ? undefined
        : this.#session.views().find((view) => view.viewId === activeViewId)?.bufferId.toString();
    }
    const previousPath = this.#session.alternateBufferPath();
    return previousPath === undefined ? undefined : this.#session.buffers().find((buffer) => buffer.path === previousPath)?.bufferId.toString();
  }

  /** Promotes a buffer out of preview -- needed on commit even when the buffer was opened
   * non-preview, since `openBufferAtPath`'s "already open" branch reuses an existing buffer
   * regardless of its current preview flag. Also clears `previewViewId` if it still pointed
   * at this same view. */
  promoteBuffer(bufferId: DocumentId, viewId: ViewId): void {
    this.#session.promoteBuffer(bufferId);
    this.#closeEmptyScratch(viewId);
    if (this.previewViewId === viewId) this.previewViewId = undefined;
  }

  createSession(document: TextFileDocument, viewId: ViewId, initialSelections?: SelectionSetSnapshot, initialLine?: number): OwnedVimSession {
    const options = this.#options;
    const resolvedInitialLine = initialLine ?? (viewId === options.launchViewId ? options.launchInitialLine : undefined);
    const workbenchSession = this.#session;
    const insertOptions = options.insertOptionsForPath?.(workbenchSession.buffer(document.id)?.path) ?? options.insertOptions;
    let publishedMode = 'normal';
    const session = createOwnedVimSession(document, {
      viewId,
      motionGhost: options.motionGhost ?? false,
      ...(options.selectionLimit === undefined ? {} : { selectionLimit: options.selectionLimit }),
      ...(options.selectionHistoryLimit === undefined ? {} : { selectionHistoryLimit: options.selectionHistoryLimit }),
      ...(options.defaultYankRegister === undefined ? {} : { defaultYankRegister: options.defaultYankRegister }),
      ...(options.mouseYankRegister === undefined ? {} : { mouseYankRegister: options.mouseYankRegister }),
      ...(options.clipboard === undefined ? {} : { clipboard: options.clipboard }),
      isActive: () => workbenchSession.activeViewId === viewId,
      ...(insertOptions === undefined ? {} : { insertOptions }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      files: {
        currentPath: () => workbenchSession.buffer(document.id)?.path,
        alternatePath: () => workbenchSession.alternateBufferPath(),
      },
      viewport: {
        topLine: () => workbenchSession.readView(viewId)?.scrollTop ?? 0,
        bottomLine: () => {
          const read = workbenchSession.readView(viewId);
          const height = workbenchSession.viewViewportHeight(viewId);
          if (read === undefined || height === undefined) return Math.max(0, document.snapshot().lineCount - 1);
          return Math.min(Math.max(0, document.snapshot().lineCount - 1), read.scrollTop + height - 1);
        },
      },
      ...(initialSelections === undefined ? {} : { initialSelections }),
      ...(resolvedInitialLine === undefined ? {} : { initialLine: resolvedInitialLine }),
      ...(options.onMessage === undefined ? {} : { onMessage: options.onMessage }),
      ...(options.onSave === undefined ? {} : { onSave: (target) => options.onSave!(document, viewId, target) }),
      ...(options.onExCommand === undefined ? {} : { onExCommand: (source: string) => options.onExCommand!(source, viewId) }),
      ...(options.onHostCommand === undefined ? {} : { onHostCommand: (command) => options.onHostCommand!(command, viewId) }),
      ...(options.onPrefixStateChange === undefined ? {} : {
        onPrefixStateChange: (state: VimPrefixHelpState) => {
          if (this.#session.activeViewId === viewId) options.onPrefixStateChange!(viewId, state);
        },
      }),
      ...(options.onCommandLineChange === undefined ? {} : { onCommandLineChange: options.onCommandLineChange }),
      onStateChange: (state) => {
        this.#session.syncViewSession(viewId, state.selections, state.mode);
        this.#options.onStateChange?.(document, state);
        if (publishedMode !== state.mode) { publishedMode = state.mode; this.notifySurfaceChange(); }
      },
      // Preview-buffer promotion only needs to run when an edit actually lands, not on
      // every key (most keys are cursor/mode moves that can never change `dirty`).
      // `onDocumentChange` fires exactly when this session commits a document edit.
      onDocumentChange: (change) => {
        // Other views of this same document (including comparison tabs) must advance
        // their private Vim cursors before they receive another key.
        for (const [otherViewId, other] of this.sessions) if (otherViewId !== viewId) other.applyExternalChange(change);
        if (this.#session.buffer(document.id)?.dirty === true) {
          this.#session.promoteBuffer(document.id);
          if (this.previewViewId === viewId) this.previewViewId = undefined;
        }
      },
    });
    this.sessions.set(viewId, session);
    return session;
  }

  /** Canonical "find an open buffer for this path, else open and create a session for it"
   * flow shared by every navigation-to-file entry point (problems, search, explorer, picker,
   * host/native jump). Buffers are matched by workspace-relative path so an undefined
   * `buffer.path` (an unsaved "[No Name]" buffer) never spuriously matches. */
  async openBufferAtPath(path: string, options: OpenBufferAtPathOptions = {}): Promise<OpenBufferAtPathResult | undefined> {
    const relativePath = this.#options.workspaceRelativePath(path);
    const inFlight = relativePath === undefined ? undefined : this.#openingByPath.get(relativePath);
    if (inFlight !== undefined) return inFlight;
    const attempt = this.#openBufferAtPathAttempt(path, options, relativePath);
    if (relativePath !== undefined) {
      this.#openingByPath.set(relativePath, attempt);
      void attempt.finally(() => {
        if (this.#openingByPath.get(relativePath) === attempt) this.#openingByPath.delete(relativePath);
      });
    }
    return attempt;
  }

  async #openBufferAtPathAttempt(path: string, options: OpenBufferAtPathOptions, relativePath: string | undefined): Promise<OpenBufferAtPathResult | undefined> {
    const existing = this.#session.buffers().find((buffer) => buffer.path !== undefined && relativePath !== undefined && this.#options.workspaceRelativePath(buffer.path) === relativePath);
    if (existing !== undefined) {
      const viewId = existing.viewIds[0];
      if (viewId === undefined) return undefined;
      this.#session.focus(viewId);
      if (options.preview !== true && options.split === undefined) this.#closeEmptyScratch(viewId);
      return { viewId, bufferId: existing.bufferId, created: false };
    }
    const openedFile = await this.#options.openDocument(path, this.nextDocumentId());
    if (openedFile === undefined) return undefined;
    this.documents.set(openedFile.id, openedFile);
    if (options.split !== undefined) {
      const createdSplit = this.#session.splitView(options.split, 'horizontal');
      if (!createdSplit.ok) {
        this.documents.delete(openedFile.id);
        return undefined;
      }
      const splitDocument = this.documents.get(createdSplit.value.session.documentId);
      if (splitDocument !== undefined && !this.sessions.has(createdSplit.value.viewId)) this.createSession(splitDocument, createdSplit.value.viewId, createdSplit.value.session.selections);
    }
    let openedBuffer: Result<WorkbenchBufferSnapshot, WorkbenchSessionFailure>;
    // Preview replacement (VS Code semantics): opening a new preview replaces the existing
    // preview buffer/view rather than stacking another tab. `replacePreview` refuses when
    // the existing preview is dirty ('dirty-preview-replacement'); that dirty preview has
    // since been promoted to a real tab by an edit, so it must be kept and a fresh preview
    // opened alongside it instead of discarding unsaved work.
    let replacedPreviewBuffer: WorkbenchBufferSnapshot | undefined;
    if (options.preview === true) {
      replacedPreviewBuffer = this.#session.buffers().find((buffer) => buffer.preview);
      const replaced = this.#session.replacePreview(openedFile, { path });
      if (!replaced.ok && replaced.error.kind === 'dirty-preview-replacement') {
        replacedPreviewBuffer = undefined;
        openedBuffer = this.#session.openBuffer(openedFile, { path, preview: true });
      } else {
        openedBuffer = replaced;
      }
    } else {
      openedBuffer = this.#session.openBuffer(openedFile, { path });
    }
    if (!openedBuffer.ok) {
      this.documents.delete(openedFile.id);
      return undefined;
    }
    if (replacedPreviewBuffer !== undefined && this.#session.buffer(replacedPreviewBuffer.bufferId) === undefined) {
      for (const staleViewId of replacedPreviewBuffer.viewIds) {
        this.sessions.get(staleViewId)?.dispose();
        this.sessions.delete(staleViewId);
        for (const listener of this.#viewClosedListeners) listener(staleViewId);
      }
      this.documents.delete(replacedPreviewBuffer.bufferId);
      this.#options.onBufferClosed?.({ documentId: replacedPreviewBuffer.bufferId, path: replacedPreviewBuffer.path });
      for (const listener of this.#bufferClosedListeners) listener(replacedPreviewBuffer.bufferId);
    }
    const viewId = openedBuffer.value.viewIds[0];
    if (viewId === undefined) return undefined;
    this.createSession(openedFile, viewId, undefined, options.line === undefined ? undefined : options.line + 1);
    this.#session.focus(viewId);
    this.#options.onBufferOpened?.({ documentId: openedFile.id, path, document: openedFile });
    if (options.split === undefined && options.preview !== true) this.#closeEmptyScratch(viewId);
    return { viewId, bufferId: openedFile.id, created: true };
  }

  #closeEmptyScratch(keep: ViewId): void {
    for (const buffer of this.#session.buffers()) {
      const viewId = buffer.viewIds[0];
      if (viewId === undefined || viewId === keep || buffer.path !== undefined || buffer.dirty || buffer.viewIds.length !== 1) continue;
      if (this.documents.get(buffer.documentId)?.snapshot().lengthUtf16 === 0) this.closeView(viewId);
    }
    this.#session.focus(keep);
  }

  /** Closes `viewId` if (and only if) it is still marked `preview` -- once an edit or an
   * explicit commit has promoted it, it is real, kept work and must never be silently
   * closed just because a caller still happens to be tracking it as a preview. */
  discardPreviewView(viewId: ViewId): { readonly ok: boolean; readonly activeViewId: ViewId | undefined } {
    const view = this.#session.views().find((candidate) => candidate.viewId === viewId);
    const bufferId = view?.bufferId;
    const buffer = bufferId === undefined ? undefined : this.#session.buffer(bufferId);
    if (bufferId === undefined || buffer?.preview !== true || buffer.dirty) return { ok: false, activeViewId: undefined };
    const closed = this.closeView(viewId, true);
    return { ok: closed.ok, activeViewId: closed.ok ? closed.value.activeViewId : undefined };
  }

  /** Release per-view resources, and notify document owners only when its last view closes. */
  closeView(viewId: ViewId, discard = false): ReturnType<WorkbenchSession['closeView']> {
    const view = this.#session.views().find(candidate => candidate.viewId === viewId);
    const buffer = view === undefined ? undefined : this.#session.buffer(view.bufferId);
    const closed = this.#session.closeView(viewId, discard ? 'discard' : undefined);
    if (!closed.ok || !closed.value.closed) return closed;
    this.sessions.get(viewId)?.dispose();
    this.sessions.delete(viewId);
    if (this.previewViewId === viewId) this.previewViewId = undefined;
    if (buffer !== undefined && this.#session.buffer(buffer.bufferId) === undefined) {
      this.documents.delete(buffer.bufferId);
      this.#options.onBufferClosed?.({ documentId: buffer.documentId, path: buffer.path });
      for (const listener of this.#bufferClosedListeners) listener(buffer.bufferId);
    }
    for (const listener of this.#viewClosedListeners) listener(viewId);
    return closed;
  }

  onViewClosed(listener: (viewId: ViewId) => void): Disposable {
    this.#viewClosedListeners.add(listener);
    return { dispose: () => { this.#viewClosedListeners.delete(listener); } };
  }

  /** Internal buffer-closed event (distinct from the composition-root-facing
   * `BufferHostOptions.onBufferClosed`): lets in-process owners of a per-buffer cache --
   * e.g. the search controller's dirty-buffer text cache -- evict their entry instead of
   * only clearing on their own dispose(). */
  onBufferClosed(listener: (bufferId: DocumentId) => void): Disposable {
    this.#bufferClosedListeners.add(listener);
    return Object.freeze({ dispose: () => { this.#bufferClosedListeners.delete(listener); } });
  }

  /** Resolves a picker "buffer" entry (keyed by `String(bufferId)`) to its first view and
   * focuses it. Returns the view id, or `undefined` when no such buffer is open. */
  focusBufferById(bufferId: string, paneViewId?: ViewId): ViewId | undefined {
    const activated = this.#session.activateBuffer(bufferId as DocumentId, paneViewId);
    if (!activated.ok) return undefined;
    const viewId = this.#session.activeViewId;
    const view = viewId === undefined ? undefined : this.#session.readView(viewId);
    const document = view === undefined ? undefined : this.documents.get(view.document.id);
    if (viewId !== undefined && document !== undefined && !this.sessions.has(viewId)) this.createSession(document, viewId, view?.selections);
    return viewId;
  }

  /** Close a previously opened preview view/buffer, replacing it with a new preview
   * navigation target. */
  discardStalePreview(exceptViewId: ViewId): void {
    if (this.previewViewId === undefined || this.previewViewId === exceptViewId) return;
    const staleViewId = this.previewViewId;
    this.previewViewId = undefined;
    this.discardPreviewView(staleViewId);
  }

  /** Registers an overlay panel for exclusivity. `alwaysClose` matches today's
   * completion/signature behavior: closed whenever open, never excluded by `keep`. */
  registerPanel(name: string, panel: BufferHostPanel): void {
    this.#panels.set(name, panel);
  }

  /** Every overlay panel is mutually exclusive with every other; opening one must always
   * close the rest, not just the ones a given call site happened to remember. `keep` is the
   * panel being opened: an open*() that defers until services load re-enters itself, and
   * closing its own pending panel there would cancel it and emit a spurious close. */
  closeAllPanels(keep?: string | readonly string[]): void {
    this.activeSession()?.clearMotionGhost();
    const kept = typeof keep === 'string' ? [keep] : keep ?? [];
    for (const [name, panel] of this.#panels) {
      if (!panel.isOpen()) continue;
      if (panel.alwaysClose === true || !kept.includes(name)) panel.close();
    }
  }

  // On-demand rendering only paints after a keypress/resize/pointer event requests a frame.
  // Every service/model subscription that can change what a surface reads must notify here
  // so a later frame reflects it even without further input. `payload` defaults to an
  // 'unspecified' kind so every pre-H2-8 zero-arg call site keeps compiling and behaving the
  // same as a bare "something changed" signal.
  notifySurfaceChange(payload: SurfaceChangePayload = { kind: 'unspecified' }): void {
    this.#pendingSurfaceChanges.push(payload);
    if (this.#surfaceChangeScheduled) return;
    this.#surfaceChangeScheduled = true;
    // Coalesces every surface-change notification raised within one macrotask (e.g. a burst
    // of git/explorer/search updates from the same filesystem event) into a single listener
    // pass carrying all of their payloads; listeners only request a frame/re-read a model, no
    // CPU work is deferred here. setImmediate (not setTimeout) keeps this the very next
    // macrotask, not delayed by the timer queue.
    setImmediate(() => {
      this.#surfaceChangeScheduled = false;
      const payloads = this.#pendingSurfaceChanges;
      this.#pendingSurfaceChanges = [];
      for (const listener of this.#surfaceChangeListeners) listener(payloads);
    });
  }

  /** `listener` may ignore the payload (`() => void`, every call site before H2-8) or read it
   * (`(payloads: readonly SurfaceChangePayload[]) => void`); both are valid JS/TS callback
   * shapes for this signature. */
  onSurfaceChange(listener: (payloads: readonly SurfaceChangePayload[]) => void): Disposable {
    this.#surfaceChangeListeners.add(listener);
    return Object.freeze({ dispose: () => { this.#surfaceChangeListeners.delete(listener); } });
  }

  /** Disposes every live Vim session and the underlying workbench session. Called last in
   * teardown, after every other owner (language, search, explorer, ...) has released its
   * own subscriptions and state. */
  dispose(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    this.#viewClosedListeners.clear();
    this.#bufferClosedListeners.clear();
    this.#session.dispose();
  }
}
