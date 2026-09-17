import type {
  CellColumn,
  DocumentId,
  DocumentSnapshot,
  DocumentVersion,
  LineIndex,
  Utf16Offset,
  ViewId,
} from '../../document/src/index';
import type {
  SelectionGeneration,
  SelectionId,
  SelectionEndpoint,
  SelectionMember,
  SelectionSetSnapshot,
} from '../../selections/src/index';

export type LayoutFrameId = number & { readonly __xiBrand: 'LayoutFrameId' };
export type LayoutGeneration = number & { readonly __xiBrand: 'LayoutGeneration' };

export interface FrameIdentity {
  readonly frameId: LayoutFrameId;
  readonly viewId: ViewId;
  readonly documentId: DocumentId;
  readonly documentVersion: DocumentVersion;
  readonly selectionGeneration: SelectionGeneration;
  readonly layoutGeneration: LayoutGeneration;
}

/** A zero-based row and terminal-cell column in one immutable published frame. */
export interface CellPoint {
  readonly row: number;
  readonly column: number;
}

/**
 * A resize-stable viewport origin. `offset` is a UTF-16 boundary in the supplied
 * document version; `displayCellColumn` is its logical line column before wrapping.
 */
export interface ViewportAnchor {
  readonly documentVersion: DocumentVersion;
  readonly lineIndex: LineIndex;
  readonly offset: Utf16Offset;
  readonly displayCellColumn: CellColumn;
}

export interface FoldRegion {
  readonly id: string;
  readonly documentVersion: DocumentVersion;
  readonly startLine: LineIndex;
  /** Exclusive logical line bound; the header and body become one placeholder row. */
  readonly endLineExclusive: LineIndex;
  readonly placeholder?: string;
}

/** Inline presentation text anchored to a document boundary; never an editable text hit. */
export interface VirtualAnnotation {
  readonly id: string;
  readonly documentVersion: DocumentVersion;
  readonly lineIndex: LineIndex;
  readonly offset: Utf16Offset;
  readonly text: string;
}

/** A non-document row inserted before `beforeLine` for side-by-side alignment. */
export interface DiffFillerRow {
  readonly id: string;
  readonly documentVersion: DocumentVersion;
  readonly beforeLine: LineIndex;
}

/**
 * Terminal-specific glyph measurement. IDs and generations are explicit cache keys;
 * changing a callback's behavior requires changing one of them.
 */
export interface CellWidthPolicy {
  readonly id: string;
  readonly generation: number;
  readonly widthOfCluster: (cluster: string) => number;
}

export interface LayoutOptions {
  readonly wrap?: boolean;
  readonly tabSize?: number;
  readonly horizontalScrollCells?: number;
  readonly widthPolicy?: CellWidthPolicy;
  readonly foldGeneration?: number;
  readonly folds?: readonly FoldRegion[];
  readonly gutterWidthCells?: number;
  readonly virtualAnnotations?: readonly VirtualAnnotation[];
  readonly diffFillerRows?: readonly DiffFillerRow[];
}

export interface ViewportProjectionInput {
  readonly viewId: ViewId;
  readonly snapshot: DocumentSnapshot;
  readonly selection: SelectionSetSnapshot;
  readonly widthCells: number;
  readonly heightCells: number;
  readonly anchor?: ViewportAnchor;
  readonly options?: LayoutOptions;
}

export type CellHitTarget = TextHitTarget | FoldHitTarget | GutterHitTarget | VirtualAnnotationHitTarget
  | DiffFillerHitTarget | ScrollbarHitTarget | SplitSeparatorHitTarget | UiControlHitTarget;

export interface TextHitTarget {
  readonly kind: 'text';
  readonly lineIndex: LineIndex;
  /** UTF-16 source boundary. Wide-glyph continuation cells use the leading boundary. */
  readonly offset: Utf16Offset;
  readonly affinity: 'left' | 'right';
  /** Display-cell displacement inside a tab; zero for ordinary glyphs. */
  readonly virtualCell: number;
  readonly displayCellColumn: CellColumn;
  /** Distinguishes wide continuations, tab cells and padding while preserving text boundaries. */
  readonly cellPart: 'glyph' | 'wide-continuation' | 'tab-fill' | 'clipped-glyph' | 'padding';
}

export interface FoldHitTarget {
  readonly kind: 'fold';
  readonly foldId: string;
  readonly lineIndex: LineIndex;
  readonly startLine: LineIndex;
  readonly endLineExclusive: LineIndex;
  /** UTF-16 boundary at the folded header's start. */
  readonly offset: Utf16Offset;
}

