import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTextDocument, type DocumentSnapshot } from '../../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type LineIndex, type Utf16Offset } from '../../../packages/primitives/src/index';
import {
  createVimMotionCursor,
  resolveVimWordMotion,
  type VimWordMotionKey,
  type VimWordMotionOptions,
} from '../../../packages/vim/src/index';
import type { OracleFixture } from '../../oracle/types';

interface WordTraceSnapshot {
  readonly label: string;
  readonly lines: readonly string[];
  readonly cursor: {
    readonly line: number;
    readonly byteColumn: number;
    readonly desiredColumn: number;
  };
  readonly iskeyword: string;
}

interface WordTraceFixture {
  readonly id: string;
  readonly snapshots: readonly WordTraceSnapshot[];
}

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const catalog = JSON.parse(await readFile(resolve(root, 'tests/vim/motions/t017-fixtures.json'), 'utf8')) as {
  readonly fixtures: readonly OracleFixture[];
};
const trace = JSON.parse(await readFile(resolve(root, 'docs/compatibility/t017-word.json'), 'utf8')) as {
  readonly fixtures: readonly WordTraceFixture[];
};
const traceById = new Map(trace.fixtures.map((fixture) => [fixture.id, fixture]));
let cursorComparisons = 0;

for (const fixture of catalog.fixtures) {
  const expectedFixture = traceById.get(fixture.id);
  assert.ok(expectedFixture, `T017-MOTION-FIXTURE-01 ${fixture.id} has a pinned trace`);
  if (expectedFixture === undefined) throw new Error(`T017-MOTION-FIXTURE-01 missing trace ${fixture.id}`);

  // The oracle trace is captured via nvim_buf_set_lines(0, 0, -1, true, fixture.lines) — an
  // exact N-line buffer, independent of any file "no trailing newline" convention. A plain
  // `lines.join('\n')` loses a genuinely-empty last line (e.g. ["...","  bar",""]) once opened,
  // because the resulting text ends in a single '\n' that the document model (and vimLineCount,
  // see motions/index.ts) treats as *terminating* the prior line, not as a separate empty line.
  // Appending one more '\n' preserves the fixture's real line count faithfully: for a non-empty
  // last line this is a no-op under vimLineCount's trailing-newline subtraction.
  const text = fixture.lines.length === 0 ? '' : `${fixture.lines.join('\n')}\n`;
  const opened = openTextDocument(asDocumentId(fixture.id), new TextEncoder().encode(text));
  assert.equal(opened.kind, 'editable', `T017-MOTION-DOCUMENT-01 ${fixture.id} opens as UTF-8`);
  if (opened.kind !== 'editable') throw new Error(`T017-MOTION-DOCUMENT-01 ${fixture.id} did not open`);
  const document = opened.document;
  const snapshot = document.snapshot();
  const startLineIndex = (fixture.cursor?.line ?? 1) - 1;
  const lineStart = snapshot.lineStartOffset(startLineIndex as LineIndex);
  assert.equal(lineStart.ok, true, `T017-MOTION-COORDINATE-01 ${fixture.id} has a start line`);
  if (!lineStart.ok) throw new Error(`T017-MOTION-COORDINATE-01 ${fixture.id} start line unavailable`);
  const initialLine = fixture.lines[startLineIndex] ?? '';
  const initialColumn = utf8ColumnToUtf16(initialLine, fixture.cursor?.byteColumn0 ?? 0);
  const initialOffset = asUtf16Offset((lineStart.value as number) + initialColumn);
  assert.equal(initialOffset.ok, true, `T017-MOTION-COORDINATE-01 ${fixture.id} cursor converts to UTF-16`);
  if (!initialOffset.ok) throw new Error(`T017-MOTION-COORDINATE-01 ${fixture.id} start offset invalid`);

  const fixtureOptions = fixture.options ?? {};
  const motionOptions: VimWordMotionOptions = {
    ...(typeof fixtureOptions.iskeyword === 'string' ? { isKeyword: fixtureOptions.iskeyword } : {}),
    ...(typeof fixtureOptions.tabstop === 'number' ? { tabSize: fixtureOptions.tabstop } : {}),
  };
  const initialized = createVimMotionCursor(snapshot, initialOffset.value,
    typeof fixtureOptions.tabstop === 'number' ? { tabSize: fixtureOptions.tabstop } : {});
  assert.equal(initialized.ok, true, `T017-MOTION-COORDINATE-01 ${fixture.id} cursor initializes`);
  if (!initialized.ok) throw new Error(`T017-MOTION-COORDINATE-01 ${fixture.id} cursor initialization failed`);
  let cursor = initialized.value;

  assert.equal(fixture.steps.length, expectedFixture.snapshots.length,
    `T017-MOTION-ORACLE-01 ${fixture.id} has a trace for every step`);
  for (let index = 0; index < fixture.steps.length; index += 1) {
    const step = fixture.steps[index];
    const expected: WordTraceSnapshot | undefined = expectedFixture.snapshots[index];
    assert.ok(step, `T017-MOTION-ORACLE-01 ${fixture.id} fixture step ${index} exists`);
    assert.ok(expected, `T017-MOTION-ORACLE-01 ${fixture.id} trace step ${index} exists`);
    if (step === undefined || expected === undefined) throw new Error(`T017-MOTION-ORACLE-01 ${fixture.id} step ${index} missing`);
    const invocation = parseWordInvocation(step.keys ?? '');
    const currentOptions = { ...motionOptions, isKeyword: expected.iskeyword };
    const resolved = resolveVimWordMotion(snapshot, cursor, invocation, currentOptions);
    assert.equal(resolved.ok, true, `T017-MOTION-RESOLVE-01 ${fixture.id}/${step.label} resolves`);
    if (!resolved.ok) throw new Error(`T017-MOTION-RESOLVE-01 ${fixture.id}/${step.label}: ${JSON.stringify(resolved)}`);
    cursor = resolved.value.cursor;

    const expectedLineIndex = expected.cursor.line - 1;
    const expectedLineStart = snapshot.lineStartOffset(expectedLineIndex as LineIndex);
    assert.equal(expectedLineStart.ok, true, `T017-MOTION-ORACLE-01 ${fixture.id}/${step.label} expected line exists`);
    if (!expectedLineStart.ok) throw new Error(`T017-MOTION-ORACLE-01 ${fixture.id}/${step.label} line unavailable`);
    const expectedLine = expected.lines[expectedLineIndex] ?? '';
    const expectedColumn = utf8ColumnToUtf16(expectedLine, expected.cursor.byteColumn - 1);
    assert.equal(cursor.offset as number, (expectedLineStart.value as number) + expectedColumn,
      `T017-MOTION-ORACLE-01 ${fixture.id}/${step.label} UTF-16 cursor matches Neovim`);
    assert.equal(cursor.desiredDisplayCellColumn as number, expected.cursor.desiredColumn,
      `T017-MOTION-ORACLE-01 ${fixture.id}/${step.label} desired display column matches Neovim`);
    cursorComparisons += 1;
  }

  assert.equal(document.snapshot().version, snapshot.version,
    `T017-MOTION-PURITY-01 ${fixture.id} resolver leaves document version unchanged`);
  const start = asUtf16Offset(0);
  const end = asUtf16Offset(snapshot.lengthUtf16);
  assert.ok(start.ok && end.ok, `T017-MOTION-PURITY-01 ${fixture.id} full text range is valid`);
  if (!start.ok || !end.ok) throw new Error(`T017-MOTION-PURITY-01 ${fixture.id} range conversion failed`);
  const unchanged = snapshot.slice(start.value, end.value);
  assert.equal(unchanged.ok, true, `T017-MOTION-PURITY-01 ${fixture.id} text remains readable`);
  if (unchanged.ok) assert.equal(unchanged.value, text, `T017-MOTION-PURITY-01 ${fixture.id} text is unchanged`);
}

