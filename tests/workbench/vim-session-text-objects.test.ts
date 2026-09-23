#!/usr/bin/env bun
// Regression: text objects through the real owned session (parser -> multi -> document).
// Before this test, `ciw`/`di(` deleted from the cursor instead of the object start, and
// Visual `iw`/`i{` were parsed as Insert/motion keys so `viw` ran a plain `w` motion.
// Every expectation below was verified against the oracle:
//   nvim --headless --clean -c "call setline(1,[TEXT])" -c 'normal! KEYS' -c 'echo string(getline(1,"$"))' -c 'q!'
import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { createOwnedVimSession, type OwnedVimKeyEvent } from '../../packages/workbench/vim-session/index';

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'vim-session-text-objects-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

interface Outcome { readonly text: string; readonly mode: string; readonly anchor: number | undefined; readonly head: number | undefined }

async function run(initial: string, keys: string): Promise<Outcome> {
  const created = TextFileDocument.create(id<DocumentId>('doc'), initial, Array.from({ length: initial.split('\n').length - 1 }, () => 'lf' as const), 'lf');
  if (!created.ok) throw new Error(created.error.kind);
  const doc = created.value;
  let mode = 'normal';
  let anchor: number | undefined;
  let head: number | undefined;
  const vim = createOwnedVimSession(doc, {
    viewId: id<ViewId>('view'),
    onStateChange: (state) => {
      mode = state.mode;
      const primary = state.selections.members.find((member) => member.id === state.selections.primaryId) ?? state.selections.members[0];
      anchor = primary?.anchor.at.offset as number | undefined;
      head = primary?.head.at.offset as number | undefined;
    },
  });
  for (const key of parseKeys(keys)) await vim.handleKey(key);
  const snapshot = doc.snapshot();
  const full = snapshot.slice(0 as unknown as Parameters<typeof snapshot.slice>[0], snapshot.lengthUtf16 as unknown as Parameters<typeof snapshot.slice>[1]);
  return { text: full.ok ? full.value : '<unreadable>', mode, anchor, head };
}

function parseKeys(source: string): OwnedVimKeyEvent[] {
  const out: OwnedVimKeyEvent[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source.startsWith('<CR>', index)) {
      out.push({ name: 'Enter', raw: '\r', shift: false, option: false, ctrl: false, meta: false });
      index += 3;
      continue;
    }
    if (source.startsWith('<C-v>', index)) {
      out.push({ name: 'v', raw: '\u0016', shift: false, option: false, ctrl: true, meta: false });
      index += 4;
      continue;
    }
    if (source.startsWith('<Esc>', index)) {
      out.push({ name: 'Esc', raw: '', shift: false, option: false, ctrl: false, meta: false });
      index += 4;
      continue;
    }
    const char = source[index]!;
    out.push({ name: char, raw: char, shift: false, option: false, ctrl: false, meta: false });
  }
  return out;
}

const cases: readonly { readonly id: string; readonly text: string; readonly keys: string; readonly expect: string }[] = [
  // Operator + text object with the cursor inside the object (not at its start).
  { id: 'TXTOBJ-S01 ciw mid-word', text: 'foo bar baz', keys: '5lciwX<Esc>', expect: 'foo X baz' },
  { id: 'TXTOBJ-S02 diw mid-word', text: 'foo bar baz', keys: '5ldiw', expect: 'foo  baz' },
  { id: 'TXTOBJ-S03 ci{ inside braces', text: 'a { b c } d', keys: '4lci{X<Esc>', expect: 'a {X} d' },
  { id: 'TXTOBJ-S04 di( inside parens', text: 'f(a, b) x', keys: '3ldi(', expect: 'f() x' },
  { id: 'TXTOBJ-S05 ci" inside quotes', text: 'x "hello" y', keys: '4lci"Z<Esc>', expect: 'x "Z" y' },
  { id: 'TXTOBJ-S06 yiw mid-word then P', text: 'foo bar', keys: '2lyiwP', expect: 'foofoo bar' },
  { id: 'TXTOBJ-S07 diw then dot-repeat on a lone space', text: 'aa bb cc dd', keys: '4ldiw3l.', expect: 'aa  ccdd' },
  { id: 'TXTOBJ-S07b ciw on a one-letter word', text: 'a b', keys: 'ciwX<Esc>', expect: 'X b' },
  { id: 'TXTOBJ-S07c ci" on empty quotes still enters Insert', text: 'x "" y', keys: '3lci"Z<Esc>', expect: 'x "Z" y' },
  // Visual mode text objects.
  { id: 'TXTOBJ-S08 viwd mid-word', text: 'foo bar baz', keys: '5lviwd', expect: 'foo  baz' },
  { id: 'TXTOBJ-S09 vi{d', text: 'a { b c } d', keys: '4lvi{d', expect: 'a {} d' },
  { id: 'TXTOBJ-S10 va{d', text: 'a { b c } d', keys: '4lva{d', expect: 'a  d' },
  { id: 'TXTOBJ-S11 viwiwd grows into whitespace', text: 'one two three', keys: 'viwiwd', expect: 'two three' },
  { id: 'TXTOBJ-S12 v2iwd counts objects', text: 'foo bar baz', keys: '5lv2iwd', expect: 'foo baz' },
  { id: 'TXTOBJ-S13 vipd is linewise', text: 'p1\np1b\n\np2', keys: 'vipd', expect: '\np2' },
];

