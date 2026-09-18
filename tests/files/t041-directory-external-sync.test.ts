#!/usr/bin/env bun
// T041 follow-up: a directory draft must stay in sync when a *real* Vim session edits its
// `.document` directly (the composition-root wiring in `apps/xi/src/main.ts` opens the draft
// as an ordinary buffer so native dd/yy/p/u/macros land on the document, not on `DirectoryDraft`'s
// own convenience methods). This guards the `subscribeChanges`-based sync added for that wiring.
import { strict as assert } from 'node:assert';
import { DirectoryDraft, type DirectoryDraftSourceEntry } from '../../packages/services/files/index';
import type { DirectoryDraftDocumentOpener } from '../../packages/services/files/directory-draft';
import { openTextDocument } from '../../packages/document/src/index';
import type { DocumentId, Utf16Offset } from '../../packages/contracts/src/index';

const entries: readonly DirectoryDraftSourceEntry[] = [
  { id: 'source-alpha', name: 'alpha.txt', path: '/workspace/alpha.txt' },
  { id: 'source-beta', name: 'beta.txt', path: '/workspace/beta.txt' },
];

// DirectoryDraft (a service) never opens documents itself; this test stands in for the
// workbench/composition root that owns the real document (docs/plan/01-architecture.md).
const openDraftDocument: DirectoryDraftDocumentOpener = (id, text) => {
  const opened = openTextDocument(id as DocumentId, new TextEncoder().encode(text), 41027, { fileFormat: 'unix' });
  if (opened.kind !== 'editable') return { ok: false, error: `document open failed: ${opened.kind}` };
  return { ok: true, value: opened.document };
};

function main(): void {
  const created = DirectoryDraft.create('/workspace', entries, openDraftDocument);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const draftInstance = created.value;

  // Simulate a normal Vim session's edit landing straight on the document, bypassing
  // DirectoryDraft's own `applyEdit`/`rename`/etc. entirely.
  const document = draftInstance.document;
  const committed = document.applyBatch(
    [{ start: 0 as Utf16Offset, end: 5 as Utf16Offset, text: 'renamed' }],
    document.version,
  );
  assert.equal(committed.ok, true, 'T041-SYNC-01 external document edit commits');

  const model = draftInstance.model;
  assert.equal(model.text, 'renamed.txt\nbeta.txt', 'T041-SYNC-02 draft text follows the external edit');
  assert.equal(model.rows.length, 2, 'T041-SYNC-03 row count is preserved across an external edit');
  assert.equal(model.rows[0]?.escapedName, 'renamed.txt', 'T041-SYNC-04 row escaped name reflects the external edit');
  assert.equal(model.rows[0]?.id, 'source-alpha', 'T041-SYNC-05 row identity is preserved (anchor remapped, not replaced)');

  // A subsequent native draft operation (yank) must still resolve every row correctly --
  // this is exactly what a double-processed sync (no re-entrancy guard) used to corrupt.
  const yanked = draftInstance.yank(['source-beta']);
  assert.equal(yanked.ok, true, 'T041-SYNC-06 draft methods still resolve rows after an external edit');

  console.log('T041 external-edit sync passed: document edits outside DirectoryDraft methods stay reflected in rows/model without double-processing');
}

main();
