import type {
  CellColumn,
  DocumentId,
  DocumentSnapshot,
  DocumentVersion,
  LineIndex,
  Utf16Offset,
  VersionedDocumentChange,
  ViewId,
} from '../../document/src/index.ts';
import type {
  SelectionGeneration,
  SelectionId,
  SelectionEndpoint,
  SelectionMember,
  SelectionSetSnapshot,
} from '../../selections/src/index.ts';

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

interface RelativeTextCell {
  readonly kind: 'text';
  readonly text: string;
  readonly role: ScreenCell['role'];
  readonly offset: number;
  readonly affinity: 'left' | 'right';
  readonly virtualCell: number;
  readonly displayCellColumn: number;
}

interface RelativeAnnotationCell {
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

type RelativeCell = RelativeTextCell | RelativeAnnotationCell;

interface RelativeAnnotation {
  readonly id: string;
  readonly offset: number;
  readonly text: string;
}

interface RelativeRow {
  readonly wrapIndex: number;
  readonly displayStartCell: number;
  readonly displayEndCell: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly cells: readonly RelativeCell[];
}

interface RelativeLineLayout {
  readonly rows: readonly RelativeRow[];
  readonly complete: boolean;
}

interface CachedLineLayout {
  readonly key: string;
  readonly value: RelativeLineLayout;
}

interface StoredFrame {
  readonly frame: VisibleFrame;
  readonly positions: PackedPositionIndex;
}

interface CachedViewportProjection {
  readonly key: string;
  readonly anchor: ViewportAnchor;
  readonly rows: readonly ScreenRow[];
  readonly selections: readonly ProjectedSelection[];
  readonly positions: PackedPositionIndex;
  readonly truncatedLongLine: boolean;
}

interface MaterializedRows {
  readonly rows: readonly ScreenRow[];
  readonly positions: PackedPositionIndex;
  readonly cellCost: number;
}

/**
 * Private numeric hit geometry. The public frame exposes CellPoint values at
 * request boundaries, while retained indexes keep only packed row/column
 * integers and never allocate a string key per visible cell.
 */
class PackedPositionIndex {
  readonly #offsets = new Map<number, number>();
  readonly #display = new Map<number, Map<number, number>>();

  setOffset(offset: number, row: number, column: number): void {
    this.#offsets.set(offset, packPoint(row, column));
  }

  hasOffset(offset: number): boolean {
    return this.#offsets.has(offset);
  }

  getOffset(offset: number): CellPoint | undefined {
    const packed = this.#offsets.get(offset);
    return packed === undefined ? undefined : unpackPoint(packed);
  }

  setDisplay(line: number, column: number, row: number, screenColumn: number): void {
    const byColumn = this.#display.get(line) ?? new Map<number, number>();
    byColumn.set(column, packPoint(row, screenColumn));
    this.#display.set(line, byColumn);
  }

  getDisplay(line: number, column: number): CellPoint | undefined {
    const packed = this.#display.get(line)?.get(column);
    return packed === undefined ? undefined : unpackPoint(packed);
  }

  hasDisplay(line: number, column: number): boolean {
    return this.#display.get(line)?.has(column) ?? false;
  }

  forEachOffset(callback: (offset: number, row: number, column: number) => void): void {
    for (const [offset, packed] of this.#offsets) {
      callback(offset, unpackRow(packed), unpackColumn(packed));
    }
  }

  forEachDisplay(callback: (line: number, column: number, row: number, screenColumn: number) => void): void {
    for (const [line, byColumn] of this.#display) {
      for (const [column, packed] of byColumn) {
        callback(line, column, unpackRow(packed), unpackColumn(packed));
      }
    }
  }
}

const PACKED_POINT_STRIDE = 2_048;

function packPoint(row: number, column: number): number {
  return row * PACKED_POINT_STRIDE + column;
}

function unpackRow(packed: number): number {
  return Math.floor(packed / PACKED_POINT_STRIDE);
}

function unpackColumn(packed: number): number {
  return packed % PACKED_POINT_STRIDE;
}

function unpackPoint(packed: number): CellPoint {
  return Object.freeze({ row: unpackRow(packed), column: unpackColumn(packed) });
}

const MAX_FRAME_HISTORY = 8;
const MAX_LINE_CACHE_ENTRIES = 512;
const MAX_MATERIALIZED_LINE_ENTRIES = 512;
const MAX_MATERIALIZED_CELL_COST = 40_000;
const MAX_CACHED_LINE_UTF16 = 8_192;
const MAX_SOURCE_PREFIX_UTF16 = 65_536;
const MAX_LAYOUT_ANNOTATIONS = 4_096;
const MAX_LAYOUT_ID_UTF16 = 256;
const MAX_LAYOUT_ANNOTATION_UTF16 = 256;
const MAX_LAYOUT_ANNOTATION_TOTAL_UTF16 = 65_536;
const MAX_DIFF_FILLER_ROWS = 4_096;
const DEFAULT_WIDTH_POLICY: CellWidthPolicy = Object.freeze({
  id: 'xi-default-terminal-width',
  generation: 1,
  widthOfCluster: defaultClusterWidth,
});

/** Default deterministic width policy: combining marks are zero-width, East Asian and emoji are two. */
export function defaultCellWidthPolicy(): CellWidthPolicy {
  return DEFAULT_WIDTH_POLICY;
}

/**
 * Project an immutable document/selection snapshot into bounded terminal rows.
 * It owns no text, cursor state, fold state or selection state.
 */
export class ViewportLayout {
  #nextFrameId = 1;
  #layoutGeneration = 0;
  #lastGeometryKey = '';
  #currentFrameId: LayoutFrameId | null = null;
  #currentDocumentKey: string | undefined;
  readonly #frames = new Map<number, StoredFrame>();
  readonly #documentVersions = new Map<string, DocumentVersion>();
  readonly #lineLayouts = new Map<string, RelativeLineLayout>();
  readonly #materializedLines = new Map<string, MaterializedRows>();
  /** Reuses the immutable screen row produced by gutter projection across selection-only frames. */
  readonly #gutterRows = new WeakMap<ScreenRow, Map<number, ScreenRow>>();
  #materializedCellCost = 0;
  #lineCacheHits = 0;
  #lineCacheMisses = 0;
  #lineCacheEvictions = 0;
  #rowsBuilt = 0;
  #frameCacheHits = 0;
  #materializedLineHits = 0;
  #materializedLineMisses = 0;
  #materializedLineEvictions = 0;
  #lastProjection: CachedViewportProjection | undefined;

  get cacheStats(): LayoutCacheStats {
    return Object.freeze({
      frameCacheHits: this.#frameCacheHits,
      lineCacheHits: this.#lineCacheHits,
      lineCacheMisses: this.#lineCacheMisses,
      lineCacheEvictions: this.#lineCacheEvictions,
      materializedLineHits: this.#materializedLineHits,
      materializedLineMisses: this.#materializedLineMisses,
      materializedLineEvictions: this.#materializedLineEvictions,
      rowsBuilt: this.#rowsBuilt,
      retainedFrames: this.#frames.size,
      retainedLineLayouts: this.#lineLayouts.size,
      retainedMaterializedCells: this.#materializedCellCost,
      trackedDocumentVersions: this.#documentVersions.size,
    });
  }

