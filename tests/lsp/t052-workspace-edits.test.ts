import assert from 'node:assert/strict';
import { executeLanguageCodeAction, LanguageServerWorkspaceEditProvider, WorkspaceEditCoordinator, type WorkspaceEditPort } from '../../packages/services/language/workspace-edits';
import type { WorkspaceEditFailure } from '../../packages/services/language/workspace-edits';
import { CancellationSource, type CancellationToken, type Result } from '../../packages/contracts/src/index';

const applied: string[] = [];
const port: WorkspaceEditPort = { async preflight() { return { ok: true, value: undefined }; }, async apply(edits, resources) { applied.push(`${edits.length}:${resources.length}`); return { ok: true, value: undefined }; } };
const coordinator = new WorkspaceEditCoordinator(port);
const target = { uri: 'file:///a', version: 3, textLength: 20 };
const valid = await coordinator.apply({ requestId: 'r', edits: [{ uri: 'file:///a', version: 3, start: 0, end: 1, newText: 'x' }], resources: [] }, [target]);
assert.equal(valid.ok, true, 'T052-APPLY-01 valid edit applies once'); assert.deepEqual(applied, ['1:0']);
const stale = await coordinator.apply({ requestId: 'stale', edits: [{ uri: 'file:///a', version: 2, start: 0, end: 1, newText: 'x' }] }, [target]); assert.equal(stale.ok, false, 'T052-STALE-01 stale version rejected before mutation');
const overlap = await coordinator.apply({ requestId: 'overlap', edits: [{ uri: 'file:///a', version: 3, start: 0, end: 3, newText: 'x' }, { uri: 'file:///a', version: 3, start: 2, end: 4, newText: 'y' }] }, [target]); assert.equal(overlap.ok, false, 'T052-OVERLAP-01 overlap rejected');
const collision = await coordinator.apply({ requestId: 'collision', edits: [], resources: [{ kind: 'rename', uri: 'file:///a', newUri: 'file:///b' }, { kind: 'rename', uri: 'file:///c', newUri: 'file:///b' }] }, [target]); assert.equal(collision.ok, false, 'T052-COLLISION-01 resource collision rejected');
const chain = await coordinator.apply({ requestId: 'chain', edits: [], resources: [{ kind: 'rename', uri: 'file:///a', newUri: 'file:///b' }, { kind: 'rename', uri: 'file:///b', newUri: 'file:///c' }] }, [target]); assert.equal(chain.ok, true, 'T052-CHAIN-01 rename chains are admitted for ordered filesystem resolution');
coordinator.dispose();

