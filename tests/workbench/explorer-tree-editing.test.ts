import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExplorerBufferController } from '../../packages/workbench/explorer/buffer';
import { ExplorerTree } from '../../packages/services/files/index';
import { compileDirectoryBuffers, parseDirectoryBufferLine } from '../../packages/services/files/directory-buffer';
import { escapeDirectoryName } from '../../packages/services/files/directory-draft';
import { createDirectoryExplorerRead } from '../../packages/ui/explorer/buffer';

const root = await mkdtemp(join(tmpdir(), 'xi-tree-editing-'));
const list = async (path: string) => (await readdir(path, { withFileTypes: true })).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).map((entry) => ({ name: entry.name, path: `${path}/${entry.name}`, kind: entry.isDirectory() ? 'directory' as const : 'file' as const }));
const tree = new ExplorerTree({ enumerateDirectory: async (path) => ({ ok: true, value: (await list(path)).map((entry) => ({ ...entry, relativePath: entry.path.slice(root.length + 1), hidden: entry.name.startsWith('.') })) }), watchDirectory: async () => ({ ok: true, value: { dispose() {} } }) }, { flattenDirs: false });
const errors: string[] = [];
const editor = new ExplorerBufferController({ root, list: async (path) => ({ ok: true, value: await list(path) }), encodeName: escapeDirectoryName, parseLine: parseDirectoryBufferLine, compile: (buffers, sources) => compileDirectoryBuffers(root, buffers, sources), apply: async () => true, openFile: async () => {}, notify: () => {}, marker: () => {}, error: (message) => errors.push(message) });
const ui = createDirectoryExplorerRead(editor, tree);
async function keys(source: string): Promise<void> { for (const raw of source) await editor.handleKey({ name: raw === '\x1b' ? 'escape' : raw.toLowerCase(), raw, ctrl: false, shift: false, meta: false, option: false }); }
const rows = () => editor.treeRows!;
const pick = (path: string) => { const row = rows().find((value) => value.path === path); assert.ok(row, `visible tree path ${path}`); return row; };
try {
  await mkdir(`${root}/apps`); await mkdir(`${root}/bench/document`, { recursive: true }); await mkdir(`${root}/bench/core`);
  await mkdir(`${root}/chain/deep`, { recursive: true }); await writeFile(`${root}/chain/deep/file.txt`, 'chain');
  await writeFile(`${root}/seed.txt`, 'seed'); await writeFile(`${root}/.secret`, 'hidden');
  await writeFile(`${root}/bench/manifest.json`, '{}');
  await writeFile(`${root}/bench/document/alpha.ts`, 'alpha'); await writeFile(`${root}/bench/document/beta.ts`, 'beta');
  const added = tree.addRoot({ id: 'workspace', path: root, label: root }); assert.ok(added.ok);
  await tree.expand(added.value);
  const bench = tree.model.nodes.find((node) => node.path === `${root}/bench`)!; await tree.expand(bench.id);
  const document = tree.model.nodes.find((node) => node.path === `${root}/bench/document`)!; await tree.expand(document.id);
  editor.attachTree(tree, async (id) => { await tree.toggleExpanded(id); });
  await editor.open(`${root}/bench/document`, `${root}/bench/document/alpha.ts`);
  assert.deepEqual(ui.model.visibleRows.map((row) => row.depth), tree.model.visibleRows.map((row) => row.depth).concat(0), 'directory editing keeps the existing tree indentation');
  assert.ok(rows().some((row) => row.path === `${root}/apps`) && rows().some((row) => row.path === `${root}/bench/core`), 'other branches remain visible');
  assert.ok(!rows().some((row) => row.name === '.secret'), 'hidden file policy stays in the tree');
  assert.equal(pick(`${root}/bench/document/alpha.ts`).depth, 3);
  await editor.selectTreeRow(pick(`${root}/bench/document`).id, true);
  assert.ok(!rows().some((row) => row.name === 'alpha.ts'), 'mouse activation collapses folder in place');
  await editor.selectTreeRow(pick(`${root}/bench/document`).id, true);
  assert.ok(rows().some((row) => row.name === 'alpha.ts'), 'mouse activation expands folder in place');
  await keys('<'); assert.ok(!rows().some((row) => row.name === 'alpha.ts'));
  await keys('>'); assert.ok(rows().some((row) => row.name === 'alpha.ts'), '> / < expand and collapse without changing the tree root');
  await keys('V<'); assert.ok(!rows().some((row) => row.name === 'alpha.ts'), 'Visual < collapses selected folders');
  await keys('>\x1b'); assert.ok(rows().some((row) => row.name === 'alpha.ts'), 'Visual > expands selected folders');
  await keys('j'); assert.equal(rows().find((row) => row.selected)?.name, 'alpha.ts', 'j crosses into expanded child rows');
  await keys('dd'); assert.equal(rows().find((row) => row.selected)?.name, 'beta.ts', 'inline delete selects next sibling');
  assert.ok(!rows().some((row) => row.name === 'alpha.ts')); await keys('u'); assert.ok(rows().some((row) => row.name === 'alpha.ts'));
  await keys('irename-\x1b'); assert.ok(rows().some((row) => row.name === 'rename-alpha.ts' && row.depth === 3), 'i renames inline at the same tree depth');
  await keys('uVjx'); assert.ok(!rows().some((row) => row.name === 'alpha.ts' || row.name === 'beta.ts')); await keys('u');
  await keys('"ayy'); await editor.selectTreeRow(pick(`${root}/apps`).id); await keys('"ap');
  assert.ok(rows().some((row) => row.name === 'alpha.ts' && row.bufferPath === `${root}/apps`), 'named registers paste into a selected tree folder');
  await keys('onew.txt\x1bOfolder/\x1b');
  assert.ok(rows().some((row) => row.name === 'new.txt' && row.depth === 2) && rows().some((row) => row.name === 'folder/' && row.depth === 2), 'o / O create inline siblings under the same folder');
  assert.ok(rows().some((row) => row.path === `${root}/bench/manifest.json`), 'Vim edits preserve expanded sibling branches');
  await keys('='); assert.ok(editor.model.reviewLines?.some((line) => line.includes('/apps/new.txt')));
  assert.ok(ui.model.nodes.some((node) => node.path === `${root}/bench/core`), 'review does not replace the tree with a directory list');
  assert.equal(errors.length, 0);
  await keys('\x1b');
  const compressed = new ExplorerTree({ enumerateDirectory: async (path) => ({ ok: true, value: (await list(path)).map((entry) => ({ ...entry, relativePath: entry.path.slice(root.length + 1), hidden: entry.name.startsWith('.') })) }), watchDirectory: async () => ({ ok: true, value: { dispose() {} } }) });
  try {
    const added = compressed.addRoot({ id: 'compressed', path: root, label: root }); assert.ok(added.ok); await compressed.expand(added.value);
    await compressed.expand(compressed.model.nodes.find((node) => node.path === `${root}/chain`)!.id);
    editor.attachTree(compressed, async (id) => { await compressed.toggleExpanded(id); }); await editor.open(root);
    assert.ok(rows().some((row) => row.name === 'chain/deep'), 'the original compact folder chain survives Vim activation');
    await editor.selectTreeRow(pick(`${root}/chain/deep`).id, true);
    assert.ok(rows().some((row) => row.name === 'file.txt' && row.depth === 2));
  } finally { compressed.dispose(); }
  console.log('Tree + Vim passed hierarchy/depth, hidden policy, mouse toggles, >/<, cross-folder j, dd/u, inline i/o/O, Visual x, named register folder paste and review');
} finally { editor.dispose(); tree.dispose(); await rm(root, { recursive: true, force: true }); }
