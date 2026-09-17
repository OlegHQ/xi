import assert from 'node:assert/strict';
import {
  applyWorkspaceEditProposal,
  applyWorkspaceResources,
  fileUri,
  planWorkspaceResources,
  renameWithBoundedRetry,
  serverSupportsFileOperation,
  workspacePathFromUri,
  WorkspaceEditResourceExecutor,
  type WorkspaceEditableDocument,
  type WorkspaceResourceFilesystemPort,
} from '../../packages/services/language/workspace-edit-resources';
import { WorkspaceEditCoordinator, type WorkspaceEditProposal, type WorkspaceEditTarget, type WorkspaceResourceOperation } from '../../packages/services/language/workspace-edits';
import type { CancellationToken, PlatformFailure, Result } from '../../packages/contracts/src/index';

const ROOT = '/ws';

function createFakeFilesystem(initial: Readonly<Record<string, 'file' | 'directory'>> = {}): WorkspaceResourceFilesystemPort & { readonly files: Map<string, 'file' | 'directory'> } {
  const files = new Map<string, 'file' | 'directory'>(Object.entries(initial));
  return {
    files,
    async stat(path: string): Promise<Result<{ readonly kind: 'file' | 'directory' | 'symlink' | 'other'; readonly sizeBytes: number; readonly modifiedMilliseconds: number }, PlatformFailure>> {
      const kind = files.get(path);
      return kind === undefined
        ? { ok: false, error: { code: 'ENOENT', message: `missing: ${path}`, retryable: false } }
        : { ok: true, value: { kind, sizeBytes: 0, modifiedMilliseconds: 0 } };
    },
    async writeFileAtomic(path: string): Promise<Result<void, PlatformFailure>> { files.set(path, 'file'); return { ok: true, value: undefined }; },
    async renamePath(from: string, to: string): Promise<Result<void, PlatformFailure>> {
      const kind = files.get(from);
      if (kind === undefined) return { ok: false, error: { code: 'ENOENT', message: `missing source: ${from}`, retryable: false } };
      files.delete(from);
      files.set(to, kind);
      return { ok: true, value: undefined };
    },
    async removePath(path: string): Promise<Result<void, PlatformFailure>> {
      if (!files.has(path)) return { ok: false, error: { code: 'ENOENT', message: `missing: ${path}`, retryable: false } };
      files.delete(path);
      return { ok: true, value: undefined };
    },
    workspaceRelativePath(root: string, path: string): string | undefined {
      return path === root ? '' : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined;
    },
    workspaceAbsolutePath(root: string, relativePath: string): string | undefined { return `${root}/${relativePath}`; },
  };
}

function uri(relativePath: string): string { return fileUri(`${ROOT}/${relativePath}`); }
const cancellation = { isCancelled: false } as CancellationToken;
void cancellation;

// T-WSE-COLLISION-01: a duplicated resource source is rejected before any stat/mutation semantics apply.
{
  const filesystem = createFakeFilesystem();
  const resources: WorkspaceResourceOperation[] = [{ kind: 'create', uri: uri('a.txt') }, { kind: 'create', uri: uri('a.txt') }];
  const plan = await planWorkspaceResources(resources, { workspaceRoot: ROOT, filesystem });
  assert.equal(plan.ok, false);
  if (!plan.ok) assert.equal(plan.error.kind, 'collision', 'T-WSE-COLLISION-01 duplicated resource source rejected');
}

// T-WSE-COLLISION-02: creating over an existing file without ignoreIfExists is a collision.
{
  const filesystem = createFakeFilesystem({ [`${ROOT}/exists.txt`]: 'file' });
  const plan = await planWorkspaceResources([{ kind: 'create', uri: uri('exists.txt') }], { workspaceRoot: ROOT, filesystem });
  assert.equal(plan.ok, false);
  if (!plan.ok) assert.equal(plan.error.kind, 'collision', 'T-WSE-COLLISION-02 create over existing file rejected');
}

