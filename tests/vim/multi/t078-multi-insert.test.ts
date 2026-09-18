import { strict as assert } from 'node:assert';
import {
  asIdentifier,
  asUndoGroupId,
  asUtf16Offset,
  type DocumentId,
  type SelectionId,
  type UndoGroupId,
  type Utf16Offset,
} from '../../../packages/primitives/src/index';
import {
  DocumentChangeMap,
  openTextDocument,
  type DocumentEdit,
  type TextFileDocument,
} from '../../../packages/document/src/index';
import {
  beginVimInsert,
  planVimInsertInput,
  type VimInsertEntryKey,
  type VimInsertOptions,
} from '../../../packages/vim/insert/index';
import {
  beginVimMultiInsert,
  mapVimMultiInsertSession,
  planVimMultiInsertInput,
  type VimMultiInsertPlan,
  type VimMultiInsertSession,
} from '../../../packages/vim/insert/multi';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture } from '../../oracle/types';

const encoder = new TextEncoder();
const GROUP = identifier<UndoGroupId>('T078-shared-insert-group');

async function testSingletonOracleEquivalence(): Promise<void> {
  const oracle = await verifyOracleBundle();
  const fixture: OracleFixture = {
    id: 'T078-MC01-SINGLETON-INSERT-01',
    title: 'singleton Insert remains the pinned oracle behavior',
    purpose: 'MC01 singleton equivalence for the shared multi-cursor Insert planner',
    modes: ['normal', 'insert'],
    lines: ['abcd'],
    cursor: { line: 1, byteColumn0: 1 },
    steps: [{ label: 'insert and exit', keys: 'iX<Esc>', drain: true }],
  };
  const expected = (await runOracleFixture(fixture, oracle.binaryPath)).snapshots.at(-1);
  assert.ok(expected, 'T078-MC01-ORACLE-01 pinned singleton snapshot exists');
  if (expected === undefined) return;

  const document = editable('abcd', 'T078-MC01-document');
  const entered = beginVimMultiInsert(document.snapshot(), [{ id: selectionId('T078-singleton'), cursorOffset: offset(1) }], 'i');
  assert.equal(entered.ok, true, 'T078-MC01-ENTRY-01 singleton multi session enters Insert');
  if (!entered.ok) return;
  let session: VimMultiInsertSession = entered.value.session;
  let state = apply(document, entered.value.plan, false);
  const singleton = beginVimInsert(document.snapshot(), offset(1), 'i');
  assert.equal(singleton.ok, true, 'T078-MC01-SINGLETON-01 ordinary planner enters at the same gap');
  if (!singleton.ok) return;
  const ordinary = planVimInsertInput(document.snapshot(), singleton.value.session, { kind: 'key', key: 'X' });
  assert.equal(ordinary.ok, true, 'T078-MC01-SINGLETON-02 ordinary planner accepts X');
  if (!ordinary.ok) return;
  const planned = planVimMultiInsertInput(document.snapshot(), session, { kind: 'key', key: 'X' });
  assert.equal(planned.ok, true, 'T078-MC01-PLAN-01 shared planner accepts X');
  if (!planned.ok) return;
  assert.deepEqual(planned.value.edits.map(numericEdit), ordinary.value.plan.edits.map(numericEdit), 'T078-MC01-PLAN-02 singleton and multi plans are identical');
  session = planned.value.nextSession as VimMultiInsertSession;
  state = apply(document, planned.value, state);
  const escaped = planVimMultiInsertInput(document.snapshot(), session, { kind: 'key', key: '<Esc>' });
  assert.equal(escaped.ok, true, 'T078-MC01-EXIT-01 singleton multi session exits Insert');
  if (!escaped.ok) return;
  apply(document, escaped.value, state);
  assert.deepEqual(read(document).split('\n'), expected.lines, 'T078-MC01-ORACLE-02 singleton final text matches Neovim');
  assert.equal(escaped.value.nextSession, null, 'T078-MC01-EXIT-02 all members converge to Normal');
}

