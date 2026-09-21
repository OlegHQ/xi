import assert from 'node:assert/strict';
import { asIdentifier, asUtf16Offset, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { createOwnedVimSession } from '../../packages/workbench/vim-session/index';
import type { ClipboardPort, Result, PlatformFailure } from '../../packages/contracts/src/index';

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'clipboard-stale');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function check(change: (vim: ReturnType<typeof createOwnedVimSession>, document: TextFileDocument, deactivate: () => void) => Promise<void> | void): Promise<void> {
  const opened = TextFileDocument.create(id<DocumentId>('clipboard-stale-document'), 'abc', [], 'lf');
  if (!opened.ok) throw new Error(opened.error.kind);
  const document = opened.value;
  let resolveRead: ((result: Result<string, PlatformFailure>) => void) | undefined;
  const clipboard: ClipboardPort = {
    readText: () => new Promise((resolve) => { resolveRead = resolve; }),
    writeText: async () => ({ ok: true, value: undefined }),
  };
  let active = true;
  const vim = createOwnedVimSession(document, { viewId: id<ViewId>('clipboard-stale-view'), clipboard, isActive: () => active });
  const pending = vim.handleClipboardPaste();
  await change(vim, document, () => { active = false; });
  resolveRead?.({ ok: true, value: 'STALE' });
  await pending;
  const snapshot = document.snapshot();
  const start = asUtf16Offset(0);
  const end = asUtf16Offset(snapshot.lengthUtf16);
  if (!start.ok || !end.ok) throw new Error('invalid offsets');
  const text = snapshot.slice(start.value, end.value);
  assert.equal(text.ok && text.value, change === dispose ? 'abc' : change === edit ? 'xbc' : 'abc');
  vim.dispose();
}

const dispose = (vim: ReturnType<typeof createOwnedVimSession>): void => vim.dispose();
const edit = (_vim: ReturnType<typeof createOwnedVimSession>, document: TextFileDocument): void => {
  const start = asUtf16Offset(0);
  const end = asUtf16Offset(1);
  if (!start.ok || !end.ok) throw new Error('invalid offsets');
  assert.equal(document.apply({ start: start.value, end: end.value, text: 'x' }, document.version).ok, true);
};
const move = async (vim: ReturnType<typeof createOwnedVimSession>): Promise<void> => { await vim.handleKey({ name: 'l', raw: 'l', shift: false, option: false, ctrl: false, meta: false }); };
const switchBuffer = (_vim: ReturnType<typeof createOwnedVimSession>, _document: TextFileDocument, deactivate: () => void): void => deactivate();

await check(dispose);
await check(edit);
await check(move);
await check(switchBuffer);
