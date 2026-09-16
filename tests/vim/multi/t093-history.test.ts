import { strict as assert } from 'node:assert';
import {
  asIdentifier,
  asUndoGroupId,
  asUtf16Offset,
  type DocumentId,
  type SelectionId,
  type UndoGroupId,
  type Utf16Offset,
  type ViewId,
} from '../../../packages/primitives/src/index';
import { TextFileDocument, type DocumentEdit } from '../../../packages/document/src/index';
import { createSelectionSet, type SelectionMember, type SelectionMemberInput, type SelectionSet } from '../../../packages/selections/src/index';
import { VimSelectionHistory } from '../../../packages/vim/src/index';
import {
  AtomicCommandCoordinator,
  WorkbenchHistoryCoordinator,
  createAtomicWorkbenchState,
  type AtomicViewState,
  type AtomicWorkbenchState,
} from '../../../packages/workbench/src/index';

const group = identifier<UndoGroupId>('T093-change-insert');

async function testChangeInsertGroupUndoRedoAndBranches(): Promise<void> {
  const { document, atomic, history } = fixture('abcd', [
    { id: 'T093-origin', offset: 1, kind: 'normal-cursor' },
    { id: 'T093-other', offset: 3, kind: 'normal-cursor' },
  ]);
  const origin = atomic.readState().views[0];
  if (origin === undefined) throw new Error('T093-origin-view-missing');
  assert.equal(document.beginUndoGroup(group, 'vim').ok, true);
  await applyChange(atomic, origin.viewId, group);
  await applyInsert(atomic, group, 'X');
  assert.equal(document.endUndoGroup(group).ok, true);
  assert.equal(document.undoHistoryStats().entries, 1, 'MC07 change plus insert is one native history node');
  assert.equal(readText(document), 'aXcd');

  const undone = history.undo();
  assert.equal(undone.ok, true, 'one coordinator call requests one native undo');
  if (!undone.ok) return;
  assert.equal(undone.value.restoredOrigin, true, 'the originating active view restores its pre-change selection');
  assert.equal(readText(document), 'abcd');
  assert.equal(undone.value.state.views.find((view) => view.viewId === origin.viewId)?.mode, 'normal');
  assert.equal(memberOffset(undone.value.state.views.find((view) => view.viewId === origin.viewId)?.selections.members[0]), 1);

  const originalBranch = document.redoBranches()[0];
  assert.ok(originalBranch, 'undo exposes the original change-plus-insert branch');
  const afterUndo = atomic.readState();
  const currentOrigin = afterUndo.views.find((view) => view.viewId === origin.viewId);
  const originalMember = currentOrigin?.selections.members[0];
  if (currentOrigin === undefined || originalMember === undefined || originalBranch === undefined) throw new Error('T093-restored-origin-missing');
  const newPrimary = identifier<SelectionId>('T093-new-primary');
  const changedPrimary = createSelectionSet(document.snapshot(), {
    primaryId: newPrimary,
    selectionGeneration: (currentOrigin.selections.selectionGeneration as number) + 1,
    members: [normal(originalMember.id, 0, 1), normal(newPrimary, 2, 3)],
  });
  assert.equal(changedPrimary.ok, true, 'the user can choose a different primary after undo');
  if (!changedPrimary.ok) return;
  const nextOrigin = Object.freeze({ ...currentOrigin, selections: changedPrimary.value.selectionSet });
  assert.equal(atomic.replaceState({
    activeViewId: origin.viewId,
    views: afterUndo.views.map((view) => view.viewId === origin.viewId ? nextOrigin : view),
    registers: afterUndo.registers,
  }).ok, true);
  const branched = await atomic.execute({
    intent: Object.freeze({ kind: 'multi-replace-after-undo' }),
    undoGroup: identifier<UndoGroupId>('T093-new-primary-branch'),
    resolveMember: (_base, member) => {
      const at = member.anchor.at.offset as number;
      return { nextSelection: normal(member.id, at, at + 1), edits: [edit(at, at + 1, 'Z')] };
    },
  });
  assert.equal(branched.ok, true, 'an edit after undo records the new primary on its new branch');
  assert.equal(readText(document), 'ZbZd');
  const secondUndo = history.undo();
  assert.equal(secondUndo.ok, true);
  if (!secondUndo.ok) return;
  assert.equal(readText(document), 'abcd');
  assert.ok(document.redoBranches().length >= 2, 'the undo tree retains both redo branches');
  assert.equal(secondUndo.value.state.views.find((view) => view.viewId === origin.viewId)?.selections.primaryId, newPrimary, 'undo after branching restores the new primary captured by that edit');
  const newBranch = document.redoBranches().find((branch) => branch.id !== originalBranch.id);
  assert.ok(newBranch, 'the new-primary edit remains independently redoable');
  const newBranchRedo = history.redo(newBranch?.id);
  assert.equal(newBranchRedo.ok, true);
  assert.equal(readText(document), 'ZbZd');
  assert.equal(newBranchRedo.ok && newBranchRedo.value.state.views.find((view) => view.viewId === origin.viewId)?.selections.primaryId, newPrimary);
  assert.equal(history.undo().ok, true);

  const selectedRedo = history.redo(originalBranch.id);
  assert.equal(selectedRedo.ok, true, 'the selected original branch replays once and restores its origin selection');
  assert.equal(readText(document), 'aXcd');
  assert.equal(selectedRedo.ok && selectedRedo.value.restoredOrigin, true);
}

