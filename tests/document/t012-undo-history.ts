import { strict as assert } from 'node:assert';
import {
  asIdentifier,
  asUndoGroupId,
  cloneSerializedSelectionValue,
  type DocumentId,
  type SerializedSelectionValue,
  type UndoGroupId,
  type Utf16Offset,
} from '../../packages/primitives/src/index';
import {
  openTextDocument,
  TextFileDocument,
  UNDO_HISTORY_POLICY,
} from '../../packages/document/src/index';

const SEED = 41027;

export function runUndoHistoryChecks(): void {
  checkGroupedUndoRedoAndSelectionIntent();
  checkBatchInverseComposition();
  checkAlternateRedoBranchesAndSavedIdentity();
  checkExternalEditInterruptsGroup();
  checkMixedEolUndoAndPersistentRoundTrip();
  checkCorruptHistoryIsRejectedAtomically();
  checkSelectionValueValidation();
  checkRetentionBounds();
}

function checkBatchInverseComposition(): void {
  const document = createDocument('ab');
  const group = groupId('T012-inverse-compose');
  commit(document, group, 'vim', [
    { start: offset(0), end: offset(1), text: '' },
    { start: offset(1), end: offset(2), text: 'X' },
  ]);
  assert.equal(read(document), 'X');
  const undo = document.undo();
  assert.equal(undo.ok, true, 'an inverse insertion touching a replacement is composed under its known history rule');
  assert.equal(read(document), 'ab');
  assert.equal(document.redo().ok, true);
  assert.equal(read(document), 'X');
  console.log('T012-INVERSE-BATCH-01 passed: a valid adjacent delete/replace batch composes its otherwise ambiguous inverse and round-trips.');
}

function checkGroupedUndoRedoAndSelectionIntent(): void {
  const document = createDocument('abc');
  const group = groupId('T012-insert-group');
  const beforeSelection = { primaryId: 'p1', cursor: { offset: 0 } };
  const opened = document.beginUndoGroup(group, 'vim', beforeSelection);
  assert.equal(opened.ok, true);
  beforeSelection.cursor.offset = 99;

  commit(document, group, 'vim', [{ start: offset(1), end: offset(1), text: 'X' }], {
    before: { cursor: 0 },
    after: { cursor: 2 },
  });
  commit(document, group, 'vim', [{ start: offset(2), end: offset(2), text: 'Y' }], {
    before: { cursor: 2 },
    after: { cursor: 3 },
  });
  assert.equal(read(document), 'aXYbc');
  assert.equal(document.undoHistoryStats().entries, 1, 'an explicit group is one tree entry');
  assert.equal(document.undoHistoryStats().retainedUtf16, 2, 'only edit text is retained, not whole snapshots');
  assert.equal(document.endUndoGroup(group, { primaryId: 'p1', cursor: { offset: 3 } }).ok, true);

  const saved = document.snapshot();
  assert.equal(document.markSaved(saved).ok, true);
  assert.equal(document.isDirty, false);
  const undone = document.undo();
  assert.equal(undone.ok, true);
  if (undone.ok) {
    assert.equal(undone.value.kind, 'undone');
    assert.deepEqual(JSON.parse(JSON.stringify(undone.value.restoredSelection)), { primaryId: 'p1', cursor: { offset: 0 } });
  }
  assert.equal(read(document), 'abc');
  assert.equal(document.isDirty, true, 'undo away from the saved revision becomes dirty');
  const redone = document.redo();
  assert.equal(redone.ok, true);
  if (redone.ok) assert.deepEqual(JSON.parse(JSON.stringify(redone.value.restoredSelection)), { primaryId: 'p1', cursor: { offset: 3 } });
  assert.equal(read(document), 'aXYbc');
  assert.equal(document.revisionId, saved.revisionId, 'redo restores the saved content identity');
  assert.equal(document.isDirty, false);
  console.log('T012-GROUP-RESTORE-01 passed: a two-transaction explicit group undoes/redoes once, restores cloned cursor intent, and follows saved revision identity.');
}

