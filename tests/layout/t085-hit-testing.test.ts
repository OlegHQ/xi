import { strict as assert } from 'node:assert';
import {
  asIdentifier,
  type DocumentId,
  type SelectionId,
  type UndoGroupId,
  type ViewId,
  type CellColumn,
  type Utf16Offset,
  type LineIndex,
} from '../../packages/primitives/src/index';
import { TextFileDocument, type EditProposal } from '../../packages/document/src/index';
import {
  createSelectionSet,
  mapSelectionSet,
  type EndpointInput,
  type SelectionSetSnapshot,
} from '../../packages/selections/src/index';
import { ViewportLayout, type DiffFillerRow, type VirtualAnnotation } from '../../packages/layout/src/index';

const viewId = identifier<ViewId>('T085-view');
const documentId = identifier<DocumentId>('T085-document');
const primaryId = identifier<SelectionId>('T085-primary');
const emptyLineId = identifier<SelectionId>('T085-empty-line');
const eofId = identifier<SelectionId>('T085-eof');
const undoGroup = identifier<UndoGroupId>('T085-edit');

function editable(text: string, id = documentId): TextFileDocument {
  const endings = Array.from({ length: [...text].filter((character) => character === '\n').length }, () => 'lf' as const);
  const created = TextFileDocument.create(id, text, endings, 'lf');
  if (!created.ok) throw new Error(`T085-document:${created.error.kind}`);
  return created.value;
}

function endpointSet(document: TextFileDocument, endpoints: readonly { readonly id: SelectionId; readonly endpoint: EndpointInput }[], primary: SelectionId): SelectionSetSnapshot {
  const created = createSelectionSet(document.snapshot(), {
    primaryId: primary,
    members: endpoints.map(({ id, endpoint }) => ({
      id,
      kind: 'normal-cursor' as const,
      direction: 'forward' as const,
      anchor: endpoint,
      head: endpoint,
    })),
  });
  if (!created.ok) throw new Error(`T085-selection:${created.error.kind}`);
  return created.value.selectionSet;
}

function gapSelection(document: TextFileDocument, at = 0): SelectionSetSnapshot {
  const gap: EndpointInput = { kind: 'gap', offset: offset(at), affinity: 'right' };
  const created = createSelectionSet(document.snapshot(), {
    primaryId,
    members: [{ id: primaryId, kind: 'insert-caret', direction: 'forward', anchor: gap, head: gap }],
  });
  if (!created.ok) throw new Error(`T085-insert-selection:${created.error.kind}`);
  return created.value.selectionSet;
}

function project(
  layout: ViewportLayout,
  document: TextFileDocument,
  selection: SelectionSetSnapshot,
  widthCells: number,
  heightCells: number,
  options: Parameters<ViewportLayout['project']>[0]['options'] = {},
  anchor?: Parameters<ViewportLayout['project']>[0]['anchor'],
) {
  const result = layout.project({
    viewId, snapshot: document.snapshot(), selection, widthCells, heightCells,
    ...(options === undefined ? {} : { options }),
    ...(anchor === undefined ? {} : { anchor }),
  });
  if (!result.ok) throw new Error(`T085-layout:${result.error.kind}`);
  return result.value;
}

function hit(layout: ViewportLayout, frameId: Parameters<ViewportLayout['hitTest']>[0], row: number, column: number) {
  const result = layout.hitTest(frameId, { row, column });
  if (!result.ok) throw new Error(`T085-hit:${result.error.kind}`);
  return result.value;
}

