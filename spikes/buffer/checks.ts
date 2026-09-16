import { strict as assert } from 'node:assert';
import { BatchCancelledError, applyReference, mapAnchorReference, mapAnchors, type TextAnchor, type TextEdit } from './model';
import type { BufferAdapter, CandidateDefinition } from './adapter';
import { safeBoundary, seededRandom, t004Seed } from './corpora';

export interface CandidateCheckResult {
  readonly candidateId: string;
  readonly referenceOperations: number;
  readonly surrogateBoundaryRejected: boolean;
  readonly cancellationCompletedEdits: number;
  readonly snapshotStable: boolean;
  readonly batchOrdersEquivalent: boolean;
  readonly anchorMapScannedEdits: number;
}

export function runCandidateChecks(candidate: CandidateDefinition, seedText: string): CandidateCheckResult {
  const text = seedText.slice(0, 16_384);
  const model = candidate.open(text, t004Seed);
  let reference = text;
  const random = seededRandom(t004Seed);
  const replacementChoices = ['x', 'é', '🙂', '\n', '\t', ''] as const;

  const firstSnapshot = model.capture();
  const firstText = reference;
  for (let operation = 0; operation < 250; operation += 1) {
    const start = safeBoundary(reference, random() % (reference.length + 1));
    const requestedEnd = Math.min(reference.length, start + (random() % 8));
    const end = Math.max(start, safeBoundary(reference, requestedEnd));
    const replacement = replacementChoices[random() % replacementChoices.length] ?? 'x';
    const beforeLast = reference;
    model.replace(start, end, replacement, true);
    reference = applyReference(reference, [{ start, end, text: replacement }]);
    assert.equal(model.text(), reference, `${candidate.id} reference mismatch at operation ${operation}`);
    assert.equal(model.length, reference.length, `${candidate.id} UTF-16 length mismatch at operation ${operation}`);
    if (operation % 17 === 0) checkLineLookups(model, reference, random, 16);
    if (operation === 249) {
      assert.equal(model.undo(), true, `${candidate.id} expected retained root for undo`);
      assert.equal(model.text(), beforeLast, `${candidate.id} undo did not restore the previous root`);
      reference = beforeLast;
    }
  }
  const snapshotStable = firstSnapshot.text() === firstText && firstSnapshot.version === 1;
  assert.equal(snapshotStable, true, `${candidate.id} snapshot root changed after later edits`);

  const batchOrdersEquivalent = checkBatchOrders(candidate);
  const cancellationCompletedEdits = checkCancellation(candidate);
  const surrogateBoundaryRejected = checkSurrogateBoundary(candidate);
  const anchorMapScannedEdits = checkAnchors();
  return {
    candidateId: candidate.id,
    referenceOperations: 250,
    surrogateBoundaryRejected,
    cancellationCompletedEdits,
    snapshotStable,
    batchOrdersEquivalent,
    anchorMapScannedEdits,
  };
}

export function createBatchEdits(length: number, count: number, order: 'sorted' | 'reversed'): TextEdit[] {
  if (count <= 0 || count >= length) throw new Error(`invalid-batch-fixture-size: ${count}/${length}`);
  const positions = Array.from({ length: count }, (_item, index) => Math.floor(((index + 1) * length) / (count + 1)));
  if (order === 'reversed') positions.reverse();
  return positions.map((start) => ({ start, end: start, text: 'x' }));
}

export function verifyBatchReference(candidate: CandidateDefinition, initialText: string, edits: readonly TextEdit[], expectedVersion = 1): void {
  const model = candidate.open(initialText, t004Seed);
  const expected = applyReference(initialText, edits);
  model.replaceBatch(edits, expectedVersion);
  assert.equal(model.text(), expected, `${candidate.id} batch result differs from reference`);
  assert.equal(model.version, expectedVersion + 1, `${candidate.id} batch must publish one version`);
}

function checkLineLookups(model: BufferAdapter, text: string, random: () => number, samples: number): void {
  for (let index = 0; index < samples; index += 1) {
    const offset = safeBoundary(text, random() % (text.length + 1));
    const expected = countLinesBefore(text, offset);
    assert.equal(model.lineIndexAt(offset), expected, `line lookup mismatch at UTF-16 offset ${offset}`);
  }
}

function checkBatchOrders(candidate: CandidateDefinition): boolean {
  const source = 'alpha\néclair\n😀omega\nend';
  const edits: readonly TextEdit[] = [
    { start: 1, end: 2, text: 'L' },
    { start: 7, end: 7, text: '!' },
    { start: 16, end: 17, text: '🙂' },
  ];
  const sorted = [...edits];
  const reversed = [...edits].reverse();
  verifyBatchReference(candidate, source, sorted);
  verifyBatchReference(candidate, source, reversed);
  return applyReference(source, sorted) === applyReference(source, reversed);
}

function checkCancellation(candidate: CandidateDefinition): number {
  const initial = 'abcdefghijklmnop';
  const model = candidate.open(initial, t004Seed);
  const originalVersion = model.version;
  const edits = Array.from({ length: 6 }, (_item, index) => ({ start: index * 2, end: index * 2, text: '!' }));
  let checks = 0;
  let caught: unknown;
  try {
    model.replaceBatch(edits, originalVersion, false, () => {
      checks += 1;
      return checks === 4;
    });
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof BatchCancelledError, `${candidate.id} did not report cancellation`);
  assert.equal(caught.completedEdits, 3);
  assert.equal(model.text(), initial, `${candidate.id} exposed partial text after cancelled batch`);
  assert.equal(model.version, originalVersion, `${candidate.id} advanced version after cancelled batch`);
  return caught.completedEdits;
}

function checkSurrogateBoundary(candidate: CandidateDefinition): boolean {
  const model = candidate.open('A😀B', t004Seed);
  const originalVersion = model.version;
  let caught: unknown;
  try {
    model.replace(2, 2, 'x');
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof Error && /edit-splits-surrogate/u.test(caught.message));
  assert.equal(model.text(), 'A😀B', `${candidate.id} mutated around rejected surrogate boundary`);
  assert.equal(model.version, originalVersion);
  return true;
}

function checkAnchors(): number {
  const edits: readonly TextEdit[] = [
    { start: 2, end: 2, text: 'XY' },
    { start: 5, end: 8, text: 'q' },
    { start: 12, end: 14, text: '' },
  ];
  const anchors: TextAnchor[] = [];
  for (let offset = 0; offset <= 20; offset += 1) {
    anchors.push({ id: offset * 2, offset, affinity: 'left' });
    anchors.push({ id: offset * 2 + 1, offset, affinity: 'right' });
  }
  const sorted = mapAnchors(anchors, edits);
  const reversed = mapAnchors([...anchors].reverse(), [...edits].reverse());
  const reversedById = new Map(reversed.anchors.map((anchor) => [anchor.id, anchor.mappedOffset]));
  for (const anchor of anchors) {
    assert.equal(sorted.anchors[anchor.id]?.mappedOffset, mapAnchorReference(anchor, edits));
    assert.equal(reversedById.get(anchor.id), mapAnchorReference(anchor, edits));
  }
  assert.equal(sorted.anchorSorts, 0);
  assert.equal(reversed.anchorSorts, 1);
  return sorted.scannedEdits;
}

function countLinesBefore(text: string, offset: number): number {
  let lines = 0;
  for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) lines += 1;
  return lines;
}
