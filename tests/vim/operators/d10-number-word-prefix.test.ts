#!/usr/bin/env bun
// D10 regression: <C-a>/<C-x> in packages/vim/operators/advanced.ts must increment a
// number run even when it's directly preceded by a word character; it must not skip it.
//
// Oracle (`.artifacts/oracle/nvim-linux-arm64/bin/nvim --headless --clean -u NONE -c
// 'exe "normal \<C-a>"'`): "abc123" -> "abc124"; "item2list3" -> "item3list3" (increments
// the first number run, "2", even though it's glued to the preceding word chars).
import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentSnapshot } from '../../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId } from '../../../packages/primitives/src/index';
import { prepareVimNumericOperator } from '../../../packages/vim/src/index';

function offset(value: number) {
  const result = asUtf16Offset(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('invalid offset');
  return result.value;
}
function open(text: string, id: string): DocumentSnapshot {
  const documentId = asIdentifier<DocumentId>(id, 'documentId');
  assert.equal(documentId.ok, true);
  if (!documentId.ok) throw new Error('invalid id');
  const result = openTextDocument(documentId.value, new TextEncoder().encode(text));
  assert.equal(result.kind, 'editable');
  if (result.kind !== 'editable') throw new Error('read-only fixture');
  return result.document.snapshot();
}

const source = open('abc123', 'D10-abc123');
const result = prepareVimNumericOperator({ snapshot: source, operator: '<C-A>', cursorOffset: offset(0), options: { nrformats: 'bin,hex' } });
assert.equal(result.ok, true, `D10-01 <C-a> prepares on "abc123": ${JSON.stringify(!result.ok && result.error)}`);
if (!result.ok) throw new Error('unreachable');
assert.equal(result.value.transaction?.edits[0]?.text, '124', 'D10-02 <C-a> increments "123" even though it is preceded by "abc"');

const glued = open('item2list3', 'D10-glued');
const gluedResult = prepareVimNumericOperator({ snapshot: glued, operator: '<C-A>', cursorOffset: offset(0), options: { nrformats: 'bin,hex' } });
assert.equal(gluedResult.ok, true, `D10-03 <C-a> prepares on "item2list3": ${JSON.stringify(!gluedResult.ok && gluedResult.error)}`);
if (!gluedResult.ok) throw new Error('unreachable');
assert.equal(gluedResult.value.transaction?.edits[0]?.text, '3', 'D10-04 <C-a> increments the first digit run "2" -> "3"');

console.log('d10-number-word-prefix: all assertions passed');
