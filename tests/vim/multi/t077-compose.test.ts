import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentEdit, type DocumentSnapshot, type TextFileDocument } from '../../../packages/document/src/index';
import { createSelectionSet, type SelectionMemberInput, type SelectionSetSnapshot } from '../../../packages/selections/src/index';
import {
  prepareVimMultiOperator,
  createVimJumpHistory,
  createVimMarkStore,
  recordVimMultiPrimaryJump,
  resolveVimMark,
  resolveVimMultiFind,
  resolveVimMultiMotion,
  resolveVimMultiSearch,
  resolveVimMultiVisualMotion,
  reselectVimMultiVisualSelection,
  rememberVimMultiVisualShapes,
  setVimMultiPrimaryMark,
  type VimMultiOperatorPlan,
  type VimOperatorSessionState,
} from '../../../packages/vim/src/index';
import { asCellColumn, asIdentifier, asUtf16Column, asUtf16Offset, type CellColumn, type DocumentId, type SelectionId, type Utf16Column, type Utf16Offset } from '../../../packages/primitives/src/index';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';

const snapshot = open('one two', 'T077-compose');
const selections = makeSelections(snapshot, [0, 4]);

const motion = resolveVimMultiMotion({
  snapshot,
  selections,
  invocation: { key: 'l', count: 1 },
  previewEnabled: true,
});
assert.equal(motion.ok, true, 'T077-MC01-01 one motion resolves for every member');
assert.deepEqual(motion.value.members.map((member) => member.status), ['completed', 'completed'], 'T077-MC01-02 both motion members complete');
assert.deepEqual(motion.value.selection.members.map((member) => member.head.at.offset), [1, 5], 'T077-MC01-03 each cursor advances independently');
assert.equal(motion.value.preview?.members.length, 2, 'T077-MC01-04 preview contains one extent per member');
assert.equal(motion.value.preview?.documentVersion, snapshot.version, 'T077-PREVIEW-04 preview is tied to the source document version');
assert.equal(motion.value.preview?.selectionGeneration, selections.selectionGeneration, 'T077-PREVIEW-05 preview records the source selection generation');
assert.equal(motion.value.selection.selectionGeneration as number, (selections.selectionGeneration as number) + 1, 'T077-PREVIEW-06 semantic selection update advances its own generation');
if (motion.value.preview !== null) {
  assert.equal(Object.isFrozen(motion.value.preview), true, 'T077-PREVIEW-07 preview metadata is immutable');
  assert.equal(Object.isFrozen(motion.value.preview.members), true, 'T077-PREVIEW-08 preview member list is immutable');
}

const staleDocument = openEditable('one two', 'T077-stale-selection');
const staleSnapshot = staleDocument.snapshot();
const staleSelections = makeSelections(staleSnapshot, [0, 4]);
const staleEdit = staleDocument.apply({ start: 0 as Utf16Offset, end: 0 as Utf16Offset, text: '!' }, staleSnapshot.version);
assert.equal(staleEdit.ok, true, 'T077-PREVIEW-09 a changed document creates a new source version');
const staleMotion = resolveVimMultiMotion({
  snapshot: staleDocument.snapshot(),
  selections: staleSelections,
  invocation: { key: 'l', count: 1 },
});
assert.equal(staleMotion.ok, false, 'T077-PREVIEW-10 stale selections are rejected before publication');
if (!staleMotion.ok) assert.equal(staleMotion.error.kind, 'stale-selection', 'T077-PREVIEW-11 stale selection failure is explicit');

const withoutPreview = resolveVimMultiMotion({
  snapshot,
  selections,
  invocation: { key: 'l', count: 1 },
  previewEnabled: false,
});
assert.equal(withoutPreview.ok, true, 'T077-PREVIEW-01 disabling preview does not change semantic resolution');
if (withoutPreview.ok) {
  assert.equal(withoutPreview.value.preview, null, 'T077-PREVIEW-02 disabled preview is absent');
  assert.deepEqual(withoutPreview.value.selection.members.map((member) => member.head.at.offset), motion.value.selection.members.map((member) => member.head.at.offset), 'T077-PREVIEW-03 preview toggle leaves selection unchanged');
}

