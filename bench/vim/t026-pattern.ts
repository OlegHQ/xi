#!/usr/bin/env bun
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  compilePattern,
  createPatternEvaluation,
  createPatternTextSnapshot,
  findAllMatches,
  patternSnapshotFromDocument,
  PatternEvaluationError,
} from '../../packages/vim/pattern/index';
import { openTextDocument } from '../../packages/document/src/index';
import type { DocumentId, DocumentVersion } from '../../packages/document/src/index';

const version = 26 as DocumentVersion;
const warmupSamples = 5;
const measuredSamples = 50;
const resumablePattern = compilePattern(String.raw`\v(a|ab)+z`);
const resumableSnapshot = createPatternTextSnapshot(version, `${'ab'.repeat(500)}z`);
const backtrackingPattern = compilePattern(String.raw`\v((a|aa)+)\1b`, { stepBudget: 50_000 });
const backtrackingSnapshot = createPatternTextSnapshot(version, 'a'.repeat(64));
const linePositionPattern = compilePattern(String.raw`\%400lneedle`);
const linePositionContent = `${'line\n'.repeat(399)}needle\ntail`;
const linePositionText = createPatternTextSnapshot(version, linePositionContent);
const openedLinePosition = openTextDocument('T026-line-position' as DocumentId, new TextEncoder().encode(linePositionContent));
if (openedLinePosition.kind !== 'editable') throw new Error('T026-BENCH-LINE-POSITION-DOCUMENT');
const indexedLinePositionText = patternSnapshotFromDocument(openedLinePosition.document.snapshot());

const workloads = {
  regularNfaRunner: measure(() => {
    const result = findAllMatches(resumablePattern, resumableSnapshot);
    if (result.matches.length !== 1 || result.matches[0]?.start !== 0) throw new Error('T026-BENCH-REGULAR-SHAPED-RESULT');
    if (result.engine !== 'nfa') throw new Error('T096-BENCH-REGULAR-PATTERN-DID-NOT-USE-NFA');
    return result.steps;
  }),
  resumableSlicesOf128WorkUnits: measure(() => {
    const session = createPatternEvaluation(resumablePattern, resumableSnapshot);
    let progress = session.resume(128);
    let slices = 1;
    while (progress.kind === 'pending') {
      progress = session.resume(128);
      slices += 1;
    }
    if (progress.result.matches.length !== 1 || progress.result.engine !== 'nfa') throw new Error('T096-BENCH-RESUME-RESULT');
    return { steps: progress.result.steps, slices };
  }),
  boundedNonRegularFallbackBudgetFailure: measure(() => {
    let observed: unknown;
    try {
      findAllMatches(backtrackingPattern, backtrackingSnapshot);
    } catch (error: unknown) {
      observed = error;
    }
    if (!(observed instanceof PatternEvaluationError) || observed.code !== 'step-budget-exceeded') {
      throw new Error('T096-BENCH-BACKTRACKING-DID-NOT-STOP-AT-BUDGET');
    }
    return { code: observed.code, steps: observed.steps };
  }),
  plainSnapshotLineNumberWithCooperativeIndexBuild: measure(() => {
    const result = findAllMatches(linePositionPattern, linePositionText);
    if (result.matches.length !== 1 || result.matches[0]?.start !== 1995) throw new Error('T026-BENCH-LINE-POSITION-RESULT');
    return result.steps;
  }),
  documentSnapshotLineNumberViaIndexedLookup: measure(() => {
    const result = findAllMatches(linePositionPattern, indexedLinePositionText);
    if (result.matches.length !== 1 || result.matches[0]?.start !== 1995) throw new Error('T026-BENCH-INDEXED-LINE-POSITION-RESULT');
    return result.steps;
  }),
};

const report = {
  schemaVersion: 1,
  ticket: 'T096',
  fixture: 'T096-NFA-WORK-COST-01',
  environment: {
    platform: process.platform,
    architecture: process.arch,
    bun: process.versions.bun ?? 'unknown',
    terminal: 'not applicable; in-process evaluator only',
  },
  method: {
    warmupSamples,
    measuredSamples,
    timer: 'performance.now; each sample creates a fresh pure evaluator session',
    thresholds: null,
  },
  workload: {
    regularShapedTextUtf16Units: resumableSnapshot.text.length,
    regularShapedPattern: resumablePattern.source,
    regularPathStatus: 'ordered Thompson NFA; no JavaScript RegExp path',
    backtrackingFailureTextUtf16Units: backtrackingSnapshot.text.length,
    backtrackingStepBudget: backtrackingPattern.stepBudget,
    linePositionTextUtf16Units: linePositionText.text.length,
    linePositionDocumentSnapshotVersion: indexedLinePositionText.version,
    resumableSliceWorkUnits: 128,
    eventLoopYield: false,
  },
  measurements: workloads,
  limitations: [
    'No target thresholds are applied; these are exploratory same-host samples.',
    'The regular evaluator is a Thompson NFA; backreferences/lookaround use the separately budgeted AST fallback.',
    'An ordered simultaneous-start Thompson scan deduplicates each program counter in favor of the earliest-priority thread, bounding one regular search attempt by input scalars times NFA program size; no target latency threshold is claimed.',
    'Resume slices yield control to the caller but do not themselves schedule an event-loop turn.',
    'No integrated editor input, cursor, repeat-state or terminal-paint latency is measured.',
  ],
};
const artifact = resolve(process.cwd(), '.artifacts/patterns/T096-nfa-benchmark.json');
await mkdir(dirname(artifact), { recursive: true });
await writeFile(artifact, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
console.log(`artifact=${artifact}`);

function measure(operation: () => number | { readonly steps: number; readonly slices?: number } | { readonly code: string; readonly steps: number }): {
  readonly p50Microseconds: number;
  readonly p95Microseconds: number;
  readonly p99Microseconds: number;
  readonly maxMicroseconds: number;
  readonly observed: number | { readonly steps: number; readonly slices?: number } | { readonly code: string; readonly steps: number };
} {
  let observed: number | { readonly steps: number; readonly slices?: number } | { readonly code: string; readonly steps: number } = 0;
  for (let sample = 0; sample < warmupSamples; sample += 1) observed = operation();
  const durations: number[] = [];
  for (let sample = 0; sample < measuredSamples; sample += 1) {
    const start = performance.now();
    observed = operation();
    durations.push((performance.now() - start) * 1_000);
  }
  durations.sort((left, right) => left - right);
  const percentile = (fraction: number): number => durations[Math.max(0, Math.ceil(durations.length * fraction) - 1)] ?? 0;
  return {
    p50Microseconds: percentile(0.5),
    p95Microseconds: percentile(0.95),
    p99Microseconds: percentile(0.99),
    maxMicroseconds: durations[durations.length - 1] ?? 0,
    observed,
  };
}
