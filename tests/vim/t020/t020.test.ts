import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTextDocument, type DocumentSnapshot, type LineIndex } from '../../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type Utf16Offset } from '../../../packages/primitives/src/index';
import {
  createVimMotionCursor,
  extendVimVisualTextObject,
  prepareVimOperator,
  resolveVimTextObject,
  vimTextObjectMotion,
  type VimOperatorSessionState,
  type VimTextObjectKey,
  type VimTextObjectRange,
} from '../../../packages/vim/src/index';
import type { OracleFixture, OracleSnapshot } from '../../oracle/types';

interface FixtureCatalog { readonly schemaVersion: number; readonly fixtures: readonly OracleFixture[] }
interface OracleTrace {
  readonly schemaVersion: number;
  readonly oracle: { readonly version: string; readonly binarySha256: string; readonly runtimeDocsSha256: string };
  readonly fixtureIds: readonly string[];
  readonly fixtures: readonly { readonly id: string; readonly snapshots: readonly OracleSnapshot[] }[];
  readonly note: string;
}

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const catalog = JSON.parse(await readFile(resolve(root, 'tests/vim/t020/t020-fixtures.json'), 'utf8')) as FixtureCatalog;
const trace = JSON.parse(await readFile(resolve(root, 'tests/vim/t020/t020-oracle-traces.json'), 'utf8')) as OracleTrace;
const traceById = new Map(trace.fixtures.map((fixture) => [fixture.id, fixture]));
const INITIAL_STATE: VimOperatorSessionState = Object.freeze({
  mode: 'normal',
  repeatTarget: Object.freeze({ operator: 'delete', motionKey: 'x', count: 1 }),
});
let normalComparisons = 0;
let visualComparisons = 0;
let failureComparisons = 0;
let zeroWidthComparisons = 0;