function checkMP03TextAndEmptyEofRoundTrips(): void {
  const ordinaryDocument = editable('abc');
  const ordinaryLayout = new ViewportLayout();
  const ordinaryFrame = project(ordinaryLayout, ordinaryDocument, gapSelection(ordinaryDocument), 5, 1);
  for (const sourceOffset of [0, 1, 2, 3]) {
    const position = ordinaryLayout.positionForOffset(ordinaryFrame.identity.frameId, offset(sourceOffset));
    assert.equal(position.ok, true, `MP03-T085-ORDINARY-ROUNDTRIP-01 position ${sourceOffset}`);
    if (!position.ok) continue;
    const projected = hit(ordinaryLayout, ordinaryFrame.identity.frameId, position.value.row, position.value.column);
    assert.equal(projected.target.kind, 'text');
    if (projected.target.kind === 'text') {
      assert.equal(projected.target.offset, sourceOffset);
      if (sourceOffset === 0) assert.equal(projected.target.affinity, 'left', 'MP03-T085-HIT-AFFINITY-01 ordinary glyph hit carries left bias');
      if (sourceOffset === 3) {
        assert.equal(projected.target.cellPart, 'padding');
        assert.equal(projected.target.affinity, 'right', 'MP03-T085-HIT-AFFINITY-01 text padding at EOF carries right bias');
      }
    }
    if (sourceOffset === 0) {
      assert.equal(Object.isFrozen(projected), true, 'MP03-T085-IMMUTABLE-HIT-01 published hit record is frozen');
      assert.equal(Object.isFrozen(projected.identity), true, 'MP03-T085-IMMUTABLE-HIT-01 hit identity is frozen');
      assert.equal(Object.isFrozen(projected.point), true, 'MP03-T085-IMMUTABLE-HIT-01 cell point is frozen');
      assert.equal(Object.isFrozen(projected.target), true, 'MP03-T085-IMMUTABLE-HIT-01 tagged target is frozen');
      assert.equal(Object.isFrozen(ordinaryFrame.identity), true, 'MP03-T085-IMMUTABLE-HIT-01 published frame identity is frozen');
    }
  }

  const document = editable('ab\t界e\u0301👩‍💻');
  const selection = gapSelection(document);
  const layout = new ViewportLayout();
  const frame = project(layout, document, selection, 20, 2, { tabSize: 4 });

  for (const [sourceOffset, expectedCell, expectedPart] of [
    [0, 0, 'glyph'], [1, 1, 'glyph'], [2, 2, 'tab-fill'], [3, 4, 'glyph'], [4, 6, 'glyph'], [6, 7, 'glyph'],
  ] as const) {
    const position = layout.positionForOffset(frame.identity.frameId, offset(sourceOffset));
    assert.equal(position.ok, true, `MP03-T085-TEXT-ROUNDTRIP-01 position ${sourceOffset}`);
    if (!position.ok) continue;
    assert.equal(position.value.column, expectedCell, `MP03-T085-TEXT-ROUNDTRIP-01 column ${sourceOffset}`);
    const projected = hit(layout, frame.identity.frameId, position.value.row, position.value.column);
    assert.equal(projected.identity.documentVersion, frame.identity.documentVersion);
    assert.equal(projected.target.kind, 'text');
    if (projected.target.kind === 'text') {
      assert.equal(projected.target.offset, sourceOffset);
      assert.equal(projected.target.cellPart, expectedPart);
    }
  }

  const wideTrailing = hit(layout, frame.identity.frameId, 0, 5).target;
  assert.equal(wideTrailing.kind, 'text');
  if (wideTrailing.kind === 'text') {
    assert.equal(wideTrailing.offset, 3, 'MP03-T085-WIDE-TRAILING-01 trailing cell snaps to the leading UTF-16 boundary');
    assert.equal(wideTrailing.cellPart, 'wide-continuation');
    assert.equal(wideTrailing.affinity, 'left', 'MP03-T085-HIT-AFFINITY-01 wide continuation carries left bias');
  }
  const tabSecondCell = hit(layout, frame.identity.frameId, 0, 3).target;
  assert.equal(tabSecondCell.kind, 'text');
  if (tabSecondCell.kind === 'text') {
    assert.equal(tabSecondCell.offset, 2);
    assert.equal(tabSecondCell.virtualCell, 1);
    assert.equal(tabSecondCell.cellPart, 'tab-fill');
    assert.equal(tabSecondCell.affinity, 'left', 'MP03-T085-HIT-AFFINITY-01 tab cell carries left bias');
  }

  const combiningInterior = layout.positionForOffset(frame.identity.frameId, offset(5));
  const combiningStart = layout.positionForOffset(frame.identity.frameId, offset(4));
  assert.deepEqual(combiningInterior, combiningStart, 'MP03-T085-GRAPHEME-ROUNDTRIP-01 combining interior maps to its cluster cell');
  const zwjTrailing = hit(layout, frame.identity.frameId, 0, 8).target;
  assert.equal(zwjTrailing.kind, 'text');
  if (zwjTrailing.kind === 'text') {
    assert.equal(zwjTrailing.offset, 6, 'MP03-T085-ZWJ-ROUNDTRIP-01 ZWJ wide continuation snaps to its leading boundary');
    assert.equal(zwjTrailing.cellPart, 'wide-continuation');
  }

  const emptyDocument = editable('');
  const emptySet = endpointSet(emptyDocument, [
    { id: emptyLineId, endpoint: { kind: 'empty-line', lineIndex: 0 as LineIndex } },
    { id: eofId, endpoint: { kind: 'eof' } },
  ], emptyLineId);
  const emptyLayout = new ViewportLayout();
  const emptyFrame = project(emptyLayout, emptyDocument, emptySet, 4, 1);
  assert.deepEqual(emptyFrame.selections.map((member) => member.head.kind), ['empty-line', 'eof']);
  assert.deepEqual(emptyFrame.selections.map((member) => member.head.position), [{ row: 0, column: 0 }, { row: 0, column: 0 }]);
  const emptyPosition = emptyLayout.positionForOffset(emptyFrame.identity.frameId, offset(0));
  assert.deepEqual(emptyPosition, { ok: true, value: { row: 0, column: 0 } }, 'MP03-T085-EMPTY-EOF-ROUNDTRIP-01 empty line and EOF project to the explicit cursor cell');
  const emptyHit = hit(emptyLayout, emptyFrame.identity.frameId, 0, 0);
  assert.equal(emptyHit.target.kind, 'text');
  if (emptyHit.target.kind === 'text') {
    assert.equal(emptyHit.target.lineIndex, 0);
    assert.equal(emptyHit.target.offset, 0);
    assert.equal(emptyHit.target.cellPart, 'padding');
    assert.equal(emptyHit.target.affinity, 'right', 'MP03-T085-HIT-AFFINITY-01 empty-line/EOF cell carries right bias');
  }

  const newlineDocument = editable('x\n');
  const newlineSet = endpointSet(newlineDocument, [
    { id: emptyLineId, endpoint: { kind: 'empty-line', lineIndex: 1 as LineIndex } },
    { id: eofId, endpoint: { kind: 'eof' } },
  ], emptyLineId);
  const newlineLayout = new ViewportLayout();
  const newlineFrame = project(newlineLayout, newlineDocument, newlineSet, 4, 2);
  const eofPosition = newlineLayout.positionForOffset(newlineFrame.identity.frameId, offset(2));
  assert.deepEqual(eofPosition, { ok: true, value: { row: 1, column: 0 } });
  const newlineHit = hit(newlineLayout, newlineFrame.identity.frameId, 1, 0);
  assert.equal(newlineHit.target.kind, 'text');
  if (newlineHit.target.kind === 'text') {
    assert.equal(newlineHit.target.lineIndex, 1);
    assert.equal(newlineHit.target.offset, 2);
  }
  console.log('MP03-T085-ORDINARY-ROUNDTRIP-01, MP03-T085-TEXT-ROUNDTRIP-01, MP03-T085-EMPTY-EOF-ROUNDTRIP-01 and Unicode trailing-cell fixtures passed.');
}

