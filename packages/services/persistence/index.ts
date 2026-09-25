import type {
  CancellationToken,
  FileInfo,
  FilesystemPort,
  PlatformFailure,
  Result,
} from '../../contracts/src/index';
import { asIdentifier } from '../../contracts/src/index';
import type { DocumentId, DocumentVersion } from '../../contracts/src/index';
import { encodeTextFileChunks } from '../../document/src/entrypoints/launch';
import type {
  OpenTextDocument,
  OpenTextDocumentOptions,
  ReadOnlyByteDocument,
  RevisionId,
  TextDocumentCreateFailure,
  TextFileDocument,
  TextFileSnapshot,
} from '../../document/src/entrypoints/launch';

/**
 * Services never construct or mutate documents themselves (docs/architecture.md
 * ownership table): opening a file's bytes/chunks into a `TextFileDocument`, and restoring
 * one from a recovery checkpoint, are the composition root's job. This service only asks
 * for one through this port, injected at construction (`apps/xi/src/main.ts`).
 */
export interface PersistenceDocumentFactory {
  openText(id: DocumentId, bytes: Uint8Array, seed: number, options: OpenTextDocumentOptions): OpenTextDocument;
  openTextChunks(id: DocumentId, chunks: AsyncIterable<Uint8Array>, seed: number, options: OpenTextDocumentOptions): Promise<OpenTextDocument>;
  restoreCheckpoint(
    id: DocumentId,
    normalizedText: string,
    lineEndings: readonly ('lf' | 'crlf' | 'cr' | 'ff' | 'nel')[],
    defaultLineEnding: 'lf' | 'crlf' | 'cr' | 'ff' | 'nel',
    hasUtf8Bom: boolean,
    seed: number,
    textIntent: 'literal-control' | undefined,
  ): Result<TextFileDocument, TextDocumentCreateFailure>;
}

const RECOVERY_SCHEMA_VERSION = 1 as const;
const SESSION_SCHEMA_VERSION = 1 as const;
const DEFAULT_MAX_RECOVERY_ENTRIES = 64;
const DEFAULT_MAX_RECOVERY_BYTES = 16 * 1024 * 1024;
// Bun's async stream setup is disproportionately expensive for tiny files.
// Keep streaming for large inputs, while using one bounded read for the common
// launch path so opening a small buffer does not pay a second event-loop turn.
const SMALL_FILE_READ_THRESHOLD_BYTES = 256 * 1024;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export interface FileIdentity {
  readonly path: string;
  readonly kind: FileInfo['kind'];
  readonly sizeBytes: number;
  readonly modifiedMilliseconds: number;
  readonly contentHash: string;
  readonly device?: string;
  readonly inode?: string;
  readonly linkCount?: number;
}

export type PersistenceFailure =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'disposed' }
  | { readonly kind: 'platform'; readonly failure: PlatformFailure }
  | { readonly kind: 'not-found'; readonly path: string }
  | { readonly kind: 'invalid-open'; readonly reason: string }
  | { readonly kind: 'read-only'; readonly reason: string }
  | { readonly kind: 'external-change'; readonly path: string; readonly expected: FileIdentity | null; readonly actual: FileIdentity | null }
  | { readonly kind: 'symlink-save'; readonly path: string; readonly message: string }
  | { readonly kind: 'hardlink-save'; readonly path: string; readonly message: string }
  | { readonly kind: 'stale-document-version'; readonly expected: DocumentVersion; readonly actual: DocumentVersion }
  | { readonly kind: 'serialize'; readonly message: string }
  | { readonly kind: 'journal-corrupt'; readonly path: string; readonly message: string }
  | { readonly kind: 'journal-too-large'; readonly path: string; readonly bytes: number }
  | { readonly kind: 'recovery-diverged'; readonly path: string; readonly expected: FileIdentity | null; readonly actual: FileIdentity | null }
  | { readonly kind: 'session-corrupt'; readonly path: string; readonly message: string };

export interface OpenFileOptions extends OpenTextDocumentOptions {
  readonly seed?: number;
}

export type OpenedFile = OpenedEditableFile | OpenedReadOnlyFile;

export interface OpenedEditableFile {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly kind: 'editable';
  readonly document: TextFileDocument;
}

export interface OpenedReadOnlyFile {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly kind: 'read-only';
  readonly document: ReadOnlyByteDocument;
}

export interface SaveFileOptions {
  /** Identity returned by openFile. If omitted, the service uses its last open identity for this document. */
  readonly expectedDisk?: FileIdentity | null;
  /** Save exactly this immutable document revision; a later edit remains dirty. */
  readonly expectedVersion?: DocumentVersion;
  /** Whether to replace through the atomic filesystem primitive; defaults to true. */
  readonly atomic?: boolean;
}

export interface SaveFileResult {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly persistedRevision: RevisionId;
  readonly persistedVersion: DocumentVersion;
  readonly documentVersion: DocumentVersion;
  readonly isDirty: boolean;
  /** False means the document is persisted but journal cleanup should be retried. */
  readonly recoveryJournalCleared: boolean;
}

export interface RecoveryCheckpoint {
  readonly schemaVersion: typeof RECOVERY_SCHEMA_VERSION;
  readonly path: string;
  readonly documentId: string;
  readonly documentVersion: number;
  readonly revisionId: number;
  readonly baseDisk: FileIdentity | null;
  readonly normalizedText: string;
  readonly lineEndings: readonly ('lf' | 'crlf' | 'cr' | 'ff' | 'nel')[];
  readonly defaultLineEnding: 'lf' | 'crlf' | 'cr' | 'ff' | 'nel';
  readonly hasUtf8Bom: boolean;
}

export type RecoveryResult =
  | { readonly kind: 'none'; readonly path: string }
  | { readonly kind: 'recovered'; readonly path: string; readonly checkpoint: RecoveryCheckpoint; readonly document: TextFileDocument; readonly baseDisk: FileIdentity | null; readonly disk: FileIdentity | null }
  | { readonly kind: 'disk-diverged'; readonly path: string; readonly checkpoint: RecoveryCheckpoint; readonly document: TextFileDocument; readonly expected: FileIdentity | null; readonly actual: FileIdentity | null };

