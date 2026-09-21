import { strict as assert } from 'node:assert';
import {
  asCellColumn,
  asIdentifier,
  asLineIndex,
  asUtf16Offset,
  asUtf8ByteOffset,
  type DocumentId,
  type LineIndex,
  type Utf16Column,
  type Utf16Offset,
  type Utf32Column,
  type Utf8ByteColumn,
} from '../../packages/primitives/src/index';
import {
  offsetToPosition,
  openTextDocument,
  positionToOffset,
  type EncodedTextPosition,
  type LineEnding,
  type TextFileDocument,
} from '../../packages/document/src/index';
import { RopeDocument } from '../../packages/document/src/rope';

const idResult = asIdentifier<DocumentId>('T010-text-fidelity', 'documentId');
if (!idResult.ok) throw new Error(idResult.error.message);
const documentId = idResult.value;

function checkCoordinateRoundTrips(): void {
  const source = 'Aé😀e\u0301👩‍👩‍👧‍👦\t界\n' + 'q'.repeat(160);
  const opened = openTextDocument(documentId, new TextEncoder().encode(source));
  assert.equal(opened.kind, 'editable');
  if (opened.kind !== 'editable') throw new Error('valid UTF-8 should open editable');
  const snapshot = opened.document.snapshot();
  const firstLine = source.slice(0, source.indexOf('\n'));
  for (const localOffset of safeUtf16Boundaries(firstLine)) {
    for (const encoding of ['utf-8', 'utf-16', 'utf-32'] as const) {
      const position = offsetToPosition(snapshot, offset(localOffset), encoding);
      assert.equal(position.ok, true, `T010-COORD-ROUNDTRIP-01 ${encoding} offset ${localOffset}`);
      if (!position.ok) continue;
      const restored = positionToOffset(snapshot, position.value);
      assert.equal(restored.ok, true, `T010-COORD-ROUNDTRIP-01 reverse ${encoding} offset ${localOffset}`);
      if (restored.ok) assert.equal(restored.value as number, localOffset);
    }
  }
  const secondLineStart = snapshot.lineStartOffset(line(1));
  assert.equal(secondLineStart.ok, true);
  if (secondLineStart.ok) {
    for (const localOffset of [0, 63, 64, 65, 127, 128, 129, 160]) {
      for (const encoding of ['utf-8', 'utf-16', 'utf-32'] as const) {
        const position = offsetToPosition(snapshot, offset((secondLineStart.value as number) + localOffset), encoding);
        assert.equal(position.ok, true, `T010-COORD-CHECKPOINT-01 ${encoding} column ${localOffset}`);
        if (!position.ok) continue;
        const restored = positionToOffset(snapshot, position.value);
        assert.equal(restored.ok, true);
        if (restored.ok) assert.equal(restored.value as number, (secondLineStart.value as number) + localOffset);
      }
    }
  }

  assert.deepEqual(offsetToPosition(snapshot, offset(2), 'utf-8'), {
    ok: true,
    value: { version: snapshot.version, line: line(0), encoding: 'utf-8', character: utf8Column(3) },
  }, 'é occupies two UTF-8 bytes after the leading ASCII character');
  assert.deepEqual(offsetToPosition(snapshot, offset(4), 'utf-32'), {
    ok: true,
    value: { version: snapshot.version, line: line(0), encoding: 'utf-32', character: utf32Column(3) },
  }, 'the emoji is one Unicode scalar, independent of its two UTF-16 units');

  const utf16Midpoint: EncodedTextPosition = {
    version: snapshot.version,
    line: line(0),
    encoding: 'utf-16',
    character: utf16Column(3),
  };
  const splitUtf16 = positionToOffset(snapshot, utf16Midpoint);
  assert.equal(splitUtf16.ok, false);
  if (!splitUtf16.ok) assert.equal(splitUtf16.error.kind, 'surrogate-split');

  const splitUtf8: EncodedTextPosition = {
    version: snapshot.version,
    line: line(0),
    encoding: 'utf-8',
    character: utf8Column(2),
  };
  const splitByte = positionToOffset(snapshot, splitUtf8);
  assert.equal(splitByte.ok, false);
  if (!splitByte.ok) assert.equal(splitByte.error.kind, 'invalid-column');

  const outsideLine: EncodedTextPosition = {
    version: snapshot.version,
    line: line(20),
    encoding: 'utf-32',
    character: utf32Column(0),
  };
  assert.equal(positionToOffset(snapshot, outsideLine).ok, false);
  const outsideColumn: EncodedTextPosition = {
    version: snapshot.version,
    line: line(0),
    encoding: 'utf-8',
    character: utf8Column(1000),
  };
  assert.equal(positionToOffset(snapshot, outsideColumn).ok, false);
  const invalidEncoding = {
    version: snapshot.version,
    line: line(0),
    encoding: 'utf-7',
    character: 0,
  } as unknown as EncodedTextPosition;
  assert.deepEqual(positionToOffset(snapshot, invalidEncoding), { ok: false, error: { kind: 'invalid-encoding' } });

  const oldPosition = offsetToPosition(snapshot, offset(4), 'utf-16');
  assert.equal(oldPosition.ok, true);
  const changed = opened.document.apply({ start: offset(0), end: offset(0), text: 'x' }, snapshot.version);
  assert.equal(changed.ok, true);
  if (oldPosition.ok) assert.deepEqual(positionToOffset(opened.document.snapshot(), oldPosition.value), {
    ok: false,
    error: { kind: 'stale-version' },
  });
  console.log('T010-COORD-ROUNDTRIP-01 passed: UTF-8/16/32 checkpoints round-trip Unicode and reject invalid/stale columns.');
}

