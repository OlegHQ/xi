#!/usr/bin/env bun
/** Diagnostic T114 probe; coordinator accounting and lifecycle only. */
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  WorkbenchResourceCoordinator,
  largeResourceProfile,
} from '../../packages/workbench/src/index';
import { captureRuntimeMemory } from './runtime-accounting';
import type { ResourceStats } from '../../packages/contracts/src/index';

const artifactPath = resolve('.artifacts/performance/T114/pf10-workbench-resources-diagnostic.json');
await mkdir(resolve('.artifacts/performance/T114'), { recursive: true });

const before = captureRuntimeMemory();
const coordinator = new WorkbenchResourceCoordinator({ capacityBytes: 16 * 1024 * 1024, pressureRatio: 0.8 });
const lifecycleStarted = performance.now();
for (let cycle = 0; cycle < 1_000; cycle += 1) {
  const lease = coordinator.admit({
    owner: 'config',
    kind: 'retained',
    bytes: 4 * 1024,
    priority: 'background',
    reclaimable: true,
  });
  if (!lease.ok) throw new Error(`lifecycle admission failed: ${lease.error.kind}`);
  lease.value.dispose();
}
const lifecycleMilliseconds = performance.now() - lifecycleStarted;

const evicted: string[] = [];
const live = coordinator.admit({ owner: 'document', kind: 'retained', bytes: 12 * 1024 * 1024, priority: 'live' });
if (!live.ok) throw new Error(`live admission failed: ${live.error.kind}`);
const cache = coordinator.admit({ owner: 'language', kind: 'retained', bytes: 1 * 1024 * 1024, priority: 'speculative', reclaimable: true, onEvict: () => evicted.push('speculative') });
if (!cache.ok) throw new Error(`cache admission failed: ${cache.error.kind}`);
const frame = coordinator.admit({ owner: 'layout', kind: 'retained', bytes: 1 * 1024 * 1024, priority: 'interactive', reclaimable: true, onEvict: () => evicted.push('interactive') });
if (!frame.ok) throw new Error(`frame admission failed: ${frame.error.kind}`);
const afterPressure = coordinator.stats();
const external = coordinator.admitExternal('language-server', 256 * 1024, 'diagnostic-external-rss');
if (!external.ok) throw new Error(`external admission failed: ${external.error.kind}`);
const afterExternal = coordinator.stats();
const profile = largeResourceProfile(100 * 1024 * 1024);
const after = captureRuntimeMemory();

const result = {
  diagnosticOnly: true,
  fixture: 'PF10-workbench-resource-coordinator',
  host: { platform: process.platform, architecture: process.arch, bun: Bun.version },
  lifecycle: { cycles: 1_000, milliseconds: lifecycleMilliseconds },
  pressure: { evicted, stats: serialiseStats(afterPressure) },
  external: { stats: serialiseStats(afterExternal) },
  profile,
  runtime: {
    rssBeforeBytes: before.processRssBytes,
    rssAfterBytes: after.processRssBytes,
    heapBeforeBytes: before.processHeapUsedBytes,
    heapAfterBytes: after.processHeapUsedBytes,
  },
  note: 'single shared-host diagnostic; production service wiring, native renderer/workers, external process CPU/RSS, stabilized retention and 30-trial PF10 qualification remain unmeasured',
};
await Bun.write(artifactPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ ...result, artifactPath }));
coordinator.dispose();

function serialiseStats(stats: ResourceStats): object {
  return { ...stats, owners: [...stats.owners.values()] };
}
