#!/usr/bin/env bun
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { asIdentifier, asUtf16Offset, type DocumentId, type SelectionId, type UndoGroupId, type Utf16Offset, type ViewId } from '../../packages/primitives/src/index';
import { openTextDocument, type DocumentChangeMap, type DocumentSnapshot, type TextFileDocument } from '../../packages/document/src/index';
import { createSelectionSet, mapSelectionSet, type SelectionSetSnapshot } from '../../packages/selections/src/index';
import { ViewportLayout } from '../../packages/layout/src/index';

const counts = [1, 10, 100, 1_000, 10_000] as const;
const benchmarkSamples = 30;
const source = 'x'.repeat(1_048_576);
const documentId = id<DocumentId>('T089-selection-document');
const opened = openTextDocument(documentId, new TextEncoder().encode(source));
if (opened.kind !== 'editable') throw new Error(`T089-open:${opened.kind}`);
const document = opened.document;
const snapshot = document.snapshot();
const insertion = document.commit({
  documentId,
  expectedVersion: snapshot.version,
  edits: [{ start: offset(0), end: offset(0), text: 'y' }],
  origin: 'vim',
  undoGroup: id<UndoGroupId>('T089-selection-edit'),
});
if (!insertion.ok || insertion.value.kind !== 'committed') throw new Error('T089-edit');
const changed = insertion.value.change;
const layout = new ViewportLayout();
const results: Record<string, unknown> = {};
for (const count of counts) {
  const selection = makeSelectionSet(snapshot, count);
  const create = measure(() => {
    const next = makeSelectionSet(snapshot, count);
    if (next.members.length !== count) throw new Error(`T089-create:${count}`);
  }, 2, benchmarkSamples);
  const reverseCreate = measure(() => {
    const next = makeSelectionSet(snapshot, count, true);
    if (next.members.length !== count) throw new Error(`T089-reverse-create:${count}`);
  }, 2, benchmarkSamples);
  const mapping = measure(() => {
    const mapped = mapSelectionSet(selection, changed.changeMap, changed.snapshot);
    if (!mapped.ok || mapped.value.selectionSet.members.length !== count) throw new Error(`T089-map:${count}`);
  }, 2, benchmarkSamples);
  const rendered = measure(() => {
    const frame = layout.project({ viewId: id<ViewId>(`T089-view-${count}`), snapshot, selection, widthCells: 120, heightCells: 40 });
    if (!frame.ok) throw new Error(`T089-render:${count}:${frame.error.kind}`);
    const second = layout.project({ viewId: id<ViewId>(`T089-second-view-${count}`), snapshot, selection, widthCells: 80, heightCells: 24 });
    if (!second.ok) throw new Error(`T089-render-second:${count}:${second.error.kind}`);
    if (frame.value.selections.length !== count || second.value.selections.length !== count) throw new Error(`T089-render-count:${count}`);
  }, 2, benchmarkSamples);
  const edited = measure(() => {
    const trial = openTextDocument(id<DocumentId>(`T089-edit-${count}`), new TextEncoder().encode(source));
    if (trial.kind !== 'editable') throw new Error(`T089-edit-open:${count}`);
    const trialSnapshot = trial.document.snapshot();
    const edits = Array.from({ length: count }, (_, index) => ({
      start: offset(index * 4),
      end: offset(index * 4),
      text: 'y',
    }));
    const committed = trial.document.commit({
      documentId: trialSnapshot.id,
      expectedVersion: trialSnapshot.version,
      edits,
      origin: 'vim',
      undoGroup: id<UndoGroupId>(`T089-edit-group-${count}`),
    });
    if (!committed.ok || committed.value.kind !== 'committed') throw new Error(`T089-edit:${count}`);
    if ((committed.value.change.snapshot.lengthUtf16 as number) !== source.length + count) throw new Error(`T089-edit-length:${count}`);
  }, 2, benchmarkSamples);
  results[String(count)] = { create, reverseCreate, mapping, render: rendered, twoViews: true, edit: edited };
}
layout.dispose();
const artifact = resolve('.artifacts/selections/t089-qualification.json');
await mkdir(resolve('.artifacts/selections'), { recursive: true });
const failureCases = runFailureCases(snapshot, changed.changeMap, changed.snapshot);
const fixtureCoverage = {
  sortedAndReverseCreation: true,
  overlapAndDuplicateCanonicalization: 'T075-MC02',
  visualBlockAndMixedUnicode: 'T075-MC02-BLOCK/T075-MC04-UTF16',
  twoViews: true,
  staleApply: failureCases.staleApplyRejected,
  conflictingBatch: failureCases.conflictingBatchRejected,
  partialPublication: failureCases.noPartialPublication,
  cancellation: 'not available in synchronous SelectionSet API; async coordinator coverage remains T076/T088',
};
await writeFile(artifact, `${JSON.stringify({ schemaVersion: 2, fixture: 'T089-SELECTION-SCALE-01', sourceUtf16Units: source.length, counts, benchmarkSamples, results, failureCases, fixtureCoverage }, null, 2)}\n`);
console.log(JSON.stringify({ fixture: 'T089-SELECTION-SCALE-01', sourceUtf16Units: source.length, counts, benchmarkSamples, results, failureCases, fixtureCoverage, artifact }, null, 2));

