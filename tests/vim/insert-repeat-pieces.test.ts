// Verifies the O(deleted)-not-O(session-length) fix for VimInsertSession's
// dot-repeat record (packages/vim/insert/index.ts): a large paste followed by
// a single <BS> must record the deletion as a pending trim count instead of
// slicing/copying the whole accumulated repeat text. Asserts both the piece
// structure directly and a latency budget that would catch an accidental
// O(n) copy creeping back in.
import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';
import { TextFileDocument } from '../../packages/document/src/index';
import { asIdentifier, asUndoGroupId, asUtf16Offset, type DocumentId } from '../../packages/primitives/src/index';
import { beginVimInsert, planVimInsertInput, type VimInsertPlan, type VimInsertSession } from '../../packages/vim/insert/index';

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'insert-repeat-pieces-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function zero() {
  const result = asUtf16Offset(0);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(id: string): TextFileDocument {
  const result = TextFileDocument.create(identifier<DocumentId>(id), 'x', [], 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

/** Apply an insert plan's edits so the next planVimInsertInput call sees an up-to-date snapshot. */
function applyPlan(doc: TextFileDocument, plan: VimInsertPlan): ReturnType<TextFileDocument['snapshot']> {
  const group = asUndoGroupId(`insert-repeat-pieces-${plan.expectedVersion as number}`);
  if (!group.ok) throw new Error('invalid undo group');
  const committed = doc.commit({
    documentId: plan.documentId,
    expectedVersion: plan.expectedVersion,
    edits: plan.edits,
    origin: 'vim',
    undoGroup: group.value,
  });
  if (!committed.ok) throw new Error(`commit failed: ${committed.error.kind}`);
  return doc.snapshot();
}

const PASTE_SIZE = 1_000_000;
const PASTE = 'a'.repeat(PASTE_SIZE);
const BUDGET_MS = 5;

const doc = document('INSERT-REPEAT-PIECES');
const initialSnapshot = doc.snapshot();
const entered = beginVimInsert(initialSnapshot, zero(), 'i');
assert.equal(entered.ok, true, 'REPEAT-PIECES-01 insert enters');
if (!entered.ok) throw new Error('unreachable');
let session: VimInsertSession = entered.value.session;

const pasted = planVimInsertInput(initialSnapshot, session, { kind: 'paste', bytes: new TextEncoder().encode(PASTE) });
assert.equal(pasted.ok, true, 'REPEAT-PIECES-02 the paste succeeds');
if (!pasted.ok || pasted.value.kind !== 'continued') throw new Error('unreachable');
session = pasted.value.session;
let snapshot = applyPlan(doc, pasted.value.plan);
assert.equal(session.repeatLength, PASTE_SIZE, 'REPEAT-PIECES-03 repeatLength reflects the whole paste');
assert.equal(session.repeatPieces.length, 1, 'REPEAT-PIECES-04 the paste is recorded as one piece');
assert.equal(session.repeatPieces[0]?.length, PASTE_SIZE, 'REPEAT-PIECES-05 the piece holds the full pasted text');
assert.equal(session.repeatTrim, 0, 'REPEAT-PIECES-06 nothing is pending trim yet');

// A second document/session pair warms up the JIT for the exact same code
// path before the measured run, so first-call tiering effects on this
// process's very first <BS> do not distort the budget (same convention as
// bounded-line-reads.test.ts).
{
  const warmupDoc = document('INSERT-REPEAT-PIECES-WARMUP');
  const warmupEntered = beginVimInsert(warmupDoc.snapshot(), zero(), 'i');
  assert.equal(warmupEntered.ok, true, 'REPEAT-PIECES-07 backspace warmup insert enters');
  if (!warmupEntered.ok) throw new Error('unreachable');
  const warmupPasted = planVimInsertInput(warmupDoc.snapshot(), warmupEntered.value.session, { kind: 'paste', bytes: new TextEncoder().encode(PASTE) });
  assert.equal(warmupPasted.ok, true, 'REPEAT-PIECES-08 backspace warmup paste succeeds');
  if (!warmupPasted.ok || warmupPasted.value.kind !== 'continued') throw new Error('unreachable');
  const warmupSnapshot = applyPlan(warmupDoc, warmupPasted.value.plan);
  const warmupStep = planVimInsertInput(warmupSnapshot, warmupPasted.value.session, { kind: 'key', key: '<BS>' });
  assert.equal(warmupStep.ok, true, 'REPEAT-PIECES-09 backspace succeeds (warmup)');
}

let step: ReturnType<typeof planVimInsertInput> | undefined;
const elapsed = (() => {
  const start = performance.now();
  step = planVimInsertInput(snapshot, session, { kind: 'key', key: '<BS>' });
  return performance.now() - start;
})();
assert.equal(step?.ok, true, 'REPEAT-PIECES-10 backspace succeeds');
if (!step?.ok || step.value.kind !== 'continued') throw new Error('unreachable');
const afterBackspace = step.value.session;

// The whole point: the backspace must not re-copy the 1 MiB piece. It records
// the deletion as a pending trim instead of slicing the accumulated text.
assert.equal(afterBackspace.repeatPieces.length, 1, 'REPEAT-PIECES-11 the original piece is untouched');
assert.equal(afterBackspace.repeatPieces[0]?.length, PASTE_SIZE, 'REPEAT-PIECES-12 the piece is not sliced');
assert.equal(afterBackspace.repeatTrim, 1, 'REPEAT-PIECES-13 exactly one pending trim unit is recorded');
assert.equal(afterBackspace.repeatLength, PASTE_SIZE - 1, 'REPEAT-PIECES-14 the logical length drops by one');
assert.ok(elapsed < BUDGET_MS, `REPEAT-PIECES-15 <BS> after a 1 MiB paste completes within budget (${elapsed.toFixed(3)}ms)`);

console.log('T-INSERT-REPEAT-PIECES passed: <BS> after a 1 MiB paste records a pending trim instead of copying the paste');
