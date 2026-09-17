#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { openTextDocument } from '../../../packages/document/src/index';
import type { DocumentId, Utf16Offset } from '../../../packages/primitives/src/index';
import {
  createVimRegisterBank,
  exportVimRegisterToClipboard,
  importVimRegisterFromClipboard,
  prepareVimPut,
  REGISTER_RETENTION_POLICY,
  type VimRegisterValue,
} from '../../../packages/vim/registers/index';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture, OracleSnapshot } from '../../oracle/types';

const line = (lines: readonly string[]): VimRegisterValue => ({ lines, type: 'linewise' });
const character = (lines: readonly string[]): VimRegisterValue => ({ lines, type: 'characterwise' });
const block = (lines: readonly string[], blockWidth: number): VimRegisterValue => ({ lines, type: 'blockwise', blockWidth });

const bank = createVimRegisterBank();
const yanked = bank.yank(line(['one']), 'a');
assert.equal(yanked.ok, true, 'T023-REGISTER-YANK-01 writes a named register');
if (!yanked.ok) throw new Error('T023-REGISTER-YANK-01');
assert.deepEqual(yanked.value.read('a'), { ok: true, value: line(['one']) });
assert.deepEqual(yanked.value.read('0'), { ok: true, value: { lines: [], type: 'characterwise' } }, 'explicit named yank leaves register 0 unchanged');
assert.deepEqual(yanked.value.read('"'), { ok: true, value: line(['one']) }, 'unnamed register follows the yank');
const defaultYank = bank.yank(line(['default']));
assert.equal(defaultYank.ok, true);
if (!defaultYank.ok) throw new Error('T023-REGISTER-DEFAULT-YANK');
assert.deepEqual(defaultYank.value.read('0'), { ok: true, value: line(['default']) }, 'unnamed yank updates register 0');
const explicitNamedFromSeed = createVimRegisterBank({ '0': character(['prior']) }).yank(character(['named']), 'b');
assert.equal(explicitNamedFromSeed.ok, true);
if (!explicitNamedFromSeed.ok) throw new Error('T023-REGISTER-EXPLICIT-NAMED');
assert.deepEqual(explicitNamedFromSeed.value.read('0'), { ok: true, value: character(['prior']) }, 'explicit named yank leaves register 0 unchanged');

const appended = yanked.value.yank(line(['two']), 'A');
assert.equal(appended.ok, true, 'T023-REGISTER-APPEND-01 uppercase named yank appends');
if (!appended.ok) throw new Error('T023-REGISTER-APPEND-01');
assert.deepEqual(appended.value.read('a'), { ok: true, value: line(['one', 'two']) });
assert.deepEqual(appended.value.read('0'), { ok: true, value: { lines: [], type: 'characterwise' } }, 'explicit uppercase named yank leaves register 0 unchanged');

let rotated = createVimRegisterBank();
for (let index = 1; index <= 3; index += 1) {
  const result = rotated.delete(character([`d${index}`]));
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('T023-REGISTER-ROTATE');
  rotated = result.value;
}
assert.deepEqual(rotated.read('1'), { ok: true, value: character(['d3']) });
assert.deepEqual(rotated.read('2'), { ok: true, value: character(['d2']) });
assert.deepEqual(rotated.read('3'), { ok: true, value: character(['d1']) });
const small = rotated.delete(character(['small']), { small: true });
assert.equal(small.ok, true);
if (!small.ok) throw new Error('T023-REGISTER-SMALL-DELETE');
assert.deepEqual(small.value.read('-'), { ok: true, value: character(['small']) });
assert.deepEqual(small.value.read('1'), { ok: true, value: character(['d3']) }, 'small delete does not rotate numbered registers');
const namedDelete = small.value.delete(character(['named-delete']), { destination: 'b' });
assert.equal(namedDelete.ok, true);
if (!namedDelete.ok) throw new Error('T023-REGISTER-NAMED-DELETE');
assert.deepEqual(namedDelete.value.read('1'), { ok: true, value: character(['d3']) }, 'explicit named delete does not rotate numbered registers');
const blackHoleDelete = small.value.delete(character(['discard']), { destination: '_' });
assert.equal(blackHoleDelete.ok, true);
if (!blackHoleDelete.ok) throw new Error('T023-REGISTER-BLACK-HOLE');
assert.equal(blackHoleDelete.value.generation, small.value.generation, 'black-hole delete does not mutate the bank');

