#!/usr/bin/env bun
// D6 regression in packages/vim/registers/index.ts:
//   1. Charwise/blockwise put must land the cursor on the START of the last inserted
//      code point, never in the middle of a surrogate pair.
//   2. Visual put of a linewise register over a characterwise selection must split the
//      surrounding text onto its own lines, not inline the register text into that line.
//
// Oracle (`.artifacts/oracle/nvim-linux-arm64/bin/nvim --headless --clean -u NONE`):
//   `normal jyyk0vep` on "hello world\nLINE\n" -> "\nLINE\n world\nLINE\n" (selecting
//   "hello" and pasting the linewise register "LINE\n" splits "hello world" into an
//   empty line, "LINE", and " world").
import { strict as assert } from 'node:assert';
import { openTextDocument } from '../../../packages/document/src/index';
import type { DocumentId, Utf16Offset } from '../../../packages/primitives/src/index';
import { prepareVimPut, type VimRegisterValue } from '../../../packages/vim/registers/index';

const line = (lines: readonly string[]): VimRegisterValue => ({ lines, type: 'linewise' });
const character = (lines: readonly string[]): VimRegisterValue => ({ lines, type: 'characterwise' });

// A surrogate pair ("\u{1F600}" grinning face emoji, 2 UTF-16 code units).
const EMOJI = '\u{1F600}';
assert.equal(EMOJI.length, 2, 'D6-SETUP-01 fixture emoji is a surrogate pair');

// 1a. `p` of a charwise register ending in a surrogate pair lands the cursor on its start.
{
  const opened = openTextDocument('d6-charput' as DocumentId, new TextEncoder().encode('ab'));
  assert.equal(opened.kind, 'editable');
  if (opened.kind !== 'editable') throw new Error('unreachable');
  const snapshot = opened.document.snapshot();
  const result = prepareVimPut({ snapshot, cursor: 0 as Utf16Offset, register: character([`x${EMOJI}`]), command: 'p' });
  assert.equal(result.ok, true, 'D6-01 charwise put with a surrogate pair succeeds');
  if (!result.ok) throw new Error('unreachable');
  // insertedEnd points just past the emoji; the cursor must be 2 code units back (its
  // start), not 1 (which would split the pair).
  assert.equal(result.value.cursor, (result.value.insertedEnd as number) - 2,
    'D6-02 cursor lands on the surrogate pair\'s start, not mid-pair');
}

// 1b. Blockwise put with a surrogate pair on the last inserted line.
{
  const opened = openTextDocument('d6-blockput' as DocumentId, new TextEncoder().encode('a\nb'));
  assert.equal(opened.kind, 'editable');
  if (opened.kind !== 'editable') throw new Error('unreachable');
  const snapshot = opened.document.snapshot();
  const result = prepareVimPut({ snapshot, cursor: 0 as Utf16Offset, register: { lines: ['x', EMOJI], type: 'blockwise', blockWidth: 1 }, command: 'p' });
  assert.equal(result.ok, true, 'D6-03 blockwise put with a surrogate pair succeeds');
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.value.cursor, (result.value.insertedEnd as number) - 2,
    'D6-04 blockwise put cursor lands on the surrogate pair\'s start');
}

// 2. Visual put of a linewise register over a characterwise selection splits lines.
{
  const opened = openTextDocument('d6-visualput' as DocumentId, new TextEncoder().encode('hello world'));
  assert.equal(opened.kind, 'editable');
  if (opened.kind !== 'editable') throw new Error('unreachable');
  const snapshot = opened.document.snapshot();
  const result = prepareVimPut({
    snapshot,
    cursor: 0 as Utf16Offset,
    register: line(['LINE']),
    command: 'p',
    selection: { start: 0 as Utf16Offset, end: 5 as Utf16Offset, kind: 'characterwise' },
  });
  assert.equal(result.ok, true, 'D6-05 visual put of a linewise register succeeds');
  if (!result.ok) throw new Error('unreachable');
  assert.deepEqual(result.value.edits, [{ start: 0, end: 5, text: '\nLINE\n' }],
    'D6-06 linewise register content is inserted as its own lines, not inlined');
}

console.log('d6-put-boundaries: all assertions passed');
