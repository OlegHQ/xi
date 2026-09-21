import { strict as assert } from 'node:assert';
import { TextFileDocument } from '../../packages/document/src/index';
import { asIdentifier, asUndoGroupId, asUtf16Offset, type DocumentId } from '../../packages/primitives/src/index';
import { beginVimInsert, planVimInsertInput, type VimInsertOptions, type VimInsertPlan } from '../../packages/vim/insert/index';

function offset(value: number) {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(id: string, source: string): TextFileDocument {
  const documentId = asIdentifier<DocumentId>(id, 'auto-pairs-id');
  if (!documentId.ok) throw new Error(documentId.error.message);
  const opened = TextFileDocument.create(documentId.value, source, [], 'lf');
  if (!opened.ok) throw new Error(opened.error.kind);
  return opened.value;
}

function apply(doc: TextFileDocument, plan: VimInsertPlan): void {
  const undoGroup = asUndoGroupId(`auto-pairs-${plan.expectedVersion as number}`);
  if (!undoGroup.ok) throw new Error(undoGroup.error.message);
  const committed = doc.commit({
    documentId: plan.documentId,
    expectedVersion: plan.expectedVersion,
    edits: plan.edits,
    origin: 'vim',
    undoGroup: undoGroup.value,
  });
  if (!committed.ok) throw new Error(committed.error.kind);
}

function source(doc: TextFileDocument): string {
  const snapshot = doc.snapshot();
  const text = snapshot.slice(offset(0), offset(snapshot.lengthUtf16 as number));
  if (!text.ok) throw new Error('unreadable document');
  return text.value;
}

function typeKey(doc: TextFileDocument, session: Parameters<typeof planVimInsertInput>[1], key: string) {
  const planned = planVimInsertInput(doc.snapshot(), session, { kind: 'key', key });
  assert.equal(planned.ok, true, `${key} plans`);
  if (!planned.ok || planned.value.session === null) throw new Error('unreachable');
  apply(doc, planned.value.plan);
  return planned.value.session;
}

function enter(doc: TextFileDocument, options: VimInsertOptions = {}) {
  const entered = beginVimInsert(doc.snapshot(), offset(0), 'i', options);
  assert.equal(entered.ok, true, 'insert enters');
  if (!entered.ok) throw new Error('unreachable');
  apply(doc, entered.value.plan);
  return entered.value.session;
}

{
  const doc = document('AUTO-PAIRS-DEFAULT', '');
  let session = enter(doc);
  session = typeKey(doc, session, '(');
  assert.equal(source(doc), '()', 'T036-AUTO-PAIRS-UNIT-01 opening pair inserts both characters');
  assert.equal(session.cursorOffset, offset(1), 'T036-AUTO-PAIRS-UNIT-02 cursor stays between the pair');
  session = typeKey(doc, session, ')');
  assert.equal(source(doc), '()', 'T036-AUTO-PAIRS-UNIT-03 existing closer is not duplicated');
  assert.equal(session.cursorOffset, offset(2), 'T036-AUTO-PAIRS-UNIT-04 closer skip advances the cursor');
}

{
  const doc = document('AUTO-PAIRS-BACKSPACE', '');
  const session = typeKey(doc, enter(doc), '(');
  typeKey(doc, session, '<BS>');
  assert.equal(source(doc), '', 'T036-AUTO-PAIRS-UNIT-05 backspace removes an empty pair');
}

{
  const doc = document('AUTO-PAIRS-DISABLED', '');
  const session = typeKey(doc, enter(doc, { autoPairs: false }), '(');
  assert.equal(source(doc), '(', 'T036-AUTO-PAIRS-UNIT-06 false disables automatic pairs');
  assert.equal(session.cursorOffset, offset(1), 'T036-AUTO-PAIRS-UNIT-07 disabled insertion advances normally');
}

{
  const doc = document('AUTO-PAIRS-CUSTOM', '');
  const session = typeKey(doc, enter(doc, { autoPairs: { x: 'y' } }), 'x');
  assert.equal(source(doc), 'xy', 'T036-AUTO-PAIRS-UNIT-08 custom table replaces the standard pair table');
  assert.equal(session.cursorOffset, offset(1), 'T036-AUTO-PAIRS-UNIT-09 custom pair keeps the cursor inside');
}

console.log('insert-auto-pairs: all assertions passed');
