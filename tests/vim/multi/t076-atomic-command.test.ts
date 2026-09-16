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
import { normalizeAtomicEdits } from '../../../packages/vim/src/index';
import {
  AtomicCommandCoordinator,
  createAtomicWorkbenchState,
  type AtomicCommandRequest,
  type AtomicPreparationStage,
  type AtomicViewState,
  type AtomicWorkbenchState,
} from '../../../packages/workbench/src/index';

const undoGroup = identifier<UndoGroupId>('T076-one-command-group');

function testEditMergeConflictPolicies(): void {
  const document = editable('abcdef');
  const base = document.snapshot();
  const merged = normalizeAtomicEdits(base, [edit(1, 4, ''), edit(3, 5, '')]);
  assert.equal(merged.ok, true, 'T076-MC03-DELETE-UNION-01 overlapping pure deletes compose');
  if (merged.ok) assert.deepEqual(merged.value.map(numericEdit), [{ start: 1, end: 5, text: '' }]);

  const duplicateInsert = normalizeAtomicEdits(base, [edit(2, 2, 'X'), edit(2, 2, 'X')]);
  assert.equal(duplicateInsert.ok, true, 'T076-MC03-INSERT-DEDUP-01 identical insertions are idempotent');
  if (duplicateInsert.ok) assert.deepEqual(duplicateInsert.value.map(numericEdit), [{ start: 2, end: 2, text: 'X' }]);

  expectConflict(normalizeAtomicEdits(base, [edit(2, 2, 'X'), edit(2, 2, 'Y')]), 'different-inserts-at-same-position', 'T076-MC03-DIFFERENT-INSERTS-01');
  expectConflict(normalizeAtomicEdits(base, [edit(1, 4, 'X'), edit(3, 5, 'Y')]), 'overlapping-replacements', 'T076-MC03-INTERSECTING-REPLACEMENTS-01');
  expectConflict(normalizeAtomicEdits(base, [edit(1, 4, ''), edit(3, 5, 'Y')]), 'delete-overlaps-replacement', 'T076-MC03-DELETE-REPLACE-CONFLICT-01');
  expectConflict(normalizeAtomicEdits(base, [edit(1, 4, 'X'), edit(4, 4, 'Y')]), 'insertion-touches-replacement', 'T076-MC03-INSERT-BOUNDARY-01');
}

function testDocumentCandidatePreviewIsSideEffectFree(): void {
  const document = editable('a\nb');
  const base = document.snapshot();
  let events = 0;
  document.subscribeChanges(() => { events += 1; });
  const candidate = document.previewTextEdits([edit(1, 1, 'X')], base.version);
  assert.equal(candidate.ok, true, 'T076-MC03-PREVIEW-01 a valid batch produces a candidate snapshot');
  if (!candidate.ok) return;
  assert.equal(candidate.value.version as number, (base.version as number) + 1, 'candidate has the predicted next version');
  const candidateText = candidate.value.slice(offset(0), offset(candidate.value.lengthUtf16 as number));
  assert.deepEqual(candidateText, { ok: true, value: 'aX\nb' });
  assert.equal(document.version, base.version, 'preview does not advance the live version');
  assert.equal(document.revisionId, base.revisionId, 'preview does not allocate a live revision');
  assert.equal(readText(document), 'a\nb', 'preview leaves live content unchanged');
  assert.equal(events, 0, 'preview emits no document event');
}

