#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import type { CancellationToken, Disposable, Result } from '../../packages/contracts/src/index';
import {
  ExplorerTree,
  type ExplorerDirectoryEntry,
  type ExplorerFailure,
  type ExplorerFilesystemPort,
  type ExplorerWatchEvent,
} from '../../packages/services/files/index';

const neverCancelled: CancellationToken = Object.freeze({ isCancelled: false, onCancel: () => Object.freeze({ dispose() {} }) });

// A workspace wide enough that a full node-list rebuild is measurably not
// free, to demonstrate focus()/blur() no longer pay for one.
const NODE_COUNT = 20_000;
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

async function main(): Promise<void> {
  const tree = new ExplorerTree(filesystem, { includeHidden: false, includeIgnored: false });
  const rootResult = tree.addRoot({ id: 'workspace', label: 'workspace', path: '/workspace' });
  assert.equal(rootResult.ok, true, 'T-EXPLORER-FOCUS-01 root registers');
  if (!rootResult.ok) return;
  const expanded = await tree.expand(rootResult.value, false, neverCancelled);
  assert.equal(expanded.ok, true, 'T-EXPLORER-FOCUS-02 root expands');
  assert.equal(tree.model.nodes.length, NODE_COUNT + 1, 'T-EXPLORER-FOCUS-03 all entries are indexed as nodes');

  // Warm up the JIT on the same call path before measuring steady state.
  for (let warmup = 0; warmup < 5; warmup += 1) { tree.focus(); tree.blur(); }

  const beforeGeneration = tree.model.generation;
  const beforeNodes = tree.model.nodes;
  const beforeVisibleRows = tree.model.visibleRows;

  const trialMilliseconds: number[] = [];
  for (let trial = 0; trial < 20; trial += 1) {
    const start = performance.now();
    tree.focus();
    tree.blur();
    trialMilliseconds.push(performance.now() - start);
  }
  const minMilliseconds = Math.min(...trialMilliseconds);
  console.log(`T-EXPLORER-FOCUS-PERF focus()+blur() over a ${NODE_COUNT}-node tree took [${trialMilliseconds.map((value) => value.toFixed(3)).join(', ')}]ms, min ${minMilliseconds.toFixed(3)}ms`);
  assert.ok(minMilliseconds < 2, `T-EXPLORER-FOCUS-04 focus/blur stays well under the 2ms background-slice budget, not an O(node count) rebuild (min ${minMilliseconds.toFixed(3)}ms)`);

  assert.equal(tree.model.generation, beforeGeneration + 40, 'T-EXPLORER-FOCUS-05 each focus/blur still advances the generation');
  assert.equal(tree.model.focused, false, 'T-EXPLORER-FOCUS-06 final state reflects the last blur()');
  assert.equal(tree.model.nodes, beforeNodes, 'T-EXPLORER-FOCUS-07 the frozen node list is reused, not rebuilt, by a focus-only publish');
  assert.equal(tree.model.visibleRows, beforeVisibleRows, 'T-EXPLORER-FOCUS-08 the frozen visible-rows list is reused, not rebuilt, by a focus-only publish');

  tree.dispose();
  console.log('T-EXPLORER-FOCUS-PERF passed: focus/blur no longer rebuild the full node/visible-row lists');
}

await main();
