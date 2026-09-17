import type { DocumentId, DocumentVersion, Result, Utf16Offset } from '../../contracts/src/index.ts';
import { asUtf16Offset } from '../../contracts/src/index';
import { openTextDocument, TextFileDocument, type DocumentEdit } from '../../document/src/index';

/** Public contract for the in-memory editable directory buffer. */
export const DIRECTORY_DRAFT_CONTRACT_VERSION = 1 as const;

export type DirectoryDraftEntryKind = 'file' | 'directory' | 'symlink' | 'other';

/** Metadata supplied by the explorer. It is never inferred from the display text. */
export interface DirectoryDraftSourceEntry {
  readonly name: string;
  readonly path?: string;
  readonly kind?: DirectoryDraftEntryKind;
  readonly stableIdentity?: string;
  readonly sizeBytes?: number;
  readonly modifiedMilliseconds?: number;
  readonly id?: string;
}

export interface DirectoryDraftMetadata {
  readonly kind: DirectoryDraftEntryKind;
  readonly stableIdentity: string | undefined;
  readonly sizeBytes: number | undefined;
  readonly modifiedMilliseconds: number | undefined;
  readonly sourcePath: string;
}

/** An anchor remains attached to a row while its escaped name is edited. */
export interface DirectoryDraftAnchor {
  readonly id: string;
  readonly offsetUtf16: number;
}

export type DirectoryDraftRowOrigin = 'base' | 'copy' | 'unbound';

export interface DirectoryDraftRow {
  readonly id: string;
  readonly sourceId: string | undefined;
  readonly anchor: DirectoryDraftAnchor;
  readonly line: number;
  readonly escapedName: string;
  readonly rawName: string | undefined;
  readonly origin: DirectoryDraftRowOrigin;
  readonly metadata: DirectoryDraftMetadata | undefined;
}

export type DirectoryOperation =
  | {
    readonly kind: 'rename';
    readonly rowId: string;
    readonly sourceId: string;
    readonly from: string;
    readonly to: string;
    readonly sourcePath: string;
    readonly destinationPath: string;
  }
  | {
    readonly kind: 'trash';
    readonly rowId: string;
    readonly sourceId: string;
    readonly sourcePath: string;
  }
  | {
    readonly kind: 'copy';
    readonly rowId: string;
    readonly sourceId: string;
    readonly sourcePath: string;
    readonly destinationPath: string;
  };

export interface DirectoryOperationPlan {
  readonly contractVersion: 1;
  readonly directoryPath: string;
  readonly baseGeneration: number;
  readonly operations: readonly DirectoryOperation[];
}

export type DirectoryDraftValidationFailure =
  | { readonly kind: 'duplicate-id'; readonly rowId: string; readonly line: number; readonly message: string }
  | { readonly kind: 'invalid-escape'; readonly rowId: string; readonly line: number; readonly column: number; readonly message: string }
  | { readonly kind: 'invalid-name'; readonly rowId: string; readonly line: number; readonly message: string }
  | { readonly kind: 'unknown-identity'; readonly rowId: string; readonly line: number; readonly message: string }
  | { readonly kind: 'ambiguous-rename'; readonly rowId: string; readonly line: number; readonly message: string }
  | { readonly kind: 'duplicate-destination'; readonly rowId: string; readonly line: number; readonly destinationPath: string; readonly message: string }
  | { readonly kind: 'review-not-open'; readonly message: string };

export interface DirectoryDraftError {
  readonly rowId: string | undefined;
  readonly line: number | undefined;
  readonly column: number | undefined;
  readonly kind: DirectoryDraftValidationFailure['kind'];
  readonly message: string;
}

export interface DirectoryDraftReadModel {
  readonly contractVersion: 1;
  readonly generation: number;
  readonly directoryPath: string;
  readonly text: string;
  readonly rows: readonly DirectoryDraftRow[];
  readonly dirty: boolean;
  readonly focus: 'edit' | 'review';
  readonly review: DirectoryOperationPlan | undefined;
  readonly error: DirectoryDraftError | undefined;
}