async function testSingleRevisionCoherentPublicationAndUndoGroup(): Promise<void> {
  const { document, coordinator } = fixture('abcd', [
    { viewId: 'T076-main', positions: [0, 4] },
    { viewId: 'T076-other', positions: [2] },
  ]);
  const before = document.snapshot();
  const observed: { readonly version: number; readonly mode: string; readonly activeVersion: number; readonly secondaryPosition: number }[] = [];
  const reentrantResults: { readonly ok: boolean; readonly error?: string }[] = [];
  const stateMutationResults: { readonly ok: boolean; readonly error?: string }[] = [];
  const resolverBaseVersions: number[] = [];
  const sharedIntent = Object.freeze({ kind: 'multi-insert', text: Object.freeze(['X', 'Y']) });
  const receivedIntents: unknown[] = [];
  const subscription = document.subscribeChanges((change) => {
    const state = coordinator.readState();
    const active = state.views.find((view) => view.viewId === state.activeViewId);
    const other = state.views.find((view) => view.viewId !== state.activeViewId);
    observed.push({
      version: change.after as number,
      mode: active?.mode ?? '',
      activeVersion: active?.selections.documentVersion as number,
      secondaryPosition: other?.selections.members[0]?.anchor.at.offset as number,
    });
    const nested = document.apply(edit(0, 0, '!'), change.after);
    reentrantResults.push({ ok: nested.ok, ...(nested.ok ? {} : { error: nested.error.kind }) });
    const attemptedStateUpdate = coordinator.replaceState({
      activeViewId: state.activeViewId,
      views: state.views,
      registers: state.registers,
    });
    stateMutationResults.push({ ok: attemptedStateUpdate.ok, ...(attemptedStateUpdate.ok ? {} : { error: attemptedStateUpdate.error.kind }) });
  });

  const request: AtomicCommandRequest = {
    intent: sharedIntent,
    undoGroup,
    resolveMember: (base, member, _index, intent) => {
      receivedIntents.push(intent);
      resolverBaseVersions.push(base.version as number);
      const at = member.anchor.at.offset as number;
      return at === 0
        ? { nextSelection: normal(member.id, 0, 1), edits: [edit(0, 0, 'X')] }
        : { nextSelection: normal(member.id, 5, 6), edits: [edit(4, 4, 'Y')] };
    },
    reduceSession: () => ({
      mode: 'normal',
      repeatTarget: { kind: 'insert-recipe', text: 'XY' },
      registerWrites: [{ name: 'a', value: ['X', 'Y'] }],
    }),
  };
  const result = await coordinator.execute(request);
  if (!result.ok) throw new Error(`T076-MC03-COMMIT-01:${result.error.kind}`);
  assert.equal(result.ok, true, 'T076-MC03-COMMIT-01 prepared multi-edit command commits');
  assert.equal(result.value.kind, 'committed');
  assert.deepEqual(resolverBaseVersions, [before.version as number, before.version as number], 'T076-MC03-ONE-BASE-01 every member resolves against the same immutable snapshot');
  assert.equal(receivedIntents.length, 2);
  assert.equal(receivedIntents[0], sharedIntent, 'T076-MC03-SHARED-GRAMMAR-01 every member receives one captured parse result');
  assert.equal(receivedIntents[1], sharedIntent, 'the multi-command is not reparsed independently per member');
  assert.equal(result.value.editCount, 2);
  assert.equal(document.version as number, (before.version as number) + 1, 'one command publishes one document version');
  assert.equal(document.revisionId as number, (before.revisionId as number) + 1, 'one command creates one content revision');
  assert.equal(readText(document), 'XabcdY');
  assert.equal(observed.length, 1, 'one command publishes one coherent document event');
  assert.deepEqual(observed[0], { version: 2, mode: 'normal', activeVersion: 2, secondaryPosition: 3 }, 'MC03 event observers see matching workbench state and mapped other-view selections');
  assert.deepEqual(reentrantResults, [{ ok: false, error: 'reentrant-transaction' }], 'T076-MC03-REENTRANT-01 an observer cannot publish a nested edit');
  assert.deepEqual(stateMutationResults, [{ ok: false, error: 'stale-state' }], 'T076-MC03-OBSERVER-STATE-01 a listener cannot replace state during event publication');
  assert.equal(result.value.state.registers.find((register) => register.name === 'a')?.value instanceof Array, true);
  assert.equal(result.value.state.views.find((view) => view.viewId === 'T076-main')?.mode, 'normal');
  assert.equal(observed[0]?.version, result.value.documentVersion as number);

  subscription.dispose();
  const undone = document.undo();
  assert.equal(undone.ok, true, 'T076-MC03-UNDO-GROUP-01 one native undo restores the complete command batch');
  assert.equal(readText(document), 'abcd');
}

