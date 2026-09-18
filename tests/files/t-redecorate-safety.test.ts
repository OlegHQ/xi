#!/usr/bin/env bun
// Regression coverage for F2-8: ExplorerTree.redecorate() must cap in-flight Git-decoration
// reads instead of firing one uncancellable read per node, and dispose()/a superseding
// redecorate() call must cancel a run already in flight instead of letting its results land
// (and its fan-out keep running) afterward.
import { strict as assert } from 'node:assert';
import type { CancellationToken, Disposable, Result } from '../../packages/contracts/src/index';
import {
  ExplorerTree,
  type ExplorerDirectoryEntry,
  type ExplorerFailure,
  type ExplorerFilesystemPort,
  type ExplorerGitDecoration,
  type ExplorerGitDecorationPort,
  type ExplorerWatchEvent,
} from '../../packages/services/files/index';

const neverCancelled: CancellationToken = Object.freeze({ isCancelled: false, onCancel: () => Object.freeze({ dispose() {} }) });

const NODE_COUNT = 200;
const workspace: ExplorerDirectoryEntry[] = Array.from({ length: NODE_COUNT }, (_unused, index) => ({
  name: `file-${index}.ts`,
  relativePath: `file-${index}.ts`,
  kind: 'file' as const,
}));
const filesystem: ExplorerFilesystemPort = {
  async enumerateDirectory(path: string, _cancellation: CancellationToken): Promise<Result<readonly ExplorerDirectoryEntry[], ExplorerFailure>> {
    return path === '/workspace' ? { ok: true, value: workspace } : { ok: false, error: { kind: 'filesystem', path, message: 'missing fixture directory' } };
  },
  async watchDirectory(_path: string, _listener: (event: ExplorerWatchEvent) => void, _cancellation: CancellationToken): Promise<Result<Disposable, ExplorerFailure>> {
    return { ok: true, value: Object.freeze({ dispose() {} }) };
  },
};

async function concurrencyStaysCapped(): Promise<void> {
  let inFlight = 0;
  let maxInFlight = 0;
  let totalCalls = 0;
  const git: ExplorerGitDecorationPort = {
    async read(_path, _cancellation): Promise<Result<ExplorerGitDecoration | undefined, ExplorerFailure>> {
      totalCalls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return { ok: true, value: undefined };
    },
  };
  const tree = new ExplorerTree(filesystem, { includeHidden: false, includeIgnored: false, git });
  const rootResult = tree.addRoot({ id: 'workspace', label: 'workspace', path: '/workspace' });
  assert.equal(rootResult.ok, true, 'sanity: root registers');
  if (!rootResult.ok) return;
  const expanded = await tree.expand(rootResult.value, false, neverCancelled);
  assert.equal(expanded.ok, true, 'sanity: root expands');
  // Let expand()'s own (separate, uncapped) per-node initial-decoration fan-out fully settle
  // before measuring redecorate()'s concurrency, so its in-flight reads do not bleed in.
  await new Promise((resolve) => setTimeout(resolve, 50));
  totalCalls = 0;
  maxInFlight = 0;

  tree.redecorate();
  // Let every scheduled microtask/macrotask from the fan-out settle.
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(maxInFlight <= 32, `F2-8: redecorate() must cap concurrent Git-decoration reads at 32, saw ${maxInFlight}`);
  assert.equal(totalCalls, NODE_COUNT, 'F2-8: every node is still eventually redecorated despite the concurrency cap');
  tree.dispose();
}

async function disposeDuringRedecorateDropsStaleResults(): Promise<void> {
  let resolveFirst: (() => void) | undefined;
  let readsAfterDispose = 0;
  let disposed = false;
  const git: ExplorerGitDecorationPort = {
    async read(_path, _cancellation): Promise<Result<ExplorerGitDecoration | undefined, ExplorerFailure>> {
      if (disposed) readsAfterDispose += 1;
      await new Promise<void>((resolve) => { resolveFirst = resolve; });
      return { ok: true, value: { state: 'modified', label: 'M', colorToken: 'git.modified' } };
    },
  };
  const tree = new ExplorerTree(filesystem, { includeHidden: false, includeIgnored: false, git });
  const rootResult = tree.addRoot({ id: 'workspace', label: 'workspace', path: '/workspace' });
  if (!rootResult.ok) return;
  await tree.expand(rootResult.value, false, neverCancelled);

  tree.redecorate();
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the first batch of reads start
  disposed = true;
  tree.dispose();
  resolveFirst?.();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(readsAfterDispose, 0, 'F2-8: dispose() cancels the redecoration run instead of leaving it to keep issuing reads');
}

async function main(): Promise<void> {
  await concurrencyStaysCapped();
  await disposeDuringRedecorateDropsStaleResults();
  console.log('T-REDECORATE-SAFETY passed: redecorate() caps concurrency at 32 and dispose() cancels an in-flight run (F2-8)');
}

await main();