/**
 * Regression: `getLineBase` in coordinates.ts used to memoize each
 * line's UTF-8/UTF-32 base offsets in a `WeakMap<DocumentSnapshot, ...>`, keyed on the
 * snapshot wrapper itself. That cache is gone -- `utf8OffsetAt`/`utf32OffsetAt` are already
 * O(log n) tree descents through the rope's precomputed subtree byte-length aggregates, so
 * the cache bought nothing while silently going stale/unshared across snapshot versions.
 * This guards the exact scenario that motivated removing it: repeated conversions on the
 * same line, on the same snapshot AND across an edited (new-version) snapshot, must never
 * read a stale byte offset left over from a different version.
 */
function checkLineBaseAcrossRepeatedAndEditedAccess(): void {
  const source = 'ab\ncdé😀\nghi\n' + 'z'.repeat(64);
  const doc = editable(new TextEncoder().encode(source));
  const before = doc.snapshot();
  const lineTwoStart = before.lineStartOffset(line(1));
  assert.equal(lineTwoStart.ok, true, 'T010-LINEBASE-01 line 1 exists before the edit');
  if (!lineTwoStart.ok) throw new Error('T010-LINEBASE-01');

  // Repeated conversions of different offsets on the same line must agree with each other
  // and with a direct round trip every time (no memoized value could leak a wrong result).
  for (let attempt = 0; attempt < 5; attempt += 1) {
    for (const localOffset of [0, 1, 2, 3]) {
      const target = offset((lineTwoStart.value as number) + localOffset);
      const position = offsetToPosition(before, target, 'utf-16');
      assert.equal(position.ok, true, `T010-LINEBASE-02 attempt ${attempt} offset ${localOffset}`);
      if (!position.ok) continue;
      assert.equal(position.value.line, 1, `T010-LINEBASE-02 attempt ${attempt} stays on line 1`);
      const restored = positionToOffset(before, position.value);
      assert.deepEqual(restored, { ok: true, value: target }, `T010-LINEBASE-02 attempt ${attempt} round trip`);
    }
  }

  // Insert two extra ASCII bytes at the very start of the document, shifting line 1's UTF-16
  // and UTF-8 base by +2 in the new version. A stale/shared cache entry from `before` would
  // make the new snapshot's line-1 base wrong by exactly that shift.
  const insertion = doc.apply({ start: offset(0), end: offset(0), text: 'xy' }, before.version);
  assert.equal(insertion.ok, true, 'T010-LINEBASE-03 edit applies');
  const after = doc.snapshot();
  const beforeBase = offsetToPosition(before, offset(lineTwoStart.value as number), 'utf-8');
  const afterLineStart = after.lineStartOffset(line(1));
  assert.equal(afterLineStart.ok, true);
  if (!afterLineStart.ok) throw new Error('T010-LINEBASE-04');
  const afterBase = offsetToPosition(after, offset(afterLineStart.value as number), 'utf-8');
  assert.equal(beforeBase.ok, true);
  assert.equal(afterBase.ok, true);
  if (beforeBase.ok && afterBase.ok) {
    assert.equal(beforeBase.value.character, 0, 'T010-LINEBASE-05 old snapshot: line 1 still starts at column 0');
    assert.equal(afterBase.value.character, 0, 'T010-LINEBASE-06 new snapshot: line 1 (now shifted) also starts at column 0');
  }
  assert.equal((afterLineStart.value as number) - (lineTwoStart.value as number), 2,
    'T010-LINEBASE-07 line 1 starts 2 UTF-16 units later in the new version');
  // The absolute UTF-8 offset of line 1's start moved by exactly the 2 inserted (ASCII) bytes.
  const beforeUtf8Start = before.utf8OffsetAt(lineTwoStart.value);
  const afterUtf8Start = after.utf8OffsetAt(afterLineStart.value);
  assert.equal(beforeUtf8Start.ok, true);
  assert.equal(afterUtf8Start.ok, true);
  if (beforeUtf8Start.ok && afterUtf8Start.ok) {
    assert.equal((afterUtf8Start.value as number) - (beforeUtf8Start.value as number), 2,
      'T010-LINEBASE-08 the new version reflects the inserted bytes, not a stale cached base');
  }
  console.log('T010-LINEBASE-01 passed: line-base conversions stay correct across repeated calls and across an edited snapshot version, with no cache to go stale.');
}

