import { strict as assert } from 'node:assert';
import {
  asIdentifier,
  asUndoGroupId,
  type CellColumn,
  type DocumentId,
  type LineIndex,
  type SelectionId,
  type Utf16Column,
  type Utf16Offset,
} from '../../packages/primitives/src/index';
import {
  createSelectionSet,
  mapSelectionSet,
  updateSelectionSet,
  type EndpointInput,
  type SelectionFailure,
  type SelectionMemberInput,
} from '../../packages/selections/src/index';
import {
  openTextDocument,
  type CommittedDocumentChange,
  type DocumentEdit,
  type TextFileDocument,
} from '../../packages/document/src/index';

function checkConstructorValidation(): void {
  const document = openEditable('constructor', 'A😀B\n\n');
  const snapshot = document.snapshot();
  const first = id('constructor-first');
  const second = id('constructor-second');

  expectFailure(createSelectionSet(snapshot, { primaryId: first, members: [] }), 'empty-selection-set', 'T075-MC02-CONSTRUCTOR-EMPTY-01');
  expectFailure(createSelectionSet(snapshot, {
    primaryId: id('constructor-missing-primary'),
    members: [normal(first, character(0))],
  }), 'invalid-primary', 'T075-MC02-CONSTRUCTOR-PRIMARY-01');
  expectFailure(createSelectionSet(snapshot, {
    primaryId: first,
    members: [normal(first, character(0)), normal(first, character(3))],
  }), 'duplicate-selection-id', 'T075-MC02-CONSTRUCTOR-ID-01');
  expectFailure(createSelectionSet(snapshot, {
    primaryId: first,
    members: [normal(first, character(0)), insertCaret(second, 0)],
  }), 'mixed-selection-kind', 'T075-MC02-CONSTRUCTOR-KIND-01');
  expectFailure(createSelectionSet(snapshot, {
    primaryId: first,
    members: [normal(first, { kind: 'gap', offset: offset(2) })],
  }), 'invalid-endpoint', 'T075-MC04-CONSTRUCTOR-SURROGATE-01');
  expectFailure(createSelectionSet(snapshot, {
    primaryId: first,
    members: [normal(first, { kind: 'empty-line', lineIndex: line(0) })],
  }), 'invalid-endpoint', 'T075-MC02-CONSTRUCTOR-NONEMPTY-LINE-01');
  expectFailure(createSelectionSet(snapshot, {
    primaryId: first,
    selectionGeneration: -1,
    members: [normal(first, character(0))],
  }), 'invalid-selection-generation', 'T075-MC02-CONSTRUCTOR-GENERATION-01');
  expectFailure(createSelectionSet(snapshot, {
    primaryId: first,
    members: [{ ...normal(first, character(0)), creationOrdinal: -1 }],
  }), 'invalid-selection-ordinal', 'T075-MC02-CONSTRUCTOR-ORDINAL-01');
  expectFailure(createSelectionSet(snapshot, {
    primaryId: first,
    members: [normal(first, { kind: 'eof', affinity: 'left' })],
  }), 'invalid-endpoint', 'T075-MC02-CONSTRUCTOR-EOF-AFFINITY-01');

  console.log('T075-MC02-CONSTRUCTOR passed: empty/invalid identities, incompatible kinds, invalid UTF-16 and line endpoints, and malformed generations are rejected.');
}

