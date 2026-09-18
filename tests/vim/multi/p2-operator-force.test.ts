#!/usr/bin/env bun
// P2 operator-force regression tests (packages/vim/multi/index.ts,
// packages/vim/ranges/normalize.ts). o_v/o_V/o_CTRL-V: force key right after
// the operator overrides the motion's wise-ness (:help o_v).
// Neovim oracle: .artifacts/oracle/nvim-linux-arm64/bin/nvim --headless --clean -u NONE -i NONE
//   -c 'call setline(1,["abc","def","ghi"])' -c 'call cursor(1,2)'
//   -c 'execute "normal! dvj"'    -> ['aef','ghi']
//   -c 'execute "normal! dVl"'    -> ['def','ghi']
//   -c 'execute "normal! dv$"'    -> ['ac','def','ghi']
//   -c 'execute "normal! dve"'    -> ['ac','def','ghi']
//   -c "execute \"normal! d\\<C-v>j\""  -> ['ac','df','ghi']
import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentSnapshot } from '../../../packages/document/src/index';
import { createSelectionSet, type SelectionMemberInput, type SelectionSetSnapshot } from '../../../packages/selections/src/index';
import { prepareVimMultiOperator } from '../../../packages/vim/src/index';
import { asIdentifier, type DocumentId, type SelectionId, type Utf16Offset } from '../../../packages/primitives/src/index';

// dvj: j is linewise; forced characterwise -> exclusive from cursor to the
// same-column offset on the next line.
{
  const doc = open('abc\ndef\nghi', 'force-dvj');
  const selections = makeSelections(doc, [1]);
  const operator = prepareVimMultiOperator({
    snapshot: doc, selections, operator: 'delete', motion: { key: 'j' }, force: 'v', failurePolicy: 'reject-command',
  });
  assert.equal(operator.ok, true, 'dvj prepares');
  if (operator.ok) assert.equal(apply(doc, operator.value.transaction?.edits ?? []), 'aef\nghi', 'dvj forces linewise j to exclusive characterwise');
}

// dVl: l is characterwise; forced linewise -> whole origin/target line span.
{
  const doc = open('abc\ndef\nghi', 'force-dVl');
  const selections = makeSelections(doc, [1]);
  const operator = prepareVimMultiOperator({
    snapshot: doc, selections, operator: 'delete', motion: { key: 'l' }, force: 'V', failurePolicy: 'reject-command',
  });
  assert.equal(operator.ok, true, 'dVl prepares');
  if (operator.ok) assert.equal(apply(doc, operator.value.transaction?.edits ?? []), 'def\nghi', 'dVl forces l to linewise');
}

// dv$: $ is inclusive characterwise; forced 'v' on an already-characterwise
// motion toggles inclusive/exclusive.
{
  const doc = open('abc\ndef\nghi', 'force-dv-dollar');
  const selections = makeSelections(doc, [1]);
  const operator = prepareVimMultiOperator({
    snapshot: doc, selections, operator: 'delete', motion: { key: '$' }, force: 'v', failurePolicy: 'reject-command',
  });
  assert.equal(operator.ok, true, 'dv$ prepares');
  if (operator.ok) assert.equal(apply(doc, operator.value.transaction?.edits ?? []), 'ac\ndef\nghi', 'dv$ toggles $ to exclusive');
}

// dve: e is inclusive characterwise; toggled to exclusive.
{
  const doc = open('abc\ndef\nghi', 'force-dve');
  const selections = makeSelections(doc, [1]);
  const operator = prepareVimMultiOperator({
    snapshot: doc, selections, operator: 'delete', motion: { key: 'e' }, force: 'v', failurePolicy: 'reject-command',
  });
  assert.equal(operator.ok, true, 'dve prepares');
  if (operator.ok) assert.equal(apply(doc, operator.value.transaction?.edits ?? []), 'ac\ndef\nghi', 'dve toggles e to exclusive');
}

// d<C-v>j: forces a single-column block spanning the origin and target lines.
{
  const doc = open('abc\ndef\nghi', 'force-block');
  const selections = makeSelections(doc, [1]);
  const operator = prepareVimMultiOperator({
    snapshot: doc, selections, operator: 'delete', motion: { key: 'j' }, force: '<C-v>', failurePolicy: 'reject-command',
  });
  assert.equal(operator.ok, true, 'd<C-v>j prepares');
  if (operator.ok) assert.equal(apply(doc, operator.value.transaction?.edits ?? []), 'ac\ndf\nghi', 'd<C-v>j forces a single-column block delete');
}

console.log('P2 operator-force tests passed');

function open(source: string, id: string): DocumentSnapshot {
  const documentId = asIdentifier<DocumentId>(id, 'documentId');
  assert.equal(documentId.ok, true);
  if (!documentId.ok) throw new Error('invalid document id');
  const result = openTextDocument(documentId.value, new TextEncoder().encode(source));
  assert.equal(result.kind, 'editable');
  if (result.kind !== 'editable') throw new Error('document is not editable');
  return result.document.snapshot();
}

function makeSelections(document: DocumentSnapshot, positions: readonly number[]): SelectionSetSnapshot {
  const members = positions.map((position, index): SelectionMemberInput => ({
    id: selectionId(`m${index + 1}`), kind: 'normal-cursor', direction: 'forward',
    anchor: { kind: 'character', offset: position as Utf16Offset, after: position + 1 as Utf16Offset },
    head: { kind: 'character', offset: position as Utf16Offset, after: position + 1 as Utf16Offset },
  }));
  const created = createSelectionSet(document, { primaryId: selectionId('m1'), members });
  assert.equal(created.ok, true, 'selection set validates');
  if (!created.ok) throw new Error('selection setup failed');
  return created.value.selectionSet;
}

function selectionId(value: string): SelectionId {
  const result = asIdentifier<SelectionId>(value, 'selectionId');
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('invalid selection id');
  return result.value;
}

function apply(document: DocumentSnapshot, edits: readonly { readonly start: Utf16Offset; readonly end: Utf16Offset; readonly text: string }[]): string {
  const text = document.slice(0 as Utf16Offset, document.lengthUtf16 as Utf16Offset);
  assert.equal(text.ok, true);
  if (!text.ok) throw new Error('source unavailable');
  return [...edits].sort((left, right) => (right.start as number) - (left.start as number))
    .reduce((value, edit) => value.slice(0, edit.start as number) + edit.text + value.slice(edit.end as number), text.value);
}
