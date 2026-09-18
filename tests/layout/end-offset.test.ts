import { strict as assert } from 'node:assert';
import {
  asIdentifier,
  type DocumentId,
  type LineIndex,
  type SelectionId,
  type Utf16Offset,
  type ViewId,
} from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { createSelectionSet } from '../../packages/selections/src/index';
import { ViewportLayout } from '../../packages/layout/src/index';

const documentId = identifier<DocumentId>('end-offset-document');
const viewId = identifier<ViewId>('end-offset-view');
const selectionId = identifier<SelectionId>('end-offset-selection');

function checkFullWidthRowEndOffsetClampsToLastCell(): void {
  // shaping.ts's endOffset marker used `width` (one past the last cell) whenever a row had no
  // padding cell (i.e. the line exactly fills the viewport width); there is no such column.
  const width = 10;
  const line = 'abcdefghij'; // exactly `width` characters: no padding cell on this row.
  const created = TextFileDocument.create(documentId, line, [], 'lf');
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const document = created.value;
  const snapshot = document.snapshot();
  const selection = gapSelection(snapshot);
  const layout = new ViewportLayout();
  const frame = layout.project({ viewId, snapshot, selection, widthCells: width, heightCells: 1, options: { wrap: false } });
  assert.equal(frame.ok, true);
  if (!frame.ok) return;
  assert.equal(frame.value.rows[0]?.cells.length, width, 'the fixture line exactly fills the row with no padding cell');
  const endPosition = layout.positionForOffset(frame.value.identity.frameId, width as Utf16Offset);
  assert.equal(endPosition.ok, true);
  if (!endPosition.ok) return;
  assert.equal(endPosition.value.column, width - 1, 'the exclusive end offset clamps to the last real cell, not one past it');
  console.log('END-OFFSET-FULL-WIDTH-ROW-01 passed: a full-width row\'s end offset clamps to its last cell.');
}

function checkBlockCellDisplayEndClampsToLastCell(): void {
  // viewport.ts's positionForDisplayCell had the same off-by-one for a block-cell endpoint whose
  // display column lands exactly at a full-width row's displayEndCell.
  const width = 10;
  const line = 'abcdefghij';
  const created = TextFileDocument.create(documentId, line, [], 'lf');
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const document = created.value;
  const snapshot = document.snapshot();
  const selection = createSelectionSet(snapshot, {
    primaryId: selectionId,
    members: [{
      id: selectionId,
      kind: 'visual-block',
      direction: 'forward',
      anchor: { kind: 'block-cell', offset: 0 as Utf16Offset, logicalUtf16Column: 0 as never, displayCellColumn: 0 as never, virtualCells: 0 },
      head: { kind: 'block-cell', offset: 0 as Utf16Offset, logicalUtf16Column: width as never, displayCellColumn: width as never, virtualCells: 0 },
    }],
  });
  assert.equal(selection.ok, true);
  if (!selection.ok) return;
  const layout = new ViewportLayout();
  const frame = layout.project({ viewId, snapshot, selection: selection.value.selectionSet, widthCells: width, heightCells: 1, options: { wrap: false } });
  assert.equal(frame.ok, true);
  if (!frame.ok) return;
  const head = frame.value.selections.find((member) => member.id === selectionId)?.head;
  assert.equal(head?.clipped, false, 'the virtual display column past a full-width line still resolves to a cell');
  assert.deepEqual(head?.position, { row: 0, column: width - 1 }, 'the block endpoint clamps to the last real cell, not one past it');
  console.log('END-OFFSET-BLOCK-CELL-ROW-01 passed: a block-cell endpoint at a full-width row\'s display end clamps to its last cell.');
}

function checkGeometryKeyDetectsChangedFoldsAtSameGeneration(): void {
  // The geometry cache key used to be JSON.stringify(folds.map(...)); replacing it with a cheap
  // length+first/last fingerprint must still tell two different single-fold sets apart even
  // under the same (possibly stale, caller-reused) foldGeneration -- and must not collide two
  // different single-element fingerprints via unescaped delimiters (e.g. an id containing ':').
  const created = TextFileDocument.create(documentId, 'zero\none\ntwo\nthree\nfour', ['lf', 'lf', 'lf', 'lf'], 'lf');
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const document = created.value;
  const snapshot = document.snapshot();
  const selection = gapSelection(snapshot);
  const layout = new ViewportLayout();
  const first = layout.project({
    viewId,
    snapshot,
    selection,
    widthCells: 12,
    heightCells: 8,
    options: {
      foldGeneration: 4,
      folds: [{ id: 'x:1', documentVersion: snapshot.version, startLine: 1 as LineIndex, endLineExclusive: 3 as LineIndex }],
    },
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = layout.project({
    viewId,
    snapshot,
    selection,
    widthCells: 12,
    heightCells: 8,
    options: {
      foldGeneration: 4,
      folds: [{ id: 'x', documentVersion: snapshot.version, startLine: 1 as LineIndex, endLineExclusive: 4 as LineIndex, placeholder: '5:' }],
    },
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  const secondFoldRow = second.value.rows.findIndex((row) => row.kind === 'fold');
  assert.equal(secondFoldRow, 1, 'the changed fold content publishes new geometry despite an unchanged foldGeneration');
  assert.equal(second.value.rows[1]?.text.startsWith('5:'), true, 'the new placeholder replaces the prior fold content');
  console.log('END-OFFSET-GEOMETRY-KEY-01 passed: the O(1) geometry-key fingerprint still distinguishes changed folds under a reused generation.');
}

function gapSelection(snapshot: { readonly id: DocumentId; readonly version: number }) {
  const result = createSelectionSet(snapshot as never, {
    primaryId: selectionId,
    members: [{
      id: selectionId,
      kind: 'insert-caret',
      direction: 'forward',
      anchor: { kind: 'gap', offset: 0 as Utf16Offset },
      head: { kind: 'gap', offset: 0 as Utf16Offset },
    }],
  });
  if (!result.ok) throw new Error(`fixture-selection:${result.error.kind}`);
  return result.value.selectionSet;
}

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'fixture-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

export function runEndOffsetChecks(): void {
  checkFullWidthRowEndOffsetClampsToLastCell();
  checkBlockCellDisplayEndClampsToLastCell();
  checkGeometryKeyDetectsChangedFoldsAtSameGeneration();
}

if (import.meta.main) runEndOffsetChecks();
