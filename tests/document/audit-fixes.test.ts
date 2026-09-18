import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type Utf16Offset } from '../../packages/primitives/src/index';
import { LineEndingSequence, TextFileDocument, encodeTextFileChunks } from '../../packages/document/src/index';
import { RopeDocument } from '../../packages/document/src/rope';
import { fingerprintUndoContent } from '../../packages/document/src/undo';
import { offsetToPosition, positionToOffset } from '../../packages/document/src/coordinates';

const idResult = asIdentifier<DocumentId>('audit-fixes', 'documentId');
const documentId: DocumentId = idResult.ok
  ? idResult.value
  : (() => { throw new Error(idResult.error.message); })();

function countLineFeeds(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) count += 1;
  return count;
}

function create(text: string): TextFileDocument {
  const result = TextFileDocument.create(documentId, text, LineEndingSequence.fromUniform(countLineFeeds(text), 'lf'), 'lf');
  if (!result.ok) throw new Error(`document-create-failed:${result.error.kind}`);
  return result.value;
}

function read(document: TextFileDocument): string {
  const snapshot = document.snapshot();
  const result = snapshot.slice(0 as Utf16Offset, snapshot.lengthUtf16 as Utf16Offset);
  if (!result.ok) throw new Error(`read-failed:${result.error.kind}`);
  return result.value;
}

// A1: a >1 MiB deletion (source-backed inverse) merged with an adjacent small
// deletion in one batch must not lose the retained undo text (undo.ts
// combineAmbiguousInverseEdits used to re-index inverseSources incorrectly).
function checkA1LargeDeleteUndoNoDataLoss(): void {
  const big = 'x'.repeat(1_100_000);
  const document = create(`abcde${big}\n`);
  const before = document.version;
  const committed = document.applyBatch([
    { start: 0 as Utf16Offset, end: 5 as Utf16Offset, text: '' },
    { start: 5 as Utf16Offset, end: (5 + big.length) as Utf16Offset, text: '' },
  ], before);
  assert.equal(committed.ok, true, 'A1 setup: batch delete should apply');
  assert.equal(read(document), '\n');
  const undoResult = document.undo();
  assert.equal(undoResult.ok, true, 'A1: undo should succeed');
  const restored = read(document);
  assert.equal(restored.length, `abcde${big}\n`.length, 'A1: undo must restore full length, not truncate to \'\'');
  assert.equal(restored, `abcde${big}\n`, 'A1: undo must restore exact original text');
}

// A3: encodeTextFileChunks must not hang when a chunk window boundary lands
// exactly between the two units of an astral character.
function checkA3EncodeChunksNoHang(): void {
  const text = 'a\u{1F600}b\n'; // "a😀b\n"
  const document = create(text);
  const snapshot = document.snapshot();
  const chunks: Uint8Array[] = [];
  const iterate = async () => {
    for await (const chunk of encodeTextFileChunks(snapshot, 1)) chunks.push(chunk);
  };
  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000));
  return Promise.race([iterate().then(() => 'done' as const), timeout]).then((outcome) => {
    assert.equal(outcome, 'done', 'A3: encodeTextFileChunks must terminate, not hang');
    const total = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf-8');
    assert.equal(total, text, 'A3: reassembled chunks must equal original text');
  }) as unknown as void;
}

