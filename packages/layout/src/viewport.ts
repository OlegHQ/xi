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
  CellWidthPolicy,
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
import { DEFAULT_WIDTH_POLICY, splitGraphemes } from './graphemes';
import {
  MAX_LAYOUT_ID_UTF16,
  MAX_SOURCE_PREFIX_UTF16,
  buildDiffFillerRow,
  buildFoldRow,
  buildGutterCells,
  buildRebasedRows,
  buildRelativeMaterializedRows,
  cellColumn,
  fillerRow,
  groupAnnotationsByLine,
  gutterLayoutWidth,
  indexRebasedRows,
  layoutFailure,
  lineCacheKey,
  lineIndex,
  lineRange,
  prependGutter,
  readFailure,
  readVisibleLineText,
  shapeLine,
  utf16Offset,
  validateAnnotations,
  validateDiffFillerRows,
  validateFolds,
} from './shaping';
import { DEFAULT_GUTTER_LAYOUT, type GutterType } from './types';

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

/**
 * Rows/positions cached by `geometryKey` alone (text, dimensions, scroll, folds,
 * style generation, etc. -- everything except `selectionGeneration`). A cursor
 * motion that changes only the selection reuses this instead of re-materializing
 * every visible row; only `projectSelections` reruns against the cached rows.
 */
interface CachedRowsProjection {
  readonly key: string;
  readonly anchor: ViewportAnchor;
  readonly rows: readonly ScreenRow[];
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
/**
 * Cache lines up to what `readVisibleLineText`/`shapeLine` actually read
 * (`MAX_SOURCE_PREFIX_UTF16`), not an arbitrary smaller cap: lines between the old
 * 8,192-unit cap and the 65,536-unit read cap were shaped every frame and never
 * cached. Retained bytes are bounded separately by `MAX_LINE_CACHE_UTF16_UNITS`
 * below, since 512 entries at 65,536 units each would be ~64 MiB.
 */
const MAX_CACHED_LINE_UTF16 = MAX_SOURCE_PREFIX_UTF16;
/**
 * Absolute `ScreenRow`s reused by exact `(contentKey, baseOffset, lineEnd)` --
 * separate from `#materializedLines`' content-only templates, which still need the
 * per-frame absolute rebase this tier skips for a repeat. Same order of magnitude
 * as `MAX_MATERIALIZED_CELL_COST`: it retains the same shape of data (rebuilt
 * absolute cells instead of relative ones), just for the subset of lines whose
 * exact absolute placement recurs across frames -- e.g. every visible line above
 * an edit made on a line below it, whose own absolute offsets never move.
 */
const MAX_REBASED_ROW_CELL_COST = 200_000;
/**
 * Byte budget for `#lineLayouts`' retained `text` (the cache key is a hash, not the
 * text -- see `CachedLineLayout`). 1,048,576 UTF-16 units * 2 bytes/unit = 2 MiB,
 * a modest slice of the workspace-wide layout-cache budget alongside the
 * materialized-row, gutter and frame caches. At the
 * 65,536-unit-per-line worst case this still retains 16 such lines before evicting;
 * ordinary short lines fill far more entries within the same byte budget.
 */
const MAX_LINE_CACHE_UTF16_UNITS = 1_048_576;

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
  /** Absolute rebased rows keyed by `(materializedKey, baseOffset, lineEnd)`; see `MAX_REBASED_ROW_CELL_COST`. */
  readonly #rebasedRows = new Map<string, { readonly rows: readonly ScreenRow[]; readonly cellCost: number }>();
  /** Gutter label cells keyed by (line, wrapIndex, gutterWidth); see `withGutter`. */
  readonly #gutterCells = new Map<string, GutterCells>();
  /**
   * `fillerRow(width)` is a pure function of `width` (a filler row carries no offset
   * or content), but was rebuilt -- `width` frozen cells plus the frozen row itself --
   * on every below-EOF/past-content row of every frame. `width` is bounded by
   * `validDimension` (<=2,000), so this never grows past a couple of thousand tiny
   * entries even across every distinct viewport width ever projected.
   */
  readonly #fillerRows = new Map<number, ScreenRow>();
  #materializedCellCost = 0;
  #rebasedRowCellCost = 0;
  #lineCacheUtf16Units = 0;
  #lineCacheHits = 0;
  #lineCacheMisses = 0;
  #lineCacheEvictions = 0;
  #rowsBuilt = 0;
  #frameCacheHits = 0;
  #rowsCacheHits = 0;
  #materializedLineHits = 0;
  #materializedLineMisses = 0;
  #materializedLineEvictions = 0;
  #lastProjection: CachedViewportProjection | undefined;
  #lastRows: CachedRowsProjection | undefined;
  /** The exact frame object handed back for the most recent `projectionKey`, so an
   * immediate repeat call (see the fast-path check in `project()`) returns the same
   * reference instead of a fresh allocation with a bumped `frameId`. */
  #lastReturnedFrame: { readonly key: string; readonly frame: VisibleFrame } | undefined;