  /**
   * Layout rows for one viewport. The cache is keyed by exact visible-line text and
   * every width/wrap/tab policy input, while absolute offsets are attached per frame.
   */
  project(input: ViewportProjectionInput): { readonly ok: true; readonly value: VisibleFrame } | { readonly ok: false; readonly error: LayoutFailure } {
    const { snapshot, selection } = input;
    if (selection.documentId !== snapshot.id) return layoutFailure('wrong-document');
    const documentKey = snapshot.id as string;
    const knownVersion = this.#documentVersions.get(documentKey);
    if (knownVersion !== undefined && (snapshot.version as number) < (knownVersion as number)) {
      return layoutFailure('stale-document-version');
    }
    const shouldTrackVersion = this.#currentDocumentKey === undefined || this.#currentDocumentKey === documentKey
      || [...this.#frames.values()].some((stored) => stored.frame.identity.documentId === snapshot.id);
    if (shouldTrackVersion && (knownVersion === undefined || (snapshot.version as number) > (knownVersion as number))) {
      this.#documentVersions.set(documentKey, snapshot.version);
      this.#trimDocumentVersions();
    }
    if (selection.documentVersion !== snapshot.version) return layoutFailure('stale-document-version');
    if (!validDimension(input.widthCells) || !validDimension(input.heightCells)
      || input.widthCells * input.heightCells > 250_000) return layoutFailure('invalid-viewport');

    const options = input.options ?? {};
    const wrap = options.wrap ?? true;
    const tabSize = options.tabSize ?? 8;
    const horizontalScrollCells = options.horizontalScrollCells ?? 0;
    const widthPolicy = options.widthPolicy ?? DEFAULT_WIDTH_POLICY;
    const folds = options.folds ?? [];
    const foldGeneration = options.foldGeneration ?? 0;
    const gutterWidthCells = options.gutterWidthCells ?? 0;
    if (!Number.isSafeInteger(tabSize) || tabSize < 1 || tabSize > 32
      || !Number.isSafeInteger(horizontalScrollCells) || horizontalScrollCells < 0
      || !Number.isSafeInteger(gutterWidthCells) || gutterWidthCells < 0 || gutterWidthCells >= input.widthCells
      || !Number.isSafeInteger(widthPolicy.generation) || widthPolicy.generation < 0
      || typeof widthPolicy.id !== 'string' || widthPolicy.id.length === 0 || widthPolicy.id.length > MAX_LAYOUT_ID_UTF16
      || typeof widthPolicy.widthOfCluster !== 'function'
      || !Number.isSafeInteger(foldGeneration) || foldGeneration < 0) {
      return layoutFailure('invalid-viewport');
    }
    const validFolds = validateFolds(folds, snapshot.lineCount, snapshot.version);
    if (!validFolds.ok) return validFolds;
    const annotationsResult = validateAnnotations(options.virtualAnnotations ?? [], snapshot);
    if (!annotationsResult.ok) return annotationsResult;
    const diffFillersResult = validateDiffFillerRows(options.diffFillerRows ?? [], snapshot);
    if (!diffFillersResult.ok) return diffFillersResult;
    const contentWidth = input.widthCells - gutterWidthCells;
    const annotationsByLine = groupAnnotationsByLine(annotationsResult.value);

    const anchorResult = input.anchor === undefined
      ? defaultAnchor(snapshot)
      : { ok: true as const, value: input.anchor };
    if (!anchorResult.ok) return anchorResult;
    let anchorForProjection = anchorResult.value;
    if (anchorForProjection.documentVersion !== snapshot.version) return layoutFailure('stale-document-version');
    const anchorLine = snapshot.lineIndexAt(anchorForProjection.offset);
    if (!anchorLine.ok || anchorLine.value !== anchorForProjection.lineIndex) return layoutFailure('invalid-anchor');
    const anchorCell = anchorForProjection.displayCellColumn as number;
    if (!Number.isSafeInteger(anchorCell) || anchorCell < 0) return layoutFailure('invalid-anchor');

    const foldAtAnchor = foldContaining(folds, anchorForProjection.lineIndex as number);
    if (foldAtAnchor !== undefined) {
      const offset = snapshot.lineStartOffset(foldAtAnchor.startLine);
      if (!offset.ok) return readFailure(offset.error.kind);
      anchorForProjection = {
        documentVersion: snapshot.version,
        lineIndex: foldAtAnchor.startLine,
        offset: offset.value,
        displayCellColumn: cellColumn(0),
      };
    }
    // Never retain a caller-owned anchor in a published frame or reusable cache entry.
    const effectiveAnchor: ViewportAnchor = Object.freeze({
      documentVersion: anchorForProjection.documentVersion,
      lineIndex: anchorForProjection.lineIndex,
      offset: anchorForProjection.offset,
      displayCellColumn: anchorForProjection.displayCellColumn,
    });

    const geometryKey = JSON.stringify([
      input.viewId,
      snapshot.id,
      snapshot.version,
      input.widthCells,
      input.heightCells,
      effectiveAnchor.lineIndex,
      effectiveAnchor.offset,
      effectiveAnchor.displayCellColumn,
      wrap,
      tabSize,
      horizontalScrollCells,
      widthPolicy.id,
      widthPolicy.generation,
      foldGeneration,
      folds.map((fold) => [fold.id, fold.startLine, fold.endLineExclusive, fold.placeholder]),
      gutterWidthCells,
      annotationsResult.value.map((annotation) => [annotation.id, annotation.lineIndex, annotation.offset, annotation.text]),
      diffFillersResult.value.map((filler) => [filler.id, filler.beforeLine]),
    ]);
    if (geometryKey !== this.#lastGeometryKey) {
      this.#layoutGeneration += 1;
      this.#lastGeometryKey = geometryKey;
    }
    const frameId = this.#nextFrameId as LayoutFrameId;
    this.#nextFrameId += 1;
    const identity: FrameIdentity = Object.freeze({
      frameId,
      viewId: input.viewId,
      documentId: snapshot.id,
      documentVersion: snapshot.version,
      selectionGeneration: selection.selectionGeneration,
      layoutGeneration: this.#layoutGeneration as LayoutGeneration,
    });

    const projectionKey = JSON.stringify([geometryKey, selection.selectionGeneration]);
    if (this.#lastProjection?.key === projectionKey) {
      this.#frameCacheHits += 1;
      const cached = this.#lastProjection;
      const frame: VisibleFrame = Object.freeze({
        identity,
        widthCells: input.widthCells,
        heightCells: input.heightCells,
        anchor: cached.anchor,
        rows: cached.rows,
        selections: cached.selections,
        truncatedLongLine: cached.truncatedLongLine,
      });
      this.#currentFrameId = frameId;
      this.#currentDocumentKey = documentKey;
      this.#documentVersions.set(documentKey, snapshot.version);
      this.#frames.set(frameId as number, {
        frame,
        positions: cached.positions,
      });
      this.#trimFrames();
      return { ok: true, value: frame };
    }

