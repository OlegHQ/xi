import assert from 'node:assert/strict';
import { HierarchyController, LanguageServerHierarchyProvider, type HierarchyItem, type HierarchyProvider } from '../../packages/services/language/hierarchy';
import type { NavigationRequest } from '../../packages/services/language/navigation';

const request: NavigationRequest = { documentId: 'd', documentVersion: 1, selectionGeneration: 1, position: { line: 0, utf16: 0 }, uri: 'file:///a.ts' };
const location = (uri = 'file:///a.ts') => ({ uri, startLine: 0, startUtf16: 0, endLine: 0, endUtf16: 1 });
const item = (id: string, name = id, children: readonly HierarchyItem[] = []): HierarchyItem => ({ id, name, kind: 12, uri: 'file:///a.ts', range: location(), selectionRange: location(), children });

const cycle = item('root', 'root-again');
const cyclicChild = item('child', 'child', [cycle]);
const cycleRoot = item('root', 'root', [cyclicChild]);
const provider: HierarchyProvider = {
  async prepare() { return { ok: true, value: Object.freeze([cycleRoot]) }; },
  async children() { return { ok: true, value: Object.freeze([item('root', 'root-again')]) }; },
  async links() { return { ok: true, value: Object.freeze([{ target: 'file:///b.ts', range: location() }]) }; },
};
const controller = new HierarchyController(provider);
const hierarchy = await controller.load(request);
assert.equal(hierarchy.ok, true, 'T070-HIER-01 hierarchy loads');
assert.equal(controller.model.state, 'ready', 'T070-HIER-02 loaded hierarchy exposes ready state');
assert.equal(controller.items[0]?.children[0]?.children[0]?.cycle, true, 'T070-CYCLE-01 recursive hierarchy identity is marked and not traversed forever');
const expanded = await controller.expand('root', request, 'outgoing');
assert.equal(expanded.ok, true, 'T070-HIER-03 lazy child expansion uses the stable item identity');
assert.equal(controller.items[0]?.children[0]?.name, 'root-again', 'T070-HIER-04 lazy expansion replaces only the selected node children');
const links = await controller.loadLinks(request);
assert.equal(links.ok, true, 'T070-LINK-01 file links load');
if (links.ok) assert.equal(controller.openLink(links.value[0]!).ok, true, 'T070-LINK-02 opening a link is an explicit safe host action');

const providerWithoutChildren: HierarchyProvider = { prepare: provider.prepare, links: provider.links };
const unavailable = new HierarchyController(providerWithoutChildren);
const unavailableResult = await unavailable.expand('root', request);
assert.equal(unavailableResult.ok, false, 'T070-CAPABILITY-01 unavailable hierarchy expansion is explicit');
if (!unavailableResult.ok) assert.equal(unavailableResult.error.kind, 'unsupported');

let resolvePrepare: ((value: { ok: true; value: readonly HierarchyItem[] }) => void) | undefined;
const pending = new HierarchyController({ ...provider, prepare: async () => new Promise((resolve) => { resolvePrepare = resolve; }) });
const loading = pending.load(request);
const origin = pending.cancel();
assert.deepEqual(origin, request, 'T070-CANCEL-01 cancellation returns the original navigation request');
resolvePrepare?.({ ok: true, value: Object.freeze([item('late')]) });
const cancelled = await loading;
assert.equal(cancelled.ok, false, 'T070-CANCEL-02 cancelled hierarchy cannot republish a late response');
if (!cancelled.ok) assert.equal(cancelled.error.kind, 'stale');

const unsafe = new HierarchyController({ ...provider, links: async () => ({ ok: true, value: Object.freeze([{ target: 'javascript:alert(1)', range: location() }]) }) });
const bad = await unsafe.loadLinks(request);
assert.equal(bad.ok, false, 'T070-LINK-FAIL-01 unsafe JavaScript target is rejected');
if (!bad.ok) assert.equal(bad.error.kind, 'unsafe-link');
const control = unsafe.openLink({ target: 'https://example.test/%1b[31m', range: location() });
assert.equal(control.ok, false, 'T070-LINK-FAIL-02 encoded terminal control target is rejected');

const requests: string[] = [];
const server = new LanguageServerHierarchyProvider({
  async request<Response>(method: string): Promise<Response> {
    requests.push(method);
    if (method === 'textDocument/prepareCallHierarchy') return [{ name: 'caller', kind: 12, uri: 'file:///a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, data: { token: 1 } }] as Response;
    if (method === 'callHierarchy/outgoingCalls') return [{ to: { name: 'callee', kind: 12, uri: 'file:///a.ts', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } }, selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } } } }] as Response;
    if (method === 'textDocument/documentLink') return [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, target: 'file:///b.ts' }] as Response;
    return { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, target: 'https://example.test/docs' } as Response;
  },
});
const call = await server.prepare(request);
assert.equal(call.ok, true, 'T070-LSP-01 call hierarchy preparation decodes native items');
if (call.ok) {
  const child = await server.children(request, call.value[0]!, 'outgoing');
  assert.equal(child.ok, true, 'T070-LSP-02 outgoing hierarchy relation decodes lazily');
}
const serverLinks = await server.links(request);
assert.equal(serverLinks.ok, true, 'T070-LSP-03 document-link ranges decode with the request URI');
if (serverLinks.ok) {
  const resolved = await server.resolveLink(request, serverLinks.value[0]!);
  assert.equal(resolved.ok, true, 'T070-LSP-04 document-link resolve remains a separate request');
  assert.equal(resolved.ok && resolved.value.target, 'https://example.test/docs');
}
assert.deepEqual(requests, ['textDocument/prepareCallHierarchy', 'callHierarchy/outgoingCalls', 'textDocument/documentLink', 'documentLink/resolve']);

controller.dispose(); unavailable.dispose(); pending.dispose(); unsafe.dispose();
console.log('T070 hierarchy/document links passed lazy call hierarchy, cycle handling, cancellation, capability state, safe explicit links and native LSP decoding');
