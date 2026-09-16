import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTextDocument, type DocumentSnapshot, type LineIndex, type Utf16Offset } from '../../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type SelectionId } from '../../../packages/primitives/src/index';
import {
  beginVimVisualSelection,
  createVimParserState,
  exchangeVimVisualBlockColumns,
  exchangeVimVisualEndpoints,
  extendVimVisualSelection,
  parseVimInput,
  planVimSelectReplacement,
  planVimVisualReplacement,
  prepareVimOperator,
  reselectVimVisualSelection,
  vimVisualSelectionMotion,
  type VimParseOutcome,
  type VimVisualCursor,
  type VimVisualKind,
} from '../../../packages/vim/src/index';
import { createSelectionSet, type SelectionSetSnapshot } from '../../../packages/selections/src/index';
import type { OracleFixture, OracleSnapshot } from '../../oracle/types';

interface FixtureCatalog { readonly schemaVersion: number; readonly fixtures: readonly OracleFixture[] }
interface OracleTrace {
  readonly schemaVersion: number;
  readonly oracle: { readonly version: string; readonly binarySha256: string; readonly runtimeDocsSha256: string };
  readonly fixtureIds: readonly string[];
  readonly fixtures: readonly { readonly id: string; readonly snapshots: readonly OracleSnapshot[] }[];
  readonly note: string;
}
interface VisualScenario {
  readonly kind: VimVisualKind;
  readonly target?: { readonly line: number; readonly offset: number; readonly displayCell: number; readonly desiredLogical?: number };
  readonly exchange?: 'o' | 'O';
  readonly reselectCount?: number;
  readonly operation?: 'delete' | 'change' | 'yank';
  readonly tabSize?: number;
}

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const catalog = JSON.parse(await readFile(resolve(root, 'tests/vim/t021/t021-fixtures.json'), 'utf8')) as FixtureCatalog;
const trace = JSON.parse(await readFile(resolve(root, 'tests/vim/t021/t021-oracle-traces.json'), 'utf8')) as OracleTrace;
assert.equal(trace.oracle.version, '0.12.4', 'T021-ORACLE-01 uses the pinned Neovim version');
assert.equal(trace.oracle.binarySha256, 'd9635db0b272b7c81cd705ef0d8bbf16edfeb05b08b36b4228ab0d6a92ec384f', 'T021-ORACLE-02 uses the pinned Neovim binary');
assert.equal(trace.oracle.runtimeDocsSha256, '79b80909bf8f5fe1d89a0fb66200388e651c88d49d565fdc51780ef4b24d7b1e', 'T021-ORACLE-03 uses the pinned runtime help');
const traceById = new Map(trace.fixtures.map((fixture) => [fixture.id, fixture]));
let visualComparisons = 0;
let operatorComparisons = 0;
let failureComparisons = 0;

const scenarios: Readonly<Record<string, VisualScenario>> = {
  'T021-ORACLE-CHAR-INCLUSIVE-01': { kind: 'visual-character', target: { line: 0, offset: 3, displayCell: 3 }, operation: 'yank' },
  'T021-ORACLE-CHAR-EXCLUSIVE-01': { kind: 'visual-character', target: { line: 0, offset: 2, displayCell: 2 }, operation: 'yank' },
  'T021-ORACLE-CHAR-REVERSED-O-01': { kind: 'visual-character', target: { line: 0, offset: 3, displayCell: 3 }, exchange: 'o', operation: 'yank' },
  'T021-ORACLE-LINE-INCLUSIVE-01': { kind: 'visual-line', target: { line: 1, offset: 2, displayCell: 2 }, operation: 'yank' },
  'T021-ORACLE-LINE-REVERSED-O-01': { kind: 'visual-line', target: { line: 1, offset: 0, displayCell: 7, desiredLogical: 7 }, exchange: 'o', operation: 'yank' },
  'T021-ORACLE-BLOCK-RAGGED-01': { kind: 'visual-block', target: { line: 2, offset: 3, displayCell: 3 }, operation: 'yank' },
  'T021-ORACLE-BLOCK-REVERSE-O-01': { kind: 'visual-block', target: { line: 1, offset: 3, displayCell: 3 }, exchange: 'O', operation: 'yank' },
  'T021-ORACLE-GV-RESELECT-01': { kind: 'visual-character', target: { line: 0, offset: 3, displayCell: 3 }, reselectCount: 1, operation: 'yank' },
  'T021-ORACLE-GV-COUNT-01': { kind: 'visual-character', target: { line: 0, offset: 3, displayCell: 3 }, reselectCount: 2, operation: 'yank' },
  'T021-ORACLE-SELECT-LINE-BLOCK-01': { kind: 'visual-block', target: { line: 1, offset: 2, displayCell: 2 }, operation: 'yank' },
  'T021-ORACLE-BLOCK-PARTIAL-TAB-DELETE-01': { kind: 'visual-block', target: { line: 1, offset: 0, displayCell: 2 }, operation: 'delete', tabSize: 8 },
  'T021-ORACLE-BLOCK-WIDE-GLYPH-EDGE-01': { kind: 'visual-block', target: { line: 0, offset: 1, displayCell: 2 }, operation: 'delete' },
  'T021-ORACLE-LINE-EMPTY-LAST-01': { kind: 'visual-line', operation: 'yank' },
  'T021-ORACLE-BLOCK-DELETE-BOUNDARIES-01': { kind: 'visual-block', target: { line: 2, offset: 3, displayCell: 3 }, operation: 'delete' },
  'T021-ORACLE-BLOCK-CHANGE-TAB-01': { kind: 'visual-block', target: { line: 1, offset: 0, displayCell: 2 }, operation: 'change', tabSize: 8 },
  'T021-ORACLE-BLOCK-CHANGE-TAB-EDGE-01': { kind: 'visual-block', target: { line: 1, offset: 1, displayCell: 1 }, operation: 'change', tabSize: 8 },
};

