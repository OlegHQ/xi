import { strict as assert } from 'node:assert';
import {
  asIdentifier,
  asUndoGroupId,
  type DocumentId,
  type DocumentVersion,
  type Utf16Offset,
} from '../../packages/primitives/src/index';
import {
  createDocumentAnchor,
  INSERTION_REPLACEMENT_BOUNDARY_POLICY,
  openTextDocument,
  SAME_POSITION_INSERT_POLICY,
  type CommittedDocumentChange,
  type DocumentAnchor,
  type DocumentEdit,
  type EditProposal,
  TextFileDocument,
} from '../../packages/document/src/index';
import * as documentApi from '../../packages/document/src/index';
import { RopeDocument } from '../../packages/document/src/rope';

const idResult = asIdentifier<DocumentId>('T011-transactions', 'documentId');
if (!idResult.ok) throw new Error(idResult.error.message);
const documentId = idResult.value;

function checkAtomicValidationAndExplicitConflictPolicies(): void {
  const document = editable('abcdef');
  const before = document.snapshot();
  const seen: CommittedDocumentChange[] = [];
  document.subscribeChanges((change) => seen.push(change));

  const overlapping = document.commit(proposal(document, [
    { start: offset(1), end: offset(4), text: '' },
    { start: offset(3), end: offset(5), text: 'x' },
  ]));
  assert.equal(overlapping.ok, false);
  if (!overlapping.ok) assert.equal(overlapping.error.kind, 'overlapping-edits');
  assertUnchanged(document, before, 'T011-INVALID-BATCH-01');
  assert.equal(seen.length, 0, 'a rejected transaction emits no change event');

  const samePosition = document.commit(proposal(document, [
    { start: offset(2), end: offset(2), text: 'a' },
    { start: offset(2), end: offset(2), text: 'b' },
  ]));
  assert.equal(SAME_POSITION_INSERT_POLICY, 'reject');
  assert.equal(samePosition.ok, false);
  if (!samePosition.ok) assert.equal(samePosition.error.kind, 'overlapping-edits');
  assertUnchanged(document, before, 'T011-SAME-POSITION-INSERT-01');

  const boundaryInsert = document.commit(proposal(document, [
    { start: offset(1), end: offset(3), text: 'R' },
    { start: offset(3), end: offset(3), text: 'I' },
  ]));
  assert.equal(INSERTION_REPLACEMENT_BOUNDARY_POLICY, 'reject');
  assert.equal(boundaryInsert.ok, false);
  if (!boundaryInsert.ok) assert.equal(boundaryInsert.error.kind, 'ambiguous-insertion-boundary');
  assertUnchanged(document, before, 'T011-BOUNDARY-INSERT-01');

  const stale = document.commit(proposal(document, [
    { start: offset(0), end: offset(0), text: '!' },
  ], documentVersion((before.version as number) - 1)));
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.kind, 'stale-version');
  assertUnchanged(document, before, 'T011-STALE-VERSION-01');

  const noOp = document.commit(proposal(document, [
    { start: offset(2), end: offset(2), text: '' },
  ]));
  assert.equal(noOp.ok, true);
  if (noOp.ok) assert.equal(noOp.value.kind, 'unchanged');
  assertUnchanged(document, before, 'T011-NO-OP-01');
  assert.equal(seen.length, 0, 'no-op edit batches do not publish phantom revisions');

  const adjacent = document.commit(proposal(document, [
    { start: offset(1), end: offset(2), text: 'X' },
    { start: offset(2), end: offset(3), text: 'Y' },
  ]));
  assert.equal(adjacent.ok, true, 'adjacent nonempty edits are valid');
  if (adjacent.ok && adjacent.value.kind === 'committed') {
    assert.deepEqual(adjacent.value.change.changedSpans.map((span) => [span.start, span.oldEnd]), [[1, 2], [2, 3]]);
  }
  assert.equal(seen.length, 1, 'one accepted batch produces exactly one event');
  console.log('T011-INVALID-BATCH-01 passed: overlap, stale, coincident insert and ambiguous-boundary failures are atomic; adjacent edits commit once.');
}

