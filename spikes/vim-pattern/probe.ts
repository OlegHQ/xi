#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { artifactRoot, projectRoot, runOracleFixture, verifyOracleBundle } from '../../tests/oracle/oracle-runner';
import type { OracleFixture } from '../../tests/oracle/types';
import { compilePattern } from './parser';
import { evaluateWithStats, findAllMatches, PatternEvaluationError, substituteAll } from './index';

const fixturePath = resolve(projectRoot, 'tests/fixtures/vim/T005-pattern-cases.json');
const fixtureDocument: unknown = JSON.parse(await readFile(fixturePath, 'utf8'));
const fixtures = readFixtureDocument(fixtureDocument);
const { binaryPath, manifest } = await verifyOracleBundle(process.env.XI_NVIM);
const cases = [];
for (const fixture of fixtures.cases) {
  const oracleFixture = asOracleFixture(fixture);
  const oracleResult = await runOracleFixture(oracleFixture, binaryPath);
  const snapshot = oracleResult.snapshots[0];
  if (snapshot === undefined) throw new Error(`pattern-oracle-no-snapshot: ${fixture.id}`);
  assert.deepEqual(snapshot.lines, fixture.expectedLines, `pinned oracle result changed for ${fixture.id}`);
  const cursorOffset = fixture.cursor === undefined
    ? undefined
    : fixture.lines.slice(0, fixture.cursor.line - 1).reduce((offset, line) => offset + line.length + 1, 0)
      + utf8ByteColumnToUtf16Offset(fixture.lines[fixture.cursor.line - 1] ?? '', fixture.cursor.byteColumn0);
  const program = compilePattern(fixture.pattern, cursorOffset === undefined ? {} : { cursorOffset });
  const candidate = substituteAll(program, fixture.lines.join('\n'), fixture.replacement);
  const candidateLines = candidate.text.split('\n');
  assert.deepEqual(candidateLines, snapshot.lines, `owned pattern engine differs from oracle for ${fixture.id}`);
  cases.push({ id: fixture.id, expectedLines: snapshot.lines, candidateLines, matches: candidate.matches.length, evaluationSteps: candidate.steps });
  console.log(`PASS ${fixture.id} matches=${candidate.matches.length} steps=${candidate.steps}`);
}

const safety = runSafetyFixtures(fixtures.safetyFixtures);
for (const result of safety) console.log(`PASS ${result.id} code=${result.code} steps=${result.steps}`);
const cancellation = measureCancellation();
console.log(`PASS PATT-CANCEL-01 checks=${cancellation.cancellationChecks} steps=${cancellation.steps} samples=${cancellation.samples} duration_us_p50=${cancellation.durationMicroseconds.p50.toFixed(3)} p95=${cancellation.durationMicroseconds.p95.toFixed(3)} max=${cancellation.durationMicroseconds.maximum.toFixed(3)}`);
assertOwnedEngineHasNoNativeRegex();

const output = {
  schemaVersion: 1,
  ticket: 'T005',
  oracle: {
    version: manifest.oracle.version,
    binarySha256: manifest.oracle.binarySha256,
    runtimeDocsSha256: manifest.oracle.runtimeDocs.sha256,
  },
  cases,
  safety,
  cancellation,
  runtimePath: 'owned parser and bounded evaluator; no JavaScript RegExp translation',
};
const outputDirectory = join(artifactRoot, '..', 'patterns');
await mkdir(outputDirectory, { recursive: true });
const resultPath = join(outputDirectory, 'T005-results.json');
await writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`oracle=Neovim ${manifest.oracle.version}`);
console.log(`binary_sha256=${manifest.oracle.binarySha256}`);
console.log(`runtime_docs_sha256=${manifest.oracle.runtimeDocs.sha256}`);
console.log(`pattern_fixtures=${cases.length} safety_fixtures=${safety.length}`);
console.log(`runtime_oracle_dependency=absent`);
console.log(`results=${resultPath}`);

interface PatternFixtureCase {
  readonly id: string;
  readonly title: string;
  readonly lines: readonly string[];
  readonly pattern: string;
  readonly replacement: string;
  readonly cursor?: { readonly line: number; readonly byteColumn0: number };
  readonly expectedLines: readonly string[];
}

interface SafetyFixture {
  readonly id: string;
  readonly title: string;
  readonly pattern: string;
  readonly textPrefix?: string;
  readonly textLength?: number;
  readonly suffix?: string;
  readonly stepBudget?: number;
  readonly expectedCode?: string;
  readonly lines?: readonly string[];
  readonly maximumMatches?: number;
  readonly expectedOffsets?: readonly number[];
}

interface PatternFixtures {
  readonly cases: readonly PatternFixtureCase[];
  readonly safetyFixtures: readonly SafetyFixture[];
}

