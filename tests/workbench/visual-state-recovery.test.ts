import assert from 'node:assert/strict';
import { TextFileDocument } from '../../packages/document/src/index';
import type { DocumentId, ViewId } from '../../packages/primitives/src/index';
import { WorkbenchSession } from '../../packages/workbench/session';
import { createOwnedVimSession } from '../../packages/workbench/vim-session';
import { executeViewCommand } from '../../packages/workbench/input/view-commands';

function fixture(text = Array.from({ length: 60 }, (_, i) => `word${i} next`).join('\n')) {
  const document = TextFileDocument.create('visual-recovery' as DocumentId, text, Array.from(text.matchAll(/\n/g), () => 'lf' as const), 'lf');
  assert.ok(document.ok);
  const workbench = new WorkbenchSession();
  const viewId = 'visual-recovery' as ViewId;
  assert.ok(workbench.openBuffer(document.value, { viewId }).ok);
  const vim = createOwnedVimSession(document.value, { viewId, onStateChange: state => {
    assert.ok(workbench.syncViewSession(viewId, state.selections, state.mode).ok);
  } });
  const key = async (name: string) => { await vim.handleKey({ name, raw: name, shift: false, ctrl: false, meta: false, option: false }); };
  return { vim, key, document: document.value, view: () => workbench.readView(viewId)!,
    scroll: (direction: 'up' | 'down') => executeViewCommand(`view.half-page-${direction}`, { workbench, viewId, getSession: () => vim, viewportHeight: 10, scrollLines: 3 }),
    dispose: () => { vim.dispose(); workbench.dispose(); } };
}

const unicode = fixture('abcdef\n😀\n\nz');
assert.ok(unicode.vim.setCursorPosition(1, 99));
assert.equal(unicode.view().selections.members[0]!.head.at.offset, 7, 'short-line clamp never splits an emoji');
await unicode.key('v');
assert.ok(unicode.vim.setCursorPosition(2, 99));
assert.equal(unicode.view().selections.members[0]!.anchor.at.offset, 7);
await unicode.key('Escape'); await unicode.key('i'); await unicode.key('Z'); await unicode.key('Escape');
assert.equal(unicode.view().session.mode, 'normal');
unicode.dispose();

const cancelled = fixture();
await cancelled.key('d');
cancelled.vim.cancelPendingOperator();
const unchanged = cancelled.document.snapshot().version;
await cancelled.key('w');
assert.equal(cancelled.document.snapshot().version, unchanged, 'cancelled operator cannot consume the next motion');
cancelled.dispose();

// Minimized crash: block text-object output and session mode previously disagreed.
const block = fixture();
for (const key of ['<C-v>', 'i', 'w', 'Escape', 'i', 'Z', 'Escape']) await block.key(key);
assert.equal(block.view().session.mode, 'normal');
assert.ok(block.document.snapshot().slice(0 as never, 1 as never).ok);
block.dispose();

for (const entry of ['v', 'V', '<C-v>']) {
  const f = fixture();
  await f.key(entry);
  const anchor = f.view().selections.members[0]!.anchor.at.offset;
  assert.ok(f.scroll('down'));
  assert.equal(f.view().selections.members[0]!.anchor.at.offset, anchor);
  assert.equal((f.document.snapshot().lineIndexAt(f.view().selections.members[0]!.head.at.offset) as { value: number }).value, 5, `${entry}: half-page moves once and extends`);
  assert.ok(f.scroll('up'));
  assert.equal((f.document.snapshot().lineIndexAt(f.view().selections.members[0]!.head.at.offset) as { value: number }).value, 0);
  await f.key(entry);
  assert.equal(f.view().session.mode, 'normal', 'same visual key toggles out');
  await f.key('i'); await f.key('Z'); await f.key('Escape');
  assert.equal(f.view().session.mode, 'normal');
  f.dispose();
}
for (const first of ['v', 'V', '<C-v>']) for (const second of ['v', 'V', '<C-v>']) {
  const f = fixture();
  await f.key(first); await f.key('j'); await f.key(second);
  if (first !== second) {
    assert.equal(f.view().selections.members[0]!.kind, second === 'v' ? 'visual-character' : second === 'V' ? 'visual-line' : 'visual-block');
    assert.equal((f.document.snapshot().lineIndexAt(f.view().selections.members[0]!.anchor.at.offset) as { value: number }).value, 0);
    assert.equal((f.document.snapshot().lineIndexAt(f.view().selections.members[0]!.head.at.offset) as { value: number }).value, 1);
  }
  await f.key('Escape'); await f.key('i'); await f.key('Z'); await f.key('Escape');
  assert.equal(f.view().session.mode, 'normal');
  f.dispose();
}
console.log('Visual transitions, text objects, scroll extension and edit recovery passed');

// Seeded transition pressure: retain the exact trace if an invariant ever fails.
for (const initialSeed of [41027, 17021, 147]) {
  const f = fixture();
  let seed = initialSeed;
  const trace: string[] = [];
  const keys = ['v', 'V', '<C-v>', 'Escape', 'Escape', 'j', 'k', 'down', 'up', 'h', 'l', 'i', 'a', 'w', 'e', 'b', 'o', 'O', 'd', 'c', 'y', 'u', '<C-g>'];
  try {
    for (let step = 0; step < 1000; step++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const key = keys[seed % keys.length]!;
      trace.push(key);
      await f.key(key);
      const view = f.view();
      assert.equal(view.selections.documentVersion, view.document.version);
      assert.ok(view.selections.members.length > 0);
      for (const member of view.selections.members) {
        assert.ok(member.anchor.at.offset >= 0 && member.anchor.at.offset <= view.document.lengthUtf16);
        assert.ok(member.head.at.offset >= 0 && member.head.at.offset <= view.document.lengthUtf16);
      }
      if (step % 100 === 99) {
        await f.key('Escape'); await f.key('Escape');
        assert.equal(f.view().session.mode, 'normal', `seed ${initialSeed}, step ${step}: Escape recovers`);
        const size = f.document.snapshot().lengthUtf16;
        await f.key('i'); await f.key('Z'); await f.key('Escape');
        assert.equal(f.document.snapshot().lengthUtf16, size + 1, 'input remains live after recovery');
      }
    }
  } catch (error) {
    await Bun.write(`.artifacts/selection-fixes/state-seed-${initialSeed}.json`, JSON.stringify(trace));
    throw error;
  } finally { f.dispose(); }
}
console.log('3,000 seeded mode/edit/motion steps preserved version/endpoints and Escape/edit recovery');
