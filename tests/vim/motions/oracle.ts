#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture } from '../../oracle/types';

interface CapturedMotionSnapshot {
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
  readonly options: Readonly<Record<string, string | number | boolean>>;
  readonly nonemptyRegisters: Readonly<Record<string, unknown>>;
}

interface CapturedMotionFixture {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly { readonly label: string; readonly keys: string | null; readonly drain: boolean }[];
  readonly snapshots: readonly CapturedMotionSnapshot[];
}

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const fixturePath = resolve(root, 'tests/vim/motions/fixtures.json');
const tracePath = resolve(root, 'docs/compatibility/t016-oracle-traces.json');
const fixtureDocument = JSON.parse(await readFile(fixturePath, 'utf8')) as { schemaVersion: number; fixtures: OracleFixture[] };
const traceDocument = JSON.parse(await readFile(tracePath, 'utf8')) as {
  schemaVersion: number;
  oracle: { version: string; binarySha256: string; runtimeDocsSha256: string };
  fixtures: CapturedMotionFixture[];
};

assert.equal(fixtureDocument.schemaVersion, 1, 'T016-ORACLE-CATALOG-01 fixture catalog version is recognized');
assert.equal(traceDocument.schemaVersion, 1, 'T016-ORACLE-TRACE-01 captured trace version is recognized');
assert.equal(traceDocument.fixtures.length, fixtureDocument.fixtures.length, 'T016-ORACLE-TRACE-01 every fixture has a captured trace');

const oracle = await verifyOracleBundle();
assert.equal(traceDocument.oracle.version, oracle.manifest.oracle.version, 'T016-ORACLE-PIN-01 trace version matches the pinned oracle');
assert.equal(traceDocument.oracle.binarySha256, oracle.manifest.oracle.binarySha256, 'T016-ORACLE-PIN-01 trace binary hash matches the pinned oracle');
assert.equal(traceDocument.oracle.runtimeDocsSha256, oracle.manifest.oracle.runtimeDocs.sha256, 'T016-ORACLE-PIN-01 trace docs hash matches the pinned oracle');

for (const fixture of fixtureDocument.fixtures) {
  const captured = traceDocument.fixtures.find((entry) => entry.id === fixture.id);
  if (captured === undefined) throw new Error(`T016-ORACLE-TRACE-01 ${fixture.id} has no captured expectations`);
  assert.deepEqual(captured.steps, fixture.steps.map((step) => ({
    label: step.label,
    keys: step.keys ?? null,
    drain: step.drain ?? false,
  })), `T016-ORACLE-TRACE-01 ${fixture.id} steps match captured expectations`);

  const actual = await runOracleFixture(fixture, oracle.binaryPath);
  assert.equal(actual.snapshots.length, captured.snapshots.length, `T016-ORACLE-TRACE-01 ${fixture.id} snapshot count matches`);
  for (let index = 0; index < actual.snapshots.length; index += 1) {
    const snapshot = actual.snapshots[index];
    const expectedState = captured.snapshots[index];
    if (snapshot === undefined || expectedState === undefined) throw new Error(`T016-ORACLE-TRACE-01 ${fixture.id} snapshot ${index} is missing`);
    const expected: CapturedMotionSnapshot = expectedState;
    const optionValues: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(snapshot.options)) {
      if ((key === 'whichwrap' || key === 'startofline' || key === 'tabstop')
        && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) optionValues[key] = value;
    }
    const actualState: CapturedMotionSnapshot = {
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
      options: optionValues,
      nonemptyRegisters: Object.fromEntries(Object.entries(snapshot.registers)
        .filter(([, value]) => isRecord(value) && Array.isArray(value.lines) && value.lines.length > 0)),
    };
    assert.deepEqual(actualState, expected, `T016-ORACLE-TRACE-01 ${fixture.id}/${expected.label} matches pinned Neovim`);
  }
  console.log(`PASS ${fixture.id} (${fixture.steps.length} snapshots)`);
}

const invariantFixture = traceDocument.fixtures.find((entry) => entry.id === 'T016-ORACLE-MOTION-STATE-INVARIANTS-01');
assert.ok(invariantFixture, 'T016-ORACLE-STATE-01 motion-only fixture exists');
const seeded = invariantFixture.snapshots[0];
assert.ok(seeded, 'T016-ORACLE-STATE-01 seeded register snapshot exists');
for (const snapshot of invariantFixture.snapshots.slice(1)) {
  assert.deepEqual(snapshot.lines, seeded.lines, `T016-ORACLE-STATE-01 ${snapshot.label} leaves text unchanged`);
  assert.deepEqual(snapshot.nonemptyRegisters, seeded.nonemptyRegisters, `T016-ORACLE-STATE-01 ${snapshot.label} leaves registers unchanged`);
}
console.log('PASS T016-ORACLE-STATE-01 motion-only trace preserves text and all nonempty registers');
console.log(`oracle=Neovim ${oracle.manifest.oracle.version}; binary=${oracle.manifest.oracle.binarySha256}`);
console.log(`runtime_docs=${oracle.manifest.oracle.runtimeDocs.sha256}`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