function checkStaleFrameAndVersionCancellation(): void {
  const document = editable('before');
  const layout = new ViewportLayout();
  const oldSnapshot = document.snapshot();
  const oldSelection = gapSelection(document);
  const oldFrame = project(layout, document, oldSelection, 12, 2);
  const proposal: EditProposal = {
    documentId,
    expectedVersion: oldSnapshot.version,
    edits: [{ start: offset(0), end: offset(1), text: 'B' }],
    origin: 'vim',
    undoGroup,
  };
  const committed = document.commit(proposal);
  assert.equal(committed.ok, true);
  if (!committed.ok || committed.value.kind !== 'committed') throw new Error('MP03-T085-STALE-VERSION-01 fixture commit failed');
  layout.observeDocumentChange(committed.value.change);

  const staleBeforeReprojection = layout.hitTest(oldFrame.identity.frameId, { row: 0, column: 0 });
  assert.equal(staleBeforeReprojection.ok, false, 'MP03-T085-STALE-VERSION-01 observed text edits cancel hits before a new frame is published');
  if (!staleBeforeReprojection.ok) assert.equal(staleBeforeReprojection.error.kind, 'stale-document-version');
  const stalePosition = layout.positionForOffset(oldFrame.identity.frameId, offset(0));
  assert.equal(stalePosition.ok, false, 'MP03-T085-STALE-VERSION-01 stale projection queries are cancelled with the old hit map');
  if (!stalePosition.ok) assert.equal(stalePosition.error.kind, 'stale-document-version');
  const staleProjection = layout.project({
    viewId, snapshot: oldSnapshot, selection: oldSelection, widthCells: 12, heightCells: 2,
  });
  assert.equal(staleProjection.ok, false, 'MP03-T085-STALE-VERSION-01 older snapshot cannot be republished after a newer change was observed');
  if (!staleProjection.ok) assert.equal(staleProjection.error.kind, 'stale-document-version');

  const mapped = mapSelectionSet(oldSelection, committed.value.change.changeMap, committed.value.change.snapshot);
  if (!mapped.ok) throw new Error(`MP03-T085-selection-map:${mapped.error.kind}`);
  const freshFrame = project(layout, document, mapped.value.selectionSet, 12, 2);
  const oldFrameHit = layout.hitTest(oldFrame.identity.frameId, { row: 0, column: 0 });
  assert.equal(oldFrameHit.ok, false, 'MP03-T085-RESIZE-STALE-FRAME-01 old frame stays cancelled after a current frame is published');
  if (!oldFrameHit.ok) assert.equal(oldFrameHit.error.kind, 'stale-document-version');
  const currentHit = hit(layout, freshFrame.identity.frameId, 0, 0);
  assert.equal(currentHit.identity.documentVersion, committed.value.change.after, 'MP03-T085-STALE-VERSION-01 current hit carries the committed version');
  assert.equal(currentHit.target.kind, 'text', 'MP03-T085-STALE-VERSION-01 current-version frame resolves text normally');

  const resizeFrame = project(layout, document, mapped.value.selectionSet, 8, 2);
  const resizedOldHit = layout.hitTest(freshFrame.identity.frameId, { row: 0, column: 0 });
  assert.equal(resizedOldHit.ok, false, 'MP03-T085-RESIZE-STALE-FRAME-02 a newer geometry frame cancels the previous frame');
  if (!resizedOldHit.ok) assert.equal(resizedOldHit.error.kind, 'stale-frame');
  const overflow = layout.hitTest(resizeFrame.identity.frameId, { row: Number.MAX_SAFE_INTEGER + 1, column: 0 });
  assert.equal(overflow.ok, false, 'MP03-T085-BOUNDED-CELL-01 oversized terminal coordinates are rejected');
  if (!overflow.ok) assert.equal(overflow.error.kind, 'outside-viewport');
  console.log('MP03-T085-STALE-VERSION-01, MP03-T085-RESIZE-STALE-FRAME-01 and bounded coordinate rejection passed.');
}