  get cacheStats(): LayoutCacheStats {
    return Object.freeze({
      frameCacheHits: this.#frameCacheHits,
      rowsCacheHits: this.#rowsCacheHits,
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
      || someStoredFrame(this.#frames, (stored) => stored.frame.identity.documentId === snapshot.id);
    if (shouldTrackVersion && (knownVersion === undefined || (snapshot.version as number) > (knownVersion as number))) {
      this.#documentVersions.set(documentKey, snapshot.version);
      this.#trimDocumentVersions();
    }
    if (selection.documentVersion !== snapshot.version) return layoutFailure('stale-document-version');
    if (!validDimension(input.widthCells) || !validDimension(input.heightCells)
      || input.widthCells * input.heightCells > 250_000) return layoutFailure('invalid-viewport');

    const options = input.options ?? {};
    const wrap = options.wrap ?? true;
    const wrapWidth = options.wrapWidth;
    const wrapIndicator = options.wrapIndicator ?? '';
    const maxWrap = options.maxWrap ?? 20;
    const maxIndentRetain = options.maxIndentRetain ?? 40;
    const tabSize = options.tabSize ?? 8;
    const horizontalScrollCells = options.horizontalScrollCells ?? 0;
    const widthPolicy = options.widthPolicy ?? DEFAULT_WIDTH_POLICY;
    const folds = options.folds ?? [];
    const foldGeneration = options.foldGeneration ?? 0;
    const gutterWidthCells = options.gutterWidthCells ?? 0;
    const gutterLayout: readonly GutterType[] = options.gutterLayout ?? (options.gutterLineNumberWidth === undefined ? (gutterWidthCells === 0 ? Object.freeze([] as GutterType[]) : Object.freeze(['line-numbers', 'spacer'] as GutterType[])) : DEFAULT_GUTTER_LAYOUT);
    const gutterLineNumberWidth = options.gutterLineNumberWidth ?? (gutterLayout.includes('line-numbers') ? Math.max(0, gutterWidthCells - 1) : 0);
    const lineNumberMode = options.lineNumberMode ?? 'absolute';
    const relativeLineNumberCursor = options.relativeLineNumberCursor;
    if (!Number.isSafeInteger(tabSize) || tabSize < 1 || tabSize > 32
      || (wrapWidth !== undefined && (!Number.isSafeInteger(wrapWidth) || wrapWidth < 1 || wrapWidth > input.widthCells))
      || !Number.isSafeInteger(maxWrap) || maxWrap < 0 || maxWrap > 65_535
      || !Number.isSafeInteger(maxIndentRetain) || maxIndentRetain < 0 || maxIndentRetain > 65_535
      || typeof wrapIndicator !== 'string' || wrapIndicator.length > 64 || /[\r\n\t]/u.test(wrapIndicator)
      || !Number.isSafeInteger(horizontalScrollCells) || horizontalScrollCells < 0
      || !Number.isSafeInteger(gutterWidthCells) || gutterWidthCells < 0 || gutterWidthCells >= input.widthCells
      || !Number.isSafeInteger(gutterLineNumberWidth) || gutterLineNumberWidth < 0 || gutterLineNumberWidth > input.widthCells
      || gutterLayout.length > 32 || gutterLayout.some((gutter) => gutter !== 'diagnostics' && gutter !== 'spacer' && gutter !== 'line-numbers' && gutter !== 'diff' && gutter !== 'code-action-hint')
      || gutterLayoutWidth(gutterLineNumberWidth, gutterLayout) !== gutterWidthCells
      || !Number.isSafeInteger(widthPolicy.generation) || widthPolicy.generation < 0
      || typeof widthPolicy.id !== 'string' || widthPolicy.id.length === 0 || widthPolicy.id.length > MAX_LAYOUT_ID_UTF16
      || typeof widthPolicy.widthOfCluster !== 'function'
      || (lineNumberMode !== 'absolute' && lineNumberMode !== 'relative')
      || (relativeLineNumberCursor !== undefined && (!Number.isSafeInteger(relativeLineNumberCursor) || relativeLineNumberCursor < 0 || relativeLineNumberCursor >= snapshot.lineCount))
      || !Number.isSafeInteger(foldGeneration) || foldGeneration < 0) {
      return layoutFailure('invalid-viewport');
    }
    const validFolds = validateFolds(folds, snapshot.lineCount, snapshot.version);
    if (!validFolds.ok) return validFolds;
    const annotationsResult = validateAnnotations(options.virtualAnnotations ?? [], snapshot);
    if (!annotationsResult.ok) return annotationsResult;
    const diffFillersResult = validateDiffFillerRows(options.diffFillerRows ?? [], snapshot);
    if (!diffFillersResult.ok) return diffFillersResult;
    const viewportContentWidth = input.widthCells - gutterWidthCells;
    const contentWidth = wrap && wrapWidth !== undefined ? Math.min(viewportContentWidth, wrapWidth) : viewportContentWidth;
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

    // A plain delimited join of cheap, O(1) fingerprints -- not JSON.stringify over
    // folds.map/annotations.map, which walked and serialized every entry on every project()
    // call. `foldGeneration` is the caller's own cache-busting counter, kept as a fast-path
    // discriminator, but a caller can reuse a stale generation for changed fold content (see
    // MP03-T085-FOLD-GEOMETRY-COLLISION-01), so a length + first/last fingerprint of the actual
    // folds is still included, same as annotations/diff fillers which have no counter at all.
    const geometryKey = [
      input.viewId,
      snapshot.id,
      snapshot.version,
      input.widthCells,
      input.heightCells,
      effectiveAnchor.lineIndex,
      effectiveAnchor.offset,
      effectiveAnchor.displayCellColumn,
      wrap,
      wrapWidth,
      maxWrap,
      maxIndentRetain,
      tabSize,
      horizontalScrollCells,
      widthPolicy.id,
      widthPolicy.generation,
      foldGeneration,
      cheapListFingerprint(folds, (fold) => [fold.id, fold.startLine, fold.endLineExclusive, fold.placeholder]),
      gutterWidthCells,
      gutterLineNumberWidth,
      gutterLayout.join(','),
      lineNumberMode,
      relativeLineNumberCursor,
      cheapListFingerprint(annotationsResult.value, (annotation) => [annotation.id, annotation.lineIndex, annotation.offset, annotation.text]),
      cheapListFingerprint(diffFillersResult.value, (filler) => [filler.id, filler.beforeLine]),
    ].join('|');
    if (geometryKey !== this.#lastGeometryKey) {
      this.#layoutGeneration += 1;
      this.#lastGeometryKey = geometryKey;
    }
    // Plain string concatenation, not JSON.stringify: geometryKey is already a
    // string and selectionGeneration a number, so a delimited template is a cheap
    // equivalent key without allocating through the JSON machinery on every call.
    const projectionKey = `${geometryKey} ${selection.selectionGeneration}`;
    // A repeat call with input identical to the immediately preceding one (e.g. the
    // second render pass of a double-flush key, or a redundant re-render) changes
    // nothing an already-returned frame doesn't already represent. Returning that
    // same object -- same frameId, same identity -- instead of allocating a new one
    // lets identity-keyed caches downstream (e.g. `canPaintPlainFrameCached`'s
    // WeakMap) keep hitting instead of missing on every such repeat.
    if (this.#lastReturnedFrame?.key === projectionKey) {
      this.#frameCacheHits += 1;
      return { ok: true, value: this.#lastReturnedFrame.frame };
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
      this.#lastReturnedFrame = { key: projectionKey, frame };
      return { ok: true, value: frame };
    }

    // Same geometry (text, dimensions, scroll, folds, style generation, ...) but a
    // different selection -- e.g. plain cursor motion. Reuse the already-built rows
    // and position index instead of re-materializing every visible row; only the
    // selection projection below needs to rerun.
    if (this.#lastRows?.key === geometryKey) {
      this.#rowsCacheHits += 1;
      const cachedRows = this.#lastRows;
      const projectedSelections = projectSelections(snapshot, selection, cachedRows.rows, cachedRows.positions, folds);
      if (!projectedSelections.ok) return projectedSelections;
      const frame: VisibleFrame = Object.freeze({
        identity,
        widthCells: input.widthCells,
        heightCells: input.heightCells,
        anchor: cachedRows.anchor,
        rows: cachedRows.rows,
        selections: projectedSelections.value,
        truncatedLongLine: cachedRows.truncatedLongLine,
      });
      this.#lastProjection = Object.freeze({
        key: projectionKey,
        anchor: cachedRows.anchor,
        rows: cachedRows.rows,
        selections: projectedSelections.value,
        positions: cachedRows.positions,
        truncatedLongLine: cachedRows.truncatedLongLine,
      });
      this.#currentFrameId = frameId;
      this.#currentDocumentKey = documentKey;
      this.#documentVersions.set(documentKey, snapshot.version);
      this.#frames.set(frameId as number, { frame, positions: cachedRows.positions });
      this.#trimFrames();
      this.#lastReturnedFrame = { key: projectionKey, frame };
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
        rows.push(this.withGutter(foldRow.value, gutterWidthCells, gutterLineNumberWidth, gutterLayout, lineNumberMode, relativeLineNumberCursor));
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
      // With wrap off and a large horizontal scroll, reading/shaping from the true
      // line start out past `horizontalScrollCells` display cells (below) walked
      // every cluster from column 0 every frame just to throw the off-screen prefix
      // away. When that skipped prefix is plain printable ASCII (no tabs, so
      // column === utf16 offset), the source offset of the first visible column is
      // known for free: skip reading straight to it instead, so the read below only
      // ever pulls the actually-visible window (plus its own row budget). `effDisplayStart`
      // (the display column the read text now starts at) is passed to `shapeLine` in
      // place of `logicalDisplayStart`, but `horizontalScrollCells` itself is passed
      // through unchanged -- `shapeLine`'s `screen = logicalCell - horizontalScroll`
      // still needs the *global* scroll offset to place cells at the right screen
      // column; only how much of that offset the read has to cover (`readScrollWidth`
      // below) shrinks. Mixed ASCII/non-ASCII lines fall through unskipped (`effBaseOffset`/
      // `effDisplayStart` stay at the line origin, `readScrollWidth` stays the full
      // `horizontalScrollCells`), which remains fully correct, just not fast.
      let effBaseOffset = baseOffset;
      let effDisplayStart = logicalDisplayStart;
      let readScrollWidth = horizontalScrollCells;
      if (!wrap && horizontalScrollCells > 0 && logicalDisplayStart === 0) {
        const lineLength = (line.value.end as number) - (baseOffset as number);
        const skip = Math.min(horizontalScrollCells, lineLength);
        if (skip > 0) {
          const skipEnd = utf16Offset((baseOffset as number) + skip);
          const ascii = snapshot.isPrintableAsciiRange?.(baseOffset, skipEnd);
          if (ascii !== undefined && ascii.ok && ascii.value) {
            effBaseOffset = skipEnd;
            effDisplayStart = skip;
            readScrollWidth = horizontalScrollCells - skip;
          }
        }
      }
      // Include the remaining `readScrollWidth` in the requested width: with wrap
      // off, the visible slice starts that many display cells further into
      // `effBaseOffset` (see `shapeLine`'s `screen = logicalCell - horizontalScroll`),
      // so reading only `contentWidth` worth of source text would truncate before
      // ever reaching the scrolled-to columns, leaving the caret's cell unplaced.
      const read = readVisibleLineText(snapshot, effBaseOffset, line.value.end, contentWidth + readScrollWidth, input.heightCells - rows.length, wrap);
      if (!read.ok) return read;
      const prefix = read.value.text;
      const lineAnnotations = (annotationsByLine.get(logicalLine) ?? []).flatMap((annotation) => {
        const absoluteOffset = annotation.offset as number;
        const relativeOffset = absoluteOffset - (effBaseOffset as number);
        const withinRead = relativeOffset < prefix.length || (relativeOffset === prefix.length && read.value.complete);
        return relativeOffset >= 0 && withinRead
          ? [{ id: annotation.id, offset: relativeOffset, text: annotation.text, ...(annotation.background === undefined ? {} : { background: annotation.background }) } satisfies RelativeAnnotation]
          : [];
      });
      const startsAtLineOrigin = effBaseOffset === line.value.start && effDisplayStart === 0;
      const canCache = startsAtLineOrigin && prefix.length <= MAX_CACHED_LINE_UTF16 && read.value.complete;
      // rowBudget only caps how many wrapped rows one logical line may produce; with
      // wrap off every line always shapes to exactly one row regardless of how much
      // viewport remains (see shapeLine's wrap-guarded `pushRow` calls), so folding
      // it into the key when unwrapped only fragments the cache across scroll
      // positions without changing the cached shape.
      const cacheKey = lineCacheKey(prefix, contentWidth, wrap ? input.heightCells - rows.length : 1, wrap, tabSize,
        effDisplayStart, horizontalScrollCells, widthPolicy, wrapIndicator, maxWrap, maxIndentRetain);
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
          effDisplayStart, horizontalScrollCells, widthPolicy, !read.value.complete, lineAnnotations, wrapIndicator, maxWrap, maxIndentRetain);
        if (!shaped.ok) return shaped;
        relative = shaped.value;
        this.#rowsBuilt += relative.rows.length;
        if (cacheableLine) this.#cacheLine(cacheKey, prefix, relative);
      }
      if (!read.value.complete || !relative.complete) truncatedLongLine = true;
      const annotationsKey = lineAnnotations.length === 0 ? '' : JSON.stringify(lineAnnotations.map((annotation) => [annotation.id, annotation.offset, annotation.text, annotation.background ?? '']));
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
      // Keyed by exact absolute placement, not just content: unlike `#materializedLines`
      // (content-only template), a hit here skips rebuilding the absolute `ScreenRow`/
      // `ScreenCell` objects entirely (see `buildRebasedRows`'s comment) -- only
      // `indexRebasedRows` below still has to run, since `positions` is fresh per frame.
      const rebasedKey = `${materializedKey}|${effBaseOffset}|${line.value.end}`;
      let rebasedEntry = this.#rebasedRows.get(rebasedKey);
      if (rebasedEntry === undefined) {
        const built = buildRebasedRows(template, lineIndex(logicalLine), effBaseOffset, line.value.end, materializedKey);
        let cellCost = 0;
        for (const builtRow of built) cellCost += builtRow.cells.length;
        rebasedEntry = { rows: built, cellCost };
        if (cellCost <= MAX_REBASED_ROW_CELL_COST) this.#cacheRebasedRows(rebasedKey, rebasedEntry);
      } else {
        this.#rebasedRows.delete(rebasedKey);
        this.#rebasedRows.set(rebasedKey, rebasedEntry);
      }
      const materializedRows = rebasedEntry.rows;
      indexRebasedRows(template, materializedRows, contentWidth, positions, rowBase, gutterWidthCells, needsDisplayIndex);
      for (let rowIndex = 0; rowIndex < materializedRows.length; rowIndex += 1) {
        const row = materializedRows[rowIndex];
        if (row === undefined || rows.length >= input.heightCells) break;
        rows.push(this.withGutter(row, gutterWidthCells, gutterLineNumberWidth, gutterLayout, lineNumberMode, relativeLineNumberCursor));
      }
      if (rows.length >= input.heightCells || (wrap && !relative.complete)) break;
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
      rows.push(this.#fillerRow(input.widthCells));
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
    this.#lastRows = Object.freeze({
      key: geometryKey,
      anchor: effectiveAnchor,
      rows: frame.rows,
      positions,
      truncatedLongLine,
    });
    this.#currentFrameId = frameId;
    this.#currentDocumentKey = documentKey;
    this.#documentVersions.set(documentKey, snapshot.version);
    this.#frames.set(frameId as number, { frame, positions });
    this.#trimFrames();
    this.#lastReturnedFrame = { key: projectionKey, frame };
    return { ok: true, value: frame };
  }