function checkBrandedUnitValidation(): void {
  assert.equal(asUtf16Offset(0).ok, true);
  assert.equal(asUtf16Offset(-1).ok, false);
  assert.equal(asUtf8ByteOffset(2.5).ok, false);
  assert.equal(asLineIndex(1).ok, true);
  assert.equal(asLineIndex(Number.MAX_SAFE_INTEGER + 1).ok, false);
  assert.equal(asCellColumn(0).ok, true);
  assert.equal(asCellColumn(-1).ok, false);
  console.log('T010-BRANDED-UNITS-01 passed: UTF-16/UTF-8/line/cell constructors reject invalid coordinates.');
}

function checkLosslessTextOpenAndSave(): void {
  const body = new TextEncoder().encode('first\r\nsecond\nthird\rend');
  const original = concatBytes(new Uint8Array([0xef, 0xbb, 0xbf]), body);
  const opened = openTextDocument(documentId, original);
  assert.equal(opened.kind, 'editable');
  if (opened.kind !== 'editable') throw new Error('valid mixed-EOL UTF-8 should open editable');
  const initial = opened.document.snapshot();
  assert.equal(initial.encoding, 'utf-8');
  assert.equal(initial.hasUtf8Bom, true);
  assert.equal(initial.hasFinalNewline, false);
  assert.deepEqual(initial.lineEndings, ['crlf', 'lf', 'cr']);
  assert.deepEqual(opened.document.serialize(), { ok: true, value: original });

  const doubleBom = concatBytes(
    new Uint8Array([0xef, 0xbb, 0xbf]),
    concatBytes(new Uint8Array([0xef, 0xbb, 0xbf]), new TextEncoder().encode('content')),
  );
  const doubled = editable(doubleBom);
  assert.equal(readAll(doubled.snapshot()), '\ufeffcontent');
  assert.deepEqual(doubled.serialize(), { ok: true, value: doubleBom }, 'only the first BOM is file metadata');
  console.log('T010-BOM-DOUBLE-01 passed: content U+FEFF after the file BOM is preserved.');

  const empty = editable(new Uint8Array());
  assert.equal(empty.snapshot().lengthUtf16, 0);
  assert.equal(empty.snapshot().hasFinalNewline, false);
  assert.deepEqual(empty.snapshot().lineEndings, []);
  assert.deepEqual(empty.serialize(), { ok: true, value: new Uint8Array() });

  const oneNewlineBytes = new TextEncoder().encode('\n');
  const oneNewline = editable(oneNewlineBytes).snapshot();
  assert.equal(oneNewline.lengthUtf16, 1);
  assert.equal(oneNewline.lineCount, 2);
  assert.equal(oneNewline.hasFinalNewline, true);
  assert.deepEqual(oneNewline.lineEndings, ['lf']);
  console.log('T010-EOL-BOM-01 passed: BOM, mixed endings, final-newline and empty/newline-only files round-trip exactly.');
}