function checkTypedGutterFoldAnnotationAndDiffTargets(): void {
  const gutterDocument = editable('abcdef\nnext');
  const gutterLayout = new ViewportLayout();
  const gutterFrame = project(gutterLayout, gutterDocument, gapSelection(gutterDocument), 7, 4, { gutterWidthCells: 2 });
  const gutterHit = hit(gutterLayout, gutterFrame.identity.frameId, 0, 0);
  assert.equal(gutterHit.target.kind, 'gutter', 'MP03-T085-GUTTER-01 gutter cells have a non-text target');
  if (gutterHit.target.kind === 'gutter') {
    assert.equal(gutterHit.target.lineIndex, 0);
    assert.equal(gutterHit.target.wrapIndex, 0);
    assert.equal(gutterHit.target.region, 'line-number');
  }
  const continuedGutterHit = hit(gutterLayout, gutterFrame.identity.frameId, 1, 0);
  assert.equal(continuedGutterHit.target.kind, 'gutter', 'MP03-T085-GUTTER-01 wrapped rows have a distinct gutter continuation target');
  if (continuedGutterHit.target.kind === 'gutter') {
    assert.equal(continuedGutterHit.target.lineIndex, 0);
    assert.equal(continuedGutterHit.target.wrapIndex, 1);
    assert.equal(continuedGutterHit.target.region, 'continuation');
  }
  const gutterTextPosition = gutterLayout.positionForOffset(gutterFrame.identity.frameId, offset(0));
  assert.deepEqual(gutterTextPosition, { ok: true, value: { row: 0, column: 2 } }, 'MP03-T085-GUTTER-01 text projection skips gutter cells');
  assert.equal(hit(gutterLayout, gutterFrame.identity.frameId, 0, 2).target.kind, 'text');

  const foldDocument = editable('top\nhead\nhidden\nend');
  const foldLayout = new ViewportLayout();
  const foldFrame = project(foldLayout, foldDocument, gapSelection(foldDocument, 9), 12, 4, {
    folds: [{ id: 'T085-fold', documentVersion: foldDocument.snapshot().version, startLine: 1 as LineIndex, endLineExclusive: 3 as LineIndex }],
    foldGeneration: 1,
  });
  const foldHit = hit(foldLayout, foldFrame.identity.frameId, 1, 0);
  assert.equal(foldHit.target.kind, 'fold', 'MP03-T085-FOLD-01 fold placeholder is not a text boundary');
  if (foldHit.target.kind === 'fold') assert.equal(foldHit.target.foldId, 'T085-fold', 'MP03-T085-FOLD-01 fold target retains its typed identity');

  const annotationDocument = editable('ab');
  const annotation: VirtualAnnotation = {
    id: 'inlay-hint-1', documentVersion: annotationDocument.snapshot().version,
    lineIndex: 0 as LineIndex, offset: offset(1), text: 'hint',
  };
  const annotationLayout = new ViewportLayout();
  const annotationFrame = project(annotationLayout, annotationDocument, gapSelection(annotationDocument), 8, 1, {
    virtualAnnotations: [annotation],
  });
  assert.equal(annotationFrame.rows[0]?.kind, 'text', 'MP03-T085-INLAY-TARGET-01 inlay occupies the text row');
  assert.equal(annotationFrame.rows[0]?.text, 'ahintb  ', 'MP03-T085-INLAY-TARGET-01 annotation is projected in place and the row remains viewport padded');
  const annotationHit = hit(annotationLayout, annotationFrame.identity.frameId, 0, 1);
  assert.equal(annotationHit.target.kind, 'virtual-annotation', 'MP03-T085-INLAY-TARGET-01 inline hint has a distinct target');
  if (annotationHit.target.kind === 'virtual-annotation') {
    assert.equal(annotationHit.target.annotationId, 'inlay-hint-1');
    assert.equal(annotationHit.target.anchorOffset, 1);
    assert.equal(Object.hasOwn(annotationHit.target, 'offset'), false, 'annotation target is not an editable text hit');
  }
  assert.equal(hit(annotationLayout, annotationFrame.identity.frameId, 0, 5).target.kind, 'text', 'MP03-T085-INLAY-TARGET-01 adjacent source text retains an ordinary text target');

  const diffDocument = editable('a\nb');
  const diffLayout = new ViewportLayout();
  const diffFrame = project(diffLayout, diffDocument, gapSelection(diffDocument), 5, 3, {
    diffFillerRows: [{ id: 'diff-gap-1', documentVersion: diffDocument.snapshot().version, beforeLine: 1 as LineIndex }],
  });
  assert.deepEqual(diffFrame.rows.map((row) => row.kind), ['text', 'diff-filler', 'text']);
  const fillerHit = hit(diffLayout, diffFrame.identity.frameId, 1, 2);
  assert.equal(fillerHit.target.kind, 'diff-filler', 'MP03-T085-DIFF-FILLER-01 alignment row has a distinct non-text target');
  if (fillerHit.target.kind === 'diff-filler') {
    assert.equal(fillerHit.target.fillerId, 'diff-gap-1');
    assert.equal(fillerHit.target.beforeLine, 1);
    assert.equal(Object.hasOwn(fillerHit.target, 'offset'), false, 'diff filler is not an editable document boundary');
  }
  const secondLinePosition = diffLayout.positionForOffset(diffFrame.identity.frameId, offset(2));
  assert.deepEqual(secondLinePosition, { ok: true, value: { row: 2, column: 0 } }, 'MP03-T085-DIFF-FILLER-01 filler rows never acquire text boundaries');

  const eofFillerLayout = new ViewportLayout();
  const eofFillerFrame = project(eofFillerLayout, diffDocument, gapSelection(diffDocument), 5, 4, {
    diffFillerRows: [{ id: 'diff-eof-gap', documentVersion: diffDocument.snapshot().version, beforeLine: 2 as LineIndex }],
  });
  assert.equal(eofFillerFrame.rows[2]?.kind, 'diff-filler', 'MP03-T085-DIFF-FILLER-EOF-01 alignment supports a distinct filler after the final logical line');
  const eofFillerHit = hit(eofFillerLayout, eofFillerFrame.identity.frameId, 2, 0);
  assert.equal(eofFillerHit.target.kind, 'diff-filler');
  if (eofFillerHit.target.kind === 'diff-filler') {
    assert.equal(eofFillerHit.target.beforeLine, 2);
    assert.equal(Object.hasOwn(eofFillerHit.target, 'offset'), false);
  }

  const badAnnotation = annotationLayout.project({
    viewId, snapshot: annotationDocument.snapshot(), selection: gapSelection(annotationDocument), widthCells: 8, heightCells: 1,
    options: { virtualAnnotations: [{ ...annotation, documentVersion: 99 as never }] },
  });
  assert.equal(badAnnotation.ok, false, 'MP03-T085-INVALID-ANNOTATION-01 stale annotations are rejected before frame publication');
  if (!badAnnotation.ok) assert.equal(badAnnotation.error.kind, 'invalid-annotations');
  const badFiller = diffLayout.project({
    viewId, snapshot: diffDocument.snapshot(), selection: gapSelection(diffDocument), widthCells: 5, heightCells: 3,
    options: { diffFillerRows: [{ id: 'stale-gap', documentVersion: 99 as never, beforeLine: 1 as LineIndex }] },
  });
  assert.equal(badFiller.ok, false, 'MP03-T085-INVALID-FILLER-01 stale filler rows are rejected before frame publication');
  if (!badFiller.ok) assert.equal(badFiller.error.kind, 'invalid-diff-fillers');
  console.log('MP03-T085-GUTTER-01, MP03-T085-FOLD-01, MP03-T085-INLAY-TARGET-01, MP03-T085-DIFF-FILLER-01 and invalid virtual-target validation passed.');
}

