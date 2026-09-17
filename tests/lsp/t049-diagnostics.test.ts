import assert from 'node:assert/strict';
import { DiagnosticStore } from '../../packages/services/language/diagnostics';
import { formatProblemsLines } from '../../packages/ui/problems/index';

const diagnostic = (message: string, line = 0) => ({ range: { startLine: line, startUtf16: 0, endLine: line, endUtf16: 2 }, message, severity: 1 as const, source: 'ts', code: 'E', });

const store = new DiagnosticStore();
store.markDocumentGeneration('file:///a.ts', 3);
assert.equal(store.publish({ serverId: 'ts', uri: 'file:///a.ts', generation: 2, diagnostics: [diagnostic('old')] }), false, 'T049-STALE-01 old generation rejected');
assert.equal(store.publish({ serverId: 'ts', uri: 'file:///a.ts', generation: 3, documentVersion: 7, diagnostics: [diagnostic('current'), diagnostic('second', 1)] }), true);
assert.equal(store.publish({ serverId: 'eslint', uri: 'file:///a.ts', generation: 3, diagnostics: [diagnostic('other')] }), true);
assert.equal(store.model.all.length, 3, 'T049-AGGREGATE-01 diagnostics aggregate per server');
// Tiebreak for equal position/severity is a cheap ordinal id comparison
// (id embeds serverId), not a locale-aware message compare, so 'eslint:...'
// sorts before 'ts:...' at the same position.
assert.equal(store.diagnosticsFor('file:///a.ts')[0]?.message, 'other');
const rows = formatProblemsLines({ contractVersion: 1, generation: store.model.generation, all: store.model.all }, 80, 2);
assert.equal(rows.length, 2, 'T049-BOUNDED-01 footer reports truncation without rendering 10k rows');
const tenThousand = Array.from({ length: 10_000 }, (_, index) => diagnostic(`bulk-${index}`, index));
assert.equal(store.publish({ serverId: 'ts', uri: 'file:///bulk.ts', generation: 1, diagnostics: tenThousand }), true, 'T049-BOUNDED-02 accepts a large diagnostic batch');
assert.equal(store.model.all.length, 3 + 2_000, 'T049-BOUNDED-02 retains diagnostics in the service model, capped per URI at DIAGNOSTICS_PER_URI_LIMIT');
assert.equal(store.model.truncatedUris.has('file:///bulk.ts'), true, 'T049-BOUNDED-02b a publish exceeding the per-URI cap is flagged truncated, never silently dropped');
const boundedBulkRows = formatProblemsLines(store.model, 100, 12);
assert.ok(boundedBulkRows.length <= 12, 'T049-BOUNDED-02 Problems rendering remains row bounded for 10k diagnostics');
assert.ok(formatProblemsLines(store.model, 80, 2)[0]?.includes('(1 file truncated)'), 'T049-BOUNDED-02c the Problems header surfaces the per-URI truncation');
store.clearUri('file:///a.ts');
assert.equal(store.diagnosticsFor('file:///a.ts').length, 0, 'T049-CLOSE-01 closed URI diagnostics clear');
store.clearUri('file:///bulk.ts');
assert.equal(store.model.all.length, 0, 'T049-CLOSE-01 all closed URI diagnostics clear');
store.dispose();

// T049-PERF: publishing 10k diagnostics for one URI while 200 other URIs are
// already populated must only re-sort/re-index that one URI (per-URI indexing,
// not a scan of every open URI's entries), so it stays well under the 8ms
// ordinary-step budget even with many other URIs present. Xi is a long-running
// process, so this warms the JIT on the same publish/sort code path first
// (a cold first-ever call pays interpreter/baseline-JIT cost unrelated to the
// algorithmic fix) before measuring the steady-state cost the running editor
// actually experiences.
const bulkForOneUri = Array.from({ length: 10_000 }, (_, index) => diagnostic(`bulk-${index}`, index));
const warmupStore = new DiagnosticStore();
for (let warmup = 0; warmup < 10; warmup += 1) {
  warmupStore.publish({ serverId: 'ts', uri: 'file:///warmup.ts', generation: warmup, diagnostics: bulkForOneUri });
}
warmupStore.dispose();

