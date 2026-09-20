import assert from 'node:assert/strict';
import reference from './helix-word-reference.json';
import { TextFileDocument } from '../../packages/document/src/index';
import type { DocumentId, ViewId } from '../../packages/primitives/src/index';
import { createOwnedVimSession } from '../../packages/workbench/vim-session';

for (const fixture of reference.cases) {
  const document = TextFileDocument.create(fixture.name as DocumentId, fixture.text, Array.from(fixture.text.matchAll(/\n/g), () => 'lf' as const), 'lf');
  assert.ok(document.ok);
  const vim = createOwnedVimSession(document.value, { viewId: fixture.name as ViewId, motionGhost: true });
  const key = async (name: string) => { await vim.handleKey({ name, raw: name, shift: false, ctrl: false, meta: false, option: false }); };
  const prefix = fixture.text.slice(0, fixture.origin);
  const line = prefix.split('\n').length - 1;
  const column = prefix.length - prefix.lastIndexOf('\n') - 1;
  assert.ok(vim.setCursorPosition(line, column));
  if (fixture.count > 1) for (const digit of String(fixture.count)) await key(digit);
  await key(fixture.key);
  const ghost = vim.motionGhost;
  assert.ok(ghost, fixture.name);
  const extent = ghost.preview.members[0]!.extent;
  assert.equal(fixture.text.slice(extent.start, extent.end), fixture.selected, `${reference.version}: ${fixture.name}`);
  await key('v'); await key('d');
  const snapshot = document.value.snapshot();
  const text = snapshot.slice(0 as never, snapshot.lengthUtf16 as never);
  assert.ok(text.ok);
  assert.equal(text.value, fixture.text.slice(0, extent.start) + fixture.text.slice(extent.end), `${fixture.name}: adoption deletes precisely the Helix range`);
  await key('u');
  assert.equal(document.value.snapshot().lengthUtf16, fixture.text.length);
  vim.dispose();
}
console.log(`${reference.cases.length} ghost/adopt/delete/undo cases match captured ${reference.version} word selections`);