    const rows: ScreenRow[] = [];
    let logicalLine = effectiveAnchor.lineIndex as number;
    let sourceAnchor: ViewportAnchor | undefined = effectiveAnchor;
    let truncatedLongLine = false;
    const positions = new PackedPositionIndex();
    let diffFillerIndex = 0;
    while (rows.length < input.heightCells && logicalLine < snapshot.lineCount) {
      while (diffFillerIndex < diffFillersResult.value.length
        && (diffFillersResult.value[diffFillerIndex]?.beforeLine as number) < logicalLine) diffFillerIndex += 1;
      while (diffFillerIndex < diffFillersResult.value.length
        && (diffFillersResult.value[diffFillerIndex]?.beforeLine as number) === logicalLine
        && rows.length < input.heightCells) {
        const filler = diffFillersResult.value[diffFillerIndex];
        if (filler !== undefined) rows.push(buildDiffFillerRow(filler, input.widthCells, diffFillerIndex));
        diffFillerIndex += 1;
      }
      if (rows.length >= input.heightCells) break;
      const fold = foldAt(folds, logicalLine);
      if (fold !== undefined) {
        const foldRow = buildFoldRow(snapshot, fold, contentWidth);
        if (!foldRow.ok) return foldRow;
        rows.push(this.withGutter(foldRow.value, gutterWidthCells));
        positions.setOffset(foldRow.value.startOffset as number, rows.length - 1, gutterWidthCells);
        logicalLine = fold.endLineExclusive as number;
        sourceAnchor = undefined;
        continue;
      }

      const line = lineRange(snapshot, lineIndex(logicalLine));
      if (!line.ok) return line;
      const baseOffset = sourceAnchor?.offset ?? line.value.start;
      const logicalDisplayStart = sourceAnchor?.displayCellColumn as number | undefined ?? 0;
      if ((baseOffset as number) < (line.value.start as number) || (baseOffset as number) > (line.value.end as number)) {
        return layoutFailure('invalid-anchor');
      }
      const read = readVisibleLineText(snapshot, baseOffset, line.value.end, contentWidth, input.heightCells - rows.length);
      if (!read.ok) return read;
      const prefix = read.value.text;
      const lineAnnotations = (annotationsByLine.get(logicalLine) ?? []).flatMap((annotation) => {
        const absoluteOffset = annotation.offset as number;
        const relativeOffset = absoluteOffset - (baseOffset as number);
        const withinRead = relativeOffset < prefix.length || (relativeOffset === prefix.length && read.value.complete);
        return relativeOffset >= 0 && withinRead
          ? [{ id: annotation.id, offset: relativeOffset, text: annotation.text } satisfies RelativeAnnotation]
          : [];
      });
      const startsAtLineOrigin = baseOffset === line.value.start && logicalDisplayStart === 0;
      const canCache = startsAtLineOrigin && prefix.length <= MAX_CACHED_LINE_UTF16 && read.value.complete;
      const cacheKey = lineCacheKey(prefix, contentWidth, input.heightCells - rows.length, wrap, tabSize,
        logicalDisplayStart, horizontalScrollCells, widthPolicy);
      const cacheableLine = canCache && lineAnnotations.length === 0;
      let relative = cacheableLine ? this.#lineLayouts.get(cacheKey) : undefined;
      if (relative !== undefined) {
        this.#lineCacheHits += 1;
        this.#lineLayouts.delete(cacheKey);
        this.#lineLayouts.set(cacheKey, relative);
      } else {
        this.#lineCacheMisses += 1;
        const shaped = shapeLine(prefix, contentWidth, input.heightCells - rows.length, wrap, tabSize,
          logicalDisplayStart, horizontalScrollCells, widthPolicy, !read.value.complete, lineAnnotations);
        if (!shaped.ok) return shaped;
        relative = shaped.value;
        this.#rowsBuilt += relative.rows.length;
        if (cacheableLine) this.#cacheLine(cacheKey, relative);
      }
      if (!read.value.complete || !relative.complete) truncatedLongLine = true;
      const annotationsKey = JSON.stringify(lineAnnotations.map((annotation) => [annotation.id, annotation.offset, annotation.text]));
      const materializedKey = JSON.stringify([
        snapshot.id, logicalLine, baseOffset, line.value.end, cacheKey, annotationsKey,
      ]);
      let materialized = this.#materializedLines.get(materializedKey);
      if (materialized !== undefined) {
        this.#materializedLineHits += 1;
        this.#materializedLines.delete(materializedKey);
        this.#materializedLines.set(materializedKey, materialized);
      } else {
        this.#materializedLineMisses += 1;
        materialized = materializeRows(relative, lineIndex(logicalLine), baseOffset, line.value.end, contentWidth);
        if (materialized.cellCost <= MAX_MATERIALIZED_CELL_COST) this.#cacheMaterializedLine(materializedKey, materialized);
      }
      const rowBase = rows.length;
      for (let rowIndex = 0; rowIndex < materialized.rows.length; rowIndex += 1) {
        const row = materialized.rows[rowIndex];
        if (row === undefined || rows.length >= input.heightCells) break;
        rows.push(this.withGutter(row, gutterWidthCells));
      }
      materialized.positions.forEachOffset((offset, row, column) => {
        positions.setOffset(offset, rowBase + row, column + gutterWidthCells);
      });
      materialized.positions.forEachDisplay((line, column, row, screenColumn) => {
        positions.setDisplay(line, column, rowBase + row, screenColumn + gutterWidthCells);
      });
      if (rows.length >= input.heightCells || !relative.complete) break;
      logicalLine += 1;
      sourceAnchor = undefined;
    }

    if (logicalLine >= snapshot.lineCount) {
      while (diffFillerIndex < diffFillersResult.value.length
        && (diffFillersResult.value[diffFillerIndex]?.beforeLine as number) === snapshot.lineCount
        && rows.length < input.heightCells) {
        const filler = diffFillersResult.value[diffFillerIndex];
        if (filler !== undefined) rows.push(buildDiffFillerRow(filler, input.widthCells, diffFillerIndex));
        diffFillerIndex += 1;
      }
    }

    while (rows.length < input.heightCells) {
      rows.push(fillerRow(input.widthCells));
    }

