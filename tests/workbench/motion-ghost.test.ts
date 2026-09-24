import assert from 'node:assert/strict';
import { WorkbenchSession } from '../../packages/workbench/session';
import { TextFileDocument } from '../../packages/document/src/index';
import type { DocumentId, ViewId } from '../../packages/primitives/src/index';
import { createOwnedVimSession } from '../../packages/workbench/vim-session';

function fixture(text = 'one two three\nnext line\n', motionGhost = true) {
  const document = TextFileDocument.create('ghost-document' as DocumentId, text, Array.from(text.matchAll(/\n/g), () => 'lf' as const), 'lf');
  assert.ok(document.ok);
  const workbench = new WorkbenchSession();
  assert.ok(workbench.openBuffer(document.value, { viewId: 'ghost-view' as ViewId }).ok);
  const vim = createOwnedVimSession(document.value, { viewId: 'ghost-view' as ViewId, motionGhost, onStateChange: state => {
    const result = workbench.syncViewSession('ghost-view' as ViewId, state.selections, state.mode);
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(workbench.readView('ghost-view' as ViewId)!.selections, state.selections);
  } });
  return { vim, document: document.value, view: () => vim.readView(vim.activeViewId!)!,
    key: async (name: string) => { await vim.handleKey({ name, raw: name, shift: false, ctrl: false, option: false, meta: false }); } };
}

for (const [keys, start, end] of [[['w'], 0, 4], [['2', 'w'], 4, 8], [['f', 't'], 0, 5]] as const) {
  const f = fixture();
  for (const key of keys) await f.key(key);
  const ghost = f.vim.motionGhost;
  assert.ok(ghost, keys.join(''));
  assert.deepEqual([ghost.preview.members[0]!.extent.start, ghost.preview.members[0]!.extent.end], [start, end], keys.join(''));
  assert.equal(f.view().session.mode, 'normal');
  await f.key('v');
  assert.equal(f.view().session.mode, 'visual');
  assert.deepEqual(f.view().selections, ghost.selection, 'v adopts exactly the engine-owned ghost');
  assert.equal(f.vim.motionGhost, undefined);
  await f.key('d');
  assert.equal(f.document.snapshot().lengthUtf16, 24 - (end - start), 'visual delete consumes the highlighted extent');
  await f.key('u');
  assert.equal(f.document.snapshot().lengthUtf16, 24);
  f.vim.dispose();
}
const unicode = fixture('a😀b\n');
await unicode.key('f');
await unicode.key('😀');
assert.deepEqual(unicode.vim.motionGhost?.preview.members[0]?.extent, { kind: 'characterwise', start: 0, end: 3 });
await unicode.key('v');
await unicode.key('d');
assert.equal(unicode.document.snapshot().lengthUtf16, 2, 'surrogate pair remains whole');
unicode.vim.dispose();
for (const key of ['h', 'Escape', 'i', 'd']) {
  const f = fixture();
  await f.key('w');
  if (key === 'h') { await f.key('0'); }
  await f.key(key);
  assert.equal(f.vim.motionGhost, undefined, `clear on ${key}`);
  f.vim.dispose();
}
// `gg` arrives as a g-prefixed command; its final raw `g` must not make it a ghosted motion.
for (const keys of [['j', 'g', 'g'], ['G', 'g', 'g'], ['g', '_']]) {
  const f = fixture();
  for (const key of keys) await f.key(key);
  assert.equal(f.vim.motionGhost, undefined, `no ghost after ${keys.join('')}`);
  f.vim.dispose();
}
const strict = fixture(undefined, false);
await strict.key('w');
assert.equal(strict.vim.motionGhost, undefined);
await strict.key('v');
assert.equal(strict.view().selections.members[0]!.anchor.at.offset, 4, 'strict v begins at the current cursor');
strict.vim.dispose();
const multi = fixture('one two\nred blue\n');
await multi.vim.submitCommandLine('xi selection.add-below');
await multi.key('w');
const members = multi.vim.motionGhost?.selection.members;
assert.equal(members?.length, 2, 'ghost keeps every motion member');
await multi.key('v');
assert.deepEqual(multi.view().selections.members, members, 'Visual adopts both members');
multi.vim.dispose();
const stale = fixture();
await stale.key('w');
assert.ok(stale.vim.motionGhost);
stale.vim.clearMotionGhost();
await stale.key('v');
assert.equal(stale.view().selections.members[0]!.anchor.at.offset, 4, 'focus/panel cancellation prevents stale adoption');
stale.vim.dispose();
const placed = fixture();
await placed.key('w');
assert.ok(placed.vim.setCursorPosition(1));
assert.equal(placed.vim.motionGhost, undefined, 'host/pointer placement invalidates the previous target');
await placed.key('w');
assert.ok(placed.vim.motionGhost);
placed.vim.dispose();
assert.equal(placed.vim.motionGhost, undefined, 'dispose releases preview state');
console.log('motion ghost passed motions, counts, find, Unicode, Visual delete/undo, clear and strict profile');
