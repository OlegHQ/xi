#!/usr/bin/env bun
// D9 regression: `>>`/`<<` in packages/vim/operators/text-transform.ts must compute
// indentation in display cells, not naively append/strip raw indent characters.
//
// Oracle: `.artifacts/oracle/nvim-linux-arm64/bin/nvim --headless --clean -u NONE -c
// 'set shiftwidth=4 tabstop=8 noexpandtab' -c 'normal <<'` on "\tfoo" -> "    foo"
// (only 4 of the tab's 8 display cells are removed; the rest survive as spaces).
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
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

const source = '\tfoo';
const snapshot = open(source, 'D9-shift-in');
const range = lineRangeFor(snapshot, 0, 0);
const result = prepareVimTextTransform({
  snapshot, range, operator: '<', options: { shiftwidth: 4, tabstop: 8, expandtab: false },
});
assert.equal(result.ok, true, `D9-01 << prepares: ${JSON.stringify(!result.ok && result.error)}`);
if (!result.ok) throw new Error('unreachable');
assert.equal(applyEdits(source, (result.value.transaction?.edits ?? []) as never), '    foo',
  'D9-02 << removes exactly 4 display cells (4 spaces survive), not the whole 8-cell tab');

console.log('d9-indent-cells: all assertions passed');
