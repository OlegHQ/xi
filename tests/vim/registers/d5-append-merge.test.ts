#!/usr/bin/env bun
// D5 regression: uppercase-register append in packages/vim/registers/index.ts must merge
// charwise fragments onto the same logical line and promote a charwise/linewise mix to
// linewise, instead of always concatenating line arrays and downgrading to characterwise.
//
// Oracle (`.artifacts/oracle/nvim-linux-arm64/bin/nvim --headless --clean -u NONE`):
//   `"ayiw` "foo" then `"Ayiw` "baz" -> getreg('a') === 'foobaz', type 'v'.
//   `"ayiw` "foo" then `"Ayy` "baz qux\n" -> getreg('a') === "foo\nbaz qux\n", type 'V'.
//   `"ayy` "foo bar\n" then `"Ayiw` "baz" -> getreg('a') === "foo bar\nbaz\n", type 'V'.
import { strict as assert } from 'node:assert';
import { createVimRegisterBank, type VimRegisterValue } from '../../../packages/vim/registers/index';

const line = (lines: readonly string[]): VimRegisterValue => ({ lines, type: 'linewise' });
const character = (lines: readonly string[]): VimRegisterValue => ({ lines, type: 'characterwise' });

const charwiseBank = createVimRegisterBank().yank(character(['foo']), 'a');
assert.equal(charwiseBank.ok, true, 'D5-01 initial charwise yank succeeds');
if (!charwiseBank.ok) throw new Error('unreachable');
const charwiseAppended = charwiseBank.value.yank(character(['baz']), 'A');
assert.equal(charwiseAppended.ok, true, 'D5-02 uppercase charwise append succeeds');
if (!charwiseAppended.ok) throw new Error('unreachable');
assert.deepEqual(charwiseAppended.value.read('a'), { ok: true, value: character(['foobaz']) },
  'D5-03 charwise+charwise append merges onto one line ("foobaz"), not ["foo","baz"]');

const charThenLineBank = createVimRegisterBank().yank(character(['foo']), 'a');
assert.equal(charThenLineBank.ok, true);
if (!charThenLineBank.ok) throw new Error('unreachable');
const charThenLine = charThenLineBank.value.yank(line(['baz qux']), 'A');
assert.equal(charThenLine.ok, true, 'D5-04 uppercase charwise->linewise append succeeds');
if (!charThenLine.ok) throw new Error('unreachable');
assert.deepEqual(charThenLine.value.read('a'), { ok: true, value: line(['foo', 'baz qux']) },
  'D5-05 charwise+linewise append promotes to linewise, keeping the charwise text as its own line');

const lineThenCharBank = createVimRegisterBank().yank(line(['foo bar']), 'a');
assert.equal(lineThenCharBank.ok, true);
if (!lineThenCharBank.ok) throw new Error('unreachable');
const lineThenChar = lineThenCharBank.value.yank(character(['baz']), 'A');
assert.equal(lineThenChar.ok, true, 'D5-06 uppercase linewise->charwise append succeeds');
if (!lineThenChar.ok) throw new Error('unreachable');
assert.deepEqual(lineThenChar.value.read('a'), { ok: true, value: line(['foo bar', 'baz']) },
  'D5-07 linewise+charwise append promotes to linewise, appending the charwise text as its own line');

console.log('d5-append-merge: all assertions passed');
