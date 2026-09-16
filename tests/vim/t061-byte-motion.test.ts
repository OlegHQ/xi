import { strict as assert } from 'node:assert';
import { openTextDocument } from '../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type Utf16Offset } from '../../packages/primitives/src/index';
import { createVimMotionCursor, resolveVimMotion } from '../../packages/vim/src/index';
import { runOracleFixture, verifyOracleBundle } from '../oracle/oracle-runner';

const source = 'aé😀z\nnext';
const cases = [
  { count: 1, line: 1, byteColumn: 1 },
  { count: 3, line: 1, byteColumn: 2 },
  { count: 4, line: 1, byteColumn: 4 },
  { count: 8, line: 1, byteColumn: 8 },
  { count: 9, line: 1, byteColumn: 8 },
  { count: 10, line: 2, byteColumn: 1 },
  { count: 20, line: 2, byteColumn: 4 },
] as const;

const document = openTextDocument(asDocumentId('T061-byte-motion'), new TextEncoder().encode(source));
assert.equal(document.kind, 'editable', 'T061-GO-OWNER-01 opens an editable snapshot');
if (document.kind !== 'editable') throw new Error('T061-GO-OWNER-01 document did not open');
const snapshot = document.document.snapshot();
const initial = createVimMotionCursor(snapshot, offset(0));
assert.equal(initial.ok, true, 'T061-GO-COORDINATE-01 initial cursor is valid');
if (!initial.ok) throw new Error('T061-GO-COORDINATE-01 initial cursor failed');

const oracle = await verifyOracleBundle();
for (const testCase of cases) {
  const actual = resolveVimMotion(snapshot, initial.value, { key: 'go', count: testCase.count });
  assert.equal(actual.ok, true, `T061-GO-RESOLVE-01 count ${testCase.count} resolves`);
  if (!actual.ok) continue;
  const expected = await runOracleFixture({
    id: `T061-GO-ORACLE-${testCase.count}`,
    title: 'absolute byte motion',
    purpose: 'Audit go against the pinned Neovim byte addressing behavior.',
    modes: ['normal'],
    lines: source.split('\n'),
    cursor: { line: 1, byteColumn0: 0 },
    steps: [{ label: 'go', keys: `${testCase.count}go`, drain: true }],
  }, oracle.binaryPath);
  const oracleSnapshot = expected.snapshots[0];
  assert.ok(oracleSnapshot, `T061-GO-ORACLE-01 count ${testCase.count} has a snapshot`);
  if (oracleSnapshot === undefined) continue;
  const expectedLineStart = snapshot.lineStartOffset((testCase.line - 1) as never);
  assert.equal(expectedLineStart.ok, true, `T061-GO-COORDINATE-02 count ${testCase.count} line exists`);
  if (!expectedLineStart.ok) continue;
  const expectedOffset = snapshot.offsetAtUtf8((utf8OffsetBeforeLine(source, testCase.line) + testCase.byteColumn - 1) as never);
  assert.equal(expectedOffset.ok, true, `T061-GO-COORDINATE-03 count ${testCase.count} expected byte is a scalar boundary`);
  if (!expectedOffset.ok) continue;
  // Neovim reports the cursor's one-based byte column. Its line and column
  // fixture above are the exact expected scalar position for each count.
  assert.equal((actual.value.cursor.offset as number), expectedOffset.value as number,
    `T061-GO-ORACLE-02 count ${testCase.count} UTF-16 offset matches pinned byte target`);
  assert.equal(oracleSnapshot.cursor.line, testCase.line, `T061-GO-ORACLE-03 count ${testCase.count} line matches`);
  assert.equal(oracleSnapshot.cursor.byteColumn, testCase.byteColumn, `T061-GO-ORACLE-04 count ${testCase.count} byte column matches`);
  assert.equal(actual.value.kind, 'characterwise', `T061-GO-ORACLE-05 count ${testCase.count} remains characterwise`);
}

assert.equal(snapshot.version, 1, 'T061-GO-PURITY-01 motion does not mutate the source snapshot');
console.log(`T061 go passed ${cases.length} pinned absolute UTF-8 byte motion fixtures`);

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

function utf8OffsetBeforeLine(value: string, line: number): number {
  return new TextEncoder().encode(value.split('\n').slice(0, line - 1).join('\n') + (line > 1 ? '\n' : '')).length;
}
