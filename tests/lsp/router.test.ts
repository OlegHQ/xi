import { strict as assert } from 'node:assert';
import { LanguageServerRouter, type LanguageServerSession } from '../../packages/services/language/index';
import type { LanguageServerConfig } from '../../packages/services/config/index';

/** T-LSP-ROUTER: one session per configured server, requests routed by document URI. */
const servers: Record<string, LanguageServerConfig> = {
  typescript: { name: 'typescript', command: 'tsls', args: [], rootMarkers: [] },
  pyright: { name: 'pyright', command: 'pyright', args: [], rootMarkers: [] },
};
const created: string[] = [];
const requests: { readonly server: string; readonly method: string }[] = [];
function fakeSession(name: string): LanguageServerSession {
  const opened = new Set<string>();
  const listeners = new Set<(change: unknown) => void>();
  return {
    state: 'ready',
    health: { capabilities: { hoverProvider: true } },
    onStateChange: (listener: (change: unknown) => void) => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    activate: () => {},
    supportsRequest: (method: string) => method !== 'workspace/unsupported',
    request: async (method: string) => { requests.push({ server: name, method }); return name; },
    notify: async () => {},
    waitForReady: async () => ({ ok: true, value: { state: 'ready' } }),
    openDocument: (document: { uri: string }) => { opened.add(document.uri); return { ok: true, value: undefined }; },
    changeDocument: (change: { documentId: string }) => ({ ok: opened.size > 0, value: undefined, documentId: change.documentId }),
    closeDocument: (uri: string) => { opened.delete(uri); return { ok: true, value: undefined }; },
    dispose: async () => { created.push(`dispose:${name}`); },
  } as unknown as LanguageServerSession;
}
const router = new LanguageServerRouter({
  resolveServer: (languageId) => (languageId === 'typescript' ? servers.typescript : languageId === 'python' ? servers.pyright : undefined),
  createSession: (config) => { created.push(config.name); return fakeSession(config.name); },
});

assert.equal(router.hasDocument('plain-text'), false, 'plain buffers are not language-sync targets');
assert.equal(router.state, 'stopped', 'ROUTER-01 no session before any document');
assert.equal(router.supportsRequest('textDocument/hover', 'file:///a.ts'), false, 'ROUTER-01 nothing supported before open');
const markdown = router.openDocument({ uri: 'file:///README.md', languageId: 'markdown', version: 1, text: '' });
assert.equal(markdown.ok, false, 'ROUTER-02 a language with no server is rejected, not sent anywhere');
assert.deepEqual(created, [], 'ROUTER-02 no session created for markdown');

assert.ok(router.openDocument({ uri: 'file:///a.ts', documentId: 'd1', languageId: 'typescript', version: 1, text: '' }).ok);
assert.ok(router.openDocument({ uri: 'file:///b.py', documentId: 'd2', languageId: 'python', version: 1, text: '' }).ok);
assert.ok(router.openDocument({ uri: 'file:///c.ts', documentId: 'd3', languageId: 'typescript', version: 1, text: '' }).ok);
assert.deepEqual(created, ['typescript', 'pyright'], 'ROUTER-03 one session per server, reused for the second .ts');
assert.equal(router.size, 2);
assert.equal(router.hasDocument('d2'), true);

assert.equal(await router.request('textDocument/hover', { textDocument: { uri: 'file:///b.py' } }), 'pyright', 'ROUTER-04 routed by uri');
assert.equal(await router.request('textDocument/definition', { textDocument: { uri: 'file:///c.ts' } }), 'typescript');
assert.equal(await router.request('completionItem/resolve', { label: 'x' }), 'typescript', 'ROUTER-05 uri-less resolve follows the last routed request');
await assert.rejects(router.request('textDocument/hover', { textDocument: { uri: 'file:///README.md' } }), /no language server/, 'ROUTER-06 unknown uri rejects');
assert.equal(router.supportsRequest('workspace/unsupported', 'file:///a.ts'), false);
assert.equal(router.supportsRequest('textDocument/hover', 'file:///a.ts'), true);

assert.ok(router.changeDocument({ documentId: 'd2', before: 1, after: 2 } as never).ok, 'ROUTER-07 change routed by documentId');
assert.equal(router.changeDocument({ documentId: 'nope', before: 1, after: 2 } as never).ok, false);
assert.ok((await router.waitForReady('file:///b.py')).ok, 'ROUTER-08 readiness per uri');
assert.equal((await router.waitForReady('file:///zzz')).ok, false);
assert.ok(router.closeDocument('file:///b.py').ok);
assert.equal(router.hasDocument('d2'), false, 'closing releases language admission');
await assert.rejects(router.request('textDocument/hover', { textDocument: { uri: 'file:///b.py' } }), /no language server/, 'ROUTER-09 closed uri no longer routes');
await router.dispose();
assert.deepEqual(created.slice(2).sort(), ['dispose:pyright', 'dispose:typescript'], 'ROUTER-10 dispose reaches every session');

const splitCreated: string[] = [];
const splitRouter = new LanguageServerRouter({
  resolveServer: () => servers.typescript,
  sessionKey: (_config, document) => document.uri.includes('/client/') ? 'typescript\u0000client' : 'typescript\u0000workspace',
  createSession: (_config, document) => { splitCreated.push(document?.uri ?? 'missing'); return fakeSession(`split-${splitCreated.length}`); },
});
assert.ok(splitRouter.openDocument({ uri: 'file:///workspace/client/main.ts', documentId: 'client', languageId: 'typescript', version: 1, text: '' }).ok);
assert.ok(splitRouter.openDocument({ uri: 'file:///workspace/server/main.ts', documentId: 'server', languageId: 'typescript', version: 1, text: '' }).ok);
assert.equal(splitRouter.size, 2, 'ROUTER-11 one configured server can own one session per workspace root');
assert.equal(splitRouter.sessionFor('file:///workspace/client/main.ts'), splitRouter.sessions()[0], 'ROUTER-12 client URI routes to its split session');
assert.notEqual(splitRouter.sessionFor('file:///workspace/client/main.ts'), splitRouter.sessionFor('file:///workspace/server/main.ts'), 'ROUTER-12 different roots do not share a session');
await splitRouter.dispose();
console.log('T-LSP-ROUTER passed: per-server sessions, uri routing, resolve follow-up, change/close routing, readiness, dispose');
