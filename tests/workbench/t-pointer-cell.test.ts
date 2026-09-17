import { strict as assert } from 'node:assert';
import { TextFileDocument } from '../../packages/document/src/index';
import { asIdentifier, type DocumentId } from '../../packages/primitives/src/index';
import { pointerTargetAt, pointerWordAt } from '../../packages/workbench/vim-session/pointer';
import { pointerDisplayColumn } from '../../packages/vim/src/index';

function documentId(value: string): DocumentId {
  const result = asIdentifier<DocumentId>(value, 'T-POINTER-CELL-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(value: string): TextFileDocument {
  const lineCount = value.split('\n').length - 1;
  const result = TextFileDocument.create(documentId('t-pointer-cell'), value, Array.from({ length: lineCount }, () => 'lf' as const), 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

// T-POINTER-CELL-01: tab stops follow the caller-supplied tabSize (Vim's buffer-local
// `tabstop`), not a hardcoded 8 -- pointerDisplayColumn now delegates the expansion formula
// to the same shape as `packages/layout/src/shaping.ts`'s own tab arithmetic instead of a
// second, pointer-only constant.
{
  const doc = document('\tx\n');
  const snapshot = doc.snapshot();
  const withTab4 = pointerTargetAt(snapshot, 1, 4);
  assert.equal(withTab4?.displayCellColumn, 4, 'T-POINTER-CELL-01 tabSize=4 expands one leading tab to column 4');
  const withTab8 = pointerTargetAt(snapshot, 1, 8);
  assert.equal(withTab8?.displayCellColumn, 8, 'T-POINTER-CELL-01 tabSize=8 (default) expands one leading tab to column 8');
}

// T-POINTER-CELL-02: a wide (CJK) glyph occupies two display cells, using the shared
// `defaultCellWidthPolicy` grapheme-width table instead of pointer.ts's own duplicate
// range check.
{
  const doc = document('中x\n'); // U+4E2D CJK ideograph, then 'x'
  const snapshot = doc.snapshot();
  const afterWideGlyph = pointerTargetAt(snapshot, 1, 4);
  assert.equal(afterWideGlyph?.displayCellColumn, 2, 'T-POINTER-CELL-02 one wide CJK glyph occupies two display cells');
}

// T-POINTER-CELL-03: word-bounds scanning now runs through Vim's owned `tokenBoundsAt`
// (packages/vim/motions/token-scan.ts) instead of a hand-rolled expand-loop; behavior for
// an ordinary ASCII word is unchanged.
{
  const doc = document('foo bar\n');
  const snapshot = doc.snapshot();
  const bounds = pointerWordAt(snapshot, 5); // inside "bar"
  assert.deepEqual(bounds, { start: 4, end: 7 }, 'T-POINTER-CELL-03 clicking inside "bar" selects the whole word');
}

console.log('T-POINTER-CELL pointer cell/word helpers passed tabSize, wide-glyph and word-bounds fixtures');
