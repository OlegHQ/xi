import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTextDocument, type DocumentSnapshot } from '../../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type LineIndex, type Utf16Offset } from '../../../packages/primitives/src/index';
import {
  createVimMotionCursor,
  resolveVimFind,
  type VimFindInvocation,
  type VimFindOutcome,
  type VimLastFind,
} from '../../../packages/vim/src/index';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture, OracleFixtureResult, OracleSnapshot } from '../../oracle/types';

interface FindFixtureCatalog {
  readonly schemaVersion: number;
  readonly fixtures: readonly OracleFixture[];
}

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const catalog = JSON.parse(await readFile(resolve(root, 'tests/vim/motions/t018-find-cases.json'), 'utf8')) as FindFixtureCatalog;
assert.equal(catalog.schemaVersion, 1, 'T018-FIND-FIXTURE-01 catalog schema is supported');
const oracle = await verifyOracleBundle();
const oracleResults = new Map<string, OracleFixtureResult>();
for (const fixture of catalog.fixtures) oracleResults.set(fixture.id, await runOracleFixture(fixture, oracle.binaryPath));

let cursorComparisons = 0;
const countFixture = fixture('T018-FIND-COUNT-AND-TILL-01');
await compareSequence(countFixture, [
  { label: 'f-first', invocation: { key: 'f', target: 'X' } },
  { label: 'f-count-two', invocation: { key: 'f', target: 'X', count: 2 } },
  { label: 't-next', invocation: { key: 't', target: 'X' } },
  { label: 'F-previous', invocation: { key: 'F', target: 'X' } },
  { label: 'T-previous-till', invocation: { key: 'T', target: 'X' } },
  { label: 'f-count-after-till', invocation: { key: 'f', target: 'X', count: 2 } },
], (outcome, label) => {
  assert.equal(outcome.kind, 'found', `T018-FIND-DIRECTION-01 ${label} resolves a match`);
  if (outcome.kind === 'found') assert.equal(outcome.motion.inclusive, true, `T018-FIND-OPERATOR-KIND-01 ${label} is inclusive`);
});

const repeatFixture = fixture('T018-FIND-REPEAT-DIRECTION-01');
await compareSequence(repeatFixture, [
  { label: 't-first', invocation: { key: 't', target: 'X' } },
  { label: 'semicolon-repeats-till', invocation: { key: ';' } },
  { label: 'comma-reverses-till', invocation: { key: ',' } },
  { label: 'semicolon-still-repeats-original-direction', invocation: { key: ';' } },
  { label: 'f-switches-last-find', invocation: { key: 'f', target: 'X' } },
  { label: 'semicolon-repeats-forward-find', invocation: { key: ';' } },
  { label: 'counted-comma-reverses-find', invocation: { key: ',', count: 2 } },
  { label: 'semicolon-after-reverse', invocation: { key: ';' } },
], (outcome, label) => {
  assert.equal(outcome.kind, 'found', `T018-FIND-REPEAT-01 ${label} resolves a match`);
});

const missingFixture = fixture('T018-FIND-MISSING-STATE-01');
const missingSnapshots = snapshots(missingFixture.id);
await compareSequence(missingFixture, [
  { label: 'successful-find-X', invocation: { key: 'f', target: 'X' } },
  { label: 'missing-target-Z', invocation: { key: 'f', target: 'Z' } },
  { label: 'semicolon-repeats-failed-Z', invocation: { key: ';' } },
  { label: 'comma-reverses-failed-Z', invocation: { key: ',' } },
], (outcome, label) => {
  if (label === 'successful-find-X') {
    assert.equal(outcome.kind, 'found', 'T018-FIND-MISSING-01 prior X find succeeds');
    return;
  }
  assert.equal(outcome.kind, 'no-match', `T018-FIND-MISSING-01 ${label} retains failed Z target`);
  assert.equal(outcome.lastFind?.target, 'Z', `T018-FIND-MISSING-01 ${label} repeat target is Z`);
});
assertStateUnchanged(snapshot(missingSnapshots, 'successful-find-X'), snapshot(missingSnapshots, 'missing-target-Z'), 'T018-FIND-MISSING-STATE-01 direct miss');
assertStateUnchanged(snapshot(missingSnapshots, 'missing-target-Z'), snapshot(missingSnapshots, 'semicolon-repeats-failed-Z'), 'T018-FIND-MISSING-STATE-01 semicolon replay');
assertStateUnchanged(snapshot(missingSnapshots, 'semicolon-repeats-failed-Z'), snapshot(missingSnapshots, 'comma-reverses-failed-Z'), 'T018-FIND-MISSING-STATE-01 comma replay');

