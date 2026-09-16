import assert from 'node:assert/strict';
import { asIdentifier, asUndoGroupId, asUtf16Offset, type DocumentId, type UndoGroupId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument, type DocumentEdit } from '../../packages/document/src/index';
import { WorkbenchSession } from '../../packages/workbench/src/index';
import { createOwnedVimSession } from '../../packages/workbench/vim-session/index';
import { expandSnippet } from '../../packages/services/language/index';

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T069-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function group(value: string): UndoGroupId {
  const result = asUndoGroupId(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function document(): TextFileDocument {
  const result = TextFileDocument.create(id<DocumentId>('T069-document'), '', [], 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}
function edit(start: number, end: number, text: string): DocumentEdit {
  const first = asUtf16Offset(start); const last = asUtf16Offset(end);
  if (!first.ok || !last.ok) throw new Error('invalid fixture edit');
  return { start: first.value, end: last.value, text };
}
function text(workbench: WorkbenchSession, viewId: ViewId): string {
  const view = workbench.readView(viewId);
  if (view === undefined) throw new Error('missing view');
  const first = asUtf16Offset(0); const last = asUtf16Offset(view.document.lengthUtf16);
  if (!first.ok || !last.ok) throw new Error('invalid read range');
  const result = view.document.slice(first.value, last.value);
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

const source = document();
const viewId = id<ViewId>('T069-view');
let engine: ReturnType<typeof createOwnedVimSession> | undefined;
const workbench = new WorkbenchSession({
  onDocumentChange: (change) => engine?.applyExternalChange(change),
});
const opened = workbench.openBuffer(source, { path: '/workspace/T069.ts', viewId });
assert.equal(opened.ok, true, 'T069-WORKBENCH-01 completion opens through the workbench owner');
if (!opened.ok) throw new Error('completion workbench could not open its fixture');
engine = createOwnedVimSession(source, {
  viewId,
  onStateChange: (state) => { workbench.syncViewSession(viewId, state.selections, state.mode); },
});
assert.equal(engine.handleKey({ name: 'i', raw: 'i', shift: false, option: false, ctrl: false, meta: false }), true);
const snippet = expandSnippet('${1:x}($0)');
assert.equal(snippet.ok, true);
if (!snippet.ok) throw new Error('completion snippet fixture did not parse');
const completionGroup = group('T069-completion-group');
assert.equal(engine.closeInsertUndoGroup(), true, 'T069-WORKBENCH-02 active Vim insert group hands history to completion');
assert.equal(workbench.beginUndoGroup(viewId, completionGroup, 'lsp').ok, true, 'T069-WORKBENCH-02 completion owns one persistent service undo group');
const inserted = await workbench.applyTextEdits(viewId, [edit(0, 0, snippet.value.text)], completionGroup, 'lsp');
assert.equal(inserted.ok, true, 'T069-WORKBENCH-02 completion insertion uses the atomic workbench coordinator');
assert.equal(text(workbench, viewId), 'x()', 'T069-WORKBENCH-03 completion text is committed once');
assert.equal(engine.setInsertCursor(0), true, 'T069-WORKBENCH-04 snippet field reanchors the owned Vim insert caret');
const replaced = await workbench.applyTextEdits(viewId, [edit(0, 1, 'y')], completionGroup, 'lsp');
assert.equal(replaced.ok, true, 'T069-WORKBENCH-05 completion field replacement remains versioned');
assert.equal(text(workbench, viewId), 'y()', 'T069-WORKBENCH-06 replacement preserves surrounding completion text');
assert.equal(workbench.endUndoGroup(viewId, completionGroup).ok, true, 'T069-WORKBENCH-07 completion group closes after snippet typing');
assert.equal(engine.handleKey({ name: 'escape', raw: '\u001b', shift: false, option: false, ctrl: false, meta: false }), true);
assert.equal(engine.handleKey({ name: 'u', raw: 'u', shift: false, option: false, ctrl: false, meta: false }), true, 'T069-WORKBENCH-08 Vim undo remains available after service insertion');
assert.equal(text(workbench, viewId), '', 'T069-WORKBENCH-09 one completion undo group restores the original document');
workbench.dispose();
console.log('T069 completion workbench passed atomic insertion, owned selection mapping, replacement and Vim undo continuity');
