#!/usr/bin/env bun
// D1 regression: J/gJ whitespace handling in packages/vim/operators/text-transform.ts.
// Oracle: `.artifacts/oracle/nvim-linux-arm64/bin/nvim --headless --clean -u NONE`
//   J:  "foo   " + "bar"  -> "foo   bar"   (keeps left's trailing whitespace, no extra space)
//   J:  "foo"    + ")bar" -> "foo)bar"     (no space before a right line starting with ')')
//   J:  "foo"    + ""     -> "foo"         (no trailing space when the right line is blank)
//   gJ: "foo"    + "  bar"-> "foo  bar"    (gJ never strips the right line's leading blanks)
import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentSnapshot } from '../../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId } from '../../../packages/primitives/src/index';
import { normalizeVimOperatorRange, prepareVimTextTransform, type VimNormalizedOperatorRange } from '../../../packages/vim/src/index';

function offset(value: number) {
  const result = asUtf16Offset(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('invalid offset');
  return result.value;
}
function open(text: string, id: string): DocumentSnapshot {
  const documentId = asIdentifier<DocumentId>(id, 'documentId');
  assert.equal(documentId.ok, true);
  if (!documentId.ok) throw new Error('invalid id');
  const result = openTextDocument(documentId.value, new TextEncoder().encode(text));
  assert.equal(result.kind, 'editable');
  if (result.kind !== 'editable') throw new Error('read-only fixture');
  return result.document.snapshot();
}
function lineStart(snapshot: DocumentSnapshot, line: number) {
  const result = snapshot.lineStartOffset(line as never);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('bad line');
  return result.value as number;
}
function endpoint(snapshot: DocumentSnapshot, at: number) {
  return { documentVersion: snapshot.version, offset: offset(at) };
}
function lineRangeFor(snapshot: DocumentSnapshot, first: number, last: number): VimNormalizedOperatorRange {
  const result = normalizeVimOperatorRange(snapshot, {
    origin: endpoint(snapshot, lineStart(snapshot, first)), target: endpoint(snapshot, lineStart(snapshot, last)),
    direction: 'forward', motionKind: 'linewise', inclusive: true, motionKey: 'j', operator: 'delete', forceKind: 'linewise',
  });
  assert.equal(result.ok, true, `range failed: ${JSON.stringify(!result.ok && result.error)}`);
  if (!result.ok) throw new Error('range failed');
  return result.value;
}
function applyEdits(text: string, edits: readonly { start: number; end: number; text: string }[]): string {
  let result = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}
function joined(source: string, operator: 'J' | 'gJ'): string {
  const snapshot = open(source, `D1-${operator}-${source}`);
  const range = lineRangeFor(snapshot, 0, 1);
  const result = prepareVimTextTransform({ snapshot, range, operator });
  assert.equal(result.ok, true, `prepare failed: ${JSON.stringify(!result.ok && result.error)}`);
  if (!result.ok) throw new Error('unreachable');
  return applyEdits(source, (result.value.transaction?.edits ?? []) as never);
}

assert.equal(joined('foo   \nbar', 'J'), 'foo   bar', 'D1-01 J keeps left trailing whitespace, no extra separator');
assert.equal(joined('foo\n)bar', 'J'), 'foo)bar', 'D1-02 J inserts no space before a right line starting with )');
assert.equal(joined('foo\n\nbaz', 'J'), 'foo\nbaz', 'D1-03 J adds no trailing space when the right line is blank');
assert.equal(joined('foo\n  bar', 'gJ'), 'foo  bar', "D1-04 gJ never strips the right line's leading blanks");

console.log('d1-join-spacing: all assertions passed');
