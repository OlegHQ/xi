#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { asIdentifier, type DocumentId, type DocumentVersion, type Utf16Offset } from '../../packages/primitives/src/index';
import { RopeDocument } from '../../packages/document/src/rope';

const initialText = 'a'.repeat(8192);
const operations = 100_000;
const expectedLength = 108_192;
const expectedSha256 = '39e8e9fdf7d3e87aee21b8a8ab56670f99fe8887bc6c9b9d0118b4a6e9afbb27';
if (process.platform !== 'linux' || process.arch !== 'arm64') throw new Error('FC-T004-FRAGMENT-01 requires Linux ARM64');
const documentId = asIdentifier<DocumentId>('T009-FC-T004-FRAGMENT-01', 'documentId');
if (!documentId.ok) throw new Error(documentId.error.message);
const opened = RopeDocument.create(documentId.value, initialText, 41027);
if (!opened.ok) throw new Error(`document-open-failed:${opened.error.kind}`);
const document = opened.value;

await settleGc();
const before = memorySnapshot();
let version: DocumentVersion = document.snapshot().version;
let length = document.metrics().utf16Length;
for (let operation = 0; operation < operations; operation += 1) {
  const center = Math.floor(length / 2);
  const applied = document.apply({ start: offset(center), end: offset(center), text: 'x' }, version);
  if (!applied.ok) throw new Error(`middle-insert-failed:${applied.error.kind}:${operation}`);
  version = applied.value;
  length += 1;
}
await settleGc();
const after = memorySnapshot();
const metrics = document.metrics();
const snapshot = document.snapshot();
const result = snapshot.slice(offset(0), offset(snapshot.lengthUtf16));
if (!result.ok) throw new Error(`snapshot-slice-failed:${result.error.kind}`);
const finalSha256 = createHash('sha256').update(result.value, 'utf8').digest('hex');
if (metrics.utf16Length !== expectedLength || finalSha256 !== expectedSha256) {
  throw new Error(`FC-T004-FRAGMENT-01 result mismatch length=${metrics.utf16Length} hash=${finalSha256}`);
}
const heapRetainedGrowthBytes = Math.max(0, after.heapUsedBytes - before.heapUsedBytes);
const rssGrowthBytes = Math.max(0, after.rssBytes - before.rssBytes);
console.log(JSON.stringify({
  finalUtf16Length: metrics.utf16Length,
  finalSha256,
  liveChunks: metrics.liveChunks,
  maximumChunkUtf16: metrics.maximumChunkUtf16,
  treeHeight: metrics.treeHeight,
  lineBreaks: metrics.lineBreaks,
  heapBeforeBytes: before.heapUsedBytes,
  heapAfterBytes: after.heapUsedBytes,
  heapRetainedGrowthBytes,
  rssBeforeBytes: before.rssBytes,
  rssAfterBytes: after.rssBytes,
  rssGrowthBytes,
}));

async function settleGc(): Promise<void> {
  const runtime = globalThis as typeof globalThis & { readonly Bun?: { gc(force?: boolean): void } };
  runtime.Bun?.gc(true);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  runtime.Bun?.gc(true);
}

function memorySnapshot(): { readonly rssBytes: number; readonly heapUsedBytes: number } {
  const usage = process.memoryUsage();
  return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed };
}

function offset(value: number): Utf16Offset { return value as Utf16Offset; }