function checkPrimaryStableIdsDirectionAndRangeMerging(): void {
  const document = openEditable('canonical', 'abcdef');
  const snapshot = document.snapshot();
  const primary = id('canonical-primary-backward');
  const adjacent = id('canonical-adjacent-forward');

  const adjacentSet = expectOk(createSelectionSet(snapshot, {
    primaryId: primary,
    members: [visualCharacters(primary, 0, 2, 'backward', 9), visualCharacters(adjacent, 2, 4, 'forward', 2)],
  }), 'T075-MC02-ADJACENT-CHAR-01').selectionSet;
  assert.equal(adjacentSet.members.length, 2, 'T075-MC02-ADJACENT-CHAR-01 adjacent ranges remain distinct');
  assert.equal(adjacentSet.primaryId, primary, 'T075-MC02-ADJACENT-CHAR-01 primary identity is stable');
  assert.equal(adjacentSet.members[0]?.id, primary, 'T075-MC02-ADJACENT-CHAR-01 members use canonical document order');

  const overlapPrimary = id('canonical-overlap-primary');
  const overlapOther = id('canonical-overlap-other');
  const overlapping = expectOk(createSelectionSet(snapshot, {
    primaryId: overlapPrimary,
    members: [
      visualCharacters(overlapOther, 0, 3, 'forward', 1),
      visualCharacters(overlapPrimary, 2, 4, 'backward', 4),
    ],
  }), 'T075-MC02-OVERLAP-PRIMARY-01');
  assert.equal(overlapping.selectionSet.members.length, 1, 'T075-MC02-OVERLAP-PRIMARY-01 overlapping ranges merge');
  assert.equal(overlapping.selectionSet.members[0]?.id, overlapPrimary, 'T075-MC02-OVERLAP-PRIMARY-01 absorbed primary identity is retained');
  assert.equal(overlapping.selectionSet.primaryId, overlapPrimary, 'T075-MC02-OVERLAP-PRIMARY-01 primary remaps to retained identity');
  assert.equal(overlapping.selectionSet.members[0]?.direction, 'backward', 'T075-MC02-OVERLAP-PRIMARY-01 retained direction is preserved');
  const merged = overlapping.selectionSet.members[0];
  assert.equal(merged?.kind, 'visual-character', 'T075-MC02-OVERLAP-PRIMARY-01 remains a character Visual selection');
  if (merged?.kind === 'visual-character') {
    assert.equal(merged.anchor.at.offset as number, 3, 'T075-MC02-OVERLAP-PRIMARY-01 backward anchor remains at high endpoint');
    assert.equal(merged.head.at.offset as number, 0, 'T075-MC02-OVERLAP-PRIMARY-01 backward head remains at low endpoint');
  }
  assert.deepEqual(overlapping.idMap, [
    { from: overlapOther, to: overlapPrimary },
    { from: overlapPrimary, to: overlapPrimary },
  ], 'T075-MC02-OVERLAP-PRIMARY-01 emits stable old-to-new identity mappings');

  console.log('T075-MC02-CANONICALIZATION passed: document order, overlap retention and direction are stable; adjacent character ranges remain separate.');
}

function checkAdjacentVisualLines(): void {
  const document = openEditable('visual-lines', 'one\ntwo\nthree');
  const first = id('line-selection-first');
  const second = id('line-selection-second');
  const result = expectOk(createSelectionSet(document.snapshot(), {
    primaryId: first,
    members: [visualLines(first, 0, 0, 'forward', 0), visualLines(second, 1, 1, 'forward', 1)],
  }), 'T075-MC02-ADJACENT-LINE-01');

  assert.equal(result.selectionSet.members.length, 2, 'T075-MC02-ADJACENT-LINE-01 adjacent but non-overlapping line ranges stay distinct');
  assert.deepEqual(result.idMap.map(({ from, to }) => [from, to]), [[first, first], [second, second]], 'T075-MC02-ADJACENT-LINE-01 identity map preserves both members');
  console.log('T075-MC02-ADJACENT-LINE-01 passed: adjacent non-overlapping VisualLine selections are not collapsed together.');
}

function checkDuplicateCaretsAndPostDeletionCollision(): void {
  const document = openEditable('duplicate-carets', 'abcd');
  const primary = id('duplicate-primary');
  const duplicate = id('duplicate-secondary');
  const initial = expectOk(createSelectionSet(document.snapshot(), {
    primaryId: primary,
    members: [insertCaret(primary, 1, 'right', 7), insertCaret(duplicate, 1, 'right', 2)],
  }), 'T075-MC02-DUPLICATE-CARET-01');
  assert.equal(initial.selectionSet.members.length, 1, 'T075-MC02-DUPLICATE-CARET-01 exact duplicate carets collapse');
  assert.equal(initial.selectionSet.primaryId, primary, 'T075-MC02-DUPLICATE-CARET-01 primary identity wins duplicate collapse');
  assert.deepEqual(initial.idMap, [
    { from: duplicate, to: primary },
    { from: primary, to: primary },
  ], 'T075-MC02-DUPLICATE-CARET-01 emits mapping for both source members');

  const documentAfterOpen = openEditable('mapped-carets', 'abcd');
  const before = documentAfterOpen.snapshot();
  const atStart = id('mapped-caret-start');
  const atEnd = id('mapped-caret-end');
  const beforeMap = expectOk(createSelectionSet(before, {
    primaryId: atStart,
    members: [insertCaret(atStart, 1, 'right', 0), insertCaret(atEnd, 3, 'right', 1)],
  }), 'T075-MC02-MAPPED-DUPLICATE-01');
  const committed = commit(documentAfterOpen, [{ start: offset(1), end: offset(3), text: '' }], 'T075-MC02-MAPPED-DUPLICATE-01');
  const mapped = expectOk(mapSelectionSet(beforeMap.selectionSet, committed.changeMap, documentAfterOpen.snapshot()), 'T075-MC02-MAPPED-DUPLICATE-01');
  assert.equal(mapped.selectionSet.members.length, 1, 'T075-MC02-MAPPED-DUPLICATE-01 carets colliding after deletion collapse');
  assert.equal(mapped.selectionSet.primaryId, atStart, 'T075-MC02-MAPPED-DUPLICATE-01 primary survives post-map collision');
  assert.equal(mapped.selectionSet.members[0]?.anchor.at.offset as number, 1, 'T075-MC02-MAPPED-DUPLICATE-01 mapped caret is at deletion start');
  assert.deepEqual(mapped.idMap, [
    { from: atStart, to: atStart },
    { from: atEnd, to: atStart },
  ], 'T075-MC02-MAPPED-DUPLICATE-01 records the absorbed identity');

  console.log('T075-MC02-DUPLICATE-CARET passed: exact and deletion-collided carets collapse without losing primary identity.');
}