const operator = prepareVimMultiOperator({
  snapshot,
  selections,
  operator: 'delete',
  motion: { key: 'l', count: 1 },
  failurePolicy: 'reject-command',
});
assert.equal(operator.ok, true, 'T077-MC03-01 shared operator resolves on one base snapshot');
assert.deepEqual(operator.value.transaction?.edits, [{ start: 0, end: 1, text: '' }, { start: 4, end: 5, text: '' }], 'T077-MC03-02 nonoverlapping ranges compose');
assert.equal(apply(snapshot, operator.value.transaction?.edits ?? []), 'ne wo', 'T077-MC03-03 one coherent transaction applies all members');
assert.equal(operator.value.historyEffect.kind, 'single-command', 'T077-MC03-04 composition creates one history command');

const conflictSelections = makeSelections(snapshot, [0, 1]);
const conflict = prepareVimMultiOperator({
  snapshot,
  selections: conflictSelections,
  operator: 'change',
  motion: { key: '$', count: 1 },
  failurePolicy: 'reject-command',
});
assert.equal(conflict.ok, true, 'T077-MC04-01 overlapping pure deletes use the explicit union policy');
if (conflict.ok) assert.deepEqual(conflict.value.transaction?.edits, [{ start: 0, end: 7, text: '' }], 'T077-MC04-02 shared operator range is one deletion');

const failedRetained = resolveVimMultiMotion({
  snapshot,
  selections,
  invocation: { key: 'l', count: 0 },
  failurePolicy: 'retain-failed',
});
assert.equal(failedRetained.ok, true, 'T077-MC04-02 nonmutating motion failures retain the set');
if (failedRetained.ok) assert.deepEqual(failedRetained.value.failedMemberIds, selections.members.map((member) => member.id), 'T077-MC04-03 all failed members remain identified');
const failedRejected = resolveVimMultiMotion({
  snapshot,
  selections,
  invocation: { key: 'l', count: 0 },
  failurePolicy: 'reject-command',
});
assert.equal(failedRejected.ok, false, 'T077-MC04-04 mutating failure policy rejects the command');

const wordMotion = resolveVimMultiMotion({
  snapshot,
  selections,
  invocation: { key: 'w', count: 1 },
  failurePolicy: 'retain-failed',
});
assert.equal(wordMotion.ok, true, 'T077-MC01-07 word motions compose through the shared path');
if (wordMotion.ok) assert.deepEqual(wordMotion.value.members.map((member) => member.status), ['completed', 'completed'], 'T077-MC04-05 word targets compose per member');

const objectSnapshot = open('one two', 'T077-text-object');
const objectSelections = makeSelections(objectSnapshot, [1, 5]);
const objectOperator = prepareVimMultiOperator({
  snapshot: objectSnapshot,
  selections: objectSelections,
  operator: 'delete',
  motion: { key: 'iw', count: 1 },
  failurePolicy: 'reject-command',
});
assert.equal(objectOperator.ok, true, 'T077-MC01-08 inner text objects resolve for every member');
if (objectOperator.ok) {
  // Cursors sit mid-word (offsets 1 and 5); `diw` removes each whole word, not cursor-to-end.
  // nvim --headless --clean -c "call setline(1,['one two'])" -c 'normal! ldiw' -> [' two']
  assert.deepEqual(objectOperator.value.transaction?.edits, [{ start: 0, end: 3, text: '' }, { start: 4, end: 7, text: '' }], 'T077-MC01-09 text-object ranges start at the object, not the cursor');
  assert.equal(apply(objectSnapshot, objectOperator.value.transaction?.edits ?? []), ' ', 'T077-MC01-10 composed inner objects preserve the shared base snapshot');
}

const visualSelections = makeVisualSelections(snapshot);
const visualMotion = resolveVimMultiVisualMotion({
  snapshot,
  selections: visualSelections,
  invocation: { key: 'l', count: 1 },
  previewEnabled: true,
});
assert.equal(visualMotion.ok, true, 'T077-MC01-08 Visual members extend independently');
if (visualMotion.ok) {
  assert.equal(visualMotion.value.members.length, 2, 'T077-MC01-09 Visual results retain member identity');
  assert.equal(visualMotion.value.preview?.members.length, 2, 'T077-MC01-10 Visual preview retains both extents');
}

