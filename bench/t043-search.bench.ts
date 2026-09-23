#!/usr/bin/env bun
/** Measure the production workspace-search boundary, including debounce and rg. */
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeProcessPort } from '../packages/platform/src/index';
import { RealtimeSearchService, RipgrepSearchBackend, type SearchReadModel } from '../packages/services/src/entrypoints/launch';

const samples = 30;
const root = await mkdtemp(join(tmpdir(), 'xi-t043-bench-'));
await mkdir(join(root, 'src'), { recursive: true });
await Promise.all(Array.from({ length: 240 }, (_, index) => writeFile(
  join(root, 'src', `search-${index}.txt`),
  index === 0
    ? Array.from({ length: 30 }, (_, queryIndex) => `${'context '.repeat(12)}needle-${queryIndex}`).join('\n') + '\n'
    : `${'context '.repeat(12)}\n`,
  'utf8',
)));

const environment: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined) environment[key] = value;
const service = new RealtimeSearchService({
  backend: new RipgrepSearchBackend({ process: new NodeProcessPort(), environment }),
  debounceMilliseconds: 5,
  defaultLimit: 10_000,
});
const request = (query: string) => ({ rootId: 'workspace', rootPath: root, query, includeHidden: true, maxResults: 10_000 });
const firstResultSamples: number[] = [];
const cpuSamples: number[] = [];
const cancellationSamples: number[] = [];
let lastModel: SearchReadModel = service.model;
const subscription = service.subscribe((model) => { lastModel = model; });

try {
 for (let index = 0; index < 3; index += 1) {
  const warm = await service.query(request(`needle-${index}`));
  if (!warm.ok) throw new Error(`T043 warmup failed: ${warm.error.kind}`);
}

 for (let index = 0; index < samples; index += 1) {
  const beforeCpu = process.cpuUsage();
  const started = performance.now();
  const searchText = `needle-${index}`;
  const generation = service.model.generation + 1;
  let resolveFirst!: (elapsed: number) => void;
  const first = new Promise<number>((resolve) => { resolveFirst = resolve; });
  const firstSubscription = service.subscribe((model) => {
    if (model.generation !== generation || model.query.query !== searchText) return;
    if (model.matches.some((match) => match.lineText.includes(searchText))) resolveFirst(performance.now() - started);
  });
  const pending = service.query(request(searchText));
  const elapsed = await Promise.race([first, pending.then(() => performance.now() - started)]);
  const result = await pending;
  firstSubscription.dispose();
  const afterCpu = process.cpuUsage(beforeCpu);
  if (!result.ok || result.value.state !== 'ready' || result.value.matches.length === 0) throw new Error('T043 first-result workload returned no ready matches');
  firstResultSamples.push(elapsed);
  cpuSamples.push((afterCpu.user + afterCpu.system) / 1_000);
}

for (let index = 0; index < samples; index += 1) {
  const pending = service.query(request('needle'));
  await new Promise<void>((resolve) => setTimeout(resolve, 45));
  const started = performance.now();
  service.cancel();
  while (lastModel.state !== 'stale' && lastModel.state !== 'idle') await new Promise<void>((resolve) => setTimeout(resolve, 1));
  cancellationSamples.push(performance.now() - started);
  await pending;
}

} finally {
  subscription.dispose();
  service.dispose();
}

const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
};
const memory = process.memoryUsage();
const report = {
  schemaVersion: 1,
  ticket: 'T043',
  fixture: 'T043-PRODUCTION-SEARCH-01',
  environment: { platform: process.platform, architecture: process.arch, bun: Bun.version, rg: 'argv/ripgrep-json', cpuAffinity: process.env.XI_BENCH_CPU_AFFINITY ?? 'uncontrolled' },
  workload: { root, files: 240, matchingFilesPerQuery: 1, measuredSamples: samples, debounceMilliseconds: 5 },
  firstResultMilliseconds: { p50: percentile(firstResultSamples, 0.5), p95: percentile(firstResultSamples, 0.95), p99: percentile(firstResultSamples, 0.99), max: Math.max(...firstResultSamples), samples: firstResultSamples },
  cancellationMilliseconds: { p50: percentile(cancellationSamples, 0.5), p95: percentile(cancellationSamples, 0.95), p99: percentile(cancellationSamples, 0.99), max: Math.max(...cancellationSamples) },
  parentCpuMilliseconds: { p50: percentile(cpuSamples, 0.5), p95: percentile(cpuSamples, 0.95), max: Math.max(...cpuSamples) },
  parentMemoryBytes: { rss: memory.rss, heapUsed: memory.heapUsed },
  budgets: { firstResultP95Milliseconds: 100, cancellationP95Milliseconds: 50 },
};
console.log(JSON.stringify(report, null, 2));
if (report.firstResultMilliseconds.p95 > report.budgets.firstResultP95Milliseconds) throw new Error('T043 warm first-result p95 budget failed');
if (report.cancellationMilliseconds.p95 > report.budgets.cancellationP95Milliseconds) throw new Error('T043 cancellation p95 budget failed');
