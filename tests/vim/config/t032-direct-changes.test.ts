import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentEdit, type DocumentSnapshot } from '../../../packages/document/src/index';
import {
  prepareVimDirectChange,
  type VimOperatorSessionState,
} from '../../../packages/vim/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type Utf16Offset } from '../../../packages/primitives/src/index';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';

const state: VimOperatorSessionState = Object.freeze({ mode: 'normal', repeatTarget: null });

checkSubstituteCharacter();
checkSubstituteLine();
checkChangeToEnd();
checkReplaceGrapheme();
checkFailures();
await checkPinnedOracleRows();

console.log('T032 direct changes passed s/S/C/r: grapheme-safe ranges, insert transitions, counts, replacement and pinned Neovim rows');

function checkSubstituteCharacter(): void {
  const snapshot = open('abc🙂ef', 'T032-s');
  const plan = expectOk(prepareVimDirectChange({ snapshot, key: 's', cursorOffset: offset(1), count: 2, state }));
  assert.equal(apply(snapshot, plan.transaction?.edits ?? []), 'a🙂ef', 'T032-DIRECT-S-01 s count removes two graphemes');
  assert.equal(plan.mode, 'insert', 'T032-DIRECT-S-02 s enters Insert');
  assert.equal(plan.cursorIntent.placement, 'insert-gap', 'T032-DIRECT-S-03 s uses an Insert gap');
  assert.equal(plan.cursorOffset, 1, 'T032-DIRECT-S-04 s gap is at the original cursor');
}

function checkSubstituteLine(): void {
  const snapshot = open('  one two\nnext\n', 'T032-S');
  const plan = expectOk(prepareVimDirectChange({ snapshot, key: 'S', cursorOffset: offset(4), state }));
  assert.equal(apply(snapshot, plan.transaction?.edits ?? []), '  \nnext\n', 'T032-DIRECT-SUPER-01 S clears line content after indentation');
  assert.equal(plan.cursorOffset, 2, 'T032-DIRECT-SUPER-02 S enters after indentation');
  assert.equal(plan.mode, 'insert', 'T032-DIRECT-SUPER-03 S enters Insert');
}

function checkChangeToEnd(): void {
  const snapshot = open('abc def\nnext', 'T032-C');
  const plan = expectOk(prepareVimDirectChange({ snapshot, key: 'C', cursorOffset: offset(4), state }));
  assert.equal(apply(snapshot, plan.transaction?.edits ?? []), 'abc \nnext', 'T032-DIRECT-C-01 C deletes through the line end and preserves newline');
  assert.equal(plan.cursorOffset, 4, 'T032-DIRECT-C-02 C enters at the original cursor');
  assert.equal(plan.mode, 'insert', 'T032-DIRECT-C-03 C enters Insert');
}

function checkReplaceGrapheme(): void {
  const snapshot = open('a🙂bc', 'T032-r');
  const plan = expectOk(prepareVimDirectChange({ snapshot, key: 'r', cursorOffset: offset(1), count: 2, replacement: 'X', state }));
  assert.equal(apply(snapshot, plan.transaction?.edits ?? []), 'aXXc', 'T032-DIRECT-R-01 r count replaces complete graphemes');
  assert.equal(plan.mode, 'normal', 'T032-DIRECT-R-02 r remains in Normal');
  assert.equal(plan.cursorOffset, 3, 'T032-DIRECT-R-03 r leaves the cursor on the last source grapheme');
  assert.equal(plan.transaction?.edits[0]?.text, 'XX', 'T032-DIRECT-R-04 r repeats one replacement grapheme');
}

