import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type SelectionId, type Utf16Offset } from '../../packages/primitives/src/index';
import { openTextDocument, type TextFileDocument } from '../../packages/document/src/index';
import { createSelectionSet, updateSelectionSet, type SelectionMemberInput, type SelectionSet } from '../../packages/selections/src/index';

/**
 * Regression for a column-dependent scan on a single long non-ASCII line: resolving a
 * cursor's semantic endpoint (scalarWidthAt / previousScalarStart in
 * packages/selections/src/index.ts, both surrogate-safe via narrow probes per A2's
 * technique) must cost the same near line-start as near line-end, not scale with the
 * cursor's column offset within the line. 200 cursors on one 20k-char mixed-script line,
 * one `l`-style motion (every member's offset advanced by one scalar) mapped through
 * updateSelectionSet: p95 < 1 ms over 100 iterations, and near-start vs near-end cost
 * ratio < 2.
 */
const LINE_LENGTH = 20_000;
const ITERATIONS = 100;

function main(): void {
  const document = openEditable(buildMixedLine(LINE_LENGTH));
  const snapshot = document.snapshot();

  const offsets = spreadOffsets(snapshot, 200, 2, LINE_LENGTH - 100);
  const set = buildSet(snapshot, offsets);

  // Warm up the JIT before measuring; the perf budget targets steady-state cost.
  for (let warm = 0; warm < 120; warm += 1) {
    const advanced = advanceMembers(snapshot, set);
    updateSelectionSet(snapshot, set, { primaryId: set.primaryId, members: advanced });
  }

  const samples: number[] = [];
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const advanced = advanceMembers(snapshot, set);
    const started = performance.now();
    const updated = updateSelectionSet(snapshot, set, { primaryId: set.primaryId, members: advanced });
    samples.push(performance.now() - started);
    assert.equal(updated.ok, true, `updateSelectionSet must not fail (got ${updated.ok ? '' : JSON.stringify(updated.error)})`);
    if (!updated.ok) return;
  }
  samples.sort((left, right) => left - right);
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? samples[samples.length - 1]!;
  assert.ok(p95 < 1, `p95 for a 200-cursor 'l' motion on a 20k-char line must stay < 1 ms, got ${p95.toFixed(4)} ms`);

  const startOffsets = spreadOffsets(snapshot, 200, 2, 1000);
  const endOffsets = spreadOffsets(snapshot, 200, LINE_LENGTH - 1000, LINE_LENGTH - 2);
  const startSet = buildSet(snapshot, startOffsets);
  const endSet = buildSet(snapshot, endOffsets);

  const startCost = timeMotion(snapshot, startSet, ITERATIONS);
  const endCost = timeMotion(snapshot, endSet, ITERATIONS);
  const ratio = endCost / Math.max(startCost, 0.001);
  assert.ok(
    ratio < 2,
    `near-end cost must stay within 2x of near-start cost on a 20k-char line, got start=${startCost.toFixed(4)}ms end=${endCost.toFixed(4)}ms ratio=${ratio.toFixed(2)}`,
  );

  console.log(`T-SELECTIONS-PERF-COLUMN-INDEPENDENT-01 passed: p95=${p95.toFixed(4)}ms start=${startCost.toFixed(4)}ms end=${endCost.toFixed(4)}ms ratio=${ratio.toFixed(2)}`);
}

function timeMotion(snapshot: ReturnType<TextFileDocument['snapshot']>, initial: SelectionSet, iterations: number): number {
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const advanced = advanceMembers(snapshot, initial);
    const started = performance.now();
    const updated = updateSelectionSet(snapshot, initial, { primaryId: initial.primaryId, members: advanced });
    samples.push(performance.now() - started);
    if (!updated.ok) throw new Error(`updateSelectionSet failed: ${JSON.stringify(updated.error)}`);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length * 0.5)] ?? samples[0]!;
}

function advanceMembers(snapshot: ReturnType<TextFileDocument['snapshot']>, set: SelectionSet): SelectionMemberInput[] {
  return set.members.map((member) => {
    const at = member.anchor.kind === 'character' ? (member.anchor.at.offset as number) : 0;
    const width = member.anchor.kind === 'character' ? (member.anchor.after.offset as number) - at : 1;
    const nextOffset = at + width;
    const nextWidth = scalarWidth(snapshot, nextOffset);
    const endpoint = { kind: 'character' as const, offset: nextOffset as Utf16Offset, after: (nextOffset + nextWidth) as Utf16Offset };
    return {
      id: member.id,
      kind: 'normal-cursor' as const,
      direction: 'forward' as const,
      anchor: endpoint,
      head: endpoint,
      creationOrdinal: member.creationOrdinal,
    };
  });
}

// Surrogate-safe scalar width probe (same narrow-probe technique as A2's scalarWidthAt).
function scalarWidth(snapshot: ReturnType<TextFileDocument['snapshot']>, start: number): number {
  const one = snapshot.slice(start as Utf16Offset, (start + 1) as Utf16Offset);
  return one.ok ? 1 : 2;
}

function buildSet(snapshot: ReturnType<TextFileDocument['snapshot']>, offsets: readonly number[]): SelectionSet {
  const members: SelectionMemberInput[] = offsets.map((value, index) => normal(sid(`m${index}`), value));
  const created = createSelectionSet(snapshot, { primaryId: members[0]!.id, members });
  if (!created.ok) throw new Error(`createSelectionSet failed: ${JSON.stringify(created.error)}`);
  return created.value.selectionSet;
}

// Walk [low, high) taking every offset at which a one-unit-wide character selection
// is valid (i.e. not splitting a surrogate pair) until `count` are collected.
function spreadOffsets(snapshot: ReturnType<TextFileDocument['snapshot']>, count: number, low: number, high: number): number[] {
  const offsets: number[] = [];
  for (let offset = low; offset < high && offsets.length < count; offset += 1) {
    const slice = snapshot.slice(offset as Utf16Offset, (offset + 1) as Utf16Offset);
    if (slice.ok) offsets.push(offset);
  }
  if (offsets.length < count) throw new Error(`could not find ${count} valid offsets in [${low},${high})`);
  return offsets;
}

function buildMixedLine(length: number): string {
  const units = ['é', '😀', '漢', 'a', 'b'];
  let line = '';
  let index = 0;
  while (line.length < length) {
    line += units[index % units.length];
    index += 1;
  }
  return `${line.slice(0, length)}\n`;
}

function openEditable(text: string): TextFileDocument {
  const documentId = asIdentifier<DocumentId>('perf-column-independent', 'documentId');
  if (!documentId.ok) throw new Error(documentId.error.message);
  const opened = openTextDocument(documentId.value, new TextEncoder().encode(text));
  if (opened.kind !== 'editable') throw new Error(`expected-editable:${opened.document.explanation}`);
  return opened.document;
}

function sid(value: string): SelectionId {
  const result = asIdentifier<SelectionId>(value, 'selectionId');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function normal(selectionId: SelectionId, offset: number): SelectionMemberInput {
  const endpoint = { kind: 'character' as const, offset: offset as Utf16Offset, after: (offset + 1) as Utf16Offset };
  return { id: selectionId, kind: 'normal-cursor', direction: 'forward', anchor: endpoint, head: endpoint };
}

main();
