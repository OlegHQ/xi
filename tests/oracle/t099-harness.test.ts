import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  artifactRoot,
  runOracleFixture,
  runUiOracleFixture,
  verifyOracleBundle,
} from './oracle-runner';
import type { OracleFixture } from './types';

const oracle = await verifyOracleBundle(process.env.XI_NVIM);

const rawFind: OracleFixture = {
  id: 'T099-HEADLESS-RAW-FIND-EMOJI-01',
  title: 'Raw supplementary character survives key expansion for find motion',
  purpose: 'Guard against passing a whole UTF-8 key string through termcode replacement.',
  modes: ['normal'],
  lines: ['a😀b😀c'],
  cursor: { line: 1, byteColumn0: 0 },
  steps: [
    { label: 'baseline', keys: '' },
    { label: 'find-first-emoji', keys: 'f😀' },
  ],
};
const rawInsert: OracleFixture = {
  id: 'T099-HEADLESS-RAW-INSERT-EMOJI-01',
  title: 'Raw supplementary character adjacent to a special key survives insertion',
  purpose: 'Check literal UTF-8 immediately before a terminal key token.',
  modes: ['insert', 'normal'],
  lines: ['ab'],
  cursor: { line: 1, byteColumn0: 0 },
  steps: [{ label: 'insert-emoji-then-escape', keys: 'i😀<Esc>' }],
};
const unknownThenKnown: OracleFixture = {
  id: 'T099-HEADLESS-UNKNOWN-THEN-KNOWN-01',
  title: 'Unknown angle notation does not swallow a later valid token',
  purpose: 'Keep the leading less-than literal while still expanding the following Escape.',
  modes: ['insert', 'normal'],
  lines: ['ab'],
  cursor: { line: 1, byteColumn0: 0 },
  steps: [{ label: 'literal-less-than-then-escape', keys: 'i<<Esc>' }],
};
const mappedFunctionKey: OracleFixture = {
  id: 'T099-MAPPED-F5-RAW-UNICODE-01',
  title: 'Mapped F5 notation still expands while its raw UTF-8 mapping stays intact',
  purpose: 'Preserve mapped special-key input through the production scanner.',
  modes: ['normal'],
  lines: ['a😀b😀c'],
  cursor: { line: 1, byteColumn0: 0 },
  mappings: [{ mode: 'n', lhs: '<F5>', rhs: 'f😀' }],
  steps: [{ label: 'mapped-find-first-emoji', keys: '<F5>' }],
};
const drainBarrier: OracleFixture = {
  id: 'T099-DRAIN-BARRIER-01',
  title: 'Unbarriered keys remain queued until an explicit drain',
  purpose: 'Preserve oracle queue semantics while changing input key expansion.',
  modes: ['insert', 'normal'],
  lines: ['ab'],
  cursor: { line: 1, byteColumn0: 0 },
  steps: [
    { label: 'queue-without-drain', keys: 'iX<Esc>', barrier: false },
    { label: 'explicit-drain', drain: true },
  ],
};

const findResult = await runOracleFixture(rawFind, oracle.binaryPath);
assert.deepEqual(findResult.snapshots[1]?.lines, ['a😀b😀c']);
assert.equal(findResult.snapshots[1]?.cursor.byteColumn, 2);
assert.deepEqual(findResult.snapshots[1]?.registers['"'], findResult.snapshots[0]?.registers['"']);

const insertResult = await runOracleFixture(rawInsert, oracle.binaryPath);
assert.deepEqual(insertResult.snapshots[0]?.lines, ['😀ab']);
assert.equal(insertResult.snapshots[0]?.cursor.byteColumn, 1);
assert.equal(insertResult.snapshots[0]?.mode, 'n');

const unknownResult = await runOracleFixture(unknownThenKnown, oracle.binaryPath);
assert.deepEqual(unknownResult.snapshots[0]?.lines, ['<ab']);
assert.equal(unknownResult.snapshots[0]?.mode, 'n');

