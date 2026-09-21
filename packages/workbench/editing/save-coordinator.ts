import { asIdentifier, asUtf16Offset, type CancellationToken, CancellationSource, type ClockPort, type Disposable, type DocumentId, type Result, type UndoGroupId, type Utf16Offset, type ViewId } from '../../contracts/src/index';
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
  saveFile(document: TextFileDocument, path: string, cancellation: CancellationToken, options?: { readonly atomic?: boolean }): Promise<Result<unknown, PersistenceFailure>>;
  clearRecovery(path: string, cancellation: CancellationToken): Promise<Result<unknown, PersistenceFailure>>;
  checkpoint(document: TextFileDocument, path: string, cancellation: CancellationToken): Promise<Result<unknown, PersistenceFailure>>;
  /** Stop and await any checkpoint write already in progress for `path` (see PersistenceService). */
  cancelPendingCheckpoint?(path: string): Promise<void>;
}

export interface SaveCoordinatorOptions {
  readonly host: BufferHost;
  readonly session: WorkbenchSession;
  readonly persistence: SaveCoordinatorPersistencePort;
  readonly clock: ClockPort;
  readonly marker: (name: string, payload?: unknown) => void;
  /** PTY-visible stderr sink; never writes to `process.stderr` itself. */
  readonly onError: (message: string) => void;
  /** Tentative completion edits are visible in the document but must never reach persistence. */
  readonly isTransientEditActive?: (documentId: DocumentId) => boolean;
  readonly formatOnSave: boolean;
  readonly formatOnSaveForPath?: (path: string) => boolean;
  readonly formatterKeyForPath?: (path: string) => string;
  /** Helix's `editor.insert-final-newline`; omitted keeps the compatibility default. */
  readonly insertFinalNewline?: boolean;
  /** Helix's `editor.trim-final-newlines`; omitted disables save trimming. */
  readonly trimFinalNewlines?: boolean;
  /** Helix's `editor.trim-trailing-whitespace`; omitted disables save trimming. */
  readonly trimTrailingWhitespace?: boolean;
  readonly editorConfigForPath?: (path: string) => { readonly insertFinalNewline?: boolean; readonly trimTrailingWhitespace?: boolean } | undefined;
  /** Fired after a file is actually written to disk (not on a directory-draft review or a
   * failed save); the composition root uses this to refresh Git status without polling. */
  readonly onSaved?: (path: string) => void;
  /** Lazily constructs (memoized here) the environment-configured formatter pipeline;
   * `process.env` reads and the services-owned `FormatterPipeline`/`createExternalFormatter`
   * dynamic import stay composition-root work in `apps/xi/src/main.ts`. */
  readonly createFormatterPipeline: (path?: string) => Promise<FormatterPipelinePort | undefined>;
  /** Checkpoint debounce, in milliseconds. Defaults to 1500 (E13 crash recovery). */
  readonly checkpointDebounceMilliseconds?: number;
  /** Helix `editor.auto-save.after-delay`; disabled unless explicitly enabled. */
  readonly autoSaveAfterDelay?: { readonly enable: boolean; readonly timeout: number };
  /** Helix `editor.auto-save.focus-lost`; disabled unless explicitly enabled. */
  readonly autoSaveFocusLost?: boolean;
  /** Helix's `editor.atomic-save`; omitted keeps atomic replacement enabled. */
  readonly atomicSave?: boolean;
}