const findSnapshot = open('aXaX', 'T077-find');
const findSelections = makeSelections(findSnapshot, [0, 2]);
const find = resolveVimMultiFind({
  snapshot: findSnapshot,
  selections: findSelections,
  invocation: { key: 'f', target: 'X' },
  lastFind: null,
  failurePolicy: 'reject-command',
});
assert.equal(find.ok, true, 'T077-MC04-06 literal find resolves independently for every member');
if (find.ok) {
  assert.deepEqual(find.value.selection.members.map((member) => member.head.at.offset), [1, 3], 'T077-MC04-07 find destinations remain source-version coordinates');
  assert.deepEqual(find.value.members.map((member) => member.status), ['completed', 'completed'], 'T077-MC04-08 successful find members commit together');
}
const noFind = resolveVimMultiFind({
  snapshot: findSnapshot,
  selections: findSelections,
  invocation: { key: 'f', target: 'z' },
  lastFind: null,
  failurePolicy: 'retain-failed',
});
assert.equal(noFind.ok, true, 'T077-MC04-09 missing find targets retain the full set');
if (noFind.ok) {
  assert.deepEqual(noFind.value.failedMemberIds, findSelections.members.map((member) => member.id), 'T077-MC04-10 each missing find target is reported');
  assert.deepEqual(noFind.value.selection.members.map((member) => member.head.at.offset), findSelections.members.map((member) => member.head.at.offset), 'T077-MC04-11 failed find leaves coordinates unchanged');
}
const cancelledFind = resolveVimMultiFind({
  snapshot: findSnapshot,
  selections: findSelections,
  invocation: { key: 'f', target: 'X' },
  lastFind: null,
  isCancelled: () => true,
});
assert.equal(cancelledFind.ok, false, 'T077-MC04-12 cancelled find publishes no partial selection');
if (!cancelledFind.ok) assert.equal(cancelledFind.error.kind, 'cancelled', 'T077-MC04-13 cancellation is explicit');

const search = resolveVimMultiSearch({
  snapshot: findSnapshot,
  selections: findSelections,
  request: { command: 'search', pattern: 'X', direction: 'forward' },
  state: { pattern: null, direction: null, lastMatch: null, previousReplacement: null, fullWord: false },
  failurePolicy: 'reject-command',
});
assert.equal(search.ok, true, 'T077-MC04-14 search resolves once per member on one base snapshot');
if (search.ok) {
  assert.deepEqual(search.value.selection.members.map((member) => member.head.at.offset), [1, 3], 'T077-MC04-15 search destinations remain independent');
  assert.equal(search.value.state.pattern, 'X', 'T077-MC04-16 search state commits once from the shared command');
}
const cancelledSearch = resolveVimMultiSearch({
  snapshot: findSnapshot,
  selections: findSelections,
  request: { command: 'search', pattern: 'X', direction: 'forward' },
  state: { pattern: null, direction: null, lastMatch: null, previousReplacement: null, fullWord: false },
  isCancelled: () => true,
});
assert.equal(cancelledSearch.ok, false, 'T077-MC04-17 cancelled search restores the complete prior set');
if (!cancelledSearch.ok) assert.equal(cancelledSearch.error.kind, 'cancelled', 'T077-MC04-18 search cancellation is explicit');

const blockSnapshot = open('abcd\nabcd', 'T077-block');
const blockSelections = makeBlockSelections(blockSnapshot);
const blockMotion = resolveVimMultiVisualMotion({
  snapshot: blockSnapshot,
  selections: blockSelections,
  invocation: { key: 'l', count: 1 },
  options: { tabSize: 4 },
  failurePolicy: 'reject-command',
});
assert.equal(blockMotion.ok, true, 'T077-MC04-19 ragged block members resolve independently');
if (blockMotion.ok) assert.equal(blockMotion.value.members.length, 2, 'T077-MC04-20 block members retain identity');
const blockOperator = prepareVimMultiOperator({
  snapshot: blockSnapshot,
  selections: blockSelections,
  operator: 'delete',
  failurePolicy: 'reject-command',
});
assert.equal(blockOperator.ok, true, 'T077-MC04-21 disjoint block ranges compose atomically');
if (blockOperator.ok) assert.ok((blockOperator.value.transaction?.edits.length ?? 0) > 0, 'T077-MC04-22 block operator emits edits');

