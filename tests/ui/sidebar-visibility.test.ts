import assert from 'node:assert/strict';
import { SidebarController } from '../../packages/workbench/sidebar';
import { calculateWorkbenchLayout } from '../../packages/ui/src/workbench';
import { getSearchBounds, getGitDiffBounds } from '../../packages/ui/src/solid/layout';
const sidebar = new SidebarController({ initialWidth: 32 });
const open = calculateWorkbenchLayout(120, 40, false, sidebar.width, sidebar.visible);
assert.equal(open.editorX, 33);
sidebar.setVisible(false);
const closed = calculateWorkbenchLayout(120, 40, false, sidebar.width, sidebar.visible);
assert.equal(closed.sidebarVisible, false);
assert.equal(closed.editorX, 0);
assert.equal(closed.editorWidth, 120);
assert.equal(getGitDiffBounds(120, 40, sidebar.readModel()).left, 0);
assert.notEqual(getSearchBounds(120, 40, sidebar.readModel()).width, 32);
assert.equal(sidebar.width, 32, 'hiding retains the width');
sidebar.setVisible(true);
assert.deepEqual(calculateWorkbenchLayout(120, 40, false, sidebar.width, sidebar.visible), open);
assert.equal(calculateWorkbenchLayout(60, 18, false, sidebar.width, sidebar.visible).sidebarVisible, false, 'narrow viewport still uses overlay');
sidebar.dispose();
console.log('Sidebar hide/show restores width and invalidates layout geometry');

const committedWidths: number[] = [];
const savedPanels: string[] = [];
const restored = new SidebarController({
  initiallyVisible: false, initialPanel: 'search',
  persistence: { width: 34, setWidth: width => committedWidths.push(width) },
  onPanelChange: panel => savedPanels.push(panel),
});
assert.equal(restored.width, 34);
assert.equal(restored.readModel().panel, 'search');
restored.beginResize();
restored.moveResize(39);
assert.deepEqual(committedWidths, [], 'drag frames never write state');
restored.commitResize();
assert.deepEqual(committedWidths, [39]);
restored.setPanel('git');
restored.setPanel('git');
assert.deepEqual(savedPanels, ['git']);
assert.equal(restored.readModel().panel, 'git');
restored.dispose();
