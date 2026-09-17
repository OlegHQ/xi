import { strict as assert } from 'node:assert';
import {
  asIdentifier,
  asUndoGroupId,
  type DocumentId,
  type SelectionId,
  type UndoGroupId,
  type Utf16Offset,
  type ViewId,
} from '../../packages/primitives/src/index';
import { TextFileDocument, type EditProposal } from '../../packages/document/src/index';
import { createSelectionSet, type SelectionSetSnapshot } from '../../packages/selections/src/index';
import { defaultCellWidthPolicy, resolveScrollAnchor, ViewportLayout, type CellHitTarget, type ViewportProjectionInput } from '../../packages/layout/src/index';

const documentId = identifier<DocumentId>('T014-layout-fixtures');
const viewId = identifier<ViewId>('T014-main-view');
const primaryId = identifier<SelectionId>('T014-primary');
const secondaryId = identifier<SelectionId>('T014-secondary');
const undoGroup = identifier<UndoGroupId>('T014-layout-edit');

function editable(text: string): TextFileDocument {
  const lineEndings = Array.from({ length: [...text].filter((character) => character === '\n').length }, () => 'lf' as const);
  const created = TextFileDocument.create(documentId, text, lineEndings, 'lf');
  if (!created.ok) throw new Error(`fixture-document:${created.error.kind}`);
  return created.value;
}

function offset(value: number): Utf16Offset { return value as Utf16Offset; }

function selectionAt(document: TextFileDocument, at = 0): SelectionSetSnapshot {
  const snapshot = document.snapshot();
  const end = snapshot.slice(offset(at), offset(at + 1));
  assert.equal(end.ok, true);
  const next = end.ok ? at + Math.max(1, end.value.length) : at + 1;
  const set = createSelectionSet(snapshot, {
    primaryId,
    members: [{
      id: primaryId,
      kind: 'normal-cursor',
      direction: 'forward',
      anchor: { kind: 'character', offset: offset(at), after: offset(next) },
      head: { kind: 'character', offset: offset(at), after: offset(next) },
    }],
  });
  if (!set.ok) throw new Error(`fixture-selection:${set.error.kind}`);
  return set.value.selectionSet;
}

function project(
  layout: ViewportLayout,
  document: TextFileDocument,
  widthCells: number,
  heightCells: number,
  selection = selectionAt(document),
  options: ViewportProjectionInput['options'] = {},
  anchor?: ViewportProjectionInput['anchor'],
) {
  const input: ViewportProjectionInput = {
    viewId,
    snapshot: document.snapshot(),
    selection,
    widthCells,
    heightCells,
    ...(anchor === undefined ? {} : { anchor }),
    ...(options === undefined ? {} : { options }),
  };
  const result = layout.project(input);
  if (!result.ok) throw new Error(`layout:${result.error.kind}`);
  return result.value;
}

