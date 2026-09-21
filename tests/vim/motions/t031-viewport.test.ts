import { strict as assert } from 'node:assert';
import { asIdentifier, asUtf16Offset, type DocumentId, type SelectionId, type Utf16Offset, type ViewId } from '../../../packages/primitives/src/index';
import { openTextDocument, type DocumentSnapshot } from '../../../packages/document/src/index';
import { createSelectionSet } from '../../../packages/selections/src/index';
import { ViewportLayout, type FoldRegion, type ViewportAnchor, type ViewportProjectionInput } from '../../../packages/layout/src/index';
import {
  createVimMotionCursor,
  ensureVimCursorVisible,
  resolveVimMotion,
  resolveVimViewportMotion,
  type VimViewportInvocation,
  type VimViewportMotionKey,
  type VimViewportScrollKey,
} from '../../../packages/vim/motions/index';
import { runUiOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture, OracleSnapshot } from '../../oracle/types';

type CasePlan =
  | { readonly kind: 'screen'; readonly key: VimViewportMotionKey; readonly count?: number }
  | { readonly kind: 'scroll'; readonly key: VimViewportScrollKey; readonly count?: number }
  | { readonly kind: 'vertical'; readonly key: 'j' | 'k'; readonly count: number; readonly folds?: readonly FoldRegion[] }
  | { readonly kind: 'visible'; readonly key: 'l' | 'j'; readonly count: number; readonly sidescrolloff?: number; readonly scrolloff?: number };

interface ViewportCase {
  readonly id: string;
  readonly title: string;
  readonly lines: readonly string[];
  readonly options: Readonly<Record<string, string | number | boolean>>;
  readonly cursor: { readonly line: number; readonly byteColumn0: number };
  readonly keys: string;
  readonly plan: CasePlan;
  readonly setup?: string;
  readonly folds?: readonly FoldRegion[];
}

