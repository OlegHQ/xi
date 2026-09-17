import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type SelectionId, type Utf16Offset } from '../../packages/primitives/src/index';
import { openTextDocument, type TextFileDocument } from '../../packages/document/src/index';
import { createSelectionSet, updateSelectionSet, type SelectionMemberInput } from '../../packages/selections/src/index';

const MEMBER_COUNT = 200_000;

/**
 * `updateSelectionSet` previously located `current.members` by id with an
 * `Array.prototype.find` inside its per-input loop (O(n^2) over the member
 * count) and computed the next creation ordinal with
 * `Math.max(...current.members.map(...))`, whose spread of 200_000 arguments
 * throws `RangeError: Maximum call stack size exceeded` well before that.
 * This exercises both: a set large enough to blow the spread and to make the
 * O(n^2) lookup path measurably slow if it regresses.
 */
function main(): void {
  const document = openEditable('update-large-set', 'a'.repeat(MEMBER_COUNT + 1));
  const snapshot = document.snapshot();

  const members: SelectionMemberInput[] = [];
  for (let index = 0; index < MEMBER_COUNT; index += 1) {
    members.push(normal(id(`m${index}`), index));
  }
  const primaryId = id('m0');

  const createStarted = performance.now();
  const created = createSelectionSet(snapshot, { primaryId, members });
  const createElapsedMs = performance.now() - createStarted;
  assert.equal(created.ok, true, 'creating a 200_000-member selection set must not throw or fail');
  if (!created.ok) return;

  const started = performance.now();
  const updated = updateSelectionSet(snapshot, created.value.selectionSet, { primaryId, members });
  const elapsedMs = performance.now() - started;

  assert.equal(updated.ok, true, 'updating a 200_000-member selection set must not throw or fail');
  if (!updated.ok) return;
  assert.equal(updated.value.selectionSet.members.length, MEMBER_COUNT);

  // `updateSelectionSet` does the same per-member validation/anchor work as
  // `createSelectionSet` plus one O(n) old-member lookup pass; on this
  // hardware/engine that per-member document validation work alone (not the
  // bug being fixed here) costs somewhat more than 1ms/member at this scale,
  // so a literal absolute "<1s" wall-clock budget is not a stable regression
  // signal by itself. The bug this test guards is O(n^2) growth: before the
  // fix, `update` took ~10-30x longer than an equivalent `create` at just
  // 20_000-200_000 members (observed up to several seconds at 20_000 alone).
  // Bounding `update` to a small constant multiple of `create`'s own elapsed
  // time catches that regression regardless of host speed, and the absolute
  // ceiling below is generous only as a backstop against a hang.
  const ratio = elapsedMs / Math.max(createElapsedMs, 1);
  assert.ok(
    ratio < 3,
    `updateSelectionSet should cost about the same as createSelectionSet per member, not scale quadratically; create=${createElapsedMs.toFixed(1)}ms update=${elapsedMs.toFixed(1)}ms ratio=${ratio.toFixed(2)}`,
  );
  assert.ok(elapsedMs < 10_000, `updateSelectionSet on 200_000 members took ${elapsedMs.toFixed(1)}ms, expected well under 10s`);

  console.log(`T-SELECTIONS-UPDATE-LARGE-SET-01 passed: updateSelectionSet handled ${MEMBER_COUNT} members without throwing; create=${createElapsedMs.toFixed(1)}ms update=${elapsedMs.toFixed(1)}ms (ratio ${ratio.toFixed(2)}).`);
}

function openEditable(label: string, text: string): TextFileDocument {
  const documentId = asIdentifier<DocumentId>(`T-${label}`, 'documentId');
  if (!documentId.ok) throw new Error(documentId.error.message);
  const opened = openTextDocument(documentId.value, new TextEncoder().encode(text));
  if (opened.kind !== 'editable') throw new Error(`expected-editable:${label}:${opened.document.explanation}`);
  return opened.document;
}

function id(value: string): SelectionId {
  const result = asIdentifier<SelectionId>(value, 'selectionId');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function normal(selectionId: SelectionId, offset: number): SelectionMemberInput {
  const endpoint = { kind: 'character' as const, offset: offset as Utf16Offset, after: (offset + 1) as Utf16Offset };
  return {
    id: selectionId,
    kind: 'normal-cursor',
    direction: 'forward',
    anchor: endpoint,
    head: endpoint,
  };
}

main();