function checkUtf16CellRoundTripsAcrossTabsWideGlyphsAndClusters(): void {
  const document = editable('a\t界e\u0301👩‍💻Z\nnext');
  const original = document.snapshot();
  const layout = new ViewportLayout();
  const frame = project(layout, document, 5, 5, selectionAt(document, 0), { tabSize: 4 });

  for (const boundary of [0, 1, 2, 3, 5, 10, 11]) {
    const position = layout.positionForOffset(frame.identity.frameId, offset(boundary));
    assert.equal(position.ok, true, `T014-CELL-ROUNDTRIP-01 position ${boundary}`);
    if (!position.ok) continue;
    const hit = layout.hitTest(frame.identity.frameId, position.value);
    assert.equal(hit.ok, true, `T014-CELL-ROUNDTRIP-01 hit ${boundary}`);
    if (hit.ok) assert.equal(hit.value.target.offset, boundary, `T014-CELL-ROUNDTRIP-01 boundary ${boundary}`);
  }
  const combiningInterior = layout.positionForOffset(frame.identity.frameId, offset(4));
  const combiningStart = layout.positionForOffset(frame.identity.frameId, offset(3));
  assert.deepEqual(combiningInterior, combiningStart, 'T014-CELL-ROUNDTRIP-01 an interior combining boundary projects to the full cluster leading cell');

  assert.equal(frame.rows[0]?.text.startsWith('a   '), true, 'T014-CELL-ROUNDTRIP-01 tab expansion uses logical display cells');
  assert.equal(frame.rows[1]?.cells[0]?.text, '界', 'T014-CELL-ROUNDTRIP-01 wide glyph moves intact to next wrapped row');
  assert.equal(frame.rows[1]?.cells[1]?.role, 'wide-continuation', 'T014-CELL-ROUNDTRIP-01 wide glyph owns two cells');
  const trailing = layout.hitTest(frame.identity.frameId, { row: 1, column: 1 });
  assert.equal(trailing.ok, true);
  if (trailing.ok) assert.equal(trailing.value.target.offset, 2, 'T014-WIDE-TRAILING-SNAPS-LEADING-01');
  assert.equal(document.snapshot().version, original.version, 'layout never changes document version');
  assert.equal(document.snapshot().revisionId, original.revisionId, 'layout never changes document revision');
  console.log('T014-CELL-ROUNDTRIP-01 passed: UTF-16 boundaries map through tab, CJK, combining and ZWJ cells; wide trailing cells snap to the leading boundary.');
}

function checkTabExpansionCanCrossWrap(): void {
  const document = editable('a\tz');
  const layout = new ViewportLayout();
  const frame = project(layout, document, 3, 3, selectionAt(document), { tabSize: 4 });
  assert.equal(frame.rows[0]?.text, 'a  ', 'T014-TAB-WRAP-01 first tab segment fills the row');
  assert.equal(frame.rows[1]?.text.startsWith(' z'), true, 'T014-TAB-WRAP-01 remaining tab cell continues on next row');
  const beforeWrap = layout.hitTest(frame.identity.frameId, { row: 0, column: 2 });
  const afterWrap = layout.hitTest(frame.identity.frameId, { row: 1, column: 0 });
  assert.equal(beforeWrap.ok, true);
  assert.equal(afterWrap.ok, true);
  if (beforeWrap.ok && afterWrap.ok) {
    assert.equal(beforeWrap.value.target.offset, 1);
    if (beforeWrap.value.target.kind === 'text') assert.equal(beforeWrap.value.target.virtualCell, 1);
    else assert.fail('expected text hit for tab fill');
    assert.equal(afterWrap.value.target.offset, 1);
    if (afterWrap.value.target.kind === 'text') assert.equal(afterWrap.value.target.virtualCell, 2);
    else assert.fail('expected text hit for tab fill');
  }
  console.log('T014-TAB-WRAP-01 passed: one tab keeps its logical stop and exposes distinct virtual-cell hit targets across a wrap.');
}

function checkFoldRelocationAndFrameStaleness(): void {
  const document = editable('one\ntwo\nthree\nfour');
  const selection = selectionAt(document, 8);
  const layout = new ViewportLayout();
  const frame = project(layout, document, 12, 4, selection, {
    folds: [{ id: 'fold-middle', documentVersion: document.snapshot().version, startLine: 1 as never, endLineExclusive: 3 as never }],
    foldGeneration: 7,
  });
  const cursor = frame.selections[0]?.head;
  assert.equal(cursor?.relocatedByFold, true, 'T014-FOLD-CURSOR-01 selection inside a fold relocates to its header');
  assert.equal(cursor?.projectedOffset, 4, 'T014-FOLD-CURSOR-01 projected UTF-16 boundary is the fold header');
  assert.deepEqual(cursor?.position, { row: 1, column: 0 });
  assert.equal(frame.rows[1]?.kind, 'fold');
  assert.equal(frame.rows[2]?.lineIndex, 3);

  const resized = project(layout, document, 6, 4, selection, {
    folds: [{ id: 'fold-middle', documentVersion: document.snapshot().version, startLine: 1 as never, endLineExclusive: 3 as never }],
    foldGeneration: 7,
  });
  assert.notEqual(resized.identity.layoutGeneration, frame.identity.layoutGeneration);
  const stale = layout.hitTest(frame.identity.frameId, { row: 0, column: 0 });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.kind, 'stale-frame');
  console.log('T014-FOLD-CURSOR-01 and T014-STALE-HIT-01 passed: folded cursors project to the placeholder and resized frames reject old hit maps.');
}

