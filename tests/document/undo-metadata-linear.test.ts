import { strict as assert } from 'node:assert';
import { asIdentifier, asUndoGroupId, type DocumentId, type UndoGroupId, type Utf16Offset } from '../../packages/primitives/src/index';
import { LineEndingSequence, TextFileDocument } from '../../packages/document/src/index';

const idResult = asIdentifier<DocumentId>('T-undo-metadata-linear', 'documentId');
const documentId: DocumentId = idResult.ok
  ? idResult.value
  : (() => { throw new Error(idResult.error.message); })();

function group(value: string): UndoGroupId {
  const result = asUndoGroupId(value);
  if (!result.ok) throw new Error(`invalid-group:${value}`);
  return result.value;
}

function create(text: string): TextFileDocument {
  const result = TextFileDocument.create(documentId, text, LineEndingSequence.fromUniform(0, 'lf'), 'lf');
  if (!result.ok) throw new Error(`document-create-failed:${result.error.kind}`);
  return result.value;
}

/**
 * Every insert lands at offset 0 (prepending), which never matches
 * `coalesceInsertSteps`'s "starts where the previous insert ended" rule, so
 * each commit appends a brand-new, non-coalescing step to the open undo
 * group's `steps` array. Before the fix, `record()` recomputed the group's
 * metadata byte total by reducing over every accumulated step on every
 * commit, making this loop O(n^2) in the commit count.
 */
function runCommits(count: number): { readonly elapsedMs: number; readonly retainedMetadataBytes: number } {
  const document = create('');
  const undoGroup = group(`T-undo-metadata-linear-${count}`);
  assert.equal(document.beginUndoGroup(undoGroup, 'vim').ok, true);
  const started = performance.now();
  for (let index = 0; index < count; index += 1) {
    const committed = document.commit({
      documentId,
      expectedVersion: document.version,
      edits: [{ start: 0 as Utf16Offset, end: 0 as Utf16Offset, text: 'x' }],
      origin: 'vim',
      undoGroup,
    });
    assert.equal(committed.ok, true, `insert ${index} commits`);
  }
  const elapsedMs = performance.now() - started;
  assert.equal(document.endUndoGroup(undoGroup).ok, true);
  const stats = document.undoHistoryStats();
  assert.equal(stats.stepCount, count, 'non-adjacent inserts remain distinct, non-coalesced steps');
  assert.ok(stats.retainedMetadataBytes > 0, 'retained metadata bytes must be positive');
  return { elapsedMs, retainedMetadataBytes: stats.retainedMetadataBytes };
}

// Warm up the JIT before measuring so the ratio reflects algorithmic
// complexity rather than one-time compilation cost.
runCommits(200);

const small = runCommits(1_000);
const large = runCommits(5_000);

assert.ok(
  large.retainedMetadataBytes > small.retainedMetadataBytes,
  `retained metadata bytes must be monotone in step count, got ${small.retainedMetadataBytes} then ${large.retainedMetadataBytes}`,
);

const ratio = large.elapsedMs / Math.max(small.elapsedMs, 0.05);
assert.ok(
  ratio < 10,
  `5x more commits into one non-coalescing undo group should scale ~linearly, not quadratically; got ${small.elapsedMs.toFixed(3)}ms for 1000 and ${large.elapsedMs.toFixed(3)}ms for 5000 (ratio ${ratio.toFixed(2)})`,
);

console.log(
  `T-UNDO-METADATA-LINEAR-01 passed: 1000 commits ${small.elapsedMs.toFixed(3)}ms (metadata ${small.retainedMetadataBytes}B), `
  + `5000 commits ${large.elapsedMs.toFixed(3)}ms (metadata ${large.retainedMetadataBytes}B), ratio ${ratio.toFixed(2)}.`,
);
