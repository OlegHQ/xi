import { asIdentifier, CancellationSource, type CancellationToken, type PlatformFailure, type Result, type UndoGroupId } from '../../contracts/src/index';
import { encodeTextFile, openTextDocument, positionToOffset, type DocumentEdit, type DocumentSnapshot, type LineIndex, type Utf16Column } from '../../document/src/index';
import type { TextFileDocument } from '../../document/src/entrypoints/launch';
import type { BufferHost } from '../host';
import { buildNavigationRequest, type LanguageServerSessionPort, type LanguageWorkbenchSessionPort, type WorkbenchNavigationRequest } from './overlays';

/** Mirrors `packages/services/language`'s `WorkspaceEditPosition`. */
export interface WorkspaceEditPosition { readonly line: number; readonly utf16: number; }
/** Mirrors `packages/services/language`'s `WorkspaceTextEdit`. */
export interface WorkspaceTextEditPort { readonly uri: string; readonly version: number; readonly start: number; readonly end: number; readonly newText: string; readonly annotationId?: string; }
/** Mirrors `packages/services/language`'s `WorkspaceResourceOperation`. */
export type WorkspaceResourceOperationPort = {
  readonly kind: 'create' | 'rename' | 'delete';
  readonly uri: string;
  readonly newUri?: string;
  readonly annotationId?: string;
  readonly options?: { readonly overwrite?: boolean; readonly ignoreIfExists?: boolean; readonly ignoreIfNotExists?: boolean; readonly recursive?: boolean };
};
/** Mirrors `packages/services/language`'s `WorkspaceEditProposal`. */
export interface WorkspaceEditProposalPort { readonly edits: readonly WorkspaceTextEditPort[]; readonly resources?: readonly WorkspaceResourceOperationPort[]; readonly requestId: string; }
/** Mirrors `packages/services/language`'s `WorkspaceEditFailure`. */
export type WorkspaceEditFailurePort = { readonly kind: 'stale' | 'overlap' | 'collision' | 'invalid-range' | 'apply' | 'disposed'; readonly message: string; readonly uri?: string };
/** Mirrors `packages/services/language`'s `WorkspaceEditProviderFailure`. */
export type WorkspaceEditProviderFailurePort = { readonly kind: 'unavailable' | 'invalid' | 'stale'; readonly message: string };
/** Mirrors `packages/services/language`'s `WorkspaceEditTarget`. */
export interface WorkspaceEditTargetPort { readonly uri: string; readonly version: number; readonly textLength: number; readonly contentHash?: string; }
/** Mirrors `packages/services/language`'s `WorkspaceEditableDocument`: this controller's
 * `loadUnopenedWorkspaceFile`/`openWorkspaceEditDocument` return values are passed by
 * `apps/xi/src/main.ts` straight into the real, services-owned `WorkspaceEditResourceExecutor`,
 * which only requires this shape structurally. */
export interface WorkspaceEditableDocumentPort {
  readonly target: WorkspaceEditTargetPort;
  offset(position: WorkspaceEditPosition): Result<number, WorkspaceEditProviderFailurePort>;
  apply(edits: readonly WorkspaceTextEditPort[]): Promise<Result<void, WorkspaceEditFailurePort>>;
}
/** Mirrors `packages/services/language`'s `WorkspaceEditRequest`. */
export interface WorkspaceEditRequestPort { readonly documentId: string; readonly uri: string; readonly version: number; readonly position: WorkspaceEditPosition; }
/** Mirrors `packages/services/language`'s `LanguageCodeAction`. */
export interface LanguageCodeActionPort {
  readonly id: string;
  readonly title: string;
  readonly kind?: string;
  readonly disabledReason?: string;
  readonly data?: unknown;
  readonly edit?: WorkspaceEditProposalPort;
  readonly command?: { readonly title: string; readonly command: string; readonly arguments: readonly unknown[] };
}
/** Mirrors `packages/services/language`'s `LanguageServerWorkspaceEditProvider`, subset used
 * here. */
