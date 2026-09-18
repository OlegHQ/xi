#!/usr/bin/env bun
// P2 linewise search-operator range regression test
// (packages/vim/multi/index.ts consumes searchVimOperator's `linewise`).
// nvim: .artifacts/oracle/nvim-linux-arm64/bin/nvim --headless --clean -u NONE -i NONE
//   -c 'call setline(1,["one","two","three"])' -c 'normal! d/two/+1' -> ['']
//   -c 'call setline(1,["abc def"])' -c 'normal! d/def<CR>' -> ['def']
import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentSnapshot } from '../../../packages/document/src/index';
import { createSelectionSet, type SelectionMemberInput, type SelectionSetSnapshot } from '../../../packages/selections/src/index';
import { prepareVimMultiOperator } from '../../../packages/vim/src/index';
import { searchVimOperator, EMPTY_VIM_SEARCH_STATE, type VimSearchView } from '../../../packages/vim/search/index';
import { asIdentifier, type DocumentId, type SelectionId, type Utf16Offset } from '../../../packages/primitives/src/index';

// d/two/+1<CR> on "one\ntwo\nthree": a numeric line search-offset makes the
// motion linewise, deleting all three lines (not just up to the match).
{
  const doc = open('one\ntwo\nthree', 'search-linewise');
  const view: VimSearchView = { cursor: 0 as Utf16Offset, desiredDisplayColumn: 0, scrollTop: 0, scrollLeft: 0 };
  const search = searchVimOperator(doc, view, EMPTY_VIM_SEARCH_STATE, { command: 'search', pattern: 'two', direction: 'forward', offset: { kind: 'line', amount: 1 } });
  assert.equal(search.ok, true, 'search resolves');
  if (!search.ok) throw new Error('search failed');
  assert.equal(search.value.range.linewise, true, 'line search-offset is linewise');
  const selections = makeSelections(doc, [0]);
  const operator = prepareVimMultiOperator({ snapshot: doc, selections, operator: 'delete', searchRange: search.value.range, failurePolicy: 'reject-command' });
  assert.equal(operator.ok, true, 'd/two/+1<CR> prepares');
  if (operator.ok) assert.equal(apply(doc, operator.value.transaction?.edits ?? []), '', 'd/two/+1<CR> deletes all three lines linewise');
}

// A plain d/def<CR> (no offset) stays exclusive characterwise: "def" survives.
{
  const doc = open('abc def', 'search-exclusive');
  const view: VimSearchView = { cursor: 0 as Utf16Offset, desiredDisplayColumn: 0, scrollTop: 0, scrollLeft: 0 };
  const search = searchVimOperator(doc, view, EMPTY_VIM_SEARCH_STATE, { command: 'search', pattern: 'def', direction: 'forward' });
  assert.equal(search.ok, true, 'search resolves');
  if (!search.ok) throw new Error('search failed');
  assert.equal(search.value.range.linewise, false, 'plain search-offset is not linewise');
  const selections = makeSelections(doc, [0]);
  const operator = prepareVimMultiOperator({ snapshot: doc, selections, operator: 'delete', searchRange: search.value.range, failurePolicy: 'reject-command' });
  assert.equal(operator.ok, true, 'd/def<CR> prepares');
  if (operator.ok) assert.equal(apply(doc, operator.value.transaction?.edits ?? []), 'def', 'd/def<CR> is exclusive: only "abc " removed');
}

console.log('P2 search-linewise tests passed');

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
