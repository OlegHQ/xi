import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { ExplorerBufferController } from '../../packages/workbench/explorer/buffer';
import { compileDirectoryBuffers, parseDirectoryBufferLine } from '../../packages/services/files/directory-buffer';
import { escapeDirectoryName } from '../../packages/services/files/directory-draft';
import { runOracleFixture, verifyOracleBundle } from '../oracle/oracle-runner';
import type { OracleFixture } from '../oracle/types';

// Development reference only. Pin mini.files so upstream changes cannot silently change
// the editing contract; the source cache is ignored and never loaded by Xi at runtime.
const revision = '561751e839b99a4baca36b9d963166b66d2536a6';
const reference = resolve(`.artifacts/reference/mini.files/${revision}.lua`);
if (!await Bun.file(reference).exists()) {
  const downloaded = await fetch(`https://raw.githubusercontent.com/nvim-mini/mini.nvim/${revision}/lua/mini/files.lua`);
  if (!downloaded.ok) throw new Error(`mini.files reference download failed: ${downloaded.status}`);
  await Bun.write(reference, await downloaded.text());
}
assert.equal(createHash('sha256').update(new Uint8Array(await Bun.file(reference).arrayBuffer())).digest('hex'), '0edf3f26199bff95ecb151fd6305739b1dfdec423ce7aff0cf84febae2a44150', 'mini.files reference source matches the pinned revision');
const root = await mkdtemp(join(tmpdir(), 'xi-mini-files-reference-'));
const oracle = await verifyOracleBundle();
const editor = new ExplorerBufferController({
  root, encodeName: escapeDirectoryName, parseLine: parseDirectoryBufferLine, compile: (buffers, sources) => compileDirectoryBuffers(root, buffers, sources),
  list: async (path) => ({ ok: true, value: (await readdir(path, { withFileTypes: true })).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).map((entry) => ({ name: entry.name, path: `${path}/${entry.name}`, kind: entry.isDirectory() ? 'directory' : 'file' })) }),
  apply: async () => true, openFile: async () => {}, notify: () => {}, error: (message) => { throw new Error(message); }, marker: () => {},
});
const steps = [
  { label: 'ready', keys: '<F12>' },
  { label: 'select-file', keys: 'j' },
  { label: 'cancel-incomplete-delete', keys: 'd<Esc>' },
  { label: 'delete-next-row', keys: 'dd' },
  { label: 'undo-source', keys: 'u' },
  { label: 'redo-source', keys: '<C-r>' },
  { label: 'enter-target', keys: 'ggl' },
  { label: 'paste-deleted-entry', keys: 'p' },
  { label: 'undo-target', keys: 'u' },
  { label: 'redo-target', keys: '<C-r>' },
  { label: 'create-below', keys: 'onew.txt<Esc>' },
  { label: 'create-above', keys: 'Ofolder/<Esc>' },
  { label: 'insert-edit-name', keys: 'iprefix-<Esc>' },
  { label: 'return-source', keys: 'h' },
  { label: 'select-final-entry', keys: 'G' },
  { label: 'visual-final-entry', keys: 'V' },
  { label: 'visual-delete-eof', keys: 'x' },
  { label: 'undo-visual', keys: 'u' },
  { label: 'visual-d-final-entry', keys: 'Vd' },
  { label: 'undo-visual-d', keys: 'u' },
  { label: 'redo-visual', keys: '<C-r>' },
  { label: 'paste-visual-register', keys: 'p' },
  { label: 'counted-delete', keys: 'gg2dd' },
  { label: 'undo-counted-delete', keys: 'u' },
  { label: 'dot-after-delete', keys: 'ggdd.' },
  { label: 'undo-dot', keys: 'u' },
  { label: 'undo-first-delete', keys: 'u' },
];
try {
  await mkdir(`${root}/destination`);
  await writeFile(`${root}/a.txt`, 'alpha'); await writeFile(`${root}/b.txt`, 'beta');
  const fixture: OracleFixture = { id: 'FILES-MINI-EDITING', title: 'mini.files editable directory buffers', purpose: 'Compare actual mini.files native edits, cursor advancement, per-directory undo and register transfer.', modes: ['normal', 'insert', 'visual'], lines: ['editor remains unchanged'],
    mappings: [{ mode: 'n', lhs: '<F12>', rhs: `<Cmd>lua local f = dofile(${JSON.stringify(reference)}); f.setup({ content = { prefix = function() return '' end }, options = { permanent_delete = false } }); f.open(${JSON.stringify(root)})<CR>` }], steps };
  const expected = await runOracleFixture(fixture, oracle.binaryPath);
  const modes: Readonly<Record<string, string>> = { n: 'normal', i: 'insert', v: 'visual', V: 'visual', '\x16': 'visual' };
  await editor.open(root);
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    if (index > 0) {
      for (const token of step.keys.match(/<[^>]+>|./gu) ?? []) {
        await editor.handleKey({ name: token === '<Esc>' ? 'escape' : token === '<C-r>' ? 'r' : token, raw: token === '<Esc>' ? '\x1b' : token === '<C-r>' ? 'r' : token, shift: false, ctrl: token === '<C-r>', meta: false, option: false });
      }
    }
    const snapshot = expected.snapshots[index]!;
    const mode = modes[snapshot.mode];
    assert.equal(editor.model.mode, mode, `${step.label}: mode matches mini.files`);
    const names = snapshot.lines.map((line) => line.replace(/^\/\d+\/[^/]*\//u, ''));
    assert.deepEqual(editor.model.rows.map((row) => row.name), names, `${step.label}: Xi directory text equals pinned mini.files`);
    assert.equal(editor.model.selectedIndex + 1, snapshot.cursor.line, `${step.label}: cursor row matches mini.files`);
    const line = snapshot.lines[snapshot.cursor.line - 1] ?? '';
    const prefix = /^\/\d+\/[^/]*\//u.exec(line)?.[0].length ?? 0;
    const column = Math.max(0, snapshot.cursor.byteColumn - 1 - prefix);
    assert.equal(editor.model.cursorColumn, column, `${step.label}: concealed-name cursor column matches mini.files`);
  }
  console.log(`Files editing matched mini.files ${revision} on pinned Neovim: ${steps.length} text/cursor checkpoints`);
} finally { editor.dispose(); await rm(root, { recursive: true, force: true }); }
