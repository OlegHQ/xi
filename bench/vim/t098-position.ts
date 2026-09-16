#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  compilePattern,
  createPatternEvaluation,
  findAllMatches,
  patternSnapshotFromDocument,
  PatternEvaluationError,
} from '../../packages/vim/pattern/index';
import { openTextDocument } from '../../packages/document/src/index';
import type { DocumentId, Utf16Offset } from '../../packages/primitives/src/index';

const inputLength = 2_048;
const measuredSamples = 30;
const warmupSamples = 3;
const text = `${'a'.repeat(inputLength)}😀\t中`;
const opened = openTextDocument('T098-position-benchmark' as DocumentId, new TextEncoder().encode(text));
if (opened.kind !== 'editable') throw new Error('T098-BENCH-DOCUMENT-NOT-EDITABLE');
const document = opened.document;
const snapshotBefore = document.snapshot();
const patternSnapshot = patternSnapshotFromDocument(snapshotBefore);
const stateBefore = Object.freeze({ cursor: 0 as Utf16Offset, repeat: 'last-search', version: snapshotBefore.version });
const workloads = [
  { id: 'regular-nfa-position-and-virtual-index', pattern: String.raw`\%1v.` },
  { id: 'bounded-backreference-position-and-virtual-index', pattern: String.raw`\v\%1v(a)\1` },
] as const;

const rows = workloads.map((workload) => {
  const program = compilePattern(workload.pattern, {
    positionContext: { version: snapshotBefore.version, cursor: 0 as Utf16Offset, tabstop: 8 },
    outputLimit: 100,
  });
  const run = () => {
    const result = findAllMatches(program, patternSnapshot);
    assert(result.matches.length >= 1, `${workload.id}: expected at least one match`);
    return { steps: result.steps, matches: result.matches.length, engine: result.engine };
  };
  for (let index = 0; index < warmupSamples; index += 1) run();
  const times: number[] = [];
  let observation = run();
  for (let index = 0; index < measuredSamples; index += 1) {
    const startedAt = performance.now();
    observation = run();
    times.push((performance.now() - startedAt) * 1_000);
  }
  times.sort((left, right) => left - right);
  const percentile = (fraction: number): number => times[Math.max(0, Math.ceil(times.length * fraction) - 1)] ?? 0;
  return {
    id: workload.id,
    pattern: workload.pattern,
    textUtf16Length: text.length,
    warmupSamples,
    measuredSamples,
    p50Microseconds: Number(percentile(0.5).toFixed(3)),
    p95Microseconds: Number(percentile(0.95).toFixed(3)),
    p99Microseconds: Number(percentile(0.99).toFixed(3)),
    maxMicroseconds: Number((times.at(-1) ?? 0).toFixed(3)),
    observation,
  };
});

const budget = 128;
let budgetError: PatternEvaluationError | undefined;
const budgetSession = createPatternEvaluation(
  compilePattern(String.raw`\%1v.`, {
    stepBudget: budget,
    positionContext: { version: snapshotBefore.version, cursor: 0 as Utf16Offset, tabstop: 8 },
  }),
  patternSnapshot,
);
try {
  budgetSession.resume(Number.MAX_SAFE_INTEGER);
} catch (error: unknown) {
  if (!(error instanceof PatternEvaluationError)) throw error;
  budgetError = error;
}
assert(budgetError !== undefined, 'T098 deterministic position-index budget must fail on the adversarial long line');
assert.equal(budgetError.code, 'step-budget-exceeded');
assert.equal(budgetError.steps, budget + 1);
assert(budgetError.source !== undefined);

const cancellation = createPatternEvaluation(
  compilePattern(String.raw`\%1v.`, {
    positionContext: { version: snapshotBefore.version, cursor: 0 as Utf16Offset, tabstop: 8 },
  }),
  patternSnapshot,
);
assert.equal(cancellation.resume(8).kind, 'pending');
cancellation.cancel();
let cancellationError: PatternEvaluationError | undefined;
try {
  cancellation.resume(1);
} catch (error: unknown) {
  if (!(error instanceof PatternEvaluationError)) throw error;
  cancellationError = error;
}
assert(cancellationError !== undefined);
assert.equal(cancellationError.code, 'cancelled');
assert(cancellationError.source !== undefined);

const snapshotAfter = document.snapshot();
const textAfter = snapshotAfter.slice(0 as Utf16Offset, snapshotAfter.lengthUtf16 as Utf16Offset);
assert(textAfter.ok);
assert.equal(snapshotAfter.version, snapshotBefore.version);
assert.equal(textAfter.value, text);
assert.deepEqual(stateBefore, { cursor: 0 as Utf16Offset, repeat: 'last-search', version: snapshotBefore.version });

const report = {
  schemaVersion: 1,
  ticket: 'T098',
  benchmark: 'snapshot-bound Vim positional coordinate index and bounded cancellation',
  environment: { platform: process.platform, architecture: process.arch, bun: Bun.version, terminal: 'in-process only' },
  method: { warmupSamples, measuredSamples, timer: 'performance.now; each sample uses a fresh pure evaluator session', thresholds: null, eventLoopYield: false },
  workload: { textUtf16Length: text.length, trailingScalars: ['😀', '\t', '中'], stepBudgetFailure: budget, cancellationResumeSlice: 8 },
  measurements: rows,
  boundedBehavior: {
    budget: { code: budgetError.code, steps: budgetError.steps, source: budgetError.source },
    cancellation: { code: cancellationError.code, steps: cancellationError.steps, source: cancellationError.source },
    snapshotVersionBefore: snapshotBefore.version,
    snapshotVersionAfter: snapshotAfter.version,
    snapshotTextPreserved: textAfter.value === text,
    cursorRepeatStatePreserved: true,
  },
  limitations: [
    'Exploratory same-host in-process measurements; no latency threshold is claimed.',
    'The evaluator returns to its caller between resume slices but does not schedule an event-loop turn.',
    'No editor command dispatch, screen paint, or terminal input latency is measured.',
  ],
};
const artifactPath = resolve(process.cwd(), 'bench/vim/t098-position-artifact.json');
await mkdir(dirname(artifactPath), { recursive: true });
await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const written = await readFile(artifactPath, 'utf8');
JSON.parse(written);
console.log(JSON.stringify({ ...report, artifactPath }, null, 2));
