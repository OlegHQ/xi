import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import {
  compilePattern,
  createPatternEvaluation,
  createPatternTextSnapshot,
  PatternEvaluationError,
} from '../../packages/vim/pattern/index';
import type { DocumentVersion } from '../../packages/primitives/src/index';

const version = 97 as DocumentVersion;
const stepBudget = 20_000;
const workloads = [
  {
    id: 'ambiguous-backreference-failure',
    pattern: String.raw`\v((a|aa)+)\1b`,
    text: 'a'.repeat(64),
  },
  {
    id: 'variable-lookbehind-candidate-scan',
    pattern: String.raw`\v(a+|aa+)@<=b`,
    text: 'a'.repeat(512),
  },
] as const;

const rows = workloads.map((workload) => {
  const program = compilePattern(workload.pattern, { stepBudget, outputLimit: 100 });
  assert.equal(program.features.containsBackreference || program.features.containsLookaround, true);
  const session = createPatternEvaluation(program, createPatternTextSnapshot(version, workload.text));
  const startedAt = performance.now();
  let outcome: 'complete' | 'step-budget-exceeded' = 'complete';
  let matchCount = 0;
  try {
    const progress = session.resume(Number.MAX_SAFE_INTEGER);
    assert.equal(progress.kind, 'complete');
    matchCount = progress.result.matches.length;
  } catch (error: unknown) {
    assert(error instanceof PatternEvaluationError, `${workload.id}: expected a typed bounded failure`);
    assert.equal(error.code, 'step-budget-exceeded', `${workload.id}: ${error.code}`);
    assert.equal(error.steps, stepBudget + 1, `${workload.id}: exact step boundary`);
    assert(error.source !== undefined, `${workload.id}: missing failing pattern span`);
    outcome = 'step-budget-exceeded';
  }
  const elapsedMs = performance.now() - startedAt;
  assert.equal(outcome, 'step-budget-exceeded', `${workload.id}: adversarial case must exercise the deterministic bound`);
  return {
    id: workload.id,
    pattern: workload.pattern,
    textUtf16Length: workload.text.length,
    stepBudget,
    outcome,
    steps: session.steps,
    matchCount,
    elapsedMs: Number(elapsedMs.toFixed(3)),
  };
});

const artifact = {
  ticket: 'T097',
  benchmark: 'bounded Vim pattern extension fallback termination',
  environment: { bun: Bun.version, platform: process.platform, arch: process.arch },
  rows,
};
const artifactPath = resolve(process.cwd(), '.artifacts/bench/vim/t097-pattern.json');
await mkdir(resolve(artifactPath, '..'), { recursive: true });
await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...artifact, artifactPath }, null, 2));
