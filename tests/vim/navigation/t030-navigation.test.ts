#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import {
  DocumentChangeMap,
  openTextDocument,
  type DocumentEdit,
  type DocumentSnapshot,
} from '../../../packages/document/src/index';
import {
  asDocumentVersion,
  asIdentifier,
  asUtf16Offset,
  type DocumentId,
  type DocumentVersion,
  type Utf16Offset,
} from '../../../packages/primitives/src/index';
import {
  beginVimJumpPreview,
  cancelVimJumpPreview,
  changeBackward,
  changeForward,
  classifyVimMarkName,
  commitVimJumpPreview,
  createVimChangeHistory,
  createVimJumpHistory,
  createVimMarkStore,
  jumpBackward,
  jumpForward,
  mapVimMarksThroughChange,
  recordVimChange,
  recordVimJump,
  resolveVimMark,
  resolveVimMarkForWorkspace,
  setVimMark,
} from '../../../packages/vim/src/index';

const docA = open('alpha\nbeta\ngamma', 't030-a');
const docB = open('other', 't030-b');
const snapshotA = docA.document.snapshot();
const snapshotB = docB.document.snapshot();
const offset = (value: number): Utf16Offset => {
  const result = asUtf16Offset(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('invalid test offset');
  return result.value;
};
const version = (value: number): DocumentVersion => {
  const result = asDocumentVersion(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('invalid test version');
  return result.value;
};
const target = (snapshot: DocumentSnapshot, at: number) => ({
  documentId: snapshot.id,
  documentVersion: snapshot.version,
  offset: offset(at),
});

assert.equal(classifyVimMarkName('a'), 'local', 'T030-MARK-01 lowercase names are local');
assert.equal(classifyVimMarkName('A'), 'global', 'T030-MARK-02 uppercase names are global');
assert.equal(classifyVimMarkName('<'), 'special', 'T030-MARK-03 special names are accepted');
assert.equal(classifyVimMarkName('aa'), null, 'T030-MARK-04 multi-character names are rejected');

let marks = createVimMarkStore();
marks = expectOk(setVimMark(marks, 'a', snapshotA, offset(2), 'right'));
marks = expectOk(setVimMark(marks, 'A', snapshotB, offset(1), 'left'));
marks = expectOk(setVimMark(marks, '<', snapshotA, offset(6), 'left'));
const local = expectOk(resolveVimMark(marks, 'a', snapshotA.id));
assert.equal(local.mark.offset, 2, 'T030-MARK-05 local mark resolves in its buffer');
assert.deepEqual(resolveVimMark(marks, 'a', snapshotB.id), { ok: false, error: { kind: 'missing-mark' } },
  'T030-MARK-06 local marks do not leak across buffers');
const global = expectOk(resolveVimMarkForWorkspace(marks, 'A', snapshotA.id, new Set([snapshotA.id])));
assert.equal(global.kind, 'missing-document', 'T030-MARK-07 missing global target is explicit');
const globalReady = expectOk(resolveVimMarkForWorkspace(marks, 'A', snapshotA.id, new Set([snapshotA.id, snapshotB.id])));
assert.equal(globalReady.kind, 'ready', 'T030-MARK-08 loaded global target resolves');

const insert: DocumentEdit = { start: offset(0), end: offset(0), text: 'ZZ' };
const afterVersion = version((snapshotA.version as number) + 1);
const map = expectOk(DocumentChangeMap.create(snapshotA, afterVersion, [insert]));
const preview = expectOk(docA.document.previewTextEdits([insert], snapshotA.version));
const shifted = expectOk(mapVimMarksThroughChange(marks, map, preview));
assert.equal(expectOk(resolveVimMark(shifted, 'a', snapshotA.id)).mark.offset, 4,
  'T030-MARK-09 right-affinity mark shifts after insertion');
assert.equal(expectOk(resolveVimMark(shifted, '<', snapshotA.id)).mark.offset, 8,
  'T030-MARK-10 special mark shifts with the same change map');
assert.equal(expectOk(resolveVimMark(shifted, 'A', snapshotA.id)).mark.offset, 1,
  'T030-MARK-11 unrelated global mark remains versioned in its source buffer');

let deletedMarkStore = createVimMarkStore();
deletedMarkStore = expectOk(setVimMark(deletedMarkStore, 'a', snapshotA, offset(2), 'left'));
const deletion: DocumentEdit = { start: offset(0), end: offset(5), text: 'x' };
const deletedVersion = version((snapshotA.version as number) + 1);
const deletedMap = expectOk(DocumentChangeMap.create(snapshotA, deletedVersion, [deletion]));
const deletedPreview = expectOk(docA.document.previewTextEdits([deletion], snapshotA.version));
const mappedDeleted = expectOk(mapVimMarksThroughChange(deletedMarkStore, deletedMap, deletedPreview));
assert.equal(expectOk(resolveVimMark(mappedDeleted, 'a', snapshotA.id)).mark.offset, 0,
  'T030-MARK-12 deleted mark maps to the explicit left edge');

let jumps = createVimJumpHistory();
jumps = expectOk(recordVimJump(jumps, target(snapshotA, 0), 'manual'));
jumps = expectOk(recordVimJump(jumps, target(snapshotA, 2), 'search'));
jumps = expectOk(recordVimJump(jumps, target(snapshotA, 2), 'search'));
assert.equal(jumps.entries.length, 2, 'T030-JUMP-01 consecutive duplicate jumps are deduplicated');
const back = expectOk(jumpBackward(jumps));
assert.equal(back.target.offset, 0, 'T030-JUMP-02 Ctrl-O returns the previous jump target');
const forward = expectOk(jumpForward(back.state));
assert.equal(forward.target.offset, 2, 'T030-JUMP-03 Ctrl-I returns the later jump target');
assert.equal(forward.state.index, 1, 'T030-JUMP-03b forward navigation advances the history cursor');
const previewJump = expectOk(beginVimJumpPreview(jumps, target(snapshotB, 0), 'tag'));
const cancelled = cancelVimJumpPreview(jumps, previewJump);
assert.strictEqual(cancelled, jumps, 'T030-JUMP-04 cancelled peek does not pollute jump history');
const committed = expectOk(commitVimJumpPreview(jumps, previewJump));
assert.equal(committed.entries.length, 3, 'T030-JUMP-05 committed peek becomes a jump');
const branched = expectOk(recordVimJump(back.state, target(snapshotB, 1), 'buffer'));
assert.equal(branched.entries.length, 2, 'T030-JUMP-06 new jump truncates forward history after Ctrl-O');
assert.deepEqual(jumpBackward(createVimJumpHistory()), { ok: false, error: { kind: 'nothing-back' } },
  'T030-JUMP-07 empty history has a typed boundary');

let changes = createVimChangeHistory();
changes = expectOk(recordVimChange(changes, target(snapshotA, 3)));
changes = expectOk(recordVimChange(changes, target(snapshotA, 8)));
changes = expectOk(recordVimChange(changes, target(snapshotB, 1)));
assert.equal(changes.entries.length, 3, 'T030-CHANGE-01 change list records cross-buffer edits');
const older = expectOk(changeBackward(changes));
assert.equal(older.target.offset, 1, 'T030-CHANGE-02 g; visits the previous change');
const newer = expectOk(changeForward(older.state));
assert.equal(newer.target.offset, 1, 'T030-CHANGE-03 g, restores the later change');
assert.deepEqual(changeForward(changes), { ok: false, error: { kind: 'nothing-forward' } },
  'T030-CHANGE-04 change-list end is explicit');

console.log('T030 navigation marks, jump/change lists, anchor mapping, cross-buffer targets and peek cancellation passed');

function open(text: string, id: string) {
  const documentId = asIdentifier<DocumentId>(id, 'document-id');
  assert.equal(documentId.ok, true);
  if (!documentId.ok) throw new Error('invalid document id');
  const result = openTextDocument(documentId.value, new TextEncoder().encode(text));
  assert.equal(result.kind, 'editable');
  if (result.kind !== 'editable') throw new Error('document did not open');
  return result;
}

function expectOk<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }): T {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
}