export interface GutterHitTarget {
  readonly kind: 'gutter';
  readonly offset?: never;
  readonly lineIndex: LineIndex;
  readonly wrapIndex: number;
  readonly gutterColumn: CellColumn;
  readonly region: 'line-number' | 'continuation';
}

export interface VirtualAnnotationHitTarget {
  readonly kind: 'virtual-annotation';
  readonly offset?: never;
  readonly annotationId: string;
  readonly lineIndex: LineIndex;
  /** Versioned UTF-16 anchor from which the non-editable annotation was projected. */
  readonly anchorOffset: Utf16Offset;
  readonly cellIndex: number;
  readonly displayCellColumn: CellColumn;
  readonly cellPart: 'leading' | 'wide-continuation' | 'clipped';
}

export interface DiffFillerHitTarget {
  readonly kind: 'diff-filler';
  readonly offset?: never;
  readonly fillerId: string;
  /** Logical insertion boundary used only for alignment; there is no text offset. */
  readonly beforeLine: LineIndex;
  readonly ordinal: number;
}

/** Reserved tagged targets for non-editor surfaces composed into a future frame. */
export interface ScrollbarHitTarget {
  readonly kind: 'scrollbar';
  readonly offset?: never;
  readonly scrollbarId: string;
  readonly axis: 'horizontal' | 'vertical';
}

export interface SplitSeparatorHitTarget {
  readonly kind: 'split-separator';
  readonly offset?: never;
  readonly separatorId: string;
  readonly axis: 'horizontal' | 'vertical';
}

export interface UiControlHitTarget {
  readonly kind: 'ui-control';
  readonly offset?: never;
  readonly controlId: string;
}

export interface ScreenCell {
  /** Glyph text for a leading cell, one ASCII space for a tab fill, or empty for continuation. */
  readonly text: string;
  readonly role: 'glyph' | 'wide-continuation' | 'tab-fill' | 'clipped-glyph' | 'fold-marker' | 'padding' | 'filler'
    | 'gutter' | 'virtual-annotation' | 'virtual-annotation-continuation' | 'diff-filler';
  readonly target: CellHitTarget | null;
}

export interface ScreenRow {
  readonly kind: 'text' | 'fold' | 'filler' | 'diff-filler';
  readonly lineIndex: LineIndex | null;
  readonly wrapIndex: number;
  /** Logical line display-cell interval represented by this wrapped row. */
  readonly displayStartCell: number;
  readonly displayEndCell: number;
  readonly startOffset: Utf16Offset | null;
  readonly endOffset: Utf16Offset | null;
  readonly cells: readonly ScreenCell[];
  readonly text: string;
  /**
   * Stable content identity: equal for two rows with identical rendered glyphs
   * (text, roles, gutter label) even when their object references and absolute
   * `startOffset`/`endOffset`/`target.offset` values differ because an edit above
   * shifted every later line's absolute offsets. A UI paint-diff MAY compare this
   * field instead of row-object identity to skip repainting rows whose visible
   * content did not change. `null` when a row has no reusable content identity
   * (never assigned by two different rows unless their glyphs are identical).
   */
  readonly contentKey: string | null;
}

export interface ProjectedEndpoint {
  readonly kind: SelectionEndpoint['kind'];
  readonly requestedOffset: Utf16Offset;
  readonly projectedOffset: Utf16Offset;
  readonly lineIndex: LineIndex;
  readonly displayCellColumn: CellColumn;
  readonly position: CellPoint | null;
  readonly clipped: boolean;
  readonly relocatedByFold: boolean;
  readonly virtualCells: number | null;
}

export interface ProjectedSelection {
  readonly id: SelectionId;
  readonly kind: SelectionMember['kind'];
  readonly primary: boolean;
  readonly direction: SelectionMember['direction'];
  readonly desiredColumn: SelectionMember['desiredColumn'];
  readonly anchor: ProjectedEndpoint;
  readonly head: ProjectedEndpoint;
}

export interface VisibleFrame {
  readonly identity: FrameIdentity;
  readonly widthCells: number;
  readonly heightCells: number;
  readonly anchor: ViewportAnchor;
  readonly rows: readonly ScreenRow[];
  readonly selections: readonly ProjectedSelection[];
  readonly truncatedLongLine: boolean;
}

export interface LayoutHit {
  readonly identity: FrameIdentity;
  readonly point: CellPoint;
  readonly target: CellHitTarget;
}