const combiningFixture = fixture('T018-FIND-MULTIBYTE-COMBINING-01');
await compareSequence(combiningFixture, [
  { label: 'find-composed-grapheme', invocation: { key: 'f', target: 'e\u0301' } },
  { label: 'find-multibyte-scalar', invocation: { key: 'f', target: 'é' } },
  { label: 'counted-find-multibyte-scalar', invocation: { key: 'f', target: 'é', count: 2 } },
], (outcome, label) => {
  if (label === 'counted-find-multibyte-scalar') assert.equal(outcome.kind, 'no-match', 'T018-FIND-COMBINING-01 insufficient count fails without moving');
  else assert.equal(outcome.kind, 'found', `T018-FIND-COMBINING-01 ${label} resolves`);
});

const baseCombiningFixture = fixture('T018-FIND-BASE-COMBINING-01');
await compareSequence(baseCombiningFixture, [
  { label: 'find-base-with-composing-mark', invocation: { key: 'f', target: 'e' } },
], (outcome) => assert.equal(outcome.kind, 'found', 'T018-FIND-BASE-COMBINING-01 plain base matches a decomposed grapheme'));

const supplementaryFixture = fixture('T018-FIND-SUPPLEMENTARY-MAPPED-01');
await compareSequence(supplementaryFixture, [
  { label: 'find-supplementary-scalar', invocation: { key: 'f', target: '😀' } },
  { label: 'counted-find-supplementary-scalar', invocation: { key: 'f', target: '😀', count: 2 } },
], (outcome, label) => assert.equal(outcome.kind, 'found', `T018-FIND-SUPPLEMENTARY-01 ${label} resolves against mapped Neovim input`));

checkAdjacentTillAndContextRecovery();
checkInvalidInputs();
console.log(`T018 find/till passed ${cursorComparisons} Neovim cursor/desired-column comparisons; failure, repeat-state, and Unicode fixtures passed`);
console.log(`oracle=Neovim ${oracle.manifest.oracle.version}; binary=${oracle.manifest.oracle.binarySha256}; runtimeDocs=${oracle.manifest.oracle.runtimeDocs.sha256}`);

function fixture(id: string): OracleFixture {
  const found = catalog.fixtures.find((entry) => entry.id === id);
  assert.ok(found, `T018-FIND-FIXTURE-01 ${id} exists`);
  if (found === undefined) throw new Error(`T018-FIND-FIXTURE-01 missing ${id}`);
  return found;
}

function snapshots(id: string): readonly OracleSnapshot[] {
  const found = oracleResults.get(id);
  assert.ok(found, `T018-FIND-ORACLE-01 ${id} oracle result exists`);
  if (found === undefined) throw new Error(`T018-FIND-ORACLE-01 missing result ${id}`);
  return found.snapshots;
}

function snapshot(source: readonly OracleSnapshot[], label: string): OracleSnapshot {
  const found = source.find((entry) => entry.label === label);
  assert.ok(found, `T018-FIND-ORACLE-01 snapshot ${label} exists`);
  if (found === undefined) throw new Error(`T018-FIND-ORACLE-01 missing snapshot ${label}`);
  return found;
}