function checkCaretDesiredColumnsParticipateInIdentity(): void {
  const document = openEditable('desired-columns', 'a\tbc');
  const snapshot = document.snapshot();
  const normalPrimary = id('desired-normal-primary');
  const normalOther = id('desired-normal-other');
  const normalDistinct = expectOk(createSelectionSet(snapshot, {
    primaryId: normalPrimary,
    members: [
      withDesiredColumn(normal(normalPrimary, character(1)), 1, 4),
      withDesiredColumn(normal(normalOther, character(1)), 3, 7),
    ],
  }), 'T075-MC02-DESIRED-NORMAL-01');
  assert.equal(normalDistinct.selectionSet.members.length, 2, 'T075-MC02-DESIRED-NORMAL-01 same-location Normal cursors with distinct preferred columns remain distinct');
  assert.deepEqual(
    normalDistinct.selectionSet.members.map((member) => [member.desiredColumn.logicalUtf16 as number, member.desiredColumn.displayCell as number]),
    [[1, 4], [3, 7]],
    'T075-MC02-DESIRED-NORMAL-01 logical UTF-16 and display-cell columns are both preserved',
  );

  const normalDuplicate = id('desired-normal-exact-duplicate');
  const normalExact = expectOk(createSelectionSet(snapshot, {
    primaryId: normalPrimary,
    members: [
      withDesiredColumn(normal(normalPrimary, character(1)), 1, 4),
      withDesiredColumn(normal(normalDuplicate, character(1)), 1, 4),
    ],
  }), 'T075-MC02-DESIRED-NORMAL-EXACT-01');
  assert.equal(normalExact.selectionSet.members.length, 1, 'T075-MC02-DESIRED-NORMAL-EXACT-01 equal endpoint and desired-column state collapses');
  assert.equal(normalExact.selectionSet.members[0]?.id, normalPrimary, 'T075-MC02-DESIRED-NORMAL-EXACT-01 duplicate collapse retains primary');

  const insertPrimary = id('desired-insert-primary');
  const insertOther = id('desired-insert-other');
  const insertDistinct = expectOk(createSelectionSet(snapshot, {
    primaryId: insertPrimary,
    members: [
      withDesiredColumn(insertCaret(insertPrimary, 1), 1, 4),
      withDesiredColumn(insertCaret(insertOther, 1), 3, 7),
    ],
  }), 'T075-MC02-DESIRED-INSERT-01');
  assert.equal(insertDistinct.selectionSet.members.length, 2, 'T075-MC02-DESIRED-INSERT-01 same-location Insert carets with distinct preferred columns remain distinct');

  const insertDuplicate = id('desired-insert-exact-duplicate');
  const insertExact = expectOk(createSelectionSet(snapshot, {
    primaryId: insertPrimary,
    members: [
      withDesiredColumn(insertCaret(insertPrimary, 1), 1, 4),
      withDesiredColumn(insertCaret(insertDuplicate, 1), 1, 4),
    ],
  }), 'T075-MC02-DESIRED-INSERT-EXACT-01');
  assert.equal(insertExact.selectionSet.members.length, 1, 'T075-MC02-DESIRED-INSERT-EXACT-01 equal endpoint and desired-column state collapses');
  assert.equal(insertExact.selectionSet.members[0]?.id, insertPrimary, 'T075-MC02-DESIRED-INSERT-EXACT-01 duplicate collapse retains primary');

  console.log('T075-MC02-DESIRED-COLUMNS passed: preferred logical/display columns distinguish same-location Normal and Insert carets, while exact duplicates collapse.');
}