function checkAlternateRedoBranchesAndSavedIdentity(): void {
  let document = createDocument('0');
  const groupA = groupId('T012-branch-A');
  const a = commit(document, groupA, 'vim', [{ start: offset(1), end: offset(1), text: 'A' }], {
    before: { cursor: 1 },
    after: { cursor: 2, label: 'A' },
  });
  if (!a.ok || a.value.kind !== 'committed') throw new Error('T012-branch-A-commit-failed');
  const branchA = a.value.change.afterRevisionId;
  assert.equal(document.markSaved(document.snapshot()).ok, true);
  assert.equal(document.undo().ok, true);

  const groupB = groupId('T012-branch-B');
  commit(document, groupB, 'vim', [{ start: offset(1), end: offset(1), text: 'B' }]);
  assert.equal(read(document), '0B');
  const currentBytes = bytes(document);
  const history = document.serializeUndoHistory();
  if (!history.ok) throw new Error(`T012-branch-serialize:${history.error.kind}`);
  const reopened = openTextDocument(id('T012-test-document'), currentBytes, SEED);
  assert.equal(reopened.kind, 'editable');
  if (reopened.kind !== 'editable') throw new Error('branch-current-bytes-must-be-editable');
  assert.equal(reopened.document.restoreUndoHistory(history.value).ok, true);
  document = reopened.document;
  assert.equal(document.undo().ok, true);
  const branches = document.redoBranches();
  assert.equal(branches.length, 2, 'a new edit after undo adds a sibling without deleting the old branch');
  assert.equal(branches.some((branch) => branch.id === branchA), true);

  const redoA = document.redo(branchA);
  assert.equal(redoA.ok, true);
  assert.equal(read(document), '0A');
  assert.equal(document.isDirty, false, 'redo can return to a saved revision on the alternate branch');
  if (redoA.ok) assert.deepEqual(JSON.parse(JSON.stringify(redoA.value.restoredSelection)), { cursor: 2, label: 'A' });

  assert.equal(document.undo().ok, true);
  assert.equal(document.redo().ok, true, 'default redo chooses the most recently-created branch');
  assert.equal(read(document), '0B');
  console.log('T012-BRANCH-REDO-01 passed: branch A survives undo-then-edit; explicit and default redo select the expected revision and saved state.');
}

function checkExternalEditInterruptsGroup(): void {
  const document = createDocument('abc');
  const group = groupId('T012-interrupt-vim');
  const externalGroup = groupId('T012-interrupt-lsp');
  assert.equal(document.beginUndoGroup(group, 'vim', { cursor: 3 }).ok, true);
  commit(document, group, 'vim', [{ start: offset(3), end: offset(3), text: 'X' }]);
  commit(document, externalGroup, 'lsp', [{ start: offset(0), end: offset(0), text: '!' }]);
  assert.equal(document.endUndoGroup(group).ok, false, 'a different-origin edit closes the active boundary');
  assert.equal(read(document), '!abcX');

  assert.equal(document.undo().ok, true);
  assert.equal(read(document), 'abcX', 'the external edit is its own undo entry');
  assert.equal(document.undo().ok, true);
  assert.equal(read(document), 'abc', 'the interrupted Vim group remains a separate entry');
  console.log('T012-GROUP-INTERRUPTION-01 passed: an external LSP edit splits the active Vim group and both entries undo independently.');
}