function checkAnchorAffinityRulesAndSortedEndpoints(): void {
  const insertionDocument = editable('abcd');
  const insertionBefore = insertionDocument.snapshot();
  const insertion = insertionDocument.commit(proposal(insertionDocument, [
    { start: offset(2), end: offset(2), text: 'XY' },
  ]));
  assert.equal(insertion.ok, true);
  if (!insertion.ok || insertion.value.kind !== 'committed') throw new Error('expected insertion commit');
  const atInsertion = anchors(insertionBefore, [2, 2, 3], ['left', 'right', 'left']);
  const inserted = insertion.value.change.changeMap.mapSortedAnchors(atInsertion);
  assert.equal(inserted.ok, true);
  if (inserted.ok) assert.deepEqual(inserted.value.map((anchor) => anchor.offset as number), [2, 4, 5]);

  const deletionDocument = editable('abcdef');
  const deletionBefore = deletionDocument.snapshot();
  const deletion = deletionDocument.commit(proposal(deletionDocument, [
    { start: offset(2), end: offset(5), text: '' },
  ]));
  assert.equal(deletion.ok, true);
  if (!deletion.ok || deletion.value.kind !== 'committed') throw new Error('expected deletion commit');
  const insideDeletion = anchors(deletionBefore, [2, 3, 3, 5], ['left', 'left', 'right', 'right']);
  const deleted = deletion.value.change.changeMap.mapSortedAnchors(insideDeletion);
  assert.equal(deleted.ok, true);
  if (deleted.ok) assert.deepEqual(deleted.value.map((anchor) => anchor.offset as number), [2, 2, 2, 2]);

  const replacementDocument = editable('abcdef');
  const replacementBefore = replacementDocument.snapshot();
  const replacement = replacementDocument.commit(proposal(replacementDocument, [
    { start: offset(2), end: offset(5), text: 'XY' },
  ]));
  assert.equal(replacement.ok, true);
  if (!replacement.ok || replacement.value.kind !== 'committed') throw new Error('expected replacement commit');
  const aroundReplacement = anchors(replacementBefore, [2, 2, 3, 3, 5, 6], ['left', 'right', 'left', 'right', 'left', 'right']);
  const replaced = replacement.value.change.changeMap.mapSortedAnchors(aroundReplacement);
  assert.equal(replaced.ok, true);
  if (replaced.ok) assert.deepEqual(replaced.value.map((anchor) => anchor.offset as number), [2, 4, 2, 4, 4, 5]);

  const adjacentDocument = editable('abcdef');
  const adjacentBefore = adjacentDocument.snapshot();
  const adjacent = adjacentDocument.commit(proposal(adjacentDocument, [
    { start: offset(1), end: offset(2), text: 'XYZ' },
    { start: offset(2), end: offset(3), text: 'Q' },
  ]));
  assert.equal(adjacent.ok, true);
  if (!adjacent.ok || adjacent.value.kind !== 'committed') throw new Error('expected adjacent replacement commit');
  const seam = anchors(adjacentBefore, [2, 2], ['left', 'right']);
  const mappedSeam = adjacent.value.change.changeMap.mapSortedAnchors(seam);
  assert.equal(mappedSeam.ok, true);
  if (mappedSeam.ok) assert.deepEqual(mappedSeam.value.map((anchor) => anchor.offset as number), [4, 5]);

  const unsorted = adjacent.value.change.changeMap.mapSortedAnchors([
    seam[0] as DocumentAnchor,
    anchor(adjacentBefore, 1, 'left'),
  ]);
  assert.equal(unsorted.ok, false);
  if (!unsorted.ok) assert.equal(unsorted.error.kind, 'invalid-anchor-order');

  const unicode = editable('A😀B').snapshot();
  const splitSurrogate = createDocumentAnchor(unicode, offset(2), 'left');
  assert.equal(splitSurrogate.ok, false);
  if (!splitSurrogate.ok) assert.equal(splitSurrogate.error.kind, 'surrogate-split');
  console.log('T011-ANCHOR-AFFINITY-01 passed: insertion, replacement, deletion, adjacent seam and sorted-endpoint affinity rules are explicit.');
}