function checkEofAndEmptyLineEndpoints(): void {
  const emptyDocument = openEditable('empty-eof', '');
  const emptyLineId = id('empty-file-line');
  const emptyEofId = id('empty-file-eof');
  const emptyFileSet = expectOk(createSelectionSet(emptyDocument.snapshot(), {
    primaryId: emptyLineId,
    members: [normal(emptyLineId, { kind: 'empty-line', lineIndex: line(0) }), normal(emptyEofId, { kind: 'eof' })],
  }), 'T075-MC02-EOF-EMPTY-01');
  assert.equal(emptyFileSet.selectionSet.members.length, 2, 'T075-MC02-EOF-EMPTY-01 EOF and empty-line endpoint kinds remain distinct at offset zero');
  assert.deepEqual(emptyFileSet.selectionSet.members.map((member) => member.anchor.kind), ['empty-line', 'eof']);

  const newlineDocument = openEditable('empty-lines', '\n');
  const firstLineId = id('newline-empty-line-0');
  const secondLineId = id('newline-empty-line-1');
  const trailingEofId = id('newline-trailing-eof');
  const newlineSet = expectOk(createSelectionSet(newlineDocument.snapshot(), {
    primaryId: firstLineId,
    members: [
      normal(firstLineId, { kind: 'empty-line', lineIndex: line(0) }),
      normal(secondLineId, { kind: 'empty-line', lineIndex: line(1) }),
      normal(trailingEofId, { kind: 'eof' }),
    ],
  }), 'T075-MC02-EOF-EMPTY-02');
  assert.equal(newlineSet.selectionSet.members.length, 3, 'T075-MC02-EOF-EMPTY-02 leading/trailing empty lines and EOF remain represented');
  assert.deepEqual(newlineSet.selectionSet.members.map((member) => member.anchor.kind), ['empty-line', 'empty-line', 'eof']);
  assert.equal(newlineSet.selectionSet.members[1]?.anchor.kind === 'empty-line' ? newlineSet.selectionSet.members[1].anchor.lineIndex as number : -1, 1);

  console.log('T075-MC02-EOF-EMPTY passed: empty document, both empty lines around a newline, and EOF are distinct valid endpoints.');
}

function checkUtf16AffinityAndCharacterMapping(): void {
  const document = openEditable('unicode-affinity', 'A😀B');
  const before = document.snapshot();
  const leftId = id('unicode-left-affinity');
  const rightId = id('unicode-right-affinity');
  const emojiId = id('unicode-emoji-character');
  const gapSet = expectOk(createSelectionSet(before, {
    primaryId: leftId,
    members: [insertCaret(leftId, 1, 'left', 0), insertCaret(rightId, 1, 'right', 1)],
  }), 'T075-MC04-UTF16-AFFINITY-01');
  const characterSet = expectOk(createSelectionSet(before, {
    primaryId: emojiId,
    members: [normal(emojiId, character(1, 3, 'right', 'right'))],
  }), 'T075-MC04-UTF16-AFFINITY-01');
  const emoji = characterSet.selectionSet.members[0];
  assert.equal(emoji?.kind, 'normal-cursor');
  if (emoji?.kind === 'normal-cursor' && emoji.anchor.kind === 'character') {
    assert.deepEqual([emoji.anchor.at.offset as number, emoji.anchor.after.offset as number], [1, 3], 'T075-MC04-UTF16-AFFINITY-01 emoji spans two UTF-16 code units');
  } else {
    assert.fail('T075-MC04-UTF16-AFFINITY-01 emoji remains a semantic character endpoint');
  }
  expectFailure(createSelectionSet(before, {
    primaryId: id('split-surrogate-gap'),
    members: [insertCaret(id('split-surrogate-gap'), 2)],
  }), 'invalid-endpoint', 'T075-MC04-UTF16-SURROGATE-01');

  const committed = commit(document, [{ start: offset(1), end: offset(1), text: 'Q' }], 'T075-MC04-UTF16-AFFINITY-01');
  const mappedGaps = expectOk(mapSelectionSet(gapSet.selectionSet, committed.changeMap, document.snapshot()), 'T075-MC04-UTF16-AFFINITY-01');
  const gapOffsets = new Map(mappedGaps.selectionSet.members.map((member) => [member.id, member.anchor.at.offset as number]));
  assert.equal(gapOffsets.get(leftId), 1, 'T075-MC04-UTF16-AFFINITY-01 left affinity stays before inserted UTF-16 text');
  assert.equal(gapOffsets.get(rightId), 2, 'T075-MC04-UTF16-AFFINITY-01 right affinity moves after inserted UTF-16 text');
  assert.equal(mappedGaps.selectionSet.members.length, 2, 'T075-MC04-UTF16-AFFINITY-01 affinity-distinct carets remain distinct');

  const mappedCharacter = expectOk(mapSelectionSet(characterSet.selectionSet, committed.changeMap, document.snapshot()), 'T075-MC04-UTF16-CHARACTER-MAP-01');
  const movedEmoji = mappedCharacter.selectionSet.members[0];
  assert.equal(movedEmoji?.kind, 'normal-cursor');
  if (movedEmoji?.kind === 'normal-cursor' && movedEmoji.anchor.kind === 'character') {
    assert.deepEqual([movedEmoji.anchor.at.offset as number, movedEmoji.anchor.after.offset as number], [2, 4], 'T075-MC04-UTF16-CHARACTER-MAP-01 character mapping preserves the emoji span');
    assert.equal(movedEmoji.anchor.at.affinity, 'right');
    assert.equal(movedEmoji.anchor.after.affinity, 'right');
  } else {
    assert.fail('T075-MC04-UTF16-CHARACTER-MAP-01 mapped endpoint remains a semantic character');
  }

  console.log('T075-MC04-UTF16-AFFINITY passed: surrogate boundaries, two-unit character endpoints and left/right insertion affinity are preserved.');
}