function checkMixedEolUndoAndPersistentRoundTrip(): void {
  const documentId = id('T012-eol-document');
  const opened = openTextDocument(documentId, new TextEncoder().encode('a\r\nb\nc\r'), SEED);
  assert.equal(opened.kind, 'editable');
  if (opened.kind !== 'editable') throw new Error('mixed-eol-fixture-must-be-editable');
  const document = opened.document;
  const originalBytes = bytes(document);
  const group = groupId('T012-eol-edit');
  commit(document, group, 'vim', [{ start: offset(3), end: offset(4), text: '!\n' }]);
  assert.equal(read(document), 'a\nb!\nc\n');
  const currentBytes = bytes(document);
  const archive = document.serializeUndoHistory();
  if (!archive.ok) throw new Error(`T012-history-serialize:${archive.error.kind}`);

  const reopened = openTextDocument(documentId, currentBytes, SEED);
  assert.equal(reopened.kind, 'editable');
  if (reopened.kind !== 'editable') throw new Error('serialized-current-text-must-be-editable');
  assert.equal(reopened.document.restoreUndoHistory(archive.value).ok, true);
  assert.equal(reopened.document.revisionId, document.revisionId);
  const undone = reopened.document.undo();
  assert.equal(undone.ok, true);
  assert.deepEqual(bytes(reopened.document), originalBytes, 'undo restores exact mixed CRLF/LF/CR bytes after restart');
  assert.equal(reopened.document.isDirty, false, 'the saved root revision is restored after history load');
  assert.equal(reopened.document.redo().ok, true);
  assert.deepEqual(bytes(reopened.document), currentBytes);
  console.log('T012-PERSIST-ROUNDTRIP-01 passed: versioned serialized history restores onto matching file bytes; mixed EOL metadata survives undo/redo.');
}

function checkCorruptHistoryIsRejectedAtomically(): void {
  const documentId = id('T012-corrupt-document');
  const original = openTextDocument(documentId, new TextEncoder().encode('before'), SEED);
  assert.equal(original.kind, 'editable');
  if (original.kind !== 'editable') throw new Error('corruption-fixture-must-be-editable');
  commit(original.document, groupId('T012-corrupt-edit'), 'vim', [
    { start: offset(6), end: offset(6), text: ' after' },
  ]);
  const currentBytes = bytes(original.document);
  const archive = original.document.serializeUndoHistory();
  if (!archive.ok) throw new Error(`T012-corrupt-serialize:${archive.error.kind}`);

  const reopened = openTextDocument(documentId, currentBytes, SEED);
  assert.equal(reopened.kind, 'editable');
  if (reopened.kind !== 'editable') throw new Error('corruption-target-must-be-editable');
  const corruptValue = JSON.parse(new TextDecoder().decode(archive.value)) as { checksum: string };
  corruptValue.checksum = `${corruptValue.checksum[0] === '0' ? '1' : '0'}${corruptValue.checksum.slice(1)}`;
  const corrupt = new TextEncoder().encode(JSON.stringify(corruptValue));
  const failed = reopened.document.restoreUndoHistory(corrupt);
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error.kind, 'history-checksum-mismatch');
  assert.equal(read(reopened.document), 'before after');
  assert.equal(reopened.document.version as number, 1, 'rejected import leaves document version untouched');
  assert.equal(reopened.document.revisionId as number, 1, 'rejected import leaves revision identity untouched');
  assert.equal(reopened.document.undo().ok, false, 'rejected history is not partially installed');
  assert.equal(reopened.document.restoreUndoHistory(new TextEncoder().encode('{')).ok, false);
  console.log('T012-CORRUPT-HISTORY-01 passed: checksum and malformed-JSON failures leave text, version, revision, and history untouched.');
}

