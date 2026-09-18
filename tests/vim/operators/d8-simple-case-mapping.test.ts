#!/usr/bin/env bun
// D8 regression: `~` (direct-changes.ts) and `gU`/`gu`/`g~` (text-transform.ts) must use
// Vim's simple (single-code-point) case mapping, not JS's default full case mapping,
// which expands "ß" to "SS" and would desync per-code-point offsets in the transformed
// range.
//
// Oracle: `.artifacts/oracle/nvim-linux-arm64/bin/nvim --headless --clean -u NONE`
//   `-c 'normal gUU'` and `-c 'normal g~~'` on "straße" both give "STRAẞE" (ß -> U+1E9E,
//   a single code point), never "SS".
import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentSnapshot } from '../../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId } from '../../../packages/primitives/src/index';
import {
  normalizeVimOperatorRange,
  prepareVimDirectChange,
  prepareVimTextTransform,
  type VimNormalizedOperatorRange,
} from '../../../packages/vim/src/index';

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
function endpoint(snapshot: DocumentSnapshot, at: number) {
  return { documentVersion: snapshot.version, offset: offset(at) };
}
function fullLineRange(snapshot: DocumentSnapshot): VimNormalizedOperatorRange {
  const result = normalizeVimOperatorRange(snapshot, {
    origin: endpoint(snapshot, 0), target: endpoint(snapshot, snapshot.lengthUtf16 as unknown as number - 1),
    direction: 'forward', motionKind: 'characterwise', inclusive: true, motionKey: '$', operator: 'delete', forceKind: 'characterwise',
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

const source = 'straße'; // "straße"

const gU = open(source, 'D8-gU');
const gUResult = prepareVimTextTransform({ snapshot: gU, range: fullLineRange(gU), operator: 'gU' });
assert.equal(gUResult.ok, true, `D8-01 gU prepares: ${JSON.stringify(!gUResult.ok && gUResult.error)}`);
if (!gUResult.ok) throw new Error('unreachable');
assert.equal(applyEdits(source, (gUResult.value.transaction?.edits ?? []) as never), 'STRAẞE',
  'D8-02 gU maps ß to U+1E9E, not "SS"');

const gTilde = open(source, 'D8-gTilde');
const gTildeResult = prepareVimTextTransform({ snapshot: gTilde, range: fullLineRange(gTilde), operator: 'g~' });
assert.equal(gTildeResult.ok, true, `D8-03 g~ prepares: ${JSON.stringify(!gTildeResult.ok && gTildeResult.error)}`);
if (!gTildeResult.ok) throw new Error('unreachable');
assert.equal(applyEdits(source, (gTildeResult.value.transaction?.edits ?? []) as never), 'STRAẞE',
  'D8-04 g~ maps ß to U+1E9E, not "SS"');

// `~` (direct-changes.ts) toggles a single character under the cursor.
const tilde = open(source, 'D8-tilde');
const ssOffset = source.indexOf('ß');
const tildeResult = prepareVimDirectChange({
  snapshot: tilde,
  key: '~',
  cursorOffset: offset(ssOffset),
  count: 1,
  state: { mode: 'normal', repeatTarget: null },
});
assert.equal(tildeResult.ok, true, `D8-05 ~ prepares: ${JSON.stringify(!tildeResult.ok && tildeResult.error)}`);
if (!tildeResult.ok) throw new Error('unreachable');
assert.equal(applyEdits(source, (tildeResult.value.transaction?.edits ?? []) as never), 'straẞe',
  'D8-06 ~ on ß produces U+1E9E, not "SS"');

console.log('d8-simple-case-mapping: all assertions passed');
