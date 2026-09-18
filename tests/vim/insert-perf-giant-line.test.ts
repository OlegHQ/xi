// Verifies the D11 fix in packages/vim/insert/index.ts: readLineWindow's
// per-key backward read is now bounded (LINE_WINDOW_BACKWARD_MARGIN, widened
// only up to LINE_WINDOW_DYNAMIC_BACKWARD_CAP for a same-line entry/auto-indent
// floor) instead of always reaching back to the true line start. Backspace,
// Enter, Tab, <C-w>, <C-u> and Esc on a 1 MiB single-line document, pressed at
// the end and in the middle of the line, must each stay well under budget and
// must produce the exact same *kind* of edit (deleted/inserted text content
// and length) as the identical key sequence on a small line with equivalent
// local context -- the bounded window must not change Vim semantics.
import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';
import { TextFileDocument } from '../../packages/document/src/index';
import { asIdentifier, asUndoGroupId, asUtf16Offset, type DocumentId } from '../../packages/primitives/src/index';
import {
  beginVimInsert,
  planVimInsertInput,
  type VimInsertOptions,
  type VimInsertPlan,
  type VimInsertSession,
} from '../../packages/vim/insert/index';

const BUDGET_MS = 1;
const ITERATIONS = 30;
const WARMUP_ITERATIONS = 3;

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'insert-perf-giant-line-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function offset(value: number) {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error(`invalid offset ${value}`);
  return result.value;
}

