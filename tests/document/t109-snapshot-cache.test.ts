import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type Utf16Offset } from '../../packages/primitives/src/index';
import { beginVimInsert, planVimInsertInput } from '../../packages/vim/insert/index';
import { offsetToPosition, openTextDocument, positionToOffset, type DocumentSnapshot } from '../../packages/document/src/index';

const idResult = asIdentifier<DocumentId>('T109-snapshot-cache', 'documentId');
const documentId: DocumentId = idResult.ok
  ? idResult.value
  : (() => { throw new Error(idResult.error.message); })();

function checkStableCurrentSnapshot(): void {
  const opened = openTextDocument(documentId, new TextEncoder().encode(('row\n').repeat(600)));
  assert.equal(opened.kind, 'editable');
  if (opened.kind !== 'editable') throw new Error('expected-editable-document');
  const document = opened.document;
  const first = document.snapshot();
  assert.strictEqual(document.snapshot(), first);
  assert.strictEqual(document.snapshot(), first);

  const position = offsetToPosition(first, 1200 as Utf16Offset, 'utf-16');
  assert.equal(position.ok, true);
  if (position.ok) assert.equal(positionToOffset(first, position.value).ok, true);

  const edit = document.apply({ start: 0 as Utf16Offset, end: 0 as Utf16Offset, text: 'x' }, first.version);
  assert.equal(edit.ok, true);
  const second = document.snapshot();
  assert.notStrictEqual(second, first);
  assert.strictEqual(document.snapshot(), second);
  assert.equal(first.slice(0 as Utf16Offset, 3 as Utf16Offset).ok, true);
}

function checkCompactionDoesNotMutateOldSnapshot(): void {
  const opened = openTextDocument(documentId, new TextEncoder().encode('a\n'.repeat(1200)));
  assert.equal(opened.kind, 'editable');
  if (opened.kind !== 'editable') throw new Error('expected-editable-document');
  const before = opened.document.snapshot();
  opened.document.compact();
  const after = opened.document.snapshot();
  assert.notStrictEqual(after, before);
  assert.equal(before.slice(0 as Utf16Offset, before.lengthUtf16 as Utf16Offset).ok, true);
  assert.equal(after.slice(0 as Utf16Offset, after.lengthUtf16 as Utf16Offset).ok, true);
}

function checkOrdinaryInsertUsesBoundedRead(): void {
  const opened = openTextDocument(documentId, new TextEncoder().encode('x'.repeat(1_048_576)));
  assert.equal(opened.kind, 'editable');
  if (opened.kind !== 'editable') throw new Error('expected-editable-document');
  const original = opened.document.snapshot();
  let largestSlice = 0;
  const counted = new Proxy(original, {
    get(target, property) {
      if (property === 'slice') {
        return (start: Utf16Offset, end: Utf16Offset) => {
          largestSlice = Math.max(largestSlice, (end as number) - (start as number));
          return original.slice(start, end);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as DocumentSnapshot;
  const entered = beginVimInsert(counted, 524_288 as Utf16Offset, 'i');
  assert.equal(entered.ok, true);
  if (!entered.ok) throw new Error('insert-entry-failed');
  const planned = planVimInsertInput(counted, entered.value.session, { kind: 'key', key: 'x' });
  assert.equal(planned.ok, true);
  assert.equal(largestSlice <= 2, true, `ordinary insert read ${largestSlice} UTF-16 units`);
}

checkStableCurrentSnapshot();
checkCompactionDoesNotMutateOldSnapshot();
checkOrdinaryInsertUsesBoundedRead();
console.log('T109-SNAPSHOT-CACHE-01 passed: unchanged versions reuse one public snapshot, edits invalidate it, and compaction preserves old reads.');
