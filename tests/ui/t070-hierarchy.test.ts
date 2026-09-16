import assert from 'node:assert/strict';
import { formatHierarchyLines, type HierarchyReadModel } from '../../packages/ui/navigation/index';

const model: HierarchyReadModel = {
  state: 'ready',
  nodes: [{ id: 'root', name: 'root', kind: 12, children: [{ id: 'cycle', name: 'root', kind: 12, cycle: true, children: [] }] }],
  links: [{ target: 'file:///workspace/other.ts', tooltip: 'Open target' }],
  message: undefined,
};
assert.deepEqual(formatHierarchyLines(model, 80), ['Hierarchy', 'root', '  ↻ root'], 'T070-UI-01 hierarchy rows preserve depth and cycle marker');
assert.deepEqual(formatHierarchyLines({ ...model, state: 'unavailable', nodes: [], message: undefined }, 80), ['Hierarchy unavailable'], 'T070-UI-02 unavailable hierarchy has an explicit state');
console.log('T070 hierarchy UI passed bounded tree rendering and capability state');