function checkGeneratedDeletionMappingAndCharacterValidity(): void {
  const seed = 731_904;
  const random = seededRandom(seed);
  const source = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let run = 0; run < 48; run += 1) {
    const start = random() % (source.length - 4);
    const length = 1 + (random() % 4);
    const end = start + length;
    for (const position of [Math.max(0, start - 1), start, start + Math.floor(length / 2), end, Math.min(source.length, end + 1)]) {
      for (const affinity of ['left', 'right'] as const) {
        const fixture = `T075-MC04-GENERATED-DELETE-01:${seed}:${run}:${position}:${affinity}`;
        const document = openEditable(`generated-${run}-${position}-${affinity}`, source);
        const memberId = id(`generated-${run}-${position}-${affinity}`);
        const before = document.snapshot();
        const selections = expectOk(createSelectionSet(before, {
          primaryId: memberId,
          members: [insertCaret(memberId, position, affinity)],
        }), fixture);
        const committed = commit(document, [{ start: offset(start), end: offset(end), text: '' }], fixture);
        const mapped = expectOk(mapSelectionSet(selections.selectionSet, committed.changeMap, document.snapshot()), fixture);
        const member = mapped.selectionSet.members[0];
        assert.equal(member?.kind, 'insert-caret', `${fixture} preserves Insert gap kind`);
        if (member?.kind === 'insert-caret') {
          assert.equal(member.anchor.at.offset as number, referenceDeleteMap(position, start, end), `${fixture} maps the gap according to deletion reference`);
          assert.equal(member.anchor.at.affinity, affinity, `${fixture} retains endpoint affinity`);
        }
      }
    }
  }

  const backwardDocument = openEditable('backward-character-delete', 'abcdefg');
  const backwardId = id('backward-character-delete-primary');
  const backwardBefore = expectOk(createSelectionSet(backwardDocument.snapshot(), {
    primaryId: backwardId,
    members: [visualCharacters(backwardId, 1, 6, 'backward', 0)],
  }), 'T075-MC04-BACKWARD-DELETE-01');
  const backwardCommit = commit(backwardDocument, [{ start: offset(3), end: offset(4), text: '' }], 'T075-MC04-BACKWARD-DELETE-01');
  const backwardMapped = expectOk(mapSelectionSet(backwardBefore.selectionSet, backwardCommit.changeMap, backwardDocument.snapshot()), 'T075-MC04-BACKWARD-DELETE-01');
  const backward = backwardMapped.selectionSet.members[0];
  assert.equal(backward?.kind, 'visual-character', 'T075-MC04-BACKWARD-DELETE-01 preserves Visual character kind');
  if (backward?.kind === 'visual-character') {
    assert.equal(backward.direction, 'backward', 'T075-MC04-BACKWARD-DELETE-01 preserves backward direction');
    assert.equal(backward.anchor.at.offset as number, 4, 'T075-MC04-BACKWARD-DELETE-01 maps the high endpoint through deletion');
    assert.equal(backward.head.at.offset as number, 1, 'T075-MC04-BACKWARD-DELETE-01 preserves the low endpoint');
  }

  const document = openEditable('character-after-delete', 'abc');
  const cursor = id('character-after-delete-primary');
  const selection = expectOk(createSelectionSet(document.snapshot(), {
    primaryId: cursor,
    members: [visualCharacters(cursor, 1, 2, 'forward', 0)],
  }), 'T075-MC04-CHARACTER-DELETE-01');
  const committed = commit(document, [{ start: offset(1), end: offset(2), text: '' }], 'T075-MC04-CHARACTER-DELETE-01');
  const mapped = expectOk(mapSelectionSet(selection.selectionSet, committed.changeMap, document.snapshot()), 'T075-MC04-CHARACTER-DELETE-01');
  for (const member of mapped.selectionSet.members) {
    for (const endpoint of [member.anchor, member.head]) {
      if (endpoint.kind !== 'character') continue;
      assert.ok(endpoint.after.offset > endpoint.at.offset, 'T075-MC04-CHARACTER-DELETE-01 character endpoints remain nonempty after deletion');
      const content = document.snapshot().slice(endpoint.at.offset, endpoint.after.offset);
      assert.equal(content.ok, true, 'T075-MC04-CHARACTER-DELETE-01 mapped character remains in the destination version');
      if (content.ok) assert.notEqual(content.value, '\n', 'T075-MC04-CHARACTER-DELETE-01 character endpoint cannot become a newline');
    }
  }

  console.log('T075-MC04-GENERATED-DELETE passed: seeded deletion maps preserve affinity and never leave invalid character endpoints.');
}