function testBroadcastUnicodeNewlineAndOpaquePaste(): void {
  const document = editable('alpha\n  beta', 'T078-MC05-unicode');
  const entered = beginVimMultiInsert(document.snapshot(), [
    { id: selectionId('T078-u-0'), cursorOffset: offset(1) },
    { id: selectionId('T078-u-1'), cursorOffset: offset(8) },
  ], 'i');
  assert.equal(entered.ok, true, 'T078-MC05-ENTRY-01 two carets enter one shared Insert mode');
  if (!entered.ok) return;
  let session = entered.value.session;
  let open = apply(document, entered.value.plan, false);
  const pasted = planVimMultiInsertInput(document.snapshot(), session, { kind: 'paste', bytes: encoder.encode('<Esc>😀\nZ') });
  assert.equal(pasted.ok, true, 'T078-MC05-PASTE-01 Unicode/newline paste is accepted');
  if (!pasted.ok) return;
  assert.deepEqual(pasted.value.edits.map((edit) => edit.text), ['<Esc>😀\nZ', '<Esc>😀\nZ'], 'T078-MC05-PASTE-02 terminal notation remains opaque literal text');
  session = pasted.value.nextSession as VimMultiInsertSession;
  open = apply(document, pasted.value, open);
  const escaped = planVimMultiInsertInput(document.snapshot(), session, { kind: 'key', key: '<Esc>' });
  assert.equal(escaped.ok, true, 'T078-MC05-PASTE-03 paste session exits cleanly');
  if (!escaped.ok) return;
  apply(document, escaped.value, open);
  assert.equal(read(document), 'a<Esc>😀\nZlpha\n  <Esc>😀\nZbeta', 'T078-MC05-PASTE-04 both members receive identical Unicode/newline text');

  const indented = editable('a\n  b', 'T078-MC05-indent');
  const indentedEntry = beginVimMultiInsert(indented.snapshot(), [
    { id: selectionId('T078-i-0'), cursorOffset: offset(1) },
    { id: selectionId('T078-i-1'), cursorOffset: offset(5) },
  ], 'i', { autoindent: true });
  assert.equal(indentedEntry.ok, true, 'T078-MC05-INDENT-01 independent lines enter with one shared autoindent profile');
  if (!indentedEntry.ok) return;
  let indentedOpen = apply(indented, indentedEntry.value.plan, false);
  const newlines = planVimMultiInsertInput(indented.snapshot(), indentedEntry.value.session, { kind: 'key', key: '<CR>' });
  assert.equal(newlines.ok, true, 'T078-MC05-INDENT-02 newline broadcasts to all members');
  if (!newlines.ok) return;
  assert.deepEqual(newlines.value.edits.map((edit) => edit.text), ['\n', '\n  '], 'T078-MC05-INDENT-03 each member receives its own active-line indentation');
  indentedOpen = apply(indented, newlines.value, indentedOpen);
  assert.equal(read(indented), 'a\n\n  b\n  ', 'T078-MC05-INDENT-04 per-member indentation and changed ranges are preserved');
}

function testReplaceStacksAndFailedBackspaceIsolation(): void {
  const document = editable('abcd', 'T078-MC05-replace');
  const entered = beginVimMultiInsert(document.snapshot(), [
    { id: selectionId('T078-r-0'), cursorOffset: offset(0) },
    { id: selectionId('T078-r-1'), cursorOffset: offset(2) },
  ], 'R');
  assert.equal(entered.ok, true, 'T078-MC05-REPLACE-01 shared Replace mode enters');
  if (!entered.ok) return;
  let session = entered.value.session;
  let open = apply(document, entered.value.plan, false);
  // nvim --clean oracle (0.12.4): entering Replace and immediately pressing <BS> with
  // nothing yet typed never deletes original buffer text, even past the entry column --
  // it only repositions the cursor (see docs/evidence for T078's repro). member 0 is
  // additionally blocked outright (already at the buffer start); member 1 moves left one
  // column with no edit of its own.
  const failedAndSuccessful = planVimMultiInsertInput(document.snapshot(), session, { kind: 'key', key: '<BS>' });
  assert.equal(failedAndSuccessful.ok, true, 'T078-MC05-REPLACE-02 failed member backspace does not fail the batch');
  if (!failedAndSuccessful.ok) return;
  assert.deepEqual(failedAndSuccessful.value.edits.map(numericEdit), [], 'T078-MC05-REPLACE-03 a Replace backspace past the entry column with no frame to restore never deletes');
  assert.deepEqual(failedAndSuccessful.value.nextSession?.members.map((member) => member.session.cursorOffset as number), [0, 1], 'T078-MC05-REPLACE-03A the blocked member stays put while the other member still moves left');
  session = failedAndSuccessful.value.nextSession as VimMultiInsertSession;
  open = apply(document, failedAndSuccessful.value, open);
  assert.equal(read(document), 'abcd', 'T078-MC05-REPLACE-04 neither member altered the original buffer text');

  const typed = planVimMultiInsertInput(document.snapshot(), session, { kind: 'key', key: 'X' });
  assert.equal(typed.ok, true, 'T078-MC05-REPLACE-05 Replace accepts a Unicode-safe scalar after the isolated failure');
  if (!typed.ok) return;
  session = typed.value.nextSession as VimMultiInsertSession;
  open = apply(document, typed.value, open);
  assert.equal(read(document), 'XXcd', 'T078-MC05-REPLACE-05A each member overwrites its own (now-adjacent) column');
  const restored = planVimMultiInsertInput(document.snapshot(), session, { kind: 'key', key: '<BS>' });
  assert.equal(restored.ok, true, 'T078-MC05-REPLACE-06 each member retains its own replace stack');
  if (!restored.ok) return;
  assert.equal(restored.value.edits.length, 2, 'T078-MC05-REPLACE-07 restore emits one edit per member');
  open = apply(document, restored.value, open);
  assert.equal(read(document), 'abcd', 'T078-MC05-REPLACE-08 replace backspace restores each overwritten member independently');
  assert.equal(open, true, 'T078-MC05-REPLACE-09 all edits share one open Vim undo group');
}

