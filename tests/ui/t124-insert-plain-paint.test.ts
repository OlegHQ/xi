import { strict as assert } from 'node:assert';
import { canPaintPlainFrame } from '../../packages/ui/editor/motion-paint';
import type { VisibleFrame } from '../../packages/layout/src/index';

/**
 * Regression for the insert-mode paint fast path: `canPaintPlainFrame` used to reject
 * every frame containing an `insert-caret` selection, forcing the per-cell
 * fillRect+setCell masked path (with an always-empty mask map) for ordinary typing.
 * Only a visual-* selection ever populates that mask map (see `markSelectionCells`),
 * so `insert-caret` -- like `normal-cursor` -- is safe on the cheap run-based path;
 * the caret glyph itself is still drawn afterward by `paintPlainFrame`.
 */
function makeFrame(selectionKind: 'normal-cursor' | 'insert-caret' | 'visual-character'): VisibleFrame {
  const row = {
    kind: 'text',
    lineIndex: 0,
    wrapIndex: 0,
    displayStartCell: 0,
    displayEndCell: 1,
    startOffset: 0,
    endOffset: 1,
    text: 'a',
    cells: [{ text: 'a', role: 'glyph', target: null }],
    contentKey: null,
  };
  return {
    identity: { frameId: 1, viewId: 'T124-view', documentId: 'T124-doc', documentVersion: 1, selectionGeneration: 1, layoutGeneration: 1 },
    widthCells: 1,
    heightCells: 1,
    anchor: { documentVersion: 1, lineIndex: 0, offset: 0, displayCellColumn: 0 },
    rows: [row],
    selections: [{
      id: 'T124-selection',
      kind: selectionKind,
      primary: true,
      direction: 'forward',
      desiredColumn: undefined,
      anchor: { position: { row: 0, column: 0 } },
      head: { position: { row: 0, column: 0 } },
    }],
    truncatedLongLine: false,
  } as unknown as VisibleFrame;
}

assert.equal(canPaintPlainFrame(makeFrame('normal-cursor'), undefined), true, 'T124-PLAIN-01 a normal-mode block cursor keeps taking the plain path');
assert.equal(canPaintPlainFrame(makeFrame('insert-caret'), undefined), true, 'T124-PLAIN-02 an insert-mode caret with no masks now takes the plain path too');
assert.equal(canPaintPlainFrame(makeFrame('visual-character'), undefined), false, 'T124-PLAIN-03 a visual selection (which does populate masks) still rejects the plain path');

console.log('T124 insert-mode plain paint passed: insert-caret frames with no masks use the cheap run-based path.');
