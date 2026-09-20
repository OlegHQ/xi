import assert from 'node:assert/strict';
import type { Disposable } from '../../packages/contracts/src/index';
import { StatusMessageController } from '../../packages/workbench/status';

class FakeClock {
  tasks: Array<{ delay: number; callback: () => void; cancelled: boolean }> = [];
  schedule(delay: number, callback: () => void): Disposable {
    const task = { delay, callback, cancelled: false };
    this.tasks.push(task);
    return { dispose: () => { task.cancelled = true; } };
  }
  fire(index: number): void {
    const task = this.tasks[index];
    if (task !== undefined && !task.cancelled) task.callback();
  }
}

const clock = new FakeClock();
const status = new StatusMessageController(clock);
const published: Array<string | undefined> = [];
status.subscribe(model => published.push(model?.text));

status.publish('recovery notice', 'info');
assert.equal(clock.tasks[0]?.delay, 5_000);
status.publish('later error');
assert.equal(clock.tasks[0]?.cancelled, true, 'replacing a message cancels its stale timer');
assert.equal(clock.tasks[1]?.delay, 8_000);
clock.fire(0);
assert.equal(status.model?.text, 'later error', 'a replaced message cannot be cleared by the old timer');
clock.fire(1);
assert.equal(status.model, undefined, 'the current message expires');
assert.deepEqual(published, ['recovery notice', 'later error', undefined]);

status.publish('dispose me', 'info');
status.dispose();
assert.equal(clock.tasks[2]?.cancelled, true);
assert.equal(status.model, undefined);

console.log('Status messages expire, replacement cancels stale timers, and disposal cleans up');
