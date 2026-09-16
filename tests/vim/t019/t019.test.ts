import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTextDocument } from '../../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type LineIndex, type Utf16Offset } from '../../../packages/primitives/src/index';
import { defaultCellWidthPolicy } from '../../../packages/layout/src/index';
import {
  createVimMotionCursor,
  multiplyVimOperatorCounts,
  prepareVimOperator,
  resolveVimMotion,
  resolveVimWordMotion,
  type VimCoreOperator,
  type VimMotionKey,
  type VimOperatorRangeInput,
  type VimOperatorSessionState,
  type VimWordMotionKey,
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
const catalog = JSON.parse(await readFile(resolve(root, 'tests/vim/t019/t019-fixtures.json'), 'utf8')) as FixtureCatalog;
const trace = JSON.parse(await readFile(resolve(root, 'tests/vim/t019/t019-oracle-traces.json'), 'utf8')) as OracleTrace;
const traceById = new Map(trace.fixtures.map((fixture) => [fixture.id, fixture]));
let operatorComparisons = 0;

for (const fixture of catalog.fixtures) {
  const traced = traceById.get(fixture.id);
  assert.ok(traced, `T019-ORACLE-TRACE-01 ${fixture.id} has a pinned Neovim trace`);
  if (traced === undefined) throw new Error(`T019-ORACLE-TRACE-01 missing ${fixture.id}`);
  if (fixture.id === 'T019-ORACLE-FAILED-MOTION-REPEAT-01') {
    verifyFailedMotionPreservesState();
    continue;
  }
  const expected = traced.snapshots[0];
  assert.ok(expected, `T019-ORACLE-TRACE-02 ${fixture.id} has a result snapshot`);
  if (expected === undefined) throw new Error(`T019-ORACLE-TRACE-02 missing result ${fixture.id}`);
  const result = prepareFixture(fixture, expected);
  assert.equal(result.kind, 'prepared', `T019-OPERATOR-PLAN-01 ${fixture.id} produces a plan`);
  if (result.kind !== 'prepared') throw new Error(`T019-OPERATOR-PLAN-01 ${fixture.id} failed: ${JSON.stringify(result)}`);

  const source = documentText(fixture);
  if (result.operator === 'change' && fixture.id === 'T019-ORACLE-CW-TRANSITION-01') {
    const afterDelete = applyEdits(source, result.transaction?.edits ?? []);
    assert.equal(afterDelete, ' beta gamma\n', 'T019-CW-01 cw removes only alpha and preserves its separator');
    assert.equal(expected.lines.join('\n'), `NEW${afterDelete.slice(0, -1)}`,
      'T019-CW-02 oracle insert text starts at the prepared insertion gap');
  } else if (result.operator === 'change' && fixture.id === 'T019-ORACLE-CW-NEXT-LINE-COLUMN-ZERO-01') {
    const afterDelete = applyEdits(source, result.transaction?.edits ?? []);
    assert.equal(afterDelete, '\nbeta tail\n', 'T019-CW-03 cross-line cw preserves the line separator');
    assert.equal(`X${afterDelete}`, serializeOracleText(expected),
      'T019-CW-04 oracle insert text starts on the original line');
  } else if (result.operator === 'change' && fixture.id === 'T019-ORACLE-CC-LINEWISE-TRANSITION-01') {
    const afterDelete = applyEdits(source, result.transaction?.edits ?? []);
    assert.equal(afterDelete, '  \nbeta\n', 'T019-CC-01 cc preserves indentation and the line separator');
    assert.deepEqual(expected.lines, ['  NEW', 'beta'], 'T019-CC-02 inserted replacement follows preserved indentation');
    assert.equal(result.cursorIntent.offset, 2, 'T019-CC-03 Insert cursor begins after the line indentation');
  } else if (result.operator === 'change' && fixture.id === 'T019-ORACLE-CC-COUNTED-TRANSITION-01') {
    const afterDelete = applyEdits(source, result.transaction?.edits ?? []);
    assert.equal(afterDelete, '  \ngamma\n', 'T019-CC-04 counted cc preserves indentation and following line');
    assert.deepEqual(expected.lines, ['  NEW', 'gamma'], 'T019-CC-05 counted cc replaces both selected lines');
    assert.equal(result.cursorIntent.offset, 2, 'T019-CC-06 counted cc starts at the first line indent boundary');
  } else {
    const after = applyEdits(source, result.transaction?.edits ?? []);
    const oracleText = serializeOracleText(expected);
    assert.equal(after, oracleText, `T019-OPERATOR-TEXT-01 ${fixture.id} text equals pinned Neovim`);
  }

  const unnamed = expected.registers['"'] as { readonly lines: readonly string[]; readonly type: string } | undefined;
  assert.ok(unnamed, `T019-OPERATOR-REGISTER-01 ${fixture.id} oracle exposes unnamed register`);
  if (unnamed === undefined) throw new Error(`T019-OPERATOR-REGISTER-01 ${fixture.id} has no unnamed register`);
  assert.deepEqual(result.registerEffect.lines, unnamed.lines,
    `T019-OPERATOR-REGISTER-02 ${fixture.id} register lines match Neovim`);
  assert.equal(result.registerEffect.type, unnamed.type,
    `T019-OPERATOR-REGISTER-03 ${fixture.id} register type matches Neovim`);
  const destinationRegister = expected.registers[result.registerEffect.destination] as { readonly lines: readonly string[]; readonly type: string } | undefined;
  assert.ok(destinationRegister, `T019-OPERATOR-REGISTER-04 ${fixture.id} destination register exists in oracle`);
  if (destinationRegister === undefined) throw new Error(`T019-OPERATOR-REGISTER-04 ${fixture.id} missing destination`);
  assert.deepEqual(result.registerEffect.lines, destinationRegister.lines,
    `T019-OPERATOR-REGISTER-05 ${fixture.id} destination payload matches Neovim`);
  assert.equal(result.registerEffect.rotateNumbered, result.registerEffect.destination === '1' && result.operator !== 'yank',
    `T019-OPERATOR-REGISTER-06 ${fixture.id} only numbered-register deletes rotate the numbered ring`);
  assert.equal(result.mode, fixture.id.includes('CW-') || fixture.id.includes('CC-') ? 'insert' : 'normal',
    `T019-OPERATOR-MODE-01 ${fixture.id} produces the expected mode`);
  if (result.operator === 'change') {
    const expectedInsertGap: Readonly<Record<string, number>> = {
      'T019-ORACLE-CW-TRANSITION-01': 0,
      'T019-ORACLE-CW-COUNT-01': 0,
      'T019-ORACLE-CW-NEXT-LINE-COLUMN-ZERO-01': 0,
      'T019-ORACLE-CC-LINEWISE-TRANSITION-01': 2,
      'T019-ORACLE-CC-COUNTED-TRANSITION-01': 2,
    };
    const gap = expectedInsertGap[fixture.id];
    assert.notEqual(gap, undefined, `T019-CHANGE-CURSOR-01 ${fixture.id} has an oracle insertion-gap expectation`);
    assert.equal(result.cursorIntent.placement, 'insert-gap', `T019-CHANGE-CURSOR-02 ${fixture.id} uses insert-gap placement`);
    assert.equal(result.cursorIntent.offset as number, gap,
      `T019-CHANGE-CURSOR-03 ${fixture.id} starts Insert at the pinned Neovim gap`);
  }
  if (result.operator === 'yank') {
    assert.equal(result.transaction, null, `T019-OPERATOR-YANK-01 ${fixture.id} does not create an edit transaction`);
    assert.equal(result.registerEffect.destination, '0', `T019-OPERATOR-YANK-02 ${fixture.id} uses yank register destination`);
  } else {
    assert.ok(result.transaction, `T019-OPERATOR-TRANSACTION-01 ${fixture.id} has a versioned transaction plan`);
    assert.equal(result.transaction?.expectedVersion, result.sourceVersion,
      `T019-OPERATOR-TRANSACTION-02 ${fixture.id} edit plan retains its base version`);
  }

  if (result.operator !== 'change') {
    const after = applyEdits(source, result.transaction?.edits ?? []);
    const rawCursor = mapOffsetThroughEdits(result.cursorOffset as number, result.transaction?.edits ?? []);
    const mappedCursor = result.operator === 'yank' ? rawCursor : normalizeNormalCursorOffset(after, rawCursor);
    const expectedCursor = oracleCursorOffset(expected, serializeOracleText(expected));
    assert.equal(mappedCursor, expectedCursor,
      `T019-OPERATOR-CURSOR-01 ${fixture.id} cursor boundary matches pinned Neovim`);
  }
  operatorComparisons += 1;
}

assert.equal(trace.fixtureIds.length, catalog.fixtures.length,
  'T019-ORACLE-CATALOG-02 every fixture has a corresponding pinned trace');
assert.deepEqual(trace.fixtureIds, catalog.fixtures.map((fixture) => fixture.id),
  'T019-ORACLE-CATALOG-03 trace order matches fixture order');
assert.deepEqual(multiplyVimOperatorCounts(2, 3), { ok: true, value: 6 },
  'T019-COUNT-01 operator and motion counts multiply');
assert.deepEqual(multiplyVimOperatorCounts(Number.MAX_SAFE_INTEGER, 2),
  { ok: false, error: { kind: 'count-overflow' } }, 'T019-COUNT-02 unsafe multiplication fails before a transaction');
console.log(`T019 operator plans passed ${operatorComparisons} oracle fixtures / text, cursor, mode, register and transaction comparisons`);
console.log('T019 explicit failure checks passed: next-line column zero, empty final line, forced kinds, failed motion and repeat-state preservation');

function prepareFixture(fixture: OracleFixture, expected: OracleSnapshot) {
  const operator: VimCoreOperator = fixture.id.includes('CW-') || fixture.id.includes('CC-') ? 'change'
    : fixture.id.includes('YANK-') ? 'yank' : 'delete';
  const source = documentText(fixture);
  const opened = openTextDocument(asDocumentId(`t019-${fixture.id}`), new TextEncoder().encode(source));
  assert.equal(opened.kind, 'editable', `T019-OWNER-01 ${fixture.id} opens as editable UTF-8`);
  if (opened.kind !== 'editable') throw new Error(`T019-OWNER-01 ${fixture.id} is not editable`);
  const snapshot = opened.document.snapshot();
  const cursorLine = (fixture.cursor?.line ?? 1) - 1;
  const lineStart = snapshot.lineStartOffset(cursorLine as LineIndex);
  assert.ok(lineStart.ok, `T019-COORDINATE-01 ${fixture.id} cursor line exists`);
  if (!lineStart.ok) throw new Error(`T019-COORDINATE-01 ${fixture.id} cursor line unavailable`);
  const lineText = fixture.lines[cursorLine] ?? '';
  const column = utf8ColumnToUtf16(lineText, fixture.cursor?.byteColumn0 ?? 0);
  const originOffset = asOffset((lineStart.value as number) + column);
  const cursor = createVimMotionCursor(snapshot, originOffset);
  assert.ok(cursor.ok, `T019-COORDINATE-02 ${fixture.id} cursor initializes`);
  if (!cursor.ok) throw new Error(`T019-COORDINATE-02 ${fixture.id}: ${JSON.stringify(cursor)}`);

  const config = fixtureMotion(fixture.id);
  const effectiveCount = config.operatorCount * config.motionCount;
  let target = cursor.value;
  let resolvedKind: 'characterwise' | 'linewise' = config.motionKind;
  if (config.motionKey === 'dd' || config.motionKey === 'cc' || config.motionKey === 'yy') {
    resolvedKind = 'linewise';
  } else if (isWordKey(config.motionKey)) {
    const motion = resolveVimWordMotion(snapshot, cursor.value, {
      key: config.motionKey,
      count: effectiveCount,
    });
    assert.ok(motion.ok, `T019-MOTION-01 ${fixture.id} word motion resolves`);
    if (!motion.ok) throw new Error(`T019-MOTION-01 ${fixture.id}: ${JSON.stringify(motion)}`);
    target = motion.value.cursor;
  } else {
    const motion = resolveVimMotion(snapshot, cursor.value, { key: config.motionKey as VimMotionKey });
    assert.ok(motion.ok, `T019-MOTION-01 ${fixture.id} motion resolves`);
    if (!motion.ok) throw new Error(`T019-MOTION-01 ${fixture.id}: ${JSON.stringify(motion)}`);
    target = motion.value.cursor;
    resolvedKind = motion.value.kind;
  }
  const forceKind = config.forceKind;
  const rangeInput: Omit<VimOperatorRangeInput, 'operator'> = {
    origin: {
      documentVersion: snapshot.version,
      offset: cursor.value.offset,
      displayCellColumn: forceKind === 'blockwise'
        ? displayCellAtOffset(snapshot, cursor.value.offset)
        : cursor.value.desiredDisplayCellColumn as number,
    },
    target: {
      documentVersion: snapshot.version,
      offset: target.offset,
      displayCellColumn: forceKind === 'blockwise'
        ? resolvedKind === 'linewise'
          ? target.desiredDisplayCellColumn as number
          : displayCellAtOffset(snapshot, target.offset)
        : target.desiredDisplayCellColumn as number,
    },
    direction: config.direction,
    motionKind: resolvedKind,
    inclusive: config.inclusive,
    motionKey: config.motionKey,
    ...(forceKind === undefined ? {} : { forceKind }),
    ...(config.doubled === true ? { lineCount: effectiveCount } : {}),
  };
  const initialState: VimOperatorSessionState = Object.freeze({
    mode: 'normal',
    repeatTarget: Object.freeze({ operator: 'delete', motionKey: 'x', count: 1 }),
  });
  const prepared = prepareVimOperator(snapshot, {
    operator,
    motion: { ok: true, value: rangeInput },
    operatorCount: config.operatorCount,
    motionCount: config.motionCount,
    ...(config.doubled === undefined ? {} : { doubled: config.doubled }),
    state: initialState,
  });
  assert.ok(prepared.ok, `T019-OPERATOR-02 ${fixture.id} count product is safe`);
  if (!prepared.ok) throw new Error(`T019-OPERATOR-02 ${fixture.id}: ${JSON.stringify(prepared)}`);
  assert.equal(prepared.value.kind, 'prepared', `T019-OPERATOR-03 ${fixture.id} normalizes the range`);
  if (prepared.value.kind !== 'prepared') throw new Error(`T019-OPERATOR-03 ${fixture.id} has no plan`);
  assert.equal(prepared.value.effectiveCount, effectiveCount,
    `T019-COUNT-03 ${fixture.id} passes the multiplied count to the operator`);
  if (operator === 'yank') {
    assert.equal(prepared.value.state.repeatTarget, initialState.repeatTarget,
      `T019-REPEAT-01 ${fixture.id} yank preserves the prior repeat target`);
  } else {
    assert.notEqual(prepared.value.state.repeatTarget, initialState.repeatTarget,
      `T019-REPEAT-02 ${fixture.id} edit operator installs a repeat target`);
  }
  assert.ok(expected.lines.length > 0, `T019-ORACLE-STATE-01 ${fixture.id} has text rows`);
  return {
    ...prepared.value,
    sourceVersion: snapshot.version,
    documentLength: snapshot.lengthUtf16,
  };
}

interface FixtureMotion {
  readonly operatorCount: number;
  readonly motionCount: number;
  readonly motionKey: string;
  readonly direction: 'forward' | 'backward';
  readonly motionKind: 'characterwise' | 'linewise';
  readonly inclusive: boolean;
  readonly doubled?: boolean;
  readonly forceKind?: 'characterwise' | 'linewise' | 'blockwise';
}

function fixtureMotion(id: string): FixtureMotion {
  const known: Readonly<Record<string, FixtureMotion>> = {
    'T019-ORACLE-COUNT-PRODUCT-01': { operatorCount: 2, motionCount: 3, motionKey: 'w', direction: 'forward', motionKind: 'characterwise', inclusive: false },
    'T019-ORACLE-DOUBLED-LINEWISE-01': { operatorCount: 2, motionCount: 1, motionKey: 'dd', direction: 'forward', motionKind: 'linewise', inclusive: false, doubled: true },
    'T019-ORACLE-D0-BACKWARD-EXCLUSIVE-01': { operatorCount: 1, motionCount: 1, motionKey: '0', direction: 'backward', motionKind: 'characterwise', inclusive: false },
    'T019-ORACLE-D-DOLLAR-INCLUSIVE-01': { operatorCount: 1, motionCount: 1, motionKey: '$', direction: 'forward', motionKind: 'characterwise', inclusive: true },
    'T019-ORACLE-BACKWARD-WORD-01': { operatorCount: 1, motionCount: 1, motionKey: 'b', direction: 'backward', motionKind: 'characterwise', inclusive: false },
    'T019-ORACLE-BACKWARD-END-01': { operatorCount: 1, motionCount: 1, motionKey: 'ge', direction: 'backward', motionKind: 'characterwise', inclusive: true },
    'T019-ORACLE-EXCLUSIVE-NEXT-LINE-COLUMN-ZERO-01': { operatorCount: 1, motionCount: 1, motionKey: 'w', direction: 'forward', motionKind: 'characterwise', inclusive: false },
    'T019-ORACLE-DW-INDENTED-EOF-01': { operatorCount: 1, motionCount: 1, motionKey: 'w', direction: 'forward', motionKind: 'characterwise', inclusive: false },
    'T019-ORACLE-EMPTY-LAST-LINE-DELETE-01': { operatorCount: 1, motionCount: 1, motionKey: 'dd', direction: 'forward', motionKind: 'linewise', inclusive: false, doubled: true },
    'T019-ORACLE-FORCED-CHARWISE-01': { operatorCount: 1, motionCount: 1, motionKey: 'j', direction: 'forward', motionKind: 'linewise', inclusive: false, forceKind: 'characterwise' },
    'T019-ORACLE-FORCED-LINEWISE-01': { operatorCount: 1, motionCount: 1, motionKey: 'w', direction: 'forward', motionKind: 'characterwise', inclusive: false, forceKind: 'linewise' },
    'T019-ORACLE-FORCED-BLOCKWISE-01': { operatorCount: 1, motionCount: 1, motionKey: 'j', direction: 'forward', motionKind: 'linewise', inclusive: false, forceKind: 'blockwise' },
    'T019-ORACLE-FORCED-BLOCKWISE-TABS-01': { operatorCount: 1, motionCount: 1, motionKey: 'j', direction: 'forward', motionKind: 'linewise', inclusive: false, forceKind: 'blockwise' },
    'T019-ORACLE-FORCED-BLOCKWISE-TAB-EDGE-EXPANSION-01': { operatorCount: 1, motionCount: 1, motionKey: 'j', direction: 'forward', motionKind: 'linewise', inclusive: false, forceKind: 'blockwise' },
    'T019-ORACLE-FORCED-BLOCKWISE-WIDE-GRAPHEME-01': { operatorCount: 1, motionCount: 1, motionKey: 'j', direction: 'forward', motionKind: 'linewise', inclusive: false, forceKind: 'blockwise' },
    'T019-ORACLE-CW-TRANSITION-01': { operatorCount: 1, motionCount: 1, motionKey: 'w', direction: 'forward', motionKind: 'characterwise', inclusive: false },
    'T019-ORACLE-CW-COUNT-01': { operatorCount: 1, motionCount: 2, motionKey: 'w', direction: 'forward', motionKind: 'characterwise', inclusive: false },
    'T019-ORACLE-CW-NEXT-LINE-COLUMN-ZERO-01': { operatorCount: 1, motionCount: 1, motionKey: 'w', direction: 'forward', motionKind: 'characterwise', inclusive: false },
    'T019-ORACLE-CC-LINEWISE-TRANSITION-01': { operatorCount: 1, motionCount: 1, motionKey: 'cc', direction: 'forward', motionKind: 'linewise', inclusive: false, doubled: true },
    'T019-ORACLE-CC-COUNTED-TRANSITION-01': { operatorCount: 2, motionCount: 1, motionKey: 'cc', direction: 'forward', motionKind: 'linewise', inclusive: false, doubled: true },
    'T019-ORACLE-YANK-LINEWISE-01': { operatorCount: 1, motionCount: 1, motionKey: 'yy', direction: 'forward', motionKind: 'linewise', inclusive: false, doubled: true },
    'T019-ORACLE-YANK-DOUBLED-COUNT-01': { operatorCount: 2, motionCount: 1, motionKey: 'yy', direction: 'forward', motionKind: 'linewise', inclusive: false, doubled: true },
  };
  const value = known[id];
  if (value === undefined) throw new Error(`T019-MOTION-02 no differential motion description for ${id}`);
  return value;
}

function verifyFailedMotionPreservesState(): void {
  const state: VimOperatorSessionState = Object.freeze({
    mode: 'normal',
    repeatTarget: Object.freeze({ operator: 'delete', motionKey: 'w', count: 1 }),
  });
  const opened = openTextDocument(asDocumentId('t019-failed-motion-state'), new TextEncoder().encode('one two three\n'));
  if (opened.kind !== 'editable') throw new Error('T019-FAILED-01 document did not open');
  const snapshot = opened.document.snapshot();
  const invalid = prepareVimOperator(snapshot, {
    operator: 'delete',
    motion: { ok: false, error: { kind: 'motion-failed', reason: 'target-not-found' } },
    state,
  });
  assert.ok(invalid.ok, 'T019-FAILED-02 failed motion is represented as a non-transactional outcome');
  if (!invalid.ok) throw new Error(`T019-FAILED-02 ${JSON.stringify(invalid)}`);
  assert.equal(invalid.value.kind, 'failed', 'T019-FAILED-03 operator does not fabricate a range');
  if (invalid.value.kind !== 'failed') throw new Error('T019-FAILED-03 expected a failed plan');
  assert.equal(invalid.value.transaction, null, 'T019-FAILED-04 no transaction is produced');
  assert.equal(invalid.value.registerEffect, null, 'T019-FAILED-05 no register update is produced');
  assert.equal(invalid.value.state, state, 'T019-FAILED-06 mode and repeat state preserve object identity');
  assert.deepEqual(invalid.value.state.repeatTarget, { operator: 'delete', motionKey: 'w', count: 1 },
    'T019-FAILED-07 the prior successful change remains the repeat target');

  const sameOffset = asOffset(0);
  const emptyRange = prepareVimOperator(snapshot, {
    operator: 'delete',
    motion: {
      ok: true,
      value: {
        origin: { documentVersion: snapshot.version, offset: sameOffset },
        target: { documentVersion: snapshot.version, offset: sameOffset },
        direction: 'forward', motionKind: 'characterwise', inclusive: false, motionKey: 'w',
      },
    },
    state,
  });
  assert.ok(emptyRange.ok && emptyRange.value.kind === 'failed',
    'T019-FAILED-08 empty normalized ranges fail without creating an edit');
  if (emptyRange.ok && emptyRange.value.kind === 'failed') {
    assert.equal(emptyRange.value.transaction, null, 'T019-FAILED-09 empty range has no transaction');
    assert.equal(emptyRange.value.state, state, 'T019-FAILED-10 empty range preserves repeat state identity');
  }
}

function documentText(fixture: OracleFixture): string {
  const lines = fixture.lines.length === 0 ? [''] : fixture.lines;
  return `${lines.join('\n')}${fixture.endOfLine === false ? '' : '\n'}`;
}

function serializeOracleText(snapshot: OracleSnapshot): string {
  return `${snapshot.lines.join('\n')}${snapshot.buffer.endOfLine === false ? '' : '\n'}`;
}

function applyEdits(text: string, edits: readonly { readonly start: Utf16Offset; readonly end: Utf16Offset; readonly text: string }[]): string {
  let result = text;
  for (const edit of [...edits].sort((left, right) => (right.start as number) - (left.start as number))) {
    result = `${result.slice(0, edit.start as number)}${edit.text}${result.slice(edit.end as number)}`;
  }
  return result;
}

function mapOffsetThroughEdits(offset: number, edits: readonly { readonly start: Utf16Offset; readonly end: Utf16Offset; readonly text: string }[]): number {
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
  let lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const nextBreak = text.indexOf('\n', offset);
  const lineEnd = nextBreak < 0 ? text.length : nextBreak;
  if (offset !== lineEnd || lineEnd <= lineStart) return offset;
  const prefix = text.slice(lineStart, lineEnd);
  let prior = 0;
  if (typeof Intl.Segmenter === 'function') {
    for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(prefix)) prior = part.index;
  } else {
    prior = Math.max(0, prefix.length - 1);
    const unit = prefix.charCodeAt(prior);
    if (unit >= 0xdc00 && unit <= 0xdfff && prior > 0) prior -= 1;
  }
  return lineStart + prior;
}