const cases: readonly ViewportCase[] = [
  screen('T031-ORACLE-GJ-WRAP-01', ['    abcdefghijklmnop', 'short'], { columns: 12, lines: 8 }, { line: 1, byteColumn0: 10 }, 'gj'),
  screen('T031-ORACLE-GK-WRAP-01', ['    abcdefghijklmnop', 'short'], { columns: 12, lines: 8 }, { line: 1, byteColumn0: 12 }, 'gk'),
  screen('T031-ORACLE-G0-01', ['    abcdefghijklmnop'], { columns: 12, lines: 8 }, { line: 1, byteColumn0: 10 }, 'g0'),
  screen('T031-ORACLE-GCARET-01', ['    abcdefghijklmnop'], { columns: 12, lines: 8 }, { line: 1, byteColumn0: 10 }, 'g^'),
  screen('T031-ORACLE-GDOLLAR-01', ['    abcdefghijklmnop'], { columns: 12, lines: 8 }, { line: 1, byteColumn0: 10 }, 'g$'),
  screen('T031-ORACLE-GM-01', ['    abcdefghijklmnop'], { columns: 12, lines: 8 }, { line: 1, byteColumn0: 10 }, 'gm'),
  screen('T031-ORACLE-GCAPM-01', ['    abcdefghijklmnop'], { columns: 12, lines: 8 }, { line: 1, byteColumn0: 10 }, 'gM'),
  screen('T031-ORACLE-H-01', numbered(30), { columns: 24, lines: 8 }, { line: 15, byteColumn0: 2 }, 'H'),
  screen('T031-ORACLE-M-01', numbered(30), { columns: 24, lines: 8 }, { line: 15, byteColumn0: 2 }, 'M'),
  screen('T031-ORACLE-L-01', numbered(30), { columns: 24, lines: 8 }, { line: 15, byteColumn0: 2 }, 'L'),
  scroll('T031-ORACLE-ZT-01', numbered(30), { columns: 24, lines: 8 }, { line: 15, byteColumn0: 2 }, 'zt'),
  scroll('T031-ORACLE-ZZ-01', numbered(30), { columns: 24, lines: 8 }, { line: 15, byteColumn0: 2 }, 'zz'),
  scroll('T031-ORACLE-ZB-01', numbered(30), { columns: 24, lines: 8 }, { line: 15, byteColumn0: 2 }, 'zb'),
  scroll('T031-ORACLE-CTRL-E-01', numbered(30), { columns: 24, lines: 8 }, { line: 5, byteColumn0: 2 }, '\u0005'),
  scroll('T031-ORACLE-CTRL-Y-01', numbered(30), { columns: 24, lines: 8 }, { line: 12, byteColumn0: 2 }, '\u0019'),
  scroll('T031-ORACLE-CTRL-D-01', numbered(30), { columns: 24, lines: 8 }, { line: 8, byteColumn0: 2 }, '\u0004'),
  scroll('T031-ORACLE-CTRL-U-01', numbered(30), { columns: 24, lines: 8 }, { line: 16, byteColumn0: 2 }, '\u0015'),
  scroll('T031-ORACLE-CTRL-F-01', numbered(30), { columns: 24, lines: 8 }, { line: 8, byteColumn0: 2 }, '\u0006'),
  scroll('T031-ORACLE-CTRL-B-01', numbered(30), { columns: 24, lines: 8 }, { line: 16, byteColumn0: 2 }, '\u0002'),
  visible('T031-ORACLE-HORIZONTAL-SCROLL-01', ['012345678901234567890123456789'], { columns: 12, lines: 8, wrap: false, sidescrolloff: 2 }, { line: 1, byteColumn0: 0 }, 'l', 17, 2),
  visible('T031-ORACLE-SCROLLOFF-01', numbered(30), { columns: 24, lines: 8, scrolloff: 2 }, { line: 4, byteColumn0: 2 }, 'j', 8, undefined, 2),
  screen('T031-ORACLE-WIDE-WRAP-01', ['ab界cdefghijklmnop'], { columns: 12, lines: 7 }, { line: 1, byteColumn0: 8 }, 'gj'),
  screen('T031-ORACLE-TINY-VIEWPORT-01', ['abcdefghijklmno', 'second', 'third', 'fourth'], { columns: 12, lines: 4 }, { line: 1, byteColumn0: 0 }, 'gj'),
  {
    ...vertical('T031-ORACLE-FOLD-DESTINATION-01', numbered(12), { columns: 20, lines: 8 }, { line: 1, byteColumn0: 0 }, 'j', 3),
    setup: ':set foldmethod=manual foldenable foldlevel=0<CR>:3,6fold<CR>',
    folds: [{ id: 't031-fold', documentVersion: 1 as never, startLine: 2 as never, endLineExclusive: 6 as never }],
  },
];

const oracle = await verifyOracleBundle();
const layoutViewId = identifier<ViewId>('T031-layout-view');
const selectionId = identifier<SelectionId>('T031-primary');
const passed: string[] = [];

