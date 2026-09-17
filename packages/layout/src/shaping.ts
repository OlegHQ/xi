import type {
  CellColumn,
  DocumentSnapshot,
  DocumentVersion,
  LineIndex,
  Utf16Offset,
} from '../../document/src/index';
import type {
  CellWidthPolicy,
  DiffFillerHitTarget,
  DiffFillerRow,
  FoldRegion,
  GutterCells,
  LayoutFailure,
  RelativeAnnotation,
  RelativeCell,
  RelativeLineLayout,
  RelativeMaterializedCell,
  RelativeMaterializedRow,
  RelativeMaterializedRows,
  ScreenCell,
  ScreenRow,
  TextHitTarget,
  VirtualAnnotation,
  VirtualAnnotationHitTarget,
} from './types';
import type { PackedPositionIndex } from './packed-index';
import { type GraphemeCluster, splitGraphemes } from './graphemes';

const MAX_SOURCE_PREFIX_UTF16 = 65_536;
const MAX_LAYOUT_ANNOTATIONS = 4_096;
export const MAX_LAYOUT_ID_UTF16 = 256;
const MAX_LAYOUT_ANNOTATION_UTF16 = 256;
const MAX_LAYOUT_ANNOTATION_TOTAL_UTF16 = 65_536;
const MAX_DIFF_FILLER_ROWS = 4_096;

