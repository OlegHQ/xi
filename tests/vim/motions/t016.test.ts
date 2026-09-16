import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTextDocument } from '../../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type Utf16Offset } from '../../../packages/primitives/src/index';
import {
  createVimMotionCursor,
  resolveVimMotion,
  VIM_END_OF_LINE_COLUMN,
  type VimMotionKey,
} from '../../../packages/vim/src/index';
import type { OracleFixture } from '../../oracle/types';

interface MotionTraceSnapshot {
  readonly label: string;
  readonly lines: readonly string[];
  readonly nonemptyRegisters: Readonly<Record<string, unknown>>;
  readonly cursor: {
    readonly line: number;
    readonly byteColumn: number;
    readonly desiredColumn: number;
  };
}

interface MotionTraceFixture {
  readonly id: string;
  readonly snapshots: readonly MotionTraceSnapshot[];
}

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const fixtureDocument = JSON.parse(await readFile(resolve(root, 'tests/vim/motions/fixtures.json'), 'utf8')) as { fixtures: OracleFixture[] };
const traceDocument = JSON.parse(await readFile(resolve(root, 'docs/compatibility/t016-oracle-traces.json'), 'utf8')) as { fixtures: MotionTraceFixture[] };
const traceById = new Map(traceDocument.fixtures.map((fixture) => [fixture.id, fixture]));
const checks: string[] = [];