function oracleCursorOffset(snapshot: OracleSnapshot, text: string): number {
  const lineIndex = snapshot.cursor.line - 1;
  const lines = snapshot.lines;
  let start = 0;
  for (let index = 0; index < lineIndex; index += 1) start += (lines[index] ?? '').length + 1;
  const line = lines[lineIndex] ?? '';
  const zeroBasedByteColumn = snapshot.cursor.byteColumn - 1;
  return start + utf8ColumnToUtf16(line, zeroBasedByteColumn);
}

function utf8ColumnToUtf16(line: string, byteColumn0: number): number {
  let bytes = 0;
  let utf16 = 0;
  for (const scalar of line) {
    if (bytes === byteColumn0) return utf16;
    const scalarBytes = Buffer.byteLength(scalar, 'utf8');
    if (bytes + scalarBytes > byteColumn0) throw new Error('T019-COORDINATE-03 oracle byte column splits a UTF-8 scalar');
    bytes += scalarBytes;
    utf16 += scalar.length;
  }
  if (bytes !== byteColumn0) throw new Error('T019-COORDINATE-03 oracle byte column exceeds line');
  return utf16;
}

function displayCellAtOffset(snapshot: import('../../../packages/document/src/index').DocumentSnapshot, offset: Utf16Offset): number {
  const lineResult = snapshot.lineIndexAt(offset);
  if (!lineResult.ok) throw new Error('T019-BLOCK-COORDINATE-01 cursor line lookup failed');
  const lineStart = snapshot.lineStartOffset(lineResult.value as LineIndex);
  if (!lineStart.ok) throw new Error('T019-BLOCK-COORDINATE-01 cursor line start failed');
  const prefix = snapshot.slice(lineStart.value, offset);
  if (!prefix.ok) throw new Error('T019-BLOCK-COORDINATE-01 cursor prefix read failed');
  let cells = 0;
  const widthPolicy = defaultCellWidthPolicy();
  if (typeof Intl.Segmenter !== 'function') throw new Error('T019-BLOCK-COORDINATE-02 grapheme segmentation is unavailable');
  for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(prefix.value)) {
    cells += part.segment === '\t' ? 8 - (cells % 8) : Math.max(1, widthPolicy.widthOfCluster(part.segment));
  }
  return cells;
}

function isWordKey(key: string): key is VimWordMotionKey {
  return key === 'w' || key === 'W' || key === 'b' || key === 'B' || key === 'e' || key === 'E' || key === 'ge' || key === 'gE';
}

function asDocumentId(value: string): DocumentId {
  const result = asIdentifier<DocumentId>(value, 'documentId');
  if (!result.ok) throw new Error(`T019-OWNER-02 invalid document ID ${value}`);
  return result.value;
}

function asOffset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error(`T019-COORDINATE-04 invalid UTF-16 offset ${value}`);
  return result.value;
}