async function compareSequence(
  sourceFixture: OracleFixture,
  sequence: readonly { readonly label: string; readonly invocation: VimFindInvocation }[],
  inspect?: (outcome: VimFindOutcome, label: string) => void,
): Promise<void> {
  const opened = openTextDocument(asDocumentId(sourceFixture.id), new TextEncoder().encode(sourceFixture.lines.join('\n')));
  assert.equal(opened.kind, 'editable', `T018-FIND-DOCUMENT-01 ${sourceFixture.id} opens as editable UTF-8`);
  if (opened.kind !== 'editable') throw new Error(`T018-FIND-DOCUMENT-01 ${sourceFixture.id} failed to open`);
  const doc = opened.document;
  const docSnapshot = doc.snapshot();
  const cursorLineIndex = (sourceFixture.cursor?.line ?? 1) - 1;
  const lineStartResult = docSnapshot.lineStartOffset(cursorLineIndex as LineIndex);
  assert.equal(lineStartResult.ok, true, `T018-FIND-COORDINATE-01 ${sourceFixture.id} has a valid starting line`);
  if (!lineStartResult.ok) throw new Error(`T018-FIND-COORDINATE-01 ${sourceFixture.id} line start failed`);
  const startLineText = sourceFixture.lines[cursorLineIndex] ?? '';
  const startUtf16Column = utf8ColumnToUtf16(startLineText, sourceFixture.cursor?.byteColumn0 ?? 0);
  const startOffset = asUtf16Offset((lineStartResult.value as number) + startUtf16Column);
  assert.equal(startOffset.ok, true, `T018-FIND-COORDINATE-01 ${sourceFixture.id} starts on a UTF-16 boundary`);
  if (!startOffset.ok) throw new Error(`T018-FIND-COORDINATE-01 ${sourceFixture.id} start offset invalid`);
  const initial = createVimMotionCursor(docSnapshot, startOffset.value);
  assert.equal(initial.ok, true, `T018-FIND-COORDINATE-01 ${sourceFixture.id} cursor initializes`);
  if (!initial.ok) throw new Error(`T018-FIND-COORDINATE-01 ${sourceFixture.id} cursor init failed`);
  let cursor = initial.value;
  let lastFind: VimLastFind | null = null;
  const expectedSnapshots = snapshots(sourceFixture.id);
  for (const step of sequence) {
    const resolved = resolveVimFind(docSnapshot, cursor, step.invocation, lastFind);
    assert.equal(resolved.ok, true, `T018-FIND-RESOLVE-01 ${sourceFixture.id}/${step.label} resolves valid input`);
    if (!resolved.ok) throw new Error(`T018-FIND-RESOLVE-01 ${sourceFixture.id}/${step.label}: ${JSON.stringify(resolved)}`);
    const outcome = resolved.value;
    if (inspect !== undefined) inspect(outcome, step.label);
    cursor = outcome.cursor;
    lastFind = outcome.lastFind;
    const expected = snapshot(expectedSnapshots, step.label);
    assertOracleCursor(docSnapshot, cursor, expected, `${sourceFixture.id}/${step.label}`);
    cursorComparisons += 1;
  }
  assert.equal(doc.snapshot().version, docSnapshot.version, `T018-FIND-PURITY-01 ${sourceFixture.id} resolver leaves document unchanged`);
  const fullText = docSnapshot.slice(asOffset(0), asOffset(docSnapshot.lengthUtf16));
  assert.equal(fullText.ok, true, `T018-FIND-PURITY-01 ${sourceFixture.id} text remains readable`);
  if (fullText.ok) assert.equal(fullText.value, sourceFixture.lines.join('\n'), `T018-FIND-PURITY-01 ${sourceFixture.id} text is unchanged`);
}

function assertOracleCursor(docSnapshot: DocumentSnapshot, cursor: { readonly offset: Utf16Offset; readonly desiredDisplayCellColumn: number | null }, expected: OracleSnapshot, label: string): void {
  const expectedLineIndex = expected.cursor.line - 1;
  const lineStartResult = docSnapshot.lineStartOffset(expectedLineIndex as LineIndex);
  assert.equal(lineStartResult.ok, true, `T018-FIND-ORACLE-01 ${label} expected line exists`);
  if (!lineStartResult.ok) throw new Error(`T018-FIND-ORACLE-01 ${label} expected line unavailable`);
  const lineText = expected.lines[expectedLineIndex] ?? '';
  const expectedColumn = utf8ColumnToUtf16(lineText, expected.cursor.byteColumn - 1);
  assert.equal(cursor.offset as number, (lineStartResult.value as number) + expectedColumn, `T018-FIND-ORACLE-01 ${label} UTF-16 cursor matches Neovim`);
  assert.equal(cursor.desiredDisplayCellColumn, expected.cursor.desiredColumn, `T018-FIND-ORACLE-01 ${label} desired display column matches Neovim`);
}