for (const fixture of catalog.fixtures) {
  const oracleFixture = traceById.get(fixture.id);
  assert.ok(oracleFixture, `T020-TRACE-01 ${fixture.id} has pinned state`);
  if (oracleFixture === undefined) throw new Error(`T020-TRACE-01 missing ${fixture.id}`);
  const initial = oracleFixture.snapshots[0];
  assert.ok(initial, `T020-TRACE-02 ${fixture.id} has an initial command snapshot`);
  if (initial === undefined) throw new Error(`T020-TRACE-02 missing initial ${fixture.id}`);
  const expected = oracleFixture.snapshots.at(-1);
  assert.ok(expected, `T020-TRACE-05 ${fixture.id} has a final command snapshot`);
  if (expected === undefined) throw new Error(`T020-TRACE-05 missing final ${fixture.id}`);
  const source = documentText(fixture);
  const opened = openTextDocument(asDocumentId(`t020-${fixture.id}`), new TextEncoder().encode(source));
  assert.equal(opened.kind, 'editable', `T020-OWNER-01 ${fixture.id} opens as editable text`);
  if (opened.kind !== 'editable') throw new Error(`T020-OWNER-01 ${fixture.id} did not open as editable text`);
  const snapshot = opened.document.snapshot();
  const cursor = seededEmptyQuoteCursor(fixture, source) ?? fixtureCursorOffset(fixture, snapshot);
  const visual = visualFixture(fixture.id);

  if (visual !== undefined) {
    const expectedRegisterSnapshot = oracleFixture.snapshots[1];
    assert.ok(expectedRegisterSnapshot, `T020-VISUAL-ORACLE-01 ${fixture.id} has the visual yank snapshot`);
    if (expectedRegisterSnapshot === undefined) throw new Error(`T020-VISUAL-ORACLE-01 missing visual register ${fixture.id}`);
    const selection = visualSelection(fixture, snapshot, cursor, visual);
    const extended = extendVimVisualTextObject(snapshot, selection, { key: visual.key });
    assert.ok(extended.ok, `T020-VISUAL-01 ${fixture.id} resolves text-object expansion`);
    const selected = slice(snapshot, extended.value.start, extended.value.end);
    assert.deepEqual(registerLines(selected, extended.value.kind), register(expectedRegisterSnapshot, 'a').lines,
      `T020-VISUAL-02 ${fixture.id} expanded selection equals Neovim register payload`);
    assert.equal(extended.value.anchor, selection.anchor,
      `T020-VISUAL-03 ${fixture.id} preserves existing selection anchor`);
    assert.equal(extended.value.direction, selection.direction,
      `T020-VISUAL-04 ${fixture.id} preserves forward/backward selection direction`);
    const visualCursor = cursorOffset(initial, fixture.lines);
    assert.equal(extended.value.head, visualCursor,
      `T020-VISUAL-05 ${fixture.id} active endpoint equals the pinned Neovim visual cursor`);
    visualComparisons += 1;
    continue;
  }

  const command = fixture.steps.at(-1)?.keys ?? '';
  const spec = parseOperatorObject(command);
  assert.ok(spec, `T020-COMMAND-01 ${fixture.id} starts with an operator and built-in object`);
  if (spec === undefined) throw new Error(`T020-COMMAND-01 cannot parse ${fixture.id}: ${command}`);
  const motionCursor = createVimMotionCursor(snapshot, cursor);
  assert.ok(motionCursor.ok, `T020-COORDINATE-05 ${fixture.id} initializes the public Vim cursor`);
  if (!motionCursor.ok) throw new Error(`T020-COORDINATE-05 ${fixture.id}: ${JSON.stringify(motionCursor)}`);
  const textCursor = {
    documentVersion: snapshot.version,
    offset: cursor,
    ...(motionCursor.value.desiredDisplayCellColumn === null
      ? {} : { displayCellColumn: motionCursor.value.desiredDisplayCellColumn }),
  };
  const resolved = resolveVimTextObject(snapshot, {
    ...textCursor,
  }, { key: spec.key, count: spec.count });

  if (isFailureFixture(fixture.id)) {
    assert.equal(resolved.ok, false, `T020-FAILURE-01 ${fixture.id} returns an object failure`);
    const expectedFailure = fixture.id.includes('EMPTY') ? 'empty-object' : 'object-not-found';
    assert.equal(resolved.error.kind, expectedFailure, `T020-FAILURE-02 ${fixture.id} has the pinned failure kind`);
    const failurePlan = prepareVimOperator(snapshot, {
      operator: spec.operator,
      motion: { ok: false, error: { kind: 'motion-failed', reason: resolved.error.kind } },
      state: INITIAL_STATE,
    });
    assert.ok(failurePlan.ok, `T020-FAILURE-03 ${fixture.id} failed motion yields a stable operator plan`);
    assert.equal(failurePlan.value.kind, 'failed', `T020-FAILURE-04 ${fixture.id} creates no operator effects`);
    if (failurePlan.value.kind === 'failed') {
      assert.equal(failurePlan.value.transaction, null, `T020-FAILURE-05 ${fixture.id} does not edit text`);
      assert.equal(failurePlan.value.registerEffect, null, `T020-FAILURE-06 ${fixture.id} preserves registers`);
      assert.equal(failurePlan.value.state, INITIAL_STATE, `T020-FAILURE-07 ${fixture.id} preserves prior mode/repeat state`);
    }
    assert.deepEqual(expected.lines, fixture.lines,
      `T020-FAILURE-08 ${fixture.id} leaves oracle text unchanged`);
    failureComparisons += 1;
    continue;
  }

  assert.ok(resolved.ok, `T020-OBJECT-01 ${fixture.id} resolves to a source range`);
  if ((resolved.value.start as number) === (resolved.value.end as number)) {
    verifyEmptyObjectOperator(fixture, snapshot, resolved.value, expected, oracleFixture.snapshots[0], spec);
    zeroWidthComparisons += 1;
    continue;
  }
  const oracleRegister = register(expected, '"');
  const motion = vimTextObjectMotion(snapshot, resolved.value);
  assert.ok(motion.ok, `T020-OPERATOR-01 ${fixture.id} adapts to central operator range normalization`);
  const plan = prepareVimOperator(snapshot, {
    operator: spec.operator,
    motion,
    state: INITIAL_STATE,
  });
  assert.ok(plan.ok, `T020-OPERATOR-02 ${fixture.id} prepares without count failure`);
  assert.equal(plan.value.kind, 'prepared', `T020-OPERATOR-03 ${fixture.id} has a normalized plan`);
  if (plan.value.kind !== 'prepared') throw new Error(`T020-OPERATOR-03 ${fixture.id}: ${JSON.stringify(plan.value)}`);
  assert.deepEqual(plan.value.registerEffect.lines, oracleRegister.lines,
    `T020-REGISTER-01 ${fixture.id} selected lines equal the oracle`);
  assert.equal(plan.value.registerEffect.type, oracleRegister.type,
    `T020-REGISTER-02 ${fixture.id} register type equals the oracle`);
  assert.equal(plan.value.operator, spec.operator, `T020-OPERATOR-04 ${fixture.id} retains d/c/y operator`);
  assert.equal(plan.value.mode, spec.operator === 'change' ? 'insert' : 'normal',
    `T020-OPERATOR-05 ${fixture.id} has the expected command mode`);
  if (spec.operator === 'yank') {
    assert.equal(plan.value.transaction, null, `T020-OPERATOR-06 ${fixture.id} yanks without a text transaction`);
  } else {
    assert.ok(plan.value.transaction, `T020-OPERATOR-07 ${fixture.id} plans a document-owned edit`);
    assert.equal(plan.value.transaction?.expectedVersion, snapshot.version,
      `T020-OPERATOR-08 ${fixture.id} transaction retains source version`);
  }
  const finalText = applyEdits(source, plan.value.transaction?.edits ?? []);
  if (spec.operator === 'change') {
    const insertionOffset = plan.value.cursorIntent.offset as number;
    const changedText = `${finalText.slice(0, insertionOffset)}${spec.insertText}${finalText.slice(insertionOffset)}`;
    assert.equal(changedText, serializeOracleText(expected),
      `T020-OPERATOR-09 ${fixture.id} change plus Insert text equals Neovim`);
  } else {
    assert.equal(finalText, serializeOracleText(expected),
      `T020-OPERATOR-10 ${fixture.id} delete/yank text equals Neovim`);
    const mappedCursor = spec.operator === 'yank' ? plan.value.cursorOffset as number
      : normalizeNormalCursorOffset(finalText, mapOffsetThroughEdits(plan.value.cursorOffset as number, plan.value.transaction?.edits ?? []));
    assert.equal(mappedCursor, cursorOffset(expected, fixture.lines),
      `T020-OPERATOR-11 ${fixture.id} cursor equals pinned Neovim`);
  }
  const selectedText = slice(snapshot, resolved.value.start, resolved.value.end);
  assert.deepEqual(registerLines(selectedText, resolved.value.kind), oracleRegister.lines,
    `T020-RANGE-01 ${fixture.id} range payload equals pinned register text`);
  normalComparisons += 1;
}

