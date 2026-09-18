import type { DocumentId, ViewId } from '../../contracts/src/index';
import type { TextFileDocument } from '../../document/src/entrypoints/launch';
import type { OwnedVimKeyEvent } from '../vim-session';

/** Metadata the composition root already read off disk for one directory entry. */
export interface DirectoryDraftEntryInput {
  readonly name: string;
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly stableIdentity?: string;
  readonly sizeBytes?: number;
  readonly modifiedMilliseconds?: number;
}

export type DirectoryDraftPortResult = { readonly ok: true } | { readonly ok: false; readonly error: { readonly message: string } };

/** The narrow slice of `DirectoryDraft`'s read model this controller's own logic needs
 * (picking a plan to apply, knowing what to re-list). Rendering reads the richer real
 * model directly through `activeReviewPort()` -- the composition root, which already
 * knows the real `packages/services/files` and `packages/ui/directory` shapes, is the only
 * place that ever needs those extra fields; workbench cannot import `packages/services`,
 * not even types (see `docs/plan/01-architecture.md`). */
export interface DirectoryDraftModel {
  readonly focus: 'edit' | 'review';
  readonly directoryPath: string;
  /** Opaque: handed back to `applyPlan` verbatim, never inspected here. */
  readonly review: unknown;
}

/** Narrow structural port onto `packages/services/files`'s `DirectoryDraft`. */
export interface DirectoryDraftPort {
  readonly model: DirectoryDraftModel;
  subscribe(listener: (model: unknown) => void): { dispose(): void };
  openReview(): DirectoryDraftPortResult;
  cancelReview(): DirectoryDraftPortResult;
  /** Rebuilds rows from a fresh on-disk listing after a plan applies, on the same buffer. */
  refreshFromEntries(entries: readonly DirectoryDraftEntryInput[]): DirectoryDraftPortResult;
}

/** Narrow port onto the composition root's directory-listing/stat primitives. */
export interface DirectoryDraftFilesystemPort {
  isDirectory(path: string): Promise<boolean>;
  listEntries(path: string): Promise<{ readonly ok: true; readonly value: readonly DirectoryDraftEntryInput[] } | { readonly ok: false; readonly error: string }>;
  resolvePath(base: string, relative: string): string;
  directoryPath(path: string): string;
}

export interface DirectoryDraftControllerOptions {
  readonly filesystem: DirectoryDraftFilesystemPort;
  readonly workspaceRoot: string;
  readonly activeBufferPath: (viewId: ViewId) => string | undefined;
  /** Constructs the real `DirectoryDraft` (services) and hands back its document and a
   * `DirectoryDraftPort`-shaped view of the same object -- a real `DirectoryDraft` already
   * has every member this narrow interface declares. */
  readonly createDraft: (
    path: string,
    documentId: DocumentId,
    entries: readonly DirectoryDraftEntryInput[],
  ) => { readonly ok: true; readonly value: { readonly port: DirectoryDraftPort; readonly document: TextFileDocument } } | { readonly ok: false; readonly error: string };
  /** Executes a reviewed plan through `JournaledFilesystemOperations`; `plan` is `model.review`
   * passed straight through. */
  readonly applyPlan: (plan: unknown) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
  readonly openBuffer: (path: string) => Promise<boolean>;
  readonly onError: (message: string) => void;
  readonly marker: (name: string, payload?: unknown) => void;
  readonly notifySurfaceChange: () => void;
}

/**
 * Owns T041/T042 directory-as-editable-text orchestration end to end: opening a directory
 * path as a draft buffer, `:w` compiling a plan into review, Enter/Esc while review is
 * focused, executing the reviewed plan through the injected `applyPlan` port and re-listing
 * the directory back into the same buffer. The composition root (`apps/xi/src/main.ts`)
 * only constructs this with structural ports (list/stat, create-draft, apply-plan,
 * open-buffer, message/marker sinks) -- it never inlines this logic into `main()` itself
 * (see `docs/plan/01-architecture.md`, "workbench owns commands/focus").
 */
export class DirectoryDraftController {
  readonly #options: DirectoryDraftControllerOptions;
  readonly #drafts = new Map<DocumentId, DirectoryDraftPort>();
  #activeReview: DocumentId | undefined;

  constructor(options: DirectoryDraftControllerOptions) {
    this.#options = options;
  }

  /** `BufferHost`'s `openDocument` hook: returns a fresh draft document for a directory
   * path, or `undefined` for anything else so the caller's own file-open path is used. */
  async openDocumentIfDirectory(path: string, documentId: DocumentId): Promise<TextFileDocument | undefined> {
    const { filesystem, createDraft, onError } = this.#options;
    if (!(await filesystem.isDirectory(path))) return undefined;
    const listed = await filesystem.listEntries(path);
    if (!listed.ok) {
      onError(`xi: cannot list ${path}: ${listed.error}\n`);
      return undefined;
    }
    const created = createDraft(path, documentId, listed.value);
    if (!created.ok) {
      onError(`xi: cannot open directory draft ${path}: ${created.error}\n`);
      return undefined;
    }
    this.#drafts.set(documentId, created.value.port);
    return created.value.document;
  }

