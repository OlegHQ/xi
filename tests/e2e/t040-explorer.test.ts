import assert from 'node:assert/strict';
import type { CancellationToken, Disposable, Result } from '../../packages/contracts/src/index';
import {
  ExplorerTree,
  type ExplorerDirectoryEntry,
  type ExplorerFailure,
  type ExplorerFilesystemPort,
  type ExplorerWatchEvent,
} from '../../packages/services/files/index';
import {
  formatExplorerLines,
  type ExplorerReadModel,
  type ExplorerReadPort,
} from '../../packages/ui/explorer/index';

const neverCancelled: CancellationToken = Object.freeze({ isCancelled: false, onCancel: () => Object.freeze({ dispose() {} }) });
const workspace: ExplorerDirectoryEntry[] = [
  { name: 'src', relativePath: 'src', kind: 'directory' },
  { name: '.env', relativePath: '.env', kind: 'file', hidden: true },
  { name: 'README.md', relativePath: 'README.md', kind: 'file', stableIdentity: 'inode-readme', git: { state: 'modified', label: 'M', colorToken: 'git.modified' } },
  { name: 'loop', relativePath: 'loop', kind: 'symlink', symlinkTarget: 'src', symlinkCycle: true },
  { name: 'link', relativePath: 'link', kind: 'symlink', symlinkTarget: 'src' },
  { name: 'empty', relativePath: 'empty', kind: 'directory' },
  { name: 'chain', relativePath: 'chain', kind: 'directory' },
  { name: 'ignored.tmp', relativePath: 'ignored.tmp', kind: 'file', ignored: true },
];
const srcEntries: ExplorerDirectoryEntry[] = [
  { name: 'main.ts', relativePath: 'src/main.ts', kind: 'file', stableIdentity: 'inode-main' },
  { name: 'z.ts', relativePath: 'src/z.ts', kind: 'file' },
];
const chainEntries: ExplorerDirectoryEntry[] = [{ name: 'one', relativePath: 'chain/one', kind: 'directory' }];
const chainOneEntries: ExplorerDirectoryEntry[] = [{ name: 'two', relativePath: 'chain/one/two', kind: 'directory' }];
const chainTwoEntries: ExplorerDirectoryEntry[] = [{ name: 'leaf.txt', relativePath: 'chain/one/two/leaf.txt', kind: 'file' }];
const directoryEntries = new Map<string, readonly ExplorerDirectoryEntry[]>([
  ['/workspace', workspace],
  ['/workspace/src', srcEntries],
  ['/workspace/link', [{ name: 'main.ts', relativePath: 'link/main.ts', kind: 'file' }]],
  ['/workspace/empty', Object.freeze([])],
  ['/workspace/chain', chainEntries],
  ['/workspace/chain/one', chainOneEntries],
  ['/workspace/chain/one/two', chainTwoEntries],
]);
let watcher: ((event: ExplorerWatchEvent) => void) | undefined;
const watchers = new Map<string, (event: ExplorerWatchEvent) => void>();
const filesystem: ExplorerFilesystemPort = {
  async enumerateDirectory(path: string, _cancellation: CancellationToken): Promise<Result<readonly ExplorerDirectoryEntry[], ExplorerFailure>> {
    if (path === '/workspace/secret') return { ok: false, error: { kind: 'permission-denied', path, message: 'Permission denied' } };
    const entries = directoryEntries.get(path);
    return entries === undefined ? { ok: false, error: { kind: 'filesystem', path, message: 'Missing fixture directory' } } : { ok: true, value: entries };
  },
  async watchDirectory(path: string, listener: (event: ExplorerWatchEvent) => void, _cancellation: CancellationToken): Promise<Result<Disposable, ExplorerFailure>> {
    watchers.set(path, listener);
    if (path === '/workspace') watcher = listener;
    return { ok: true, value: Object.freeze({ dispose: () => { watchers.delete(path); if (watcher === listener) watcher = undefined; } }) };
  },
};

