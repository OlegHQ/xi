// D7 regression in packages/vim/text-objects/index.ts:
//   1. `{count}iw` must count N consecutive class-runs (word/punct/space) forward from
//      the cursor's own run, not assume word/whitespace alternation.
//   2. `i{`/`i(`/... interior that spans whole lines must be promoted to 'linewise'.
//
// Oracle (`.artifacts/oracle/nvim-linux-arm64/bin/nvim --headless --clean -u NONE`):
//   `normal 0d{N}iw` on "a.b c" for N=1..5 deletes "a", "a.", "a.b", "a.b ", "a.b c".
//   `normal jyi{` on "if (x) {\n  foo\n  bar\n}\n" -> getregtype('"') === 'V'.
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

let documentCounter = 0;
function snapshotOf(text: string): DocumentSnapshot {
  documentCounter += 1;
  const id = asIdentifier<DocumentId>(`d7-count-linewise-${documentCounter}`, 'documentId');
  assert.ok(id.ok);
  if (!id.ok) throw new Error('unreachable');
  const opened = openTextDocument(id.value, new TextEncoder().encode(text));
  assert.equal(opened.kind, 'editable');
  if (opened.kind !== 'editable') throw new Error('unreachable');
  return opened.document.snapshot();
}

const iwFixture = 'a.b c';
const expectedByCount: Record<number, string> = { 1: 'a', 2: 'a.', 3: 'a.b', 4: 'a.b ', 5: 'a.b c' };
for (const [countText, expected] of Object.entries(expectedByCount)) {
  const count = Number(countText);
  const snapshot = snapshotOf(iwFixture);
  const cursor = { documentVersion: snapshot.version, offset: offset(0) };
  const result = resolveVimTextObject(snapshot, cursor, { key: 'iw', count });
  assert.equal(result.ok, true, `D7-IW-${count} resolves: ${JSON.stringify(!result.ok && result.error)}`);
  if (!result.ok) throw new Error('unreachable');
  const slice = iwFixture.slice(result.value.start as number, result.value.end as number);
  assert.equal(slice, expected, `D7-IW-${count} ${count}iw on "${iwFixture}" selects "${expected}"`);
}

const braceFixture = 'if (x) {\n  foo\n  bar\n}\n';
{
  const snapshot = snapshotOf(braceFixture);
  const fooOffset = braceFixture.indexOf('foo');
  const cursor = { documentVersion: snapshot.version, offset: offset(fooOffset) };
  const result = resolveVimTextObject(snapshot, cursor, { key: 'i{' });
  assert.equal(result.ok, true, `D7-BRACE-01 i{ resolves: ${JSON.stringify(!result.ok && result.error)}`);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.value.kind, 'linewise', 'D7-BRACE-02 a full-line brace interior is promoted to linewise');
  assert.equal(braceFixture.slice(result.value.start as number, result.value.end as number), '  foo\n  bar\n',
    'D7-BRACE-03 the linewise interior spans the two inner lines');
}

console.log('d7-count-and-linewise: all assertions passed');
