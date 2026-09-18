#!/usr/bin/env bun
// C3/C9 regression tests (packages/vim/multi/index.ts). Neovim oracle:
// .artifacts/oracle/nvim-linux-arm64/bin/nvim --headless --clean -u NONE
import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentSnapshot } from '../../../packages/document/src/index';
import { createSelectionSet, type SelectionMemberInput, type SelectionSetSnapshot } from '../../../packages/selections/src/index';
import { prepareVimMultiOperator, resolveVimMultiMotion } from '../../../packages/vim/src/index';
import { asIdentifier, type DocumentId, type SelectionId, type Utf16Offset } from '../../../packages/primitives/src/index';

// --- C3: operatorMotionInclusive must be an allow-list, not a deny-list. ---
// nvim: :call setline(1,['abcdef']) | normal! 03ld0 -> 'ef' ('0' is exclusive; 'def' removed)
{
  const doc = open('abcdef', 'C3-zero-exclusive');
  const selections = makeSelections(doc, [3]);
  const operator = prepareVimMultiOperator({
    snapshot: doc,
    selections,
    operator: 'delete',
    motion: { key: '0' },
    failurePolicy: 'reject-command',
  });
  assert.equal(operator.ok, true, 'C3-01 d0 prepares');
  if (operator.ok) {
    assert.deepEqual(operator.value.transaction?.edits, [{ start: 0, end: 3, text: '' }], 'C3-02 0 is exclusive: only "abc" removed, not "abcd"');
    assert.equal(apply(doc, operator.value.transaction?.edits ?? []), 'def', 'C3-03 d0 on "abcdef" col3 leaves "def"');
  }
}

// e/E/ge/gE/$/g_ stay inclusive (regression guard for the allow-list rewrite).
// nvim: :call setline(1,['foo bar']) | normal! de -> ' bar'
{
  const doc = open('foo bar', 'C3-e-inclusive');
  const selections = makeSelections(doc, [0]);
  const operator = prepareVimMultiOperator({
    snapshot: doc,
    selections,
    operator: 'delete',
    motion: { key: 'e' },
    failurePolicy: 'reject-command',
  });
  assert.equal(operator.ok, true, 'C3-04 de prepares');
  if (operator.ok) assert.equal(apply(doc, operator.value.transaction?.edits ?? []), ' bar', 'C3-05 de on "foo bar" removes the whole word "foo"');
}

// --- C9: motion previews are opt-in (default off), not built on every key. ---
{
  const doc = open('one two', 'C9-preview-default-off');
  const selections = makeSelections(doc, [0, 4]);
  const motion = resolveVimMultiMotion({ snapshot: doc, selections, invocation: { key: 'l', count: 1 } });
  assert.equal(motion.ok, true, 'C9-01 motion resolves');
  if (motion.ok) assert.equal(motion.value.preview, null, 'C9-02 preview is null by default (no previewEnabled: true)');
}
{
  const doc = open('one two', 'C9-preview-explicit-opt-in');
  const selections = makeSelections(doc, [0, 4]);
  const motion = resolveVimMultiMotion({ snapshot: doc, selections, invocation: { key: 'l', count: 1 }, previewEnabled: true });
  assert.equal(motion.ok, true, 'C9-03 motion resolves with explicit opt-in');
  if (motion.ok) assert.equal(motion.value.preview?.members.length, 2, 'C9-04 preview is still available on explicit opt-in');
}

console.log('C3/C9 multi tests passed');

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
