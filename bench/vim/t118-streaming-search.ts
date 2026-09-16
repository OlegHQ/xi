#!/usr/bin/env bun
/** Diagnostic T118 production no-match scan; run from the repository root. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openTextDocument, type DocumentSnapshot } from '../../packages/document/src/index';
import { asIdentifier, type DocumentId, type Utf16Offset } from '../../packages/primitives/src/index';
import { compilePattern, createPatternEvaluation, patternSnapshotFromDocument } from '../../packages/vim/pattern/index';

const idResult = asIdentifier<DocumentId>('T118-PF08-streaming', 'documentId');
const documentId: DocumentId = idResult.ok
  ? idResult.value
  : (() => { throw new Error(idResult.error.message); })();
const source = 'x'.repeat(100 * 1024 * 1024);
const opened = openTextDocument(documentId, new TextEncoder().encode(source));
if (opened.kind !== 'editable') throw new Error(`open:${opened.kind}`);
const base = opened.document.snapshot();
const reads: number[] = [];
const observed = new Proxy(base, {
  get(target, property) {
    if (property === 'slice') {
      return (start: Utf16Offset, end: Utf16Offset) => {
        reads.push((end as number) - (start as number));
        return target.slice(start, end);
      };
    }
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) as unknown : value;
  },
}) as DocumentSnapshot;

const before = process.memoryUsage();
const evaluation = createPatternEvaluation(
  compilePattern('z', { stepBudget: 500_000_000, cancellationCheckInterval: 4096 }),
  patternSnapshotFromDocument(observed),
);
const started = performance.now();
const progress = evaluation.resume(Number.MAX_SAFE_INTEGER);
const elapsedMs = performance.now() - started;
if (progress.kind !== 'complete') throw new Error('PF08 no-match scan did not complete');
if (progress.result.matches.length !== 0) throw new Error('PF08 unexpected match');
if (typeof Bun.gc === 'function') Bun.gc(true);
const after = process.memoryUsage();
const artifact = {
  schemaVersion: 1,
  diagnosticOnly: true,
  fixture: 'PF08-100MiB-single-line-no-match',
  host: { platform: process.platform, architecture: process.arch, bun: Bun.version },
  sourceUtf16Units: source.length,
  elapsedMs,
  steps: evaluation.steps,
  matches: progress.result.matches.length,
  reads: { count: reads.length, totalUtf16Units: reads.reduce((sum, value) => sum + value, 0), largestUtf16Units: Math.max(...reads) },
  rssKiB: { before: Math.round(before.rss / 1024), after: Math.round(after.rss / 1024), delta: Math.round((after.rss - before.rss) / 1024) },
  heapUsedKiB: { before: Math.round(before.heapUsed / 1024), after: Math.round(after.heapUsed / 1024), delta: Math.round((after.heapUsed - before.heapUsed) / 1024) },
  note: 'Production document-backed evaluator; no flattened pattern snapshot, no reference-host qualification, no loaded input responsiveness trial and no allocator census.',
};
await mkdir(resolve('.artifacts/performance/T118'), { recursive: true });
const artifactPath = resolve('.artifacts/performance/T118/pf08-100MiB-streaming-search-diagnostic.json');
await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({ ...artifact, artifactPath }, null, 2));
