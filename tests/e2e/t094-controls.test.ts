import assert from 'node:assert/strict';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { WorkbenchSession } from '../../packages/workbench/src/index';
import { SplitterDragController, TerminalRestoration, WorkbenchControlRegistry } from '../../packages/workbench/input/controls';
import { PanelHitMap, PanelScroll } from '../../packages/ui/src/panel-pointer';

const hitMap = new PanelHitMap();
hitMap.publish(7, [undefined, 'explorer:workspace\0src/a.ts']);
assert.equal(hitMap.resolve(1, 7), 'explorer:workspace\0src/a.ts', 'T127-PANEL-01 resolves a stable item identity from the painted generation');
hitMap.publish(8, [undefined, 'explorer:workspace\0aaa.ts', 'explorer:workspace\0src/a.ts']);
assert.equal(hitMap.resolve(1, 7), undefined, 'T127-PANEL-02 rejects a stale row after insertion beneath the pointer');
assert.equal(hitMap.resolve(2, 8), 'explorer:workspace\0src/a.ts', 'T127-PANEL-02 resolves the moved item by stable ID after repaint');

const scroll = new PanelScroll();
assert.equal(scroll.scrollBy(5, 100, 10), true, 'T129-SCROLL-01 wheel delta below the max scrolls');
assert.equal(scroll.offset, 5);
assert.equal(scroll.scrollBy(1000, 100, 10), true, 'T129-SCROLL-01 wheel delta clamps to the content/viewport bound');
assert.equal(scroll.offset, 90, 'max offset is total(100) - viewport(10)');
assert.equal(scroll.scrollBy(1, 100, 10), false, 'T129-SCROLL-01 scrolling past the clamp is a no-op that reports unchanged');
scroll.reset();
assert.equal(scroll.thumb(100, 10)?.size, 1, 'T129-SCROLL-02 thumb size is proportional and at least one cell');
assert.equal(scroll.thumb(5, 10), undefined, 'T129-SCROLL-02 no thumb when content fits without scrolling');
scroll.beginDrag(10);
assert.equal(scroll.dragging, true);
scroll.dragTo(20, 100, 10);
assert.ok(scroll.offset > 0, 'T129-SCROLL-03 dragging the thumb down increases the offset');
scroll.clamp(3, 10);
assert.equal(scroll.offset, 0, 'T129-SCROLL-03 clamp resolves the offset when content shrinks below the viewport');
scroll.beginDrag(0);
scroll.endDrag();
assert.equal(scroll.dragging, false, 'T129-SCROLL-04 endDrag (Escape/resize/disposal path) releases capture');

let activated = 0;
const controls = new WorkbenchControlRegistry();
controls.publish([
  { id: 'tree:stable-node-42', kind: 'tree', enabled: true, activate: () => { activated += 1; } },
  { id: 'button:disabled', kind: 'button', enabled: false, activate: () => { activated += 10; } },
]);
assert.equal(controls.activate('tree:stable-node-42'), true);
assert.equal(controls.activate('button:disabled'), false);
controls.publish([
  { id: 'tree:new-node', kind: 'tree', enabled: true, activate: () => { activated += 100; } },
  { id: 'tree:stable-node-42', kind: 'tree', enabled: true, activate: () => { activated += 2; } },
]);
assert.equal(controls.activate('tree:stable-node-42'), true);
assert.equal(controls.activate('button:disabled'), false);
assert.equal(activated, 3, 'T094-CONTROL-01 stable identity survives row replacement/reordering; disabled controls cannot execute');

const documentId = asIdentifier<DocumentId>('T094-layout-document', 'document-id');
const viewId = asIdentifier<ViewId>('T094-layout-view', 'view-id');
if (!documentId.ok || !viewId.ok) throw new Error('T094 layout identifiers');
const createdDocument = TextFileDocument.create(documentId.value, 'alpha\n', ['lf'], 'lf');
if (!createdDocument.ok) throw new Error('T094 layout document');
const workbench = new WorkbenchSession({ minimumPaneSize: 12 });
const opened = workbench.openBuffer(createdDocument.value, { viewId: viewId.value });
assert.equal(opened.ok, true);
const unsplitRead = workbench.readLayout();
assert.equal(workbench.readLayout(), unsplitRead, 'T094-LAYOUT-READ-01 reuses its immutable snapshot between layout changes');
const split = workbench.splitView(viewId.value, 'vertical');
assert.equal(split.ok, true);
assert.notEqual(workbench.readLayout(), unsplitRead, 'T094-LAYOUT-READ-01 invalidates after split creation');
const splitRead = workbench.readLayout();
assert.equal(workbench.readLayout(), splitRead, 'T094-LAYOUT-READ-01 does not clone split geometry on every render');
if (splitRead.split.root?.kind !== 'split') throw new Error('T094 layout split root');
assert.equal(workbench.resizeSplit(splitRead.split.root.nodeId, 0.6, 100).ok, true);
assert.notEqual(workbench.readLayout(), splitRead, 'T094-LAYOUT-READ-01 invalidates after separator resize');
workbench.dispose();

const splitter = new SplitterDragController(12);
assert.equal(splitter.begin({ firstSize: 20, secondSize: 20 }), true);
assert.equal(splitter.move(30, 30), true);
assert.deepEqual(splitter.cancel(), { firstSize: 20, secondSize: 20 }, 'T094-SPLIT-01 Escape restores initial geometry');
assert.equal(splitter.begin({ firstSize: 20, secondSize: 20 }), true);
assert.equal(splitter.move(25, 25), true);
assert.deepEqual(splitter.commit(), { firstSize: 25, secondSize: 25 });
const modes: string[] = [];
const terminal = new TerminalRestoration({ enterMouse: () => modes.push('enter'), leaveMouse: () => modes.push('leave'), restoreCursor: () => modes.push('cursor') });
terminal.start();
terminal.dispose();
assert.deepEqual(modes, ['enter', 'leave', 'cursor'], 'T094-TERM-01 terminal modes restore on disposal');
controls.dispose();
splitter.dispose();
console.log('T094 workbench controls passed stable identity, cached layout reads, splitter rollback/commit and terminal restoration');