for (const testCase of cases) {
  console.log(`T031-ORACLE-RUN-01 ${testCase.id}`);
  const fixture = oracleFixture({ ...testCase, keys: `${testCase.setup ?? ''}${testCase.keys}` }, testCase.id);
  const baselineFixture = oracleFixture({ ...testCase, keys: `${testCase.setup ?? ''}<Esc>` }, `${testCase.id}-BASE`);
  const baselineResult = await runUiOracleFixture(baselineFixture, oracle.binaryPath,
    { processTimeoutMs: 15_000, readinessTimeoutMs: 8_000, readinessMarker: readinessMarker(testCase) });
  const actionResult = await runUiOracleFixture(fixture, oracle.binaryPath,
    { processTimeoutMs: 15_000, readinessTimeoutMs: 8_000, readinessMarker: readinessMarker(testCase) });
  assert.equal(baselineResult.terminalRestored, true, `T031-ORACLE-RESTORE-01 ${testCase.id}/base`);
  assert.equal(actionResult.terminalRestored, true, `T031-ORACLE-RESTORE-01 ${testCase.id}`);
  const expectedColumns = Number(testCase.options.columns);
  const expectedRows = Number(testCase.options.lines);
  for (const result of [baselineResult, actionResult]) {
    assert.equal(result.pty.columns, expectedColumns, `T031-ORACLE-GEOMETRY-01 ${testCase.id} PTY width`);
    assert.equal(result.snapshot.geometry.columns, expectedColumns, `T031-ORACLE-GEOMETRY-01 ${testCase.id} Neovim width`);
    assert.equal(result.pty.rows, expectedRows, `T031-ORACLE-GEOMETRY-01 ${testCase.id} PTY height`);
    assert.equal(result.snapshot.geometry.lines, expectedRows, `T031-ORACLE-GEOMETRY-01 ${testCase.id} Neovim height`);
  }
  const documentText = testCase.lines.join('\n');
  const opened = openTextDocument(identifier<DocumentId>(testCase.id), new TextEncoder().encode(documentText));
  assert.equal(opened.kind, 'editable', `T031-DOCUMENT-OWNER-01 ${testCase.id}`);
  if (opened.kind !== 'editable') throw new Error(`T031-DOCUMENT-OWNER-01 ${testCase.id} is not editable`);
  const document = opened.document;
  const snapshot = document.snapshot();
  const inputOffset = offsetFromOracle(snapshot, baselineResult.snapshot);
  const initialCursor = createVimMotionCursor(snapshot, inputOffset, {
    ...(typeof testCase.options.tabstop === 'number' ? { tabSize: testCase.options.tabstop } : {}),
  });
  if (!initialCursor.ok) throw new Error(`T031-CURSOR-INIT-01 ${testCase.id}: ${initialCursor.error.kind}`);
  assert.equal(initialCursor.ok, true, `T031-CURSOR-INIT-01 ${testCase.id}`);

  const topLine = numeric(baselineResult.snapshot.view, 'topline');
  const leftColumn = numeric(baselineResult.snapshot.view, 'leftcol');
  const topOffset = snapshot.lineStartOffset((topLine - 1) as never);
  assert.equal(topOffset.ok, true, `T031-LAYOUT-ANCHOR-01 ${testCase.id}`);
  if (!topOffset.ok) throw new Error(`T031-LAYOUT-ANCHOR-01 ${testCase.id}`);
  const anchor: ViewportAnchor = {
    documentVersion: snapshot.version,
    lineIndex: (topLine - 1) as never,
    offset: topOffset.value,
    displayCellColumn: 0 as never,
  };
  const folds = (testCase.folds ?? []).map((fold) => ({ ...fold, documentVersion: snapshot.version }));
  const layout = new ViewportLayout();
  const width = baselineResult.snapshot.geometry.windowWidth;
  const height = baselineResult.snapshot.geometry.windowHeight;
  const options = {
    wrap: testCase.options.wrap !== false,
    // The Neovim oracle wraps at cell boundaries; Helix's word/indent carry
    // belongs to configured rendering, not this Vim geometry differential.
    maxWrap: 0,
    maxIndentRetain: 0,
    horizontalScrollCells: leftColumn,
    ...(folds.length === 0 ? {} : { folds, foldGeneration: 1 }),
  };
  let frame = project(layout, document, layoutViewId, width, height, initialCursor.value.offset, anchor, options);
  let state = {
    cursor: initialCursor.value,
    desiredScreenCellColumn: Math.max(0, baselineResult.snapshot.cursor.screenColumn - 1) as never,
  };

  let actualOffset: Utf16Offset;
  let resultingFrame = frame;
  if (testCase.plan.kind === 'screen' || testCase.plan.kind === 'scroll') {
    const invocation: VimViewportInvocation = {
      key: testCase.plan.key,
      ...(testCase.plan.count === undefined ? {} : { count: testCase.plan.count }),
    };
    const resolved = resolveVimViewportMotion(snapshot, frame, state, invocation, {
      ...(folds.length === 0 ? {} : { folds }),
    });
    if (!resolved.ok) throw new Error(`T031-VIEWPORT-RESOLVE-01 ${testCase.id}: ${resolved.error.kind}`);
    assert.equal(resolved.ok, true, `T031-VIEWPORT-RESOLVE-01 ${testCase.id}`);
    actualOffset = resolved.value.cursor.offset;
    if (testCase.plan.kind === 'scroll') {
      assert.equal((resolved.value.viewportAnchor.lineIndex as number) + 1, numeric(actionResult.snapshot.view, 'topline'),
        `T031-SCROLL-VIEW-ORACLE-01 ${testCase.id} top line`);
    }
    resultingFrame = project(layout, document, layoutViewId, width, height, actualOffset, resolved.value.viewportAnchor, options);
  } else if (testCase.plan.kind === 'vertical') {
    const resolved = resolveVimMotion(snapshot, state.cursor, { key: testCase.plan.key, count: testCase.plan.count }, {
      folds,
    });
    if (!resolved.ok) throw new Error(`T031-FOLD-VERTICAL-01 ${testCase.id}: ${resolved.error.kind}`);
    assert.equal(resolved.ok, true, `T031-FOLD-VERTICAL-01 ${testCase.id}`);
    actualOffset = resolved.value.cursor.offset;
    const corrected = ensureVimCursorVisible(snapshot, frame, resolved.value.cursor, { folds });
    if (!corrected.ok) throw new Error(`T031-FOLD-VISIBLE-01 ${testCase.id}: ${corrected.error.kind}`);
    assert.equal(corrected.ok, true, `T031-FOLD-VISIBLE-01 ${testCase.id}`);
    resultingFrame = project(layout, document, layoutViewId, width, height, actualOffset, corrected.value.viewportAnchor, {
      ...options,
      horizontalScrollCells: corrected.value.horizontalScrollCells,
    });
  } else {
    const moved = resolveVimMotion(snapshot, state.cursor, { key: testCase.plan.key, count: testCase.plan.count });
    if (!moved.ok) throw new Error(`T031-ORDINARY-MOTION-01 ${testCase.id}: ${moved.error.kind}`);
    assert.equal(moved.ok, true, `T031-ORDINARY-MOTION-01 ${testCase.id}`);
    const visible = ensureVimCursorVisible(snapshot, frame, moved.value.cursor, {
      ...(testCase.plan.sidescrolloff === undefined ? {} : { sidescrolloff: testCase.plan.sidescrolloff }),
      ...(testCase.plan.scrolloff === undefined ? {} : { scrolloff: testCase.plan.scrolloff }),
    });
    if (!visible.ok) throw new Error(`T031-CURSOR-VISIBLE-01 ${testCase.id}: ${visible.error.kind}`);
    assert.equal(visible.ok, true, `T031-CURSOR-VISIBLE-01 ${testCase.id}`);
    actualOffset = moved.value.cursor.offset;
    assert.equal(visible.value.viewportAnchor.lineIndex, actionAnchorLine(snapshot, actionResult.snapshot),
      `T031-CURSOR-VISIBLE-01 ${testCase.id} scrolloff viewport line`);
    assert.equal(visible.value.horizontalScrollCells, numeric(actionResult.snapshot.view, 'leftcol'),
      `T031-CURSOR-VISIBLE-01 ${testCase.id} horizontal viewport`);
    resultingFrame = project(layout, document, layoutViewId, width, height, actualOffset, visible.value.viewportAnchor, {
      ...options,
      horizontalScrollCells: visible.value.horizontalScrollCells,
    });
  }

  const expectedOffset = offsetFromOracle(snapshot, actionResult.snapshot);
  assert.equal(actualOffset as number, expectedOffset as number, `T031-CURSOR-ORACLE-01 ${testCase.id} UTF-16 offset`);
  const position = layout.positionForOffset(resultingFrame.identity.frameId, actualOffset);
  assert.equal(position.ok, true, `T031-SCREEN-POSITION-01 ${testCase.id}`);
  if (position.ok) {
    assert.equal(position.value.row + 1, actionResult.snapshot.cursor.screenRow, `T031-SCREEN-POSITION-01 ${testCase.id} row`);
    assert.equal(position.value.column + 1, actionResult.snapshot.cursor.screenColumn, `T031-SCREEN-POSITION-01 ${testCase.id} column`);
  }
  assert.equal(document.snapshot().version, snapshot.version, `T031-PURE-MOTION-01 ${testCase.id}`);
  passed.push(testCase.id);
}