  isDirectoryDraft(documentId: DocumentId): boolean {
    return this.#drafts.has(documentId);
  }

  /** `BufferHost`'s `onBufferClosed` hook. */
  closeDocument(documentId: DocumentId): void {
    if (this.#activeReview === documentId) this.#activeReview = undefined;
    this.#drafts.delete(documentId);
  }

  get isReviewOpen(): boolean {
    return this.#activeReview !== undefined;
  }

  /** The draft currently under review, if any -- the composition root's own rendering
   * adapter reads its real (richer) `.model`/`.subscribe` through this. */
  activeReviewPort(): DirectoryDraftPort | undefined {
    return this.#activeReview === undefined ? undefined : this.#drafts.get(this.#activeReview);
  }

  /** `:w` on a directory-draft buffer (T041/T042 UX): compiles a plan and opens review
   * instead of writing draft text to disk. Returns whether `documentId` was a known draft
   * (i.e. whether the save was handled here at all, independent of compile success). */
  requestSave(documentId: DocumentId): boolean {
    const draft = this.#drafts.get(documentId);
    if (draft === undefined) return false;
    const opened = draft.openReview();
    if (!opened.ok) this.#options.onError('xi: directory draft has validation errors; fix the row and retry\n');
    else this.#activeReview = documentId;
    this.#options.notifySurfaceChange();
    return true;
  }

  /** `:Explore [path]` (`Space O`/`Space o`, docs/plan/03-ux.md, route here too). */
  async explore(target: string | undefined, viewId: ViewId): Promise<void> {
    const { filesystem, workspaceRoot, activeBufferPath, openBuffer, onError } = this.#options;
    const trimmed = target?.trim();
    let resolved: string;
    if (trimmed === undefined || trimmed.length === 0) {
      const currentPath = activeBufferPath(viewId);
      resolved = currentPath === undefined ? workspaceRoot : filesystem.directoryPath(currentPath);
    } else {
      resolved = trimmed.startsWith('/') ? trimmed : filesystem.resolvePath(workspaceRoot, trimmed);
    }
    if (!(await filesystem.isDirectory(resolved))) {
      onError(`xi: not a directory: ${resolved}\n`);
      return;
    }
    const opened = await openBuffer(resolved);
    if (!opened) onError(`xi: cannot open directory: ${resolved}\n`);
  }

  /** Enter/Esc while the directory-review overlay is focused; anything else falls through. */
  handleKeypress(event: OwnedVimKeyEvent): 'handled' | 'unhandled' {
    const activeId = this.#activeReview;
    if (activeId === undefined) return 'unhandled';
    const name = event.name.toLowerCase();
    if (name === 'return' || name === 'enter') {
      void this.#applyActiveReview(activeId);
      return 'handled';
    }
    if (name === 'escape') {
      this.closeReview();
      return 'handled';
    }
    return 'unhandled';
  }

  /** Cancel review and restore edit focus without changing the draft text (T041 acceptance) --
   * also the `BufferHost` panel-exclusivity `close` hook when another panel takes focus. */
  closeReview(): void {
    const activeId = this.#activeReview;
    if (activeId === undefined) return;
    this.#drafts.get(activeId)?.cancelReview();
    this.#activeReview = undefined;
    this.#options.notifySurfaceChange();
  }

  /** Releases every open draft. Callers close review focus and stop tracking documents;
   * this does not touch the workbench-owned session/document lifecycle itself. */
  dispose(): void {
    this.#activeReview = undefined;
    this.#drafts.clear();
  }

  async #applyActiveReview(documentId: DocumentId): Promise<void> {
    const { applyPlan, filesystem, onError, marker, notifySurfaceChange } = this.#options;
    const draft = this.#drafts.get(documentId);
    const plan = draft?.model.review;
    if (draft === undefined || plan === undefined) return;
    const directoryPath = draft.model.directoryPath;
    const applied = await applyPlan(plan);
    if (!applied.ok) {
      onError(`xi: directory apply failed: ${applied.error}\n`);
      marker('XI_DIRECTORY_APPLY_FAILED', { directoryPath });
      return;
    }
    marker('XI_DIRECTORY_APPLY', { directoryPath });
    if (this.#activeReview === documentId) this.#activeReview = undefined;
    const relisted = await filesystem.listEntries(directoryPath);
    if (relisted.ok) {
      const refreshed = draft.refreshFromEntries(relisted.value);
      if (!refreshed.ok) onError(`xi: directory draft refresh failed: ${refreshed.error.message}\n`);
    } else {
      onError(`xi: cannot re-list ${directoryPath} after apply: ${relisted.error}\n`);
    }
    notifySurfaceChange();
  }
}
