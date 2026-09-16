import { strict as assert } from 'node:assert';
import { openTextDocument } from '../../../packages/document/src/index';
import {
  applyVimRepeatEvent,
  createVimInsertRepeatTarget,
  createVimOperatorRepeatTarget,
  createVimRepeatState,
  recordVimRepeatTarget,
  replayVimMultiDot,
} from '../../../packages/vim/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type SelectionId } from '../../../packages/primitives/src/index';
import { createSelectionSet, type SelectionMemberInput } from '../../../packages/selections/src/index';

const snapshot = open('one two three', 'T080');
const selections = makeSelections(snapshot, [1, 5]);
const operator = createVimOperatorRepeatTarget({ operator: 'change', motionKey: 'iw', count: 1 });
assert.equal(operator.ok, true, 'T080-MC07-01 ciw target is semantic');
if (!operator.ok) throw new Error('operator target failed');
const recorded = recordVimRepeatTarget(createVimRepeatState(), operator.value);
assert.equal(recorded.ok, true, 'T080-MC07-02 semantic target records');
if (!recorded.ok) throw new Error('record failed');
const replayed = replayVimMultiDot(recorded.value, { snapshot, selections }, (context) => {
  assert.equal(context.target.kind, 'operator', 'T080-MC07-03 dot retains operator recipe');
  if (context.target.kind === 'operator') assert.equal(context.target.motionKey, 'iw', 'T080-MC07-04 dot retains ciw motion');
  assert.equal(context.selections.members.length, 2, 'T080-MC07-05 dot resolves once for current set');
  return { ok: true as const, value: context.selections.members.map((member) => member.id) };
});
assert.equal(replayed.ok, true, 'T080-MC07-06 dot replays at changed selection positions');
if (replayed.ok) assert.equal(replayed.value.resolved.length, 2, 'T080-MC07-07 dot returns one result per member');

const insert = createVimInsertRepeatTarget({ entryKey: 'i', mode: 'insert', text: 'X', count: 1 });
assert.equal(insert.ok, true, 'T080-MC07-08 insert recipe records');
if (!insert.ok) throw new Error('insert target failed');
const insertedState = recordVimRepeatTarget(recorded.value, insert.value);
assert.equal(insertedState.ok, true, 'T080-MC07-09 insert replaces prior target once');
if (!insertedState.ok) throw new Error('insert record failed');
const counted = replayVimMultiDot(insertedState.value, { snapshot, selections, count: 2 }, (context) => {
  assert.equal(context.count, 2, 'T080-MC07-10 explicit dot count applies to all members');
  return { ok: true as const, value: 'broadcast' };
});
assert.equal(counted.ok, true, 'T080-MC07-11 counted dot succeeds for a changed selection set');

const failed = replayVimMultiDot(insertedState.value, { snapshot, selections }, () => ({ ok: false as const, error: { kind: 'invalid-text' as const } }));
assert.equal(failed.ok, false, 'T080-MC07-12 incompatible recipe rejects');
if (!failed.ok) assert.equal(insertedState.value.target?.kind, 'insert', 'T080-MC07-13 failed repeat leaves last target unchanged');

const serviceState = applyVimRepeatEvent(insertedState.value, { kind: 'service' });
assert.equal(serviceState.ok, true, 'T080-MC07-14 service action does not become a dot target');
if (serviceState.ok) {
  assert.equal(serviceState.value.target?.kind, 'insert', 'T080-MC07-15 service action retains prior target');
  assert.equal(serviceState.value.sequence, insertedState.value.sequence, 'T080-MC07-16 service action does not advance repeat sequence');
}

const stale = replayVimMultiDot(insertedState.value, { snapshot: open('one two three', 'T080-new'), selections }, () => ({ ok: true as const, value: 'unreachable' }));
assert.equal(stale.ok, false, 'T080-MC07-17 stale selection generation rejects before replay');

console.log('T080 semantic multi-cursor dot passed ciw, insert/count, incompatible recipe and service-target policies');

function open(source: string, id: string) {
  const checked = asIdentifier<DocumentId>(id, 'documentId');
  assert.equal(checked.ok, true, 'T080-OWNER-01 document id validates');
  if (!checked.ok) throw new Error('invalid id');
  const result = openTextDocument(checked.value, new TextEncoder().encode(source));
  assert.equal(result.kind, 'editable', 'T080-OWNER-02 document opens');
  if (result.kind !== 'editable') throw new Error('document unavailable');
  return result.document.snapshot();
}

function makeSelections(document: ReturnType<typeof open>, positions: readonly number[]) {
  const members: SelectionMemberInput[] = positions.map((position, index) => ({
    id: selectionId(`m${index + 1}`), kind: 'normal-cursor', direction: 'forward',
    anchor: { kind: 'character', offset: position as never, after: (position + 1) as never },
    head: { kind: 'character', offset: position as never, after: (position + 1) as never },
  }));
  const result = createSelectionSet(document, { primaryId: selectionId('m1'), members });
  assert.equal(result.ok, true, 'T080-SET-01 selection set validates');
  if (!result.ok) throw new Error('selection unavailable');
  return result.value.selectionSet;
}
function selectionId(value: string): SelectionId {
  const result = asIdentifier<SelectionId>(value, 'selectionId');
  assert.equal(result.ok, true, 'T080-SET-02 selection id validates');
  if (!result.ok) throw new Error('selection id unavailable');
  return result.value;
}