// T-WSE-IGNORE-01: ignoreIfExists skips (does not fail) a create over an existing file.
{
  const filesystem = createFakeFilesystem({ [`${ROOT}/exists.txt`]: 'file' });
  const plan = await planWorkspaceResources([{ kind: 'create', uri: uri('exists.txt'), options: { ignoreIfExists: true } }], { workspaceRoot: ROOT, filesystem });
  assert.equal(plan.ok, true, 'T-WSE-IGNORE-01 ignoreIfExists is accepted');
  if (plan.ok) assert.equal(plan.value[0]?.skip, true, 'T-WSE-IGNORE-01 skip flag set for ignored create');
}

// T-WSE-OVERWRITE-01: a rename destination that exists is rejected without overwrite, accepted with it.
{
  const filesystem = createFakeFilesystem({ [`${ROOT}/from.txt`]: 'file', [`${ROOT}/to.txt`]: 'file' });
  const rejected = await planWorkspaceResources([{ kind: 'rename', uri: uri('from.txt'), newUri: uri('to.txt') }], { workspaceRoot: ROOT, filesystem });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.kind, 'collision', 'T-WSE-OVERWRITE-01 rename destination exists without overwrite rejected');
  const accepted = await planWorkspaceResources([{ kind: 'rename', uri: uri('from.txt'), newUri: uri('to.txt'), options: { overwrite: true } }], { workspaceRoot: ROOT, filesystem });
  assert.equal(accepted.ok, true, 'T-WSE-OVERWRITE-02 rename destination exists with overwrite accepted');
}

// T-WSE-RENAME-CYCLE-01: a<->b swap is planned and applied by breaking the cycle through a temporary path.
{
  const filesystem = createFakeFilesystem({ [`${ROOT}/a.txt`]: 'file', [`${ROOT}/b.txt`]: 'file' });
  const resources: WorkspaceResourceOperation[] = [
    { kind: 'rename', uri: uri('a.txt'), newUri: uri('b.txt'), options: { overwrite: true } },
    { kind: 'rename', uri: uri('b.txt'), newUri: uri('a.txt'), options: { overwrite: true } },
  ];
  const plan = await planWorkspaceResources(resources, { workspaceRoot: ROOT, filesystem });
  assert.equal(plan.ok, true, 'T-WSE-RENAME-CYCLE-01 a<->b swap is planned');
  if (plan.ok) {
    const renamed: Array<readonly [string, string]> = [];
    const applied = await applyWorkspaceResources(plan.value, { workspaceRoot: ROOT, filesystem, onResourcePathRenamed: (from, to) => { renamed.push([from, to]); } });
    assert.equal(applied.ok, true, 'T-WSE-RENAME-CYCLE-02 swap applies successfully');
    assert.equal(filesystem.files.has(`${ROOT}/a.txt`), true, 'T-WSE-RENAME-CYCLE-03 a.txt exists after swap (was b.txt)');
    assert.equal(filesystem.files.has(`${ROOT}/b.txt`), true, 'T-WSE-RENAME-CYCLE-04 b.txt exists after swap (was a.txt)');
    assert.ok(renamed.length >= 2, 'T-WSE-RENAME-CYCLE-05 both moves (including the temporary hop) are reported');
  }
}

// T-WSE-PARTIAL-01: a later resource failing does not roll back an earlier resource's completed effect.
{
  const filesystem = createFakeFilesystem({ [`${ROOT}/from.txt`]: 'file' });
  const resources: WorkspaceResourceOperation[] = [
    { kind: 'rename', uri: uri('from.txt'), newUri: uri('to.txt') },
    { kind: 'delete', uri: uri('missing.txt') },
  ];
  const plan = await planWorkspaceResources(resources, { workspaceRoot: ROOT, filesystem });
  assert.equal(plan.ok, false, 'T-WSE-PARTIAL-01 planning still rejects a resource on a missing target');
  // Apply the rename alone (already planned/accepted), then force a delete failure directly against
  // applyWorkspaceResources to show a partial-plan failure reports without undoing the prior rename.
  const renameOnlyPlan = await planWorkspaceResources([resources[0]!], { workspaceRoot: ROOT, filesystem });
  assert.equal(renameOnlyPlan.ok, true);
  if (renameOnlyPlan.ok) {
    const combinedPlan = [...renameOnlyPlan.value, { resource: resources[1]!, sourcePath: `${ROOT}/absent.txt`, sourceState: { kind: 'present' as const, info: { kind: 'file' as const, sizeBytes: 0, modifiedMilliseconds: 0 } }, skip: false }];
    const applied = await applyWorkspaceResources(combinedPlan, { workspaceRoot: ROOT, filesystem });
    assert.equal(applied.ok, false, 'T-WSE-PARTIAL-02 the failing delete is reported');
    if (!applied.ok) assert.equal(applied.error.kind, 'apply', 'T-WSE-PARTIAL-03 failure kind is apply, not a rollback signal');
    assert.equal(filesystem.files.has(`${ROOT}/to.txt`), true, 'T-WSE-PARTIAL-04 the earlier rename is not rolled back');
  }
}

