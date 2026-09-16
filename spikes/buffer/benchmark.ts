#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { candidates, type CandidateDefinition } from './adapter';
import { createCorpora, nowNanoseconds, quantiles, safeBoundary, seededRandom, sha256, t004Seed } from './corpora';
import { createBatchEdits, runCandidateChecks, verifyBatchReference } from './checks';
import { applyReference, mapAnchors, type TextAnchor, type TextEdit } from './model';

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const artifactsDirectory = resolve(projectRoot, '.artifacts/buffer');
const fixturePath = resolve(projectRoot, 'bench/fixtures/T004-traces.json');
const fixtureManifest: unknown = JSON.parse(await readFile(fixturePath, 'utf8'));
if (!isRecord(fixtureManifest) || fixtureManifest.schemaVersion !== 1 || fixtureManifest.seed !== t004Seed) {
  throw new Error('invalid-t004-fixture-manifest');
}
assert.deepEqual(entryIds(fixtureManifest, 'corpora'), ['T004-LONG-1M', 'T004-BATCH-1M', 'T004-UNICODE-2K', 'T004-MIDDLE-SEED']);
assert.deepEqual(entryIds(fixtureManifest, 'traces'), ['T004-REF-250', 'T004-SMALL-10K', 'T004-MIDDLE-100K', 'T004-BATCH-1-10K', 'T004-ANCHOR-1-10K', 'T004-UNDO-1K', 'T004-CANCEL-10K']);
assert.deepEqual(entryIds(fixtureManifest, 'failureFixtures'), ['FC-T004-SURROGATE-01', 'FC-T004-CANCEL-01', 'FC-T004-FRAGMENT-01']);
const fragmentationFixture = entryById(fixtureManifest, 'failureFixtures', 'FC-T004-FRAGMENT-01');
const expectedFragmentationLength = requiredNumber(fragmentationFixture, 'expectedUtf16Length');
const expectedFragmentationSha256 = requiredString(fragmentationFixture, 'expectedSha256');
if (expectedFragmentationLength !== 108_192 || expectedFragmentationSha256 !== '39e8e9fdf7d3e87aee21b8a8ab56670f99fe8887bc6c9b9d0118b4a6e9afbb27') {
  throw new Error('invalid-middle-insert-reference-result');
}

const corpora = createCorpora();
const corpusHashes = {
  longLine: sha256(corpora.longLine),
  batchText: sha256(corpora.batchText),
  unicodeText: sha256(corpora.unicodeText),
  fragmentationSeed: sha256(corpora.fragmentationSeed),
};
const candidateChecks = candidates.map((candidate) => runCandidateChecks(candidate, corpora.unicodeText));
console.log(`reference_checks=pass candidates=${candidateChecks.map((check) => check.candidateId).join(',')}`);
console.log(`failure_fixtures=FC-T004-SURROGATE-01,FC-T004-CANCEL-01,FC-T004-FRAGMENT-01`);
const detectedCpuModel = cpus()[0]?.model.trim();

const candidateBatchMeasurements = candidates.map((candidate) => measureBatchAndCancellation(candidate, corpora.batchText));
const anchorMeasurements = measureAnchors(corpora.batchText);
const performance: Record<string, CandidatePerformance> = {};
for (const candidate of candidates) {
  const measurement = await measureCandidate(candidate, corpora.longLine, corpora.batchText, corpora.unicodeText, corpora.fragmentationSeed);
  performance[candidate.id] = measurement;
  console.log(`${candidate.id} single_edit_pair_us_p95=${formatQuantile(measurement.singleEditRoundTrip.p95)} p99=${formatQuantile(measurement.singleEditRoundTrip.p99)} fragment_100k_ms=${formatMilliseconds(measurement.middleInsert100k.latency.max / 1000)}`);
}

