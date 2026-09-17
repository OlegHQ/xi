import { asIdentifier, type DocumentId, type Disposable, type ViewId } from '../../contracts/src/index';
import type { SelectionSetSnapshot } from '../../selections/src/index';
import type { TextFileDocument } from '../../document/src/entrypoints/launch';
import type { VimHostCommand } from '../../vim/src/index';
import { createOwnedVimSession } from '../vim-session';
import type { OwnedVimKeyEvent, OwnedVimSession, VimCommandLineState, VimPrefixHelpState } from '../vim-session';
import type { WorkbenchSession } from '../session';

export type { OwnedVimKeyEvent };

export type HostCommandPort = (command: VimHostCommand, viewId: ViewId) => void | Promise<void>;

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
  readonly onMessage?: (message: string) => void;
  readonly onSave?: (document: TextFileDocument, viewId: ViewId, target: string | undefined) => Promise<boolean>;
  readonly onExCommand?: (source: string, viewId: ViewId) => Promise<'handled' | 'unhandled' | 'quit'> | 'handled' | 'unhandled' | 'quit';
  readonly onHostCommand?: HostCommandPort;
  readonly onPrefixStateChange?: (viewId: ViewId, state: VimPrefixHelpState) => void;
  readonly onCommandLineChange?: (state: VimCommandLineState | undefined) => void;
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
  readonly #surfaceChangeListeners = new Set<() => void>();
  #surfaceChangePending = false;
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

  /** Promotes a buffer out of preview -- needed on commit even when the buffer was opened
   * non-preview, since `openBufferAtPath`'s "already open" branch reuses an existing buffer
   * regardless of its current preview flag. Also clears `previewViewId` if it still pointed
   * at this same view. */
  promoteBuffer(bufferId: DocumentId, viewId: ViewId): void {
    this.#session.promoteBuffer(bufferId);
    if (this.previewViewId === viewId) this.previewViewId = undefined;
  }

  createSession(document: TextFileDocument, viewId: ViewId, initialSelections?: SelectionSetSnapshot, initialLine?: number): OwnedVimSession {
    const options = this.#options;
    const resolvedInitialLine = initialLine ?? (viewId === options.launchViewId ? options.launchInitialLine : undefined);
    const session = createOwnedVimSession(document, {
      viewId,
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
        const bufferId = this.#session.readView(viewId)?.document.id;
        if (bufferId !== undefined && this.#session.buffer(bufferId)?.dirty === true) {
          this.#session.promoteBuffer(bufferId);
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
    const existing = this.#session.buffers().find((buffer) => buffer.path !== undefined && relativePath !== undefined && this.#options.workspaceRelativePath(buffer.path) === relativePath);
    if (existing !== undefined) {
      const viewId = existing.viewIds[0];
      if (viewId === undefined) return undefined;
      this.#session.focus(viewId);
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
    const openedBuffer = this.#session.openBuffer(openedFile, { path, ...(options.preview === true ? { preview: true } : {}) });
    if (!openedBuffer.ok) {
      this.documents.delete(openedFile.id);
      return undefined;
    }
    const viewId = openedBuffer.value.viewIds[0];
    if (viewId === undefined) return undefined;
    this.createSession(openedFile, viewId, undefined, options.line === undefined ? undefined : options.line + 1);
    this.#session.focus(viewId);
    return { viewId, bufferId: openedFile.id, created: true };
  }

  /** Closes `viewId` if (and only if) it is still marked `preview` -- once an edit or an
   * explicit commit has promoted it, it is real, kept work and must never be silently
   * closed just because a caller still happens to be tracking it as a preview. */
  discardPreviewView(viewId: ViewId): { readonly ok: boolean; readonly activeViewId: ViewId | undefined } {
    const view = this.#session.views().find((candidate) => candidate.viewId === viewId);
    const bufferId = view?.bufferId;
    if (bufferId === undefined || this.#session.buffer(bufferId)?.preview !== true) return { ok: false, activeViewId: undefined };
    const closed = this.#session.closeView(viewId, 'discard');
    this.sessions.get(viewId)?.dispose();
    this.sessions.delete(viewId);
    if (closed.ok) this.documents.delete(bufferId);
    return { ok: closed.ok, activeViewId: closed.ok ? closed.value.activeViewId : undefined };
  }

  /** Resolves a picker "buffer" entry (keyed by `String(bufferId)`) to its first view and
   * focuses it. Returns the view id, or `undefined` when no such buffer is open. */
  focusBufferById(bufferId: string): ViewId | undefined {
    const buffer = this.#session.buffers().find((candidate) => String(candidate.bufferId) === bufferId);
    const viewId = buffer?.viewIds[0];
    if (viewId !== undefined) this.#session.focus(viewId);
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
  closeAllPanels(keep?: string): void {
    for (const [name, panel] of this.#panels) {
      if (!panel.isOpen()) continue;
      if (panel.alwaysClose === true || name !== keep) panel.close();
    }
  }

  // On-demand rendering only paints after a keypress/resize/pointer event requests a frame.
  // Every service/model subscription that can change what a surface reads must notify here
  // so the next tick's frame reflects it even without further input.
  notifySurfaceChange(): void {
    if (this.#surfaceChangePending) return;
    this.#surfaceChangePending = true;
    queueMicrotask(() => {
      this.#surfaceChangePending = false;
      for (const listener of this.#surfaceChangeListeners) listener();
    });
  }

  onSurfaceChange(listener: () => void): Disposable {
    this.#surfaceChangeListeners.add(listener);
    return Object.freeze({ dispose: () => { this.#surfaceChangeListeners.delete(listener); } });
  }

  /** Disposes every live Vim session and the underlying workbench session. Called last in
   * teardown, after every other owner (language, search, explorer, ...) has released its
   * own subscriptions and state. */
  dispose(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    this.#session.dispose();
  }
}