const mappingResult = await runOracleFixture(mappedFunctionKey, oracle.binaryPath);
assert.deepEqual(mappingResult.snapshots[0]?.lines, ['a😀b😀c']);
assert.equal(mappingResult.snapshots[0]?.cursor.byteColumn, 2);

const barrierResult = await runOracleFixture(drainBarrier, oracle.binaryPath);
assert.deepEqual(barrierResult.snapshots[0]?.lines, ['ab']);
assert.deepEqual(barrierResult.snapshots[1]?.lines, ['Xab']);

const styledPty: OracleFixture = {
  id: 'T099-PTY-ANSI-UNICODE-01',
  title: 'PTY readiness sees the complete marker through ANSI-styled Unicode output',
  purpose: 'Ensure SGR between visible characters does not prevent full-marker matching.',
  modes: ['normal'],
  lines: ['a😀b'],
  cursor: { line: 1, byteColumn0: 0 },
  options: { columns: 40, lines: 8 },
  searchPattern: '😀',
  steps: [{ label: 'capture-styled-first-line', keys: '<Esc>' }],
};
const ptyResult = await runUiOracleFixture(styledPty, oracle.binaryPath, {
  readinessMarker: 'a😀b',
});
assert.equal(ptyResult.terminalRestored, true);
assert.deepEqual(ptyResult.snapshot.lines, ['a😀b']);
const styledTranscript = await readFile(ptyResult.transcriptPath, 'utf8');
assert.match(styledTranscript, /\u001b\[[0-?]*[ -/]*m(?:\u001b\[[0-?]*[ -/]*m)*a/u);
assert.ok(styledTranscript.includes('😀'));
assert.ok(!styledTranscript.includes('E1568'));

const markerTimeout: OracleFixture = {
  ...styledPty,
  id: 'T099-PTY-MARKER-TIMEOUT-RESTORE-01',
  title: 'PTY readiness timeout restores terminal modes',
};
await assert.rejects(
  () => runUiOracleFixture(markerTimeout, oracle.binaryPath, {
    readinessTimeoutMs: 1_000,
    readinessMarker: 'T099-MARKER-NEVER-RENDERED',
  }),
  /pty-marker-timeout/u,
);
const timeoutTranscript = await readFile(join(artifactRoot, 'pty', `${markerTimeout.id}.ansi`));
assert.ok(timeoutTranscript.includes(Buffer.from('\u001b[?1049l')));
assert.ok(timeoutTranscript.includes(Buffer.from('\u001b[?25h')));

const { searchPattern: _searchPattern, ...unstyledPty } = styledPty;
void _searchPattern;
const oracleFailure: OracleFixture = {
  ...unstyledPty,
  id: 'T099-PTY-ORACLE-FAILURE-RESTORE-01',
  title: 'PTY child failure restores terminal modes',
  steps: [{ label: 'quit-with-failure', keys: ':cq<CR>' }],
};
await assert.rejects(
  () => runUiOracleFixture(oracleFailure, oracle.binaryPath),
  /pty-oracle-(?:exited-before-marker|produced-no-snapshot)|oracle-process-failed/u,
);
const failureTranscript = await readFile(join(artifactRoot, 'pty', `${oracleFailure.id}.ansi`));
assert.ok(failureTranscript.includes(Buffer.from('\u001b[?1049l')));
assert.ok(failureTranscript.includes(Buffer.from('\u001b[?25h')));

console.log([
  'PASS T099-HEADLESS-RAW-FIND-EMOJI-01',
  'PASS T099-HEADLESS-RAW-INSERT-EMOJI-01',
  'PASS T099-HEADLESS-UNKNOWN-THEN-KNOWN-01',
  'PASS T099-MAPPED-F5-RAW-UNICODE-01',
  'PASS T099-DRAIN-BARRIER-01',
  'PASS T099-PTY-ANSI-UNICODE-01',
  'PASS T099-PTY-MARKER-TIMEOUT-RESTORE-01',
  'PASS T099-PTY-ORACLE-FAILURE-RESTORE-01',
].join('\n'));
