import { strict as assert } from 'node:assert';
import { asIdentifier, asUtf16Offset, type DocumentId, type Utf16Offset } from '../../../packages/primitives/src/index';
import { openTextDocument } from '../../../packages/document/src/index';
import {
  resolveVimStructuralMotion,
  type VimStructuralMotionCursor,
  type VimStructuralMotionInvocation,
} from '../../../packages/vim/src/index';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture } from '../../oracle/types';

interface Fixture {
  readonly id: string;
  readonly lines: readonly string[];
  readonly line: number;
  readonly byteColumn0: number;
  readonly key: VimStructuralMotionInvocation['key'];
  readonly count?: number;
  readonly options?: Readonly<Record<string, string | number | boolean>>;
}

const fixtures: readonly Fixture[] = [
  { id: 'T102-STRUCT-PERCENT-NESTED-01', lines: ['a (x [y] z) q'], line: 1, byteColumn0: 2, key: '%' },
  { id: 'T102-STRUCT-PERCENT-CLOSING-01', lines: ['a (x [y] z) q'], line: 1, byteColumn0: 10, key: '%' },
  { id: 'T102-STRUCT-PERCENT-CUSTOM-PAIR-01', lines: ['a <x> q'], line: 1, byteColumn0: 2, key: '%', options: { matchpairs: '(:),{:},[:],<:>' } },
  { id: 'T102-STRUCT-SENTENCE-FORWARD-01', lines: ['First one. Second here! Third? End'], line: 1, byteColumn0: 0, key: ')' },
  { id: 'T102-STRUCT-SENTENCE-BACKWARD-01', lines: ['First one. Second here! Third? End'], line: 1, byteColumn0: 11, key: '(' },
  { id: 'T102-STRUCT-PARAGRAPH-FORWARD-01', lines: ['para one', 'still', '', 'para two', 'still', '', 'para three'], line: 1, byteColumn0: 0, key: '}' },
  { id: 'T102-STRUCT-PARAGRAPH-BACKWARD-01', lines: ['para one', 'still', '', 'para two', 'still', '', 'para three'], line: 7, byteColumn0: 0, key: '{' },
  { id: 'T102-STRUCT-PARAGRAPH-MACRO-OPTION-01', lines: ['.PP first', 'body', '.PP second', 'body', 'tail'], line: 1, byteColumn0: 0, key: '}', options: { paragraphs: 'PP' } },
  { id: 'T102-STRUCT-PERCENT-COUNT-02', lines: ['one', 'two', 'three', 'four', 'five'], line: 1, byteColumn0: 0, key: '%', count: 50 },
  { id: 'T102-STRUCT-SECTION-FORWARD-01', lines: ['.SH one', 'body', '', '.SH two', 'body', '', '.SH three'], line: 1, byteColumn0: 0, key: ']]' },
  { id: 'T102-STRUCT-SECTION-BACKWARD-01', lines: ['.SH one', 'body', '', '.SH two', 'body', '', '.SH three'], line: 7, byteColumn0: 0, key: '[[' },
  { id: 'T102-STRUCT-SECTION-END-BACKWARD-01', lines: ['.SH one', 'body', '', '.SH two', 'body', '', '.SH three'], line: 1, byteColumn0: 0, key: '[]' },
  { id: 'T102-STRUCT-SECTION-END-FORWARD-01', lines: ['.SH one', 'body', '', '.SH two', 'body', '', '.SH three'], line: 7, byteColumn0: 0, key: '][' },
  { id: 'T102-STRUCT-SECTION-CUSTOM-OPTION-01', lines: ['.AB one', 'body', '.AB two', 'body'], line: 1, byteColumn0: 0, key: ']]', options: { sections: 'AB' } },
  { id: 'T061-STRUCT-UNMATCHED-PAREN-BACKWARD-01', lines: ['foo ( bar'], line: 1, byteColumn0: 8, key: '[(' },
  { id: 'T061-STRUCT-UNMATCHED-BRACE-BACKWARD-01', lines: ['foo { bar'], line: 1, byteColumn0: 8, key: '[{' },
  { id: 'T061-STRUCT-UNMATCHED-PAREN-FORWARD-01', lines: ['foo ) bar'], line: 1, byteColumn0: 0, key: '])' },
  { id: 'T061-STRUCT-UNMATCHED-BRACE-FORWARD-01', lines: ['foo } bar'], line: 1, byteColumn0: 0, key: ']}' },
  { id: 'T061-STRUCT-UNMATCHED-PAREN-COUNT-01', lines: ['( ( text'], line: 1, byteColumn0: 8, key: '[(', count: 2 },
];

