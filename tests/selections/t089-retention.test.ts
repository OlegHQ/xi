import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { asIdentifier, asUtf16Offset, type DocumentId, type SelectionId, type Utf16Offset, type ViewId } from '../../packages/primitives/src/index';
import { openTextDocument } from '../../packages/document/src/index';
import { createSelectionSet, updateSelectionSet } from '../../packages/selections/src/index';
import { WorkbenchSession } from '../../packages/workbench/src/index';

const encoder = new TextEncoder();
const source = 'one 😀 two\nthree\n';
const cycleCounts = [1_000, 10_000] as const;
const observations: Array<{
  readonly cycles: number;
  readonly elapsedMs: number;
  readonly rssBeforeBytes: number;
  readonly rssAfterBytes: number;
  readonly heapUsedBeforeBytes: number;
  readonly heapUsedAfterBytes: number;
  readonly externalBeforeBytes: number;
  readonly externalAfterBytes: number;
  readonly arrayBuffersBeforeBytes: number;
  readonly arrayBuffersAfterBytes: number;
  readonly viewsAfter: number;
  readonly buffersAfter: number;
}> = [];

const session = new WorkbenchSession({ workspaceId: 'T089-retention' });
let nextCycle = 0;
runCycles(1_000, 'warmup');
forceGc();
const stabilizedBaselineBytes = process.memoryUsage().rss;

for (const cycles of cycleCounts) {
  forceGc();
  const beforeMemory = process.memoryUsage();
  const started = performance.now();
  runCycles(cycles, String(cycles));
  const viewsAfter = session.views().length;
  const buffersAfter = session.buffers().length;
  forceGc();
  const afterMemory = process.memoryUsage();
  observations.push({
    cycles,
    elapsedMs: performance.now() - started,
    rssBeforeBytes: beforeMemory.rss,
    rssAfterBytes: afterMemory.rss,
    heapUsedBeforeBytes: beforeMemory.heapUsed,
    heapUsedAfterBytes: afterMemory.heapUsed,
    externalBeforeBytes: beforeMemory.external,
    externalAfterBytes: afterMemory.external,
    arrayBuffersBeforeBytes: beforeMemory.arrayBuffers,
    arrayBuffersAfterBytes: afterMemory.arrayBuffers,
    viewsAfter,
    buffersAfter,
  });
}
session.dispose();

