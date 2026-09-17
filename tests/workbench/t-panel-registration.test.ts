import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { WorkbenchSession } from '../../packages/workbench/session/index';
import { BufferHost } from '../../packages/workbench/host/index';

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'panel-registration-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const launchDocumentId = id<DocumentId>('panel-registration-launch-document');
const created = TextFileDocument.create(launchDocumentId, 'alpha\n', ['lf'], 'lf');
if (!created.ok) throw new Error(created.error.kind);
const launchDocument = created.value;

const session = new WorkbenchSession({ workspaceId: 'panel-registration-host' });
const launchViewId = id<ViewId>('panel-registration-launch-view');
const opened = session.openBuffer(launchDocument, { viewId: launchViewId });
assert.equal(opened.ok, true, 'launch buffer opens');

const host = new BufferHost(session, launchDocument, {
  openDocument: async () => undefined,
  workspaceRelativePath: () => undefined,
  marker: () => {},
  launchViewId,
});

// closeAllPanels('a') must close every other registered panel, including 'b', while leaving
// the kept panel ('a') open -- registering two panels is enough to prove that.
let aClosed = false;
let bClosed = false;
host.registerPanel('a', { isOpen: () => true, close: () => { aClosed = true; } });
host.registerPanel('b', { isOpen: () => true, close: () => { bClosed = true; } });
host.closeAllPanels('a');
assert.equal(aClosed, false, 'the kept panel is left open');
assert.equal(bClosed, true, 'the other panel is closed');

console.log('panel-registration: closeAllPanels(a) closes b, keeps a open');