for (const fixture of catalog.fixtures) {
  const scenario = scenarios[fixture.id];
  const actualTrace = traceById.get(fixture.id);
  assert.ok(actualTrace, `T021-TRACE-01 ${fixture.id} has a pinned trace`);
  if (actualTrace === undefined) throw new Error(`T021-TRACE-01 missing ${fixture.id}`);
  if (fixture.id === 'T021-ORACLE-SELECT-TOGGLE-CHAR-01' || fixture.id === 'T021-ORACLE-SELECT-REPLACE-01') continue;
  assert.ok(scenario, `T021-SCENARIO-01 ${fixture.id} has a production visual case`);
  if (scenario === undefined) throw new Error(`T021-SCENARIO-01 missing ${fixture.id}`);

  const source = documentText(fixture);
  const opened = openTextDocument(documentId(`t021-${fixture.id}`), new TextEncoder().encode(source));
  assert.equal(opened.kind, 'editable', `T021-OWNER-01 ${fixture.id} opens as editable document text`);
  if (opened.kind !== 'editable') throw new Error(`T021-OWNER-01 ${fixture.id} is not editable`);
  const snapshot = opened.document.snapshot();
  const start = fixtureCursorOffset(fixture, snapshot);
  const startCell = fixtureStartCell(fixture.id, fixture.cursor?.byteColumn0 ?? 0);
  const selectionId = selectionIdFor(fixture.id);
  const started = beginVimVisualSelection(snapshot, selectionId, visualCursor(snapshot, start, startCell), scenario.kind, {
    selection: fixture.options?.selection === 'exclusive' ? 'exclusive' : 'inclusive',
  });
  assert.ok(started.ok, `T021-SELECTION-01 ${fixture.id} begins the requested visual selection`);
    if (!started.ok) throw new Error(`T021-SELECTION-01 ${fixture.id} selection failed`);
  let selection = started.value;
  let activeCursor = visualCursor(snapshot, start, startCell);

  if (scenario.target !== undefined) {
    const targetOffset = lineOffset(snapshot, scenario.target.line, scenario.target.offset);
    activeCursor = visualCursor(snapshot, targetOffset, scenario.target.displayCell,
      scenario.target.desiredLogical ?? scenario.target.offset);
    const extended = extendVimVisualSelection(snapshot, selection, [{ id: selectionId, cursor: activeCursor }], {
      selection: fixture.options?.selection === 'exclusive' ? 'exclusive' : 'inclusive',
    });
    assert.ok(extended.ok, `T021-SELECTION-02 ${fixture.id} extends the active endpoint`);
    if (!extended.ok) throw new Error(`T021-SELECTION-02 ${fixture.id} extension failed`);
    selection = extended.value;
  }

  if (scenario.exchange === 'o') {
    const exchanged = exchangeVimVisualEndpoints(snapshot, selection);
    assert.ok(exchanged.ok, `T021-EXCHANGE-01 ${fixture.id} exchanges anchor and head`);
    if (!exchanged.ok) throw new Error(`T021-EXCHANGE-01 ${fixture.id} endpoint exchange failed`);
    selection = exchanged.value;
    activeCursor = visualCursor(snapshot, start, startCell,
      fixture.cursor?.byteColumn0 === undefined ? startCell
        : utf8ColumnToUtf16(fixture.lines[(fixture.cursor.line ?? 1) - 1] ?? '', fixture.cursor.byteColumn0));
  } else if (scenario.exchange === 'O') {
    const exchanged = exchangeVimVisualBlockColumns(snapshot, selection);
    assert.ok(exchanged.ok, `T021-EXCHANGE-02 ${fixture.id} exchanges block columns`);
    if (!exchanged.ok) throw new Error(`T021-EXCHANGE-02 ${fixture.id} block exchange failed`);
    selection = exchanged.value;
    activeCursor = cursorForMemberHead(snapshot, selection.members[0]);
  }

  if (scenario.reselectCount !== undefined) {
    const previous = selection;
    const reselected = reselectVimVisualSelection(snapshot, previous, scenario.reselectCount);
    assert.ok(reselected.ok, `T021-RESELECT-01 ${fixture.id} accepts the observed gv count`);
    if (!reselected.ok) throw new Error(`T021-RESELECT-01 ${fixture.id} reselect failed`);
    assert.deepEqual(reselected.value, previous, `T021-RESELECT-02 ${fixture.id} restores selection endpoints and metadata`);
    selection = reselected.value;
  }

  const selectedSnapshot = snapshotForSelectionStep(actualTrace.snapshots, fixture.id);
  assert.ok(selectedSnapshot, `T021-ORACLE-04 ${fixture.id} has a Visual-state oracle checkpoint`);
  if (selectedSnapshot === undefined) throw new Error(`T021-ORACLE-04 missing selected snapshot ${fixture.id}`);
  assertVisualCursorMatches(snapshot, selection, activeCursor, selectedSnapshot, fixture.lines, fixture.id, scenario.kind, startCell);
  visualComparisons += 1;

  if (scenario.operation === undefined) continue;
  const motion = vimVisualSelectionMotion(snapshot, selection, scenario.operation, {
    ...(scenario.tabSize === undefined ? {} : { tabSize: scenario.tabSize }),
  });
  assert.ok(motion.ok, `T021-RANGE-01 ${fixture.id} adapts stored selection geometry`);
  if (!motion.ok) throw new Error(`T021-RANGE-01 ${fixture.id} motion adaptation failed`);
  const prepared = prepareVimOperator(snapshot, {
    operator: scenario.operation,
    motion,
    state: { mode: 'normal', repeatTarget: null },
  });
  assert.ok(prepared.ok, `T021-OPERATOR-01 ${fixture.id} prepares the selection operator`);
  if (!prepared.ok) throw new Error(`T021-OPERATOR-01 ${fixture.id} preparation failed`);
  assert.equal(prepared.value.kind, 'prepared', `T021-OPERATOR-02 ${fixture.id} has a prepared plan`);
  if (prepared.value.kind !== 'prepared') throw new Error(`T021-OPERATOR-02 ${fixture.id} failed: ${JSON.stringify(prepared.value)}`);
  const expectedFinal = actualTrace.snapshots.at(-1);
  assert.ok(expectedFinal, `T021-ORACLE-05 ${fixture.id} has a final operator checkpoint`);
  if (expectedFinal === undefined) throw new Error(`T021-ORACLE-05 missing final ${fixture.id}`);
  const expectedRegister = oracleRegister(expectedFinal, '"', fixture.id);
  assert.deepEqual(prepared.value.registerEffect.lines, expectedRegister.lines,
    `T021-REGISTER-01 ${fixture.id} block/character/line payload matches Neovim`);
  assert.equal(prepared.value.registerEffect.type, expectedRegister.type,
    `T021-REGISTER-02 ${fixture.id} register type and block width match Neovim`);
  if (scenario.operation === 'yank') {
    assert.equal(prepared.value.transaction, null, `T021-OPERATOR-03 ${fixture.id} yank does not mutate document text`);
    assert.equal(source, serializeOracleText(expectedFinal), `T021-TEXT-01 ${fixture.id} yank leaves source text unchanged`);
  } else {
    assert.ok(prepared.value.transaction, `T021-OPERATOR-04 ${fixture.id} edit is proposed through the document boundary`);
    const resultText = applyEdits(source, prepared.value.transaction?.edits ?? []);
    if (scenario.operation === 'change') {
      const replacement = planVimVisualReplacement(snapshot, selection, 'Z', {
        ...(scenario.tabSize === undefined ? {} : { tabSize: scenario.tabSize }),
      });
      assert.ok(replacement.ok, `T021-TEXT-02 ${fixture.id} prepares row-wise block insertion`);
      if (!replacement.ok) throw new Error(`T021-TEXT-02 ${fixture.id} replacement planner failed`);
      const resultWithInsert = applyEdits(source, replacement.value.edits);
      assert.equal(resultWithInsert, serializeOracleText(expectedFinal),
        `T021-TEXT-03 ${fixture.id} block change plus cZ input matches Neovim without splitting tab cells`);
    } else {
      assert.equal(resultText, serializeOracleText(expectedFinal),
        `T021-TEXT-04 ${fixture.id} delete transaction matches Neovim without splitting text boundaries`);
    }
  }
  operatorComparisons += 1;
}

