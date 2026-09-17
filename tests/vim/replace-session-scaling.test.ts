// Verifies the O(n^2)-to-O(n) fix for a long Replace-mode session in
// packages/vim/insert/index.ts: appendReplaceFrame/popReplaceFrame mutate the
// session's privately-owned frame stack in place instead of copying it (via
// spread) on every keystroke, and freezeSession no longer re-clones every
// already-frozen frame on every keystroke. A 10x increase in keystroke count
// should cost roughly 10x the time, not ~100x.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { TextFileDocument } from '../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId } from '../../packages/primitives/src/index';
import { beginVimInsert, planVimInsertInput, type VimInsertSession } from '../../packages/vim/insert/index';

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'replace-scaling-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function zero() {
  const result = asUtf16Offset(0);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function longLineDocument(id: string, length: number): TextFileDocument {
  const result = TextFileDocument.create(identifier<DocumentId>(id), 'a'.repeat(length), [], 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

// Fixed regardless of keystroke count: `replacePayload` scans the current
// line once per keystroke (an orthogonal, non-quadratic O(line length) cost),
// so the line length must stay constant across runs or it would itself
// contribute a spurious O(keystrokes * lineLength) term to the comparison.
const LINE_LENGTH = 25_000;

/** Types `keystrokes` single-character Replace-mode keys and returns the elapsed time in ms. */
function timeReplaceRun(label: string, keystrokes: number): number {
  const doc = longLineDocument(label, LINE_LENGTH);
  const snapshot = doc.snapshot();
  const entered = beginVimInsert(snapshot, zero(), 'R');
  assert.equal(entered.ok, true, `${label}-ENTER-01 Replace mode starts`);
  if (!entered.ok) throw new Error('enter');
  let session: VimInsertSession = entered.value.session;
  const start = performance.now();
  for (let index = 0; index < keystrokes; index += 1) {
    const step = planVimInsertInput(snapshot, session, { kind: 'key', key: 'x' });
    if (!step.ok || step.value.kind !== 'continued') throw new Error(`${label}-STEP-${index} unexpected result`);
    session = step.value.session;
  }
  assert.equal(session.replaceStack.length, keystrokes, `${label}-STACK-01 one replace frame recorded per keystroke`);
  assert.equal(session.repeatLength, keystrokes, `${label}-REPEAT-01 repeat text captures every typed character`);
  return performance.now() - start;
}

// Warm up the JIT before measuring, so tier-up effects do not distort the ratio.
timeReplaceRun('SCALING-WARMUP', 500);

const small = timeReplaceRun('SCALING-SMALL', 2000);
const large = timeReplaceRun('SCALING-LARGE', 20000);
const ratio = large / Math.max(small, 0.001);

// A 10x keystroke increase should cost roughly 10x the time for a linear
// implementation; a quadratic one costs roughly 100x. The measured pre-fix
// implementation (array-spread replaceStack growth plus a full-session
// isSessionValid re-validation of the whole accumulated repeatText/
// replaceStack on every keystroke) measured a ~60-90x ratio for this exact
// comparison. Allow generous headroom above the ~10x linear expectation for
// GC/allocator/scheduler noise without letting real quadratic behavior pass.
assert.ok(ratio < 25, `SCALING-RATIO-01 10x keystrokes should cost roughly linear time, not quadratic (small=${small.toFixed(3)}ms large=${large.toFixed(3)}ms ratio=${ratio.toFixed(2)})`);

console.log(`T-REPLACE-SCALING passed: 2000 keys=${small.toFixed(3)}ms, 20000 keys=${large.toFixed(3)}ms, ratio=${ratio.toFixed(2)}x (linear budget < 25x for a 10x increase)`);