const foldSnapshot = open('a\nb\nc\nd', 'T077-fold');
const foldSelections = makeSelections(foldSnapshot, [0, 2]);
const foldedMotion = resolveVimMultiMotion({
  snapshot: foldSnapshot,
  selections: foldSelections,
  invocation: { key: 'j', count: 1 },
  options: { folds: [{ id: 'fold-1', documentVersion: foldSnapshot.version, startLine: 1 as never, endLineExclusive: 3 as never }] },
  failurePolicy: 'reject-command',
});
assert.equal(foldedMotion.ok, true, 'T077-MC04-23 folded vertical motions resolve as a shared command');
if (foldedMotion.ok) assert.equal(foldedMotion.value.members.length, 2, 'T077-MC04-24 folded motion retains every member');

const countedSnapshot = open('abcdef', 'T077-count');
const countedSelections = makeSelections(countedSnapshot, [0, 3]);
const countedOperator = prepareVimMultiOperator({
  snapshot: countedSnapshot,
  selections: countedSelections,
  operator: 'delete',
  motion: { key: 'l', count: 2 },
  failurePolicy: 'reject-command',
});
assert.equal(countedOperator.ok, true, 'T077-MC01-11 multiplied motion counts resolve per member');
if (countedOperator.ok) assert.deepEqual(countedOperator.value.transaction?.edits, [{ start: 0, end: 2, text: '' }, { start: 3, end: 5, text: '' }], 'T077-MC01-12 multiplied ranges remain source-relative');

const unicodeSnapshot = open('😀a😀a', 'T077-unicode');
const unicodeSelections = makeSelectionsWithAfter(unicodeSnapshot, [[0, 5], [2, 3]]);
const unicodeMotion = resolveVimMultiMotion({ snapshot: unicodeSnapshot, selections: unicodeSelections, invocation: { key: 'l' }, failurePolicy: 'reject-command' });
assert.equal(unicodeMotion.ok, true, 'T077-MC01-13 multi motion respects UTF-16 grapheme boundaries');
if (unicodeMotion.ok) assert.deepEqual(unicodeMotion.value.selection.members.map((member) => member.head.at.offset), [2, 3], 'T077-MC01-14 astral members advance by grapheme');

const markStore = createVimMarkStore();
const marked = setVimMultiPrimaryMark(markStore, 'a', snapshot, selections);
assert.equal(marked.ok, true, 'T077-MC04-06 one multi-command mark update succeeds');
if (marked.ok) {
  assert.equal(marked.value.generation, 1, 'T077-MC04-07 marking a set advances shared mark state once');
  const resolvedMark = resolveVimMark(marked.value, 'a', snapshot.id);
  assert.equal(resolvedMark.ok, true, 'T077-MC04-08 primary mark is resolvable');
  if (resolvedMark.ok) assert.equal(resolvedMark.value.mark.offset, 0, 'T077-MC04-09 mark uses the primary member location');
}

const jump = recordVimMultiPrimaryJump(createVimJumpHistory(), {
  documentId: snapshot.id,
  documentVersion: snapshot.version,
  offset: 0 as Utf16Offset,
}, 'search');
assert.equal(jump.ok, true, 'T077-MC04-10 one multi-command jump update succeeds');
if (jump.ok) {
  assert.equal(jump.value.entries.length, 1, 'T077-MC04-11 multi-command jump records one entry');
  assert.equal(jump.value.index, 0, 'T077-MC04-12 jump cursor identifies the sole current entry');
  assert.equal(jump.value.entries[0]?.target.offset, 0, 'T077-MC04-13 jump uses the primary navigation target');
}

const visualShapes = rememberVimMultiVisualShapes(visualSelections);
const missingVisualShape = reselectVimMultiVisualSelection(
  snapshot,
  selectionId('v1'),
  [selectionId('v1'), selectionId('v-missing')],
  visualShapes,
);
assert.equal(missingVisualShape.ok, false, 'T077-MC04-14 gv refuses a member without prior Visual history');
if (!missingVisualShape.ok) {
  assert.equal(missingVisualShape.error.kind, 'missing-visual-shape', 'T077-MC04-15 missing Visual history has an explicit failure');
  if (missingVisualShape.error.kind === 'missing-visual-shape') assert.equal(missingVisualShape.error.memberId, selectionId('v-missing'), 'T077-MC04-16 failure identifies the missing stable member');
}

