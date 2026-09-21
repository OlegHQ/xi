import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import type { Result } from '../../packages/contracts/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { WorkbenchSession } from '../../packages/workbench/session/index';
import { BufferHost } from '../../packages/workbench/host/index';
import {
  WorkspaceEditsController,
  type LanguageCodeActionPort,
  type RenameRetryOptionsPort,
  type WorkspaceEditProposalPort,
  type WorkspaceEditProviderFailurePort,
  type WorkspaceEditProviderPort,
  type WorkspaceEditRequestPort,
} from '../../packages/workbench/language/workspace-edits';
import type { LanguageServerSessionPort } from '../../packages/workbench/language/overlays';

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T116-workspace-edit-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(documentId: DocumentId, value: string): TextFileDocument {
  const result = TextFileDocument.create(documentId, value, Array.from({ length: value.split('\n').length - 1 }, () => 'lf' as const), 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function textOf(doc: TextFileDocument): string {
  const snapshot = doc.snapshot();
  const content = snapshot.slice(0 as unknown as never, snapshot.lengthUtf16 as unknown as never);
  if (!content.ok) throw new Error(content.error.kind);
  return content.value;
}

class ReadyLanguageSession implements LanguageServerSessionPort {
  async waitForReady(): Promise<Result<unknown, { readonly message: string }>> { return { ok: true, value: undefined }; }
  supportsRequest(method: string): boolean { return method === 'textDocument/codeAction'; }
}

// -- A rename provider whose `rename` call always fails, mirroring a language server that
// cannot answer the request (e.g. project not yet indexed). --
class FailingRenameProvider implements WorkspaceEditProviderPort {
  readonly renameCalls: Array<{ readonly request: WorkspaceEditRequestPort; readonly newName: string }> = [];
  async codeActions(): Promise<Result<readonly LanguageCodeActionPort[], WorkspaceEditProviderFailurePort>> {
    return { ok: true, value: [{ id: 'quickfix', title: 'Fix value' }, { id: 'disabled', title: 'Disabled', disabledReason: 'not applicable' }] };
  }
  async prepareRename(): Promise<Result<undefined, WorkspaceEditProviderFailurePort>> { return { ok: true, value: undefined }; }
  async rename(request: WorkspaceEditRequestPort, newName: string): Promise<Result<WorkspaceEditProposalPort, WorkspaceEditProviderFailurePort>> {
    this.renameCalls.push({ request, newName });
    return { ok: false, error: { kind: 'unavailable', message: 'language server rename failed for this fixture' } };
  }
}

const launchDocumentId = id<DocumentId>('T116-workspace-edit-launch-document');
const launchDocument = document(launchDocumentId, 'const foo = 1;\n');
const session = new WorkbenchSession({ workspaceId: 'T116-workspace-edit' });
const launchViewId = id<ViewId>('T116-workspace-edit-launch-view');
session.openBuffer(launchDocument, { viewId: launchViewId, path: '/workspace/a.ts' });
const host = new BufferHost(session, launchDocument, {
  openDocument: async () => undefined,
  workspaceRelativePath: (path) => (path.startsWith('/workspace/') ? path.slice('/workspace/'.length) : undefined),
  marker: () => {},
  launchViewId,
});
host.createSession(launchDocument, launchViewId);

const errors: string[] = [];
const markers: Array<{ readonly name: string; readonly payload: unknown }> = [];
let runWorkspaceEditProposalCalls = 0;

const controller = new WorkspaceEditsController({
  host,
  session,
  filesystem: {
    readFile: async () => { throw new Error('T116-workspace-edit: readFile must not be called by this fixture'); },
    writeFileAtomic: async () => { throw new Error('T116-workspace-edit: writeFileAtomic must not be called by this fixture'); },
  },
  marker: (name, payload) => { markers.push({ name, payload }); },
  onError: (message) => { errors.push(message); },
  fileUri: (path) => `file://${path}`,
  workspaceRelativePathFromUri: (uri) => (uri.startsWith('file:///workspace/') ? uri.slice('file:///workspace/'.length) : undefined),
  workspaceAbsolutePath: (relativePath) => `/workspace/${relativePath}`,
  nextDocumentId: () => id<DocumentId>('T116-workspace-edit-next-document'),
  languageId: 'typescript',
  ensureLanguage: async () => {},
  readDiagnostics: () => [],
  // Never reached: `renameCurrent` returns before applying anything once `rename` itself fails.
  runWorkspaceEditProposal: async () => { runWorkspaceEditProposalCalls += 1; throw new Error('T116-workspace-edit: runWorkspaceEditProposal must not run for a failed rename'); },
  renameWithRetry: async (request, newName, rename, _options: RenameRetryOptionsPort | undefined) => rename(request, newName),
  ensureCodeActionExecutor: async () => undefined,
  codeActionHints: true,
});

const provider = new FailingRenameProvider();
controller.attachLanguage(new ReadyLanguageSession(), provider);
await controller.refreshCodeActionHints();
assert.equal(controller.codeActionHint(String(launchDocument.id), Number(launchDocument.version)), 1, 'T116-CODE-ACTION-HINT-UNIT-01 enabled code actions are exposed for the current document version');

// T116-WORKSPACE-EDIT-01: renaming with a provider that fails reports the failure through
// `onError`, never touches the open document, and never reaches `runWorkspaceEditProposal`.
const beforeText = textOf(launchDocument);
const renamed = await controller.renameCurrent('bar');
assert.equal(renamed, false, 'T116-WORKSPACE-EDIT-01a a failing rename provider reports failure');
assert.equal(provider.renameCalls.length, 1, 'T116-WORKSPACE-EDIT-01b the provider was asked to rename exactly once');
assert.equal(provider.renameCalls[0]?.newName, 'bar', 'T116-WORKSPACE-EDIT-01c the requested new name was forwarded');
assert.ok(errors.some((message) => message.includes('rename failed')), 'T116-WORKSPACE-EDIT-01d the failure was reported through onError');
assert.equal(runWorkspaceEditProposalCalls, 0, 'T116-WORKSPACE-EDIT-01e a failed rename never reaches runWorkspaceEditProposal');
assert.equal(textOf(launchDocument), beforeText, 'T116-WORKSPACE-EDIT-01f the open document was never mutated');

// T116-WORKSPACE-EDIT-02: prepareRename is skipped (with its own marker) when the language
// session reports the server does not support it -- `supportsRequest` returns false above.
assert.ok(markers.some((entry) => entry.name === 'XI_RENAME_PREPARE_SKIPPED'), 'T116-WORKSPACE-EDIT-02a prepareRename is skipped when unsupported');

controller.dispose();

console.log('T116 WorkspaceEditsController passed rename-failure-reports-through-onError and no-document-mutation fixtures');
