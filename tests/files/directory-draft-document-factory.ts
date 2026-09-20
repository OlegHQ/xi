// DirectoryDraft (a service) no longer opens documents itself
// (docs/architecture.md); tests stand in for the workbench/composition root that owns
// the real document the way `apps/xi/src/wiring/controllers.ts`'s `createDraft` does.
import { openTextDocument } from '../../packages/document/src/index';
import type { DirectoryDraftDocumentOpener } from '../../packages/services/files/directory-draft';
import type { DocumentId } from '../../packages/contracts/src/index';

export const openDraftDocument: DirectoryDraftDocumentOpener = (id, text) => {
  const opened = openTextDocument(id as DocumentId, new TextEncoder().encode(text), 41027, { fileFormat: 'unix' });
  if (opened.kind !== 'editable') return { ok: false, error: `document open failed: ${opened.kind}` };
  return { ok: true, value: opened.document };
};
