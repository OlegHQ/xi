import type {
  DocumentSnapshot,
  DocumentVersion,
  LineIndex,
  Utf16Offset,
  VersionedDocumentChange,
} from '../../document/src/index';
import type {
  SelectionEndpoint,
  SelectionSetSnapshot,
} from '../../selections/src/index';
import type {
  CellPoint,
  FoldRegion,
  FrameIdentity,
  GutterCells,
  LayoutCacheStats,
  LayoutFailure,
  LayoutFrameId,
  LayoutGeneration,
  LayoutHit,
  ProjectedEndpoint,
  ProjectedSelection,
  RelativeAnnotation,
  RelativeLineLayout,
  RelativeMaterializedRows,
  ScreenCell,
  ScreenRow,
  ViewportAnchor,
  ViewportProjectionInput,
  VisibleFrame,
} from './types';
import { PackedPositionIndex } from './packed-index';
import { DEFAULT_WIDTH_POLICY } from './graphemes';
import {
  MAX_LAYOUT_ID_UTF16,
  buildDiffFillerRow,
  buildFoldRow,
  buildGutterCells,
  buildRelativeMaterializedRows,
  cellColumn,
  fillerRow,
  groupAnnotationsByLine,
  layoutFailure,
  lineCacheKey,
  lineIndex,
  lineRange,
  prependGutter,
  readFailure,
  readVisibleLineText,
  rebaseMaterializedRows,
  shapeLine,
  validateAnnotations,
  validateDiffFillerRows,
  validateFolds,
} from './shaping';

/**
 * `#lineLayouts` entry. The map key is a cheap hash of the visible line text plus
 * its shaping inputs (see `lineCacheKey`/`hashLineCacheParts`), not the text itself,
 * so entries never carry up to `MAX_CACHED_LINE_UTF16` UTF-16 units of key string.
 * `text` is retained so a hit can be verified with a real equality check before the
 * hashed layout is reused, ruling out a hash collision.
 */
