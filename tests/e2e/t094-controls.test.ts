import assert from 'node:assert/strict';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { WorkbenchSession } from '../../packages/workbench/src/index';
import { SplitterDragController, TerminalRestoration, WorkbenchControlRegistry } from '../../packages/workbench/input/controls';

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
