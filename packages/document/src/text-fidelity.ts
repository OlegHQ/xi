// `String.prototype.isWellFormed` (ES2024) exists on the pinned Bun/JavaScriptCore runtime
// this project targets, but the repo's `lib` compiler option is ES2022. Declare it locally
// rather than widening `lib` repo-wide.
declare global {
  interface String {
    isWellFormed(): boolean;
  }
}

import {
  asDocumentVersion,
  asRevisionId,
  asUndoGroupId,
  type DocumentId,
  type DocumentVersion,
  type LineIndex,
  type RevisionId,
  type Result,
  type SerializedSelectionValue,
  type Utf16Offset,
  type Utf32Offset,
  type Utf8ByteOffset,
} from '../../primitives/src/index';
import type { DocumentReadFailure, DocumentSnapshot, UndoGroupId } from './contracts.ts';
import { RopeDocument, type DocumentEdit, type DocumentMutationFailure, type DocumentTextIntent } from './rope';
import {
  LineEndingSequence,
  LineEndingSequenceBuilder,
  type LineEnding,
  type LineEndingStorageMetrics,
} from './line-endings';
export type { LineEnding, LineEndingStorageMetrics } from './line-endings';
import {
  DocumentChangeMap,
  validateEditProposal,
  type CommitOutcome,
  type CommittedDocumentChange,
  type DocumentTransactionFailure,
  type EditOrigin,
  type EditProposal,
  type SaveRevisionFailure,
  type SaveRevisionIdentity,
} from './transactions';
import {
  decodeUndoHistory,
  fingerprintUndoContent,
  materializeUndoEdits,
  UNDO_HISTORY_POLICY,
  UndoTree,
  type InverseLineEndingPatch,
  type UndoGroupFailure,
  type UndoHistoryFailure,
  type UndoOperationFailure,
  type UndoOutcome,
  type UndoRetention,
  type UndoStep,
  type UndoTextRun,
  estimateUndoStepMetadata,
} from './undo';

export type ReadOnlyByteReason = 'invalid-utf8' | 'binary-content' | 'ambiguous-line-endings' | 'invalid-file-format';

/** Explicit open policy for byte sequences where a lone CR can be data or an old-Mac line ending. */
export type TextFileFormat = 'auto' | 'unix' | 'dos' | 'mac' | 'legacy';

export interface OpenTextDocumentOptions {
  readonly fileFormat?: TextFileFormat;
}

export interface TextFileSnapshot extends DocumentSnapshot {
  readonly encoding: 'utf-8';
  readonly hasUtf8Bom: boolean;
  /** One preserved ending per normalized LF in the snapshot text. */
  readonly lineEndings: readonly LineEnding[];
  readonly defaultLineEnding: LineEnding;
  readonly hasFinalNewline: boolean;
  /** Optional packed metadata lookup used by streaming save; it does not materialize all endings. */
  readonly lineEndingAt?: (index: number) => LineEnding | undefined;
  /** Optional sequential metadata reader used by streaming save. */
  readonly lineEndingReader?: () => { next(): LineEnding | undefined };
}

const lineEndingArrayCache = new WeakMap<TextFileSnapshot, readonly LineEnding[]>();

export type TextFidelityFailure = DocumentReadFailure | DocumentTransactionFailure;
export type TextEncodingFailure = { readonly kind: 'line-ending-index-mismatch' } | DocumentReadFailure;
export type TextDocumentCreateFailure = { readonly kind: 'invalid-line-ending' | 'invalid-text' | 'invalid-seed' | 'line-ending-index-mismatch' };

export interface ChangeListenerFailure {
  readonly afterVersion: DocumentVersion;
  readonly error: unknown;
}

export interface ChangeListenerFailureDrain {
  readonly failures: readonly ChangeListenerFailure[];
  readonly droppedCount: number;
}

interface UndoCommitOptions {
  readonly targetRevisionId?: RevisionId;
  readonly inverseLineEndings?: readonly InverseLineEndingPatch[];
  readonly sourceSnapshot?: DocumentSnapshot;
  readonly sourceLineEndings?: LineEndingSequence;
  readonly historyReplay?: true;
}

interface UndoStepDraft {
  readonly forwardEdits: readonly DocumentEdit[];
  readonly forwardTextRuns: readonly UndoTextRun[];
  readonly inverseEdits: readonly DocumentEdit[];
  readonly inverseSources: readonly import('./undo').UndoTextSource[];
  readonly inverseLineEndings: readonly InverseLineEndingPatch[];
  readonly retainedUtf16: number;
  readonly retainedRootUtf16: number;
  readonly retainedMetadataBytes: number;
  readonly coalescibleInsert: boolean;
}

const TEXT_FILE_DOCUMENT_TOKEN = Symbol('TextFileDocument.factory');
const MAX_RETAINED_LISTENER_FAILURES = 32;
const MAX_INLINE_UNDO_TEXT_UTF16 = 1_048_576;
const MAX_INLINE_UNDO_EOL_COUNT = 16_384;

export type OpenTextDocument =
  | { readonly kind: 'editable'; readonly document: TextFileDocument }
  | { readonly kind: 'read-only'; readonly document: ReadOnlyByteDocument };

/** Open accepted UTF-8 bytes losslessly; unsupported bytes remain available read-only. */
export function openTextDocument(
  id: DocumentId,
  bytes: Uint8Array,
  seed = 41027,
  options: OpenTextDocumentOptions = {},
): OpenTextDocument {
  const fileFormat = resolveFileFormat(options);
  if (fileFormat === undefined) {
    return { kind: 'read-only', document: new ReadOnlyByteDocument(id, bytes, 'invalid-file-format') };
  }
  const hasUtf8Bom = startsWithUtf8Bom(bytes);
  const payload = bytes.subarray(hasUtf8Bom ? 3 : 0);
  let decoded: string;
  try {
    // The file BOM has already been removed into metadata; preserve any further U+FEFF as content.
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload);
  } catch {
    return { kind: 'read-only', document: new ReadOnlyByteDocument(id, bytes, 'invalid-utf8') };
  }
  if (decoded.includes('\0')) {
    return { kind: 'read-only', document: new ReadOnlyByteDocument(id, bytes, 'binary-content') };
  }
  // Scan once and reuse: `hasCarriageReturn` feeds normalizeLineEndings (skipping its own
  // includes('\r')) and `wellFormed` feeds RopeDocument.create's trusted-metrics fast path
  // (skipping its isNormalizedText re-scan). Native String methods here (measured) beat a
  // hand-rolled combined per-char loop -- see tests/document/t010-text-fidelity.ts open-scan bench.
  const hasCarriageReturn = decoded.includes('\r');
  const wellFormed = decoded.isWellFormed();

  const normalized = normalizeLineEndings(decoded, fileFormat, hasCarriageReturn);
  if (normalized === undefined) {
    return { kind: 'read-only', document: new ReadOnlyByteDocument(id, bytes, 'ambiguous-line-endings') };
  }
  // normalizeLineEndings only returns text still containing '\r' when hasCarriageReturn was
  // true (see its 'unix'/'dos'-without-crlf branches); skip the recheck otherwise.
  const normalizedHasCarriageReturn = hasCarriageReturn && normalized.text.includes('\r');
  const opened = TextFileDocument.create(
    id,
    normalized.text,
    normalized.lineEndingSequence,
    normalized.defaultLineEnding,
    hasUtf8Bom,
    seed,
    normalizedHasCarriageReturn ? 'literal-control' : undefined,
    // Safe whenever the non-literal-control branch above is taken: CR replacement is an
    // ASCII-only rewrite that cannot change UTF-16 well-formedness.
    wellFormed,
  );
  if (!opened.ok) throw new Error(`normalized-utf8-document-rejected:${opened.error.kind}`);
  return {
    kind: 'editable',
    document: opened.value,
  };
}