function checkBlockGeometryAndVirtualCells(): void {
  const document = openEditable('blocks', 'abcdef\nghijkl\nmnopqr\nstuvwx');
  const snapshot = document.snapshot();

  const disjointPrimary = id('block-disjoint-primary');
  const disjointOther = id('block-disjoint-other');
  const disjoint = expectOk(createSelectionSet(snapshot, {
    primaryId: disjointPrimary,
    members: [
      visualBlock(disjointPrimary, 0, 0, 1, 1, 0, 0),
      visualBlock(disjointOther, 2, 3, 3, 4, 0, 1),
    ],
  }), 'T075-MC02-BLOCK-DISJOINT-01');
  assert.equal(disjoint.selectionSet.members.length, 2, 'T075-MC02-BLOCK-DISJOINT-01 disjoint blocks remain separate');
  assert.deepEqual(disjoint.idMap.map(({ from, to }) => [from, to]), [[disjointPrimary, disjointPrimary], [disjointOther, disjointOther]]);

  const adjacentPrimary = id('block-adjacent-primary');
  const adjacentOther = id('block-adjacent-other');
  const adjacent = expectOk(createSelectionSet(snapshot, {
    primaryId: adjacentPrimary,
    members: [
      visualBlock(adjacentPrimary, 0, 0, 1, 1, 0, 0, 1, 1),
      visualBlock(adjacentOther, 0, 2, 1, 3, 0, 0, 2, 3),
    ],
  }), 'T075-MC02-BLOCK-RECTANGULAR-ADJACENCY-01');
  assert.equal(adjacent.selectionSet.members.length, 1, 'T075-MC02-BLOCK-RECTANGULAR-ADJACENCY-01 edge-adjacent blocks merge when union adds no cells');
  assert.equal(adjacent.selectionSet.members[0]?.id, adjacentPrimary, 'T075-MC02-BLOCK-RECTANGULAR-ADJACENCY-01 retained primary identity is stable');
  const merged = adjacent.selectionSet.members[0];
  assert.equal(merged?.kind, 'visual-block', 'T075-MC02-BLOCK-RECTANGULAR-ADJACENCY-01 remains a block selection');
  if (merged?.kind === 'visual-block') {
    assert.deepEqual([merged.anchor.displayCellColumn as number, merged.head.displayCellColumn as number], [0, 3]);
    assert.deepEqual([merged.anchor.logicalUtf16Column as number, merged.head.logicalUtf16Column as number], [1, 3], 'T075-MC04-BLOCK-UNITS-01 logical UTF-16 columns stay distinct from display cells');
    assert.deepEqual([merged.anchor.virtualCells, merged.head.virtualCells], [0, 0], 'T075-MC04-BLOCK-UNITS-01 virtual-cell metadata remains explicit');
  }

  const incompatiblePrimary = id('block-incompatible-primary');
  const incompatibleOther = id('block-incompatible-other');
  const incompatibleVirtual = expectOk(createSelectionSet(snapshot, {
    primaryId: incompatiblePrimary,
    members: [
      visualBlock(incompatiblePrimary, 0, 0, 1, 1, 0, 0),
      visualBlock(incompatibleOther, 2, 0, 3, 1, 2, 1),
    ],
  }), 'T075-MC02-BLOCK-VIRTUAL-INCOMPATIBLE-01');
  assert.equal(incompatibleVirtual.selectionSet.members.length, 2, 'T075-MC02-BLOCK-VIRTUAL-INCOMPATIBLE-01 incompatible virtual extents prevent merging');

  const diagonalPrimary = id('block-diagonal-primary');
  const diagonalOther = id('block-diagonal-other');
  const diagonal = expectOk(createSelectionSet(snapshot, {
    primaryId: diagonalPrimary,
    members: [
      visualBlock(diagonalPrimary, 0, 0, 1, 1, 0, 0),
      visualBlock(diagonalOther, 2, 2, 3, 3, 0, 0),
    ],
  }), 'T075-MC02-BLOCK-INCOMPATIBLE-RECTANGLES-01');
  assert.equal(diagonal.selectionSet.members.length, 2, 'T075-MC02-BLOCK-INCOMPATIBLE-RECTANGLES-01 non-rectangular union cannot select extra cells');

  console.log('T075-MC02-BLOCK passed: rectangular adjacency merges without adding cells; disjoint, diagonal, and incompatible virtual shapes stay distinct.');
}

