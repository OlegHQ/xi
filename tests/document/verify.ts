import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type DocumentVersion, type LineIndex, type Utf16Offset } from '../../packages/primitives/src/index';
import { RopeDocument, type DocumentEdit } from '../../packages/document/src/rope';

const SEED = 41027;

export function runDocumentStorageChecks(): void {
  checkSeededReferenceEdits();
  checkBatchEdits();
  checkEmptyAndGiantLine();
  checkSnapshotsAndCompaction();
  checkSurrogateSplitAndStaleReads();
}

function checkSeededReferenceEdits(): void {
  let reference = Array.from({ length: 1800 }, (_value, line) => `row-${line}\té界🙂-${line % 13}`).join('\n');
  const originalText = reference;
  const document = createDocument(reference);
  const initialSnapshot = document.snapshot();
  const random = seededRandom(SEED);
  const replacements = ['x', 'é', '🙂', '\n', '\t', ''] as const;

  for (let operation = 0; operation < 250; operation += 1) {
    const start = safeBoundary(reference, random() % (reference.length + 1));
    const end = safeBoundary(reference, Math.min(reference.length, start + (random() % 11)));
    const text = replacements[random() % replacements.length] ?? 'x';
    const beforeVersion = document.snapshot().version;
    const applied = document.apply({ start: offset(start), end: offset(end), text }, beforeVersion);
    assert.equal(applied.ok, true, `T009-REF-250 operation ${operation} should commit`);
    reference = reference.slice(0, start) + text + reference.slice(end);
    const snapshot = document.snapshot();
    assert.equal(snapshot.lengthUtf16, reference.length);
    assert.equal(read(snapshot, 0, snapshot.lengthUtf16), reference);
    assert.equal(snapshot.lineCount, countLineBreaks(reference) + 1);
    for (let sample = 0; sample < 6; sample += 1) {
      const at = safeBoundary(reference, random() % (reference.length + 1));
      const line = snapshot.lineIndexAt(offset(at));
      assert.equal(line.ok, true);
      if (line.ok) assert.equal(line.value as number, countLineBreaks(reference.slice(0, at)));
    }
    assert.deepEqual(document.validateInvariants(), [], `T009-REF-250 tree invariant failure at operation ${operation}`);
  }

  assert.equal(read(initialSnapshot, 0, initialSnapshot.lengthUtf16), originalText);
  console.log('T009-REF-250 passed: 250 seeded Unicode edits match the string model and treap aggregates.');
}

function checkBatchEdits(): void {
  const initial = 'alpha\néclair\n😀omega\nend';
  const edits: readonly DocumentEdit[] = [
    { start: offset(1), end: offset(2), text: 'L' },
    { start: offset(7), end: offset(7), text: '!' },
    { start: offset(16), end: offset(17), text: '🙂' },
  ];
  const expected = applyReference(initial, edits);
  for (const ordered of [edits, [...edits].reverse()]) {
    const document = createDocument(initial);
    const applied = document.applyBatch(ordered, document.snapshot().version);
    assert.equal(applied.ok, true);
    const snapshot = document.snapshot();
    assert.equal(read(snapshot, 0, snapshot.lengthUtf16), expected);
    assert.equal(snapshot.version as number, 2, 'one batch publishes one document version');
    assert.deepEqual(document.validateInvariants(), []);
  }

  const unchanged = createDocument(initial);
  const version = unchanged.snapshot().version;
  const overlap = unchanged.applyBatch([
    { start: offset(2), end: offset(8), text: '' },
    { start: offset(7), end: offset(7), text: 'x' },
  ], version);
  assert.equal(overlap.ok, false);
  if (!overlap.ok) assert.equal(overlap.error.kind, 'overlapping-edits');
  assert.equal(read(unchanged.snapshot(), 0, unchanged.snapshot().lengthUtf16), initial);
  assert.equal(unchanged.snapshot().version, version);
  console.log('T009-BATCH-BASE-01 passed: sorted/reversed base-version edits agree; overlap rejection is atomic.');
}

