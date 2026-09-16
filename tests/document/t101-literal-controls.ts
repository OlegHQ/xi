import { strict as assert } from 'node:assert';
import {
  asIdentifier,
  type DocumentId,
  type Utf16Offset,
} from '../../packages/primitives/src/index';
import {
  createDocumentAnchor,
  openTextDocument,
  TextFileDocument,
  type DocumentChangeMap,
  type TextFileFormat,
} from '../../packages/document/src/index';

const documentIdResult = asIdentifier<DocumentId>('T101-literal-control', 'documentId');
if (!documentIdResult.ok) throw new Error(documentIdResult.error.message);
const documentId = documentIdResult.value;
const offset = (value: number): Utf16Offset => value as Utf16Offset;
const encoder = new TextEncoder();

function read(document: TextFileDocument): string {
  const snapshot = document.snapshot();
  const result = snapshot.slice(offset(0), offset(snapshot.lengthUtf16));
  if (!result.ok) throw new Error(`T101-read:${result.error.kind}`);
  return result.value;
}

function bytes(document: TextFileDocument): Uint8Array {
  const result = document.serialize();
  if (!result.ok) throw new Error(`T101-serialize:${result.error.kind}`);
  return result.value;
}

function openEditable(source: string, fileFormat?: 'auto' | 'unix' | 'dos' | 'mac' | 'legacy'): TextFileDocument {
  const opened = openTextDocument(
    documentId,
    encoder.encode(source),
    41027,
    fileFormat === undefined ? {} : { fileFormat },
  );
  if (opened.kind !== 'editable') throw new Error(`T101-open:${opened.document.reason}`);
  return opened.document;
}

function checkLiteralCrMetadataUndoAndReopen(): void {
  const document = openEditable('A\r\nB\r\nC');
  const before = document.snapshot();
  const leftResult = createDocumentAnchor(before, offset(3), 'left');
  const rightResult = createDocumentAnchor(before, offset(3), 'right');
  assert.equal(leftResult.ok, true);
  assert.equal(rightResult.ok, true);
  if (!leftResult.ok || !rightResult.ok) throw new Error('T101-anchor-create');
  let changeMap: DocumentChangeMap | undefined;
  document.subscribeChanges((change) => { changeMap = change.changeMap; });

  const inserted = document.apply({
    start: offset(3),
    end: offset(3),
    text: '\r',
    textIntent: 'literal-control',
  }, before.version);
  assert.equal(inserted.ok, true);
  assert.equal(read(document), 'A\nB\r\nC');
  assert.equal(document.snapshot().lineCount, 3, 'literal CR content does not split a logical line');
  assert.equal(document.snapshot().lineEndings.join(','), 'crlf,crlf');
  assert.deepEqual(bytes(document), encoder.encode('A\r\nB\r\r\nC'));

  assert.ok(changeMap);
  const mapped = changeMap.mapSortedAnchors([leftResult.value, rightResult.value]);
  assert.equal(mapped.ok, true);
  if (mapped.ok) assert.deepEqual(mapped.value.map((anchor) => anchor.offset as number), [3, 4]);

  const currentBytes = bytes(document);
  const history = document.serializeUndoHistory();
  if (!history.ok) throw new Error(`T101-history:${history.error.kind}`);
  const reopened = openTextDocument(documentId, currentBytes, 41027, { fileFormat: 'dos' });
  assert.equal(reopened.kind, 'editable');
  if (reopened.kind !== 'editable') throw new Error('T101-explicit-reopen');
  assert.equal(read(reopened.document), 'A\nB\r\nC');
  assert.deepEqual(bytes(reopened.document), currentBytes, 'explicit DOS fileformat preserves literal CR beside CRLF endings');
  assert.equal(reopened.document.restoreUndoHistory(history.value).ok, true);
  assert.equal(reopened.document.undo().ok, true);
  assert.equal(read(reopened.document), 'A\nB\nC');
  assert.deepEqual(bytes(reopened.document), encoder.encode('A\r\nB\r\nC'));
  assert.equal(reopened.document.redo().ok, true);
  assert.equal(read(reopened.document), 'A\nB\r\nC');
  assert.deepEqual(bytes(reopened.document), currentBytes);
  console.log('T101-LITERAL-CR-01 passed: tagged CR stays in one logical line, anchors map, mixed CRLF serialization and persisted undo/redo round-trip.');
}

