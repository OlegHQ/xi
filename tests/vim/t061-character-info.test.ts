import { strict as assert } from 'node:assert';
import { openTextDocument } from '../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type Utf16Offset } from '../../packages/primitives/src/index';
import { resolveVimCharacterInfo } from '../../packages/vim/src/index';
import { runOracleFixture, verifyOracleBundle } from '../oracle/oracle-runner';

const source = 'aé😀z';
const document = openTextDocument(asDocumentId('T061-character-info'), new TextEncoder().encode(source));
assert.equal(document.kind, 'editable', 'T061-CHAR-OWNER-01 opens an editable snapshot');
if (document.kind !== 'editable') throw new Error('T061-CHAR-OWNER-01 document did not open');
const snapshot = document.document.snapshot();

const expected = [
  { offset: 0, grapheme: 'a', codePoints: [0x61], utf8Hex: '61' },
  { offset: 1, grapheme: 'é', codePoints: [0xe9], utf8Hex: 'c3 a9' },
  { offset: 2, grapheme: '😀', codePoints: [0x1f600], utf8Hex: 'f0 9f 98 80' },
] as const;
for (const item of expected) {
  const result = resolveVimCharacterInfo(snapshot, offset(item.offset));
  assert.equal(result.ok, true, `T061-CHAR-RESOLVE-01 ${item.grapheme} resolves at its UTF-16 boundary`);
  if (!result.ok) continue;
  assert.equal(result.value.grapheme, item.grapheme, `T061-CHAR-GRAPHEME-01 ${item.grapheme} is retained`);
  assert.deepEqual(result.value.codePoints, item.codePoints, `T061-CHAR-CODEPOINT-01 ${item.grapheme} code point is retained`);
  assert.equal(result.value.utf8Hex, item.utf8Hex, `T061-CHAR-UTF8-01 ${item.grapheme} bytes are exact`);
}

const combining = openTextDocument(asDocumentId('T061-character-combining'), new TextEncoder().encode('e\u0301x'));
assert.equal(combining.kind, 'editable', 'T061-CHAR-GRAPHEME-02 combining fixture opens');
if (combining.kind === 'editable') {
  const result = resolveVimCharacterInfo(combining.document.snapshot(), offset(0));
  assert.equal(result.ok, true, 'T061-CHAR-GRAPHEME-02 composed grapheme resolves');
  if (result.ok) {
    assert.equal(result.value.grapheme, 'e\u0301', 'T061-CHAR-GRAPHEME-02 base and mark remain one grapheme');
    assert.equal(result.value.utf8Hex, '65 cc 81', 'T061-CHAR-GRAPHEME-02 composed grapheme bytes remain exact');
  }
}
assert.deepEqual(resolveVimCharacterInfo(snapshot, offset(snapshot.lengthUtf16)), { ok: false, error: { kind: 'no-character' } },
  'T061-CHAR-BOUNDARY-01 EOL has no character metadata');

const oracle = await verifyOracleBundle();
for (const [keys, byteColumn0] of [['ga', 3], ['g8', 3] ] as const) {
  const traced = await runOracleFixture({
    id: `T061-${keys}-ORACLE-01`, title: keys, purpose: 'Pin character information commands as read-only Normal commands.',
    modes: ['normal'], lines: [source], cursor: { line: 1, byteColumn0 },
    steps: [{ label: 'after', keys, drain: true }],
  }, oracle.binaryPath);
  const result = traced.snapshots[0];
  assert.ok(result, `T061-${keys}-ORACLE-01 snapshot exists`);
  if (result !== undefined) {
    assert.deepEqual(result.lines, [source], `T061-${keys}-ORACLE-02 does not edit text`);
    assert.equal(result.cursor.byteColumn, byteColumn0 + 1, `T061-${keys}-ORACLE-03 retains the cursor`);
    assert.equal(result.error, '', `T061-${keys}-ORACLE-04 has no Vim error`);
  }
}

console.log('T061 ga/g8 character metadata and read-only pinned command fixtures passed');

function asDocumentId(value: string): DocumentId {
  const result = asIdentifier<DocumentId>(value, 'document-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function offset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
