#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';
import { openTextDocument, type DocumentId } from '../../packages/document/src/index';
import type { DocumentVersion, Utf16Offset } from '../../packages/primitives/src/index';
import {
  compilePattern,
  createPatternEvaluation,
  findAllMatches,
  PatternEvaluationError,
  patternSnapshotFromDocument,
} from '../../packages/vim/pattern/index';

const warmupSamples = 3;
const measuredSamples = 25;
const text = 'x'.repeat(256);
const opened = openTextDocument('T026-integrated-classes-bench' as DocumentId, new TextEncoder().encode(text));
assert.equal(opened.kind, 'editable');
if (opened.kind !== 'editable') throw new Error('T026-BENCH-DOCUMENT-NOT-EDITABLE');
const document = opened.document;
const snapshotBefore = document.snapshot();
const patternSnapshot = patternSnapshotFromDocument(snapshotBefore);
const callerState = { cursor: 7 as Utf16Offset, repeat: 'last-search', version: snapshotBefore.version };
const callerStateBefore = { ...callerState };
const optionRules = Array.from({ length: 64 }, (_, index) => String(index)).join(',');
const characterClassContext = { version: snapshotBefore.version, isIdent: optionRules };
const stepBudget = 20_000;
const program = compilePattern(String.raw`\i`, { characterClassContext, stepBudget });

const run = () => {
  const result = findAllMatches(program, patternSnapshot);
  assert.equal(result.engine, 'nfa');
  assert.equal(result.matches.length, 0);
  return { steps: result.steps, matches: result.matches.length, engine: result.engine };
};
for (let index = 0; index < warmupSamples; index += 1) run();
const durations: number[] = [];
let observation = run();
for (let index = 0; index < measuredSamples; index += 1) {
  const startedAt = performance.now();
  observation = run();
  durations.push((performance.now() - startedAt) * 1_000);
}
durations.sort((left, right) => left - right);
const percentile = (fraction: number): number => durations[Math.max(0, Math.ceil(durations.length * fraction) - 1)] ?? 0;

const resumeSliceWorkUnits = 64;
const resumable = createPatternEvaluation(program, patternSnapshot);
let progress = resumable.resume(resumeSliceWorkUnits);
let slices = 1;
while (progress.kind === 'pending') {
  progress = resumable.resume(resumeSliceWorkUnits);
  slices += 1;
}
assert.equal(progress.result.steps, observation.steps);

const budget = 1_024;
let budgetFailure: PatternEvaluationError | undefined;
try {
  findAllMatches(compilePattern(String.raw`\i`, {
    characterClassContext,
    stepBudget: budget,
  }), patternSnapshot);
} catch (error: unknown) {
  if (!(error instanceof PatternEvaluationError)) throw error;
  budgetFailure = error;
}
assert(budgetFailure !== undefined, 'option-heavy class workload must exercise its deterministic step bound');
assert.equal(budgetFailure.code, 'step-budget-exceeded');
assert.equal(budgetFailure.steps, budget + 1);
assert.deepEqual(budgetFailure.source, { start: 0, end: 2 });

const cancelSession = createPatternEvaluation(program, patternSnapshot);
assert.equal(cancelSession.resume(resumeSliceWorkUnits).kind, 'pending');
cancelSession.cancel();
let cancellationFailure: PatternEvaluationError | undefined;
try {
  cancelSession.resume(1);
} catch (error: unknown) {
  if (!(error instanceof PatternEvaluationError)) throw error;
  cancellationFailure = error;
}
assert(cancellationFailure !== undefined);
assert.equal(cancellationFailure.code, 'cancelled');
assert.deepEqual(cancellationFailure.source, { start: 0, end: 2 });

let staleFailure: PatternEvaluationError | undefined;
try {
  createPatternEvaluation(compilePattern(String.raw`\i`, {
    characterClassContext: { version: (snapshotBefore.version - 1) as DocumentVersion, isIdent: optionRules },
  }), patternSnapshot);
} catch (error: unknown) {
  if (!(error instanceof PatternEvaluationError)) throw error;
  staleFailure = error;
}
assert(staleFailure !== undefined);
assert.equal(staleFailure.code, 'stale-position');
assert.deepEqual(staleFailure.source, { start: 0, end: 2 });

const snapshotAfter = document.snapshot();
const textAfter = snapshotAfter.slice(0 as Utf16Offset, snapshotAfter.lengthUtf16 as Utf16Offset);
assert(textAfter.ok);
assert.equal(snapshotAfter.version, snapshotBefore.version);
assert.equal(textAfter.value, text);
assert.deepEqual(callerState, callerStateBefore);

const artifact = {
  schemaVersion: 1,
  ticket: 'T026',
  benchmark: 'bounded NFA evaluation with option-driven isident rules',
  environment: { platform: process.platform, architecture: process.arch, bun: process.versions.bun ?? 'unknown', terminal: 'in-process evaluator only' },
  method: {
    warmupSamples,
    measuredSamples,
    timer: 'performance.now; fresh evaluator per sample',
    thresholds: null,
    eventLoopYield: false,
  },
  workload: {
    textUtf16Units: text.length,
    pattern: program.source,
    optionRuleCount: 64,
    optionContextVersion: snapshotBefore.version,
    engine: 'ordered Thompson NFA',
    stepBudget,
    resumeSliceWorkUnits,
  },
  measurements: {
    p50Microseconds: Number(percentile(0.5).toFixed(3)),
    p95Microseconds: Number(percentile(0.95).toFixed(3)),
    p99Microseconds: Number(percentile(0.99).toFixed(3)),
    maxMicroseconds: Number((durations.at(-1) ?? 0).toFixed(3)),
    observation,
    resumableSlices: slices,
    budgetFailure: { code: budgetFailure.code, steps: budgetFailure.steps, source: budgetFailure.source },
    cancellation: { code: cancellationFailure.code, source: cancellationFailure.source },
    staleContext: { code: staleFailure.code, source: staleFailure.source },
    snapshotVersionPreserved: snapshotAfter.version === snapshotBefore.version,
    snapshotTextPreserved: textAfter.value === text,
    callerCursorRepeatStatePreserved: true,
  },
  limitations: [
    'This exploratory same-host in-process measurement has no latency threshold and is not a representative text corpus.',
    'Resume slices return to the caller but do not themselves schedule an event-loop turn.',
    'No editor command dispatch, cursor/repeat integration, terminal input or rendering latency is measured.',
  ],
};
const artifactPath = resolve(process.cwd(), '.artifacts/bench/vim/t026-integrated-classes.json');
await mkdir(dirname(artifactPath), { recursive: true });
await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...artifact, artifactPath }, null, 2));