const artifactDirectory = resolve(process.cwd(), '.artifacts/selections');
await mkdir(artifactDirectory, { recursive: true });
await writeFile(resolve(artifactDirectory, 't089-retention.json'), `${JSON.stringify({
  schemaVersion: 2,
  fixture: 'T089-SELECTION-RETENTION-01',
  sourceUtf16Units: source.length,
  warmupCycles: 1_000,
  cycleCounts,
  stabilizedBaselineBytes,
  observations,
  rssBudgetBytes: 10 * 1024 * 1024,
  rssBudgetObserved: observations.map((item) => item.rssAfterBytes - item.rssBeforeBytes),
  attribution: observations.map((item) => ({
    cycles: item.cycles,
    rssDeltaBytes: item.rssAfterBytes - item.rssBeforeBytes,
    heapUsedDeltaBytes: item.heapUsedAfterBytes - item.heapUsedBeforeBytes,
    externalDeltaBytes: item.externalAfterBytes - item.externalBeforeBytes,
    arrayBuffersDeltaBytes: item.arrayBuffersAfterBytes - item.arrayBuffersBeforeBytes,
    // RSS includes allocator/native pages and is intentionally reported
    // separately from JS heap and external/ArrayBuffer counters.
    rssUnaccountedByJsCountersBytes: (item.rssAfterBytes - item.rssBeforeBytes)
      - (item.heapUsedAfterBytes - item.heapUsedBeforeBytes)
      - (item.externalAfterBytes - item.externalBeforeBytes),
  })),
}, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ fixture: 'T089-SELECTION-RETENTION-01', stabilizedBaselineBytes, observations, artifact: resolve(artifactDirectory, 't089-retention.json') }, null, 2));

function runCycles(cycles: number, label: string): void {
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const cycleId = nextCycle;
    nextCycle += 1;
    const documentId = id<DocumentId>(`T089-retention-document-${label}-${cycleId}`);
    const opened = openTextDocument(documentId, encoder.encode(source));
    assert.equal(opened.kind, 'editable', `T089-RETENTION-DOC-${label}-${cycleId}`);
    if (opened.kind !== 'editable') throw new Error('T089-retention-open');
    const snapshot = opened.document.snapshot();
    const primaryId = id<SelectionId>(`T089-retention-primary-${label}-${cycleId}`);
    const secondaryId = id<SelectionId>(`T089-retention-secondary-${label}-${cycleId}`);
    const created = createSelectionSet(snapshot, {
      primaryId,
      members: [caret(primaryId, 0), caret(secondaryId, 2)],
    });
    if (!created.ok) throw new Error(`T089-retention-create:${created.error.kind}`);
    const collapsed = updateSelectionSet(snapshot, created.value.selectionSet, {
      primaryId,
      members: [caret(primaryId, 1)],
    });
    if (!collapsed.ok) throw new Error(`T089-retention-collapse:${collapsed.error.kind}`);
    assert.equal(collapsed.value.selectionSet.members.length, 1, `T089-RETENTION-COLLAPSE-COUNT-${label}-${cycleId}`);
    assert.equal(collapsed.value.selectionSet.selectionGeneration, 1, `T089-RETENTION-GENERATION-${label}-${cycleId}`);
    assert.equal(collapsed.value.selectionSet.documentVersion, snapshot.version, `T089-RETENTION-TEXT-VERSION-${label}-${cycleId}`);

    const openedBuffer = session.openBuffer(opened.document, { path: `/tmp/T089-retention-${label}-${cycleId}.txt` });
    if (!openedBuffer.ok) throw new Error(`T089-retention-view:${openedBuffer.error.kind}`);
    const viewId = openedBuffer.value.viewIds[0];
    assert.notEqual(viewId, undefined, `T089-RETENTION-VIEW-ID-${label}-${cycleId}`);
    if (viewId === undefined) throw new Error('T089-retention-view-id');
    const closed = session.closeView(viewId as ViewId, 'discard');
    if (!closed.ok) throw new Error(`T089-retention-close:${closed.error.kind}`);
    assert.equal(closed.ok && closed.value.closed, true, `T089-RETENTION-VIEW-CLOSED-${label}-${cycleId}`);
    if ((cycle + 1) % 1_000 === 0) {
      assert.equal(session.views().length, 0, `T089-RETENTION-LIVE-VIEWS-${label}-${cycleId}`);
      assert.equal(session.buffers().length, 0, `T089-RETENTION-LIVE-BUFFERS-${label}-${cycleId}`);
    }
  }
}

function caret(selectionId: SelectionId, value: number): {
  readonly id: SelectionId;
  readonly kind: 'insert-caret';
  readonly direction: 'forward';
  readonly anchor: { readonly kind: 'gap'; readonly offset: Utf16Offset };
  readonly head: { readonly kind: 'gap'; readonly offset: Utf16Offset };
} {
  const offset = asUtf16Offset(value);
  if (!offset.ok) throw new Error(`T089-retention-offset:${value}`);
  return {
    id: selectionId,
    kind: 'insert-caret',
    direction: 'forward',
    anchor: { kind: 'gap', offset: offset.value },
    head: { kind: 'gap', offset: offset.value },
  };
}

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T089-retention-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function forceGc(): void {
  const runtime = (globalThis as unknown as { readonly Bun?: { readonly gc?: (force?: boolean) => void } }).Bun;
  runtime?.gc?.(true);
}