const oracle = await verifyOracleBundle();
for (const fixture of fixtures) {
  const documentId = asDocumentId(fixture.id);
  const opened = openTextDocument(documentId, new TextEncoder().encode(fixture.lines.join('\n')));
  assert.equal(opened.kind, 'editable', `${fixture.id} document opens`);
  if (opened.kind !== 'editable') throw new Error(`${fixture.id} document did not open`);
  const snapshot = opened.document.snapshot();
  const lineStart = snapshot.lineStartOffset((fixture.line - 1) as never);
  assert.equal(lineStart.ok, true, `${fixture.id} line start exists`);
  if (!lineStart.ok) throw new Error(`${fixture.id} line start unavailable`);
  const offset = asUtf16Offset((lineStart.value as number) + fixture.byteColumn0);
  assert.equal(offset.ok, true, `${fixture.id} cursor offset is valid`);
  if (!offset.ok) throw new Error(`${fixture.id} cursor offset invalid`);
  const cursor: VimStructuralMotionCursor = {
    documentVersion: snapshot.version,
    offset: offset.value,
    desiredDisplayCellColumn: 0 as never,
  };
  const invocation: VimStructuralMotionInvocation = {
    key: fixture.key,
    ...(fixture.count === undefined ? {} : { count: fixture.count }),
  };
  const result = resolveVimStructuralMotion(snapshot, cursor, invocation, {
    ...(typeof fixture.options?.matchpairs === 'string' ? { matchPairs: fixture.options.matchpairs } : {}),
    ...(typeof fixture.options?.sections === 'string' ? { sections: fixture.options.sections } : {}),
    ...(typeof fixture.options?.paragraphs === 'string' ? { paragraphs: fixture.options.paragraphs } : {}),
  });
  if (!result.ok) throw new Error(`T102-STRUCT-RESOLVE-01 ${fixture.id}: ${result.error.kind}`);

  const oracleFixture: OracleFixture = {
    id: `${fixture.id}-ORACLE`,
    title: 'T102 structural motion oracle',
    purpose: 'Pinned Neovim structural motion coordinate.',
    modes: ['normal'],
    lines: fixture.lines,
    cursor: { line: fixture.line, byteColumn0: fixture.byteColumn0 },
    ...(fixture.options === undefined ? {} : { options: fixture.options }),
    steps: [{ label: 'motion', keys: `${fixture.count ?? ''}${fixture.key}` }],
  };
  const oracleResult = await runOracleFixture(oracleFixture, oracle.binaryPath);
  const expected = oracleResult.snapshots[0];
  assert.ok(expected, `${fixture.id} oracle snapshot exists`);
  if (expected === undefined) continue;
  const expectedLineStart = snapshot.lineStartOffset((expected.cursor.line - 1) as never);
  assert.equal(expectedLineStart.ok, true, `${fixture.id} oracle line exists`);
  if (!expectedLineStart.ok) continue;
  const expectedOffset = utf8ColumnToUtf16(expected.lines[expected.cursor.line - 1] ?? '', expected.cursor.byteColumn - 1);
  assert.equal(result.value.cursor.offset as number, (expectedLineStart.value as number) + expectedOffset,
    `T102-STRUCT-ORACLE-01 ${fixture.id} UTF-16 offset`);
  assert.equal(opened.document.snapshot().version, snapshot.version, `T102-STRUCT-PURITY-01 ${fixture.id}`);
  console.log(`PASS ${fixture.id}`);
}

const invalidDocument = openTextDocument(asDocumentId('T102-STRUCT-FAILURES'), new TextEncoder().encode('no pair'));
assert.equal(invalidDocument.kind, 'editable');
if (invalidDocument.kind === 'editable') {
  const snapshot = invalidDocument.document.snapshot();
  const cursor: VimStructuralMotionCursor = { documentVersion: snapshot.version, offset: 0 as Utf16Offset, desiredDisplayCellColumn: null };
  assert.deepEqual(resolveVimStructuralMotion(snapshot, cursor, { key: '%' }), { ok: false, error: { kind: 'unmatched-structure' } },
    'T102-STRUCT-UNMATCHED-01');
  assert.deepEqual(resolveVimStructuralMotion(snapshot, cursor, { key: '%', count: 0 }), { ok: false, error: { kind: 'invalid-count' } },
    'T102-STRUCT-COUNT-01');
  assert.deepEqual(resolveVimStructuralMotion(snapshot, cursor, { key: ')' }, { maxScanUtf16: 1 }), { ok: false, error: { kind: 'scan-limit' } },
    'T102-STRUCT-SCAN-BOUND-01');
  assert.deepEqual(resolveVimStructuralMotion(snapshot, { ...cursor, documentVersion: 2 as never }, { key: ')' }),
    { ok: false, error: { kind: 'stale-document-version' } }, 'T102-STRUCT-STALE-01');
}

console.log(`T102 structural motion fixtures passed: ${fixtures.length}`);

function asDocumentId(value: string): DocumentId {
  const result = asIdentifier<DocumentId>(value, 'document-id');
  if (!result.ok) throw new Error(`invalid document id: ${value}`);
  return result.value;
}

function utf8ColumnToUtf16(line: string, byteColumn0: number): number {
  let bytes = 0;
  let units = 0;
  for (const scalar of line) {
    if (bytes === byteColumn0) return units;
    const scalarBytes = Buffer.byteLength(scalar, 'utf8');
    if (bytes + scalarBytes > byteColumn0) throw new Error('oracle byte column splits a scalar');
    bytes += scalarBytes;
    units += scalar.length;
  }
  if (bytes !== byteColumn0) throw new Error('oracle byte column exceeds line');
  return units;
}
