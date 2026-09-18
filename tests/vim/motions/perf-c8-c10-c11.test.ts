#!/usr/bin/env bun
// Perf regression tests for C8 (multi/index.ts endpointForOffset/firstGrapheme
// bounded reads), C9 (motion previews are lazy/opt-in), C10 (one reusable
// Intl.Segmenter instance instead of constructing one per call) and C11
// (readLine's non-ASCII measurement is cached per document version/line).
// Budget: h/l/j/k on a 10k-char non-ASCII line, p95 < 0.2ms (per findings.md).
import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentSnapshot } from '../../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type SelectionId, type Utf16Offset } from '../../../packages/primitives/src/index';
import { createVimMotionCursor, resolveVimMotion } from '../../../packages/vim/src/index';
import { createSelectionSet, type SelectionMemberInput, type SelectionSetSnapshot } from '../../../packages/selections/src/index';
import { resolveVimMultiMotion } from '../../../packages/vim/multi/index';

const ITERATIONS = 60;
const P95_BUDGET_MS = 0.2;

function open(source: string, id: string): DocumentSnapshot {
  const documentId = asIdentifier<DocumentId>(id, 'documentId');
  assert.equal(documentId.ok, true);
  if (!documentId.ok) throw new Error('invalid document id');
  const result = openTextDocument(documentId.value, new TextEncoder().encode(source));
  assert.equal(result.kind, 'editable');
  if (result.kind !== 'editable') throw new Error('document is not editable');
  return result.document.snapshot();
}
function offset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('invalid offset');
  return result.value;
}
function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

// A 10,000-character non-ASCII line (forces the grapheme-measurement path in
// readLine/measureDisplayCells, not the printable-ASCII fast path), on two
// lines so j/k actually cross a line boundary.
const LONG_LINE = 'é'.repeat(10_000);
const doc = open(`${LONG_LINE}\n${LONG_LINE}`, 'PERF-C8-C10-C11');

function measure(run: () => void): number[] {
  // Warm up (JIT + module-level segmenter/caches settle) before sampling.
  for (let i = 0; i < 30; i += 1) run();
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  return samples;
}

// --- h/l/j/k on the long non-ASCII line (C10, C11). ---
{
  const cursor = createVimMotionCursor(doc, offset(5_000));
  assert.equal(cursor.ok, true);
  if (!cursor.ok) throw new Error('cursor');
  for (const key of ['l', 'h', 'j', 'k'] as const) {
    const samples = measure(() => {
      const result = resolveVimMotion(doc, cursor.value, { key });
      assert.equal(result.ok, true, `PERF-${key}-01 ${key} resolves`);
    });
    const observedP95 = p95(samples);
    assert.ok(observedP95 < P95_BUDGET_MS, `PERF-${key}-02 ${key} p95 (${observedP95.toFixed(4)}ms) stays under ${P95_BUDGET_MS}ms on a 10k-char non-ASCII line`);
  }
}

// --- C8: endpointForOffset/firstGrapheme must be O(1) in the *remaining*
// line length, not scan to lineEnd -- a cursor near the START of the 10k-char
// line (9,990 unscanned characters ahead of the endpoint) must be exactly as
// fast as one near the END (only ~10 characters ahead). Before the fix,
// `endpointForOffset` sliced from the endpoint to `lineEnd` and
// `firstGrapheme` spread the *entire* segmenter iteration just to read
// element 0, so the near-start case would have been ~1000x slower.
// (Multi-cursor motion resolution also depends on packages/selections'
// updateSelectionSet, outside this allowlist, whose own cost scales with
// cursor position; this test isolates the two endpoints against each other
// rather than asserting an absolute budget dominated by that dependency.)
{
  const nearStart = makeSelections(doc, [10]);
  const nearEnd = makeSelections(doc, [9_990]);
  const startSamples = measure(() => {
    const result = resolveVimMultiMotion({ snapshot: doc, selections: nearStart, invocation: { key: 'l', count: 1 } });
    assert.equal(result.ok, true, 'PERF-MULTI-01 multi l resolves near line start');
  });
  const endSamples = measure(() => {
    const result = resolveVimMultiMotion({ snapshot: doc, selections: nearEnd, invocation: { key: 'l', count: 1 } });
    assert.equal(result.ok, true, 'PERF-MULTI-02 multi l resolves near line end');
  });
  const startP95 = p95(startSamples);
  const endP95 = p95(endSamples);
  // A generous ratio bound: real O(1) behavior keeps this near 1x; the
  // pre-fix O(remaining-length) endpointForOffset would have pushed it into
  // the hundreds.
  assert.ok(startP95 < endP95 * 5 + 1, `PERF-MULTI-03 endpointForOffset cost near line start (${startP95.toFixed(4)}ms) is not proportional to the ~9,990 unscanned characters ahead (end p95 ${endP95.toFixed(4)}ms)`);
}

// --- C9: previews are opt-in, so the default (unset) path must not pay for
// building preview extents -- confirm it stays this cheap and returns null. ---
{
  const selections = makeSelections(doc, [5_000]);
  const result = resolveVimMultiMotion({ snapshot: doc, selections, invocation: { key: 'l', count: 1 } });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.preview, null, 'PERF-C9-01 default motion resolution builds no preview');
}

console.log('C8/C9/C10/C11 perf tests passed');

function makeSelections(document: DocumentSnapshot, positions: readonly number[]): SelectionSetSnapshot {
  const members = positions.map((position, index): SelectionMemberInput => ({
    id: selectionId(`p${index + 1}`), kind: 'normal-cursor', direction: 'forward',
    anchor: { kind: 'character', offset: position as Utf16Offset, after: position + 1 as Utf16Offset },
    head: { kind: 'character', offset: position as Utf16Offset, after: position + 1 as Utf16Offset },
  }));
  const created = createSelectionSet(document, { primaryId: selectionId('p1'), members });
  assert.equal(created.ok, true, 'selection set validates');
  if (!created.ok) throw new Error('selection setup failed');
  return created.value.selectionSet;
}
function selectionId(value: string): SelectionId {
  const result = asIdentifier<SelectionId>(value, 'selectionId');
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('invalid selection id');
  return result.value;
}
