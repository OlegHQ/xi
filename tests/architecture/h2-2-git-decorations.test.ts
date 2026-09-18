import assert from 'node:assert/strict';
import { createGitDecorationPort, toExplorerGitDecoration } from '../../packages/services/git/decorations';

// H2-2: apps/xi/src/wiring/controllers.ts reimplemented the git status entry -> explorer
// decoration mapping, its own root-relative-path resolution and a linear `entries.find` per
// decoration read. That logic now lives in packages/services/git/decorations.ts (exported off
// the git entrypoint), indexes the snapshot by path once per generation, and delegates
// root-relative resolution to the injected filesystem port instead of reimplementing it.

assert.deepEqual(
  toExplorerGitDecoration({ state: 'added', staged: true, unstaged: false, conflict: false }),
  { state: 'staged', label: 'A', colorToken: 'git.staged' },
  'H2-2-01 a staged, non-conflicting entry decorates as staged with its state label',
);
assert.deepEqual(
  toExplorerGitDecoration({ state: 'modified', staged: false, unstaged: true, conflict: true }),
  { state: 'conflicted', label: 'M', colorToken: 'git.conflicted' },
  'H2-2-02 conflict always wins regardless of staged/unstaged',
);

let indexCalls = 0;
const snapshot = {
  root: '/repo',
  generation: 1,
  branch: undefined,
  entries: Object.freeze([
    { path: 'a.txt', state: 'modified' as const, indexCode: ' ', worktreeCode: 'M', staged: false, unstaged: true, conflict: false },
    { path: 'b.txt', state: 'added' as const, indexCode: 'A', worktreeCode: ' ', staged: true, unstaged: false, conflict: false },
  ]),
};
const filesystem = {
  workspaceRelativePath(root: string, path: string): string | undefined {
    indexCalls += 1;
    return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined;
  },
};
const port = createGitDecorationPort({ snapshot }, '/repo', filesystem);

const a = await port.read('/repo/a.txt');
assert.equal(a.ok, true, 'H2-2-03 read() resolves ok');
if (a.ok) assert.equal(a.value?.state, 'modified', 'H2-2-04 a.txt resolves to its snapshot entry');

const b = await port.read('/repo/b.txt');
if (b.ok) assert.equal(b.value?.state, 'staged', 'H2-2-05 b.txt resolves to its snapshot entry');

const missing = await port.read('/repo/c.txt');
if (missing.ok) assert.equal(missing.value, undefined, 'H2-2-06 a path with no snapshot entry decorates as undefined, not an error');

assert.equal(indexCalls, 3, 'H2-2-07 workspaceRelativePath is used for path resolution instead of a local reimplementation');

// Perf/behavioral intent: the by-path index is built once per snapshot generation, not
// re-scanned per read() -- exercise enough reads that an O(entries) `find` per call would show
// up as quadratic, and assert it stays fast (a loose upper bound; this is a correctness/shape
// guard, not a calibrated timing gate).
const bigEntries = Array.from({ length: 5_000 }, (_unused, index) => ({ path: `f${index}.txt`, state: 'modified' as const, indexCode: ' ', worktreeCode: 'M', staged: false, unstaged: true, conflict: false }));
const bigSnapshot = { root: '/repo', generation: 2, branch: undefined, entries: Object.freeze(bigEntries) };
const bigPort = createGitDecorationPort({ snapshot: bigSnapshot }, '/repo', filesystem);
const started = performance.now();
for (let index = 0; index < 5_000; index += 1) await bigPort.read(`/repo/f${index}.txt`);
const elapsedMilliseconds = performance.now() - started;
assert.ok(elapsedMilliseconds < 200, `H2-2-08 5,000 indexed reads should stay well under a linear-scan-per-read cost (took ${elapsedMilliseconds.toFixed(2)}ms)`);

console.log(`H2-2 git decoration mapping/index behaves correctly (5,000 indexed reads in ${elapsedMilliseconds.toFixed(2)}ms)`);
