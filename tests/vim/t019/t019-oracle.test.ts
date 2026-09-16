#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture, OracleSnapshot } from '../../oracle/types';

interface T019FixtureCatalog {
  readonly schemaVersion: number;
  readonly fixtures: readonly OracleFixture[];
}

interface T019OracleTrace {
  readonly schemaVersion: 1;
  readonly oracle: {
    readonly version: string;
    readonly binarySha256: string;
    readonly runtimeDocsSha256: string;
  };
  readonly fixtureIds: readonly string[];
  readonly fixtures: readonly {
    readonly id: string;
    readonly snapshots: readonly OracleSnapshot[];
  }[];
  readonly note: string;
}

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const fixturePath = resolve(root, 'tests/vim/t019/t019-fixtures.json');
const tracePath = resolve(root, 'tests/vim/t019/t019-oracle-traces.json');
const catalog = JSON.parse(await readFile(fixturePath, 'utf8')) as T019FixtureCatalog;
assert.equal(catalog.schemaVersion, 1, 'T019-ORACLE-CATALOG-01 fixture schema is supported');
const oracle = await verifyOracleBundle();
const fixtures: { readonly id: string; readonly snapshots: readonly OracleSnapshot[] }[] = [];

for (const fixture of catalog.fixtures) {
  const result = await runOracleFixture(fixture, oracle.binaryPath);
  assert.equal(result.snapshots.length, fixture.steps.length,
    `T019-ORACLE-SNAPSHOT-01 ${fixture.id} has one snapshot per command`);
  fixtures.push({ id: fixture.id, snapshots: result.snapshots });
}

const trace: T019OracleTrace = {
  schemaVersion: 1,
  oracle: {
    version: oracle.manifest.oracle.version,
    binarySha256: oracle.manifest.oracle.binarySha256,
    runtimeDocsSha256: oracle.manifest.oracle.runtimeDocs.sha256,
  },
  fixtureIds: catalog.fixtures.map((fixture) => fixture.id),
  fixtures,
  note: 'Pinned Neovim state snapshots for T019 fixtures only; no compatibility inventory rows are marked verified by this file.',
};

const failedMotion = findFixture(trace, 'T019-ORACLE-FAILED-MOTION-REPEAT-01');
const afterSeededDelete = findSnapshot(failedMotion.snapshots, 'successful-dw-seeds-repeat');
const afterFailure = findSnapshot(failedMotion.snapshots, 'failed-find-operator');
assert.deepEqual(afterFailure.lines, afterSeededDelete.lines,
  'T019-ORACLE-FAILED-MOTION-01 failed motion preserves text');
assert.deepEqual(afterFailure.cursor, afterSeededDelete.cursor,
  'T019-ORACLE-FAILED-MOTION-01 failed motion preserves cursor');
assert.deepEqual(afterFailure.registers, afterSeededDelete.registers,
  'T019-ORACLE-FAILED-MOTION-01 failed motion preserves registers');
assert.deepEqual(afterFailure.changeList, afterSeededDelete.changeList,
  'T019-ORACLE-FAILED-MOTION-01 failed motion preserves change list');
const afterDot = findSnapshot(failedMotion.snapshots, 'dot-repeats-prior-dw');
assert.deepEqual(afterDot.lines, ['three'],
  'T019-ORACLE-FAILED-MOTION-02 dot still repeats the prior successful dw');

if (process.argv.includes('--record')) {
  await writeFile(tracePath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
  console.log(`RECORDED ${fixtures.length} T019 fixtures to ${tracePath}`);
} else {
  const expected = JSON.parse(await readFile(tracePath, 'utf8')) as T019OracleTrace;
  assert.deepEqual(expected, trace, 'T019-ORACLE-TRACE-01 snapshots match pinned Neovim');
  console.log(`T019 oracle passed ${fixtures.length} fixtures / ${fixtures.reduce((sum, fixture) => sum + fixture.snapshots.length, 0)} snapshots`);
}

console.log(`oracle=Neovim ${oracle.manifest.oracle.version}; binary=${oracle.manifest.oracle.binarySha256}`);
console.log(`runtime_docs=${oracle.manifest.oracle.runtimeDocs.sha256}`);

function findFixture(source: T019OracleTrace, id: string): T019OracleTrace['fixtures'][number] {
  const result = source.fixtures.find((fixture) => fixture.id === id);
  assert.ok(result, `T019-ORACLE-TRACE-02 ${id} exists`);
  if (result === undefined) throw new Error(`T019-ORACLE-TRACE-02 missing fixture ${id}`);
  return result;
}

function findSnapshot(source: readonly OracleSnapshot[], label: string): OracleSnapshot {
  const result = source.find((snapshot) => snapshot.label === label);
  assert.ok(result, `T019-ORACLE-TRACE-03 ${label} exists`);
  if (result === undefined) throw new Error(`T019-ORACLE-TRACE-03 missing snapshot ${label}`);
  return result;
}