async function testUndoFromAnotherViewMapsWithoutRestoringOrigin(): Promise<void> {
  const { document, atomic, history } = fixture('abcd', [
    { id: 'T093-origin-other', offset: 1, kind: 'normal-cursor' },
    { id: 'T093-invoker', offset: 3, kind: 'normal-cursor' },
  ]);
  const originId = atomic.readState().views[0]?.viewId;
  const otherId = atomic.readState().views[1]?.viewId;
  if (originId === undefined || otherId === undefined) throw new Error('T093-view-fixture');
  assert.equal(document.beginUndoGroup(group, 'vim').ok, true);
  await applyChange(atomic, originId, group);
  await applyInsert(atomic, group, 'X');
  assert.equal(document.endUndoGroup(group).ok, true);

  const beforeSwitch = atomic.readState();
  const switched = atomic.replaceState({ activeViewId: otherId, views: beforeSwitch.views, registers: beforeSwitch.registers });
  assert.equal(switched.ok, true);
  const invokingGeneration = switched.ok ? switched.value.views.find((view) => view.viewId === otherId)?.selections.selectionGeneration : undefined;
  const undone = history.undo();
  assert.equal(undone.ok, true);
  if (!undone.ok) return;
  assert.equal(undone.value.restoredOrigin, false, 'another view’s invocation does not restore the origin’s old cursor');
  const originAfter = undone.value.state.views.find((view) => view.viewId === originId);
  const invokerAfter = undone.value.state.views.find((view) => view.viewId === otherId);
  assert.equal(originAfter?.selections.documentVersion, document.version, 'the origin view is mapped to the undone text');
  assert.equal(invokerAfter?.selections.documentVersion, document.version, 'the invoking view is mapped to the undone text');
  assert.equal(invokerAfter?.selections.selectionGeneration, invokingGeneration, 'document mapping preserves selection-only generation');
}

async function testClosedOriginIsNotResurrected(): Promise<void> {
  const { document, atomic, history } = fixture('abcd', [
    { id: 'T093-closed-origin', offset: 1, kind: 'normal-cursor' },
    { id: 'T093-survivor', offset: 3, kind: 'normal-cursor' },
  ]);
  const originId = atomic.readState().views[0]?.viewId;
  const survivorId = atomic.readState().views[1]?.viewId;
  if (originId === undefined || survivorId === undefined) throw new Error('T093-view-fixture');
  assert.equal(document.beginUndoGroup(group, 'vim').ok, true);
  await applyChange(atomic, originId, group);
  await applyInsert(atomic, group, 'X');
  assert.equal(document.endUndoGroup(group).ok, true);
  const live = atomic.readState();
  assert.equal(atomic.replaceState({ activeViewId: survivorId, views: live.views.filter((view) => view.viewId !== originId), registers: live.registers }).ok, true);
  history.closeView(originId);
  const undone = history.undo();
  assert.equal(undone.ok, true);
  if (!undone.ok) return;
  assert.equal(undone.value.restoredOrigin, false);
  assert.deepEqual(undone.value.state.views.map((view) => view.viewId), [survivorId], 'a closed view is never recreated from serialized history');
  assert.equal(undone.value.state.activeViewId, survivorId);
  assert.equal(undone.value.state.views[0]?.selections.documentVersion, document.version);
}