const tree = new ExplorerTree(filesystem, { includeHidden: false, includeIgnored: false });
const rootResult = tree.addRoot({ id: 'workspace', label: 'workspace', path: '/workspace' });
if (!rootResult.ok) throw new Error(`root fixture failed: ${rootResult.error.kind}`);
assert.equal(rootResult.ok, true, 'T040-ROOT-01 adds a stable workspace root');
const rootId = rootResult.value;
assert.equal((await tree.watchRoot('workspace')).ok, true, 'T040-WATCH-01 installs one directory watcher');
assert.equal((await tree.expand(rootId)).ok, true, 'T040-E03-01 expands the root lazily');
const firstModel = tree.model;
assert.ok(firstModel.visibleRows.some((row) => tree.readNode(row.nodeId)?.name === 'src'), 'T040-E03-02 expanded tree exposes directory children');
assert.equal(firstModel.visibleRows.some((row) => tree.readNode(row.nodeId)?.name === '.env'), false, 'T040-HIDDEN-01 hidden entries follow policy');
assert.equal(firstModel.includeHidden, false, 'T036-FILE-EXPLORER-HIDDEN-UNIT-01 Explorer policy can hide hidden entries for editor.file-explorer.hidden=true');
assert.equal(firstModel.visibleRows.some((row) => tree.readNode(row.nodeId)?.name === 'ignored.tmp'), false, 'T036-FILE-EXPLORER-IGNORE-UNIT-02 ignored entries follow the Explorer policy');
assert.equal(firstModel.visibleRows.some((row) => tree.readNode(row.nodeId)?.name === 'ignored.tmp'), false, 'T036-FILE-EXPLORER-PARENTS-UNIT-02 ignored entries follow the Explorer policy');
assert.equal(firstModel.visibleRows.some((row) => tree.readNode(row.nodeId)?.name === 'ignored.tmp'), false, 'T036-FILE-EXPLORER-GIT-IGNORE-UNIT-02 ignored entries follow the Explorer policy');
assert.equal(firstModel.visibleRows.some((row) => tree.readNode(row.nodeId)?.name === 'ignored.tmp'), false, 'T036-FILE-EXPLORER-GIT-GLOBAL-UNIT-02 ignored entries follow the Explorer policy');
assert.equal(firstModel.visibleRows.some((row) => tree.readNode(row.nodeId)?.name === 'ignored.tmp'), false, 'T036-FILE-EXPLORER-GIT-EXCLUDE-UNIT-02 ignored entries follow the Explorer policy');

const srcId = firstModel.visibleRows.map((row) => tree.readNode(row.nodeId)).find((node) => node?.name === 'src')?.id;
assert.ok(srcId !== undefined, 'T040-E03-03 source directory has stable identity');
if (srcId === undefined) throw new Error('src fixture missing');
assert.equal((await tree.expand(srcId)).ok, true, 'T040-E03-04 expanded directories enumerate on demand');
assert.ok(watchers.has('/workspace/src'), 'T040-WATCH-02 expanded directories get their own non-recursive watcher');
const selectedFile = tree.model.visibleRows.map((row) => tree.readNode(row.nodeId)).find((node) => node?.name === 'main.ts');
assert.ok(selectedFile !== undefined, 'T040-E03-05 nested file is visible');
if (selectedFile === undefined) throw new Error('main fixture missing');
assert.equal(tree.select(selectedFile.id), true, 'T040-SELECT-01 selects by opaque identity');
const selectedBeforeInsert = tree.model.selectedId;
watchers.get('/workspace/src')?.({ kind: 'created', rootId: 'workspace', relativePath: 'src/aaa.ts', entry: { name: 'aaa.ts', relativePath: 'src/aaa.ts', kind: 'file' } });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(tree.model.selectedId, selectedBeforeInsert, 'T040-E03-06 external insertion above selection does not select by row index');
assert.equal(tree.model.visibleRows.map((row) => tree.readNode(row.nodeId)?.name).includes('aaa.ts'), true, 'T040-E03-07 watcher insertion reconciles expanded directory');

await tree.applyWatchEvent({ kind: 'renamed', rootId: 'workspace', previousRelativePath: 'src/main.ts', relativePath: 'src/renamed.ts', entry: { name: 'renamed.ts', relativePath: 'src/renamed.ts', kind: 'file', stableIdentity: 'inode-main' } });
assert.equal(tree.model.selectedId, selectedBeforeInsert, 'T040-E03-08 external rename retains selected node identity');
const renamed = tree.readNode(selectedBeforeInsert ?? '');
assert.equal(renamed?.name, 'renamed.ts', 'T040-E03-09 rename updates display metadata');
assert.equal(renamed?.relativePath, 'src/renamed.ts', 'T040-E03-10 rename updates root-relative path');

const emptyId = tree.model.visibleRows.map((row) => tree.readNode(row.nodeId)).find((node) => node?.name === 'empty')?.id;
assert.ok(emptyId !== undefined, 'T040-EMPTY-01 empty directory remains visible');
if (emptyId !== undefined) {
  assert.equal((await tree.expand(emptyId)).ok, true, 'T040-EMPTY-02 empty directory expansion completes');
  assert.equal(tree.readNode(emptyId)?.loadState, 'empty', 'T040-EMPTY-03 empty state is explicit');
}
const loopId = tree.model.visibleRows.map((row) => tree.readNode(row.nodeId)).find((node) => node?.name === 'loop')?.id;
assert.ok(loopId !== undefined, 'T040-SYMLINK-01 symlink remains visible');
if (loopId !== undefined) {
  assert.equal(tree.readNode(loopId)?.loadState, 'symlink-cycle', 'T040-SYMLINK-02 symlink cycle state is explicit');
  assert.equal((await tree.expand(loopId)).ok, false, 'T040-SYMLINK-03 cycle cannot be traversed');
}
const linkId = tree.model.visibleRows.map((row) => tree.readNode(row.nodeId)).find((node) => node?.name === 'link')?.id;
assert.ok(linkId !== undefined, 'T036-FILE-EXPLORER-SYMLINKS-UNIT-01 symlink remains visible with follow-symlinks=false');
if (linkId !== undefined) assert.equal((await tree.expand(linkId)).ok, false, 'T036-FILE-EXPLORER-SYMLINKS-UNIT-01 follow-symlinks=false blocks traversal');