function checkFailures(): void {
  const snapshot = open('abc', 'T032-fail');
  assert.deepEqual(prepareVimDirectChange({ snapshot, key: 'r', cursorOffset: offset(0), replacement: 'XY', state }),
    { ok: false, error: { kind: 'invalid-replacement' } }, 'T032-DIRECT-FAIL-01 r rejects multiple graphemes');
  assert.deepEqual(prepareVimDirectChange({ snapshot, key: 's', cursorOffset: offset(0), expectedVersion: 99 as DocumentSnapshot['version'], state }),
    { ok: false, error: { kind: 'stale-document-version' } }, 'T032-DIRECT-FAIL-02 stale direct change is rejected');
  assert.deepEqual(prepareVimDirectChange({ snapshot, key: 's', cursorOffset: offset(0), count: 0, state }),
    { ok: false, error: { kind: 'invalid-count' } }, 'T032-DIRECT-FAIL-03 invalid count has no transaction');
}

async function checkPinnedOracleRows(): Promise<void> {
  const oracle = await verifyOracleBundle();
  const cases = [
    { id: 'T032-DIRECT-ORACLE-S-01', lines: ['abc'], cursor: 1, keys: 's<Esc>', expected: ['ac'] },
    { id: 'T032-DIRECT-ORACLE-SUPER-01', lines: ['  abc', 'next'], cursor: 3, keys: 'SNEW<Esc>', expected: ['  NEW', 'next'] },
    { id: 'T032-DIRECT-ORACLE-C-01', lines: ['abc def', 'next'], cursor: 4, keys: 'C<Esc>', expected: ['abc ', 'next'] },
    { id: 'T032-DIRECT-ORACLE-R-01', lines: ['a🙂bc'], cursor: 1, keys: 'rX', expected: ['aXbc'] },
  ] as const;
  for (const fixture of cases) {
    const result = await runOracleFixture({
      id: fixture.id,
      title: fixture.id,
      purpose: 'Pin direct-change text and mode behavior.',
      modes: ['normal', 'insert'],
      lines: fixture.lines,
      cursor: { line: 1, byteColumn0: Buffer.byteLength(fixture.lines[0]?.slice(0, fixture.cursor) ?? '', 'utf8') },
      steps: [{ label: 'direct-change', keys: fixture.keys, drain: true }],
    }, oracle.binaryPath);
    const snapshot = result.snapshots.at(-1);
    assert.ok(snapshot, `${fixture.id} exposes a final snapshot`);
    if (snapshot === undefined) continue;
    assert.deepEqual(snapshot.lines, fixture.expected, `${fixture.id} matches pinned Neovim text`);
    assert.equal(snapshot.mode, 'n', `${fixture.id} returns to Normal or remains Normal`);
  }
}

function open(source: string, id: string): DocumentSnapshot {
  const documentId = asIdentifier<DocumentId>(id, 'documentId');
  assert.equal(documentId.ok, true, 'T032-DIRECT-OWNER-01 fixture id is valid');
  if (!documentId.ok) throw new Error('invalid fixture id');
  const opened = openTextDocument(documentId.value, new TextEncoder().encode(source));
  assert.equal(opened.kind, 'editable', 'T032-DIRECT-OWNER-02 fixture opens editable');
  if (opened.kind !== 'editable') throw new Error('fixture did not open editable');
  return opened.document.snapshot();
}

function apply(snapshot: DocumentSnapshot, edits: readonly DocumentEdit[]): string {
  const source = snapshot.slice(offset(0), offset(snapshot.lengthUtf16));
  assert.equal(source.ok, true, 'T032-DIRECT-OWNER-03 fixture text is readable');
  if (!source.ok) throw new Error('fixture text unavailable');
  return [...edits].sort((left, right) => (right.start as number) - (left.start as number)
    || (right.end as number) - (left.end as number))
    .reduce((text, edit) => `${text.slice(0, edit.start as number)}${edit.text}${text.slice(edit.end as number)}`, source.value);
}

function offset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  assert.equal(result.ok, true, 'T032-DIRECT-COORDINATE-01 offset is safe');
  if (!result.ok) throw new Error('invalid offset');
  return result.value;
}

function expectOk<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }): T {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
}
