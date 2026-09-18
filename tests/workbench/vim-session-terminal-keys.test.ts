/** Actual Core-decoded terminal arrows through Xi's session, compared with pinned Neovim. */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { StdinParser } from '@opentui/core/renderer';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { createOwnedVimSession } from '../../packages/workbench/vim-session/index';

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'terminal-key-fixture');
  assert(result.ok); return result.value;
}
const oracle = '.artifacts/oracle/nvim-linux-arm64/bin/nvim';
const manifest = JSON.parse(readFileSync('tests/oracle/manifest.json', 'utf8')) as { oracle: { binarySha256: string } };
assert.equal(createHash('sha256').update(readFileSync(oracle)).digest('hex'), manifest.oracle.binarySha256);
const fixtures = [
  { keys: '\x1b[B\x1b[B\x1b[A\x1b[C\x1b[D', vim: '<Down><Down><Up><Right><Left>' },
  { keys: 'v\x1b[B\x1b[C\x1b', vim: 'v<Down><Right><Esc>' },
  { keys: 'iX\x1b[B\x1b[CZ\x1b', vim: 'iX<Down><Right>Z<Esc>' },
  { keys: 'G', vim: 'G' }, // printable uppercase must retain its meaning
];
for (const fixture of fixtures) {
  const created = TextFileDocument.create(id<DocumentId>('doc'), 'aaa\nbbb\nccc', ['lf', 'lf'], 'lf');
  assert(created.ok);
  const doc = created.value;
  let cursor = 0;
  let mode = 'normal';
  const session = createOwnedVimSession(doc, {
    viewId: id<ViewId>('view'),
    onStateChange: state => { cursor = Number(state.selections.members[0]!.head.at.offset); mode = state.mode; },
  });
  const parser = new StdinParser({ armTimeouts: false });
  parser.push(new TextEncoder().encode(fixture.keys));
  parser.flushTimeout(Number.MAX_SAFE_INTEGER);
  for (let event = parser.read(); event !== null; event = parser.read()) {
    assert.equal(event.type, 'key');
    if (event.type === 'key') await session.handleKey({ ...event.key, raw: event.raw });
  }
  const snapshot = doc.snapshot();
  const text = snapshot.slice(0 as Parameters<typeof snapshot.slice>[0], snapshot.lengthUtf16 as Parameters<typeof snapshot.slice>[1]);
  assert(text.ok);
  const lua = `vim.api.nvim_buf_set_lines(0,0,-1,false,{'aaa','bbb','ccc'}); vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes(${JSON.stringify(fixture.vim)},true,false,true),'xt',false); local c=vim.api.nvim_win_get_cursor(0); local lines=vim.api.nvim_buf_get_lines(0,0,-1,false); local offset=c[2]; for i=1,c[1]-1 do offset=offset+#lines[i]+1 end; io.write(vim.json.encode({text=table.concat(lines,'\\n'),cursor=offset,mode=vim.api.nvim_get_mode().mode}))`;
  const result = Bun.spawnSync([oracle, '--headless', '--clean', '-i', 'NONE', '-c', `lua ${lua}`, '-c', 'qa!']);
  assert.equal(result.exitCode, 0, result.stderr.toString());
  const expected: unknown = JSON.parse(result.stdout.toString());
  assert.deepEqual({ text: text.value, cursor, mode: mode === 'normal' ? 'n' : mode }, expected, fixture.vim);
  parser.destroy(); session.dispose();
}
console.log('Terminal-key parity passed: real Core decoding, Normal/Visual/Insert arrows and uppercase input');
