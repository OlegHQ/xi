import assert from 'node:assert/strict';
import { ViewSelectionPersistence, type PersistedViewSelection } from '../../packages/workbench/session/selection-persistence';
import { TextFileDocument } from '../../packages/document/src/index';
import { createSelectionSet, type EndpointInput } from '../../packages/selections/src/index';
import { WorkbenchSession } from '../../packages/workbench/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type SelectionId, type ViewId } from '../../packages/primitives/src/index';

const view = (viewId: string, hash = 'hash'): PersistedViewSelection => ({ viewId, documentId: 'doc', contentHash: hash, documentVersion: 4, scrollTop: 7, scrollLeft: 2, primaryId: 'one', members: [{ id: 'one', anchor: 1, head: 3, kind: 'normal-cursor' }, { id: 'two', anchor: 8, head: 8, kind: 'normal-cursor' }] });
const persistence = new ViewSelectionPersistence();
const encoded = persistence.encode([view('left'), view('right')]); assert.equal(encoded.ok, true, 'T095-ENCODE-01 independent views encode');
if ('error' in encoded) throw new Error(String(encoded.error));
const decoded = persistence.decode(encoded.value); assert.equal(decoded.ok, true); if ('error' in decoded) throw new Error(String(decoded.error));
assert.equal(decoded.value.views[0]?.scrollTop, 7); assert.equal(decoded.value.views[1]?.viewId, 'right', 'T095-MC10-01 split view state remains independent');
const serializedRestored = persistence.restore(decoded.value, { openViewIds: new Set(['left', 'right']), contentHashes: new Map([['doc', 'hash']]) }); assert.equal(serializedRestored.ok, true);
const changed = persistence.restore(decoded.value, { openViewIds: new Set(['left', 'right']), contentHashes: new Map([['doc', 'changed']]) }); assert.equal(changed.ok, false, 'T095-FAIL-DISK-01 changed content cannot restore offsets');
const closed = persistence.restore(decoded.value, { openViewIds: new Set(['left']), contentHashes: new Map([['doc', 'hash']]) }); assert.equal(closed.ok, false, 'T095-FAIL-CLOSED-01 closed view does not erase or retarget state');
const unknown = persistence.decode(new TextEncoder().encode('{"schemaVersion":99,"views":[]}')); assert.equal(unknown.ok, false, 'T095-FAIL-SCHEMA-01 unknown schema preserved as failure');

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 't095-id');
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
  const result = TextFileDocument.create(identifier<DocumentId>(id), 'abcdef\n', ['lf'], 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

const shared = document('T095-workbench-document');
const workbench = new WorkbenchSession({ workspaceId: 'T095-workbench' });
const opened = workbench.openBuffer(shared, { viewId: identifier<ViewId>('T095-view-left') });
assert.equal(opened.ok, true, 'T095-MC10-01 first split view opens');
if (!opened.ok) throw new Error('T095-open');
const left = opened.value.viewIds[0] as ViewId;
const split = workbench.splitView(left, 'vertical', identifier<ViewId>('T095-view-right'));
assert.equal(split.ok, true, 'T095-MC10-02 second split view shares the document');
if (!split.ok) throw new Error('T095-split');
const right = split.value.viewId;
const leftPrimary = identifier<SelectionId>('T095-left-primary');
const rightPrimary = identifier<SelectionId>('T095-right-primary');
const leftSet = createSelectionSet(shared.snapshot(), { primaryId: leftPrimary, members: [cursor(leftPrimary, 1), cursor(identifier<SelectionId>('T095-left-secondary'), 4)] });
const rightSet = createSelectionSet(shared.snapshot(), { primaryId: rightPrimary, members: [cursor(rightPrimary, 3), cursor(identifier<SelectionId>('T095-right-secondary'), 5)] });
assert.equal(leftSet.ok, true, 'T095-MC10-03 left selection set is valid');
assert.equal(rightSet.ok, true, 'T095-MC10-04 right selection set is valid');
if (!leftSet.ok || !rightSet.ok) throw new Error('T095-selection');
assert.equal(workbench.syncViewSession(left, leftSet.value.selectionSet, 'normal').ok, true, 'T095-MC10-05 left selection is owned by its view');
assert.equal(workbench.syncViewSession(right, rightSet.value.selectionSet, 'normal').ok, true, 'T095-MC10-06 right selection is owned by its view');
assert.equal(workbench.setViewScroll(left, 11, 2).ok, true, 'T095-MC10-07 left scroll is independent');
assert.equal(workbench.setViewScroll(right, 23, 4).ok, true, 'T095-MC10-08 right scroll is independent');
const captured = workbench.captureSelectionPersistence(new Map([[String(shared.id), 'T095-content-hash']]));
assert.equal(captured.ok, true, 'T095-MC10-09 workbench captures every open view');
if (!captured.ok) throw new Error('T095-capture');

const changedEvents: unknown[] = [];
shared.subscribeChanges((change) => changedEvents.push(change));
const resetLeft = createSelectionSet(shared.snapshot(), { primaryId: leftPrimary, members: [cursor(leftPrimary, 0), cursor(identifier<SelectionId>('T095-left-secondary'), 2)] });
const resetRight = createSelectionSet(shared.snapshot(), { primaryId: rightPrimary, members: [cursor(rightPrimary, 0), cursor(identifier<SelectionId>('T095-right-secondary'), 2)] });
if (!resetLeft.ok || !resetRight.ok) throw new Error('T095-reset-selection');
assert.equal(workbench.syncViewSession(left, resetLeft.value.selectionSet, 'normal').ok, true, 'T095-MC10-10 test mutates left selection state');
assert.equal(workbench.syncViewSession(right, resetRight.value.selectionSet, 'normal').ok, true, 'T095-MC10-11 test mutates right selection state');
assert.equal(workbench.setViewScroll(left, 0, 0).ok, true, 'T095-MC10-12 test mutates left scroll state');
assert.equal(workbench.setViewScroll(right, 0, 0).ok, true, 'T095-MC10-13 test mutates right scroll state');
const restored = workbench.restoreSelectionPersistence(captured.value, new Map([[String(shared.id), 'T095-content-hash']]));
if (!restored.ok) throw new Error(`T095-restore:${restored.error.kind}`);
assert.equal(restored.ok, true, 'T095-MC10-14 workbench restores all view state atomically');
assert.equal(workbench.readView(left)?.selections.members[0]?.head.at.offset, 1, 'T095-MC10-15 left primary endpoint is restored');
assert.equal(workbench.readView(right)?.selections.members[0]?.head.at.offset, 3, 'T095-MC10-16 right primary endpoint is restored independently');
assert.equal(workbench.views().find((view) => view.viewId === left)?.scrollTop, 11, 'T095-MC10-17 left scroll is restored');
assert.equal(workbench.views().find((view) => view.viewId === right)?.scrollTop, 23, 'T095-MC10-18 right scroll is restored');
assert.equal(changedEvents.length, 0, 'T095-MC10-19 selection recovery emits no didChange text event');

const beforeFailure = workbench.readView(left)?.selections.members[0]?.head.at.offset;
const failedRestore = workbench.restoreSelectionPersistence(captured.value, new Map([[String(shared.id), 'T095-changed-hash']]));
assert.equal(failedRestore.ok, false, 'T095-FAIL-DISK-02 changed content rejects workbench restore');
assert.equal(workbench.readView(left)?.selections.members[0]?.head.at.offset, beforeFailure, 'T095-FAIL-DISK-03 failed restore leaves current selection intact');
assert.equal(workbench.closeView(right, 'discard').ok, true, 'T095-FAIL-CLOSED-02 closed split view is removed');
const closedRestore = workbench.restoreSelectionPersistence(captured.value, new Map([[String(shared.id), 'T095-content-hash']]));
assert.equal(closedRestore.ok, false, 'T095-FAIL-CLOSED-03 closed view cannot be retargeted during restore');
workbench.dispose();
console.log('T095 selection persistence passed independent split sets, coordinator recovery, no-didChange restore, content identity checks, closed targets and schema rejection');