export interface WorkspaceEditProviderPort {
  codeActions(request: WorkspaceEditRequestPort & { readonly diagnostics?: readonly unknown[]; readonly cancellation?: CancellationToken }): Promise<Result<readonly LanguageCodeActionPort[], WorkspaceEditProviderFailurePort>>;
  resolveCodeAction?(action: LanguageCodeActionPort): Promise<Result<LanguageCodeActionPort, WorkspaceEditProviderFailurePort>>;
  prepareRename(request: WorkspaceEditRequestPort): Promise<Result<{ readonly start: number; readonly end: number; readonly placeholder?: string } | undefined, WorkspaceEditProviderFailurePort>>;
  rename(request: WorkspaceEditRequestPort, newName: string): Promise<Result<WorkspaceEditProposalPort, WorkspaceEditProviderFailurePort>>;
}
/** Result of `apps/xi/src/main.ts`'s injected `runWorkspaceEditProposal` (wraps the
 * services-owned `applyWorkspaceEditProposal` -- a dynamically-imported free function this
 * controller cannot import statically). */
export interface AppliedWorkspaceEditProposal { readonly applied: { readonly edits: readonly unknown[]; readonly resources?: readonly unknown[] } }
/** Mirrors the retry options accepted by `packages/services/language`'s
 * `renameWithBoundedRetry`. */
export interface RenameRetryOptionsPort { readonly attempts: number; readonly delayMs: number; }
/** Executes one selected code action; mirrors `packages/services/language`'s
 * `executeLanguageCodeAction`. */
export type ExecuteLanguageCodeActionFn = (
  action: LanguageCodeActionPort,
  executor: {
    apply(proposal: WorkspaceEditProposalPort): Promise<Result<void, WorkspaceEditFailurePort>>;
    execute(command: NonNullable<LanguageCodeActionPort['command']>): Promise<Result<void, { readonly kind: 'unsupported' | 'failed'; readonly message: string }>>;
  },
) => Promise<Result<{ readonly editApplied: boolean; readonly commandExecuted: boolean }, { readonly kind: 'disabled' | 'edit' | 'command'; readonly message: string }>>;

/** Narrow port onto the platform filesystem adapter's file IO for an unopened workspace file --
 * mirrors `SearchFilesystemPort`'s own subset. */