function testDuplicateMergeAndExternalTransform(): void {
  const document = editable('abcd', 'T078-MC05-map');
  const entered = beginVimMultiInsert(document.snapshot(), [
    { id: selectionId('T078-m-0'), cursorOffset: offset(1) },
    { id: selectionId('T078-m-1'), cursorOffset: offset(1) },
  ], 'i');
  assert.equal(entered.ok, true, 'T078-MC05-MERGE-01 duplicate carets enter');
  if (!entered.ok) return;
  assert.equal(entered.value.plan.edits.length, 0, 'T078-MC05-MERGE-02 Insert entry itself has no text edit');
  let open = apply(document, entered.value.plan, false);
  const typed = planVimMultiInsertInput(document.snapshot(), entered.value.session, { kind: 'key', key: 'X' });
  assert.equal(typed.ok, true, 'T078-MC05-MERGE-03 duplicate carets accept one shared key');
  if (!typed.ok) return;
  assert.equal(typed.value.edits.length, 1, 'T078-MC05-MERGE-04 duplicate insertion is deduplicated atomically');
  const next = typed.value.nextSession;
  assert.ok(next, 'T078-MC05-MERGE-03 merged session retains both stable member IDs');
  if (next === null) return;
  assert.deepEqual(next.members.map((member) => member.session.cursorOffset as number), [2, 2], 'T078-MC05-MERGE-05 both members converge on the same post-insert gap');
  open = apply(document, typed.value, open);
  assert.equal(document.endUndoGroup(GROUP).ok, true, 'T078-MC05-MAP-00 close the shared group before an external edit');
  open = false;

  const beforeExternal = document.snapshot();
  const external = document.commit({
    documentId: beforeExternal.id,
    expectedVersion: beforeExternal.version,
    edits: [{ start: offset(0), end: offset(0), text: '!' }],
    origin: 'vim',
    undoGroup: identifier<UndoGroupId>('T078-external-transform'),
  });
  assert.equal(external.ok, true, 'T078-MC05-MAP-01 external edit commits through the document owner');
  if (!external.ok || external.value.kind !== 'committed') return;
  const mapped = mapVimMultiInsertSession(beforeExternal, document.snapshot(), external.value.change.changeMap, next);
  assert.equal(mapped.ok, true, 'T078-MC05-MAP-02 external position transform maps the whole shared session');
  if (!mapped.ok) return;
  assert.deepEqual(mapped.value.members.map((member) => member.session.cursorOffset as number), [3, 3], 'T078-MC05-MAP-03 both member cursors shift through the external edit');
  assert.equal(open, false, 'T078-MC05-MAP-06 external transform occurs after the shared group closes');

  const replace = editable('abcd', 'T078-MC05-replace-merge');
  const replaceEntry = beginVimMultiInsert(replace.snapshot(), [
    { id: selectionId('T078-rm-0'), cursorOffset: offset(1) },
    { id: selectionId('T078-rm-1'), cursorOffset: offset(1) },
  ], 'R');
  assert.equal(replaceEntry.ok, true, 'T078-MC05-MERGE-07 duplicate Replace carets enter');
  if (!replaceEntry.ok) return;
  let replaceOpen = apply(replace, replaceEntry.value.plan, false);
  const replaceTyped = planVimMultiInsertInput(replace.snapshot(), replaceEntry.value.session, { kind: 'key', key: 'X' });
  assert.equal(replaceTyped.ok, true, 'T078-MC05-MERGE-08 duplicate Replace carets accept one shared replacement');
  if (!replaceTyped.ok) return;
  assert.equal(replaceTyped.value.edits.length, 1, 'T078-MC05-MERGE-09 merged Replace edits remain atomic');
  replaceOpen = apply(replace, replaceTyped.value, replaceOpen);
  const replaceBackspace = planVimMultiInsertInput(replace.snapshot(), replaceTyped.value.nextSession as VimMultiInsertSession, { kind: 'key', key: '<BS>' });
  assert.equal(replaceBackspace.ok, true, 'T078-MC05-MERGE-10 merged Replace stack accepts Backspace');
  if (!replaceBackspace.ok) return;
  assert.equal(replaceBackspace.value.edits.length, 1, 'T078-MC05-MERGE-11 merged Replace Backspace is deduplicated');
  apply(replace, replaceBackspace.value, replaceOpen);
  assert.equal(read(replace), 'abcd', 'T078-MC05-MERGE-12 cursor merge inside Replace restores original text');
}

