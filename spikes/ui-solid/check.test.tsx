import assert from 'node:assert/strict';
import { createTestRenderer } from '@opentui/core/testing';
import { StatusMessageController } from '../../packages/workbench/status';
import { runOpenTuiWorkbench } from './launch';

const setup = await createTestRenderer({ width: 120, height: 40, bufferedOutput: 'memory' });
const messages = new StatusMessageController({ schedule: (delay, callback) => { const timer = setTimeout(callback, delay); return { dispose: () => clearTimeout(timer) }; } });
let subscriptions = 0;
const running = runOpenTuiWorkbench({ activeViewId: undefined, readView: () => undefined, readDocument: () => undefined }, 'fixture', {
  renderer: Promise.resolve(setup.renderer),
  dispatchKey: () => 'unhandled',
  statusMessage: { read: {
    get model() { return messages.model; },
    subscribe(listener) {
      subscriptions++;
      const subscription = messages.subscribe(listener);
      return { dispose() { subscriptions--; subscription.dispose(); } };
    },
  } },
});
await setup.waitForFrame(() => subscriptions === 1);
const children = setup.renderer.root.getChildren();
messages.publish('Solid reactive error');
await setup.waitForFrame(frame => frame.includes('Solid reactive error'));
messages.clear();
await setup.waitForFrame(frame => !frame.includes('Solid reactive error'));
assert.deepEqual(setup.renderer.root.getChildren(), children, 'Clearing status must preserve the editor siblings');
setup.renderer.destroy();
await running;
assert.equal(subscriptions, 0, 'Renderer destruction disposes the actual status subscription');
console.log('Solid CLI adapter: reactive status, sibling preservation and disposal passed');
