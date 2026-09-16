#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture, OracleSnapshot } from '../../oracle/types';

interface FixtureCatalog {
  readonly schemaVersion: number;
  readonly fixtures: readonly OracleFixture[];
}

interface OracleTrace {
  readonly schemaVersion: 1;
  readonly oracle: {
    readonly version: string;
    readonly binarySha256: string;
    readonly runtimeDocsSha256: string;
  };
  readonly fixtureIds: readonly string[];
  readonly fixtures: readonly { readonly id: string; readonly snapshots: readonly OracleSnapshot[] }[];
  readonly note: string;
}

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const fixturePath = resolve(root, 'tests/vim/t021/t021-fixtures.json');
const tracePath = resolve(root, 'tests/vim/t021/t021-oracle-traces.json');
const catalog = JSON.parse(await readFile(fixturePath, 'utf8')) as FixtureCatalog;
assert.equal(catalog.schemaVersion, 1, 'T021-ORACLE-CATALOG-01 fixture schema is supported');

const oracle = await verifyOracleBundle();
const fixtures: { readonly id: string; readonly snapshots: readonly OracleSnapshot[] }[] = [];
for (const fixture of catalog.fixtures) {
  const result = await runOracleFixture(fixture, oracle.binaryPath);
  assert.equal(result.snapshots.length, fixture.steps.length,
    `T021-ORACLE-SNAPSHOT-01 ${fixture.id} has one snapshot per input barrier`);
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
  note: 'Pinned Neovim 0.12.4 Visual/Select state fixtures for T021 only; compatibility inventory remains owned by T061.',
};

if (process.argv.includes('--record')) {
  await writeFile(tracePath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
  console.log(`RECORDED ${fixtures.length} T021 fixtures to ${tracePath}`);
} else {
  const expected = JSON.parse(await readFile(tracePath, 'utf8')) as OracleTrace;
  assert.deepEqual(expected, trace, 'T021-ORACLE-TRACE-01 pinned snapshots match the fixture catalog');
  console.log(`T021 oracle passed ${fixtures.length} fixtures / ${fixtures.reduce((sum, fixture) => sum + fixture.snapshots.length, 0)} snapshots`);
}

console.log(`oracle=Neovim ${oracle.manifest.oracle.version}; binary=${oracle.manifest.oracle.binarySha256}`);
console.log(`runtime_docs=${oracle.manifest.oracle.runtimeDocs.sha256}`);
