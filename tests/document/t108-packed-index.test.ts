import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type Utf16Offset } from '../../packages/primitives/src/index';
import { RopeDocument } from '../../packages/document/src/rope';

const idResult = asIdentifier<DocumentId>('T108-packed-index', 'documentId');
const documentId: DocumentId = idResult.ok
  ? idResult.value
  : (() => { throw new Error(idResult.error.message); })();

function create(text: string): RopeDocument {
  const result = RopeDocument.create(documentId, text, 41027);
  if (!result.ok) throw new Error(`document-create-failed:${result.error.kind}`);
  return result.value;
}

function checkDenseIndexIsPacked(): void {
  const text = 'x\n'.repeat(524_288);
  const document = create(text);
  const metrics = document.metrics();
  assert.equal(metrics.lineBreaks, 524_288);
  assert.equal(metrics.lineBreakIndexKind, 'packed-u16');
  assert.equal(metrics.lineBreakIndexBytes, metrics.lineBreaks * 2);
  assert.deepEqual(document.validateInvariants(), []);
}

function checkIndexSurvivesPersistentEdit(): void {
  const document = create(('left\nright\n').repeat(128));
  const before = document.snapshot();
  const beforeMetrics = document.metrics();
  const applied = document.apply({ start: 5 as Utf16Offset, end: 5 as Utf16Offset, text: '!' }, before.version);
  assert.equal(applied.ok, true);
  assert.equal(document.metrics().lineBreakIndexKind, 'packed-u16');
  assert.equal(document.metrics().lineBreakIndexBytes, beforeMetrics.lineBreakIndexBytes);
  const oldText = before.slice(0 as Utf16Offset, before.lengthUtf16 as Utf16Offset);
  assert.equal(oldText.ok, true);
  if (oldText.ok) assert.equal(oldText.value, ('left\nright\n').repeat(128));
  assert.deepEqual(document.validateInvariants(), []);
}

checkDenseIndexIsPacked();
checkIndexSurvivesPersistentEdit();
console.log('T108-PACKED-LF-INDEX-01 passed: rope newline indexes use checked Uint16 storage and remain valid across persistent edits.');