for (const fixture of fixtureDocument.fixtures) {
  const trace = traceById.get(fixture.id);
  assert.ok(trace, `T016-MOTION-FIXTURE-01 ${fixture.id} has oracle snapshots`);
  const documentText = fixture.lines.join('\n');
  const opened = openTextDocument(asDocumentId(fixture.id), new TextEncoder().encode(documentText));
  assert.equal(opened.kind, 'editable', `T016-MOTION-OWNER-01 ${fixture.id} opens as editable UTF-8`);
  if (opened.kind !== 'editable') throw new Error(`T016-MOTION-OWNER-01 ${fixture.id} is not editable`);
  const document = opened.document;
  const snapshot = document.snapshot();
  const startLine = (fixture.cursor?.line ?? 1) - 1;
  const lineIndexResult = snapshot.lineStartOffset(asLineIndex(startLine));
  assert.equal(lineIndexResult.ok, true, `T016-MOTION-COORDINATE-01 ${fixture.id} starts on a valid line`);
  if (!lineIndexResult.ok) throw new Error(`T016-MOTION-COORDINATE-01 ${fixture.id} line start is unavailable`);
  const initialLineText = fixture.lines[fixture.cursor?.line === undefined ? 0 : fixture.cursor.line - 1] ?? '';
  const initialUtf16Column = utf8ColumnToUtf16(initialLineText, fixture.cursor?.byteColumn0 ?? 0);
  const startOffset = asUtf16Offset((lineIndexResult.value as number) + initialUtf16Column);
  assert.equal(startOffset.ok, true, `T016-MOTION-COORDINATE-01 ${fixture.id} start is a UTF-16 boundary`);
  if (!startOffset.ok) throw new Error(`T016-MOTION-COORDINATE-01 ${fixture.id} start offset is invalid`);
  const optionSet = fixture.options ?? {};
  const motionOptions = {
    ...(typeof optionSet.whichwrap === 'string' ? { whichWrap: optionSet.whichwrap } : {}),
    ...(typeof optionSet.startofline === 'boolean' ? { startOfLine: optionSet.startofline } : {}),
    ...(typeof optionSet.tabstop === 'number' ? { tabSize: optionSet.tabstop } : {}),
  };
  const initialized = createVimMotionCursor(snapshot, startOffset.value, motionOptions);
  assert.equal(initialized.ok, true, `T016-MOTION-COORDINATE-01 ${fixture.id} has a valid initial cursor`);
  if (!initialized.ok) throw new Error(`T016-MOTION-COORDINATE-01 ${fixture.id} cursor initialization failed`);
  let cursor = initialized.value;
  const seededInvariantState = fixture.id === 'T016-ORACLE-MOTION-STATE-INVARIANTS-01'
    ? trace.snapshots.find((entry) => entry.label === 'seed-register')
    : undefined;
  if (fixture.id === 'T016-ORACLE-MOTION-STATE-INVARIANTS-01') {
    assert.ok(seededInvariantState, 'T016-MOTION-STATE-INVARIANTS-01 seeded register snapshot exists');
  }

  for (let index = 0; index < fixture.steps.length; index += 1) {
    const step = fixture.steps[index];
    const traceState: MotionTraceSnapshot | undefined = trace.snapshots[index];
    if (step === undefined || traceState === undefined) throw new Error(`T016-MOTION-FIXTURE-01 ${fixture.id} step ${index} has no expected snapshot`);
    const expected: MotionTraceSnapshot = traceState;
    if (fixture.id === 'T016-ORACLE-MOTION-STATE-INVARIANTS-01' && step.label === 'seed-register') continue;
    if (seededInvariantState !== undefined) {
      assert.deepEqual(expected.lines, seededInvariantState.lines,
        `T016-MOTION-STATE-INVARIANTS-01 ${step.label} leaves oracle text unchanged`);
      assert.deepEqual(expected.nonemptyRegisters, seededInvariantState.nonemptyRegisters,
        `T016-MOTION-STATE-INVARIANTS-01 ${step.label} leaves oracle registers unchanged`);
    }
    for (const invocation of parseMotionSequence(step.keys ?? '')) {
      const resolved = resolveVimMotion(snapshot, cursor, invocation, motionOptions);
      if (!resolved.ok) throw new Error(`T016-MOTION-RESOLVE-01 ${fixture.id}/${step.label} failed: ${resolved.error.kind}`);
      assert.equal(resolved.value.kind, isLinewise(invocation.key) ? 'linewise' : 'characterwise',
        `T016-MOTION-KIND-01 ${fixture.id}/${step.label}/${invocation.key} has the right motion class`);
      cursor = resolved.value.cursor;
    }
    assert.ok(expected, `T016-MOTION-FIXTURE-01 ${fixture.id}/${step.label} expected snapshot exists`);
    const expectedLine = expected.cursor.line - 1;
    const expectedLineStart = snapshot.lineStartOffset(asLineIndex(expectedLine));
    assert.equal(expectedLineStart.ok, true, `T016-MOTION-ORACLE-01 ${fixture.id}/${step.label} oracle line exists`);
    if (!expectedLineStart.ok) throw new Error(`T016-MOTION-ORACLE-01 ${fixture.id}/${step.label} line start missing`);
    const expectedText = expected.lines[expectedLine] ?? '';
    const expectedUtf16Column = utf8ColumnToUtf16(expectedText, expected.cursor.byteColumn - 1);
    const expectedOffset = (expectedLineStart.value as number) + expectedUtf16Column;
    assert.equal(cursor.offset as number, expectedOffset, `T016-MOTION-ORACLE-01 ${fixture.id}/${step.label} UTF-16 cursor matches Neovim`);
    assert.equal(cursor.desiredDisplayCellColumn as number, expected.cursor.desiredColumn,
      `T016-MOTION-ORACLE-01 ${fixture.id}/${step.label} desired display column matches Neovim`);
    checks.push(`T016-MOTION-ORACLE-01:${fixture.id}/${step.label}`);
  }

  assert.equal(document.snapshot().version, snapshot.version, `T016-MOTION-PURITY-01 ${fixture.id} leaves document version unchanged`);
  const startOfDocument = asUtf16Offset(0);
  const endOfDocument = asUtf16Offset(snapshot.lengthUtf16);
  assert.equal(startOfDocument.ok && endOfDocument.ok, true, `T016-MOTION-PURITY-01 ${fixture.id} full-range offsets are safe`);
  if (!startOfDocument.ok || !endOfDocument.ok) throw new Error(`T016-MOTION-PURITY-01 ${fixture.id} full-range offsets are invalid`);
  const entireDocument = snapshot.slice(startOfDocument.value, endOfDocument.value);
  assert.equal(entireDocument.ok, true, `T016-MOTION-PURITY-01 ${fixture.id} remains readable`);
  if (entireDocument.ok) assert.equal(entireDocument.value, documentText, `T016-MOTION-PURITY-01 ${fixture.id} never edits document text`);
}

checkStaleVersionAndInvalidInputs();
console.log(`T016 motions passed ${checks.length} oracle cursor/desired-column comparisons and immutable-document checks`);
console.log(`fixtures=${fixtureDocument.fixtures.length}; end-of-line sentinel=${VIM_END_OF_LINE_COLUMN as number}`);

function parseMotionSequence(keys: string): readonly { readonly key: VimMotionKey; readonly count?: number }[] {
  const motions: { key: VimMotionKey; count?: number }[] = [];
  let index = 0;
  while (index < keys.length) {
    let count: number | undefined;
    const first = keys[index];
    if (first !== undefined && first >= '1' && first <= '9') {
      const begin = index;
      while (index < keys.length && keys[index] !== undefined && keys[index]! >= '0' && keys[index]! <= '9') index += 1;
      count = Number(keys.slice(begin, index));
    }
    let key: string | undefined;
    if (keys.startsWith('gg', index) || keys.startsWith('g_', index)) {
      key = keys.slice(index, index + 2);
      index += 2;
    } else if (keys[index] === '<') {
      const end = keys.indexOf('>', index);
      if (end < 0) throw new Error(`T016-MOTION-PARSER-TEST invalid test token: ${keys}`);
      key = keys.slice(index, end + 1);
      index = end + 1;
    } else {
      key = keys[index];
      index += 1;
    }
    if (!key || !isMotionKey(key)) throw new Error(`T016-MOTION-PARSER-TEST unsupported test token ${JSON.stringify(key)} in ${JSON.stringify(keys)}`);
    motions.push({ key, ...(count === undefined ? {} : { count }) });
  }
  return motions;
}

