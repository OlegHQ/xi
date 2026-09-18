// D4 regression: moveInsertCursorTo (packages/vim/insert/index.ts) reports a dot-repeat
// 'break' when the cursor moves during Insert mode, but left session.repeatPieces (and
// repeatTrim/repeatLength/entryOffset) pointing at text typed before the move. Since this
// module's own count>1 replay at <Esc> (and any outer dot-repeat reader of these fields
// before exit) reads repeatPieces to know what to replay, a stale repeatPieces means a
// move-then-type-then-repeat sequence would replay text from before the move too.
//
// Oracle intent (`.artifacts/oracle/nvim-linux-arm64/bin/nvim --headless --clean -u NONE`):
// `ifoo<Left>X<Esc>` then `.` replays only "X" -- a cursor move starts a fresh dot-repeat
// unit. This test asserts the session-level invariant directly: after a cursor move,
// repeatPieces/repeatTrim/repeatLength are reset to empty and entryOffset tracks the move,
// so any text typed afterward is recorded as its own, independent repeat unit.
import { strict as assert } from 'node:assert';
import { TextFileDocument } from '../../packages/document/src/index';
import { asIdentifier, asUndoGroupId, asUtf16Offset, type DocumentId } from '../../packages/primitives/src/index';
import { beginVimInsert, planVimInsertInput, type VimInsertPlan, type VimInsertSession } from '../../packages/vim/insert/index';

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'insert-d4-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function off(n: number) {
  const result = asUtf16Offset(n);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function document(id: string, text: string): TextFileDocument {
  const result = TextFileDocument.create(identifier<DocumentId>(id), text, [], 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}
function applyPlan(doc: TextFileDocument, plan: VimInsertPlan): ReturnType<TextFileDocument['snapshot']> {
  const group = asUndoGroupId(`insert-d4-${plan.expectedVersion as number}`);
  if (!group.ok) throw new Error('invalid undo group');
  const committed = doc.commit({ documentId: plan.documentId, expectedVersion: plan.expectedVersion, edits: plan.edits, origin: 'vim', undoGroup: group.value });
  if (!committed.ok) throw new Error(`commit failed: ${committed.error.kind}`);
  return doc.snapshot();
}

async function main(): Promise<void> {
  const doc = document('D4', '');
  let snapshot = doc.snapshot();
  const entered = beginVimInsert(snapshot, off(0), 'i');
  assert.equal(entered.ok, true, 'D4-01 insert enters');
  if (!entered.ok) throw new Error('unreachable');
  snapshot = applyPlan(doc, entered.value.plan);
  let session: VimInsertSession = entered.value.session;

  for (const ch of 'foo') {
    const typed = planVimInsertInput(snapshot, session, { kind: 'key', key: ch });
    assert.equal(typed.ok, true, `D4-02 typing ${ch} succeeds`);
    if (!typed.ok || typed.value.kind !== 'continued') throw new Error('unreachable');
    snapshot = applyPlan(doc, typed.value.plan);
    session = typed.value.session;
  }
  assert.equal(session.repeatLength, 3, 'D4-03 repeatPieces holds "foo" before any move');

  const moved = planVimInsertInput(snapshot, session, { kind: 'key', key: '<Left>' });
  assert.equal(moved.ok, true, 'D4-04 <Left> succeeds');
  if (!moved.ok || moved.value.kind !== 'continued') throw new Error('unreachable');
  snapshot = applyPlan(doc, moved.value.plan);
  session = moved.value.session;

  assert.deepEqual(session.repeatPieces, [], 'D4-05 <Left> clears repeatPieces');
  assert.equal(session.repeatTrim, 0, 'D4-06 <Left> clears repeatTrim');
  assert.equal(session.repeatLength, 0, 'D4-07 <Left> clears repeatLength');
  assert.equal(session.entryOffset, session.cursorOffset, 'D4-08 <Left> advances entryOffset to the new cursor');

  const typedX = planVimInsertInput(snapshot, session, { kind: 'key', key: 'X' });
  assert.equal(typedX.ok, true, 'D4-09 typing X after the move succeeds');
  if (!typedX.ok || typedX.value.kind !== 'continued') throw new Error('unreachable');
  session = typedX.value.session;
  assert.equal(session.repeatLength, 1, 'D4-10 only "X" (not "fooX") is recorded as the repeat unit after the move');

  console.log('insert-d4-move-breaks-repeat: all assertions passed');
}

void main();