/**
 * Open UTF-8 input delivered as bounded chunks. UTF-8 decoding and EOL
 * classification happen incrementally; the retained decoded values are chunks,
 * never a per-line normalization array.
 */
export async function openTextDocumentChunks(
  id: DocumentId,
  chunks: AsyncIterable<Uint8Array>,
  seed = 41027,
  options: OpenTextDocumentOptions = {},
): Promise<OpenTextDocument> {
  const original: Uint8Array[] = [];
  const fileFormat = resolveFileFormat(options);
  let prefix: number[] = [];
  let payloadStarted = false;
  let hasUtf8Bom = false;
  let pendingCR = false;
  let sawLoneCR = false;
  let sawNul = false;
  const endings = new LineEndingSequenceBuilder();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const emptyRope = RopeDocument.create(id, '', seed);
  if (!emptyRope.ok) throw new Error(`chunked-rope-rejected:${emptyRope.error.kind}`);
  const textDocument = emptyRope.value;

  const appendNormalized = (normalized: string): void => {
    if (normalized.length === 0) return;
    const appended = textDocument.appendInitialChunk(normalized, true);
    if (!appended.ok) throw new Error(`chunked-rope-rejected:${appended.error.kind}`);
  };

  const appendDecoded = (decoded: string): void => {
    if (decoded.length === 0) return;
    if (decoded.includes('\0')) sawNul = true;
    let text = decoded;
    if (pendingCR) {
      if (text.charCodeAt(0) === 10) {
        endings.push('crlf');
        appendNormalized('\n');
        text = text.slice(1);
      } else {
        sawLoneCR = true;
        if (fileFormat === 'legacy' || fileFormat === 'mac') {
          endings.push('cr');
          appendNormalized('\n');
        } else {
          appendNormalized('\r');
        }
      }
      pendingCR = false;
      if (text.length === 0) return;
    }
    // Fast path: chunks without a bare/leading CR need no per-line splitting;
    // append the decoded text whole and only tally its LF count.
    if (text.indexOf('\r') === -1) {
      let lfCount = 0;
      for (let index = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === 10) lfCount += 1;
      }
      for (let index = 0; index < lfCount; index += 1) endings.push('lf');
      appendNormalized(text);
      return;
    }
    const parts: string[] = [];
    let start = 0;
    let index = 0;
    for (; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 10) {
        if (index > start) parts.push(text.slice(start, index));
        endings.push('lf');
        parts.push('\n');
        start = index + 1;
        continue;
      }
      if (text.charCodeAt(index) !== 13) continue;
      if (index > start) parts.push(text.slice(start, index));
      if (index + 1 === text.length) {
        pendingCR = true;
        start = text.length;
        continue;
      }
      if (text.charCodeAt(index + 1) === 10) {
        endings.push('crlf');
        parts.push('\n');
        index += 1;
        start = index + 1;
        continue;
      }
      sawLoneCR = true;
      if (fileFormat === 'legacy' || fileFormat === 'mac') {
        endings.push('cr');
        parts.push('\n');
      } else {
        parts.push('\r');
      }
      start = index + 1;
    }
    if (start < text.length) parts.push(text.slice(start));
    const normalized = parts.join('');
    appendNormalized(normalized);
  };

  const appendPayload = (bytes: Uint8Array): void => {
    if (bytes.length !== 0) appendDecoded(decoder.decode(bytes, { stream: true }));
  };

  try {
    for await (const chunk of chunks) {
      if (!(chunk instanceof Uint8Array)) throw new TypeError('file chunk is not Uint8Array');
      // Retained only for the rare invalid-input fallback; producers hand each
      // chunk over once and do not mutate it after yielding, so no copy is needed here.
      original.push(chunk);
      let offset = 0;
      if (!payloadStarted) {
        while (prefix.length < 3 && offset < chunk.length) {
          const byte = chunk[offset];
          if (byte !== undefined) prefix.push(byte);
          offset += 1;
        }
        if (prefix.length === 3) {
          hasUtf8Bom = prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf;
          appendPayload(Uint8Array.from(hasUtf8Bom ? [] : prefix));
          prefix = [];
          payloadStarted = true;
        }
      }
      if (payloadStarted) appendPayload(chunk.subarray(offset));
    }
    if (!payloadStarted) {
      hasUtf8Bom = prefix.length === 3 && prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf;
      appendPayload(Uint8Array.from(hasUtf8Bom ? [] : prefix));
    }
    appendDecoded(decoder.decode());
  } catch {
    return { kind: 'read-only', document: new ReadOnlyByteDocument(id, concatBytes(original), 'invalid-utf8') };
  }

  if (fileFormat === undefined) {
    return { kind: 'read-only', document: new ReadOnlyByteDocument(id, concatBytes(original), 'invalid-file-format') };
  }
  if (sawNul) return { kind: 'read-only', document: new ReadOnlyByteDocument(id, concatBytes(original), 'binary-content') };
  if (pendingCR) {
    sawLoneCR = true;
    if (fileFormat === 'legacy' || fileFormat === 'mac') {
      endings.push('cr');
      appendNormalized('\n');
    } else {
      appendNormalized('\r');
    }
  }
  if (fileFormat === 'auto' && sawLoneCR) {
    return { kind: 'read-only', document: new ReadOnlyByteDocument(id, concatBytes(original), 'ambiguous-line-endings') };
  }
  const finished = endings.finish();
  original.length = 0;
  const opened = TextFileDocument.createFromRope(
    textDocument,
    finished.sequence,
    finished.defaultLineEnding,
    hasUtf8Bom,
  );
  if (!opened.ok) {
    throw new Error(`chunked-utf8-document-rejected:${opened.error.kind}`);
  }
  return { kind: 'editable', document: opened.value };
}

/** A rejected byte sequence cannot be edited or silently rewritten. */
export class ReadOnlyByteDocument {
  readonly readOnly = true;
  readonly explanation: string;
  readonly #originalBytes: Uint8Array;

  constructor(
    readonly id: DocumentId,
    originalBytes: Uint8Array,
    readonly reason: ReadOnlyByteReason,
  ) {
    this.#originalBytes = originalBytes.slice();
    this.explanation = reason === 'invalid-utf8'
      ? 'This file is not valid UTF-8. It is read-only so saving cannot replace or discard the original bytes.'
      : reason === 'binary-content'
        ? 'This file contains a NUL byte and is treated as binary. It is read-only so saving cannot replace or discard the original bytes.'
        : reason === 'ambiguous-line-endings'
          ? 'This file contains lone carriage returns that may be literal content or legacy line endings. Choose a fileformat to edit it without losing bytes.'
          : 'The requested fileformat is invalid. The original bytes remain read-only.';
    Object.freeze(this);
  }