export interface WorkspaceEditFilesystemPort {
  readFile(path: string, cancellation: CancellationToken): Promise<Result<Uint8Array, PlatformFailure>>;
  writeFileAtomic(path: string, contents: Uint8Array, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
}

export interface WorkspaceEditsControllerOptions {
  readonly host: BufferHost;
  readonly session: LanguageWorkbenchSessionPort;
  readonly filesystem: WorkspaceEditFilesystemPort;
  readonly marker: (name: string, payload?: unknown) => void;
  /** PTY-visible stderr sink; never writes to `process.stderr` itself. */
  readonly onError: (message: string) => void;
  readonly fileUri: (path: string) => string;
  /** `workspaceRelativePathFromUri(filesystem, workspaceRoot, uri)`, curried by the composition
   * root -- a services-owned free function this controller cannot import. */
  readonly workspaceRelativePathFromUri: (uri: string) => string | undefined;
  /** `filesystem.workspaceAbsolutePath(workspaceRoot, relativePath)`, curried. */
  readonly workspaceAbsolutePath: (relativePath: string) => string | undefined;
  readonly nextDocumentId: () => import('../../contracts/src/index').DocumentId;
  readonly languageId: string | undefined;
  /** Lazily constructs (memoized) the language session/workspace-edit provider -- composition-
   * root work, never duplicated here; a no-op (already-resolved) promise when no language
   * server applies to the current file. */
  readonly ensureLanguage: () => Promise<void>;
  readonly readDiagnostics: () => readonly unknown[];
  /** Wraps the dynamically-imported `applyWorkspaceEditProposal`, bound to the composition
   * root's live `WorkspaceEditCoordinator`/`LanguageServerWorkspaceEditProvider`/
   * `LanguageServerSession`/`WorkspaceEditResourceExecutor` -- returns the same `disposed`
   * failure the original inline check produced when any of those is still unavailable. */
  readonly runWorkspaceEditProposal: (proposal: WorkspaceEditProposalPort) => Promise<Result<AppliedWorkspaceEditProposal, WorkspaceEditFailurePort>>;
  /** Wraps the dynamically-imported `renameWithBoundedRetry`. */
  readonly renameWithRetry: (
    request: WorkspaceEditRequestPort,
    newName: string,
    rename: (request: WorkspaceEditRequestPort, newName: string) => Promise<Result<WorkspaceEditProposalPort, WorkspaceEditProviderFailurePort>>,
    options: RenameRetryOptionsPort | undefined,
  ) => Promise<Result<WorkspaceEditProposalPort, WorkspaceEditProviderFailurePort>>;
  /** Lazily resolves (memoized) the services-owned `executeLanguageCodeAction`, or `undefined`
   * if optional services are still loading and it is not yet available. */
  readonly ensureCodeActionExecutor: () => Promise<ExecuteLanguageCodeActionFn | undefined>;
  readonly codeActionHints?: boolean;
  readonly notifySurfaceChange?: () => void;
}

/**
 * Owns code actions, rename, workspace-edit-proposal application and unopened/open workspace
 * file access for the language feature. Moved out of `apps/xi/src/main.ts`'s `main()` closure.
 * Text edits to an already-open buffer still go only through the workbench's document/edit
 * coordinator (`session.applyDocumentEdits`) -- `openWorkspaceEditDocument`'s returned `apply`
 * calls it directly, exactly as `apps/xi/src/main.ts` did before.
 */
export class WorkspaceEditsController {
  #provider: WorkspaceEditProviderPort | undefined;
  #session: LanguageServerSessionPort | undefined;
  #operationNumber = 0;
  #codeActionHint: { readonly documentId: string; readonly documentVersion: number; readonly count: number } | undefined;
  #codeActionHintCancellation: CancellationSource | undefined;
  readonly #options: WorkspaceEditsControllerOptions;

  constructor(options: WorkspaceEditsControllerOptions) {
    this.#options = options;
  }

  /** Binds the lazily-constructed workspace-edit provider/session once the composition root
   * has created them (mirrors S5/S6's `attachTree`/`attachServices`; no subscription to own). */
  attachLanguage(session: LanguageServerSessionPort, provider: WorkspaceEditProviderPort): void {
    this.#session = session;
    this.#provider = provider;
    void this.refreshCodeActionHints();
  }