// A4: fingerprintUndoContent perf -- must stay well under the 250 ms open
// budget even for large content (previously ~116 ms/MiB via per-byte BigInt).
function checkA4FingerprintPerf(): void {
  const bytes = new TextEncoder().encode('y'.repeat(1024 * 1024));
  for (let i = 0; i < 5; i += 1) fingerprintUndoContent(bytes); // warm up JIT before measuring
  const samples: number[] = [];
  for (let i = 0; i < 30; i += 1) {
    const start = performance.now();
    fingerprintUndoContent(bytes);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? samples[samples.length - 1] ?? 0;
  // Budget is generous (open path allows 250ms) to absorb shared-host noise;
  // the original BigInt-per-byte hash measured ~116ms/MiB, ~9x this bound.
  assert.ok(p95 < 50, `A4: fingerprintUndoContent p95 for 1 MiB should be < 50ms, got ${p95.toFixed(3)}ms`);
  // Stability: same bytes must fingerprint identically.
  assert.equal(fingerprintUndoContent(bytes), fingerprintUndoContent(bytes));
  // Sensitivity: different bytes should (overwhelmingly likely) fingerprint differently.
  const other = new TextEncoder().encode('z'.repeat(1024 * 1024));
  assert.notEqual(fingerprintUndoContent(bytes), fingerprintUndoContent(other));
}

// A5: an insertion touching either side of a replacement's boundary is
// ambiguous and rope.ts must reject it consistently, matching
// transactions.ts's validateEdits (previously accepted end-touching only).
function checkA5AmbiguousInsertionBoundary(): void {
  const created = RopeDocument.create(documentId, 'abcdefgh', 1, true);
  if (!created.ok) throw new Error('A5 setup failed');
  const doc = created.value;
  const version = doc.snapshot().version;
  const result = doc.applyBatch([
    { start: 1 as Utf16Offset, end: 3 as Utf16Offset, text: 'XY' },
    { start: 3 as Utf16Offset, end: 3 as Utf16Offset, text: 'Z' },
  ], version);
  assert.equal(result.ok, false, 'A5: insertion touching a replacement END must be rejected');
  if (!result.ok) assert.equal(result.error.kind, 'ambiguous-insertion-boundary');
}

// A6: textIntent:'literal-control' means "skip CR normalization", not "must
// contain a CR" -- other control characters (e.g. BEL) must be accepted.
function checkA6LiteralControlWithoutCR(): void {
  const created = RopeDocument.create(documentId, 'ab', 1, true);
  if (!created.ok) throw new Error('A6 setup failed');
  const doc = created.value;
  const version = doc.snapshot().version;
  const result = doc.applyBatch([
    { start: 1 as Utf16Offset, end: 1 as Utf16Offset, text: '\x07', textIntent: 'literal-control' },
  ], version);
  assert.equal(result.ok, true, 'A6: literal-control text without CR must be accepted');
}

// A7: retainedRootUtf16 accounting for a step with multiple source-backed
// inverse edits sharing the same `before` snapshot must not multiply-count
// that snapshot's length (UndoTree.addSources dedupes by identity).
function checkA7RetainedRootUtf16Dedup(): void {
  const bigA = 'a'.repeat(1_100_000);
  const bigB = 'b'.repeat(1_100_000);
  const document = create(`${bigA}|${bigB}|\n`);
  const before = document.version;
  const committed = document.applyBatch([
    { start: 0 as Utf16Offset, end: bigA.length as Utf16Offset, text: '' },
    { start: (bigA.length + 1) as Utf16Offset, end: (bigA.length + 1 + bigB.length) as Utf16Offset, text: '' },
  ], before);
  assert.equal(committed.ok, true, 'A7 setup: batch delete should apply');
  const stats = document.undoHistoryStats() as { readonly retainedRootUtf16: number };
  const originalLength = `${bigA}|${bigB}|\n`.length;
  assert.ok(
    stats.retainedRootUtf16 <= originalLength,
    `A7: retainedRootUtf16 (${stats.retainedRootUtf16}) must not exceed the single shared before-snapshot length (${originalLength})`,
  );
  const undoResult = document.undo();
  assert.equal(undoResult.ok, true);
  assert.equal(read(document), `${bigA}|${bigB}|\n`, 'A7: undo must still restore exact text after dedup fix');
}

// A8: dead code removal -- sanity that the paths still behave identically
// (mapping through a same-position edit, and encoding without the deleted
// chooseDefaultEnding helper).
function checkA8StillWorks(): void {
  const document = create('abc\n');
  const before = document.version;
  const committed = document.applyBatch([{ start: 0 as Utf16Offset, end: 0 as Utf16Offset, text: 'X' }], before);
  assert.equal(committed.ok, true);
  assert.equal(read(document), 'Xabc\n');
}

// A10: coordinate conversion stays fast (O(log n) via rope aggregates) on a
// large document -- no per-line checkpoint cache is required.
function checkA10CoordinatesPerf(): void {
  const line = 'const value = 1;\n';
  const lineCount = Math.floor((10 * 1024 * 1024) / line.length);
  const text = line.repeat(lineCount);
  const document = create(text);
  const snapshot = document.snapshot();
  const targetLine = Math.floor(lineCount * 0.75);
  const offset = (targetLine * line.length + 6) as Utf16Offset;
  const callsPerBatch = 500;
  const roundTrip = (): void => {
    const position = offsetToPosition(snapshot, offset, 'utf-16');
    if (!position.ok) throw new Error('A10: offsetToPosition failed');
    const back = positionToOffset(snapshot, position.value);
    if (!back.ok) throw new Error('A10: positionToOffset failed');
  };
  for (let i = 0; i < 50; i += 1) roundTrip(); // warm up JIT before measuring
  const samples: number[] = [];
  for (let batch = 0; batch < 30; batch += 1) {
    const start = performance.now();
    for (let i = 0; i < callsPerBatch; i += 1) roundTrip();
    // Two per-call conversions per round trip; report per-call microseconds.
    samples.push(((performance.now() - start) / (callsPerBatch * 2)) * 1000);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? samples[samples.length - 1] ?? 0;
  // O(log n) via rope aggregates should stay a few us/call; 100us leaves
  // generous headroom for shared-host noise while still catching an O(n)
  // regression (which would cost ms, not us, on a 10 MiB document).
  assert.ok(p95 < 100, `A10: coordinate conversion p95 on a 10 MiB doc should be < 100us/call, got ${p95.toFixed(2)}us`);
}

async function main(): Promise<void> {
  checkA1LargeDeleteUndoNoDataLoss();
  await checkA3EncodeChunksNoHang();
  checkA4FingerprintPerf();
  checkA5AmbiguousInsertionBoundary();
  checkA6LiteralControlWithoutCR();
  checkA7RetainedRootUtf16Dedup();
  checkA8StillWorks();
  checkA10CoordinatesPerf();
  console.log('tests/document/audit-fixes.test.ts: all checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
