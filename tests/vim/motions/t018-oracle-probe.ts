#!/usr/bin/env bun
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture } from '../../oracle/types';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const catalog = JSON.parse(await readFile(resolve(root, 'tests/vim/motions/t018-find-cases.json'), 'utf8')) as {
  readonly schemaVersion: number;
  readonly fixtures: readonly OracleFixture[];
};
if (catalog.schemaVersion !== 1) throw new Error('T018-ORACLE-CATALOG-01 unsupported fixture catalog');
const oracle = await verifyOracleBundle();
const oracleTraces: Array<Record<string, unknown>> = [];
for (const fixture of catalog.fixtures) {
  const result = await runOracleFixture(fixture, oracle.binaryPath);
  oracleTraces.push({
    id: fixture.id,
    title: fixture.title,
    purpose: fixture.purpose,
    input: fixture.steps,
    ...(fixture.mappings === undefined ? {} : { mappings: fixture.mappings }),
    snapshots: result.snapshots.map((snapshot) => ({
      label: snapshot.label,
      lines: snapshot.lines,
      cursor: snapshot.cursor,
      mode: snapshot.mode,
      error: snapshot.error,
      nonemptyRegisters: Object.fromEntries(Object.entries(snapshot.registers)
        .filter(([, value]) => isRecord(value) && Array.isArray(value.lines) && value.lines.length > 0)),
      visualStart: snapshot.marks['<'],
      visualEnd: snapshot.marks['>'],
      search: snapshot.search,
    })),
  });
}
const rawSupplementaryRepro: OracleFixture = {
  id: 'T018-HARNESS-RAW-SUPPLEMENTARY-REPRO-01',
  title: 'Oracle helper preserves raw supplementary input regression',
  purpose: 'Verify raw f😀 survives recognized terminal-key expansion without changing text or registers.',
  modes: ['normal'],
  lines: ['a😀b😀c'],
  cursor: { line: 1, byteColumn0: 0 },
  steps: [
    { label: 'before-raw-step', drain: true },
    { label: 'raw-step-f-emoji', keys: 'f😀' },
  ],
};
const rawReproResult = await runOracleFixture(rawSupplementaryRepro, oracle.binaryPath);
const initialStep = rawReproResult.snapshots[0];
const rawStep = rawReproResult.snapshots[1];
if (initialStep === undefined) throw new Error('T018-HARNESS-RAW-SUPPLEMENTARY-REPRO-01 missing baseline snapshot');
if (rawStep === undefined) throw new Error('T018-HARNESS-RAW-SUPPLEMENTARY-REPRO-01 missing reproduction snapshot');
if (JSON.stringify(rawStep.lines) !== JSON.stringify(rawSupplementaryRepro.lines)
  || rawStep.cursor.byteColumn !== 2
  || JSON.stringify(rawStep.registers) !== JSON.stringify(initialStep.registers)) {
  throw new Error(`T018-HARNESS-RAW-SUPPLEMENTARY-REPRO-01 mismatch: ${JSON.stringify({
    lines: rawStep.lines,
    cursor: rawStep.cursor,
    registers: rawStep.registers,
  })}`);
}
const compatibility = {
  schemaVersion: 1,
  ticket: 'T018',
  oracle: {
    name: oracle.manifest.oracle.name,
    version: oracle.manifest.oracle.version,
    binarySha256: oracle.manifest.oracle.binarySha256,
    runtimeDocsSha256: oracle.manifest.oracle.runtimeDocs.sha256,
    profile: oracle.manifest.runtimeProfile,
  },
  fixtures: oracleTraces,
  harnessRegression: {
    id: rawSupplementaryRepro.id,
    inputMethod: 'oracle-runner raw step with keys="f😀"',
    initialLines: rawSupplementaryRepro.lines,
    observed: {
      lines: rawStep.lines,
      cursor: rawStep.cursor,
      mode: rawStep.mode,
      registers: Object.fromEntries(Object.entries(rawStep.registers)
        .filter(([name, value]) => (name === '"' || name === '-') && isRecord(value)
          && Array.isArray(value.lines) && value.lines.length > 0)),
    },
    resolution: 'T099 fixed terminal-token expansion so literal UTF-8 is preserved; the raw helper case now matches the first emoji without changing text or registers.',
  },
};
const compatibilityPath = resolve(root, 'docs/compatibility/t018-find-till.json');
await writeFile(compatibilityPath, `${JSON.stringify(sortJsonKeys(compatibility), null, 2)}\n`);
console.log(`wrote ${compatibilityPath}`);
console.log(`oracle=Neovim ${oracle.manifest.oracle.version}; binary=${oracle.manifest.oracle.binarySha256}; runtimeDocs=${oracle.manifest.oracle.runtimeDocs.sha256}`);

/** Canonicalize RPC snapshot objects whose property enumeration order is not stable. */
function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return Object.fromEntries(keys.map((key) => [key, sortJsonKeys(record[key])]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
