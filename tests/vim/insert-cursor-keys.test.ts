// Insert/Replace cursor-only keys (packages/vim/insert/index.ts): <Left> <Right> <Up>
// <Down> <Home> <End> <C-Left> <C-Right> move the caret without leaving Insert mode or
// editing text, never wrap to an adjacent line, keep a Normal `j`/`k`-style desired column
// across <Up>/<Down>, and start a new undo/dot-repeat piece (nvim: an arrow key breaks the
// insert into a new undo sequence and dot only replays the text typed after it).
//
// Oracle: nvim --headless --clean -u NONE 0.12.4, e.g.
//   nvim --headless --clean -u NONE -c 'execute "normal! ggi\<Right>\<Right>Z\<Esc>"' ...
//     on "foo bar baz" gives "foZo bar baz"
//   ... 'execute "normal! ggi\<Left>Z\<Esc>"' on "foo\nbar" gives "Zfoo\nbar" (no wrap)
//   ... 'execute "normal! ggA\<Right>Z\<Esc>"' on "foo\nbar" gives "fooZ\nbar" (no wrap)
//   ... 'execute "normal! \$a\<Home>Z\<End>Y\<Esc>"' on "foo bar baz" gives "Zfoo bar bazY"
//   ... 'execute "normal! i\<C-Right>Z\<Esc>"' on "foo.bar baz" gives "fooZ.bar baz"
//   ... 'execute "normal! i\<C-Right>\<C-Right>Z\<Esc>"' on "foo.bar baz" gives "foo.Zbar baz"
//   ... 'execute "normal! \$a\<C-Left>Z\<Esc>"' on "foo bar baz" gives "foo bar Zbaz"
//   ... 'execute "normal! 2GA\<Up>Z\<Down>\<Down>Y\<Esc>"' on "a\nbcdefg\na" gives "aZ\nbcdefg\naY"
//   ... 'execute "normal! iab\<Left>c\<Esc>."' on "" gives "accb"
import { strict as assert } from 'node:assert';
import { asIdentifier, asUndoGroupId, asUtf16Offset, type DocumentId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import {
  beginVimInsert,
  planVimInsertInput,
  type VimInsertPlan,
  type VimInsertSession,
  type VimInsertTransition,
} from '../../packages/vim/insert/index';
import type { ViewId } from '../../packages/primitives/src/index';
import { createOwnedVimSession, type OwnedVimKeyEvent } from '../../packages/workbench/vim-session/index';

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'insert-cursor-keys-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function toOffset(value: number) {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(text: string): TextFileDocument {
  const lines = text.split('\n');
  const result = TextFileDocument.create(identifier<DocumentId>(`insert-cursor-keys-${Math.random()}`), text, Array.from({ length: lines.length - 1 }, () => 'lf' as const), 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

let groupCounter = 0;

/** Apply an insert plan's edits so the next planVimInsertInput call sees an up-to-date snapshot. */
function applyPlan(doc: TextFileDocument, plan: VimInsertPlan): ReturnType<TextFileDocument['snapshot']> {
  if (plan.edits.length === 0) return doc.snapshot();
  groupCounter += 1;
  const group = asUndoGroupId(`insert-cursor-keys-${groupCounter}`);
  if (!group.ok) throw new Error('invalid undo group');
  const committed = doc.commit({
    documentId: plan.documentId,
    expectedVersion: plan.expectedVersion,
    edits: plan.edits,
    origin: 'vim',
    undoGroup: group.value,
  });
  if (!committed.ok) throw new Error(`commit failed: ${committed.error.kind}`);
  return doc.snapshot();
}

function text(doc: TextFileDocument): string {
  const snapshot = doc.snapshot();
  const whole = snapshot.slice(toOffset(0), toOffset(snapshot.lengthUtf16));
  if (!whole.ok) throw new Error('unreadable');
  return whole.value;
}

/** Drive one insert session through a sequence of keys against a fresh document, typing a
 * literal character for any key not in `<...>` notation. */
function run(initial: string, entryOffset: number, entryKey: 'i' | 'a' | 'A', keys: readonly string[]): { readonly text: string; readonly session: VimInsertSession; readonly transitions: readonly VimInsertTransition[] } {
  const doc = document(initial);
  let snapshot = doc.snapshot();
  const entered = beginVimInsert(snapshot, toOffset(entryOffset), entryKey);
  assert.equal(entered.ok, true, `CURSOR-KEYS entry ${entryKey} succeeds`);
  if (!entered.ok) throw new Error('unreachable');
  snapshot = applyPlan(doc, entered.value.plan);
  let session = entered.value.session;
  const transitions: VimInsertTransition[] = [entered.value];
  for (const key of keys) {
    const planned = planVimInsertInput(snapshot, session, { kind: 'key', key });
    assert.equal(planned.ok, true, `CURSOR-KEYS key ${key} succeeds`);
    if (!planned.ok) throw new Error('unreachable');
    snapshot = applyPlan(doc, planned.value.plan);
    if (planned.value.kind === 'exited') throw new Error('unexpected exit');
    session = planned.value.session;
    transitions.push(planned.value);
  }
  return { text: text(doc), session, transitions };
}

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'insert-cursor-keys-session-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function event(name: string, raw = name): OwnedVimKeyEvent {
  return { name, raw, shift: false, option: false, ctrl: false, meta: false };
}

function keys(source: string): OwnedVimKeyEvent[] {
  const out: OwnedVimKeyEvent[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '<') {
      const end = source.indexOf('>', index);
      const token = source.slice(index + 1, end);
      index = end + 1;
      if (token === 'Esc') out.push(event('ESC', '\x1b'));
      else out.push(event(token));
      continue;
    }
    out.push(event(char === ' ' ? 'space' : char, char));
    index += 1;
  }
  return out;
}