checkResizeRetainsSemanticCursor();
console.log(`T031 viewport differential tests passed: ${passed.length} geometry-matched Neovim fixtures plus resize preservation.`);
console.log(`Fixtures: ${passed.join(', ')}`);

function screen(
  id: string,
  lines: readonly string[],
  options: Readonly<Record<string, string | number | boolean>>,
  cursor: { readonly line: number; readonly byteColumn0: number },
  key: VimViewportMotionKey,
): ViewportCase {
  return { id, title: 'T031 screen motion', lines, options, cursor, keys: key, plan: { kind: 'screen', key } };
}

function scroll(
  id: string,
  lines: readonly string[],
  options: Readonly<Record<string, string | number | boolean>>,
  cursor: { readonly line: number; readonly byteColumn0: number },
  key: string,
): ViewportCase {
  const scrollKey = key === '\u0005' ? '<C-E>' : key === '\u0019' ? '<C-Y>' : key === '\u0004' ? '<C-D>'
    : key === '\u0015' ? '<C-U>' : key === '\u0006' ? '<C-F>' : key === '\u0002' ? '<C-B>' : key as VimViewportScrollKey;
  return { id, title: 'T031 viewport scrolling', lines, options, cursor, keys: key, plan: { kind: 'scroll', key: scrollKey } };
}