const provider = new LanguageServerWorkspaceEditProvider({
  session: {
    async request<Response>(method: string): Promise<Response> {
      if (method === 'textDocument/codeAction') return [{ title: 'Fix import', kind: 'quickfix', edit: { changes: { 'file:///a': [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'z' }] } } }] as Response;
      if (method === 'textDocument/prepareRename') return { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, placeholder: 'x' } as Response;
      return { changes: { 'file:///a': [{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, newText: 'renamed' }] } } as Response;
    },
  },
  target: (uri) => uri === 'file:///a' ? target : undefined,
  offset: (uri, position) => uri === 'file:///a' && position.line === 0 && position.utf16 >= 0 && position.utf16 <= 20 ? { ok: true, value: position.utf16 } : { ok: false, error: { kind: 'invalid', message: 'position outside fixture' } },
});
const actions = await provider.codeActions({ documentId: 'doc', uri: 'file:///a', version: 3, position: { line: 0, utf16: 0 } });
const cancellation = new CancellationSource();
let forwarded: CancellationToken | undefined;
const cancellableProvider = new LanguageServerWorkspaceEditProvider({
  session: { async request<Response>(_method: string, _params?: unknown, token?: CancellationToken): Promise<Response> { forwarded = token; return [] as Response; } },
  target: () => undefined,
  offset: () => ({ ok: false, error: { kind: 'stale', message: 'closed' } }),
});
await cancellableProvider.codeActions({ documentId: 'doc', uri: 'file:///a', version: 3, position: { line: 0, utf16: 0 }, cancellation: cancellation.token });
assert.equal(forwarded, cancellation.token, 'code-action cancellation reaches the LSP request');
cancellation.dispose();
assert.equal(actions.ok, true, 'T052-LSP-01 native code action edit decodes to absolute ranges');
if (actions.ok) assert.equal(actions.value[0]?.edit?.edits[0]?.start, 0);
const commandProvider = new LanguageServerWorkspaceEditProvider({
  session: { async request<Response>(method: string): Promise<Response> { return (method === 'textDocument/codeAction' ? [{ title: 'Fix then command', edit: { changes: { 'file:///a': [] } }, command: { title: 'Run unsupported', command: 'example.unsupported', arguments: [] } }] : null) as Response; } },
  target: (uri) => uri === 'file:///a' ? target : undefined,
  offset: () => ({ ok: true, value: 0 }),
});
const commandActions = await commandProvider.codeActions({ documentId: 'doc', uri: 'file:///a', version: 3, position: { line: 0, utf16: 0 } });
assert.equal(commandActions.ok, true, 'T052-COMMAND-01 code action preserves a command alongside an edit');
if (commandActions.ok) {
  const order: string[] = [];
  const action = commandActions.value[0];
  assert.ok(action !== undefined);
  if (action !== undefined) {
    const executed = await executeLanguageCodeAction(action, {
      async apply() { order.push('edit'); return { ok: true, value: undefined }; },
      async execute() { order.push('command'); return { ok: false, error: { kind: 'unsupported', message: 'unsupported command' } }; },
    });
    assert.equal(executed.ok, false, 'T052-COMMAND-02 unsupported command reports failure after edit');
    assert.deepEqual(order, ['edit', 'command'], 'T052-COMMAND-03 edit is applied before command execution');
  }
}
const hookEvents: string[] = [];
const hookProvider = new LanguageServerWorkspaceEditProvider({
  session: {
    async request<Response>(method: string): Promise<Response> {
      hookEvents.push(method);
      return { changes: { 'file:///a': [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '// renamed\n' }] } } as Response;
    },
    async notify(method: string): Promise<void> { hookEvents.push(method); },
  },
  target: (uri) => uri === 'file:///a' ? target : undefined,
  offset: () => ({ ok: true, value: 0 }),
});
const willRename = await hookProvider.willFileOperation('rename', [{ kind: 'rename', uri: 'file:///a', newUri: 'file:///b' }]);
assert.equal(willRename.ok, true, 'T052-HOOK-01 willRenameFiles workspace edit decodes');
const didRename = await hookProvider.didFileOperation('rename', [{ kind: 'rename', uri: 'file:///a', newUri: 'file:///b' }]);
assert.equal(didRename.ok, true, 'T052-HOOK-02 didRenameFiles notification is sent after apply');
assert.deepEqual(hookEvents, ['workspace/willRenameFiles', 'workspace/didRenameFiles'], 'T052-HOOK-03 file hooks preserve will/did order');
const prepared = await provider.prepareRename({ documentId: 'doc', uri: 'file:///a', version: 3, position: { line: 0, utf16: 1 } });
assert.equal(prepared.ok, true, 'T052-LSP-02 prepare rename decodes and validates range');
if (prepared.ok) assert.deepEqual(prepared.value, { start: 1, end: 2, placeholder: 'x' });
const renamed = await provider.rename({ documentId: 'doc', uri: 'file:///a', version: 3, position: { line: 0, utf16: 1 } }, 'renamed');
assert.equal(renamed.ok, true, 'T052-LSP-03 rename workspace edit decodes');
const outside = await new LanguageServerWorkspaceEditProvider({ session: { async request<Response>(): Promise<Response> { return { changes: { 'file:///outside': [] } } as Response; } }, target: () => undefined, offset: () => ({ ok: false, error: { kind: 'stale', message: 'closed' } }) }).rename({ documentId: 'doc', uri: 'file:///a', version: 3, position: { line: 0, utf16: 0 } }, 'x');
assert.equal(outside.ok, false, 'T052-OUTSIDE-01 workspace edit outside the admitted root is rejected');
console.log('T052 workspace edits passed native code-action/prepare-rename/rename decoding, version/range preflight, overlap/resource collision and single apply ordering');