function checkBoundedAnnotationAndFillerInputs(): void {
  const document = editable('ab');
  const snapshot = document.snapshot();
  const selection = gapSelection(document);
  const layout = new ViewportLayout();
  const baseAnnotation: VirtualAnnotation = {
    id: 'hint', documentVersion: snapshot.version, lineIndex: 0 as LineIndex, offset: offset(1), text: 'hint',
  };
  const annotationResult = (annotations: readonly VirtualAnnotation[]) => layout.project({
    viewId, snapshot, selection, widthCells: 8, heightCells: 1, options: { virtualAnnotations: annotations },
  });
  const fillerResult = (diffFillerRows: readonly DiffFillerRow[]) => layout.project({
    viewId, snapshot, selection, widthCells: 8, heightCells: 1, options: { diffFillerRows },
  });
  const invalidAnnotation = (annotations: readonly VirtualAnnotation[], fixture: string): void => {
    const result = annotationResult(annotations);
    assert.equal(result.ok, false, `${fixture} rejects invalid annotation input`);
    if (!result.ok) assert.equal(result.error.kind, 'invalid-annotations', fixture);
  };
  const invalidFiller = (fillers: readonly DiffFillerRow[], fixture: string): void => {
    const result = fillerResult(fillers);
    assert.equal(result.ok, false, `${fixture} rejects invalid filler input`);
    if (!result.ok) assert.equal(result.error.kind, 'invalid-diff-fillers', fixture);
  };

  invalidAnnotation([{ ...baseAnnotation, id: '' }], 'MP03-T085-ANNOTATION-ID-EMPTY-01');
  invalidAnnotation([{ ...baseAnnotation, id: 'a'.repeat(257) }], 'MP03-T085-ANNOTATION-ID-LENGTH-01');
  invalidAnnotation([baseAnnotation, { ...baseAnnotation, id: 'hint' }], 'MP03-T085-ANNOTATION-ID-DUPLICATE-01');
  invalidAnnotation([{ ...baseAnnotation, lineIndex: 1 as LineIndex }], 'MP03-T085-ANNOTATION-BOUNDS-01');
  invalidAnnotation([{ ...baseAnnotation, offset: offset(3) }], 'MP03-T085-ANNOTATION-BOUNDS-02');
  invalidAnnotation([{ ...baseAnnotation, text: '' }], 'MP03-T085-ANNOTATION-TEXT-EMPTY-01');
  invalidAnnotation([{ ...baseAnnotation, text: 'x'.repeat(257) }], 'MP03-T085-ANNOTATION-TEXT-LENGTH-01');
  invalidAnnotation([{ ...baseAnnotation, text: 'x\ty' }], 'MP03-T085-ANNOTATION-TEXT-CONTROL-01');

  const validAtPerItemLimit: VirtualAnnotation[] = Array.from({ length: 256 }, (_, index) => ({
    id: index === 0 ? 'i'.repeat(256) : `hint-${index}`,
    documentVersion: snapshot.version,
    lineIndex: 0 as LineIndex,
    offset: offset(1),
    text: 'x'.repeat(256),
  }));
  const maximumAggregate = annotationResult(validAtPerItemLimit);
  assert.equal(maximumAggregate.ok, true, 'MP03-T085-ANNOTATION-BOUNDARY-01 allows 256-unit IDs/text and an aggregate of exactly 65,536 units');
  invalidAnnotation([...validAtPerItemLimit, {
    ...baseAnnotation, id: 'overflow', text: 'x'.repeat(256),
  }], 'MP03-T085-ANNOTATION-TOTAL-LENGTH-01');
  invalidAnnotation(Array.from({ length: 4_097 }, (_, index) => ({
    ...baseAnnotation, id: `count-${index}`,
  })), 'MP03-T085-ANNOTATION-COUNT-01');

  const baseFiller: DiffFillerRow = {
    id: 'gap', documentVersion: snapshot.version, beforeLine: 0 as LineIndex,
  };
  invalidFiller([{ ...baseFiller, id: '' }], 'MP03-T085-FILLER-ID-EMPTY-01');
  invalidFiller([{ ...baseFiller, id: 'f'.repeat(257) }], 'MP03-T085-FILLER-ID-LENGTH-01');
  invalidFiller([baseFiller, { ...baseFiller }], 'MP03-T085-FILLER-ID-DUPLICATE-01');
  invalidFiller([{ ...baseFiller, documentVersion: 99 as never }], 'MP03-T085-FILLER-STALE-01');
  invalidFiller([{ ...baseFiller, beforeLine: 2 as LineIndex }], 'MP03-T085-FILLER-BOUNDS-01');
  invalidFiller(Array.from({ length: 4_097 }, (_, index) => ({ ...baseFiller, id: `filler-${index}` })), 'MP03-T085-FILLER-COUNT-01');
  const maximumFillers = fillerResult(Array.from({ length: 4_096 }, (_, index) => ({
    ...baseFiller, id: index === 0 ? 'f'.repeat(256) : `filler-${index}`,
  })));
  assert.equal(maximumFillers.ok, true, 'MP03-T085-FILLER-BOUNDARY-01 accepts 4,096 distinct frame-scoped rows');

  console.log('MP03-T085 annotation/filler validation passed: ids, uniqueness, bounds, payload lengths and per-frame row limits are enforced.');
}

