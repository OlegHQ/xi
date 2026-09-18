import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { createOwnedVimSession, type OwnedVimKeyEvent } from '../../packages/workbench/vim-session/index';

// Neovim i_ALT: an unmapped <M-x> acts as <Esc> then x. A cold-start read that coalesces
// "\x1b:" into one chunk therefore still leaves Insert mode and opens the ':' prompt.
function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'alt-chord-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const key = (raw: string, extra: Partial<OwnedVimKeyEvent> = {}): OwnedVimKeyEvent => ({ name: raw, raw, shift: false, option: false, ctrl: false, meta: false, ...extra });
const created = TextFileDocument.create(id<DocumentId>('alt-chord-doc'), 'first line\nsecond line\n', ['lf', 'lf'], 'lf');
if (!created.ok) throw new Error(created.error.kind);
const doc = created.value;
let mode = 'normal';
const session = createOwnedVimSession(doc, { viewId: id<ViewId>('alt-chord-view'), onStateChange: (state) => { mode = state.mode; } });
await session.handleKey(key('i'));
await session.handleKey(key('X'));
await session.handleKey(key(':', { option: true }));
assert.equal(mode, 'normal', 'ALT-CHORD-01 <M-:> in Insert leaves Insert mode');
assert.equal(session.commandLine?.source, ':', 'ALT-CHORD-02 and then opens the : command line');
const text = doc.snapshot().slice(0 as never, 11 as never);
assert.equal(text.ok && text.value, 'Xfirst line', 'ALT-CHORD-03 only the typed X was inserted');
await session.handleKey(key('Escape', { raw: '\x1b' }));
await session.handleKey(key('l', { meta: true }));
assert.equal(mode, 'normal', 'ALT-CHORD-04 <M-l> in Normal is <Esc>l: stays Normal');
assert.equal(session.commandLine, undefined, 'ALT-CHORD-05 the command line closed on the split Esc');
session.dispose();
console.log('vim-session alt-chord passed');
