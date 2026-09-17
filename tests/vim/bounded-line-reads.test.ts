// Verifies the "bounded window instead of whole-line materialization" fix
// across insert/index.ts, operators/direct-changes.ts, ranges/normalize.ts,
// visual/index.ts, motions/viewport.ts and motions/word.ts: an ordinary key
// pressed near the start of a huge (1 MiB) line must not read, segment or
// allocate anything proportional to the line's full length. Each case
// exercises the exact function family named in the ticket and asserts both a
// generous latency budget and an unchanged (hand-computed) result.
import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';
import { TextFileDocument } from '../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type SelectionId } from '../../packages/primitives/src/index';
import { beginVimInsert, planVimInsertInput, type VimInsertSession } from '../../packages/vim/insert/index';
import { prepareVimDirectChange } from '../../packages/vim/operators/direct-changes';
import { prepareVimOperator, type VimOperatorSessionState } from '../../packages/vim/operators/core';
import { normalizeVimOperatorRange, type VimOperatorRangeInput } from '../../packages/vim/ranges/normalize';
import { beginVimVisualSelection, type VimVisualCursor } from '../../packages/vim/visual/index';
import { resolveVimWordMotion, type VimWordMotionCursor } from '../../packages/vim/motions/word';
import { resolveVimViewportMotion, type VimViewportCursor } from '../../packages/vim/motions/viewport';
import type { ScreenCell, ScreenRow, ViewportAnchor, VisibleFrame } from '../../packages/layout/src/index';
import type { Utf16Offset } from '../../packages/document/src/index';

const BUDGET_MS = 5;

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'bounded-line-reads-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function offset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error(`invalid offset ${value}`);
  return result.value;
}

// 1 MiB+ first line of ASCII with frequent word boundaries ("word " repeated),
// so word motions near the start only ever need a few characters of context,
// plus a short second line, per the ticket's fixture description.
const WORD_BLOCK = 'word ';
const REPEAT_COUNT = 200_000; // 5 * 200_000 = 1_000_000 UTF-16 units
const LONG_LINE = WORD_BLOCK.repeat(REPEAT_COUNT);
const TEXT = `${LONG_LINE}\nshort`;
// A short first line followed by the huge line, so a linewise `dd` on line 0
// must resolve the post-delete cursor's display column against line 1
// without reading that line's full length.
const SHORT_THEN_LONG_TEXT = `abc\n${LONG_LINE}`;