function checkGeneratedAnchorMapsAgainstReference(): void {
  const source = '0123456789abcdefghijklmnopqrstuv';
  const random = seededRandom(731_904);
  for (let run = 0; run < 128; run += 1) {
    const document = editable(source);
    const before = document.snapshot();
    const edits: DocumentEdit[] = [];
    for (let slot = 0; slot < 8; slot += 1) {
      const start = 1 + slot * 4;
      const removed = random() % 3;
      const inserted = removed === 0
        ? (random() % 2 === 0 ? 'I' : 'XY')
        : (random() % 3 === 0 ? '' : random() % 2 === 0 ? 'R' : 'ST');
      edits.push({ start: offset(start), end: offset(start + removed), text: inserted });
    }
    const committed = document.commit(proposal(document, edits));
    assert.equal(committed.ok, true, `T011-ANCHOR-GENERATED-01 transaction ${run}`);
    if (!committed.ok || committed.value.kind !== 'committed') continue;

    const endpoints: DocumentAnchor[] = [];
    for (let position = 0; position <= source.length; position += 1) {
      endpoints.push(anchor(before, position, 'left'));
      endpoints.push(anchor(before, position, 'right'));
    }
    const mapped = committed.value.change.changeMap.mapSortedAnchors(endpoints);
    assert.equal(mapped.ok, true, `T011-ANCHOR-GENERATED-01 map ${run}`);
    if (mapped.ok) {
      assert.deepEqual(
        mapped.value.map((item) => item.offset as number),
        endpoints.map((item) => referenceMap(item.offset as number, item.affinity, edits)),
        `T011-ANCHOR-GENERATED-01 reference mismatch ${run}`,
      );
    }
    assert.equal(readAll(document), applyReference(source, edits), `T011-ANCHOR-GENERATED-01 text ${run}`);
  }
  console.log('T011-ANCHOR-GENERATED-01 passed: 128 seeded mixed insertion/deletion/replacement batches map all endpoints like the reference.');
}

function checkGeneratedOverlappingBatchesAreAtomic(): void {
  const source = '0123456789abcdefghijklmnopqrstuvwxyz';
  const random = seededRandom(902_417);
  for (let run = 0; run < 128; run += 1) {
    const document = editable(source);
    const before = document.snapshot();
    const start = random() % 24;
    const firstEnd = start + 4 + (random() % 4);
    const secondStart = start + (random() % 4);
    const secondEnd = Math.min(source.length, Math.max(secondStart + 1, firstEnd + (random() % 3)));
    const edits: DocumentEdit[] = [
      { start: offset(start), end: offset(firstEnd), text: '' },
      { start: offset(secondStart), end: offset(secondEnd), text: 'X' },
    ];
    if (run % 2 === 1) edits.reverse();
    let events = 0;
    document.subscribeChanges(() => { events += 1; });
    const rejected = document.commit(proposal(document, edits));
    assert.equal(rejected.ok, false, `T011-GENERATED-OVERLAP-01 transaction ${run}`);
    if (!rejected.ok) assert.equal(rejected.error.kind, 'overlapping-edits');
    assertUnchanged(document, before, `T011-GENERATED-OVERLAP-01:${run}`);
    assert.equal(events, 0, `T011-GENERATED-OVERLAP-01 event ${run}`);
  }
  console.log('T011-GENERATED-OVERLAP-01 passed: 128 seeded overlapping batches reject atomically in both input orders.');
}

function checkRevisionStreamAndSavedIdentity(): void {
  const document = editable('first\nsecond');
  const savedAtOpen = document.snapshot();
  assert.equal(document.isDirty, false);
  const viewA: CommittedDocumentChange[] = [];
  const viewB: CommittedDocumentChange[] = [];
  let reentrantKind: string | undefined;
  document.subscribeChanges((change) => {
    viewA.push(change);
    const nested = document.commit(proposal(document, [
      { start: offset(0), end: offset(0), text: '!' },
    ], change.after));
    if (!nested.ok) reentrantKind = nested.error.kind;
  });
  document.subscribeChanges((change) => viewB.push(change));

  const edit = document.commit(proposal(document, [
    { start: offset(0), end: offset(5), text: 'FIRST' },
  ], document.version, 'lsp'));
  assert.equal(edit.ok, true);
  if (!edit.ok || edit.value.kind !== 'committed') throw new Error('expected revision commit');
  assert.equal(viewA.length, 1);
  assert.equal(viewB.length, 1);
  assert.equal(viewA[0], viewB[0], 'views consume the same immutable event object');
  assert.equal(edit.value.change.before, savedAtOpen.version);
  assert.equal(edit.value.change.after as number, (savedAtOpen.version as number) + 1);
  assert.equal(edit.value.change.beforeRevisionId, savedAtOpen.revisionId);
  assert.equal(document.isDirty, true);
  assert.equal(reentrantKind, 'reentrant-transaction', 'observers cannot commit while a revision is being published');

  const markedOldSave = document.markSaved(savedAtOpen);
  assert.equal(markedOldSave.ok, true);
  assert.equal(document.isDirty, true, 'finishing an older save does not mark newer text clean');
  const capturedForSave = document.snapshot();
  const newerEdit = document.commit(proposal(document, [
    { start: offset(document.snapshot().lengthUtf16), end: offset(document.snapshot().lengthUtf16), text: '!' },
  ]));
  assert.equal(newerEdit.ok, true);
  assert.equal(document.markSaved(capturedForSave).ok, true);
  assert.equal(document.isDirty, true, 'save completion is tied to its captured revision identity');
  assert.equal(document.markSaved(document.snapshot()).ok, true);
  assert.equal(document.isDirty, false);

  const otherId = asIdentifier<DocumentId>('T011-other-document', 'documentId');
  if (!otherId.ok) throw new Error(otherId.error.message);
  const wrongDocument = editable('other', otherId.value).snapshot();
  const wrongSave = document.markSaved(wrongDocument);
  assert.equal(wrongSave.ok, false);
  if (!wrongSave.ok) assert.equal(wrongSave.error.kind, 'wrong-document');
  const unknownRevision = document.markSaved({ id: documentId, revisionId: 10_000 as typeof document.revisionId });
  assert.equal(unknownRevision.ok, false);
  if (!unknownRevision.ok) assert.equal(unknownRevision.error.kind, 'unknown-revision');
  assert.equal(viewA.length, 2);
  assert.equal(viewB.length, 2);
  assert.deepEqual(viewA.map((change) => change.after as number), [2, 3]);
  console.log('T011-REVISION-STREAM-01 passed: two subscribers share ordered events; versions, revision identity and captured-save dirty state agree.');
}

