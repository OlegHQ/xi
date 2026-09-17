#!/usr/bin/env bun
// Regression coverage for ExplorerTree's per-parent in-flight watch-event guard: two
// overlapping watcher events for the same parent directory must not run their
// reconcile/enumerate work concurrently, and must produce one ordered sequence.
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

async function main(): Promise<void> {
  const rootEntries: ExplorerDirectoryEntry[] = [{ name: 'src', relativePath: 'src', kind: 'directory' }];
  let version = 0;
  let holdSrcCalls = false;
  let activeSrcCalls = 0;
  let maxConcurrentSrcCalls = 0;
  const callStarts: number[] = [];
  const callEnds: number[] = [];
  const pendingReleases: (() => void)[] = [];
  let watcher: ((event: ExplorerWatchEvent) => void) | undefined;

  const filesystem: ExplorerFilesystemPort = {
    async enumerateDirectory(path: string, _cancellation: CancellationToken): Promise<Result<readonly ExplorerDirectoryEntry[], ExplorerFailure>> {
      if (path === '/workspace') return { ok: true, value: rootEntries };
      if (path !== '/workspace/src') return { ok: false, error: { kind: 'filesystem', path, message: 'unexpected fixture path' } };
      const callId = callStarts.length;
      callStarts.push(callId);
      activeSrcCalls += 1;
      maxConcurrentSrcCalls = Math.max(maxConcurrentSrcCalls, activeSrcCalls);
      if (holdSrcCalls) await new Promise<void>((resolve) => pendingReleases.push(resolve));
      activeSrcCalls -= 1;
      callEnds.push(callId);
      // Each release captures the entries as of that moment: a distinct 'version' tag lets the
      // test assert exactly which enumeration result the final published model reflects.
      const tagged: ExplorerDirectoryEntry[] = [{ name: `main-v${version}.ts`, relativePath: `src/main-v${version}.ts`, kind: 'file' }];
      return { ok: true, value: Object.freeze(tagged) };
    },
    async watchDirectory(_path: string, listener: (event: ExplorerWatchEvent) => void, _cancellation: CancellationToken): Promise<Result<Disposable, ExplorerFailure>> {
      watcher = listener;
      return { ok: true, value: Object.freeze({ dispose: () => { watcher = undefined; } }) };
    },
  };

  const tree = new ExplorerTree(filesystem, { includeHidden: true, includeIgnored: true });
  const rootResult = tree.addRoot({ id: 'workspace', label: 'workspace', path: '/workspace' });
  assert.ok(rootResult.ok, 'root fixture is added');
  if (!rootResult.ok) return;
  const rootId = rootResult.value;
  assert.ok((await tree.watchRoot('workspace', neverCancelled)).ok, 'watcher installs');
  assert.ok((await tree.expand(rootId)).ok, 'root expand enumerates /workspace');
  const srcId = tree.model.visibleRows.map((row) => tree.readNode(row.nodeId)).find((node) => node?.name === 'src')?.id;
  assert.ok(srcId !== undefined, 'src directory node exists');
  if (srcId === undefined) return;
  version = 0;
  assert.ok((await tree.expand(srcId)).ok, 'src expand enumerates /workspace/src (not held)');
  const baseline = callStarts.length;
  assert.equal(baseline, 1, 'setup performed exactly one enumeration of src');

  // From here on, enumerating /workspace/src blocks until explicitly released, so two
  // watcher-driven 'changed' events for that same directory can be made to overlap
  // deterministically.
  holdSrcCalls = true;

  // T-FILES-WATCH-SERIAL-01: two 'changed' events for the same parent directory, without an
  // attached entry (so both hit the applyWatchEvent -> expand -> enumerateDirectory path).
  version = 1;
  watcher?.({ kind: 'changed', rootId: 'workspace', relativePath: 'src/watched.ts' });
  // A bare 'changed' (no attached entry) first goes through watchRoot's own 50ms burst
  // debounce before it ever reaches the dispatch guard under test; wait past that.
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(callStarts.length, baseline + 1, 'T-FILES-WATCH-SERIAL-01a the first event has started its enumeration');
  assert.equal(activeSrcCalls, 1, 'T-FILES-WATCH-SERIAL-01b exactly one enumeration is active');

  version = 2;
  watcher?.({ kind: 'changed', rootId: 'workspace', relativePath: 'src/watched.ts' });
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(callStarts.length, baseline + 1, 'T-FILES-WATCH-SERIAL-02 a second overlapping event for the same parent does NOT start a concurrent enumeration; it is queued');
  assert.equal(activeSrcCalls, 1, 'still only one enumeration in flight');

  // Release the first (now-superseded) enumeration; the queued (latest) event must then run,
  // never concurrently with the first.
  pendingReleases.shift()?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(callStarts.length, baseline + 2, 'T-FILES-WATCH-SERIAL-03 the coalesced second event starts only after the first finishes');
  assert.equal(maxConcurrentSrcCalls, 1, 'T-FILES-WATCH-SERIAL-04 at no point were two enumerations of the same parent active at once');

  pendingReleases.shift()?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(callEnds, [0, 1, 2], 'T-FILES-WATCH-SERIAL-05 the two runs completed in start order (ordered publish sequence)');

  const child = tree.model.visibleRows.map((row) => tree.readNode(row.nodeId)).find((node) => node?.parentId === srcId);
  assert.equal(child?.name, 'main-v2.ts', 'T-FILES-WATCH-SERIAL-06 the final published model reflects the latest (coalesced) event, not the superseded one');

  tree.dispose();
}

await main();
console.log('T-FILES-WATCH-SERIAL explorer watch-event dispatch passed per-parent in-flight coalescing and ordered publish');