function readFixtureDocument(value: unknown): PatternFixtures {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.oracle) || value.oracle.name !== 'Neovim' || value.oracle.version !== '0.12.4') {
    throw new Error('invalid-t005-pattern-fixture-envelope');
  }
  if (!Array.isArray(value.cases) || !Array.isArray(value.safetyFixtures) || value.cases.length === 0 || value.safetyFixtures.length === 0) {
    throw new Error('invalid-t005-pattern-fixture-lists');
  }
  return {
    cases: value.cases.map(readPatternCase),
    safetyFixtures: value.safetyFixtures.map(readSafetyFixture),
  };
}

function readPatternCase(value: unknown): PatternFixtureCase {
  if (!isRecord(value)) throw new Error('invalid-t005-pattern-case');
  const lines = requiredStringArray(value, 'lines');
  const cursor = optionalCursor(value, 'cursor');
  if (cursor !== undefined) {
    const line = lines[cursor.line - 1];
    if (line === undefined || cursor.byteColumn0 > Buffer.byteLength(line, 'utf8')) throw new Error('invalid-fixture-cursor');
    utf8ByteColumnToUtf16Offset(line, cursor.byteColumn0);
  }
  return {
    id: requiredString(value, 'id'),
    title: requiredString(value, 'title'),
    lines,
    pattern: requiredString(value, 'pattern'),
    replacement: requiredString(value, 'replacement'),
    ...(cursor === undefined ? {} : { cursor }),
    expectedLines: requiredStringArray(value, 'expectedLines'),
  };
}

function readSafetyFixture(value: unknown): SafetyFixture {
  if (!isRecord(value)) throw new Error('invalid-t005-safety-fixture');
  const textPrefix = optionalString(value, 'textPrefix');
  const textLength = optionalNumber(value, 'textLength');
  const suffix = optionalString(value, 'suffix');
  const stepBudget = optionalNumber(value, 'stepBudget');
  const expectedCode = optionalString(value, 'expectedCode');
  const lines = optionalStringArray(value, 'lines');
  const maximumMatches = optionalNumber(value, 'maximumMatches');
  const expectedOffsets = optionalNumberArray(value, 'expectedOffsets');
  const result: SafetyFixture = {
    id: requiredString(value, 'id'),
    title: requiredString(value, 'title'),
    pattern: requiredString(value, 'pattern'),
    ...(textPrefix === undefined ? {} : { textPrefix }),
    ...(textLength === undefined ? {} : { textLength }),
    ...(suffix === undefined ? {} : { suffix }),
    ...(stepBudget === undefined ? {} : { stepBudget }),
    ...(expectedCode === undefined ? {} : { expectedCode }),
    ...(lines === undefined ? {} : { lines }),
    ...(maximumMatches === undefined ? {} : { maximumMatches }),
    ...(expectedOffsets === undefined ? {} : { expectedOffsets }),
  };
  return result;
}

function asOracleFixture(fixture: PatternFixtureCase): OracleFixture {
  if (fixture.pattern.includes('/') || fixture.replacement.includes('/')) throw new Error(`oracle-pattern-fixture-delimiter-not-supported: ${fixture.id}`);
  return {
    id: fixture.id,
    title: fixture.title,
    purpose: 'Pinned Neovim 0.12.4 `:substitute` result for the Xi-owned Vim pattern prototype.',
    modes: ['normal'],
    lines: fixture.lines,
    ...(fixture.cursor === undefined ? {} : { cursor: fixture.cursor }),
    steps: [{ label: fixture.title, keys: `:%s/${fixture.pattern}/${fixture.replacement}/g<CR>` }],
  };
}

function runSafetyFixtures(fixturesToRun: readonly SafetyFixture[]): readonly Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  for (const fixture of fixturesToRun) {
    if (fixture.expectedCode === 'step-budget-exceeded') {
      const source = `${fixture.textPrefix?.repeat(fixture.textLength ?? 0) ?? ''}${fixture.suffix ?? ''}`;
      const program = compilePattern(fixture.pattern, fixture.stepBudget === undefined ? {} : { stepBudget: fixture.stepBudget });
      let caught: unknown;
      const started = process.hrtime.bigint();
      try {
        findAllMatches(program, source);
      } catch (error) {
        caught = error;
      }
      const elapsedMicroseconds = Number(process.hrtime.bigint() - started) / 1000;
      assert(caught instanceof PatternEvaluationError, `${fixture.id} did not fail through the bounded evaluator`);
      assert.equal(caught.code, fixture.expectedCode);
      assert(caught.steps <= (fixture.stepBudget ?? 0) + 1);
      results.push({ id: fixture.id, title: fixture.title, code: caught.code, steps: caught.steps, durationMicroseconds: elapsedMicroseconds });
      continue;
    }
    if (fixture.expectedCode === 'unsupported-construct') {
      let caught: unknown;
      try {
        compilePattern(fixture.pattern);
      } catch (error) {
        caught = error;
      }
      assert(caught instanceof PatternEvaluationError, `${fixture.id} was not rejected through the typed pattern error`);
      assert.equal(caught.code, fixture.expectedCode);
      assert(caught.source !== undefined, `${fixture.id} did not retain a source span`);
      results.push({ id: fixture.id, title: fixture.title, code: caught.code, steps: caught.steps, source: caught.source });
      continue;
    }
    if (fixture.expectedOffsets !== undefined) {
      const lines = fixture.lines;
      if (lines === undefined) throw new Error(`zero-width-fixture-without-lines: ${fixture.id}`);
      const program = compilePattern(fixture.pattern, fixture.maximumMatches === undefined ? {} : { outputLimit: fixture.maximumMatches });
      const matches = findAllMatches(program, lines.join('\n'));
      assert.deepEqual(matches.map((match) => match.start), fixture.expectedOffsets);
      assert(matches.length < (fixture.maximumMatches ?? Number.MAX_SAFE_INTEGER));
      results.push({ id: fixture.id, title: fixture.title, code: 'completed', steps: evaluateWithStats(program, lines.join('\n')).steps, offsets: matches.map((match) => match.start) });
      continue;
    }
    throw new Error(`unsupported-safety-fixture: ${fixture.id}`);
  }
  return results;
}

