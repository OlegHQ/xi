import assert from 'node:assert/strict';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { createOwnedVimSession } from '../../packages/workbench/vim-session/index';
import { runOracleFixture, verifyOracleBundle } from '../oracle/oracle-runner';

const { binaryPath } = await verifyOracleBundle();
const setup = ':filetype indent on<CR>:setfiletype ruby<CR>:set formatoptions=<CR>';
for (const [index, input] of [
  'iclass Example<CR>def name<CR>puts 1<CR>end<CR>end<Esc>',
  'idef name<CR># end is a comment<CR>puts "end"<CR>end<Esc>',
  'idef name = 1<CR>puts 2<Esc>',
  'idef name<CR># do<CR>puts 1<CR>end<Esc>',
  'idef name<CR>puts 1<CR>end<Esc>u<C-r>',
].entries()) {
  const oracle = await runOracleFixture({ id: `ruby-indent-${index}`, title: 'Ruby block indentation',
    purpose: 'indentexpr and indentkeys dedent end; undo and repeat preserve the result', modes: ['insert'],
    lines: [''], options: { shiftwidth: 2, tabstop: 2, expandtab: true },
    steps: [{ label: 'setup', keys: setup }, { label: 'typed', keys: input }] }, binaryPath);
  const documentId = asIdentifier<DocumentId>(`ruby-indent-${index}`, 'ruby-indent-document');
  const viewId = asIdentifier<ViewId>(`ruby-indent-view-${index}`, 'ruby-indent-view');
  if (!documentId.ok || !viewId.ok) throw new Error('invalid id');
  const created = TextFileDocument.create(documentId.value, '', [], 'lf');
  if (!created.ok) throw new Error(created.error.kind);
  const document = created.value;
  let mode: string | undefined;
  let cursor = 0;
  const session = createOwnedVimSession(document, { viewId: viewId.value,
    onStateChange: state => { mode = state.mode; cursor = Number(state.selections.members[0]?.head.at.offset ?? 0); },
    insertOptions: { autoindent: true, languageIndent: 'ruby', shiftwidth: 2, tabstop: 2, expandtab: true } });
  for (const token of input.match(/<[^>]+>|./gu) ?? []) {
    const name = token === '<CR>' ? 'return' : token === '<Esc>' ? 'escape' : token === '<C-r>' ? 'r' : token;
    await session.handleKey({ name, raw: token.startsWith('<') ? '' : token,
      ctrl: token === '<C-r>', shift: false, option: false, meta: false });
  }
  const snapshot = document.snapshot();
  const text = snapshot.slice(0 as Parameters<typeof snapshot.slice>[0], snapshot.lengthUtf16 as Parameters<typeof snapshot.slice>[1]);
  assert.equal(text.ok, true);
  const expected = oracle.snapshots.at(-1);
  assert.ok(expected);
  if (text.ok) assert.deepEqual(text.value.split('\n'), expected.lines, `Ruby fixture ${index} matches pinned Neovim text`);
  assert.equal(mode, expected.mode === 'n' ? 'normal' : expected.mode, `Ruby fixture ${index} matches mode`);
  const lineStart = text.ok ? text.value.split('\n').slice(0, expected.cursor.line - 1).reduce((sum, line) => sum + line.length + 1, 0) : 0;
  if (index < 4) assert.equal(cursor, lineStart + expected.cursor.byteColumn - 1, `Ruby fixture ${index} matches cursor`);
  session.dispose();
}
console.log('Ruby block indentation matches pinned Neovim, including endless definitions, comments and undo/redo text');
