// Regression test for 'smarttab': with 'smarttab' (nvim default: on), <Tab>
// where only whitespace precedes the cursor uses 'shiftwidth'; otherwise (or
// with 'smarttab' off) it uses 'softtabstop' when >0, else 'tabstop'.
// Oracle: `.artifacts/oracle/nvim-linux-arm64/bin/nvim --headless --clean -u NONE`
//   `-c 'set expandtab shiftwidth=4 tabstop=8'` `-c 'normal i\t'` on "a\n" (cursor
//     at start of line, 'smarttab' on by default) -> "    a\n" (shiftwidth=4,
//     not tabstop=8).
//   Same options, `-c 'normal li\t'` on "xa\n" (non-whitespace 'x' before
//     cursor) -> "x       a\n" (tabstop=8, not shiftwidth=4).
//   `-c 'set expandtab shiftwidth=4 tabstop=8 nosmarttab'` `-c 'normal i\t'`
//     on "a\n" (start of line, 'smarttab' off) -> "        a\n" (tabstop=8).
import { strict as assert } from 'node:assert';
import { TextFileDocument } from '../../packages/document/src/index';
import { asIdentifier, asUndoGroupId, asUtf16Offset, type DocumentId } from '../../packages/primitives/src/index';
import { beginVimInsert, planVimInsertInput, type VimInsertOptions, type VimInsertPlan, type VimInsertSession } from '../../packages/vim/insert/index';

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'insert-smarttab-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function off(n: number) {
  const result = asUtf16Offset(n);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(id: string, text: string): TextFileDocument {
  const result = TextFileDocument.create(identifier<DocumentId>(id), text, Array.from({ length: text.split('\n').length - 1 }, () => 'lf' as const), 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function applyPlan(doc: TextFileDocument, plan: VimInsertPlan): ReturnType<TextFileDocument['snapshot']> {
  const group = asUndoGroupId(`insert-smarttab-${plan.expectedVersion as number}`);
  if (!group.ok) throw new Error('invalid undo group');
  const committed = doc.commit({ documentId: plan.documentId, expectedVersion: plan.expectedVersion, edits: plan.edits, origin: 'vim', undoGroup: group.value });
  if (!committed.ok) throw new Error(`commit failed: ${committed.error.kind}`);
  return doc.snapshot();
}

function text(snapshot: ReturnType<TextFileDocument['snapshot']>): string {
  const full = snapshot.slice(off(0), off(snapshot.lengthUtf16 as number));
  if (!full.ok) throw new Error('unreadable');
  return full.value;
}

function tab(doc: TextFileDocument, cursor: number, options: VimInsertOptions): string {
  const snapshot0 = doc.snapshot();
  const entered = beginVimInsert(snapshot0, off(cursor), 'i', options);
  assert.equal(entered.ok, true, 'enters insert');
  if (!entered.ok) throw new Error('unreachable');
  const snapshot1 = applyPlan(doc, entered.value.plan);
  const step = planVimInsertInput(snapshot1, entered.value.session, { kind: 'key', key: '<Tab>' });
  assert.equal(step.ok, true, '<Tab> succeeds');
  if (!step.ok || step.value.kind !== 'continued') throw new Error('unreachable');
  return text(applyPlan(doc, step.value.plan));
}

// Start of line, 'smarttab' defaults on -> 'shiftwidth' (4), not 'tabstop' (8).
{
  const doc = document('SMARTTAB-START', 'a\n');
  const result = tab(doc, 0, { expandtab: true, shiftwidth: 4, tabstop: 8 });
  assert.equal(result, '    a\n', 'smarttab at start of line uses shiftwidth');
}

// Non-whitespace before cursor -> 'tabstop' (8), not 'shiftwidth' (4), even
// with 'smarttab' on.
{
  const doc = document('SMARTTAB-MID', 'xa\n');
  const result = tab(doc, 1, { expandtab: true, shiftwidth: 4, tabstop: 8 });
  assert.equal(result, 'x       a\n', 'smarttab mid-line uses tabstop, not shiftwidth');
}

// 'smarttab' off -> always 'tabstop' (softtabstop=0), even at start of line.
{
  const doc = document('SMARTTAB-OFF', 'a\n');
  const result = tab(doc, 0, { expandtab: true, shiftwidth: 4, tabstop: 8, smarttab: false });
  assert.equal(result, '        a\n', 'smarttab off at start of line still uses tabstop');
}

console.log('insert-smarttab: all assertions passed');