async function testStateOnlyDoesNotCreateTextRevision(): Promise<void> {
  const { document, coordinator } = fixture('abcd', [{ viewId: 'T076-main', positions: [1] }]);
  const before = document.snapshot();
  let events = 0;
  document.subscribeChanges(() => { events += 1; });
  const result = await coordinator.execute({
    intent: null,
    undoGroup,
    resolveMember: (_base, member) => ({ nextSelection: gap(member.id, 2), edits: [] }),
    reduceSession: () => ({ mode: 'replace', repeatTarget: 'repeat-state', registerWrites: [{ name: 'b', value: 'captured' }] }),
  });
  assert.equal(result.ok, true, 'T076-MC03-STATE-ONLY-01 state transition succeeds');
  if (!result.ok) return;
  assert.equal(result.value.kind, 'state-only');
  assert.equal(document.version, before.version, 'selection/register/mode changes do not create a document version');
  assert.equal(document.revisionId, before.revisionId, 'selection/register/mode changes do not create a text revision');
  assert.equal(events, 0, 'state-only changes emit no document event');
  assert.equal(result.value.state.registers.find((register) => register.name === 'b')?.value, 'captured');
  assert.equal(result.value.state.views[0]?.mode, 'replace');
  assert.equal(document.undo().ok, false, 'state-only commands do not create native undo entries');
}

async function testInjectedPreparationFailuresAreSideEffectFree(): Promise<void> {
  const stages: readonly AtomicPreparationStage[] = [
    'resolve-member',
    'normalize-edits',
    'reduce-session',
    'preview-document',
    'prepare-selections',
    'prepare-session-state',
    'before-commit',
  ];
  for (const failedStage of stages) {
    const { document, coordinator } = fixture('abcd', [{ viewId: `T076-${failedStage}`, positions: [1] }]);
    const beforeSnapshot = document.snapshot();
    const beforeState = coordinator.readState();
    let events = 0;
    document.subscribeChanges(() => { events += 1; });
    const result = await coordinator.execute({
      intent: null,
      undoGroup,
      resolveMember: (_base, member) => ({ nextSelection: gap(member.id, 2), edits: [edit(1, 1, 'X')] }),
      reduceSession: () => ({ mode: 'replace', repeatTarget: 'new-repeat', registerWrites: [{ name: 'a', value: 'new-register' }] }),
      onPreparationStage: (stage) => { if (stage === failedStage) throw new Error(`injected:${stage}`); },
    });
    assert.equal(result.ok, false, `T076-MC03-FAIL-${failedStage} injected failure rejects`);
    if (!result.ok) assert.deepEqual(result.error, { kind: 'preparation-failed', stage: failedStage });
    assert.equal(readText(document), 'abcd', `T076-MC03-FAIL-${failedStage} leaves text untouched`);
    assert.equal(document.version, beforeSnapshot.version);
    assert.equal(document.revisionId, beforeSnapshot.revisionId);
    assert.equal(coordinator.readState(), beforeState, `T076-MC03-FAIL-${failedStage} retains the exact prior state pointer`);
    assert.equal(events, 0, `T076-MC03-FAIL-${failedStage} publishes no document event`);
  }
}

async function testDocumentCommitRejectionRestoresPreparedSessionState(): Promise<void> {
  const { document, coordinator } = fixture('abcd', [{ viewId: 'T076-commit-reject', positions: [1] }]);
  const before = coordinator.readState();
  let events = 0;
  document.subscribeChanges(() => { events += 1; });
  assert.equal(asUndoGroupId('').ok, false, 'fixture uses a group id rejected at the document boundary');
  const result = await coordinator.execute({
    intent: null,
    undoGroup: '' as UndoGroupId,
    resolveMember: (_base, member) => ({ nextSelection: gap(member.id, 2), edits: [edit(1, 1, 'X')] }),
    reduceSession: () => ({ mode: 'replace', repeatTarget: 'new-repeat', registerWrites: [{ name: 'a', value: 'new-register' }] }),
  });
  assert.equal(result.ok, false, 'T076-MC03-COMMIT-REJECT-01 document rejects an invalid prepared proposal');
  if (!result.ok) assert.deepEqual(result.error, { kind: 'document-commit-failed', cause: { kind: 'invalid-undo-group' } });
  assert.equal(readText(document), 'abcd', 'rejected document proposal does not change text');
  assert.equal(coordinator.readState(), before, 'T076-MC03-COMMIT-ROLLBACK-01 prepared session pointer is restored on commit rejection');
  assert.equal(events, 0, 'rejected proposal emits no change event');
}

