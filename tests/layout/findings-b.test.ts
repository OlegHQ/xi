import { strict as assert } from 'node:assert';
import { TextFileDocument } from '../../packages/document/src/index';
import { createSelectionSet, type SelectionSetSnapshot } from '../../packages/selections/src/index';
import {
  asIdentifier,
  type DocumentId,
  type LineIndex,
  type SelectionId,
  type UndoGroupId,
  type Utf16Offset,
  type ViewId,
} from '../../packages/primitives/src/index';
import { ViewportLayout, type VirtualAnnotation, type ViewportProjectionInput } from '../../packages/layout/src/index';
import { PackedPositionIndex } from '../../packages/layout/src/packed-index';

const viewId = identifier<ViewId>('findings-b-view');
const documentId = identifier<DocumentId>('findings-b-document');
const primaryId = identifier<SelectionId>('findings-b-primary');
const undoGroup = identifier<UndoGroupId>('findings-b-edit');

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'fixture-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function offset(value: number): Utf16Offset { return value as Utf16Offset; }

function editable(text: string): TextFileDocument {
  const lineEndings = Array.from({ length: [...text].filter((character) => character === '\n').length }, () => 'lf' as const);
  const created = TextFileDocument.create(documentId, text, lineEndings, 'lf');
  if (!created.ok) throw new Error(`fixture-document:${created.error.kind}`);
  return created.value;
}

function selectionAt(document: TextFileDocument, at = 0): SelectionSetSnapshot {
  const snapshot = document.snapshot();
  const end = snapshot.slice(offset(at), offset(at + 1));
  assert.equal(end.ok, true);
  const next = end.ok ? at + Math.max(1, end.value.length) : at + 1;
  const set = createSelectionSet(snapshot, {
    primaryId,
    members: [{
      id: primaryId,
      kind: 'normal-cursor',
      direction: 'forward',
      anchor: { kind: 'character', offset: offset(at), after: offset(next) },
      head: { kind: 'character', offset: offset(at), after: offset(next) },
    }],
  });
  if (!set.ok) throw new Error(`fixture-selection:${set.error.kind}`);
  return set.value.selectionSet;
}

function project(
  layout: ViewportLayout,
  document: TextFileDocument,
  widthCells: number,
  heightCells: number,
  selection: SelectionSetSnapshot,
  options: ViewportProjectionInput['options'] = {},
) {
  const input: ViewportProjectionInput = {
    viewId,
    snapshot: document.snapshot(),
    selection,
    widthCells,
    heightCells,
    options,
  };
  const result = layout.project(input);
  if (!result.ok) throw new Error(`layout:${result.error.kind}`);
  return result.value;
}

/**
 * B1: `cheapListFingerprint` used to key `geometryKey` on a list's length plus its
 * first and last entries only. Three annotations on the same line where only the
 * *middle* one's text changes (same ids, same offsets, same count, same first/last
 * entries) produced an unchanged geometryKey, so the second `project()` call hit
 * `#lastRows`/`#lastProjection` and served the first call's stale rendered text.
 */
function checkMiddleAnnotationChangeIsNeverStale(): void {
  const document = editable('0123456789');
  const version = document.snapshot().version;
  const annotations = (middleText: string): readonly VirtualAnnotation[] => [
    { id: 'ann-a', documentVersion: version, lineIndex: 0 as LineIndex, offset: offset(0), text: 'A' },
    { id: 'ann-mid', documentVersion: version, lineIndex: 0 as LineIndex, offset: offset(1), text: middleText },
    { id: 'ann-c', documentVersion: version, lineIndex: 0 as LineIndex, offset: offset(2), text: 'C' },
  ];
  const layout = new ViewportLayout();
  const selection = selectionAt(document, 0);
  const first = project(layout, document, 30, 3, selection, { virtualAnnotations: annotations('X') });
  assert.ok(first.rows[0]?.text.includes('X'), 'B1 sanity: first projection renders the initial middle annotation text');

  const second = project(layout, document, 30, 3, selection, { virtualAnnotations: annotations('Y') });
  assert.ok(second.rows[0]?.text.includes('Y'), 'B1-STALE-RENDER-01 a middle-only annotation text change must render the new text');
  assert.ok(!second.rows[0]?.text.includes('X'), 'B1-STALE-RENDER-01 the stale middle annotation text must not survive re-projection');
  console.log('B1-STALE-RENDER-01 passed: geometryKey now hashes every annotation entry, not just the first and last, so a middle-only change busts the cached rows.');
}

/**
 * B6: `DISPLAY_KEY_STRIDE` packed `line * stride + column` into one number, but the
 * old stride (1,048,576) was smaller than the maximum reachable display column
 * (tab expansion at the maximum tabSize of 32 over a 65,536-unit line, plus
 * annotation cells, ~2,228,224). A display column at or past the old stride on one
 * line collided with a low display column on the next line in the packed key,
 * silently overwriting or misreading a `setDisplay`/`getDisplay` entry.
 */
function checkDisplayKeyStrideHasNoCrossLineCollision(): void {
  const positions = new PackedPositionIndex();
  const overStrideColumn = 1_048_576 + 3; // exceeds the old stride, well within the new one
  positions.setDisplay(0, overStrideColumn, 1, 2);
  positions.setDisplay(1, 3, 9, 9);
  const lineZero = positions.getDisplay(0, overStrideColumn);
  const lineOne = positions.getDisplay(1, 3);
  assert.deepEqual(lineZero, { row: 1, column: 2 }, 'B6-DISPLAY-STRIDE-01 line 0 entry must not be overwritten by line 1');
  assert.deepEqual(lineOne, { row: 9, column: 9 }, 'B6-DISPLAY-STRIDE-01 line 1 entry must not read back line 0\'s value');
  console.log('B6-DISPLAY-STRIDE-01 passed: a tab-expansion-sized display column on one line no longer collides with a low column on the next line.');
}

checkMiddleAnnotationChangeIsNeverStale();
checkDisplayKeyStrideHasNoCrossLineCollision();