verifySelectParserAndReplacement();
verifyFailures();
assert.equal(trace.fixtureIds.length, catalog.fixtures.length, 'T021-TRACE-02 every fixture has a trace');
assert.deepEqual(trace.fixtureIds, catalog.fixtures.map((fixture) => fixture.id), 'T021-TRACE-03 fixture and trace order match');
assert.equal(visualComparisons + 2, catalog.fixtures.length,
  'T021-CATALOG-01 visual geometry, Select-mode, and replacement assertions cover every oracle fixture');
assert.equal(operatorComparisons, 16, 'T021-CATALOG-02 all operator fixtures are checked against register and text output');
console.log(`T021 passed ${visualComparisons} selection geometry, ${operatorComparisons} operator, 2 Select-mode/replacement fixtures, and ${failureComparisons} failure comparisons across ${catalog.fixtures.length} pinned fixtures.`);
console.log('Pinned oracle: Neovim 0.12.4, binary sha256 d9635db0b272b7c81cd705ef0d8bbf16edfeb05b08b36b4228ab0d6a92ec384f.');

function verifySelectParserAndReplacement(): void {
  const fixture = catalog.fixtures.find((candidate) => candidate.id === 'T021-ORACLE-SELECT-REPLACE-01');
  const observed = traceById.get('T021-ORACLE-SELECT-REPLACE-01');
  assert.ok(fixture && observed, 'T021-SELECT-01 replacement fixture and trace exist');
  if (fixture === undefined || observed === undefined) throw new Error('T021-SELECT-01 missing fixture');
  const source = documentText(fixture);
  const opened = openTextDocument(documentId('t021-select-replacement'), new TextEncoder().encode(source));
  assert.equal(opened.kind, 'editable');
  if (opened.kind !== 'editable') throw new Error('T021-SELECT-01 fixture did not open');
  const snapshot = opened.document.snapshot();
  const cursor = fixtureCursorOffset(fixture, snapshot);
  const selectionId = selectionIdFor('t021-select-replacement');
  const started = beginVimVisualSelection(snapshot, selectionId, visualCursor(snapshot, cursor, 2), 'visual-character');
  assert.ok(started.ok, 'T021-SELECT-02 gh begins a character selection at the active character');
  if (!started.ok) throw new Error('T021-SELECT-02 unable to create the selection');
  const replacement = planVimSelectReplacement(snapshot, started.value, 'X');
  assert.ok(replacement.ok, 'T021-SELECT-03 ghX creates a pure document edit proposal');
  if (!replacement.ok) throw new Error('T021-SELECT-03 unable to prepare the replacement');
  assert.equal(replacement.value.nextMode, 'insert', 'T021-SELECT-04 the first printable Select key transitions into Insert');
  assert.equal(replacement.value.expectedVersion, snapshot.version, 'T021-SELECT-05 replacement retains source version');
  const changed = applyEdits(source, replacement.value.edits);
  assert.equal(changed, serializeOracleText(observed.snapshots.at(-1)!), 'T021-SELECT-06 ghX text matches the Neovim oracle');

  const normal = normalSelection(snapshot, cursor, selectionIdFor('t021-select-normal'));
  const normalParser = createVimParserState('normal', normal);
  assert.ok(normalParser.ok, 'T021-SELECT-07 normal session accepts a normal-cursor selection');
  if (!normalParser.ok) throw new Error('T021-SELECT-07 unable to create normal parser state');
  const gh = parseKeys(normalParser.value, ['g', 'h']);
  assert.equal(gh.kind, 'command', 'T021-SELECT-08 gh completes as a command');
  if (gh.kind !== 'command') throw new Error('T021-SELECT-08 gh did not complete');
  assert.equal(gh.command.kind, 'mode-transition', 'T021-SELECT-09 gh is a mode transition, not a text edit');
  if (gh.command.kind === 'mode-transition') assert.equal(gh.command.to, 'select-character', 'T021-SELECT-10 gh enters character Select mode');
  const gH = parseKeys(normalParser.value, ['g', 'H']);
  assert.equal(gH.kind, 'command', 'T021-SELECT-11 gH completes as a command');
  if (gH.kind !== 'command') throw new Error('T021-SELECT-11 gH did not complete');
  assert.equal(gH.command.kind, 'mode-transition', 'T021-SELECT-12 gH is a mode transition');
  if (gH.command.kind === 'mode-transition') assert.equal(gH.command.to, 'select-line', 'T021-SELECT-13 gH enters line Select mode');
  const gCtrlH = parseKeys(normalParser.value, ['g', '<C-h>']);
  assert.equal(gCtrlH.kind, 'command', 'T021-SELECT-14 gCtrl-H completes as a command');
  if (gCtrlH.kind !== 'command') throw new Error('T021-SELECT-14 gCtrl-H did not complete');
  assert.equal(gCtrlH.command.kind, 'mode-transition', 'T021-SELECT-15 gCtrl-H is a mode transition');
  if (gCtrlH.command.kind === 'mode-transition') assert.equal(gCtrlH.command.to, 'select-block', 'T021-SELECT-16 gCtrl-H enters block Select mode');

  const selectParser = createVimParserState('select-character', started.value);
  assert.ok(selectParser.ok, 'T021-SELECT-14 character selection can back a Select parser session');
  if (!selectParser.ok) throw new Error('T021-SELECT-17 unable to create Select parser state');
  const selectKey = parseVimInput(selectParser.value, inputKey('X'));
  assert.equal(selectKey.kind, 'command', 'T021-SELECT-15 printable Select input returns a command');
  if (selectKey.kind === 'command') {
    assert.equal(selectKey.command.kind, 'select-key', 'T021-SELECT-16 printable Select input is dispatched as a selection replacement intent');
    if (selectKey.command.kind === 'select-key') assert.equal(selectKey.command.mode, 'select-character', 'T021-SELECT-17 replacement intent retains the Select submode');
  }
  const ctrlG = parseVimInput(selectParser.value, inputKey('<C-g>'));
  assert.equal(ctrlG.kind, 'command', 'T021-SELECT-18 Ctrl-G is consumed as a transition');
  if (ctrlG.kind === 'command' && ctrlG.command.kind === 'mode-transition') assert.equal(ctrlG.command.to, 'visual-character', 'T021-SELECT-19 Ctrl-G toggles to matching Visual mode');
  const visualParser = createVimParserState('visual-character', started.value);
  assert.ok(visualParser.ok, 'T021-SELECT-20 matching Visual parser state is valid');
  if (!visualParser.ok) throw new Error('T021-SELECT-20 unable to create Visual parser state');
  const ctrlGBack = parseVimInput(visualParser.value, inputKey('<C-g>'));
  assert.equal(ctrlGBack.kind, 'command', 'T021-SELECT-21 Visual Ctrl-G completes as a transition');
  if (ctrlGBack.kind === 'command' && ctrlGBack.command.kind === 'mode-transition') {
    assert.equal(ctrlGBack.command.to, 'select-character', 'T021-SELECT-22 Visual Ctrl-G returns to the matching Select mode');
  }
}