async function main(): Promise<void> {
  // 1. <Right><Right> then a literal char: "foo bar baz" -> "foZo bar baz".
  {
    const result = run('foo bar baz', 0, 'i', ['<Right>', '<Right>', 'Z']);
    assert.equal(result.text, 'foZo bar baz', 'CURSOR-KEYS-01 <Right><Right> moves two graphemes');
  }

  // 2. <Left> at column 0 never wraps to the previous line.
  {
    const result = run('foo\nbar', 0, 'i', ['<Left>', 'Z']);
    assert.equal(result.text, 'Zfoo\nbar', 'CURSOR-KEYS-02 <Left> at column 0 does not wrap');
  }

  // 3. <Right> at end of line never wraps to the next line.
  {
    const result = run('foo\nbar', 3, 'A', ['<Right>', 'Z']);
    assert.equal(result.text, 'fooZ\nbar', 'CURSOR-KEYS-03 <Right> at end of line does not wrap');
  }

  // 4. <Home>/<End>: <Home> goes to column 0, <End> to one past the last character.
  {
    const result = run('foo bar baz', 11, 'A', ['<Home>', 'Z', '<End>', 'Y']);
    assert.equal(result.text, 'Zfoo bar bazY', 'CURSOR-KEYS-04 <Home>/<End> reach both line boundaries');
  }

  // 5. <C-Right> stops at the next word/punctuation-class boundary, not the next blank
  // (WORD-style `<C-w>` deletion is a different class of motion).
  {
    const result = run('foo.bar baz', 0, 'i', ['<C-Right>', 'Z']);
    assert.equal(result.text, 'fooZ.bar baz', 'CURSOR-KEYS-05 <C-Right> stops at the punctuation-class boundary');
  }
  {
    const result = run('foo.bar baz', 0, 'i', ['<C-Right>', '<C-Right>', 'Z']);
    assert.equal(result.text, 'foo.Zbar baz', 'CURSOR-KEYS-06 a second <C-Right> reaches the next word start');
  }

  // 6. <C-Left> from end of line reaches the start of the last word.
  {
    const result = run('foo bar baz', 11, 'A', ['<C-Left>', 'Z']);
    assert.equal(result.text, 'foo bar Zbaz', 'CURSOR-KEYS-07 <C-Left> reaches the start of the last word');
  }

  // 7. Undo/dot-repeat piece break: a cursor move reports plan.undoAction 'break', not
  // 'continue', and never produces an edit.
  {
    const doc = document('ab');
    const entered = beginVimInsert(doc.snapshot(), toOffset(0), 'i');
    assert.equal(entered.ok, true, 'CURSOR-KEYS-08 entry succeeds');
    if (!entered.ok) throw new Error('unreachable');
    const snapshot = applyPlan(doc, entered.value.plan);
    const moved = planVimInsertInput(snapshot, entered.value.session, { kind: 'key', key: '<Left>' });
    assert.equal(moved.ok, true, 'CURSOR-KEYS-09 <Left> succeeds');
    if (!moved.ok) throw new Error('unreachable');
    assert.equal(moved.value.plan.undoAction, 'break', "CURSOR-KEYS-10 a cursor move reports undoAction 'break'");
    assert.equal(moved.value.plan.edits.length, 0, 'CURSOR-KEYS-11 a cursor move never edits the document');
  }

  // 8. <Up>/<Down> keep the desired display-cell column, like Normal `j`/`k`: landing on a
  // shorter line clamps to its end but does not forget the original column, so a later
  // <Down> back onto a long-enough line returns to it.
  // nvim: "a\nbcdefg\na" + `2GA<Up>` clamps to the end of "a" (col 1, from col 6), then
  // `<Down>` returns to col 6 on "bcdefg", then `<Down>` again clamps to the end of "a".
  {
    const doc = document('a\nbcdefg\na');
    const entered = beginVimInsert(doc.snapshot(), toOffset(8), 'A');
    assert.equal(entered.ok, true, 'CURSOR-KEYS-12 entry succeeds');
    if (!entered.ok) throw new Error('unreachable');
    assert.equal(entered.value.session.cursorOffset, 8, 'CURSOR-KEYS-13 A enters at the end of "bcdefg"');
    let snapshot = applyPlan(doc, entered.value.plan);
    const up = planVimInsertInput(snapshot, entered.value.session, { kind: 'key', key: '<Up>' });
    assert.equal(up.ok, true, 'CURSOR-KEYS-14 <Up> succeeds');
    if (!up.ok || up.value.kind === 'exited') throw new Error('unreachable');
    assert.equal(up.value.session.cursorOffset, 1, 'CURSOR-KEYS-15 <Up> clamps to the end of the shorter line "a"');
    assert.equal(up.value.session.desiredColumn, 6, 'CURSOR-KEYS-16 the desired column (6) survives the clamp');
    snapshot = applyPlan(doc, up.value.plan);
    const down1 = planVimInsertInput(snapshot, up.value.session, { kind: 'key', key: '<Down>' });
    assert.equal(down1.ok, true, 'CURSOR-KEYS-17 <Down> succeeds');
    if (!down1.ok || down1.value.kind === 'exited') throw new Error('unreachable');
    assert.equal(down1.value.session.cursorOffset, 8, 'CURSOR-KEYS-18 <Down> returns to column 6 on "bcdefg"');
    snapshot = applyPlan(doc, down1.value.plan);
    const down2 = planVimInsertInput(snapshot, down1.value.session, { kind: 'key', key: '<Down>' });
    assert.equal(down2.ok, true, 'CURSOR-KEYS-19 a second <Down> succeeds');
    if (!down2.ok || down2.value.kind === 'exited') throw new Error('unreachable');
    assert.equal(down2.value.session.cursorOffset, 10, 'CURSOR-KEYS-20 <Down> onto the final "a" clamps again, still remembering column 6');
  }

  // 9. Dot-repeat after a cursor move: nvim's `iab<Left>c<Esc>` then `.` only replays "c",
  // the text typed after the movement, not "abc" (verified through the owning
  // workbench/vim-session, which is what actually records the dot-repeat target).
  {
    const doc = document('');
    const vim = createOwnedVimSession(doc, { viewId: id<ViewId>('insert-cursor-keys-view') });
    for (const key of keys('iab<Left>c<Esc>.')) await vim.handleKey(key);
    assert.equal(text(doc), 'accb', 'CURSOR-KEYS-21 dot only replays text typed after the last cursor move');
  }

  console.log('insert-cursor-keys: all fixtures passed');
}

void main();