function isMotionKey(value: string): value is VimMotionKey {
  return ['h', 'l', 'j', 'k', '0', '^', '$', 'g_', '|', '+', '-', '_', 'gg', 'G',
    '<Left>', '<Right>', '<Up>', '<Down>', '<Home>', '<End>', '<C-Home>', '<C-End>', '<BS>', '<C-H>', '<Space>',
    '<NL>', '<CR>', '<C-M>', '<C-J>', '<C-N>', '<C-P>'].includes(value);
}

function isLinewise(key: VimMotionKey): boolean {
  return ['j', 'k', '<Up>', '<Down>', '<NL>', '<C-J>', '<C-N>', '<C-P>', '+', '<CR>', '<C-M>', '-', '_', 'gg', 'G', '<C-Home>', '<C-End>'].includes(key);
}

function asDocumentId(value: string): DocumentId {
  const result = asIdentifier<DocumentId>(value, 'documentId');
  if (!result.ok) throw new Error('T016-MOTION-OWNER-01 invalid document ID');
  return result.value;
}

function asLineIndex(value: number) {
  return value as import('../../../packages/primitives/src/index').LineIndex;
}

function utf8ColumnToUtf16(line: string, byteColumn0: number): number {
  let byteColumn = 0;
  let utf16Column = 0;
  for (const scalar of line) {
    if (byteColumn === byteColumn0) return utf16Column;
    const bytes = Buffer.byteLength(scalar, 'utf8');
    if (byteColumn + bytes > byteColumn0) throw new Error('T016-MOTION-COORDINATE-02 oracle byte column splits a UTF-8 scalar');
    byteColumn += bytes;
    utf16Column += scalar.length;
  }
  if (byteColumn !== byteColumn0) throw new Error('T016-MOTION-COORDINATE-02 oracle byte column exceeds line length');
  return utf16Column;
}

function checkStaleVersionAndInvalidInputs(): void {
  const opened = openTextDocument(asDocumentId('t016-negative'), new TextEncoder().encode('x\ny'));
  if (opened.kind !== 'editable') throw new Error('T016-MOTION-NEGATIVE-01 editable fixture failed to open');
  const snapshot = opened.document.snapshot();
  const offset = asUtf16Offset(0);
  if (!offset.ok) throw new Error('T016-MOTION-NEGATIVE-01 invalid offset constructor');
  const cursor = createVimMotionCursor(snapshot, offset.value);
  if (!cursor.ok) throw new Error('T016-MOTION-NEGATIVE-01 cursor creation failed');
  const stale = { ...cursor.value, documentVersion: (snapshot.version as number + 1) as typeof snapshot.version };
  assert.deepEqual(resolveVimMotion(snapshot, stale, { key: 'j' }), { ok: false, error: { kind: 'stale-document-version' } },
    'T016-MOTION-NEGATIVE-01 stale cursor/version pair is rejected');
  assert.deepEqual(resolveVimMotion(snapshot, cursor.value, { key: 'j', count: 0 }), { ok: false, error: { kind: 'invalid-count' } },
    'T016-MOTION-NEGATIVE-02 zero motion count is rejected');
  assert.deepEqual(resolveVimMotion(snapshot, cursor.value, { key: 'j', count: Number.MAX_SAFE_INTEGER + 1 }), { ok: false, error: { kind: 'invalid-count' } },
    'T016-MOTION-NEGATIVE-03 unsafe motion count is rejected');

  const graphemeDocument = openTextDocument(asDocumentId('t016-grapheme-boundary'), new TextEncoder().encode('e\u0301b'));
  if (graphemeDocument.kind !== 'editable') throw new Error('T016-MOTION-NEGATIVE-04 grapheme fixture failed to open');
  const interiorGraphemeOffset = asUtf16Offset(1);
  if (!interiorGraphemeOffset.ok) throw new Error('T016-MOTION-NEGATIVE-04 grapheme offset constructor failed');
  assert.deepEqual(createVimMotionCursor(graphemeDocument.document.snapshot(), interiorGraphemeOffset.value),
    { ok: false, error: { kind: 'invalid-cursor' } },
    'T016-MOTION-NEGATIVE-04 cursor cannot start on a combining scalar inside a Vim grapheme');
}
