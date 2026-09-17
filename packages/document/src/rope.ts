import {
  asDocumentVersion,
  asRevisionId,
  type DocumentVersion,
  type LineIndex,
  type RevisionId,
  type Utf16Offset,
  type Utf32Offset,
  type Utf8ByteOffset,
} from '../../primitives/src/index';
import type { DocumentReadFailure, DocumentSnapshot, Result } from './contracts.ts';

const MAX_CHUNK_UTF16 = 1024;

export type DocumentTextIntent = 'literal-control';

export interface DocumentEdit {
  /** Zero-based UTF-16 code-unit offsets against the expected document version. */
  readonly start: Utf16Offset;
  readonly end: Utf16Offset;
  /** Well-formed replacement text; ordinary edits are LF-normalized at the text-file boundary. */
  readonly text: string;
  /** Preserve U+000D as content instead of interpreting CR/CRLF as line-ending input. */
  readonly textIntent?: DocumentTextIntent;
}

export type DocumentMutationFailure = DocumentReadFailure
  | { readonly kind: 'invalid-text' }
  | { readonly kind: 'overlapping-edits' }
  | { readonly kind: 'version-overflow' };

export interface RopeStorageMetrics {
  readonly version: DocumentVersion;
  readonly utf16Length: number;
  readonly utf8ByteLength: number;
  readonly utf32ScalarLength: number;
  readonly lineBreaks: number;
  readonly liveChunks: number;
  readonly treeHeight: number;
  readonly maximumChunkUtf16: number;
  /** Private per-chunk newline ordinal index storage, in bytes. */
  readonly lineBreakIndexBytes: number;
  readonly lineBreakIndexKind: 'packed-u16';
}

interface PackedLineBreakOffsets extends ArrayLike<number> {
  readonly byteLength: number;
  readonly BYTES_PER_ELEMENT: number;
}

interface RopeChunk {
  readonly text: string;
  readonly utf8ByteLength: number;
  readonly utf32ScalarLength: number;
  readonly lineBreakOffsets: PackedLineBreakOffsets;
  readonly printableAscii: boolean;
}

interface RopeNode {
  readonly chunk: RopeChunk;
  readonly priority: number;
  readonly left: RopeNode | null;
  readonly right: RopeNode | null;
  readonly utf16Length: number;
  readonly utf8ByteLength: number;
  readonly utf32ScalarLength: number;
  readonly lineBreakCount: number;
  readonly nodeCount: number;
  readonly height: number;
  readonly maximumChunkUtf16: number;
  readonly lineBreakIndexBytes: number;
  readonly printableAscii: boolean;
}

type RopeRoot = RopeNode | null;

/** Immutable read view over one root. Later edits and compaction cannot change it. */
class RopeSnapshot implements DocumentSnapshot {
  readonly #root: RopeRoot;
  readonly lengthUtf16: number;
  readonly lineCount: number;
  readonly readOnly = false;