// T-WSE-EXECUTOR-01/02: the executor dispatches to the open-document handle when a buffer is open,
// and to the unopened-file loader otherwise; a URI outside the workspace root is always stale.
{
  const filesystem = createFakeFilesystem({ [`${ROOT}/open.txt`]: 'file', [`${ROOT}/closed.txt`]: 'file' });
  const openApplied: string[] = [];
  const closedApplied: string[] = [];
  const openHandle: WorkspaceEditableDocument = {
    target: { uri: uri('open.txt'), version: 1, textLength: 10 },
    offset: (position) => ({ ok: true, value: position.utf16 }),
    async apply(edits) { openApplied.push(...edits.map((edit) => edit.uri)); return { ok: true, value: undefined }; },
  };
  const closedHandle: WorkspaceEditableDocument = {
    target: { uri: uri('closed.txt'), version: 0, textLength: 10 },
    offset: (position) => ({ ok: true, value: position.utf16 }),
    async apply(edits) { closedApplied.push(...edits.map((edit) => edit.uri)); return { ok: true, value: undefined }; },
  };
  const executor = new WorkspaceEditResourceExecutor({
    workspaceRoot: ROOT,
    filesystem,
    openDocument: (candidate) => candidate === uri('open.txt') ? openHandle : undefined,
    loadUnopenedFile: async (candidate) => candidate === uri('closed.txt') ? closedHandle : undefined,
  });
  const applied = await executor.apply(
    [{ uri: uri('open.txt'), version: 1, start: 0, end: 1, newText: 'x' }, { uri: uri('closed.txt'), version: 0, start: 0, end: 1, newText: 'y' }],
    [],
    [{ uri: uri('open.txt'), version: 1, textLength: 10 }, { uri: uri('closed.txt'), version: 0, textLength: 10 }],
  );
  assert.equal(applied.ok, true, 'T-WSE-EXECUTOR-01 mixed open/unopened edits both apply');
  assert.deepEqual(openApplied, [uri('open.txt')], 'T-WSE-EXECUTOR-01 open buffer edit dispatched to the open-document handle');
  assert.deepEqual(closedApplied, [uri('closed.txt')], 'T-WSE-EXECUTOR-01 unopened file edit dispatched to the loader');

  const outside = await executor.apply([{ uri: 'file:///outside/file.txt', version: 0, start: 0, end: 0, newText: 'x' }], []);
  assert.equal(outside.ok, false);
  if (!outside.ok) assert.equal(outside.error.kind, 'stale', 'T-WSE-EXECUTOR-02 a URI outside the workspace root is stale');
}