function checkListenerFailureIsolationAndDuplicateSubscriptions(): void {
  const document = editable('listener');
  let sharedListenerCalls = 0;
  let afterThrowCalls = 0;
  const expectedError = new Error('T011-LISTENER-THROW-01');
  const sharedListener = (): void => { sharedListenerCalls += 1; };
  const firstRegistration = document.subscribeChanges(sharedListener);
  const secondRegistration = document.subscribeChanges(sharedListener);
  firstRegistration.dispose();
  document.subscribeChanges(() => { throw expectedError; });
  document.subscribeChanges(() => { afterThrowCalls += 1; });

  const committed = document.commit(proposal(document, [
    { start: offset(0), end: offset(0), text: '!' },
  ]));
  assert.equal(committed.ok, true, 'observer failures cannot make an already-applied commit look rejected');
  assert.equal(sharedListenerCalls, 1, 'disposing one duplicate registration preserves the other');
  assert.equal(afterThrowCalls, 1, 'a throwing listener cannot interrupt later deliveries');
  const failures = document.drainChangeListenerFailures();
  assert.equal(failures.droppedCount, 0);
  assert.equal(failures.failures.length, 1);
  assert.equal(failures.failures[0]?.afterVersion, document.version);
  assert.equal(failures.failures[0]?.error, expectedError);
  secondRegistration.dispose();
  assert.equal(document.drainChangeListenerFailures().failures.length, 0);
  console.log('T011-LISTENER-DELIVERY-01 passed: duplicate registrations dispose independently; thrown observers are retained and later listeners still receive commits.');
}

function checkRuntimeSnapshotEncapsulationAndPublicOwnerBoundary(): void {
  assert.equal(Object.hasOwn(documentApi, 'RopeDocument'), false, 'mutable rope storage is not part of the public package barrel');
  const rawRope = RopeDocument.create(documentId, 'protected');
  if (!rawRope.ok) throw new Error('expected internal rope');
  const oldRopeSnapshot = rawRope.value.snapshot();
  assert.equal(Object.hasOwn(oldRopeSnapshot, 'root'), false);
  assert.equal(Reflect.get(oldRopeSnapshot, 'root'), undefined);
  assert.equal(Reflect.set(oldRopeSnapshot, 'root', { chunk: { text: 'corrupt' } }), false);
  const rawApply = rawRope.value.apply({ start: offset(0), end: offset(0), text: 'x' }, oldRopeSnapshot.version);
  assert.equal(rawApply.ok, true);
  assert.equal(readSnapshot(oldRopeSnapshot), 'protected', 'a retained immutable root snapshot survives later owner edits');

  const document = editable('protected');
  const oldTextSnapshot = document.snapshot();
  assert.equal(Object.hasOwn(oldTextSnapshot, 'text'), false);
  assert.equal(Object.hasOwn(oldTextSnapshot, 'lineEndingSequence'), false);
  assert.equal(Object.hasOwn(document, 'textDocument'), false);
  assert.equal(Object.hasOwn(document, 'lineEndings'), false);
  assert.equal(Reflect.get(oldTextSnapshot, 'text'), undefined);
  assert.equal(Reflect.set(oldTextSnapshot, 'text', { root: { chunk: { text: 'corrupt' } } }), false);
  const RuntimeConstructor = TextFileDocument as unknown as new (...args: unknown[]) => TextFileDocument;
  assert.throws(() => new RuntimeConstructor(Symbol()), /TextFileDocument-constructor-is-private/);
  const edited = document.commit(proposal(document, [
    { start: offset(0), end: offset(0), text: 'x' },
  ]));
  assert.equal(edited.ok, true);
  assert.equal(readAllSnapshot(oldTextSnapshot), 'protected');
  assert.equal(readAll(document), 'xprotected');
  console.log('T011-IMMUTABLE-OWNER-01 passed: snapshots have no runtime backing-field path, and the public owner cannot be wired to an independently mutable rope.');
}