function checkSelectionOnlyGenerationAndDocumentInvariants(): void {
  const document = openEditable('selection-only', 'alpha\nbeta');
  const initialGroup = asUndoGroupId('T075-selection-only-initial');
  if (!initialGroup.ok) throw new Error(initialGroup.error.message);
  const priorEdit = document.commit({
    documentId: document.id,
    expectedVersion: document.version,
    edits: [{ start: offset(0), end: offset(0), text: '!' }],
    origin: 'vim',
    undoGroup: initialGroup.value,
  });
  if (!priorEdit.ok) throw new Error(`T075-MC02-UPDATE-DIRTY-01 setup:${priorEdit.error.kind}`);
  assert.equal(document.isDirty, true, 'T075-MC02-UPDATE-DIRTY-01 setup creates dirty state');

  const snapshot = document.snapshot();
  const first = id('selection-only-first');
  const next = id('selection-only-next');
  const initial = expectOk(createSelectionSet(snapshot, {
    primaryId: first,
    selectionGeneration: 12,
    members: [insertCaret(first, 1)],
  }), 'T075-MC02-UPDATE-GENERATION-01');
  const events: unknown[] = [];
  document.subscribeChanges((change) => events.push(change));
  const before = {
    version: document.version,
    revisionId: document.revisionId,
    savedRevisionId: document.savedRevisionId,
    dirty: document.isDirty,
  };

  const updated = expectOk(updateSelectionSet(snapshot, initial.selectionSet, {
    primaryId: next,
    members: [insertCaret(first, 1), insertCaret(next, 4, 'right', 1)],
  }), 'T075-MC02-UPDATE-GENERATION-01');
  assert.equal(updated.selectionSet.selectionGeneration as number, 13, 'T075-MC02-UPDATE-GENERATION-01 selection generation advances once');
  assert.equal(updated.selectionSet.documentVersion, before.version, 'T075-MC02-UPDATE-GENERATION-01 text version is unchanged');
  assert.equal(updated.selectionSet.primaryId, next, 'T075-MC02-UPDATE-GENERATION-01 updated primary is explicit');
  assert.equal(document.version, before.version, 'T075-MC02-UPDATE-DIRTY-01 document version is unchanged');
  assert.equal(document.revisionId, before.revisionId, 'T075-MC02-UPDATE-DIRTY-01 revision/history identity is unchanged');
  assert.equal(document.savedRevisionId, before.savedRevisionId, 'T075-MC02-UPDATE-DIRTY-01 saved revision is unchanged');
  assert.equal(document.isDirty, before.dirty, 'T075-MC02-UPDATE-DIRTY-01 dirty state is unchanged');
  assert.equal(events.length, 0, 'T075-MC02-UPDATE-DIRTY-01 selection-only updates publish no document change event');

  console.log('T075-MC02-UPDATE-GENERATION passed: selection-only updates advance only selection generation and leave text/history/save state untouched.');
}

function openEditable(label: string, text: string): TextFileDocument {
  const documentId = asIdentifier<DocumentId>(`T075-${label}`, 'documentId');
  if (!documentId.ok) throw new Error(documentId.error.message);
  const opened = openTextDocument(documentId.value, new TextEncoder().encode(text));
  if (opened.kind !== 'editable') throw new Error(`T075-expected-editable:${label}:${opened.document.explanation}`);
  return opened.document;
}

function commit(document: TextFileDocument, edits: readonly DocumentEdit[], label: string): CommittedDocumentChange {
  const undoGroup = asUndoGroupId(`${label}-undo`);
  if (!undoGroup.ok) throw new Error(undoGroup.error.message);
  const result = document.commit({
    documentId: document.id,
    expectedVersion: document.version,
    edits,
    origin: 'formatter',
    undoGroup: undoGroup.value,
  });
  if (!result.ok) throw new Error(`${label}:commit:${result.error.kind}`);
  if (result.value.kind !== 'committed') throw new Error(`${label}:expected-committed-change`);
  return result.value.change;
}

