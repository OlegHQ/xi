import { strict as assert } from 'node:assert';
import { test } from 'bun:test';
import {
  allocationAccounting,
  captureRuntimeMemory,
  measureRuntimeOperation,
  signedRuntimeDelta,
} from '../../bench/performance/runtime-accounting';

test('runtime sampler preserves signed deltas and separates inclusive JSC fields', () => {
  const before = captureRuntimeMemory();
  const sample = measureRuntimeOperation(() => 'measured');
  const after = captureRuntimeMemory();
  assert.equal(sample.result, 'measured');
  assert.equal(sample.cpuMicros >= 0, true);
  assert.equal(sample.wallMicros >= 0, true);
  assert.equal(sample.signedDeltas.processHeapUsedBytes, sample.after.processHeapUsedBytes - sample.before.processHeapUsedBytes);
  const delta = signedRuntimeDelta(after, before);
  assert.equal(delta.processRssBytes, before.processRssBytes - after.processRssBytes);
  assert.equal(sample.allocation.jscExtraMemoryBytes >= 0, true);
  assert.equal(sample.allocation.totalAllocationBytes.status, 'unsupported');
});

test('allocation accounting does not double count JSC extra memory', () => {
  const memory = captureRuntimeMemory();
  const accounting = allocationAccounting(memory, { count: 1, processRssBytes: 4096, status: 'measured' });
  assert.equal(accounting.jscNativeCommitBytes, memory.jscCurrentCommitBytes);
  assert.equal(accounting.jscExtraMemoryBytes, memory.jscExtraMemoryBytes);
  assert.equal(accounting.processRssBytes, memory.processRssBytes);
  assert.deepEqual(accounting.workers, { count: 1, processRssBytes: 4096, status: 'measured' });
});