let nextDocSeq = 0;
function document(text: string): TextFileDocument {
  const result = TextFileDocument.create(identifier<DocumentId>(`GIANT-${nextDocSeq++}`), text, [], 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function applyPlan(doc: TextFileDocument, plan: VimInsertPlan): ReturnType<TextFileDocument['snapshot']> {
  const group = asUndoGroupId(`insert-perf-giant-line-${plan.expectedVersion as number}-${nextDocSeq}`);
  if (!group.ok) throw new Error('invalid undo group');
  const committed = doc.commit({
    documentId: plan.documentId,
    expectedVersion: plan.expectedVersion,
    edits: plan.edits,
    origin: 'vim',
    undoGroup: group.value,
  });
  if (!committed.ok) throw new Error(`commit failed: ${committed.error.kind}`);
  return doc.snapshot();
}

function enter(doc: TextFileDocument, cursor: number, options: VimInsertOptions = {}): VimInsertSession {
  const entered = beginVimInsert(doc.snapshot(), offset(cursor), 'i', options);
  assert.equal(entered.ok, true, 'insert enters');
  if (!entered.ok) throw new Error('unreachable');
  return entered.value.session;
}

/** Type plain text keys and commit each edit, so the document reflects it for the next key. */
function typeAndCommit(doc: TextFileDocument, session: VimInsertSession, text: string): VimInsertSession {
  let current = session;
  for (const char of text) {
    const step = planVimInsertInput(doc.snapshot(), current, { kind: 'key', key: char });
    assert.equal(step.ok, true, `typing '${char}' succeeds`);
    if (!step.ok || (step.value.kind !== 'continued' && step.value.kind !== 'entered')) throw new Error('unreachable');
    applyPlan(doc, step.value.plan);
    current = step.value.session;
  }
  return current;
}

function percentileMs(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  const value = sorted[index];
  if (value === undefined) throw new Error('empty sample set');
  return value;
}

/**
 * Time `timed(setup())` ITERATIONS times, where `setup()` (document/session
 * construction) is untimed and only the key-planning call itself is measured.
 * Reused across warmup and measured iterations; asserts p95 < BUDGET_MS.
 */
function measure<T>(label: string, setup: () => T, timed: (args: T) => void): void {
  for (let i = 0; i < WARMUP_ITERATIONS; i += 1) timed(setup());
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const args = setup();
    const start = performance.now();
    timed(args);
    samples.push(performance.now() - start);
  }
  const p95 = percentileMs(samples, 0.95);
  assert.ok(p95 < BUDGET_MS, `${label} p95 (${p95.toFixed(3)}ms) is within budget (${BUDGET_MS}ms)`);
  console.log(`  ${label}: p95=${p95.toFixed(3)}ms over ${ITERATIONS} iterations`);
}

const GIANT_LENGTH = 1_000_000;
const GIANT_LINE = 'a'.repeat(GIANT_LENGTH);
const GIANT_END = GIANT_LENGTH;
const GIANT_MIDDLE = GIANT_LENGTH / 2;

// --- Backspace -------------------------------------------------------------
function checkBackspace(position: number, label: string): void {
  const doc = document(GIANT_LINE);
  const snapshot = doc.snapshot();
  const setup = () => ({ session: enter(doc, position) });
  const timed = ({ session }: { session: VimInsertSession }) => {
    const step = planVimInsertInput(snapshot, session, { kind: 'key', key: '<BS>' });
    assert.equal(step.ok, true, `${label}: backspace succeeds`);
    if (!step.ok || step.value.kind !== 'continued') throw new Error('unreachable');
    assert.equal(step.value.plan.edits.length, 1, `${label}: backspace produces one edit`);
    const edit = step.value.plan.edits[0];
    if (edit === undefined) throw new Error('unreachable');
    assert.equal(edit.text, '', `${label}: backspace deletes (inserts nothing)`);
    assert.equal((edit.end as number) - (edit.start as number), 1, `${label}: backspace deletes exactly one grapheme`);
    assert.equal(edit.end, position, `${label}: backspace's deleted range ends at the cursor`);
  };
  measure(`Backspace (${label})`, setup, timed);

  // Correctness vs. the same op on a small line with identical local content.
  const smallDoc = document('aaaaa');
  const smallSession = enter(smallDoc, 5);
  const smallStep = planVimInsertInput(smallDoc.snapshot(), smallSession, { kind: 'key', key: '<BS>' });
  assert.equal(smallStep.ok, true, `${label}: small-line backspace succeeds`);
  if (!smallStep.ok || smallStep.value.kind !== 'continued') throw new Error('unreachable');
  const smallEdit = smallStep.value.plan.edits[0];
  if (smallEdit === undefined) throw new Error('unreachable');
  assert.equal(smallEdit.text, '', `${label}: small-line backspace also deletes`);
  assert.equal((smallEdit.end as number) - (smallEdit.start as number), 1, `${label}: small-line backspace also deletes one grapheme`);
}

// --- Enter (autoindent) -----------------------------------------------------
const INDENT = '    ';
const GIANT_INDENTED_LINE = INDENT + 'a'.repeat(GIANT_LENGTH - INDENT.length);
function checkEnter(position: number, label: string): void {
  const options: VimInsertOptions = { autoindent: true };
  const doc = document(GIANT_INDENTED_LINE);
  const snapshot = doc.snapshot();
  const setup = () => ({ session: enter(doc, position, options) });
  const timed = ({ session }: { session: VimInsertSession }) => {
    const step = planVimInsertInput(snapshot, session, { kind: 'key', key: '<CR>' });
    assert.equal(step.ok, true, `${label}: enter succeeds`);
    if (!step.ok || step.value.kind !== 'continued') throw new Error('unreachable');
    assert.equal(step.value.plan.edits.length, 1, `${label}: enter produces one edit`);
    const edit = step.value.plan.edits[0];
    if (edit === undefined) throw new Error('unreachable');
    assert.equal(edit.text, `\n${INDENT}`, `${label}: enter carries the true line's leading indent`);
  };
  measure(`Enter (${label})`, setup, timed);

  const smallDoc = document(`${INDENT}aaaaa`);
  const smallSession = enter(smallDoc, INDENT.length + 5, options);
  const smallStep = planVimInsertInput(smallDoc.snapshot(), smallSession, { kind: 'key', key: '<CR>' });
  assert.equal(smallStep.ok, true, `${label}: small-line enter succeeds`);
  if (!smallStep.ok || smallStep.value.kind !== 'continued') throw new Error('unreachable');
  const smallEdit = smallStep.value.plan.edits[0];
  if (smallEdit === undefined) throw new Error('unreachable');
  assert.equal(smallEdit.text, `\n${INDENT}`, `${label}: small-line enter carries the same indent`);
}

// --- Tab (expandtab) ---------------------------------------------------------
function checkTab(position: number, label: string): void {
  const options: VimInsertOptions = { expandtab: true, tabstop: 4 };
  const doc = document(GIANT_LINE);
  const snapshot = doc.snapshot();
  const setup = () => ({ session: enter(doc, position, options) });
  const timed = ({ session }: { session: VimInsertSession }) => {
    const step = planVimInsertInput(snapshot, session, { kind: 'key', key: '<Tab>' });
    assert.equal(step.ok, true, `${label}: tab succeeds`);
    if (!step.ok || step.value.kind !== 'continued') throw new Error('unreachable');
    const edit = step.value.plan.edits[0];
    if (edit === undefined) throw new Error('unreachable');
    // `position` is a multiple of 4 both at GIANT_END and GIANT_MIDDLE, so
    // expandtab pads a full tabstop of spaces.
    assert.equal(edit.text, '    ', `${label}: tab expands to spaces up to the next tabstop`);
  };
  measure(`Tab (${label})`, setup, timed);

  const smallDoc = document('aaaa');
  const smallSession = enter(smallDoc, 4, options);
  const smallStep = planVimInsertInput(smallDoc.snapshot(), smallSession, { kind: 'key', key: '<Tab>' });
  assert.equal(smallStep.ok, true, `${label}: small-line tab succeeds`);
  if (!smallStep.ok || smallStep.value.kind !== 'continued') throw new Error('unreachable');
  const smallEdit = smallStep.value.plan.edits[0];
  if (smallEdit === undefined) throw new Error('unreachable');
  assert.equal(smallEdit.text, '    ', `${label}: small-line tab expands the same way`);
}

// --- Ctrl-w (delete previous word) -------------------------------------------
function checkCtrlW(position: number, label: string): void {
  const run = () => {
    const doc = document(GIANT_LINE);
    let session = enter(doc, position);
    session = typeAndCommit(doc, session, 'foo');
    const step = planVimInsertInput(doc.snapshot(), session, { kind: 'key', key: '<C-w>' });
    assert.equal(step.ok, true, `${label}: ctrl-w succeeds`);
    if (!step.ok || step.value.kind !== 'continued') throw new Error('unreachable');
    assert.equal(step.value.plan.edits.length, 1, `${label}: ctrl-w produces one edit`);
    const edit = step.value.plan.edits[0];
    if (edit === undefined) throw new Error('unreachable');
    assert.equal(edit.text, '', `${label}: ctrl-w deletes`);
    assert.equal((edit.end as number) - (edit.start as number), 3, `${label}: ctrl-w deletes exactly the typed word`);
    assert.equal(edit.start, position, `${label}: ctrl-w stops exactly at the entry point`);
  };
  // Not measured on the shared 30-sample loop below with typing included --
  // only the <C-w> call itself is timed.
  const warmup = () => {
    const doc = document(GIANT_LINE);
    let session = enter(doc, position);
    session = typeAndCommit(doc, session, 'foo');
    void planVimInsertInput(doc.snapshot(), session, { kind: 'key', key: '<C-w>' });
  };
  measureCtrlLike(`Ctrl-w (${label})`, position, warmup, run);

  const smallDoc = document('bbbbb');
  let smallSession = enter(smallDoc, 5);
  smallSession = typeAndCommit(smallDoc, smallSession, 'foo');
  const smallStep = planVimInsertInput(smallDoc.snapshot(), smallSession, { kind: 'key', key: '<C-w>' });
  assert.equal(smallStep.ok, true, `${label}: small-line ctrl-w succeeds`);
  if (!smallStep.ok || smallStep.value.kind !== 'continued') throw new Error('unreachable');
  const smallEdit = smallStep.value.plan.edits[0];
  if (smallEdit === undefined) throw new Error('unreachable');
  assert.equal(smallEdit.text, '', `${label}: small-line ctrl-w also deletes`);
  assert.equal((smallEdit.end as number) - (smallEdit.start as number), 3, `${label}: small-line ctrl-w deletes the same amount`);
}

// --- Ctrl-u (delete to line start / entry point) -----------------------------
function checkCtrlU(position: number, label: string): void {
  const run = () => {
    const doc = document(GIANT_LINE);
    let session = enter(doc, position);
    session = typeAndCommit(doc, session, 'foo bar');
    const step = planVimInsertInput(doc.snapshot(), session, { kind: 'key', key: '<C-u>' });
    assert.equal(step.ok, true, `${label}: ctrl-u succeeds`);
    if (!step.ok || step.value.kind !== 'continued') throw new Error('unreachable');
    assert.equal(step.value.plan.edits.length, 1, `${label}: ctrl-u produces one edit`);
    const edit = step.value.plan.edits[0];
    if (edit === undefined) throw new Error('unreachable');
    assert.equal(edit.text, '', `${label}: ctrl-u deletes`);
    assert.equal((edit.end as number) - (edit.start as number), 7, `${label}: ctrl-u deletes everything typed since entry`);
    assert.equal(edit.start, position, `${label}: ctrl-u stops exactly at the entry point`);
  };
  const warmup = () => {
    const doc = document(GIANT_LINE);
    let session = enter(doc, position);
    session = typeAndCommit(doc, session, 'foo bar');
    void planVimInsertInput(doc.snapshot(), session, { kind: 'key', key: '<C-u>' });
  };
  measureCtrlLike(`Ctrl-u (${label})`, position, warmup, run);

  const smallDoc = document('bbbbb');
  let smallSession = enter(smallDoc, 5);
  smallSession = typeAndCommit(smallDoc, smallSession, 'foo bar');
  const smallStep = planVimInsertInput(smallDoc.snapshot(), smallSession, { kind: 'key', key: '<C-u>' });
  assert.equal(smallStep.ok, true, `${label}: small-line ctrl-u succeeds`);
  if (!smallStep.ok || smallStep.value.kind !== 'continued') throw new Error('unreachable');
  const smallEdit = smallStep.value.plan.edits[0];
  if (smallEdit === undefined) throw new Error('unreachable');
  assert.equal(smallEdit.text, '', `${label}: small-line ctrl-u also deletes`);
  assert.equal((smallEdit.end as number) - (smallEdit.start as number), 7, `${label}: small-line ctrl-u deletes the same amount`);
}

/** Ctrl-w/Ctrl-u need setup (enter + type + commit) that must not count against the
 * per-key budget; each measured iteration re-creates the giant document/session,
 * types the fixture text (untimed), then times only the final key. */
function measureCtrlLike(label: string, position: number, warmup: () => void, buildAndRun: () => void): void {
  for (let i = 0; i < WARMUP_ITERATIONS; i += 1) warmup();
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const doc = document(GIANT_LINE);
    let session = enter(doc, position);
    session = typeAndCommit(doc, session, label.startsWith('Ctrl-u') ? 'foo bar' : 'foo');
    const start = performance.now();
    const step = planVimInsertInput(doc.snapshot(), session, { kind: 'key', key: label.startsWith('Ctrl-u') ? '<C-u>' : '<C-w>' });
    samples.push(performance.now() - start);
    assert.equal(step.ok, true, `${label}: key succeeds`);
  }
  const p95 = percentileMs(samples, 0.95);
  assert.ok(p95 < BUDGET_MS, `${label} p95 (${p95.toFixed(3)}ms) is within budget (${BUDGET_MS}ms)`);
  console.log(`  ${label}: p95=${p95.toFixed(3)}ms over ${ITERATIONS} iterations`);
  buildAndRun();
}

