import { asIdentifier, asUtf16Offset, type CancellationToken, CancellationSource, type Disposable, type DocumentId, type Result, type UndoGroupId, type ViewId } from '../../contracts/src/index';
import type { DocumentEdit, DocumentSnapshot } from '../../document/src/index';
import type { TextFileDocument } from '../../document/src/entrypoints/launch';
import type { BufferHost } from '../host';
import type { WorkbenchSession } from '../session';

/** Mirrors `packages/services/formatting`'s `FormatResult`/`FormatterFailure`, subset used
 * here; workbench cannot import `packages/services`, not even types. */
export interface FormatterFormatResult {
  readonly changed: boolean;
  readonly text: string;
  readonly expectedVersion: number;
  readonly formatterIds: readonly string[];
}
export type FormatterFailure = { readonly kind: string; readonly message: string };

/** Narrow port onto `packages/services/formatting`'s `FormatterPipeline`. */
export interface FormatterPipelinePort extends Disposable {
  formatTwiceStable(
    document: { readonly documentId: string; readonly version: number; readonly text: string; readonly path: string },
    currentVersion: () => number,
    cancellation: CancellationToken,
  ): Promise<Result<FormatterFormatResult, FormatterFailure>>;
}

export type PersistenceFailure = { readonly kind: string };

/** Narrow port onto the composition root's `PersistenceService`. */
export interface SaveCoordinatorPersistencePort {
  saveFile(document: TextFileDocument, path: string, cancellation: CancellationToken): Promise<Result<unknown, PersistenceFailure>>;
  clearRecovery(path: string, cancellation: CancellationToken): Promise<Result<unknown, PersistenceFailure>>;
  checkpoint(document: TextFileDocument, path: string, cancellation: CancellationToken): Promise<Result<unknown, PersistenceFailure>>;
}

export interface SaveCoordinatorOptions {
  readonly host: BufferHost;
  readonly session: WorkbenchSession;
  readonly persistence: SaveCoordinatorPersistencePort;
  readonly marker: (name: string, payload?: unknown) => void;
  /** PTY-visible stderr sink; never writes to `process.stderr` itself. */
  readonly onError: (message: string) => void;
  readonly formatOnSave: boolean;
  /** Lazily constructs (memoized here) the environment-configured formatter pipeline;
   * `process.env` reads and the services-owned `FormatterPipeline`/`createExternalFormatter`
   * dynamic import stay composition-root work in `apps/xi/src/main.ts`. */
  readonly createFormatterPipeline: () => Promise<FormatterPipelinePort | undefined>;
  /** Checkpoint debounce, in milliseconds. Defaults to 1500 (E13 crash recovery). */
  readonly checkpointDebounceMilliseconds?: number;
}

/**
 * Owns save/format/checkpoint state that used to live as closure state inside
 * `apps/xi/src/main.ts`'s `main()`: pending-save dedupe (`requestSave`), format-on-save
 * through a lazily constructed formatter pipeline, the debounced crash-recovery
 * checkpoint write and its `tornDown` gate. Stderr messages and `marker(...)` payloads
 * are byte-identical to the moved code.
 */
export class SaveCoordinator implements Disposable {
  readonly #options: SaveCoordinatorOptions;
  readonly #pendingSaves = new Map<string, Promise<boolean>>();
  readonly #checkpointTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #checkpointDebounceMilliseconds: number;
  #formatterPipeline: FormatterPipelinePort | undefined;
  #formattingInitialization: Promise<void> | undefined;
  #formatterOperationNumber = 0;
  #tornDown = false;

  constructor(options: SaveCoordinatorOptions) {
    this.#options = options;
    this.#checkpointDebounceMilliseconds = options.checkpointDebounceMilliseconds ?? 1500;
  }

