#!/usr/bin/env bun
// C1/C2 regression tests (packages/vim/motions/structural.ts, motions/index.ts,
// motions/word.ts). Neovim oracle:
// .artifacts/oracle/nvim-linux-arm64/bin/nvim --headless --clean -u NONE
import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentSnapshot } from '../../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type Utf16Offset } from '../../../packages/primitives/src/index';
import {
  createVimMotionCursor,
  resolveVimMotion,
  resolveVimStructuralMotion,
  resolveVimWordMotion,
  type VimStructuralMotionCursor,
} from '../../../packages/vim/src/index';

function open(source: string, id: string): DocumentSnapshot {
  const documentId = asIdentifier<DocumentId>(id, 'documentId');
  assert.equal(documentId.ok, true);
  if (!documentId.ok) throw new Error('invalid document id');
  const result = openTextDocument(documentId.value, new TextEncoder().encode(source));
  assert.equal(result.kind, 'editable');
  if (result.kind !== 'editable') throw new Error('document is not editable');
  return result.document.snapshot();
}
function offset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('invalid offset');
  return result.value;
}

// --- C1: `}` with no further boundary must clamp to the last grapheme's
// start, not one past it (an unreadable "phantom" cursor). ---
// nvim: :call setline(1,['aaa','bbb']) | normal! } -> cursor at (2,3) i.e. offset 6 (0-idx), not 7
{
  const doc = open('aaa\nbbb', 'C1-paragraph-clamp');
  const cursor: VimStructuralMotionCursor = { documentVersion: doc.version, offset: offset(0), desiredDisplayCellColumn: null };
  const result = resolveVimStructuralMotion(doc, cursor, { key: '}' });
  assert.equal(result.ok, true, 'C1-01 } resolves');
  if (result.ok) {
    assert.equal(result.value.cursor.offset as number, 6, 'C1-02 } clamps to the start of the last grapheme ("b" at offset 6), not offset 7');
    // The clamped cursor must remain valid: a follow-up motion must not fail.
    const followUp = resolveVimMotion(doc, { documentVersion: doc.version, offset: result.value.cursor.offset, desiredDisplayCellColumn: null }, { key: 'h' });
    assert.equal(followUp.ok, true, 'C1-03 a motion from the clamped cursor does not fail with invalid-cursor');
  }
}

// --- C2: `snapshot.lineCount` includes the document model's phantom empty
// line after a trailing final newline; Vim does not count it as a line. ---
// nvim: :call setline(1,['abc','defgh']) | write! ; nvim --headless -c ':$' -c 'echo line(".")' -> 2
{
  const doc = open('abc\ndefgh\n', 'C2-G-final-newline');
  assert.equal(doc.lineCount, 3, 'C2-00 the document model reports the phantom trailing line (sanity)');
  const cursor = createVimMotionCursor(doc, offset(0));
  assert.equal(cursor.ok, true);
  if (cursor.ok) {
    const result = resolveVimMotion(doc, cursor.value, { key: 'G' });
    assert.equal(result.ok, true, 'C2-01 G resolves');
    if (result.ok) {
      const line = doc.lineIndexAt(result.value.cursor.offset);
      assert.equal(line.ok, true);
      if (line.ok) assert.equal(line.value as number, 1, 'C2-02 G lands on the last real line (index 1, "defgh"), not the phantom line 2');
    }
  }
}

// j at the last real line must not descend into the phantom trailing line.
// nvim: :call setline(1,['abc','defgh']) | write! ; normal! Gj -> stays on line 2
{
  const doc = open('abc\ndefgh\n', 'C2-j-no-overrun');
  const lineStart = doc.lineStartOffset(1 as never);
  assert.equal(lineStart.ok, true);
  if (lineStart.ok) {
    const cursor = createVimMotionCursor(doc, lineStart.value);
    assert.equal(cursor.ok, true);
    if (cursor.ok) {
      const result = resolveVimMotion(doc, cursor.value, { key: 'j' });
      assert.equal(result.ok, true, 'C2-03 j resolves');
      if (result.ok) {
        assert.equal(result.value.moved, false, 'C2-04 j from the last real line does not move into the phantom line');
        const line = doc.lineIndexAt(result.value.cursor.offset);
        if (line.ok) assert.equal(line.value as number, 1, 'C2-05 cursor stays on line index 1');
      }
    }
  }
}

// `w` at the last word of the buffer must not step into the phantom line either.
// nvim: :call setline(1,['abc','defgh']) | write! ; normal! Gw -> stays put (last word already)
{
  const doc = open('abc\ndefgh\n', 'C2-word-no-overrun');
  const lineStart = doc.lineStartOffset(1 as never);
  assert.equal(lineStart.ok, true);
  if (lineStart.ok) {
    const cursor = { documentVersion: doc.version, offset: lineStart.value, desiredDisplayCellColumn: null };
    const result = resolveVimWordMotion(doc, cursor, { key: 'w' });
    assert.equal(result.ok, true, 'C2-06 w resolves');
    if (result.ok) {
      const line = doc.lineIndexAt(result.value.cursor.offset);
      if (line.ok) assert.equal(line.value as number, 1, 'C2-07 w does not step onto the phantom trailing line');
    }
  }
}

console.log('C1/C2 tests passed');
