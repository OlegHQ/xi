#!/usr/bin/env bun
// Perf regression coverage for F2-14: scanning an ~8 MiB dirty buffer for search matches must
// not block the event loop in one synchronous pass (the old `buffer.text.split('\n')` plus an
// unbounded match accumulator did exactly that, with no cancellation or yield point). The fix
// walks lines with an indexOf cursor and yields to a macrotask whenever a run of lines has
// consumed more than ~4ms.
//
// A setInterval "watchdog" ticking every 1ms measures the actual max gap between event-loop
// turns while the query runs; a single blocking slice over the whole buffer would show one
// huge gap roughly the size of the whole scan, while the fixed, yielding scan keeps every gap
// bounded near the yield budget.
import assert from 'node:assert/strict';
import { RealtimeSearchService, type SearchBackend, type SearchQuery } from '../../packages/services/search/index';
import type { CancellationToken, Result } from '../../packages/contracts/src/index';

// A backend that never finds disk matches -- this test isolates the dirty-buffer scan path.
const emptyDiskBackend: SearchBackend = {
  async search(_query: SearchQuery, _token: CancellationToken, _generation: number): Promise<Result<readonly [], never>> {
    return { ok: true, value: Object.freeze([]) };
  },
};

async function main(): Promise<void> {
  const TARGET_UTF16_LENGTH = 8 * 1024 * 1024;
  const LINE = 'the quick brown fox jumps over the lazy dog and keeps going\n';
  const repeats = Math.ceil(TARGET_UTF16_LENGTH / LINE.length);
  const text = LINE.repeat(repeats);
  assert.ok(text.length >= TARGET_UTF16_LENGTH, 'sanity: fixture buffer is at least 8 MiB of UTF-16 code units');

  const service = new RealtimeSearchService({ backend: emptyDiskBackend, debounceMilliseconds: 0, defaultLimit: 200 });

  // Warm up the regex/scan/insertTopN hot path on a tiny buffer first: a fresh process's first
  // call into this code pays a one-time JIT-compilation cost that has nothing to do with the
  // scan's own yield discipline, and would otherwise show up as a spurious large watchdog gap.
  service.setBufferSources([{ rootId: 'root', path: 'warm.txt', version: 1, text: LINE.repeat(4) }]);
  await service.query({ rootId: 'root', rootPath: '/workspace', query: 'fox', regex: false, maxResults: 200 });

  service.setBufferSources([{ rootId: 'root', path: 'huge.txt', version: 1, text }]);

  let maxGapMilliseconds = 0;
  let lastTick = performance.now();
  const watchdog = setInterval(() => {
    const now = performance.now();
    maxGapMilliseconds = Math.max(maxGapMilliseconds, now - lastTick);
    lastTick = now;
  }, 1);

  const started = performance.now();
  const result = await service.query({ rootId: 'root', rootPath: '/workspace', query: 'fox', regex: false, maxResults: 200 });
  const elapsedMilliseconds = performance.now() - started;
  clearInterval(watchdog);

  assert.equal(result.ok, true, 'sanity: the query completes successfully');
  if (result.ok) {
    assert.equal(result.value.matches.length, 200, 'sanity: matches are capped at the query limit, not accumulated unbounded');
    assert.ok(result.value.totalMatches >= repeats, 'sanity: totalMatches still counts every match found, not just the capped/kept ones');
  }

  console.log(`T-BUFFER-SCAN-LATENCY 8 MiB dirty-buffer search took ${elapsedMilliseconds.toFixed(1)}ms total, max single event-loop gap ${maxGapMilliseconds.toFixed(2)}ms`);
  // The repository's ordinary-stall budget is 8ms (docs/performance.md); the scan
  // yields every ~2ms (`BUFFER_SCAN_YIELD_BUDGET_MS`), leaving headroom under 8ms for one run of
  // lines plus `setTimeout(resolve, 0)` scheduling jitter, while still catching the old behavior
  // (one synchronous multi-hundred-ms pass with no yield at all).
  assert.ok(maxGapMilliseconds < 8, `F2-14: no synchronous slice of the 8 MiB dirty-buffer scan may exceed the 8ms ordinary-stall budget (max gap ${maxGapMilliseconds.toFixed(2)}ms)`);

  service.dispose();
  console.log('T-BUFFER-SCAN-LATENCY passed: 8 MiB dirty-buffer search yields regularly instead of scanning in one blocking pass (F2-14)');
}

await main();
