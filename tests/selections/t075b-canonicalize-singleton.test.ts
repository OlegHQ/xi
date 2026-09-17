import { strict as assert } from 'node:assert';
import {
  asIdentifier,
  type CellColumn,
  type DocumentId,
  type LineIndex,
  type SelectionId,
  type Utf16Column,
  type Utf16Offset,
} from '../../packages/primitives/src/index';
import {
  createSelectionSet,
  type EndpointInput,
  type SelectionMemberInput,
} from '../../packages/selections/src/index';
import { openTextDocument, type DocumentSnapshot } from '../../packages/document/src/index';

// Regression for the canonicalize() singleton fast path (AGENTS.md performance
// ticket): `[...inputMembers].sort(compareMembers)`, the duplicate-caret group map
// and the final `finalMembers.sort` all ran even for a single-member selection set.
// Each check below proves the fast (1-member) path produces the exact same member
// and idMap entry that the general grouping/merge path computes for that same
// member when canonicalizing alongside an unrelated, non-joinable second member.

function documentSnapshot(): DocumentSnapshot {
  const documentId = asIdentifier<DocumentId>('T075b-canonicalize-singleton', 'documentId');
  if (!documentId.ok) throw new Error(documentId.error.message);
  const text = 'aaaaaaaaaa\n'.repeat(8) + 'aaaaaaaaaa';
  const opened = openTextDocument(documentId.value, new TextEncoder().encode(text));
  if (opened.kind !== 'editable') throw new Error(`T075b-expected-editable:${opened.document.explanation}`);
  return opened.document.snapshot();
}

function id(value: string): SelectionId {
  const result = asIdentifier<SelectionId>(value, 'selectionId');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function offset(value: number): Utf16Offset { return value as Utf16Offset; }
function line(value: number): LineIndex { return value as LineIndex; }
function cell(value: number): CellColumn { return value as CellColumn; }
function utf16Column(value: number): Utf16Column { return value as Utf16Column; }

function character(start: number): EndpointInput {
  return { kind: 'character', offset: offset(start), after: offset(start + 1), affinity: 'right', afterAffinity: 'right' };
}

function normal(selectionId: SelectionId, at: number, creationOrdinal: number): SelectionMemberInput {
  const endpoint = character(at);
  return { id: selectionId, kind: 'normal-cursor', direction: 'forward', anchor: endpoint, head: endpoint, creationOrdinal };
}

function insertCaret(selectionId: SelectionId, at: number, creationOrdinal: number): SelectionMemberInput {
  const endpoint: EndpointInput = { kind: 'gap', offset: offset(at), affinity: 'right' };
  return { id: selectionId, kind: 'insert-caret', direction: 'forward', anchor: endpoint, head: endpoint, creationOrdinal };
}

function visualCharacter(selectionId: SelectionId, start: number, end: number, creationOrdinal: number): SelectionMemberInput {
  const low = character(start);
  const high = character(end - 1);
  return { id: selectionId, kind: 'visual-character', direction: 'forward', anchor: low, head: high, inclusive: true, creationOrdinal };
}

function visualLine(selectionId: SelectionId, start: number, end: number, creationOrdinal: number): SelectionMemberInput {
  const low: EndpointInput = { kind: 'line', lineIndex: line(start) };
  const high: EndpointInput = { kind: 'line', lineIndex: line(end) };
  return { id: selectionId, kind: 'visual-line', direction: 'forward', anchor: low, head: high, creationOrdinal };
}

function visualBlock(selectionId: SelectionId, topLine: number, bottomLine: number, creationOrdinal: number): SelectionMemberInput {
  const top: EndpointInput = {
    kind: 'block-cell', offset: offset(topLine * 11), logicalUtf16Column: utf16Column(0), displayCellColumn: cell(0), virtualCells: 0,
  };
  const bottom: EndpointInput = {
    kind: 'block-cell', offset: offset(bottomLine * 11), logicalUtf16Column: utf16Column(2), displayCellColumn: cell(2), virtualCells: 0,
  };
  return { id: selectionId, kind: 'visual-block', direction: 'forward', anchor: top, head: bottom, creationOrdinal };
}

/**
 * Builds `solo` as a singleton set (exercises the fast path) and again alongside an
 * unrelated `other` member of the same kind that cannot join it, so the general
 * grouping/merge path canonicalizes `solo` on its own. Asserts the two produce an
 * identical member entry and idMap entry for `solo`.
 */
function checkSingletonMatchesGeneralPath(
  label: string,
  soloId: SelectionId,
  solo: SelectionMemberInput,
  other: SelectionMemberInput,
): void {
  const snapshot = documentSnapshot();

  const soloOnly = createSelectionSet(snapshot, { primaryId: soloId, members: [solo] });
  if (!soloOnly.ok) throw new Error(`${label}:solo-only:${soloOnly.error.kind}`);

  const withOther = createSelectionSet(snapshot, { primaryId: soloId, members: [solo, other] });
  if (!withOther.ok) throw new Error(`${label}:with-other:${withOther.error.kind}`);

  assert.equal(soloOnly.value.selectionSet.members.length, 1, `${label} the fast path returns exactly one member`);
  assert.equal(withOther.value.selectionSet.members.length, 2, `${label} the general path keeps both non-joinable members separate`);

  const soloEntryFromGeneral = withOther.value.selectionSet.members.find((member) => member.id === soloId);
  assert.ok(soloEntryFromGeneral !== undefined, `${label} the general path retains the solo member by id`);
  assert.deepEqual(soloOnly.value.selectionSet.members[0], soloEntryFromGeneral, `${label} fast-path member matches the general-path member`);

  assert.equal(soloOnly.value.selectionSet.primaryId, soloId, `${label} fast-path primary is the solo member`);
  assert.equal(withOther.value.selectionSet.primaryId, soloId, `${label} general-path primary is still the solo member`);

  const soloIdMapFast = soloOnly.value.idMap;
  assert.deepEqual(soloIdMapFast, [{ from: soloId, to: soloId }], `${label} fast-path idMap is an identity mapping`);
  const soloIdMapGeneral = withOther.value.idMap.filter((mapping) => mapping.from === soloId);
  assert.deepEqual(soloIdMapFast, soloIdMapGeneral, `${label} fast-path idMap matches the solo entry from the general path`);

  console.log(`T075b-CANONICALIZE-SINGLETON-01 (${label}) passed: singleton canonicalize matches the general grouping path.`);
}

function checkAllKinds(): void {
  checkSingletonMatchesGeneralPath('normal-cursor', id('solo-normal'), normal(id('solo-normal'), 1, 0), normal(id('other-normal'), 50, 1));
  checkSingletonMatchesGeneralPath('insert-caret', id('solo-insert'), insertCaret(id('solo-insert'), 1, 0), insertCaret(id('other-insert'), 50, 1));
  checkSingletonMatchesGeneralPath(
    'visual-character',
    id('solo-visual-char'),
    visualCharacter(id('solo-visual-char'), 1, 3, 0),
    visualCharacter(id('other-visual-char'), 40, 45, 1),
  );
  checkSingletonMatchesGeneralPath(
    'visual-line',
    id('solo-visual-line'),
    visualLine(id('solo-visual-line'), 0, 1, 0),
    visualLine(id('other-visual-line'), 5, 6, 1),
  );
  checkSingletonMatchesGeneralPath(
    'visual-block',
    id('solo-visual-block'),
    visualBlock(id('solo-visual-block'), 0, 1, 0),
    visualBlock(id('other-visual-block'), 5, 6, 1),
  );
}

checkAllKinds();
