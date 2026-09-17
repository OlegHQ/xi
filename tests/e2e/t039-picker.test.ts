import assert from 'node:assert/strict';
import { createTestRenderer } from '@opentui/core/testing';
import {
  CancellationSource,
  type CancellationToken,
  type Result,
} from '../../packages/contracts/src/index';
import {
  BoundedPickerModel,
  FilePathIndex,
  createNavigationContributionModule,
  FilePickerProvider,
  truncatePathForDisplay,
  type PickerEntry,
  type PickerFailure,
  type PickerProvider,
  type PickerQueryRequest,
} from '../../packages/services/navigation/index';
import { PickerRenderable, type PickerEntry as UiPickerEntry, type PickerReadModel, type PickerReadPort } from '../../packages/ui/picker/index';
import { CommandRegistry } from '../../packages/workbench/commands/registry';
import { ContributionRegistry } from '../../packages/workbench/contributions/index';

const index = new FilePathIndex({ maxEntries: 120_000 });
assert.equal(index.addRoot({ id: 'root-a', label: 'workspace-a', path: '/workspace/a' }).ok, true, 'T039-INDEX-ROOT-01 adds first root');
assert.equal(index.addRoot({ id: 'root-b', label: 'workspace-b', path: '/workspace/b' }).ok, true, 'T039-INDEX-ROOT-02 adds second root');
const generated: { rootId: string; relativePath: string; hidden?: boolean }[] = [];
for (let i = 0; i < 50_000; i += 1) {
  generated.push({ rootId: i % 2 === 0 ? 'root-a' : 'root-b', relativePath: `src/generated/file-${String(i).padStart(6, '0')}.ts` });
}
generated.push({ rootId: 'root-a', relativePath: 'src/shared.ts' });
generated.push({ rootId: 'root-b', relativePath: 'src/shared.ts' });
generated.push({ rootId: 'root-a', relativePath: '.hidden/settings.json', hidden: true });
const added = index.addPaths('root-a', generated.filter((entry) => entry.rootId === 'root-a').map((entry) => ({ ...entry })));
assert.equal(added.ok, true, 'T039-INDEX-ADD-01 incrementally adds root-a paths');
const addedB = index.addPaths('root-b', generated.filter((entry) => entry.rootId === 'root-b').map((entry) => ({ ...entry })));
assert.equal(addedB.ok, true, 'T039-INDEX-ADD-02 incrementally adds root-b paths');
index.markReady();

const warmStart = performance.now();
const warm = await index.queryAsync('generated/file-004', { limit: 40, includeHidden: false });
const warmMilliseconds = performance.now() - warmStart;
assert.equal(warm.ok, true, 'T039-BUDGET-01 warm 50k path query returns results');
if (warm.ok) assert.ok(warm.value.entries.length > 0, 'T039-BUDGET-02 fuzzy subsequence matching finds generated files');
assert.ok(warmMilliseconds < 500, `T039-BUDGET-03 warm query remains bounded (${warmMilliseconds.toFixed(2)}ms)`);

const duplicates = await index.queryAsync('shared', { includeHidden: false });
assert.equal(duplicates.ok, true, 'T039-DUP-01 duplicate relative names query succeeds');
if (duplicates.ok) {
  assert.equal(duplicates.value.totalMatches, 2, 'T039-DUP-02 both roots remain selectable');
  assert.equal(new Set(duplicates.value.entries.map((entry) => entry.rootId)).size, 2, 'T039-DUP-03 root identity survives duplicate relative names');
  assert.notEqual(duplicates.value.entries[0]?.id, duplicates.value.entries[1]?.id, 'T039-DUP-04 duplicate rows have stable distinct IDs');
}
const hidden = await index.queryAsync('settings', { includeHidden: false });
assert.equal(hidden.ok, true, 'T039-HIDDEN-01 hidden filtering is explicit');
if (hidden.ok) assert.equal(hidden.value.totalMatches, 0, 'T039-HIDDEN-02 hidden path is omitted when disabled');
const hiddenShown = await index.queryAsync('settings', { includeHidden: true });
assert.equal(hiddenShown.ok, true, 'T039-HIDDEN-03 hidden paths can be selected');
if (hiddenShown.ok) assert.equal(hiddenShown.value.totalMatches, 1, 'T039-HIDDEN-04 hidden result is retained when enabled');

