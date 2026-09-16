import { asIdentifier, type DocumentId, type SelectionId, type UndoGroupId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument, type EditProposal } from '../../packages/document/src/index';
import { createSelectionSet, mapSelectionSet, type SelectionSetSnapshot } from '../../packages/selections/src/index';
import { ViewportLayout } from '../../packages/layout/src/index';

const lineCount = 10_000;
const content = Array.from({ length: lineCount }, (_, index) =>
  `const value_${index} = { column: ${index}, label: 'Xi layout fixture ${index % 97}' };`).join('\n');
const endings = Array.from({ length: lineCount - 1 }, () => 'lf' as const);
const documentId = identifier<DocumentId>('T014-benchmark-document');
const primaryId = identifier<SelectionId>('T014-benchmark-primary');
const undoGroup = identifier<UndoGroupId>('T014-benchmark-edit');
const viewId = identifier<ViewId>('T014-benchmark-view');
const created = TextFileDocument.create(documentId, content, endings, 'lf');
if (!created.ok) throw new Error(`T014-benchmark-document:${created.error.kind}`);
const document = created.value;
const snapshot = document.snapshot();
const selection = createSelectionSet(snapshot, {
  primaryId,
  members: [{
    id: primaryId,
    kind: 'normal-cursor',
    direction: 'forward',
    anchor: { kind: 'character', offset: 0 as never, after: 1 as never },
    head: { kind: 'character', offset: 0 as never, after: 1 as never },
  }],
});
if (!selection.ok) throw new Error(`T014-benchmark-selection:${selection.error.kind}`);

const layout = new ViewportLayout();
const total = 300;
const cachedSamples: number[] = [];
for (let index = 0; index < total + 30; index += 1) {
  const start = performance.now();
  const frame = layout.project({ viewId, snapshot, selection: selection.value.selectionSet, widthCells: 120, heightCells: 40 });
  if (!frame.ok) throw new Error(`T014-benchmark-layout:${frame.error.kind}`);
  const elapsed = performance.now() - start;
  if (index >= 30) cachedSamples.push(elapsed);
}
const anchorAOffset = snapshot.lineStartOffset(500 as never);
const anchorBOffset = snapshot.lineStartOffset(5_000 as never);
if (!anchorAOffset.ok || !anchorBOffset.ok) throw new Error('T014-benchmark-viewport-anchors-unavailable');
const changingSamples: number[] = [];
for (let index = 0; index < total + 30; index += 1) {
  const line = index % 2 === 0 ? 500 : 5_000;
  const start = performance.now();
  const frame = layout.project({
    viewId,
    snapshot,
    selection: selection.value.selectionSet,
    widthCells: 120,
    heightCells: 40,
    anchor: {
      documentVersion: snapshot.version,
      lineIndex: line as never,
      offset: line === 500 ? anchorAOffset.value : anchorBOffset.value,
      displayCellColumn: 0 as never,
    },
  });
  if (!frame.ok) throw new Error(`T014-benchmark-scrolled-layout:${frame.error.kind}`);
  const elapsed = performance.now() - start;
  if (index >= 30) changingSamples.push(elapsed);
}
const editedSamples: number[] = [];
let currentSelection: SelectionSetSnapshot = selection.value.selectionSet;
for (let index = 0; index < total + 30; index += 1) {
  const before = document.snapshot();
  const proposal: EditProposal = {
    documentId,
    expectedVersion: before.version,
    // Keep the edit length fixed while making each measured line's content new,
    // so this workload rebuilds changed-line geometry rather than toggling between
    // two warmed content-cache entries.
    edits: [{ start: 0 as never, end: 4 as never, text: String(index).padStart(4, '0') }],
    origin: 'vim',
    undoGroup,
  };
  const committed = document.commit(proposal);
  if (!committed.ok || committed.value.kind !== 'committed') throw new Error('T014-benchmark-edit-failed');
  const mapped = mapSelectionSet(currentSelection, committed.value.change.changeMap, committed.value.change.snapshot);
  if (!mapped.ok) throw new Error(`T014-benchmark-selection-map:${mapped.error.kind}`);
  currentSelection = mapped.value.selectionSet;
  layout.observeDocumentChange(committed.value.change);
  const start = performance.now();
  const frame = layout.project({
    viewId,
    snapshot: committed.value.change.snapshot,
    selection: currentSelection,
    widthCells: 120,
    heightCells: 40,
  });
  if (!frame.ok) throw new Error(`T014-benchmark-edited-layout:${frame.error.kind}`);
  const elapsed = performance.now() - start;
  if (index >= 30) editedSamples.push(elapsed);
}
cachedSamples.sort((left, right) => left - right);
changingSamples.sort((left, right) => left - right);
editedSamples.sort((left, right) => left - right);
const percentile = (samples: readonly number[], fraction: number): number =>
  samples[Math.min(samples.length - 1, Math.ceil(samples.length * fraction) - 1)] ?? 0;
const stats = layout.cacheStats;
console.log(JSON.stringify({
  fixture: 'T014-LAYOUT-VISIBLE-ROWS-01',
  host: { platform: process.platform, architecture: process.arch, bun: Bun.version },
  corpus: { lines: lineCount, utf16Units: content.length, viewport: '120x40', warmup: 30, samples: total },
  repeatedFrameMs: {
    p50: percentile(cachedSamples, 0.5),
    p95: percentile(cachedSamples, 0.95),
    p99: percentile(cachedSamples, 0.99),
    max: cachedSamples.at(-1) ?? 0,
  },
  changedViewportMs: {
    p50: percentile(changingSamples, 0.5),
    p95: percentile(changingSamples, 0.95),
    p99: percentile(changingSamples, 0.99),
    max: changingSamples.at(-1) ?? 0,
  },
  oneLineEditNewVersionMs: {
    p50: percentile(editedSamples, 0.5),
    p95: percentile(editedSamples, 0.95),
    p99: percentile(editedSamples, 0.99),
    max: editedSamples.at(-1) ?? 0,
  },
  cacheStats: stats,
}, null, 2));

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'fixture-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