assert.equal(trace.fixtureIds.length, catalog.fixtures.length,
  'T020-TRACE-03 every fixture is pinned');
assert.deepEqual(trace.fixtureIds, catalog.fixtures.map((fixture) => fixture.id),
  'T020-TRACE-04 pinned fixture order matches catalog');
assert.equal(normalComparisons + visualComparisons + failureComparisons + zeroWidthComparisons, catalog.fixtures.length,
  'T020-CATALOG-01 every fixture is covered by a production-path assertion');
console.log(`T020 passed ${normalComparisons} normal d/c/y, ${visualComparisons} visual, ${failureComparisons} malformed-object failure, and ${zeroWidthComparisons} zero-width d/c/y comparisons across ${catalog.fixtures.length} pinned fixtures.`);
console.log('Pinned oracle: Neovim 0.12.4, binary sha256 d9635db0b272b7c81cd705ef0d8bbf16edfeb05b08b36b4228ab0d6a92ec384f.');

interface OperatorObject { readonly operator: 'delete' | 'change' | 'yank'; readonly key: VimTextObjectKey; readonly count: number; readonly insertText: string }
function parseOperatorObject(command: string): OperatorObject | undefined {
  for (let operatorIndex = 0; operatorIndex < command.length; operatorIndex += 1) {
    const first = command[operatorIndex];
    if (first !== 'd' && first !== 'c' && first !== 'y') continue;
    let index = operatorIndex + 1;
    while (/\d/u.test(command[index] ?? '')) index += 1;
    const key = command.slice(index, index + 2) as VimTextObjectKey;
    if (!isTextObjectKey(key)) continue;
    const count = index === operatorIndex + 1 ? 1 : Number(command.slice(operatorIndex + 1, index));
    const escape = command.indexOf('<Esc>', index + 2);
    const insertText = first === 'c' && escape >= 0 ? command.slice(index + 2, escape) : '';
    return { operator: first === 'd' ? 'delete' : first === 'c' ? 'change' : 'yank', key, count, insertText };
  }
  return undefined;
}

