import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type SelectionId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { createSelectionSet } from '../../packages/selections/src/index';
import { ViewportLayout } from '../../packages/layout/src/index';

const documentId = identifier<DocumentId>('T111-packed-document');
const viewId = identifier<ViewId>('T111-packed-view');
const selectionId = identifier<SelectionId>('T111-packed-selection');

const created = TextFileDocument.create(
  documentId,
  Array.from({ length: 32 }, (_, index) => `line-${index} wide text`).join('\n'),
  Array.from({ length: 31 }, () => 'lf' as const),
  'lf',
);
assert.equal(created.ok, true, 'T111-PACKED-FRAME-01 fixture document opens');
if (!created.ok) throw new Error('T111-document');
const document = created.value;
const snapshot = document.snapshot();
const selection = createSelectionSet(snapshot, {
  primaryId: selectionId,
  members: [{
    id: selectionId,
    kind: 'normal-cursor',
    direction: 'forward',
    anchor: { kind: 'character', offset: 0 as never, after: 1 as never },
    head: { kind: 'character', offset: 0 as never, after: 1 as never },
  }],
});
assert.equal(selection.ok, true, 'T111-PACKED-FRAME-01 fixture selection opens');
if (!selection.ok) throw new Error('T111-selection');

const layout = new ViewportLayout();
const first = layout.project({
  viewId,
  snapshot,
  selection: selection.value.selectionSet,
  widthCells: 120,
  heightCells: 40,
});
assert.equal(first.ok, true, 'T111-PACKED-FRAME-01 first frame publishes');
if (!first.ok) throw new Error('T111-first-frame');

const firstLineOffset = snapshot.lineStartOffset(0 as never);
assert.equal(firstLineOffset.ok, true);
if (!firstLineOffset.ok) throw new Error('T111-first-offset');

for (let line = 1; line <= 12; line += 1) {
  const lineOffset = snapshot.lineStartOffset(line as never);
  assert.equal(lineOffset.ok, true, `T111-PACKED-FRAME-01 line ${line} has an anchor`);
  if (!lineOffset.ok) continue;
  const frame = layout.project({
    viewId,
    snapshot,
    selection: selection.value.selectionSet,
    widthCells: 120,
    heightCells: 4,
    anchor: {
      documentVersion: snapshot.version,
      lineIndex: line as never,
      offset: lineOffset.value,
      displayCellColumn: 0 as never,
    },
  });
  assert.equal(frame.ok, true, `T111-PACKED-FRAME-01 line ${line} publishes`);
}

const stats = layout.cacheStats;
assert.equal(stats.retainedFrames, 8, 'T111-PACKED-FRAME-01 frame leases are capped at eight retained generations');
assert.ok(stats.retainedMaterializedCells <= 40_000, 'T111-PACKED-FRAME-01 materialized cells remain within the cache cap');

const evicted = layout.positionForOffset(first.value.identity.frameId, firstLineOffset.value);
assert.equal(evicted.ok, false, 'T111-PACKED-FRAME-01 an old pointer cannot access an evicted frame');
if (!evicted.ok) assert.equal(evicted.error.kind, 'unknown-frame');

const current = layout.project({
  viewId,
  snapshot,
  selection: selection.value.selectionSet,
  widthCells: 120,
  heightCells: 4,
  anchor: {
    documentVersion: snapshot.version,
    lineIndex: 12 as never,
    offset: (() => {
      const result = snapshot.lineStartOffset(12 as never);
      if (!result.ok) throw new Error('T111-current-offset');
      return result.value;
    })(),
    displayCellColumn: 0 as never,
  },
});
assert.equal(current.ok, true, 'T111-PACKED-FRAME-01 current frame republishes');
if (current.ok) {
  const point = layout.positionForOffset(current.value.identity.frameId, current.value.anchor.offset);
  assert.equal(point.ok, true, 'T111-PACKED-FRAME-01 packed offset index resolves current geometry');
  if (point.ok) {
    const hit = layout.hitTest(current.value.identity.frameId, point.value);
    assert.equal(hit.ok, true, 'T111-PACKED-FRAME-01 packed geometry preserves hit targets');
    if (hit.ok) assert.equal(hit.value.target.kind, 'text');
  }
}

console.log('T111-PACKED-FRAME-01 passed: numeric hit geometry retains current semantics while frame and materialized caches stay bounded.');

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'fixture-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
