import type { LineIndex, CellColumn, Utf16Offset } from '../../document/src/index';
import { createSelectionSet } from '../../selections/src/index';
import type { ViewportProjectionInput, VisibleFrame, ScreenRow, ProjectedEndpoint } from './types';
import { ViewportLayout } from './viewport';

export interface ComparisonRow { readonly left: number | null; readonly right: number | null; readonly removed: boolean; readonly added: boolean; }

/** Shape only visible real rows with the standard Unicode/layout engine, then insert
 * noneditable alignment rows. Text hits retain their original document/version offsets. */
export function projectComparisonSide(layout: ViewportLayout, input: ViewportProjectionInput, rows: readonly ComparisonRow[], side: 'left' | 'right'): VisibleFrame | undefined {
  const first = rows.find(row => row[side] !== null)?.[side] ?? 0;
  const offset = input.snapshot.lineStartOffset(first as LineIndex);
  if (!offset.ok) return undefined;
  const empty = side === 'left' ? createSelectionSet(input.snapshot, { primaryId: input.selection.primaryId, selectionGeneration: 0, members: [{ id: input.selection.primaryId, kind: 'insert-caret', direction: 'forward', anchor: { kind: 'gap', offset: 0 as Utf16Offset }, head: { kind: 'gap', offset: 0 as Utf16Offset }, desiredColumn: { logicalUtf16: null, displayCell: null } }] }) : undefined;
  const projected = layout.project({ ...input, selection: empty?.ok ? empty.value.selectionSet : input.selection, heightCells: Math.max(1, rows.length), anchor: { documentVersion: input.snapshot.version, lineIndex: first as LineIndex, offset: offset.value, displayCellColumn: 0 as CellColumn } });
  if (!projected.ok) return undefined;
  const frame = projected.value;
  const byLine = new Map<number, ScreenRow>();
  for (const row of frame.rows) if (row.lineIndex !== null) byLine.set(row.lineIndex, row);
  const positions = new Map<number, number>();
  const output = rows.map((row, index): ScreenRow => {
    const line = row[side];
    const real = line === null ? undefined : byLine.get(line);
    if (real !== undefined) { positions.set(line!, index); return real; }
    return { kind: 'diff-filler', lineIndex: null, wrapIndex: 0, displayStartCell: 0, displayEndCell: 0, startOffset: null, endOffset: null, cells: [], text: '', contentKey: null };
  });
  const endpoint = (point: ProjectedEndpoint): ProjectedEndpoint => {
    const row = positions.get(point.lineIndex);
    return { ...point, position: row === undefined || point.position === null ? null : { ...point.position, row } };
  };
  return { ...frame, rows: output, heightCells: rows.length, selections: side === 'left' ? [] : frame.selections.map(selection => ({ ...selection, anchor: endpoint(selection.anchor), head: endpoint(selection.head) })) };
}