checkIsKeywordChangesAreImmediate();
checkAdjacentWordReadsStayLocal();
checkInvalidInputs();
console.log(`T017 word motions passed ${catalog.fixtures.length} fixtures / ${cursorComparisons} oracle cursor-and-column comparisons`);
console.log('T017 acceptance: immediate iskeyword updates and bounded adjacent-word source reads passed');

function parseWordInvocation(keys: string): { readonly key: VimWordMotionKey; readonly count?: number } {
  const match = /^(\d+)?(ge|gE|[wWbBeE])$/u.exec(keys);
  if (match === null) throw new Error(`T017-MOTION-PARSER-01 unsupported fixture key sequence ${JSON.stringify(keys)}`);
  const key = match[2];
  if (key === undefined) throw new Error(`T017-MOTION-PARSER-01 missing motion key in ${JSON.stringify(keys)}`);
  const count = match[1] === undefined ? undefined : Number(match[1]);
  return { key: key as VimWordMotionKey, ...(count === undefined ? {} : { count }) };
}

function checkIsKeywordChangesAreImmediate(): void {
  const opened = openTextDocument(asDocumentId('t017-live-iskeyword'), new TextEncoder().encode('foo-bar baz'));
  if (opened.kind !== 'editable') throw new Error('T017-MOTION-ISKEYWORD-01 document failed to open');
  const snapshot = opened.document.snapshot();
  const cursor = createVimMotionCursor(snapshot, asOffset(0));
  if (!cursor.ok) throw new Error('T017-MOTION-ISKEYWORD-01 initial cursor failed');

  const defaultResult = resolveVimWordMotion(snapshot, cursor.value, { key: 'w' });
  if (!defaultResult.ok) throw new Error(`T017-MOTION-ISKEYWORD-01 default option failed: ${defaultResult.error.kind}`);
  assert.equal(defaultResult.value.cursor.offset as number, 3,
    'T017-MOTION-ISKEYWORD-01 pinned default stops on the hyphen');

  const customResult = resolveVimWordMotion(snapshot, cursor.value, { key: 'w' }, {
    isKeyword: '@,48-57,_,192-255,-',
  });
  if (!customResult.ok) throw new Error(`T017-MOTION-ISKEYWORD-01 changed option failed: ${customResult.error.kind}`);
  assert.equal(customResult.value.cursor.offset as number, 8,
    'T017-MOTION-ISKEYWORD-01 custom value immediately groups the hyphenated word');
}

