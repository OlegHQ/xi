/** Diagnostic only: fresh child per case, no release pass from these samples.
 * Run: bun run bench/performance/planning-probe.ts public dense 1048576
 * Compare: bun run bench/performance/planning-probe.ts rope dense 1048576
 */
import { createHash } from 'node:crypto';
import { openTextDocument } from '../../packages/document/src/index';
import { RopeDocument } from '../../packages/document/src/rope';
import { asIdentifier, type DocumentId } from '../../packages/primitives/src/index';
import {
  allocationAccounting,
  captureRuntimeMemory,
  signedRuntimeDelta,
} from './runtime-accounting';

const [layer, shape, requested] = process.argv.slice(2);
const size = Number(requested);
if (!['public', 'rope'].includes(layer ?? '') || !['dense', 'normal', 'long'].includes(shape ?? '')
  || !Number.isSafeInteger(size) || size < 1024 || size > 100 * 1024 * 1024) {
  throw new Error('usage: planning-probe.ts public|rope dense|normal|long bytes (1024..104857600)');
}
const runtime = globalThis as typeof globalThis & { Bun: { gc(force: boolean): void; version: string } };
const id = asIdentifier<DocumentId>('planning-resource-probe', 'documentId');
if (!id.ok) throw new Error('invalid-fixture-id');
function gc(): void { runtime.Bun.gc(true); runtime.Bun.gc(true); }
gc();
const before = process.memoryUsage();
const beforeRuntime = captureRuntimeMemory();
const cpuBefore = process.cpuUsage();
const unit = shape === 'dense' ? 'x\n' : shape === 'normal' ? 'x'.repeat(79) + '\n' : 'x';
let source: string | undefined = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
let bytes: Uint8Array | undefined = new TextEncoder().encode(source);
const hash = createHash('sha256').update(bytes).digest('hex');
const started = performance.now();
const result = layer === 'public' ? openTextDocument(id.value, bytes) : RopeDocument.create(id.value, source);
const openMs = performance.now() - started;
const cpu = process.cpuUsage(cpuBefore);
const beforeCollection = process.memoryUsage();
source = undefined;
bytes = undefined;
gc();
const retained = process.memoryUsage();
const afterRuntime = captureRuntimeMemory();
// Keep the document reachable across collection, and verify successful construction.
const snapshot = 'kind' in result
  ? result.kind === 'editable' ? result.document.snapshot() : undefined
  : result.ok ? result.value.snapshot() : undefined;
if (snapshot?.lengthUtf16 !== size) throw new Error('open-did-not-preserve-length');
console.log(JSON.stringify({ diagnosticOnly: true, layer, shape, bytes: size, sha256: hash,
  bun: runtime.Bun.version, platform: process.platform, arch: process.arch,
  lines: snapshot.lineCount, openMs, cpuMicrosIncludingFixture: cpu.user + cpu.system,
  before, beforeCollection, retained, heapGrowth: retained.heapUsed - before.heapUsed,
  rssGrowth: retained.rss - before.rss, maxRssKiB: process.resourceUsage().maxRSS,
  runtimeMemory: { before: beforeRuntime, after: afterRuntime, signedDeltas: signedRuntimeDelta(beforeRuntime, afterRuntime) },
  allocationAccounting: allocationAccounting(afterRuntime),
}));
