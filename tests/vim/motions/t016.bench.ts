#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { asIdentifier, asUtf16Offset, type DocumentId, type Utf16Offset } from '../../../packages/primitives/src/index';
import { openTextDocument } from '../../../packages/document/src/index';
import { createVimMotionCursor, resolveVimMotion, type VimMotionKey, type VimMotionOptions } from '../../../packages/vim/motions/index';

const TARGET_MS = 1;
const LINE_LENGTH = 100_000;
const ONE_MIB = 1024 * 1024;
const ASCII = 'a'.repeat(LINE_LENGTH);
const ONE_MIB_ASCII = 'a'.repeat(ONE_MIB);
const SOURCE_LINE = '  const item = 12345;\n';
const SMALL_SOURCE = SOURCE_LINE.repeat(2_000);
const cases = [
  createCase('small-source-2k-lines-h', SMALL_SOURCE, SOURCE_LINE.length * 1_000 + 10, 'h'),
  createCase('ascii-h', ASCII, 50_000, 'h'),
  createCase('ascii-l', ASCII, 50_000, 'l'),
  createCase('ascii-eol', ASCII, 0, '$'),
  createCase('one-mib-ascii-l', ONE_MIB_ASCII, 0, 'l', {}, 16),
  createCase('one-mib-ascii-eol', ONE_MIB_ASCII, 0, '$', {}, 16),
  createCase('tab-neighbor-l', `${'a'.repeat(50_000)}\t${'b'.repeat(49_999)}`, 49_999, 'l'),
  createCase('combining-neighbor-l', `${'a'.repeat(50_000)}e\u0301${'b'.repeat(49_998)}`, 50_000, 'l'),
  createCase('wide-neighbor-l', `${'a'.repeat(50_000)}界${'b'.repeat(49_999)}`, 49_999, 'l'),
  createCase('wrap-left', `${ASCII}\n${ASCII}`, LINE_LENGTH + 1, 'h', { whichWrap: 'h' }),
];

const results = cases.map((entry) => measure(entry.name, entry.run, entry.targetMs,
  entry.name.includes('ascii-') || entry.name.includes('small-source') ? 100 : 15));
console.log(JSON.stringify({
  ticket: 'T016',
  documentLineLengthUtf16: LINE_LENGTH,
  oneMiBUtf16: ONE_MIB,
  targetEngineStepMs: TARGET_MS,
  targetLargeFileTypingMs: 16,
  cases: results,
}, null, 2));

function createCase(
  name: string,
  text: string,
  offset: number,
  key: VimMotionKey,
  options: VimMotionOptions = {},
  targetMs = TARGET_MS,
): { readonly name: string; readonly targetMs: number; readonly run: () => void } {
  const opened = openTextDocument(asDocumentId(`t016-bench-${name}`), new TextEncoder().encode(text));
  assert.equal(opened.kind, 'editable');
  if (opened.kind !== 'editable') throw new Error(`T016-BENCH-01 ${name} failed to open`);
  const snapshot = opened.document.snapshot();
  const cursor = createVimMotionCursor(snapshot, asOffset(offset), options);
  if (!cursor.ok) throw new Error(`T016-BENCH-01 ${name} cursor failed: ${cursor.error.kind}`);
  return {
    name,
    targetMs,
    run: () => {
      const outcome = resolveVimMotion(snapshot, cursor.value, { key }, options);
      if (!outcome.ok) throw new Error(`T016-BENCH-01 ${name} motion failed: ${outcome.error.kind}`);
    },
  };
}

function measure(name: string, run: () => void, targetMs: number, samples: number): {
  readonly name: string;
  readonly targetMs: number;
  readonly samples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly withinBudget: boolean;
} {
  for (let index = 0; index < 10; index += 1) run();
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const start = performance.now();
    run();
    durations.push(performance.now() - start);
  }
  durations.sort((left, right) => left - right);
  const p50Ms = percentile(durations, 0.50);
  const p95Ms = percentile(durations, 0.95);
  const p99Ms = percentile(durations, 0.99);
  const maxMs = durations.at(-1) ?? 0;
  return { name, targetMs, samples, p50Ms, p95Ms, p99Ms, maxMs, withinBudget: p95Ms <= targetMs };
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function asDocumentId(value: string): DocumentId {
  const result = asIdentifier<DocumentId>(value, 'documentId');
  if (!result.ok) throw new Error('T016-BENCH-01 invalid document ID');
  return result.value;
}

function asOffset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error('T016-BENCH-01 invalid UTF-16 offset');
  return result.value;
}