function checkAdjacentWordReadsStayLocal(): void {
  const lines = ['alpha beta', ...Array.from({ length: 2_000 }, () => 'nearby'), 'z'.repeat(1_000_000)];
  const text = lines.join('\n');
  const opened = openTextDocument(asDocumentId('t017-bounded-adjacent'), new TextEncoder().encode(text));
  if (opened.kind !== 'editable') throw new Error('T017-MOTION-BOUNDED-01 document failed to open');
  const snapshot = opened.document.snapshot();
  const cursor = createVimMotionCursor(snapshot, asOffset(0));
  if (!cursor.ok) throw new Error('T017-MOTION-BOUNDED-01 initial cursor failed');

  const lineIndexesRead: number[] = [];
  let totalSliceUnits = 0;
  const observed = new Proxy(snapshot, {
    get(target, property) {
      if (property === 'lineStartOffset') {
        return (index: LineIndex) => {
          lineIndexesRead.push(index as number);
          return target.lineStartOffset(index);
        };
      }
      if (property === 'slice') {
        return (start: Utf16Offset, end: Utf16Offset) => {
          totalSliceUnits += (end as number) - (start as number);
          return target.slice(start, end);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    },
  }) as DocumentSnapshot;

  const result = resolveVimWordMotion(observed, cursor.value, { key: 'w' });
  assert.equal(result.ok, true, 'T017-MOTION-BOUNDED-01 adjacent w resolves on a large document');
  if (!result.ok) throw new Error(`T017-MOTION-BOUNDED-01 resolver failed: ${JSON.stringify(result)}`);
  assert.equal(result.value.cursor.offset as number, 6, 'T017-MOTION-BOUNDED-01 moves from alpha to beta');
  assert.ok(lineIndexesRead.every((line) => line <= 1),
    `T017-MOTION-BOUNDED-01 reads only the current line and its boundary, got ${JSON.stringify(lineIndexesRead)}`);
  assert.ok(totalSliceUnits <= 256,
    `T017-MOTION-BOUNDED-01 reads only local text ranges, observed ${totalSliceUnits} UTF-16 units`);
  assert.ok(snapshot.lengthUtf16 > 1_000_000, 'T017-MOTION-BOUNDED-01 fixture includes distant 1 MiB content');
  console.log(`T017 bounded adjacent w: ${snapshot.lengthUtf16} UTF-16 units, lineStartOffset calls=${JSON.stringify(lineIndexesRead)}, slice units=${totalSliceUnits}`);
}

function checkInvalidInputs(): void {
  const opened = openTextDocument(asDocumentId('t017-negative'), new TextEncoder().encode('e\u0301 word'));
  if (opened.kind !== 'editable') throw new Error('T017-MOTION-NEGATIVE-01 document failed to open');
  const snapshot = opened.document.snapshot();
  const cursor = createVimMotionCursor(snapshot, asOffset(0));
  if (!cursor.ok) throw new Error('T017-MOTION-NEGATIVE-01 initial cursor failed');
  assert.deepEqual(resolveVimWordMotion(snapshot, cursor.value, { key: 'w', count: 0 }),
    { ok: false, error: { kind: 'invalid-count' } }, 'T017-MOTION-NEGATIVE-01 zero count is rejected');
  assert.deepEqual(resolveVimWordMotion(snapshot, cursor.value, { key: 'w', count: Number.MAX_SAFE_INTEGER + 1 }),
    { ok: false, error: { kind: 'invalid-count' } }, 'T017-MOTION-NEGATIVE-02 unsafe count is rejected');
  assert.deepEqual(resolveVimWordMotion(snapshot, { ...cursor.value, documentVersion: (snapshot.version as number + 1) as typeof snapshot.version }, { key: 'w' }),
    { ok: false, error: { kind: 'stale-document-version' } }, 'T017-MOTION-NEGATIVE-03 stale version is rejected');
  assert.deepEqual(resolveVimWordMotion(snapshot, cursor.value, { key: 'w' }, { tabSize: 0 }),
    { ok: false, error: { kind: 'invalid-option' } }, 'T017-MOTION-NEGATIVE-04 invalid tab size is rejected');
  const interior = createVimMotionCursor(snapshot, asOffset(1));
  assert.deepEqual(interior, { ok: false, error: { kind: 'invalid-cursor' } },
    'T017-MOTION-NEGATIVE-05 a cursor inside a combining grapheme is rejected');
}

function asOffset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error(`T017-MOTION-COORDINATE-02 invalid UTF-16 offset ${value}`);
  return result.value;
}

function asDocumentId(value: string): DocumentId {
  const result = asIdentifier<DocumentId>(value, 'documentId');
  if (!result.ok) throw new Error(`T017-MOTION-DOCUMENT-02 invalid ID ${value}`);
  return result.value;
}

function utf8ColumnToUtf16(line: string, byteColumn0: number): number {
  let byteColumn = 0;
  let utf16Column = 0;
  for (const scalar of line) {
    if (byteColumn === byteColumn0) return utf16Column;
    const bytes = Buffer.byteLength(scalar, 'utf8');
    if (byteColumn + bytes > byteColumn0) throw new Error('T017-MOTION-COORDINATE-03 pinned byte column splits a UTF-8 scalar');
    byteColumn += bytes;
    utf16Column += scalar.length;
  }
  if (byteColumn !== byteColumn0) throw new Error('T017-MOTION-COORDINATE-03 pinned byte column exceeds line');
  return utf16Column;
}
