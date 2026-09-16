#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  beginVimMacroRecording,
  commitVimMacroRecording,
  executeVimMacro,
  finishVimMacroRecording,
  readVimMacro,
  recordVimMacroKey,
  recordVimMacroToken,
  writeVimMacro,
  createVimMacroStore,
  type VimMacroRecording,
  type VimMacroToken,
} from '../../../packages/vim/src/index';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture, OracleSnapshot } from '../../oracle/types';

interface FixtureCatalog { readonly schemaVersion: number; readonly fixtures: readonly OracleFixture[] }
interface OracleTrace {
  readonly schemaVersion: 1;
  readonly oracle: { readonly version: string; readonly binarySha256: string; readonly runtimeDocsSha256: string };
  readonly fixtureIds: readonly string[];
  readonly fixtures: readonly { readonly id: string; readonly snapshots: readonly OracleSnapshot[] }[];
  readonly note: string;
}

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const fixturePath = resolve(root, 'tests/vim/macros/t025-fixtures.json');
const tracePath = resolve(root, 'tests/vim/macros/t025-oracle-traces.json');
const catalog = JSON.parse(await readFile(fixturePath, 'utf8')) as FixtureCatalog;
assert.equal(catalog.schemaVersion, 1, 'T025-ORACLE-CATALOG-01 fixture schema is supported');
const oracle = await verifyOracleBundle();
const tracedFixtures: OracleTrace['fixtures'][number][] = [];
for (const fixture of catalog.fixtures) {
  const result = await runOracleFixture(fixture, oracle.binaryPath);
  assert.equal(result.snapshots.length, fixture.steps.length,
    `T025-ORACLE-SNAPSHOT-01 ${fixture.id} has one snapshot per command`);
  tracedFixtures.push({ id: fixture.id, snapshots: result.snapshots });
}
const generatedTrace: OracleTrace = {
  schemaVersion: 1,
  oracle: {
    version: oracle.manifest.oracle.version,
    binarySha256: oracle.manifest.oracle.binarySha256,
    runtimeDocsSha256: oracle.manifest.oracle.runtimeDocs.sha256,
  },
  fixtureIds: catalog.fixtures.map((fixture) => fixture.id),
  fixtures: tracedFixtures,
  note: 'Pinned Neovim 0.12.4 macro recording/playback snapshots for T025 only; no compatibility inventory rows are marked verified by this file.',
};
if (process.argv.includes('--record')) {
  await writeFile(tracePath, `${JSON.stringify(generatedTrace, null, 2)}\n`, 'utf8');
  console.log(`RECORDED ${tracedFixtures.length} T025 fixtures to ${tracePath}`);
} else {
  const expected = JSON.parse(await readFile(tracePath, 'utf8')) as OracleTrace;
  assert.deepEqual(expected, generatedTrace, 'T025-ORACLE-TRACE-01 snapshots match pinned Neovim');
}
assert.equal(generatedTrace.oracle.version, '0.12.4', 'T025-ORACLE-02 uses Neovim 0.12.4');
assert.equal(generatedTrace.oracle.binarySha256,
  'd9635db0b272b7c81cd705ef0d8bbf16edfeb05b08b36b4228ab0d6a92ec384f',
  'T025-ORACLE-03 uses the pinned Neovim binary');
assert.equal(generatedTrace.oracle.runtimeDocsSha256,
  '79b80909bf8f5fe1d89a0fb66200388e651c88d49d565fdc51780ef4b24d7b1e',
  'T025-ORACLE-04 uses the pinned Neovim runtime docs');
const expectedOracleText: Readonly<Record<string, readonly string[]>> = {
  'T025-ORACLE-RECORD-PLAY-01': ['XXXone two three'],
  'T025-ORACLE-NESTED-01': ['XXXone two'],
  'T025-ORACLE-MAPPING-01': ['XXone two'],
};
for (const fixture of generatedTrace.fixtures) {
  const expected = expectedOracleText[fixture.id];
  assert.notEqual(expected, undefined, `T025-ORACLE-TEXT-01 ${fixture.id} has an expected result`);
  const final = fixture.snapshots.at(-1);
  assert.notEqual(final, undefined, `T025-ORACLE-TEXT-02 ${fixture.id} has a final snapshot`);
  if (expected !== undefined && final !== undefined) {
    assert.deepEqual(final.lines, expected, `T025-ORACLE-TEXT-03 ${fixture.id} matches Neovim output`);
  }
}