  async refreshCodeActionHints(): Promise<void> {
    if (this.#options.codeActionHints !== true) return;
    const request = this.currentNavigationRequest();
    const provider = this.#provider;
    const session = this.#session;
    if (request === undefined || request.uri === undefined || provider === undefined || session === undefined) return;
    this.#codeActionHintCancellation?.cancel();
    const cancellation = new CancellationSource();
    this.#codeActionHintCancellation = cancellation;
    try {
      const ready = await session.waitForReady();
      if (cancellation.token.isCancelled || !ready.ok || !session.supportsRequest('textDocument/codeAction', request.uri)) return;
      const result = await provider.codeActions({
        documentId: request.documentId,
        uri: request.uri,
        version: request.documentVersion,
        position: request.position,
        diagnostics: this.#options.readDiagnostics(),
        cancellation: cancellation.token,
      });
      if (cancellation.token.isCancelled) return;
      if (!result.ok) return;
      this.#codeActionHint = Object.freeze({ documentId: request.documentId, documentVersion: request.documentVersion, count: result.value.filter((action) => action.disabledReason === undefined).length });
      this.#options.marker('XI_CODE_ACTION_HINT_STATE', { documentId: request.documentId, version: request.documentVersion, count: this.#codeActionHint.count });
      this.#options.notifySurfaceChange?.();
    } catch {
      // Optional hints must not affect editing when a server withdraws or crashes.
    } finally {
      if (this.#codeActionHintCancellation === cancellation) this.#codeActionHintCancellation = undefined;
      cancellation.dispose();
    }
  }

  codeActionHint(documentId: string, documentVersion: number): number {
    const hint = this.#codeActionHint;
    return hint?.documentId === documentId && hint.documentVersion === documentVersion ? hint.count : 0;
  }

  currentNavigationRequest(): WorkbenchNavigationRequest | undefined {
    return buildNavigationRequest(this.#options.session, this.#options.fileUri);
  }

  /** `WorkspaceEditResourceExecutor.loadUnopenedFile`: reads, opens and (on `apply`) commits,
   * encodes and atomically writes back a workspace file that has no open buffer. */
  async loadUnopenedWorkspaceFile(uri: string): Promise<WorkspaceEditableDocumentPort | undefined> {
    const relative = this.#options.workspaceRelativePathFromUri(uri);
    const absolute = relative === undefined ? undefined : this.#options.workspaceAbsolutePath(relative);
    if (absolute === undefined) return undefined;
    const cancellation = new CancellationSource();
    let bytes: Uint8Array;
    let document: TextFileDocument;
    try {
      const read = await this.#options.filesystem.readFile(absolute, cancellation.token);
      if (!read.ok) return undefined;
      const opened = openTextDocument(this.#options.nextDocumentId(), read.value);
      if (opened.kind !== 'editable') return undefined;
      bytes = read.value;
      document = opened.document;
    } finally { cancellation.dispose(); }
    const snapshot = document.snapshot();
    return {
      target: { uri, version: 0, textLength: snapshot.lengthUtf16, contentHash: textHash(bytes) },
      offset: (position) => this.#workspaceOffset(document.snapshot(), position),
      apply: async (edits) => {
        const converted = workspaceDocumentEdits(document.snapshot(), edits);
        if (!converted.ok) return workspaceEditFailure('invalid-range', converted.error, uri);
        const group = asIdentifier<UndoGroupId>(`xi-lsp-${Date.now()}-${this.#operationNumber += 1}`, 'undoGroupId');
        if (!group.ok) return workspaceEditFailure('apply', group.error.message, uri);
        const committed = document.commit({ documentId: document.id, expectedVersion: document.version, edits: converted.value, origin: 'lsp', undoGroup: group.value });
        if (!committed.ok) return workspaceEditFailure('apply', committed.error.kind, uri);
        const encoded = encodeTextFile(document.snapshot());
        if (!encoded.ok) return workspaceEditFailure('apply', encoded.error.kind, uri);
        const writeCancellation = new CancellationSource();
        try {
          const written = await this.#options.filesystem.writeFileAtomic(absolute, encoded.value, writeCancellation.token);
          return written.ok ? { ok: true, value: undefined } : workspaceEditFailure('apply', written.error.message, uri);
        } finally { writeCancellation.dispose(); }
      },
    };
  }

  /** `WorkspaceEditResourceExecutor.openDocument`: wraps an already-open buffer so its edits
   * apply through the workbench, which keeps ownership of open-buffer mutation. */
  openWorkspaceEditDocument(uri: string): WorkspaceEditableDocumentPort | undefined {
    const openBuffer = this.#options.session.buffers().find((buffer) => buffer.path !== undefined && this.#options.fileUri(buffer.path) === uri);
    const openDocument = openBuffer === undefined ? undefined : this.#options.host.documents.get(openBuffer.documentId);
    if (openBuffer === undefined || openDocument === undefined) return undefined;
    const snapshot = openDocument.snapshot();
    return {
      target: { uri, version: snapshot.version, textLength: snapshot.lengthUtf16 },
      offset: (position) => this.#workspaceOffset(openDocument.snapshot(), position),
      apply: async (edits) => {
        const converted = workspaceDocumentEdits(openDocument.snapshot(), edits);
        if (!converted.ok) return workspaceEditFailure('invalid-range', converted.error, uri);
        const group = asIdentifier<UndoGroupId>(`xi-lsp-${Date.now()}-${this.#operationNumber += 1}`, 'undoGroupId');
        if (!group.ok) return workspaceEditFailure('apply', group.error.message, uri);
        const applied = await this.#options.session.applyDocumentEdits(openDocument.id, converted.value, group.value, 'lsp');
        return applied.ok ? { ok: true, value: undefined } : workspaceEditFailure('apply', applied.error.kind, uri);
      },
    };
  }

  async requestCodeActions(): Promise<boolean> {
    const request = this.currentNavigationRequest();
    if (request === undefined) {
      this.#options.marker('XI_CODE_ACTION_STATE', { state: 'unavailable' });
      return true;
    }
    this.#options.marker('XI_CODE_ACTION_OPEN');
    await this.#options.ensureLanguage();
    const provider = this.#provider;
    const session = this.#session;
    if (provider === undefined || session === undefined) {
      this.#options.marker('XI_CODE_ACTION_STATE', { state: 'unavailable' });
      return true;
    }
    const ready = await session.waitForReady();
    if (!ready.ok) { this.#options.marker('XI_CODE_ACTION_STATE', { state: 'error', message: ready.error.message }); return true; }
    if (request.uri === undefined) return true;
    const workspaceRequest: WorkspaceEditRequestPort = { documentId: request.documentId, uri: request.uri, version: request.documentVersion, position: request.position };
    const result = await provider.codeActions({ ...workspaceRequest, diagnostics: this.#options.readDiagnostics() });
    if (!result.ok) { this.#options.marker('XI_CODE_ACTION_STATE', { state: 'error', message: result.error.message }); return true; }
    this.#options.marker('XI_CODE_ACTION_STATE', { state: 'ready', actions: result.value.length });
    let action = result.value.find((candidate) => candidate.disabledReason === undefined);
    if (action?.data !== undefined && provider.resolveCodeAction !== undefined) {
      const resolved = await provider.resolveCodeAction(action);
      if (!resolved.ok) { this.#options.onError(`xi: code action resolve failed: ${resolved.error.message}\n`); return true; }
      action = resolved.value;
    }
    if (action !== undefined) {
      const execute = await this.#options.ensureCodeActionExecutor();
      if (execute === undefined) return true;
      const executed = await execute(action, {
        apply: (proposal) => this.applyWorkspaceProposal(proposal),
        execute: async (command) => {
          this.#options.onError(`xi: unsupported language command: ${command.command}\n`);
          return { ok: false, error: { kind: 'unsupported', message: `unsupported language command: ${command.command}` } };
        },
      });
      this.#options.marker('XI_CODE_ACTION_APPLIED', { title: action.title, ok: executed.ok, editApplied: action.edit !== undefined, command: action.command?.command });
    }
    return true;
  }

  async renameCurrent(newName: string): Promise<boolean> {
    const request = this.currentNavigationRequest();
    if (request === undefined) return false;
    await this.#options.ensureLanguage();
    const provider = this.#provider;
    const session = this.#session;
    if (provider === undefined || session === undefined) return false;
    const ready = await session.waitForReady();
    if (!ready.ok) { this.#options.onError(`xi: rename unavailable: ${ready.error.message}\n`); return false; }
    if (request.uri === undefined) return false;
    const workspaceRequest: WorkspaceEditRequestPort = { documentId: request.documentId, uri: request.uri, version: request.documentVersion, position: request.position };
    if (session.supportsRequest('textDocument/prepareRename', request.uri)) {
      const prepared = await provider.prepareRename(workspaceRequest);
      if (!prepared.ok || prepared.value === undefined) { this.#options.onError(`xi: rename unavailable${prepared.ok ? '' : `: ${prepared.error.message}`}\n`); return false; }
      this.#options.marker('XI_RENAME_PREPARED', { start: prepared.value.start, end: prepared.value.end });
    } else {
      this.#options.marker('XI_RENAME_PREPARE_SKIPPED', { reason: 'unsupported' });
    }
    // TypeScript can answer a rename while its project graph is still being populated with
    // only the open file. A bounded retry lets the normal request settle without imposing
    // indexing latency on ordinary typing.
    const result = await this.#options.renameWithRetry(
      workspaceRequest,
      newName,
      (req, name) => provider.rename(req, name),
      this.#options.languageId === 'typescript' ? { attempts: 5, delayMs: 100 } : undefined,
    );
    if (!result.ok) { this.#options.onError(`xi: rename failed: ${result.error.message}\n`); return false; }
    const applied = await this.applyWorkspaceProposal(result.value);
    this.#options.marker('XI_RENAME_APPLIED', { name: newName, ok: applied.ok, edits: result.value.edits.length, files: [...new Set(result.value.edits.map((edit) => edit.uri))] });
    return applied.ok;
  }

  async applyWorkspaceProposal(proposal: WorkspaceEditProposalPort): Promise<Result<void, WorkspaceEditFailurePort>> {
    const applied = await this.#options.runWorkspaceEditProposal(proposal);
    if (!applied.ok) { this.#options.onError(`xi: workspace edit failed: ${applied.error.message}\n`); return applied; }
    this.#options.marker('XI_WORKSPACE_EDIT_APPLIED', { edits: applied.value.applied.edits.length, resources: applied.value.applied.resources?.length ?? 0 });
    return { ok: true, value: undefined };
  }

  dispose(): void {
    this.#codeActionHintCancellation?.cancel();
    this.#codeActionHintCancellation = undefined;
    this.#codeActionHint = undefined;
    this.#provider = undefined;
    this.#session = undefined;
  }

  #workspaceOffset(snapshot: DocumentSnapshot, position: WorkspaceEditPosition): Result<number, WorkspaceEditProviderFailurePort> {
    if (!Number.isSafeInteger(position.line) || position.line < 0 || !Number.isSafeInteger(position.utf16) || position.utf16 < 0) return { ok: false, error: { kind: 'invalid', message: 'workspace edit position is invalid' } };
    const line = position.line as LineIndex;
    const column = position.utf16 as Utf16Column;
    const offsetResult = positionToOffset(snapshot, { version: snapshot.version, line, encoding: 'utf-16', character: column });
    return offsetResult.ok ? { ok: true, value: offsetResult.value as number } : { ok: false, error: { kind: 'invalid', message: `workspace edit position is invalid: ${offsetResult.error.kind}` } };
  }
}

function workspaceDocumentEdits(snapshot: DocumentSnapshot, edits: readonly WorkspaceTextEditPort[]): Result<readonly DocumentEdit[], string> {
  const converted: DocumentEdit[] = [];
  for (const edit of edits) {
    if (edit.end > snapshot.lengthUtf16 || edit.start < 0 || edit.end < edit.start) return { ok: false, error: 'workspace edit range is outside the document' };
    converted.push({ start: edit.start, end: edit.end, text: edit.newText } as DocumentEdit);
  }
  return { ok: true, value: Object.freeze(converted) };
}

function workspaceEditFailure(kind: WorkspaceEditFailurePort['kind'], message: string, uri?: string): Result<never, WorkspaceEditFailurePort> {
  return { ok: false, error: { kind, message, ...(uri === undefined ? {} : { uri }) } };
}

// Content identity only needs a stable, collision-resistant digest for
// equality checks. Bun's native CryptoHasher is hardware-accelerated, unlike
// the previous per-byte BigInt FNV loop.
function textHash(bytes: Uint8Array): string {
  return Bun.CryptoHasher.hash('sha256', bytes, 'hex');
}
