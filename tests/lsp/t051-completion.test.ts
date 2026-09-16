import assert from 'node:assert/strict';
import { CompletionController, LanguageServerCompletionProvider, type CompletionRequest } from '../../packages/services/language/completion';
import { LanguageServerSignatureProvider, SignatureController } from '../../packages/services/language/signature';

const request: CompletionRequest = { documentId: 'doc', documentVersion: 1, selectionGeneration: 1, position: { line: 0, utf16: 3 }, trigger: 'invoked', uri: 'file:///workspace/main.ts' };
const controller = new CompletionController();
const serial = controller.begin(request);
assert.equal(controller.publish(serial, request, { isIncomplete: false, items: [
  { id: 'fn', label: 'function', detail: 'keyword', documentation: 'A function', textEdit: { start: { line: 0, utf16: 0 }, end: { line: 0, utf16: 3 }, newText: 'function' } },
  { id: 'const', label: 'const' },
  ] }), true, 'T051-LIST-01 completion list publishes');
assert.equal(controller.accept('enter').ok, true, 'T051-ENTER-01 selected item is required before Enter acceptance');
controller.move(1);
const accepted = controller.accept('tab');
assert.equal(accepted.ok, true);
if ('value' in accepted && accepted.value.kind === 'insert') assert.equal(accepted.value.item.id, 'fn');
const newline = new CompletionController();
const serial2 = newline.begin(request);
newline.publish(serial2, request, { isIncomplete: false, items: [{ id: 'x', label: 'x' }] });
const newlineResult = newline.accept('enter');
assert.equal(newlineResult.ok, true);
if (newlineResult.ok) assert.equal(newlineResult.value.kind, 'newline', 'T051-ENTER-02 Enter without selection inserts newline');
const stale = new CompletionController();
const old = stale.begin(request); stale.begin({ ...request, documentVersion: 2 });
assert.equal(stale.publish(old, request, { isIncomplete: false, items: [{ id: 'old', label: 'old' }] }), false, 'T051-STALE-01 cursor/version result cannot publish');
stale.dispose(); newline.dispose(); controller.dispose();

const requests: string[] = [];
const server = new LanguageServerCompletionProvider({
  async request<Response>(method: string): Promise<Response> {
    requests.push(method);
    if (method === 'textDocument/completion') return { isIncomplete: true, items: [{ label: 'map', detail: 'method', documentation: { kind: 'markdown', value: 'map docs' }, insertText: 'map' }, { label: 'filter', textEdit: { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'filter' }, additionalTextEdits: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, newText: 'import x from "x";\n' }] }] } as Response;
    return { label: 'map', documentation: 'resolved docs' } as Response;
  },
});
const list = await server.complete(request);
assert.equal(list.ok, true, 'T051-LSP-01 completion request decodes native list');
if (list.ok) {
  assert.equal(list.value.isIncomplete, true);
  assert.equal(list.value.items[0]?.documentation, 'map docs');
  assert.equal(list.value.items[0]?.textEdit?.newText, 'map');
  const resolved = await server.resolve(list.value.items[0]!);
  assert.equal(resolved.ok, true, 'T051-LSP-02 late completion resolve decodes documentation');
  if (resolved.ok) assert.equal(resolved.value.textEdit?.newText, 'map', 'T051-LSP-03 resolve preserves the original insertion edit');
}
assert.deepEqual(requests, ['textDocument/completion', 'completionItem/resolve']);

const overlap = new CompletionController();
const overlapSerial = overlap.begin(request);
overlap.publish(overlapSerial, request, { isIncomplete: false, items: [{ id: 'overlap', label: 'overlap', textEdit: { start: { line: 0, utf16: 0 }, end: { line: 0, utf16: 1 }, newText: 'x' }, additionalTextEdits: [{ start: { line: 0, utf16: 0 }, end: { line: 0, utf16: 2 }, newText: 'y' }] }] });
overlap.move(1);
const overlapResult = overlap.accept('tab');
assert.equal(overlapResult.ok, false, 'T051-OVERLAP-01 overlapping additional edit is rejected before mutation');
overlap.dispose();
const late = new CompletionController();
const lateSerial = late.begin(request);
late.publish(lateSerial, request, { isIncomplete: false, items: [{ id: 'late', label: 'late' }] });
late.move(1);
late.cancel();
assert.equal(late.publishResolved(request, { id: 'late', label: 'late', documentation: 'late result' }), false, 'T051-LATE-01 resolve after cancellation cannot republish');
late.dispose();

const signatureServer = new LanguageServerSignatureProvider({
  async request<Response>(): Promise<Response> {
    return { signatures: [{ label: 'map(fn)', documentation: { kind: 'markdown', value: 'signature docs' }, parameters: [{ label: 'fn', documentation: 'callback' }] }], activeSignature: 0, activeParameter: 0 } as Response;
  },
});
const signatureController = new SignatureController(signatureServer);
const signatureResult = await signatureController.request({ documentId: 'doc', documentVersion: 1, selectionGeneration: 1, position: { line: 0, utf16: 3 }, ...(request.uri === undefined ? {} : { uri: request.uri }) });
assert.equal(signatureResult.ok, true, 'T051-SIG-01 signature request decodes native help');
assert.equal(signatureController.model.signatures[0]?.parameters[0]?.documentation, 'callback');
signatureController.cancel(); signatureController.dispose();

const documentation = new CompletionController();
const documentationRequest: CompletionRequest = { ...request, documentVersion: 3, selectionGeneration: 3 };
const documentationSerial = documentation.begin(documentationRequest);
documentation.publish(documentationSerial, documentationRequest, { isIncomplete: false, items: [{ id: 'docs', label: 'docs', documentation: 'one\ntwo\nthree\nfour\nfive\nsix\nseven' }] });
documentation.move(1);
const beforeScroll = documentation.model.documentationOffset;
documentation.scrollDocumentation(1);
assert.equal(documentation.model.documentationOffset > beforeScroll, true, 'T051-DOC-01 documentation scroll advances within bounded content');
documentation.dispose();

console.log('T051 completion passed native transport decoding, resolve preservation, signature help, explicit Enter/newline semantics, selection routing, stale rejection and documentation scrolling');