function verifyFailures(): void {
  const fixture = catalog.fixtures[0];
  assert.ok(fixture, 'T021-FAILURE-01 a source fixture exists');
  if (fixture === undefined) throw new Error('T021-FAILURE-01 no fixture');
  const opened = openTextDocument(documentId('t021-failure-source'), new TextEncoder().encode(documentText(fixture)));
  assert.equal(opened.kind, 'editable');
  if (opened.kind !== 'editable') throw new Error('T021-FAILURE-01 fixture did not open');
  const snapshot = opened.document.snapshot();
  const offset = fixtureCursorOffset(fixture, snapshot);
  const cursor = visualCursor(snapshot, offset, 1);
  const stale = beginVimVisualSelection(snapshot, selectionIdFor('stale'), { ...cursor, documentVersion: asDocumentVersion((snapshot.version as number) + 1) }, 'visual-character');
  assert.equal(stale.ok, false, 'T021-FAILURE-02 stale cursor version is rejected');
  const staleFailure = stale.ok ? null : stale.error.kind;
  assert.equal(staleFailure, 'stale-document-version', 'T021-FAILURE-03 stale cursor has a typed failure');
  const started = beginVimVisualSelection(snapshot, selectionIdFor('valid'), cursor, 'visual-character');
  assert.ok(started.ok, 'T021-FAILURE-04 valid selection is available for negative probes');
  if (!started.ok) throw new Error('T021-FAILURE-04 unable to seed selection');
  const invalidCount = reselectVimVisualSelection(snapshot, started.value, 0);
  assert.equal(invalidCount.ok, false, 'T021-FAILURE-05 nonpositive gv count is rejected');
  const countFailure = invalidCount.ok ? null : invalidCount.error.kind;
  assert.equal(countFailure, 'invalid-count', 'T021-FAILURE-06 invalid gv count is typed');
  const notBlock = exchangeVimVisualBlockColumns(snapshot, started.value);
  assert.equal(notBlock.ok, false, 'T021-FAILURE-07 O refuses a non-block selection');
  const blockFailure = notBlock.ok ? null : notBlock.error.kind;
  assert.equal(blockFailure, 'not-blockwise', 'T021-FAILURE-08 non-block O reports its reason');
  const malformed = planVimSelectReplacement(snapshot, started.value, '\ud800');
  assert.equal(malformed.ok, false, 'T021-FAILURE-09 malformed UTF-16 replacement is rejected before planning');
  const replacementFailure = malformed.ok ? null : malformed.error.kind;
  assert.equal(replacementFailure, 'invalid-replacement-text', 'T021-FAILURE-10 malformed replacement has a typed error');
  failureComparisons += 5;
}

