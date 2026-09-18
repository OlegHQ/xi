#!/usr/bin/env bun
// Oracle-verified parity fixes (nvim --headless --clean 0.12.4). Each block
// cites the nvim command sequence used to derive the expected result.
import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentSnapshot } from '../../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId } from '../../../packages/primitives/src/index';
import {
  createVimRegisterBank,
  normalizeVimOperatorRange,
  prepareVimDirectChange,
  prepareVimPut,
  type VimNormalizedOperatorRange,
  type VimOperatorRangeInput,
} from '../../../packages/vim/src/index';

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
function range(snapshot: DocumentSnapshot, input: Omit<VimOperatorRangeInput, 'origin' | 'target'> & { origin: number; target: number }): VimNormalizedOperatorRange {
  const result = normalizeVimOperatorRange(snapshot, {
    ...input,
    origin: { documentVersion: snapshot.version, offset: offset(input.origin) },
    target: { documentVersion: snapshot.version, offset: offset(input.target) },
  });
  assert.equal(result.ok, true, `range failed: ${JSON.stringify(!result.ok && result.error)}`);
  if (!result.ok) throw new Error('range failed');
  return result.value;
}

// --- 4: e/E/ge/gE are inclusive ('foo bar' de -> ' bar') ---
// nvim: :call setline(1,['foo bar']) | normal! de -> ' bar'
{
  const doc = open('foo bar', 'inclusive-e');
  const result = range(doc, { origin: 0, target: 2, direction: 'forward', motionKind: 'characterwise', inclusive: true, motionKey: 'e', operator: 'delete' });
  assert.equal(result.ranges[0]?.text, 'foo', 'PARITY-04 de on "foo bar" removes the whole word "foo"');
}

// --- 5: dl at end of line still deletes the last character ---
// nvim: :call setline(1,['abc']) | normal! $dl -> 'ab'
{
  const doc = open('abc', 'dl-eol');
  const result = range(doc, { origin: 2, target: 2, direction: 'forward', motionKind: 'characterwise', inclusive: false, motionKey: 'l', operator: 'delete' });
  assert.equal(result.ranges[0]?.text, 'c', 'PARITY-05 dl at EOL deletes the last character instead of no-op');
}

// --- 6: register rotation and yank cursor placement ---
{
  const bank = createVimRegisterBank();
  // nvim: named non-small delete still rotates "1 ("add also sets register 1).
  const deleted = bank.delete({ lines: ['one', 'two'], type: 'linewise' }, { destination: 'a' });
  assert.equal(deleted.ok, true);
  if (deleted.ok) {
    assert.deepEqual(deleted.value.read('1'), { ok: true, value: { lines: ['one', 'two'], type: 'linewise' } }, 'PARITY-06a "add also rotates into "1');
    assert.deepEqual(deleted.value.read('a'), { ok: true, value: { lines: ['one', 'two'], type: 'linewise' } }, 'PARITY-06a "add writes the named register too');
  }
  // nvim: small delete into a named register never touches "- or "1..9.
  const smallDeleted = bank.delete({ lines: ['x'], type: 'characterwise' }, { destination: 'b', small: true });
  assert.equal(smallDeleted.ok, true);
  if (smallDeleted.ok) {
    assert.deepEqual(smallDeleted.value.read('-'), { ok: true, value: { lines: [], type: 'characterwise' } }, 'PARITY-06b small named delete leaves "- untouched');
  }
}
{
  // nvim: 'foo bar baz' $ yb rX -> 'foo bar Xaz' (cursor lands at range start on a backward yank)
  const doc = open('foo bar baz', 'yank-cursor');
  const plan = normalizeVimOperatorRange(doc, {
    origin: { documentVersion: doc.version, offset: offset(10) },
    target: { documentVersion: doc.version, offset: offset(8) },
    direction: 'backward', motionKind: 'characterwise', inclusive: false, motionKey: 'b', operator: 'yank',
  });
  assert.equal(plan.ok, true);
  if (plan.ok) assert.equal(plan.value.start, 8, 'PARITY-06c backward yank range starts at the motion target');
}

