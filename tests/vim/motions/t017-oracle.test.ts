#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture, OracleSnapshot } from '../../oracle/types';

interface WordTraceSnapshot {
  readonly label: string;
  readonly lines: readonly string[];
  readonly cursor: {
    readonly line: number;
    readonly byteColumn: number;
    readonly coladd: number;
    readonly virtualColumn: number;
    readonly desiredColumn: number;
  };
  readonly mode: string;
  readonly error: string;
  readonly iskeyword: string;
  readonly nonemptyRegisters: Readonly<Record<string, unknown>>;
}

interface WordTraceFixture {
  readonly id: string;
  readonly steps: readonly { readonly label: string; readonly keys: string | null; readonly drain: boolean }[];
  readonly snapshots: readonly WordTraceSnapshot[];
}

interface WordTraceDocument {
  readonly schemaVersion: number;
  readonly oracle: {
    readonly version: string;
    readonly binarySha256: string;
    readonly runtimeDocsSha256: string;
  };
  readonly helpTags: readonly string[];
  readonly note: string;
  readonly fixtures: readonly WordTraceFixture[];
}

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const fixturePath = resolve(root, 'tests/vim/motions/t017-fixtures.json');
const tracePath = resolve(root, 'docs/compatibility/t017-word.json');
const fixtureDocument = JSON.parse(await readFile(fixturePath, 'utf8')) as {
  readonly schemaVersion: number;
  readonly fixtures: readonly OracleFixture[];
};
assert.equal(fixtureDocument.schemaVersion, 1, 'T017-ORACLE-CATALOG-01 fixture schema is recognized');

const oracle = await verifyOracleBundle();
const capturedFixtures: WordTraceFixture[] = [];
for (const fixture of fixtureDocument.fixtures) {
  const result = await runOracleFixture(fixture, oracle.binaryPath);
  assert.equal(result.snapshots.length, fixture.steps.length, `T017-ORACLE-SNAPSHOT-01 ${fixture.id} has one snapshot per step`);
  const snapshots = result.snapshots.map(projectSnapshot);
  const initial = snapshots[0];
  assert.ok(initial, `T017-ORACLE-STATE-01 ${fixture.id} has an initial snapshot`);
  for (const snapshot of snapshots.slice(1)) {
    assert.deepEqual(snapshot.lines, initial.lines, `T017-ORACLE-STATE-01 ${fixture.id}/${snapshot.label} preserves text`);
    assert.deepEqual(snapshot.nonemptyRegisters, initial.nonemptyRegisters,
      `T017-ORACLE-STATE-01 ${fixture.id}/${snapshot.label} preserves nonempty registers`);
  }
  capturedFixtures.push({
    id: fixture.id,
    steps: fixture.steps.map((step) => ({ label: step.label, keys: step.keys ?? null, drain: step.drain ?? false })),
    snapshots,
  });
}

const trace: WordTraceDocument = {
  schemaVersion: 1,
  oracle: {
    version: oracle.manifest.oracle.version,
    binarySha256: oracle.manifest.oracle.binarySha256,
    runtimeDocsSha256: oracle.manifest.oracle.runtimeDocs.sha256,
  },
  helpTags: ['word', 'WORD', 'w', 'W', 'b', 'B', 'e', 'E', 'ge', 'gE', "'iskeyword'"],
  note: 'Pinned fixture evidence only. Compatibility inventory rows remain unimplemented pending T061 review.',
  fixtures: capturedFixtures,
};

if (process.argv.includes('--record')) {
  await writeFile(tracePath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
  console.log(`RECORDED ${capturedFixtures.length} T017 fixtures to ${tracePath}`);
} else {
  const expected = JSON.parse(await readFile(tracePath, 'utf8')) as WordTraceDocument;
  assert.equal(expected.schemaVersion, 1, 'T017-ORACLE-TRACE-01 trace schema is recognized');
  assert.deepEqual(expected.oracle, trace.oracle, 'T017-ORACLE-PIN-01 trace matches pinned Neovim binary and runtime docs');
  assert.deepEqual(expected.helpTags, trace.helpTags, 'T017-ORACLE-HELP-01 pinned help tags remain identified');
  assert.equal(expected.fixtures.length, fixtureDocument.fixtures.length,
    'T017-ORACLE-TRACE-01 every fixture has a captured trace');
  assert.deepEqual(expected, trace, 'T017-ORACLE-TRACE-01 all recorded word-motion behavior still matches Neovim');
  console.log(`T017 oracle passed ${capturedFixtures.length} fixtures / ${capturedFixtures.reduce((sum, fixture) => sum + fixture.snapshots.length, 0)} snapshots`);
}

console.log(`oracle=Neovim ${oracle.manifest.oracle.version}; binary=${oracle.manifest.oracle.binarySha256}`);
console.log(`runtime_docs=${oracle.manifest.oracle.runtimeDocs.sha256}`);

function projectSnapshot(snapshot: OracleSnapshot): WordTraceSnapshot {
  const nonemptyRegisters = Object.fromEntries(Object.entries(snapshot.registers)
    .filter(([, value]) => isRecord(value) && Array.isArray(value.lines) && value.lines.length > 0));
  return {
    label: snapshot.label,
    lines: snapshot.lines,
    cursor: {
      line: snapshot.cursor.line,
      byteColumn: snapshot.cursor.byteColumn,
      coladd: snapshot.cursor.coladd,
      virtualColumn: snapshot.cursor.virtualColumn,
      desiredColumn: snapshot.cursor.desiredColumn,
    },
    mode: snapshot.mode,
    error: snapshot.error,
    iskeyword: String(snapshot.options.iskeyword ?? ''),
    nonemptyRegisters,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