function checkResizeRetainsLogicalViewportAnchor(): void {
  const document = editable('first line\nsecond line\nthird line');
  const layout = new ViewportLayout();
  const selection = selectionAt(document, 12);
  const anchor = { documentVersion: document.snapshot().version, lineIndex: 1 as never, offset: offset(11), displayCellColumn: 0 as never };
  const before = project(layout, document, 9, 3, selection, {}, anchor);
  const after = project(layout, document, 4, 4, selection, {}, anchor);
  assert.deepEqual(after.anchor, before.anchor, 'T014-RESIZE-ANCHOR-01 resize retains logical line and UTF-16 viewport anchor');
  assert.equal(after.rows[0]?.lineIndex, 1, 'T014-RESIZE-ANCHOR-01 same logical content remains at the top');
  console.log('T014-RESIZE-ANCHOR-01 passed: width and height changes preserve the versioned logical viewport position.');
}

function checkOnlyEditedVisibleLineMissesTheLineCache(): void {
  const document = editable('alpha\nbravo\ncharlie\ndelta');
  const layout = new ViewportLayout();
  project(layout, document, 16, 4);
  project(layout, document, 16, 4);
  const warm = layout.cacheStats;
  assert.equal(warm.frameCacheHits, 1, 'T014-BOUNDED-INVALIDATION-01 identical frames reuse their immutable row and hit-map projection');

  const before = document.snapshot();
  const proposal: EditProposal = {
    documentId,
    expectedVersion: before.version,
    edits: [{ start: offset(6), end: offset(11), text: 'BRAVO' }],
    origin: 'vim',
    undoGroup,
  };
  const committed = document.commit(proposal);
  assert.equal(committed.ok, true);
  if (!committed.ok || committed.value.kind !== 'committed') throw new Error('fixture-edit-failed');
  layout.observeDocumentChange(committed.value.change);
  project(layout, document, 16, 4);
  const after = layout.cacheStats;
  assert.equal(after.lineCacheMisses - warm.lineCacheMisses, 1, 'T014-BOUNDED-INVALIDATION-01 one changed line alone requires a new layout');
  assert.equal(after.lineCacheHits - warm.lineCacheHits, 3, 'T014-BOUNDED-INVALIDATION-01 three unchanged line layouts stay cached');
  console.log('T014-BOUNDED-INVALIDATION-01 passed: a one-line text edit invalidates one cached line layout; neighboring rows are reused.');
}

function checkRejectsMismatchedSnapshotsAndMalformedFolds(): void {
  const document = editable('one\ntwo\nthree');
  const layout = new ViewportLayout();
  const snapshot = document.snapshot();
  const selection = selectionAt(document);
  const mismatch = layout.project({ viewId, snapshot, selection: { ...selection, documentVersion: 999 as never }, widthCells: 10, heightCells: 3 });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.error.kind, 'stale-document-version');
  const badFolds = layout.project({
    viewId, snapshot, selection, widthCells: 10, heightCells: 3,
    options: { folds: [
      { id: 'outer', documentVersion: snapshot.version, startLine: 0 as never, endLineExclusive: 3 as never },
      { id: 'overlap', documentVersion: snapshot.version, startLine: 1 as never, endLineExclusive: 3 as never },
    ] },
  });
  assert.equal(badFolds.ok, false);
  if (!badFolds.ok) assert.equal(badFolds.error.kind, 'invalid-folds');
  const staleAnchor = layout.project({
    viewId, snapshot, selection, widthCells: 10, heightCells: 3,
    anchor: { documentVersion: 999 as never, lineIndex: 0 as never, offset: offset(0), displayCellColumn: 0 as never },
  });
  assert.equal(staleAnchor.ok, false);
  if (!staleAnchor.ok) assert.equal(staleAnchor.error.kind, 'stale-document-version');
  console.log('T014-INPUT-VALIDATION-01 passed: stale selection versions and overlapping fold definitions are rejected before publishing a frame.');
}