function testSelectionHistoryIsIndependentAndBounded(): void {
  const bounded = new VimSelectionHistory(2);
  assert.equal(bounded.record({ n: 0 }, { n: 1 }).ok, true);
  assert.equal(bounded.record({ n: 1 }, { n: 2 }).ok, true);
  assert.equal(bounded.record({ n: 2 }, { n: 3 }).ok, true);
  assert.equal(bounded.size, 2, 'selection-only history has a hard retention bound');
  assert.deepEqual(bounded.undo({ n: 3 }), { ok: true, value: { n: 2 } });
  assert.deepEqual(bounded.undo({ n: 2 }), { ok: true, value: { n: 1 } });
  assert.deepEqual(bounded.undo({ n: 1 }), { ok: false, error: { kind: 'nothing-to-undo' } });

  const branched = new VimSelectionHistory();
  branched.record({ n: 0 }, { n: 1 });
  branched.record({ n: 1 }, { n: 2 });
  assert.deepEqual(branched.undo({ n: 2 }), { ok: true, value: { n: 1 } });
  branched.record({ n: 1 }, { n: 9 });
  assert.deepEqual(branched.redo({ n: 9 }), { ok: false, error: { kind: 'nothing-to-redo' } }, 'a new selection after undo cuts the old selection redo branch');

  const unmappable = new VimSelectionHistory();
  unmappable.record({ n: 0 }, { n: 1 });
  unmappable.map(() => ({ ok: false, error: 'stale-history-position' }));
  assert.deepEqual(unmappable.undo({ n: 1 }), { ok: false, error: { kind: 'unmappable-history' } }, 'crossing a stale text-mapping boundary is diagnosed');
}

async function testSelectionUndoAndServiceEditMapping(): Promise<void> {
  const { document, atomic, history } = fixture('abcdef', [{ id: 'T093-selection-only', offset: 1, kind: 'normal-cursor' }]);
  const initial = atomic.readState();
  const version = document.version;
  const revision = document.revisionId;
  const registers = initial.registers;
  let events = 0;
  document.subscribeChanges(() => { events += 1; });

  let view = initial.views[0];
  if (view === undefined) throw new Error('T093-view-missing');
  view = changeSelection(document, view, 2, 1);
  assert.equal(history.recordSelectionTransition(view.viewId, view).ok, true);
  view = changeSelection(document, view, 3, 2);
  assert.equal(history.recordSelectionTransition(view.viewId, view).ok, true);
  assert.equal(document.undoHistoryStats().entries, 0, 'selection-only changes create no document undo entries');
  assert.equal(document.commit({
    documentId: document.id,
    expectedVersion: document.version,
    edits: [edit(0, 0, '!')],
    origin: 'lsp',
    undoGroup: identifier<UndoGroupId>('T093-service-edit'),
  }).ok, true, 'a service edit occurs between selection history entries');
  assert.equal(readText(document), '!abcdef');
  const mappedCurrent = atomic.readState().views[0];
  assert.equal(memberOffset(mappedCurrent?.selections.members[0]), 4, 'service edit maps the current selection');
  const revisionAfterServiceEdit = document.revisionId;
  const undoEntriesAfterServiceEdit = document.undoHistoryStats().entries;
  const selectionUndo = history.selectionUndo();
  assert.equal(selectionUndo.ok, true);
  if (!selectionUndo.ok) return;
  assert.equal(memberOffset(selectionUndo.value.state.views[0]?.selections.members[0]), 3, 'selection undo restores the prior set mapped through the service edit');
  assert.equal(document.version as number, (version as number) + 1, 'selection undo does not create a document revision');
  assert.equal(document.revisionId, revisionAfterServiceEdit, 'selection undo leaves text revision identity alone');
  assert.equal(document.isDirty, true, 'selection history does not modify dirty state');
  assert.equal(document.undoHistoryStats().entries, undoEntriesAfterServiceEdit, 'selection undo does not add or consume native text history');
  assert.deepEqual(selectionUndo.value.state.registers, registers, 'selection undo has no register side effects');
  assert.equal(events, 1, 'only the independent text edit emitted a document event');

  const selectionRedo = history.selectionRedo();
  assert.equal(selectionRedo.ok, true);
  assert.equal(memberOffset(selectionRedo.ok ? selectionRedo.value.state.views[0]?.selections.members[0] : undefined), 4);

  const emptyTextUndo = history.undo();
  assert.equal(emptyTextUndo.ok, true, 'text undo stays a separate operation from selection.undo');
  assert.equal(document.isDirty, false, 'native document undo returns to the saved content');
}

async function applyChange(atomic: AtomicCommandCoordinator, viewId: ViewId, undoGroup: UndoGroupId): Promise<void> {
  const result = await atomic.execute({
    intent: Object.freeze({ kind: 'change-one-character' }),
    undoGroup,
    resolveMember: (_base, member) => ({
      nextSelection: gap(member.id, 1),
      edits: [edit(1, 2, '')],
    }),
    reduceSession: () => ({ mode: 'insert' }),
  });
  if (!result.ok) throw new Error(`T093-change:${result.error.kind}`);
  assert.equal(result.value.state.activeViewId, viewId);
}