function measureCancellation(): {
  readonly code: string;
  readonly steps: number;
  readonly cancellationChecks: number;
  readonly samples: number;
  readonly durationMicroseconds: { readonly p50: number; readonly p95: number; readonly maximum: number };
} {
  let cancellationChecks = 0;
  const program = compilePattern(String.raw`\v(a+)+b`, {
    stepBudget: 100_000,
    cancellationCheckInterval: 64,
    shouldCancel: () => {
      cancellationChecks += 1;
      return cancellationChecks >= 8;
    },
  });
  const durations: number[] = [];
  for (let sample = 0; sample < 31; sample += 1) {
    cancellationChecks = 0;
    let caught: unknown;
    const started = process.hrtime.bigint();
    try {
      findAllMatches(program, 'a'.repeat(64));
    } catch (error) {
      caught = error;
    }
    durations.push(Number(process.hrtime.bigint() - started) / 1000);
    assert(caught instanceof PatternEvaluationError);
    assert.equal(caught.code, 'cancelled');
    assert.equal(caught.steps, 512);
  }
  durations.sort((left, right) => left - right);
  const percentile = (p: number): number => durations[Math.min(durations.length - 1, Math.ceil(durations.length * p) - 1)] ?? 0;
  return {
    code: 'cancelled',
    steps: 512,
    cancellationChecks: 8,
    samples: durations.length,
    durationMicroseconds: { p50: percentile(0.5), p95: percentile(0.95), maximum: durations[durations.length - 1] ?? 0 },
  };
}

function assertOwnedEngineHasNoNativeRegex(): void {
  const result = spawnSync('rg', ['-n', 'new RegExp|RegExp\\(|\\.replace\\(', 'spikes/vim-pattern/parser.ts', 'spikes/vim-pattern/evaluator.ts', 'spikes/vim-pattern/index.ts'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (result.status === 0) throw new Error(`native-regex-or-replacement-used-in-vim-pattern-engine: ${result.stdout}`);
  if (result.status !== 1) throw new Error(`pattern-engine-native-regex-scan-failed: ${result.stderr}`);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`invalid-fixture-string: ${key}`);
  return value;
}

function requiredStringArray(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`invalid-fixture-string-array: ${key}`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`invalid-fixture-string: ${key}`);
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`invalid-fixture-number: ${key}`);
  return value;
}

function optionalCursor(record: Record<string, unknown>, key: string): { readonly line: number; readonly byteColumn0: number } | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`invalid-fixture-cursor: ${key}`);
  const line = value.line;
  const byteColumn0 = value.byteColumn0;
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1) throw new Error(`invalid-fixture-cursor-line: ${key}`);
  if (typeof byteColumn0 !== 'number' || !Number.isSafeInteger(byteColumn0) || byteColumn0 < 0) throw new Error(`invalid-fixture-cursor-column: ${key}`);
  return { line, byteColumn0 };
}

function utf8ByteColumnToUtf16Offset(line: string, byteColumn0: number): number {
  if (byteColumn0 > Buffer.byteLength(line, 'utf8')) throw new Error('invalid-fixture-cursor-byte-column');
  let bytes = 0;
  let utf16 = 0;
  while (bytes < byteColumn0) {
    const codePoint = line.codePointAt(utf16);
    if (codePoint === undefined) throw new Error('invalid-fixture-cursor-byte-column');
    const value = String.fromCodePoint(codePoint);
    const width = Buffer.byteLength(value, 'utf8');
    if (bytes + width > byteColumn0) throw new Error('fixture-cursor-not-on-utf8-boundary');
    bytes += width;
    utf16 += value.length;
  }
  return utf16;
}

function optionalStringArray(record: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`invalid-fixture-string-array: ${key}`);
  return value;
}

function optionalNumberArray(record: Record<string, unknown>, key: string): readonly number[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) throw new Error(`invalid-fixture-number-array: ${key}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