function checkLocaleIndependentTargetOrdering(): void {
  const annotationDocument = editable('ab');
  const annotationVersion = annotationDocument.snapshot().version;
  const annotations: VirtualAnnotation[] = [
    { id: 'a', documentVersion: annotationVersion, lineIndex: 0 as LineIndex, offset: offset(1), text: 'l' },
    { id: 'A', documentVersion: annotationVersion, lineIndex: 0 as LineIndex, offset: offset(1), text: 'U' },
  ];
  const annotationRows = [annotations, [...annotations].reverse()].map((virtualAnnotations) => {
    const layout = new ViewportLayout();
    const frame = project(layout, annotationDocument, gapSelection(annotationDocument), 8, 1, { virtualAnnotations });
    const first = hit(layout, frame.identity.frameId, 0, 1);
    const second = hit(layout, frame.identity.frameId, 0, 2);
    assert.equal(first.target.kind, 'virtual-annotation');
    assert.equal(second.target.kind, 'virtual-annotation');
    if (first.target.kind === 'virtual-annotation' && second.target.kind === 'virtual-annotation') {
      assert.equal(first.target.annotationId, 'A', 'MP03-T085-TARGET-ORDER-01 annotation ties use UTF-16 code-unit ID order');
      assert.equal(second.target.annotationId, 'a');
    }
    return frame.rows[0]?.text;
  });
  assert.deepEqual(annotationRows, ['aUlb    ', 'aUlb    '], 'MP03-T085-TARGET-ORDER-01 annotation order ignores locale and input order');

  const fillerDocument = editable('a\nb');
  const fillerVersion = fillerDocument.snapshot().version;
  const fillers: DiffFillerRow[] = [
    { id: 'a', documentVersion: fillerVersion, beforeLine: 1 as LineIndex },
    { id: 'A', documentVersion: fillerVersion, beforeLine: 1 as LineIndex },
  ];
  const fillerTargetOrders = [fillers, [...fillers].reverse()].map((diffFillerRows) => {
    const layout = new ViewportLayout();
    const frame = project(layout, fillerDocument, gapSelection(fillerDocument), 4, 4, { diffFillerRows });
    const first = hit(layout, frame.identity.frameId, 1, 0);
    const second = hit(layout, frame.identity.frameId, 2, 0);
    assert.equal(first.target.kind, 'diff-filler');
    assert.equal(second.target.kind, 'diff-filler');
    if (first.target.kind === 'diff-filler' && second.target.kind === 'diff-filler') {
      assert.equal(first.target.fillerId, 'A', 'MP03-T085-TARGET-ORDER-01 filler ties use UTF-16 code-unit ID order');
      assert.equal(second.target.fillerId, 'a');
    }
    return frame.rows.map((row) => row.kind);
  });
  assert.deepEqual(fillerTargetOrders, [
    ['text', 'diff-filler', 'diff-filler', 'text'],
    ['text', 'diff-filler', 'diff-filler', 'text'],
  ], 'MP03-T085-TARGET-ORDER-01 filler order ignores locale and input order');
  console.log('MP03-T085-TARGET-ORDER-01 passed: same-anchor annotations and same-line diff fillers use locale-independent ID ordering.');
}