async function testConflictingMultiEditsRejectWholeCommand(): Promise<void> {
  const { document, coordinator } = fixture('abcdef', [{ viewId: 'T076-conflict', positions: [1, 4] }]);
  const before = coordinator.readState();
  const failed = await coordinator.execute({
    intent: null,
    undoGroup,
    resolveMember: (_base, member, index) => ({
      nextSelection: gap(member.id, 1),
      edits: [index === 0 ? edit(2, 2, 'X') : edit(2, 2, 'Y')],
    }),
  });
  assert.equal(failed.ok, false, 'T076-MC03-DIFFERENT-INSERTS-02 conflicting member intents reject');
  if (!failed.ok) assert.deepEqual(failed.error, { kind: 'edit-conflict', conflict: 'different-inserts-at-same-position' });
  assert.equal(readText(document), 'abcdef');
  assert.equal(coordinator.readState(), before);

  const deleted = await coordinator.execute({
    intent: null,
    undoGroup,
    resolveMember: (_base, member, index) => ({
      nextSelection: gap(member.id, 1),
      edits: [index === 0 ? edit(1, 4, '') : edit(3, 5, '')],
    }),
  });
  assert.equal(deleted.ok, true, 'T076-MC03-DELETE-UNION-02 overlapping delete intents compose');
  assert.equal(readText(document), 'af', 'overlapping ranges are deleted once as their union');
  assert.equal(deleted.ok && deleted.value.kind, 'committed');
}

async function testYieldCancellationAndStalenessDoNotPublishCommandEdits(): Promise<void> {
  {
    const { document, coordinator } = fixture('abcd', [{ viewId: 'T076-cancel', positions: [0, 3] }]);
    const before = coordinator.readState();
    const controller = new AbortController();
    const result = await coordinator.execute({
      intent: null,
      undoGroup,
      resolveMember: (_base, member) => ({ nextSelection: gap(member.id, 1), edits: [edit(0, 0, 'X')] }),
      signal: controller.signal,
      yieldEveryMembers: 1,
      yieldControl: async () => { controller.abort(); },
    });
    assert.equal(result.ok, false, 'T076-MC03-CANCEL-01 a yielded command observes cancellation');
    if (!result.ok) assert.equal(result.error.kind, 'cancelled');
    assert.equal(readText(document), 'abcd');
    assert.equal(coordinator.readState(), before);
  }
  {
    const { document, coordinator } = fixture('abcd', [{ viewId: 'T076-stale-selection', positions: [0, 3] }]);
    const prior = coordinator.readState();
    const result = await coordinator.execute({
      intent: null,
      undoGroup,
      resolveMember: (_base, member) => ({ nextSelection: gap(member.id, 1), edits: [edit(0, 0, 'X')] }),
      yieldEveryMembers: 1,
      yieldControl: async () => {
        const changed = selection(document, [1, 2], [selectionId('T076-stale-selection-0'), selectionId('T076-stale-selection-1')], 1);
        const view: AtomicViewState = { ...(prior.views[0] as AtomicViewState), selections: changed };
        assert.equal(coordinator.replaceState({ activeViewId: prior.activeViewId, views: [view], registers: prior.registers }).ok, true);
      },
    });
    assert.equal(result.ok, false, 'T076-MC03-STALE-SELECTION-01 a changed selection generation invalidates pending plans');
    if (!result.ok) assert.equal(result.error.kind, 'stale-state');
    assert.equal(readText(document), 'abcd', 'stale command edits do not leak into the document');
    assert.notEqual(coordinator.readState(), prior, 'the independently published selection update remains installed');
  }
  {
    const { document, coordinator } = fixture('abcd', [{ viewId: 'T076-stale-document', positions: [0, 3] }]);
    const result = await coordinator.execute({
      intent: null,
      undoGroup,
      resolveMember: (_base, member) => ({ nextSelection: gap(member.id, 1), edits: [edit(0, 0, 'X')] }),
      yieldEveryMembers: 1,
      yieldControl: async () => { assert.equal(document.apply(edit(0, 0, '!'), document.version).ok, true); },
    });
    assert.equal(result.ok, false, 'T076-MC03-STALE-DOCUMENT-01 a changed document version invalidates pending plans');
    if (!result.ok) assert.equal(result.error.kind, 'stale-document');
    assert.equal(readText(document), '!abcd', 'only the independent concurrent edit is visible');
  }
}