let recording = expectOk(beginVimMacroRecording('a'));
recording = expectOk(recordVimMacroKey(recording, { key: '<F5>', source: 'user' }));
const beforeMappingExpansion = recording;
recording = expectOk(recordVimMacroKey(recording, { key: 'iX<Esc>', source: 'mapping' }));
assert.strictEqual(recording, beforeMappingExpansion,
  'T025-RECORD-01 mapping expansion is not recorded a second time');
const beforeMacroReplay = recording;
recording = expectOk(recordVimMacroKey(recording, { key: '<F5>', source: 'macro' }));
assert.strictEqual(recording, beforeMacroReplay, 'T025-RECORD-02 macro playback is not recorded recursively');
recording = expectOk(recordVimMacroToken(recording, { kind: 'macro-call', register: 'b', count: 1 }));
const committed = expectOk(commitVimMacroRecording(createVimMacroStore(), recording));
assert.equal(committed.recording.tokenCount, 2, 'T025-RECORD-03 raw key and semantic nested token are retained');
assert.deepEqual(committed.recording.tokens[0], { kind: 'key', key: '<F5>' },
  'T025-RECORD-04 macro stores raw mapped key for replay through mappings');

const simpleStore = storeFrom('a', [{ kind: 'key', key: 'x' }, { kind: 'key', key: 'y' }]);
const seen: string[] = [];
const simpleRun = expectOk(executeVimMacro(simpleStore, 'a', (context) => {
  seen.push(context.token.key);
  return { ok: true, value: { kind: 'continue', committed: true } };
}, { sliceSize: 1 }));
assert.equal(simpleRun.status, 'completed', 'T025-EXEC-01 macro executes through the dispatcher');
assert.deepEqual(seen, ['x', 'y'], 'T025-EXEC-02 dispatcher receives each recorded token exactly once');
assert.equal(simpleRun.committedCommands, 2, 'T025-EXEC-03 committed command count is atomic per callback');
assert.equal(simpleRun.slices, 2, 'T025-EXEC-04 deterministic slice callback boundary is honored');

const nestedStore = storeFrom('a', [{ kind: 'key', key: 'x' }], 'b', [
  { kind: 'macro-call', register: 'a', count: 1 }, { kind: 'repeat-last' },
]);
const nestedSeen: string[] = [];
const nestedRun = expectOk(executeVimMacro(nestedStore, 'b', (context) => {
  nestedSeen.push(context.token.key);
  return { ok: true, value: { kind: 'continue', committed: true } };
}));
assert.equal(nestedRun.status, 'completed', 'T025-EXEC-05 nested macro completes');
assert.deepEqual(nestedSeen, ['x', 'x'], 'T025-EXEC-06 nested @ and @@ use one parser dispatch path');
assert.equal(nestedRun.lastRegister, 'a', 'T025-EXEC-07 @@ retains the most recently invoked register');
const crossCallSeen: string[] = [];
const crossCall = expectOk(executeVimMacro(nestedStore, '@', (context) => {
  crossCallSeen.push(context.token.key);
  return { ok: true, value: { kind: 'continue', committed: true } };
}, { lastRegister: nestedRun.lastRegister }));
assert.equal(crossCall.status, 'completed', 'T025-EXEC-08 @@ can use the retained register across executions');
assert.deepEqual(crossCallSeen, ['x'], 'T025-EXEC-09 cross-execution @@ dispatches the retained macro');

const mappingStore = storeFrom('a', [{ kind: 'key', key: '<F5>' }]);
let mappingDispatches = 0;
const mappingRun = expectOk(executeVimMacro(mappingStore, 'a', (context) => {
  mappingDispatches += 1;
  assert.equal(context.token.key, '<F5>', 'T025-MAPPING-01 macro sends the raw lhs to mapping dispatch');
  return { ok: true, value: { kind: 'continue', committed: true } };
}));
assert.equal(mappingRun.status, 'completed', 'T025-MAPPING-02 mapped macro completes');
assert.equal(mappingDispatches, 1, 'T025-MAPPING-03 mapping expansion is performed once by the dispatcher');