  /**
   * The gutter's line-number label only depends on (line, wrapIndex, gutterWidth),
   * never on which row object it is prepended to (that row is freshly allocated per
   * frame whenever an earlier edit shifts absolute offsets, even though the label
   * itself is unchanged), so this caches by that value key instead of row identity.
   */
  private withGutter(row: ScreenRow, gutterWidth: number, lineNumberWidth: number, gutterLayout: readonly GutterType[], lineNumberMode: 'absolute' | 'relative', relativeLineNumberCursor?: number): ScreenRow {
    if (gutterWidth === 0 || row.lineIndex === null) return row;
    const key = `${row.lineIndex}:${row.wrapIndex}:${gutterWidth}:${lineNumberWidth}:${gutterLayout.join(',')}:${lineNumberMode}:${relativeLineNumberCursor ?? ''}`;
    let gutterCells = this.#gutterCells.get(key);
    if (gutterCells === undefined) {
      gutterCells = buildGutterCells(row.lineIndex, row.wrapIndex, gutterWidth, lineNumberWidth, gutterLayout, lineNumberMode, relativeLineNumberCursor);
      this.#gutterCells.set(key, gutterCells);
      while (this.#gutterCells.size > MAX_GUTTER_CACHE_ENTRIES) {
        const oldest = this.#gutterCells.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.#gutterCells.delete(oldest);
      }
    }
    return prependGutter(row, gutterWidth, gutterCells, gutterLayout.join(','));
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
      || someStoredFrame(this.#frames, (stored) => stored.frame.identity.documentId === change.documentId);
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
    this.#rebasedRows.clear();
    this.#gutterCells.clear();
    this.#fillerRows.clear();
    this.#materializedCellCost = 0;
    this.#rebasedRowCellCost = 0;
    this.#lineCacheUtf16Units = 0;
    this.#currentFrameId = null;
    this.#lastGeometryKey = '';
    this.#lastProjection = undefined;
    this.#lastRows = undefined;
    this.#lastReturnedFrame = undefined;
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
    this.#lineCacheUtf16Units += text.length;
    while (this.#lineLayouts.size > MAX_LINE_CACHE_ENTRIES || this.#lineCacheUtf16Units > MAX_LINE_CACHE_UTF16_UNITS) {
      const oldest = this.#lineLayouts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const evicted = this.#lineLayouts.get(oldest);
      this.#lineLayouts.delete(oldest);
      if (evicted !== undefined) this.#lineCacheUtf16Units -= evicted.text.length;
      this.#lineCacheEvictions += 1;
    }
  }

  #fillerRow(width: number): ScreenRow {
    let row = this.#fillerRows.get(width);
    if (row === undefined) {
      row = fillerRow(width);
      this.#fillerRows.set(width, row);
    }
    return row;
  }

