#!/usr/bin/env bun
// C7 regression tests (packages/vim/motions/structural.ts): `]]`/`[[`/`[]`/`][`
// were reported unconditionally linewise (they are exclusive charwise, only
// promoted to linewise by the exclusive-linewise rule); `{count}%` was
// reported charwise (it is unconditionally linewise); `%`'s hardcoded column
// 0 killed the sticky column for j/k; sentence motions did not skip closing
// `)]"'` after `.`/`!`/`?`.
// nvim: :call setline(1,['.SH one','body','','.SH two']) | normal! llly]] -> getregtype('"')=='v'
// nvim: :call setline(1,['one','two','three','four','five']) | normal! d50% -> deletes lines 1-3 linewise
// nvim: :call setline(1,['a (bbbb) c','xxxxxxxxxxxxxxxxxxxx']) | normal! 0f(%j -> col('.')==8
// nvim: :call setline(1,['He said "Hi." She left.']) | normal! ) -> col('.')==15
import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentSnapshot } from '../../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type Utf16Offset } from '../../../packages/primitives/src/index';
import { normalizeVimOperatorRange, resolveVimMotion, resolveVimStructuralMotion, type VimOperatorRangeInput, type VimStructuralMotionCursor } from '../../../packages/vim/src/index';

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

// `]]` from mid-line (not at first non-blank) must resolve charwise, not linewise.
{
  const doc = open('.SH one\nbody\n\n.SH two', 'C7-section-charwise');
  const cursor: VimStructuralMotionCursor = { documentVersion: doc.version, offset: offset(3), desiredDisplayCellColumn: null };
  const result = resolveVimStructuralMotion(doc, cursor, { key: ']]' });
  assert.equal(result.ok, true, 'C7-01 ]] resolves');
  if (result.ok) assert.equal(result.value.kind, 'characterwise', 'C7-02 ]] from mid-line is exclusive charwise, not unconditionally linewise');
}

// `]]` from col0 at the first non-blank still ends up linewise after the
// generic exclusive-linewise range promotion (ranges/normalize.ts, C4).
{
  const doc = open('.SH one\nbody\n\n.SH two', 'C7-section-linewise-via-normalize');
  const cursor: VimStructuralMotionCursor = { documentVersion: doc.version, offset: offset(0), desiredDisplayCellColumn: null };
  const result = resolveVimStructuralMotion(doc, cursor, { key: ']]' });
  assert.equal(result.ok, true, 'C7-03 ]] resolves');
  if (result.ok) {
    const input: VimOperatorRangeInput = {
      origin: { documentVersion: doc.version, offset: offset(0) },
      target: { documentVersion: doc.version, offset: result.value.cursor.offset },
      direction: 'forward',
      motionKind: result.value.kind,
      inclusive: false,
      motionKey: ']]',
      operator: 'delete',
    };
    const range = normalizeVimOperatorRange(doc, input);
    assert.equal(range.ok, true, 'C7-04 the range normalizes');
    if (range.ok) assert.equal(range.value.kind, 'linewise', 'C7-05 starting at the first non-blank still yields a linewise range end-to-end');
  }
}

// `{count}%` is unconditionally linewise.
{
  const doc = open('one\ntwo\nthree\nfour\nfive', 'C7-percent-linewise');
  const cursor: VimStructuralMotionCursor = { documentVersion: doc.version, offset: offset(0), desiredDisplayCellColumn: null };
  const result = resolveVimStructuralMotion(doc, cursor, { key: '%', count: 50 });
  assert.equal(result.ok, true, 'C7-06 50% resolves');
  if (result.ok) assert.equal(result.value.kind, 'linewise', 'C7-07 {count}% is declared linewise');
}

// `%` (bracket match) must not reset the sticky column to 0.
{
  const doc = open('a (bbbb) c\nxxxxxxxxxxxxxxxxxxxx', 'C7-percent-sticky-column');
  const cursor: VimStructuralMotionCursor = { documentVersion: doc.version, offset: offset(2), desiredDisplayCellColumn: null };
  const result = resolveVimStructuralMotion(doc, cursor, { key: '%' });
  assert.equal(result.ok, true, 'C7-08 % resolves');
  if (result.ok) {
    assert.equal(result.value.cursor.offset as number, 7, 'C7-09 % lands on the matching ")" at offset 7');
    const down = resolveVimMotion(doc, { documentVersion: doc.version, offset: result.value.cursor.offset, desiredDisplayCellColumn: result.value.cursor.desiredDisplayCellColumn }, { key: 'j' });
    assert.equal(down.ok, true, 'C7-10 j resolves');
    if (down.ok) assert.equal(down.value.cursor.offset as number, 11 + 7, 'C7-11 j preserves the % landing column (7), not column 0');
  }
}

// Sentence motion `)` must skip closing `)]"'` after the terminator.
{
  const doc = open('He said "Hi." She left.', 'C7-sentence-closer');
  const cursor: VimStructuralMotionCursor = { documentVersion: doc.version, offset: offset(0), desiredDisplayCellColumn: null };
  const result = resolveVimStructuralMotion(doc, cursor, { key: ')' });
  assert.equal(result.ok, true, 'C7-12 ) resolves');
  if (result.ok) assert.equal(result.value.cursor.offset as number, 14, 'C7-13 ) lands on "She" (offset 14), skipping the closing quote after "."');
}

console.log('C7 structural tests passed');
