import { strict as assert } from 'node:assert';
import { asIdentifier, asUtf16Offset, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { WorkbenchSession } from '../../packages/workbench/session/index';

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'G2-close-async-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function offset(value: number) {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function document(documentId: DocumentId, value = 'alpha\n'): TextFileDocument {
  const result = TextFileDocument.create(documentId, value, ['lf'], 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function scenario(name: 'closeViewAsync' | 'closeBufferAsync'): Promise<void> {
  const documentId = id<DocumentId>(`G2-${name}-document`);
  const doc = document(documentId);
  const viewId = id<ViewId>(`G2-${name}-view`);

  const session = new WorkbenchSession({
    workspaceId: `G2-${name}`,
    // Simulates the real save path: it captures the document's revision, does slow I/O, and
    // only marks that exact revision saved -- exactly like SaveCoordinator's persistence.saveFile
    // + document.markSaved(). While the write is "in flight" (the sleep), a keystroke commits a
    // second edit to the very same buffer, as if the user kept typing during the save.
    saveBuffer: async () => {
      const revisionAtSaveStart = doc.revisionId;
      await sleep(10);
      const secondEdit = doc.apply({ start: offset(0), end: offset(0), text: 'X' }, doc.version);
      if (!secondEdit.ok) throw new Error(`G2 setup: mid-save edit failed: ${secondEdit.error.kind}`);
      const marked = doc.markSaved({ id: documentId, revisionId: revisionAtSaveStart });
      if (!marked.ok) throw new Error(`G2 setup: markSaved failed: ${marked.error.kind}`);
      return { ok: true, value: undefined };
    },
  });
  const opened = session.openBuffer(doc, { viewId, path: '/workspace/a.txt' });
  assert.equal(opened.ok, true, `G2-${name}-00 buffer opens`);

  // Make the buffer dirty so 'save' is the exercised decision path.
  const initialEdit = await session.applyTextEdits(viewId, [{ start: offset(5), end: offset(5), text: '!' }]);
  assert.equal(initialEdit.ok, true, `G2-${name}-01 the initial edit applies`);
  assert.equal(doc.isDirty, true, `G2-${name}-02 the buffer is dirty before closing`);

  const closed = name === 'closeViewAsync'
    ? await session.closeViewAsync(viewId, 'save')
    : await session.closeBufferAsync(documentId, 'save');

  // The mid-save edit landed after `saveBuffer` captured its revision, so the buffer is dirty
  // again once the save settles. The old code discarded unconditionally here, losing that edit;
  // the fix must refuse to close (so the caller re-prompts) instead of discarding it.
  assert.equal(closed.ok, false, `G2-${name}-03 close is refused because an edit committed during the save`);
  if (!closed.ok) assert.equal(closed.error.kind, 'dirty-buffer', `G2-${name}-04 the failure re-prompts as a dirty buffer, not a silent discard`);
  assert.equal(doc.isDirty, true, `G2-${name}-05 the buffer (and its unsaved mid-save edit) is still open and dirty`);
}

await scenario('closeViewAsync');
await scenario('closeBufferAsync');

console.log('G2 closeViewAsync/closeBufferAsync mid-save-edit fixtures passed');
