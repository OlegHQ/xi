import { strict as assert } from 'node:assert';
import { openTextDocument } from '../../../packages/document/src/index';
import { applyVimSelectionCommand } from '../../../packages/vim/src/index';
import { createSelectionSet, type SelectionMemberInput } from '../../../packages/selections/src/index';
import { asIdentifier, type DocumentId, type SelectionId } from '../../../packages/primitives/src/index';

const snapshot = open('one two one\nthree', 'T081');
const initial = makeNormal(snapshot, 0);
const first = applyVimSelectionCommand({ snapshot, selections: initial, command: 'selection.add-next-match', pattern: 'one' });
assert.equal(first.ok, true, 'T081-MC09-01 first next-match materializes the primary as Visual');
if (!first.ok) throw new Error('first selection failed');
assert.equal(first.value.selection.members[0]?.kind, 'visual-character', 'T081-MC09-02 first next-match enters character Visual');
const next = applyVimSelectionCommand({ snapshot, selections: first.value.selection, command: 'selection.add-next-match' });
assert.equal(next.ok, true, 'T081-MC09-03 next-match adds a later occurrence');
if (!next.ok) throw new Error('next selection failed');
assert.equal(next.value.selection.members.length, 2, 'T081-MC09-04 next-match keeps both occurrences');

const all = applyVimSelectionCommand({ snapshot, selections: initial, command: 'selection.select-all-matches', pattern: 'one' });
assert.equal(all.ok, true, 'T081-MC09-05 select-all finds all literal occurrences');
if (all.ok) assert.equal(all.value.selection.members.length, 2, 'T081-MC09-06 select-all creates two members');
const limited = applyVimSelectionCommand({ snapshot, selections: all.ok ? all.value.selection : initial, command: 'selection.select-regex', pattern: '.', regex: true, limit: 1 });
assert.equal(limited.ok, false, 'T081-MC09-07 select-regex limit rejects before truncation');
if (!limited.ok) assert.equal(limited.error.kind, 'selection-limit', 'T081-MC09-08 limit failure is explicit');
const zeroDocument = open('ab', 'T081-zero');
const zero = applyVimSelectionCommand({ snapshot: zeroDocument, selections: makeNormal(zeroDocument, 0), command: 'selection.select-regex', pattern: '(?=a)', regex: true });
assert.equal(zero.ok, true, 'T081-MC09-09 zero-width regex advances at a valid boundary');
const eofDocument = open('ab', 'T081-eof');
const eof = applyVimSelectionCommand({ snapshot: eofDocument, selections: makeVisual(eofDocument, 0, 2), command: 'selection.select-regex', pattern: '(?=$)', regex: true });
assert.equal(eof.ok, true, 'T081-MC09-09A EOF zero-width regex creates an explicit EOF selection');
if (eof.ok) assert.equal(eof.value.selection.members[0]?.head.kind, 'eof', 'T081-MC09-09B EOF match retains the EOF endpoint');

const kept = applyVimSelectionCommand({ snapshot, selections: all.ok ? all.value.selection : initial, command: 'selection.keep-matching', pattern: 'one' });
assert.equal(kept.ok, true, 'T081-MC09-10 keep-matching retains matching members');
const empty = applyVimSelectionCommand({ snapshot, selections: all.ok ? all.value.selection : initial, command: 'selection.keep-matching', pattern: 'missing' });
assert.equal(empty.ok, false, 'T081-MC09-11 empty filtering is rejected without truncation');
if (!empty.ok) assert.equal(empty.error.kind, 'empty-filter-result', 'T081-MC09-12 empty filter reports prior-set preservation');

const removed = applyVimSelectionCommand({ snapshot, selections: all.ok ? all.value.selection : initial, command: 'selection.remove-primary' });
assert.equal(removed.ok, true, 'T081-MC09-13 remove-primary succeeds');
if (removed.ok) assert.equal(removed.value.selection.members.length, 1, 'T081-MC09-14 remove-primary keeps one member');
const rotated = applyVimSelectionCommand({ snapshot, selections: all.ok ? all.value.selection : initial, command: 'selection.rotate-primary-next' });
assert.equal(rotated.ok, true, 'T081-MC09-15 primary rotation succeeds');
if (rotated.ok) assert.notEqual(rotated.value.selection.primaryId, (all.ok ? all.value.selection.primaryId : initial.primaryId), 'T081-MC09-16 primary identity rotates');

const above = applyVimSelectionCommand({ snapshot, selections: initial, command: 'selection.add-below' });
assert.equal(above.ok, true, 'T081-MC09-17 keyboard add-below works without terminal modifiers');
if (above.ok) {
  assert.equal(above.value.selection.members.length, 2, 'T081-MC09-18 add-below creates a second caret');
  assert.equal(above.value.selection.primaryId, above.value.selection.members[1]?.id, 'T081-MC09-18A newly added caret becomes primary');
}
const aboveLine = applyVimSelectionCommand({ snapshot, selections: initial, command: 'selection.add-above' });
assert.equal(aboveLine.ok, true, 'T081-MC09-18B keyboard add-above keeps the source when the frontier is bounded');
if (aboveLine.ok) assert.equal(aboveLine.value.selection.members.length, 1, 'T081-MC09-18C add-above at the first line is a no-op');
const frontierDocument = open('a\nb\nc', 'T081-frontier');
const frontierInitial = makeNormal(frontierDocument, 0);
const frontierOnce = applyVimSelectionCommand({ snapshot: frontierDocument, selections: frontierInitial, command: 'selection.add-below' });
const nextFrontier = frontierOnce.ok ? applyVimSelectionCommand({ snapshot: frontierDocument, selections: frontierOnce.value.selection, command: 'selection.add-below' }) : frontierOnce;
assert.equal(nextFrontier.ok, true, 'T081-MC09-18D repeated add-below advances the outer frontier');
if (nextFrontier.ok) assert.equal(nextFrontier.value.selection.members.length, 3, 'T081-MC09-18E repeated add-below adds only the next line');
const collapse = applyVimSelectionCommand({ snapshot, selections: all.ok ? all.value.selection : initial, command: 'selection.collapse' });
assert.equal(collapse.ok, true, 'T081-MC09-19 collapse returns to Normal cursors');
if (collapse.ok) assert.equal(collapse.value.selection.members[0]?.kind, 'normal-cursor', 'T081-MC09-20 collapse retains heads');
const undone = collapse.ok
  ? applyVimSelectionCommand({ snapshot, selections: collapse.value.selection, command: 'selection.undo', history: [all.ok ? all.value.selection : initial] })
  : { ok: false as const, error: { kind: 'selection-history-empty' as const } };
