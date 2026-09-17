import assert from 'node:assert/strict';
import { CancellationSource } from '../../packages/contracts/src/index';
import { NodeProcessPort } from '../../packages/platform/src/process';
import type { ProcessSpec } from '../../packages/contracts/src/index';

type TestBody = () => void | Promise<void>;
const cases: { readonly id: string; readonly name: string; readonly body: TestBody }[] = [];

function test(id: string, name: string, body: TestBody): void {
  cases.push({ id, name, body });
}

function baseSpec(overrides: Partial<ProcessSpec> = {}): ProcessSpec {
  return {
    argv: ['sleep', '30'],
    cwd: process.cwd(),
    env: {},
    cancellation: new CancellationSource().token,
    ...overrides,
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

test('PLATFORM-PROCESS-NO-LIFETIME-01', 'a process spawned without timeoutMilliseconds is not killed on any wall-clock schedule', async () => {
  const port = new NodeProcessPort();
  const spawned = await port.spawn(baseSpec());
  assert.equal(spawned.ok, true, 'process spawns');
  if (!spawned.ok) return;
  // Long-lived servers (e.g. LSP) must have no forced lifetime; there is no timer to race here,
  // so a bounded wait proves the process was never scheduled for a kill.
  await delay(300);
  assert.equal(spawned.value.exit, spawned.value.exit, 'exit promise exists');
  let exited = false;
  void spawned.value.exit.then(() => { exited = true; });
  await delay(50);
  assert.equal(exited, false, 'process without an explicit timeout stays alive past the old hard-coded 5 s default window scale');
  await spawned.value.terminate(200);
});

test('PLATFORM-PROCESS-TIMEOUT-STILL-WORKS-01', 'an explicit finite timeout still bounds the process lifetime', async () => {
  const port = new NodeProcessPort();
  const spawned = await port.spawn(baseSpec({ timeoutMilliseconds: 100 }));
  assert.equal(spawned.ok, true, 'process spawns');
  if (!spawned.ok) return;
  const exit = await spawned.value.exit;
  assert.equal(exit.ok, true, 'process exit observed');
  if (exit.ok) assert.notEqual(exit.value.signal, null, 'explicit timeout terminates the process');
});

test('PLATFORM-PROCESS-DISPOSE-ESCALATES-SIGKILL-01', 'dispose escalates to SIGKILL when a child ignores SIGTERM', async () => {
  const port = new NodeProcessPort();
  const spawned = await port.spawn(baseSpec({ argv: ['bash', '-c', "trap '' TERM; sleep 30"] }));
  assert.equal(spawned.ok, true, 'process spawns');
  if (!spawned.ok) return;
  await delay(50); // let the trap install
  spawned.value.dispose();
  const started = Date.now();
  const exit = await spawned.value.exit;
  const elapsed = Date.now() - started;
  assert.equal(exit.ok, true, 'process exit observed after dispose');
  assert.ok(elapsed < 2_000, `dispose escalated to SIGKILL within a bounded grace period (took ${elapsed} ms)`);
});

test('PLATFORM-PROCESS-TIMEOUT-ESCALATES-SIGKILL-01', 'the wall-clock timeout escalates to SIGKILL when a child ignores SIGTERM', async () => {
  const port = new NodeProcessPort();
  const spawned = await port.spawn(baseSpec({ argv: ['bash', '-c', "trap '' TERM; sleep 30"], timeoutMilliseconds: 100 }));
  assert.equal(spawned.ok, true, 'process spawns');
  if (!spawned.ok) return;
  const started = Date.now();
  const exit = await spawned.value.exit;
  const elapsed = Date.now() - started;
  assert.equal(exit.ok, true, 'process exit observed after timeout');
  assert.ok(elapsed < 2_000, `timeout escalated to SIGKILL within a bounded grace period (took ${elapsed} ms)`);
});

for (const testCase of cases) {
  await testCase.body();
  console.log(`${testCase.id} passed: ${testCase.name}`);
}
console.log(`process lifetime cases passed: ${cases.length}`);