function checkBoundedDocumentVersionTracking(): void {
  const layout = new ViewportLayout();
  for (let index = 0; index < 12; index += 1) {
    const document = editable(`doc-${index}`, identifier<DocumentId>(`T085-document-${index}`));
    const frame = project(layout, document, gapSelection(document), 8, 1);
    assert.equal(frame.identity.documentId, document.snapshot().id);
  }
  assert.ok(layout.cacheStats.trackedDocumentVersions <= 8, 'MP03-T085-VERSION-TRACKING-BOUND-01 version bookkeeping follows the bounded retained-frame history');
  console.log('MP03-T085-VERSION-TRACKING-BOUND-01 passed: version bookkeeping remains bounded across distinct documents.');
}

function checkPublishedAnchorOwnsFrozenSnapshot(): void {
  const document = editable('first line\nsecond line\nthird line');
  const snapshot = document.snapshot();
  const selection = gapSelection(document);
  const callerAnchor = {
    documentVersion: snapshot.version,
    lineIndex: 1 as LineIndex,
    offset: offset(11),
    displayCellColumn: 2 as CellColumn,
  };
  const layout = new ViewportLayout();
  const frame = project(layout, document, selection, 8, 2, {}, callerAnchor);
  const publishedAnchor = { ...frame.anchor };

  assert.equal(Object.isFrozen(callerAnchor), false, 'MP03-T085-ANCHOR-OWNERSHIP-01 projection does not freeze caller-owned input');
  assert.equal(Object.isFrozen(frame.anchor), true, 'MP03-T085-ANCHOR-OWNERSHIP-01 published frame anchor is frozen');
  assert.notEqual(frame.anchor, callerAnchor, 'MP03-T085-ANCHOR-OWNERSHIP-01 frame owns an anchor value');
  callerAnchor.lineIndex = 0 as LineIndex;
  callerAnchor.offset = offset(0);
  callerAnchor.displayCellColumn = 7 as CellColumn;
  assert.equal(Object.isFrozen(callerAnchor), false, 'MP03-T085-ANCHOR-OWNERSHIP-01 caller object remains mutable after publication');
  assert.deepEqual(frame.anchor, publishedAnchor, 'MP03-T085-ANCHOR-OWNERSHIP-01 later input mutation cannot alter published anchor');
  console.log('MP03-T085-ANCHOR-OWNERSHIP-01 passed: published frame owns an immutable snapshot of the caller anchor.');
}

function checkHorizontalScrollRoundTripsAndVirtualCells(): void {
  const document = editable('0123456789');
  const layout = new ViewportLayout();
  const frame = project(layout, document, gapSelection(document), 4, 1, { wrap: false, horizontalScrollCells: 3 });
  assert.equal(frame.rows[0]?.text, '3456', 'MP03-T085-HORIZONTAL-SCROLL-01 frame begins at the requested logical display cell');
  for (const sourceOffset of [3, 4, 5, 6]) {
    const position = layout.positionForOffset(frame.identity.frameId, offset(sourceOffset));
    assert.equal(position.ok, true, `MP03-T085-HORIZONTAL-SCROLL-01 visible offset ${sourceOffset} projects`);
    if (!position.ok) continue;
    assert.deepEqual(position.value, { row: 0, column: sourceOffset - 3 });
    const projected = hit(layout, frame.identity.frameId, position.value.row, position.value.column);
    assert.equal(projected.target.kind, 'text');
    if (projected.target.kind === 'text') {
      assert.equal(projected.target.offset, sourceOffset);
      assert.equal(projected.target.displayCellColumn, sourceOffset);
    }
  }

  const tabDocument = editable('a\tbc');
  const tabLayout = new ViewportLayout();
  const tabFrame = project(tabLayout, tabDocument, gapSelection(tabDocument), 4, 1, {
    wrap: false, tabSize: 4, horizontalScrollCells: 2,
  });
  assert.equal(tabFrame.rows[0]?.text, '  bc', 'MP03-T085-HORIZONTAL-SCROLL-TAB-01 a partially scrolled tab retains its visible fill cells');
  const firstVisibleTabCell = hit(tabLayout, tabFrame.identity.frameId, 0, 0);
  assert.equal(firstVisibleTabCell.target.kind, 'text');
  if (firstVisibleTabCell.target.kind === 'text') {
    assert.equal(firstVisibleTabCell.target.offset, 1);
    assert.equal(firstVisibleTabCell.target.cellPart, 'tab-fill');
    assert.equal(firstVisibleTabCell.target.virtualCell, 1, 'MP03-T085-HORIZONTAL-SCROLL-TAB-01 virtual cell counts from the tab start across horizontal scroll');
    const projectedTab = tabLayout.positionForOffset(tabFrame.identity.frameId, offset(1));
    assert.deepEqual(projectedTab, { ok: true, value: { row: 0, column: 0 } }, 'MP03-T085-HORIZONTAL-SCROLL-TAB-01 source tab boundary resolves to its first visible cell');
  }
  const followingText = hit(tabLayout, tabFrame.identity.frameId, 0, 2);
  assert.equal(followingText.target.kind, 'text');
  if (followingText.target.kind === 'text') assert.equal(followingText.target.offset, 2, 'MP03-T085-HORIZONTAL-SCROLL-TAB-01 following glyph retains its UTF-16 offset');
  console.log('MP03-T085-HORIZONTAL-SCROLL-01 and MP03-T085-HORIZONTAL-SCROLL-TAB-01 passed.');
}