function checkBlockSelectionKeepsTabCellGeometry(): void {
  const document = editable('a\tb');
  const snapshot = document.snapshot();
  const block = createSelectionSet(snapshot, {
    primaryId,
    members: [{
      id: primaryId,
      kind: 'visual-block',
      direction: 'forward',
      anchor: {
        kind: 'block-cell', offset: offset(1),
        logicalUtf16Column: 1 as never, displayCellColumn: 2 as never, virtualCells: 0,
      },
      head: {
        kind: 'block-cell', offset: offset(1),
        logicalUtf16Column: 1 as never, displayCellColumn: 2 as never, virtualCells: 0,
      },
    }],
  });
  if (!block.ok) throw new Error(`fixture-block-selection:${block.error.kind}`);
  const layout = new ViewportLayout();
  const frame = project(layout, document, 8, 2, block.value.selectionSet, { tabSize: 4 });
  const projected = frame.selections[0]?.head;
  assert.equal(projected?.kind, 'block-cell');
  assert.deepEqual(projected?.position, { row: 0, column: 2 }, 'T014-BLOCK-CELL-PROJECTION-01 block endpoint uses display column inside tab');
  assert.equal(projected?.displayCellColumn, 2);
  assert.equal(projected?.virtualCells, 0);
  console.log('T014-BLOCK-CELL-PROJECTION-01 passed: block endpoints project by display-cell geometry while retaining UTF-16 and virtual metadata.');
}

function checkSelectionIdentityAndClippingProjection(): void {
  const document = editable('abc\ndef\nghi');
  const snapshot = document.snapshot();
  const multiple = createSelectionSet(snapshot, {
    primaryId: secondaryId,
    members: [
      {
        id: primaryId,
        kind: 'normal-cursor',
        direction: 'forward',
        anchor: { kind: 'character', offset: offset(0), after: offset(1) },
        head: { kind: 'character', offset: offset(0), after: offset(1) },
      },
      {
        id: secondaryId,
        kind: 'normal-cursor',
        direction: 'backward',
        anchor: { kind: 'character', offset: offset(8), after: offset(9) },
        head: { kind: 'character', offset: offset(8), after: offset(9) },
      },
    ],
  });
  if (!multiple.ok) throw new Error(`fixture-multiselection:${multiple.error.kind}`);
  const layout = new ViewportLayout();
  const frame = project(layout, document, 8, 3, multiple.value.selectionSet);
  const primary = frame.selections.find((member) => member.id === secondaryId);
  const secondary = frame.selections.find((member) => member.id === primaryId);
  assert.equal(primary?.primary, true, 'T014-SELECTION-PROJECTION-01 primary identity survives document-order layout');
  assert.equal(primary?.direction, 'backward');
  assert.deepEqual(primary?.head.position, { row: 2, column: 0 });
  assert.equal(secondary?.primary, false);
  assert.deepEqual(secondary?.head.position, { row: 0, column: 0 });

  const clipped = project(layout, document, 8, 1, multiple.value.selectionSet);
  const offscreen = clipped.selections.find((member) => member.id === secondaryId);
  assert.equal(offscreen?.head.clipped, true, 'T014-SELECTION-PROJECTION-01 offscreen secondary remains in the set but has no cell location');
  console.log('T014-SELECTION-PROJECTION-01 passed: immutable members retain IDs, primary/direction and clipped state across viewport projection.');
}

