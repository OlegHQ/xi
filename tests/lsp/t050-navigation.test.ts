import assert from 'node:assert/strict';
import { LanguageNavigationController, LanguageServerNavigationProvider, type LanguageSymbol, type NavigationFailure, type NavigationProvider, type NavigationRequest } from '../../packages/services/language/navigation';
import type { Result } from '../../packages/contracts/src/index';

const request: NavigationRequest = { documentId: 'doc', documentVersion: 1, selectionGeneration: 1, position: { line: 0, utf16: 0 } };
const pending: Array<(value: Result<readonly LanguageSymbol[], NavigationFailure>) => void> = [];
const provider: NavigationProvider = {
  definition: async () => ({ ok: true, value: Object.freeze([{ uri: 'file:///target.ts', startLine: 1, startUtf16: 0, endLine: 1, endUtf16: 2 }]) }),
  hover: async () => ({ ok: true, value: { markdown: 'docs' } }),
  symbols: async () => new Promise((resolve) => { pending.push(resolve); }),
};
const controller = new LanguageNavigationController(provider);
const first = controller.loadOutline(request);
const second = controller.loadOutline({ ...request, documentVersion: 2 });
pending[1]?.({ ok: true, value: Object.freeze([]) });
const latest = await second;
assert.equal(latest.ok, true, 'T050-OUTLINE-01 latest outline publishes');
pending[0]?.({ ok: true, value: Object.freeze([{ id: 'old', name: 'Old', kind: 12, range: { uri: 'file:///old', startLine: 0, startUtf16: 0, endLine: 0, endUtf16: 1 }, children: Object.freeze([]) }]) });
const stale = await first;
assert.equal(stale.ok, false, 'T050-OUTLINE-02 out-of-order outline cannot replace active model');
const hover = await controller.requestHover(request);
assert.equal(hover.ok, true);
const definition = await controller.definition(request);
assert.equal(definition.ok, true, 'T050-NAV-01 definition returns workspace URI');
controller.dispose();

const calls: string[] = [];
const lsp = new LanguageServerNavigationProvider({
  request: async <T>(method: string): Promise<T> => {
    calls.push(method);
    const response: unknown = method === 'textDocument/definition'
      ? [{ uri: 'file:///target.ts', range: { start: { line: 2, character: 1 }, end: { line: 2, character: 5 } } }]
      : method === 'textDocument/hover'
        ? { contents: [{ language: 'typescript', value: 'const value = 1' }, { value: 'docs' }] }
        : [{ name: 'render', detail: 'function', kind: 12, location: { uri: 'file:///main.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } }, children: [] }];
    return response as T;
  },
});
const lspRequest: NavigationRequest = { ...request, uri: 'file:///main.ts' };
const parsedDefinition = await lsp.definition(lspRequest);
assert.equal(parsedDefinition.ok && parsedDefinition.value[0]?.startLine, 2, 'T050-LSP-01 live definition response is normalized');
const parsedHover = await lsp.hover(lspRequest);
assert.equal(parsedHover.ok && parsedHover.value.markdown.includes('docs'), true, 'T050-LSP-02 hover markup is normalized');
const parsedSymbols = await lsp.symbols(lspRequest);
assert.equal(parsedSymbols.ok && parsedSymbols.value[0]?.name, 'render', 'T050-LSP-03 document symbols are normalized');
assert.deepEqual(calls, ['textDocument/definition', 'textDocument/hover', 'textDocument/documentSymbol'], 'T050-LSP-04 provider uses native LSP methods');

const externalController = new LanguageNavigationController({ ...provider, definition: async () => ({ ok: true, value: Object.freeze([{ uri: 'https://example.test/docs', startLine: 0, startUtf16: 0, endLine: 0, endUtf16: 1 }]) }) });
const external = await externalController.definition({ ...lspRequest });
assert.equal(external.ok, false, 'T050-EXTERNAL-URI-01 external definition is rejected');
externalController.dispose();
console.log('T050 navigation passed live LSP response decoding, stale outline suppression, hover/definition return, external URI rejection and explicit no-LSP model states');