function fixture(text: string, views: readonly { readonly viewId: string; readonly positions: readonly number[] }[]): { readonly document: TextFileDocument; readonly coordinator: AtomicCommandCoordinator } {
  const document = editable(text);
  const viewStates = views.map(({ viewId, positions }) => ({
    viewId: identifier<ViewId>(viewId),
    selections: selection(document, positions, positions.map((_, index) => selectionId(`${viewId}-${index}`))),
    mode: 'insert' as const,
    repeatTarget: null,
  }));
  const created = createAtomicWorkbenchState(document.snapshot(), {
    activeViewId: viewStates[0]?.viewId as ViewId,
    views: viewStates,
    registers: [{ name: 'a', value: 'prior-register' }],
  });
  if (!created.ok) throw new Error(`T076-state:${created.error.kind}`);
  return { document, coordinator: new AtomicCommandCoordinator(document, created.value) };
}

function editable(text: string): TextFileDocument {
  const lineEndings = Array.from({ length: [...text].filter((character) => character === '\n').length }, () => 'lf' as const);
  const created = TextFileDocument.create(identifier<DocumentId>('T076-document'), text, lineEndings, 'lf');
  if (!created.ok) throw new Error(`T076-document:${created.error.kind}`);
  return created.value;
}

function selection(document: TextFileDocument, positions: readonly number[], ids: readonly SelectionId[], generation = 0): SelectionSet {
  const created = createSelectionSet(document.snapshot(), {
    primaryId: ids[0] as SelectionId,
    selectionGeneration: generation,
    members: positions.map((position, index) => gap(ids[index] as SelectionId, position)),
  });
  if (!created.ok) throw new Error(`T076-selection:${created.error.kind}`);
  return created.value.selectionSet;
}

function gap(id: SelectionId, position: number): SelectionMemberInput {
  const endpoint = { kind: 'gap' as const, offset: offset(position) };
  return { id, kind: 'insert-caret', direction: 'forward', anchor: endpoint, head: endpoint };
}

function normal(id: SelectionId, start: number, end: number): SelectionMemberInput {
  const endpoint = { kind: 'character' as const, offset: offset(start), after: offset(end) };
  return { id, kind: 'normal-cursor', direction: 'forward', anchor: endpoint, head: endpoint };
}

function memberOffset(member: SelectionMember): number { return member.anchor.at.offset as number; }
function edit(start: number, end: number, text: string): DocumentEdit { return { start: offset(start), end: offset(end), text }; }
function numericEdit(value: DocumentEdit): { readonly start: number; readonly end: number; readonly text: string } {
  return { start: value.start as number, end: value.end as number, text: value.text };
}
function offset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error(`T076-offset:${result.error.message}`);
  return result.value;
}
function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'fixtureId');
  if (!result.ok) throw new Error(`T076-id:${result.error.message}`);
  return result.value;
}
function selectionId(value: string): SelectionId { return identifier<SelectionId>(value); }
function readText(document: TextFileDocument): string {
  const snapshot = document.snapshot();
  const result = snapshot.slice(offset(0), offset(snapshot.lengthUtf16 as number));
  if (!result.ok) throw new Error(`T076-read:${result.error.kind}`);
  return result.value;
}
function expectConflict(
  result: ReturnType<typeof normalizeAtomicEdits>,
  expected: string,
  fixtureId: string,
): void {
  assert.equal(result.ok, false, `${fixtureId} rejects ambiguous edits`);
  if (!result.ok) assert.equal(result.error.conflict, expected, `${fixtureId} explains the conflict`);
}

testEditMergeConflictPolicies();
testDocumentCandidatePreviewIsSideEffectFree();
await testSingleRevisionCoherentPublicationAndUndoGroup();
await testStateOnlyDoesNotCreateTextRevision();
await testInjectedPreparationFailuresAreSideEffectFree();
await testDocumentCommitRejectionRestoresPreparedSessionState();
await testConflictingMultiEditsRejectWholeCommand();
await testYieldCancellationAndStalenessDoNotPublishCommandEdits();