// T-WSE-PROPOSAL-01: applyWorkspaceEditProposal merges willCreateFiles edits, applies through the
// coordinator, then fires didCreateFiles once the coordinator reports success.
{
  const target: WorkspaceEditTarget = { uri: 'file:///ws/new.txt', version: 0, textLength: 0 };
  const appliedEdits: string[][] = [];
  const coordinator = new WorkspaceEditCoordinator({
    async preflight() { return { ok: true, value: undefined }; },
    async apply(edits) { appliedEdits.push(edits.map((edit) => edit.uri)); return { ok: true, value: undefined }; },
  });
  const events: string[] = [];
  const provider = {
    async willFileOperation(kind: 'create' | 'rename' | 'delete') {
      events.push(`will:${kind}`);
      return { ok: true as const, value: { requestId: 'will', edits: [{ uri: target.uri, version: 0, start: 0, end: 0, newText: '// header\n' }], resources: [] } };
    },
    async didFileOperation(kind: 'create' | 'rename' | 'delete') { events.push(`did:${kind}`); return { ok: true as const, value: undefined }; },
  };
  const session = { health: { capabilities: {} }, supportsRequest: () => true };
  const proposal: WorkspaceEditProposal = { requestId: 'r1', edits: [], resources: [{ kind: 'create', uri: target.uri }] };
  const applied = await applyWorkspaceEditProposal(proposal, { coordinator, provider, session, resolveTarget: async (candidate) => candidate === target.uri ? target : undefined });
  assert.equal(applied.ok, true, 'T-WSE-PROPOSAL-01 proposal with a will-hook edit applies');
  if (applied.ok) assert.equal(applied.value.applied.edits.length, 1, 'T-WSE-PROPOSAL-01 the will-hook edit is merged into the applied proposal');
  assert.deepEqual(appliedEdits, [[target.uri]], 'T-WSE-PROPOSAL-02 the coordinator receives the merged edit');
  assert.deepEqual(events, ['will:create', 'did:create'], 'T-WSE-PROPOSAL-03 will/did fire only for the resource kind present, in order');
}

// T-WSE-RETRY-01/02: renameWithBoundedRetry stops as soon as a result touches another file, and
// gives up after the configured attempts if it never does.
{
  let calls = 0;
  const requestUri = 'file:///ws/a.ts';
  const request = { documentId: 'd', uri: requestUri, version: 1, position: { line: 0, utf16: 0 } };
  const settleOnSecondCall = async () => {
    calls += 1;
    const edits = calls < 2 ? [{ uri: requestUri, version: 1, start: 0, end: 1, newText: 'x' }] : [{ uri: requestUri, version: 1, start: 0, end: 1, newText: 'x' }, { uri: 'file:///ws/b.ts', version: 1, start: 0, end: 1, newText: 'y' }];
    return { ok: true as const, value: { requestId: 'r', edits, resources: [] } };
  };
  const settled = await renameWithBoundedRetry(request, 'renamed', settleOnSecondCall, { attempts: 5, delayMs: 0 }, async () => {});
  assert.equal(calls, 2, 'T-WSE-RETRY-01 retry stops once another file is touched');
  assert.equal(settled.ok, true);
  if (settled.ok) assert.equal(settled.value.edits.length, 2);

  let neverSettles = 0;
  const alwaysSingleFile = async () => { neverSettles += 1; return { ok: true as const, value: { requestId: 'r', edits: [{ uri: requestUri, version: 1, start: 0, end: 1, newText: 'x' }], resources: [] } }; };
  await renameWithBoundedRetry(request, 'renamed', alwaysSingleFile, { attempts: 3, delayMs: 0 }, async () => {});
  assert.equal(neverSettles, 4, 'T-WSE-RETRY-02 exactly attempts+1 calls are made when the result never widens');
}

// T-WSE-CAPABILITY-01: serverSupportsFileOperation prefers supportsRequest, falls back to a raw capability record.
{
  assert.equal(serverSupportsFileOperation({ health: { capabilities: {} }, supportsRequest: () => true }, 'rename', 'will'), true, 'T-WSE-CAPABILITY-01 supportsRequest negotiation wins');
  assert.equal(serverSupportsFileOperation({ health: { capabilities: { workspace: { fileOperations: { willRename: {} } } } } }, 'rename', 'will'), true, 'T-WSE-CAPABILITY-02 capability record fallback');
  assert.equal(serverSupportsFileOperation({ health: { capabilities: {} } }, 'rename', 'will'), false, 'T-WSE-CAPABILITY-03 no negotiation and no record means unsupported');
}

assert.equal(workspacePathFromUri('file:///ws/a.txt'), '/ws/a.txt', 'T-WSE-URI-01 file URI decodes to an absolute path');
assert.equal(workspacePathFromUri('http://example.com/a'), undefined, 'T-WSE-URI-02 a non-file URI is rejected');
assert.equal(fileUri('/ws/a b.txt'), 'file:///ws/a%20b.txt', 'T-WSE-URI-03 path segments are percent-encoded');

console.log('T-WSE workspace-edit-resources passed plan/apply resource semantics, executor dispatch, proposal negotiation, rename retry and URI helpers');