function checkLineEndingEditsAndReadOnlyBytes(): void {
  const original = new TextEncoder().encode('a\r\nb\nc\r');
  const editableDocument = editable(original);
  const oldSnapshot = editableDocument.snapshot();
  const insertion = editableDocument.apply({ start: offset(3), end: offset(3), text: '\n' }, oldSnapshot.version);
  assert.equal(insertion.ok, true);
  const insertedSnapshot = editableDocument.snapshot();
  assert.deepEqual(insertedSnapshot.lineEndings, ['crlf', 'crlf', 'lf', 'cr']);
  assert.deepEqual(editableDocument.serialize(), { ok: true, value: new TextEncoder().encode('a\r\nb\r\n\nc\r') });
  const oldBytes = editableDocument.serializeSnapshot(oldSnapshot);
  assert.deepEqual(oldBytes, { ok: true, value: original }, 'captured old text and EOL metadata remain stable');

  const batchDocument = editable(new TextEncoder().encode('one\r\ntwo\nthree\r\nfour'));
  const batchBase = batchDocument.snapshot();
  const batch = batchDocument.applyBatch([
    { start: offset(3), end: offset(4), text: '' },
    { start: offset(16), end: offset(16), text: '\n' },
  ], batchBase.version);
  assert.equal(batch.ok, true);
  assert.deepEqual(batchDocument.snapshot().lineEndings, ['lf', 'crlf', 'crlf']);
  assert.deepEqual(batchDocument.serialize(), { ok: true, value: new TextEncoder().encode('onetwo\nthree\r\nfo\r\nur') });

  for (const pastedEnding of ['\r\n', '\r']) {
    const pasted = editable(new TextEncoder().encode('a\r\nb'));
    const paste = pasted.apply({ start: offset(1), end: offset(1), text: pastedEnding }, pasted.snapshot().version);
    assert.equal(paste.ok, true);
    assert.equal(readAll(pasted.snapshot()), 'a\n\nb', 'pasted CR/CRLF is normalized to one logical LF');
    assert.deepEqual(pasted.serialize(), { ok: true, value: new TextEncoder().encode('a\r\n\r\nb') });
  }
  console.log('T010-EDIT-EOL-01 passed: pasted CRLF and CR normalize to one default-style logical line break.');

  const invalidBytes = new Uint8Array([0x61, 0xc3, 0x28, 0x62]);
  const invalid = openTextDocument(documentId, invalidBytes);
  assert.equal(invalid.kind, 'read-only');
  if (invalid.kind === 'read-only') {
    assert.equal(invalid.document.reason, 'invalid-utf8');
    assert.match(invalid.document.explanation, /read-only/u);
    const copy = invalid.document.copyOriginalBytes();
    assert.deepEqual(copy, invalidBytes);
    copy[0] = 0;
    assert.deepEqual(invalid.document.copyOriginalBytes(), invalidBytes);
  }

  const binaryBytes = new Uint8Array([0x61, 0, 0x62]);
  const binary = openTextDocument(documentId, binaryBytes);
  assert.equal(binary.kind, 'read-only');
  if (binary.kind === 'read-only') {
    assert.equal(binary.document.reason, 'binary-content');
    assert.deepEqual(binary.document.copyOriginalBytes(), binaryBytes);
  }
  console.log('T010-RAW-BYTES-01 passed: edited mixed-EOL metadata stays aligned; invalid UTF-8 and NUL bytes remain read-only and lossless.');
}