for (const item of cases) {
  const outcome = await run(item.text, item.keys);
  assert.equal(outcome.text, item.expect, `${item.id}: ${JSON.stringify(item.keys)} on ${JSON.stringify(item.text)}`);
}

// Selection shape after a Visual text object: nvim `4lvi{` on 'a { b c } d' reports
// mode v, col("v")=4, col(".")=8 (1-based) -> anchor offset 3, head offset 7.
{
  const outcome = await run('a { b c } d', '4lvi{');
  assert.equal(outcome.mode, 'visual-character', 'TXTOBJ-S14 vi{ stays in characterwise Visual');
  assert.equal(outcome.anchor, 3, 'TXTOBJ-S14 vi{ anchor moves to the inner block start');
  assert.equal(outcome.head, 7, 'TXTOBJ-S14 vi{ head lands on the inner block end');
}
{
  const outcome = await run('foo bar baz', '5lviw');
  assert.equal(outcome.anchor, 4, 'TXTOBJ-S15 viw anchor moves to word start');
  assert.equal(outcome.head, 6, 'TXTOBJ-S15 viw head lands on the last word character');
}
{
  // nvim `vip` on ['p1','p1b','','p2']: mode V, line("v")=1, line(".")=2.
  const outcome = await run('p1\np1b\n\np2', 'vip');
  assert.equal(outcome.mode, 'visual-line', 'TXTOBJ-S16 vip switches to linewise Visual');
}
// Operator-pending `i` still means text object (regression guard for the new Visual grammar).
{
  const outcome = await run('abc', 'iX<Esc>');
  assert.equal(outcome.text, 'Xabc', 'TXTOBJ-S17 Normal-mode i still enters Insert');
}

// Bare G addresses the last line in every Visual kind; a typed count addresses that line.
for (const visual of ['v', 'V', '<C-v>'] as const) {
  const end = await run('one\ntwo\nthree', `${visual}G`);
  assert.equal(end.mode, visual === 'V' ? 'visual-line' : visual === 'v' ? 'visual-character' : 'visual-block', `${visual}G stays Visual`);
  assert.equal(end.head, 8, `${visual}G reaches the last line`);
  const counted = await run('one\ntwo\nthree', `j${visual}3G`);
  assert.equal(counted.head, 8, `${visual}3G reaches the counted line`);
  const firstCounted = await run('one\ntwo\nthree', `j${visual}1G`);
  assert.equal(firstCounted.head, 0, `${visual}1G differs from bare G`);
  const first = await run('one\ntwo\nthree', `j${visual}gg`);
  assert.equal(first.head, 0, `${visual}gg reaches the first line`);
}
{
  const matched = await run('(x)\nlast', 'v%');
  assert.equal(matched.head, 2, 'Visual % extends to the matching delimiter');
  const paragraph = await run('one\n\ntwo', 'v}');
  assert.equal(paragraph.mode, 'visual-character', 'Visual paragraph motion keeps its mode');
  assert.notEqual(paragraph.head, paragraph.anchor, 'Visual paragraph motion extends selection');
  const find = await run('abcabc', 'vfb;');
  assert.equal(find.head, 4, 'Visual f and ; extend through repeated character finds');
  const search = await run('one two one', 'v/one<CR>');
  assert.equal(search.head, 8, 'Visual search reaches the next match');
  const repeat = await run('one two one', 'v/one<CR>n');
  assert.equal(repeat.head, 0, 'Visual n repeats the search while retaining the selection');
}

console.log(`vim-session-text-objects: ${cases.length + 23} checks passed`);
