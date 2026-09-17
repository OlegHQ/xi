import { strict as assert } from 'node:assert';
import { openTextDocument } from '../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type Utf16Offset } from '../../packages/primitives/src/index';
import {
  createVimMotionCursor,
  prepareVimPut,
  resolveVimFind,
  resolveVimStructuralMotion,
  type VimRegisterValue,
} from '../../packages/vim/src/index';

// D1: `p`, `f`, and `%` must resolve against the cursor's own line, not the
// whole document. A 2 MiB single line sits far from the short lines these
// motions actually touch; if any of them fell back to a whole-document or
// whole-line read, the giant line would dominate the timing below.
const LONG_LINE_LENGTH = 2 * 1024 * 1024;
const longLine = 'x'.repeat(LONG_LINE_LENGTH);
const shortLines = ['(hello)', 'abc def', 'end'];
const source = [longLine, ...shortLines].join('\n');

const BOUND_MS = 5;

const document = openTextDocument(asDocumentId('bounded-reads'), new TextEncoder().encode(source));
assert.equal(document.kind, 'editable', 'BOUNDED-READS-01 opens an editable snapshot');
if (document.kind !== 'editable') throw new Error('BOUNDED-READS-01 document did not open');
const snapshot = document.document.snapshot();

// Line 1 is `(hello)`; line start offset plus 0 is the `(`.
const parenLineStart = snapshot.lineStartOffset(1 as never);
assert.equal(parenLineStart.ok, true, 'BOUNDED-READS-02 line 1 start resolves');
if (!parenLineStart.ok) throw new Error('line 1 missing');
const parenOffset = parenLineStart.value as number;

const percentCursorResult = createVimMotionCursor(snapshot, offset(parenOffset));
assert.equal(percentCursorResult.ok, true, 'BOUNDED-READS-03 percent cursor is valid');
if (!percentCursorResult.ok) throw new Error('percent cursor failed');

const percentStart = performance.now();
const percentOutcome = resolveVimStructuralMotion(snapshot, percentCursorResult.value, { key: '%' });
const percentElapsed = performance.now() - percentStart;
assert.equal(percentOutcome.ok, true, 'BOUNDED-READS-04 % resolves a match');
if (percentOutcome.ok) {
  assert.equal(percentOutcome.value.cursor.offset as number, parenOffset + '(hello)'.length - 1,
    'BOUNDED-READS-05 % lands on the closing paren');
}
assert.ok(percentElapsed < BOUND_MS, `BOUNDED-READS-06 % completed in ${percentElapsed}ms (< ${BOUND_MS}ms)`);

// Line 2 is `abc def`; find the `d` in `def` with `f`.
const findLineStart = snapshot.lineStartOffset(2 as never);
assert.equal(findLineStart.ok, true, 'BOUNDED-READS-07 line 2 start resolves');
if (!findLineStart.ok) throw new Error('line 2 missing');
const findOffset = findLineStart.value as number;

const findCursorResult = createVimMotionCursor(snapshot, offset(findOffset));
assert.equal(findCursorResult.ok, true, 'BOUNDED-READS-08 find cursor is valid');
if (!findCursorResult.ok) throw new Error('find cursor failed');

const findStart = performance.now();
const findOutcome = resolveVimFind(snapshot, findCursorResult.value, { key: 'f', target: 'd' }, null);
const findElapsed = performance.now() - findStart;
assert.equal(findOutcome.ok, true, 'BOUNDED-READS-09 f resolves');
if (findOutcome.ok && findOutcome.value.kind === 'found') {
  assert.equal(findOutcome.value.cursor.offset as number, findOffset + 'abc '.length,
    'BOUNDED-READS-10 f lands on the d in def');
} else {
  assert.fail('BOUNDED-READS-10 f did not find a match');
}
assert.ok(findElapsed < BOUND_MS, `BOUNDED-READS-11 f completed in ${findElapsed}ms (< ${BOUND_MS}ms)`);

// Line 3 is `end`; put a short register value after the cursor with `p`.
const putLineStart = snapshot.lineStartOffset(3 as never);
assert.equal(putLineStart.ok, true, 'BOUNDED-READS-12 line 3 start resolves');
if (!putLineStart.ok) throw new Error('line 3 missing');
const putOffset = putLineStart.value as number;

const registerValue: VimRegisterValue = Object.freeze({ lines: Object.freeze(['XY']), type: 'characterwise' });
const putStart = performance.now();
const putPlan = prepareVimPut({
  snapshot,
  cursor: offset(putOffset),
  register: registerValue,
  command: 'p',
});
const putElapsed = performance.now() - putStart;
assert.equal(putPlan.ok, true, 'BOUNDED-READS-13 p prepares a plan');
if (putPlan.ok) {
  assert.equal(putPlan.value.edits.length, 1, 'BOUNDED-READS-14 p produces one edit');
  assert.equal(putPlan.value.edits[0]?.text, 'XY', 'BOUNDED-READS-15 p inserts the register text');
  assert.equal(putPlan.value.edits[0]?.start as number, putOffset + 1, 'BOUNDED-READS-16 p inserts after the cursor character');
}
assert.ok(putElapsed < BOUND_MS, `BOUNDED-READS-17 p completed in ${putElapsed}ms (< ${BOUND_MS}ms)`);

console.log(`bounded-reads: % ${percentElapsed.toFixed(3)}ms, f ${findElapsed.toFixed(3)}ms, p ${putElapsed.toFixed(3)}ms`);

function asDocumentId(value: string): DocumentId {
  const result = asIdentifier<DocumentId>(value, 'document-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function offset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