// Nine 10 MiB deletes rotate through every numbered register (1..9); without a retention
// budget that retains 90 MiB forever. REGISTER_RETENTION_POLICY.maxRetainedUtf16 must keep
// the bank's total well under that, while never dropping the most recent numbered register.
const BIG_CHUNK = 'x'.repeat(10 * 1024 * 1024);
let big = createVimRegisterBank();
for (let index = 1; index <= 9; index += 1) {
  const result = big.delete(character([BIG_CHUNK]));
  assert.equal(result.ok, true, `T023-REGISTER-BUDGET-DELETE-${index}`);
  if (!result.ok) throw new Error(`T023-REGISTER-BUDGET-DELETE-${index}`);
  big = result.value;
}
assert.equal(big.truncated, true, 'T023-REGISTER-BUDGET-01 the bank reports truncation once the budget is exceeded');
assert.deepEqual(big.read('1'), { ok: true, value: character([BIG_CHUNK]) },
  'T023-REGISTER-BUDGET-02 the most recent numbered register is always fully retained');
let bigRetained = 0;
for (const name of ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const) {
  const value = big.read(name);
  assert.equal(value.ok, true, `T023-REGISTER-BUDGET-READ-${name}`);
  if (value.ok) bigRetained += value.value.lines.reduce((sum, line) => sum + line.length, 0);
}
assert.ok(bigRetained < 9 * BIG_CHUNK.length,
  `T023-REGISTER-BUDGET-03 numbered registers retain less than all nine 10 MiB deletes (retained ${bigRetained})`);
assert.ok(bigRetained <= REGISTER_RETENTION_POLICY.maxRetainedUtf16 + BIG_CHUNK.length,
  `T023-REGISTER-BUDGET-04 numbered retention stays close to the configured budget (retained ${bigRetained}, budget ${REGISTER_RETENTION_POLICY.maxRetainedUtf16})`);