const recursionStore = storeFrom('a', [{ kind: 'macro-call', register: 'a', count: 1 }]);
const recursionRun = expectOk(executeVimMacro(recursionStore, 'a', () => ({
  ok: true, value: { kind: 'continue', committed: true },
})));
assert.deepEqual(recursionRun, {
  status: 'failed', register: 'a', committedCommands: 0, consumedTokens: 1, slices: 0,
  lastRegister: 'a', failure: { kind: 'recursive-macro', register: 'a' },
}, 'T025-FAILURE-01 recursive macro stops before a half transaction');

let dispatchCount = 0;
const cancellationRun = expectOk(executeVimMacro(simpleStore, 'a', () => {
  dispatchCount += 1;
  return { ok: true, value: { kind: 'continue', committed: true } };
}, { isCancelled: () => dispatchCount >= 1, sliceSize: 1 }));
assert.equal(cancellationRun.status, 'cancelled', 'T025-FAILURE-02 cancellation is checked between commands');
assert.equal(cancellationRun.committedCommands, 1, 'T025-FAILURE-03 cancellation retains committed operations');

dispatchCount = 0;
const errorRun = expectOk(executeVimMacro(simpleStore, 'a', () => {
  dispatchCount += 1;
  return dispatchCount === 2
    ? { ok: false, error: { kind: 'dispatch-failed', message: 'synthetic failure' } }
    : { ok: true, value: { kind: 'continue', committed: true } };
}));
assert.deepEqual(errorRun, {
  status: 'failed', register: 'a', committedCommands: 1, consumedTokens: 2, slices: 0,
  lastRegister: 'a', failure: { kind: 'dispatch-failed', message: 'synthetic failure' },
}, 'T025-FAILURE-04 mid-macro error preserves prior atomic commands');

const hugeCount = expectOk(executeVimMacro(simpleStore, 'a', () => ({
  ok: true, value: { kind: 'continue', committed: true },
}), { count: 2, maxRepeatCount: 1 }));
assert.deepEqual(hugeCount.failure, { kind: 'repeat-count-limit', count: 2, limit: 1 },
  'T025-FAILURE-05 huge repeat count is rejected deterministically');
assert.equal(hugeCount.committedCommands, 0, 'T025-FAILURE-06 huge count fails before dispatch');

assert.deepEqual(expectError(finishVimMacroRecording(expectOk(beginVimMacroRecording('c')))),
  { kind: 'empty-macro' }, 'T025-FAILURE-07 empty macro is rejected');
const lookup = expectOk(readVimMacro(committed.store, 'a'));
assert.equal(lookup.generation, 1, 'T025-REGISTER-01 macro register metadata increments on commit');
console.log(`T025 macro recording/execution passed ${catalog.fixtures.length} pinned oracle fixtures; raw mapping keys, nested @/@@, recursion, cancellation, work budget and atomic failure isolation verified`);
console.log(`oracle=Neovim ${generatedTrace.oracle.version}; binary=${generatedTrace.oracle.binarySha256}`);
console.log(`runtime_docs=${generatedTrace.oracle.runtimeDocsSha256}`);

function storeFrom(firstRegister: 'a' | 'b', firstTokens: readonly VimMacroToken[], secondRegister?: 'a' | 'b', secondTokens?: readonly VimMacroToken[]) {
  let store = createVimMacroStore();
  for (const [register, tokens] of [[firstRegister, firstTokens], ...(secondRegister === undefined || secondTokens === undefined ? [] : [[secondRegister, secondTokens] as const])] as const) {
    const recording: VimMacroRecording = { register, tokens, tokenCount: tokens.length };
    store = expectOk(writeVimMacro(store, recording));
  }
  return store;
}

function expectOk<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }): T {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
}

function expectError<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }): unknown {
  if (!result.ok) return result.error;
  throw new Error('unexpected success');
}