function parseKeys(state: Parameters<typeof parseVimInput>[0], keys: readonly string[]): VimParseOutcome {
  let current = state;
  let outcome: VimParseOutcome = { kind: 'pending', state, continuations: [] };
  for (const key of keys) {
    const parsed = parseVimInput(current, inputKey(key));
    outcome = parsed;
    if (parsed.kind !== 'pending') return parsed;
    current = parsed.state;
  }
  return outcome;
}

function inputKey(key: string) {
  const ctrl = key.startsWith('<C-');
  const resolved = ctrl ? key.slice(3, -1) : key;
  return {
    kind: 'key' as const,
    key: resolved,
    phase: 'press' as const,
    modifiers: { shift: false, alt: false, ctrl, meta: false },
    atMilliseconds: 1,
  };
}

function normalSelection(snapshot: DocumentSnapshot, offset: Utf16Offset, id: SelectionId) {
  const char = snapshot.slice(offset, ((offset as number) + 1) as Utf16Offset);
  assert.ok(char.ok && char.value.length > 0, 'T021-PARSER-01 parser test cursor names a character');
  const line = snapshot.lineIndexAt(offset);
  assert.ok(line.ok, 'T021-PARSER-02 parser cursor has a line');
  if (!line.ok) throw new Error('T021-PARSER-02 no cursor line');
  const start = snapshot.lineStartOffset(line.value);
  assert.ok(start.ok, 'T021-PARSER-03 parser cursor line start resolves');
  if (!start.ok) throw new Error('T021-PARSER-03 no line start');
  const logical = ((offset as number) - (start.value as number)) as never;
  const endpoint = { kind: 'character' as const, offset, after: ((offset as number) + char.value.length) as Utf16Offset };
  const created = createSelectionSet(snapshot, {
    primaryId: id,
    members: [{
      id, kind: 'normal-cursor', direction: 'forward', anchor: endpoint, head: endpoint,
      desiredColumn: { logicalUtf16: logical, displayCell: logical },
    }],
  });
  assert.ok(created.ok, 'T021-PARSER-04 normal cursor selection validates');
  if (!created.ok) throw new Error('T021-PARSER-04 unable to create normal selection');
  return created.value.selectionSet;
}