export interface DirectoryDraftReadPort {
  readonly model: DirectoryDraftReadModel;
  subscribe(listener: (model: DirectoryDraftReadModel) => void): { dispose(): void };
}

export interface DirectoryDraftOptions {
  /** Path comparison is exact by default; set false for a case-insensitive volume. */
  readonly caseSensitive?: boolean;
  readonly documentId?: string;
}

export interface DirectoryYankBuffer {
  readonly rows: readonly DirectoryDraftRow[];
}

interface MutableRow {
  id: string;
  sourceId: string | undefined;
  anchorId: string;
  anchorOffset: number;
  escapedName: string;
  rawName: string | undefined;
  origin: DirectoryDraftRowOrigin;
  metadata: DirectoryDraftMetadata | undefined;
}

/**
 * An editable directory document. It only changes an in-memory draft: disk
 * effects are represented by a reviewed operation plan for T042 to execute.
 * Row IDs are generated independently from names, and are therefore safe to
 * use as anchors even when a filename is renamed to another valid name.
 */
export class DirectoryDraft implements DirectoryDraftReadPort {
  readonly #directoryPath: string;
  readonly #caseSensitive: boolean;
  readonly #base = new Map<string, DirectoryDraftSourceEntry>();
  readonly #listeners = new Set<(model: DirectoryDraftReadModel) => void>();
  readonly #document: TextFileDocument;
  #initialVersion: DocumentVersion;
  #rows: MutableRow[];
  #text: string;
  #generation = 0;
  #nextId = 1;
  #focus: 'edit' | 'review' = 'edit';
  #review: DirectoryOperationPlan | undefined;
  #error: DirectoryDraftError | undefined;
  #disposed = false;
  #syncing = false;

