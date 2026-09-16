#!/usr/bin/env bun
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { cpus, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asIdentifier, type DocumentId, type DocumentVersion, type Utf16Offset } from '../../packages/primitives/src/index';
import { RopeDocument } from '../../packages/document/src/rope';

const operationCount = 100_000;
const initialText = 'a'.repeat(8192);
const expectedHash = '39e8e9fdf7d3e87aee21b8a8ab56670f99fe8887bc6c9b9d0118b4a6e9afbb27';
const idResult = asIdentifier<DocumentId>('T009-FC-T004-FRAGMENT-01', 'documentId');
if (!idResult.ok) throw new Error(idResult.error.message);
if (process.platform !== 'linux' || process.arch !== 'arm64') throw new Error('T009 memory gate requires the pinned Linux ARM64 environment');
const latencyDocument = openDocument(idResult.value);
const latency = runMiddleInsertTrace(latencyDocument);
const memoryProbe = await runMemoryProbe();
if (memoryProbe.finalUtf16Length !== 108_192 || memoryProbe.finalSha256 !== expectedHash) {
  throw new Error(`FC-T004-FRAGMENT-01 output mismatch length=${memoryProbe.finalUtf16Length} hash=${memoryProbe.finalSha256}`);
}
const budget = {
  maximumLiveChunks: 2048,
  maximumHeapRetainedGrowthBytes: 4 * 1024 * 1024,
  maximumRssGrowthBytes: 80 * 1024 * 1024,
};
const report = {
  schemaVersion: 1,
  ticket: 'T009',
  fixture: 'FC-T004-FRAGMENT-01',
  fixtureSet: 'T004-v1',
  seed: 41027,
  environment: {
    platform: process.platform,
    architecture: process.arch,
    kernel: release(),
    bun: process.versions.bun ?? 'unknown',
    cpuModel: cpus()[0]?.model.trim() || 'not exposed',
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    terminal: 'not applicable; in-process document storage benchmark',
  },
  workload: {
    initialUtf16Length: initialText.length,
    operations: operationCount,
    operation: 'insert one ASCII unit at floor(currentLength/2), no undo roots retained',
    expectedUtf16Length: 108_192,
    observedUtf16Length: memoryProbe.finalUtf16Length,
    expectedSha256: expectedHash,
    observedSha256: memoryProbe.finalSha256,
  },
  structural: {
    liveChunks: memoryProbe.liveChunks,
    maximumChunkUtf16: memoryProbe.maximumChunkUtf16,
    treapHeight: memoryProbe.treeHeight,
    lineBreaks: memoryProbe.lineBreaks,
  },
  memory: {
    heapBeforeBytes: memoryProbe.heapBeforeBytes,
    heapAfterBytes: memoryProbe.heapAfterBytes,
    heapRetainedGrowthBytes: memoryProbe.heapRetainedGrowthBytes,
    rssBeforeBytes: memoryProbe.rssBeforeBytes,
    rssAfterBytes: memoryProbe.rssAfterBytes,
    rssGrowthBytes: memoryProbe.rssGrowthBytes,
  },
  latencyMicroseconds: latency,
  budget,
  result: {
    fragmentHashMatches: memoryProbe.finalSha256 === expectedHash,
    chunkBudgetPassed: memoryProbe.liveChunks <= budget.maximumLiveChunks,
    heapBudgetPassed: memoryProbe.heapRetainedGrowthBytes <= budget.maximumHeapRetainedGrowthBytes,
    rssBudgetPassed: memoryProbe.rssGrowthBytes <= budget.maximumRssGrowthBytes,
  },
};

const artifactPath = resolve(fileURLToPath(new URL('../../.artifacts/document/T009-results.json', import.meta.url)));
await mkdir(dirname(artifactPath), { recursive: true });
await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
console.log(`artifact=${artifactPath}`);
if (!report.result.chunkBudgetPassed || !report.result.heapBudgetPassed || !report.result.rssBudgetPassed) {
  throw new Error('FC-T004-FRAGMENT-01 production rope resource budget failed');
}

