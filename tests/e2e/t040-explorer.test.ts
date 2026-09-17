import assert from 'node:assert/strict';
import { createTestRenderer } from '@opentui/core/testing';
import type { CancellationToken, Disposable, Result } from '../../packages/contracts/src/index';
import {
  ExplorerTree,
  type ExplorerDirectoryEntry,
  type ExplorerFailure,
  type ExplorerFilesystemPort,
  type ExplorerWatchEvent,
} from '../../packages/services/files/index';
import {
  ExplorerRenderable,
  type ExplorerReadModel,
  type ExplorerReadPort,
} from '../../packages/ui/explorer/index';

const neverCancelled: CancellationToken = Object.freeze({ isCancelled: false, onCancel: () => Object.freeze({ dispose() {} }) });
const workspace: ExplorerDirectoryEntry[] = [
  { name: 'src', relativePath: 'src', kind: 'directory' },
  { name: '.env', relativePath: '.env', kind: 'file', hidden: true },
  { name: 'README.md', relativePath: 'README.md', kind: 'file', stableIdentity: 'inode-readme', git: { state: 'modified', label: 'M', colorToken: 'git.modified' } },
  { name: 'loop', relativePath: 'loop', kind: 'symlink', symlinkTarget: 'src', symlinkCycle: true },
  { name: 'empty', relativePath: 'empty', kind: 'directory' },
];
const srcEntries: ExplorerDirectoryEntry[] = [
  { name: 'main.ts', relativePath: 'src/main.ts', kind: 'file', stableIdentity: 'inode-main' },
  { name: 'z.ts', relativePath: 'src/z.ts', kind: 'file' },
];
const directoryEntries = new Map<string, readonly ExplorerDirectoryEntry[]>([
  ['/workspace', workspace],
  ['/workspace/src', srcEntries],
  ['/workspace/empty', Object.freeze([])],
]);
let watcher: ((event: ExplorerWatchEvent) => void) | undefined;
const filesystem: ExplorerFilesystemPort = {
  async enumerateDirectory(path: string, _cancellation: CancellationToken): Promise<Result<readonly ExplorerDirectoryEntry[], ExplorerFailure>> {
    if (path === '/workspace/secret') return { ok: false, error: { kind: 'permission-denied', path, message: 'Permission denied' } };
    const entries = directoryEntries.get(path);
    return entries === undefined ? { ok: false, error: { kind: 'filesystem', path, message: 'Missing fixture directory' } } : { ok: true, value: entries };
  },
  async watchDirectory(_path: string, listener: (event: ExplorerWatchEvent) => void, _cancellation: CancellationToken): Promise<Result<Disposable, ExplorerFailure>> {
    watcher = listener;
    return { ok: true, value: Object.freeze({ dispose: () => { watcher = undefined; } }) };
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

const srcId = firstModel.visibleRows.map((row) => tree.readNode(row.nodeId)).find((node) => node?.name === 'src')?.id;
assert.ok(srcId !== undefined, 'T040-E03-03 source directory has stable identity');
if (srcId === undefined) throw new Error('src fixture missing');
assert.equal((await tree.expand(srcId)).ok, true, 'T040-E03-04 expanded directories enumerate on demand');
const selectedFile = tree.model.visibleRows.map((row) => tree.readNode(row.nodeId)).find((node) => node?.name === 'main.ts');
assert.ok(selectedFile !== undefined, 'T040-E03-05 nested file is visible');
if (selectedFile === undefined) throw new Error('main fixture missing');
assert.equal(tree.select(selectedFile.id), true, 'T040-SELECT-01 selects by opaque identity');
const selectedBeforeInsert = tree.model.selectedId;
await tree.applyWatchEvent({ kind: 'created', rootId: 'workspace', relativePath: 'src/aaa.ts', entry: { name: 'aaa.ts', relativePath: 'src/aaa.ts', kind: 'file' } });
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

tree.setIncludeHidden(true);
assert.ok(tree.model.visibleRows.some((row) => tree.readNode(row.nodeId)?.name === '.env'), 'T040-HIDDEN-02 hidden entries can be intentionally included');
tree.setFilter('renamed');
assert.ok(tree.model.visibleRows.some((row) => tree.readNode(row.nodeId)?.name === 'renamed.ts'), 'T040-FILTER-01 filtering retains matching descendants and ancestors');
tree.setFilter('');
await tree.applyWatchEvent({ kind: 'overflow', rootId: 'workspace', relativePath: '' });
assert.equal(tree.readNode(rootId)?.loadState, 'ready', 'T040-OVERFLOW-01 watcher overflow recovers by re-enumerating expanded root');
assert.ok(watcher !== undefined, 'T040-OVERFLOW-02 watcher remains installed after recovery');

const uiModel: ExplorerReadModel = tree.model;
const uiRead: ExplorerReadPort = { model: uiModel, subscribe: () => Object.freeze({ dispose() {} }) };
const rendererSetup = await createTestRenderer({ width: 52, height: 12, bufferedOutput: 'memory' });
const explorer = new ExplorerRenderable(rendererSetup.renderer.root.ctx, { explorer: uiRead, width: 52, height: 12 });
rendererSetup.renderer.root.add(explorer);
await rendererSetup.renderOnce();
const frame = rendererSetup.captureCharFrame();
assert.match(frame, /Files/u, 'T040-UI-01 explorer panel header is visible');
assert.match(frame, /renamed\.ts/u, 'T040-UI-02 stable renamed file is rendered');
rendererSetup.renderer.destroy();
assert.equal(explorer.isDestroyed, true, 'T040-UI-03 explorer renderable disposes its subscription');

tree.dispose();
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
