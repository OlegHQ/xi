import { strict as assert } from 'node:assert';
import { boundedRunExitCode, runBoundedTasks } from '../../tools/bounded-tasks';

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Concurrency is capped and results retain input order even when tasks finish out of order.
{
  const started: number[] = [];
  const emitted: number[] = [];
  let active = 0;
  let maximumActive = 0;
  let releaseFirst!: () => void;
  const firstTask = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const runPromise = runBoundedTasks(20, 3, async (index) => {
    started.push(index);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await (index === 0 ? firstTask : delay(2));
    active -= 1;
    return { code: 0, value: index };
  }, (_index, outcome) => { emitted.push(outcome.value); });
  const deadline = Date.now() + 1000;
  while (started.length < 12 && Date.now() < deadline) await delay(2);
  await delay(10);
  assert.deepEqual(started, Array.from({ length: 12 }, (_, index) => index), 'out-of-order output buffering does not launch past the bounded window');
  releaseFirst();
  const run = await runPromise;
  assert.equal(maximumActive, 3);
  assert.deepEqual(started, Array.from({ length: 20 }, (_, index) => index));
  assert.deepEqual(emitted, Array.from({ length: 20 }, (_, index) => index));
  assert.deepEqual(run.codes, Array(20).fill(0));
}

// The first failure stops further launches and still waits for the already-running task.
{
  const started: number[] = [];
  const emitted: number[] = [];
  const run = await runBoundedTasks(8, 2, async (index) => {
    started.push(index);
    await delay(index === 0 ? 2 : 8);
    return { code: index === 0 ? 1 : 0, value: index };
  }, (_index, outcome) => { emitted.push(outcome.value); });
  assert.deepEqual(started, [0, 1]);
  assert.equal(run.failed, true);
  assert.deepEqual(emitted, [0, 1]);
}

// Opt-in keep-going runs every fixture and retains every failing exit code.
{
  const started: number[] = [];
  const run = await runBoundedTasks(6, 2, async (index) => {
    started.push(index);
    await delay(index === 0 ? 2 : 1);
    return { code: index === 1 || index === 4 ? 7 : 0, value: index };
  }, () => {}, () => false, true);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(run.codes, [0, 7, 0, 0, 7, 0]);
  assert.equal(boundedRunExitCode(run), 7, 'keep-going still returns a nonzero failure code');
}

// Cancellation stops new launches and remains separately reportable from a fixture failure.
{
  let interrupted = false;
  const started: number[] = [];
  setTimeout(() => { interrupted = true; }, 2);
  const run = await runBoundedTasks(8, 2, async (index) => {
    started.push(index);
    await delay(8);
    return { code: 1, value: index };
  }, () => {}, () => interrupted);
  assert.deepEqual(started, [0, 1]);
  assert.equal(run.interrupted, true);
  assert.equal(run.failed, true);
  assert.equal(boundedRunExitCode(run), 130, 'interruption exit takes precedence over killed fixture status');
}

console.log('Bounded fixture runner passed concurrency, ordered result, fail-fast and cancellation checks');