interface CachedLineLayout {
  readonly text: string;
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

const MAX_FRAME_HISTORY = 8;
const MAX_LINE_CACHE_ENTRIES = 512;
const MAX_MATERIALIZED_LINE_ENTRIES = 512;
/** Distinct (line, wrapIndex, gutterWidth) label sets retained by `withGutter`. */
const MAX_GUTTER_CACHE_ENTRIES = 4_096;
/**
 * Materialized-row templates are now keyed by content only (see `#materializedLines`),
 * so the same template is reused across every absolute base offset an edit produces
 * for a given line instead of being rebuilt and evicted every keystroke. Measured
 * with `process.memoryUsage().heapUsed` before/after warming ~4,900 distinct
 * single-row templates at 200 width + 6-cell gutter (`Bun.gc(true)` on both sides):
 * a frozen text-cell plus its frozen target costs ~293 bytes retained
 * (29,149,515 bytes / 99,328 cells). 200,000 cells is therefore ~57 MiB, covering a
 * 200x50 viewport (10,300 cells including gutter) plus tens of thousands of
 * scrolled-past template cells before eviction. The previous 40,000 bound was only
 * ~4 such viewports and, combined with the base-offset-keyed cache this replaces,
 * thrashed on every keystroke (see bench/layout/t014-viewport.ts's production-shape
 * scenario: pre-fix, 50 of 50 visible rows missed the materialized cache on every
 * keystroke with continuous evictions; post-fix, only the 1 actually-edited row misses).
 */
const MAX_MATERIALIZED_CELL_COST = 200_000;
const MAX_CACHED_LINE_UTF16 = 8_192;

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
  readonly #lineLayouts = new Map<string, CachedLineLayout>();
  readonly #materializedLines = new Map<string, RelativeMaterializedRows>();
  /** Gutter label cells keyed by (line, wrapIndex, gutterWidth); see `withGutter`. */
  readonly #gutterCells = new Map<string, GutterCells>();
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
    // Only visual-block selections ever query the display-column index (see
    // `projectEndpoint`'s `block-cell` branch); every other selection kind falls
    // through `positionForOffset`/offset lookups. Skipping `setDisplay` here avoids
    // indexing every visible cell's (line, displayColumn) — a second full-frame Map
    // write per cell — for a lookup that ordinary typing/motion never performs
    // (profiled with `bun --cpu-prof`: `setDisplay` was one of the two largest
    // remaining self-time contributors in the production-shape typing scenario, see
    // bench/layout/t014-viewport.ts).
    const needsDisplayIndex = selection.members.some((member) => member.kind === 'visual-block');
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
      const read = readVisibleLineText(snapshot, baseOffset, line.value.end, contentWidth, input.heightCells - rows.length, wrap);
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
      // rowBudget only caps how many wrapped rows one logical line may produce; with
      // wrap off every line always shapes to exactly one row regardless of how much
      // viewport remains (see shapeLine's wrap-guarded `pushRow` calls), so folding
      // it into the key when unwrapped only fragments the cache across scroll
      // positions without changing the cached shape.
      const cacheKey = lineCacheKey(prefix, contentWidth, wrap ? input.heightCells - rows.length : 1, wrap, tabSize,
        logicalDisplayStart, horizontalScrollCells, widthPolicy);
      const cacheableLine = canCache && lineAnnotations.length === 0;
      const cachedLineEntry = cacheableLine ? this.#lineLayouts.get(cacheKey) : undefined;
      const cacheHit = cachedLineEntry !== undefined && cachedLineEntry.text === prefix ? cachedLineEntry : undefined;
      let relative: RelativeLineLayout | undefined;
      if (cacheHit !== undefined) {
        relative = cacheHit.value;
        this.#lineCacheHits += 1;
        this.#lineLayouts.delete(cacheKey);
        this.#lineLayouts.set(cacheKey, cacheHit);
      } else {
        this.#lineCacheMisses += 1;
        const shaped = shapeLine(prefix, contentWidth, input.heightCells - rows.length, wrap, tabSize,
          logicalDisplayStart, horizontalScrollCells, widthPolicy, !read.value.complete, lineAnnotations);
        if (!shaped.ok) return shaped;
        relative = shaped.value;
        this.#rowsBuilt += relative.rows.length;
        if (cacheableLine) this.#cacheLine(cacheKey, prefix, relative);
      }
      if (!read.value.complete || !relative.complete) truncatedLongLine = true;
      const annotationsKey = JSON.stringify(lineAnnotations.map((annotation) => [annotation.id, annotation.offset, annotation.text]));
      // Content-only key: independent of `logicalLine`/`baseOffset`/`line.value.end`.
      // Editing an earlier line shifts every later line's absolute offsets without
      // changing its rendered glyphs, so the *template* below (built once per
      // distinct visible text) stays valid and reusable across that shift; only the
      // final absolute rebase below needs the per-call line/baseOffset/lineEnd.
      const materializedKey = `${cacheKey}|${annotationsKey}`;
      let template = this.#materializedLines.get(materializedKey);
      if (template !== undefined) {
        this.#materializedLineHits += 1;
        this.#materializedLines.delete(materializedKey);
        this.#materializedLines.set(materializedKey, template);
      } else {
        this.#materializedLineMisses += 1;
        template = buildRelativeMaterializedRows(relative, contentWidth);
        if (template.cellCost <= MAX_MATERIALIZED_CELL_COST) this.#cacheMaterializedLine(materializedKey, template);
      }
      const rowBase = rows.length;
      const materializedRows = rebaseMaterializedRows(
        template, lineIndex(logicalLine), baseOffset, line.value.end, contentWidth, materializedKey,
        positions, rowBase, gutterWidthCells, needsDisplayIndex,
      );
      for (let rowIndex = 0; rowIndex < materializedRows.length; rowIndex += 1) {
        const row = materializedRows[rowIndex];
        if (row === undefined || rows.length >= input.heightCells) break;
        rows.push(this.withGutter(row, gutterWidthCells));
      }
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