function runMiddleInsertTrace(model: RopeDocument): { readonly samples: number; readonly p50: number; readonly p95: number; readonly p99: number; readonly max: number } {
  const durations: number[] = [];
  let version: DocumentVersion = model.snapshot().version;
  let length = model.metrics().utf16Length;
  for (let operation = 0; operation < operationCount; operation += 1) {
    const startTime = process.hrtime.bigint();
    const center = Math.floor(length / 2);
    const result = model.apply({ start: offset(center), end: offset(center), text: 'x' }, version);
    if (!result.ok) throw new Error(`middle-insert-failed:${result.error.kind}:${operation}`);
    version = result.value;
    length += 1;
    durations.push(Number(process.hrtime.bigint() - startTime) / 1000);
  }
  const sorted = [...durations].sort((left, right) => left - right);
  const at = (fraction: number): number => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  const result = { samples: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? 0 };
  durations.length = 0;
  sorted.length = 0;
  return result;
}

function offset(value: number): Utf16Offset { return value as Utf16Offset; }

function openDocument(id: DocumentId): RopeDocument {
  const opened = RopeDocument.create(id, initialText, 41027);
  if (!opened.ok) throw new Error(`document-open-failed:${opened.error.kind}`);
  return opened.value;
}

interface ProbeResult {
  readonly finalUtf16Length: number;
  readonly finalSha256: string;
  readonly liveChunks: number;
  readonly maximumChunkUtf16: number;
  readonly treeHeight: number;
  readonly lineBreaks: number;
  readonly heapBeforeBytes: number;
  readonly heapAfterBytes: number;
  readonly heapRetainedGrowthBytes: number;
  readonly rssBeforeBytes: number;
  readonly rssAfterBytes: number;
  readonly rssGrowthBytes: number;
}

async function runMemoryProbe(): Promise<ProbeResult> {
  const scriptPath = fileURLToPath(new URL('./t009-fragmentation-probe.ts', import.meta.url));
  const output = await new Promise<string>((resolveOutput, rejectOutput) => {
    const child = spawn(process.execPath, [scriptPath], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', rejectOutput);
    child.once('close', (code, signal) => {
      if (code !== 0) rejectOutput(new Error(`T009 memory probe failed code=${String(code)} signal=${String(signal)} stderr=${stderr.slice(-4000)}`));
      else resolveOutput(stdout);
    });
  });
  let unknown: unknown;
  try { unknown = JSON.parse(output) as unknown; }
  catch (error: unknown) { throw new Error('T009 memory probe returned invalid JSON', { cause: error }); }
  if (!isRecord(unknown)) throw new Error('T009 memory probe returned a non-object result');
  return {
    finalUtf16Length: requiredNumber(unknown, 'finalUtf16Length'),
    finalSha256: requiredString(unknown, 'finalSha256'),
    liveChunks: requiredNumber(unknown, 'liveChunks'),
    maximumChunkUtf16: requiredNumber(unknown, 'maximumChunkUtf16'),
    treeHeight: requiredNumber(unknown, 'treeHeight'),
    lineBreaks: requiredNumber(unknown, 'lineBreaks'),
    heapBeforeBytes: requiredNumber(unknown, 'heapBeforeBytes'),
    heapAfterBytes: requiredNumber(unknown, 'heapAfterBytes'),
    heapRetainedGrowthBytes: requiredNumber(unknown, 'heapRetainedGrowthBytes'),
    rssBeforeBytes: requiredNumber(unknown, 'rssBeforeBytes'),
    rssAfterBytes: requiredNumber(unknown, 'rssAfterBytes'),
    rssGrowthBytes: requiredNumber(unknown, 'rssGrowthBytes'),
  };
}

function requiredNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`T009 memory probe field ${field} is invalid`);
  return value;
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`T009 memory probe field ${field} is invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