    const projectedSelections = projectSelections(snapshot, selection, rows, positions, folds);
    if (!projectedSelections.ok) return projectedSelections;
    const frame: VisibleFrame = Object.freeze({
      identity,
      widthCells: input.widthCells,
      heightCells: input.heightCells,
      anchor: effectiveAnchor,
      rows: Object.freeze(rows),
      selections: projectedSelections.value,
      truncatedLongLine,
    });
    this.#lastProjection = Object.freeze({
      key: projectionKey,
      anchor: effectiveAnchor,
      rows: frame.rows,
      selections: frame.selections,
      positions,
      truncatedLongLine,
    });
    this.#currentFrameId = frameId;
    this.#currentDocumentKey = documentKey;
    this.#documentVersions.set(documentKey, snapshot.version);
    this.#frames.set(frameId as number, { frame, positions });
    this.#trimFrames();
    return { ok: true, value: frame };
  }

  private withGutter(row: ScreenRow, gutterWidth: number): ScreenRow {
    if (gutterWidth === 0 || row.lineIndex === null) return row;
    let byWidth = this.#gutterRows.get(row);
    if (byWidth === undefined) {
      byWidth = new Map<number, ScreenRow>();
      this.#gutterRows.set(row, byWidth);
    }
    const cached = byWidth.get(gutterWidth);
    if (cached !== undefined) return cached;
    const projected = prependGutter(row, gutterWidth);
    byWidth.set(gutterWidth, projected);
    return projected;
  }

  /** Hit-test only the current published frame; an old frame is explicitly stale. */
  hitTest(frameId: LayoutFrameId, point: CellPoint): { readonly ok: true; readonly value: LayoutHit } | { readonly ok: false; readonly error: LayoutFailure } {
    const stored = this.#frames.get(frameId as number);
    if (stored === undefined) return layoutFailure('unknown-frame');
    if (this.#isFrameVersionStale(stored)) return layoutFailure('stale-document-version');
    if (frameId !== this.#currentFrameId) {
      return { ok: false, error: { kind: 'stale-frame', currentFrameId: this.#currentFrameId as LayoutFrameId } };
    }
    if (!Number.isSafeInteger(point.row) || !Number.isSafeInteger(point.column) || point.row < 0 || point.column < 0
      || point.row >= stored.frame.heightCells || point.column >= stored.frame.widthCells) {
      return layoutFailure('outside-viewport');
    }
    const row = stored.frame.rows[point.row];
    const cell = row?.cells[point.column];
    if (row === undefined || cell === undefined) return layoutFailure('outside-viewport');
    if (cell.target === null) return layoutFailure('empty-cell');
    return {
      ok: true,
      value: Object.freeze({ identity: stored.frame.identity, point: Object.freeze({ ...point }), target: cell.target }),
    };
  }

  /** Map a UTF-16 text boundary to a visible screen-cell edge in one published frame. */
  positionForOffset(frameId: LayoutFrameId, offset: Utf16Offset): { readonly ok: true; readonly value: CellPoint } | { readonly ok: false; readonly error: LayoutFailure } {
    const stored = this.#frames.get(frameId as number);
    if (stored === undefined) return layoutFailure('unknown-frame');
    if (this.#isFrameVersionStale(stored)) return layoutFailure('stale-document-version');
    if (frameId !== this.#currentFrameId) {
      return { ok: false, error: { kind: 'stale-frame', currentFrameId: this.#currentFrameId as LayoutFrameId } };
    }
    const point = lookupOffsetPosition(stored.frame.rows, stored.positions, offset as number);
    return point === undefined ? layoutFailure('outside-viewport') : { ok: true, value: point };
  }

  /**
   * Validate and account for a committed text transition. Content-addressed line
   * entries remain safe; changed text naturally gets a different cache key.
   */
  observeDocumentChange(change: VersionedDocumentChange): void {
    if (!Number.isSafeInteger(change.before as number) || !Number.isSafeInteger(change.after as number)
      || (change.after as number) <= (change.before as number)) return;
    const documentKey = change.documentId as string;
    const known = this.#documentVersions.get(documentKey);
    const isCurrentOrRetained = this.#currentDocumentKey === undefined || this.#currentDocumentKey === documentKey
      || [...this.#frames.values()].some((stored) => stored.frame.identity.documentId === change.documentId);
    if (isCurrentOrRetained && (known === undefined || (change.after as number) > (known as number))) {
      if (this.#currentDocumentKey === undefined) this.#currentDocumentKey = documentKey;
      this.#documentVersions.set(documentKey, change.after);
      this.#trimDocumentVersions();
    }
    if (change.documentId !== this.#frames.get(this.#currentFrameId as number)?.frame.identity.documentId) return;
    // Geometry keys include document versions, so old hit maps can never be reused.
    this.#lastGeometryKey = '';
  }

  dispose(): void {
    this.#frames.clear();
    this.#documentVersions.clear();
    this.#currentDocumentKey = undefined;
    this.#lineLayouts.clear();
    this.#materializedLines.clear();
    this.#materializedCellCost = 0;
    this.#currentFrameId = null;
    this.#lastGeometryKey = '';
    this.#lastProjection = undefined;
  }

  #trimFrames(): void {
    while (this.#frames.size > MAX_FRAME_HISTORY) {
      const oldest = this.#frames.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.#frames.delete(oldest);
    }
    this.#trimDocumentVersions();
  }

  #trimDocumentVersions(): void {
    const retained = new Set<string>();
    if (this.#currentDocumentKey !== undefined) retained.add(this.#currentDocumentKey);
    for (const stored of this.#frames.values()) retained.add(stored.frame.identity.documentId as string);
    for (const key of this.#documentVersions.keys()) {
      if (!retained.has(key)) this.#documentVersions.delete(key);
    }
  }

  #cacheLine(key: string, value: RelativeLineLayout): void {
    this.#lineLayouts.set(key, value);
    while (this.#lineLayouts.size > MAX_LINE_CACHE_ENTRIES) {
      const oldest = this.#lineLayouts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#lineLayouts.delete(oldest);
      this.#lineCacheEvictions += 1;
    }
  }

  #isFrameVersionStale(stored: StoredFrame): boolean {
    const identity = stored.frame.identity;
    const known = this.#documentVersions.get(identity.documentId as string);
    return known !== undefined && known !== identity.documentVersion;
  }

  #cacheMaterializedLine(key: string, value: MaterializedRows): void {
    this.#materializedLines.set(key, value);
    this.#materializedCellCost += value.cellCost;
    while (this.#materializedLines.size > MAX_MATERIALIZED_LINE_ENTRIES
      || this.#materializedCellCost > MAX_MATERIALIZED_CELL_COST) {
      const oldestKey = this.#materializedLines.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.#materializedLines.get(oldestKey);
      this.#materializedLines.delete(oldestKey);
      if (oldest !== undefined) this.#materializedCellCost -= oldest.cellCost;
      this.#materializedLineEvictions += 1;
    }
  }
}

function validDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 2_000;
}

function validateFolds(
  folds: readonly FoldRegion[],
  lineCount: number,
  documentVersion: DocumentVersion,
): { readonly ok: true } | { readonly ok: false; readonly error: LayoutFailure } {
  let previousEnd = 0;
  const ids = new Set<string>();
  for (const fold of folds) {
    const start = fold.startLine as number;
    const end = fold.endLineExclusive as number;
    if (fold.documentVersion !== documentVersion) return layoutFailure('stale-document-version');
    if (typeof fold.id !== 'string' || fold.id.length === 0 || fold.id.length > MAX_LAYOUT_ID_UTF16 || ids.has(fold.id)
      || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < previousEnd || start < 0 || end <= start + 1 || end > lineCount
      || (fold.placeholder !== undefined && typeof fold.placeholder !== 'string')) {
      return layoutFailure('invalid-folds');
    }
    ids.add(fold.id);
    previousEnd = end;
  }
  return { ok: true };
}

function validateAnnotations(
  annotations: readonly VirtualAnnotation[],
  snapshot: DocumentSnapshot,
): { readonly ok: true; readonly value: readonly VirtualAnnotation[] } | { readonly ok: false; readonly error: LayoutFailure } {
  if (annotations.length > MAX_LAYOUT_ANNOTATIONS) return layoutFailure('invalid-annotations');
  const ids = new Set<string>();
  let totalUtf16 = 0;
  const validated: VirtualAnnotation[] = [];
  for (const annotation of annotations) {
    const line = annotation.lineIndex as number;
    const offset = annotation.offset as number;
    if (annotation.documentVersion !== snapshot.version || typeof annotation.id !== 'string'
      || annotation.id.length === 0 || annotation.id.length > MAX_LAYOUT_ID_UTF16 || ids.has(annotation.id) || typeof annotation.text !== 'string'
      || annotation.text.length === 0 || annotation.text.length > MAX_LAYOUT_ANNOTATION_UTF16
      || /[\r\n\t]/u.test(annotation.text) || !Number.isSafeInteger(line) || line < 0 || line >= snapshot.lineCount
      || !Number.isSafeInteger(offset) || offset < 0 || offset > (snapshot.lengthUtf16 as number)) {
      return layoutFailure('invalid-annotations');
    }
    totalUtf16 += annotation.text.length;
    if (totalUtf16 > MAX_LAYOUT_ANNOTATION_TOTAL_UTF16) return layoutFailure('invalid-annotations');
    const range = lineRange(snapshot, annotation.lineIndex);
    if (!range.ok) return layoutFailure('invalid-annotations');
    const location = snapshot.lineIndexAt(annotation.offset);
    const boundary = snapshot.slice(annotation.offset, annotation.offset);
    if (!location.ok || location.value !== annotation.lineIndex || !boundary.ok
      || offset < (range.value.start as number) || offset > (range.value.end as number)) {
      return layoutFailure('invalid-annotations');
    }
    ids.add(annotation.id);
    validated.push(annotation);
  }
  validated.sort((left, right) => (left.lineIndex as number) - (right.lineIndex as number)
    || (left.offset as number) - (right.offset as number) || compareUtf16CodeUnits(left.id, right.id));
  return { ok: true, value: Object.freeze(validated) };
}

function validateDiffFillerRows(
  fillers: readonly DiffFillerRow[],
  snapshot: DocumentSnapshot,
): { readonly ok: true; readonly value: readonly DiffFillerRow[] } | { readonly ok: false; readonly error: LayoutFailure } {
  if (fillers.length > MAX_DIFF_FILLER_ROWS) return layoutFailure('invalid-diff-fillers');
  const ids = new Set<string>();
  const validated: DiffFillerRow[] = [];
  for (const filler of fillers) {
    const beforeLine = filler.beforeLine as number;
    if (filler.documentVersion !== snapshot.version || typeof filler.id !== 'string' || filler.id.length === 0
      || filler.id.length > MAX_LAYOUT_ID_UTF16
      || ids.has(filler.id) || !Number.isSafeInteger(beforeLine) || beforeLine < 0 || beforeLine > snapshot.lineCount) {
      return layoutFailure('invalid-diff-fillers');
    }
    ids.add(filler.id);
    validated.push(filler);
  }
  validated.sort((left, right) => (left.beforeLine as number) - (right.beforeLine as number)
    || compareUtf16CodeUnits(left.id, right.id));
  return { ok: true, value: Object.freeze(validated) };
}

function compareUtf16CodeUnits(left: string, right: string): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function groupAnnotationsByLine(annotations: readonly VirtualAnnotation[]): ReadonlyMap<number, readonly VirtualAnnotation[]> {
  const grouped = new Map<number, VirtualAnnotation[]>();
  for (const annotation of annotations) {
    const line = annotation.lineIndex as number;
    const lineAnnotations = grouped.get(line) ?? [];
    lineAnnotations.push(annotation);
    grouped.set(line, lineAnnotations);
  }
  return grouped;
}

function defaultAnchor(snapshot: DocumentSnapshot): { readonly ok: true; readonly value: ViewportAnchor } | { readonly ok: false; readonly error: LayoutFailure } {
  const offset = snapshot.lineStartOffset(lineIndex(0));
  if (!offset.ok) return readFailure(offset.error.kind);
  return { ok: true, value: Object.freeze({ documentVersion: snapshot.version, lineIndex: lineIndex(0), offset: offset.value, displayCellColumn: cellColumn(0) }) };
}

function lineRange(snapshot: DocumentSnapshot, line: LineIndex): { readonly ok: true; readonly value: { readonly start: Utf16Offset; readonly end: Utf16Offset } } | { readonly ok: false; readonly error: LayoutFailure } {
  const start = snapshot.lineStartOffset(line);
  if (!start.ok) return readFailure(start.error.kind);
  if ((line as number) + 1 < snapshot.lineCount) {
    const next = snapshot.lineStartOffset(lineIndex((line as number) + 1));
    if (!next.ok) return readFailure(next.error.kind);
    return { ok: true, value: { start: start.value, end: utf16Offset((next.value as number) - 1) } };
  }
  return { ok: true, value: { start: start.value, end: utf16Offset(snapshot.lengthUtf16) } };
}

interface VisibleText {
  readonly text: string;
  readonly complete: boolean;
}

function readVisibleLineText(
  snapshot: DocumentSnapshot,
  start: Utf16Offset,
  end: Utf16Offset,
  width: number,
  height: number,
): { readonly ok: true; readonly value: VisibleText } | { readonly ok: false; readonly error: LayoutFailure } {
  const remaining = (end as number) - (start as number);
  const usefulPrefix = Math.max(32, Math.min(MAX_SOURCE_PREFIX_UTF16, width * Math.max(1, height) * 4));
  let count = Math.min(remaining, usefulPrefix);
  let result = snapshot.slice(start, utf16Offset((start as number) + count));
  if (!result.ok && result.error.kind === 'surrogate-split' && count > 0) {
    count -= 1;
    result = snapshot.slice(start, utf16Offset((start as number) + count));
  }
  if (!result.ok) return { ok: false, error: { kind: 'snapshot-read-failed', reason: result.error.kind } };
  return { ok: true, value: { text: result.value, complete: count >= remaining } };
}

function lineCacheKey(
  text: string,
  width: number,
  rowBudget: number,
  wrap: boolean,
  tabSize: number,
  startCell: number,
  horizontalScroll: number,
  policy: CellWidthPolicy,
): string {
  return JSON.stringify([
    policy.id, policy.generation, width, rowBudget, wrap, tabSize, startCell, horizontalScroll, text,
  ]);
}

function shapeLine(
  text: string,
  width: number,
  rowBudget: number,
  wrap: boolean,
  tabSize: number,
  displayStart: number,
  horizontalScroll: number,
  policy: CellWidthPolicy,
  sourceTruncated: boolean,
  annotations: readonly RelativeAnnotation[] = [],
): { readonly ok: true; readonly value: RelativeLineLayout } | { readonly ok: false; readonly error: LayoutFailure } {
  const rows: { wrapIndex: number; displayStartCell: number; displayEndCell: number; startOffset: number; endOffset: number; cells: RelativeCell[] }[] = [];
  let logicalCell = displayStart;
  let screenColumn = 0;
  let wrapIndex = 0;
  let currentStartCell = displayStart;
  let currentStartOffset = 0;
  let currentEndOffset = 0;
  let current: RelativeCell[] = [];
  let stoppedAtRowLimit = false;
  let annotationIndex = 0;
  let nextAnnotationCell = 0;
  let priorClusters: readonly GraphemeCluster[] = [];
  try {
    priorClusters = splitGraphemes(text);
  } catch {
    return layoutFailure('invalid-viewport');
  }

  const pushRow = (): boolean => {
    if (rows.length >= rowBudget) return false;
    rows.push({
      wrapIndex,
      displayStartCell: currentStartCell,
      displayEndCell: logicalCell,
      startOffset: currentStartOffset,
      endOffset: currentEndOffset,
      cells: current,
    });
    wrapIndex += 1;
    current = [];
    screenColumn = 0;
    currentStartCell = logicalCell;
    currentStartOffset = currentEndOffset;
    return true;
  };

  const place = (cell: RelativeCell): boolean => {
    if (wrap && screenColumn >= width) {
      if (!pushRow()) return false;
    }
    if (wrap) {
      current.push(cell);
      screenColumn += 1;
    } else {
      const screen = logicalCell - horizontalScroll;
      if (screen >= 0 && screen < width) current[screen] = cell;
      screenColumn += 1;
    }
    logicalCell += 1;
    currentEndOffset = cell.offset + (cell.affinity === 'right' ? 0 : 0);
    return true;
  };

  const insertAnnotationsAt = (offset: number): { readonly ok: true } | { readonly ok: false; readonly error: LayoutFailure } => {
    while (annotationIndex < annotations.length) {
      const annotation = annotations[annotationIndex];
      if (annotation === undefined || annotation.offset !== offset) break;
      let clusters: readonly GraphemeCluster[];
      try {
        clusters = splitGraphemes(annotation.text);
      } catch {
        return layoutFailure('invalid-annotations');
      }
      for (const cluster of clusters) {
        let measured: number;
        try {
          measured = policy.widthOfCluster(cluster.text);
        } catch {
          return layoutFailure('invalid-annotations');
        }
        if (!Number.isSafeInteger(measured) || measured < 0 || measured > 2) return layoutFailure('invalid-annotations');
        const originalWidth = measured;
        if (measured === 0) measured = 1;
        if (wrap && measured > width) measured = 1;
        else if (wrap && measured > 0 && screenColumn > 0 && screenColumn + measured > width && !pushRow()) {
          stoppedAtRowLimit = true;
          return { ok: true };
        }
        const visibleColumn = wrap ? screenColumn : logicalCell - horizontalScroll;
        const clipped = originalWidth === 2 && (measured === 1 || (!wrap && (visibleColumn < 0 || visibleColumn + measured > width)));
        const visibleStart = wrap || (visibleColumn >= 0 && visibleColumn < width);
        if (visibleStart) {
          for (let cellIndex = 0; cellIndex < measured; cellIndex += 1) {
            const continuation = measured === 2 && cellIndex === 1;
            const screenColumnForCell = wrap ? screenColumn + cellIndex : logicalCell + cellIndex - horizontalScroll;
            if (!wrap && (screenColumnForCell < 0 || screenColumnForCell >= width)) continue;
            const part: VirtualAnnotationHitTarget['cellPart'] = clipped ? 'clipped'
              : continuation ? 'wide-continuation' : 'leading';
            const cell: RelativeCell = {
              kind: 'virtual-annotation',
              text: clipped ? ' ' : continuation ? '' : measured === 1 && originalWidth > 1 ? '?' : cluster.text,
              role: clipped ? 'clipped-glyph' : continuation ? 'virtual-annotation-continuation' : 'virtual-annotation',
              offset: annotation.offset,
              affinity: 'left',
              virtualCell: 0,
              displayCellColumn: logicalCell + cellIndex,
              annotationId: annotation.id,
              annotationCellIndex: nextAnnotationCell + cellIndex,
              annotationCellPart: part,
            };
            if (wrap) current.push(cell);
            else current[screenColumnForCell] = cell;
          }
        }
        if (wrap) screenColumn += measured;
        logicalCell += measured;
        nextAnnotationCell += measured;
      }
      annotationIndex += 1;
      nextAnnotationCell = 0;
      if (stoppedAtRowLimit) break;
    }
    return { ok: true };
  };

  for (const cluster of priorClusters) {
    const sourceOffset = cluster.start;
    const sourceEnd = cluster.end;
    const inserted = insertAnnotationsAt(sourceOffset);
    if (!inserted.ok) return inserted;
    if (stoppedAtRowLimit) break;
    const pendingAnnotation = annotations[annotationIndex];
    if (pendingAnnotation !== undefined && pendingAnnotation.offset > sourceOffset && pendingAnnotation.offset < cluster.end) {
      return layoutFailure('invalid-annotations');
    }
    currentEndOffset = sourceOffset;
    if (cluster.text === '\t') {
      const expansion = tabSize - (logicalCell % tabSize);
      for (let cellIndex = 0; cellIndex < expansion; cellIndex += 1) {
        if (wrap && screenColumn >= width && !pushRow()) {
          stoppedAtRowLimit = true;
          break;
        }
        const visible = wrap || (logicalCell - horizontalScroll >= 0 && logicalCell - horizontalScroll < width);
        if (visible) {
          const targetOffset = sourceOffset;
          const targetScreen = wrap ? screenColumn : logicalCell - horizontalScroll;
          if (!wrap) current[targetScreen] = {
            kind: 'text',
            text: ' ', role: 'tab-fill', offset: targetOffset, affinity: 'left',
            virtualCell: cellIndex, displayCellColumn: logicalCell,
          };
          else current.push({
            kind: 'text',
            text: ' ', role: 'tab-fill', offset: targetOffset, affinity: 'left',
            virtualCell: cellIndex, displayCellColumn: logicalCell,
          });
        }
        if (wrap) screenColumn += 1;
        logicalCell += 1;
        currentEndOffset = sourceEnd;
        if (!wrap && logicalCell - horizontalScroll >= width) {
          // The visible no-wrap slice is complete; remaining text cannot enter this frame.
          break;
        }
      }
      if (stoppedAtRowLimit) break;
      if (!wrap && logicalCell - horizontalScroll >= width) break;
      continue;
    }

    let measured: number;
    try {
      measured = policy.widthOfCluster(cluster.text);
    } catch {
      return layoutFailure('invalid-viewport');
    }
    if (!Number.isSafeInteger(measured) || measured < 0 || measured > 2) return layoutFailure('invalid-viewport');
    if (measured === 0) {
      const last = current.at(-1);
      if (last !== undefined && last.role === 'glyph') {
        current[current.length - 1] = { ...last, text: `${last.text}${cluster.text}` };
        currentEndOffset = sourceEnd;
        continue;
      }
      // A leading combining-only cluster has no base cell to occupy; make its location visible.
      measured = 1;
    }
    if (wrap && measured > width) {
      measured = 1;
    } else if (wrap && screenColumn > 0 && screenColumn + measured > width) {
      if (!pushRow()) {
        stoppedAtRowLimit = true;
        break;
      }
    }
    const targetOffset = sourceOffset;
    const visibleScreenColumn = wrap ? screenColumn : logicalCell - horizontalScroll;
    const clipped = measured === 2 && !wrap && (visibleScreenColumn < 0 || visibleScreenColumn + measured > width);
    const visibleStart = wrap || (visibleScreenColumn >= 0 && visibleScreenColumn < width);
    if (visibleStart) {
      let originalWidth = measured;
      try {
        originalWidth = policy.widthOfCluster(cluster.text);
      } catch {
        return layoutFailure('invalid-viewport');
      }
      const textValue = measured === 1 && originalWidth > 1 ? '?' : cluster.text;
      current.push({
        kind: 'text',
        text: clipped ? ' ' : textValue,
        role: clipped ? 'clipped-glyph' : 'glyph',
        offset: targetOffset,
        affinity: 'left',
        virtualCell: 0,
        displayCellColumn: logicalCell,
      });
    }
    if (measured === 2) {
      const secondLogicalCell = logicalCell + 1;
      const secondScreenColumn = wrap ? screenColumn + 1 : secondLogicalCell - horizontalScroll;
      const secondVisible = wrap || (secondScreenColumn >= 0 && secondScreenColumn < width);
      if (secondVisible) {
        current.push({
          kind: 'text',
          text: clipped ? ' ' : '',
          role: clipped ? 'clipped-glyph' : 'wide-continuation',
          offset: targetOffset,
          affinity: 'left',
          virtualCell: 0,
          displayCellColumn: secondLogicalCell,
        });
      }
      if (wrap) screenColumn += 2;
      logicalCell += 2;
    } else {
      if (wrap) screenColumn += 1;
      logicalCell += 1;
    }
    currentEndOffset = sourceEnd;
  }

  if (!stoppedAtRowLimit) {
    const inserted = insertAnnotationsAt(text.length);
    if (!inserted.ok) return inserted;
    if (annotationIndex < annotations.length) return layoutFailure('invalid-annotations');
  }

  if (rows.length < rowBudget && (current.length > 0 || rows.length === 0 || (!stoppedAtRowLimit && !sourceTruncated))) {
    rows.push({
      wrapIndex,
      displayStartCell: currentStartCell,
      displayEndCell: logicalCell,
      startOffset: currentStartOffset,
      endOffset: currentEndOffset,
      cells: current,
    });
  }
  const complete = !sourceTruncated && !stoppedAtRowLimit;
  return { ok: true, value: Object.freeze({ rows: Object.freeze(rows.map((row) => Object.freeze({ ...row, cells: Object.freeze(row.cells) }))), complete }) };
}

interface GraphemeCluster {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function splitGraphemes(text: string): readonly GraphemeCluster[] {
  const clusters: GraphemeCluster[] = [];
  let previousScalar = '';
  let start = 0;
  let offset = 0;
  let regionalCount = 0;
  for (const scalar of text) {
    const nextOffset = offset + scalar.length;
    if (offset === 0) {
      start = offset;
      regionalCount = isRegionalIndicator(scalar) ? 1 : 0;
    } else if (joinsCluster(previousScalar, scalar, regionalCount)) {
      if (isRegionalIndicator(scalar)) regionalCount += 1;
      else if (scalar !== '\u200d' && !isExtender(scalar)) regionalCount = 0;
    } else {
      clusters.push(Object.freeze({ text: text.slice(start, offset), start, end: offset }));
      start = offset;
      regionalCount = isRegionalIndicator(scalar) ? 1 : 0;
    }
    previousScalar = scalar;
    offset = nextOffset;
  }
  if (offset > 0) clusters.push(Object.freeze({ text: text.slice(start, offset), start, end: offset }));
  return Object.freeze(clusters);
}

function joinsCluster(previous: string, next: string, regionalCount: number): boolean {
  if (isExtender(next) || next === '\u200d' || previous === '\u200d') return true;
  return isRegionalIndicator(next) && regionalCount === 1;
}

function isExtender(value: string): boolean {
  return /\p{M}/u.test(value)
    || /\p{Emoji_Modifier}/u.test(value)
    || isVariationSelector(value)
    || isEmojiTag(value);
}

function isVariationSelector(value: string): boolean {
  const code = value.codePointAt(0) ?? 0;
  return (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef);
}

function isEmojiTag(value: string): boolean {
  const code = value.codePointAt(0) ?? 0;
  return code >= 0xe0020 && code <= 0xe007f;
}

function isRegionalIndicator(value: string): boolean {
  const code = value.codePointAt(0) ?? 0;
  return code >= 0x1f1e6 && code <= 0x1f1ff;
}

function defaultClusterWidth(cluster: string): number {
  if (cluster.length === 0) return 0;
  if (cluster.includes('\u200d') || /\p{Extended_Pictographic}/u.test(cluster)
    || /\p{Emoji_Modifier}/u.test(cluster) || /\uFE0F/u.test(cluster)
    || /\u20E3/u.test(cluster) || Array.from(cluster).filter(isRegionalIndicator).length >= 2) return 2;
  let width = 0;
  for (const scalar of cluster) {
    if (isExtender(scalar) || scalar === '\u200d') continue;
    const code = scalar.codePointAt(0) ?? 0;
    if (isWideCodePoint(code)) return 2;
    width = Math.max(width, 1);
  }
  return width;
}

function isWideCodePoint(code: number): boolean {
  return code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x20000 && code <= 0x3fffd)
  );
}

function materializeRows(
  layout: RelativeLineLayout,
  line: LineIndex,
  baseOffset: Utf16Offset,
  lineEnd: Utf16Offset,
  width: number,
): MaterializedRows {
  const output: ScreenRow[] = [];
  const positions = new PackedPositionIndex();
  for (let index = 0; index < layout.rows.length; index += 1) {
    const source = layout.rows[index];
    if (source === undefined) continue;
    const cells: ScreenCell[] = source.cells.slice(0, width).map((cell) => Object.freeze({
      text: cell.text,
      role: cell.role,
      target: cell.kind === 'virtual-annotation'
        ? Object.freeze({
          kind: 'virtual-annotation' as const,
          annotationId: cell.annotationId,
          lineIndex: line,
          anchorOffset: utf16Offset((baseOffset as number) + cell.offset),
          cellIndex: cell.annotationCellIndex,
          displayCellColumn: cellColumn(cell.displayCellColumn),
          cellPart: cell.annotationCellPart,
        })
        : Object.freeze({
          kind: 'text' as const,
          lineIndex: line,
          offset: utf16Offset((baseOffset as number) + cell.offset),
          affinity: cell.affinity,
          virtualCell: cell.virtualCell,
          displayCellColumn: cellColumn(cell.displayCellColumn),
          cellPart: textCellPart(cell.role),
        }),
    }));
    const endOffset = Math.min((baseOffset as number) + source.endOffset, lineEnd as number);
    const startOffset = Math.min((baseOffset as number) + source.startOffset, lineEnd as number);
    while (cells.length < width) {
      const relativeEnd = Math.max(0, source.endOffset);
      cells.push(Object.freeze({
        text: ' ',
        role: 'padding',
        target: Object.freeze({
          kind: 'text',
          lineIndex: line,
          offset: utf16Offset(Math.min((baseOffset as number) + relativeEnd, lineEnd as number)),
          affinity: 'right',
          virtualCell: 0,
          displayCellColumn: cellColumn(source.displayEndCell),
          cellPart: 'padding',
        }),
      }));
    }
    const row = Object.freeze({
      kind: 'text',
      lineIndex: line,
      wrapIndex: source.wrapIndex,
      displayStartCell: source.displayStartCell,
      displayEndCell: source.displayEndCell,
      startOffset: utf16Offset(startOffset),
      endOffset: utf16Offset(endOffset),
      cells: Object.freeze(cells),
      text: cells.map((cell) => cell.text).join(''),
    }) as ScreenRow;
    output.push(row);
    for (let column = 0; column < row.cells.length; column += 1) {
      const target = row.cells[column]?.target;
      if (target?.kind !== 'text') continue;
      const offset = target.offset as number;
      if (!positions.hasOffset(offset) || column === 0) {
        positions.setOffset(offset, index, column);
      }
      const displayLine = target.lineIndex as number;
      const displayColumn = target.displayCellColumn as number;
      if (!positions.hasDisplay(displayLine, displayColumn) || column === 0) {
        positions.setDisplay(displayLine, displayColumn, index, column);
      }
    }
    if (row.startOffset !== null) {
      const offset = row.startOffset as number;
      if (!positions.hasOffset(offset) || row.wrapIndex > 0) {
        positions.setOffset(offset, index, 0);
      }
    }
    if (row.endOffset !== null) {
      const offset = row.endOffset as number;
      const paddingColumn = row.cells.findIndex((cell) => cell.role === 'padding');
      const column = paddingColumn < 0 ? width : paddingColumn;
      if (!positions.hasOffset(offset) || column === 0) {
        positions.setOffset(offset, index, column);
      }
    }
  }
  return Object.freeze({
    rows: Object.freeze(output),
    positions,
    cellCost: output.reduce((total, row) => total + row.cells.length, 0),
  });
}

function buildFoldRow(
  snapshot: DocumentSnapshot,
  fold: FoldRegion,
  width: number,
): { readonly ok: true; readonly value: ScreenRow } | { readonly ok: false; readonly error: LayoutFailure } {
  const start = snapshot.lineStartOffset(fold.startLine);
  if (!start.ok) return readFailure(start.error.kind);
  const hidden = (fold.endLineExclusive as number) - (fold.startLine as number) - 1;
  const label = fold.placeholder ?? `… ${hidden} lines`;
  const cells: ScreenCell[] = Array.from(label).slice(0, width).map((text) => Object.freeze({
    text,
    role: 'fold-marker',
    target: Object.freeze({
      kind: 'fold' as const,
      foldId: fold.id,
      lineIndex: fold.startLine,
      startLine: fold.startLine,
      endLineExclusive: fold.endLineExclusive,
      offset: start.value,
    }),
  }));
  while (cells.length < width) {
    cells.push(Object.freeze({
      text: ' ', role: 'padding' as const,
      target: Object.freeze({
        kind: 'fold' as const,
        foldId: fold.id,
        lineIndex: fold.startLine,
        startLine: fold.startLine,
        endLineExclusive: fold.endLineExclusive,
        offset: start.value,
      }),
    }));
  }
  return {
    ok: true,
    value: Object.freeze({
      kind: 'fold',
      lineIndex: fold.startLine,
      wrapIndex: 0,
      displayStartCell: 0,
      displayEndCell: Math.min(width, Array.from(label).length),
      startOffset: start.value,
      endOffset: start.value,
      cells: Object.freeze(cells),
      text: cells.map((cell) => cell.text).join(''),
    }),
  };
}

function prependGutter(row: ScreenRow, gutterWidth: number): ScreenRow {
  if (gutterWidth === 0) return row;
  const line = row.lineIndex;
  if (line === null) return row;
  const lineNumber = row.wrapIndex === 0 ? String((line as number) + 1) : '';
  const visibleNumber = lineNumber.slice(-gutterWidth);
  const leftPadding = Math.max(0, gutterWidth - visibleNumber.length);
  const gutterCells: ScreenCell[] = [];
  for (let column = 0; column < gutterWidth; column += 1) {
    const labelColumn = column - leftPadding;
    const isLabel = labelColumn >= 0 && labelColumn < visibleNumber.length;
    gutterCells.push(Object.freeze({
      text: isLabel ? visibleNumber[labelColumn] ?? ' ' : ' ',
      role: 'gutter',
      target: Object.freeze({
        kind: 'gutter',
        lineIndex: line,
        wrapIndex: row.wrapIndex,
        gutterColumn: cellColumn(column),
        region: row.wrapIndex === 0 ? 'line-number' : 'continuation',
      }),
    }));
  }
  const cells = Object.freeze([...gutterCells, ...row.cells]);
  return Object.freeze({ ...row, cells, text: cells.map((cell) => cell.text).join('') });
}

function buildDiffFillerRow(filler: DiffFillerRow, width: number, ordinal: number): ScreenRow {
  const target: DiffFillerHitTarget = Object.freeze({
    kind: 'diff-filler',
    fillerId: filler.id,
    beforeLine: filler.beforeLine,
    ordinal,
  });
  const cells: ScreenCell[] = Array.from({ length: width }, () => Object.freeze({ text: ' ', role: 'diff-filler', target }));
  return Object.freeze({
    kind: 'diff-filler',
    lineIndex: null,
    wrapIndex: 0,
    displayStartCell: 0,
    displayEndCell: 0,
    startOffset: null,
    endOffset: null,
    cells: Object.freeze(cells),
    text: cells.map((cell) => cell.text).join(''),
  });
}

function textCellPart(role: ScreenCell['role']): TextHitTarget['cellPart'] {
  switch (role) {
    case 'wide-continuation': return 'wide-continuation';
    case 'tab-fill': return 'tab-fill';
    case 'clipped-glyph': return 'clipped-glyph';
    case 'padding': return 'padding';
    default: return 'glyph';
  }
}

function fillerRow(width: number): ScreenRow {
  const cells: ScreenCell[] = Array.from({ length: width }, () => Object.freeze({ text: ' ', role: 'filler', target: null }));
  return Object.freeze({
    kind: 'filler',
    lineIndex: null,
    wrapIndex: 0,
    displayStartCell: 0,
    displayEndCell: 0,
    startOffset: null,
    endOffset: null,
    cells: Object.freeze(cells),
    text: cells.map((cell) => cell.text).join(''),
  });
}

function projectSelections(
  snapshot: DocumentSnapshot,
  selection: SelectionSetSnapshot,
  rows: readonly ScreenRow[],
  positions: PackedPositionIndex,
  folds: readonly FoldRegion[],
): { readonly ok: true; readonly value: readonly ProjectedSelection[] } | { readonly ok: false; readonly error: LayoutFailure } {
  const projected: ProjectedSelection[] = [];
  for (const member of selection.members) {
    const anchor = projectEndpoint(snapshot, member.anchor, rows, positions, folds);
    if (!anchor.ok) return anchor;
    const head = projectEndpoint(snapshot, member.head, rows, positions, folds);
    if (!head.ok) return head;
    projected.push(Object.freeze({
      id: member.id,
      kind: member.kind,
      primary: member.id === selection.primaryId,
      direction: member.direction,
      desiredColumn: member.desiredColumn,
      anchor: anchor.value,
      head: head.value,
    }));
  }
  return { ok: true, value: Object.freeze(projected) };
}

function projectEndpoint(
  snapshot: DocumentSnapshot,
  endpoint: SelectionEndpoint,
  rows: readonly ScreenRow[],
  positions: PackedPositionIndex,
  folds: readonly FoldRegion[],
): { readonly ok: true; readonly value: ProjectedEndpoint } | { readonly ok: false; readonly error: LayoutFailure } {
  let offset = endpoint.at.offset;
  let line = endpoint.kind === 'line' || endpoint.kind === 'empty-line' || endpoint.kind === 'block-cell'
    ? endpoint.lineIndex
    : snapshot.lineIndexAt(offset);
  if (typeof line !== 'number' && !line.ok) return readFailure(line.error.kind);
  if (typeof line !== 'number') line = line.value;
  let displayColumn = endpoint.kind === 'block-cell'
    ? endpoint.displayCellColumn as number
    : findDisplayColumn(rows, line as LineIndex, offset as number);
  let relocatedByFold = false;
  const fold = foldContaining(folds, line as number);
  if (fold !== undefined) {
    const foldedRow = rows.findIndex((row) => row.kind === 'fold' && row.lineIndex === fold.startLine);
    if (foldedRow >= 0) {
      const target = rows[foldedRow]?.cells[0]?.target;
      if (target?.kind === 'fold') {
        offset = target.offset;
        line = fold.startLine;
        displayColumn = 0;
        relocatedByFold = true;
      }
    }
  }
  let position: CellPoint | null;
  if (endpoint.kind === 'block-cell') {
    position = positions.getDisplay(line as number, endpoint.displayCellColumn as number)
      ?? positionForDisplayCell(rows, line as LineIndex, endpoint.displayCellColumn as number);
  } else {
    position = lookupOffsetPosition(rows, positions, offset as number) ?? null;
  }
  return {
    ok: true,
    value: Object.freeze({
      kind: endpoint.kind,
      requestedOffset: endpoint.at.offset,
      projectedOffset: offset,
      lineIndex: line as LineIndex,
      displayCellColumn: cellColumn(Number.isSafeInteger(displayColumn) && displayColumn >= 0 ? displayColumn : 0),
      position,
      clipped: position === null,
      relocatedByFold,
      virtualCells: endpoint.kind === 'block-cell' ? endpoint.virtualCells : null,
    }),
  };
}

function findDisplayColumn(rows: readonly ScreenRow[], line: LineIndex, offset: number): number {
  for (const row of rows) {
    if (row.lineIndex !== line || row.kind !== 'text') continue;
    if ((row.startOffset as number) <= offset && offset <= (row.endOffset as number)) {
      if (offset === (row.endOffset as number)) return row.displayEndCell;
      const cell = row.cells.find((entry) => entry.target?.kind === 'text' && (entry.target.offset as number) === offset);
      if (cell?.target?.kind === 'text') return cell.target.displayCellColumn as number;
      let preceding: ScreenCell | undefined;
      for (const entry of row.cells) {
        if (entry.target?.kind === 'text' && (entry.target.offset as number) < offset) preceding = entry;
      }
      if (preceding?.target?.kind === 'text') return preceding.target.displayCellColumn as number;
      return row.displayStartCell;
    }
  }
  return 0;
}

function lookupOffsetPosition(rows: readonly ScreenRow[], positions: PackedPositionIndex, offset: number): CellPoint | undefined {
  const direct = positions.getOffset(offset);
  if (direct !== undefined) return direct;
  // Boundaries inside a grapheme cluster are visually projected to the cluster's
  // leading cell while retaining their distinct UTF-16 value in the read model.
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row?.kind !== 'text' || row.startOffset === null || row.endOffset === null
      || offset < (row.startOffset as number) || offset > (row.endOffset as number)) continue;
    let preceding: CellPoint | undefined;
    for (let column = 0; column < row.cells.length; column += 1) {
      const target = row.cells[column]?.target;
      if (target?.kind !== 'text') continue;
      if ((target.offset as number) > offset) break;
      preceding = Object.freeze({ row: rowIndex, column });
    }
    if (preceding !== undefined) return preceding;
  }
  return undefined;
}

function positionForDisplayCell(rows: readonly ScreenRow[], line: LineIndex, cell: number): CellPoint | null {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row?.lineIndex !== line || row.kind !== 'text') continue;
    const contentStartColumn = row.cells.findIndex((entry) => entry.target?.kind !== 'gutter');
    const contentStart = contentStartColumn < 0 ? 0 : contentStartColumn;
    const contentWidth = row.cells.length - contentStart;
    if (cell >= row.displayStartCell && cell < row.displayEndCell) {
      const target = row.cells.findIndex((entry) => entry.target?.kind === 'text' && entry.target.displayCellColumn === cell);
      if (target >= 0) return Object.freeze({ row: rowIndex, column: target });
    }
    if (cell === row.displayEndCell && !rows.some((candidate) => candidate.lineIndex === line && candidate.displayStartCell === cell && candidate.wrapIndex > row.wrapIndex)) {
      return Object.freeze({ row: rowIndex, column: Math.min(row.cells.length, contentStart + Math.min(contentWidth, row.displayEndCell - row.displayStartCell)) });
    }
  }
  return null;
}

function foldAt(folds: readonly FoldRegion[], line: number): FoldRegion | undefined {
  return folds.find((fold) => (fold.startLine as number) === line);
}

function foldContaining(folds: readonly FoldRegion[], line: number): FoldRegion | undefined {
  return folds.find((fold) => (fold.startLine as number) <= line && line < (fold.endLineExclusive as number));
}

function layoutFailure<K extends LayoutFailure['kind']>(kind: K): { readonly ok: false; readonly error: Extract<LayoutFailure, { readonly kind: K }> } {
  return { ok: false, error: { kind } as Extract<LayoutFailure, { readonly kind: K }> };
}

function readFailure(reason: string): { readonly ok: false; readonly error: LayoutFailure } {
  return { ok: false, error: { kind: 'snapshot-read-failed', reason } };
}

function lineIndex(value: number): LineIndex { return value as LineIndex; }
function utf16Offset(value: number): Utf16Offset { return value as Utf16Offset; }
function cellColumn(value: number): CellColumn { return value as CellColumn; }
