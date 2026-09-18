import { strict as assert } from 'node:assert';
import { asIdentifier, asUndoGroupId, type DocumentId, type SelectionId, type Utf16Offset } from '../../packages/primitives/src/index';
import { createSelectionSet, mapSelectionSet, type EndpointInput, type SelectionMemberInput } from '../../packages/selections/src/index';
import { openTextDocument, type CommittedDocumentChange, type DocumentEdit, type TextFileDocument } from '../../packages/document/src/index';

// A2: an astral (surrogate-pair) character sitting exactly at a remapped
// endpoint offset must not make mapSelectionSet fail with
// 'invalid-change-map'. Repro: "ab\u{1F600}cd\n", a 'character' selection on
// "a" (offset 0..1); deleting [0,2) ("ab") collapses that selection onto the
// astral character that is now at offset 0 -- semanticEndpointAt must widen
// its 1-unit probe instead of asking the rope for an invalid mid-pair slice.
function checkA2AstralCharacterAtRemappedEndpoint(): void {
  const text = `ab${'\u{1F600}'}cd\n`;
  const document = openEditable('a2-astral', text);
  const memberId = id('a2-astral-member');
  const before = document.snapshot();
  const selections = expectOk(createSelectionSet(before, {
    primaryId: memberId,
    members: [normal(memberId, character(0, 1))],
  }), 'A2');
  const committed = commit(document, [{ start: offset(0), end: offset(2), text: '' }], 'A2');
  const mapped = mapSelectionSet(selections.selectionSet, committed.changeMap, document.snapshot());
  assert.equal(mapped.ok, true, `A2: mapSelectionSet must not fail on an astral char at the remapped endpoint (got ${mapped.ok ? '' : JSON.stringify(mapped.error)})`);
  if (!mapped.ok) return;
  const member = mapped.value.selectionSet.members[0];
  assert.equal(member?.anchor.kind, 'character', 'A2: endpoint stays a character endpoint');
  if (member?.anchor.kind === 'character') {
    assert.equal(member.anchor.at.offset as number, 0, 'A2: endpoint lands at the astral character start');
    assert.equal(member.anchor.after.offset as number, 2, 'A2: endpoint spans both UTF-16 units of the astral character');
  }
}

// A2b: the same astral character reached from the other direction --
// previousScalarStart must back up a full pair, not land mid-pair, when the
// preceding content ends exactly on a low surrogate.
function checkA2AstralCharacterAtLineEnd(): void {
  const text = `x${'\u{1F600}'}\n`; // "x😀\n"
  const document = openEditable('a2-lineend', text);
  const memberId = id('a2-lineend-member');
  const before = document.snapshot();
  const selections = expectOk(createSelectionSet(before, {
    primaryId: memberId,
    members: [normal(memberId, character(0, 1))],
  }), 'A2b');
  // Delete "x" only; the empty-line/eof fallback path exercises
  // previousScalarStart via lineSpan's contentEnd landing right after the
  // astral pair.
  const committed = commit(document, [{ start: offset(0), end: offset(1), text: '' }], 'A2b');
  const mapped = mapSelectionSet(selections.selectionSet, committed.changeMap, document.snapshot());
  assert.equal(mapped.ok, true, `A2b: mapSelectionSet must not fail (got ${mapped.ok ? '' : JSON.stringify(mapped.error)})`);
  if (!mapped.ok) return;
  const member = mapped.value.selectionSet.members[0];
  assert.equal(member?.anchor.kind, 'character', 'A2b: endpoint stays a character endpoint');
  if (member?.anchor.kind === 'character') {
    assert.equal(member.anchor.at.offset as number, 0, 'A2b: endpoint lands at the astral character start, not mid-pair');
    assert.equal(member.anchor.after.offset as number, 2, 'A2b: endpoint spans both UTF-16 units of the astral character');
  }
}

function openEditable(label: string, text: string): TextFileDocument {
  const documentId = asIdentifier<DocumentId>(`AUDIT-${label}`, 'documentId');
  if (!documentId.ok) throw new Error(documentId.error.message);
  const opened = openTextDocument(documentId.value, new TextEncoder().encode(text));
  if (opened.kind !== 'editable') throw new Error(`expected-editable:${label}:${opened.document.explanation}`);
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

function normal(selectionId: SelectionId, endpoint: EndpointInput): SelectionMemberInput {
  return { id: selectionId, kind: 'normal-cursor', direction: 'forward', anchor: endpoint, head: endpoint };
}

function character(start: number, after = start + 1): EndpointInput {
  return { kind: 'character', offset: offset(start), after: offset(after), affinity: 'right', afterAffinity: 'right' };
}

function offset(value: number): Utf16Offset { return value as Utf16Offset; }

function expectOk<T, E>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E }, fixture: string): T {
  if (!result.ok) throw new Error(`${fixture}:expected-success:${JSON.stringify(result.error)}`);
  return result.value;
}

checkA2AstralCharacterAtRemappedEndpoint();
checkA2AstralCharacterAtLineEnd();
console.log('tests/selections/audit-fixes.test.ts: all checks passed');