function testAtomicConflictAndCount(): void {
  const document = editable('abcd', 'T078-MC05-atomic');
  const entered = beginVimMultiInsert(document.snapshot(), [
    { id: selectionId('T078-c-0'), cursorOffset: offset(1) },
    { id: selectionId('T078-c-1'), cursorOffset: offset(3) },
  ], 'i', {}, 2);
  assert.equal(entered.ok, true, 'T078-MC01-COUNT-01 counted multi Insert enters');
  if (!entered.ok) return;
  let open = apply(document, entered.value.plan, false);
  const typed = planVimMultiInsertInput(document.snapshot(), entered.value.session, { kind: 'key', key: 'λ' });
  assert.equal(typed.ok, true, 'T078-MC01-COUNT-02 counted Unicode insertion is prepared for every member');
  if (!typed.ok) return;
  open = apply(document, typed.value, open);
  const exited = planVimMultiInsertInput(document.snapshot(), typed.value.nextSession as VimMultiInsertSession, { kind: 'key', key: '<Esc>' });
  assert.equal(exited.ok, true, 'T078-MC01-COUNT-03 counted sessions converge on Escape');
  if (!exited.ok) return;
  apply(document, exited.value, open);
  assert.equal(read(document), 'aλλbcλλd', 'T078-MC01-COUNT-04 each member applies its count independently');
}

function apply(document: TextFileDocument, plan: VimMultiInsertPlan, groupOpen: boolean): boolean {
  let open = groupOpen;
  if (plan.undoAction === 'open' && !open) {
    assert.equal(document.beginUndoGroup(GROUP, 'vim').ok, true, 'T078-COMMIT-01 shared Insert undo group opens');
    open = true;
  }
  if (plan.edits.length > 0) {
    assert.equal(open, true, 'T078-COMMIT-02 text edits require the shared undo group');
    const committed = document.commit({
      documentId: plan.documentId,
      expectedVersion: plan.expectedVersion,
      edits: plan.edits,
      origin: 'vim',
      undoGroup: GROUP,
    });
    assert.equal(committed.ok, true, 'T078-COMMIT-03 one prepared batch commits atomically');
  }
  if (plan.undoAction === 'close' && open) {
    assert.equal(document.endUndoGroup(GROUP).ok, true, 'T078-COMMIT-04 shared Insert undo group closes');
    open = false;
  }
  return open;
}

function editable(text: string, name: string): TextFileDocument {
  const id = identifier<DocumentId>(name);
  const opened = openTextDocument(id, encoder.encode(text));
  if (opened.kind !== 'editable') throw new Error(`T078-open:${opened.document.reason}`);
  return opened.document;
}

function read(document: TextFileDocument): string {
  const snapshot = document.snapshot();
  const result = snapshot.slice(offset(0), offset(snapshot.lengthUtf16 as number));
  if (!result.ok) throw new Error(`T078-read:${result.error.kind}`);
  return result.value;
}

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T078-id');
  if (!result.ok) throw new Error(`T078-id:${result.error.message}`);
  return result.value;
}

function selectionId(value: string): SelectionId { return identifier<SelectionId>(value); }
function offset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error(`T078-offset:${result.error.message}`);
  return result.value;
}
function numericEdit(edit: DocumentEdit): { readonly start: number; readonly end: number; readonly text: string } {
  return { start: edit.start as number, end: edit.end as number, text: edit.text };
}

await testSingletonOracleEquivalence();
testBroadcastUnicodeNewlineAndOpaquePaste();
testReplaceStacksAndFailedBackspaceIsolation();
testDuplicateMergeAndExternalTransform();
testAtomicConflictAndCount();
console.log('T078 passed MC01 singleton oracle equivalence and MC05 multi-cursor Insert/Replace, Unicode/newline/opaque paste, per-member replace backspace isolation, duplicate merge, counted edits, shared undo grouping and external position transforms');
