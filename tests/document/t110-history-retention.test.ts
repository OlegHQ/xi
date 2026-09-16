import { strict as assert } from 'node:assert';
import { asIdentifier, asUndoGroupId, type DocumentId, type UndoGroupId, type Utf16Offset } from '../../packages/primitives/src/index';
import { LineEndingSequence, TextFileDocument } from '../../packages/document/src/index';

const idResult = asIdentifier<DocumentId>('T110-history-retention', 'documentId');
const documentId: DocumentId = idResult.ok
  ? idResult.value
  : (() => { throw new Error(idResult.error.message); })();

function group(value: string): UndoGroupId {
  const result = asUndoGroupId(value);
  if (!result.ok) throw new Error(`invalid-group:${value}`);
  return result.value;
}

function create(text: string): TextFileDocument {
  const result = TextFileDocument.create(documentId, text, LineEndingSequence.fromUniform(countLineFeeds(text), 'lf'), 'lf');
  if (!result.ok) throw new Error(`document-create-failed:${result.error.kind}`);
  return result.value;
}

function countLineFeeds(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) count += 1;
  return count;
}

function read(document: TextFileDocument): string {
  const snapshot = document.snapshot();
  const result = snapshot.slice(0 as Utf16Offset, snapshot.lengthUtf16 as Utf16Offset);
  if (!result.ok) throw new Error(`read-failed:${result.error.kind}`);
  return result.value;
}

function checkAdjacentInsertCoalescing(): void {
  const document = create('');
  const undoGroup = group('T110-coalesced-insert');
  assert.equal(document.beginUndoGroup(undoGroup, 'vim').ok, true);
  for (let index = 0; index < 10_000; index += 1) {
    const position = document.snapshot().lengthUtf16;
    const committed = document.commit({
      documentId,
      expectedVersion: document.version,
      edits: [{ start: position as Utf16Offset, end: position as Utf16Offset, text: 'x' }],
      origin: 'vim',
      undoGroup,
    });
    assert.equal(committed.ok, true, `insert ${index} commits`);
  }
  assert.equal(document.endUndoGroup(undoGroup).ok, true);
  const stats = document.undoHistoryStats();
  assert.equal(stats.entries, 1);
  assert.equal(stats.stepCount, 1, 'adjacent typing is one bounded history step');
  assert.equal(stats.retainedUtf16, 10_000, 'only the forward typing payload is retained');
  assert.equal(document.undo().ok, true);
  assert.equal(read(document), '');
  assert.equal(document.redo().ok, true);
  assert.equal(read(document), 'x'.repeat(10_000));
}

function checkLargeDeleteUsesSourceRoot(): void {
  const source = 'x\n'.repeat(600_000);
  const document = create(source);
  const undoGroup = group('T110-large-delete');
  const deleted = document.commit({
    documentId,
    expectedVersion: document.version,
    edits: [{ start: 0 as Utf16Offset, end: source.length as Utf16Offset, text: '' }],
    origin: 'vim',
    undoGroup,
  });
  assert.equal(deleted.ok, true, 'large delete commits without an inverse string limit');
  const stats = document.undoHistoryStats();
  assert.equal(stats.retainedUtf16, 0, 'deleted text is retained through a source root');
  assert.equal(stats.retainedRootUtf16, source.length, 'the source root is charged once');
  assert.equal(stats.retainedRootSnapshots, 1);
  assert.equal(read(document), '');
  assert.equal(document.undo().ok, true, 'lazy source text materializes only during undo');
  assert.equal(read(document), source);
  assert.equal(document.redo().ok, true);
  assert.equal(read(document), '');
}

function checkLargeMiddleDeleteMaterializesOnlyOnUndo(): void {
  const source = 'x\n'.repeat(800_000);
  const start = 100_000;
  const end = source.length - 100_000;
  const document = create(source);
  const undoGroup = group('T110-large-middle-delete');
  const deleted = document.commit({
    documentId,
    expectedVersion: document.version,
    edits: [{ start: start as Utf16Offset, end: end as Utf16Offset, text: '' }],
    origin: 'vim',
    undoGroup,
  });
  assert.equal(deleted.ok, true);
  assert.equal(read(document), source.slice(0, start) + source.slice(end));
  assert.equal(document.undo().ok, true, 'a large middle inverse remains exact through its source range');
  assert.equal(read(document), source);
  assert.equal(document.redo().ok, true);
  assert.equal(read(document), source.slice(0, start) + source.slice(end));
}

checkAdjacentInsertCoalescing();
checkLargeDeleteUsesSourceRoot();
checkLargeMiddleDeleteMaterializesOnlyOnUndo();
console.log('T110-HISTORY-RETENTION-01 passed: adjacent typing coalesces into one bounded step and large deletes retain shared immutable source roots for exact undo/redo.');