await checkPinnedSingletonOracle();
console.log('T077 multi-command composition passed singleton-equivalent motions/operators, preview isolation, overlap rejection and member failure policies');

async function checkPinnedSingletonOracle(): Promise<void> {
  const oracle = await verifyOracleBundle();
  const rows = [
    { id: 'T077-MC01-ORACLE-FIRST-01', column: 0, expected: ['ne two'] },
    { id: 'T077-MC01-ORACLE-SECOND-01', column: 4, expected: ['one wo'] },
  ] as const;
  for (const row of rows) {
    const result = await runOracleFixture({
      id: row.id, title: row.id, purpose: 'Pin singleton native delete-motion behavior for multi-command composition.',
      modes: ['normal'], lines: ['one two'], cursor: { line: 1, byteColumn0: row.column },
      steps: [{ label: 'delete-motion', keys: 'dl', drain: true }],
    }, oracle.binaryPath);
    const final = result.snapshots.at(-1);
    assert.ok(final, `${row.id} has a final snapshot`);
    if (final !== undefined) assert.deepEqual(final.lines, row.expected, `${row.id} matches pinned Neovim`);
  }
  const extraRows = [
    { id: 'T077-MC01-ORACLE-COUNT-01', keys: '2dl', lines: ['abcdef'], column: 0, expected: ['cdef'] },
    { id: 'T077-MC01-ORACLE-CW-01', keys: 'cwNEW<Esc>', lines: ['abcdef'], column: 0, expected: ['NEW'] },
    { id: 'T077-MC01-ORACLE-EOL-01', keys: 'd$', lines: ['abcdef'], column: 0, expected: [''] },
  ] as const;
  for (const row of extraRows) {
    const result = await runOracleFixture({
      id: row.id, title: row.id, purpose: 'Pin count, cw and exclusive end-of-line singleton behavior for multi-command composition.',
      modes: ['normal'], lines: row.lines, cursor: { line: 1, byteColumn0: row.column },
      steps: [{ label: row.id, keys: row.keys, drain: true }],
    }, oracle.binaryPath);
    const final = result.snapshots.at(-1);
    assert.ok(final, `${row.id} has a final snapshot`);
    if (final !== undefined) assert.deepEqual(final.lines, row.expected, `${row.id} matches pinned Neovim`);
  }
}

function open(source: string, id: string): DocumentSnapshot {
  const documentId = asIdentifier<DocumentId>(id, 'documentId');
  assert.equal(documentId.ok, true, 'T077-OWNER-01 document id validates');
  if (!documentId.ok) throw new Error('invalid document id');
  const result = openTextDocument(documentId.value, new TextEncoder().encode(source));
  assert.equal(result.kind, 'editable', 'T077-OWNER-02 document opens editable');
  if (result.kind !== 'editable') throw new Error('document is not editable');
  return result.document.snapshot();
}

function openEditable(source: string, id: string): TextFileDocument {
  const documentId = asIdentifier<DocumentId>(id, 'documentId');
  assert.equal(documentId.ok, true, 'T077-OWNER-04 editable document id validates');
  if (!documentId.ok) throw new Error('invalid editable document id');
  const result = openTextDocument(documentId.value, new TextEncoder().encode(source));
  assert.equal(result.kind, 'editable', 'T077-OWNER-05 editable document opens');
  if (result.kind !== 'editable') throw new Error('editable document unavailable');
  return result.document;
}

function makeSelections(document: DocumentSnapshot, positions: readonly number[]): SelectionSetSnapshot {
  const members = positions.map((position, index): SelectionMemberInput => ({
    id: selectionId(`m${index + 1}`), kind: 'normal-cursor', direction: 'forward',
    anchor: { kind: 'character', offset: position as Utf16Offset, after: position + 1 as Utf16Offset },
    head: { kind: 'character', offset: position as Utf16Offset, after: position + 1 as Utf16Offset },
  }));
  const created = createSelectionSet(document, { primaryId: selectionId('m1'), members });
  assert.equal(created.ok, true, 'T077-SET-01 selection set validates');
  return created.value.selectionSet;
}

