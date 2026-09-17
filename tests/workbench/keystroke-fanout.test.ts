// Verifies the T-KEYSTROKE-LATENCY fan-out fix in packages/workbench/session/index.ts:
// a vim-origin commit on a buffer with exactly one view must not perform a redundant
// external selection mapping (that view's own vim session republishes authoritative
// state via syncViewSession immediately after), while a second view on the same
// document still gets its selections mapped through the change.
import assert from 'node:assert/strict';
import { TextFileDocument } from '../../packages/document/src/index';
import { createSelectionSet, type EndpointInput } from '../../packages/selections/src/index';
import { WorkbenchSession, AtomicCommandCoordinator } from '../../packages/workbench/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type SelectionId, type UndoGroupId, type ViewId } from '../../packages/primitives/src/index';

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'keystroke-fanout-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function offset(value: number) {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function cursor(id: SelectionId, position: number) {
  const endpoint: EndpointInput = { kind: 'character', offset: offset(position), after: offset(position + 1), affinity: 'right', afterAffinity: 'right' };
  return { id, kind: 'normal-cursor' as const, direction: 'forward' as const, anchor: endpoint, head: endpoint };
}

function document(id: string): TextFileDocument {
  const result = TextFileDocument.create(identifier<DocumentId>(id), 'ab\n', ['lf'], 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

// Spy on AtomicCommandCoordinator.replaceState to count invocations without
// changing production behavior; restored at the end of this file.
let replaceStateCalls = 0;
const originalReplaceState = AtomicCommandCoordinator.prototype.replaceState;
AtomicCommandCoordinator.prototype.replaceState = function replaceStateSpy(
  this: AtomicCommandCoordinator,
  ...args: Parameters<typeof originalReplaceState>
) {
  replaceStateCalls += 1;
  return originalReplaceState.apply(this, args);
};

try {
  // Single view: the vim-origin commit itself must not trigger a state
  // replacement; only the subsequent syncViewSession call (standing in for
  // handleKey's post-command onStateChange) should.
  {
    const doc = document('FANOUT-single');
    const workbench = new WorkbenchSession({ workspaceId: 'fanout-single' });
    const opened = workbench.openBuffer(doc, { viewId: identifier<ViewId>('FANOUT-single-view') });
    assert.equal(opened.ok, true, 'FANOUT-SINGLE-00 buffer opens with one view');
    if (!opened.ok) throw new Error('open');
    const viewId = opened.value.viewIds[0] as ViewId;

    replaceStateCalls = 0;
    const committed = doc.commit({
      documentId: doc.id,
      expectedVersion: doc.version,
      edits: [{ start: offset(0), end: offset(0), text: 'x' }],
      origin: 'vim',
      undoGroup: identifier<UndoGroupId>('FANOUT-undo-1'),
    });
    assert.equal(committed.ok, true, 'FANOUT-SINGLE-01 vim edit commits');
    assert.equal(replaceStateCalls, 0, 'FANOUT-SINGLE-02 a single-view vim commit performs no external mapping replaceState call');

    const primary = identifier<SelectionId>('FANOUT-single-primary');
    const nextSelections = createSelectionSet(doc.snapshot(), { primaryId: primary, members: [cursor(primary, 1)] });
    assert.equal(nextSelections.ok, true, 'FANOUT-SINGLE-03 authoritative post-command selection is valid');
    if (!nextSelections.ok) throw new Error('selection');
    const synced = workbench.syncViewSession(viewId, nextSelections.value.selectionSet, 'normal');
    assert.equal(synced.ok, true, 'FANOUT-SINGLE-04 the owning session publishes authoritative state');
    assert.equal(replaceStateCalls, 1, 'FANOUT-SINGLE-05 exactly one state replacement for the whole keystroke');

    const read = workbench.readView(viewId);
    assert.equal(read?.selections, nextSelections.value.selectionSet, 'FANOUT-SINGLE-06 the synced selections are installed');
  }

  // Multi-view: a second view on the same document must still have its
  // selections mapped through the committed change even though the fast
  // path above skips work for the single-view case.
  {
    const doc = document('FANOUT-multi');
    const workbench = new WorkbenchSession({ workspaceId: 'fanout-multi' });
    const opened = workbench.openBuffer(doc, { viewId: identifier<ViewId>('FANOUT-multi-left') });
    assert.equal(opened.ok, true, 'FANOUT-MULTI-00 buffer opens');
    if (!opened.ok) throw new Error('open');
    const left = opened.value.viewIds[0] as ViewId;
    const split = workbench.splitView(left, 'vertical', identifier<ViewId>('FANOUT-multi-right'));
    assert.equal(split.ok, true, 'FANOUT-MULTI-01 a second view splits off the same document');
    if (!split.ok) throw new Error('split');
    const right = split.value.viewId;

    const beforeRight = workbench.readView(right);
    assert.notEqual(beforeRight, undefined, 'FANOUT-MULTI-02 the passive view reads before the commit');

    replaceStateCalls = 0;
    const committed = doc.commit({
      documentId: doc.id,
      expectedVersion: doc.version,
      edits: [{ start: offset(0), end: offset(0), text: 'y' }],
      origin: 'vim',
      undoGroup: identifier<UndoGroupId>('FANOUT-undo-2'),
    });
    assert.equal(committed.ok, true, 'FANOUT-MULTI-03 vim edit commits with a second view present');
    assert.ok(replaceStateCalls >= 1, 'FANOUT-MULTI-04 a second view forces the external mapping to run');

    const afterRight = workbench.readView(right);
    assert.notEqual(afterRight?.session.documentVersion, beforeRight?.session.documentVersion, 'FANOUT-MULTI-05 the passive view observes the new document version');
    assert.notEqual(afterRight?.selections, beforeRight?.selections, 'FANOUT-MULTI-06 the passive view selections were mapped through the change');
  }
} finally {
  AtomicCommandCoordinator.prototype.replaceState = originalReplaceState;
}

console.log('T-KEYSTROKE-FANOUT passed: single-view vim commit collapses to exactly one state replacement; a second view on the same buffer is still mapped.');
