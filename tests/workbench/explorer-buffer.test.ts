import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExplorerBufferController } from '../../packages/workbench/explorer/buffer';
import type { OwnedVimKeyEvent } from '../../packages/workbench/vim-session';
import { compileDirectoryBuffers, parseDirectoryBufferLine } from '../../packages/services/files/directory-buffer';
import { escapeDirectoryName } from '../../packages/services/files/directory-draft';
import { JournaledFilesystemOperations } from '../../packages/services/files/journaled-operations';
import { NodeFilesystemPort } from '../../packages/platform/src/filesystem';
import { CancellationSource } from '../../packages/contracts/src/index';

const root = await mkdtemp(join(tmpdir(), 'xi-files-buffer-'));
const cancellation = new CancellationSource();
const filesystem = new NodeFilesystemPort();
const operations = new JournaledFilesystemOperations(filesystem, { trashRoot: `${root}/.xi-trash` });
const errors: string[] = [];
const editor = new ExplorerBufferController({
  root, encodeName: escapeDirectoryName, parseLine: parseDirectoryBufferLine,
  compile: (buffers, sources) => compileDirectoryBuffers(root, buffers, sources),
  list: async (path) => ({ ok: true, value: (await readdir(path, { withFileTypes: true })).filter((entry) => !entry.name.startsWith('.xi')).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).map((entry) => ({ name: entry.name, path: `${path}/${entry.name}`, kind: entry.isDirectory() ? 'directory' : 'file' })) }),
  apply: async (plan) => { const applied = await operations.apply(plan, cancellation.token); if (!applied.ok) errors.push(JSON.stringify(applied.error)); return applied.ok; },
  openFile: async () => {}, notify: () => {}, error: (message) => errors.push(message), marker: () => {},
});
async function keys(source: string): Promise<void> {
  for (const raw of source) {
    const event: OwnedVimKeyEvent = { name: raw === '\x1b' ? 'escape' : raw === '\x12' ? 'r' : raw.toLowerCase(), raw: raw === '\x12' ? 'r' : raw, ctrl: raw === '\x12', shift: raw !== raw.toLowerCase(), meta: false, option: false };
    await editor.handleKey(event);
  }
}
const names = (): readonly string[] => editor.model.rows.map((row) => row.name);
try {
  await mkdir(`${root}/destination`);
  await writeFile(`${root}/a.txt`, 'alpha'); await writeFile(`${root}/b.txt`, 'beta'); await writeFile(`${root}/c.txt`, 'gamma');
  await editor.open(root, `${root}/a.txt`);
  await keys('d'); assert.deepEqual(names(), ['destination', 'a.txt', 'b.txt', 'c.txt'], 'incomplete d does not delete');
  await keys('d'); assert.deepEqual(names(), ['destination', 'b.txt', 'c.txt'], 'dd edits only the directory document');
  assert.equal(editor.model.rows[editor.model.selectedIndex]?.name, 'b.txt', 'delete selects the following entry');
  assert.equal(await readFile(`${root}/a.txt`, 'utf8'), 'alpha', 'draft delete leaves disk intact');
  await keys('u'); assert.ok(names().includes('a.txt'), 'u restores the directory row');
  await keys('dd'); editor.selectRow(0); await keys('l'); await keys('p');
  assert.ok(names().includes('a.txt'), 'deleted entry register pastes into another directory');
  await keys('u'); assert.ok(!names().includes('a.txt'), 'destination undo owns its own history');
  await keys('\x12=');
  assert.ok(editor.model.reviewLines?.some((line) => line.includes('/destination/a.txt')), JSON.stringify({model:editor.model,errors}));
  await keys('y');
  assert.equal(errors.length, 0, 'move apply succeeds');
  assert.equal(await readFile(`${root}/destination/a.txt`, 'utf8'), 'alpha', 'synchronize moves original file with exact content');
  assert.ok(!(await readdir(root)).includes('a.txt'), 'move removes the original path');
  await keys('onew.txt\x1b');
  await keys('Onested/deep/file.txt\x1b');
  await keys('ofolder/\x1b');
  assert.ok(names().includes('new.txt') && names().includes('folder/'), 'o/O add editable entry rows');
  await keys('='); assert.ok(editor.model.reviewLines?.some((line) => line.includes('new.txt')), 'review names every affected path');
  await keys('\x1b'); assert.ok(names().includes('new.txt'), 'review cancellation preserves draft without touching disk');
  assert.ok(!(await readdir(`${root}/destination`)).includes('new.txt'), 'cancel is a filesystem no-op');
  await keys('=y');
  assert.equal(await readFile(`${root}/destination/new.txt`, 'utf8'), '', 'new file is created');
  assert.equal(await readFile(`${root}/destination/nested/deep/file.txt`, 'utf8'), '', 'nested file parents are created');
  assert.ok((await readdir(`${root}/destination`, { withFileTypes: true })).some((entry) => entry.name === 'folder' && entry.isDirectory()), 'trailing slash creates directory');
  await editor.open(root, `${root}/b.txt`); await keys('Vjx');
  assert.deepEqual(names(), ['destination'], 'Visual line x removes both selected entry rows');
  await keys('u'); assert.ok(names().includes('b.txt') && names().includes('c.txt'), 'one u restores the Visual edit');
  await keys('"ayy'); await editor.open(`${root}/destination`); await keys('"ap');
  assert.ok(names().includes('b.txt'), 'named registers cross directory sessions');
  await keys('=y'); assert.equal(await readFile(`${root}/destination/b.txt`, 'utf8'), 'beta', 'yy/p copies rather than moves');
  assert.equal(await readFile(`${root}/b.txt`, 'utf8'), 'beta', 'copy preserves original');
  await editor.open(root, `${root}/b.txt`); await keys('irename-\x1b=y');
  assert.equal(await readFile(`${root}/rename-b.txt`, 'utf8'), 'beta', 'i edits the existing name through Vim');
  assert.equal(errors.length, 0, 'all edits apply without engine or filesystem errors');
  await keys('o../outside.txt\x1b=');
  assert.ok(errors.pop()?.includes('invalid entry name'), 'directory traversal is rejected before review');
  assert.equal(editor.model.reviewLines, undefined);
  await keys('u'); await keys('onew-review.txt\x1b=');
  const reviewed = names(); editor.handlePaste(new TextEncoder().encode('unreviewed.txt'));
  assert.deepEqual(names(), reviewed, 'paste cannot change a plan while confirmation is open');
  await keys('\x1b');
  assert.equal(await editor.handleKey({ name: 'escape', raw: '\x1b', ctrl: false, shift: false, meta: false, option: false }), 'close', 'normal Escape returns focus even with a draft');
  assert.ok(names().includes('new-review.txt'), 'returning focus preserves the directory draft');
  console.log('Files buffers passed: incomplete d, dd/register/p, per-directory undo/redo, next cursor, i/o/O, nested creates, Visual x, named yy/p and reviewed apply');
} finally { editor.dispose(); operations.dispose(); cancellation.dispose(); await rm(root, { recursive: true, force: true }); }