type SavePolicy = {
  readonly atomicSave: boolean;
  readonly insertFinalNewline: boolean;
  readonly trimFinalNewlines: boolean;
  readonly trimTrailingWhitespace: boolean;
  readonly autoSaveAfterDelay: SaveCoordinatorOptions['autoSaveAfterDelay'];
  readonly autoSaveFocusLost: boolean;
};

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
  // The document version each in-flight (or just-settled, until cleanup runs) save was
  // requested for; lets a concurrent request tell "identical to the in-flight save" (piggyback,
  // no extra write) apart from "a newer version was committed since" (needs a follow-up write).
  readonly #pendingSaveVersions = new Map<string, unknown>();
  readonly #checkpointTimers = new Map<string, Disposable>();
  readonly #autoSaveTimers = new Map<string, Disposable>();
  // Tracks a checkpoint write already in flight (its debounce timer already fired) so a save
  // started while it is running can await it instead of racing it to disk.
  readonly #inFlightCheckpoints = new Map<string, Promise<void>>();
  readonly #checkpointDebounceMilliseconds: number;
  #savePolicy: SavePolicy;
  readonly #formatterPipelines = new Map<string, FormatterPipelinePort | undefined>();
  readonly #formattingInitializations = new Map<string, Promise<void>>();
  #formatterOperationNumber = 0;
  #saveNormalizationOperationNumber = 0;
  #tornDown = false;

  constructor(options: SaveCoordinatorOptions) {
    this.#options = options;
    this.#checkpointDebounceMilliseconds = options.checkpointDebounceMilliseconds ?? 1500;
    this.#savePolicy = {
      atomicSave: options.atomicSave ?? true,
      insertFinalNewline: options.insertFinalNewline ?? false,
      trimFinalNewlines: options.trimFinalNewlines ?? false,
      trimTrailingWhitespace: options.trimTrailingWhitespace ?? false,
      autoSaveAfterDelay: options.autoSaveAfterDelay,
      autoSaveFocusLost: options.autoSaveFocusLost ?? false,
    };
  }

  updateSavePolicy(policy: SavePolicy): void {
    this.#savePolicy = policy;
    for (const timer of this.#autoSaveTimers.values()) timer.dispose();
    this.#autoSaveTimers.clear();
    if (policy.autoSaveAfterDelay?.enable === true) {
      for (const buffer of this.#options.session.buffers()) if (buffer.dirty) this.scheduleAutoSave(buffer.documentId);
    }
  }

  get formatterPipeline(): FormatterPipelinePort | undefined { return this.#formatterPipelines.get(''); }

  #formatterKey(path: string): string { return this.#options.formatterKeyForPath?.(path) ?? path; }

  ensureFormatting(path = ''): Promise<void> {
    const key = this.#formatterKey(path);
    let initialization = this.#formattingInitializations.get(key);
    if (initialization === undefined) {
      initialization = this.#options.createFormatterPipeline(path || undefined).then((pipeline) => { this.#formatterPipelines.set(key, pipeline); });
      this.#formattingInitializations.set(key, initialization);
    }
    return initialization;
  }

  requestSave(sessionDocument: TextFileDocument, path: string, viewId: ViewId | undefined): Promise<boolean> {
    const key = String(sessionDocument.id);
    if (this.#options.isTransientEditActive?.(sessionDocument.id) === true) {
      this.#options.onError('xi: accept, dismiss, or undo the completion preview before saving\n');
      return Promise.resolve(false);
    }
    this.#autoSaveTimers.get(key)?.dispose();
    this.#autoSaveTimers.delete(key);
    const requestedVersion = sessionDocument.version;
    const existing = this.#pendingSaves.get(key);
    if (existing !== undefined) {
      // A save requested for the same version already in flight can piggyback on it. But a
      // newer version (a keystroke committed after the in-flight save captured its bytes, e.g.
      // `:w`, type, `:w`) must not silently resolve to that save's result: chain a follow-up
      // save once it settles so the newest bytes actually get written.
      if (this.#pendingSaveVersions.get(key) === requestedVersion) return existing;
      return existing.then(() => this.requestSave(sessionDocument, path, viewId));
    }
    // A save must not race a crash-recovery checkpoint for the same document: cancel any
    // still-debouncing checkpoint outright, and await one already writing so the save's own
    // write (and its clearRecovery) always lands after it, never concurrently with it. No
    // checkpoint is rescheduled here afterward -- only a later edit reschedules one.
    const existingTimer = this.#checkpointTimers.get(key);
    if (existingTimer !== undefined) { existingTimer.dispose(); this.#checkpointTimers.delete(key); }
    const inFlightCheckpoint = this.#inFlightCheckpoints.get(key);
    const policy = this.#savePolicy;
    const save = async (): Promise<boolean> => {
      if (inFlightCheckpoint !== undefined) await inFlightCheckpoint;
      await this.#options.persistence.cancelPendingCheckpoint?.(path);
      return this.#saveWithConfiguredFormatter(sessionDocument, path, viewId, policy);
    };
    const pending = (this.#options.formatOnSaveForPath?.(path) ?? this.#options.formatOnSave) ? this.ensureFormatting(path).then(save) : save();
    this.#pendingSaveVersions.set(key, requestedVersion);
    this.#pendingSaves.set(key, pending);
    void pending.then(
      () => { if (this.#pendingSaves.get(key) === pending) { this.#pendingSaves.delete(key); this.#pendingSaveVersions.delete(key); } },
      () => { if (this.#pendingSaves.get(key) === pending) { this.#pendingSaves.delete(key); this.#pendingSaveVersions.delete(key); } },
    );
    return pending;
  }

  /** E13 crash recovery: debounced, best-effort, off the keystroke path -- a checkpoint
   * write is scheduled after edits to a dirty buffer settle, not on every commit. */
  scheduleCheckpoint(documentId: DocumentId): void {
    const key = String(documentId);
    const existing = this.#checkpointTimers.get(key);
    if (existing !== undefined) existing.dispose();
    this.#checkpointTimers.set(key, this.#options.clock.schedule(this.#checkpointDebounceMilliseconds, () => {
      this.#checkpointTimers.delete(key);
      const write = this.#writeCheckpoint(documentId);
      this.#inFlightCheckpoints.set(key, write);
      void write.finally(() => { if (this.#inFlightCheckpoints.get(key) === write) this.#inFlightCheckpoints.delete(key); });
    }));
  }

  /** Schedule one bounded, reset-on-edit save through the same guarded save path as `:w`. */
  scheduleAutoSave(documentId: DocumentId): void {
    const config = this.#savePolicy.autoSaveAfterDelay;
    if (config?.enable !== true) return;
    const key = String(documentId);
    this.#autoSaveTimers.get(key)?.dispose();
    this.#autoSaveTimers.set(key, this.#options.clock.schedule(config.timeout, () => {
      this.#autoSaveTimers.delete(key);
      const document = this.#options.host.documents.get(documentId);
      const buffer = this.#options.session.buffers().find((candidate) => candidate.documentId === documentId);
      if (document === undefined || buffer?.dirty !== true || buffer.path === undefined) return;
      void this.requestSave(document, buffer.path, undefined);
    }));
  }

  /** Save every dirty file when the terminal reports focus leaving Xi. */
  handleFocusChange(focused: boolean): void {
    this.#options.marker('XI_AUTO_SAVE_FOCUS', { focused, enabled: this.#savePolicy.autoSaveFocusLost });
    if (focused || !this.#savePolicy.autoSaveFocusLost || this.#tornDown) return;
    for (const buffer of this.#options.session.buffers()) {
      if (!buffer.dirty || buffer.path === undefined) continue;
      const document = this.#options.host.documents.get(buffer.documentId);
      if (document !== undefined) void this.requestSave(document, buffer.path, undefined);
    }
  }

  /** Runs the environment-configured formatter over the active view's document, then
   * (if changed) applies the result through the view's own undo group. */
  async formatView(viewId: ViewId): Promise<boolean> {
    const view = this.#options.session.views().find((candidate) => candidate.viewId === viewId);
    const document = view === undefined ? undefined : this.#options.host.documents.get(view.bufferId);
    const path = view === undefined ? undefined : this.#options.session.buffer(view.bufferId)?.path;
    if (document === undefined || path === undefined) {
      this.#reportFormatterFailure('failed', 'active buffer is unavailable');
      return false;
    }
    await this.ensureFormatting(path);
    const pipeline = this.#formatterPipelines.get(this.#formatterKey(path));
    if (pipeline === undefined) {
      this.#reportFormatterFailure('failed', 'no formatter is configured');
      return false;
    }
    return this.#applyConfiguredFormatter(document, path, pipeline, viewId);
  }

  dispose(): void {
    this.#tornDown = true;
    for (const timer of this.#checkpointTimers.values()) timer.dispose();
    this.#checkpointTimers.clear();
    for (const timer of this.#autoSaveTimers.values()) timer.dispose();
    this.#autoSaveTimers.clear();
    for (const pipeline of this.#formatterPipelines.values()) pipeline?.dispose();
    this.#formatterPipelines.clear();
  }

  async #writeCheckpoint(documentId: DocumentId): Promise<void> {
    if (this.#tornDown) return;
    if (this.#options.isTransientEditActive?.(documentId) === true) return;
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

  async #saveWithConfiguredFormatter(document: TextFileDocument, path: string, viewId: ViewId | undefined, policy: SavePolicy): Promise<boolean> {
    const pipeline = this.#formatterPipelines.get(this.#formatterKey(path));
    if ((this.#options.formatOnSaveForPath?.(path) ?? this.#options.formatOnSave) && pipeline !== undefined && !(await this.#applyConfiguredFormatter(document, path, pipeline, viewId))) return false;
    if (!(await this.#normalizeForSave(document, path, viewId, policy))) return false;
    const saved = await this.#saveDocument(document, path, policy);
    if (!saved) this.#reportFormatterFailure('failed', `save failed for ${path}`);
    return saved;
  }

  async #saveDocument(document: TextFileDocument, path: string, policy: SavePolicy): Promise<boolean> {
    if (this.#options.isTransientEditActive?.(document.id) === true) return false;
    const cancellation = new CancellationSource();
    try {
      this.#options.marker('XI_SAVE_POLICY', { path, atomic: policy.atomicSave });
      const saved = await this.#options.persistence.saveFile(document, path, cancellation.token, { atomic: policy.atomicSave });
      if (!saved.ok) {
        this.#options.onError(`xi: cannot save ${path}: ${saved.error.kind}\n`);
        return false;
      }
      // A clean save supersedes any crash-recovery checkpoint for this path; clearing is
      // best-effort (E13) -- a stale leftover journal only affects the next crash-recovery
      // prompt, never this save's own success.
      const cleared = await this.#options.persistence.clearRecovery(path, cancellation.token);
      if (!cleared.ok) this.#options.onError(`xi: could not clear the recovery journal for ${path}: ${cleared.error.kind}\n`);
      this.#options.onSaved?.(path);
      return true;
    } finally {
      cancellation.dispose();
    }
  }

  async #normalizeForSave(document: TextFileDocument, path: string, viewId: ViewId | undefined, policy: SavePolicy): Promise<boolean> {
    const fileSettings = this.#options.editorConfigForPath?.(path);
    const insertFinalNewline = fileSettings?.insertFinalNewline ?? policy.insertFinalNewline;
    const trimFinalNewlines = policy.trimFinalNewlines;
    const trimTrailingWhitespace = fileSettings?.trimTrailingWhitespace ?? policy.trimTrailingWhitespace;
    if (!insertFinalNewline && !trimFinalNewlines && !trimTrailingWhitespace) return true;
    const snapshot = document.snapshot();
    const applyEdits = async (edits: readonly DocumentEdit[]): Promise<boolean> => {
      if (document.version !== snapshot.version) {
        this.#options.onError('xi: document changed during save normalization; retry the save\n');
        return false;
      }
      const group = asIdentifier<UndoGroupId>(`xi-save-normalization-${Date.now()}-${this.#saveNormalizationOperationNumber += 1}`, 'undoGroupId');
      if (!group.ok) {
        this.#options.onError(`xi: cannot normalize document before save: ${group.error.message}\n`);
        return false;
      }
      const applied = viewId === undefined
        ? await this.#options.session.applyDocumentEdits(document.id, edits, group.value, 'formatter')
        : await this.#options.session.applyTextEdits(viewId, edits, group.value, 'formatter', false);
      if (!applied.ok) {
        this.#options.onError(`xi: cannot normalize document before save: ${String(applied.error)}\n`);
        return false;
      }
      this.#options.marker('XI_SAVE_NORMALIZATION_APPLIED', { documentId: String(document.id), version: applied.value.version, insertFinalNewline, trimFinalNewlines, trimTrailingWhitespace });
      return true;
    };
    if (insertFinalNewline && !trimFinalNewlines && !trimTrailingWhitespace) {
      if (snapshot.hasFinalNewline) return true;
      const end = asUtf16Offset(snapshot.lengthUtf16 as number);
      if (!end.ok) {
        this.#options.onError('xi: cannot normalize document before save: invalid document range\n');
        return false;
      }
      return applyEdits([{ start: end.value, end: end.value, text: '\n' }]);
    }
    const edits: DocumentEdit[] = [];
    const addEdit = (startValue: number, endValue: number, replacement: string): boolean => {
      const start = asUtf16Offset(startValue);
      const end = asUtf16Offset(endValue);
      if (!start.ok || !end.ok) return false;
      edits.push({ start: start.value, end: end.value, text: replacement });
      return true;
    };
    let rangesValid = true;
    let whitespaceStart: number | undefined;
    let finalNewlineStart: number | undefined;
    let lastCharacter = '';
    for (let offset = 0; offset < snapshot.lengthUtf16;) {
      let end = Math.min(snapshot.lengthUtf16, offset + 16_384);
      let chunk = snapshot.slice(offset as Utf16Offset, end as Utf16Offset);
      if (!chunk.ok && end < snapshot.lengthUtf16) chunk = snapshot.slice(offset as Utf16Offset, --end as Utf16Offset);
      if (!chunk.ok) {
        this.#options.onError(`xi: cannot normalize document before save: ${chunk.error.kind}\n`);
        return false;
      }
      for (let index = 0; index < chunk.value.length; index += 1) {
        const absolute = offset + index;
        const character = chunk.value[index]!;
        if (character === '\n') {
          if (trimTrailingWhitespace && whitespaceStart !== undefined && !addEdit(whitespaceStart, absolute, '')) rangesValid = false;
          whitespaceStart = undefined;
          finalNewlineStart ??= absolute;
        } else {
          finalNewlineStart = undefined;
          if (trimTrailingWhitespace && (character === ' ' || character === '\t')) whitespaceStart ??= absolute;
          else whitespaceStart = undefined;
        }
        lastCharacter = character;
      }
      offset = end;
      await new Promise<void>((done) => setImmediate(done));
    }
    if (trimFinalNewlines && finalNewlineStart !== undefined && snapshot.lengthUtf16 - finalNewlineStart > 1 && !addEdit(finalNewlineStart + 1, snapshot.lengthUtf16, '')) rangesValid = false;
    if (insertFinalNewline && lastCharacter !== '\n' && !addEdit(snapshot.lengthUtf16, snapshot.lengthUtf16, '\n')) rangesValid = false;
    if (edits.length === 0) return true;
    if (!rangesValid) {
      this.#options.onError('xi: cannot normalize document before save: invalid document range\n');
      return false;
    }
    return applyEdits(edits);
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
      // The edit below is built from `snapshot`'s length; if the document changed while the
      // formatter ran (a keystroke committed mid-format), applying it would clobber those
      // newer bytes with a whole-document replace sized to the stale snapshot. Re-check the
      // version immediately before applying (no await between here and the call) and retry
      // with a fresh snapshot instead.
      if ((document.version as number) !== (snapshot.version as number)) {
        if (attempt < 3) continue;
        this.#reportFormatterFailure('stale', 'document changed while formatting');
        return false;
      }
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