export interface RecoveryOptions {
  readonly journalPath?: string;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly seed?: number;
}

export interface SessionDocumentState {
  readonly documentId: string;
  readonly path: string;
  readonly viewIds?: readonly string[];
}

export interface SessionSnapshot {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly roots: readonly string[];
  readonly documents: readonly SessionDocumentState[];
  readonly activeDocumentId?: string;
}

interface JournalEntryEncoding {
  readonly json: string;
  readonly encoded: Uint8Array;
  readonly bytes: number;
}

interface JournalCacheEntry {
  /** Size/mtime observed when this cache entry was produced; `null` means "file absent". Invalidated by a differing stat. */
  readonly info: { readonly sizeBytes: number; readonly modifiedMilliseconds: number } | null;
  readonly entries: readonly RecoveryCheckpoint[];
  readonly encoded: readonly JournalEntryEncoding[];
}

/** Optional deletion capability some filesystem ports (e.g. NodeFilesystemPort) provide beyond
 * the base FilesystemPort contract. Duck-typed the same way `readFileChunks` already is. */
interface RemovableFilesystemPort extends FilesystemPort {
  removePath?(path: string, recursive: boolean, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
}

export class PersistenceService {
  readonly #filesystem: RemovableFilesystemPort;
  readonly #opened = new Map<string, FileIdentity>();
  readonly #journalCache = new Map<string, JournalCacheEntry>();
  /** Journal path -> the in-flight checkpoint write for it, and a way to stop it early.
   * Bounded by the number of journals with a checkpoint currently in flight (ordinarily 0 or 1). */
  readonly #pendingCheckpoints = new Map<string, { readonly promise: Promise<Result<RecoveryCheckpoint, PersistenceFailure>>; readonly cancel: () => void }>();
  readonly #onError: (message: string) => void;
  readonly #documents: PersistenceDocumentFactory | undefined;
  readonly #journalPathForPath: (path: string) => string;
  #disposed = false;

  constructor(filesystem: FilesystemPort, onError: (message: string) => void = () => {}, documents?: PersistenceDocumentFactory, journalPathForPath = recoveryJournalPath) {
    this.#filesystem = filesystem;
    this.#onError = onError;
    this.#documents = documents;
    this.#journalPathForPath = journalPathForPath;
  }

  /** `openFile`/`recover` construct documents; both require the composition root to have
   * injected `documents` at construction (`apps/xi/src/main.ts`) -- there is no in-package
   * default, since this package never imports `openTextDocument`/`TextFileDocument` itself. */
  #requireDocuments(): PersistenceDocumentFactory {
    if (this.#documents === undefined) throw new Error('persistence-document-factory-not-configured');
    return this.#documents;
  }

