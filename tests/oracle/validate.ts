#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { strict as assert } from 'node:assert';
import { artifactRoot, checkNoRuntimeOracleDependency, compareSnapshot, projectRoot, runOracleFixture, runUiOracleFixture, verifyOracleBundle } from './oracle-runner';
import { minimizeSequence, runHarnessSelfTests } from './self-test';
import type { OracleFixture, OracleSnapshot } from './types';

const selector = parseArgs(process.argv.slice(2));
if (selector.profile === 'xi' && selector.suite === 'multi-selection') {
  await checkNoRuntimeOracleDependency();
  const multiSelectionFixtures = [
    'tests/vim/multi/t076-atomic-command.test.ts',
    'tests/vim/multi/t077-compose.test.ts',
    'tests/vim/multi/t078-multi-insert.test.ts',
    'tests/vim/multi/t079-registers.test.ts',
    'tests/vim/multi/t080-repeat.test.ts',
    'tests/vim/multi/t081-selections.test.ts',
    'tests/vim/multi/t081-cli.test.ts',
  ] as const;
  for (const fixture of multiSelectionFixtures) {
    await import(resolve(projectRoot, fixture));
    console.log(`PASS ${fixture}`);
  }
  console.log(`vim multi-selection suite passed seed=${selector.seed ?? 'default'}`);
  process.exit(0);
}
if (selector.profile !== 'strict' || (selector.suite !== 'oracle' && selector.suite !== 'singleton-oracle')) {
  throw new Error(`vim-suite-unimplemented: profile=${selector.profile} suite=${selector.suite}; this runner currently owns only pinned singleton oracle fixtures`);
}

await checkNoRuntimeOracleDependency();
const harnessCases = await runHarnessSelfTests();
const oracle = await verifyOracleBundle(process.env.XI_NVIM);
await import('./t121-clipboard.test');
console.log('PASS tests/oracle/t121-clipboard.test.ts');
const fixtureDocument: unknown = JSON.parse(await readFile(resolve(projectRoot, 'tests/fixtures/vim/oracle-fixtures.json'), 'utf8'));
if (!isRecord(fixtureDocument) || fixtureDocument.schemaVersion !== 1 || !Array.isArray(fixtureDocument.fixtures)) {
  throw new Error('invalid-vim-oracle-fixture-catalog');
}
const fixtures = fixtureDocument.fixtures as OracleFixture[];
if (fixtures.length === 0) throw new Error('vim-oracle-fixture-catalog-empty');

const fixtureResults: Awaited<ReturnType<typeof runOracleFixture>>[] = [];
const fixtureById = new Map<string, OracleFixture>();
for (const fixture of fixtures) {
  fixtureById.set(fixture.id, fixture);
  const result = await runOracleFixture(fixture, oracle.binaryPath);
  if (result.snapshots.length !== fixture.steps.length) {
    throw new Error(`oracle-snapshot-count-mismatch: ${fixture.id} expected=${fixture.steps.length} observed=${result.snapshots.length}`);
  }
  for (let index = 0; index < fixture.steps.length; index += 1) {
    const step = fixture.steps[index];
    const snapshot = result.snapshots[index];
    if (step === undefined || snapshot === undefined) throw new Error(`oracle-step-missing: ${fixture.id}[${index}]`);
    if (step.expected === undefined || Object.keys(step.expected).length === 0) {
      throw new Error(`oracle-expectation-missing: ${fixture.id}/${step.label}`);
    }
    const differences = compareSnapshot(step.expected, snapshot);
    if (differences.length > 0) {
      throw new Error(`oracle-fixture-mismatch: ${fixture.id}/${step.label}\n${differences.join('\n')}`);
    }
  }
  fixtureResults.push(result);
  console.log(`PASS ${fixture.id} ${fixture.title}`);
}

const uiResults: Awaited<ReturnType<typeof runUiOracleFixture>>[] = [];
for (const fixtureId of ['ORC-INSERT-01', 'ORC-WRAP-01']) {
  const fixture = fixtureById.get(fixtureId);
  if (fixture === undefined) throw new Error(`pty-fixture-not-found: ${fixtureId}`);
  const result = await runUiOracleFixture(fixture, oracle.binaryPath);
  const inputStep = fixture.steps.find((step) => step.keys !== undefined && step.barrier !== false);
  if (inputStep?.expected === undefined) throw new Error(`pty-fixture-expectation-missing: ${fixtureId}`);
  const differences = compareSnapshot(inputStep.expected, result.snapshot);
  if (differences.length > 0) {
    throw new Error(`pty-oracle-fixture-mismatch: ${fixtureId}\n${differences.join('\n')}`);
  }
  const expectedColumns = fixture.options?.columns ?? 80;
  const expectedRows = fixture.options?.lines ?? 24;
  if (result.pty.columns !== expectedColumns || result.pty.rows !== expectedRows) {
    throw new Error(`pty-oracle-geometry-mismatch: ${fixtureId} expected=${expectedRows}x${expectedColumns} observed=${result.pty.rows}x${result.pty.columns}`);
  }
  if (!result.terminalRestored) throw new Error(`pty-oracle-terminal-not-restored: ${fixtureId}`);
  uiResults.push(result);
  console.log(`PASS ${fixtureId} real PTY ${result.pty.rows}x${result.pty.columns}; terminal restored`);
}