function checkOpenFileformatAmbiguityAndLegacyPolicy(): void {
  const raw = encoder.encode('before\rafter');
  const strictAuto = openTextDocument(documentId, raw, 41027, { fileFormat: 'auto' });
  assert.equal(strictAuto.kind, 'read-only');
  if (strictAuto.kind === 'read-only') {
    assert.equal(strictAuto.document.reason, 'ambiguous-line-endings');
    assert.deepEqual(strictAuto.document.copyOriginalBytes(), raw);
  }
  const invalidFormat = openTextDocument(documentId, raw, 41027, { fileFormat: 'unknown' as TextFileFormat });
  assert.equal(invalidFormat.kind, 'read-only');
  if (invalidFormat.kind === 'read-only') {
    assert.equal(invalidFormat.document.reason, 'invalid-file-format');
    assert.deepEqual(invalidFormat.document.copyOriginalBytes(), raw);
  }

  const asUnix = openTextDocument(documentId, raw, 41027, { fileFormat: 'unix' });
  assert.equal(asUnix.kind, 'editable');
  if (asUnix.kind !== 'editable') throw new Error('T101-unix-open');
  assert.equal(read(asUnix.document), 'before\rafter');
  assert.deepEqual(bytes(asUnix.document), raw);

  const asMac = openTextDocument(documentId, raw, 41027, { fileFormat: 'mac' });
  assert.equal(asMac.kind, 'editable');
  if (asMac.kind !== 'editable') throw new Error('T101-mac-open');
  assert.equal(read(asMac.document), 'before\nafter');
  assert.deepEqual(asMac.document.snapshot().lineEndings, ['cr']);

  const trailingCr = encoder.encode('end\r');
  const strictTrailing = openTextDocument(documentId, trailingCr, 41027, { fileFormat: 'auto' });
  assert.equal(strictTrailing.kind, 'read-only');
  if (strictTrailing.kind === 'read-only') {
    assert.equal(strictTrailing.document.reason, 'ambiguous-line-endings');
    assert.deepEqual(strictTrailing.document.copyOriginalBytes(), trailingCr);
  }
  const trailingLiteral = openTextDocument(documentId, trailingCr, 41027, { fileFormat: 'unix' });
  assert.equal(trailingLiteral.kind, 'editable');
  if (trailingLiteral.kind !== 'editable') throw new Error('T101-trailing-literal-open');
  assert.equal(read(trailingLiteral.document), 'end\r');
  assert.equal(trailingLiteral.document.snapshot().hasFinalNewline, false);
  assert.deepEqual(bytes(trailingLiteral.document), trailingCr);
  const trailingEnding = openTextDocument(documentId, trailingCr, 41027, { fileFormat: 'mac' });
  assert.equal(trailingEnding.kind, 'editable');
  if (trailingEnding.kind !== 'editable') throw new Error('T101-trailing-ending-open');
  assert.equal(read(trailingEnding.document), 'end\n');
  assert.equal(trailingEnding.document.snapshot().hasFinalNewline, true);
  assert.deepEqual(trailingEnding.document.snapshot().lineEndings, ['cr']);
  assert.deepEqual(bytes(trailingEnding.document), trailingCr);

  const legacy = openTextDocument(documentId, raw);
  assert.equal(legacy.kind, 'editable');
  if (legacy.kind !== 'editable') throw new Error('T101-legacy-open');
  assert.equal(read(legacy.document), 'before\nafter', 'the no-options entry point retains T010 mixed-EOL interpretation');
  console.log('T101-FILEFORMAT-01 passed: strict auto preserves ambiguity at mid-line and EOF; unix/mac distinguish literal EOF CR from a trailing legacy CR ending; legacy default stays compatible.');
}

function checkGenericPasteAndNulBehavior(): void {
  const document = openEditable('ab');
  const before = document.snapshot();
  const preview = document.previewTextEdits([
    { start: offset(1), end: offset(1), text: '\r\n' },
  ], before.version);
  if (!preview.ok) throw new Error(`T101-preview:${preview.error.kind}`);
  const previewText = preview.value.slice(offset(0), offset(preview.value.lengthUtf16));
  assert.deepEqual(previewText, { ok: true, value: 'a\nb' });
  assert.equal(document.snapshot().version, before.version, 'preview does not mutate live text');

  const paste = document.apply({ start: offset(1), end: offset(1), text: '\r\n' }, before.version);
  assert.equal(paste.ok, true);
  assert.equal(read(document), 'a\nb');

  const withNul = openEditable('ab');
  assert.equal(withNul.apply({ start: offset(1), end: offset(1), text: '\0' }, withNul.snapshot().version).ok, true);
  assert.deepEqual(bytes(withNul), encoder.encode('a\0b'));
  const rawNul = encoder.encode('a\0b');
  const readonly = openTextDocument(documentId, rawNul);
  assert.equal(readonly.kind, 'read-only');
  if (readonly.kind === 'read-only') {
    assert.equal(readonly.document.reason, 'binary-content');
    assert.deepEqual(readonly.document.copyOriginalBytes(), rawNul);
  }
  console.log('T101-LEGACY-NUL-01 passed: generic paste keeps CR normalization; live NUL is editable and raw NUL reopens losslessly read-only.');
}

checkLiteralCrMetadataUndoAndReopen();
checkOpenFileformatAmbiguityAndLegacyPolicy();
checkGenericPasteAndNulBehavior();