  constructor(
    readonly id: DocumentSnapshot['id'],
    readonly version: DocumentVersion,
    readonly revisionId: RevisionId,
    root: RopeRoot,
  ) {
    this.#root = root;
    this.lengthUtf16 = rootLength(this.#root);
    this.lineCount = rootLineBreaks(this.#root) + 1;
    Object.freeze(this);
  }

  slice(start: Utf16Offset, end: Utf16Offset): Result<string, DocumentReadFailure> {
    return readSlice(this.#root, start, end);
  }

  lineIndexAt(offset: Utf16Offset): Result<LineIndex, DocumentReadFailure> {
    const valid = validateBoundary(this.#root, offset);
    return valid.ok
      ? { ok: true, value: asLineIndex(countLineBreaksBefore(this.#root, offset)) }
      : valid;
  }

  lineStartOffset(lineIndex: LineIndex): Result<Utf16Offset, DocumentReadFailure> {
    const line = lineIndex as number;
    const lineCount = rootLineBreaks(this.#root) + 1;
    if (!Number.isSafeInteger(line) || line < 0 || line >= lineCount) {
      return { ok: false, error: { kind: 'invalid-line' } };
    }
    if (line === 0) return { ok: true, value: asUtf16Offset(0) };
    const lineBreak = findLineBreakOffset(this.#root, line - 1);
    if (lineBreak === undefined) return { ok: false, error: { kind: 'invalid-line' } };
    return { ok: true, value: asUtf16Offset(lineBreak + 1) };
  }

  utf8OffsetAt(offset: Utf16Offset): Result<Utf8ByteOffset, DocumentReadFailure> {
    const valid = validateBoundary(this.#root, offset);
    return valid.ok
      ? { ok: true, value: asUtf8ByteOffset(countUtf8Before(this.#root, offset as number)) }
      : valid;
  }

  utf32OffsetAt(offset: Utf16Offset): Result<Utf32Offset, DocumentReadFailure> {
    const valid = validateBoundary(this.#root, offset);
    return valid.ok
      ? { ok: true, value: asUtf32Offset(countScalarsBefore(this.#root, offset as number)) }
      : valid;
  }

  offsetAtUtf8(offset: Utf8ByteOffset): Result<Utf16Offset, DocumentReadFailure> {
    const target = offset as number;
    if (!Number.isSafeInteger(target) || target < 0 || target > rootUtf8Bytes(this.#root)) {
      return { ok: false, error: { kind: 'invalid-range' } };
    }
    const converted = utf16AtEncodedOffset(this.#root, target, 'utf8');
    return converted === undefined
      ? { ok: false, error: { kind: 'invalid-encoded-offset' } }
      : { ok: true, value: asUtf16Offset(converted) };
  }

  offsetAtUtf32(offset: Utf32Offset): Result<Utf16Offset, DocumentReadFailure> {
    const target = offset as number;
    if (!Number.isSafeInteger(target) || target < 0 || target > rootScalars(this.#root)) {
      return { ok: false, error: { kind: 'invalid-range' } };
    }
    const converted = utf16AtEncodedOffset(this.#root, target, 'utf32');
    return converted === undefined
      ? { ok: false, error: { kind: 'invalid-encoded-offset' } }
      : { ok: true, value: asUtf16Offset(converted) };
  }

  isPrintableAsciiRange(start: Utf16Offset, end: Utf16Offset): Result<boolean, DocumentReadFailure> {
    const valid = validateRange(this.#root, start, end);
    if (!valid.ok) return valid;
    return { ok: true, value: rangeIsPrintableAscii(this.#root, start as number, end as number) };
  }

  rangeEqualsText(start: Utf16Offset, end: Utf16Offset, text: string): Result<boolean, DocumentReadFailure> {
    const valid = validateRange(this.#root, start, end);
    if (!valid.ok) return valid;
    if (typeof text !== 'string' || text.length !== (end as number) - (start as number)) {
      return { ok: true, value: false };
    }
    return { ok: true, value: rangeEqualsText(this.#root, start as number, end as number, text) };
  }

  /** Owner-only root access used for exact persistent history restoration. */
  rootForOwner(): RopeRoot { return this.#root; }
}

/**
 * Persistent implicit treap of bounded, surrogate-safe UTF-16 chunks.
 * Snapshots retain immutable roots; replacing the current root never edits old nodes.
 */
export class RopeDocument {
  #root: RopeRoot;
  #currentVersion: DocumentVersion;
  #currentRevisionId: RevisionId;
  #nextRevisionId: number;
  #priorityState: number;
  #snapshotCache: RopeSnapshot | undefined;
  readonly #id: DocumentSnapshot['id'];

  private constructor(
    id: DocumentSnapshot['id'],
    initialText: string,
    seed: number,
  ) {
    this.#id = id;
    this.#root = null;
    this.#currentVersion = documentVersion(1);
    this.#currentRevisionId = revisionId(1);
    this.#nextRevisionId = 2;
    this.#priorityState = (seed >>> 0) || 0x9e3779b9;
    this.#root = buildBalancedRoot(chunkText(initialText));
  }

  static create(id: DocumentSnapshot['id'], initialText: string, seed = 41027): Result<RopeDocument, { readonly kind: 'invalid-text' | 'invalid-seed' }> {
    if (!isNormalizedText(initialText)) return { ok: false, error: { kind: 'invalid-text' } };
    if (!Number.isSafeInteger(seed)) return { ok: false, error: { kind: 'invalid-seed' } };
    return { ok: true, value: new RopeDocument(id, initialText, seed) };
  }

  /** Create normalized text whose explicit fileformat policy classified CR as content. */
  static createWithLiteralCRContent(
    id: DocumentSnapshot['id'],
    initialText: string,
    seed = 41027,
  ): Result<RopeDocument, { readonly kind: 'invalid-text' | 'invalid-seed' }> {
    if (!isLiteralControlText(initialText)) return { ok: false, error: { kind: 'invalid-text' } };
    if (!Number.isSafeInteger(seed)) return { ok: false, error: { kind: 'invalid-seed' } };
    return { ok: true, value: new RopeDocument(id, initialText, seed) };
  }

  /** Build an immutable initial root from bounded normalized chunks without joining them. */
  static createFromChunks(
    id: DocumentSnapshot['id'],
    chunks: Iterable<string>,
    seed = 41027,
    allowLiteralCR = false,
  ): Result<RopeDocument, { readonly kind: 'invalid-text' | 'invalid-seed' }> {
    if (!Number.isSafeInteger(seed)) return { ok: false, error: { kind: 'invalid-seed' } };
    const document = new RopeDocument(id, '', seed);
    document.#root = null;
    for (const chunk of chunks) {
      const appended = document.appendInitialChunk(chunk, allowLiteralCR);
      if (!appended.ok) return appended;
    }
    return { ok: true, value: document };
  }

  /** Append one validated initial chunk without creating a version transition. */
  appendInitialChunk(
    chunk: string,
    allowLiteralCR = false,
  ): Result<void, { readonly kind: 'invalid-text' }> {
    if (typeof chunk !== 'string' || !(allowLiteralCR ? isWellFormedUtf16(chunk) : isNormalizedText(chunk))) {
      return { ok: false, error: { kind: 'invalid-text' } };
    }
    // Bulk-build the pieces of this one call into a balanced subtree, then fold
    // it into the accumulated root with a single merge instead of one per piece.
    const subtree = buildBalancedRoot(chunkText(chunk));
    if (subtree !== null) this.#root = this.merge(this.#root, subtree);
    this.#snapshotCache = undefined;
    return { ok: true, value: undefined };
  }

  snapshot(): DocumentSnapshot {
    const cached = this.#snapshotCache;
    if (cached !== undefined) return cached;
    const snapshot = new RopeSnapshot(this.#id, this.#currentVersion, this.#currentRevisionId, this.#root);
    this.#snapshotCache = snapshot;
    return snapshot;
  }

  slice(start: Utf16Offset, end: Utf16Offset, expectedVersion: DocumentVersion): Result<string, DocumentReadFailure> {
    if (expectedVersion !== this.#currentVersion) return { ok: false, error: { kind: 'stale-version' } };
    return readSlice(this.#root, start, end);
  }

  apply(edit: DocumentEdit, expectedVersion: DocumentVersion): Result<DocumentVersion, DocumentMutationFailure> {
    if (expectedVersion !== this.#currentVersion) return { ok: false, error: { kind: 'stale-version' } };
    if (this.#currentVersion >= Number.MAX_SAFE_INTEGER || this.#nextRevisionId > Number.MAX_SAFE_INTEGER) {
      return { ok: false, error: { kind: 'version-overflow' } };
    }
    const rangeFailure = rangeFailureAt(this.#root, edit.start, edit.end);
    if (rangeFailure !== undefined) return { ok: false, error: rangeFailure };
    if (!isValidEditText(edit)) return { ok: false, error: { kind: 'invalid-text' } };
    this.#root = this.replaceRoot(this.#root, edit.start, edit.end, edit.text);
    this.#currentVersion = documentVersion(this.#currentVersion + 1);
    this.#currentRevisionId = revisionId(this.#nextRevisionId);
    this.#nextRevisionId += 1;
    this.#snapshotCache = undefined;
    return { ok: true, value: this.#currentVersion };
  }

  /** Apply nonoverlapping half-open ranges that all refer to the current base version. */
  applyBatch(edits: readonly DocumentEdit[], expectedVersion: DocumentVersion): Result<DocumentVersion, DocumentMutationFailure> {
    return this.applyBatchInternal(edits, expectedVersion);
  }

  /**
   * Apply a batch to a persistent-root fork and return its predicted snapshot.
   * The live document, version and revision history are unchanged.
   */
  previewBatch(edits: readonly DocumentEdit[], expectedVersion: DocumentVersion): Result<DocumentSnapshot, DocumentMutationFailure> {
    if (expectedVersion !== this.#currentVersion) return { ok: false, error: { kind: 'stale-version' } };
    const fork = new RopeDocument(this.#id, '', this.#priorityState);
    fork.#root = this.#root;
    fork.#currentVersion = this.#currentVersion;
    fork.#currentRevisionId = this.#currentRevisionId;
    fork.#nextRevisionId = this.#nextRevisionId;
    fork.#priorityState = this.#priorityState;
    const applied = fork.applyBatch(edits, expectedVersion);
    return applied.ok ? { ok: true, value: fork.snapshot() } : applied;
  }

  /** Apply a history transition while restoring the identity of its target content node. */
  applyBatchRestoringRevision(
    edits: readonly DocumentEdit[],
    expectedVersion: DocumentVersion,
    targetRevisionId: RevisionId,
  ): Result<DocumentVersion, DocumentMutationFailure> {
    const target = targetRevisionId as number;
    if (!Number.isSafeInteger(target) || target < 1 || edits.length === 0) {
      return { ok: false, error: { kind: 'invalid-text' } };
    }
    return this.applyBatchInternal(edits, expectedVersion, targetRevisionId);
  }

  /** Restore a root already retained by an immutable snapshot without flattening its text. */
  restoreSnapshot(
    snapshot: DocumentSnapshot,
    expectedVersion: DocumentVersion,
    targetRevisionId: RevisionId,
  ): Result<DocumentVersion, DocumentMutationFailure> {
    if (expectedVersion !== this.#currentVersion) return { ok: false, error: { kind: 'stale-version' } };
    const target = targetRevisionId as number;
    if (snapshot.id !== this.#id || snapshot.readOnly || !Number.isSafeInteger(target) || target < 1
      || this.#currentVersion >= Number.MAX_SAFE_INTEGER) {
      return { ok: false, error: { kind: 'invalid-text' } };
    }
    if (!(snapshot instanceof RopeSnapshot)) return { ok: false, error: { kind: 'invalid-text' } };
    this.#root = snapshot.rootForOwner();
    this.#currentVersion = documentVersion(this.#currentVersion + 1);
    this.#currentRevisionId = targetRevisionId;
    this.#snapshotCache = undefined;
    return { ok: true, value: this.#currentVersion };
  }

  /** Set a deserialized history identity on an untouched initial root. */
  restoreInitialRevisionIdentity(currentRevisionId: RevisionId, nextRevisionId: number): boolean {
    const current = currentRevisionId as number;
    if (this.#currentVersion !== 1 || !Number.isSafeInteger(current) || current < 1
      || !Number.isSafeInteger(nextRevisionId) || nextRevisionId <= current || nextRevisionId < 2) return false;
    this.#currentRevisionId = currentRevisionId;
    this.#nextRevisionId = nextRevisionId;
    this.#snapshotCache = undefined;
    return true;
  }

  private applyBatchInternal(
    edits: readonly DocumentEdit[],
    expectedVersion: DocumentVersion,
    restoredRevisionId?: RevisionId,
  ): Result<DocumentVersion, DocumentMutationFailure> {
    if (expectedVersion !== this.#currentVersion) return { ok: false, error: { kind: 'stale-version' } };
    if (edits.length === 0) return { ok: true, value: this.#currentVersion };
    if (this.#currentVersion >= Number.MAX_SAFE_INTEGER
      || (restoredRevisionId === undefined && this.#nextRevisionId > Number.MAX_SAFE_INTEGER)) {
      return { ok: false, error: { kind: 'version-overflow' } };
    }

    let ordered: readonly DocumentEdit[] = edits;
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (previous === undefined || current === undefined) continue;
      if (compareEdits(previous, current) > 0) {
        ordered = [...edits].sort(compareEdits);
        break;
      }
    }
    let previous: DocumentEdit | undefined;
    for (const edit of ordered) {
      const rangeFailure = rangeFailureAt(this.#root, edit.start, edit.end);
      if (rangeFailure !== undefined) return { ok: false, error: rangeFailure };
      if (!isValidEditText(edit)) return { ok: false, error: { kind: 'invalid-text' } };
      if (previous !== undefined && (edit.start < previous.end || edit.start === previous.start)) {
        return { ok: false, error: { kind: 'overlapping-edits' } };
      }
      previous = edit;
    }

    let candidate = this.#root;
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const edit = ordered[index];
      if (edit === undefined) return { ok: false, error: { kind: 'overlapping-edits' } };
      candidate = this.replaceRoot(candidate, edit.start, edit.end, edit.text);
    }
    this.#root = candidate;
    this.#currentVersion = documentVersion(this.#currentVersion + 1);
    if (restoredRevisionId === undefined) {
      this.#currentRevisionId = revisionId(this.#nextRevisionId);
      this.#nextRevisionId += 1;
    } else {
      this.#currentRevisionId = restoredRevisionId;
    }
    this.#snapshotCache = undefined;
    return { ok: true, value: this.#currentVersion };
  }

  /** Repack current text into full leaves; older captured snapshots keep their roots. */
  compact(): void {
    const text = renderRoot(this.#root);
    this.#root = buildBalancedRoot(chunkText(text));
    this.#snapshotCache = undefined;
  }

  metrics(): RopeStorageMetrics {
    return {
      version: this.#currentVersion,
      utf16Length: rootLength(this.#root),
      utf8ByteLength: rootUtf8Bytes(this.#root),
      utf32ScalarLength: rootScalars(this.#root),
      lineBreaks: rootLineBreaks(this.#root),
      liveChunks: rootNodeCount(this.#root),
      treeHeight: rootHeight(this.#root),
      maximumChunkUtf16: rootMaximumChunkLength(this.#root),
      lineBreakIndexBytes: rootLineBreakIndexBytes(this.#root),
      lineBreakIndexKind: 'packed-u16',
    };
  }

  /** Invariant report used by deterministic document tests and diagnostics. */
  validateInvariants(): readonly string[] {
    const errors: string[] = [];
    const chunks: RopeChunk[] = [];
    const visit = (node: RopeRoot): void => {
      if (node === null) return;
      visit(node.left);
      chunks.push(node.chunk);
      visit(node.right);
      if (node.left !== null && node.priority > node.left.priority) errors.push(`treap-left-priority:${node.priority}>${node.left.priority}`);
      if (node.right !== null && node.priority > node.right.priority) errors.push(`treap-right-priority:${node.priority}>${node.right.priority}`);
      const expectedLength = rootLength(node.left) + node.chunk.text.length + rootLength(node.right);
      const expectedUtf8Length = rootUtf8Bytes(node.left) + node.chunk.utf8ByteLength + rootUtf8Bytes(node.right);
      const expectedUtf32Length = rootScalars(node.left) + node.chunk.utf32ScalarLength + rootScalars(node.right);
      const expectedBreaks = rootLineBreaks(node.left) + node.chunk.lineBreakOffsets.length + rootLineBreaks(node.right);
      const expectedCount = rootNodeCount(node.left) + 1 + rootNodeCount(node.right);
      const expectedHeight = Math.max(rootHeight(node.left), rootHeight(node.right)) + 1;
      const expectedMaximum = Math.max(node.chunk.text.length, rootMaximumChunkLength(node.left), rootMaximumChunkLength(node.right));
      const expectedLineBreakIndexBytes = rootLineBreakIndexBytes(node.left)
        + node.chunk.lineBreakOffsets.byteLength + rootLineBreakIndexBytes(node.right);
      if (node.utf16Length !== expectedLength) errors.push('utf16-aggregate');
      if (node.utf8ByteLength !== expectedUtf8Length) errors.push('utf8-aggregate');
      if (node.utf32ScalarLength !== expectedUtf32Length) errors.push('utf32-aggregate');
      if (node.lineBreakCount !== expectedBreaks) errors.push('linebreak-aggregate');
      if (node.nodeCount !== expectedCount) errors.push('chunk-count-aggregate');
      if (node.height !== expectedHeight) errors.push('height-aggregate');
      if (node.maximumChunkUtf16 !== expectedMaximum) errors.push('maximum-chunk-aggregate');
      if (node.lineBreakIndexBytes !== expectedLineBreakIndexBytes) errors.push('linebreak-index-bytes-aggregate');
      const expectedPrintableAscii = (node.left?.printableAscii ?? true)
        && node.chunk.printableAscii
        && (node.right?.printableAscii ?? true);
      if (node.printableAscii !== expectedPrintableAscii) errors.push('printable-ascii-aggregate');
      if (node.chunk.text.length === 0 || node.chunk.text.length > MAX_CHUNK_UTF16) errors.push('chunk-size');
      if (!isWellFormedUtf16(node.chunk.text)) errors.push('chunk-surrogate-boundary');
      if (node.chunk.text.includes('\r')) errors.push('unnormalized-carriage-return');
      if (node.chunk.printableAscii !== isPrintableAscii(node.chunk.text)) errors.push('chunk-ascii-index');
      const expectedChunkMetrics = encodedMetrics(node.chunk.text);
      if (node.chunk.utf8ByteLength !== expectedChunkMetrics.utf8ByteLength) errors.push('chunk-utf8-index');
      if (node.chunk.utf32ScalarLength !== expectedChunkMetrics.utf32ScalarLength) errors.push('chunk-utf32-index');
      if (!sameOffsets(node.chunk.lineBreakOffsets, lineBreakOffsets(node.chunk.text))) errors.push('chunk-line-index');
    };
    visit(this.#root);
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1];
      const current = chunks[index];
      if (previous !== undefined && current !== undefined && previous.text.length + current.text.length <= MAX_CHUNK_UTF16) {
        errors.push('uncoalesced-adjacent-chunks');
      }
    }
    const nodeCount = rootNodeCount(this.#root);
    const heightLimit = Math.max(12, 4 * Math.ceil(Math.log2(nodeCount + 1)));
    if (rootHeight(this.#root) > heightLimit) errors.push('treap-height-bound');
    return errors;
  }

  private replaceRoot(root: RopeRoot, start: number, end: number, text: string): RopeRoot {
    const [before, rest] = this.split(root, start);
    const [, after] = this.split(rest, end - start);
    let inserted: RopeRoot = null;
    for (const chunk of chunkText(text)) inserted = this.merge(inserted, this.createNode(chunk));
    return this.concat(this.concat(before, inserted), after);
  }

  private split(root: RopeRoot, offset: number): readonly [RopeRoot, RopeRoot] {
    if (root === null) return [null, null];
    const leftLength = rootLength(root.left);
    const chunkEnd = leftLength + root.chunk.text.length;
    if (offset < leftLength) {
      const [before, remaining] = this.split(root.left, offset);
      return [before, this.cloneNode(root, remaining, root.right)];
    }
    if (offset > chunkEnd) {
      const [remaining, after] = this.split(root.right, offset - chunkEnd);
      return [this.cloneNode(root, root.left, remaining), after];
    }
    if (offset === leftLength) return [root.left, this.cloneNode(root, null, root.right)];
    if (offset === chunkEnd) return [this.cloneNode(root, root.left, null), root.right];
    const [leftChunk, rightChunk] = splitChunk(root.chunk, offset - leftLength);
    return [
      this.merge(root.left, this.createNode(leftChunk, root.priority)),
      this.merge(this.createNode(rightChunk, root.priority), root.right),
    ];
  }

  private concat(left: RopeRoot, right: RopeRoot): RopeRoot {
    if (left === null || right === null) return left ?? right;
    const last = rightmost(left);
    const first = leftmost(right);
    if (last === undefined || first === undefined || last.chunk.text.length + first.chunk.text.length > MAX_CHUNK_UTF16) {
      return this.merge(left, right);
    }
    let [leftRest, leftNode] = this.popRight(left);
    let [rightNode, rightRest] = this.popLeft(right);
    let combinedText = leftNode.chunk.text + rightNode.chunk.text;
    let grew = true;
    while (grew) {
      grew = false;
      const previous = leftRest === null ? undefined : rightmost(leftRest);
      if (leftRest !== null && previous !== undefined && previous.chunk.text.length + combinedText.length <= MAX_CHUNK_UTF16) {
        const popped = this.popRight(leftRest);
        leftRest = popped[0];
        leftNode = popped[1];
        combinedText = leftNode.chunk.text + combinedText;
        grew = true;
      }
      const next = rightRest === null ? undefined : leftmost(rightRest);
      if (rightRest !== null && next !== undefined && combinedText.length + next.chunk.text.length <= MAX_CHUNK_UTF16) {
        const popped = this.popLeft(rightRest);
        rightNode = popped[0];
        rightRest = popped[1];
        combinedText += rightNode.chunk.text;
        grew = true;
      }
    }
    return this.merge(this.merge(leftRest, this.createNode(makeChunk(combinedText))), rightRest);
  }

  private popRight(root: RopeNode): readonly [RopeRoot, RopeNode] {
    if (root.right === null) return [root.left, this.cloneNode(root, null, null)];
    const [remaining, node] = this.popRight(root.right);
    return [this.cloneNode(root, root.left, remaining), node];
  }

  private popLeft(root: RopeNode): readonly [RopeNode, RopeRoot] {
    if (root.left === null) return [this.cloneNode(root, null, null), root.right];
    const [node, remaining] = this.popLeft(root.left);
    return [node, this.cloneNode(root, remaining, root.right)];
  }

  private merge(left: RopeRoot, right: RopeRoot): RopeRoot {
    if (left === null) return right;
    if (right === null) return left;
    if (left.priority < right.priority) return this.cloneNode(left, left.left, this.merge(left.right, right));
    return this.cloneNode(right, this.merge(left, right.left), right.right);
  }

  private createNode(chunk: RopeChunk, priority = this.nextPriority()): RopeNode {
    return makeNode(chunk, priority, null, null);
  }

  private cloneNode(node: RopeNode, left: RopeRoot, right: RopeRoot): RopeNode {
    return makeNode(node.chunk, node.priority, left, right);
  }

  private nextPriority(): number {
    this.#priorityState ^= this.#priorityState << 13;
    this.#priorityState ^= this.#priorityState >>> 17;
    this.#priorityState ^= this.#priorityState << 5;
    return this.#priorityState >>> 0;
  }
}

function makeNode(chunk: RopeChunk, priority: number, left: RopeRoot, right: RopeRoot): RopeNode {
  return Object.freeze({
    chunk,
    priority,
    left,
    right,
    utf16Length: rootLength(left) + chunk.text.length + rootLength(right),
    utf8ByteLength: rootUtf8Bytes(left) + chunk.utf8ByteLength + rootUtf8Bytes(right),
    utf32ScalarLength: rootScalars(left) + chunk.utf32ScalarLength + rootScalars(right),
    lineBreakCount: rootLineBreaks(left) + chunk.lineBreakOffsets.length + rootLineBreaks(right),
    nodeCount: rootNodeCount(left) + 1 + rootNodeCount(right),
    height: Math.max(rootHeight(left), rootHeight(right)) + 1,
    maximumChunkUtf16: Math.max(chunk.text.length, rootMaximumChunkLength(left), rootMaximumChunkLength(right)),
    lineBreakIndexBytes: rootLineBreakIndexBytes(left) + chunk.lineBreakOffsets.byteLength + rootLineBreakIndexBytes(right),
    printableAscii: (left?.printableAscii ?? true) && chunk.printableAscii && (right?.printableAscii ?? true),
  });
}

function makeChunk(text: string): RopeChunk {
  // Typed-array elements cannot be frozen on the pinned JSC runtime. The index
  // remains private to immutable rope nodes; only the containing chunk is frozen.
  return Object.freeze({ text, ...chunkMetrics(text) });
}

/**
 * Build a balanced treap from chunks already in document order, in O(n)
 * instead of merging one chunk at a time (O(chunks · log chunks)). Priorities
 * are assigned in preorder so every node's priority is strictly less than any
 * priority used within its own subtree, satisfying the treap's min-heap
 * invariant while keeping the tree height ~log2(n) regardless of randomness.
 */
function buildBalancedRoot(chunks: readonly RopeChunk[]): RopeRoot {
  if (chunks.length === 0) return null;
  let nextPriority = 0;
  const build = (lo: number, hi: number): RopeNode => {
    const mid = (lo + hi) >>> 1;
    const chunk = chunks[mid];
    if (chunk === undefined) throw new Error('rope-bulk-build-index');
    const priority = nextPriority;
    nextPriority += 1;
    const left = lo <= mid - 1 ? build(lo, mid - 1) : null;
    const right = mid + 1 <= hi ? build(mid + 1, hi) : null;
    return makeNode(chunk, priority, left, right);
  };
  return build(0, chunks.length - 1);
}

function compareEdits(left: DocumentEdit, right: DocumentEdit): number {
  return left.start - right.start || left.end - right.end;
}

function chunkText(text: string): RopeChunk[] {
  const chunks: RopeChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + MAX_CHUNK_UTF16);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end -= 1;
    if (end <= start) throw new Error(`rope-chunker-no-progress:${start}`);
    chunks.push(makeChunk(text.slice(start, end)));
    start = end;
  }
  return chunks;
}

function splitChunk(chunk: RopeChunk, offset: number): readonly [RopeChunk, RopeChunk] {
  return [makeChunk(chunk.text.slice(0, offset)), makeChunk(chunk.text.slice(offset))];
}

function renderRoot(root: RopeRoot): string {
  if (root === null) return '';
  const chunks: string[] = [];
  const pending: RopeNode[] = [];
  let current: RopeRoot = root;
  while (current !== null || pending.length > 0) {
    while (current !== null) {
      pending.push(current);
      current = current.left;
    }
    const node = pending.pop();
    if (node === undefined) break;
    chunks.push(node.chunk.text);
    current = node.right;
  }
  return chunks.join('');
}

function readSlice(root: RopeRoot, start: number, end: number): Result<string, DocumentReadFailure> {
  const valid = validateRange(root, start, end);
  if (!valid.ok) return valid;
  if (start === end) return { ok: true, value: '' };
  const chunks: string[] = [];
  appendRange(root, start, end, chunks);
  return { ok: true, value: chunks.join('') };
}

function appendRange(root: RopeRoot, start: number, end: number, output: string[]): void {
  if (root === null || start === end) return;
  const leftLength = rootLength(root.left);
  const chunkStart = leftLength;
  const chunkEnd = chunkStart + root.chunk.text.length;
  if (start < leftLength) appendRange(root.left, start, Math.min(end, leftLength), output);
  const localStart = Math.max(start, chunkStart) - chunkStart;
  const localEnd = Math.min(end, chunkEnd) - chunkStart;
  if (localStart < localEnd) output.push(root.chunk.text.slice(localStart, localEnd));
  if (end > chunkEnd) appendRange(root.right, Math.max(0, start - chunkEnd), end - chunkEnd, output);
}

function validateRange(root: RopeRoot, start: number, end: number): Result<void, DocumentReadFailure> {
  const failure = rangeFailureAt(root, start, end);
  return failure === undefined ? { ok: true, value: undefined } : { ok: false, error: failure };
}

function rangeFailureAt(root: RopeRoot, start: number, end: number): DocumentReadFailure | undefined {
  const length = rootLength(root);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > length) {
    return { kind: 'invalid-range' };
  }
  const startFailure = boundaryFailureAt(root, start);
  if (startFailure !== undefined) return startFailure;
  return boundaryFailureAt(root, end);
}

function validateBoundary(root: RopeRoot, offset: number): Result<void, DocumentReadFailure> {
  const failure = boundaryFailureAt(root, offset);
  return failure === undefined ? { ok: true, value: undefined } : { ok: false, error: failure };
}

function boundaryFailureAt(root: RopeRoot, offset: number): DocumentReadFailure | undefined {
  const length = rootLength(root);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > length) return { kind: 'invalid-range' };
  if (offset > 0 && offset < length && isHighSurrogate(codeUnitAt(root, offset - 1)) && isLowSurrogate(codeUnitAt(root, offset))) {
    return { kind: 'surrogate-split' };
  }
  return undefined;
}

function codeUnitAt(root: RopeRoot, offset: number): number {
  if (root === null) throw new Error('code-unit-read-empty-document');
  const leftLength = rootLength(root.left);
  if (offset < leftLength) return codeUnitAt(root.left, offset);
  const chunkOffset = offset - leftLength;
  if (chunkOffset < root.chunk.text.length) return root.chunk.text.charCodeAt(chunkOffset);
  return codeUnitAt(root.right, chunkOffset - root.chunk.text.length);
}

function countLineBreaksBefore(root: RopeRoot, offset: number): number {
  if (root === null || offset <= 0) return 0;
  const leftLength = rootLength(root.left);
  if (offset <= leftLength) return countLineBreaksBefore(root.left, offset);
  const chunkOffset = offset - leftLength;
  const beforeChunk = rootLineBreaks(root.left);
  if (chunkOffset <= root.chunk.text.length) return beforeChunk + lowerBound(root.chunk.lineBreakOffsets, chunkOffset);
  return beforeChunk + root.chunk.lineBreakOffsets.length + countLineBreaksBefore(root.right, chunkOffset - root.chunk.text.length);
}

function rangeIsPrintableAscii(root: RopeRoot, start: number, end: number): boolean {
  const visit = (node: RopeRoot, baseOffset: number): boolean => {
    if (node === null) return true;
    const nodeEnd = baseOffset + rootLength(node);
    if (end <= baseOffset || start >= nodeEnd) return true;
    if (start <= baseOffset && end >= nodeEnd) return node.printableAscii;
    const leftLength = rootLength(node.left);
    const chunkStart = baseOffset + leftLength;
    const chunkEnd = chunkStart + node.chunk.text.length;
    if (!visit(node.left, baseOffset)) return false;
    const localStart = Math.max(start, chunkStart) - chunkStart;
    const localEnd = Math.min(end, chunkEnd) - chunkStart;
    for (let index = localStart; index < localEnd; index += 1) {
      const unit = node.chunk.text.charCodeAt(index);
      if (unit < 0x20 || unit > 0x7e) return false;
    }
    return visit(node.right, chunkEnd);
  };
  return start >= end || visit(root, 0);
}

function rangeEqualsText(root: RopeRoot, start: number, end: number, text: string): boolean {
  const visit = (node: RopeRoot, baseOffset: number): boolean => {
    if (node === null) return true;
    const nodeEnd = baseOffset + rootLength(node);
    if (end <= baseOffset || start >= nodeEnd) return true;
    const leftLength = rootLength(node.left);
    const chunkStart = baseOffset + leftLength;
    const chunkEnd = chunkStart + node.chunk.text.length;
    if (!visit(node.left, baseOffset)) return false;
    const localStart = Math.max(start, chunkStart) - chunkStart;
    const localEnd = Math.min(end, chunkEnd) - chunkStart;
    for (let index = localStart; index < localEnd; index += 1) {
      const expectedOffset = chunkStart + index - start;
      if (node.chunk.text.charCodeAt(index) !== text.charCodeAt(expectedOffset)) return false;
    }
    return visit(node.right, chunkEnd);
  };
  return start >= end ? text.length === 0 : visit(root, 0);
}

function countUtf8Before(root: RopeRoot, offset: number): number {
  if (root === null || offset <= 0) return 0;
  const leftLength = rootLength(root.left);
  if (offset <= leftLength) return countUtf8Before(root.left, offset);
  const chunkOffset = offset - leftLength;
  const beforeChunk = rootUtf8Bytes(root.left);
  if (chunkOffset <= root.chunk.text.length) return beforeChunk + utf8BytesInPrefix(root.chunk.text, chunkOffset);
  return beforeChunk + root.chunk.utf8ByteLength
    + countUtf8Before(root.right, chunkOffset - root.chunk.text.length);
}

function countScalarsBefore(root: RopeRoot, offset: number): number {
  if (root === null || offset <= 0) return 0;
  const leftLength = rootLength(root.left);
  if (offset <= leftLength) return countScalarsBefore(root.left, offset);
  const chunkOffset = offset - leftLength;
  const beforeChunk = rootScalars(root.left);
  if (chunkOffset <= root.chunk.text.length) return beforeChunk + scalarsInPrefix(root.chunk.text, chunkOffset);
  return beforeChunk + root.chunk.utf32ScalarLength
    + countScalarsBefore(root.right, chunkOffset - root.chunk.text.length);
}

function utf16AtEncodedOffset(root: RopeRoot, target: number, encoding: 'utf8' | 'utf32', baseUtf16 = 0): number | undefined {
  if (root === null) return target === 0 ? baseUtf16 : undefined;
  const leftLength = rootLength(root.left);
  const leftEncodedLength = encoding === 'utf8' ? rootUtf8Bytes(root.left) : rootScalars(root.left);
  if (target < leftEncodedLength) return utf16AtEncodedOffset(root.left, target, encoding, baseUtf16);
  const withinChunk = target - leftEncodedLength;
  const chunkEncodedLength = encoding === 'utf8' ? root.chunk.utf8ByteLength : root.chunk.utf32ScalarLength;
  if (withinChunk <= chunkEncodedLength) {
    const localOffset = utf16InChunkAtEncodedOffset(root.chunk.text, withinChunk, encoding);
    return localOffset === undefined ? undefined : baseUtf16 + leftLength + localOffset;
  }
  return utf16AtEncodedOffset(
    root.right,
    withinChunk - chunkEncodedLength,
    encoding,
    baseUtf16 + leftLength + root.chunk.text.length,
  );
}

function utf16InChunkAtEncodedOffset(text: string, target: number, encoding: 'utf8' | 'utf32'): number | undefined {
  let utf16 = 0;
  let encoded = 0;
  while (encoded < target && utf16 < text.length) {
    const width16 = scalarUtf16WidthAt(text, utf16);
    const nextEncoded = encoded + (encoding === 'utf8' ? scalarUtf8WidthAt(text, utf16) : 1);
    if (nextEncoded > target) return undefined;
    encoded = nextEncoded;
    utf16 += width16;
  }
  return encoded === target ? utf16 : undefined;
}

function utf8BytesInPrefix(text: string, end: number): number {
  let utf8 = 0;
  for (let offset = 0; offset < end;) {
    const width16 = scalarUtf16WidthAt(text, offset);
    utf8 += scalarUtf8WidthAt(text, offset);
    offset += width16;
  }
  return utf8;
}

function scalarsInPrefix(text: string, end: number): number {
  let scalars = 0;
  for (let offset = 0; offset < end; scalars += 1) offset += scalarUtf16WidthAt(text, offset);
  return scalars;
}

function encodedMetrics(text: string): {
  readonly utf8ByteLength: number;
  readonly utf32ScalarLength: number;
  readonly printableAscii: boolean;
} {
  // @xi-perf H0 DOC-COORDINATES -- Chunk metrics run for every opened scalar; numeric widths avoid per-scalar temporary objects.
  let utf8ByteLength = 0;
  let utf32ScalarLength = 0;
  let printableAscii = true;
  for (let offset = 0; offset < text.length; utf32ScalarLength += 1) {
    const first = text.charCodeAt(offset);
    if (first < 0x20 || first > 0x7e) printableAscii = false;
    utf8ByteLength += scalarUtf8WidthAt(text, offset);
    offset += scalarUtf16WidthAt(text, offset);
  }
  return { utf8ByteLength, utf32ScalarLength, printableAscii };
}

/**
 * Chunk construction on the open path (`makeChunk`) needs encodedMetrics and
 * lineBreakOffsets together; folding them into one forward walk avoids three
 * passes (encodedMetrics, then lineBreakOffsets' count pass and fill pass)
 * per bounded chunk. `encodedMetrics`/`lineBreakOffsets` stay separate for
 * invariant-checking call sites that only need one of the two.
 */
function chunkMetrics(text: string): {
  readonly utf8ByteLength: number;
  readonly utf32ScalarLength: number;
  readonly printableAscii: boolean;
  readonly lineBreakOffsets: PackedLineBreakOffsets;
} {
  let utf8ByteLength = 0;
  let utf32ScalarLength = 0;
  let printableAscii = true;
  const breaks: number[] = [];
  for (let offset = 0; offset < text.length; utf32ScalarLength += 1) {
    const first = text.charCodeAt(offset);
    if (first < 0x20 || first > 0x7e) printableAscii = false;
    if (first === 10) breaks.push(offset);
    utf8ByteLength += scalarUtf8WidthAt(text, offset);
    offset += scalarUtf16WidthAt(text, offset);
  }
  const offsets = new Uint16Array(breaks.length);
  for (let index = 0; index < breaks.length; index += 1) {
    const value = breaks[index];
    if (value === undefined || value > 0xffff) throw new Error('linebreak-index-overflow');
    offsets[index] = value;
  }
  return { utf8ByteLength, utf32ScalarLength, printableAscii, lineBreakOffsets: offsets };
}

function scalarUtf16WidthAt(text: string, offset: number): 1 | 2 {
  const first = text.charCodeAt(offset);
  return isHighSurrogate(first) && isLowSurrogate(text.charCodeAt(offset + 1)) ? 2 : 1;
}

function scalarUtf8WidthAt(text: string, offset: number): 1 | 2 | 3 | 4 {
  const first = text.charCodeAt(offset);
  if (isHighSurrogate(first) && isLowSurrogate(text.charCodeAt(offset + 1))) return 4;
  return first <= 0x7f ? 1 : first <= 0x7ff ? 2 : 3;
}

function findLineBreakOffset(root: RopeRoot, targetIndex: number, baseOffset = 0): number | undefined {
  if (root === null || targetIndex < 0 || targetIndex >= rootLineBreaks(root)) return undefined;
  const leftBreaks = rootLineBreaks(root.left);
  const leftLength = rootLength(root.left);
  if (targetIndex < leftBreaks) return findLineBreakOffset(root.left, targetIndex, baseOffset);
  const chunkIndex = targetIndex - leftBreaks;
  if (chunkIndex < root.chunk.lineBreakOffsets.length) {
    const offset = root.chunk.lineBreakOffsets[chunkIndex];
    return offset === undefined ? undefined : baseOffset + leftLength + offset;
  }
  return findLineBreakOffset(
    root.right,
    chunkIndex - root.chunk.lineBreakOffsets.length,
    baseOffset + leftLength + root.chunk.text.length,
  );
}

function lineBreakOffsets(text: string): PackedLineBreakOffsets {
  let count = 0;
  for (let offset = text.indexOf('\n'); offset >= 0; offset = text.indexOf('\n', offset + 1)) count += 1;
  const offsets = new Uint16Array(count);
  let index = 0;
  for (let offset = text.indexOf('\n'); offset >= 0; offset = text.indexOf('\n', offset + 1)) {
    if (offset > 0xffff || index >= offsets.length) throw new Error('linebreak-index-overflow');
    offsets[index] = offset;
    index += 1;
  }
  return offsets;
}

function lowerBound(values: ArrayLike<number>, target: number): number {
  // @xi-perf H0 DOC-COORDINATES -- Numeric rank lookup over the private chunk index.
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const value = values[middle];
    if (value !== undefined && value < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function rightmost(root: RopeNode): RopeNode {
  return root.right === null ? root : rightmost(root.right);
}

function leftmost(root: RopeNode): RopeNode {
  return root.left === null ? root : leftmost(root.left);
}

function rootLength(root: RopeRoot): number { return root?.utf16Length ?? 0; }
function rootUtf8Bytes(root: RopeRoot): number { return root?.utf8ByteLength ?? 0; }
function rootScalars(root: RopeRoot): number { return root?.utf32ScalarLength ?? 0; }
function rootLineBreaks(root: RopeRoot): number { return root?.lineBreakCount ?? 0; }
function rootNodeCount(root: RopeRoot): number { return root?.nodeCount ?? 0; }
function rootHeight(root: RopeRoot): number { return root?.height ?? 0; }
function rootMaximumChunkLength(root: RopeRoot): number { return root?.maximumChunkUtf16 ?? 0; }
function rootLineBreakIndexBytes(root: RopeRoot): number { return root?.lineBreakIndexBytes ?? 0; }

function isWellFormedUtf16(text: string): boolean {
  // @xi-perf H0 DOC-COORDINATES -- Scalar boundary validation must avoid per-unit temporaries.
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (isHighSurrogate(unit)) {
      const next = text.charCodeAt(index + 1);
      if (!isLowSurrogate(next)) return false;
      index += 1;
    } else if (isLowSurrogate(unit)) {
      return false;
    }
  }
  return true;
}

function isPrintableAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || unit > 0x7e) return false;
  }
  return true;
}

function isNormalizedText(text: string): boolean {
  return !text.includes('\r') && isWellFormedUtf16(text);
}

function isLiteralControlText(text: string): boolean {
  return text.includes('\r') && isWellFormedUtf16(text);
}

function isValidEditText(edit: DocumentEdit): boolean {
  if (edit.textIntent === undefined) return isNormalizedText(edit.text);
  return edit.textIntent === 'literal-control' && isLiteralControlText(edit.text);
}

function isHighSurrogate(unit: number): boolean { return unit >= 0xd800 && unit <= 0xdbff; }
function isLowSurrogate(unit: number): boolean { return unit >= 0xdc00 && unit <= 0xdfff; }
function asUtf16Offset(value: number): Utf16Offset { return value as Utf16Offset; }
function asUtf8ByteOffset(value: number): Utf8ByteOffset { return value as Utf8ByteOffset; }
function asUtf32Offset(value: number): Utf32Offset { return value as Utf32Offset; }
function asLineIndex(value: number): LineIndex { return value as LineIndex; }

function documentVersion(value: number): DocumentVersion {
  const result = asDocumentVersion(value);
  if (!result.ok) throw new Error('invalid-document-version');
  return result.value;
}

function revisionId(value: number): RevisionId {
  const result = asRevisionId(value);
  if (!result.ok) throw new Error('invalid-revision-id');
  return result.value;
}

function sameOffsets(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