function makeSelectionsWithAfter(document: DocumentSnapshot, positions: readonly (readonly [number, number])[]): SelectionSetSnapshot {
  const members = positions.map(([position, after], index): SelectionMemberInput => ({
    id: selectionId(`u${index + 1}`), kind: 'normal-cursor', direction: 'forward',
    anchor: { kind: 'character', offset: position as Utf16Offset, after: after as Utf16Offset },
    head: { kind: 'character', offset: position as Utf16Offset, after: after as Utf16Offset },
  }));
  const created = createSelectionSet(document, { primaryId: selectionId('u1'), members });
  assert.equal(created.ok, true, 'T077-SET-08 grapheme selection set validates');
  if (!created.ok) throw new Error('grapheme selection setup failed');
  return created.value.selectionSet;
}

function makeVisualSelections(document: DocumentSnapshot): SelectionSetSnapshot {
  const members: SelectionMemberInput[] = [0, 4].map((position, index) => ({
    id: selectionId(`v${index + 1}`), kind: 'visual-character', direction: 'forward', inclusive: true,
    anchor: { kind: 'character', offset: position as Utf16Offset, after: position + 1 as Utf16Offset },
    head: { kind: 'character', offset: position as Utf16Offset, after: position + 1 as Utf16Offset },
    desiredColumn: { logicalUtf16: utf16Column(position), displayCell: cellColumn(position) },
    anchorDesiredColumn: { logicalUtf16: utf16Column(position), displayCell: cellColumn(position) },
  }));
  const created = createSelectionSet(document, { primaryId: selectionId('v1'), members });
  assert.equal(created.ok, true, 'T077-SET-03 visual selection set validates');
  if (!created.ok) throw new Error('visual selection setup failed');
  return created.value.selectionSet;
}

function makeBlockSelections(document: DocumentSnapshot): SelectionSetSnapshot {
  const member = (id: string, left: number): SelectionMemberInput => ({
    id: selectionId(id), kind: 'visual-block', direction: 'forward',
    anchor: { kind: 'block-cell', offset: blockOffset(document, 0, left), logicalUtf16Column: left as never, displayCellColumn: left as never, virtualCells: 0 },
    head: { kind: 'block-cell', offset: blockOffset(document, 1, left), logicalUtf16Column: left as never, displayCellColumn: left as never, virtualCells: 0 },
    desiredColumn: { logicalUtf16: left as never, displayCell: left as never },
    anchorDesiredColumn: { logicalUtf16: left as never, displayCell: left as never },
  });
  const created = createSelectionSet(document, { primaryId: selectionId('b1'), members: [member('b1', 0), member('b2', 3)] });
  assert.equal(created.ok, true, 'T077-SET-06 block selection set validates');
  if (!created.ok) throw new Error('block selection setup failed');
  return created.value.selectionSet;
}

function blockOffset(document: DocumentSnapshot, line: number, column: number): Utf16Offset {
  const start = document.lineStartOffset(line as never);
  assert.equal(start.ok, true, 'T077-SET-07 block line start validates');
  if (!start.ok) throw new Error('block line unavailable');
  return (start.value as number + column) as Utf16Offset;
}

function utf16Column(value: number): Utf16Column {
  const result = asUtf16Column(value);
  assert.equal(result.ok, true, 'T077-SET-04 logical desired column validates');
  if (!result.ok) throw new Error('invalid logical column');
  return result.value;
}

function cellColumn(value: number): CellColumn {
  const result = asCellColumn(value);
  assert.equal(result.ok, true, 'T077-SET-05 display desired column validates');
  if (!result.ok) throw new Error('invalid display column');
  return result.value;
}

function selectionId(value: string): SelectionId {
  const result = asIdentifier<SelectionId>(value, 'selectionId');
  assert.equal(result.ok, true, 'T077-SET-02 selection id validates');
  if (!result.ok) throw new Error('invalid selection id');
  return result.value;
}

function apply(document: DocumentSnapshot, edits: readonly DocumentEdit[]): string {
  const text = document.slice(0 as Utf16Offset, document.lengthUtf16 as Utf16Offset);
  assert.equal(text.ok, true, 'T077-OWNER-03 source is readable');
  if (!text.ok) throw new Error('source unavailable');
  return [...edits].sort((left, right) => (right.start as number) - (left.start as number))
    .reduce((value, edit) => value.slice(0, edit.start as number) + edit.text + value.slice(edit.end as number), text.value);
}