function snapshotForSelectionStep(snapshots: readonly OracleSnapshot[], id: string): OracleSnapshot | undefined {
  const labels: Readonly<Record<string, string>> = {
    'T021-ORACLE-CHAR-INCLUSIVE-01': 'visual-three-characters',
    'T021-ORACLE-CHAR-EXCLUSIVE-01': 'exclusive-visual',
    'T021-ORACLE-CHAR-REVERSED-O-01': 'reverse-active-endpoint',
    'T021-ORACLE-LINE-INCLUSIVE-01': 'two-lines',
    'T021-ORACLE-LINE-REVERSED-O-01': 'reverse-linewise-active-endpoint',
    'T021-ORACLE-BLOCK-RAGGED-01': 'ragged-block',
    'T021-ORACLE-BLOCK-REVERSE-O-01': 'block-opposite-corner',
    'T021-ORACLE-GV-RESELECT-01': 'reselect',
    'T021-ORACLE-GV-COUNT-01': 'counted-reselect',
    'T021-ORACLE-SELECT-LINE-BLOCK-01': 'extend-visual-block',
    'T021-ORACLE-BLOCK-PARTIAL-TAB-DELETE-01': 'select-partial-tab-cell',
    'T021-ORACLE-BLOCK-WIDE-GLYPH-EDGE-01': 'wide-glyph-edge-block',
    'T021-ORACLE-LINE-EMPTY-LAST-01': 'empty-final-line-selection',
    'T021-ORACLE-BLOCK-DELETE-BOUNDARIES-01': 'wide-ragged-block',
    'T021-ORACLE-BLOCK-CHANGE-TAB-01': 'select-tab-change-block',
    'T021-ORACLE-BLOCK-CHANGE-TAB-EDGE-01': 'select-through-tab-edge',
  };
  return snapshots.find((snapshot) => snapshot.label === labels[id]);
}

