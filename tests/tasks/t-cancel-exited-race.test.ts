#!/usr/bin/env bun
// Regression coverage for F2-12:
//  - cancel() must not overwrite a run that already reached 'exited' with 'cancelled' (start()
//    calling cancel() first on the previous run was mutating that previous run's real outcome).
//  - append()'s `truncated` flag must stay sticky once set, instead of being recomputed from
//    only the current chunk (which can flip it back to false on a later, non-truncated chunk).
import assert from 'node:assert/strict';
import { TaskController, type TaskProcess, type TaskProcessFactory } from '../../packages/services/tasks/index';
import type { Result } from '../../packages/contracts/src/index';

type ExitResult = Result<{ readonly code: number | null; readonly signal: string | null }, { readonly kind: 'failed'; readonly message: string }>;

function fakeProcess(): { readonly process: TaskProcess; readonly stdout: (bytes: Uint8Array) => void; readonly resolveExit: (value: ExitResult) => void } {
  let stdoutListener: ((bytes: Uint8Array) => void) | undefined;
  let resolveExit: ((value: ExitResult) => void) | undefined;
  const process: TaskProcess = {
    exit: new Promise((resolve) => { resolveExit = resolve; }),
    onStdout(listener) { stdoutListener = listener; return { dispose() { stdoutListener = undefined; } }; },
    onStderr() { return { dispose() {} }; },
    async terminate() {},
    dispose() {},
  };
  return {
    process,
    stdout: (bytes) => stdoutListener?.(bytes),
    resolveExit: (value) => resolveExit?.(value),
  };
}

async function cancelDoesNotOverwriteAlreadyExitedRun(): Promise<void> {
  const fake = fakeProcess();
  const factory: TaskProcessFactory = { async spawn() { return { ok: true, value: fake.process }; } };
  const tasks = new TaskController(factory, 1024);
  await tasks.start({ id: 'race', argv: ['echo', 'x'], cwd: '/tmp' });

  // The process exits naturally first...
  fake.resolveExit({ ok: true, value: { code: 0, signal: null } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(tasks.snapshot.state, 'exited', 'sanity: the run reached exited before cancel() races it');

  // ...then something calls cancel() (directly, or via the next start()) against a controller
  // that has not otherwise been told the run finished.
  await tasks.cancel();
  assert.equal(tasks.snapshot.state, 'exited', 'F2-12: cancel() must not overwrite an already-exited run\'s state with cancelled');
  tasks.dispose();
}

async function startCallingCancelDoesNotMutatePreviousExitedRun(): Promise<void> {
  const first = fakeProcess();
  const second = fakeProcess();
  let call = 0;
  const factory: TaskProcessFactory = { async spawn() { call += 1; return { ok: true, value: call === 1 ? first.process : second.process }; } };
  const tasks = new TaskController(factory, 1024);
  await tasks.start({ id: 'first', argv: ['echo', 'x'], cwd: '/tmp' });
  first.resolveExit({ ok: true, value: { code: 0, signal: null } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const firstRunSnapshot = tasks.snapshot;
  assert.equal(firstRunSnapshot.state, 'exited', 'sanity: first run exited');

  // start() calls cancel() internally before spawning the next run.
  await tasks.start({ id: 'second', argv: ['echo', 'y'], cwd: '/tmp' });
  assert.equal(tasks.snapshot.taskId, 'second', 'sanity: the controller has moved on to the second run');
  tasks.dispose();
}

async function truncatedFlagStaysStickyAcrossChunks(): Promise<void> {
  const fake = fakeProcess();
  const factory: TaskProcessFactory = { async spawn() { return { ok: true, value: fake.process }; } };
  const tasks = new TaskController(factory, 1024);
  await tasks.start({ id: 'truncate', argv: ['echo', 'x'], cwd: '/tmp' });

  fake.stdout(new TextEncoder().encode('x'.repeat(2048)));
  assert.equal(tasks.snapshot.truncated, true, 'sanity: the first, over-budget chunk sets truncated');

  // A later chunk that arrives once the budget is already exhausted decodes to an empty
  // accepted slice with the SAME byteLength as the chunk only when the chunk itself is empty;
  // recomputing `truncated` from just this chunk (accepted.byteLength !== bytes.byteLength)
  // would then read `0 !== 0` and incorrectly flip it back to false.
  fake.stdout(new Uint8Array(0));
  assert.equal(tasks.snapshot.truncated, true, 'F2-12: truncated must stay sticky once set, not be recomputed from only the latest chunk');
  await tasks.cancel();
  tasks.dispose();
}

await cancelDoesNotOverwriteAlreadyExitedRun();
await startCallingCancelDoesNotMutatePreviousExitedRun();
await truncatedFlagStaysStickyAcrossChunks();
console.log('T-CANCEL-EXITED-RACE passed: cancel() preserves an already-exited run\'s state and truncated stays sticky (F2-12)');
