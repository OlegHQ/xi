import { strict as assert } from 'node:assert';
import { createTestRenderer } from '@opentui/core/testing';
import { asIdentifier, asUndoGroupId, asUtf16Offset, type DocumentId, type SelectionId, type ViewId } from '../../packages/primitives/src/index';
import { openTextDocument, type DocumentReadPort, type DocumentSnapshot, type TextFileDocument } from '../../packages/document/src/index';
import { createSelectionSet } from '../../packages/selections/src/index';
import type { WorkbenchReadPort, WorkbenchViewSnapshot } from '../../packages/workbench/src/index';
import { WorkbenchRenderable, calculatePaintRanges } from '../../packages/ui/src/index';

const VIEW_ID = id<ViewId>('T123-PK-view');
const DOCUMENT_ID = id<DocumentId>('T123-PK-document');

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T123-PK-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function makeCursorView(snapshot: DocumentSnapshot, primary: SelectionId, offset: number, generation: number): WorkbenchViewSnapshot {
  const head = asUtf16Offset(offset);
  const after = asUtf16Offset(offset + 1);
  if (!head.ok || !after.ok) throw new Error(`T123-PK-offset:${offset}`);
  const selections = createSelectionSet(snapshot, {
    primaryId: primary,
    selectionGeneration: generation,
    members: [{ id: primary, kind: 'normal-cursor', direction: 'forward', anchor: { kind: 'character', offset: head.value, after: after.value }, head: { kind: 'character', offset: head.value, after: after.value } }],
  });
  if (!selections.ok) throw new Error(`T123-PK-selection:${selections.error.kind}`);
  return {
    session: { viewId: VIEW_ID, documentId: DOCUMENT_ID, documentVersion: snapshot.version, selections: selections.value.selectionSet, mode: 'normal' },
    document: snapshot,
    selections: selections.value.selectionSet,
    scrollTop: 0,
    scrollLeft: 0,
  };
}

/**
 * T123-PAINT-CONTENTKEY-01: typing on line 0 of a viewport must not repaint every row below it.
 * Before comparing `ScreenRow.contentKey` (packages/ui/src/workbench.ts's `calculatePaintRanges`,
 * packages/layout/src/index.ts's doc comment on `ScreenRow.contentKey`), a single-character
 * insertion shifted every later row's absolute `startOffset`/`endOffset`, producing a new row
 * object per row even though 49 of the 50 visible lines render identical glyphs -- the old
 * reference-identity diff marked the whole viewport dirty on every keystroke.
 */
async function testInsertOnFirstLineRepaintsFewRows(): Promise<void> {
  const lineCount = 60;
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i += 1) lines.push(`line${String(i).padStart(3, '0')} unchanged content`);
  const text = lines.join('\n');
  const opened = openTextDocument(DOCUMENT_ID, new TextEncoder().encode(text));
  if (opened.kind !== 'editable') throw new Error('T123-PK-document-open');
  let document: TextFileDocument = opened.document;
  let snapshot = document.snapshot();
  const primary = id<SelectionId>('T123-PK-primary');
  let generation = 0;
  let view = makeCursorView(snapshot, primary, 0, generation);
  const workbenchDocument: DocumentReadPort = {
    snapshot: () => snapshot,
    slice: (start, end, expectedVersion) => expectedVersion === snapshot.version
      ? snapshot.slice(start, end)
      : { ok: false, error: { kind: 'stale-version' } },
  };
  const workbench: WorkbenchReadPort = {
    activeViewId: VIEW_ID,
    readView: (viewId) => viewId === VIEW_ID ? view : undefined,
    readDocument: (viewId) => viewId === VIEW_ID ? workbenchDocument : undefined,
  };

  // Viewport height 50 (createTestRenderer's editorHeight runs 2 rows short of the
  // terminal height for the header/status rows -- see tests/ui/t111-render-scheduling).
  const setup = await createTestRenderer({ width: 80, height: 52, bufferedOutput: 'memory', gatherStats: true });
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, { workbench, fileLabel: 'editor.ts' });
  setup.renderer.root.add(viewport);
  await setup.renderOnce();
  assert.equal(viewport.layout.editorHeight, 50, 'T123-PK-00 fixture viewport is 50 rows tall');

  const before = viewport.lastFrame;
  assert.ok(before?.frame !== undefined && before.view !== undefined, 'T123-PK-01 an initial frame is projected');

  // Insert a single character at the very start of line 0.
  const group = asUndoGroupId('T123-PK-insert');
  if (!group.ok) throw new Error('T123-PK-group');
  const zero = asUtf16Offset(0);
  if (!zero.ok) throw new Error('T123-PK-zero-offset');
  const committed = document.commit({
    documentId: document.id,
    expectedVersion: document.version,
    edits: [{ start: zero.value, end: zero.value, text: 'X' }],
    origin: 'vim',
    undoGroup: group.value,
  });
  if (!committed.ok) throw new Error(`T123-PK-commit:${committed.error.kind}`);
  snapshot = document.snapshot();
  generation += 1;
  view = makeCursorView(snapshot, primary, 1, generation);

  viewport.refresh();
  await setup.flush();

  const after = viewport.lastFrame;
  assert.ok(after?.frame !== undefined && after.view !== undefined, 'T123-PK-02 a frame is projected after the edit');

  const ranges = calculatePaintRanges(before, after!.frame!, after!.view!, undefined, undefined, false);
  const repaintedRows = ranges.reduce((sum, range) => sum + (range.end - range.start), 0);
  assert.ok(repaintedRows <= 2, `T123-PK-03 inserting on line 0 repaints <=2 rows, got ${repaintedRows} (ranges=${JSON.stringify(ranges)})`);

  setup.renderer.destroy();
}

await testInsertOnFirstLineRepaintsFewRows();
console.log('T123 paint contentKey passed: an edit on line 0 of a 50-row viewport repaints <=2 rows, not the whole viewport');