function checkCustomWidthAndEmptyLinePolicies(): void {
  const customDocument = editable('界x');
  const layout = new ViewportLayout();
  const baseWidth = defaultCellWidthPolicy();
  const frame = project(layout, customDocument, 2, 1, selectionAt(customDocument), {
    widthPolicy: {
      id: 'T014-single-cell-CJK',
      generation: 1,
      widthOfCluster: (cluster) => cluster === '界' ? 1 : baseWidth.widthOfCluster(cluster),
    },
  });
  assert.equal(frame.rows[0]?.cells[0]?.text, '界', 'T014-WIDTH-POLICY-01 the supplied terminal policy controls CJK width');
  assert.equal(frame.rows[0]?.cells[1]?.text, 'x');

  const emptyLineDocument = editable('a\n');
  const emptyLayout = new ViewportLayout();
  const emptyFrame = project(emptyLayout, emptyLineDocument, 3, 2);
  assert.equal(emptyFrame.rows[1]?.lineIndex, 1, 'T014-EMPTY-EOF-01 final empty logical line has its own row');
  const eof = emptyLayout.positionForOffset(emptyFrame.identity.frameId, offset(2));
  assert.equal(eof.ok, true, 'T014-EMPTY-EOF-01 EOF maps to the empty line cell');
  if (eof.ok) {
    const hit = emptyLayout.hitTest(emptyFrame.identity.frameId, eof.value);
    assert.equal(hit.ok, true);
    if (hit.ok) assert.equal(hit.value.target.offset, 2);
  }
  console.log('T014-WIDTH-POLICY-01 and T014-EMPTY-EOF-01 passed: terminal width policy is injectable and trailing empty lines remain addressable.');
}

function checkRaggedRowsAndWideGlyphClippedAtViewportEdge(): void {
  const raggedDocument = editable('x\nlong');
  const raggedLayout = new ViewportLayout();
  const raggedFrame = project(raggedLayout, raggedDocument, 5, 2);
  assert.equal(raggedFrame.rows[0]?.text, 'x    ', 'T014-RAGGED-ROW-01 shorter rows are padded to viewport width');
  assert.equal(raggedFrame.rows[1]?.text, 'long ', 'T014-RAGGED-ROW-01 longer rows retain text and one explicit pad cell');
  assert.equal(raggedFrame.rows[0]?.cells.length, 5);
  assert.equal(raggedFrame.rows[0]?.cells[1]?.role, 'padding');

  const clippedDocument = editable('abc界');
  const clippedLayout = new ViewportLayout();
  const clippedFrame = project(clippedLayout, clippedDocument, 4, 1, selectionAt(clippedDocument), { wrap: false });
  assert.equal(clippedFrame.rows[0]?.cells[3]?.role, 'clipped-glyph', 'T014-WIDE-EDGE-01 a wide glyph is never painted half-visible');
  assert.equal(clippedFrame.rows[0]?.cells[3]?.text, ' ', 'T014-WIDE-EDGE-01 the partial glyph is replaced by a blank cell');
  const hit = clippedLayout.hitTest(clippedFrame.identity.frameId, { row: 0, column: 3 });
  assert.equal(hit.ok, true);
  if (hit.ok) assert.equal(hit.value.target.offset, 3, 'T014-WIDE-EDGE-01 the clipped cell retains its source boundary');
  console.log('T014-RAGGED-ROW-01 and T014-WIDE-EDGE-01 passed: ragged lines receive explicit padding and a wide glyph at the no-wrap edge is not split.');
}