export type LayoutFailure =
  | { readonly kind: 'invalid-viewport' }
  | { readonly kind: 'invalid-anchor' }
  | { readonly kind: 'invalid-folds' }
  | { readonly kind: 'invalid-annotations' }
  | { readonly kind: 'invalid-diff-fillers' }
  | { readonly kind: 'wrong-document' }
  | { readonly kind: 'stale-document-version' }
  | { readonly kind: 'snapshot-read-failed'; readonly reason: string }
  | { readonly kind: 'unknown-frame' }
  | { readonly kind: 'stale-frame'; readonly currentFrameId: LayoutFrameId }
  | { readonly kind: 'outside-viewport' }
  | { readonly kind: 'empty-cell' }
  | { readonly kind: 'invalid-offset' };

export interface LayoutCacheStats {
  readonly frameCacheHits: number;
  readonly rowsCacheHits: number;
  readonly lineCacheHits: number;
  readonly lineCacheMisses: number;
  readonly lineCacheEvictions: number;
  readonly materializedLineHits: number;
  readonly materializedLineMisses: number;
  readonly materializedLineEvictions: number;
  readonly rowsBuilt: number;
  readonly retainedFrames: number;
  readonly retainedLineLayouts: number;
  readonly retainedMaterializedCells: number;
  readonly trackedDocumentVersions: number;
}

/**
 * Private, base-offset-independent shaping types shared by shaping.ts and
 * viewport.ts. Not part of the package's public surface (see index.ts).
 */
export interface RelativeTextCell {
  readonly kind: 'text';
  readonly text: string;
  readonly role: ScreenCell['role'];
  readonly offset: number;
  readonly affinity: 'left' | 'right';
  readonly virtualCell: number;
  readonly displayCellColumn: number;
}

export interface RelativeAnnotationCell {
  readonly kind: 'virtual-annotation';
  readonly text: string;
  readonly role: ScreenCell['role'];
  readonly offset: number;
  readonly affinity: 'left' | 'right';
  readonly virtualCell: number;
  readonly displayCellColumn: number;
  readonly annotationId: string;
  readonly annotationCellIndex: number;
  readonly annotationCellPart: VirtualAnnotationHitTarget['cellPart'];
}

export type RelativeCell = RelativeTextCell | RelativeAnnotationCell;

export interface RelativeAnnotation {
  readonly id: string;
  readonly offset: number;
  readonly text: string;
}

export interface RelativeRow {
  readonly wrapIndex: number;
  readonly displayStartCell: number;
  readonly displayEndCell: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly cells: readonly RelativeCell[];
}

export interface RelativeLineLayout {
  readonly rows: readonly RelativeRow[];
  readonly complete: boolean;
}

/**
 * A pre-shaped, content-only cell: everything about it (text, role, hit-target
 * kind/part, relative offset) is derived purely from the visible line's text and
 * shaping inputs, never from the line's absolute position in the document. It is
 * cached and reused across every base offset an edit above it produces.
 */
export interface RelativeMaterializedCell {
  readonly text: string;
  readonly role: ScreenCell['role'];
  readonly kind: 'text' | 'virtual-annotation';
  readonly relativeOffset: number;
  readonly affinity: 'left' | 'right';
  readonly virtualCell: number;
  readonly displayCellColumn: number;
  readonly cellPart: TextHitTarget['cellPart'] | VirtualAnnotationHitTarget['cellPart'];
  readonly annotationId: string | null;
  readonly annotationCellIndex: number;
}

export interface RelativeMaterializedRow {
  readonly wrapIndex: number;
  readonly displayStartCell: number;
  readonly displayEndCell: number;
  readonly relativeStartOffset: number;
  readonly relativeEndOffset: number;
  readonly cells: readonly RelativeMaterializedCell[];
  /** Relative offset baked into any padding cells appended up to `width`. */
  readonly paddingRelativeOffset: number;
  readonly paddingCount: number;
  /**
   * Precomputed `cells.map((cell) => cell.text).join('') + ' '.repeat(paddingCount)`.
   * Rendered glyph text never depends on the absolute base offset an edit elsewhere
   * gives this row, so `rebaseMaterializedRows` reuses this string as-is every frame
   * instead of re-joining every visible cell's text on every keystroke.
   */
  readonly text: string;
}

/** The cached, base-offset-independent template stored in `#materializedLines`. */
export interface RelativeMaterializedRows {
  readonly rows: readonly RelativeMaterializedRow[];
  readonly cellCost: number;
}

export interface GutterCells {
  readonly cells: readonly ScreenCell[];
  /** `cells.map((cell) => cell.text).join('')`, cached once per (line, wrapIndex, width). */
  readonly text: string;
}
