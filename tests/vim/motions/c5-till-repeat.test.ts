#!/usr/bin/env bun
// C5 regression test (packages/vim/motions/find.ts): `;`/`,` repeating a `t`/`T`
// always searches past the immediate next occurrence of the target (Vim's
// "cap" behavior), independent of any stale prior-match offset.
// nvim: :call setline(1,['azbzcz']) | normal! tzll; -> col('.')==5 (0-idx 4)
// nvim: :call setline(1,['azbzczdzez']) | normal! tzll; -> col('.')==5 (0-idx 4)
// nvim: :call setline(1,['azbzczdzez']) | normal! tzll2; -> col('.')==5 (0-idx 4)
// nvim: :call setline(1,['azbzczdzez']) | normal! tzll3; -> col('.')==7 (0-idx 6)
import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentSnapshot } from '../../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type Utf16Offset } from '../../../packages/primitives/src/index';
import { createVimMotionCursor, resolveVimFind, type VimLastFind } from '../../../packages/vim/src/index';

function open(source: string, id: string): DocumentSnapshot {
  const documentId = asIdentifier<DocumentId>(id, 'documentId');
  assert.equal(documentId.ok, true);
  if (!documentId.ok) throw new Error('invalid document id');
  const result = openTextDocument(documentId.value, new TextEncoder().encode(source));
  assert.equal(result.kind, 'editable');
  if (result.kind !== 'editable') throw new Error('document is not editable');
  return result.document.snapshot();
}
function offset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('invalid offset');
  return result.value;
}

// "azbzcz": tz from col0 -> col0 (stops before the first 'z'); moved to col2
// manually ("ll"); `;` must land at col4 (before the *second* remaining 'z'),
// not col2 (a no-op) and not the immediately-adjacent match at col3.
{
  const doc = open('azbzcz', 'C5-basic-repeat');
  const cursor0 = createVimMotionCursor(doc, offset(0));
  assert.equal(cursor0.ok, true);
  if (!cursor0.ok) throw new Error('cursor');
  const tz = resolveVimFind(doc, cursor0.value, { key: 't', target: 'z' }, null);
  assert.equal(tz.ok, true, 'C5-01 tz resolves');
  if (!tz.ok) throw new Error('tz failed');
  assert.equal(tz.value.kind, 'found', 'C5-02 tz finds a match');
  const lastFind: VimLastFind | null = tz.value.kind === 'found' ? tz.value.lastFind : null;
  const cursor2 = createVimMotionCursor(doc, offset(2));
  assert.equal(cursor2.ok, true);
  if (!cursor2.ok) throw new Error('cursor2');
  const repeat = resolveVimFind(doc, cursor2.value, { key: ';' }, lastFind);
  assert.equal(repeat.ok, true, 'C5-03 ; resolves');
  if (repeat.ok && repeat.value.kind === 'found') {
    assert.equal(repeat.value.cursor.offset as number, 4, 'C5-04 ; from col2 lands at col4, skipping the immediately-adjacent match');
  } else {
    assert.fail('C5-05 ; must find a match');
  }
}

// "azbzczdzez": count semantics on the repeat -- count 1 and count 2 land on
// the same match (both drop the first candidate); count 3 advances one more.
{
  const doc = open('azbzczdzez', 'C5-count-semantics');
  const cursor0 = createVimMotionCursor(doc, offset(0));
  assert.equal(cursor0.ok, true);
  if (!cursor0.ok) throw new Error('cursor');
  const tz = resolveVimFind(doc, cursor0.value, { key: 't', target: 'z' }, null);
  assert.equal(tz.ok, true);
  if (!tz.ok) throw new Error('tz failed');
  const lastFind: VimLastFind | null = tz.value.kind === 'found' ? tz.value.lastFind : null;
  // matches the oracle's "tzll{count};" sequence: tz stops at col0, ll moves to col2.
  const cursor2 = createVimMotionCursor(doc, offset(2));
  assert.equal(cursor2.ok, true);
  if (!cursor2.ok) throw new Error('cursor2');
  for (const [count, expected] of [[1, 4], [2, 4], [3, 6]] as const) {
    const repeat = resolveVimFind(doc, cursor2.value, { key: ';', count }, lastFind);
    assert.equal(repeat.ok, true, `C5-06 ${count}; resolves`);
    if (repeat.ok && repeat.value.kind === 'found') {
      assert.equal(repeat.value.cursor.offset as number, expected, `C5-07 ${count}; from col2 lands at offset${expected}`);
    } else {
      assert.fail(`C5-08 ${count}; must find a match`);
    }
  }
}

console.log('C5 till-repeat tests passed');