function checkPersistentMixedEndingMetadata(): void {
  const originalEndings = Array.from({ length: 120 }, (_value, index) => {
    const ending = ['crlf', 'lf', 'cr'] as const;
    return ending[index % ending.length] ?? 'lf';
  });
  let originalBytesText = '';
  for (let lineIndex = 0; lineIndex <= originalEndings.length; lineIndex += 1) {
    originalBytesText += `line-${lineIndex}`;
    const ending = originalEndings[lineIndex];
    if (ending !== undefined) originalBytesText += ending === 'crlf' ? '\r\n' : ending === 'cr' ? '\r' : '\n';
  }
  const document = editable(new TextEncoder().encode(originalBytesText));
  const originalSnapshot = document.snapshot();
  let expectedText = originalBytesText.replace(/\r\n?/gu, '\n');
  let expectedEndings: LineEnding[] = [...originalEndings];
  let state = 0x5011;
  const random = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };

  for (let operation = 0; operation < 160; operation += 1) {
    if (random() % 4 === 0) {
      const breaks: number[] = [];
      for (let index = 0; index < expectedText.length; index += 1) {
        if (expectedText.charCodeAt(index) === 10) breaks.push(index);
      }
      const breakIndex = breaks[random() % breaks.length];
      if (breakIndex === undefined) throw new Error('expected-at-least-one-line-break');
      let lineIndex = 0;
      for (let index = 0; index < breakIndex; index += 1) if (expectedText.charCodeAt(index) === 10) lineIndex += 1;
      const result = document.apply({ start: offset(breakIndex), end: offset(breakIndex + 1), text: '' }, document.snapshot().version);
      assert.equal(result.ok, true, `T010-EOL-PERSIST-01 deletion ${operation}`);
      expectedText = expectedText.slice(0, breakIndex) + expectedText.slice(breakIndex + 1);
      expectedEndings.splice(lineIndex, 1);
    } else {
      const position = random() % (expectedText.length + 1);
      let lineIndex = 0;
      for (let index = 0; index < position; index += 1) if (expectedText.charCodeAt(index) === 10) lineIndex += 1;
      const result = document.apply({ start: offset(position), end: offset(position), text: '\n' }, document.snapshot().version);
      assert.equal(result.ok, true, `T010-EOL-PERSIST-01 insertion ${operation}`);
      expectedText = expectedText.slice(0, position) + '\n' + expectedText.slice(position);
      expectedEndings.splice(lineIndex, 0, originalSnapshot.defaultLineEnding);
    }

    const current = document.snapshot();
    assert.equal(readAll(current), expectedText, `T010-EOL-PERSIST-01 text ${operation}`);
    assert.deepEqual(current.lineEndings, expectedEndings, `T010-EOL-PERSIST-01 metadata ${operation}`);
    assert.deepEqual(document.serialize(), { ok: true, value: encodeWithEndings(expectedText, expectedEndings) });
  }
  assert.deepEqual(originalSnapshot.lineEndings, originalEndings, 'persistent old EOL metadata stays immutable');
  assert.deepEqual(document.serializeSnapshot(originalSnapshot), { ok: true, value: new TextEncoder().encode(originalBytesText) });
  console.log('T010-EOL-PERSIST-01 passed: 160 seeded mixed-EOL insert/delete edits preserve current and captured metadata.');
}

function checkRopeRejectsUnnormalizedLineEndings(): void {
  const created = RopeDocument.create(documentId, 'a\nb');
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error('LF-normalized rope input should be accepted');
  const document = created.value;
  const initial = document.snapshot();
  assert.deepEqual(RopeDocument.create(documentId, 'a\rb'), { ok: false, error: { kind: 'invalid-text' } });
  assert.deepEqual(document.apply({ start: offset(1), end: offset(1), text: '\r' }, initial.version), {
    ok: false,
    error: { kind: 'invalid-text' },
  });
  assert.equal(document.snapshot().version, initial.version, 'invalid CR edits leave the current version unchanged');

  const textFile = editable(new TextEncoder().encode('a'));
  assert.equal(textFile.apply({ start: offset(1), end: offset(1), text: '\r\n' }, textFile.snapshot().version).ok, true,
    'the text-file boundary normalizes CRLF before applying to the rope');
  console.log('T010-ROPE-EOL-01 passed: raw ropes reject CR while the text-file boundary normalizes it.');
}