// --- Esc ----------------------------------------------------------------------
function checkEsc(position: number, label: string): void {
  const doc = document(GIANT_LINE);
  const snapshot = doc.snapshot();
  const setup = () => ({ session: enter(doc, position) });
  const timed = ({ session }: { session: VimInsertSession }) => {
    const step = planVimInsertInput(snapshot, session, { kind: 'key', key: '<Esc>' });
    assert.equal(step.ok, true, `${label}: esc succeeds`);
    if (!step.ok || step.value.kind !== 'exited') throw new Error('unreachable');
    assert.equal(step.value.plan.edits.length, 0, `${label}: esc with nothing typed makes no edit`);
    assert.equal(step.value.plan.cursorOffset, position - 1, `${label}: esc moves the cursor back one grapheme`);
  };
  measure(`Esc (${label})`, setup, timed);

  const smallDoc = document('aaaaa');
  const smallSession = enter(smallDoc, 5);
  const smallStep = planVimInsertInput(smallDoc.snapshot(), smallSession, { kind: 'key', key: '<Esc>' });
  assert.equal(smallStep.ok, true, `${label}: small-line esc succeeds`);
  if (!smallStep.ok || smallStep.value.kind !== 'exited') throw new Error('unreachable');
  assert.equal(smallStep.value.plan.cursorOffset, 4, `${label}: small-line esc also moves back one grapheme`);
}

console.log('Backspace/Enter/Tab/Ctrl-w/Ctrl-u/Esc on a 1 MiB single line:');
checkBackspace(GIANT_END, 'end');
checkBackspace(GIANT_MIDDLE, 'middle');
checkEnter(GIANT_END, 'end');
checkEnter(GIANT_MIDDLE, 'middle');
checkTab(GIANT_END, 'end');
checkTab(GIANT_MIDDLE, 'middle');
checkCtrlW(GIANT_END, 'end');
checkCtrlW(GIANT_MIDDLE, 'middle');
checkCtrlU(GIANT_END, 'end');
checkCtrlU(GIANT_MIDDLE, 'middle');
checkEsc(GIANT_END, 'end');
checkEsc(GIANT_MIDDLE, 'middle');

console.log('T-INSERT-PERF-GIANT-LINE passed: Backspace/Enter/Tab/Ctrl-w/Ctrl-u/Esc stay bounded on a 1 MiB line with unchanged semantics');