function vertical(
  id: string,
  lines: readonly string[],
  options: Readonly<Record<string, string | number | boolean>>,
  cursor: { readonly line: number; readonly byteColumn0: number },
  key: 'j' | 'k',
  count: number,
): ViewportCase {
  return { id, title: 'T031 folded vertical destination', lines, options, cursor, keys: `${count}${key}`, plan: { kind: 'vertical', key, count } };
}

function visible(
  id: string,
  lines: readonly string[],
  options: Readonly<Record<string, string | number | boolean>>,
  cursor: { readonly line: number; readonly byteColumn0: number },
  key: 'l' | 'j',
  count: number,
  sidescrolloff?: number,
  scrolloff?: number,
): ViewportCase {
  return {
    id, title: 'T031 cursor visibility', lines, options, cursor,
    // Feed horizontal steps individually: Vim's counted `l` command applies
    // its own side-scroll chunking, while this fixture isolates the ordinary
    // cursor-visibility contract exercised by repeated key events.
    keys: key === 'l' ? key.repeat(count) : `${count}${key}`,
    plan: { kind: 'visible', key, count, ...(sidescrolloff === undefined ? {} : { sidescrolloff }), ...(scrolloff === undefined ? {} : { scrolloff }) },
  };
}

function oracleFixture(testCase: ViewportCase, id: string): OracleFixture {
  return {
    id,
    title: testCase.title,
    purpose: 'Geometry-matched T031 screen-motion and viewport oracle fixture.',
    modes: ['normal'],
    lines: testCase.lines,
    cursor: testCase.cursor,
    options: testCase.options,
    steps: [{ label: 'viewport-command', keys: testCase.keys }],
  };
}

function readinessMarker(testCase: ViewportCase): string {
  return (testCase.lines[0] ?? '').trimStart().slice(0, 4);
}

function project(
  layout: ViewportLayout,
  document: { snapshot(): DocumentSnapshot },
  viewId: ViewId,
  widthCells: number,
  heightCells: number,
  cursorOffset: Utf16Offset,
  anchor: ViewportAnchor,
  options: ViewportProjectionInput['options'],
) {
  const snapshot = document.snapshot();
  const nextOffset = Math.min(snapshot.lengthUtf16, (cursorOffset as number) + 1);
  const afterResult = asUtf16Offset(nextOffset);
  const after = afterResult.ok ? afterResult.value : cursorOffset;
  const selection = createSelectionSet(snapshot, {
    primaryId: selectionId,
    members: [{
      id: selectionId,
      kind: 'normal-cursor',
      direction: 'forward',
      anchor: { kind: 'character', offset: cursorOffset, after },
      head: { kind: 'character', offset: cursorOffset, after },
    }],
  });
  if (!selection.ok) throw new Error(`T031-LAYOUT-SELECTION-01 ${selection.error.kind}`);
  assert.equal(selection.ok, true, 'T031-LAYOUT-SELECTION-01');
  const result = layout.project({
    viewId,
    snapshot,
    selection: selection.value.selectionSet,
    widthCells,
    heightCells,
    anchor,
    ...(options === undefined ? {} : { options }),
  });
  if (!result.ok) throw new Error(`T031-LAYOUT-FRAME-01 ${result.error.kind}`);
  assert.equal(result.ok, true, 'T031-LAYOUT-FRAME-01');
  return result.value;
}

