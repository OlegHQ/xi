// D2 regression: `a"` in packages/vim/text-objects/index.ts must only grab whitespace
// within the same line, never crossing the newline into the next line's indent.
// Oracle: `.artifacts/oracle/nvim-linux-arm64/bin/nvim --headless --clean -u NONE
//   -c 'normal 0da"'` on 'say "hi"\n  next' -> 'say\n  next' (removes the trailing
// space before the quote via the backward fallback, since there is no forward
// whitespace on the same line to grab -- the newline and next line's indent are untouched).
import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentSnapshot } from '../../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type Utf16Offset } from '../../../packages/primitives/src/index';
import { resolveVimTextObject } from '../../../packages/vim/text-objects/index';

function offset(value: number): Utf16Offset {
  const parsed = asUtf16Offset(value);
  assert.ok(parsed.ok);
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.value;
}

function snapshotOf(text: string): DocumentSnapshot {
  const id = asIdentifier<DocumentId>('d2-quote-line-whitespace', 'documentId');
  assert.ok(id.ok);
  if (!id.ok) throw new Error('unreachable');
  const opened = openTextDocument(id.value, new TextEncoder().encode(text));
  assert.equal(opened.kind, 'editable');
  if (opened.kind !== 'editable') throw new Error('unreachable');
  return opened.document.snapshot();
}

const text = 'say "hi"\n  next';
const snapshot = snapshotOf(text);
const cursor = { documentVersion: snapshot.version, offset: offset(0) };
const result = resolveVimTextObject(snapshot, cursor, { key: 'a"' });
assert.equal(result.ok, true, `D2-01 a" resolves: ${JSON.stringify(!result.ok && result.error)}`);
if (!result.ok) throw new Error('unreachable');
const { start, end } = result.value;
const removed = text.slice(start as number, end as number);
const remaining = text.slice(0, start as number) + text.slice(end as number);
assert.equal(removed, ' "hi"', 'D2-02 a" grabs the leading space (backward fallback), not the newline+indent');
assert.equal(remaining, 'say\n  next', 'D2-03 deleting a" leaves the next line\'s indent untouched');

console.log('d2-quote-line-whitespace: all assertions passed');
