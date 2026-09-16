import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import {
  compilePattern,
  findAllMatches,
  PatternEvaluationError,
} from '../../packages/vim/pattern/index';
import type { DocumentVersion } from '../../packages/primitives/src/index';

const version = 100 as DocumentVersion;
const longCluster = `a${'\u0301'.repeat(20_000)}`;
const successfulPattern = compilePattern('.', { stepBudget: 30_000 });
const successfulStarted = performance.now();
const successful = findAllMatches(successfulPattern, { version, text: longCluster });
const successfulElapsedMs = performance.now() - successfulStarted;
assert.equal(successful.engine, 'nfa');
assert.deepEqual(successful.matches.map((match) => [match.start as number, match.end as number]), [[0, longCluster.length]]);
assert(successful.steps > 20_000, 'cluster scan charges work for each composing mark');

const adversarialText = `a${'\u0301'.repeat(5_000)}`;
const adversarialPattern = compilePattern('.', { stepBudget: 1_024 });
const failures = [0, 1].map(() => {
  const started = performance.now();
  let failure: unknown;
  try {
    findAllMatches(adversarialPattern, { version, text: adversarialText });
  } catch (error: unknown) {
    failure = error;
  }
  const elapsedMs = performance.now() - started;
  assert(failure instanceof PatternEvaluationError);
  assert.equal(failure.code, 'step-budget-exceeded');
  assert.equal(failure.steps, 1_025);
  assert.deepEqual(failure.source, { start: 0, end: 1 });
  return { steps: failure.steps, source: failure.source, elapsedMs: Number(elapsedMs.toFixed(3)) };
});
assert.deepEqual(failures[0]?.steps, failures[1]?.steps);
assert.deepEqual(failures[0]?.source, failures[1]?.source);

const artifact = {
  ticket: 'T100',
  benchmark: 'bounded Vim composing-cluster scanning',
  environment: { bun: process.versions.bun ?? 'unknown', platform: process.platform, architecture: process.arch },
  workloads: [
    {
      id: 'regular-dot-long-composing-cluster',
      textUtf16Units: longCluster.length,
      pattern: successfulPattern.source,
      stepBudget: successfulPattern.stepBudget,
      engine: successful.engine,
      steps: successful.steps,
      matches: successful.matches.length,
      elapsedMs: Number(successfulElapsedMs.toFixed(3)),
    },
    {
      id: 'regular-dot-adversarial-composing-budget',
      textUtf16Units: adversarialText.length,
      pattern: adversarialPattern.source,
      stepBudget: adversarialPattern.stepBudget,
      repeatedFailures: failures,
    },
  ],
  limitations: [
    'This microbenchmark measures the in-process evaluator only, not editor scheduling or rendering latency.',
    'The long cluster is a stress workload, not a representative natural-language corpus.',
    'No target latency threshold is claimed; deterministic work-bound behavior is asserted.',
  ],
};
const artifactPath = resolve(process.cwd(), '.artifacts/bench/vim/t100-composing.json');
await mkdir(resolve(artifactPath, '..'), { recursive: true });
await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...artifact, artifactPath }, null, 2));