function checkSelectionValueValidation(): void {
  const source = { primary: 's1', anchor: { offset: 4 }, members: ['s1'] };
  const cloned = cloneSerializedSelectionValue(source);
  assert.equal(cloned.ok, true);
  source.anchor.offset = 99;
  source.members.push('s2');
  if (cloned.ok) {
    assert.deepEqual(JSON.parse(JSON.stringify(cloned.value)), { primary: 's1', anchor: { offset: 4 }, members: ['s1'] });
    assert.equal(Object.isFrozen(cloned.value), true);
    if (typeof cloned.value === 'object' && cloned.value !== null && !Array.isArray(cloned.value)) {
      assert.equal(Object.getPrototypeOf(cloned.value), null);
    }
  }
  assert.equal(cloneSerializedSelectionValue(Number.NaN).ok, false);
  assert.equal(cloneSerializedSelectionValue(() => 1).ok, false);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.equal(cloneSerializedSelectionValue(cyclic).ok, false);
  const getter = Object.defineProperty({}, 'offset', { enumerable: true, get: () => 1 });
  assert.equal(cloneSerializedSelectionValue(getter).ok, false);
  const document = createDocument('before');
  const documentVersion = document.version;
  const group = groupId('T012-invalid-selection-state');
  const malformedProposal = {
    documentId: document.id,
    expectedVersion: document.version,
    edits: [{ start: offset(6), end: offset(6), text: '!' }],
    origin: 'vim',
    undoGroup: group,
    selectionHistory: { before: cyclic, after: {} },
  };
  const rejected = document.commit(malformedProposal as never);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.kind, 'invalid-selection-history');
  assert.equal(read(document), 'before');
  assert.equal(document.version, documentVersion);
  console.log('T012-SELECTION-VALUE-01 passed: selection history accepts only bounded frozen JSON data and clones nested input defensively.');
}

function checkRetentionBounds(): void {
  const document = createDocument('x');
  for (let index = 0; index < UNDO_HISTORY_POLICY.maxEntries + 40; index += 1) {
    const position = document.snapshot().lengthUtf16;
    const result = commit(document, groupId(`T012-retention-${index}`), 'vim', [
      { start: offset(position), end: offset(position), text: 'x' },
    ]);
    assert.equal(result.ok, true);
  }
  const stats = document.undoHistoryStats();
  assert.equal(stats.entries, UNDO_HISTORY_POLICY.maxEntries);
  assert.equal(stats.retainedUtf16 <= UNDO_HISTORY_POLICY.maxRetainedUtf16, true);
  for (let index = 0; index < UNDO_HISTORY_POLICY.maxEntries; index += 1) {
    assert.equal(document.undo().ok, true, `retained undo entry ${index} should remain reachable`);
  }
  const boundary = document.undo();
  assert.equal(boundary.ok, false);
  if (!boundary.ok) assert.equal(boundary.error.kind, 'nothing-to-undo');
  console.log(`T012-RETENTION-01 passed: history remains bounded to ${UNDO_HISTORY_POLICY.maxEntries} entries / ${UNDO_HISTORY_POLICY.maxRetainedUtf16} UTF-16 units and stops at the checkpoint.`);
}

function commit(
  document: TextFileDocument,
  undoGroup: UndoGroupId,
  origin: 'vim' | 'lsp' | 'formatter' | 'workspace-replace' | 'directory',
  edits: readonly { readonly start: Utf16Offset; readonly end: Utf16Offset; readonly text: string }[],
  selectionHistory?: { readonly before: SerializedSelectionValue; readonly after: SerializedSelectionValue },
) {
  return document.commit({
    documentId: document.id,
    expectedVersion: document.version,
    edits,
    origin,
    undoGroup,
    ...(selectionHistory === undefined ? {} : { selectionHistory }),
  });
}

function createDocument(text: string): TextFileDocument {
  const result = TextFileDocument.create(id('T012-test-document'), text, [], 'lf', false, SEED);
  if (!result.ok) throw new Error(`document-create:${result.error.kind}`);
  return result.value;
}

function id(value: string): DocumentId {
  const result = asIdentifier<DocumentId>(value, 'documentId');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function groupId(value: string): UndoGroupId {
  const result = asUndoGroupId(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function read(document: TextFileDocument): string {
  const snapshot = document.snapshot();
  const result = snapshot.slice(offset(0), offset(snapshot.lengthUtf16));
  if (!result.ok) throw new Error(`document-read:${result.error.kind}`);
  return result.value;
}

function bytes(document: TextFileDocument): Uint8Array {
  const result = document.serialize();
  if (!result.ok) throw new Error(`document-encode:${result.error.kind}`);
  return result.value;
}

function offset(value: number): Utf16Offset { return value as Utf16Offset; }

if (import.meta.main) runUndoHistoryChecks();
