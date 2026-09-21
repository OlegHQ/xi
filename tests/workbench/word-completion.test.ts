import assert from 'node:assert/strict';
import { asIdentifier, type DocumentId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { createWordCompletionProvider, type WorkbenchCompletionRequest } from '../../packages/workbench/language/completion';

function document(name: string, text: string): TextFileDocument {
  const id = asIdentifier<DocumentId>(name, 'word-completion-document');
  if (!id.ok) throw new Error(id.error.message);
  const created = TextFileDocument.create(id.value, text, Array.from({ length: text.split('\n').length - 1 }, () => 'lf' as const), 'lf');
  if (!created.ok) throw new Error(created.error.kind);
  return created.value;
}

const current = document('word-current', 'alpha al\n');
const other = document('word-other', 'alphabet alpine\n');
const provider = createWordCompletionProvider(() => [current.snapshot(), other.snapshot()], 2);
const request: WorkbenchCompletionRequest = {
  documentId: String(current.id),
  documentVersion: Number(current.version),
  selectionGeneration: 0,
  position: { line: 0, utf16: 8 },
  trigger: 'character',
};
const result = await provider.complete(request);
assert.equal(result.ok, true, 'WORD-COMPLETION-UNIT-01 provider returns a bounded completion list');
if (result.ok) {
  assert.deepEqual(result.value.items.map((item) => item.label), ['alpha', 'alphabet', 'alpine'], 'WORD-COMPLETION-UNIT-02 open-buffer words are deterministic and deduplicated');
  assert.equal(result.value.items[0]?.textEdit?.newText, 'pha', 'WORD-COMPLETION-UNIT-03 completion inserts only the suffix after the typed prefix');
}
console.log('Word completion provider passed bounded open-buffer indexing, deterministic ordering and suffix edits');

const longLine = document('word-long-line', 'a'.repeat(200_000) + 'zz');
let readUnits = 0;
const measured = longLine.snapshot();
const counted = new Proxy(measured, { get(target, property) {
  if (property === 'slice') return (start: Parameters<typeof measured.slice>[0], end: Parameters<typeof measured.slice>[1]) => {
    readUnits += Number(end) - Number(start);
    return measured.slice(start, end);
  };
  const value: unknown = Reflect.get(target, property, target);
  return typeof value === 'function' ? value.bind(target) : value;
} });
const bounded = createWordCompletionProvider(() => [counted, ...Array.from({ length: 100 }, () => counted)], 2);
const empty = await bounded.complete({ ...request, documentId: String(longLine.id), documentVersion: Number(longLine.version), position: { line: 0, utf16: 200_002 } });
assert.equal(empty.ok, true);
assert.ok(readUnits <= 128 * 1024 + 256, 'one completion request reads at most 128 Ki UTF-16 units across every buffer plus a bounded prefix');
readUnits = 0;
const short = document('word-short-prefix', 'zz');
const manyBuffers = createWordCompletionProvider(() => [short.snapshot(), ...Array.from({ length: 100 }, () => counted)], 2);
const noMatch = await manyBuffers.complete({ ...request, documentId: String(short.id), documentVersion: Number(short.version), position: { line: 0, utf16: 2 } });
assert.equal(noMatch.ok, true);
assert.ok(readUnits <= 128 * 1024, 'buffer count cannot multiply the total scan budget');