  /**
   * The gutter's line-number label only depends on (line, wrapIndex, gutterWidth),
   * never on which row object it is prepended to (that row is freshly allocated per
   * frame whenever an earlier edit shifts absolute offsets, even though the label
   * itself is unchanged), so this caches by that value key instead of row identity.
   */
  private withGutter(row: ScreenRow, gutterWidth: number): ScreenRow {
    if (gutterWidth === 0 || row.lineIndex === null) return row;
    const key = `${row.lineIndex}:${row.wrapIndex}:${gutterWidth}`;
    let gutterCells = this.#gutterCells.get(key);
    if (gutterCells === undefined) {
      gutterCells = buildGutterCells(row.lineIndex, row.wrapIndex, gutterWidth);
      this.#gutterCells.set(key, gutterCells);
      while (this.#gutterCells.size > MAX_GUTTER_CACHE_ENTRIES) {
        const oldest = this.#gutterCells.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.#gutterCells.delete(oldest);
      }
    }
    return prependGutter(row, gutterWidth, gutterCells);
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
    // `rebaseMaterializedRows` leaves a text/annotation/padding target unfrozen for
    // speed (see its comment); freeze the one target actually observed here rather
    // than every visible cell on every frame. Already-frozen targets (gutter, fold,
    // filler, diff-filler) make this a cheap no-op.
    return {
      ok: true,
      value: Object.freeze({ identity: stored.frame.identity, point: Object.freeze({ ...point }), target: Object.freeze(cell.target) }),
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
    this.#gutterCells.clear();
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

  #cacheLine(key: string, text: string, value: RelativeLineLayout): void {
    this.#lineLayouts.set(key, { text, value });
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

  #cacheMaterializedLine(key: string, value: RelativeMaterializedRows): void {
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

function defaultAnchor(snapshot: DocumentSnapshot): { readonly ok: true; readonly value: ViewportAnchor } | { readonly ok: false; readonly error: LayoutFailure } {
  const offset = snapshot.lineStartOffset(lineIndex(0));
  if (!offset.ok) return readFailure(offset.error.kind);
  return { ok: true, value: Object.freeze({ documentVersion: snapshot.version, lineIndex: lineIndex(0), offset: offset.value, displayCellColumn: cellColumn(0) }) };
}

/**
 * Cursor-following scroll anchor (docs/plan/01-architecture.md "Input, effects and
 * rendering"): clamps a stored `scrollTop` line to the document, then keeps the
 * primary selection's head line inside `[top, top + heightCells)` the way Vim does --
 * scroll up to the cursor line when it is above the viewport, or to
 * `cursor - heightCells + 1` when it is below. No scrolloff margin exists in this
 * codebase yet, so none is applied. Callers must report the returned `scrollTop`
 * back to the read model so scroll position and the rendered anchor never drift.
 */
export function resolveScrollAnchor(
  snapshot: DocumentSnapshot,
  selection: SelectionSetSnapshot,
  scrollTop: number,
  heightCells: number,
): { readonly ok: true; readonly value: { readonly anchor: ViewportAnchor; readonly scrollTop: number } } | { readonly ok: false; readonly error: LayoutFailure } {
  const lastLine = Math.max(0, snapshot.lineCount - 1);
  let top = Math.min(Math.max(0, Math.trunc(scrollTop)), lastLine);
  const primary = selection.members.find((member) => member.id === selection.primaryId);
  if (primary !== undefined) {
    const cursorLineResult = snapshot.lineIndexAt(primary.head.at.offset);
    if (cursorLineResult.ok) {
      const cursorLine = cursorLineResult.value as number;
      const visibleRows = Math.max(1, heightCells);
      if (cursorLine < top) top = cursorLine;
      else if (cursorLine > top + visibleRows - 1) top = Math.max(0, cursorLine - visibleRows + 1);
    }
  }
  const offset = snapshot.lineStartOffset(lineIndex(top));
  if (!offset.ok) return readFailure(offset.error.kind);
  return {
    ok: true,
    value: {
      anchor: Object.freeze({ documentVersion: snapshot.version, lineIndex: lineIndex(top), offset: offset.value, displayCellColumn: cellColumn(0) }),
      scrollTop: top,
    },
  };
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