function checkAdjacentTillAndContextRecovery(): void {
  const adjacent = fixture('T018-FIND-ADJACENT-OPERATOR-01');
  const opened = openTextDocument(asDocumentId('t018-adjacent-local'), new TextEncoder().encode(adjacent.lines.join('\n')));
  if (opened.kind !== 'editable') throw new Error('T018-FIND-ADJACENT-01 document did not open');
  const docSnapshot = opened.document.snapshot();
  const start = asOffset(0);
  const initial = createVimMotionCursor(docSnapshot, start);
  if (!initial.ok) throw new Error('T018-FIND-ADJACENT-01 initial cursor failed');
  const resolved = resolveVimFind(docSnapshot, initial.value, { key: 't', target: 'b' }, null);
  assert.equal(resolved.ok, true, 'T018-FIND-ADJACENT-01 adjacent target resolves');
  if (!resolved.ok || resolved.value.kind !== 'found') throw new Error('T018-FIND-ADJACENT-01 adjacent till did not resolve');
  assert.equal(resolved.value.cursor.offset, initial.value.offset, 'T018-FIND-ADJACENT-01 adjacent till endpoint is current grapheme');
  assert.equal(resolved.value.moved, false, 'T018-FIND-ADJACENT-01 adjacent till reports no cursor movement');
  assert.equal(resolved.value.motion.inclusive, true, 'T018-FIND-ADJACENT-01 endpoint remains operator-inclusive');
  const adjacentStates = snapshots(adjacent.id);
  assert.deepEqual(snapshot(adjacentStates, 'adjacent-till-delete').lines, ['b'], 'T018-FIND-ADJACENT-01 Neovim dtb deletes the current character');

  const operatorFixture = fixture('T018-FIND-OPERATOR-FAILURE-01');
  const operatorStates = snapshots(operatorFixture.id);
  const operatorSeed = snapshot(operatorStates, 'seed-register');
  const operatorAfter = snapshot(operatorStates, 'failed-delete-find');
  assertStateUnchanged(operatorSeed, operatorAfter, 'T018-FIND-OPERATOR-FAILURE-01 exact document/cursor/register/selection');
  assertStateUnchanged(operatorAfter, snapshot(operatorStates, 'repeat-failed-operator-find-forward'), 'T018-FIND-OPERATOR-FAILURE-01 semicolon repeats missing target');
  assertStateUnchanged(snapshot(operatorStates, 'repeat-failed-operator-find-forward'), snapshot(operatorStates, 'repeat-failed-operator-find-reverse'), 'T018-FIND-OPERATOR-FAILURE-01 comma repeats missing target');
  const operatorOpen = openTextDocument(asDocumentId('t018-operator-local'), new TextEncoder().encode(operatorFixture.lines.join('\n')));
  if (operatorOpen.kind !== 'editable') throw new Error('T018-FIND-OPERATOR-FAILURE-01 local document failed to open');
  const operatorSnapshot = operatorOpen.document.snapshot();
  const operatorStart = createVimMotionCursor(operatorSnapshot, asOffset(0));
  if (!operatorStart.ok) throw new Error('T018-FIND-OPERATOR-FAILURE-01 local cursor failed');
  const operatorFailure = resolveVimFind(operatorSnapshot, operatorStart.value, { key: 'f', target: 'Z' }, null, { context: 'operator-pending' });
  assert.equal(operatorFailure.ok, true, 'T018-FIND-OPERATOR-FAILURE-01 missing target is a handled no-match');
  if (!operatorFailure.ok) throw new Error('T018-FIND-OPERATOR-FAILURE-01 resolver failure');
  assert.equal(operatorFailure.value.kind, 'no-match', 'T018-FIND-OPERATOR-FAILURE-01 no match returned');
  assert.equal(operatorFailure.value.lastFind?.target, 'Z', 'T018-FIND-OPERATOR-FAILURE-01 failed target is remembered');
  assert.equal(operatorFailure.value.recovery, 'cancel-operator', 'T018-FIND-OPERATOR-FAILURE-01 pending operator must cancel');
  let operatorRepeatState = operatorFailure.value.lastFind;
  for (const key of [';', ','] as const) {
    const repeated = resolveVimFind(operatorSnapshot, operatorFailure.value.cursor, { key }, operatorRepeatState);
    assert.equal(repeated.ok, true, `T018-FIND-OPERATOR-FAILURE-01 ${key} is handled after cancellation`);
    if (!repeated.ok) throw new Error(`T018-FIND-OPERATOR-FAILURE-01 repeat resolver failed`);
    assert.equal(repeated.value.kind, 'no-match', `T018-FIND-OPERATOR-FAILURE-01 ${key} retains the failed Z target`);
    assert.equal(repeated.value.lastFind?.target, 'Z', `T018-FIND-OPERATOR-FAILURE-01 ${key} target remains Z`);
    operatorRepeatState = repeated.value.lastFind;
  }

  const visualFixture = fixture('T018-FIND-VISUAL-FAILURE-01');
  const visualStates = snapshots(visualFixture.id);
  const visualBefore = snapshot(visualStates, 'enter-visual');
  const visualAfter = snapshot(visualStates, 'failed-visual-find');
  assertStateUnchanged(visualBefore, visualAfter, 'T018-FIND-VISUAL-FAILURE-01 exact document/cursor/register/selection');
  assertStateUnchanged(visualAfter, snapshot(visualStates, 'repeat-failed-visual-find-forward'), 'T018-FIND-VISUAL-FAILURE-01 semicolon repeats missing target');
  assertStateUnchanged(snapshot(visualStates, 'repeat-failed-visual-find-forward'), snapshot(visualStates, 'repeat-failed-visual-find-reverse'), 'T018-FIND-VISUAL-FAILURE-01 comma repeats missing target');
  const visualOpen = openTextDocument(asDocumentId('t018-visual-local'), new TextEncoder().encode(visualFixture.lines.join('\n')));
  if (visualOpen.kind !== 'editable') throw new Error('T018-FIND-VISUAL-FAILURE-01 local document failed to open');
  const visualSnapshot = visualOpen.document.snapshot();
  const visualStart = createVimMotionCursor(visualSnapshot, asOffset(1));
  if (!visualStart.ok) throw new Error('T018-FIND-VISUAL-FAILURE-01 local cursor failed');
  const visualFailure = resolveVimFind(visualSnapshot, visualStart.value, { key: 'f', target: 'Z' }, null, { context: 'visual' });
  assert.equal(visualFailure.ok, true, 'T018-FIND-VISUAL-FAILURE-01 missing target is a handled no-match');
  if (!visualFailure.ok) throw new Error('T018-FIND-VISUAL-FAILURE-01 resolver failure');
  assert.equal(visualFailure.value.kind, 'no-match', 'T018-FIND-VISUAL-FAILURE-01 no match returned');
  assert.equal(visualFailure.value.lastFind?.target, 'Z', 'T018-FIND-VISUAL-FAILURE-01 failed target is remembered');
  assert.equal(visualFailure.value.recovery, 'preserve-visual-selection', 'T018-FIND-VISUAL-FAILURE-01 Visual selection must be preserved');
  let visualRepeatState = visualFailure.value.lastFind;
  for (const key of [';', ','] as const) {
    const repeated = resolveVimFind(visualSnapshot, visualFailure.value.cursor, { key }, visualRepeatState, { context: 'visual' });
    assert.equal(repeated.ok, true, `T018-FIND-VISUAL-FAILURE-01 ${key} is handled while Visual`);
    if (!repeated.ok) throw new Error('T018-FIND-VISUAL-FAILURE-01 repeat resolver failed');
    assert.equal(repeated.value.kind, 'no-match', `T018-FIND-VISUAL-FAILURE-01 ${key} retains the failed Z target`);
    assert.equal(repeated.value.recovery, 'preserve-visual-selection', `T018-FIND-VISUAL-FAILURE-01 ${key} preserves Visual selection`);
    assert.equal(repeated.value.lastFind?.target, 'Z', `T018-FIND-VISUAL-FAILURE-01 ${key} target remains Z`);
    visualRepeatState = repeated.value.lastFind;
  }
}