  get formatterPipeline(): FormatterPipelinePort | undefined { return this.#formatterPipeline; }

  ensureFormatting(): Promise<void> {
    this.#formattingInitialization ??= (async () => {
      this.#formatterPipeline = await this.#options.createFormatterPipeline();
    })();
    return this.#formattingInitialization;
  }

  requestSave(sessionDocument: TextFileDocument, path: string, viewId: ViewId | undefined): Promise<boolean> {
    const key = String(sessionDocument.id);
    const existing = this.#pendingSaves.get(key);
    if (existing !== undefined) return existing;
    const save = (): Promise<boolean> => this.#saveWithConfiguredFormatter(sessionDocument, path, viewId);
    const pending = this.#options.formatOnSave ? this.ensureFormatting().then(save) : save();
    this.#pendingSaves.set(key, pending);
    void pending.then(
      () => { if (this.#pendingSaves.get(key) === pending) this.#pendingSaves.delete(key); },
      () => { if (this.#pendingSaves.get(key) === pending) this.#pendingSaves.delete(key); },
    );
    return pending;
  }

  /** E13 crash recovery: debounced, best-effort, off the keystroke path -- a checkpoint
   * write is scheduled after edits to a dirty buffer settle, not on every commit. */
  scheduleCheckpoint(documentId: DocumentId): void {
    const key = String(documentId);
    const existing = this.#checkpointTimers.get(key);
    if (existing !== undefined) clearTimeout(existing);
    this.#checkpointTimers.set(key, setTimeout(() => {
      this.#checkpointTimers.delete(key);
      void this.#writeCheckpoint(documentId);
    }, this.#checkpointDebounceMilliseconds));
  }

  /** Runs the environment-configured formatter over the active view's document, then
   * (if changed) applies the result through the view's own undo group. */
  async formatView(viewId: ViewId): Promise<boolean> {
    await this.ensureFormatting();
    if (this.#formatterPipeline === undefined) {
      this.#reportFormatterFailure('failed', 'no formatter is configured');
      return false;
    }
    const view = this.#options.session.views().find((candidate) => candidate.viewId === viewId);
    const document = view === undefined ? undefined : this.#options.host.documents.get(view.bufferId);
    const path = view === undefined ? undefined : this.#options.session.buffer(view.bufferId)?.path;
    if (document === undefined || path === undefined) {
      this.#reportFormatterFailure('failed', 'active buffer is unavailable');
      return false;
    }
    return this.#applyConfiguredFormatter(document, path, this.#formatterPipeline, viewId);
  }

  dispose(): void {
    this.#tornDown = true;
    for (const timer of this.#checkpointTimers.values()) clearTimeout(timer);
    this.#checkpointTimers.clear();
    this.#formatterPipeline?.dispose();
  }

  async #writeCheckpoint(documentId: DocumentId): Promise<void> {
    if (this.#tornDown) return;
    const { host, session, persistence, marker } = this.#options;
    const targetDocument = host.documents.get(documentId);
    const buffer = session.buffers().find((candidate) => candidate.documentId === documentId);
    if (targetDocument === undefined || buffer === undefined || buffer.dirty !== true || buffer.path === undefined) return;
    const cancellation = new CancellationSource();
    try {
      const written = await persistence.checkpoint(targetDocument, buffer.path, cancellation.token);
      marker('XI_RECOVERY_CHECKPOINT', { path: buffer.path, ok: written.ok });
    } finally {
      cancellation.dispose();
    }
  }

  async #saveWithConfiguredFormatter(document: TextFileDocument, path: string, viewId: ViewId | undefined): Promise<boolean> {
    if (this.#options.formatOnSave && this.#formatterPipeline !== undefined && !(await this.#applyConfiguredFormatter(document, path, this.#formatterPipeline, viewId))) return false;
    const saved = await this.#saveDocument(document, path);
    if (!saved) this.#reportFormatterFailure('failed', `save failed for ${path}`);
    return saved;
  }

  async #saveDocument(document: TextFileDocument, path: string): Promise<boolean> {
    const cancellation = new CancellationSource();
    try {
      const saved = await this.#options.persistence.saveFile(document, path, cancellation.token);
      if (!saved.ok) {
        this.#options.onError(`xi: cannot save ${path}: ${saved.error.kind}\n`);
        return false;
      }
      // A clean save supersedes any crash-recovery checkpoint for this path; clearing is
      // best-effort (E13) -- a stale leftover journal only affects the next crash-recovery
      // prompt, never this save's own success.
      const cleared = await this.#options.persistence.clearRecovery(path, cancellation.token);
      if (!cleared.ok) this.#options.onError(`xi: could not clear the recovery journal for ${path}: ${cleared.error.kind}\n`);
      return true;
    } finally {
      cancellation.dispose();
    }
  }

  async #applyConfiguredFormatter(document: TextFileDocument, path: string, pipeline: FormatterPipelinePort, viewId: ViewId | undefined): Promise<boolean> {
    const { session, marker } = this.#options;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const snapshot = document.snapshot();
      const text = fullDocumentText(snapshot);
      if (!text.ok) {
        this.#reportFormatterFailure('failed', `cannot read document for formatting: ${text.error.kind}`);
        return false;
      }
      const cancellation = new CancellationSource();
      const result = await pipeline.formatTwiceStable({
        documentId: String(document.id),
        version: snapshot.version as number,
        text: text.value,
        path,
      }, () => document.version as number, cancellation.token);
      cancellation.dispose();
      if (!result.ok) {
        if (result.error.kind === 'stale' && attempt < 3) continue;
        this.#reportFormatterFailure(result.error.kind, result.error.message);
        return false;
      }
      if (!result.value.changed) return true;
      const start = asUtf16Offset(0);
      const end = asUtf16Offset(snapshot.lengthUtf16 as number);
      if (!start.ok || !end.ok) {
        this.#reportFormatterFailure('failed', 'formatter document range is invalid');
        return false;
      }
      const group = asIdentifier<UndoGroupId>(`xi-formatter-${Date.now()}-${this.#formatterOperationNumber += 1}`, 'undoGroupId');
      if (!group.ok) {
        this.#reportFormatterFailure('failed', group.error.message);
        return false;
      }
      const edit: DocumentEdit = { start: start.value, end: end.value, text: result.value.text };
      const applied = viewId === undefined
        ? await session.applyDocumentEdits(document.id, [edit], group.value, 'formatter')
        : await session.applyTextEdits(viewId, [edit], group.value, 'formatter', true);
      if (!applied.ok) {
        if (attempt < 3) continue;
        this.#reportFormatterFailure('stale', `formatted document could not be applied: ${String(applied.error)}`);
        return false;
      }
      marker('XI_FORMAT_APPLIED', { documentId: String(document.id), version: result.value.expectedVersion, formatterIds: result.value.formatterIds });
      return true;
    }
    this.#reportFormatterFailure('stale', 'document kept changing while formatting');
    return false;
  }

  #reportFormatterFailure(kind: string, message: string): void {
    this.#options.onError(`xi: formatter ${kind}: ${message}\n`);
    this.#options.marker('XI_FORMAT_ERROR', { kind, message });
  }
}

function fullDocumentText(snapshot: DocumentSnapshot): Result<string, { readonly kind: string }> {
  const start = asUtf16Offset(0);
  const end = asUtf16Offset(snapshot.lengthUtf16);
  if (!start.ok || !end.ok) return { ok: false, error: { kind: 'invalid-range' } };
  const content = snapshot.slice(start.value, end.value);
  return content.ok ? content : { ok: false, error: { kind: content.error.kind } };
}