function assertVisualCursorMatches(
  snapshot: DocumentSnapshot,
  selection: SelectionSetSnapshot,
  active: VimVisualCursor,
  expected: OracleSnapshot,
  originalLines: readonly string[],
  id: string,
  kind: VimVisualKind,
  anchorDesiredCell: number,
): void {
  const member = selection.members[0];
  assert.ok(member, `T021-CURSOR-01 ${id} has a primary selection member`);
  if (member === undefined) throw new Error(`T021-CURSOR-01 missing member ${id}`);
  assert.equal(member.kind, kind,
    `T021-CURSOR-02 ${id} retains the selection kind`);
  assert.equal(member.desiredColumn.displayCell, active.displayCellColumn, `T021-CURSOR-03 ${id} stores the active display column`);
  const expectedLine = expected.cursor.line - 1;
  const line = snapshot.lineIndexAt(active.offset);
  assert.ok(line.ok, `T021-CURSOR-04 ${id} active cursor line resolves`);
  if (!line.ok) throw new Error(`T021-CURSOR-04 ${id} no line`);
  assert.equal(line.value as number, expectedLine, `T021-CURSOR-05 ${id} active line equals Neovim`);
  assert.equal(member.desiredColumn.displayCell as number, expected.cursor.desiredColumn,
    `T021-CURSOR-06 ${id} sticky desired column equals Neovim`);
  if (member.kind === 'visual-character') {
    assert.equal(member.head.kind === 'empty-line' ? 0 : (member.head.at.offset as number), active.offset as number,
      `T021-CURSOR-07 ${id} active character boundary is retained`);
    assert.equal(member.inclusive, expected.options.selection !== 'exclusive', `T021-CURSOR-08 ${id} selection option matches Neovim`);
  } else if (member.kind === 'visual-line') {
    assert.equal(member.head.lineIndex as number, expectedLine, `T021-CURSOR-09 ${id} linewise active endpoint matches Neovim`);
    assert.equal(member.anchorDesiredColumn.displayCell as number, anchorDesiredCell,
      `T021-CURSOR-10 ${id} anchor desired column survives endpoint exchange`);
  } else if (member.kind === 'visual-block') {
    assert.equal(member.head.kind, 'block-cell', `T021-CURSOR-11 ${id} stores block cell metadata`);
    if (member.head.kind === 'block-cell') {
      assert.equal(member.head.displayCellColumn as number, active.displayCellColumn as number,
        `T021-CURSOR-12 ${id} active block cell matches the frame cursor`);
      assert.ok(Number.isSafeInteger(member.head.virtualCells) && member.head.virtualCells >= 0,
        `T021-CURSOR-13 ${id} records a nonnegative virtual cell count`);
    }
  }
}

function cursorForMemberHead(snapshot: DocumentSnapshot, member: { readonly head: { readonly kind: string; readonly at?: { readonly offset: Utf16Offset }; readonly lineIndex?: LineIndex; readonly displayCellColumn?: number }; readonly desiredColumn: { readonly logicalUtf16: number | null; readonly displayCell: number | null } } | undefined): VimVisualCursor {
  if (member === undefined) throw new Error('T021-EXCHANGE-03 missing selection member');
  const endpointOffset = member.head.at?.offset;
  let offset = endpointOffset;
  if (offset === undefined && member.head.lineIndex !== undefined) {
    const start = snapshot.lineStartOffset(member.head.lineIndex);
    if (!start.ok) throw new Error('T021-EXCHANGE-04 line endpoint start unavailable');
    offset = start.value;
  }
  if (offset === undefined) throw new Error('T021-EXCHANGE-05 endpoint has no UTF-16 anchor');
  return visualCursor(snapshot, offset, member.head.displayCellColumn ?? member.desiredColumn.displayCell ?? 0,
    member.desiredColumn.logicalUtf16 ?? 0);
}

function oracleRegister(snapshot: OracleSnapshot, key: string, id: string): { readonly lines: readonly string[]; readonly type: string } {
  const value = snapshot.registers[key] as { readonly lines?: readonly string[]; readonly type?: string } | undefined;
  assert.ok(value, `T021-REGISTER-03 ${id} oracle register ${key} exists`);
  if (value === undefined) throw new Error(`T021-REGISTER-03 missing ${id} register ${key}`);
  return { lines: value.lines ?? [], type: value.type ?? '' };
}