export function validateFolds(
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

export function validateAnnotations(
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

export function validateDiffFillerRows(
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

export function groupAnnotationsByLine(annotations: readonly VirtualAnnotation[]): ReadonlyMap<number, readonly VirtualAnnotation[]> {
  const grouped = new Map<number, VirtualAnnotation[]>();
  for (const annotation of annotations) {
    const line = annotation.lineIndex as number;
    const lineAnnotations = grouped.get(line) ?? [];
    lineAnnotations.push(annotation);
    grouped.set(line, lineAnnotations);
  }
  return grouped;
}

export function lineRange(snapshot: DocumentSnapshot, line: LineIndex): { readonly ok: true; readonly value: { readonly start: Utf16Offset; readonly end: Utf16Offset } } | { readonly ok: false; readonly error: LayoutFailure } {
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

export function readVisibleLineText(
  snapshot: DocumentSnapshot,
  start: Utf16Offset,
  end: Utf16Offset,
  width: number,
  height: number,
  wrap: boolean,
): { readonly ok: true; readonly value: VisibleText } | { readonly ok: false; readonly error: LayoutFailure } {
  const remaining = (end as number) - (start as number);
  // With wrap off a logical line always shapes to exactly one screen row (see
  // `shapeLine`'s wrap-guarded `pushRow` calls), so reading enough text for
  // `height` rows only inflates the read, the cache key and materialization cost.
  const effectiveHeight = wrap ? Math.max(1, height) : 1;
  const usefulPrefix = Math.max(32, Math.min(MAX_SOURCE_PREFIX_UTF16, width * effectiveHeight * 4));
  let count = Math.min(remaining, usefulPrefix);
  let result = snapshot.slice(start, utf16Offset((start as number) + count));
  if (!result.ok && result.error.kind === 'surrogate-split' && count > 0) {
    count -= 1;
    result = snapshot.slice(start, utf16Offset((start as number) + count));
  }
  if (!result.ok) return { ok: false, error: { kind: 'snapshot-read-failed', reason: result.error.kind } };
  return { ok: true, value: { text: result.value, complete: count >= remaining } };
}

/** Cheap 32-bit FNV-1a hash; collisions are ruled out by a real text equality check on hit. */
function hashLineText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Never embeds the up-to-`MAX_CACHED_LINE_UTF16` visible-line text directly: the key
 * is a hash plus the small shaping inputs, so `MAX_LINE_CACHE_ENTRIES` keys stay tiny
 * instead of carrying megabytes of duplicated line text. Callers must verify a hit
 * with a real string-equality check against the cached entry's retained text.
 */
export function lineCacheKey(
  text: string,
  width: number,
  rowBudget: number,
  wrap: boolean,
  tabSize: number,
  startCell: number,
  horizontalScroll: number,
  policy: CellWidthPolicy,
): string {
  return `${policy.id}|${policy.generation}|${width}|${rowBudget}|${wrap}|${tabSize}|${startCell}|${horizontalScroll}|`
    + `${text.length}|${hashLineText(text)}`;
}

export function shapeLine(
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

/**
 * Shapes one logical line's rows into a base-offset-independent template: width
 * slicing, padding sizing, role and hit-target-part derivation all happen exactly
 * once per distinct (text, width, wrap, tab, policy, annotations) combination and
 * are cached in `#materializedLines`. Absolute offsets are added later by
 * `rebaseMaterializedRows`, so the same template serves every base offset an edit
 * elsewhere in the document produces for this line.
 */
export function buildRelativeMaterializedRows(layout: RelativeLineLayout, width: number): RelativeMaterializedRows {
  const rows: RelativeMaterializedRow[] = [];
  let cellCost = 0;
  for (let index = 0; index < layout.rows.length; index += 1) {
    const source = layout.rows[index];
    if (source === undefined) continue;
    const cells: RelativeMaterializedCell[] = source.cells.slice(0, width).map((cell) => ({
      text: cell.text,
      role: cell.role,
      kind: cell.kind,
      relativeOffset: cell.offset,
      affinity: cell.affinity,
      virtualCell: cell.virtualCell,
      displayCellColumn: cell.displayCellColumn,
      cellPart: cell.kind === 'virtual-annotation' ? cell.annotationCellPart : textCellPart(cell.role),
      annotationId: cell.kind === 'virtual-annotation' ? cell.annotationId : null,
      annotationCellIndex: cell.kind === 'virtual-annotation' ? cell.annotationCellIndex : -1,
    }));
    const paddingCount = Math.max(0, width - cells.length);
    rows.push(Object.freeze({
      wrapIndex: source.wrapIndex,
      displayStartCell: source.displayStartCell,
      displayEndCell: source.displayEndCell,
      relativeStartOffset: source.startOffset,
      relativeEndOffset: source.endOffset,
      cells: Object.freeze(cells),
      paddingRelativeOffset: Math.max(0, source.endOffset),
      paddingCount,
      text: cells.map((cell) => cell.text).join('') + (paddingCount > 0 ? ' '.repeat(paddingCount) : ''),
    }));
    cellCost += cells.length + paddingCount;
  }
  return Object.freeze({ rows: Object.freeze(rows), cellCost });
}

/**
 * One cheap O(cells) pass that turns a content-only template into this frame's
 * absolute `ScreenRow`s: add `baseOffset`, clamp to `lineEnd`. No role, text-shape,
 * wide-glyph or annotation-matching work is redone here — all of that already
 * happened once in `buildRelativeMaterializedRows` and is reused as-is.
 * `contentKey` is stable across base-offset shifts for otherwise-identical rows.
 *
 * Neither the returned `ScreenRow`s, their `ScreenCell`s, nor a cell's `target` are
 * frozen here: every visible cell is rebuilt on every frame whenever an edit shifts
 * this row's absolute offsets (see the production-shape typing scenario in
 * `bench/layout/t014-viewport.ts`), so deep-freezing here was the dominant
 * self-time cost (~50% of `project()`, profiled with `bun --cpu-prof`) for
 * essentially no externally observed benefit: nothing reads `Object.isFrozen` on a
 * `ScreenRow` or `ScreenCell`, and a `target` is only required to be frozen for the
 * single cell `hitTest` actually returns (see `MP03-T085-IMMUTABLE-HIT-01` in
 * tests/layout/t085-hit-testing.test.ts), which `hitTest` now freezes on demand
 * instead of every one of ~10,000 visible cells eagerly freezing a target object
 * nobody looks at.
 *
 * Position entries are written straight into the caller's frame-level `positions`
 * index (`rowBase`/`columnBase` place this line's rows/columns within the full
 * frame) instead of building a throwaway per-line index that `project()` used to
 * copy, cell by cell, into the frame index afterward.
 */
export function rebaseMaterializedRows(
  template: RelativeMaterializedRows,
  line: LineIndex,
  baseOffset: Utf16Offset,
  lineEnd: Utf16Offset,
  width: number,
  contentKey: string,
  positions: PackedPositionIndex,
  rowBase: number,
  columnBase: number,
  needsDisplayIndex: boolean,
): readonly ScreenRow[] {
  const output: ScreenRow[] = [];
  for (let index = 0; index < template.rows.length; index += 1) {
    const source = template.rows[index];
    if (source === undefined) continue;
    const cells: ScreenCell[] = new Array(source.cells.length + source.paddingCount);
    for (let cellIndex = 0; cellIndex < source.cells.length; cellIndex += 1) {
      const cell = source.cells[cellIndex] as RelativeMaterializedCell;
      cells[cellIndex] = {
        text: cell.text,
        role: cell.role,
        target: cell.kind === 'virtual-annotation'
          ? {
            kind: 'virtual-annotation' as const,
            annotationId: cell.annotationId as string,
            lineIndex: line,
            anchorOffset: utf16Offset((baseOffset as number) + cell.relativeOffset),
            cellIndex: cell.annotationCellIndex,
            displayCellColumn: cellColumn(cell.displayCellColumn),
            cellPart: cell.cellPart as VirtualAnnotationHitTarget['cellPart'],
          }
          : {
            kind: 'text' as const,
            lineIndex: line,
            offset: utf16Offset((baseOffset as number) + cell.relativeOffset),
            affinity: cell.affinity,
            virtualCell: cell.virtualCell,
            displayCellColumn: cellColumn(cell.displayCellColumn),
            cellPart: cell.cellPart as TextHitTarget['cellPart'],
          },
      };
    }
    const paddingOffset = utf16Offset(Math.min((baseOffset as number) + source.paddingRelativeOffset, lineEnd as number));
    for (let padding = 0; padding < source.paddingCount; padding += 1) {
      cells[source.cells.length + padding] = {
        text: ' ',
        role: 'padding',
        target: {
          kind: 'text',
          lineIndex: line,
          offset: paddingOffset,
          affinity: 'right',
          virtualCell: 0,
          displayCellColumn: cellColumn(source.displayEndCell),
          cellPart: 'padding',
        },
      };
    }
    const endOffset = Math.min((baseOffset as number) + source.relativeEndOffset, lineEnd as number);
    const startOffset = Math.min((baseOffset as number) + source.relativeStartOffset, lineEnd as number);
    const row = {
      kind: 'text',
      lineIndex: line,
      wrapIndex: source.wrapIndex,
      displayStartCell: source.displayStartCell,
      displayEndCell: source.displayEndCell,
      startOffset: utf16Offset(startOffset),
      endOffset: utf16Offset(endOffset),
      cells,
      text: source.text,
      contentKey: `${contentKey}#${index}`,
    } as ScreenRow;
    output.push(row);
    const frameRow = rowBase + index;
    for (let column = 0; column < cells.length; column += 1) {
      const target = cells[column]?.target;
      if (target?.kind !== 'text') continue;
      const offset = target.offset as number;
      const frameColumn = columnBase + column;
      if (!positions.hasOffset(offset) || column === 0) {
        positions.setOffset(offset, frameRow, frameColumn);
      }
      if (needsDisplayIndex) {
        const displayLine = target.lineIndex as number;
        const displayColumn = target.displayCellColumn as number;
        if (!positions.hasDisplay(displayLine, displayColumn) || column === 0) {
          positions.setDisplay(displayLine, displayColumn, frameRow, frameColumn);
        }
      }
    }
    if (row.startOffset !== null) {
      const offset = row.startOffset as number;
      if (!positions.hasOffset(offset) || row.wrapIndex > 0) {
        positions.setOffset(offset, frameRow, columnBase);
      }
    }
    if (row.endOffset !== null) {
      const offset = row.endOffset as number;
      const paddingColumn = source.paddingCount > 0 ? source.cells.length : -1;
      const column = paddingColumn < 0 ? width : paddingColumn;
      if (!positions.hasOffset(offset) || column === 0) {
        positions.setOffset(offset, frameRow, columnBase + column);
      }
    }
  }
  return output;
}

export function buildFoldRow(
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
      contentKey: `fold:${fold.id}`,
    }),
  };
}

/**
 * Builds the gutter-label cells for one (line, wrapIndex, width) combination.
 * Frozen because these are cached by `withGutter` and reused across every frame the
 * label is unchanged, unlike the per-frame row/cell allocations in
 * `rebaseMaterializedRows`, so freezing them once is not a per-keystroke cost.
 */
export function buildGutterCells(line: LineIndex, wrapIndex: number, gutterWidth: number): GutterCells {
  const lineNumber = wrapIndex === 0 ? String((line as number) + 1) : '';
  const visibleNumber = lineNumber.slice(-gutterWidth);
  const leftPadding = Math.max(0, gutterWidth - visibleNumber.length);
  const gutterCells: ScreenCell[] = [];
  const cellTexts: string[] = [];
  for (let column = 0; column < gutterWidth; column += 1) {
    const labelColumn = column - leftPadding;
    const isLabel = labelColumn >= 0 && labelColumn < visibleNumber.length;
    const cellText = isLabel ? visibleNumber[labelColumn] ?? ' ' : ' ';
    cellTexts.push(cellText);
    gutterCells.push(Object.freeze({
      text: cellText,
      role: 'gutter',
      target: Object.freeze({
        kind: 'gutter',
        lineIndex: line,
        wrapIndex,
        gutterColumn: cellColumn(column),
        region: wrapIndex === 0 ? 'line-number' : 'continuation',
      }),
    }));
  }
  return Object.freeze({ cells: Object.freeze(gutterCells), text: cellTexts.join('') });
}

/**
 * Unlike `buildGutterCells`, this runs on every visible row every frame (the row
 * itself was just freshly rebased), so it stays unfrozen and avoids re-joining the
 * (cached, content-only) row text: see `rebaseMaterializedRows`'s comment on why
 * per-frame row/cell allocations here are deliberately not deep-frozen.
 */
export function prependGutter(row: ScreenRow, gutterWidth: number, gutter: GutterCells): ScreenRow {
  if (gutterWidth === 0) return row;
  if (row.lineIndex === null) return row;
  const cells = [...gutter.cells, ...row.cells];
  return {
    ...row,
    cells,
    text: gutter.text + row.text,
    contentKey: row.contentKey === null ? null : `${row.contentKey}|g:${gutterWidth}:${row.lineIndex}:${row.wrapIndex}`,
  };
}

export function buildDiffFillerRow(filler: DiffFillerRow, width: number, ordinal: number): ScreenRow {
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
    contentKey: `diff-filler:${filler.id}:${ordinal}`,
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

export function fillerRow(width: number): ScreenRow {
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
    contentKey: `filler:${width}`,
  });
}

export function layoutFailure<K extends LayoutFailure['kind']>(kind: K): { readonly ok: false; readonly error: Extract<LayoutFailure, { readonly kind: K }> } {
  return { ok: false, error: { kind } as Extract<LayoutFailure, { readonly kind: K }> };
}

export function readFailure(reason: string): { readonly ok: false; readonly error: LayoutFailure } {
  return { ok: false, error: { kind: 'snapshot-read-failed', reason } };
}

export function lineIndex(value: number): LineIndex { return value as LineIndex; }
export function utf16Offset(value: number): Utf16Offset { return value as Utf16Offset; }
export function cellColumn(value: number): CellColumn { return value as CellColumn; }
