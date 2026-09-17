import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { WorkbenchSession } from '../../packages/workbench/session/index';
import { BufferHost } from '../../packages/workbench/host/index';

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T116-host-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(documentId: DocumentId, value = 'alpha\nbeta\n'): TextFileDocument {
  const result = TextFileDocument.create(documentId, value, Array.from({ length: value.split('\n').length - 1 }, () => 'lf' as const), 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

// A tiny fake "disk": path -> document. Every openDocument() call allocates a fresh
// TextFileDocument for the requested id, matching the composition root's own openDocument
// helper (persistence-backed there, in-memory here).
const disk = new Map<string, string>([['/workspace/a.txt', 'a-content\n'], ['/workspace/b.txt', 'b-content\n']]);

const launchDocumentId = id<DocumentId>('T116-launch-document');
const launchDocument = document(launchDocumentId);
const session = new WorkbenchSession({ workspaceId: 'T116-host' });
const launchViewId = id<ViewId>('T116-launch-view');
const opened = session.openBuffer(launchDocument, { viewId: launchViewId });
assert.equal(opened.ok, true, 'T116-HOST-01 launch buffer opens');

const host = new BufferHost(session, launchDocument, {
  openDocument: async (path, documentId) => {
    const content = disk.get(path);
    return content === undefined ? undefined : document(documentId, content);
  },
  workspaceRelativePath: (path) => (path.startsWith('/workspace/') ? path.slice('/workspace/'.length) : undefined),
  marker: () => {},
  launchViewId,
});
host.createSession(launchDocument, launchViewId);

// T116-HOST-02: documents/sessions bookkeeping starts seeded with the launch buffer/session.
assert.equal(host.documents.get(launchDocumentId), launchDocument, 'T116-HOST-02a launch document is tracked');
assert.equal(host.sessions.size, 1, 'T116-HOST-02b launch session is tracked');
assert.equal(host.activeSession(), host.sessions.get(launchViewId), 'T116-HOST-02c activeSession reads the workbench active view');

// T116-HOST-03: openBufferAtPath opens a new buffer/session for an unopened path.
const firstOpen = await host.openBufferAtPath('/workspace/a.txt');
assert.ok(firstOpen !== undefined, 'T116-HOST-03a a.txt opens');
assert.equal(firstOpen?.created, true, 'T116-HOST-03b a.txt is newly created');
assert.equal(host.sessions.size, 2, 'T116-HOST-03c a new session is tracked');

// T116-HOST-04: re-requesting an already-open path focuses it instead of duplicating it.
session.focus(launchViewId);
const secondOpen = await host.openBufferAtPath('/workspace/a.txt');
assert.ok(secondOpen !== undefined, 'T116-HOST-04a a.txt resolves again');
assert.equal(secondOpen?.created, false, 'T116-HOST-04b an already-open buffer is reused, not recreated');
assert.equal(secondOpen?.viewId, firstOpen?.viewId, 'T116-HOST-04c the same view is returned');
assert.equal(session.activeViewId, firstOpen?.viewId, 'T116-HOST-04d focusing the existing buffer switches the active view');
assert.equal(host.sessions.size, 2, 'T116-HOST-04e no extra session was created');

// T116-HOST-05: discardPreviewView only closes a still-preview buffer, never a promoted one.
session.focus(launchViewId);
const previewOpen = await host.openBufferAtPath('/workspace/b.txt', { preview: true });
assert.ok(previewOpen !== undefined, 'T116-HOST-05a preview buffer opens');
const previewViewId = previewOpen?.viewId as ViewId;
session.promoteBuffer(previewOpen?.bufferId as DocumentId);
const keptDiscard = host.discardPreviewView(previewViewId);
assert.equal(keptDiscard.ok, false, 'T116-HOST-05b a promoted buffer is never discarded as a stale preview');
assert.equal(host.sessions.has(previewViewId), true, 'T116-HOST-05c the promoted session survives');

// T116-HOST-06: closeAllPanels respects `keep`, except for panels registered with alwaysClose.
let searchClosed = false;
let explorerClosed = false;
let completionClosed = false;
host.registerPanel('search', { isOpen: () => true, close: () => { searchClosed = true; } });
host.registerPanel('explorer', { isOpen: () => true, close: () => { explorerClosed = true; } });
host.registerPanel('completion', { isOpen: () => true, close: () => { completionClosed = true; }, alwaysClose: true });
host.closeAllPanels('search');
assert.equal(searchClosed, false, 'T116-HOST-06a the kept panel is left open');
assert.equal(explorerClosed, true, 'T116-HOST-06b every other open panel closes');
assert.equal(completionClosed, true, 'T116-HOST-06c an alwaysClose panel closes even though a different panel is kept');

// T116-HOST-07: dispose() releases every live session and the underlying workbench session.
host.dispose();
assert.equal(host.sessions.size, 0, 'T116-HOST-07a dispose() clears every session');
assert.equal(session.buffers().length, 0, 'T116-HOST-07b the underlying workbench session is disposed too');

console.log('T116 BufferHost passed bookkeeping, focus-reuse, preview-discard, panel-exclusivity and dispose fixtures');
