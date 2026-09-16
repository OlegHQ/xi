import type {
  DocumentId,
  DocumentVersion,
  LineIndex,
  RevisionId,
  Result,
  Utf16Offset,
  Utf32Offset,
  Utf8ByteOffset,
} from '../../primitives/src/index.ts';

export type DocumentReadFailure =
  | { readonly kind: 'stale-version' }
  | { readonly kind: 'invalid-range' }
  | { readonly kind: 'surrogate-split' }
  | { readonly kind: 'invalid-encoded-offset' }
  | { readonly kind: 'invalid-line' };

export interface DocumentSnapshot {
  readonly id: DocumentId;
  /** All reads and coordinates on this immutable root belong to this exact version. */
  readonly version: DocumentVersion;
  /** Content/history identity; later undo may restore this while document version keeps increasing. */
  readonly revisionId: RevisionId;
  /** Number of zero-based UTF-16 code units; valid edit/read boundaries cannot split surrogate pairs. */
  readonly lengthUtf16: number;
  readonly lineCount: number;
  readonly readOnly: boolean;
  /** Slice offsets are zero-based UTF-16 code units in this snapshot's version. */
  slice(start: Utf16Offset, end: Utf16Offset): Result<string, DocumentReadFailure>;
  /** The returned zero-based line index is derived from a safe UTF-16 boundary. */
  lineIndexAt(offset: Utf16Offset): Result<LineIndex, DocumentReadFailure>;
  /** Returns the zero-based UTF-16 code-unit offset of the line start. */
  lineStartOffset(lineIndex: LineIndex): Result<Utf16Offset, DocumentReadFailure>;
  /** UTF-8 byte count from document start to a safe UTF-16 boundary in this version. */
  utf8OffsetAt(offset: Utf16Offset): Result<Utf8ByteOffset, DocumentReadFailure>;
  /** Unicode scalar count from document start to a safe UTF-16 boundary in this version. */
  utf32OffsetAt(offset: Utf16Offset): Result<Utf32Offset, DocumentReadFailure>;
  /** Maps an absolute UTF-8 byte offset in this version; mid-scalar offsets fail. */
  offsetAtUtf8(offset: Utf8ByteOffset): Result<Utf16Offset, DocumentReadFailure>;
  /** Maps an absolute Unicode scalar offset in this version. */
  offsetAtUtf32(offset: Utf32Offset): Result<Utf16Offset, DocumentReadFailure>;
  /** Optional bounded classification for printable single-cell ASCII ranges. */
  readonly isPrintableAsciiRange?: (
    start: Utf16Offset,
    end: Utf16Offset,
  ) => Result<boolean, DocumentReadFailure>;
  /** Optional allocation-free comparison for large replacement validation. */
  readonly rangeEqualsText?: (
    start: Utf16Offset,
    end: Utf16Offset,
    text: string,
  ) => Result<boolean, DocumentReadFailure>;
}

/** Read-only boundary. Results are valid only for the supplied document version. */
export interface DocumentReadPort {
  snapshot(): DocumentSnapshot;
  slice(
    start: Utf16Offset,
    end: Utf16Offset,
    expectedVersion: DocumentVersion,
  ): Result<string, DocumentReadFailure>;
}

export interface VersionedDocumentChange {
  readonly documentId: DocumentId;
  /** Source document version, measured in committed text transitions. */
  readonly before: DocumentVersion;
  /** Destination document version, greater than `before`. */
  readonly after: DocumentVersion;
  readonly beforeRevisionId: RevisionId;
  readonly afterRevisionId: RevisionId;
  readonly changedRanges: readonly {
    /** UTF-16 range start in `before`. */
    readonly start: Utf16Offset;
    /** Exclusive UTF-16 range end in `before`. */
    readonly oldEnd: Utf16Offset;
    /** Exclusive UTF-16 range end in `after`. */
    readonly newEnd: Utf16Offset;
  }[];
}

export type {
  CellColumn,
  DocumentId,
  DocumentVersion,
  LineIndex,
  RevisionId,
  Result,
  SerializedSelectionValue,
  Utf16Column,
  Utf16Offset,
  Utf32Offset,
  Utf32Column,
  Utf8ByteColumn,
  Utf8ByteOffset,
  UndoGroupId,
  ViewId,
} from '../../primitives/src/index.ts';
