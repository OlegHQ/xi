import { strict as assert } from 'node:assert';
import { TextFileDocument } from '../../packages/document/src/index';
import type { DocumentId, ViewId } from '../../packages/primitives/src/index';
import { BufferHost } from '../../packages/workbench/host';
import { WorkbenchSession } from '../../packages/workbench/session';
import { WorkbenchHostCommands } from '../../packages/workbench/commands/host-commands';

const created = TextFileDocument.create('quit-document' as DocumentId, 'alpha\n', ['lf'], 'lf');
assert.ok(created.ok);
const document = created.value;
const viewId = 'quit-view' as ViewId;
const session = new WorkbenchSession();
assert.ok(session.openBuffer(document, { viewId }).ok);
const released: string[] = [];
const host = new BufferHost(session, document, {
  onBufferClosed: buffer => released.push(String(buffer.documentId)),
  openDocument: async () => undefined, workspaceRelativePath: path => path, marker: () => {}, launchViewId: viewId,
});
host.createSession(document, viewId);
const errors: string[] = [];
const commands = new WorkbenchHostCommands({
  host, session, onError: message => errors.push(message), marker: () => {},
  filesystem: { stat: async () => ({ ok: false, error: { code: 'not-found', message: 'absent', retryable: false } }), resolvePath: (base, path) => `${base}/${path}`, directoryPath: path => path },
  workspaceRoot: '/workspace', workspacePathFromUri: () => undefined,
  ensureHostNavigation: async () => {}, readHostNavigation: () => undefined,
  workspaceEdits: { renameCurrent: async () => {}, requestCodeActions: async () => false },
  problems: { runConfiguredTask: async () => {}, listConfiguredTasks: async () => {}, cancelTask: async () => {} },
  saveCoordinator: { requestSave: async () => false, formatView: async () => false },
  directoryDrafts: { open: async () => {} },
});

const second = TextFileDocument.create('quit-second' as DocumentId, 'second\n', ['lf'], 'lf');
assert.ok(second.ok);
const secondView = 'quit-second-view' as ViewId;
assert.ok(session.openBuffer(second.value, { viewId: secondView }).ok);
host.documents.set(second.value.id, second.value);
host.createSession(second.value, secondView);
const secondLayout = session.readLayout();
assert.equal(await commands.handleWorkbenchCommand('q', secondView), 'handled');
assert.equal(session.activeViewId, viewId, 'closing a tab restores the previous buffer');
assert.notEqual(session.readLayout(), secondLayout);
assert.equal(session.readLayout().split.root?.kind, 'leaf');
assert.equal(session.buffers().length, 1);

await host.activeSession()!.handleKey({ name: 'i', raw: 'i', ctrl: false, meta: false, option: false, shift: false });
await host.activeSession()!.handleKey({ name: 'x', raw: 'x', ctrl: false, meta: false, option: false, shift: false });
await host.activeSession()!.handleKey({ name: 'escape', raw: '\x1b', ctrl: false, meta: false, option: false, shift: false });
assert.equal(await commands.handleWorkbenchCommand('q', viewId), 'handled');
assert.equal(session.buffers().length, 1, 'dirty buffer survives :q');
assert.match(errors.join(''), /unsaved changes/);
assert.equal(await commands.handleWorkbenchCommand('qa', viewId), 'handled');
const comparison = session.openComparisonView(viewId, 'Working Tree');
assert.ok(comparison.ok);
host.createSession(document, comparison.value.viewId, comparison.value.session.selections);
assert.equal(await commands.handleWorkbenchCommand('split', comparison.value.viewId), 'handled');
const splitId = session.activeViewId!;
assert.equal(await commands.handleWorkbenchCommand('q', splitId), 'handled');
assert.equal(session.activeViewId, comparison.value.viewId, 'closing a split focuses its visible sibling, not a hidden file tab');
const viewCount = session.views().length;
assert.equal(session.splitView(viewId, 'vertical').ok, false, 'a hidden view cannot be split');
assert.equal(session.views().length, viewCount, 'failed split must not register a phantom view');
assert.equal(await commands.handleWorkbenchCommand('q', comparison.value.viewId), 'handled');
assert.equal(session.activeViewId, viewId, 'closing a dirty comparison preserves its editable file buffer');
assert.deepEqual(released, ['quit-second'], 'closing shared views retains document services');
const before = session.readLayout();
assert.equal(await commands.handleWorkbenchCommand('q!', viewId), 'handled', ':q! closes last buffer without exiting');
assert.equal(session.buffers().length, 0);
assert.equal(host.sessions.size, 0);
assert.equal(host.documents.size, 0);
assert.deepEqual(released, ['quit-second', 'quit-document'], 'last-view close releases each document exactly once');
assert.notEqual(session.readLayout(), before, 'closing invalidates the painted layout');
assert.equal(session.readLayout().split.root, undefined);
assert.equal(await commands.handleWorkbenchCommand('q', viewId), 'handled', ':q in empty workbench is harmless');
assert.equal(await commands.handleWorkbenchCommand('qa', viewId), 'quit', ':qa exits empty workbench');
host.dispose();
session.dispose();
console.log('Quit buffer dirty protection, final close, empty layout and quit-all passed');
