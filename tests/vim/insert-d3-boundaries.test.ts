// Regression tests for D3: insert-mode <C-w>, <C-u>, and <Tab> boundary bugs in
// packages/vim/insert/index.ts.
// Oracle: `.artifacts/oracle/nvim-linux-arm64/bin/nvim --headless --clean -u NONE`
//   <C-w>: `-c 'normal ifoo.bar\x17'` on an empty file -> "foo." (word-class boundary,
//     not a whitespace/non-whitespace split).
//   <C-u>: `-c 'set autoindent shiftwidth=2' -c 'normal A\rfoo\x15'` on "  if (x) {" ->
//     "  if (x) {\n  \n" (keeps the auto-inserted indent even when Insert began on an
//     earlier line).
//   <Tab>: `-c 'set shiftwidth=2 tabstop=8 softtabstop=0 expandtab' -c 'normal A\tx'`
//     on "a\n" -> "a       x\n" (pads to 'tabstop', not 'shiftwidth').
import { strict as assert } from 'node:assert';
import { TextFileDocument } from '../../packages/document/src/index';
import { asIdentifier, asUndoGroupId, asUtf16Offset, type DocumentId } from '../../packages/primitives/src/index';
import { beginVimInsert, planVimInsertInput, type VimInsertOptions, type VimInsertPlan, type VimInsertSession } from '../../packages/vim/insert/index';

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'insert-d3-id');
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
  const group = asUndoGroupId(`insert-d3-${plan.expectedVersion as number}`);
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

async function typeKeys(doc: TextFileDocument, snapshot: ReturnType<TextFileDocument['snapshot']>, session: VimInsertSession, keys: readonly string[]) {
  let current = snapshot;
  let s = session;
  for (const key of keys) {
    const result = planVimInsertInput(current, s, { kind: 'key', key });
    if (!result.ok || result.value.kind !== 'continued') throw new Error(`key ${key} failed`);
    current = applyPlan(doc, result.value.plan);
    s = result.value.session;
  }
  return { snapshot: current, session: s };
}

async function main(): Promise<void> {
  // <C-w> stops at a word-class boundary, not any non-whitespace run.
  {
    const doc = document('D3-CW', '');
    const snapshot0 = doc.snapshot();
    const entered = beginVimInsert(snapshot0, off(0), 'i');
    assert.equal(entered.ok, true, 'D3-CW enters insert');
    if (!entered.ok) throw new Error('unreachable');
    const snapshot1 = applyPlan(doc, entered.value.plan);
    const typed = await typeKeys(doc, snapshot1, entered.value.session, [...'foo.bar']);
    const cw = planVimInsertInput(typed.snapshot, typed.session, { kind: 'key', key: '<C-w>' });
    assert.equal(cw.ok, true, 'D3-CW <C-w> succeeds');
    if (!cw.ok || cw.value.kind !== 'continued') throw new Error('unreachable');
    const finalSnapshot = applyPlan(doc, cw.value.plan);
    assert.equal(text(finalSnapshot), 'foo.', 'D3-CW <C-w> after "foo.bar" leaves "foo."');
  }

  // <C-u> preserves an auto-indent inserted by <CR> during the same insert session.
  {
    const doc = document('D3-CU', '  if (x) {\n');
    const snapshot0 = doc.snapshot();
    const options: VimInsertOptions = { autoindent: true };
    const entered = beginVimInsert(snapshot0, off(2), 'A', options);
    assert.equal(entered.ok, true, 'D3-CU enters insert');
    if (!entered.ok) throw new Error('unreachable');
    const snapshot1 = applyPlan(doc, entered.value.plan);
    const afterCr = await typeKeys(doc, snapshot1, entered.value.session, ['<CR>', ...'foo']);
    const cu = planVimInsertInput(afterCr.snapshot, afterCr.session, { kind: 'key', key: '<C-u>' });
    assert.equal(cu.ok, true, 'D3-CU <C-u> succeeds');
    if (!cu.ok || cu.value.kind !== 'continued') throw new Error('unreachable');
    const finalSnapshot = applyPlan(doc, cu.value.plan);
    assert.equal(text(finalSnapshot), '  if (x) {\n  \n', 'D3-CU <C-u> keeps the auto-indent');
  }

  // <Tab> with expandtab and softtabstop=0 pads to 'tabstop', not 'shiftwidth'.
  {
    const doc = document('D3-TAB', 'a\n');
    const snapshot0 = doc.snapshot();
    const options: VimInsertOptions = { expandtab: true, shiftwidth: 2, tabstop: 8, softtabstop: 0 };
    const entered = beginVimInsert(snapshot0, off(1), 'A', options);
    assert.equal(entered.ok, true, 'D3-TAB enters insert');
    if (!entered.ok) throw new Error('unreachable');
    const snapshot1 = applyPlan(doc, entered.value.plan);
    const typed = await typeKeys(doc, snapshot1, entered.value.session, ['<Tab>', 'x']);
    assert.equal(text(typed.snapshot), 'a       x\n', 'D3-TAB pads to column 8 (tabstop), not 2 (shiftwidth)');
  }

  console.log('insert-d3-boundaries: all assertions passed');
}

void main();
