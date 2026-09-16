#!/usr/bin/env bun
/** Diagnostic T109 production motion probe; run from the repository root. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openTextDocument, type DocumentSnapshot } from '../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type Utf16Offset } from '../../packages/primitives/src/index';
import { createVimMotionCursor, resolveVimMotion, type VimMotionKey } from '../../packages/vim/motions/index';

const idResult = asIdentifier<DocumentId>('T109-semantic-reads', 'documentId');
const documentId: DocumentId = idResult.ok
  ? idResult.value
  : (() => { throw new Error(idResult.error.message); })();
const sizes = [1_048_576, 10_485_760];
const samplesPerCase = 5;
const warmupSamples = 1;

interface MotionCase {
  readonly fixture: string;
  readonly source: string;
  readonly offset: number;
  readonly key: VimMotionKey;
}

interface CaseResult {
  readonly fixture: string;
  readonly key: VimMotionKey;
  readonly sourceUtf16Units: number;
  readonly timingsMs: Stats;
  readonly sliceUnits: Stats;
  readonly largestSliceUtf16: number;
  readonly successfulSamples: number;
}

interface Stats {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

const results: CaseResult[] = [];
for (const size of sizes) {
  const ascii = `${' '.repeat(size - 1)}x`;
  results.push(await measure({ fixture: `PF02-${size}-ASCII-head-nonblank`, source: ascii, offset: 0, key: '^' }));
  results.push(await measure({ fixture: `PF02-${size}-ASCII-middle-step`, source: 'x'.repeat(size), offset: Math.floor(size / 2), key: 'l' }));
  results.push(await measure({ fixture: `PF02-${size}-ASCII-end-line`, source: 'x'.repeat(size), offset: 0, key: '$' }));

  const combiningUnit = 'e\u0301';
  const combining = repeatToUtf16(combiningUnit, size);
  results.push(await measure({ fixture: `PF02-${size}-combining-middle-step`, source: combining, offset: nearestUnitBoundary(combining, Math.floor(combining.length / 2)), key: 'l' }));
  const wideUnit = '界';
  const wide = repeatToUtf16(wideUnit, size);
  results.push(await measure({ fixture: `PF02-${size}-wide-middle-step`, source: wide, offset: nearestUnitBoundary(wide, Math.floor(wide.length / 2)), key: 'l' }));
}

const artifact = {
  schemaVersion: 1,
  diagnosticOnly: true,
  fixtureFamily: 'PF02',
  host: { platform: process.platform, architecture: process.arch, bun: Bun.version },
  samplesPerCase,
  warmupSamples,
  results,
  note: 'Production motion resolver reads through DocumentSnapshot; no reference-host qualification, allocation census, terminal visual review or release certification.',
};
await mkdir(resolve('.artifacts/performance/T109'), { recursive: true });
const artifactPath = resolve('.artifacts/performance/T109/pf02-semantic-reads-diagnostic.json');
await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({ ...artifact, artifactPath }, null, 2));

async function measure(testCase: MotionCase): Promise<CaseResult> {
  const opened = openTextDocument(documentId, new TextEncoder().encode(testCase.source));
  if (opened.kind !== 'editable') throw new Error(`open:${testCase.fixture}:${opened.kind}`);
  const snapshot = opened.document.snapshot();
  const cursor = createVimMotionCursor(snapshot, testCase.offset as Utf16Offset);
  if (!cursor.ok) throw new Error(`cursor:${testCase.fixture}:${cursor.error.kind}`);
  for (let index = 0; index < warmupSamples; index += 1) {
    const result = resolveVimMotion(snapshot, cursor.value, { key: testCase.key });
    if (!result.ok) throw new Error(`warmup:${testCase.fixture}:${result.error.kind}`);
  }
  const timings: number[] = [];
  const reads: number[] = [];
  let largestSlice = 0;
  let successfulSamples = 0;
  for (let index = 0; index < samplesPerCase; index += 1) {
    let sliceUnits = 0;
    const observed = observe(snapshot, (units) => {
      sliceUnits += units;
      largestSlice = Math.max(largestSlice, units);
    });
    const started = performance.now();
    const result = resolveVimMotion(observed, cursor.value, { key: testCase.key });
    timings.push(performance.now() - started);
    reads.push(sliceUnits);
    if (!result.ok) throw new Error(`sample:${testCase.fixture}:${result.error.kind}`);
    successfulSamples += 1;
  }
  return {
    fixture: testCase.fixture,
    key: testCase.key,
    sourceUtf16Units: testCase.source.length,
    timingsMs: stats(timings),
    sliceUnits: stats(reads),
    largestSliceUtf16: largestSlice,
    successfulSamples,
  };
}

function observe(snapshot: DocumentSnapshot, onSlice: (units: number) => void): DocumentSnapshot {
  return new Proxy(snapshot, {
    get(target, property) {
      if (property === 'slice') {
        return (start: Utf16Offset, end: Utf16Offset) => {
          onSlice((end as number) - (start as number));
          return target.slice(start, end);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    },
  }) as DocumentSnapshot;
}

function stats(values: readonly number[]): Stats {
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number => ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
  return { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: ordered.at(-1) ?? 0 };
}

function repeatToUtf16(unit: string, target: number): string {
  const count = Math.max(1, Math.ceil(target / unit.length));
  return unit.repeat(count).slice(0, target - (target % unit.length));
}

function nearestUnitBoundary(value: string, requested: number): number {
  return requested - (requested % 2);
}