  /** Idempotent. Releases the opened-file and journal caches; later calls fail with `{ kind: 'disposed' }`. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#opened.clear();
    this.#journalCache.clear();
    for (const pending of this.#pendingCheckpoints.values()) pending.cancel();
    this.#pendingCheckpoints.clear();
  }

  /** Release this document's cached disk identity and its journal's cache entry. Callers must
   * invoke this when a document closes, or #opened/#journalCache grow for every file ever
   * opened in a long-lived session instead of only currently-open ones. */
  closeDocument(documentId: DocumentId, journalPath?: string): void {
    const identity = this.#opened.get(documentId);
    this.#opened.delete(documentId);
    const path = journalPath ?? (identity === undefined ? undefined : this.#journalPathForPath(identity.path));
    if (path !== undefined) this.#journalCache.delete(path);
    if (identity !== undefined) this.#journalCache.delete(recoveryJournalPath(identity.path));
  }

  /**
   * A save (or anything else about to make this journal's content stale) must call this first.
   * It stops any checkpoint currently being written for `path` at its next safe point and
   * awaits it, so a slow in-flight checkpoint write can never land after -- and silently
   * reintroduce a stale recovery journal for -- a save that already completed. The workbench
   * save coordinator (owned elsewhere) is expected to call this before saveFile.
   */
  async cancelPendingCheckpoint(path: string, journalPath = this.#journalPathForPath(path)): Promise<void> {
    const pending = this.#pendingCheckpoints.get(journalPath);
    if (pending === undefined) return;
    pending.cancel();
    await pending.promise.catch(() => {});
  }

  async openFile(
    path: string,
    documentId: DocumentId,
    cancellation: CancellationToken,
    options: OpenFileOptions = {},
  ): Promise<Result<OpenedFile, PersistenceFailure>> {
    if (this.#disposed) return { ok: false, error: { kind: 'disposed' } };
    const initial = await this.#stat(path, cancellation);
    if (!initial.ok) return initial;
    if (initial.value === undefined) return { ok: false, error: { kind: 'not-found', path } };
    if (initial.value.kind !== 'file' && initial.value.kind !== 'symlink') {
      return { ok: false, error: { kind: 'invalid-open', reason: `path is ${initial.value.kind}` } };
    }
    const textOptions: OpenTextDocumentOptions = {
      ...(options.fileFormat === undefined ? {} : { fileFormat: options.fileFormat }),
      ...(options.defaultLineEnding === undefined ? {} : { defaultLineEnding: options.defaultLineEnding }),
      ...(options.editorConfigLineEnding === undefined ? {} : { editorConfigLineEnding: options.editorConfigLineEnding }),
    };
    const readChunks = this.#filesystem.readFileChunks;
    if (readChunks !== undefined && initial.value.sizeBytes > SMALL_FILE_READ_THRESHOLD_BYTES) {
      const streamed = await readChunks.call(this.#filesystem, path, cancellation);
      if (!streamed.ok) return this.#platform(streamed.error);
      const hash = createFingerprintAccumulator();
      const source = streamed.value;
      const observed = (async function* (): AsyncIterable<Uint8Array> {
        for await (const chunk of source) {
          hash.update(chunk);
          yield chunk;
        }
      })();
      const opened = await this.#requireDocuments().openTextChunks(documentId, observed, options.seed ?? 41027, textOptions);
      if (cancellation.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
      const final = await this.#stat(path, cancellation);
      if (!final.ok) return final;
      if (final.value === undefined) return { ok: false, error: { kind: 'not-found', path } };
      const identity = makeIdentityFromHash(path, final.value, hash.value());
      if (initial.value.sizeBytes !== final.value.sizeBytes || initial.value.modifiedMilliseconds !== final.value.modifiedMilliseconds
        || initial.value.inode !== final.value.inode || initial.value.device !== final.value.device) {
        return { ok: false, error: { kind: 'external-change', path, expected: null, actual: identity } };
      }
      if (opened.kind === 'editable') {
        this.#opened.set(documentId, identity);
        return { ok: true, value: { kind: 'editable', path, identity, document: opened.document } };
      }
      return { ok: true, value: { kind: 'read-only', path, identity, document: opened.document } };
    }
    const read = await this.#filesystem.readFile(path, cancellation);
    if (!read.ok) return this.#platform(read.error);
    if (cancellation.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
    const final = await this.#stat(path, cancellation);
    if (!final.ok) return final;
    if (final.value === undefined) return { ok: false, error: { kind: 'not-found', path } };
    const identity = makeIdentity(path, final.value, read.value);
    if (initial.value.sizeBytes !== final.value.sizeBytes || initial.value.modifiedMilliseconds !== final.value.modifiedMilliseconds
      || initial.value.inode !== final.value.inode || initial.value.device !== final.value.device) {
      return { ok: false, error: { kind: 'external-change', path, expected: null, actual: identity } };
    }
    const opened = this.#requireDocuments().openText(documentId, read.value, options.seed ?? 41027, textOptions);
    if (opened.kind === 'editable') {
      this.#opened.set(documentId, identity);
      return { ok: true, value: { kind: 'editable', path, identity, document: opened.document } };
    }
    return { ok: true, value: { kind: 'read-only', path, identity, document: opened.document } };
  }

  /** Alias used by composition roots that model persistence as an open operation. */
  open = this.openFile.bind(this);

  async saveFile(
    document: TextFileDocument,
    path: string,
    cancellation: CancellationToken,
    options: SaveFileOptions = {},
  ): Promise<Result<SaveFileResult, PersistenceFailure>> {
    if (this.#disposed) return { ok: false, error: { kind: 'disposed' } };
    const snapshot = document.snapshot();
    if (options.expectedVersion !== undefined && options.expectedVersion !== snapshot.version) {
      return { ok: false, error: { kind: 'stale-document-version', expected: options.expectedVersion, actual: snapshot.version } };
    }
    const expected = options.expectedDisk === undefined ? this.#opened.get(document.id) ?? null : options.expectedDisk;
    const current = await this.#readIdentity(path, cancellation, expected);
    if (!current.ok) return current;
    if (!sameIdentity(expected, current.value)) {
      return { ok: false, error: { kind: 'external-change', path, expected, actual: current.value } };
    }
    if (current.value?.kind === 'symlink') {
      return { ok: false, error: { kind: 'symlink-save', path, message: 'saving would replace a symbolic link; resolve the target explicitly' } };
    }
    if ((current.value?.linkCount ?? 1) > 1) {
      return { ok: false, error: { kind: 'hardlink-save', path, message: 'saving would replace a multiply-linked inode; choose an explicit copy path' } };
    }
    let written: Result<void, PlatformFailure>;
    let persistedHash: string;
    if (options.atomic === false) {
      const directWrite = this.#filesystem.writeFile;
      if (directWrite === undefined) return { ok: false, error: { kind: 'platform', failure: { code: 'direct-write-unavailable', message: 'the filesystem does not support non-atomic saves', retryable: false } } };
      const serialized = document.serializeSnapshot(snapshot);
      if (!serialized.ok) return { ok: false, error: { kind: 'serialize', message: serialized.error.kind } };
      written = await directWrite.call(this.#filesystem, path, serialized.value, cancellation);
      persistedHash = fingerprint(serialized.value);
    } else if (this.#filesystem.writeFileAtomicChunks !== undefined) {
      const writeChunks = this.#filesystem.writeFileAtomicChunks;
      try {
        const hash = createFingerprintAccumulator();
        const encoded = (async function* (): AsyncIterable<Uint8Array> {
          for await (const chunk of encodeTextFileChunks(snapshot)) {
            hash.update(chunk);
            yield chunk;
          }
        })();
        written = await writeChunks.call(this.#filesystem, path, encoded, cancellation);
        persistedHash = hash.value();
      } catch (error: unknown) {
        return { ok: false, error: { kind: 'serialize', message: error instanceof Error ? error.message : 'streaming serialization failed' } };
      }
    } else {
      const serialized = document.serializeSnapshot(snapshot);
      if (!serialized.ok) return { ok: false, error: { kind: 'serialize', message: serialized.error.kind } };
      written = await this.#filesystem.writeFileAtomic(path, serialized.value, cancellation);
      persistedHash = fingerprint(serialized.value);
    }
    if (!written.ok) return this.#platform(written.error);
    if (cancellation.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
    const after = await this.#stat(path, cancellation);
    if (!after.ok) return after;
    if (after.value === undefined) return { ok: false, error: { kind: 'not-found', path } };
    const persistedIdentity = makeIdentityFromHash(path, after.value, persistedHash);
    const marked = document.markSaved({ id: document.id, revisionId: snapshot.revisionId });
    if (!marked.ok) return { ok: false, error: { kind: 'serialize', message: `save revision was not retained: ${marked.error.kind}` } };
    this.#opened.set(document.id, persistedIdentity);
    const recoveryCleanup = await this.clearRecovery(path, cancellation);
    return {
      ok: true,
      value: {
        path,
        identity: persistedIdentity,
        persistedRevision: snapshot.revisionId,
        persistedVersion: snapshot.version,
        documentVersion: document.version,
        isDirty: document.isDirty,
        recoveryJournalCleared: recoveryCleanup.ok,
      },
    };
  }

  save = this.saveFile.bind(this);

  async checkpoint(
    document: TextFileDocument,
    path: string,
    cancellation: CancellationToken,
    options: RecoveryOptions = {},
  ): Promise<Result<RecoveryCheckpoint, PersistenceFailure>> {
    if (this.#disposed) return { ok: false, error: { kind: 'disposed' } };
    const journalPath = options.journalPath ?? this.#journalPathForPath(path);
    const cancelFlag = { cancelled: false };
    const run = this.#runCheckpoint(document, path, cancellation, options, journalPath, cancelFlag);
    this.#pendingCheckpoints.set(journalPath, { promise: run, cancel: () => { cancelFlag.cancelled = true; } });
    try {
      return await run;
    } finally {
      if (this.#pendingCheckpoints.get(journalPath)?.promise === run) this.#pendingCheckpoints.delete(journalPath);
    }
  }

  async #runCheckpoint(
    document: TextFileDocument,
    path: string,
    cancellation: CancellationToken,
    options: RecoveryOptions,
    journalPath: string,
    cancelFlag: { cancelled: boolean },
  ): Promise<Result<RecoveryCheckpoint, PersistenceFailure>> {
    const snapshot = document.snapshot();
    const maxBytes = boundedPositive(options.maxBytes, DEFAULT_MAX_RECOVERY_BYTES);
    // Cheap pre-check: the document's UTF-16 length is a lower bound on the
    // JSON-encoded UTF-8 byte size of the new entry alone. If that already
    // exceeds the journal's byte budget, the checkpoint is definitely too
    // large; bail before slicing, JSON-encoding or writing anything.
    if (snapshot.lengthUtf16 > maxBytes) {
      return { ok: false, error: { kind: 'journal-too-large', path: journalPath, bytes: snapshot.lengthUtf16 } };
    }
    const text = await materializeSnapshotYielding(snapshot);
    if (!text.ok) return { ok: false, error: text.error };
    if (cancelFlag.cancelled) return { ok: false, error: { kind: 'cancelled' } };
    const base = this.#opened.get(document.id);
    const checkpoint: RecoveryCheckpoint = Object.freeze({
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      path,
      documentId: document.id,
      documentVersion: snapshot.version as number,
      revisionId: snapshot.revisionId as number,
      baseDisk: base ?? null,
      normalizedText: text.value,
      lineEndings: Object.freeze([...snapshot.lineEndings]),
      defaultLineEnding: snapshot.defaultLineEnding,
      hasUtf8Bom: snapshot.hasUtf8Bom,
    });
    // Reuse the decoded journal kept from the previous checkpoint/recover on
    // this path when the file's stat has not changed since, instead of
    // re-reading and JSON.parsing up to DEFAULT_MAX_RECOVERY_BYTES on every
    // keystroke-triggered checkpoint.
    const existing = await this.#readJournalCache(journalPath, cancellation);
    if (!existing.ok) return existing;
    // A checkpoint for a document already tracked in this journal replaces that document's
    // prior entry in place, instead of appending a new one and letting superseded versions of
    // the SAME document accumulate. `recover()` only ever reads the latest entry per
    // (path, documentId) (see the `.reverse().find(...)` below), so keeping old versions of
    // the same open document serves no recovery purpose and only inflates every subsequent
    // write. This keeps the journal (and so each write's cost) at O(distinct open documents
    // for this path) -- ordinarily one -- rather than O(DEFAULT_MAX_RECOVERY_ENTRIES).
    const entries = [...existing.value.entries];
    const encodedEntries = [...existing.value.encoded];
    const replaceAt = entries.findIndex((entry) => entry.documentId === checkpoint.documentId);
    if (replaceAt === -1) {
      entries.push(checkpoint);
      encodedEntries.push(journalEntryEncoding(checkpoint));
    } else {
      entries[replaceAt] = checkpoint;
      encodedEntries[replaceAt] = journalEntryEncoding(checkpoint);
    }
    const maxEntries = Math.min(DEFAULT_MAX_RECOVERY_ENTRIES, boundedPositive(options.maxEntries, DEFAULT_MAX_RECOVERY_ENTRIES));
    while (entries.length > maxEntries) { entries.shift(); encodedEntries.shift(); }
    // Only the new entry is ever JSON.stringify'd here; older, unchanged
    // entries reuse their cached encoding instead of being re-serialized.
    let totalBytes = journalTotalBytes(encodedEntries);
    while (totalBytes > maxBytes && entries.length > 1) {
      entries.shift();
      encodedEntries.shift();
      totalBytes = journalTotalBytes(encodedEntries);
    }
    if (totalBytes > maxBytes) return { ok: false, error: { kind: 'journal-too-large', path: journalPath, bytes: totalBytes } };
    if (cancellation.isCancelled || cancelFlag.cancelled) return { ok: false, error: { kind: 'cancelled' } };
    const writeChunks = this.#filesystem.writeFileAtomicChunks;
    const written = writeChunks !== undefined
      ? await writeChunks.call(this.#filesystem, journalPath, journalEntryChunks(encodedEntries), cancellation)
      : await this.#filesystem.writeFileAtomic(journalPath, new TextEncoder().encode(joinJournalEntries(encodedEntries)), cancellation);
    if (!written.ok) return this.#platform(written.error);
    const info = await this.#stat(journalPath, cancellation);
    this.#journalCache.set(journalPath, {
      info: info.ok && info.value !== undefined ? { sizeBytes: info.value.sizeBytes, modifiedMilliseconds: info.value.modifiedMilliseconds } : null,
      entries,
      encoded: encodedEntries,
    });
    return { ok: true, value: checkpoint };
  }

  checkpointRecovery = this.checkpoint.bind(this);

  async recover(
    path: string,
    documentId: DocumentId,
    cancellation: CancellationToken,
    options: RecoveryOptions = {},
  ): Promise<Result<RecoveryResult, PersistenceFailure>> {
    if (this.#disposed) return { ok: false, error: { kind: 'disposed' } };
    const journalPaths = options.journalPath === undefined
      ? [...new Set([this.#journalPathForPath(path), recoveryJournalPath(path)])]
      : [options.journalPath];
    let checkpoint: RecoveryCheckpoint | undefined;
    for (const journalPath of journalPaths) {
      const journal = await this.#readJournal(journalPath, cancellation);
      if (!journal.ok) return journal;
      checkpoint = [...journal.value].reverse().find((entry) => entry.path === path && entry.documentId === documentId);
      if (checkpoint !== undefined) break;
    }
    if (checkpoint === undefined) return { ok: true, value: { kind: 'none', path } };
    const restored = restoreCheckpointDocument(this.#requireDocuments(), checkpoint, documentId, options.seed ?? 41027);
    if (!restored.ok) return restored;
    const disk = await this.#readIdentity(path, cancellation, checkpoint.baseDisk);
    if (!disk.ok) return disk;
    if (sameIdentity(checkpoint.baseDisk, disk.value)) {
      return {
        ok: true,
        value: { kind: 'recovered', path, checkpoint, document: restored.value, baseDisk: checkpoint.baseDisk, disk: disk.value },
      };
    }
    return {
      ok: true,
      value: { kind: 'disk-diverged', path, checkpoint, document: restored.value, expected: checkpoint.baseDisk, actual: disk.value },
    };
  }

  recoverFile = this.recover.bind(this);

  /** Remove a checkpoint journal only after its owning save/session operation succeeds. */
  async clearRecovery(path: string, cancellation: CancellationToken, journalPath?: string): Promise<Result<void, PersistenceFailure>> {
    const paths = journalPath === undefined ? [...new Set([this.#journalPathForPath(path), recoveryJournalPath(path)])] : [journalPath];
    for (const target of paths) {
      const cleared = await this.#clearJournal(target, cancellation);
      if (!cleared.ok) return cleared;
    }
    return { ok: true, value: undefined };
  }

  async #clearJournal(journalPath: string, cancellation: CancellationToken): Promise<Result<void, PersistenceFailure>> {
    if (this.#disposed) return { ok: false, error: { kind: 'disposed' } };
    const present = await this.#stat(journalPath, cancellation);
    if (!present.ok) return present;
    if (present.value === undefined) {
      this.#journalCache.delete(journalPath);
      return { ok: true, value: undefined };
    }
    // A recovery journal that no longer applies should not exist at all, not exist-but-empty:
    // removing it (when the port supports deletion) leaves no sibling file to find, read or
    // race a fresh checkpoint against. Falls back to writing `[]` only for a filesystem port
    // that cannot remove files.
    if (this.#filesystem.removePath !== undefined) {
      const removed = await this.#filesystem.removePath(journalPath, false, cancellation);
      if (!removed.ok) return this.#platform(removed.error);
      this.#journalCache.delete(journalPath);
      return { ok: true, value: undefined };
    }
    const written = await this.#filesystem.writeFileAtomic(journalPath, encodeJson([]), cancellation);
    if (!written.ok) return this.#platform(written.error);
    const info = await this.#stat(journalPath, cancellation);
    this.#journalCache.set(journalPath, {
      info: info.ok && info.value !== undefined ? { sizeBytes: info.value.sizeBytes, modifiedMilliseconds: info.value.modifiedMilliseconds } : null,
      entries: [],
      encoded: [],
    });
    return written;
  }

  async saveSession(path: string, session: SessionSnapshot, cancellation: CancellationToken): Promise<Result<void, PersistenceFailure>> {
    if (this.#disposed) return { ok: false, error: { kind: 'disposed' } };
    const encoded = encodeSession(session);
    if (!encoded.ok) return encoded;
    const result = await this.#filesystem.writeFileAtomic(path, encoded.value, cancellation);
    return result.ok ? result : this.#platform(result.error);
  }

  async loadSession(path: string, cancellation: CancellationToken): Promise<Result<SessionSnapshot, PersistenceFailure>> {
    if (this.#disposed) return { ok: false, error: { kind: 'disposed' } };
    const read = await this.#filesystem.readFile(path, cancellation);
    if (!read.ok) {
      if (isNotFound(read.error)) return { ok: false, error: { kind: 'not-found', path } };
      return this.#platform(read.error);
    }
    return decodeSession(read.value, path);
  }

  async #stat(path: string, cancellation: CancellationToken): Promise<Result<FileInfo | undefined, PersistenceFailure>> {
    const result = await this.#filesystem.stat(path, cancellation);
    if (result.ok) return result;
    if (isNotFound(result.error)) return { ok: true, value: undefined };
    return this.#platform(result.error);
  }

  /**
   * Reads the current on-disk identity. `hint` is the identity last observed
   * for this path (from open/save); when a `stat` shows the same size, mtime,
   * device and inode, content cannot have changed, so the file is not
   * re-read and re-hashed — the hint's hash is reused as-is.
   */
  async #readIdentity(path: string, cancellation: CancellationToken, hint?: FileIdentity | null): Promise<Result<FileIdentity | null, PersistenceFailure>> {
    const info = await this.#stat(path, cancellation);
    if (!info.ok) return info;
    if (info.value === undefined) return { ok: true, value: null };
    if (info.value.kind !== 'file' && info.value.kind !== 'symlink') {
      return { ok: false, error: { kind: 'invalid-open', reason: `path is ${info.value.kind}` } };
    }
    if (hint != null && identityMatchesStat(hint, path, info.value)) return { ok: true, value: hint };
    const read = await this.#filesystem.readFile(path, cancellation);
    if (!read.ok) return this.#platform(read.error);
    return { ok: true, value: makeIdentity(path, info.value, read.value) };
  }

  async #readJournal(path: string, cancellation: CancellationToken): Promise<Result<RecoveryCheckpoint[], PersistenceFailure>> {
    const cached = await this.#readJournalCache(path, cancellation);
    if (!cached.ok) return cached;
    return { ok: true, value: [...cached.value.entries] };
  }

  /**
   * Stats the journal file and reuses the in-memory decoded journal for this
   * path when size/mtime match what produced it, avoiding a re-read and
   * re-parse of up to DEFAULT_MAX_RECOVERY_BYTES of JSON per call. A changed
   * stat (external edit, or a previous write we made) forces a fresh read.
   */
  async #readJournalCache(path: string, cancellation: CancellationToken): Promise<Result<JournalCacheEntry, PersistenceFailure>> {
    const info = await this.#stat(path, cancellation);
    if (!info.ok) return info;
    if (info.value === undefined) {
      const empty: JournalCacheEntry = { info: null, entries: [], encoded: [] };
      this.#journalCache.set(path, empty);
      return { ok: true, value: empty };
    }
    const cached = this.#journalCache.get(path);
    if (cached !== undefined && cached.info !== null && cached.info.sizeBytes === info.value.sizeBytes && cached.info.modifiedMilliseconds === info.value.modifiedMilliseconds) {
      return { ok: true, value: cached };
    }
    const read = await this.#filesystem.readFile(path, cancellation);
    if (!read.ok) {
      if (isNotFound(read.error)) {
        const empty: JournalCacheEntry = { info: null, entries: [], encoded: [] };
        this.#journalCache.set(path, empty);
        return { ok: true, value: empty };
      }
      return this.#platform(read.error);
    }
    const decoded = decodeJournal(read.value, path);
    if (!decoded.ok) {
      // An unparseable journal must not permanently block every future checkpoint for this
      // path (returning the error here left #runCheckpoint aborting before it ever wrote a
      // fresh journal, so the same corrupt bytes kept failing every checkpoint forever).
      // Treat it as empty so the next successful checkpoint overwrites the corrupt file, and
      // report it once here rather than silently discarding the recovery data it held.
      this.#onError(`xi: recovery journal ${path} is corrupt and will be reset: ${decoded.error.kind === 'journal-corrupt' ? decoded.error.message : decoded.error.kind}`);
      const empty: JournalCacheEntry = {
        info: { sizeBytes: info.value.sizeBytes, modifiedMilliseconds: info.value.modifiedMilliseconds },
        entries: [],
        encoded: [],
      };
      this.#journalCache.set(path, empty);
      return { ok: true, value: empty };
    }
    const entry: JournalCacheEntry = {
      info: { sizeBytes: info.value.sizeBytes, modifiedMilliseconds: info.value.modifiedMilliseconds },
      entries: decoded.value,
      encoded: decoded.value.map(journalEntryEncoding),
    };
    this.#journalCache.set(path, entry);
    return { ok: true, value: entry };
  }

  #platform(failure: PlatformFailure): { readonly ok: false; readonly error: PersistenceFailure } {
    return failure.code === 'cancelled'
      ? { ok: false, error: { kind: 'cancelled' } }
      : { ok: false, error: { kind: 'platform', failure } };
  }
}

export function createPersistenceService(filesystem: FilesystemPort, documents?: PersistenceDocumentFactory): PersistenceService {
  return new PersistenceService(filesystem, undefined, documents);
}

export function openFile(
  filesystem: FilesystemPort,
  path: string,
  documentId: DocumentId,
  cancellation: CancellationToken,
  options: OpenFileOptions = {},
  documents?: PersistenceDocumentFactory,
): Promise<Result<OpenedFile, PersistenceFailure>> {
  return new PersistenceService(filesystem, undefined, documents).openFile(path, documentId, cancellation, options);
}

export function saveFile(
  filesystem: FilesystemPort,
  document: TextFileDocument,
  path: string,
  cancellation: CancellationToken,
  options: SaveFileOptions = {},
): Promise<Result<SaveFileResult, PersistenceFailure>> {
  return new PersistenceService(filesystem).saveFile(document, path, cancellation, options);
}

export function recoverFile(
  filesystem: FilesystemPort,
  path: string,
  documentId: DocumentId,
  cancellation: CancellationToken,
  options: RecoveryOptions = {},
  documents?: PersistenceDocumentFactory,
): Promise<Result<RecoveryResult, PersistenceFailure>> {
  return new PersistenceService(filesystem, undefined, documents).recover(path, documentId, cancellation, options);
}

export function recoveryJournalPath(path: string): string {
  return `${path}.xi-recovery.json`;
}

export function encodeSession(session: SessionSnapshot): Result<Uint8Array, PersistenceFailure> {
  const checked = validateSession(session);
  if (!checked.ok) return { ok: false, error: { kind: 'session-corrupt', path: '<session>', message: checked.error.message } };
  return { ok: true, value: encodeJson(session) };
}

export function decodeSession(bytes: Uint8Array, path = '<session>'): Result<SessionSnapshot, PersistenceFailure> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { return { ok: false, error: { kind: 'session-corrupt', path, message: 'session is not valid UTF-8 JSON' } }; }
  const checked = validateSession(value);
  return checked.ok ? checked : { ok: false, error: { kind: 'session-corrupt', path, message: checked.error.message } };
}

function validateSession(value: unknown): Result<SessionSnapshot, { readonly message: string }> {
  if (!isRecord(value) || value.schemaVersion !== SESSION_SCHEMA_VERSION || typeof value.workspaceId !== 'string'
    || !Array.isArray(value.roots) || !value.roots.every((root): root is string => typeof root === 'string')
    || !Array.isArray(value.documents)
    || !hasOnlyKeys(value, ['schemaVersion', 'workspaceId', 'roots', 'documents', 'activeDocumentId'])
    || (value.activeDocumentId !== undefined && typeof value.activeDocumentId !== 'string')) {
    return { ok: false, error: { message: 'unsupported session schema' } };
  }
  const documents: SessionDocumentState[] = [];
  for (const candidate of value.documents) {
    if (!isRecord(candidate) || typeof candidate.documentId !== 'string' || typeof candidate.path !== 'string'
      || !hasOnlyKeys(candidate, ['documentId', 'path', 'viewIds'])
      || (candidate.viewIds !== undefined && (!Array.isArray(candidate.viewIds) || !candidate.viewIds.every((id): id is string => typeof id === 'string')))) {
      return { ok: false, error: { message: 'invalid session document' } };
    }
    documents.push(Object.freeze({
      documentId: candidate.documentId,
      path: candidate.path,
      ...(candidate.viewIds === undefined ? {} : { viewIds: Object.freeze([...candidate.viewIds]) }),
    }));
  }
  return {
    ok: true,
    value: Object.freeze({
      schemaVersion: SESSION_SCHEMA_VERSION,
      workspaceId: value.workspaceId,
      roots: Object.freeze([...value.roots]),
      documents: Object.freeze(documents),
      ...(typeof value.activeDocumentId === 'string' ? { activeDocumentId: value.activeDocumentId } : {}),
    }),
  };
}

function decodeJournal(bytes: Uint8Array, path: string): Result<RecoveryCheckpoint[], PersistenceFailure> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { return { ok: false, error: { kind: 'journal-corrupt', path, message: 'journal is not valid UTF-8 JSON' } }; }
  if (!Array.isArray(value) || value.length > DEFAULT_MAX_RECOVERY_ENTRIES) {
    return { ok: false, error: { kind: 'journal-corrupt', path, message: 'journal must be a bounded checkpoint array' } };
  }
  const output: RecoveryCheckpoint[] = [];
  for (const candidate of value) {
    const checked = validateCheckpoint(candidate);
    if (!checked.ok) return { ok: false, error: { kind: 'journal-corrupt', path, message: checked.error } };
    output.push(checked.value);
  }
  return { ok: true, value: output };
}

function validateCheckpoint(value: unknown): Result<RecoveryCheckpoint, string> {
  if (!isRecord(value) || value.schemaVersion !== RECOVERY_SCHEMA_VERSION || typeof value.path !== 'string'
    || typeof value.documentId !== 'string' || !Number.isSafeInteger(value.documentVersion) || (value.documentVersion as number) < 1
    || !Number.isSafeInteger(value.revisionId) || (value.revisionId as number) < 1 || typeof value.normalizedText !== 'string'
    || !Array.isArray(value.lineEndings) || !value.lineEndings.every((ending): ending is 'lf' | 'crlf' | 'cr' | 'ff' | 'nel' => ending === 'lf' || ending === 'crlf' || ending === 'cr' || ending === 'ff' || ending === 'nel')
    || (value.defaultLineEnding !== 'lf' && value.defaultLineEnding !== 'crlf' && value.defaultLineEnding !== 'cr' && value.defaultLineEnding !== 'ff' && value.defaultLineEnding !== 'nel')
    || typeof value.hasUtf8Bom !== 'boolean' || !hasOnlyKeys(value, ['schemaVersion', 'path', 'documentId', 'documentVersion', 'revisionId', 'baseDisk', 'normalizedText', 'lineEndings', 'defaultLineEnding', 'hasUtf8Bom'])
    || (value.baseDisk !== null && !validateIdentity(value.baseDisk))) {
    return { ok: false, error: 'checkpoint schema is invalid' };
  }
  return { ok: true, value: Object.freeze({
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    path: value.path,
    documentId: value.documentId,
    documentVersion: value.documentVersion as number,
    revisionId: value.revisionId as number,
    baseDisk: value.baseDisk === null ? null : value.baseDisk as FileIdentity,
    normalizedText: value.normalizedText,
    lineEndings: Object.freeze([...value.lineEndings]),
    defaultLineEnding: value.defaultLineEnding,
    hasUtf8Bom: value.hasUtf8Bom,
  }) };
}

function restoreCheckpointDocument(
  documents: PersistenceDocumentFactory,
  checkpoint: RecoveryCheckpoint,
  documentId: DocumentId,
  seed: number,
): Result<TextFileDocument, PersistenceFailure> {
  const checkedId = asIdentifier<DocumentId>(checkpoint.documentId, 'documentId');
  if (!checkedId.ok || checkedId.value !== documentId) return { ok: false, error: { kind: 'journal-corrupt', path: checkpoint.path, message: 'checkpoint document identity does not match request' } };
  if (!isNonnegativeSafeInteger(checkpoint.documentVersion) || checkpoint.documentVersion < 1
    || !isNonnegativeSafeInteger(checkpoint.revisionId) || checkpoint.revisionId < 1) {
    return { ok: false, error: { kind: 'journal-corrupt', path: checkpoint.path, message: 'checkpoint version identity is invalid' } };
  }
  const created = documents.restoreCheckpoint(
    documentId,
    checkpoint.normalizedText,
    checkpoint.lineEndings,
    checkpoint.defaultLineEnding,
    checkpoint.hasUtf8Bom,
    seed,
    checkpoint.normalizedText.includes('\r') ? 'literal-control' : undefined,
  );
  if (!created.ok) return { ok: false, error: { kind: 'journal-corrupt', path: checkpoint.path, message: `checkpoint text is invalid: ${created.error.kind}` } };
  // Recovery records carry their original identities for diagnostics. The
  // document starts with its own fresh version; persisted version is metadata.
  return created;
}

function validateIdentity(value: unknown): value is FileIdentity {
  if (!isRecord(value) || typeof value.path !== 'string' || (value.kind !== 'file' && value.kind !== 'symlink')
    || !hasOnlyKeys(value, ['path', 'kind', 'sizeBytes', 'modifiedMilliseconds', 'contentHash', 'device', 'inode', 'linkCount'])
    || !Number.isFinite(value.sizeBytes) || (value.sizeBytes as number) < 0
    || !Number.isFinite(value.modifiedMilliseconds) || typeof value.contentHash !== 'string') return false;
  return (value.device === undefined || typeof value.device === 'string')
    && (value.inode === undefined || typeof value.inode === 'string')
    && (value.linkCount === undefined || (typeof value.linkCount === 'number' && Number.isSafeInteger(value.linkCount) && value.linkCount >= 1));
}

function makeIdentity(path: string, info: FileInfo, bytes: Uint8Array): FileIdentity {
  return makeIdentityFromHash(path, info, fingerprint(bytes));
}

function makeIdentityFromHash(path: string, info: FileInfo, contentHash: string): FileIdentity {
  return Object.freeze({
    path,
    kind: info.kind,
    sizeBytes: info.sizeBytes,
    modifiedMilliseconds: info.modifiedMilliseconds,
    contentHash,
    ...(info.device === undefined ? {} : { device: info.device }),
    ...(info.inode === undefined ? {} : { inode: info.inode }),
    ...(info.linkCount === undefined ? {} : { linkCount: info.linkCount }),
  });
}

// Content identity only needs a stable, collision-resistant digest for equality
// checks; it is never validated against a fixed format (validateIdentity only
// requires a string), so the algorithm can change freely. Bun's native
// CryptoHasher is hardware-accelerated and supports incremental updates for
// the streaming read/write paths, unlike the previous per-byte BigInt FNV loop.
function createFingerprintAccumulator(): { update(bytes: Uint8Array): void; value(): string } {
  const hasher = new Bun.CryptoHasher('sha256');
  return {
    update(bytes: Uint8Array): void { hasher.update(bytes); },
    value(): string { return `sha256-${hasher.digest('hex')}`; },
  };
}

function identityMatchesStat(hint: FileIdentity, path: string, info: FileInfo): boolean {
  // An mtime within ~2 ms of "now" is inside the filesystem's mtime granularity: a second,
  // external write landing in that same window can produce an identical (sizeBytes, mtime)
  // pair to the hint even though the content changed. Refuse the stat-only shortcut and force
  // a re-hash whenever the observed mtime is this fresh, rather than trusting a coincidental
  // match.
  if (Date.now() - info.modifiedMilliseconds < 2) return false;
  return hint.path === path && hint.kind === info.kind && hint.sizeBytes === info.sizeBytes
    && hint.modifiedMilliseconds === info.modifiedMilliseconds && hint.device === info.device && hint.inode === info.inode
    && hint.linkCount === info.linkCount;
}

function sameIdentity(expected: FileIdentity | null, actual: FileIdentity | null): boolean {
  if (expected === null || actual === null) return expected === actual;
  return expected.path === actual.path && expected.kind === actual.kind && expected.sizeBytes === actual.sizeBytes
    && expected.contentHash === actual.contentHash && expected.device === actual.device && expected.inode === actual.inode;
}

function fingerprint(bytes: Uint8Array): string {
  return `sha256-${Bun.CryptoHasher.hash('sha256', bytes, 'hex')}`;
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function journalEntryEncoding(entry: RecoveryCheckpoint): JournalEntryEncoding {
  const json = JSON.stringify(entry);
  const encoded = new TextEncoder().encode(json);
  return { json, encoded, bytes: encoded.byteLength };
}

/** Streams `[` + each entry's already-UTF-8-encoded JSON, joined by `,` + `]`, without
 * building one giant joined string (`joinJournalEntries`) and re-encoding it (a second full
 * O(journal) pass) on every checkpoint. */
async function* journalEntryChunks(encoded: readonly JournalEntryEncoding[]): AsyncIterable<Uint8Array> {
  yield OPEN_BRACKET;
  let first = true;
  for (const entry of encoded) {
    if (!first) yield COMMA;
    first = false;
    yield entry.encoded;
  }
  yield CLOSE_BRACKET;
}
const OPEN_BRACKET = new TextEncoder().encode('[');
const CLOSE_BRACKET = new TextEncoder().encode(']');
const COMMA = new TextEncoder().encode(',');

/** Byte length of `JSON.stringify(entries.map(e => JSON.parse(e.json)))`, computed from cached per-entry sizes. */
function journalTotalBytes(encoded: readonly JournalEntryEncoding[]): number {
  if (encoded.length === 0) return 2; // "[]"
  let total = 2 + (encoded.length - 1); // brackets + commas
  for (const entry of encoded) total += entry.bytes;
  return total;
}

function joinJournalEntries(encoded: readonly JournalEntryEncoding[]): string {
  return `[${encoded.map((entry) => entry.json).join(',')}]`;
}

function asOffset(value: number): Parameters<TextFileSnapshot['slice']>[0] {
  return value as Parameters<TextFileSnapshot['slice']>[0];
}

/**
 * Same text as `snapshot.slice(0, length)`, but joined across bounded chunks and yielding to a
 * macrotask (setTimeout(0)) whenever a run of chunks has consumed more than maxSliceMilliseconds,
 * instead of materializing a whole (up to 10+ MiB) document in one synchronous main-thread step.
 * Backs off one UTF-16 unit at a time on a surrogate split, like the read-side chunking this
 * mirrors.
 */
async function materializeSnapshotYielding(
  snapshot: TextFileSnapshot,
  chunkUtf16 = 64 * 1024,
  maxSliceMilliseconds = 4,
): Promise<Result<string, { readonly kind: 'serialize'; readonly message: string }>> {
  const chunks: string[] = [];
  let start = 0;
  let sliceStartedAt = performance.now();
  while (start < snapshot.lengthUtf16) {
    let end = Math.min(snapshot.lengthUtf16, start + chunkUtf16);
    let read = false;
    while (end > start) {
      const sliced = snapshot.slice(asOffset(start), asOffset(end));
      if (sliced.ok) {
        chunks.push(sliced.value);
        start = end;
        read = true;
        break;
      }
      if (sliced.error.kind !== 'surrogate-split') return { ok: false, error: { kind: 'serialize', message: sliced.error.kind } };
      end -= 1;
    }
    if (!read) return { ok: false, error: { kind: 'serialize', message: 'no safe UTF-16 chunk boundary found' } };
    if (performance.now() - sliceStartedAt >= maxSliceMilliseconds) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      sliceStartedAt = performance.now();
    }
  }
  return { ok: true, value: chunks.join('') };
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function boundedPositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isFileKind(value: unknown): value is FileInfo['kind'] {
  return value === 'file' || value === 'directory' || value === 'symlink' || value === 'other';
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNotFound(failure: PlatformFailure): boolean {
  return failure.code === 'ENOENT' || failure.code === 'not-found';
}

export function encodeRecoveryCheckpoint(checkpoint: RecoveryCheckpoint): Uint8Array {
  return encodeJson(checkpoint);
}

// Kept as a small, deterministic helper for callers that need a journal
// payload without constructing the service. It intentionally does not expose
// a byte-oriented text store separate from the document snapshot.
export function encodeBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += BASE64_ALPHABET[first >> 2] ?? '';
    output += BASE64_ALPHABET[((first & 3) << 4) | ((second ?? 0) >> 4)] ?? '';
    output += second === undefined ? '=' : BASE64_ALPHABET[((second & 15) << 2) | ((third ?? 0) >> 6)] ?? '';
    output += third === undefined ? '=' : BASE64_ALPHABET[third & 63] ?? '';
  }
  return output;
}