function checkInvalidInputs(): void {
  const opened = openTextDocument(asDocumentId('t018-negative'), new TextEncoder().encode('a😀e\u0301'));
  if (opened.kind !== 'editable') throw new Error('T018-FIND-NEGATIVE-01 fixture failed to open');
  const docSnapshot = opened.document.snapshot();
  const initial = createVimMotionCursor(docSnapshot, asOffset(0));
  if (!initial.ok) throw new Error('T018-FIND-NEGATIVE-01 cursor creation failed');
  assert.deepEqual(resolveVimFind(docSnapshot, initial.value, { key: 'f', target: '' }, null),
    { ok: false, error: { kind: 'invalid-character' } }, 'T018-FIND-NEGATIVE-01 empty literal rejected');
  assert.deepEqual(resolveVimFind(docSnapshot, initial.value, { key: 'f', target: '\ud800' }, null),
    { ok: false, error: { kind: 'invalid-character' } }, 'T018-FIND-NEGATIVE-01 unpaired surrogate literal rejected');
  assert.deepEqual(resolveVimFind(docSnapshot, initial.value, { key: 'f', target: 'e\u0301x' }, null),
    { ok: false, error: { kind: 'invalid-character' } }, 'T018-FIND-NEGATIVE-02 a base plus combining grapheme must be supplied as one target');
  assert.deepEqual(resolveVimFind(docSnapshot, initial.value, { key: 'f', target: 'x', count: 0 }, null),
    { ok: false, error: { kind: 'invalid-count' } }, 'T018-FIND-NEGATIVE-03 zero count rejected');
  const stale = { ...initial.value, documentVersion: (docSnapshot.version as number + 1) as typeof docSnapshot.version };
  assert.deepEqual(resolveVimFind(docSnapshot, stale, { key: 'f', target: '😀' }, null),
    { ok: false, error: { kind: 'stale-document-version' } }, 'T018-FIND-NEGATIVE-04 stale document version rejected');
  const noPriorRepeat = resolveVimFind(docSnapshot, initial.value, { key: ';' }, null, { context: 'operator-pending' });
  assert.equal(noPriorRepeat.ok, true, 'T018-FIND-NEGATIVE-05 no prior repeat is handled');
  if (noPriorRepeat.ok) {
    assert.equal(noPriorRepeat.value.kind, 'no-match', 'T018-FIND-NEGATIVE-05 no prior repeat has no motion');
    assert.equal(noPriorRepeat.value.recovery, 'cancel-operator', 'T018-FIND-NEGATIVE-05 no prior repeat cancels operator');
  }
}

