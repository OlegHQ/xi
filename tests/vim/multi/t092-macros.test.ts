import { strict as assert } from 'node:assert';
import { openTextDocument } from '../../../packages/document/src/index';
import {
  beginVimMacroRecording,
  commitVimMacroRecording,
  createVimMacroStore,
  executeVimMultiMacro,
  type VimMultiMacroDispatchValue,
} from '../../../packages/vim/src/index';
import { asIdentifier, type DocumentId, type SelectionId } from '../../../packages/primitives/src/index';
import { createSelectionSet, type SelectionMemberInput } from '../../../packages/selections/src/index';

const snapshot = open('one two', 'T092');
const selections = makeSelections(snapshot);
let recording = beginVimMacroRecording('a');
assert.equal(recording.ok, true, 'T092-MC08-01 macro recording starts');
if (!recording.ok) throw new Error('recording failed');
recording = { ok: true, value: { ...recording.value, tokens: Object.freeze([{ kind: 'key', key: 'x' }, { kind: 'key', key: 'y' }]) } };
const committed = commitVimMacroRecording(createVimMacroStore(), recording.value);
assert.equal(committed.ok, true, 'T092-MC08-02 macro commits');
if (!committed.ok) throw new Error('macro commit failed');

let dispatches = 0;
const execution = executeVimMultiMacro(committed.value.store, 'a', selections, (context) => {
  dispatches += 1;
  assert.equal(context.selections.members.length, 2, 'T092-MC08-03 dispatcher sees the complete set');
  return { ok: true as const, value: { effect: { kind: 'continue', committed: true }, selections: context.selections } };
});
assert.equal(execution.ok, true, 'T092-MC08-04 multi macro completes');
if (execution.ok) {
  assert.equal(execution.value.committedCommands, 2, 'T092-MC08-05 each macro token commits once');
  assert.equal(dispatches, 2, 'T092-MC08-06 macro stream is not replayed once per cursor');
}

let attempts = 0;
const failed = executeVimMultiMacro(committed.value.store, 'a', selections, (context) => {
  attempts += 1;
  if (attempts === 1) return { ok: true as const, value: { effect: { kind: 'continue', committed: true }, selections: context.selections } };
  return { ok: false as const, error: { kind: 'dispatch-failed' as const, message: 'atomic command rejected' } };
});
assert.equal(failed.ok, true, 'T092-MC08-07 execution returns a typed failed status');
if (failed.ok) {
  assert.equal(failed.value.status, 'failed', 'T092-MC08-08 failed command stops playback');
  assert.equal(failed.value.committedCommands, 1, 'T092-MC08-09 prior command remains committed');
}

const cancelled = executeVimMultiMacro(committed.value.store, 'a', selections, () => ({ ok: false as const, error: { kind: 'dispatch-failed' as const, message: 'cancelled' } }), { isCancelled: () => true });
assert.equal(cancelled.ok, true, 'T092-MC08-10 cancellation returns execution status');
if (cancelled.ok) assert.equal(cancelled.value.status, 'cancelled', 'T092-MC08-11 cancellation leaves no partial current command');

console.log('T092 multi-cursor macro passed one-stream dispatch, prior-command retention and cancellation boundaries');

function open(source: string, id: string) {
  const checked = asIdentifier<DocumentId>(id, 'documentId'); assert.equal(checked.ok, true); if (!checked.ok) throw new Error('bad id');
  const result = openTextDocument(checked.value, new TextEncoder().encode(source)); assert.equal(result.kind, 'editable'); if (result.kind !== 'editable') throw new Error('unavailable'); return result.document.snapshot();
}
function makeSelections(document: ReturnType<typeof open>) {
  const member = (id: string, position: number): SelectionMemberInput => ({ id: selectionId(id), kind: 'normal-cursor', direction: 'forward', anchor: { kind: 'character', offset: position as never, after: (position + 1) as never }, head: { kind: 'character', offset: position as never, after: (position + 1) as never } });
  const result = createSelectionSet(document, { primaryId: selectionId('m1'), members: [member('m1', 0), member('m2', 4)] }); assert.equal(result.ok, true); if (!result.ok) throw new Error('selection unavailable'); return result.value.selectionSet;
}
function selectionId(value: string): SelectionId { const result = asIdentifier<SelectionId>(value, 'selectionId'); assert.equal(result.ok, true); if (!result.ok) throw new Error('selection id'); return result.value; }