function isTextObjectKey(key: string): key is VimTextObjectKey {
  return /^(?:i|a)(?:w|W|s|p|t|"|'|`|[()b\[\]{}B<>])$/u.test(key);
}

function visualFixture(id: string): { readonly key: VimTextObjectKey; readonly direction: 'forward' | 'backward'; readonly kind: 'characterwise' | 'linewise'; readonly headDelta?: number } | undefined {
  if (id === 'T020-ORACLE-VAS-SENTENCE-01') return { key: 'as', direction: 'forward', kind: 'characterwise' };
  if (id === 'T020-ORACLE-VIP-PARAGRAPH-01') return { key: 'ip', direction: 'forward', kind: 'linewise' };
  if (id === 'T020-ORACLE-VIW-EXPAND-FORWARD-01') return { key: 'iw', direction: 'forward', kind: 'characterwise', headDelta: 6 };
  if (id === 'T020-ORACLE-VIW-EXPAND-BACKWARD-01') return { key: 'iw', direction: 'backward', kind: 'characterwise', headDelta: -9 };
  if (id === 'T020-ORACLE-VAT-NESTED-TAG-01') return { key: 'at', direction: 'forward', kind: 'characterwise' };
  return undefined;
}

function visualSelection(
  fixture: OracleFixture,
  snapshot: DocumentSnapshot,
  cursor: Utf16Offset,
  spec: NonNullable<ReturnType<typeof visualFixture>>,
): Parameters<typeof extendVimVisualTextObject>[1] {
  const anchor = spec.headDelta === undefined ? cursor
    : spec.direction === 'forward' ? asOffset(0) : cursor;
  const head = spec.headDelta === undefined ? cursor
    : spec.direction === 'forward' ? asOffset(spec.headDelta) : asOffset((cursor as number) + spec.headDelta);
  if (anchor === null || head === null) throw new Error(`T020-VISUAL-COORDINATE-01 ${fixture.id} has a valid anchor and head`);
  return {
    documentVersion: snapshot.version,
    anchor,
    head,
    direction: spec.direction,
    kind: spec.kind,
  };
}

function verifyEmptyObjectOperator(
  fixture: OracleFixture,
  snapshot: DocumentSnapshot,
  objectRange: VimTextObjectRange,
  expected: OracleSnapshot,
  before: OracleSnapshot | undefined,
  spec: OperatorObject,
): void {
  const motion = vimTextObjectMotion(snapshot, objectRange);
  assert.ok(motion.ok, `T020-ZERO-WIDTH-01 ${fixture.id} adapts the empty object range`);
  const plan = prepareVimOperator(snapshot, {
    operator: spec.operator,
    motion,
    state: INITIAL_STATE,
  });
  assert.ok(plan.ok, `T020-ZERO-WIDTH-02 ${fixture.id} prepares the zero-width operator`);
  assert.equal(plan.value.kind, 'prepared', `T020-ZERO-WIDTH-03 ${fixture.id} produces a zero-width plan`);
  if (plan.value.kind !== 'prepared') throw new Error(`T020-ZERO-WIDTH-03 ${fixture.id}: ${JSON.stringify(plan.value)}`);
  assert.equal(plan.value.transaction, null, `T020-ZERO-WIDTH-04 ${fixture.id} creates no text transaction`);
  assert.equal(plan.value.cursorOffset, objectRange.start,
    `T020-ZERO-WIDTH-05 ${fixture.id} places the cursor at the empty inner-object gap`);
  assert.equal(plan.value.mode, spec.operator === 'change' ? 'insert' : 'normal',
    `T020-ZERO-WIDTH-06 ${fixture.id} enters Insert only for change`);
  assert.equal(Boolean(plan.value.registerEffect.noOp), spec.operator !== 'yank',
    `T020-ZERO-WIDTH-07 ${fixture.id} distinguishes register-preserving no-op from empty yank`);

  const expectedUnnamed = register(expected, '"');
  if (spec.operator === 'yank') {
    assert.deepEqual(plan.value.registerEffect.lines, expectedUnnamed.lines,
      `T020-ZERO-WIDTH-08 ${fixture.id} register lines match the oracle`);
    assert.equal(plan.value.registerEffect.type, expectedUnnamed.type,
      `T020-ZERO-WIDTH-09 ${fixture.id} register type matches the oracle`);
    assert.equal(plan.value.registerEffect.destination, '0',
      `T020-ZERO-WIDTH-10 ${fixture.id} writes an empty yank to register zero`);
    assert.equal(plan.value.registerEffect.alsoUnnamed, true,
      `T020-ZERO-WIDTH-11 ${fixture.id} updates the unnamed register`);
    if (before !== undefined) {
      assert.deepEqual(register(expected, 'a'), register(before, 'a'),
        `T020-ZERO-WIDTH-12 ${fixture.id} preserves the previously named register`);
    }
  } else {
    assert.equal(plan.value.registerEffect.alsoUnnamed, false,
      `T020-ZERO-WIDTH-13 ${fixture.id} preserves existing registers`);
    if (before !== undefined) assert.deepEqual(expected.registers, before.registers,
      `T020-ZERO-WIDTH-14 ${fixture.id} leaves all register state unchanged`);
  }

  const source = documentText(fixture);
  const command = fixture.steps.at(-1)?.keys ?? '';
  const insertion = spec.operator === 'change' ? /ci["'`]([\s\S]*?)<Esc>/u.exec(command)?.[1] ?? '' : '';
  const actualText = spec.operator === 'change'
    ? `${source.slice(0, objectRange.start as number)}${insertion}${source.slice(objectRange.end as number)}`
    : source;
  assert.equal(actualText, serializeOracleText(expected),
    `T020-ZERO-WIDTH-15 ${fixture.id} resulting text equals pinned Neovim`);
  assert.equal(plan.value.cursorOffset, cursorOffset(expected, fixture.lines),
    `T020-ZERO-WIDTH-16 ${fixture.id} cursor equals pinned Neovim`);
}

function isFailureFixture(id: string): boolean {
  return id.includes('UNCLOSED');
}

function fixtureCursorOffset(
  fixture: OracleFixture,
  snapshot: DocumentSnapshot,
): Utf16Offset {
  const lineIndex = (fixture.cursor?.line ?? 1) - 1;
  const start = snapshot.lineStartOffset(lineIndex as LineIndex);
  assert.ok(start.ok, `T020-COORDINATE-01 ${fixture.id} cursor line exists`);
  if (!start.ok) throw new Error(`T020-COORDINATE-01 ${fixture.id} cursor line unavailable`);
  const line = fixture.lines[lineIndex] ?? '';
  return asOffset((start.value as number) + utf8ColumnToUtf16(line, fixture.cursor?.byteColumn0 ?? 0));
}

function seededEmptyQuoteCursor(
  fixture: OracleFixture,
  source: string,
): Utf16Offset | null {
  if (!fixture.id.includes('EMPTY-REGISTER')) return null;
  const quote = source.indexOf('""');
  return quote < 0 ? null : asOffset(quote);
}

function cursorOffset(snapshot: OracleSnapshot, initialLines: readonly string[]): number {
  const lineIndex = snapshot.cursor.line - 1;
  let start = 0;
  for (let index = 0; index < lineIndex; index += 1) start += (initialLines[index] ?? '').length + 1;
  return start + utf8ColumnToUtf16(snapshot.lines[lineIndex] ?? '', snapshot.cursor.byteColumn - 1);
}

function register(snapshot: OracleSnapshot, key: string): { readonly lines: readonly string[]; readonly type: string } {
  const value = snapshot.registers[key] as { readonly lines?: readonly string[]; readonly type?: string } | undefined;
  assert.ok(value, `T020-REGISTER-03 oracle snapshot contains register ${key}`);
  if (value === undefined) throw new Error(`T020-REGISTER-03 missing register ${key}`);
  return { lines: value.lines ?? [], type: value.type ?? '' };
}

function serializeOracleText(snapshot: OracleSnapshot): string {
  return `${snapshot.lines.join('\n')}${snapshot.buffer.endOfLine === false ? '' : '\n'}`;
}

function applyEdits(
  text: string,
  edits: readonly { readonly start: Utf16Offset; readonly end: Utf16Offset; readonly text: string }[],
): string {
  let result = text;
  for (const edit of [...edits].sort((left, right) => (right.start as number) - (left.start as number))) {
    result = `${result.slice(0, edit.start as number)}${edit.text}${result.slice(edit.end as number)}`;
  }
  return result;
}

function mapOffsetThroughEdits(
  offset: number,
  edits: readonly { readonly start: Utf16Offset; readonly end: Utf16Offset; readonly text: string }[],
): number {
  let mapped = offset;
  for (const edit of [...edits].sort((left, right) => (left.start as number) - (right.start as number))) {
    const start = edit.start as number;
    const end = edit.end as number;
    if (mapped < start) break;
    if (mapped <= end) return start + edit.text.length;
    mapped += edit.text.length - (end - start);
  }
  return mapped;
}

function normalizeNormalCursorOffset(text: string, offset: number): number {
  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const nextBreak = text.indexOf('\n', offset);
  const lineEnd = nextBreak < 0 ? text.length : nextBreak;
  if (offset !== lineEnd || lineEnd <= lineStart) return offset;
  const line = text.slice(lineStart, lineEnd);
  let previous = 0;
  if (typeof Intl.Segmenter === 'function') {
    for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)) previous = part.index;
  } else {
    previous = Math.max(0, line.length - 1);
    const unit = line.charCodeAt(previous);
    if (unit >= 0xdc00 && unit <= 0xdfff && previous > 0) previous -= 1;
  }
  return lineStart + previous;
}