// T039-ASYNC-INDEX: queryAsync must time-slice a large index -- yielding to the
// event loop between chunks -- and honor cancellation/generation between those
// yields instead of scoring 50k+ entries in one uninterruptible synchronous pass.
const asyncWarm = await index.queryAsync('generated/file-004', { limit: 40, includeHidden: false });
assert.equal(asyncWarm.ok, true, 'T039-ASYNC-INDEX-01 time-sliced query succeeds on a large index');
if (asyncWarm.ok) assert.ok(asyncWarm.value.entries.length > 0, 'T039-ASYNC-INDEX-02 time-sliced query still finds matches');

const asyncCancelSource = new CancellationSource();
const asyncCancelPending = index.queryAsync('generated', { cancellation: asyncCancelSource.token });
asyncCancelSource.cancel();
const asyncCancelled = await asyncCancelPending;
assert.equal(asyncCancelled.ok, false, 'T039-ASYNC-INDEX-03 a query over 50k+ entries yields at least once, so a cancel requested right after dispatch still lands before completion');
if (!asyncCancelled.ok) assert.equal(asyncCancelled.error.kind, 'cancelled', 'T039-ASYNC-INDEX-04 cancellation between slices is typed');

const asyncStalePending = index.queryAsync('generated');
assert.equal(index.addPaths('root-a', [{ rootId: 'root-a', relativePath: 'src/late-added-during-scan.ts' }]).ok, true, 'T039-ASYNC-INDEX-05 index mutates mid-scan');
const asyncStaleResult = await asyncStalePending;
assert.equal(asyncStaleResult.ok, false, 'T039-ASYNC-INDEX-06 a generation change mid-scan is observed between slices, not scored against a moving store');
if (!asyncStaleResult.ok) assert.equal(asyncStaleResult.error.kind, 'stale', 'T039-ASYNC-INDEX-07 generation mismatch is reported as stale');

// T039-LARGE-INDEX: a query matching most of a 250k-entry index must still
// score in bounded time slices and keep a bounded candidate set (top-N insert
// instead of collecting and sorting every match), rather than an unbounded
// scan/sort that would blow past the slice budget.
const largeIndex = new FilePathIndex({ maxEntries: 260_000 });
assert.equal(largeIndex.addRoot({ id: 'root-large', label: 'large', path: '/workspace/large' }).ok, true, 'T039-LARGE-INDEX-01 large index root registers');
const largeBatchSize = 50_000;
for (let start = 0; start < 250_000; start += largeBatchSize) {
  const batch = Array.from({ length: largeBatchSize }, (_unused, offset) => ({ rootId: 'root-large', relativePath: `src/file-${String(start + offset).padStart(7, '0')}.ts` }));
  assert.equal(largeIndex.addPaths('root-large', batch).ok, true, 'T039-LARGE-INDEX-02 large index accepts bulk batches');
}
largeIndex.markReady();

// A cancel requested immediately after dispatch only lands if the scan
// actually yields before finishing a 250k-entry, mostly-matching query --
// proving it time-slices rather than running one long synchronous pass.
const largeCancelSource = new CancellationSource();
const largeCancelPending = largeIndex.queryAsync('file', { limit: 40, cancellation: largeCancelSource.token });
largeCancelSource.cancel();
const largeCancelled = await largeCancelPending;
assert.equal(largeCancelled.ok, false, 'T039-LARGE-INDEX-03 a query matching most of a 250k-entry index yields at least once, so an immediate cancel lands before completion');
if (!largeCancelled.ok) assert.equal(largeCancelled.error.kind, 'cancelled', 'T039-LARGE-INDEX-04 cancellation is typed');