function fixtureCursorOffset(fixture: OracleFixture, snapshot: DocumentSnapshot): Utf16Offset {
  const line = (fixture.cursor?.line ?? 1) - 1;
  const start = snapshot.lineStartOffset(line as LineIndex);
  assert.ok(start.ok, `T021-COORDINATE-01 ${fixture.id} cursor line exists`);
  if (!start.ok) throw new Error(`T021-COORDINATE-01 ${fixture.id} has no cursor line`);
  const local = utf8ColumnToUtf16(fixture.lines[line] ?? '', fixture.cursor?.byteColumn0 ?? 0);
  return asOffset((start.value as number) + local);
}

function visualCursor(snapshot: DocumentSnapshot, offset: Utf16Offset, displayCell: number, desiredLogical = displayCell): VimVisualCursor {
  const line = snapshot.lineIndexAt(offset);
  assert.ok(line.ok, 'T021-COORDINATE-02 visual cursor line exists');
  if (!line.ok) throw new Error('T021-COORDINATE-02 no visual cursor line');
  const lineStart = snapshot.lineStartOffset(line.value);
  assert.ok(lineStart.ok, 'T021-COORDINATE-03 visual cursor line start exists');
  if (!lineStart.ok) throw new Error('T021-COORDINATE-03 no line start');
  return {
    documentVersion: snapshot.version,
    offset,
    displayCellColumn: displayCell as never,
    desiredColumn: { logicalUtf16: desiredLogical as never, displayCell: displayCell as never },
  };
}

function cursorOffset(snapshot: OracleSnapshot, initialLines: readonly string[]): number {
  let offset = 0;
  for (let index = 0; index < snapshot.cursor.line - 1; index += 1) offset += (initialLines[index] ?? '').length + 1;
  return offset + utf8ColumnToUtf16(snapshot.lines[snapshot.cursor.line - 1] ?? '', snapshot.cursor.byteColumn - 1);
}

function lineOffset(snapshot: DocumentSnapshot, line: number, local: number): Utf16Offset {
  const start = snapshot.lineStartOffset(line as LineIndex);
  assert.ok(start.ok, 'T021-COORDINATE-04 target line exists');
  if (!start.ok) throw new Error('T021-COORDINATE-04 target line unavailable');
  return asOffset((start.value as number) + local);
}

function fixtureStartCell(id: string, logical: number): number {
  if (id === 'T021-ORACLE-BLOCK-WIDE-GLYPH-EDGE-01') return logical;
  if (id === 'T021-ORACLE-BLOCK-DELETE-BOUNDARIES-01') return 1;
  return logical;
}

function documentText(fixture: OracleFixture): string {
  const lines = fixture.lines.length === 0 ? [''] : fixture.lines;
  return `${lines.join('\n')}${fixture.endOfLine === false ? '' : '\n'}`;
}

function serializeOracleText(snapshot: OracleSnapshot): string {
  return `${snapshot.lines.join('\n')}${snapshot.buffer.endOfLine === false ? '' : '\n'}`;
}

function applyEdits(text: string, edits: readonly { readonly start: Utf16Offset; readonly end: Utf16Offset; readonly text: string }[]): string {
  let output = text;
  for (const edit of [...edits].sort((left, right) => (right.start as number) - (left.start as number))) {
    output = `${output.slice(0, edit.start as number)}${edit.text}${output.slice(edit.end as number)}`;
  }
  return output;
}

function applyInsertPayload(text: string, offset: number, payload: string): string {
  return `${text.slice(0, offset)}${payload}${text.slice(offset)}`;
}

function utf8ColumnToUtf16(text: string, byteColumn0: number): number {
  let bytes = 0;
  let units = 0;
  for (const scalar of text) {
    if (bytes === byteColumn0) return units;
    const size = Buffer.byteLength(scalar, 'utf8');
    if (bytes + size > byteColumn0) throw new Error('T021-COORDINATE-05 Neovim byte column splits a scalar');
    bytes += size;
    units += scalar.length;
  }
  if (bytes !== byteColumn0) throw new Error('T021-COORDINATE-06 Neovim byte column exceeds line');
  return units;
}

function asOffset(value: number): Utf16Offset {
  const offset = asUtf16Offset(value);
  if (!offset.ok) throw new Error(`T021-COORDINATE-07 invalid UTF-16 offset ${value}`);
  return offset.value;
}

function documentId(value: string): DocumentId {
  const id = asIdentifier<DocumentId>(value, 'documentId');
  if (!id.ok) throw new Error(`T021-OWNER-02 invalid fixture id ${value}`);
  return id.value;
}

function selectionIdFor(value: string): SelectionId {
  const id = asIdentifier<SelectionId>(value, 'selectionId');
  if (!id.ok) throw new Error(`T021-OWNER-03 invalid selection id ${value}`);
  return id.value;
}

function asDocumentVersion(value: number): DocumentSnapshot['version'] { return value as DocumentSnapshot['version']; }