function documentText(fixture: OracleFixture): string {
  const lines = fixture.lines.length === 0 ? [''] : fixture.lines;
  return `${lines.join('\n')}${fixture.endOfLine === false ? '' : '\n'}`;
}

function slice(snapshot: DocumentSnapshot, start: Utf16Offset, end: Utf16Offset): string {
  const result = snapshot.slice(start, end);
  assert.ok(result.ok, 'T020-RANGE-02 selected source range is readable');
  return result.value ?? '';
}

function registerLines(text: string, kind: 'characterwise' | 'linewise'): readonly string[] {
  if (kind === 'linewise') {
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.length === 0 ? [''] : lines;
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function utf8ColumnToUtf16(text: string, byteColumn0: number): number {
  let bytes = 0;
  let units = 0;
  for (const scalar of text) {
    if (bytes === byteColumn0) return units;
    const size = Buffer.byteLength(scalar, 'utf8');
    if (bytes + size > byteColumn0) throw new Error('T020-COORDINATE-02 oracle byte column splits UTF-8 scalar');
    bytes += size;
    units += scalar.length;
  }
  if (bytes !== byteColumn0) throw new Error('T020-COORDINATE-03 oracle byte column exceeds line');
  return units;
}

function asDocumentId(value: string): DocumentId {
  const parsed = asIdentifier<DocumentId>(value, 'documentId');
  if (!parsed.ok) throw new Error(`T020-OWNER-02 invalid fixture document id ${value}`);
  return parsed.value;
}

function asOffset(value: number): Utf16Offset {
  const parsed = asUtf16Offset(value);
  if (!parsed.ok) throw new Error(`T020-COORDINATE-04 invalid UTF-16 offset ${value}`);
  return parsed.value;
}
