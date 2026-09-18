#!/usr/bin/env bun
// C6 regression tests (packages/vim/motions/viewport.ts): M/L must clamp to
// the buffer's actual visible text rows (not filler rows past EOF), and
// `{count}zt/zz/zb` must move the cursor to line [count] before repositioning
// the viewport (currently the count was silently ignored).
// Vim semantics: :help L ("less lines than window height -> last line"),
// :help M ("middle of the shown text" when the last line is above the
// middle), :help zt ("line [count] at top of window").
import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentSnapshot } from '../../../packages/document/src/index';
import { asIdentifier, type DocumentId, type ViewId } from '../../../packages/primitives/src/index';
import { resolveVimViewportMotion, type VimViewportCursor } from '../../../packages/vim/motions/viewport';
import type { ScreenCell, ScreenRow, VisibleFrame } from '../../../packages/layout/src/index';

function open(source: string, id: string): DocumentSnapshot {
  const documentId = asIdentifier<DocumentId>(id, 'documentId');
  assert.equal(documentId.ok, true);
  if (!documentId.ok) throw new Error('invalid document id');
  const result = openTextDocument(documentId.value, new TextEncoder().encode(source));
  assert.equal(result.kind, 'editable');
  if (result.kind !== 'editable') throw new Error('document is not editable');
  return result.document.snapshot();
}

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'id');
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('invalid id');
  return result.value;
}

function textRow(snapshot: DocumentSnapshot, lineIndex: number, text: string): ScreenRow {
  const start = snapshot.lineStartOffset(lineIndex as never);
  assert.equal(start.ok, true);
  if (!start.ok) throw new Error('line start unavailable');
  const startOffset = start.value;
  const endOffset = ((start.value as number) + text.length) as never;
  return {
    kind: 'text',
    lineIndex: lineIndex as never,
    wrapIndex: 0,
    displayStartCell: 0,
    displayEndCell: text.length,
    startOffset,
    endOffset,
    text,
    contentKey: null,
    cells: [...text].map((character, column): ScreenCell => ({
      text: character,
      role: 'glyph',
      target: {
        kind: 'text',
        lineIndex: lineIndex as never,
        offset: ((startOffset as number) + column) as never,
        affinity: 'left',
        virtualCell: 0,
        displayCellColumn: column as never,
        cellPart: 'glyph',
      },
    })),
  };
}

function fillerRow(width: number): ScreenRow {
  const cells: ScreenCell[] = Array.from({ length: width }, () => ({ text: ' ', role: 'filler', target: null }));
  return { kind: 'filler', lineIndex: null, wrapIndex: 0, displayStartCell: 0, displayEndCell: 0,
    startOffset: null, endOffset: null, cells, text: ' '.repeat(width), contentKey: `filler:${width}` };
}

function frame(snapshot: DocumentSnapshot, lines: readonly string[], height: number, anchorLine: number): VisibleFrame {
  const rows: ScreenRow[] = lines.map((text, index) => textRow(snapshot, index, text));
  while (rows.length < height) rows.push(fillerRow(20));
  const anchorStart = snapshot.lineStartOffset(anchorLine as never);
  assert.equal(anchorStart.ok, true);
  if (!anchorStart.ok) throw new Error('anchor line unavailable');
  return {
    identity: {
      frameId: 1 as never,
      viewId: identifier<ViewId>('C6-view'),
      documentId: snapshot.id,
      documentVersion: snapshot.version,
      selectionGeneration: 1 as never,
      layoutGeneration: 1 as never,
    },
    widthCells: 20,
    heightCells: height,
    anchor: { documentVersion: snapshot.version, lineIndex: anchorLine as never, offset: anchorStart.value, displayCellColumn: 0 as never },
    rows,
    selections: [],
    truncatedLongLine: false,
  };
}

// --- L/M must clamp to the last real text row when the buffer is shorter
// than the window, instead of failing on a filler row past EOF. ---
{
  const doc = open('l1\nl2\nl3', 'C6-short-buffer');
  const testFrame = frame(doc, ['l1', 'l2', 'l3'], 8, 0);
  const state: VimViewportCursor = { cursor: { documentVersion: doc.version, offset: 0 as never, desiredDisplayCellColumn: 0 as never }, desiredScreenCellColumn: 0 as never };

  const l = resolveVimViewportMotion(doc, testFrame, state, { key: 'L' });
  assert.equal(l.ok, true, 'C6-01 L on a buffer shorter than the window does not fail with destination-not-visible');
  if (l.ok) {
    const line = doc.lineIndexAt(l.value.cursor.offset);
    if (line.ok) assert.equal(line.value as number, 2, 'C6-02 L lands on the last real line (index 2), not a filler row');
  }

  const m = resolveVimViewportMotion(doc, testFrame, state, { key: 'M' });
  assert.equal(m.ok, true, 'C6-03 M on a buffer shorter than the window does not fail');
  if (m.ok) {
    const line = doc.lineIndexAt(m.value.cursor.offset);
    if (line.ok) assert.equal(line.value as number, 1, 'C6-04 M lands on the middle of the actual text rows (index 1), not the window middle');
  }
}

// --- `{count}zt` must move the cursor to line [count] first, then place it
// at the top of the window; the count was previously ignored entirely. ---
{
  const doc = open('l1\nl2\nl3\nl4\nl5', 'C6-count-zt');
  const testFrame = frame(doc, ['l1', 'l2', 'l3'], 3, 0);
  const state: VimViewportCursor = { cursor: { documentVersion: doc.version, offset: 0 as never, desiredDisplayCellColumn: 0 as never }, desiredScreenCellColumn: 0 as never };

  const zt = resolveVimViewportMotion(doc, testFrame, state, { key: 'zt', count: 4 });
  assert.equal(zt.ok, true, 'C6-05 4zt resolves');
  if (zt.ok) {
    const line = doc.lineIndexAt(zt.value.cursor.offset);
    if (line.ok) assert.equal(line.value as number, 3, 'C6-06 4zt moves the cursor to line index 3 (line 4), not just scrolling in place');
    assert.equal(zt.value.viewportAnchor.lineIndex as number, 3, 'C6-07 4zt places line 4 at the top of the window');
  }
}

console.log('C6 viewport tests passed');
