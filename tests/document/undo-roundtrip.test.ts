import { strict as assert } from 'node:assert';
import {
  asIdentifier,
  asUndoGroupId,
  type DocumentId,
  type UndoGroupId,
  type Utf16Offset,
} from '../../packages/primitives/src/index';
import {
  openTextDocument,
  openTextDocumentChunks,
  TextFileDocument,
} from '../../packages/document/src/index';

const SEED = 41027;

function checkCoalescedGroupRoundTrips(): void {
  // Two chars typed under one undo group used to leave the entry's id (fixed at the
  // first change's revision) mismatched with its coalesced steps[0].afterRevisionId
  // (advanced to the latest revision), failing decode with 'invalid-history-graph'.
  const document = createDocument('abc\n');
  const group = groupId('undo-roundtrip-coalesce');
  assert.equal(document.beginUndoGroup(group, 'vim').ok, true);
  assert.equal(commit(document, group, [{ start: offset(0), end: offset(0), text: 'x' }]).ok, true);
  assert.equal(commit(document, group, [{ start: offset(1), end: offset(1), text: 'y' }]).ok, true);
  assert.equal(document.endUndoGroup(group).ok, true);
  assert.equal(read(document), 'xyabc\n');

  const historyBytes = document.serializeUndoHistory();
  assert.equal(historyBytes.ok, true, 'a coalesced two-commit group serializes');
  const fresh = reopen(document);
  if (!historyBytes.ok) return;
  const restored = fresh.restoreUndoHistory(historyBytes.value);
  assert.equal(restored.ok, true, 'the coalesced group round-trips through decodeUndoHistory');
  assert.equal(fresh.undo().ok, true);
  assert.equal(read(fresh), 'abc\n');
  console.log('UNDO-ROUNDTRIP-COALESCE-01 passed: a two-commit coalesced group serializes/restores and undoes as one step.');
}

function checkAmbiguousBatchInverseRoundTrips(): void {
  // combineAmbiguousInverseEdits can merge touching inverse edits into fewer entries than
  // forwardEdits; validateStep used to reject any length mismatch as 'invalid-history-graph'.
  const document = createDocument('abcdef\n');
  const applied = document.applyBatch([
    { start: offset(1), end: offset(2), text: '' },
    { start: offset(2), end: offset(4), text: 'ZZZ' },
  ], document.version);
  assert.equal(applied.ok, true);
  assert.equal(read(document), 'aZZZef\n');

  const historyBytes = document.serializeUndoHistory();
  assert.equal(historyBytes.ok, true, 'an adjacent delete+replace batch serializes');
  const fresh = reopen(document);
  if (!historyBytes.ok) return;
  const restored = fresh.restoreUndoHistory(historyBytes.value);
  assert.equal(restored.ok, true, 'the ambiguous-inverse batch round-trips through decodeUndoHistory');
  assert.equal(document.undo().ok, true);
  assert.equal(read(document), 'abcdef\n');
  console.log('UNDO-ROUNDTRIP-BATCH-01 passed: applyBatch([{1,2,\'\'},{2,4,\'ZZZ\'}]) serializes/restores and undoes cleanly.');
}

function checkLargeWholeDocumentDeleteUndoes(): void {
  // A whole-document delete on a >1 MiB single-line file returned the same LineEndingSequence
  // object on the forward edit (nothing to splice); replay of the inverse insert then saw
  // candidateEndings === this.#lineEndings and a placeholder-empty-text inverse edit and wrongly
  // reported the undo replay as 'unchanged', permanently failing undo with 'history-replay-failed'.
  const text = 'x'.repeat(1_048_577);
  const opened = openTextDocument(id('undo-roundtrip-large'), new TextEncoder().encode(text));
  assert.equal(opened.kind, 'editable');
  if (opened.kind !== 'editable') return;
  const document = opened.document;
  const deleted = document.apply({ start: offset(0), end: offset(text.length), text: '' }, document.version);
  assert.equal(deleted.ok, true);
  assert.equal(document.snapshot().lengthUtf16, 0);
  const undone = document.undo();
  assert.equal(undone.ok, true, 'undoing a >1 MiB whole-document delete must not fail history replay');
  assert.equal(document.snapshot().lengthUtf16, text.length);
  console.log('UNDO-ROUNDTRIP-LARGE-DELETE-01 passed: undo of a whole-document delete on a >1 MiB single-line file succeeds.');
}

