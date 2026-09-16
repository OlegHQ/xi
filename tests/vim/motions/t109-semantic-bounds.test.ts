import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentSnapshot } from '../../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type Utf16Offset } from '../../../packages/primitives/src/index';
import { createVimMotionCursor, resolveVimMotion } from '../../../packages/vim/motions/index';

const idResult = asIdentifier<DocumentId>('T109-semantic-bounds', 'documentId');
const documentId: DocumentId = idResult.ok
  ? idResult.value
  : (() => { throw new Error(idResult.error.message); })();

function asOffset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error(`invalid UTF-16 offset: ${value}`);
  return result.value;
}

function open(value: string): DocumentSnapshot {
  const opened = openTextDocument(documentId, new TextEncoder().encode(value));
  if (opened.kind !== 'editable') throw new Error(`expected editable document, got ${opened.kind}`);
  return opened.document.snapshot();
}

function observed(snapshot: DocumentSnapshot): { readonly snapshot: DocumentSnapshot; readonly largestSlice: () => number } {
  let largest = 0;
  const proxy = new Proxy(snapshot, {
    get(target, property) {
      if (property === 'slice') {
        return (start: Utf16Offset, end: Utf16Offset) => {
          largest = Math.max(largest, (end as number) - (start as number));
          return target.slice(start, end);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    },
  }) as DocumentSnapshot;
  return { snapshot: proxy, largestSlice: () => largest };
}

function checkAsciiWindows(): void {
  const longLine = `${' '.repeat(8192)}x`;
  const text = `${longLine}\n${'a'.repeat(1_048_576)}`;
  const snapshot = open(text);
  const start = createVimMotionCursor(snapshot, asOffset(0));
  assert.equal(start.ok, true, 'T109-MOTION-BOUNDS-01 initial ASCII cursor is valid');
  if (!start.ok) throw new Error('initial ASCII cursor failed');

  for (const key of ['^', 'g_', 'j', '$', 'l'] as const) {
    const measured = observed(snapshot);
    const result = resolveVimMotion(measured.snapshot, start.value, { key }, key === 'j' ? {} : { startOfLine: true });
    assert.equal(result.ok, true, `T109-MOTION-BOUNDS-01 ${key} resolves`);
    assert.ok(measured.largestSlice() <= 256,
      `T109-MOTION-BOUNDS-01 ${key} read ${measured.largestSlice()} UTF-16 units`);
  }
}

function checkUnicodeWindowEdges(): void {
  const combining = `a${'\u0301'.repeat(1024)}b`;
  const regional = '🇦🇧🇨';
  const zwj = '👩‍'.repeat(256) + '💻';
  const snapshot = open(`${combining}\n${regional}\n${zwj}`);
  const combiningCursor = createVimMotionCursor(snapshot, asOffset(0));
  assert.equal(combiningCursor.ok, true, 'T109-MOTION-GRAPHEME-01 combining cursor is valid');
  if (!combiningCursor.ok) throw new Error('combining cursor failed');
  const forward = resolveVimMotion(snapshot, combiningCursor.value, { key: 'l' });
  assert.equal(forward.ok, true, 'T109-MOTION-GRAPHEME-01 forward motion resolves');
  if (!forward.ok) throw new Error('forward combining motion failed');
  assert.equal(forward.value.cursor.offset as number, combining.length - 1,
    'T109-MOTION-GRAPHEME-01 forward motion lands on the final b cluster');

  const backward = resolveVimMotion(snapshot, forward.value.cursor, { key: 'h' });
  assert.equal(backward.ok, true, 'T109-MOTION-GRAPHEME-02 backward motion resolves');
  if (!backward.ok) throw new Error('backward combining motion failed');
  assert.equal(backward.value.cursor.offset as number, 0,
    'T109-MOTION-GRAPHEME-02 backward motion returns to the leading cluster');
}

checkAsciiWindows();
checkUnicodeWindowEdges();
console.log('T109 semantic bounds passed: ASCII motion reads stay within 256 UTF-16 units and long combining graphemes remain exact.');