function checkEmptyAndGiantLine(): void {
  const empty = createDocument('');
  const emptySnapshot = empty.snapshot();
  assert.equal(emptySnapshot.lengthUtf16, 0);
  assert.equal(emptySnapshot.lineCount, 1);
  assert.equal(read(emptySnapshot, 0, 0), '');
  assert.equal(emptySnapshot.lineStartOffset(line(0)).ok, true);
  assert.equal(emptySnapshot.lineStartOffset(line(1)).ok, false);

  const giantText = 'x'.repeat(1024 * 1024);
  const giant = createDocument(giantText);
  const giantSnapshot = giant.snapshot();
  assert.equal(giantSnapshot.lengthUtf16, giantText.length);
  assert.equal(giantSnapshot.lineCount, 1);
  assert.equal(read(giantSnapshot, 1019, 1031), 'x'.repeat(12));
  assert.deepEqual(giant.validateInvariants(), []);
  assert.equal(giant.metrics().maximumChunkUtf16 <= 1024, true);
  console.log('T009-EMPTY-01 and T009-GIANT-LINE-01 passed: empty document and 1 MiB single-line reads.');
}

function checkSnapshotsAndCompaction(): void {
  const document = createDocument(('abc🙂\n').repeat(800));
  const original = document.snapshot();
  const originalText = read(original, 0, original.lengthUtf16);
  const firstEdit = document.apply({ start: offset(3), end: offset(3), text: 'X' }, original.version);
  assert.equal(firstEdit.ok, true);
  const current = document.snapshot();
  const currentText = read(current, 0, current.lengthUtf16);
  const compactedVersion = current.version;
  document.compact();
  const compacted = document.snapshot();
  assert.equal(read(compacted, 0, compacted.lengthUtf16), currentText);
  assert.equal(compacted.version, compactedVersion, 'storage-only compaction does not change document version');
  assert.equal(read(original, 0, original.lengthUtf16), originalText, 'old snapshot survives edit and compaction');
  assert.equal(read(current, 0, current.lengthUtf16), currentText, 'pre-compaction snapshot survives compaction');
  assert.deepEqual(document.validateInvariants(), []);
  console.log('T009-SNAPSHOT-COMPACT-01 passed: persistent snapshots remain stable through edits and compaction.');
}

function checkSurrogateSplitAndStaleReads(): void {
  const document = createDocument('A😀B');
  const before = document.snapshot();
  assert.equal(before.lengthUtf16, 4);
  const split = document.apply({ start: offset(2), end: offset(2), text: 'x' }, before.version);
  assert.equal(split.ok, false);
  if (!split.ok) assert.equal(split.error.kind, 'surrogate-split');
  assert.equal(read(document.snapshot(), 0, 4), 'A😀B');
  assert.equal(document.snapshot().version, before.version);
  const stale = document.slice(offset(0), offset(1), documentVersion((before.version as number) + 1));
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.kind, 'stale-version');
  const unpaired = document.apply({ start: offset(1), end: offset(3), text: '\ud800' }, before.version);
  assert.equal(unpaired.ok, false);
  if (!unpaired.ok) assert.equal(unpaired.error.kind, 'invalid-text');
  console.log('FC-T004-SURROGATE-01 passed: split edits and malformed UTF-16 are rejected without text/version changes.');
}

function createDocument(text: string): RopeDocument {
  const id = asIdentifier<DocumentId>('test-document', 'documentId');
  if (!id.ok) throw new Error(id.error.message);
  const result = RopeDocument.create(id.value, text, SEED);
  if (!result.ok) throw new Error(`document-create-failed:${result.error.kind}`);
  return result.value;
}

function read(snapshot: ReturnType<RopeDocument['snapshot']>, start: number, end: number): string {
  const result = snapshot.slice(offset(start), offset(end));
  if (!result.ok) throw new Error(`snapshot-slice-failed:${result.error.kind}`);
  return result.value;
}

function offset(value: number): Utf16Offset { return value as Utf16Offset; }
function line(value: number): LineIndex { return value as LineIndex; }
function documentVersion(value: number): DocumentVersion { return value as DocumentVersion; }

function countLineBreaks(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) count += 1;
  return count;
}

function safeBoundary(text: string, requested: number): number {
  const boundary = Math.max(0, Math.min(text.length, requested));
  return boundary > 0 && boundary < text.length
    && text.charCodeAt(boundary - 1) >= 0xd800 && text.charCodeAt(boundary - 1) <= 0xdbff
    && text.charCodeAt(boundary) >= 0xdc00 && text.charCodeAt(boundary) <= 0xdfff
    ? boundary + 1
    : boundary;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function applyReference(text: string, edits: readonly DocumentEdit[]): string {
  let output = text;
  for (const edit of [...edits].sort((left, right) => right.start - left.start || right.end - left.end)) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  return output;
}

if (import.meta.main) runDocumentStorageChecks();
