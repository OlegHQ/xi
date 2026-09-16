#!/usr/bin/env bun
import { createCorpora, forceGc, memorySnapshot } from './corpora';
import { candidates, type CandidateDefinition } from './adapter';

const candidateId = process.argv[2];
const candidate = candidates.find((entry) => entry.id === candidateId);
if (candidate === undefined) throw new Error(`unknown-memory-probe-candidate: ${candidateId ?? 'missing'}`);

const corpora = createCorpora();
const batch = await measureBatchOpen(candidate, corpora.batchText);
const middleInsert = await measureMiddleInsert(candidate, corpora.fragmentationSeed);
const undo = await measureUndo(candidate, corpora.longLine);
console.log(JSON.stringify({ candidateId, batch, middleInsert, undo }));

async function measureBatchOpen(candidateDefinition: CandidateDefinition, text: string) {
  await settleGc();
  const before = memorySnapshot();
  const model = candidateDefinition.open(text);
  await settleGc();
  const after = memorySnapshot();
  const metrics = model.metrics();
  return {
    heapRetainedDeltaBytes: after.heapUsedBytes - before.heapUsedBytes,
    rssRetainedDeltaBytes: after.rssBytes - before.rssBytes,
    retainedNodes: metrics.retainedNodes,
    retainedPayloadUnits: metrics.retainedPayloadUnits,
    treeHeight: metrics.treeHeight,
  };
}

async function measureMiddleInsert(candidateDefinition: CandidateDefinition, initialText: string) {
  const model = candidateDefinition.open(initialText);
  await settleGc();
  const before = memorySnapshot();
  for (let operation = 0; operation < 100_000; operation += 1) {
    const offset = Math.floor(model.length / 2);
    model.replace(offset, offset, 'x');
  }
  await settleGc();
  const after = memorySnapshot();
  const metrics = model.metrics();
  return {
    operations: 100_000,
    heapRetainedDeltaBytes: after.heapUsedBytes - before.heapUsedBytes,
    rssRetainedDeltaBytes: after.rssBytes - before.rssBytes,
    retainedNodes: metrics.retainedNodes,
    retainedPayloadUnits: metrics.currentPayloadUnits,
    treeHeight: metrics.treeHeight,
  };
}

async function measureUndo(candidateDefinition: CandidateDefinition, initialText: string) {
  const model = candidateDefinition.open(initialText);
  await settleGc();
  const before = memorySnapshot();
  for (let operation = 0; operation < 1000; operation += 1) {
    const offset = Math.floor(initialText.length / 2);
    model.replace(offset, offset, 'u', true);
  }
  await settleGc();
  const after = memorySnapshot();
  const metrics = model.metrics();
  return {
    operations: 1000,
    heapRetainedDeltaBytes: after.heapUsedBytes - before.heapUsedBytes,
    rssRetainedDeltaBytes: after.rssBytes - before.rssBytes,
    historyEntries: metrics.historyEntries,
    retainedNodes: metrics.retainedNodes,
    retainedPayloadUnits: metrics.retainedPayloadUnits,
  };
}

async function settleGc(): Promise<void> {
  forceGc();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  forceGc();
}