  static create(
    directoryPath: string,
    entries: readonly DirectoryDraftSourceEntry[],
    options: DirectoryDraftOptions = {},
  ): Result<DirectoryDraft, DirectoryDraftValidationFailure> {
    if (!isDirectoryPath(directoryPath)) {
      return { ok: false, error: { kind: 'invalid-name', rowId: '', line: 0, message: 'directory path must be nonempty and contain no NUL' } };
    }
    const seen = new Set<string>();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === undefined || !isValidRawName(entry.name)) {
        return { ok: false, error: { kind: 'invalid-name', rowId: entry?.id ?? '', line: index, message: 'directory entry has an invalid name' } };
      }
      const id = entry.id ?? `row-${index + 1}`;
      if (!isOpaqueId(id) || seen.has(id)) {
        return { ok: false, error: { kind: 'duplicate-id', rowId: id, line: index, message: 'directory entries must have unique opaque IDs' } };
      }
      seen.add(id);
    }
    return { ok: true, value: new DirectoryDraft(directoryPath, entries, options, seen) };
  }

  private constructor(
    directoryPath: string,
    entries: readonly DirectoryDraftSourceEntry[],
    options: DirectoryDraftOptions,
    ids: ReadonlySet<string>,
  ) {
    this.#directoryPath = trimTrailingSlash(directoryPath);
    this.#caseSensitive = options.caseSensitive !== false;
    const rows: MutableRow[] = [];
    let offset = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      const id = entry.id ?? `row-${index + 1}`;
      const sourcePath = entry.path ?? joinPath(this.#directoryPath, entry.name);
      const metadata: DirectoryDraftMetadata = Object.freeze({
        kind: entry.kind ?? 'file',
        stableIdentity: entry.stableIdentity,
        sizeBytes: entry.sizeBytes,
        modifiedMilliseconds: entry.modifiedMilliseconds,
        sourcePath,
      });
      const escapedName = escapeDirectoryName(entry.name);
      this.#base.set(id, Object.freeze({ ...entry, id }));
      rows.push({
        id,
        sourceId: id,
        anchorId: `anchor-${id}`,
        anchorOffset: offset,
        escapedName,
        rawName: entry.name,
        origin: 'base',
        metadata,
      });
      offset += escapedName.length + 1;
    }
    // `ids` is deliberately consumed here to make the constructor's invariant
    // explicit to readers and to guard future changes from unused-id mistakes.
    if (ids.size !== this.#base.size) throw new Error('directory-draft-id-invariant');
    this.#rows = rows;
    this.#text = rows.map((row) => row.escapedName).join('\n');
    const documentId = toDocumentId(options.documentId ?? 'directory-draft');
    const opened = openTextDocument(documentId, new TextEncoder().encode(this.#text), 41027, { fileFormat: 'unix' });
    if (opened.kind !== 'editable') throw new Error('directory-draft-document-open-failed');
    this.#document = opened.document;
    this.#initialVersion = this.#document.version;
    // Native Vim edits (dd/yy/p/u/macros) land on `#document` directly through a normal
    // Vim session opened against it, never through this class's own methods below --
    // this keeps rows/anchors in sync with whatever committed the edit.
    this.#document.subscribeChanges((change) => {
      if (this.#syncing || this.#disposed) return;
      this.applyHistoryOutcome(change.edits);
      this.#review = undefined;
      this.#focus = 'edit';
      this.publish();
    });
  }

  get model(): DirectoryDraftReadModel { return this.buildModel(); }
  get text(): string { return this.#text; }
  get isDirty(): boolean { return this.#document.version !== this.#initialVersion; }
  /** The buffer a normal Vim session edits directly; row tracking follows it via
   * `subscribeChanges` above regardless of which session or method committed the edit. */
  get document(): TextFileDocument { return this.#document; }

  subscribe(listener: (model: DirectoryDraftReadModel) => void): { dispose(): void } {
    if (this.#disposed) throw new Error('directory-draft-disposed');
    this.#listeners.add(listener);
    return Object.freeze({ dispose: () => { this.#listeners.delete(listener); } });
  }

  /** Replace a UTF-16 range, as the Vim/document coordinator would. */
  applyEdit(start: number, end: number, replacement: string): Result<void, DirectoryDraftValidationFailure> {
    if (this.#disposed) return this.failUnknown('', 0, 'directory draft is disposed');
    if (!isSafeBoundary(this.#text, start) || !isSafeBoundary(this.#text, end) || start > end) {
      return this.failUnknown('', 0, 'edit range is not a valid UTF-16 boundary');
    }
    if (replacement.includes('\r')) return this.failUnknown('', 0, 'directory draft edits must use LF text');
    const startOffset = asUtf16Offset(start);
    const endOffset = asUtf16Offset(end);
    if (!startOffset.ok || !endOffset.ok) return this.failUnknown('', 0, 'edit range is not a valid UTF-16 boundary');
    const edit: DocumentEdit = { start: startOffset.value, end: endOffset.value, text: replacement };
    this.#syncing = true;
    const committed = this.#document.applyBatch([edit], this.#document.version);
    this.#syncing = false;
    if (!committed.ok) return this.failUnknown('', 0, `directory draft edit was rejected: ${committed.error.kind}`);
    this.#text = this.currentDocumentText();
    this.#rows = this.remapRows(this.#rows, [edit]);
    this.#review = undefined;
    this.#focus = 'edit';
    this.#error = undefined;
    this.publish();
    return { ok: true, value: undefined };
  }

  /** Convenience for a Vim-style replacement of one escaped row. */
  setRowText(rowId: string, escapedName: string): Result<void, DirectoryDraftValidationFailure> {
    const row = this.#rows.find((candidate) => candidate.id === rowId);
    if (row === undefined) return this.failUnknown(rowId, 0, 'row identity is not present in this draft');
    return this.applyEdit(row.anchorOffset, row.anchorOffset + row.escapedName.length, escapedName);
  }

  rename(rowId: string, rawName: string): Result<void, DirectoryDraftValidationFailure> {
    if (!isValidRawName(rawName)) return this.failName(rowId, this.lineOf(rowId), 'filename is empty, contains NUL, or contains a path separator');
    return this.setRowText(rowId, escapeDirectoryName(rawName));
  }

  /** Delete rows from the draft. The filesystem is never called. */
  delete(rowIds: readonly string[]): Result<void, DirectoryDraftValidationFailure> {
    const selected = this.rowsForIds(rowIds);
    if (!selected.ok) return selected;
    if (selected.value.length === 0) return { ok: true, value: undefined };
    const deleted = new Set(selected.value.map((row) => row.id));
    const nextRows = this.#rows.filter((row) => !deleted.has(row.id));
    const committed = this.commitFullText(nextRows.map((row) => row.escapedName).join('\n'));
    if (!committed.ok) return committed;
    this.#rows = this.recomputeOffsets(nextRows);
    this.#review = undefined;
    this.#focus = 'edit';
    this.#error = undefined;
    this.publish();
    return { ok: true, value: undefined };
  }

  yank(rowIds: readonly string[]): Result<DirectoryYankBuffer, DirectoryDraftValidationFailure> {
    const selected = this.rowsForIds(rowIds);
    if (!selected.ok) return selected;
    return { ok: true, value: Object.freeze({ rows: Object.freeze(selected.value.map((row, line) => this.publicRow(row, line))) }) };
  }

  /** Paste as explicit copies with fresh IDs; originals remain untouched. */
  put(buffer: DirectoryYankBuffer, afterRowId?: string): Result<readonly string[], DirectoryDraftValidationFailure> {
    return this.paste(buffer, afterRowId === undefined ? {} : { afterRowId });
  }

  /**
   * `preserveIdentity` exists only for replay/import paths. It intentionally
   * leaves duplicate IDs visible so review can reject them with a row error.
   */
  paste(
    buffer: DirectoryYankBuffer,
    options: { readonly afterRowId?: string; readonly preserveIdentity?: boolean } = {},
  ): Result<readonly string[], DirectoryDraftValidationFailure> {
    if (this.#disposed) return this.failUnknown('', 0, 'directory draft is disposed');
    const afterIndex = options.afterRowId === undefined ? this.#rows.length - 1 : this.#rows.findIndex((row) => row.id === options.afterRowId);
    if (afterIndex < -1) return this.failUnknown(options.afterRowId ?? '', 0, 'paste destination row is not present');
    const inserted: MutableRow[] = buffer.rows.map((source) => {
      const preserve = options.preserveIdentity === true;
      const id = preserve ? source.id : this.nextOpaqueId();
      return {
        id,
        sourceId: source.sourceId ?? source.id,
        anchorId: `anchor-${id}-${this.#generation + 1}`,
        anchorOffset: 0,
        escapedName: source.escapedName,
        rawName: source.rawName,
        metadata: source.metadata,
        origin: 'copy',
      };
    });
    const nextRows = [...this.#rows];
    nextRows.splice(afterIndex + 1, 0, ...inserted);
    const committed = this.commitFullText(nextRows.map((row) => row.escapedName).join('\n'));
    if (!committed.ok) return committed;
    this.#rows = this.recomputeOffsets(nextRows);
    this.#review = undefined;
    this.#focus = 'edit';
    this.#error = undefined;
    this.publish();
    return { ok: true, value: Object.freeze(inserted.map((row) => row.id)) };
  }

  undo(): Result<void, DirectoryDraftValidationFailure> {
    if (this.#disposed) return this.failUnknown('', 0, 'directory draft is disposed');
    this.#syncing = true;
    const outcome = this.#document.undo();
    this.#syncing = false;
    if (!outcome.ok) return this.failUnknown('', 0, `nothing to undo: ${outcome.error.kind}`);
    this.applyHistoryOutcome(outcome.value.change.edits);
    this.#review = undefined;
    this.#focus = 'edit';
    this.publish();
    return { ok: true, value: undefined };
  }

  redo(): Result<void, DirectoryDraftValidationFailure> {
    if (this.#disposed) return this.failUnknown('', 0, 'directory draft is disposed');
    this.#syncing = true;
    const outcome = this.#document.redo();
    this.#syncing = false;
    if (!outcome.ok) return this.failUnknown('', 0, `nothing to redo: ${outcome.error.kind}`);
    this.applyHistoryOutcome(outcome.value.change.edits);
    this.#review = undefined;
    this.#focus = 'edit';
    this.publish();
    return { ok: true, value: undefined };
  }

  compilePlan(): Result<DirectoryOperationPlan, DirectoryDraftValidationFailure> {
    const plan = this.compile();
    if (!plan.ok) {
      this.#error = toReadError(plan.error);
      this.#review = undefined;
      this.publish();
      return plan;
    }
    this.#error = undefined;
    return plan;
  }

  /** Compile and move focus to review. A failed compile leaves text untouched. */
  openReview(): Result<DirectoryOperationPlan, DirectoryDraftValidationFailure> {
    const plan = this.compilePlan();
    if (!plan.ok) return plan;
    this.#review = plan.value;
    this.#focus = 'review';
    this.publish();
    return plan;
  }

  /** Cancel review and restore edit focus without changing the draft text. */
  cancelReview(): Result<void, DirectoryDraftValidationFailure> {
    if (this.#focus !== 'review') return { ok: false, error: { kind: 'review-not-open', message: 'directory review is not open' } };
    this.#focus = 'edit';
    this.#review = undefined;
    this.#error = undefined;
    this.publish();
    return { ok: true, value: undefined };
  }

  /**
   * Re-enumerate the on-disk directory into this same buffer/document after a reviewed
   * plan (T042) has been applied -- entries, rows and anchors are rebuilt from scratch
   * (paths/identities on disk have just changed), but the `TextFileDocument` instance
   * itself, and therefore the view/session already open on it, is kept.
   */
  refreshFromEntries(entries: readonly DirectoryDraftSourceEntry[]): Result<void, DirectoryDraftValidationFailure> {
    if (this.#disposed) return this.failUnknown('', 0, 'directory draft is disposed');
    const seen = new Set<string>();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === undefined || !isValidRawName(entry.name)) {
        return this.failName(entry?.id ?? '', index, 'directory entry has an invalid name');
      }
      const id = entry.id ?? `row-${index + 1}`;
      if (!isOpaqueId(id) || seen.has(id)) return this.failUnknown(id, index, 'directory entries must have unique opaque IDs');
      seen.add(id);
    }
    this.#base.clear();
    const rows: MutableRow[] = [];
    let offset = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      const id = entry.id ?? `row-${index + 1}`;
      const sourcePath = entry.path ?? joinPath(this.#directoryPath, entry.name);
      const metadata: DirectoryDraftMetadata = Object.freeze({
        kind: entry.kind ?? 'file',
        stableIdentity: entry.stableIdentity,
        sizeBytes: entry.sizeBytes,
        modifiedMilliseconds: entry.modifiedMilliseconds,
        sourcePath,
      });
      const escapedName = escapeDirectoryName(entry.name);
      this.#base.set(id, Object.freeze({ ...entry, id }));
      rows.push({ id, sourceId: id, anchorId: `anchor-${id}`, anchorOffset: offset, escapedName, rawName: entry.name, origin: 'base', metadata });
      offset += escapedName.length + 1;
    }
    const newText = rows.map((row) => row.escapedName).join('\n');
    const committed = this.commitFullText(newText);
    if (!committed.ok) return committed;
    this.#rows = rows;
    this.#initialVersion = this.#document.version;
    this.#review = undefined;
    this.#error = undefined;
    this.#focus = 'edit';
    this.publish();
    return { ok: true, value: undefined };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
  }

  private compile(): Result<DirectoryOperationPlan, DirectoryDraftValidationFailure> {
    const seenIds = new Set<string>();
    const destinations = new Map<string, MutableRow>();
    const operations: DirectoryOperation[] = [];
    for (let index = 0; index < this.#rows.length; index += 1) {
      const row = this.#rows[index];
      if (row === undefined) continue;
      const line = index;
      if (seenIds.has(row.id)) {
        return { ok: false, error: { kind: 'duplicate-id', rowId: row.id, line, message: 'pasted row duplicates an existing opaque identity' } };
      }
      seenIds.add(row.id);
      const decoded = decodeDirectoryName(row.escapedName);
      if (!decoded.ok) {
        return { ok: false, error: { kind: 'invalid-escape', rowId: row.id, line, column: decoded.column, message: decoded.message } };
      }
      if (!isValidRawName(decoded.value)) {
        return { ok: false, error: { kind: 'invalid-name', rowId: row.id, line, message: 'filename is empty, contains NUL, or contains a path separator' } };
      }
      const destinationPath = joinPath(this.#directoryPath, decoded.value);
      const collisionKey = this.#caseSensitive ? destinationPath : destinationPath.toLocaleLowerCase('en-US');
      const previous = destinations.get(collisionKey);
      if (previous !== undefined) {
        return { ok: false, error: { kind: 'duplicate-destination', rowId: row.id, line, destinationPath, message: `destination collides with row ${previous.id}` } };
      }
      destinations.set(collisionKey, row);
      if (row.sourceId === undefined) {
        return { ok: false, error: { kind: 'unknown-identity', rowId: row.id, line, message: 'row has no anchored source identity' } };
      }
      const source = this.#base.get(row.sourceId);
      if (source === undefined) {
        return { ok: false, error: { kind: 'unknown-identity', rowId: row.id, line, message: 'row identity is not present in the base directory listing' } };
      }
      const sourcePath = source.path ?? joinPath(this.#directoryPath, source.name);
      if (row.origin === 'copy') {
        operations.push({ kind: 'copy', rowId: row.id, sourceId: row.sourceId, sourcePath, destinationPath });
      } else if (decoded.value !== source.name) {
        if (destinationPath === sourcePath) {
          return { ok: false, error: { kind: 'ambiguous-rename', rowId: row.id, line, message: 'rename resolves to the source path with a different spelling' } };
        }
        operations.push({ kind: 'rename', rowId: row.id, sourceId: row.sourceId, from: source.name, to: decoded.value, sourcePath, destinationPath });
      }
    }
    for (const [sourceId, source] of this.#base) {
      if (!seenIds.has(sourceId)) {
        operations.push({ kind: 'trash', rowId: sourceId, sourceId, sourcePath: source.path ?? joinPath(this.#directoryPath, source.name) });
      }
    }
    return {
      ok: true,
      value: Object.freeze({
        contractVersion: DIRECTORY_DRAFT_CONTRACT_VERSION,
        directoryPath: this.#directoryPath,
        baseGeneration: this.#generation,
        operations: Object.freeze(operations),
      }),
    };
  }

  private rowsForIds(rowIds: readonly string[]): Result<MutableRow[], DirectoryDraftValidationFailure> {
    const requested = new Set(rowIds);
    const rows = this.#rows.filter((row) => requested.has(row.id));
    if (rows.length !== requested.size) {
      const missing = rowIds.find((id) => !rows.some((row) => row.id === id)) ?? '';
      return this.failUnknown(missing, this.lineOf(missing), 'row identity is not present in this draft');
    }
    return { ok: true, value: rows };
  }

  private bindRowsToText(rows: readonly MutableRow[]): MutableRow[] {
    const starts = lineStarts(this.#text);
    const byOffset = new Map(rows.map((row) => [row.anchorOffset, row]));
    const bound: MutableRow[] = [];
    for (let line = 0; line < starts.length; line += 1) {
      const start = starts[line] ?? 0;
      const end = line + 1 < starts.length ? (starts[line + 1] ?? this.#text.length) - 1 : this.#text.length;
      const row = byOffset.get(start);
      if (row === undefined) {
        const id = this.nextOpaqueId();
        bound.push({ id, sourceId: undefined, anchorId: `anchor-${id}`, anchorOffset: start, escapedName: this.#text.slice(start, end), rawName: undefined, origin: 'unbound', metadata: undefined });
      } else {
        const escapedName = this.#text.slice(start, end);
        const decoded = decodeDirectoryName(escapedName);
        bound.push({ ...row, anchorOffset: start, escapedName, rawName: decoded.ok ? decoded.value : undefined });
      }
    }
    return bound;
  }

  /** Recompute contiguous line offsets after rows are filtered/spliced with `text` already committed. */
  private recomputeOffsets(rows: readonly MutableRow[]): MutableRow[] {
    let offset = 0;
    return rows.map((row) => {
      const next = { ...row, anchorOffset: offset };
      offset += row.escapedName.length + 1;
      return next;
    });
  }

  /** Replace the whole document text with `newText` in a single document commit. */
  private commitFullText(newText: string): Result<void, DirectoryDraftValidationFailure> {
    const oldText = this.#text;
    if (newText === oldText) return { ok: true, value: undefined };
    const edit: DocumentEdit = { start: utf16(0), end: utf16(oldText.length), text: newText };
    this.#syncing = true;
    const committed = this.#document.applyBatch([edit], this.#document.version);
    this.#syncing = false;
    if (!committed.ok) return this.failUnknown('', 0, `directory draft edit was rejected: ${committed.error.kind}`);
    this.#text = newText;
    return { ok: true, value: undefined };
  }

  private currentDocumentText(): string {
    const snapshot = this.#document.snapshot();
    const sliced = snapshot.slice(utf16(0), utf16(snapshot.lengthUtf16));
    return sliced.ok ? sliced.value : this.#text;
  }

  /** Remap existing row anchors through a batch of ordered, non-overlapping document edits. */
  private remapRows(rows: readonly MutableRow[], edits: readonly DocumentEdit[]): MutableRow[] {
    const ordered = [...edits].sort((left, right) => (left.start as number) - (right.start as number));
    const nextRows: MutableRow[] = [];
    for (const row of rows) {
      const mapped = mapOffsetThroughEdits(row.anchorOffset, ordered);
      if (mapped === undefined) continue;
      nextRows.push({ ...row, anchorOffset: mapped });
    }
    return this.bindRowsToText(nextRows);
  }

  private applyHistoryOutcome(edits: readonly DocumentEdit[]): void {
    const oldRows = this.#rows;
    this.#text = this.currentDocumentText();
    this.#rows = this.remapRows(oldRows, edits);
    this.#error = undefined;
  }

  private nextOpaqueId(): string {
    let id = `row-${this.#nextId++}`;
    while (this.#rows.some((row) => row.id === id) || this.#base.has(id)) id = `row-${this.#nextId++}`;
    return id;
  }

  private lineOf(rowId: string): number {
    const index = this.#rows.findIndex((row) => row.id === rowId);
    return index < 0 ? 0 : index;
  }

  private publicRow(row: MutableRow, line: number): DirectoryDraftRow {
    return Object.freeze({
      id: row.id,
      sourceId: row.sourceId,
      anchor: Object.freeze({ id: row.anchorId, offsetUtf16: row.anchorOffset }),
      line,
      escapedName: row.escapedName,
      rawName: row.rawName,
      origin: row.origin,
      metadata: row.metadata,
    });
  }

  private buildModel(): DirectoryDraftReadModel {
    return Object.freeze({
      contractVersion: DIRECTORY_DRAFT_CONTRACT_VERSION,
      generation: this.#generation,
      directoryPath: this.#directoryPath,
      text: this.#text,
      rows: Object.freeze(this.#rows.map((row, line) => Object.freeze({
        id: row.id,
        sourceId: row.sourceId,
        anchor: Object.freeze({ id: row.anchorId, offsetUtf16: row.anchorOffset }),
        line,
        escapedName: row.escapedName,
        rawName: row.rawName,
        origin: row.origin,
        metadata: row.metadata,
      }))),
      dirty: this.isDirty,
      focus: this.#focus,
      review: this.#review,
      error: this.#error,
    });
  }

  private publish(): void {
    this.#generation += 1;
    const model = this.buildModel();
    for (const listener of [...this.#listeners]) listener(model);
  }

  private failUnknown(rowId: string, line: number, message: string): Result<never, DirectoryDraftValidationFailure> {
    return { ok: false, error: { kind: 'unknown-identity', rowId, line, message } };
  }

  private failName(rowId: string, line: number, message: string): Result<never, DirectoryDraftValidationFailure> {
    return { ok: false, error: { kind: 'invalid-name', rowId, line, message } };
  }
}

export function createDirectoryDraft(
  directoryPath: string,
  entries: readonly DirectoryDraftSourceEntry[],
  options: DirectoryDraftOptions = {},
): Result<DirectoryDraft, DirectoryDraftValidationFailure> {
  return DirectoryDraft.create(directoryPath, entries, options);
}

export function escapeDirectoryName(name: string): string {
  let output = '';
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '\\') output += '\\\\';
    else if (character === '\n') output += '\\n';
    else if (character === '\t') output += '\\t';
    else if (character === '\r') output += '\\r';
    else if (code < 0x20 || code === 0x7f) output += `\\x${code.toString(16).padStart(2, '0')}`;
    else output += character;
  }
  return output;
}

export function decodeDirectoryName(value: string): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly column: number; readonly message: string } {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '\\') {
      output += character ?? '';
      continue;
    }
    const next = value[index + 1];
    if (next === undefined) return { ok: false, column: index, message: 'escape ends at end of row' };
    if (next === 'n' || next === 't' || next === 'r' || next === '\\') {
      output += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : '\\';
      index += 1;
      continue;
    }
    if (next === 'x') {
      const hex = value.slice(index + 2, index + 4);
      if (!/^[0-9a-fA-F]{2}$/u.test(hex)) return { ok: false, column: index, message: 'hex escape requires exactly two hexadecimal digits' };
      output += String.fromCharCode(Number.parseInt(hex, 16));
      index += 3;
      continue;
    }
    return { ok: false, column: index, message: `unknown escape \\${next}` };
  }
  return { ok: true, value: output };
}

function toReadError(error: DirectoryDraftValidationFailure): DirectoryDraftError {
  if ('rowId' in error && 'line' in error) {
    return { rowId: error.rowId, line: error.line, column: 'column' in error ? error.column : undefined, kind: error.kind, message: error.message };
  }
  return { rowId: undefined, line: undefined, column: undefined, kind: error.kind, message: error.message };
}

/** Map an offset in the pre-edit text through a batch of ordered, non-overlapping edits; `undefined` if the offset fell inside a replaced span. */
function mapOffsetThroughEdits(offset: number, edits: readonly DocumentEdit[]): number | undefined {
  let delta = 0;
  for (const edit of edits) {
    const start = edit.start as number;
    const end = edit.end as number;
    if (offset > start && offset < end) return undefined;
    if (offset <= start) return offset + delta;
    delta += edit.text.length - (end - start);
  }
  return offset + delta;
}

function utf16(value: number): Utf16Offset { return value as Utf16Offset; }
function toDocumentId(value: string): DocumentId { return value as DocumentId; }

function lineStarts(text: string): number[] {
  if (text.length === 0) return [];
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) if (text[index] === '\n') starts.push(index + 1);
  return starts;
}
function isSafeBoundary(text: string, offset: number): boolean { return Number.isSafeInteger(offset) && offset >= 0 && offset <= text.length && (offset === 0 || offset === text.length || !isSurrogateSplit(text, offset)); }
function isSurrogateSplit(text: string, offset: number): boolean { const before = text.charCodeAt(offset - 1); const after = text.charCodeAt(offset); return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff; }
function isValidRawName(name: string): boolean { return name.length > 0 && !name.includes('\0') && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..'; }
function isDirectoryPath(path: string): boolean { return path.length > 0 && !path.includes('\0'); }
function isOpaqueId(id: string): boolean { return id.length > 0 && id.length <= 256 && !/[\s/\\\0]/u.test(id); }
function trimTrailingSlash(path: string): string { return path.length > 1 ? path.replace(/\/+$/u, '') : path; }
function joinPath(directory: string, name: string): string { return `${trimTrailingSlash(directory)}/${name}`; }