function checkConfiguredDefaultLineEndings(): void {
  for (const [ending, bytes] of [['lf', '\n'], ['crlf', '\r\n'], ['cr', '\r'], ['ff', '\f'], ['nel', '\u0085']] as const) {
    const opened = openTextDocument(documentId, new Uint8Array(), 41027, { defaultLineEnding: ending });
    assert.equal(opened.kind, 'editable', `T010-DEFAULT-EOL-01 ${ending} opens an editable new buffer`);
    if (opened.kind !== 'editable') continue;
    const applied = opened.document.apply({ start: offset(0), end: offset(0), text: '\n' }, opened.document.version);
    assert.equal(applied.ok, true, `T010-DEFAULT-EOL-02 ${ending} inserts a normalized line break`);
    assert.deepEqual(opened.document.serialize(), { ok: true, value: new TextEncoder().encode(bytes) }, `T010-DEFAULT-EOL-03 ${ending} serializes through its configured ending`);
  }
  console.log('T010-DEFAULT-EOL-01 passed: LF, CRLF, CR, FF and NEL defaults serialize new line breaks exactly.');
}

function editable(bytes: Uint8Array): TextFileDocument {
  const opened = openTextDocument(documentId, bytes);
  if (opened.kind !== 'editable') throw new Error(`expected-editable-document:${opened.document.reason}`);
  return opened.document;
}

function readAll(snapshot: ReturnType<TextFileDocument['snapshot']>): string {
  const result = snapshot.slice(offset(0), offset(snapshot.lengthUtf16));
  if (!result.ok) throw new Error(`T010-read-text-failed:${result.error.kind}`);
  return result.value;
}

function safeUtf16Boundaries(text: string): number[] {
  const boundaries = [0];
  for (let offset_ = 0; offset_ < text.length; offset_ += 1) {
    const first = text.charCodeAt(offset_);
    if (first >= 0xd800 && first <= 0xdbff && offset_ + 1 < text.length) offset_ += 1;
    boundaries.push(offset_ + 1);
  }
  return boundaries;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}

function encodeWithEndings(text: string, endings: readonly ('lf' | 'crlf' | 'cr' | 'ff' | 'nel')[]): Uint8Array {
  let output = '';
  let endingIndex = 0;
  let segmentStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    output += text.slice(segmentStart, index);
    const ending = endings[endingIndex];
    if (ending === undefined) throw new Error('missing-reference-line-ending');
    output += ending === 'crlf' ? '\r\n' : ending === 'cr' ? '\r' : ending === 'ff' ? '\f' : ending === 'nel' ? '\u0085' : '\n';
    segmentStart = index + 1;
    endingIndex += 1;
  }
  if (endingIndex !== endings.length) throw new Error('extra-reference-line-ending');
  output += text.slice(segmentStart);
  return new TextEncoder().encode(output);
}

function offset(value: number): Utf16Offset { return value as Utf16Offset; }
function line(value: number): LineIndex { return value as LineIndex; }
function utf8Column(value: number): Utf8ByteColumn { return value as Utf8ByteColumn; }
function utf16Column(value: number): Utf16Column { return value as Utf16Column; }
function utf32Column(value: number): Utf32Column { return value as Utf32Column; }

checkCoordinateRoundTrips();
checkLineBaseAcrossRepeatedAndEditedAccess();
checkBrandedUnitValidation();
checkLosslessTextOpenAndSave();
checkLineEndingEditsAndReadOnlyBytes();
checkPersistentMixedEndingMetadata();
checkRopeRejectsUnnormalizedLineEndings();
checkConfiguredDefaultLineEndings();