// --- 7: ~ with count advances past the last toggled char; {count}r fails outright ---
{
  // nvim: 'abcd' 3~ rZ -> 'ABCZ' (cursor lands on 'd')
  const doc = open('abcd', 'tilde-count');
  const prepared = prepareVimDirectChange({ snapshot: doc, key: '~', cursorOffset: offset(0), count: 3, state: { mode: 'normal', repeatTarget: null } });
  assert.equal(prepared.ok, true);
  if (prepared.ok && prepared.value.kind === 'prepared') {
    assert.equal(prepared.value.cursorOffset, 3, 'PARITY-07a 3~ advances the cursor past the last toggled character');
  }
  // nvim: 'abc' 5rx is a no-op (count exceeds remaining characters)
  const doc2 = open('abc', 'replace-count-overflow');
  const replaced = prepareVimDirectChange({ snapshot: doc2, key: 'r', cursorOffset: offset(0), count: 5, replacement: 'x', state: { mode: 'normal', repeatTarget: null } });
  assert.equal(replaced.ok, false, 'PARITY-07b 5rx on "abc" fails outright');
}
{
  // nvim: ['abcdef','ghijkl','mnopqr'] ll 2D -> 'ab' joined with 'mnopqr'
  const doc = open('abcdef\nghijkl\nmnopqr\n', 'D-count');
  const prepared = prepareVimDirectChange({ snapshot: doc, key: 'D', cursorOffset: offset(2), count: 2, state: { mode: 'normal', repeatTarget: null } });
  assert.equal(prepared.ok, true);
  if (prepared.ok && prepared.value.kind === 'prepared' && prepared.value.transaction !== null) {
    const edit = prepared.value.transaction.edits[0];
    assert.equal(edit?.text, '', 'PARITY-07c 2D deletes rather than inserts');
    assert.equal((edit?.end as unknown as number) - (edit?.start as unknown as number), 'cdef\nghijkl\n'.length, 'PARITY-07c 2D removes the rest of the line plus the next full line');
  }
}

// --- 8: put cursor/behavior ---
{
  // nvim: ['  hello','world'] yyp rZ -> first non-blank of the pasted line
  const doc = open('  hello\nworld\n', 'put-first-nonblank');
  const plan = prepareVimPut({ snapshot: doc, cursor: offset(0), command: 'p', register: { lines: ['  hello'], type: 'linewise' } });
  assert.equal(plan.ok, true);
  if (plan.ok) {
    const expected = 8 /* start of pasted line */ + 2 /* leading spaces */;
    assert.equal(plan.value.cursor, expected, 'PARITY-08a linewise p lands on the first non-blank of the pasted line');
  }
  // nvim: {count}p repeats the register content
  const doc2 = open('abc', 'put-count');
  const plan2 = prepareVimPut({ snapshot: doc2, cursor: offset(0), command: 'p', register: { lines: ['a'], type: 'characterwise' }, count: 3 });
  assert.equal(plan2.ok, true);
  if (plan2.ok) {
    const edit = plan2.value.edits[0];
    assert.equal(edit?.text, 'aaa', 'PARITY-08b {count}p repeats the register text');
  }
  // charwise p on an empty mid-document line inserts on that line, not the next
  const doc3 = open('ab\n\ncd\n', 'put-empty-line');
  const plan3 = prepareVimPut({ snapshot: doc3, cursor: offset(3), command: 'p', register: { lines: ['a'], type: 'characterwise' } });
  assert.equal(plan3.ok, true);
  if (plan3.ok) {
    assert.equal(plan3.value.insertedStart, 3, 'PARITY-08c charwise p on an empty line inserts at that line, not the next');
  }
}

console.log('PASS operators/parity-fixes: e/E inclusive, dl@EOL, register rotation, yank cursor, ~/r/D counts, put cursor');
