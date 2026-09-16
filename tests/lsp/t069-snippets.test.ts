import assert from 'node:assert/strict';
import { CompletionController, LanguageServerCompletionProvider, SnippetSession, expandSnippet, type CompletionRequest } from '../../packages/services/language';

function expansion(source: string) {
  const result = expandSnippet(source);
  if (!result.ok) throw new Error(`snippet should parse (${source}): ${result.error.message}`);
  return result.value;
}

const nested = expansion('fn(${1:name}, ${2:arg})$0');
assert.equal(nested.text, 'fn(name, arg)');
assert.deepEqual(nested.tabstops.map((tabstop) => tabstop.index), [1, 2, 0], 'T069-TAB-01 final stop sorts after ordinary placeholders');
const session = new SnippetSession(nested, 3);
assert.equal(session.active?.index, 1);
assert.equal(session.next(3).ok, true); assert.equal(session.active?.index, 2);
assert.equal(session.next(2).ok, false, 'T069-STALE-01 stale cursor cannot move snippet');
assert.equal(session.next(3).ok, true); assert.equal(session.active?.index, 0);
assert.equal(session.next(3).ok, true); assert.equal(session.active, undefined, 'T069-STOP-01 final stop exits snippet mode');
session.dispose();

const mirrored = expansion('${1:foo} ${1} ${1/(.*)/${1:/upcase}/} $0');
assert.equal(mirrored.text, 'foo foo FOO ');
assert.deepEqual(mirrored.tabstops.map((tabstop) => [tabstop.index, tabstop.mirror === true, tabstop.start, tabstop.end]), [
  [1, false, 0, 3], [1, true, 4, 7], [1, true, 8, 11], [0, false, 12, 12],
], 'T069-MIRROR-01 primary, plain mirror and transformed mirror anchors are exact');
const mirroredSession = new SnippetSession(mirrored, 10);
const replacements = mirroredSession.replaceActive('bar', 10);
assert.equal(replacements.ok, true, 'T069-MIRROR-02 active placeholder plans all mirrors');
if (replacements.ok) assert.deepEqual(replacements.value, [
  { start: 0, end: 3, text: 'bar' }, { start: 4, end: 7, text: 'bar' }, { start: 8, end: 11, text: 'BAR' },
]);
assert.equal(mirroredSession.active?.end, 3);
assert.equal(mirroredSession.next(10).ok, true); assert.equal(mirroredSession.active?.index, 0);
assert.equal(mirroredSession.next(10).ok, true); assert.equal(mirroredSession.active, undefined, 'T069-MIRROR-03 mirrors do not become extra Tab stops');

const mapped = new SnippetSession(expansion('a${1:x}z'), 2);
assert.equal(mapped.mapExternalEdits([{ start: 0, end: 0, text: 'qq' }, { start: 3, end: 3, text: '!' }], 2).ok, true, 'T069-ANCHOR-01 maps one sorted external batch');
assert.deepEqual(mapped.active && [mapped.active.start, mapped.active.end], [3, 4]);
assert.equal(mapped.reanchor(4).ok, true, 'T069-GENERATION-01 selection-only movement can reanchor a live snippet');
assert.equal(mapped.next(2).ok, false, 'T069-GENERATION-02 old selection generation is rejected');
assert.equal(mapped.outsideEdit(4).ok, false, 'T069-CANCEL-01 outside edit cancels the active snippet');
assert.equal(mapped.active, undefined);

for (const invalid of ['${TM_FILENAME}', '${1/(/bad/}', '${1:unterminated']) {
  const result = expandSnippet(invalid);
  assert.equal(result.ok, false, `T069-UNSUPPORTED-${invalid} is explicit`);
}

const request: CompletionRequest = { documentId: 'doc', documentVersion: 1, selectionGeneration: 1, position: { line: 0, utf16: 0 }, trigger: 'invoked', uri: 'file:///workspace/main.ts' };
const provider = new LanguageServerCompletionProvider({
  async request<Response>(): Promise<Response> {
    return { isIncomplete: false, items: [{ label: 'function', insertText: '${1:name}($0)', insertTextFormat: 2 }] } as Response;
  },
});
const completion = await provider.complete(request);
assert.equal(completion.ok, true, 'T069-COMPLETION-01 provider accepts an advertised snippet item');
if (completion.ok) assert.equal(completion.value.items[0]?.insertTextFormat, 'snippet', 'T069-COMPLETION-02 snippet format remains explicit at the service boundary');

const controller = new CompletionController();
const serial = controller.begin(request);
controller.publish(serial, request, { isIncomplete: false, items: [{ id: 'snippet', label: 'snippet', insertTextFormat: 'snippet', textEdit: { start: { line: 0, utf16: 0 }, end: { line: 0, utf16: 0 }, newText: '${1:x}' } }] });
controller.move(1);
const accepted = controller.accept('tab');
assert.equal(accepted.ok, true); assert.equal(accepted.ok && accepted.value.kind, 'insert', 'T069-COMPLETION-03 acceptance retains the snippet item for expansion');
controller.dispose();

console.log('T069 snippets passed nested placeholders, mirrors, transforms, anchor mapping, cancellation, completion format decoding and Tab priority');
