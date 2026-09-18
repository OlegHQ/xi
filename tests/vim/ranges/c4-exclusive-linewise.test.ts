#!/usr/bin/env bun
// C4 regression test (packages/vim/ranges/normalize.ts): the exclusive-linewise
// backoff only implemented ":help exclusive-linewise" rule 1 (end column-0
// backoff); rule 2 (start at/before first non-blank -> whole motion becomes
// linewise) was missing.
// nvim: :call setline(1,['foo','','bar']) | normal! d} -> deletes "foo" (linewise, message "1 fewer line"), leaves ['', 'bar']
import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentSnapshot } from '../../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId } from '../../../packages/primitives/src/index';
import { normalizeVimOperatorRange, type VimOperatorRangeInput } from '../../../packages/vim/src/index';

function offset(value: number) {
  const result = asUtf16Offset(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('invalid offset');
  return result.value;
}
function open(source: string, id: string): DocumentSnapshot {
  const documentId = asIdentifier<DocumentId>(id, 'documentId');
  assert.equal(documentId.ok, true);
  if (!documentId.ok) throw new Error('invalid document id');
  const result = openTextDocument(documentId.value, new TextEncoder().encode(source));
  assert.equal(result.kind, 'editable');
  if (result.kind !== 'editable') throw new Error('document is not editable');
  return result.document.snapshot();
}

// "foo\n\nbar": d} from col0 of "foo" targets col0 of the blank line (offset 4, exclusive).
{
  const doc = open('foo\n\nbar', 'C4-rule2-linewise');
  const input: VimOperatorRangeInput = {
    origin: { documentVersion: doc.version, offset: offset(0) },
    target: { documentVersion: doc.version, offset: offset(4) },
    direction: 'forward',
    motionKind: 'characterwise',
    inclusive: false,
    motionKey: '}',
    operator: 'delete',
  };
  const result = normalizeVimOperatorRange(doc, input);
  assert.equal(result.ok, true, 'C4-01 d} range normalizes');
  if (result.ok) {
    assert.equal(result.value.kind, 'linewise', 'C4-02 start at first non-blank promotes the range to linewise');
    assert.deepEqual(result.value.registerLines, ['foo'], 'C4-03 only the "foo" line is captured, not the blank line');
  }
}

// Same shape but the start is mid-word (not at/before first non-blank): stays charwise.
// nvim: :call setline(1,['foo','','bar']) | normal! lld} -> deletes "o" only (charwise, stays on line 1)
{
  const doc = open('foo\n\nbar', 'C4-midword-stays-charwise');
  const input: VimOperatorRangeInput = {
    origin: { documentVersion: doc.version, offset: offset(2) },
    target: { documentVersion: doc.version, offset: offset(4) },
    direction: 'forward',
    motionKind: 'characterwise',
    inclusive: false,
    motionKey: '}',
    operator: 'delete',
  };
  const result = normalizeVimOperatorRange(doc, input);
  assert.equal(result.ok, true, 'C4-04 mid-word d} range normalizes');
  if (result.ok) {
    assert.equal(result.value.kind, 'characterwise', 'C4-05 a start not at/before first non-blank stays charwise');
    assert.deepEqual(result.value.registerLines, ['o'], 'C4-06 only the trailing "o" of "foo" is captured');
  }
}

console.log('C4 exclusive-linewise tests passed');