function checkFoldGeometryKeyCollisionDoesNotReuseRows(): void {
  const document = editable('zero\none\ntwo\nthree\nfour\nfive\nsix\nseven');
  const snapshot = document.snapshot();
  const selection = gapSelection(document);
  const layout = new ViewportLayout();
  const firstFrame = project(layout, document, selection, 12, 8, {
    foldGeneration: 4,
    folds: [{ id: 'x:1', documentVersion: snapshot.version, startLine: 3 as LineIndex, endLineExclusive: 5 as LineIndex }],
  });
  const firstFoldRow = firstFrame.rows.findIndex((row) => row.kind === 'fold');
  assert.equal(firstFoldRow, 3, 'MP03-T085-FOLD-GEOMETRY-COLLISION-01 first fold occupies its source row');
  const firstFoldTarget = firstFrame.rows[firstFoldRow]?.cells[0]?.target;
  assert.equal(firstFoldTarget?.kind, 'fold');
  if (firstFoldTarget?.kind === 'fold') assert.equal(firstFoldTarget.foldId, 'x:1');

  const secondFrame = project(layout, document, selection, 12, 8, {
    foldGeneration: 4,
    folds: [{
      id: 'x', documentVersion: snapshot.version, startLine: 1 as LineIndex,
      endLineExclusive: 3 as LineIndex, placeholder: '5:',
    }],
  });
  const secondFoldRow = secondFrame.rows.findIndex((row) => row.kind === 'fold');
  assert.equal(secondFoldRow, 1, 'MP03-T085-FOLD-GEOMETRY-COLLISION-01 changed fold geometry publishes the new row');
  assert.equal(secondFrame.rows[1]?.text.startsWith('5:'), true, 'MP03-T085-FOLD-GEOMETRY-COLLISION-01 new placeholder replaces prior fold content');
  assert.equal(secondFrame.rows[2]?.lineIndex, 3, 'MP03-T085-FOLD-GEOMETRY-COLLISION-01 rows after the fold follow its new end line');
  assert.notEqual(secondFrame.identity.layoutGeneration, firstFrame.identity.layoutGeneration, 'MP03-T085-FOLD-GEOMETRY-COLLISION-01 distinct geometry has a distinct generation');

  const secondHit = layout.hitTest(secondFrame.identity.frameId, { row: 1, column: 0 });
  assert.equal(secondHit.ok, true, 'MP03-T085-FOLD-GEOMETRY-COLLISION-01 current fold row resolves from the current hit map');
  if (secondHit.ok) {
    assert.equal(secondHit.value.identity.frameId, secondFrame.identity.frameId);
    assert.equal(secondHit.value.target.kind, 'fold');
    if (secondHit.value.target.kind === 'fold') {
      assert.equal(secondHit.value.target.foldId, 'x');
      assert.equal(secondHit.value.target.startLine, 1);
      assert.equal(secondHit.value.target.endLineExclusive, 3);
    }
  }
  const staleFirstHit = layout.hitTest(firstFrame.identity.frameId, { row: 3, column: 0 });
  assert.equal(staleFirstHit.ok, false, 'MP03-T085-FOLD-GEOMETRY-COLLISION-01 prior frame cannot return the old fold target');
  if (!staleFirstHit.ok) assert.equal(staleFirstHit.error.kind, 'stale-frame');
  console.log('MP03-T085-FOLD-GEOMETRY-COLLISION-01 passed: the second fold uses only its own row geometry and target identity.');
}

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'fixture-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function offset(value: number): Utf16Offset { return value as Utf16Offset; }

checkMP03TextAndEmptyEofRoundTrips();
checkStaleFrameAndVersionCancellation();
checkTypedGutterFoldAnnotationAndDiffTargets();
checkBoundedAnnotationAndFillerInputs();
checkLocaleIndependentTargetOrdering();
checkBoundedDocumentVersionTracking();
checkPublishedAnchorOwnsFrozenSnapshot();
checkHorizontalScrollRoundTripsAndVirtualCells();
checkFoldGeometryKeyCollisionDoesNotReuseRows();