  get byteLength(): number { return this.#originalBytes.length; }

  copyOriginalBytes(): Uint8Array { return this.#originalBytes.slice(); }
}

/** Editable normalized-LF text with versioned line-ending and BOM metadata. */
export class TextFileDocument {
  #lineEndings: LineEndingSequence;
  readonly #changeListeners = new Set<{ readonly listener: (change: CommittedDocumentChange) => void }>();
  #publishingChange = false;
  #savedRevision: RevisionId;
  #maximumRevisionId: RevisionId;
  readonly #textDocument: RopeDocument;
  readonly #undoTree: UndoTree;
  #historyBusy = false;
  #snapshotCache: TextFileSnapshot | undefined;
  readonly #listenerFailures: ChangeListenerFailure[] = [];
  #droppedListenerFailures = 0;
  readonly #hasUtf8Bom: boolean;
  readonly #defaultLineEnding: LineEnding;

  static create(
    id: DocumentId,
    normalizedText: string,
    lineEndings: readonly LineEnding[] | LineEndingSequence,
    defaultLineEnding: LineEnding,
    hasUtf8Bom = false,
    seed = 41027,
    initialTextIntent?: DocumentTextIntent,
    /** Caller already proved `normalizedText` has no CR and is well-formed UTF-16 (see `RopeDocument.create`). */
    trustedNormalizedText = false,
  ): Result<TextFileDocument, TextDocumentCreateFailure> {
    if ((!Array.isArray(lineEndings) && !(lineEndings instanceof LineEndingSequence))
      || !isLineEnding(defaultLineEnding)
      || (Array.isArray(lineEndings) && lineEndings.some((ending) => !isLineEnding(ending)))
      || typeof hasUtf8Bom !== 'boolean') {
      return { ok: false, error: { kind: 'invalid-line-ending' } };
    }
    if (initialTextIntent !== undefined && initialTextIntent !== 'literal-control') {
      return { ok: false, error: { kind: 'invalid-text' } };
    }
    const textDocument = initialTextIntent === 'literal-control'
      ? RopeDocument.createWithLiteralCRContent(id, normalizedText, seed)
      : RopeDocument.create(id, normalizedText, seed, trustedNormalizedText);
    if (!textDocument.ok) return { ok: false, error: textDocument.error };
    const lineEndingSequence = lineEndings instanceof LineEndingSequence
      ? lineEndings
      : LineEndingSequence.from(lineEndings);
    if (lineEndingSequence.length !== textDocument.value.metrics().lineBreaks) {
      return { ok: false, error: { kind: 'line-ending-index-mismatch' } };
    }
    return {
      ok: true,
      value: new TextFileDocument(
        TEXT_FILE_DOCUMENT_TOKEN,
        textDocument.value,
        hasUtf8Bom,
        lineEndingSequence,
        defaultLineEnding,
      ),
    };
  }

  /** Construct from normalized chunks so persistence need not join a large input string. */
  static createFromChunks(
    id: DocumentId,
    normalizedChunks: Iterable<string>,
    lineEndings: readonly LineEnding[] | LineEndingSequence,
    defaultLineEnding: LineEnding,
    hasUtf8Bom = false,
    seed = 41027,
    initialTextIntent?: DocumentTextIntent,
  ): Result<TextFileDocument, TextDocumentCreateFailure> {
    if ((!Array.isArray(lineEndings) && !(lineEndings instanceof LineEndingSequence))
      || !isLineEnding(defaultLineEnding)
      || (Array.isArray(lineEndings) && lineEndings.some((ending) => !isLineEnding(ending)))
      || typeof hasUtf8Bom !== 'boolean'
      || (initialTextIntent !== undefined && initialTextIntent !== 'literal-control')) {
      return { ok: false, error: { kind: 'invalid-line-ending' } };
    }
    const textDocument = RopeDocument.createFromChunks(id, normalizedChunks, seed, initialTextIntent === 'literal-control');
    if (!textDocument.ok) return { ok: false, error: textDocument.error };
    const lineEndingSequence = lineEndings instanceof LineEndingSequence
      ? lineEndings
      : LineEndingSequence.from(lineEndings);
    if (lineEndingSequence.length !== textDocument.value.metrics().lineBreaks) {
      return { ok: false, error: { kind: 'line-ending-index-mismatch' } };
    }
    return {
      ok: true,
      value: new TextFileDocument(TEXT_FILE_DOCUMENT_TOKEN, textDocument.value, hasUtf8Bom, lineEndingSequence, defaultLineEnding),
    };
  }

  /** Finalize a rope assembled by a streaming decoder without flattening it. */
  static createFromRope(
    textDocument: RopeDocument,
    lineEndings: readonly LineEnding[] | LineEndingSequence,
    defaultLineEnding: LineEnding,
    hasUtf8Bom = false,
  ): Result<TextFileDocument, TextDocumentCreateFailure> {
    if ((!Array.isArray(lineEndings) && !(lineEndings instanceof LineEndingSequence))
      || !isLineEnding(defaultLineEnding)
      || (Array.isArray(lineEndings) && lineEndings.some((ending) => !isLineEnding(ending)))
      || typeof hasUtf8Bom !== 'boolean') {
      return { ok: false, error: { kind: 'invalid-line-ending' } };
    }
    const lineEndingSequence = lineEndings instanceof LineEndingSequence
      ? lineEndings
      : LineEndingSequence.from(lineEndings);
    if (lineEndingSequence.length !== textDocument.metrics().lineBreaks) {
      return { ok: false, error: { kind: 'line-ending-index-mismatch' } };
    }
    return {
      ok: true,
      value: new TextFileDocument(TEXT_FILE_DOCUMENT_TOKEN, textDocument, hasUtf8Bom, lineEndingSequence, defaultLineEnding),
    };
  }

  private constructor(
    token: typeof TEXT_FILE_DOCUMENT_TOKEN,
    textDocument: RopeDocument,
    hasUtf8Bom: boolean,
    initialLineEndings: LineEndingSequence,
    defaultLineEnding: LineEnding,
  ) {
    if (token !== TEXT_FILE_DOCUMENT_TOKEN) throw new Error('TextFileDocument-constructor-is-private');
    this.#textDocument = textDocument;
    this.#hasUtf8Bom = hasUtf8Bom;
    this.#defaultLineEnding = defaultLineEnding;
    this.#lineEndings = initialLineEndings;
    if (this.#lineEndings.length !== textDocument.metrics().lineBreaks) {
      throw new Error('line-ending-metadata-does-not-match-document');
    }
    this.#savedRevision = textDocument.snapshot().revisionId;
    this.#maximumRevisionId = textDocument.snapshot().revisionId;
    this.#undoTree = new UndoTree(textDocument.snapshot().revisionId);
  }

  get id(): DocumentId { return this.#textDocument.snapshot().id; }
  get version(): DocumentVersion { return this.#textDocument.snapshot().version; }
  get revisionId(): RevisionId { return this.#textDocument.snapshot().revisionId; }
  get savedRevisionId(): RevisionId { return this.#savedRevision; }
  get hasUtf8Bom(): boolean { return this.#hasUtf8Bom; }
  get defaultLineEnding(): LineEnding { return this.#defaultLineEnding; }
  /** Private storage accounting exposed as immutable counters for performance probes. */
  lineEndingStorageMetrics(): LineEndingStorageMetrics { return this.#lineEndings.metrics(); }
  get isDirty(): boolean { return this.revisionId !== this.#savedRevision; }
  get readOnly(): false { return false; }

  snapshot(): TextFileSnapshot {
    const cached = this.#snapshotCache;
    if (cached !== undefined) return cached;
    const text = this.#textDocument.snapshot();
    const snapshot = new TextFileSnapshotView(
      text,
      this.hasUtf8Bom,
      text.revisionId,
      this.#lineEndings,
      this.defaultLineEnding,
    );
    this.#snapshotCache = snapshot;
    return snapshot;
  }

  slice(start: Utf16Offset, end: Utf16Offset, expectedVersion: DocumentVersion) {
    return this.#textDocument.slice(start, end, expectedVersion);
  }

  /**
   * Produce the document snapshot a valid batch would create, without touching
   * the live rope, line-ending metadata, history or change stream.
   */
  previewTextEdits(
    edits: readonly DocumentEdit[],
    expectedVersion: DocumentVersion,
  ): Result<DocumentSnapshot, DocumentTransactionFailure> {
    if (this.#publishingChange) return { ok: false, error: { kind: 'reentrant-transaction' } };
    if (this.#historyBusy) return { ok: false, error: { kind: 'history-operation-in-progress' } };
    const before = this.#textDocument.snapshot();
    if (expectedVersion !== before.version) return { ok: false, error: { kind: 'stale-version' } };
    if (edits.length === 0) return { ok: true, value: before };
    if ((before.version as number) >= Number.MAX_SAFE_INTEGER) {
      return { ok: false, error: { kind: 'version-overflow' } };
    }
    const afterVersion = asDocumentVersion((before.version as number) + 1);
    if (!afterVersion.ok) return { ok: false, error: { kind: 'version-overflow' } };
    const normalizedEdits = edits.map(normalizeEditText);
    const checked = DocumentChangeMap.create(before, afterVersion.value, normalizedEdits);
    if (!checked.ok) return checked;
    const orderedEdits = checked.value.orderedEdits;
    const candidateEndings = transformLineEndings(before, this.#lineEndings, orderedEdits, this.defaultLineEnding);
    if (!candidateEndings.ok) return candidateEndings;
    let contentChanged = false;
    for (const edit of orderedEdits) {
      if ((edit.end as number) - (edit.start as number) !== edit.text.length) {
        contentChanged = true;
        break;
      }
      const previousText = before.slice(edit.start, edit.end);
      if (!previousText.ok) return previousText;
      if (previousText.value !== edit.text) {
        contentChanged = true;
        break;
      }
    }
    if (!contentChanged && candidateEndings.value === this.#lineEndings) {
      return { ok: true, value: before };
    }
    return this.#textDocument.previewBatch(orderedEdits, before.version);
  }

  apply(edit: DocumentEdit, expectedVersion: DocumentVersion): Result<DocumentVersion, DocumentTransactionFailure> {
    return this.applyBatch([edit], expectedVersion);
  }

  applyBatch(edits: readonly DocumentEdit[], expectedVersion: DocumentVersion): Result<DocumentVersion, DocumentTransactionFailure> {
    const group = asUndoGroupId(`direct-edit-${(expectedVersion as number) + 1}`);
    if (!group.ok) return { ok: false, error: { kind: 'invalid-undo-group' } };
    const committed = this.commit({
      documentId: this.id,
      expectedVersion,
      edits,
      origin: 'vim',
      undoGroup: group.value,
    });
    if (!committed.ok) return committed;
    return {
      ok: true,
      value: committed.value.kind === 'committed' ? committed.value.change.after : committed.value.version,
    };
  }

  /** Validate and atomically commit edits against exactly one immutable base version. */
  commit(proposal: EditProposal): Result<CommitOutcome, DocumentTransactionFailure> {
    return this.commitInternal(proposal, {});
  }

  private commitInternal(
    proposal: EditProposal,
    options: UndoCommitOptions,
  ): Result<CommitOutcome, DocumentTransactionFailure> {
    if (this.#publishingChange) return { ok: false, error: { kind: 'reentrant-transaction' } };
    if (this.#historyBusy && options.historyReplay !== true) {
      return { ok: false, error: { kind: 'history-operation-in-progress' } };
    }
    const validated = validateEditProposal(proposal, this.id);
    if (!validated.ok) return validated;
    const before = this.#textDocument.snapshot();
    const beforeEndings = this.#lineEndings;
    if (validated.value.expectedVersion !== before.version) return { ok: false, error: { kind: 'stale-version' } };
    if (validated.value.edits.length === 0) {
      return { ok: true, value: { kind: 'unchanged', version: before.version, revisionId: before.revisionId } };
    }
    if ((before.version as number) >= Number.MAX_SAFE_INTEGER
      || (options.targetRevisionId === undefined && (this.#maximumRevisionId as number) >= Number.MAX_SAFE_INTEGER)) {
      return { ok: false, error: { kind: 'version-overflow' } };
    }

    const normalizedEdits = validated.value.edits.map(normalizeEditText);
    const afterVersion = asDocumentVersion((before.version as number) + 1);
    if (!afterVersion.ok) return { ok: false, error: { kind: 'version-overflow' } };
    const changeMap = DocumentChangeMap.create(before, afterVersion.value, normalizedEdits);
    if (!changeMap.ok) return changeMap;
    const orderedEdits = changeMap.value.orderedEdits;
    const sourceSnapshot = options.sourceSnapshot instanceof TextFileSnapshotView
      ? options.sourceSnapshot.ownerTextSnapshot()
      : options.sourceSnapshot;
    const sourceEndings = options.sourceLineEndings
      ?? (options.sourceSnapshot instanceof TextFileSnapshotView ? options.sourceSnapshot.ownerLineEndingSequence() : undefined);
    const candidateEndings = sourceEndings === undefined
      ? transformLineEndings(
        before,
        beforeEndings,
        orderedEdits,
        this.defaultLineEnding,
        options.inverseLineEndings,
      )
      : { ok: true as const, value: sourceEndings };
    if (!candidateEndings.ok) return candidateEndings;
    let contentChanged = false;
    for (const edit of orderedEdits) {
      const removedLength = (edit.end as number) - (edit.start as number);
      if (removedLength !== edit.text.length) {
        contentChanged = true;
        break;
      }
      if (removedLength > MAX_INLINE_UNDO_TEXT_UTF16) {
        const compare = before.rangeEqualsText;
        if (compare === undefined) return { ok: false, error: { kind: 'invalid-text' } };
        const equal = compare.call(before, edit.start, edit.end, edit.text);
        if (!equal.ok) return equal;
        if (!equal.value) {
          contentChanged = true;
          break;
        }
        continue;
      }
      const previousText = before.slice(edit.start, edit.end);
      if (!previousText.ok) return previousText;
      if (previousText.value !== edit.text) {
        contentChanged = true;
        break;
      }
    }
    if (!contentChanged && candidateEndings.value === this.#lineEndings) {
      return { ok: true, value: { kind: 'unchanged', version: before.version, revisionId: before.revisionId } };
    }

    let historyDraft: UndoStepDraft | undefined;
    if (options.historyReplay !== true) {
      const prepared = prepareUndoStep(before, beforeEndings, orderedEdits, changeMap.value.changedSpans);
      if (!prepared.ok) return prepared;
      historyDraft = prepared.value;
      const retention: UndoRetention = {
        retainedUtf16: historyDraft.retainedUtf16,
        retainedRootUtf16: historyDraft.retainedRootUtf16,
        retainedMetadataBytes: historyDraft.retainedMetadataBytes,
        coalescibleInsert: historyDraft.coalescibleInsert,
      };
      if (!this.#undoTree.canAppend(retention, validated.value.undoGroup, validated.value.origin)) {
        return { ok: false, error: { kind: 'undo-history-limit' } };
      }
    }

    const applied = sourceSnapshot !== undefined && options.targetRevisionId !== undefined
      ? this.#textDocument.restoreSnapshot(sourceSnapshot, before.version, options.targetRevisionId)
      : options.targetRevisionId === undefined
        ? this.#textDocument.applyBatch(orderedEdits, before.version)
        : this.#textDocument.applyBatchRestoringRevision(orderedEdits, before.version, options.targetRevisionId);
    if (!applied.ok) return applied;
    this.#lineEndings = candidateEndings.value;
    this.#snapshotCache = undefined;
    const after = this.#textDocument.snapshot();
    if ((after.revisionId as number) > (this.#maximumRevisionId as number)) this.#maximumRevisionId = after.revisionId;
    const change: CommittedDocumentChange = Object.freeze({
      documentId: this.id,
      before: before.version,
      after: after.version,
      beforeRevisionId: before.revisionId,
      afterRevisionId: after.revisionId,
      changedRanges: Object.freeze(changeMap.value.changedSpans.map((span) => Object.freeze({
        start: span.start,
        oldEnd: span.oldEnd,
        newEnd: span.newEnd,
      }))),
      origin: validated.value.origin,
      undoGroup: validated.value.undoGroup,
      ...(validated.value.selectionHistory === undefined ? {} : { selectionHistory: validated.value.selectionHistory }),
      edits: orderedEdits,
      changedSpans: changeMap.value.changedSpans,
      changeMap: changeMap.value,
      snapshot: after,
    });
    if (historyDraft !== undefined) {
      const step: UndoStep = Object.freeze({
        beforeRevisionId: before.revisionId,
        afterRevisionId: after.revisionId,
        forwardEdits: historyDraft.forwardEdits,
        forwardTextRuns: historyDraft.forwardTextRuns,
        inverseEdits: historyDraft.inverseEdits,
        inverseSources: historyDraft.inverseSources,
        inverseLineEndings: historyDraft.inverseLineEndings,
        retainedUtf16: historyDraft.retainedUtf16,
        retainedRootUtf16: historyDraft.retainedRootUtf16,
        retainedMetadataBytes: historyDraft.retainedMetadataBytes,
        coalescibleInsert: historyDraft.coalescibleInsert,
      });
      this.#undoTree.record(change, step);
    }
    this.publishChange(change);
    return { ok: true, value: { kind: 'committed', change } };
  }

  /** Open an explicit undo-group boundary. Only commits with this id and origin coalesce. */
  beginUndoGroup(
    groupId: UndoGroupId,
    origin: EditOrigin,
    beforeSelection?: unknown,
  ): Result<void, UndoGroupFailure | { readonly kind: 'invalid-undo-group' | 'invalid-origin' | 'history-operation-in-progress' }> {
    if (this.#publishingChange || this.#historyBusy) return { ok: false, error: { kind: 'history-operation-in-progress' } };
    const validId = asUndoGroupId(groupId);
    if (!validId.ok) return { ok: false, error: { kind: 'invalid-undo-group' } };
    if (!isEditOrigin(origin)) return { ok: false, error: { kind: 'invalid-origin' } };
    return this.#undoTree.beginGroup(validId.value, origin, beforeSelection);
  }

  /** Close an open group and record its final inert cursor intent. */
  endUndoGroup(
    groupId: UndoGroupId,
    afterSelection?: unknown,
  ): Result<void, UndoGroupFailure | { readonly kind: 'invalid-undo-group' | 'history-operation-in-progress' }> {
    if (this.#publishingChange || this.#historyBusy) return { ok: false, error: { kind: 'history-operation-in-progress' } };
    const validId = asUndoGroupId(groupId);
    if (!validId.ok) return { ok: false, error: { kind: 'invalid-undo-group' } };
    return this.#undoTree.endGroup(validId.value, afterSelection);
  }

  undoHistoryStats() { return this.#undoTree.stats(); }
  redoBranches() { return this.#undoTree.redoBranches(); }

  undo(): Result<UndoOutcome, UndoOperationFailure> {
    if (this.#publishingChange || this.#historyBusy) {
      return { ok: false, error: { kind: 'history-operation-in-progress' } };
    }
    const plan = this.#undoTree.undoPlan();
    if (plan === undefined) return { ok: false, error: { kind: 'nothing-to-undo' } };
    return this.replayHistoryPlan(plan);
  }

  redo(branchId?: RevisionId): Result<UndoOutcome, UndoOperationFailure> {
    if (this.#publishingChange || this.#historyBusy) {
      return { ok: false, error: { kind: 'history-operation-in-progress' } };
    }
    const plan = this.#undoTree.redoPlan(branchId);
    if (!plan.ok) return plan;
    return this.replayHistoryPlan(plan.value);
  }

  serializeUndoHistory(): Result<Uint8Array, TextEncodingFailure | UndoHistoryFailure> {
    if (this.#publishingChange || this.#historyBusy) {
      return { ok: false, error: { kind: 'history-operation-in-progress' } };
    }
    const encoded = encodeTextFile(this.snapshot());
    if (!encoded.ok) return encoded;
    return {
      ok: true,
      value: this.#undoTree.serialize(
        this.id,
        this.revisionId,
        this.#savedRevision,
        this.#maximumRevisionId,
        fingerprintUndoContent(encoded.value),
      ),
    };
  }

  /** Restore validated history only onto a fresh document with identical serialized bytes. */
  restoreUndoHistory(bytes: Uint8Array): Result<void, UndoHistoryFailure> {
    if (this.#publishingChange || this.#historyBusy || this.#undoTree.hasEntries || (this.version as number) !== 1) {
      return { ok: false, error: { kind: 'history-not-empty' } };
    }
    const decoded = decodeUndoHistory(bytes, this.id);
    if (!decoded.ok) return decoded;
    const encoded = encodeTextFile(this.snapshot());
    if (!encoded.ok || fingerprintUndoContent(encoded.value) !== decoded.value.contentFingerprint) {
      return { ok: false, error: { kind: 'history-content-mismatch' } };
    }
    if (decoded.value.maximumRevisionId >= Number.MAX_SAFE_INTEGER) {
      return { ok: false, error: { kind: 'invalid-history-graph' } };
    }
    const currentRevision = asRevisionId(decoded.value.currentRevisionId);
    const maximumRevision = asRevisionId(decoded.value.maximumRevisionId);
    if (!currentRevision.ok || !maximumRevision.ok
      || !this.#textDocument.restoreInitialRevisionIdentity(currentRevision.value, decoded.value.maximumRevisionId + 1)) {
      return { ok: false, error: { kind: 'invalid-history-graph' } };
    }
    this.#undoTree.restore(decoded.value);
    this.#maximumRevisionId = maximumRevision.value;
    this.#savedRevision = decoded.value.savedRevisionId as RevisionId;
    this.#snapshotCache = undefined;
    return { ok: true, value: undefined };
  }

  private replayHistoryPlan(plan: import('./undo').UndoReplayPlan): Result<UndoOutcome, UndoOperationFailure> {
    this.#historyBusy = true;
    let lastChange: CommittedDocumentChange | undefined;
    try {
      for (let index = 0; index < plan.steps.length; index += 1) {
        const step = plan.steps[index];
        if (step === undefined) return { ok: false, error: { kind: 'history-replay-failed', stepIndex: index } };
        const undo = plan.direction === 'undo';
        const source = undo ? exactRootRestoreSource(step) : undefined;
        const replayEdits = source === undefined
          ? materializeUndoEdits(step, undo ? 'inverse' : 'forward')
          : { ok: true as const, value: step.inverseEdits };
        if (!replayEdits.ok) return { ok: false, error: { kind: 'history-replay-failed', stepIndex: index } };
        const proposal: EditProposal = {
          documentId: this.id,
          expectedVersion: this.version,
          edits: replayEdits.value,
          origin: plan.node.origin,
          undoGroup: plan.node.groupId,
        };
        const committed = this.commitInternal(proposal, {
          historyReplay: true,
          targetRevisionId: undo ? step.beforeRevisionId : step.afterRevisionId,
          ...(undo ? { inverseLineEndings: step.inverseLineEndings } : {}),
          ...(source === undefined ? {} : {
            sourceSnapshot: source.snapshot,
            ...(source.lineEndings === undefined ? {} : { sourceLineEndings: source.lineEndings }),
          }),
        });
        if (!committed.ok || committed.value.kind !== 'committed') {
          return { ok: false, error: { kind: 'history-replay-failed', stepIndex: index } };
        }
        lastChange = committed.value.change;
      }
      if (lastChange === undefined) return { ok: false, error: { kind: 'history-replay-failed', stepIndex: 0 } };
      this.#undoTree.complete(plan);
      const outcome: UndoOutcome = {
        kind: plan.direction === 'undo' ? 'undone' : 'redone',
        entry: this.#undoTree.entryInfo(plan.node),
        version: this.version,
        revisionId: this.revisionId,
        change: lastChange,
        ...(plan.restoredSelection === undefined ? {} : { restoredSelection: plan.restoredSelection }),
      };
      return { ok: true, value: Object.freeze(outcome) };
    } finally {
      this.#historyBusy = false;
    }
  }

  /** Subscribe a view or service to the one ordered text-revision stream. */
  subscribeChanges(listener: (change: CommittedDocumentChange) => void): { dispose(): void } {
    const registration = { listener };
    this.#changeListeners.add(registration);
    let active = true;
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        this.#changeListeners.delete(registration);
      },
    };
  }

  /** Mark the exact captured revision used by a save; a later edit remains dirty. */
  markSaved(identity: SaveRevisionIdentity): Result<void, SaveRevisionFailure> {
    if (identity.id !== this.id) return { ok: false, error: { kind: 'wrong-document' } };
    const saved = identity.revisionId as number;
    if (!Number.isSafeInteger(saved) || saved < 1 || saved > (this.#maximumRevisionId as number)) {
      return { ok: false, error: { kind: 'unknown-revision' } };
    }
    this.#savedRevision = identity.revisionId;
    return { ok: true, value: undefined };
  }

  /** Retrieve bounded observer failures without making a committed edit appear to fail. */
  drainChangeListenerFailures(): ChangeListenerFailureDrain {
    const drained = Object.freeze({
      failures: Object.freeze(this.#listenerFailures.splice(0)),
      droppedCount: this.#droppedListenerFailures,
    });
    this.#droppedListenerFailures = 0;
    return drained;
  }

  compact(): void {
    this.#textDocument.compact();
    this.#snapshotCache = undefined;
  }

  serialize(): Result<Uint8Array, TextEncodingFailure> {
    return encodeTextFile(this.snapshot());
  }

  serializeSnapshot(snapshot: TextFileSnapshot): Result<Uint8Array, TextEncodingFailure> {
    return encodeTextFile(snapshot);
  }

  private publishChange(change: CommittedDocumentChange): void {
    this.#publishingChange = true;
    try {
      for (const registration of [...this.#changeListeners]) {
        try {
          registration.listener(change);
        } catch (error: unknown) {
          if (this.#listenerFailures.length === MAX_RETAINED_LISTENER_FAILURES) {
            this.#listenerFailures.shift();
            this.#droppedListenerFailures += 1;
          }
          this.#listenerFailures.push(Object.freeze({ afterVersion: change.after, error }));
        }
      }
    } finally {
      this.#publishingChange = false;
    }
  }
}

function exactRootRestoreSource(step: UndoStep): import('./undo').UndoTextSource | undefined {
  if (step.inverseSources.length !== 1 || step.inverseEdits.length !== 1) return undefined;
  const source = step.inverseSources[0];
  const inverse = step.inverseEdits[0];
  if (source === undefined || inverse === undefined || inverse.text !== ''
    || (source.start as number) !== 0 || (source.end as number) !== source.snapshot.lengthUtf16
    || (inverse.start as number) !== 0 || (inverse.end as number) !== 0
    || source.lineEndings === undefined) return undefined;
  return source;
}

class TextFileSnapshotView implements TextFileSnapshot {
  readonly #text: DocumentSnapshot;
  readonly #lineEndingSequence: LineEndingSequence;
  readonly id: DocumentId;
  readonly version: DocumentVersion;
  readonly lengthUtf16: number;
  readonly lineCount: number;
  readonly readOnly = false;
  readonly encoding = 'utf-8' as const;
  readonly hasFinalNewline: boolean;

  constructor(
    text: DocumentSnapshot,
    readonly hasUtf8Bom: boolean,
    readonly revisionId: RevisionId,
    lineEndingSequence: LineEndingSequence,
    readonly defaultLineEnding: LineEnding,
  ) {
    this.#text = text;
    this.#lineEndingSequence = lineEndingSequence;
    this.id = text.id;
    this.version = text.version;
    this.lengthUtf16 = text.lengthUtf16;
    this.lineCount = text.lineCount;
    if (text.lengthUtf16 === 0) {
      this.hasFinalNewline = false;
    } else {
      const finalUnit = text.slice(utf16Offset(text.lengthUtf16 - 1), utf16Offset(text.lengthUtf16));
      this.hasFinalNewline = finalUnit.ok && finalUnit.value === '\n';
    }
    Object.freeze(this);
  }

  slice(start: Utf16Offset, end: Utf16Offset) { return this.#text.slice(start, end); }
  get lineEndings(): readonly LineEnding[] {
    const cached = lineEndingArrayCache.get(this);
    if (cached !== undefined) return cached;
    const values = this.#lineEndingSequence.toArray();
    lineEndingArrayCache.set(this, values);
    return values;
  }
  lineEndingAt(index: number): LineEnding | undefined { return this.#lineEndingSequence.at(index); }
  lineEndingReader(): { next(): LineEnding | undefined } { return this.#lineEndingSequence.reader(); }
  lineIndexAt(offset: Utf16Offset) { return this.#text.lineIndexAt(offset); }
  lineStartOffset(lineIndex_: LineIndex) { return this.#text.lineStartOffset(lineIndex_); }
  utf8OffsetAt(offset: Utf16Offset) { return this.#text.utf8OffsetAt(offset); }
  utf32OffsetAt(offset: Utf16Offset) { return this.#text.utf32OffsetAt(offset); }
  offsetAtUtf8(offset: Utf8ByteOffset) { return this.#text.offsetAtUtf8(offset); }
  offsetAtUtf32(offset: Utf32Offset) { return this.#text.offsetAtUtf32(offset); }
  isPrintableAsciiRange(start: Utf16Offset, end: Utf16Offset) {
    const classify = this.#text.isPrintableAsciiRange;
    return classify === undefined
      ? { ok: true as const, value: false }
      : classify.call(this.#text, start, end);
  }
  rangeEqualsText(start: Utf16Offset, end: Utf16Offset, text: string) {
    const compare = this.#text.rangeEqualsText;
    return compare === undefined
      ? { ok: true as const, value: false }
      : compare.call(this.#text, start, end, text);
  }
  ownerTextSnapshot(): DocumentSnapshot { return this.#text; }
  ownerLineEndingSequence(): LineEndingSequence { return this.#lineEndingSequence; }
}

/** Serialize normalized text using its captured per-break endings and BOM. */
export function encodeTextFile(snapshot: TextFileSnapshot): Result<Uint8Array, TextEncodingFailure> {
  const content = snapshot.slice(utf16Offset(0), utf16Offset(snapshot.lengthUtf16));
  if (!content.ok) return content;
  let lineIndex_ = 0;
  let segmentStart = 0;
  const rendered: string[] = [];
  for (let index = 0; index < content.value.length; index += 1) {
    if (content.value.charCodeAt(index) !== 10) continue;
    const ending = lineEndingAt(snapshot, lineIndex_);
    if (ending === undefined) return { ok: false, error: { kind: 'line-ending-index-mismatch' } };
    rendered.push(content.value.slice(segmentStart, index), lineEndingText(ending));
    segmentStart = index + 1;
    lineIndex_ += 1;
  }
  if (lineEndingAt(snapshot, lineIndex_) !== undefined) return { ok: false, error: { kind: 'line-ending-index-mismatch' } };
  rendered.push(content.value.slice(segmentStart));
  const body = new TextEncoder().encode(rendered.join(''));
  if (!snapshot.hasUtf8Bom) return { ok: true, value: body };
  const withBom = new Uint8Array(body.length + 3);
  withBom.set([0xef, 0xbb, 0xbf], 0);
  withBom.set(body, 3);
  return { ok: true, value: withBom };
}

/** Stream a snapshot through bounded UTF-16 windows without building a file-sized byte buffer. */
export async function* encodeTextFileChunks(
  snapshot: TextFileSnapshot,
  windowUtf16 = 64 * 1024,
): AsyncIterable<Uint8Array> {
  if (!Number.isSafeInteger(windowUtf16) || windowUtf16 < 1) throw new Error('invalid-encoding-window');
  let start = 0;
  let endingIndex = 0;
  let first = true;
  const encoder = new TextEncoder();
  const endingReader = snapshot.lineEndingReader?.();
  while (start < snapshot.lengthUtf16) {
    let end = Math.min(snapshot.lengthUtf16, start + windowUtf16);
    let content = snapshot.slice(utf16Offset(start), utf16Offset(end));
    while (!content.ok && content.error.kind === 'surrogate-split' && end > start) {
      end -= 1;
      content = snapshot.slice(utf16Offset(start), utf16Offset(end));
    }
    if (!content.ok) throw new Error(`snapshot-slice:${content.error.kind}`);
    const rendered = content.value.replace(/\n/gu, () => {
      const ending = endingReader === undefined ? lineEndingAt(snapshot, endingIndex) : endingReader.next();
      if (ending === undefined) throw new Error('line-ending-index-mismatch');
      endingIndex += 1;
      return lineEndingText(ending);
    });
    let bytes = encoder.encode(rendered);
    if (first && snapshot.hasUtf8Bom) {
      const withBom = new Uint8Array(bytes.length + 3);
      withBom.set([0xef, 0xbb, 0xbf], 0);
      withBom.set(bytes, 3);
      bytes = withBom;
    }
    if (bytes.length !== 0) yield bytes;
    first = false;
    start = end;
  }
  if (endingReader === undefined && lineEndingAt(snapshot, endingIndex) !== undefined) throw new Error('line-ending-index-mismatch');
  if (endingReader !== undefined && endingReader.next() !== undefined) throw new Error('line-ending-index-mismatch');
  if (first && snapshot.hasUtf8Bom) yield new Uint8Array([0xef, 0xbb, 0xbf]);
}

function lineEndingAt(snapshot: TextFileSnapshot, index: number): LineEnding | undefined {
  if (snapshot.lineEndingAt !== undefined) return snapshot.lineEndingAt(index);
  return snapshot.lineEndings[index];
}

function prepareUndoStep(
  before: DocumentSnapshot,
  lineEndings: LineEndingSequence,
  forwardEdits: readonly DocumentEdit[],
  changedSpans: CommittedDocumentChange['changedSpans'],
): Result<UndoStepDraft, DocumentTransactionFailure> {
  if (forwardEdits.length !== changedSpans.length) return { ok: false, error: { kind: 'invalid-change-version' } };
  const inverseEdits: DocumentEdit[] = [];
  const inverseSources: import('./undo').UndoTextSource[] = [];
  const inverseLineEndings: InverseLineEndingPatch[] = [];
  let retainedUtf16 = 0;
  let retainedRootUtf16 = 0;
  for (let index = 0; index < forwardEdits.length; index += 1) {
    const edit = forwardEdits[index];
    const span = changedSpans[index];
    if (edit === undefined || span === undefined) return { ok: false, error: { kind: 'invalid-change-version' } };
    const startLine = before.lineIndexAt(edit.start);
    if (!startLine.ok) return startLine;
    const endLine = before.lineIndexAt(edit.end);
    if (!endLine.ok) return endLine;
    const removedCount = (endLine.value as number) - (startLine.value as number);
    const removedLength = (edit.end as number) - (edit.start as number);
    const useSource = removedLength > MAX_INLINE_UNDO_TEXT_UTF16;
    let removedText: string | undefined;
    if (!useSource) {
      const removed = before.slice(edit.start, edit.end);
      if (!removed.ok) return removed;
      removedText = removed.value;
      if (countLineFeeds(removedText) !== removedCount) {
        return { ok: false, error: { kind: 'line-ending-index-mismatch' } };
      }
    }
    inverseEdits.push(Object.freeze({
      start: span.newStart,
      end: span.newEnd,
      text: removedText ?? '',
      ...(removedText?.includes('\r') ? { textIntent: 'literal-control' as const } : {}),
    }));
    if (useSource) {
      inverseSources.push(Object.freeze({ editIndex: index, snapshot: before, start: edit.start, end: edit.end, lineEndings }));
      retainedRootUtf16 += before.lengthUtf16;
    }
    const insertedBreaks = countLineFeeds(edit.text);
    if (insertedBreaks !== 0 || removedCount !== 0) {
      if (removedCount > MAX_INLINE_UNDO_EOL_COUNT) {
        inverseLineEndings.push(Object.freeze({
          editIndex: index,
          removeCount: insertedBreaks,
          insert: Object.freeze([]),
          insertSequence: lineEndings.range(startLine.value as number, removedCount),
        }));
      } else {
        const removedLineEndings: LineEnding[] = [];
        for (let endingIndex = 0; endingIndex < removedCount; endingIndex += 1) {
          const ending = lineEndings.at((startLine.value as number) + endingIndex);
          if (ending === undefined) return { ok: false, error: { kind: 'line-ending-index-mismatch' } };
          removedLineEndings.push(ending);
        }
        inverseLineEndings.push(Object.freeze({
          editIndex: index,
          removeCount: insertedBreaks,
          insert: Object.freeze(removedLineEndings),
        }));
      }
    }
    retainedUtf16 += edit.text.length + (removedText?.length ?? 0);
  }
  if (!Number.isSafeInteger(retainedUtf16)) return { ok: false, error: { kind: 'undo-history-limit' } };
  const normalizedInverse = combineAmbiguousInverseEdits(inverseEdits, inverseLineEndings);
  const coalescibleInsert = isCoalescibleInsert(forwardEdits, normalizedInverse.edits, normalizedInverse.lineEndings);
  return {
    ok: true,
    value: Object.freeze({
      forwardEdits: Object.freeze(forwardEdits.map((edit) => Object.freeze({ ...edit }))),
      forwardTextRuns: Object.freeze([]),
      inverseEdits: normalizedInverse.edits,
      inverseSources: Object.freeze(inverseSources),
      inverseLineEndings: normalizedInverse.lineEndings,
      retainedUtf16,
      retainedRootUtf16,
      retainedMetadataBytes: estimateUndoStepMetadata(forwardEdits, normalizedInverse.edits, normalizedInverse.lineEndings),
      coalescibleInsert,
    }),
  };
}

function isCoalescibleInsert(
  forwardEdits: readonly DocumentEdit[],
  inverseEdits: readonly DocumentEdit[],
  inverseLineEndings: readonly InverseLineEndingPatch[],
): boolean {
  const forward = forwardEdits[0];
  const inverse = inverseEdits[0];
  return forwardEdits.length === 1 && inverseEdits.length === 1 && inverseLineEndings.length === 0
    && forward !== undefined && inverse !== undefined && forward.start === forward.end
    && inverse.text === '' && !forward.text.includes('\n') && !forward.text.includes('\r');
}

function combineAmbiguousInverseEdits(
  edits: readonly DocumentEdit[],
  lineEndings: readonly InverseLineEndingPatch[],
): { readonly edits: readonly DocumentEdit[]; readonly lineEndings: readonly InverseLineEndingPatch[] } {
  // A source-backed inverse has persistent coordinates and metadata. Keep its
  // canonical edit index stable; the large-delete path uses one source edit.
  if (lineEndings.some((patch) => patch.insertSequence !== undefined)) {
    return { edits: Object.freeze([...edits]), lineEndings: Object.freeze([...lineEndings]) };
  }
  const endingByEdit = new Map(lineEndings.map((patch) => [patch.editIndex, patch] as const));
  const combined: { edit: DocumentEdit; removeCount: number; insert: LineEnding[]; hasPatch: boolean }[] = [];
  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index];
    if (edit === undefined) continue;
    const patch = endingByEdit.get(index);
    const current = {
      edit,
      removeCount: patch?.removeCount ?? 0,
      insert: [...(patch?.insert ?? [])],
      hasPatch: patch !== undefined,
    };
    const previous = combined[combined.length - 1];
    if (previous === undefined) {
      combined.push(current);
      continue;
    }
    const previousStart = previous.edit.start as number;
    const previousEnd = previous.edit.end as number;
    const currentStart = current.edit.start as number;
    const overlaps = currentStart < previousEnd;
    const touchesInsertion = currentStart === previousEnd
      && ((previous.edit.start as number) === previousEnd || currentStart === (current.edit.end as number));
    const sharesStart = currentStart === previousStart;
    if (!overlaps && !touchesInsertion && !sharesStart) {
      combined.push(current);
      continue;
    }
    previous.edit = Object.freeze({
      start: previous.edit.start,
      end: (Math.max(previousEnd, current.edit.end as number)) as DocumentEdit['end'],
      text: previous.edit.text + current.edit.text,
    });
    previous.removeCount += current.removeCount;
    previous.insert.push(...current.insert);
    previous.hasPatch ||= current.hasPatch;
  }
  const normalizedEdits: DocumentEdit[] = [];
  const normalizedLineEndings: InverseLineEndingPatch[] = [];
  for (const entry of combined) {
    const editIndex = normalizedEdits.length;
    normalizedEdits.push(entry.edit);
    if (entry.hasPatch) {
      normalizedLineEndings.push(Object.freeze({
        editIndex,
        removeCount: entry.removeCount,
        insert: Object.freeze(entry.insert),
      }));
    }
  }
  return Object.freeze({
    edits: Object.freeze(normalizedEdits),
    lineEndings: Object.freeze(normalizedLineEndings),
  });
}

function transformLineEndings(
  snapshot: DocumentSnapshot,
  current: LineEndingSequence,
  edits: readonly DocumentEdit[],
  insertedEnding: LineEnding,
  overridePatches: readonly InverseLineEndingPatch[] = [],
): Result<LineEndingSequence, DocumentTransactionFailure> {
  let candidate = current;
  const patches = new Map<number, InverseLineEndingPatch>();
  for (const patch of overridePatches) {
    if (!Number.isSafeInteger(patch.editIndex) || patch.editIndex < 0 || patch.editIndex >= edits.length
      || patches.has(patch.editIndex) || !Number.isSafeInteger(patch.removeCount) || patch.removeCount < 0
      || patch.insert.some((ending) => !isLineEnding(ending))) {
      return { ok: false, error: { kind: 'invalid-range' } };
    }
    patches.set(patch.editIndex, patch);
  }
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index];
    if (edit === undefined) return { ok: false, error: { kind: 'invalid-range' } };
    const startLine = snapshot.lineIndexAt(edit.start);
    if (!startLine.ok) return startLine;
    const endLine = snapshot.lineIndexAt(edit.end);
    if (!endLine.ok) return endLine;
    const removedCount = (endLine.value as number) - (startLine.value as number);
    const insertedCount = countLineFeeds(edit.text);
    const patch = patches.get(index);
    const patchInsertCount = patch === undefined ? 0 : patch.insertSequence?.length ?? patch.insert.length;
    if (patch !== undefined && (patch.removeCount !== removedCount || patchInsertCount !== insertedCount)) {
      return { ok: false, error: { kind: 'line-ending-index-mismatch' } };
    }
    if (removedCount === 0 && insertedCount === 0 && patch === undefined) continue;
    const start = startLine.value as number;
    if (start + removedCount > candidate.length) return { ok: false, error: { kind: 'invalid-range' } };
    if (patch === undefined) {
      if (removedCount === insertedCount && candidate.rangeEqualsUniform(start, removedCount, insertedEnding)) continue;
      candidate = candidate.spliceUniform(start, removedCount, insertedCount, insertedEnding);
      continue;
    }
    if (patch.insertSequence !== undefined) {
      candidate = candidate.spliceSequence(start, removedCount, patch.insertSequence);
      continue;
    }
    if (removedCount === patch.insert.length
      && patch.insert.every((ending, endingIndex) => candidate.at(start + endingIndex) === ending)) continue;
    candidate = candidate.splice(start, removedCount, patch.insert);
  }
  if (patches.size > edits.length) return { ok: false, error: { kind: 'invalid-range' } };
  return { ok: true, value: candidate };
}

function normalizeLineEndings(
  text: string,
  fileFormat: TextFileFormat,
  hasCarriageReturn: boolean,
): { readonly text: string; readonly lineEndingSequence: LineEndingSequence; readonly defaultLineEnding: LineEnding } | undefined {
  // hasLoneCarriageReturn cannot be true when the caller's scan already found no CR at all.
  if (fileFormat === 'auto' && hasCarriageReturn && hasLoneCarriageReturn(text)) return undefined;
  if (!hasCarriageReturn) {
    return { text, lineEndingSequence: LineEndingSequence.fromUniform(countLineFeeds(text), 'lf'), defaultLineEnding: 'lf' };
  }

  if (fileFormat === 'unix' || (fileFormat === 'dos' && !text.includes('\r\n'))) {
    return { text, lineEndingSequence: LineEndingSequence.fromUniform(countLineFeeds(text), 'lf'), defaultLineEnding: 'lf' };
  }

  const builder = new LineEndingSequenceBuilder();
  const normalized = text.replace(/\r\n|\r|\n/gu, (match: string) => {
    if (match === '\n') {
      builder.push('lf');
      return '\n';
    }
    if (match === '\r\n') {
      builder.push('crlf');
      return '\n';
    }
    if ((fileFormat === 'legacy' || fileFormat === 'mac') && match === '\r') {
      builder.push('cr');
      return '\n';
    }
    // Keep a literal CR in dos input.
    return match;
  });
  const finished = builder.finish();
  return { text: normalized, lineEndingSequence: finished.sequence, defaultLineEnding: finished.defaultLineEnding };
}

function hasLoneCarriageReturn(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 13 && text.charCodeAt(index + 1) !== 10) return true;
  }
  return false;
}

function resolveFileFormat(options: OpenTextDocumentOptions): TextFileFormat | undefined {
  try {
    if (typeof options !== 'object' || options === null || Array.isArray(options)
      || (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
      || Object.keys(options).some((key) => key !== 'fileFormat')) return undefined;
    const selected = options.fileFormat ?? 'legacy';
    return selected === 'auto' || selected === 'unix' || selected === 'dos'
      || selected === 'mac' || selected === 'legacy'
      ? selected
      : undefined;
  } catch {
    return undefined;
  }
}

function chooseDefaultEnding(endings: readonly LineEnding[]): LineEnding {
  if (endings.length === 0) return 'lf';
  const counts: Record<LineEnding, number> = { lf: 0, crlf: 0, cr: 0 };
  for (const ending of endings) counts[ending] += 1;
  let selected = endings[0] ?? 'lf';
  for (const ending of endings) if (counts[ending] > counts[selected]) selected = ending;
  return selected;
}

function isLineEnding(value: unknown): value is LineEnding {
  return value === 'lf' || value === 'crlf' || value === 'cr';
}

function isEditOrigin(value: unknown): value is EditOrigin {
  return value === 'vim' || value === 'lsp' || value === 'formatter'
    || value === 'workspace-replace' || value === 'directory';
}

function startsWithUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function countLineFeeds(text: string): number {
  // indexOf is a native vectorized scan; measured ~3x faster than a per-char charCodeAt loop
  // for multi-MiB buffers (see tests/document/t010-text-fidelity.ts open-scan bench).
  let count = 0;
  for (let offset = text.indexOf('\n'); offset >= 0; offset = text.indexOf('\n', offset + 1)) count += 1;
  return count;
}

function normalizeInsertedLineEndings(text: string): string {
  return text.replace(/\r\n?/gu, '\n');
}

function normalizeEditText(edit: DocumentEdit): DocumentEdit {
  return Object.freeze({
    ...edit,
    text: edit.textIntent === 'literal-control' ? edit.text : normalizeInsertedLineEndings(edit.text),
  });
}

function lineEndingText(ending: LineEnding): string {
  switch (ending) {
    case 'lf': return '\n';
    case 'crlf': return '\r\n';
    case 'cr': return '\r';
  }
}

function utf16Offset(value: number): Utf16Offset { return value as Utf16Offset; }