function checkTypingOnFirstLineKeepsLowerRowContentIdentityAndShiftsOffsetsCorrectly(): void {
  // Matches the production non-wrapping viewport shape (packages/ui/src/workbench.ts
  // uses `{ wrap: false, gutterWidthCells: 6 }`): a document with several lines below
  // the edit, wrap off, gutter on.
  const document = editable('first\nsecond\nthird\nfourth\nfifth');
  const layout = new ViewportLayout();
  const options: ViewportProjectionInput['options'] = { wrap: false, gutterWidthCells: 6 };
  const before = project(layout, document, 20, 5, selectionAt(document), options);
  assert.equal(before.rows.length, 5);

  const proposal: EditProposal = {
    documentId,
    expectedVersion: document.snapshot().version,
    edits: [{ start: offset(0), end: offset(0), text: 'X' }],
    origin: 'vim',
    undoGroup,
  };
  const committed = document.commit(proposal);
  assert.equal(committed.ok, true);
  if (!committed.ok || committed.value.kind !== 'committed') throw new Error('fixture-edit-failed');
  layout.observeDocumentChange(committed.value.change);
  const after = project(layout, document, 20, 5, selectionAt(document), options);
  assert.equal(after.rows.length, 5);

  // The edited line's own row legitimately changes.
  assert.notEqual(after.rows[0]?.text, before.rows[0]?.text, 'the edited line\'s rendered text changes');

  for (let rowIndex = 1; rowIndex < 5; rowIndex += 1) {
    const beforeRow = before.rows[rowIndex];
    const afterRow = after.rows[rowIndex];
    assert.ok(beforeRow !== undefined && afterRow !== undefined);
    if (beforeRow === undefined || afterRow === undefined) continue;
    assert.equal(afterRow.text, beforeRow.text,
      `T014-STABLE-CONTENT-01 row ${rowIndex} keeps identical rendered glyphs when only an earlier line changed`);
    assert.equal(afterRow.contentKey, beforeRow.contentKey,
      `T014-STABLE-CONTENT-01 row ${rowIndex} content identity is stable across the absolute-offset shift`);
    assert.ok(beforeRow.contentKey !== null, 'a text row always carries a non-null content key');
    assert.equal(afterRow.lineIndex, beforeRow.lineIndex);
    assert.equal((afterRow.startOffset as number), (beforeRow.startOffset as number) + 1,
      `T014-SHIFTED-OFFSET-01 row ${rowIndex} start offset absorbs the one inserted character`);
    assert.equal((afterRow.endOffset as number), (beforeRow.endOffset as number) + 1,
      `T014-SHIFTED-OFFSET-01 row ${rowIndex} end offset absorbs the one inserted character`);
    for (let column = 0; column < afterRow.cells.length; column += 1) {
      const beforeTarget: CellHitTarget | null | undefined = beforeRow.cells[column]?.target;
      const afterTarget: CellHitTarget | null | undefined = afterRow.cells[column]?.target;
      if (beforeTarget?.kind === 'text' && afterTarget?.kind === 'text') {
        assert.equal(afterTarget.offset as number, (beforeTarget.offset as number) + 1,
          `T014-SHIFTED-OFFSET-01 row ${rowIndex} column ${column} cell offset absorbs the one inserted character`);
      }
      if (beforeTarget?.kind === 'gutter' && afterTarget?.kind === 'gutter') {
        assert.deepEqual(afterTarget, beforeTarget, `T014-STABLE-CONTENT-01 row ${rowIndex} column ${column} gutter label is unchanged`);
      }
    }
  }

  // Hit-testing and offset lookups on the shifted rows must still be correct, not
  // merely reused: probe the second visible line's first text cell (after the
  // 6-column gutter) by its NEW absolute offset.
  const secondLineFirstCellBefore = before.rows[1]?.cells[6]?.target;
  assert.equal(secondLineFirstCellBefore?.kind, 'text');
  const expectedOffset = secondLineFirstCellBefore?.kind === 'text' ? (secondLineFirstCellBefore.offset as number) + 1 : -1;
  const position = layout.positionForOffset(after.identity.frameId, offset(expectedOffset));
  assert.equal(position.ok, true, 'T014-SHIFTED-OFFSET-01 the shifted offset resolves to a screen position');
  if (position.ok) {
    assert.deepEqual(position.value, { row: 1, column: 6 }, 'T014-SHIFTED-OFFSET-01 offset maps to the same visible cell as before the edit');
    const hit = layout.hitTest(after.identity.frameId, position.value);
    assert.equal(hit.ok, true);
    if (hit.ok) {
      assert.equal(hit.value.target.offset, expectedOffset, 'T014-SHIFTED-OFFSET-01 hit-testing returns the correct shifted offset');
      assert.equal(Object.isFrozen(hit.value.target), true,
        'T014-LAZY-TARGET-FREEZE-01 a target actually returned by hitTest is frozen');
    }
  }
  // Performance fix (see rebaseMaterializedRows in packages/layout/src/index.ts):
  // per-frame cells are deliberately left unfrozen until `hitTest` actually returns
  // one, so an un-hit-tested cell's target on the published frame stays unfrozen.
  const untouchedTarget = after.rows[2]?.cells[7]?.target;
  assert.ok(untouchedTarget !== null && untouchedTarget !== undefined);
  if (untouchedTarget !== null && untouchedTarget !== undefined) {
    assert.equal(Object.isFrozen(untouchedTarget), false,
      'T014-LAZY-TARGET-FREEZE-01 a cell target nobody hit-tested is not eagerly frozen');
  }
  console.log('T014-STABLE-CONTENT-01 and T014-SHIFTED-OFFSET-01 passed: typing on the first visible line keeps unaffected rows\' content identity stable and shifts their absolute offsets and hit-testing correctly.');
}