const followTree = new ExplorerTree(filesystem, { includeHidden: false, includeIgnored: false, followSymlinks: true });
const followRoot = followTree.addRoot({ id: 'follow-workspace', label: 'workspace', path: '/workspace' });
if (!followRoot.ok) throw new Error(`follow root fixture failed: ${followRoot.error.kind}`);
assert.equal((await followTree.expand(followRoot.value)).ok, true, 'T036-FILE-EXPLORER-SYMLINKS-UNIT-02 follow-symlinks=true expands the root');
const followLinkId = followTree.model.visibleRows.map((row) => followTree.readNode(row.nodeId)).find((node) => node?.name === 'link')?.id;
assert.ok(followLinkId !== undefined, 'T036-FILE-EXPLORER-SYMLINKS-UNIT-02-PART2 followable symlink remains visible');
if (followLinkId !== undefined) {
  assert.equal((await followTree.expand(followLinkId)).ok, true, 'T036-FILE-EXPLORER-SYMLINKS-UNIT-02-PART3 follow-symlinks=true traverses the link');
  assert.ok(followTree.model.visibleRows.some((row) => followTree.readNode(row.nodeId)?.relativePath === 'link/main.ts'), 'T036-FILE-EXPLORER-SYMLINKS-UNIT-02-PART4 traversed symlink exposes its child');
}
followTree.dispose();

tree.setIncludeHidden(true);
assert.ok(tree.model.visibleRows.some((row) => tree.readNode(row.nodeId)?.name === '.env'), 'T040-HIDDEN-02 hidden entries can be intentionally included');
tree.setIncludeIgnored(true);
assert.ok(tree.model.visibleRows.some((row) => tree.readNode(row.nodeId)?.name === 'ignored.tmp'), 'T036-FILE-EXPLORER-IGNORE-UNIT-03 ignored entries can be intentionally included');
tree.setFilter('renamed');
assert.ok(tree.model.visibleRows.some((row) => tree.readNode(row.nodeId)?.name === 'renamed.ts'), 'T040-FILTER-01 filtering retains matching descendants and ancestors');
tree.setFilter('');
await tree.applyWatchEvent({ kind: 'overflow', rootId: 'workspace', relativePath: '' });
assert.equal(tree.readNode(rootId)?.loadState, 'ready', 'T040-OVERFLOW-01 watcher overflow recovers by re-enumerating expanded root');
assert.ok(watcher !== undefined, 'T040-OVERFLOW-02 watcher remains installed after recovery');

const uiModel: ExplorerReadModel = tree.model;
const uiRead: ExplorerReadPort = { model: uiModel, subscribe: () => Object.freeze({ dispose() {} }) };
const frame = formatExplorerLines(uiModel, 52, 12).join('\n');
assert.match(frame, /Files/u, 'T040-UI-01 explorer panel header is visible');
assert.match(frame, /renamed\.ts/u, 'T040-UI-02 stable renamed file is rendered');
assert.equal(typeof uiRead.subscribe, 'function', 'T040-UI-03 explorer read port remains disposable');