async function applyInsert(atomic: AtomicCommandCoordinator, undoGroup: UndoGroupId, text: string): Promise<void> {
  const result = await atomic.execute({
    intent: Object.freeze({ kind: 'insert-text', text }),
    undoGroup,
    resolveMember: (base, member) => {
      const at = member.anchor.at.offset as number;
      return { nextSelection: normal(member.id, at, at + text.length), edits: [edit(at, at, text)] };
    },
    reduceSession: () => ({ mode: 'normal' }),
  });
  if (!result.ok) throw new Error(`T093-insert:${result.error.kind}`);
}

function fixture(
  text: string,
  views: readonly { readonly id: string; readonly offset: number; readonly kind: 'normal-cursor' }[],
): { readonly document: TextFileDocument; readonly atomic: AtomicCommandCoordinator; readonly history: WorkbenchHistoryCoordinator } {
  const document = editable(text);
  const viewStates: AtomicViewState[] = views.map((item) => {
    const viewId = identifier<ViewId>(item.id);
    const selectionId = identifier<SelectionId>(`${item.id}-selection`);
    const created = createSelectionSet(document.snapshot(), {
      primaryId: selectionId,
      members: [normal(selectionId, item.offset, item.offset + 1)],
    });
    if (!created.ok) throw new Error(`T093-selection:${created.error.kind}`);
    return { viewId, selections: created.value.selectionSet, mode: 'normal', repeatTarget: null };
  });
  const createdState = createAtomicWorkbenchState(document.snapshot(), {
    activeViewId: viewStates[0]?.viewId as ViewId,
    views: viewStates,
  });
  if (!createdState.ok) throw new Error(`T093-state:${createdState.error.kind}`);
  const atomic = new AtomicCommandCoordinator(document, createdState.value);
  return { document, atomic, history: new WorkbenchHistoryCoordinator(atomic) };
}

function changeSelection(document: TextFileDocument, view: AtomicViewState, position: number, generation: number): AtomicViewState {
  const member = view.selections.members[0];
  if (member === undefined) throw new Error('T093-member-missing');
  const created = createSelectionSet(document.snapshot(), {
    primaryId: member.id,
    selectionGeneration: generation,
    members: [normal(member.id, position, position + 1)],
  });
  if (!created.ok) throw new Error(`T093-selection-change:${created.error.kind}`);
  return Object.freeze({ ...view, selections: created.value.selectionSet });
}

function editable(text: string): TextFileDocument {
  const lineEndings = Array.from({ length: [...text].filter((character) => character === '\n').length }, () => 'lf' as const);
  const created = TextFileDocument.create(identifier<DocumentId>('T093-document'), text, lineEndings, 'lf');
  if (!created.ok) throw new Error(`T093-document:${created.error.kind}`);
  return created.value;
}

function normal(id: SelectionId, start: number, end: number): SelectionMemberInput {
  return {
    id,
    kind: 'normal-cursor',
    direction: 'forward',
    anchor: { kind: 'character', offset: offset(start), after: offset(end) },
    head: { kind: 'character', offset: offset(start), after: offset(end) },
  };
}

function gap(id: SelectionId, position: number): SelectionMemberInput {
  const endpoint = { kind: 'gap' as const, offset: offset(position) };
  return { id, kind: 'insert-caret', direction: 'forward', anchor: endpoint, head: endpoint };
}

function memberOffset(member: SelectionMember | undefined): number | undefined { return member?.anchor.at.offset as number | undefined; }
function edit(start: number, end: number, text: string): DocumentEdit { return { start: offset(start), end: offset(end), text }; }
function offset(value: number): Utf16Offset {
  const checked = asUtf16Offset(value);
  if (!checked.ok) throw new Error(`T093-offset:${checked.error.message}`);
  return checked.value;
}
function identifier<T extends string>(value: string): T {
  const checked = asIdentifier<T>(value, 'fixtureId');
  if (!checked.ok) throw new Error(`T093-id:${checked.error.message}`);
  return checked.value;
}
function readText(document: TextFileDocument): string {
  const snapshot = document.snapshot();
  const read = snapshot.slice(offset(0), offset(snapshot.lengthUtf16 as number));
  if (!read.ok) throw new Error(`T093-read:${read.error.kind}`);
  return read.value;
}

await testChangeInsertGroupUndoRedoAndBranches();
await testUndoFromAnotherViewMapsWithoutRestoringOrigin();
await testClosedOriginIsNotResurrected();
testSelectionHistoryIsIndependentAndBounded();
await testSelectionUndoAndServiceEditMapping();
