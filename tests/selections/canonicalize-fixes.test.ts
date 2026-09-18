import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type SelectionId } from '../../packages/primitives/src/index';
import { createSelectionSet, mapSelectionSet, type EndpointInput, type SelectionMemberInput } from '../../packages/selections/src/index';
import { openTextDocument, type TextFileDocument } from '../../packages/document/src/index';

function checkOverlappingMixedDirectionExclusiveCharacterMerge(): void {
  // A backward-exclusive member overlapping a forward-exclusive member can produce a union
  // boundary that sits on neither member's own "end" side (endpointEnd), only the other's `at`
  // side; chooseEndpoint's single uniform formula threw 'canonical-endpoint-not-found' instead of
  // returning a canonical merged selection.
  const document = openEditable('mixed-excl', 'abcdefghij\nabcdefghij\nabcdefghij\nabcdefghij\n');
  const snapshot = document.snapshot();
  const members: SelectionMemberInput[] = [
    { id: sid('a'), kind: 'visual-character', direction: 'backward', inclusive: false, anchor: character(4), head: character(1) },
    { id: sid('b'), kind: 'visual-character', direction: 'forward', inclusive: false, anchor: character(3), head: character(6) },
  ];
  const result = createSelectionSet(snapshot, { primaryId: sid('a'), members });
  assert.equal(result.ok, true, 'overlapping mixed-direction exclusive visual-character members merge instead of throwing');
  if (!result.ok) return;
  assert.equal(result.value.selectionSet.members.length, 1, 'overlapping members collapse into one canonical selection');
  const merged = result.value.selectionSet.members[0];
  assert.equal(merged?.kind, 'visual-character');
  if (merged?.kind === 'visual-character' && merged.anchor.kind === 'character' && merged.head.kind === 'character') {
    // direction backward + exclusive: coverage is [head.after, anchor.after) per characterCoverage.
    const headBoundary = merged.head.at.offset as number;
    const anchorBoundary = merged.anchor.after.offset as number;
    assert.equal(Math.min(headBoundary, merged.head.after.offset as number), 1, 'low boundary from the backward-exclusive member is preserved');
    assert.equal(anchorBoundary, 6, 'high boundary contributed by the forward-exclusive member is preserved');
  }
  console.log('CANONICALIZE-FIXES-VISUAL-CHAR-MERGE-01 passed: overlapping mixed-direction exclusive visual-character members merge canonically.');
}

function checkVisualBlockDiagonalCornerMerge(): void {
  // Two stacked visual blocks whose union corners (top,left)/(bottom,right) are not literal
  // endpoints of either block (only the opposite diagonal, (top,right)/(bottom,left), is) used to
  // throw 'canonical-endpoint-not-found' instead of synthesizing/choosing valid corner endpoints.
  const document = openEditable('blocks', 'abcdefghij\nabcdefghij\nabcdefghij\nabcdefghij\n');
  const snapshot = document.snapshot();
  const members: SelectionMemberInput[] = [
    { id: sid('a'), kind: 'visual-block', direction: 'forward', anchor: blockCell(1, 1), head: blockCell(11, 0) },
    { id: sid('b'), kind: 'visual-block', direction: 'forward', anchor: blockCell(23, 1), head: blockCell(33, 0) },
  ];
  const result = createSelectionSet(snapshot, { primaryId: sid('a'), members });
  assert.equal(result.ok, true, 'a diagonal-only corner match merges instead of throwing');
  if (!result.ok) return;
  assert.equal(result.value.selectionSet.members.length, 1);
  const merged = result.value.selectionSet.members[0];
  assert.equal(merged?.kind, 'visual-block');
  if (merged?.kind === 'visual-block') {
    const top = Math.min(merged.anchor.lineIndex as number, merged.head.lineIndex as number);
    const bottom = Math.max(merged.anchor.lineIndex as number, merged.head.lineIndex as number);
    const left = Math.min(merged.anchor.displayCellColumn as number, merged.head.displayCellColumn as number);
    const right = Math.max(merged.anchor.displayCellColumn as number, merged.head.displayCellColumn as number);
    assert.deepEqual([top, bottom, left, right], [0, 3, 0, 1], 'the merged block reproduces the exact union rectangle');
  }
  console.log('CANONICALIZE-FIXES-VISUAL-BLOCK-MERGE-01 passed: stacked blocks merge onto their real diagonal corners.');
}

function checkNormalCursorCharacterStaysOneWide(): void {
  // A Normal-mode character endpoint's `after` used stored right affinity, so an insertion
  // exactly at that boundary grew the mapped endpoint to cover the inserted text too.
  const document = openEditable('normal-map', 'abcdef\n');
  const snapshot = document.snapshot();
  const cursorId = sid('cursor');
  const created = createSelectionSet(snapshot, {
    primaryId: cursorId,
    members: [{ id: cursorId, kind: 'normal-cursor', direction: 'forward', anchor: character(2), head: character(2) }],
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const committed = document.commit({
    documentId: document.id,
    expectedVersion: document.version,
    edits: [{ start: 3 as never, end: 3 as never, text: 'XYZ' }],
    origin: 'lsp',
    undoGroup: 'canonicalize-fixes-map' as never,
  });
  assert.equal(committed.ok, true);
  if (!committed.ok || committed.value.kind !== 'committed') return;
  const mapped = mapSelectionSet(created.value.selectionSet, committed.value.change.changeMap, document.snapshot());
  assert.equal(mapped.ok, true);
  if (!mapped.ok) return;
  const head = mapped.value.selectionSet.members[0]?.head;
  assert.equal(head?.kind, 'character');
  if (head?.kind === 'character') {
    assert.equal(head.at.offset as number, 2, 'the character start is untouched by an insertion after it');
    assert.equal(head.after.offset as number, 3, 'the character stays exactly one UTF-16 unit wide across the insertion');
  }
  console.log('CANONICALIZE-FIXES-NORMAL-CHARACTER-WIDTH-01 passed: a Normal-mode character endpoint stays one character wide across an insertion at its boundary.');
}

function openEditable(label: string, text: string): TextFileDocument {
  const documentId = asIdentifier<DocumentId>(`canonicalize-fixes-${label}`, 'documentId');
  if (!documentId.ok) throw new Error(documentId.error.message);
  const opened = openTextDocument(documentId.value, new TextEncoder().encode(text));
  if (opened.kind !== 'editable') throw new Error(`expected-editable:${label}`);
  return opened.document;
}

function sid(value: string): SelectionId {
  const result = asIdentifier<SelectionId>(value, 'selectionId');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function character(offset: number): EndpointInput {
  return { kind: 'character', offset: offset as never, after: (offset + 1) as never };
}

function blockCell(offset: number, column: number): EndpointInput {
  return {
    kind: 'block-cell',
    offset: offset as never,
    logicalUtf16Column: column as never,
    displayCellColumn: column as never,
    virtualCells: 0,
  };
}

export function runCanonicalizeFixesChecks(): void {
  checkOverlappingMixedDirectionExclusiveCharacterMerge();
  checkVisualBlockDiagonalCornerMerge();
  checkNormalCursorCharacterStaysOneWide();
}

if (import.meta.main) runCanonicalizeFixesChecks();
