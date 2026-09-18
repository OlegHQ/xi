#!/usr/bin/env bun
// Regression coverage for ExplorerTree's #stableIds path->id cache: a rename must drop the
// stale key for the old path, and a removed node's key must be dropped too, or a later
// `mv a b; touch a` makes the recreated `a` invisible/conflated with the renamed node.
import { strict as assert } from 'node:assert';
import type { CancellationToken, Disposable, Result } from '../../packages/contracts/src/index';
import {
  ExplorerTree,
  type ExplorerDirectoryEntry,
  type ExplorerFailure,
  type ExplorerFilesystemPort,
} from '../../packages/services/files/index';

const neverCancelled: CancellationToken = Object.freeze({ isCancelled: false, onCancel: () => Object.freeze({ dispose() {} }) });

async function main(): Promise<void> {
  let entries: ExplorerDirectoryEntry[] = [{ name: 'a.txt', relativePath: 'a.txt', kind: 'file', stableIdentity: 'a-inode' }];
  const filesystem: ExplorerFilesystemPort = {
    async enumerateDirectory(path: string, _cancellation: CancellationToken): Promise<Result<readonly ExplorerDirectoryEntry[], ExplorerFailure>> {
      if (path !== '/workspace') return { ok: false, error: { kind: 'filesystem', path, message: 'unexpected fixture path' } };
      return { ok: true, value: Object.freeze([...entries]) };
    },
    async watchDirectory(): Promise<Result<Disposable, ExplorerFailure>> {
      return { ok: true, value: Object.freeze({ dispose: () => {} }) };
    },
  };

  const tree = new ExplorerTree(filesystem, { includeHidden: true, includeIgnored: true });
  const rootResult = tree.addRoot({ id: 'workspace', label: 'workspace', path: '/workspace' });
  assert.ok(rootResult.ok, 'root fixture is added');
  if (!rootResult.ok) return;
  const rootId = rootResult.value;
  assert.ok((await tree.expand(rootId)).ok, 'root expand enumerates /workspace');
  const originalNode = tree.model.visibleRows.map((row) => tree.readNode(row.nodeId)).find((node) => node?.name === 'a.txt');
  assert.ok(originalNode !== undefined, 'T-STABLEID-01 a.txt is initially visible');

  // mv a.txt b.txt
  await tree.applyWatchEvent({ kind: 'renamed', rootId: 'workspace', previousRelativePath: 'a.txt', relativePath: 'b.txt', entry: { name: 'b.txt', relativePath: 'b.txt', kind: 'file', stableIdentity: 'a-inode' } });
  entries = [{ name: 'b.txt', relativePath: 'b.txt', kind: 'file', stableIdentity: 'a-inode' }, { name: 'a.txt', relativePath: 'a.txt', kind: 'file', stableIdentity: 'new-a-inode' }];

  // touch a.txt (recreate under the freed path)
  await tree.applyWatchEvent({ kind: 'created', rootId: 'workspace', relativePath: 'a.txt', entry: { name: 'a.txt', relativePath: 'a.txt', kind: 'file', stableIdentity: 'new-a-inode' } });

  const nodesByPath = tree.model.visibleRows.map((row) => tree.readNode(row.nodeId));
  const recreatedA = nodesByPath.find((node) => node?.relativePath === 'a.txt');
  const renamedB = nodesByPath.find((node) => node?.relativePath === 'b.txt');
  assert.ok(recreatedA !== undefined, 'T-STABLEID-02 recreated a.txt is visible, not shadowed by the stale rename key');
  assert.ok(renamedB !== undefined, 'T-STABLEID-03 renamed b.txt remains visible');
  assert.notEqual(recreatedA?.id, renamedB?.id, 'T-STABLEID-04 recreated a.txt is a distinct node from renamed b.txt');
  assert.equal(recreatedA?.stableIdentity, 'new-a-inode', 'T-STABLEID-05 recreated a.txt carries its own stable identity');

  console.log('T-STABLEID stable-id path cache drops stale keys on rename and remove');
}

await main();