function assertStateUnchanged(before: OracleSnapshot, after: OracleSnapshot, label: string): void {
  assert.deepEqual(after.lines, before.lines, `${label}: document`);
  assert.deepEqual(after.cursor, before.cursor, `${label}: cursor`);
  assert.deepEqual(after.registers, before.registers, `${label}: registers`);
  assert.deepEqual(after.marks, before.marks, `${label}: selection/marks`);
  assert.equal(after.mode, before.mode, `${label}: mode`);
  assert.equal(after.error, before.error, `${label}: command error`);
}

function asDocumentId(value: string): DocumentId {
  const result = asIdentifier<DocumentId>(value, 'documentId');
  if (!result.ok) throw new Error('T018-FIND-OWNER-01 test document ID is invalid');
  return result.value;
}

function asOffset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error('T018-FIND-COORDINATE-01 UTF-16 offset is invalid');
  return result.value;
}

function utf8ColumnToUtf16(line: string, byteColumn0: number): number {
  let byteColumn = 0;
  let utf16Column = 0;
  for (const scalar of line) {
    if (byteColumn === byteColumn0) return utf16Column;
    const bytes = Buffer.byteLength(scalar, 'utf8');
    if (byteColumn + bytes > byteColumn0) throw new Error('T018-FIND-COORDINATE-02 oracle byte column splits a UTF-8 scalar');
    byteColumn += bytes;
    utf16Column += scalar.length;
  }
  if (byteColumn !== byteColumn0) throw new Error('T018-FIND-COORDINATE-02 oracle byte column exceeds line length');
  return utf16Column;
}