async function checkUnixFileFormatCrlfParity(): Promise<void> {
  // 'unix' keeps every CR byte as literal content; the chunked open path used to classify any
  // \r\n as a 'crlf' line ending regardless of fileFormat, disagreeing with the sync path.
  const bytes = new TextEncoder().encode('a\r\nb\r\n');
  const sync = openTextDocument(id('undo-roundtrip-unix-sync'), bytes, 41027, { fileFormat: 'unix' });
  async function* gen(): AsyncGenerator<Uint8Array> { yield bytes; }
  const chunked = await openTextDocumentChunks(id('undo-roundtrip-unix-chunk'), gen(), 41027, { fileFormat: 'unix' });
  assert.equal(sync.kind, 'editable');
  assert.equal(chunked.kind, 'editable');
  if (sync.kind !== 'editable' || chunked.kind !== 'editable') return;
  const syncSnapshot = sync.document.snapshot();
  const chunkedSnapshot = chunked.document.snapshot();
  const syncText = syncSnapshot.slice(offset(0), offset(syncSnapshot.lengthUtf16));
  const chunkedText = chunkedSnapshot.slice(offset(0), offset(chunkedSnapshot.lengthUtf16));
  assert.equal(syncText.ok, true);
  assert.equal(chunkedText.ok, true);
  if (!syncText.ok || !chunkedText.ok) return;
  assert.equal(syncText.value, 'a\r\nb\r\n', 'unix format keeps CR bytes as literal content');
  assert.equal(chunkedText.value, syncText.value, 'chunked and sync unix opens agree on content');
  assert.deepEqual([...chunkedSnapshot.lineEndings], [...syncSnapshot.lineEndings], 'chunked and sync unix opens agree on line endings (lf only)');
  assert.deepEqual([...syncSnapshot.lineEndings], ['lf', 'lf']);
  console.log('UNDO-ROUNDTRIP-UNIX-CRLF-01 passed: sync and chunked opens agree on \'unix\' fileFormat for a\\r\\nb\\r\\n.');
}

// NOTE: undo.ts:550's prune() guard (`if (this.#current === first) this.#current = null;`) fixes
// a real defect -- pruning the sole root-level entry left #current pointing at the now-emptied
// node, so undoPlan() reported canUndo === true while yielding zero steps. It is not covered by
// a runtime assertion here: canAppend() gates cumulative text/root retention per commit
// (packages/document/src/undo.ts canAppend), and cloneSerializedSelectionValue bounds a single
// selectionHistory payload to ~100,000 nodes (~9.6 MB via estimateSerializedValueBytes' fixed
// per-member cost, itself decoupled from string content size), both well under
// UNDO_HISTORY_POLICY.maxRetainedPrivateBytes (64 MiB) and maxRetainedUtf16 (32 MiB). No cheap,
// legitimate sequence of public commits was found that leaves a single root-level entry over any
// retention cap; the guard is verified by code inspection (it is a pure no-op whenever prune()
// discards anything other than #current itself).

function commit(
  document: TextFileDocument,
  undoGroup: UndoGroupId,
  edits: readonly { readonly start: Utf16Offset; readonly end: Utf16Offset; readonly text: string }[],
) {
  return document.commit({
    documentId: document.id,
    expectedVersion: document.version,
    edits,
    origin: 'vim',
    undoGroup,
  });
}

function createDocument(text: string): TextFileDocument {
  const opened = openTextDocument(id('undo-roundtrip-document'), new TextEncoder().encode(text), SEED);
  if (opened.kind !== 'editable') throw new Error('document-create-not-editable');
  return opened.document;
}

/** Opens a fresh document with the same bytes so restoreUndoHistory sees an empty (version 1) history. */
function reopen(document: TextFileDocument): TextFileDocument {
  const serialized = document.serialize();
  if (!serialized.ok) throw new Error(`document-encode:${serialized.error.kind}`);
  const opened = openTextDocument(document.id, serialized.value);
  if (opened.kind !== 'editable') throw new Error('document-reopen-not-editable');
  return opened.document;
}

function id(value: string): DocumentId {
  const result = asIdentifier<DocumentId>(value, 'documentId');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function groupId(value: string): UndoGroupId {
  const result = asUndoGroupId(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function read(document: TextFileDocument): string {
  const snapshot = document.snapshot();
  const result = snapshot.slice(offset(0), offset(snapshot.lengthUtf16));
  if (!result.ok) throw new Error(`document-read:${result.error.kind}`);
  return result.value;
}

function offset(value: number): Utf16Offset { return value as Utf16Offset; }

export async function runUndoRoundtripChecks(): Promise<void> {
  checkCoalescedGroupRoundTrips();
  checkAmbiguousBatchInverseRoundTrips();
  checkLargeWholeDocumentDeleteUndoes();
  await checkUnixFileFormatCrlfParity();
}

if (import.meta.main) await runUndoRoundtripChecks();
