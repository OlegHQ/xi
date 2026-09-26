import assert from 'node:assert/strict';
import { createTestRenderer } from '@opentui/core/testing';
import { mountSolidRoot } from '../../packages/ui/src/solid/root';

const setup = await createTestRenderer({ width: 90, height: 20, bufferedOutput: 'memory' });
try {
  await mountSolidRoot(setup.renderer, [() => { throw new Error('Deliberate UI failure'); }]);
  await setup.waitForFrame(frame => frame.includes('Xi UI error') && frame.includes('Deliberate UI failure'));
  assert.match(setup.captureCharFrame(), /Click here to retry/);
  assert.equal(setup.renderer.isDestroyed, false, 'UI failure is contained in a dialog');
  setup.renderer.emit('render:error', { error: new Error('Native render failure'), renderable: undefined });
  await setup.waitForFrame(frame => frame.includes('Native render failure'));
  assert.equal(setup.renderer.isDestroyed, false, 'native render failure stays in the dialog');
} finally { setup.renderer.destroy(); }
console.log('UI errors are contained in an in-app dialog');