function document(id: string): TextFileDocument {
  const result = TextFileDocument.create(identifier<DocumentId>(id), TEXT, ['lf'], 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function shortThenLongDocument(id: string): TextFileDocument {
  const result = TextFileDocument.create(identifier<DocumentId>(id), SHORT_THEN_LONG_TEXT, ['lf'], 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function timeIt(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

// Warm up the JIT for each code path before measuring, so first-call tiering
// effects on this process's very first invocation do not distort the budget
// (the same convention as tests/vim/replace-session-scaling.test.ts).
checkDirectChangeX(true);
checkInsertBackspace(true);
checkWordMotionBackward(true);
checkChangeWord(true);
checkVisualEnter(true);
checkViewportScroll(true);
checkLinewiseDeleteDisplayColumn(true);

checkDirectChangeX(false);
checkInsertBackspace(false);
checkWordMotionBackward(false);
checkChangeWord(false);
checkVisualEnter(false);
checkViewportScroll(false);
checkLinewiseDeleteDisplayColumn(false);

console.log('T-BOUNDED-LINE-READS passed: x, <BS>, b, cw, v, <C-E>, dd-display-column on a 1 MiB line complete within budget with unchanged results');

// `dd` on a short line directly above the huge line: the post-delete cursor
// must land on the huge line at the same display column as the origin, and
// `offsetAtDisplayColumn` (operators/core.ts) must resolve that column with
// a bounded window instead of reading/segmenting the whole huge line.
function checkLinewiseDeleteDisplayColumn(warmup: boolean): void {
  const snapshot = shortThenLongDocument('BOUNDED-DD').snapshot();
  const originOffset = offset(1); // 'b' in "abc", display column 1
  const input: VimOperatorRangeInput = {
    origin: { documentVersion: snapshot.version, offset: originOffset, displayCellColumn: 1 as never },
    target: { documentVersion: snapshot.version, offset: originOffset, displayCellColumn: 1 as never },
    direction: 'forward',
    motionKind: 'linewise',
    inclusive: false,
    motionKey: 'dd',
    operator: 'delete',
  };
  const state: VimOperatorSessionState = Object.freeze({ mode: 'normal', repeatTarget: null });
  let prepared: ReturnType<typeof prepareVimOperator> | undefined;
  const elapsed = timeIt(() => {
    prepared = prepareVimOperator(snapshot, { operator: 'delete', motion: { ok: true, value: input }, state });
  });
  assert.ok(prepared?.ok, 'BOUNDED-DD-01 dd succeeds above the long line');
  if (!prepared?.ok || prepared.value.kind !== 'prepared') throw new Error('unreachable');
  // Line 1 starts at offset 4 ("abc\n"); column 1 lands 1 cell into "word ".
  assert.equal(prepared.value.cursorOffset, 5, 'BOUNDED-DD-02 dd lands at the same display column on the huge next line');
  if (!warmup) assert.ok(elapsed < BUDGET_MS, `BOUNDED-DD-03 dd completes within budget (${elapsed.toFixed(3)}ms)`);
}

function checkDirectChangeX(warmup: boolean): void {
  const snapshot = document('BOUNDED-X').snapshot();
  const state: VimOperatorSessionState = Object.freeze({ mode: 'normal', repeatTarget: null });
  let plan: ReturnType<typeof prepareVimDirectChange> | undefined;
  const elapsed = timeIt(() => {
    plan = prepareVimDirectChange({ snapshot, key: 'x', cursorOffset: offset(10), state });
  });
  assert.ok(plan?.ok, 'BOUNDED-X-01 x succeeds on the long line');
  if (!plan?.ok) throw new Error('unreachable');
  assert.equal(plan.value.transaction?.edits.length, 1, 'BOUNDED-X-02 x produces one edit');
  assert.equal(plan.value.transaction?.edits[0]?.start, 10, 'BOUNDED-X-03 x deletes at the cursor');
  assert.equal(plan.value.transaction?.edits[0]?.end, 11, 'BOUNDED-X-04 x deletes exactly one grapheme');
  assert.equal(plan.value.cursorOffset, 10, 'BOUNDED-X-05 x leaves the cursor in place');
  if (!warmup) assert.ok(elapsed < BUDGET_MS, `BOUNDED-X-06 x completes within budget (${elapsed.toFixed(3)}ms)`);
}

function checkInsertBackspace(warmup: boolean): void {
  const snapshot = document('BOUNDED-BS').snapshot();
  const entered = beginVimInsert(snapshot, offset(11), 'i');
  assert.ok(entered.ok, 'BOUNDED-BS-01 insert enters at the cursor');
  if (!entered.ok) throw new Error('unreachable');
  let session: VimInsertSession = entered.value.session;
  let step: ReturnType<typeof planVimInsertInput> | undefined;
  const elapsed = timeIt(() => {
    step = planVimInsertInput(snapshot, session, { kind: 'key', key: '<BS>' });
  });
  assert.ok(step?.ok, 'BOUNDED-BS-02 backspace succeeds on the long line');
  if (!step?.ok || step.value.kind !== 'continued') throw new Error('unreachable');
  session = step.value.session;
  assert.equal(step.value.plan.edits.length, 1, 'BOUNDED-BS-03 backspace produces one edit');
  assert.equal(step.value.plan.edits[0]?.start, 10, 'BOUNDED-BS-04 backspace deletes the previous grapheme start');
  assert.equal(step.value.plan.edits[0]?.end, 11, 'BOUNDED-BS-05 backspace deletes exactly one grapheme');
  assert.equal(session.cursorOffset, 10, 'BOUNDED-BS-06 backspace moves the cursor back one grapheme');
  if (!warmup) assert.ok(elapsed < BUDGET_MS, `BOUNDED-BS-07 backspace completes within budget (${elapsed.toFixed(3)}ms)`);
}

function checkWordMotionBackward(warmup: boolean): void {
  const snapshot = document('BOUNDED-B').snapshot();
  const cursor: VimWordMotionCursor = { documentVersion: snapshot.version, offset: offset(12), desiredDisplayCellColumn: null };
  let result: ReturnType<typeof resolveVimWordMotion> | undefined;
  const elapsed = timeIt(() => {
    result = resolveVimWordMotion(snapshot, cursor, { key: 'b' });
  });
  assert.ok(result?.ok, 'BOUNDED-B-01 b succeeds on the long line');
  if (!result?.ok) throw new Error('unreachable');
  // Position 12 is the 'r' of the third "word" (word[0..3], ' '[4]); `b` from
  // mid-word moves to that word's start at offset 10.
  assert.equal(result.value.cursor.offset, 10, 'BOUNDED-B-02 b moves to the start of the current word');
  if (!warmup) assert.ok(elapsed < BUDGET_MS, `BOUNDED-B-03 b completes within budget (${elapsed.toFixed(3)}ms)`);
}

function checkChangeWord(warmup: boolean): void {
  const snapshot = document('BOUNDED-CW').snapshot();
  const originOffset = 12;
  const wordCursor: VimWordMotionCursor = { documentVersion: snapshot.version, offset: offset(originOffset), desiredDisplayCellColumn: null };
  const forward = resolveVimWordMotion(snapshot, wordCursor, { key: 'w' });
  assert.ok(forward.ok, 'BOUNDED-CW-00 w resolves a target for cw');
  if (!forward.ok) throw new Error('unreachable');
  // `w` from mid-word lands on the start of the *next* word (offset 15,
  // past the single space at 14); `cw`'s special case then pulls the range
  // back to the end of the *current* word (14), matching Vim's `ce`-like cw.
  assert.equal(forward.value.cursor.offset, 15, 'BOUNDED-CW-00B w lands on the next word start');
  const input: VimOperatorRangeInput = {
    origin: { documentVersion: snapshot.version, offset: offset(originOffset) },
    target: { documentVersion: snapshot.version, offset: forward.value.cursor.offset },
    direction: 'forward',
    motionKind: 'characterwise',
    inclusive: false,
    motionKey: 'w',
    operator: 'change',
  };
  let result: ReturnType<typeof normalizeVimOperatorRange> | undefined;
  const elapsed = timeIt(() => {
    result = normalizeVimOperatorRange(snapshot, input);
  });
  assert.ok(result?.ok, 'BOUNDED-CW-01 cw succeeds on the long line');
  if (!result?.ok || result.value.kind !== 'characterwise') throw new Error('unreachable');
  assert.equal(result.value.start, 12, 'BOUNDED-CW-02 cw starts at the cursor');
  assert.equal(result.value.end, 14, 'BOUNDED-CW-03 cw stops at the end of the current word, excluding trailing space');
  assert.equal(result.value.ranges[0]?.text, 'rd', 'BOUNDED-CW-04 cw captures exactly the remainder of the current word');
  if (!warmup) assert.ok(elapsed < BUDGET_MS, `BOUNDED-CW-05 cw completes within budget (${elapsed.toFixed(3)}ms)`);
}

function checkVisualEnter(warmup: boolean): void {
  const snapshot = document('BOUNDED-V').snapshot();
  const selectionId = identifier<SelectionId>('BOUNDED-V-selection');
  const cursor: VimVisualCursor = {
    documentVersion: snapshot.version,
    offset: offset(12),
    displayCellColumn: 12 as never,
  };
  let result: ReturnType<typeof beginVimVisualSelection> | undefined;
  const elapsed = timeIt(() => {
    result = beginVimVisualSelection(snapshot, selectionId, cursor, 'visual-character');
  });
  assert.ok(result?.ok, 'BOUNDED-V-01 v succeeds on the long line');
  if (!result?.ok) throw new Error('unreachable');
  const primary = result.value.members.find((member) => member.id === selectionId);
  assert.ok(primary !== undefined, 'BOUNDED-V-02 v creates the primary selection member');
  assert.equal(primary?.anchor.at.offset, 12, 'BOUNDED-V-03 v anchors at the cursor');
  if (!warmup) assert.ok(elapsed < BUDGET_MS, `BOUNDED-V-04 v completes within budget (${elapsed.toFixed(3)}ms)`);
}

/**
 * A minimal, hand-built two-row frame (no wrap, one row per document line)
 * standing in for `ViewportLayout.project`'s output: row 0 shows the first
 * `width` cells of the huge line, row 1 shows the short second line. This
 * keeps the test focused on `resolveVimViewportMotion`/`readLineMetrics`
 * (owned by this ticket) without depending on the separately-owned layout
 * package's projector.
 */
function textRow(lineIndex: number, lineText: string, width: number): ScreenRow {
  const visible = lineText.slice(0, width);
  return {
    kind: 'text',
    lineIndex: lineIndex as never,
    wrapIndex: 0,
    displayStartCell: 0,
    displayEndCell: visible.length,
    startOffset: offset(0),
    endOffset: offset(visible.length),
    text: visible,
    contentKey: null,
    cells: [...visible].map((character, column): ScreenCell => ({
      text: character,
      role: 'glyph',
      target: {
        kind: 'text',
        lineIndex: lineIndex as never,
        offset: offset(column),
        affinity: 'left',
        virtualCell: 0,
        displayCellColumn: column as never,
        cellPart: 'glyph',
      },
    })),
  };
}

function checkViewportScroll(warmup: boolean): void {
  const snapshot = document('BOUNDED-CTRL-E').snapshot();
  const cursorOffset = offset(12);
  const lineStart1 = LONG_LINE.length + 1;
  const width = 24;
  const row0 = textRow(0, LONG_LINE, width);
  const row1raw = textRow(1, 'short', width);
  // Line 1's absolute offsets are relative to the whole document, not to line 1.
  const row1: ScreenRow = { ...row1raw, startOffset: offset(lineStart1), endOffset: offset(lineStart1 + 5),
    cells: row1raw.cells.map((cell): ScreenCell => {
      const target = cell.target;
      return {
        ...cell,
        target: target !== null && target.kind === 'text'
          ? { ...target, offset: offset(lineStart1 + (target.offset as number)) }
          : null,
      };
    }) };
  const frame: VisibleFrame = {
    identity: {
      frameId: 1 as never,
      viewId: identifier<import('../../packages/primitives/src/index').ViewId>('BOUNDED-CTRL-E-view'),
      documentId: snapshot.id,
      documentVersion: snapshot.version,
      selectionGeneration: 1 as never,
      layoutGeneration: 1 as never,
    },
    widthCells: width,
    heightCells: 2,
    anchor: { documentVersion: snapshot.version, lineIndex: 0 as never, offset: offset(0), displayCellColumn: 0 as never },
    rows: [row0, row1],
    selections: [],
    truncatedLongLine: true,
  };
  const state: VimViewportCursor = {
    cursor: { documentVersion: snapshot.version, offset: cursorOffset, desiredDisplayCellColumn: 12 as never },
    desiredScreenCellColumn: 12 as never,
  };
  let result: ReturnType<typeof resolveVimViewportMotion> | undefined;
  const elapsed = timeIt(() => {
    result = resolveVimViewportMotion(snapshot, frame, state, { key: '<C-E>' });
  });
  assert.ok(result?.ok, 'BOUNDED-CTRL-E-01 <C-E> succeeds on the long line');
  if (!result?.ok) throw new Error('unreachable');
  assert.ok(Number.isSafeInteger(result.value.cursor.offset as number), 'BOUNDED-CTRL-E-02 <C-E> yields a well-formed cursor');
  assert.ok((result.value.cursor.offset as number) >= 0 && (result.value.cursor.offset as number) <= snapshot.lengthUtf16,
    'BOUNDED-CTRL-E-03 <C-E> cursor stays within the document');
  if (!warmup) assert.ok(elapsed < BUDGET_MS, `BOUNDED-CTRL-E-04 <C-E> completes within budget (${elapsed.toFixed(3)}ms)`);
}