function checkHorizontalScrollFollowsCursorOffScreen(): void {
  const document = editable(`${'x'.repeat(600)}`);
  const selection = selectionAt(document, 500);
  const widthCells = 80;
  const resolved = resolveScrollAnchor(document.snapshot(), selection, 0, 20, widthCells, 0);
  assert.equal(resolved.ok, true, 'T014-HSCROLL-01 resolveScrollAnchor succeeds for a long unwrapped line');
  if (!resolved.ok) return;
  assert.ok(resolved.value.scrollLeft > 0, 'T014-HSCROLL-01 a cursor past the viewport width scrolls right');
  const layout = new ViewportLayout();
  const frame = project(
    layout, document, widthCells, 20, selection,
    { wrap: false, horizontalScrollCells: resolved.value.scrollLeft }, resolved.value.anchor,
  );
  const primary = frame.selections.find((member) => member.primary);
  assert.ok(primary !== undefined, 'T014-HSCROLL-01 primary selection projects');
  assert.equal(primary?.head.clipped, false, 'T014-HSCROLL-01 the caret cell is not clipped once scrolled into view');
  const position = primary?.head.position;
  assert.ok(position !== null && position !== undefined, 'T014-HSCROLL-01 the caret has a visible screen position');
  if (position !== null && position !== undefined) {
    assert.ok(position.column >= 0 && position.column < widthCells, 'T014-HSCROLL-01 the caret column stays inside the viewport width');
  }
  console.log('T014-HSCROLL-01 passed: resolveScrollAnchor scrolls horizontally to keep an off-screen cursor column visible and unclipped.');
}

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'fixture-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

checkUtf16CellRoundTripsAcrossTabsWideGlyphsAndClusters();
checkTabExpansionCanCrossWrap();
checkFoldRelocationAndFrameStaleness();
checkResizeRetainsLogicalViewportAnchor();
checkOnlyEditedVisibleLineMissesTheLineCache();
checkRejectsMismatchedSnapshotsAndMalformedFolds();
checkBlockSelectionKeepsTabCellGeometry();
checkSelectionIdentityAndClippingProjection();
checkCustomWidthAndEmptyLinePolicies();
checkRaggedRowsAndWideGlyphClippedAtViewportEdge();
checkTypingOnFirstLineKeepsLowerRowContentIdentityAndShiftsOffsetsCorrectly();
checkHorizontalScrollFollowsCursorOffScreen();