assert.equal(undone.ok, true, 'T081-MC09-21 selection undo restores the prior set without editing text');
if (undone.ok) assert.equal(undone.value.selection.members.length, 2, 'T081-MC09-22 selection undo restores both members');

const splitDocument = open('one\ntwo\n\nthree', 'T081-split');
const splitSelection = makeVisual(splitDocument, 1, 6);
const split = applyVimSelectionCommand({ snapshot: splitDocument, selections: splitSelection, command: 'selection.split-lines' });
assert.equal(split.ok, true, 'T081-MC09-23 split-lines creates one selection for each selected line intersection');
if (split.ok) {
  assert.deepEqual(split.value.selection.members.map((member) => [member.anchor.at.offset, member.head.at.offset]), [[1, 2], [4, 5]], 'T081-MC09-24 split-lines preserves exact nonempty intersections');
}
const regionalRegex = applyVimSelectionCommand({ snapshot: splitDocument, selections: splitSelection, command: 'selection.select-regex', pattern: '.', regex: true });
assert.equal(regionalRegex.ok, true, 'T081-MC09-25 regex selection scans selected regions');
if (regionalRegex.ok) assert.equal(regionalRegex.value.selection.members.length, 4, 'T081-MC09-26 regex selection does not scan outside selected regions');

const scaledDocument = open(`${'x '.repeat(10_001)}`, 'T081-scale');
const scaled = applyVimSelectionCommand({ snapshot: scaledDocument, selections: makeNormal(scaledDocument, 0), command: 'selection.select-all-matches', pattern: 'x', limit: 10_000 });
assert.equal(scaled.ok, false, 'T081-MC12-01 the 10000-member ceiling rejects the 10001st match');
if (!scaled.ok) assert.equal(scaled.error.kind, 'selection-limit', 'T081-MC12-02 scale overflow has an explicit limit failure');
const cancelled = applyVimSelectionCommand({ snapshot: scaledDocument, selections: makeNormal(scaledDocument, 0), command: 'selection.select-all-matches', pattern: 'x', cancellation: { isCancelled: true } });
assert.equal(cancelled.ok, false, 'T081-MC12-03 cancellation publishes no partial selection set');
if (!cancelled.ok) assert.equal(cancelled.error.kind, 'cancelled', 'T081-MC12-04 cancellation has a typed failure');

console.log('T081 selection commands passed occurrence, regex, limit, filter, primary and keyboard creation policies');

function open(source: string, id: string) {
  const checked = asIdentifier<DocumentId>(id, 'documentId'); assert.equal(checked.ok, true, 'T081-OWNER-01 id validates');
  if (!checked.ok) throw new Error('bad id');
  const result = openTextDocument(checked.value, new TextEncoder().encode(source)); assert.equal(result.kind, 'editable', 'T081-OWNER-02 document opens');
  if (result.kind !== 'editable') throw new Error('read-only'); return result.document.snapshot();
}
function makeNormal(document: ReturnType<typeof open>, position: number) {
  const id = asIdentifier<SelectionId>('primary', 'selectionId'); assert.equal(id.ok, true, 'T081-SET-01 id validates');
  if (!id.ok) throw new Error('bad selection id');
  const member: SelectionMemberInput = { id: id.value, kind: 'normal-cursor', direction: 'forward', anchor: { kind: 'character', offset: position as never, after: (position + 1) as never }, head: { kind: 'character', offset: position as never, after: (position + 1) as never } };
  const result = createSelectionSet(document, { primaryId: id.value, members: [member] }); assert.equal(result.ok, true, 'T081-SET-02 selection creates');
  if (!result.ok) throw new Error('selection failed'); return result.value.selectionSet;
}

function makeVisual(document: ReturnType<typeof open>, start: number, end: number) {
  const primary = asIdentifier<SelectionId>('visual-primary', 'selectionId'); assert.equal(primary.ok, true, 'T081-VISUAL-01 id validates');
  if (!primary.ok) throw new Error('bad visual id');
  const member: SelectionMemberInput = {
    id: primary.value,
    kind: 'visual-character',
    direction: 'forward',
    inclusive: true,
    anchor: { kind: 'character', offset: start as never, after: (start + 1) as never },
    head: { kind: 'character', offset: (end - 1) as never, after: end as never },
  };
  const result = createSelectionSet(document, { primaryId: primary.value, members: [member] }); assert.equal(result.ok, true, 'T081-VISUAL-02 selection creates');
  if (!result.ok) throw new Error('visual selection failed'); return result.value.selectionSet;
}
