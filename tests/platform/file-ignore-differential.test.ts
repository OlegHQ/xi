import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CancellationSource } from '../../packages/contracts/src/index';
import { NodeFilesystemPort } from '../../packages/platform/src/entrypoints/launch';
import { FilePathIndex } from '../../packages/services/navigation/index';

const run = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), 'xi-ignore-differential-'));
const root = join(temporary, 'repo');
await mkdir(root);
const filesystem = new NodeFilesystemPort();
const collect = async (directory: string, options: { parents: boolean; ignore: boolean; gitIgnore: boolean; gitGlobal: boolean; gitExclude: boolean }, maxVisitedEntries?: number): Promise<Set<string>> => {
  const paths = new Set<string>();
  const result = await filesystem.enumerateFiles(directory, new CancellationSource().token, entries => { for (const entry of entries) paths.add(entry.relativePath); }, { followSymlinks: false, ignore: options, ...(maxVisitedEntries === undefined ? {} : { maxVisitedEntries }) });
  assert.equal(result.ok, true, result.ok ? '' : result.error.message);
  return paths;
};
const enabled = { parents: true, ignore: true, gitIgnore: true, gitGlobal: false, gitExclude: true };
const put = async (path: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), path); };
try {
  await run('git', ['init', '-q', root]);
  await writeFile(join(root, '.gitignore'), [
    'named/', '**/*.log', '/anchored.txt', 'dir/file.txt', '[ab].tmp',
    'escaped\\ space.txt', '\\#hash.txt', 'blocked/', '!blocked/child.txt', 'conflict.txt',
  ].join('\n') + '\n');
  const candidates = ['named', 'sub/named/child.txt', 'top.log', 'sub/deep.log', 'anchored.txt', 'sub/anchored.txt', 'dir/file.txt', 'sub/dir/file.txt', 'a.tmp', 'c.tmp', 'escaped space.txt', '#hash.txt', 'blocked/child.txt', 'conflict.txt', 'plain.txt'];
  for (const path of candidates) await put(path);
  const actual = await collect(root, enabled);
  const openBufferPaths = candidates.filter((path) => path !== 'named');
  const visibleBuffers = await new NodeFilesystemPort().visibleWorkspacePaths(root, openBufferPaths, enabled, new CancellationSource().token);
  assert.equal(visibleBuffers.ok, true, 'F20-BUFFER-IGNORE-01 open buffers resolve against the same ignore rules');
  if (visibleBuffers.ok) for (const path of openBufferPaths) assert.equal(visibleBuffers.value.has(path), actual.has(path), `F20-BUFFER-IGNORE-02 ${path}`);
  for (const path of candidates) {
    const git = await run('git', ['-C', root, 'check-ignore', '--no-index', '-q', '--', path]).then(() => true, () => false);
    assert.equal(actual.has(path), !git, `F20-GIT-DIFF ${path}`);
  }
  await writeFile(join(root, '.ignore'), '!conflict.txt\n');
  assert.equal((await collect(root, enabled)).has('conflict.txt'), true, 'F20-IGNORE-PRIORITY .ignore whitelist overrides .gitignore');

  const linked = join(temporary, 'linked');
  const gitDirectory = join(temporary, 'git-meta', 'worktree');
  const commonDirectory = join(temporary, 'git-meta', 'common');
  await mkdir(join(linked, 'child'), { recursive: true });
  await mkdir(gitDirectory, { recursive: true });
  await mkdir(join(commonDirectory, 'info'), { recursive: true });
  await writeFile(join(linked, '.git'), `gitdir: ${gitDirectory}\n`);
  await writeFile(join(gitDirectory, 'commondir'), '../common\n');
  await writeFile(join(linked, '.gitignore'), 'parent.txt\n');
  await writeFile(join(commonDirectory, 'info', 'exclude'), 'excluded.txt\n');
  await writeFile(join(linked, 'child', 'parent.txt'), 'parent');
  await writeFile(join(linked, 'child', 'excluded.txt'), 'excluded');
  await writeFile(join(linked, 'child', 'visible.txt'), 'visible');
  for (const directory of [root, linked]) {
    const paths: string[] = [];
    const result = await filesystem.enumerateFiles(directory, new CancellationSource().token, entries => { for (const entry of entries) paths.push(entry.relativePath); }, { followSymlinks: false, ignoredDirectoryNames: ['.git'], ignore: enabled });
    assert.equal(result.ok, true);
    assert.equal(paths.some(path => path === '.git' || path.startsWith('.git/')), false, `F20-VCS-SKIP ${directory} skips .git directories and worktree files`);
    assert.equal(paths.length > 0, true);
  }
  const nested = await collect(join(linked, 'child'), enabled);
  assert.deepEqual([...nested].sort(), ['visible.txt'], 'F20-WORKTREE-ROOT parent ignore and linked git exclude apply below editor root');
  const nestedBuffers = await new NodeFilesystemPort().visibleWorkspacePaths(join(linked, 'child'), ['parent.txt', 'excluded.txt', 'visible.txt'], enabled, new CancellationSource().token);
  assert.equal(nestedBuffers.ok, true);
  if (nestedBuffers.ok) assert.deepEqual([...nestedBuffers.value], ['visible.txt'], 'F20-BUFFER-WORKTREE-01 linked gitdir and parent ignores also gate dirty buffers');

  const xdgConfigHome = join(temporary, 'xdg');
  await mkdir(join(xdgConfigHome, 'git'), { recursive: true });
  await writeFile(join(xdgConfigHome, 'git', 'ignore'), 'global.txt\n');
  await writeFile(join(linked, 'child', 'global.txt'), 'global');
  const globalOptions = { ...enabled, gitGlobal: true, xdgConfigHome };
  assert.equal((await collect(join(linked, 'child'), globalOptions)).has('global.txt'), false, 'F20-XDG-GLOBAL Git global ignore honors XDG_CONFIG_HOME without HOME');
  const globalBuffers = await filesystem.visibleWorkspacePaths(join(linked, 'child'), ['global.txt'], globalOptions, new CancellationSource().token);
  assert.equal(globalBuffers.ok, true);
  if (globalBuffers.ok) assert.deepEqual([...globalBuffers.value], [], 'F20-XDG-BUFFER dirty buffers honor XDG Git global ignore');

  const discovered: { readonly rootId: string; readonly relativePath: string; readonly absolutePath: string; readonly hidden: boolean; readonly ignored: boolean }[] = [];
  const allFiles = await filesystem.enumerateFiles(join(linked, 'child'), new CancellationSource().token, batch => {
    discovered.push(...batch.map(entry => ({ rootId: 'picker', ...entry, ignored: false })));
  }, { followSymlinks: false, ignore: { parents: false, ignore: false, gitIgnore: false, gitGlobal: false, gitExclude: false } });
  assert.equal(allFiles.ok, true, 'F20-IGNORED-INDEX-01 on-demand enumeration sees globally ignored paths');
  const visible = await filesystem.visibleWorkspacePaths(join(linked, 'child'), discovered.map(entry => entry.relativePath), globalOptions, new CancellationSource().token);
  assert.equal(visible.ok, true, 'F20-IGNORED-INDEX-02 ignored path classification uses the configured policy');
  if (visible.ok) {
    const ignored = discovered.filter(entry => !visible.value.has(entry.relativePath)).map(entry => ({ ...entry, ignored: true }));
    const index = new FilePathIndex({ maxEntries: 120_000 });
    assert.equal(index.addRoot({ id: 'picker', label: 'picker', path: join(linked, 'child') }).ok, true);
    assert.equal(index.addPaths('picker', ignored).ok, true, 'F20-IGNORED-INDEX-03 ignored paths can be added lazily');
    index.markReady();
    const hiddenByDefault = await index.queryAsync('global.txt', { includeIgnored: false });
    const revealed = await index.queryAsync('global.txt', { includeIgnored: true });
    assert.equal(hiddenByDefault.ok && hiddenByDefault.value.totalMatches, 0, 'F20-IGNORED-INDEX-04 ignored path stays hidden until toggled');
    assert.equal(revealed.ok && revealed.value.entries[0]?.relativePath, 'global.txt', 'F20-IGNORED-INDEX-05 ignored path becomes selectable');
    index.dispose();
  }

  const bounded = join(temporary, 'bounded');
  await mkdir(bounded);
  await mkdir(join(bounded, '.git'));
  await mkdir(join(bounded, 'blocked'));
  await writeFile(join(bounded, '.gitignore'), 'blocked/\n');
  await writeFile(join(bounded, 'visible.txt'), 'visible');
  for (let index = 0; index < 30; index += 1) await writeFile(join(bounded, 'blocked', `${index}.txt`), 'hidden');
  assert.deepEqual([...await collect(bounded, enabled, 12)].filter(path => path.endsWith('.txt')), ['visible.txt'], 'F23-IGNORE-TREE ignored directories do not consume an unbounded traversal budget');
  await writeFile(join(bounded, '.gitignore'), '');
  const capped = await filesystem.enumerateFiles(bounded, new CancellationSource().token, () => {}, { maxVisitedEntries: 12, ignore: enabled });
  assert.equal(capped.ok, false, 'F23-VISIT-LIMIT dense traversal reports a limit');
  if (!capped.ok) assert.equal(capped.error.code, 'enumeration-limit');
  const resultCapped = await filesystem.enumerateFiles(bounded, new CancellationSource().token, () => {}, { maxEntries: 1, ignore: enabled });
  assert.equal(resultCapped.ok, false, 'F23-RESULT-LIMIT reports a truncated file set');
  if (!resultCapped.ok) assert.equal(resultCapped.error.code, 'enumeration-limit');
  await writeFile(join(bounded, '.gitignore'), 'x'.repeat(1024 * 1024 + 1));
  const oversized = await filesystem.enumerateFiles(bounded, new CancellationSource().token, () => {}, { ignore: enabled });
  assert.equal(oversized.ok, false, 'F23-IGNORE-SIZE oversized ignore input reports an error');
  if (!oversized.ok) assert.equal(oversized.error.code, 'ignore-file-too-large');
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log('F20 ignore differential passed Git patterns, source precedence, nested root and linked worktree');
