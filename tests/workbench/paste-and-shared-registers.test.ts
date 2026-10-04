import assert from 'node:assert/strict';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { createOwnedVimSession } from '../../packages/workbench/vim-session/index';
import { createVimRegisterBank } from '../../packages/vim/src/index';

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'paste-shared-registers');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function open(name: string, text: string): TextFileDocument {
  const opened = TextFileDocument.create(id<DocumentId>(name), text, [], 'lf');
  if (!opened.ok) throw new Error(opened.error.kind);
  return opened.value;
}
const key = (raw: string) => ({ name: raw, raw, shift: false, option: false, ctrl: false, meta: false });
const text = (document: TextFileDocument): string => { const s = document.snapshot(); const r = s.slice(0 as never, s.lengthUtf16 as never); return r.ok ? r.value : ''; };

// A yank in one buffer's session pastes in another buffer's session through the host-owned bank.
let bank = createVimRegisterBank();
const registers = { read: () => bank, write: (next: typeof bank) => { bank = next; } };
const first = open('shared-a', 'alpha');
const second = open('shared-b', 'other');
const a = createOwnedVimSession(first, { viewId: id<ViewId>('shared-a-view'), registers });
const b = createOwnedVimSession(second, { viewId: id<ViewId>('shared-b-view'), registers });
await a.handleKey(key('y')); await a.handleKey(key('y'));
await b.handleKey(key('p'));
assert.equal(text(second), 'other\nalpha');

// A paste publishes the moved selections, so the host never projects a stale document version.
let published = 0;
const pasted = open('paste-state', 'abc');
const c = createOwnedVimSession(pasted, { viewId: id<ViewId>('paste-state-view'), onStateChange: () => { published += 1; } });
c.handlePaste(new TextEncoder().encode('X\n'));
assert.ok(published >= 2, "paste publishes final state after the edit");
assert.equal(text(pasted), 'abc\nX');