const opened = openTextDocument('t023-put' as DocumentId, new TextEncoder().encode('abc\ndef'));
assert.equal(opened.kind, 'editable');
if (opened.kind !== 'editable') throw new Error('T023-PUT-DOCUMENT');
const snapshot = opened.document.snapshot();
const put = (command: 'p' | 'P' | 'gp' | 'gP', register: VimRegisterValue, cursor: number, selection?: { readonly start: number; readonly end: number; readonly kind: 'characterwise' | 'linewise' | 'blockwise' }) => {
  const result = prepareVimPut({ snapshot, cursor: cursor as Utf16Offset, register, command, ...(selection === undefined ? {} : { selection: { ...selection, start: selection.start as Utf16Offset, end: selection.end as Utf16Offset } }) });
  assert.equal(result.ok, true, `T023-PUT-${command} produces a plan`);
  if (!result.ok) throw new Error(`T023-PUT-${command}`);
  return result.value;
};
assert.deepEqual(put('p', character(['X']), 1).edits, [{ start: 2, end: 2, text: 'X' }]);
assert.deepEqual(put('P', character(['X']), 1).edits, [{ start: 1, end: 1, text: 'X' }]);
assert.deepEqual(put('gp', character(['X']), 1).cursor, 3);
assert.deepEqual(put('gP', character(['X']), 1).cursor, 2);
assert.deepEqual(put('p', line(['X']), 0).edits, [{ start: 4, end: 4, text: 'X\n' }]);
assert.deepEqual(put('P', line(['X']), 0).edits, [{ start: 0, end: 0, text: 'X\n' }]);
const finalLineDocument = openTextDocument('t023-final-line' as DocumentId, new TextEncoder().encode('abc'));
assert.equal(finalLineDocument.kind, 'editable');
if (finalLineDocument.kind !== 'editable') throw new Error('T023-PUT-FINAL-LINE-DOCUMENT');
const finalSnapshot = finalLineDocument.document.snapshot();
const finalAfter = prepareVimPut({ snapshot: finalSnapshot, cursor: 1 as Utf16Offset, register: line(['X']), command: 'p' });
assert.equal(finalAfter.ok, true);
if (!finalAfter.ok) throw new Error('T023-PUT-FINAL-LINE-P');
assert.deepEqual(finalAfter.value.edits, [{ start: 3, end: 3, text: '\nX' }], 'linewise p at final line creates a separator');
assert.deepEqual(put('p', block(['X', 'Y'], 1), 0).edits, [
  { start: 0, end: 0, text: 'X' },
  { start: 4, end: 4, text: 'Y' },
]);
const paddedBlock = prepareVimPut({ snapshot, cursor: 5 as Utf16Offset, register: block(['Z'], 1), command: 'p' });
assert.equal(paddedBlock.ok, true);
if (!paddedBlock.ok) throw new Error('T023-PUT-BLOCK-PADDING');
assert.deepEqual(paddedBlock.value.edits, [{ start: 5, end: 5, text: 'Z' }], 'block put targets the same logical column on each line');
const selected = put('p', character(['Z']), 1, { start: 1, end: 2, kind: 'characterwise' });
assert.deepEqual(selected.edits, [{ start: 1, end: 2, text: 'Z' }], 'visual put replaces the selected range');
assert.deepEqual(selected.register, character(['Z']), 'visual put never mutates its source register');
const selectedBlock = prepareVimPut({
  snapshot,
  cursor: 1 as Utf16Offset,
  register: block(['X', 'Y'], 1),
  command: 'p',
  selection: { start: 1 as Utf16Offset, end: 6 as Utf16Offset, kind: 'blockwise', firstLine: 0, lastLine: 1, firstColumn: 1, lastColumn: 1 },
});
assert.equal(selectedBlock.ok, true);
if (!selectedBlock.ok) throw new Error('T023-PUT-VISUAL-BLOCK');
assert.deepEqual(selectedBlock.value.edits, [
  { start: 1, end: 2, text: 'X' },
  { start: 5, end: 6, text: 'Y' },
], 'visual block put emits one bounded edit per selected line');

const cancellation = { isCancelled: false, onCancel: () => ({ dispose() {} }) };
const deniedClipboard = {
  async readText() { return { ok: false as const, error: { code: 'denied', message: 'clipboard denied', retryable: false } }; },
  async writeText() { return { ok: false as const, error: { code: 'denied', message: 'clipboard denied', retryable: false } }; },
};
const beforeClipboard = appended.value;
const deniedRead = await importVimRegisterFromClipboard(beforeClipboard, deniedClipboard, cancellation);
assert.equal(deniedRead.ok, false, 'T023-CLIPBOARD-DENIAL-01 reports clipboard denial');
assert.equal(beforeClipboard.generation, appended.value.generation, 'clipboard denial leaves internal yank untouched');
const deniedWrite = await exportVimRegisterToClipboard(line(['one']), deniedClipboard, cancellation);
assert.equal(deniedWrite.ok, false, 'clipboard export reports denial explicitly');

