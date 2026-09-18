#!/usr/bin/env bun
// Regression for T043: the first publish of a search run used to go through the same
// `setTimeout(0)` coalescing hop as every later batch (`schedulePublish` in
// packages/services/search/index.ts), even though there was nothing yet to coalesce it
// with. That extra macrotask hop, plus the 40ms debounce, pushed first-result latency past
// the T043 100ms p95 budget. The fix publishes the very first batch of a run synchronously,
// inline with the backend's `onBatch` call, and only coalesces subsequent batches within the
// same run behind the timer.
//
// This is verified deterministically (no timing/flakiness): a fake backend calls `onBatch`
// synchronously, before any `await`, and the test asserts the read model already reflects
// that batch by the time `onBatch` returns control -- which is only possible if the publish
// happened as a direct function call, not via a queued timer (a timer callback cannot run
// until the current synchronous stack, including this backend call, finishes).
import assert from 'node:assert/strict';
import { RealtimeSearchService, type SearchBackend, type SearchMatch, type SearchQuery } from '../../packages/services/search/index';
import type { CancellationToken, Result } from '../../packages/contracts/src/index';

function match(id: string): SearchMatch {
  return Object.freeze({
    id, rootId: 'root', path: `${id}.txt`, line: 0,
    range: Object.freeze({ startUtf16: 0, endUtf16: 1 }), lineText: 'x', snippet: 'x',
    source: 'disk', generation: 1,
  });
}

async function main(): Promise<void> {
  let sawSynchronousFirstPublish = false;
  let secondBatchResolve!: () => void;
  const backend: SearchBackend = {
    async search(_query: SearchQuery, _token: CancellationToken, _generation: number, onBatch?: (matches: readonly SearchMatch[]) => void): Promise<Result<readonly SearchMatch[], never>> {
      const first = match('a');
      onBatch?.([first]);
      // Assert INSIDE the synchronous call stack of the first onBatch: if the first publish
      // were still scheduled via setTimeout(0), the model would not yet reflect it here,
      // because that timer callback cannot run until this whole synchronous function body
      // (still executing) yields back to the event loop.
      sawSynchronousFirstPublish = service.model.matches.some((candidate) => candidate.id === 'a');
      await new Promise<void>((resolve) => { secondBatchResolve = resolve; });
      const second = match('b');
      onBatch?.([second]);
      return { ok: true, value: [first, second] };
    },
  };
  const service = new RealtimeSearchService({ backend, debounceMilliseconds: 0 });
  const publishedMatchCounts: number[] = [];
  service.subscribe((model) => { publishedMatchCounts.push(model.matches.length); });

  const pending = service.query({ rootId: 'root', rootPath: '/workspace', query: 'needle' });
  // Let the (0ms) debounce timer fire and the backend run up to its first await.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sawSynchronousFirstPublish, true, 'T043-FIRST-PUBLISH-01: first batch must publish synchronously, not via a queued timer');
  assert.ok(publishedMatchCounts.includes(1), `T043-FIRST-PUBLISH-01: read model must have published the first batch already, got ${JSON.stringify(publishedMatchCounts)}`);

  secondBatchResolve();
  const result = await pending;
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.matches.length, 2, 'sanity: both batches are present in the final model');

  service.dispose();
  console.log('T043-FIRST-PUBLISH-01 passed: first search-result batch publishes synchronously, no coalescing timer on the critical path');
}

await main();