const rangeResult = resultFor('ORC-RANGE-01', fixtureResults);
const rangeSnapshot = onlySnapshot(rangeResult);
const rangeLine = rangeSnapshot.lines[0];
if (rangeLine !== 'two') throw new Error(`inclusive-range-baseline-unexpected: expected "two", observed ${JSON.stringify(rangeLine)}`);
const inclusiveMutation = { ...rangeSnapshot, lines: ['wo'] };
assertMismatch('ORC-MUTATION-RANGE-01', rangeSnapshot, inclusiveMutation, '$.lines[0]');

const byteResult = resultFor('ORC-BYTE-01', fixtureResults);
const byteSnapshot = onlySnapshot(byteResult);
if (byteSnapshot.cursor.byteColumn !== 3) {
  throw new Error(`byte-column-baseline-unexpected: expected 3, observed ${byteSnapshot.cursor.byteColumn}`);
}
const byteMutation = { ...byteSnapshot, cursor: { ...byteSnapshot.cursor, byteColumn: 2 } };
assertMismatch('ORC-MUTATION-BYTE-01', byteSnapshot, byteMutation, '$.cursor.byteColumn');

const rangeMinimization = await minimizeSequence(['d', 'w', 'x', 'j'], async (keys) => {
  const mutatedRangePersists = keys.includes('d') && keys.includes('w');
  if (!mutatedRangePersists) return false;
  const candidate = { ...rangeSnapshot, lines: ['wo'] };
  return compareSnapshot(rangeSnapshot as unknown as Record<string, unknown>, candidate).length > 0;
});
assert.deepEqual(rangeMinimization, ['d', 'w']);

await mkdir(artifactRoot, { recursive: true });
const resultPath = join(artifactRoot, 'fixture-results.json');
const evidenceRun = {
  oracle: {
    version: oracle.manifest.oracle.version,
    binarySha256: oracle.manifest.oracle.binarySha256,
    runtimeDocsSha256: oracle.manifest.oracle.runtimeDocs.sha256,
  },
  isolation: oracle.manifest.runtimeProfile,
  fixtures: fixtureResults,
  uiFixtures: uiResults,
  harnessCases,
  mutations: {
    inclusiveRange: { fixtureId: 'ORC-RANGE-01', expected: 'two', mutated: 'wo', rejected: true },
    utf8ByteColumn: { fixtureId: 'ORC-BYTE-01', expectedByteColumn: 3, mutatedByteColumn: 2, rejected: true },
  },
  minimizedMismatch: { sourceKeys: ['d', 'w', 'x', 'j'], minimizedKeys: rangeMinimization },
};
await writeFile(resultPath, `${JSON.stringify(evidenceRun, null, 2)}\n`, 'utf8');
console.log(`oracle=${oracle.manifest.oracle.name} ${oracle.manifest.oracle.version}`);
console.log(`binary_sha256=${oracle.manifest.oracle.binarySha256}`);
console.log(`runtime_docs_sha256=${oracle.manifest.oracle.runtimeDocs.sha256}`);
console.log(`fixtures=${fixtureResults.length} harness_cases=${harnessCases.length}`);
console.log(`inclusive_range_mutation=rejected at $.lines[0]`);
console.log(`utf8_byte_column_mutation=rejected at $.cursor.byteColumn`);
console.log(`minimized_keys=${rangeMinimization.join('')}`);
console.log(`runtime_oracle_dependency=absent`);
console.log(`results=${resultPath}`);

function parseArgs(args: readonly string[]): { profile: string; suite: string; seed?: number } {
  let profile = 'strict';
  let suite = 'oracle';
  let seed: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--profile') {
      const value = args[index + 1];
      if (value === undefined) throw new Error('--profile requires a value');
      profile = value;
      index += 1;
    } else if (arg === '--suite') {
      const value = args[index + 1];
      if (value === undefined) throw new Error('--suite requires a value');
      suite = value;
      index += 1;
    } else if (arg === '--seed') {
      const value = args[index + 1];
      if (value === undefined || !/^\d+$/u.test(value)) throw new Error('--seed requires a nonnegative integer');
      seed = Number(value);
      if (!Number.isSafeInteger(seed)) throw new Error('--seed is outside the safe integer range');
      index += 1;
    } else {
      throw new Error(`vim-selector-not-supported-yet: ${arg}`);
    }
  }
  return seed === undefined ? { profile, suite } : { profile, suite, seed };
}

function resultFor(
  id: string,
  results: readonly Awaited<ReturnType<typeof runOracleFixture>>[],
): Awaited<ReturnType<typeof runOracleFixture>> {
  const result = results.find((item) => item.fixtureId === id);
  if (result === undefined) throw new Error(`oracle-fixture-not-run: ${id}`);
  return result;
}

function onlySnapshot(result: Awaited<ReturnType<typeof runOracleFixture>>): OracleSnapshot {
  const snapshot = result.snapshots[0];
  if (snapshot === undefined) throw new Error(`oracle-fixture-no-snapshot: ${result.fixtureId}`);
  return snapshot;
}

function assertMismatch(id: string, expected: OracleSnapshot, actual: unknown, path: string): void {
  const differences = compareSnapshot(expected as unknown as Record<string, unknown>, actual);
  assert(differences.some((difference) => difference.startsWith(path)), `${id} did not detect mutation at ${path}`);
  console.log(`PASS ${id} detected ${path}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
