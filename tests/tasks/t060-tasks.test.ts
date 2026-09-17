import assert from 'node:assert/strict';
import { CancellationSource } from '../../packages/primitives/src/index';
import { NodeProcessPort } from '../../packages/platform/src/process';
import {
  TaskController,
  createSpawnTaskProcessFactory,
  stripAnsiEscapes,
  matchTaskProblems,
  GENERIC_COMPILER_PROBLEM_MATCHER,
  type TaskProcess,
  type TaskProcessFactory,
} from '../../packages/services/tasks/index';
import type { Disposable, Result } from '../../packages/contracts/src/index';

let stdout: ((bytes: Uint8Array) => void) | undefined; let stderr: ((bytes: Uint8Array) => void) | undefined; let resolveExit: ((value: Result<{ readonly code: number | null; readonly signal: string | null }, { readonly kind: 'failed'; readonly message: string }>) => void) | undefined;
const fakeProcess: TaskProcess = { exit: new Promise((resolve) => { resolveExit = resolve; }), onStdout(listener) { stdout = listener; return { dispose() { stdout = undefined; } }; }, onStderr(listener) { stderr = listener; return { dispose() { stderr = undefined; } }; }, async terminate() {}, dispose() {} };
const fakeFactory: TaskProcessFactory = { async spawn() { return { ok: true, value: fakeProcess }; } };
const tasks = new TaskController(fakeFactory, 1024); await tasks.start({ id: 'build', argv: ['echo', 'x'], cwd: '/tmp' }); stdout?.(new TextEncoder().encode('x'.repeat(2048))); stderr?.(new TextEncoder().encode('err')); assert.equal(tasks.snapshot.truncated, true, 'T060-OUTPUT-01 output is bounded'); resolveExit?.({ ok: true, value: { code: 0, signal: null } }); await new Promise((resolve) => setTimeout(resolve, 0)); assert.equal(tasks.snapshot.state, 'exited', 'T060-EXIT-01 exit status is retained'); await tasks.cancel(); tasks.dispose();