function id(value: string): SelectionId {
  const result = asIdentifier<SelectionId>(value, 'selectionId');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function normal(selectionId: SelectionId, endpoint: EndpointInput, direction: 'forward' | 'backward' = 'forward', creationOrdinal?: number): SelectionMemberInput {
  return {
    id: selectionId,
    kind: 'normal-cursor',
    direction,
    anchor: endpoint,
    head: endpoint,
    ...(creationOrdinal === undefined ? {} : { creationOrdinal }),
  };
}

function insertCaret(selectionId: SelectionId, position: number, affinity: 'left' | 'right' = 'right', creationOrdinal?: number): SelectionMemberInput {
  const endpoint: EndpointInput = { kind: 'gap', offset: offset(position), affinity };
  return {
    id: selectionId,
    kind: 'insert-caret',
    direction: 'forward',
    anchor: endpoint,
    head: endpoint,
    ...(creationOrdinal === undefined ? {} : { creationOrdinal }),
  };
}

function visualCharacters(
  selectionId: SelectionId,
  start: number,
  end: number,
  direction: 'forward' | 'backward',
  creationOrdinal: number,
): SelectionMemberInput {
  if (end <= start) throw new Error('visual-character-range-must-not-be-empty');
  const low = character(start);
  const high = character(end - 1);
  return {
    id: selectionId,
    kind: 'visual-character',
    direction,
    anchor: direction === 'forward' ? low : high,
    head: direction === 'forward' ? high : low,
    inclusive: true,
    creationOrdinal,
  };
}

function visualLines(
  selectionId: SelectionId,
  start: number,
  end: number,
  direction: 'forward' | 'backward',
  creationOrdinal: number,
): SelectionMemberInput {
  const low: EndpointInput = { kind: 'line', lineIndex: line(start) };
  const high: EndpointInput = { kind: 'line', lineIndex: line(end) };
  return {
    id: selectionId,
    kind: 'visual-line',
    direction,
    anchor: direction === 'forward' ? low : high,
    head: direction === 'forward' ? high : low,
    creationOrdinal,
  };
}

function visualBlock(
  selectionId: SelectionId,
  topLine: number,
  leftCell: number,
  bottomLine: number,
  rightCell: number,
  topVirtual: number,
  bottomVirtual: number,
  topLogical = leftCell,
  bottomLogical = rightCell,
): SelectionMemberInput {
  const top: EndpointInput = {
    kind: 'block-cell',
    offset: lineStart(topLine),
    logicalUtf16Column: utf16Column(topLogical),
    displayCellColumn: cell(leftCell),
    virtualCells: topVirtual,
  };
  const bottom: EndpointInput = {
    kind: 'block-cell',
    offset: lineStart(bottomLine),
    logicalUtf16Column: utf16Column(bottomLogical),
    displayCellColumn: cell(rightCell),
    virtualCells: bottomVirtual,
  };
  return {
    id: selectionId,
    kind: 'visual-block',
    direction: 'forward',
    anchor: top,
    head: bottom,
  };
}

function character(start: number, after = start + 1, affinity: 'left' | 'right' = 'right', afterAffinity: 'left' | 'right' = 'right'): EndpointInput {
  return { kind: 'character', offset: offset(start), after: offset(after), affinity, afterAffinity };
}

function withDesiredColumn(member: SelectionMemberInput, logical: number, display: number): SelectionMemberInput {
  return {
    ...member,
    desiredColumn: { logicalUtf16: utf16Column(logical), displayCell: cell(display) },
  };
}

function lineStart(lineIndex: number): Utf16Offset {
  return offset(lineIndex * 7);
}

function offset(value: number): Utf16Offset { return value as Utf16Offset; }
function line(value: number): LineIndex { return value as LineIndex; }
function cell(value: number): CellColumn { return value as CellColumn; }
function utf16Column(value: number): Utf16Column { return value as Utf16Column; }

function expectOk<T, E>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E }, fixture: string): T {
  if (!result.ok) throw new Error(`${fixture}:expected-success:${JSON.stringify(result.error)}`);
  return result.value;
}

function expectFailure<T>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: SelectionFailure },
  kind: SelectionFailure['kind'],
  fixture: string,
): void {
  assert.equal(result.ok, false, `${fixture} rejects invalid selection input`);
  if (!result.ok) assert.equal(result.error.kind, kind, `${fixture} returns the expected validation failure`);
}

function referenceDeleteMap(position: number, start: number, end: number): number {
  if (position < start) return position;
  if (position < end) return start;
  return position - (end - start);
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

checkConstructorValidation();
checkPrimaryStableIdsDirectionAndRangeMerging();
checkAdjacentVisualLines();
checkDuplicateCaretsAndPostDeletionCollision();
checkCaretDesiredColumnsParticipateInIdentity();
checkEofAndEmptyLineEndpoints();
checkUtf16AffinityAndCharacterMapping();
checkGeneratedDeletionMappingAndCharacterValidity();
checkBlockGeometryAndVirtualCells();
checkSelectionOnlyGenerationAndDocumentInvariants();