const largeStart = performance.now();
const largeResult = await largeIndex.queryAsync('file', { limit: 40 });
const largeMilliseconds = performance.now() - largeStart;
assert.equal(largeResult.ok, true, 'T039-LARGE-INDEX-05 the query completes');
if (largeResult.ok) {
  assert.equal(largeResult.value.totalMatches, 250_000, 'T039-LARGE-INDEX-06 nearly all entries match a broad query');
  assert.equal(largeResult.value.entries.length, 40, 'T039-LARGE-INDEX-07 results are bounded by limit despite the large candidate pool');
  assert.equal(largeResult.value.truncated, true, 'T039-LARGE-INDEX-08 truncation is reported');
}
// 250k entries at a 2k-entry chunk size is ~125 yields; each yield's
// setTimeout(0) costs more than the ~4ms scoring slice it bounds, so total
// wall time is yield-overhead-dominated, not a measure of the per-slice fix.
// The bound here only proves the whole query still finishes promptly, not
// hangs or scans unbounded.
assert.ok(largeMilliseconds < 3_000, `T039-LARGE-INDEX-09 a 250k-entry, mostly-matching query completes in bounded total time across its slices (${largeMilliseconds.toFixed(2)}ms)`);
largeIndex.dispose();

const notReady = new FilePathIndex();
assert.equal(notReady.addRoot({ id: 'cold', label: 'cold', path: '/cold' }).ok, true);
const coldResult = await notReady.queryAsync('x');
assert.deepEqual(coldResult, { ok: false, error: { kind: 'not-ready', mode: 'file', message: 'filename index is still warming' } }, 'T039-FAIL-NOT-READY-01 index not ready is visible');
assert.equal(truncatePathForDisplay(`a/${'😀'.repeat(100)}/tail.ts`, 24).endsWith('tail.ts'), true, 'T039-FAIL-HUGE-PATH-01 truncation preserves basename');
assert.equal([...truncatePathForDisplay('😀'.repeat(100), 17)].length, 17, 'T039-FAIL-HUGE-PATH-02 truncation counts Unicode scalars without splitting');

const fileProvider = new FilePickerProvider(index);
const staticProvider: PickerProvider = {
  id: 'delayed', mode: 'command',
  async query(request: PickerQueryRequest, _cancellation: CancellationToken): Promise<Result<readonly PickerEntry[], PickerFailure>> {
    await new Promise<void>((resolve) => setTimeout(resolve, request.query === 'old' ? 20 : 1));
    return { ok: true, value: [{ id: request.query, mode: 'command', kind: 'command', label: request.query, detail: '', value: request.query, rootId: undefined, relativePath: undefined, hidden: false, score: 1 }] };
  },
};
const model = new BoundedPickerModel({ providers: [fileProvider, staticProvider], maxResults: 20 });
const oldQuery = model.query('command', 'old');
const newQuery = model.query('command', 'new');
const [oldResult, newResult] = await Promise.all([oldQuery, newQuery]);
assert.equal(oldResult.ok, false, 'T039-FAIL-STALE-01 superseded query cannot publish');
if (!oldResult.ok) assert.equal(oldResult.error.kind, 'stale', 'T039-FAIL-STALE-02 stale generation is explicit');
assert.equal(newResult.ok, true, 'T039-ASYNC-01 latest query publishes');
if (newResult.ok) assert.equal(newResult.value.selectedId, 'new', 'T039-ASYNC-02 selection is stable by item identity');
const external = new CancellationSource();
const cancelled = model.query('command', 'cancelled', { cancellation: external.token });
external.cancel();
const cancelledResult = await cancelled;
assert.equal(cancelledResult.ok, false, 'T039-CANCEL-01 external cancellation stops query');
if (!cancelledResult.ok) assert.equal(cancelledResult.error.kind, 'cancelled', 'T039-CANCEL-02 cancellation has typed outcome');
model.dispose();
index.dispose();
notReady.dispose();