function makeSelectionSet(base: ReturnType<TextFileDocument['snapshot']>, count: number, reverse = false): SelectionSetSnapshot {
  const primaryId = id<SelectionId>('T089-selection-0');
  const members = Array.from({ length: count }, (_, index) => {
    const memberId = id<SelectionId>(`T089-selection-${index}`);
    const point = offset(index * 4);
    const endpoint = { kind: 'gap' as const, offset: point, affinity: 'right' as const };
    return { id: memberId, kind: 'insert-caret' as const, direction: 'forward' as const, anchor: endpoint, head: endpoint };
  }).sort((left, right) => reverse ? right.anchor.offset - left.anchor.offset : left.anchor.offset - right.anchor.offset);
  const created = createSelectionSet(base, { primaryId, members });
  if (!created.ok) throw new Error(`T089-selection:${count}:${created.error.kind}`);
  return created.value.selectionSet;
}

function runFailureCases(
  base: ReturnType<TextFileDocument['snapshot']>,
  changeMap: DocumentChangeMap,
  destination: DocumentSnapshot,
): { readonly staleApplyRejected: boolean; readonly conflictingBatchRejected: boolean; readonly noPartialPublication: boolean } {
  const selection = makeSelectionSet(base, 10);
  const stale = mapSelectionSet(selection, changeMap, base);
  const staleApplyRejected = !stale.ok && stale.error.kind === 'invalid-change-map';
  if (!staleApplyRejected) throw new Error('T089-stale-apply');

  const target = openTextDocument(id<DocumentId>('T089-conflict-document'), new TextEncoder().encode('abcdef'));
  if (target.kind !== 'editable') throw new Error('T089-conflict-open');
  const before = target.document.snapshot();
  const conflicting = target.document.commit({
    documentId: before.id,
    expectedVersion: before.version,
    edits: [{ start: offset(1), end: offset(4), text: 'X' }, { start: offset(2), end: offset(5), text: 'Y' }],
    origin: 'vim',
    undoGroup: id<UndoGroupId>('T089-conflict-group'),
  });
  const conflictingBatchRejected = !conflicting.ok && conflicting.error.kind === 'overlapping-edits';
  if (!conflictingBatchRejected) throw new Error('T089-conflict-batch');
  const after = target.document.snapshot();
  const read = after.slice(offset(0), offset(6));
  const noPartialPublication = read.ok && read.value === 'abcdef' && after.version === before.version;
  if (!noPartialPublication) throw new Error('T089-partial-publication');
  const mapped = mapSelectionSet(selection, changeMap, destination);
  if (!mapped.ok || mapped.value.selectionSet.members.length !== selection.members.length) throw new Error('T089-valid-map');
  return { staleApplyRejected, conflictingBatchRejected, noPartialPublication };
}

function measure(operation: () => void, warmups: number, samples: number): { readonly samples: number; readonly p50Ms: number; readonly p95Ms: number; readonly p99Ms: number; readonly maxMs: number } {
  for (let index = 0; index < warmups; index += 1) operation();
  const values: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const start = performance.now();
    operation();
    values.push(performance.now() - start);
  }
  values.sort((a, b) => a - b);
  const at = (fraction: number) => values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * fraction) - 1))] ?? 0;
  return { samples: values.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: values.at(-1) ?? 0 };
}

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T089-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function offset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error(`T089-offset:${value}`);
  return result.value;
}