function offsetFromOracle(snapshot: DocumentSnapshot, oracleSnapshot: OracleSnapshot): Utf16Offset {
  const lineIndex = oracleSnapshot.cursor.line - 1;
  const lineText = oracleSnapshot.lines[lineIndex] ?? '';
  const lineStart = snapshot.lineStartOffset(lineIndex as never);
  assert.equal(lineStart.ok, true, 'T031-ORACLE-COORD-01 line exists');
  if (!lineStart.ok) throw new Error('T031-ORACLE-COORD-01 line start failed');
  const utf16Column = utf8ColumnToUtf16(lineText, oracleSnapshot.cursor.byteColumn - 1);
  return (lineStart.value as number + utf16Column) as Utf16Offset;
}

function actionAnchorLine(snapshot: DocumentSnapshot, oracleSnapshot: OracleSnapshot) {
  const line = numeric(oracleSnapshot.view, 'topline') - 1;
  return line as never;
}

function numeric(value: unknown, key: string): number {
  assert.equal(typeof value, 'object', `T031-ORACLE-VIEW-01 ${key} exists`);
  const candidate = value as Record<string, unknown>;
  assert.equal(typeof candidate[key], 'number', `T031-ORACLE-VIEW-01 ${key} is numeric`);
  return candidate[key] as number;
}

function utf8ColumnToUtf16(line: string, byteColumn0: number): number {
  let bytes = 0;
  let units = 0;
  for (const scalar of line) {
    if (bytes === byteColumn0) return units;
    const scalarBytes = Buffer.byteLength(scalar, 'utf8');
    if (bytes + scalarBytes > byteColumn0) throw new Error('T031-ORACLE-COORD-02 byte column splits a scalar');
    bytes += scalarBytes;
    units += scalar.length;
  }
  if (bytes !== byteColumn0) throw new Error('T031-ORACLE-COORD-02 byte column exceeds line');
  return units;
}

function numbered(count: number): readonly string[] {
  return Array.from({ length: count }, (_value, index) => `line ${String(index + 1).padStart(2, '0')} abcdefghijklmnop`);
}

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'id');
  if (!result.ok) throw new Error('T031-IDENTIFIER-01 invalid identifier');
  return result.value;
}

function checkResizeRetainsSemanticCursor(): void {
  const opened = openTextDocument(identifier<DocumentId>('T031-resize'), new TextEncoder().encode(numbered(30).join('\n')));
  assert.equal(opened.kind, 'editable');
  if (opened.kind !== 'editable') throw new Error('T031-RESIZE-01 document creation failed');
  const document = opened.document;
  const snapshot = document.snapshot();
  const start = snapshot.lineStartOffset(19 as never);
  assert.equal(start.ok, true);
  if (!start.ok) throw new Error('T031-RESIZE-01 cursor line missing');
  const offset = (start.value as number) + 4 as Utf16Offset;
  const cursor = createVimMotionCursor(snapshot, offset);
  assert.equal(cursor.ok, true);
  if (!cursor.ok) throw new Error('T031-RESIZE-01 cursor invalid');
  const layout = new ViewportLayout();
  const anchor: ViewportAnchor = { documentVersion: snapshot.version, lineIndex: 19 as never, offset: start.value, displayCellColumn: 0 as never };
  const small = project(layout, document, layoutViewId, 15, 5, offset, anchor, {});
  const smallPosition = layout.positionForOffset(small.identity.frameId, offset);
  assert.equal(smallPosition.ok, true);
  const large = project(layout, document, layoutViewId, 50, 13, offset, anchor, {});
  assert.deepEqual(large.anchor, small.anchor, 'T031-RESIZE-SEMANTIC-01 resize keeps the immutable semantic viewport anchor');
  const largePosition = layout.positionForOffset(large.identity.frameId, offset);
  assert.equal(largePosition.ok, true);
  assert.equal(document.snapshot().version, snapshot.version, 'T031-RESIZE-SEMANTIC-01 resize does not move the document cursor');
  passed.push('T031-RESIZE-SEMANTIC-01');
}