const report = {
  schemaVersion: 1,
  ticket: 'T004',
  fixtureSet: 'T004-v1',
  seed: t004Seed,
  environment: {
    platform: process.platform,
    architecture: process.arch,
    kernel: release(),
    runtime: process.version,
    bun: process.versions.bun ?? 'unknown',
    cpuModel: detectedCpuModel === undefined || detectedCpuModel.length === 0 || detectedCpuModel === 'unknown'
      ? 'not exposed by kernel (virtual host)'
      : detectedCpuModel,
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    locale: process.env.LC_ALL ?? process.env.LANG ?? 'unknown',
    terminal: 'not applicable; in-process data structure benchmark',
  },
  fixtureHashes: corpusHashes,
  validation: {
    referenceChecks: candidateChecks,
    batchWorkloads: candidateBatchMeasurements.map((measurement) => ({ candidateId: measurement.candidateId, batch: measurement.batch })),
    anchorMapping: anchorMeasurements,
    cancellation: candidateBatchMeasurements.map((measurement) => ({ candidateId: measurement.candidateId, result: measurement.cancellation })),
  },
  performance,
  methodology: {
    timingUnit: 'microseconds unless named otherwise',
    percentiles: 'nearest-rank p50/p95/p99/max over independent operation samples; no shared-runner release claim',
    memory: 'fresh Bun child per candidate; corpus exists before baseline; compare process RSS and JS heap after two forced GC points while candidate roots remain live; retained node/payload counts are structural and runtime-independent',
    persistence: 'both spikes use deterministic persistent implicit treaps with subtree UTF-16 and LF aggregates; piece-tree leaves reference original/insert chunks, rope leaves own bounded text chunks',
    batch: 'edits use one base version, are checked before preparation, applied from high to low offset and publish one new version only after success',
    anchorMap: 'anchors and edits are sorted once when needed, then transformed in one sweep; instrumented anchor/edit advancement counts are retained',
  },
};

await mkdir(artifactsDirectory, { recursive: true });
const resultPath = join(artifactsDirectory, 'T004-results.json');
await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`fixture_hashes=${JSON.stringify(corpusHashes)}`);
console.log(`results=${resultPath}`);

