import { createHash } from 'node:crypto';

export const t004Seed = 41027;
export const oneMiB = 1024 * 1024;

export interface T004Corpora {
  readonly longLine: string;
  readonly batchText: string;
  readonly unicodeText: string;
  readonly fragmentationSeed: string;
}

export function createCorpora(): T004Corpora {
  const longLine = 'x'.repeat(oneMiB);
  const batchText = `${'a'.repeat(1023)}\n`.repeat(1024);
  const unicodeText = makeUnicodeText(2000, t004Seed);
  const fragmentationSeed = 'a'.repeat(8192);
  if (batchText.length !== oneMiB) throw new Error(`batch-fixture-length-mismatch: ${batchText.length}`);
  if (longLine.length !== oneMiB) throw new Error(`long-line-fixture-length-mismatch: ${longLine.length}`);
  return { longLine, batchText, unicodeText, fragmentationSeed };
}

export function makeUnicodeText(lineCount: number, seed: number): string {
  const next = seededRandom(seed);
  const glyphs = ['é', '界', '🙂', 'λ', 'ø'] as const;
  const rows: string[] = [];
  for (let line = 0; line < lineCount; line += 1) {
    const glyph = glyphs[next() % glyphs.length];
    const width = 8 + (next() % 37);
    const body = `row-${line.toString().padStart(4, '0')}\t${glyph}\t${'x'.repeat(width)}`;
    rows.push(`${body}\n`);
  }
  return rows.join('');
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function safeBoundary(text: string, requestedOffset: number): number {
  const clamped = Math.max(0, Math.min(text.length, requestedOffset));
  if (clamped === 0 || clamped === text.length) return clamped;
  const before = text.charCodeAt(clamped - 1);
  const after = text.charCodeAt(clamped);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) return clamped + 1;
  return clamped;
}

export function memorySnapshot(): { readonly rssBytes: number; readonly heapUsedBytes: number } {
  const usage = process.memoryUsage();
  return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed };
}

export function forceGc(): void {
  const runtime = globalThis as typeof globalThis & { readonly Bun?: { gc(force?: boolean): void } };
  runtime.Bun?.gc(true);
}

export function nowNanoseconds(): bigint {
  return process.hrtime.bigint();
}

export function quantiles(values: readonly number[]): {
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
} {
  if (values.length === 0) throw new Error('cannot-compute-quantiles-without-samples');
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}