const oracleFixture: OracleFixture = {
  id: 'T023-REGISTER-PUT-ORACLE',
  title: 'Pinned register append and put state',
  purpose: 'Observe named uppercase append, numbered delete rotation and a characterwise p put in Neovim.',
  modes: ['normal'],
  lines: ['one', 'two', 'three'],
  cursor: { line: 1, byteColumn0: 0 },
  steps: [
    { label: 'named-yank', keys: '"ayy' },
    { label: 'uppercase-append', keys: 'j"Ayy' },
    { label: 'numbered-delete', keys: 'dd' },
    { label: 'character-put', keys: '"ap' },
  ],
};
const oracle = await verifyOracleBundle();
const observed = await runOracleFixture(oracleFixture, oracle.binaryPath);
assert.equal(observed.snapshots.length, oracleFixture.steps.length);
const first = observed.snapshots[0];
const second = observed.snapshots[1];
const third = observed.snapshots[2];
const fourth = observed.snapshots[3];
assert(first !== undefined && second !== undefined && third !== undefined && fourth !== undefined);
assertRegister(first, 'a', ['one'], 'V', 'T023-ORACLE-APPEND-01');
assertRegister(second, 'a', ['one', 'two'], 'V', 'T023-ORACLE-APPEND-02');
assertRegister(third, '1', ['two'], 'V', 'T023-ORACLE-ROTATE-01');
assert(fourth.lines.join('\n').includes('two'), 'T023-ORACLE-PUT-01 put leaves the yanked line in the buffer');

const blockOracleFixture: OracleFixture = {
  id: 'T023-REGISTER-BLOCK-ORACLE',
  title: 'Pinned visual block register width',
  purpose: 'Observe the native blockwise register payload and width metadata after a two-column visual block yank.',
  modes: ['normal'],
  lines: ['abcd', 'efgh'],
  cursor: { line: 1, byteColumn0: 0 },
  steps: [{ label: 'block-yank', keys: '<C-v>jly' }],
};
const blockObserved = await runOracleFixture(blockOracleFixture, oracle.binaryPath);
const blockSnapshot = blockObserved.snapshots[0];
assert(blockSnapshot !== undefined, 'T023-ORACLE-BLOCK-01 snapshot exists');
if (blockSnapshot !== undefined) {
  assertRegister(blockSnapshot, '0', ['ab', 'ef'], '\u00162', 'T023-ORACLE-BLOCK-01');
  assertRegister(blockSnapshot, '"', ['ab', 'ef'], '\u00162', 'T023-ORACLE-BLOCK-02');
}

const visualPutOracleFixture: OracleFixture = {
  id: 'T023-REGISTER-VISUAL-PUT-ORACLE',
  title: 'Visual put source preservation',
  purpose: 'Observe a characterwise named register through a visual put and verify its source value remains unchanged.',
  modes: ['normal'],
  lines: ['abcd', 'efgh'],
  cursor: { line: 1, byteColumn0: 0 },
  steps: [{ label: 'visual-put', keys: 'vll"ay0vll"ap' }],
};
const visualPutObserved = await runOracleFixture(visualPutOracleFixture, oracle.binaryPath);
const visualPutSnapshot = visualPutObserved.snapshots[0];
assert(visualPutSnapshot !== undefined, 'T023-ORACLE-VISUAL-PUT-01 snapshot exists');
if (visualPutSnapshot !== undefined) {
  assert.deepEqual(visualPutSnapshot.lines, ['abcd', 'efgh'], 'T023-ORACLE-VISUAL-PUT-01 buffer remains stable');
  assertRegister(visualPutSnapshot, 'a', ['abc'], 'v', 'T023-ORACLE-VISUAL-PUT-02');
}

console.log('PASS T023 registers/put: immutable yanks, uppercase append, numbered rotation, small-delete, black-hole, p/P/gp/gP, visual replacement and clipboard denial; pinned oracle append/rotation/put/block-width/visual-source state passed');

function assertRegister(snapshot: OracleSnapshot, name: string, lines: readonly string[], type: string, label: string): void {
  const actual = snapshot.registers[name] as { readonly lines: readonly string[]; readonly type: string } | undefined;
  assert(actual !== undefined, `${label}: register ${name} exists`);
  if (actual === undefined) return;
  assert.deepEqual(actual.lines, lines, `${label}: lines`);
  assert.equal(actual.type, type, `${label}: type`);
}
