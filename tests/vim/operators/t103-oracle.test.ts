#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const fixturePath = resolve(root, 'tests/vim/operators/t103-fixtures.json');
const tracePath = resolve(root, 'tests/vim/operators/t103-oracle-traces.json');
const catalog = JSON.parse(await readFile(fixturePath, 'utf8')) as FixtureCatalog;
assert.equal(catalog.schemaVersion, 1, 'T103-ORACLE-CATALOG-01 fixture schema is supported');
const oracle = await verifyOracleBundle();
const fixtures: OracleTrace['fixtures'][number][] = [];
for (const fixture of catalog.fixtures) {
  const result = await runOracleFixture(fixture, oracle.binaryPath);
  assert.equal(result.snapshots.length, fixture.steps.length,
    `T103-ORACLE-SNAPSHOT-01 ${fixture.id} has one snapshot per command`);
  fixtures.push({ id: fixture.id, snapshots: result.snapshots });
}
const trace: OracleTrace = {
  schemaVersion: 1,
  oracle: {
    version: oracle.manifest.oracle.version,
    binarySha256: oracle.manifest.oracle.binarySha256,
    runtimeDocsSha256: oracle.manifest.oracle.runtimeDocs.sha256,
  },
  fixtureIds: catalog.fixtures.map((fixture) => fixture.id),
  fixtures,
  note: 'Pinned Neovim 0.12.4 text-transform operator snapshots for T103; provider-backed formatting is an explicit Xi integration boundary.',
};
if (process.argv.includes('--record')) {
  await writeFile(tracePath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
  console.log(`RECORDED ${fixtures.length} T103 fixtures to ${tracePath}`);
} else {
  const expected = JSON.parse(await readFile(tracePath, 'utf8')) as OracleTrace;
  assert.deepEqual(expected, trace, 'T103-ORACLE-TRACE-01 snapshots match pinned Neovim');
}
assert.equal(trace.oracle.version, '0.12.4', 'T103-ORACLE-02 uses Neovim 0.12.4');
assert.equal(trace.oracle.binarySha256,
  'd9635db0b272b7c81cd705ef0d8bbf16edfeb05b08b36b4228ab0d6a92ec384f',
  'T103-ORACLE-03 uses the pinned Neovim binary');
assert.equal(trace.oracle.runtimeDocsSha256,
  '79b80909bf8f5fe1d89a0fb66200388e651c88d49d565fdc51780ef4b24d7b1e',
  'T103-ORACLE-04 uses the pinned Neovim runtime docs');
const expectedLines: Readonly<Record<string, readonly string[]>> = {
  'T103-ORACLE-GU-CHAR-01': ['one TWO'],
  'T103-ORACLE-GU-LINE-01': ['one two', 'three four'],
  'T103-ORACLE-GU-UPPER-CHAR-01': ['ONE TWO'],
  'T103-ORACLE-GU-BLOCK-01': ['ABCD', 'EFGH'],
  'T103-ORACLE-GTILDE-01': ['aBc xYz'],
  'T103-ORACLE-J-JOINSPACES-01': ['Hello.  world', 'next'],
  'T103-ORACLE-J-SINGLESPACE-01': ['Hello. world'],
  'T103-ORACLE-GJ-NOSPACES-01': ['leftright'],
  'T103-ORACLE-INDENT-01': ['\tone', '  two'],
  'T103-ORACLE-DEDENT-01': ['one'],
  'T103-ORACLE-FORMAT-01': ['one two', 'three four', 'five six', 'seven eight', 'nine ten'],
  'T103-ORACLE-FORMAT-PRESERVE-01': ['one two', 'three four', 'five six', 'seven eight', 'nine ten'],
};
for (const fixture of fixtures) {
  const expected = expectedLines[fixture.id];
  assert.notEqual(expected, undefined, `T103-ORACLE-TEXT-01 ${fixture.id} has expected lines`);
  const finalSnapshot = fixture.snapshots.at(-1);
  assert.notEqual(finalSnapshot, undefined, `T103-ORACLE-TEXT-02 ${fixture.id} has final snapshot`);
  if (expected !== undefined && finalSnapshot !== undefined) {
    assert.deepEqual(finalSnapshot.lines, expected, `T103-ORACLE-TEXT-03 ${fixture.id} matches Neovim output`);
  }
}
console.log(`T103 oracle passed ${fixtures.length} pinned text-transform fixtures`);
console.log(`oracle=Neovim ${trace.oracle.version}; binary=${trace.oracle.binarySha256}`);
console.log(`runtime_docs=${trace.oracle.runtimeDocsSha256}`);