  #cacheRebasedRows(key: string, value: { readonly rows: readonly ScreenRow[]; readonly cellCost: number }): void {
    this.#rebasedRows.set(key, value);
    this.#rebasedRowCellCost += value.cellCost;
    while (this.#rebasedRows.size > MAX_MATERIALIZED_LINE_ENTRIES || this.#rebasedRowCellCost > MAX_REBASED_ROW_CELL_COST) {
      const oldestKey = this.#rebasedRows.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.#rebasedRows.get(oldestKey);
      this.#rebasedRows.delete(oldestKey);
      if (oldest !== undefined) this.#rebasedRowCellCost -= oldest.cellCost;
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

/** `frames.values().some(...)` without the interim array `project()`/`observeDocumentChange` used to allocate per call. */
function someStoredFrame(frames: ReadonlyMap<number, StoredFrame>, predicate: (stored: StoredFrame) => boolean): boolean {
  for (const stored of frames.values()) {
    if (predicate(stored)) return true;
  }
  return false;
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
 * Cursor-following scroll anchor (docs/architecture.md "Input, effects and
 * rendering"): clamps a stored `scrollTop` line to the document, then keeps the
 * primary selection's head line inside `[top, top + heightCells)` the way Vim does --
 * scroll up to the cursor line plus the configured top margin when it is too close
 * to the viewport edge, or to the corresponding bottom-margin position. The
 * asymmetric margins match Helix: `scrolloff` is capped independently at half the
 * viewport, leaving at least one line between the margins. Callers must report the returned `scrollTop`
 * back to the read model so scroll position and the rendered anchor never drift.
 *
 * `scrollLeft` follows the same rule horizontally over the primary head's display
 * column when wrapping is disabled. Wrapped rows reset horizontal scrolling because
 * their screen columns are derived from the wrapped row start.
 * Callers must feed the returned `scrollLeft` back as `options.horizontalScrollCells`
 * on the following `project()` call and report it back to the read model exactly
 * like `scrollTop`.
 */
export function resolveScrollAnchor(
  snapshot: DocumentSnapshot,
  selection: SelectionSetSnapshot,
  scrollTop: number,
  heightCells: number,
  widthCells: number,
  scrollLeft: number,
  options?: { readonly tabSize?: number; readonly widthPolicy?: CellWidthPolicy; readonly scrolloff?: number; readonly wrap?: boolean },
): { readonly ok: true; readonly value: { readonly anchor: ViewportAnchor; readonly scrollTop: number; readonly scrollLeft: number } } | { readonly ok: false; readonly error: LayoutFailure } {
  const lastLine = Math.max(0, snapshot.lineCount - 1);
  const visibleRows = Math.max(1, heightCells);
  const visibleColumns = Math.max(1, widthCells);
  const configuredScrolloff = options?.scrolloff ?? 0;
  const scrolloff = Number.isSafeInteger(configuredScrolloff) && configuredScrolloff >= 0 ? configuredScrolloff : 0;
  const scrolloffTop = Math.min(scrolloff, Math.floor(Math.max(0, visibleRows - 1) / 2));
  const scrolloffBottom = Math.min(scrolloff, Math.floor(visibleRows / 2));
  const scrolloffLeft = Math.min(scrolloff, Math.floor(Math.max(0, visibleColumns - 1) / 2));
  const scrolloffRight = Math.min(scrolloff, Math.floor(visibleColumns / 2));
  const maxTop = Math.max(0, lastLine - visibleRows + 1);
  let top = Math.min(Math.max(0, Math.trunc(scrollTop)), maxTop);
  let left = options?.wrap === true ? 0 : Math.max(0, Math.trunc(scrollLeft));
  const primary = selection.members.find((member) => member.id === selection.primaryId);
  if (primary !== undefined) {
    const cursorLineResult = snapshot.lineIndexAt(primary.head.at.offset);
    if (cursorLineResult.ok) {
      const cursorLine = cursorLineResult.value as number;
      if (cursorLine < top + scrolloffTop) top = Math.max(0, cursorLine - scrolloffTop);
      else if (cursorLine + scrolloffBottom >= top + visibleRows) top = Math.min(maxTop, Math.max(0, cursorLine - visibleRows + scrolloffBottom + 1));

      const lineStart = snapshot.lineStartOffset(lineIndex(cursorLine));
      if (lineStart.ok && options?.wrap !== true) {
        const headColumn = measureDisplayColumn(
          snapshot, lineStart.value, primary.head.at.offset,
          options?.tabSize ?? 8, options?.widthPolicy ?? DEFAULT_WIDTH_POLICY,
        );
        if (headColumn !== undefined) {
          const lastVisibleColumn = left + visibleColumns - 1;
          if (headColumn < left + scrolloffLeft) left = Math.max(0, headColumn - scrolloffLeft);
          else if (headColumn > lastVisibleColumn - scrolloffRight) left += headColumn - (lastVisibleColumn - scrolloffRight);
        }
      }
    }
  }
  const offset = snapshot.lineStartOffset(lineIndex(top));
  if (!offset.ok) return readFailure(offset.error.kind);
  return {
    ok: true,
    value: {
      anchor: Object.freeze({ documentVersion: snapshot.version, lineIndex: lineIndex(top), offset: offset.value, displayCellColumn: cellColumn(0) }),
      scrollTop: top,
      scrollLeft: left,
    },
  };
}

/**
 * Last `measureDisplayColumn` result for one (document, version, lineStart), so a
 * later call for a larger offset on the same line -- the common case, the primary
 * head advancing rightward one grapheme per keystroke -- only measures the new
 * delta text instead of rescanning the whole prefix from column 0 every time.
 * Module-level rather than per-`ViewportLayout` since `resolveScrollAnchor` is a
 * free function with no instance to hang state off; a stale/mismatched entry is
 * simply ignored (see the guard below), never returned as-is.
 */
let displayColumnMemo: {
  readonly documentId: string;
  readonly version: number;
  readonly lineStart: number;
  readonly offset: number;
  readonly column: number;
} | undefined;

/**
 * Display-cell column of `targetOffset` within the line starting at `lineStart`,
 * mirroring `shapeLine`'s unwrapped column advance (tab stops plus per-cluster
 * width) without materializing any cells -- only used to keep the horizontal
 * scroll anchor over the cursor. `undefined` on an unreadable slice or invalid
 * cluster width; callers then leave `scrollLeft` unchanged.
 */
function measureDisplayColumn(
  snapshot: DocumentSnapshot,
  lineStart: Utf16Offset,
  targetOffset: Utf16Offset,
  tabSize: number,
  widthPolicy: CellWidthPolicy,
): number | undefined {
  const lineStartNum = lineStart as number;
  const targetNum = targetOffset as number;
  if (targetNum <= lineStartNum) return 0;

  // Fast path: printable ASCII (0x20-0x7e) has no tabs, no combining marks and no
  // wide glyphs, so under the default width policy every unit is exactly one
  // display column -- column === utf16 length, no grapheme split or width lookup
  // needed at all. `isPrintableAsciiRange` is a cheap bounded classification, not a
  // second full read+scan (see packages/document/src/contracts.ts).
  if (widthPolicy === DEFAULT_WIDTH_POLICY) {
    const ascii = snapshot.isPrintableAsciiRange?.(lineStart, targetOffset);
    if (ascii !== undefined && ascii.ok && ascii.value) return targetNum - lineStartNum;
  }

  const documentId = snapshot.id as string;
  const version = snapshot.version as number;
  const memo = displayColumnMemo;
  if (memo !== undefined && memo.documentId === documentId && memo.version === version && memo.lineStart === lineStartNum) {
    if (memo.offset === targetNum) return memo.column;
    if (memo.offset < targetNum) {
      const column = measureDisplayColumnFrom(snapshot, memo.offset, targetNum, memo.column, tabSize, widthPolicy);
      if (column !== undefined) {
        displayColumnMemo = { documentId, version, lineStart: lineStartNum, offset: targetNum, column };
      }
      return column;
    }
  }
  const column = measureDisplayColumnFrom(snapshot, lineStartNum, targetNum, 0, tabSize, widthPolicy);
  if (column !== undefined) {
    displayColumnMemo = { documentId, version, lineStart: lineStartNum, offset: targetNum, column };
  }
  return column;
}

function measureDisplayColumnFrom(
  snapshot: DocumentSnapshot,
  fromOffset: number,
  toOffset: number,
  startColumn: number,
  tabSize: number,
  widthPolicy: CellWidthPolicy,
): number | undefined {
  const prefix = snapshot.slice(utf16Offset(fromOffset), utf16Offset(toOffset));
  if (!prefix.ok) return undefined;
  let column = startColumn;
  let clusters: readonly { readonly text: string }[];
  try {
    clusters = splitGraphemes(prefix.value);
  } catch {
    return undefined;
  }
  for (const cluster of clusters) {
    if (cluster.text === '\t') {
      column += tabSize - (column % tabSize);
      continue;
    }
    let measured: number;
    try {
      measured = widthPolicy.widthOfCluster(cluster.text);
    } catch {
      return undefined;
    }
    if (!Number.isSafeInteger(measured) || measured < 0 || measured > 2) return undefined;
    column += measured === 0 ? 0 : measured;
  }
  return column;
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
  let relocatedByFold = false;
  const fold = foldContaining(folds, line as number);
  if (fold !== undefined) {
    const foldedRow = rows.findIndex((row) => row.kind === 'fold' && row.lineIndex === fold.startLine);
    if (foldedRow >= 0) {
      const target = rows[foldedRow]?.cells[0]?.target;
      if (target?.kind === 'fold') {
        offset = target.offset;
        line = fold.startLine;
        relocatedByFold = true;
      }
    }
  }
  // B5: `findDisplayColumn` used to linearly scan every row (twice through its
  // cells, once to `.find` an exact match and once for the preceding-cell fallback)
  // per endpoint per frame, even on the `#lastRows` cache-hit path. `positions`
  // already indexes every recorded offset to its (row, column) in O(1) (see
  // `indexRebasedRows`), so `projectedTextPosition` below reads the display column
  // straight off that cell instead of a fresh scan -- same result, since a
  // `PackedPositionIndex` hit for `offset` always lands on the same cell
  // `findDisplayColumn`'s scan would have found (see its comment for the one
  // special case -- an offset that lands exactly on `row.endOffset` -- handled the
  // same way here).
  let displayColumn: number;
  let position: CellPoint | null;
  if (endpoint.kind === 'block-cell') {
    displayColumn = endpoint.displayCellColumn as number;
    position = positions.getDisplay(line as number, endpoint.displayCellColumn as number)
      ?? positionForDisplayCell(rows, line as LineIndex, endpoint.displayCellColumn as number);
  } else if (relocatedByFold) {
    displayColumn = 0;
    position = lookupOffsetPosition(rows, positions, offset as number) ?? null;
  } else {
    const projected = projectedTextPosition(rows, positions, offset as number);
    displayColumn = projected.displayColumn;
    position = projected.position;
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

/**
 * Position and display column for a non-block-cell, non-fold-relocated endpoint,
 * derived together from one `lookupOffsetPosition` lookup (O(1) via `positions` on
 * the common path) instead of `findDisplayColumn`'s separate full-row-and-cell scan.
 */
function projectedTextPosition(
  rows: readonly ScreenRow[],
  positions: PackedPositionIndex,
  offset: number,
): { readonly position: CellPoint | null; readonly displayColumn: number } {
  const point = lookupOffsetPosition(rows, positions, offset);
  if (point === undefined) return { position: null, displayColumn: 0 };
  const row = rows[point.row];
  if (row === undefined || row.kind !== 'text') return { position: point, displayColumn: 0 };
  if (offset === (row.endOffset as number)) return { position: point, displayColumn: row.displayEndCell };
  const target = row.cells[point.column]?.target;
  const displayColumn = target?.kind === 'text' ? (target.displayCellColumn as number) : row.displayStartCell;
  return { position: point, displayColumn };
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
      const raw = contentStart + Math.min(contentWidth, row.displayEndCell - row.displayStartCell);
      // A row with no padding cell has no column past its last real cell; a padded row's first
      // padding cell (role === 'padding') sits exactly at displayEndCell and is the right target.
      const paddingColumn = row.cells.findIndex((entry) => entry.role === 'padding');
      const column = raw < row.cells.length ? raw : paddingColumn >= 0 ? paddingColumn : Math.max(row.cells.length - 1, 0);
      return Object.freeze({ row: rowIndex, column });
    }
  }
  return null;
}

/**
 * Cache-key fingerprint for a list: length plus a rolling FNV-1a hash over every
 * entry's JSON-encoded fingerprint (`hashLineText` style, see shaping.ts), not just
 * the first and last -- a length+first+last fingerprint let a middle-entry-only
 * change (e.g. a fold/annotation/filler text edit with the same count, first and
 * last) collide with the previous geometryKey and serve a stale `#lastRows`/
 * `#lastProjection` frame. A per-entry hash mix (rather than one JSON.stringify over
 * the whole mapped list) keeps this from re-allocating a large string every call.
 */
function cheapListFingerprint<T>(list: readonly T[], fingerprint: (item: T) => unknown): string {
  if (list.length === 0) return '0';
  let hash = 0x811c9dc5;
  for (const item of list) {
    const part = JSON.stringify(fingerprint(item));
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    // Mix a boundary marker between entries so ['ab','c'] and ['a','bc'] hash differently.
    hash = Math.imul(hash ^ 0x9e3779b9, 0x01000193);
  }
  return `${list.length}:${(hash >>> 0).toString(36)}`;
}

function foldAt(folds: readonly FoldRegion[], line: number): FoldRegion | undefined {
  return folds.find((fold) => (fold.startLine as number) === line);
}

function foldContaining(folds: readonly FoldRegion[], line: number): FoldRegion | undefined {
  return folds.find((fold) => (fold.startLine as number) <= line && line < (fold.endLineExclusive as number));
}
