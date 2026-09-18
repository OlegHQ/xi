import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot, flushSync } from '@opentui/react';
import { useState } from 'react';
import { DiagnosticStore } from '../../packages/services/language/diagnostics';
import { StatusMessageController } from '../../packages/workbench/status';
import type { ProblemsReadPort } from '../../packages/ui/problems/index';
import type { StatusMessageReadPort } from '../../packages/ui/status/index';
import { DARK_WORKBENCH_THEME, LIGHT_WORKBENCH_THEME } from '../../packages/ui/theme/workbench-themes';
import { Shell } from './components';

const problems = new DiagnosticStore();
const messages = new StatusMessageController();
let problemReads = 0, subscriptions = 0;
const problemPort: ProblemsReadPort = {
  get model() { problemReads++; return problems.model; },
  subscribe(listener) {
    subscriptions++;
    const subscription = problems.subscribe(listener);
    return { dispose() { subscriptions--; subscription.dispose(); } };
  },
};
const messagePort: StatusMessageReadPort = {
  get model() { return messages.model; },
  subscribe(listener) {
    subscriptions++;
    const subscription = messages.subscribe(listener);
    return { dispose() { subscriptions--; subscription.dispose(); } };
  },
};
const setup = await createTestRenderer({ width: 100, height: 30, maxFps: 1000, bufferedOutput: 'memory' });
let setDark!: (value: boolean) => void;
let setOffset!: (value: number) => void;
function App() {
  const [dark, updateDark] = useState(false);
  const [offset, updateOffset] = useState(0);
  setDark = updateDark;
  setOffset = updateOffset;
  return <Shell theme={dark ? DARK_WORKBENCH_THEME : LIGHT_WORKBENCH_THEME} problems={problemPort} messages={messagePort}
    offset={offset} onSelect={id => messages.publish(`Selected ${id}`, 'info')}>
    <text>Editor slot</text>
  </Shell>;
}
const root = createRoot(setup.renderer);
flushSync(() => root.render(<App />));
await setup.waitForFrame(frame => frame.includes('No problems') && frame.includes('No messages'));
assert.equal(subscriptions, 2);

const publish = (generation: number, count: number) => problems.publish({ serverId: 'test', uri: 'file.ts', generation,
  diagnostics: Array.from({ length: count }, (_, index) => ({
    range: { startLine: index, startUtf16: 0, endLine: index, endUtf16: 1 },
    message: `problem-${index}`, severity: 1 as const, source: 'test', code: undefined,
  })),
});
flushSync(() => { publish(2, 1000); });
await setup.waitForFrame(frame => frame.includes('Problems 1000') && frame.includes('problem-0'));
assert.ok(!setup.captureCharFrame().includes('problem-8'), 'Only the eight visible diagnostics render');
assert.equal(publish(1, 1), false, 'The existing store rejects stale service results');
const readsBeforeMessage = problemReads;
flushSync(() => messages.publish('asynchronous service error'));
await setup.waitForFrame(frame => frame.includes('asynchronous service error'));
assert.equal(problemReads, readsBeforeMessage, 'Message updates do not rerender the sibling Problems subscription');
const firstRow = setup.captureCharFrame().split('\n').findIndex(row => row.includes('problem-0'));
await setup.mockMouse.click(55, firstRow);
await setup.waitForFrame(frame => frame.includes('Selected '));
assert.ok(messages.model?.text.startsWith('Selected '), 'Pointer selection calls the controller');
flushSync(() => setOffset(20));
await setup.waitForFrame(frame => frame.includes('problem-20'));
assert.ok(!setup.captureCharFrame().includes('problem-0'));
const light = JSON.stringify(setup.captureSpans());
flushSync(() => setDark(true));
await setup.flush();
assert.notEqual(JSON.stringify(setup.captureSpans()), light, 'Theme propagates through both shared panels');
assert.ok(setup.captureCharFrame().includes('problem-20'));
setup.resize(44, 18);
await setup.waitForFrame(frame => frame.includes('Problems 1000') && frame.includes('Messages'));
const narrow = setup.captureCharFrame();
assert.ok(narrow.split('\n').every(row => [...row].length <= 44), 'Narrow layout stays within terminal width');
flushSync(() => { publish(3, 0); messages.clear(); });
await setup.waitForFrame(frame => frame.includes('No problems') && frame.includes('No messages'));
await mkdir('../../.artifacts/ui-declarative', { recursive: true });
await writeFile('../../.artifacts/ui-declarative/react-narrow.txt', narrow);
flushSync(() => root.unmount());
assert.equal(subscriptions, 0, 'Unmount disposes all controller subscriptions');
messages.publish('after unmount');
assert.equal(subscriptions, 0);
setup.renderer.destroy();
problems.dispose();
console.log('React shell passed: shared panels, bounded rows, isolated subscriptions, stale results, theme, resize, cleanup');
