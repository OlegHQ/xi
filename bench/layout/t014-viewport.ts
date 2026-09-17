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

// Production non-wrapping shape (packages/ui/src/workbench.ts uses
// `{ wrap: false, gutterWidthCells: 6 }`) at a 200x50 viewport: repeatedly typing one
// character on the first visible line. Every keystroke shifts the absolute UTF-16
// offset of every one of the other ~49 visible lines without changing their text,
// which is exactly the materialized-row cache-key defect this ticket fixes.
const prodLineCount = 5_000;
const prodContent = Array.from({ length: prodLineCount }, (_, index) =>
  `const value_${index} = { column: ${index}, label: 'Xi production-shape fixture ${index % 97}' };`).join('\n');
const prodEndings = Array.from({ length: prodLineCount - 1 }, () => 'lf' as const);
const prodDocumentId = identifier<DocumentId>('T014-benchmark-production-document');
const prodPrimaryId = identifier<SelectionId>('T014-benchmark-production-primary');
const prodUndoGroup = identifier<UndoGroupId>('T014-benchmark-production-edit');
const prodViewId = identifier<ViewId>('T014-benchmark-production-view');
const prodCreated = TextFileDocument.create(prodDocumentId, prodContent, prodEndings, 'lf');
if (!prodCreated.ok) throw new Error(`T014-benchmark-production-document:${prodCreated.error.kind}`);
const prodDocument = prodCreated.value;
const prodSelectionResult = createSelectionSet(prodDocument.snapshot(), {
  primaryId: prodPrimaryId,
  members: [{
    id: prodPrimaryId,
    kind: 'normal-cursor',
    direction: 'forward',
    anchor: { kind: 'character', offset: 0 as never, after: 1 as never },
    head: { kind: 'character', offset: 0 as never, after: 1 as never },
  }],
});
if (!prodSelectionResult.ok) throw new Error(`T014-benchmark-production-selection:${prodSelectionResult.error.kind}`);

const prodLayout = new ViewportLayout();
const prodTotal = 300;
const prodOptions = { wrap: false as const, gutterWidthCells: 6 };
const prodSamples: number[] = [];
let prodSelection: SelectionSetSnapshot = prodSelectionResult.value.selectionSet;
const materializedMissesByIndex: number[] = [];
const rowsBuiltByIndex: number[] = [];
for (let index = 0; index < prodTotal + 30; index += 1) {
  const before = prodDocument.snapshot();
  // Real typing: monotonically insert one character at the start of the first
  // visible line every keystroke, like a person actually typing there. This keeps
  // pushing every lower line's absolute base offset to a value it has never had
  // before, which is exactly what defeats a base-offset-keyed materialized-row
  // cache; an insert/delete toggle would only ever visit two offsets and mask the
  // regression this benchmark exists to catch.
  const proposal: EditProposal = {
    documentId: prodDocumentId,
    expectedVersion: before.version,
    edits: [{ start: 0 as never, end: 0 as never, text: 'x' }],
    origin: 'vim',
    undoGroup: prodUndoGroup,
  };
  const committed = prodDocument.commit(proposal);
  if (!committed.ok || committed.value.kind !== 'committed') throw new Error('T014-benchmark-production-edit-failed');
  const mapped = mapSelectionSet(prodSelection, committed.value.change.changeMap, committed.value.change.snapshot);
  if (!mapped.ok) throw new Error(`T014-benchmark-production-selection-map:${mapped.error.kind}`);
  prodSelection = mapped.value.selectionSet;
  prodLayout.observeDocumentChange(committed.value.change);
  const statsBefore = prodLayout.cacheStats;
  const start = performance.now();
  const frame = prodLayout.project({
    viewId: prodViewId,
    snapshot: committed.value.change.snapshot,
    selection: prodSelection,
    widthCells: 200,
    heightCells: 50,
    options: prodOptions,
  });
  if (!frame.ok) throw new Error(`T014-benchmark-production-layout:${frame.error.kind}`);
  const elapsed = performance.now() - start;
  const statsAfter = prodLayout.cacheStats;
  if (index >= 30) {
    prodSamples.push(elapsed);
    materializedMissesByIndex.push(statsAfter.materializedLineMisses - statsBefore.materializedLineMisses);
    rowsBuiltByIndex.push(statsAfter.rowsBuilt - statsBefore.rowsBuilt);
  }
}
prodSamples.sort((left, right) => left - right);
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
console.log(JSON.stringify({
  fixture: 'T014-LAYOUT-PRODUCTION-SHAPE-TYPING-01',
  host: { platform: process.platform, architecture: process.arch, bun: Bun.version },
  corpus: {
    lines: prodLineCount, utf16Units: prodContent.length, viewport: '200x50', wrap: false, gutterWidthCells: 6,
    warmup: 30, samples: prodTotal,
  },
  perFrameMs: {
    p50: percentile(prodSamples, 0.5),
    p95: percentile(prodSamples, 0.95),
    p99: percentile(prodSamples, 0.99),
    max: prodSamples.at(-1) ?? 0,
  },
  materializedLineMissesPerFrame: {
    mean: sum(materializedMissesByIndex) / materializedMissesByIndex.length,
    max: Math.max(...materializedMissesByIndex),
  },
  rowsBuiltPerFrame: {
    mean: sum(rowsBuiltByIndex) / rowsBuiltByIndex.length,
    max: Math.max(...rowsBuiltByIndex),
  },
  cacheStats: prodLayout.cacheStats,
}, null, 2));

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'fixture-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