// T060-SUBSCRIBE-01: subscribers are notified on every snapshot transition, not just read on demand.
{
  const seenStates: string[] = [];
  let subStdout: ((bytes: Uint8Array) => void) | undefined;
  let subResolveExit: ((value: Result<{ readonly code: number | null; readonly signal: string | null }, { readonly kind: 'failed'; readonly message: string }>) => void) | undefined;
  const subProcess: TaskProcess = { exit: new Promise((resolve) => { subResolveExit = resolve; }), onStdout(listener) { subStdout = listener; return { dispose() {} }; }, onStderr() { return { dispose() {} }; }, async terminate() {}, dispose() {} };
  const subFactory: TaskProcessFactory = { async spawn() { return { ok: true, value: subProcess }; } };
  const subscribed = new TaskController(subFactory, 1024);
  const subscription = subscribed.subscribe((snapshot) => seenStates.push(snapshot.state));
  await subscribed.start({ id: 'sub', argv: ['echo', 'x'], cwd: '/tmp' });
  subStdout?.(new TextEncoder().encode('hi'));
  subResolveExit?.({ ok: true, value: { code: 0, signal: null } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seenStates, ['running', 'running', 'exited'], 'T060-SUBSCRIBE-01 subscriber sees running, append, exited transitions');
  subscription.dispose();
  subscribed.dispose();
}

// T060-REAL-SPAWN-01: a genuinely real child process, not a mocked factory -- exercises
// createSpawnTaskProcessFactory end to end through the pre-existing Bun.spawn-backed
// NodeProcessPort, closing the disclosed "no real child process is started" gap.
{
  const cancellation = new CancellationSource();
  const factory = createSpawnTaskProcessFactory(new NodeProcessPort(), cancellation.token);
  const real = new TaskController(factory, 1_048_576);
  const started = await real.start({ id: 'real-echo', argv: ['printf', 'line1:5:2: error TS1: boom\\nplain output\\n'], cwd: '/tmp' });
  assert.equal(started.ok, true, 'T060-REAL-SPAWN-01 real process starts');
  for (let attempt = 0; attempt < 50 && real.snapshot.state === 'running'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(real.snapshot.state, 'exited', 'T060-REAL-SPAWN-01 real process reaches exited');
  assert.equal(real.snapshot.exitCode, 0, 'T060-REAL-SPAWN-01 real process reports its actual exit code');
  assert.ok(real.snapshot.stdout.includes('plain output'), 'T060-REAL-SPAWN-01 real stdout bytes are retained');
  const matched = matchTaskProblems(real.snapshot.stdout, GENERIC_COMPILER_PROBLEM_MATCHER);
  assert.equal(matched.length, 1, 'T060-PROBLEM-MATCHER-01 the compiler-style line is matched exactly once');
  assert.equal(matched[0]?.file, 'line1', 'T060-PROBLEM-MATCHER-01 file capture');
  assert.equal(matched[0]?.line, 5, 'T060-PROBLEM-MATCHER-01 line capture');
  assert.equal(matched[0]?.severity, 1, 'T060-PROBLEM-MATCHER-01 "error" maps to severity 1');
  real.dispose();
  cancellation.dispose();
}

// T060-SPAWN-FAILURE-01: a real spawn failure (nonexistent executable) is a typed failure, not a throw/crash.
{
  const cancellation = new CancellationSource();
  const factory = createSpawnTaskProcessFactory(new NodeProcessPort(), cancellation.token);
  const failing = new TaskController(factory, 1024);
  const started = await failing.start({ id: 'missing', argv: ['xi-nonexistent-executable-t060'], cwd: '/tmp' });
  assert.equal(started.ok, false, 'T060-SPAWN-FAILURE-01 a missing executable is a typed failure');
  assert.equal(failing.snapshot.state, 'failed', 'T060-SPAWN-FAILURE-01 snapshot reflects the failure');
  failing.dispose();
  cancellation.dispose();
}

// T060-ANSI-SANITIZE-01: terminal-escape sequences never reach the retained read model.
assert.equal(stripAnsiEscapes('[31mred[0m plain'), 'red plain', 'T060-ANSI-SANITIZE-01 CSI/control bytes are stripped, literal text survives');


// T060-ENV-MERGE: a configured task must inherit the base process environment
// (PATH, HOME, ...) the same way LSP/ripgrep/formatter spawns already do via
// processEnvironment(); apps/xi/src/main.ts wires this by starting the task
// with `env: { ...processEnvironment(), ...config.env }`. This exercises that
// exact merged-env shape end to end through a real spawned child, and its
// companion case demonstrates the pre-fix scrubbed-environment bug (an
// explicit-only env has no PATH) that the merge in main.ts now avoids.
{
  const cancellation = new CancellationSource();
  const factory = createSpawnTaskProcessFactory(new NodeProcessPort(), cancellation.token);
  const controller = new TaskController(factory, 1_048_576);
  const merged = { ...process.env, PATH: process.env.PATH ?? '/usr/bin:/bin', XI_TASK_ENV_TEST: 'from-task' } as Record<string, string>;
  const started = await controller.start({ id: 'env-merge', argv: ['/usr/bin/env'], cwd: '/tmp', env: merged });
  assert.equal(started.ok, true, 'T060-ENV-MERGE-01 task starts with a merged environment');
  for (let attempt = 0; attempt < 50 && controller.snapshot.state === 'running'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(controller.snapshot.state, 'exited', 'T060-ENV-MERGE-02 task exits');
  assert.ok(controller.snapshot.stdout.includes('PATH='), 'T060-ENV-MERGE-03 the base environment (PATH) is inherited, not scrubbed to an empty env');
  assert.ok(controller.snapshot.stdout.includes('XI_TASK_ENV_TEST=from-task'), 'T060-ENV-MERGE-04 explicit task env keys are present and applied last so they can override the base');
  controller.dispose();
  cancellation.dispose();
}
{
  const cancellation = new CancellationSource();
  const factory = createSpawnTaskProcessFactory(new NodeProcessPort(), cancellation.token);
  const controller = new TaskController(factory, 1_048_576);
  const started = await controller.start({ id: 'env-scrubbed', argv: ['/usr/bin/env'], cwd: '/tmp', env: { XI_TASK_ENV_TEST: 'from-task' } });
  assert.equal(started.ok, true, 'T060-ENV-SCRUBBED-01 task starts with an explicit-only, unmerged environment');
  for (let attempt = 0; attempt < 50 && controller.snapshot.state === 'running'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(controller.snapshot.state, 'exited', 'T060-ENV-SCRUBBED-02 task exits');
  assert.equal(controller.snapshot.stdout.includes('PATH='), false, 'T060-ENV-SCRUBBED-03 an unmerged explicit-only env has no PATH -- reproduces the exact scrubbed-environment bug main.ts now avoids by merging processEnvironment()');
  controller.dispose();
  cancellation.dispose();
}

console.log('T060 tasks passed bounded stdout/stderr retention, exit status, disposal/cancellation lifecycle, live subscription, a real spawned child process, a real spawn failure, ANSI sanitization, problem-matcher extraction and base-environment merge/override');