interface QuantileSummary {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

interface MemoryProbe {
  readonly batch: {
    readonly heapRetainedDeltaBytes: number;
    readonly rssRetainedDeltaBytes: number;
    readonly retainedNodes: number;
    readonly retainedPayloadUnits: number;
    readonly treeHeight: number;
  };
  readonly middleInsert: {
    readonly heapRetainedDeltaBytes: number;
    readonly rssRetainedDeltaBytes: number;
    readonly retainedNodes: number;
    readonly retainedPayloadUnits: number;
    readonly treeHeight: number;
  };
  readonly undo: {
    readonly heapRetainedDeltaBytes: number;
    readonly rssRetainedDeltaBytes: number;
    readonly historyEntries: number;
    readonly retainedNodes: number;
    readonly retainedPayloadUnits: number;
  };
}

interface CandidatePerformance {
  readonly openOneMiB: QuantileSummary;
  readonly lineLookupUnicode2000: QuantileSummary;
  readonly snapshotCapture: QuantileSummary;
  readonly snapshotMaterializeOneMiB: QuantileSummary;
  readonly singleEditRoundTrip: QuantileSummary;
  readonly batchCorpusStructure: {
    readonly inputBytesUtf16: number;
    readonly lineBreaks: number;
    readonly nodeCount: number;
    readonly treeHeight: number;
    readonly heapDeltaBytesAfterBuild: number;
    readonly rssDeltaBytesAfterBuild: number;
    readonly retainedNodes: number;
    readonly retainedPayloadUnits: number;
    readonly logicalRetainedUtf16Bytes: number;
  };
  readonly middleInsert100k: {
    readonly initialLengthUtf16: number;
    readonly finalLengthUtf16: number;
    readonly operations: number;
    readonly latency: QuantileSummary;
    readonly currentNodesOrPieces: number;
    readonly treeHeight: number;
    readonly currentPayloadUnits: number;
    readonly logicalRetainedUtf16Bytes: number;
    readonly heapRetainedDeltaBytes: number;
    readonly rssRetainedDeltaBytes: number;
    readonly finalSha256: string;
  };
  readonly undoRetention1000: {
    readonly operations: number;
    readonly latency: QuantileSummary;
    readonly historyEntries: number;
    readonly currentNodes: number;
    readonly uniqueRetainedNodes: number;
    readonly currentPayloadUnits: number;
    readonly retainedPayloadUnits: number;
    readonly logicalRetainedUtf16Bytes: number;
    readonly heapRetainedDeltaBytes: number;
    readonly rssRetainedDeltaBytes: number;
    readonly undoRestoredInitialHash: boolean;
  };
}

interface BatchAndCancellationMeasurements {
  readonly candidateId: string;
  readonly batch: readonly Record<string, unknown>[];
  readonly cancellation: readonly Record<string, unknown>[];
}

function measureBatchAndCancellation(candidate: CandidateDefinition, initialText: string): BatchAndCancellationMeasurements {
  const counts = [1, 10, 100, 1000, 10_000] as const;
  const orders = ['sorted', 'reversed'] as const;
  const batch: Record<string, unknown>[] = [];
  const cancellation: Record<string, unknown>[] = [];

  for (const count of counts) {
    const expected = applyReference(initialText, createBatchEdits(initialText.length, count, 'sorted'));
    const expectedDigest = sha256(expected);
    for (const order of orders) {
      const edits = createBatchEdits(initialText.length, count, order);
      const durations: number[] = [];
      let observedDigest = '';
      const trials = count === 10_000 ? 30 : 50;
      for (let warmup = 0; warmup < 5; warmup += 1) {
        const model = candidate.open(initialText, t004Seed).fork();
        model.replaceBatch(edits, model.version);
        assert.equal(model.version, 2, `${candidate.id} warmup batch published more than one revision`);
      }
      for (let trial = 0; trial < trials; trial += 1) {
        const model = candidate.open(initialText, t004Seed).fork();
        const start = nowNanoseconds();
        model.replaceBatch(edits, model.version);
        durations.push(toMicroseconds(nowNanoseconds() - start));
        if (trial === 0) observedDigest = sha256(model.text());
        assert.equal(model.version, 2, `${candidate.id} batch published more than one revision`);
      }
      assert.equal(observedDigest, expectedDigest, `${candidate.id} ${order} batch differs from reference`);
      batch.push({ candidateId: candidate.id, count, order, trials, latency: quantiles(durations), expectedSha256: expectedDigest });

    }
  }

  const cancelCount = 10_000;
  const cancelEdits = createBatchEdits(initialText.length, cancelCount, 'sorted');
  const model = candidate.open(initialText, t004Seed);
  const originalText = model.text();
  const originalVersion = model.version;
  let completed = 0;
  const before = nowNanoseconds();
  try {
    model.replaceBatch(cancelEdits, originalVersion, false, () => completed >= 5_000 ? true : (completed += 1, false));
    throw new Error(`${candidate.id} cancellation did not abort batch`);
  } catch (error) {
    if (!(error instanceof Error) || !/batch-cancelled-after/u.test(error.message)) throw error;
    const duration = toMicroseconds(nowNanoseconds() - before);
    assert.equal(model.version, originalVersion);
    assert.equal(model.text(), originalText);
    cancellation.push({ candidateId: candidate.id, requested: cancelCount, completedEdits: Number(error.message.match(/after-(\d+)/u)?.[1] ?? 0), durationMicroseconds: duration, textAndVersionUnchanged: true });
  }
  return { candidateId: candidate.id, batch, cancellation };
}

function measureAnchors(initialText: string): readonly Record<string, unknown>[] {
  const measurements: Record<string, unknown>[] = [];
  for (const count of [1, 10, 100, 1000, 10_000]) {
    for (const order of ['sorted', 'reversed'] as const) {
      const edits = createBatchEdits(initialText.length, count, order);
      const anchors = createAnchors(initialText.length, count, order);
      for (let warmup = 0; warmup < 5; warmup += 1) mapAnchors(anchors, edits);
      const durations: number[] = [];
      let operationCounts = { scannedAnchors: 0, scannedEdits: 0, anchorSorts: 0, editSorts: 0 };
      for (let trial = 0; trial < 50; trial += 1) {
        const start = nowNanoseconds();
        const mapped = mapAnchors(anchors, edits);
        durations.push(toMicroseconds(nowNanoseconds() - start));
        if (trial === 0) {
          for (const anchor of mapped.anchors) {
            const expected = anchor.offset + anchor.id + (anchor.affinity === 'right' ? 1 : 0);
            assert.equal(anchor.mappedOffset, expected, `anchor map mismatch: count=${count}, id=${anchor.id}`);
          }
        }
        operationCounts = {
          scannedAnchors: mapped.scannedAnchors,
          scannedEdits: mapped.scannedEdits,
          anchorSorts: mapped.anchorSorts,
          editSorts: mapped.editSorts,
        };
      }
      measurements.push({ count, order, trials: durations.length, latency: quantiles(durations), operationCounts });
    }
  }
  return measurements;
}

async function measureCandidate(
  candidate: CandidateDefinition,
  longLine: string,
  batchText: string,
  unicodeText: string,
  fragmentationSeed: string,
): Promise<CandidatePerformance> {
  const openTimes: number[] = [];
  for (let warmup = 0; warmup < 5; warmup += 1) {
    const model = candidate.open(longLine, t004Seed);
    assert.equal(model.length, longLine.length);
  }
  for (let trial = 0; trial < 30; trial += 1) {
    const start = nowNanoseconds();
    const model = candidate.open(longLine, t004Seed);
    assert.equal(model.length, longLine.length);
    openTimes.push(toMicroseconds(nowNanoseconds() - start));
  }

  const lineModel = candidate.open(unicodeText, t004Seed);
  const lineRandom = seededRandom(t004Seed);
  const lineSamples: number[] = [];
  for (let sample = 0; sample < 10_000; sample += 1) {
    const offset = safeBoundary(unicodeText, lineRandom() % (unicodeText.length + 1));
    const start = nowNanoseconds();
    const row = lineModel.lineIndexAt(offset);
    lineSamples.push(toMicroseconds(nowNanoseconds() - start));
    assert(row >= 0 && row <= 2000);
  }

  const snapshotModel = candidate.open(longLine, t004Seed);
  const snapshotCaptureSamples: number[] = [];
  let capturedVersion = 0;
  for (let sample = 0; sample < 10_000; sample += 1) {
    const start = nowNanoseconds();
    const snapshot = snapshotModel.capture();
    snapshotCaptureSamples.push(toMicroseconds(nowNanoseconds() - start));
    capturedVersion += snapshot.version;
  }
  assert(capturedVersion > 0);
  const captured = snapshotModel.capture();
  const materializeSamples: number[] = [];
  for (let sample = 0; sample < 30; sample += 1) {
    const start = nowNanoseconds();
    const content = captured.text();
    materializeSamples.push(toMicroseconds(nowNanoseconds() - start));
    assert.equal(content.length, longLine.length);
  }

  const editModel = candidate.open(longLine, t004Seed);
  const middle = Math.floor(longLine.length / 2);
  for (let warmup = 0; warmup < 100; warmup += 1) {
    editModel.replace(middle, middle, 'x');
    editModel.replace(middle, middle + 1, '');
  }
  const editRoundTrips: number[] = [];
  for (let sample = 0; sample < 10_000; sample += 1) {
    const start = nowNanoseconds();
    editModel.replace(middle, middle, 'x');
    editModel.replace(middle, middle + 1, '');
    editRoundTrips.push(toMicroseconds(nowNanoseconds() - start));
  }
  assert.equal(sha256(editModel.text()), sha256(longLine));

  const middleModel = candidate.open(fragmentationSeed, t004Seed);
  const middleInsertLatency: number[] = [];
  for (let operation = 0; operation < 100_000; operation += 1) {
    const offset = Math.floor(middleModel.length / 2);
    const start = nowNanoseconds();
    middleModel.replace(offset, offset, 'x');
    middleInsertLatency.push(toMicroseconds(nowNanoseconds() - start));
  }
  const middleMetrics = middleModel.metrics();
  const middleText = middleModel.text();
  const middleHash = sha256(middleText);
  assert.equal(middleText, `${'a'.repeat(4096)}${'x'.repeat(100_000)}${'a'.repeat(4096)}`);
  assert.equal(middleMetrics.utf16Length, expectedFragmentationLength);
  assert.equal(middleHash, expectedFragmentationSha256);

  const undoModel = candidate.open(longLine, t004Seed);
  const undoLatency: number[] = [];
  const undoMiddle = Math.floor(longLine.length / 2);
  for (let operation = 0; operation < 1000; operation += 1) {
    const start = nowNanoseconds();
    undoModel.replace(undoMiddle, undoMiddle, 'u', true);
    undoLatency.push(toMicroseconds(nowNanoseconds() - start));
  }
  const undoRetainedMetrics = undoModel.metrics();
  for (let operation = 0; operation < 1000; operation += 1) assert.equal(undoModel.undo(), true);
  assert.equal(sha256(undoModel.text()), sha256(longLine));
  const memory = await runMemoryProbe(candidate);

  return {
    openOneMiB: quantiles(openTimes),
    lineLookupUnicode2000: quantiles(lineSamples),
    snapshotCapture: quantiles(snapshotCaptureSamples),
    snapshotMaterializeOneMiB: quantiles(materializeSamples),
    singleEditRoundTrip: quantiles(editRoundTrips),
    batchCorpusStructure: {
      inputBytesUtf16: batchText.length,
      lineBreaks: 1024,
      nodeCount: memory.batch.retainedNodes,
      treeHeight: memory.batch.treeHeight,
      heapDeltaBytesAfterBuild: memory.batch.heapRetainedDeltaBytes,
      rssDeltaBytesAfterBuild: memory.batch.rssRetainedDeltaBytes,
      retainedNodes: memory.batch.retainedNodes,
      retainedPayloadUnits: memory.batch.retainedPayloadUnits,
      logicalRetainedUtf16Bytes: memory.batch.retainedPayloadUnits * 2,
    },
    middleInsert100k: {
      initialLengthUtf16: fragmentationSeed.length,
      finalLengthUtf16: middleMetrics.utf16Length,
      operations: middleInsertLatency.length,
      latency: quantiles(middleInsertLatency),
      currentNodesOrPieces: memory.middleInsert.retainedNodes,
      treeHeight: memory.middleInsert.treeHeight,
      currentPayloadUnits: middleMetrics.currentPayloadUnits,
      logicalRetainedUtf16Bytes: middleMetrics.currentPayloadUnits * 2,
      heapRetainedDeltaBytes: memory.middleInsert.heapRetainedDeltaBytes,
      rssRetainedDeltaBytes: memory.middleInsert.rssRetainedDeltaBytes,
      finalSha256: middleHash,
    },
    undoRetention1000: {
      operations: undoLatency.length,
      latency: quantiles(undoLatency),
      historyEntries: memory.undo.historyEntries,
      currentNodes: undoRetainedMetrics.currentNodes,
      uniqueRetainedNodes: memory.undo.retainedNodes,
      currentPayloadUnits: undoRetainedMetrics.currentPayloadUnits,
      retainedPayloadUnits: memory.undo.retainedPayloadUnits,
      logicalRetainedUtf16Bytes: memory.undo.retainedPayloadUnits * 2,
      heapRetainedDeltaBytes: memory.undo.heapRetainedDeltaBytes,
      rssRetainedDeltaBytes: memory.undo.rssRetainedDeltaBytes,
      undoRestoredInitialHash: true,
    },
  };
}

function createAnchors(length: number, count: number, order: 'sorted' | 'reversed'): TextAnchor[] {
  const anchors = Array.from({ length: count }, (_item, index) => ({
    id: index,
    offset: Math.floor(((index + 1) * length) / (count + 1)),
    affinity: index % 2 === 0 ? 'left' as const : 'right' as const,
  }));
  if (order === 'reversed') anchors.reverse();
  return anchors;
}

async function runMemoryProbe(candidate: CandidateDefinition): Promise<MemoryProbe> {
  const scriptPath = fileURLToPath(new URL('./memory-probe.ts', import.meta.url));
  const output = await new Promise<string>((resolveOutput, rejectOutput) => {
    const child = spawn(process.execPath, [scriptPath, candidate.id], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', rejectOutput);
    child.once('close', (code, signal) => {
      if (code !== 0) {
        rejectOutput(new Error(`memory-probe-failed: candidate=${candidate.id}; code=${String(code)}; signal=${String(signal)}; stderr=${stderr.slice(-4000)}`));
        return;
      }
      resolveOutput(stdout);
    });
  });
  let data: unknown;
  try {
    data = JSON.parse(output);
  } catch (error) {
    throw new Error(`memory-probe-invalid-json: candidate=${candidate.id}`, { cause: error });
  }
  return parseMemoryProbe(data, candidate.id);
}

function parseMemoryProbe(value: unknown, candidateId: string): MemoryProbe {
  if (!isRecord(value) || value.candidateId !== candidateId) throw new Error(`memory-probe-invalid-envelope: ${candidateId}`);
  const batch = requiredRecord(value.batch, 'batch');
  const middleInsert = requiredRecord(value.middleInsert, 'middleInsert');
  const undo = requiredRecord(value.undo, 'undo');
  return {
    batch: {
      heapRetainedDeltaBytes: requiredNumber(batch, 'heapRetainedDeltaBytes'),
      rssRetainedDeltaBytes: requiredNumber(batch, 'rssRetainedDeltaBytes'),
      retainedNodes: requiredNumber(batch, 'retainedNodes'),
      retainedPayloadUnits: requiredNumber(batch, 'retainedPayloadUnits'),
      treeHeight: requiredNumber(batch, 'treeHeight'),
    },
    middleInsert: {
      heapRetainedDeltaBytes: requiredNumber(middleInsert, 'heapRetainedDeltaBytes'),
      rssRetainedDeltaBytes: requiredNumber(middleInsert, 'rssRetainedDeltaBytes'),
      retainedNodes: requiredNumber(middleInsert, 'retainedNodes'),
      retainedPayloadUnits: requiredNumber(middleInsert, 'retainedPayloadUnits'),
      treeHeight: requiredNumber(middleInsert, 'treeHeight'),
    },
    undo: {
      heapRetainedDeltaBytes: requiredNumber(undo, 'heapRetainedDeltaBytes'),
      rssRetainedDeltaBytes: requiredNumber(undo, 'rssRetainedDeltaBytes'),
      historyEntries: requiredNumber(undo, 'historyEntries'),
      retainedNodes: requiredNumber(undo, 'retainedNodes'),
      retainedPayloadUnits: requiredNumber(undo, 'retainedPayloadUnits'),
    },
  };
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`memory-probe-invalid-section: ${name}`);
  return value;
}

function requiredNumber(record: Record<string, unknown>, name: string): number {
  const value = record[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`memory-probe-invalid-number: ${name}`);
  return value;
}

function requiredString(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== 'string') throw new Error(`memory-probe-invalid-string: ${name}`);
  return value;
}

function toMicroseconds(durationNanoseconds: bigint): number {
  return Number(durationNanoseconds) / 1000;
}

function formatQuantile(value: number): string {
  return value.toFixed(3);
}

function formatMilliseconds(microseconds: number): string {
  return (microseconds / 1000).toFixed(3);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entryIds(manifest: Record<string, unknown>, key: string): string[] {
  const entries = manifest[key];
  if (!Array.isArray(entries)) throw new Error(`invalid-t004-manifest-array: ${key}`);
  return entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string') throw new Error(`invalid-t004-manifest-entry: ${key}`);
    return entry.id;
  });
}

function entryById(manifest: Record<string, unknown>, key: string, id: string): Record<string, unknown> {
  const entries = manifest[key];
  if (!Array.isArray(entries)) throw new Error(`invalid-t004-manifest-array: ${key}`);
  const entry = entries.find((value) => isRecord(value) && value.id === id);
  if (!isRecord(entry)) throw new Error(`t004-fixture-not-found: ${id}`);
  return entry;
}
