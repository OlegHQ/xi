import { strict as assert } from 'node:assert';
import {
  asIdentifier,
  asUtf16Offset,
  type DocumentId,
  type SelectionId,
  type Utf16Offset,
  type ViewId,
} from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { createSelectionSet, type SelectionMemberInput, type SelectionSet } from '../../packages/selections/src/index';
import { createAtomicWorkbenchState, type AtomicRegisterValue, type AtomicViewState } from '../../packages/workbench/editing/atomic-command';

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'G5-perf-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function offset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function gap(id: SelectionId, position: number): SelectionMemberInput {
  const endpoint = { kind: 'gap' as const, offset: offset(position) };
  return { id, kind: 'insert-caret', direction: 'forward', anchor: endpoint, head: endpoint };
}

const document = TextFileDocument.create(identifier<DocumentId>('G5-perf-document'), 'a\nb\nc\n', ['lf', 'lf', 'lf'], 'lf');
if (!document.ok) throw new Error('G5-perf: could not build fixture document');
const snapshot = document.value.snapshot();

function selection(viewId: string, position: number): SelectionSet {
  const id = identifier<SelectionId>(`${viewId}-primary`);
  const created = createSelectionSet(snapshot, { primaryId: id, selectionGeneration: 0, members: [gap(id, position)] });
  if (!created.ok) throw new Error(`G5-perf-selection:${created.error.kind}`);
  return created.value.selectionSet;
}

// Realistic dot-repeat payload: a small nested edit description, not a bare primitive --
// this is what makes the recursive validating clone in `cloneSerializedSelectionValue`
// actually do work per call.
const repeatTarget = Object.freeze({
  kind: 'change',
  edits: Object.freeze(Array.from({ length: 20 }, (_v, index) => Object.freeze({ start: index, end: index + 1, text: `x${index}` }))),
});

// 8 views (a realistic multi-window/multi-cursor session), 26 registers (a-z plus specials),
// each holding a moderately sized string -- named per docs/performance.md's ordinary
// engine-step budget (p95 <= 1ms), this must stay far under that for a selection-changing
// keystroke that runs many such calls per key.
const views: AtomicViewState[] = Array.from({ length: 8 }, (_v, index) => Object.freeze({
  viewId: identifier<ViewId>(`G5-perf-view-${index}`),
  selections: selection(`G5-perf-view-${index}`, index % 3),
  mode: 'insert' as const,
  repeatTarget,
}));
const registers: AtomicRegisterValue[] = Array.from({ length: 26 }, (_v, index) => Object.freeze({
  name: String.fromCharCode(97 + index),
  value: `register-payload-${index}-${'x'.repeat(64)}`,
}));

const seeded = createAtomicWorkbenchState(snapshot, { activeViewId: views[0]!.viewId, views, registers }, 0);
assert.equal(seeded.ok, true, 'G5-perf-seed the fixture state validates once');
if (!seeded.ok) throw new Error('unreachable');

// G5: once views/registers are the *frozen output* of a prior createAtomicWorkbenchState call
// (as every publish after the first passes them straight back in, unchanged), a
// selection-changing keystroke must not pay for re-walking and re-cloning them again -- the
// frozen fast path in `cheapCloneSelectionValue` must make this effectively free.
const state = seeded.value;
const iterations = 500;
const samples: number[] = [];
for (let i = 0; i < iterations; i += 1) {
  const start = performance.now();
  const result = createAtomicWorkbenchState(snapshot, { activeViewId: state.activeViewId, views: state.views, registers: state.registers }, i);
  const elapsed = performance.now() - start;
  assert.equal(result.ok, true, `G5-perf-call-${i} revalidation succeeds`);
  samples.push(elapsed);
}
samples.sort((a, b) => a - b);
const p95 = samples[Math.floor(samples.length * 0.95)] as number;
const thresholdMilliseconds = 1;
assert.ok(p95 < thresholdMilliseconds, `G5-perf p95=${p95.toFixed(4)}ms must stay under ${thresholdMilliseconds}ms for already-frozen views/registers (8 views, 26 registers)`);

console.log(`G5 createAtomicWorkbenchState frozen-input fast path passed: p95=${p95.toFixed(4)}ms over ${iterations} iterations (threshold ${thresholdMilliseconds}ms)`);