const fileIndex = new FilePathIndex();
assert.equal(fileIndex.addRoot({ id: 'contrib-root', label: 'contrib', path: '/contrib' }).ok, true);
assert.equal(fileIndex.addPaths('contrib-root', [{ rootId: 'contrib-root', relativePath: 'main.ts' }]).ok, true);
fileIndex.markReady();
const commands = new CommandRegistry({ nativeExNames: ['quit', 'write', 'Xi'] });
const contributionHost = {
  read: { read: () => ({ ready: true }) },
  selectionGeneration: 0 as never,
};
const contributions = new ContributionRegistry({ commands, host: contributionHost });
const activation = await contributions.activate(createNavigationContributionModule({
  fileIndex,
  themes: [{ id: 'xi-light', mode: 'theme', label: 'Xi Light' }],
  configs: [{ id: 'config.open', mode: 'config', label: 'Config' }],
}));
assert.equal(activation.ok, true, 'T039-EX05-01 navigation module activates through contribution registry');
assert.ok(commands.snapshot.commands.some((row) => row.descriptor.id === 'files.pick'), 'T039-EX05-02 file picker command is a public contribution');
assert.ok(commands.snapshot.commands.some((row) => row.descriptor.id === 'theme.pick'), 'T039-EX05-03 theme picker command is a public contribution');
assert.ok(commands.snapshot.commands.some((row) => row.descriptor.id === 'config.open'), 'T039-EX05-04 config command is a public contribution');
assert.ok(contributions.snapshot.models.some((row) => row.id === 'xi.navigation.file'), 'T039-EX05-05 file read model is registered publicly');
assert.ok(contributions.snapshot.models.some((row) => row.id === 'xi.navigation.theme'), 'T039-EX05-06 theme read model is registered publicly');
assert.ok(contributions.snapshot.models.some((row) => row.id === 'xi.navigation.config'), 'T039-EX05-07 config read model is registered publicly');
await contributions.dispose();
commands.dispose();
const uiEntries: readonly UiPickerEntry[] = Object.freeze([{ id: 'root-a\u0000shared.ts', mode: 'file', kind: 'file', label: 'src/shared.ts', detail: 'workspace-a', value: '/workspace/a/src/shared.ts', rootId: 'root-a', relativePath: 'src/shared.ts', hidden: false, score: 1 }]);
const uiModel: PickerReadModel = Object.freeze({
  contractVersion: 1, mode: 'file', query: 'shared', generation: 1, state: 'ready',
  entries: uiEntries,
  selectedId: 'root-a\u0000shared.ts', totalMatches: 2, truncated: true, message: undefined,
});
const uiRead: PickerReadPort = {
  model: uiModel,
  subscribe: () => Object.freeze({ dispose() {} }),
};
const uiSetup = await createTestRenderer({ width: 72, height: 8, bufferedOutput: 'memory', gatherStats: true });
const picker = new PickerRenderable(uiSetup.renderer.root.ctx, { picker: uiRead, width: 72, height: 8 });
uiSetup.renderer.root.add(picker);
await uiSetup.renderOnce();
const pickerFrame = uiSetup.captureCharFrame();
assert.match(pickerFrame, /Files/u, 'T039-UI-01 file mode is visible');
assert.match(pickerFrame, /src\/shared\.ts/u, 'T039-UI-02 selected file row is visible');
assert.match(pickerFrame, /2\+ matches/u, 'T039-UI-03 truncation count is textual');
uiSetup.resize(32, 4);
await uiSetup.renderOnce();
assert.match(uiSetup.captureCharFrame(), /Files/u, 'T039-UI-04 compact picker remains readable after resize');
uiSetup.renderer.destroy();
assert.equal(picker.isDestroyed, true, 'T039-UI-05 picker disposal releases renderable');


console.log(`T039 picker passed 50k warm query ${warmMilliseconds.toFixed(2)}ms, duplicate-root identity, Unicode/hidden paths, cancellation/stale generations and contribution consumers`);
