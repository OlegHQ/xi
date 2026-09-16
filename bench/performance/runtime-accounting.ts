import { heapStats, memoryUsage as jscMemoryUsage } from 'bun:jsc';

export interface RuntimeMemorySnapshot {
  readonly processRssBytes: number;
  readonly processHeapUsedBytes: number;
  readonly processExternalBytes: number;
  readonly processArrayBufferBytes: number;
  readonly jscLiveHeapBytes: number;
  readonly jscHeapCapacityBytes: number;
  /** JSC's inclusive external/ArrayBuffer accounting; do not add to heap size. */
  readonly jscExtraMemoryBytes: number;
  readonly jscCurrentCommitBytes: number;
  readonly jscPeakCommitBytes: number;
  readonly maxRssKiB: number;
}

export interface RuntimeMemoryDeltas {
  readonly processRssBytes: number;
  readonly processHeapUsedBytes: number;
  readonly processExternalBytes: number;
  readonly processArrayBufferBytes: number;
  readonly jscLiveHeapBytes: number;
  readonly jscHeapCapacityBytes: number;
  readonly jscExtraMemoryBytes: number;
  readonly jscCurrentCommitBytes: number;
  readonly jscPeakCommitBytes: number;
  readonly maxRssKiB: number;
}

export interface WorkerAccounting {
  readonly count: number;
  readonly processRssBytes: number;
  readonly status: 'measured' | 'no-worker-in-operation' | 'unsupported';
}

export interface TotalAllocationAccounting {
  readonly status: 'measured' | 'unsupported';
  readonly reason?: string;
  readonly bytes?: number;
}

export interface AllocationAccounting {
  readonly wrapperCounters: {
    readonly status: 'measured' | 'unsupported';
    readonly bytes?: number;
    readonly reason?: string;
  };
  readonly jscLiveHeapBytes: number;
  readonly jscExtraMemoryBytes: number;
  readonly jscNativeCommitBytes: number;
  readonly processRssBytes: number;
  readonly workers: WorkerAccounting;
  readonly totalAllocationBytes: TotalAllocationAccounting;
}

export interface RuntimeOperationSample<T> {
  readonly result: T;
  readonly wallMicros: number;
  readonly cpuMicros: number;
  readonly before: RuntimeMemorySnapshot;
  readonly after: RuntimeMemorySnapshot;
  readonly signedDeltas: RuntimeMemoryDeltas;
  readonly allocation: AllocationAccounting;
}

export function captureRuntimeMemory(): RuntimeMemorySnapshot {
  const processMemory = process.memoryUsage();
  const jsc = heapStats();
  const jscMemory = jscMemoryUsage();
  return {
    processRssBytes: processMemory.rss,
    processHeapUsedBytes: processMemory.heapUsed,
    processExternalBytes: processMemory.external,
    processArrayBufferBytes: processMemory.arrayBuffers,
    jscLiveHeapBytes: jsc.heapSize,
    jscHeapCapacityBytes: jsc.heapCapacity,
    jscExtraMemoryBytes: jsc.extraMemorySize,
    jscCurrentCommitBytes: jscMemory.currentCommit,
    jscPeakCommitBytes: jscMemory.peakCommit,
    maxRssKiB: process.resourceUsage().maxRSS,
  };
}

export function signedRuntimeDelta(
  before: RuntimeMemorySnapshot,
  after: RuntimeMemorySnapshot,
): RuntimeMemoryDeltas {
  return {
    processRssBytes: after.processRssBytes - before.processRssBytes,
    processHeapUsedBytes: after.processHeapUsedBytes - before.processHeapUsedBytes,
    processExternalBytes: after.processExternalBytes - before.processExternalBytes,
    processArrayBufferBytes: after.processArrayBufferBytes - before.processArrayBufferBytes,
    jscLiveHeapBytes: after.jscLiveHeapBytes - before.jscLiveHeapBytes,
    jscHeapCapacityBytes: after.jscHeapCapacityBytes - before.jscHeapCapacityBytes,
    jscExtraMemoryBytes: after.jscExtraMemoryBytes - before.jscExtraMemoryBytes,
    jscCurrentCommitBytes: after.jscCurrentCommitBytes - before.jscCurrentCommitBytes,
    jscPeakCommitBytes: after.jscPeakCommitBytes - before.jscPeakCommitBytes,
    maxRssKiB: after.maxRssKiB - before.maxRssKiB,
  };
}

export function measureRuntimeOperation<T>(
  operation: () => T,
  workers: WorkerAccounting = { count: 0, processRssBytes: 0, status: 'no-worker-in-operation' },
): RuntimeOperationSample<T> {
  const before = captureRuntimeMemory();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  let result: T | undefined;
  let failure: unknown;
  let failed = false;
  let after = before;
  try {
    result = operation();
  } catch (error: unknown) {
    failed = true;
    failure = error;
  } finally {
    after = captureRuntimeMemory();
  }
  const cpu = process.cpuUsage(cpuBefore);
  if (failed) throw failure;
  return {
    result: result as T,
    wallMicros: Math.round((performance.now() - started) * 1000),
    cpuMicros: cpu.user + cpu.system,
    before,
    after,
    signedDeltas: signedRuntimeDelta(before, after),
    allocation: allocationAccounting(after, workers),
  };
}

export function allocationAccounting(
  after: RuntimeMemorySnapshot,
  workers: WorkerAccounting = { count: 0, processRssBytes: 0, status: 'no-worker-in-operation' },
): AllocationAccounting {
  return {
    wrapperCounters: {
      status: 'unsupported',
      reason: 'document operation exposes no allocation counter',
    },
    jscLiveHeapBytes: after.jscLiveHeapBytes,
    jscExtraMemoryBytes: after.jscExtraMemoryBytes,
    jscNativeCommitBytes: after.jscCurrentCommitBytes,
    processRssBytes: after.processRssBytes,
    workers,
    totalAllocationBytes: {
      status: 'unsupported',
      reason: 'pinned Bun/JSC API exposes live and peak state, not total allocation',
    },
  };
}