function editable(text: string, id: DocumentId = documentId): TextFileDocument {
  const opened = openTextDocument(id, new TextEncoder().encode(text));
  if (opened.kind !== 'editable') throw new Error('expected editable UTF-8 document');
  return opened.document;
}

function proposal(
  document: TextFileDocument,
  edits: readonly DocumentEdit[],
  expectedVersion: DocumentVersion = document.version,
  origin: EditProposal['origin'] = 'formatter',
): EditProposal {
  const group = asUndoGroupId(`test-group-${expectedVersion as number}`);
  if (!group.ok) throw new Error(group.error.message);
  return { documentId: document.id, expectedVersion, edits, origin, undoGroup: group.value };
}

function anchors(snapshot: ReturnType<TextFileDocument['snapshot']>, positions: readonly number[], affinities: readonly ('left' | 'right')[]): DocumentAnchor[] {
  return positions.map((position, index) => anchor(snapshot, position, affinities[index] ?? 'left'));
}

function anchor(snapshot: ReturnType<TextFileDocument['snapshot']>, position: number, affinity: 'left' | 'right'): DocumentAnchor {
  const result = createDocumentAnchor(snapshot, offset(position), affinity);
  if (!result.ok) throw new Error(`anchor-create-failed:${result.error.kind}:${position}`);
  return result.value;
}

function assertUnchanged(document: TextFileDocument, before: ReturnType<TextFileDocument['snapshot']>, fixture: string): void {
  const after = document.snapshot();
  assert.equal(readAll(document), readAllSnapshot(before), `${fixture} text`);
  assert.equal(after.version, before.version, `${fixture} version`);
  assert.equal(after.revisionId, before.revisionId, `${fixture} revision identity`);
  assert.equal(document.savedRevisionId, before.revisionId, `${fixture} saved identity`);
  assert.equal(document.isDirty, false, `${fixture} dirty flag`);
}

function readAll(document: TextFileDocument): string { return readAllSnapshot(document.snapshot()); }

function readAllSnapshot(snapshot: ReturnType<TextFileDocument['snapshot']>): string {
  const content = snapshot.slice(offset(0), offset(snapshot.lengthUtf16));
  if (!content.ok) throw new Error(`snapshot-read-failed:${content.error.kind}`);
  return content.value;
}

function readSnapshot(snapshot: ReturnType<RopeDocument['snapshot']>): string {
  const content = snapshot.slice(offset(0), offset(snapshot.lengthUtf16));
  if (!content.ok) throw new Error(`snapshot-read-failed:${content.error.kind}`);
  return content.value;
}

function applyReference(text: string, edits: readonly DocumentEdit[]): string {
  let output = text;
  for (const edit of [...edits].sort((left, right) => right.start - left.start || right.end - left.end)) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  return output;
}

function referenceMap(position: number, affinity: 'left' | 'right', edits: readonly DocumentEdit[]): number {
  let delta = 0;
  for (const edit of [...edits].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const start = edit.start as number;
    const end = edit.end as number;
    if (position < start) return position + delta;
    if (position === start && start === end) return start + delta + (affinity === 'right' ? edit.text.length : 0);
    if (position === start || position < end) return start + delta + (affinity === 'right' ? edit.text.length : 0);
    delta += edit.text.length - (end - start);
  }
  return position + delta;
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

function offset(value: number): Utf16Offset { return value as Utf16Offset; }
function documentVersion(value: number): DocumentVersion { return value as DocumentVersion; }

checkAtomicValidationAndExplicitConflictPolicies();
checkAnchorAffinityRulesAndSortedEndpoints();
checkGeneratedAnchorMapsAgainstReference();
checkGeneratedOverlappingBatchesAreAtomic();
checkRevisionStreamAndSavedIdentity();
checkListenerFailureIsolationAndDuplicateSubscriptions();
checkRuntimeSnapshotEncapsulationAndPublicOwnerBoundary();