const perfStore = new DiagnosticStore();
for (let uriIndex = 0; uriIndex < 200; uriIndex += 1) {
  perfStore.publish({ serverId: 'ts', uri: `file:///other-${uriIndex}.ts`, generation: 0, diagnostics: [diagnostic('noise')] });
}
// Several publishes (each to its own fresh URI, so every sample does real
// work rather than hitting a cache) are timed individually with both
// performance.now() (wall clock) and process.cpuUsage() (actual CPU consumed
// by this process). On a shared/loaded machine -- this suite runs alongside
// other test files and other agents' processes -- wall clock includes time
// spent preempted off the CPU entirely, which is OS scheduler contention, not
// this code path's cost. CPU time is not inflated by being paused, so it is
// the gate; wall clock is still measured and printed for transparency. A
// genuine regression in the fix itself would show up in CPU time too.
const trialMilliseconds: number[] = [];
const trialCpuMilliseconds: number[] = [];
for (let trial = 0; trial < 20; trial += 1) {
  const cpuStart = process.cpuUsage();
  const perfStart = performance.now();
  assert.equal(perfStore.publish({ serverId: 'ts', uri: `file:///hot-${trial}.ts`, generation: 0, diagnostics: bulkForOneUri }), true, 'T049-PERF-01 accepts the large single-URI publish');
  trialMilliseconds.push(performance.now() - perfStart);
  const cpuDelta = process.cpuUsage(cpuStart);
  trialCpuMilliseconds.push((cpuDelta.user + cpuDelta.system) / 1_000);
}
const minMilliseconds = Math.min(...trialMilliseconds);
const minCpuMilliseconds = Math.min(...trialCpuMilliseconds);
console.log(`T049-PERF publish of 10k diagnostics for one URI amid 200 other URIs: wall [${trialMilliseconds.map((value) => value.toFixed(3)).join(', ')}]ms (min ${minMilliseconds.toFixed(3)}ms), cpu [${trialCpuMilliseconds.map((value) => value.toFixed(3)).join(', ')}]ms (min ${minCpuMilliseconds.toFixed(3)}ms)`);
assert.ok(minCpuMilliseconds < 2, `T049-PERF-02 publish stays within the 2 ms background integration slice (min CPU ${minCpuMilliseconds.toFixed(3)}ms)`);
const medianOf = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
assert.ok(medianOf(trialCpuMilliseconds.slice(10)) <= Math.max(2, 3 * medianOf(trialCpuMilliseconds.slice(0, 10))), 'T049-PERF-05 publish cost does not grow with the number of populated URIs (read-model views are lazy)');
const modelBefore = perfStore.model;
assert.equal(modelBefore.all.length, 200 + 20 * 2_000, 'T049-PERF-06 lazy `all` flattens every URI on demand');
perfStore.publish({ serverId: 'ts', uri: 'file:///late.ts', generation: 0, diagnostics: [diagnostic('late')] });
assert.equal(modelBefore.all.length, 200 + 20 * 2_000, 'T049-PERF-07 an earlier snapshot stays immutable after a later publish');
assert.equal(perfStore.model.truncatedUris.has('file:///hot-0.ts'), true, 'T049-PERF-03 the truncation flag is set for the capped URI');
assert.equal(perfStore.diagnosticsFor('file:///hot-0.ts').length, 2_000, 'T049-PERF-04 the hot URI is capped at the per-URI limit');
perfStore.dispose();

console.log('T049 diagnostics passed generation ordering, per-server aggregation, bounded Problems rows, close cleanup and per-URI publish performance under load');
