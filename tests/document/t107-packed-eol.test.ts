import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type Utf16Offset } from '../../packages/primitives/src/index';
import { LineEndingSequence, openTextDocument, type TextFileDocument } from '../../packages/document/src/index';

const idResult = asIdentifier<DocumentId>('T107-packed-eol', 'documentId');
if (!idResult.ok) throw new Error(idResult.error.message);
const documentId = idResult.value;

function open(bytes: Uint8Array): TextFileDocument {
  const result = openTextDocument(documentId, bytes);
  assert.equal(result.kind, 'editable');
  if (result.kind !== 'editable') throw new Error('unexpected-read-only-document');
  return result.document;
}

function checkUniformDenseStorage(): void {
  const bytes = new TextEncoder().encode('x\n'.repeat(524_288));
  const document = open(bytes);
  const metrics = document.lineEndingStorageMetrics();
  assert.equal(metrics.lineBreaks, 524_288);
  assert.equal(metrics.packedBytes, 0, 'uniform LF blocks carry one code, not one packed payload per line');
  assert.equal(metrics.uniformBlocks > 0, true);
  assert.equal(metrics.retainedBytes <= 65_536, true, `uniform EOL metadata: ${metrics.retainedBytes}`);
  const small = open(new TextEncoder().encode('x\r\ny\n')).snapshot();
  assert.deepEqual(small.lineEndings, ['crlf', 'lf']);
  assert.deepEqual(document.serialize(), { ok: true, value: bytes });
}

function checkAlternatingDenseStorageAndBlockEdits(): void {
  const bytes = new TextEncoder().encode('x\r\ny\n'.repeat(174_763) + 'x\r\n');
  const document = open(bytes);
  const before = document.snapshot();
  const metrics = document.lineEndingStorageMetrics();
  const packedBound = Math.ceil(metrics.lineBreaks / 4) + 65_536;
  assert.equal(metrics.packedBlocks > 0, true);
  assert.equal(metrics.retainedBytes <= packedBound, true, `alternating EOL metadata: ${metrics.retainedBytes} > ${packedBound}`);

  // 8,192 breaks fill one packed block; this insertion splits that block.
  const blockInteriorOffset = 8_194;
  const inserted = document.apply({ start: blockInteriorOffset as Utf16Offset, end: blockInteriorOffset as Utf16Offset, text: '\n' }, before.version);
  assert.equal(inserted.ok, true);
  assert.equal(document.lineEndingStorageMetrics().lineBreaks, metrics.lineBreaks + 1);
  assert.deepEqual(document.serializeSnapshot(before), { ok: true, value: bytes }, 'old packed blocks stay immutable');
  const undone = document.undo();
  assert.equal(undone.ok, true);
  assert.deepEqual(document.serialize(), { ok: true, value: bytes }, 'block split edit and undo retain exact bytes');
}

function checkPackedCodeBoundary(): void {
  assert.throws(
    () => LineEndingSequence.fromPacked(1, new Uint8Array([7])),
    /invalid-line-ending-code/u,
    'reserved packed EOL code is rejected at the storage boundary',
  );
}

checkUniformDenseStorage();
checkAlternatingDenseStorageAndBlockEdits();
checkPackedCodeBoundary();
console.log('T107-PACKED-EOL-01 passed: dense uniform and alternating metadata use packed blocks, block edits are persistent, and serialization is lossless.');