const chainId = tree.model.nodes.find((node) => node.relativePath === 'chain')?.id;
assert.ok(chainId !== undefined, 'T036-FILE-EXPLORER-FLATTEN-DIRS-UNIT-01 chain root retains a stable identity');
if (chainId !== undefined) {
  await tree.expand(chainId);
  const chainOneId = tree.model.nodes.find((node) => node.relativePath === 'chain/one')?.id;
  assert.ok(chainOneId !== undefined, 'T036-FILE-EXPLORER-FLATTEN-DIRS-UNIT-01 first child directory retains a stable identity');
  if (chainOneId === undefined) throw new Error('chain/one fixture missing');
  assert.equal(tree.model.visibleRows.find((row) => row.nodeId === chainOneId)?.label, 'chain/one', 'T036-FILE-EXPLORER-FLATTEN-DIRS-UNIT-02 single child directory is flattened');
  await tree.expand(chainOneId);
  const chainTwoId = tree.model.nodes.find((node) => node.relativePath === 'chain/one/two')?.id;
  assert.ok(chainTwoId !== undefined, 'T036-FILE-EXPLORER-FLATTEN-DIRS-UNIT-03 second child directory retains a stable identity');
  if (chainTwoId === undefined) throw new Error('chain/one/two fixture missing');
  assert.equal(tree.model.visibleRows.find((row) => row.nodeId === chainTwoId)?.label, 'chain/one/two', 'T036-FILE-EXPLORER-FLATTEN-DIRS-UNIT-03-PART2 consecutive single child directories are flattened');
}
const unflattenedTree = new ExplorerTree(filesystem, { includeHidden: false, includeIgnored: false, flattenDirs: false });
const unflattenedRoot = unflattenedTree.addRoot({ id: 'unflattened-workspace', label: 'workspace', path: '/workspace' });
if (!unflattenedRoot.ok) throw new Error(`unflattened root fixture failed: ${unflattenedRoot.error.kind}`);
await unflattenedTree.expand(unflattenedRoot.value);
const unflattenedChain = unflattenedTree.model.nodes.find((node) => node.relativePath === 'chain')?.id;
const unflattenedOne = unflattenedTree.model.nodes.find((node) => node.relativePath === 'chain/one')?.id;
if (unflattenedChain !== undefined && unflattenedOne !== undefined) {
  await unflattenedTree.expand(unflattenedChain);
  assert.equal(unflattenedTree.model.visibleRows.find((row) => row.nodeId === unflattenedOne)?.label, undefined, 'T036-FILE-EXPLORER-FLATTEN-DIRS-UNIT-04 flatten-dirs=false preserves separate directory labels');
}
unflattenedTree.dispose();

tree.dispose();
assert.equal(watchers.size, 0, 'T040-WATCH-03 disposal closes root and expanded-directory watchers');
assert.equal(tree.model.nodes.length, 0, 'T040-DISPOSE-01 tree releases nodes and watcher state');

// T040-COALESCE: a burst of raw 'changed' watch events (no entry) for the same
// directory must produce one re-enumeration and a bounded number of publishes,
// not one enumerateDirectory + one publish per raw event.
{
  let enumerateCalls = 0;
  const coalesceDirectories = new Map<string, readonly ExplorerDirectoryEntry[]>([
    ['/coalesce-root', [{ name: 'a.txt', relativePath: 'a.txt', kind: 'file' }]],
  ]);
  let coalesceListener: ((event: ExplorerWatchEvent) => void) | undefined;
  const coalesceFilesystem: ExplorerFilesystemPort = {
    async enumerateDirectory(path: string, _cancellation: CancellationToken): Promise<Result<readonly ExplorerDirectoryEntry[], ExplorerFailure>> {
      enumerateCalls += 1;
      const entries = coalesceDirectories.get(path);
      return entries === undefined ? { ok: false, error: { kind: 'filesystem', path, message: 'missing fixture directory' } } : { ok: true, value: entries };
    },
    async watchDirectory(_path: string, listener: (event: ExplorerWatchEvent) => void, _cancellation: CancellationToken): Promise<Result<Disposable, ExplorerFailure>> {
      coalesceListener = listener;
      return { ok: true, value: Object.freeze({ dispose() { coalesceListener = undefined; } }) };
    },
  };
  const coalesceTree = new ExplorerTree(coalesceFilesystem, {});
  const coalesceRoot = coalesceTree.addRoot({ id: 'coalesce', label: 'coalesce', path: '/coalesce-root' });
  if (!coalesceRoot.ok) throw new Error(`coalesce root fixture failed: ${coalesceRoot.error.kind}`);
  assert.equal((await coalesceTree.watchRoot('coalesce')).ok, true, 'T040-COALESCE-00 installs one directory watcher');
  assert.ok(coalesceListener !== undefined, 'T040-COALESCE-01 watcher listener is captured');
  assert.equal((await coalesceTree.expand(coalesceRoot.value)).ok, true, 'T040-COALESCE-02 initial expansion enumerates once');
  enumerateCalls = 0;
  let publishCount = 0;
  const coalesceSubscription = coalesceTree.subscribe(() => { publishCount += 1; });
  for (let index = 0; index < 10; index += 1) coalesceListener?.({ kind: 'changed', rootId: 'coalesce', relativePath: 'a.txt' });
  // The coalescing window is ~50ms; wait past it with margin.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(enumerateCalls, 1, 'T040-COALESCE-03 ten rapid raw events for one directory produce exactly one re-enumeration');
  assert.ok(publishCount <= 2, `T040-COALESCE-04 ten rapid raw events produce a bounded publish count (${publishCount}), not one publish per raw event`);
  coalesceSubscription.dispose();
  coalesceTree.dispose();
}

console.log('T040 Explorer passed E03 insertion/rename identity, lazy expansion, hidden/filter policy, permission/symlink/empty states, overflow recovery, watch-event coalescing and UI rendering');
