#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTextDocument, type DocumentSnapshot, type Utf16Offset } from '../../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId } from '../../../packages/primitives/src/index';
import {
  applyVimRepeatEvent,
  createVimInsertRepeatTarget,
  createVimOperatorRepeatTarget,
  createVimPutRepeatTarget,
  createVimRepeatState,
  createVimVisualRepeatTarget,
  recordVimRepeatTarget,
  replayVimDot,
} from '../../../packages/vim/src/index';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture, OracleSnapshot } from '../../oracle/types';

interface FixtureCatalog { readonly schemaVersion: number; readonly fixtures: readonly OracleFixture[] }
interface OracleTrace {
  readonly schemaVersion: 1;
  readonly oracle: { readonly version: string; readonly binarySha256: string; readonly runtimeDocsSha256: string };
  readonly fixtureIds: readonly string[];
  readonly fixtures: readonly { readonly id: string; readonly snapshots: readonly OracleSnapshot[] }[];
  readonly note: string;
}

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const fixturePath = resolve(root, 'tests/vim/repeat/t024-fixtures.json');
const tracePath = resolve(root, 'tests/vim/repeat/t024-oracle-traces.json');
const catalog = JSON.parse(await readFile(fixturePath, 'utf8')) as FixtureCatalog;
assert.equal(catalog.schemaVersion, 1, 'T024-ORACLE-CATALOG-01 fixture schema is supported');
const oracle = await verifyOracleBundle();
const generatedFixtures: OracleTrace['fixtures'][number][] = [];

for (const fixture of catalog.fixtures) {
  const result = await runOracleFixture(fixture, oracle.binaryPath);
  assert.equal(result.snapshots.length, fixture.steps.length,
    `T024-ORACLE-SNAPSHOT-01 ${fixture.id} has one snapshot per command`);
  generatedFixtures.push({ id: fixture.id, snapshots: result.snapshots });
}

const generatedTrace: OracleTrace = {
  schemaVersion: 1,
  oracle: {
    version: oracle.manifest.oracle.version,
    binarySha256: oracle.manifest.oracle.binarySha256,
    runtimeDocsSha256: oracle.manifest.oracle.runtimeDocs.sha256,
  },
  fixtureIds: catalog.fixtures.map((fixture) => fixture.id),
  fixtures: generatedFixtures,
  note: 'Pinned Neovim 0.12.4 semantic-dot snapshots for T024 only; no compatibility inventory rows are marked verified by this file.',
};

if (process.argv.includes('--record')) {
  await writeFile(tracePath, `${JSON.stringify(generatedTrace, null, 2)}\n`, 'utf8');
  console.log(`RECORDED ${generatedFixtures.length} T024 fixtures to ${tracePath}`);
} else {
  const expected = JSON.parse(await readFile(tracePath, 'utf8')) as OracleTrace;
  assert.deepEqual(expected, generatedTrace, 'T024-ORACLE-TRACE-01 snapshots match pinned Neovim');
}

assert.equal(generatedTrace.oracle.version, '0.12.4', 'T024-ORACLE-02 uses Neovim 0.12.4');
assert.equal(generatedTrace.oracle.binarySha256,
  'd9635db0b272b7c81cd705ef0d8bbf16edfeb05b08b36b4228ab0d6a92ec384f',
  'T024-ORACLE-03 uses the pinned Neovim binary');
assert.equal(generatedTrace.oracle.runtimeDocsSha256,
  '79b80909bf8f5fe1d89a0fb66200388e651c88d49d565fdc51780ef4b24d7b1e',
  'T024-ORACLE-04 uses the pinned Neovim runtime docs');
const expectedOracleText: Readonly<Record<string, readonly string[]>> = {
  'T024-ORACLE-INSERT-01': ['Xalpha Xbeta'],
  'T024-ORACLE-CHANGE-01': ['X X three'],
  'T024-ORACLE-VISUAL-01': ['X X three'],
  'T024-ORACLE-PUT-01': ['one', 'one', 'two', 'one', 'three'],
  'T024-ORACLE-FAILED-01': [''],
};
for (const fixture of generatedTrace.fixtures) {
  const expected = expectedOracleText[fixture.id];
  assert.notEqual(expected, undefined, `T024-ORACLE-TEXT-01 ${fixture.id} has an expected result`);
  const finalSnapshot = fixture.snapshots.at(-1);
  assert.notEqual(finalSnapshot, undefined, `T024-ORACLE-TEXT-02 ${fixture.id} has a final snapshot`);
  if (expected === undefined || finalSnapshot === undefined) continue;
  assert.deepEqual(finalSnapshot.lines, expected, `T024-ORACLE-TEXT-03 ${fixture.id} matches Neovim output`);
}

const source = openSnapshot('alpha beta');
const insertTarget = expectOk(createVimInsertRepeatTarget({ entryKey: 'i', mode: 'insert', text: 'X' }));
let state = expectOk(recordVimRepeatTarget(createVimRepeatState(), insertTarget));
const insertReplay = expectOk(replayVimDot(state, {
  snapshot: source,
  cursorOffset: asOffset(6),
  count: 2,
}, (context) => {
  assert.equal(context.target.kind, 'insert', 'T024-INSERT-01 dot retains insert metadata');
  assert.equal(context.count, 2, 'T024-COUNT-01 count before dot overrides the recorded count');
  return { ok: true, value: { kind: 'insert', offset: context.cursorOffset, text: context.target.text, count: context.count } };
}));
assert.deepEqual(insertReplay.resolved, { kind: 'insert', offset: 6, text: 'X', count: 2 },
  'T024-INSERT-02 insert replay resolves at the new cursor');
assert.strictEqual(insertReplay.state, state, 'T024-INSERT-03 replay does not mutate repeat state');

const operatorTarget = expectOk(createVimOperatorRepeatTarget({ operator: 'change', motionKey: 'w', count: 1 }));
state = expectOk(recordVimRepeatTarget(state, operatorTarget));
const operatorReplay = expectOk(replayVimDot(state, {
  snapshot: openSnapshot('one two three'),
  cursorOffset: asOffset(4),
}, (context) => {
  assert.equal(context.target.kind, 'operator', 'T024-CHANGE-01 dot retains the semantic motion');
  const text = context.snapshot.slice(context.cursorOffset, asOffset(context.snapshot.lengthUtf16));
  assert.equal(text.ok, true, 'T024-CHANGE-02 motion resolver can read current content');
  return { ok: true, value: { motion: context.target.motionKey, currentSuffix: text.ok ? text.value : '', count: context.count } };
}));
assert.deepEqual(operatorReplay.resolved, { motion: 'w', currentSuffix: 'two three', count: 1 },
  'T024-CHANGE-03 motion is re-evaluated against the current snapshot');

const visualTarget = expectOk(createVimVisualRepeatTarget({
  selection: { kind: 'character', anchor: 0, head: 2 },
  replacementText: 'X',
}));
state = expectOk(recordVimRepeatTarget(state, visualTarget));
assert.ok(Object.isFrozen(visualTarget.selection), 'T024-VISUAL-01 visual selection metadata is immutable');
const visualReplay = expectOk(replayVimDot(state, {
  snapshot: source,
  cursorOffset: asOffset(6),
}, (context) => {
  assert.equal(context.target.kind, 'visual', 'T024-VISUAL-02 dot retains visual selection shape');
  return { ok: true, value: { selection: context.target.selection, replacementText: context.target.replacementText } };
}));
assert.deepEqual(visualReplay.resolved, {
  selection: { kind: 'character', anchor: 0, head: 2 }, replacementText: 'X',
}, 'T024-VISUAL-03 visual replay restores the recorded shape');

const putTarget = expectOk(createVimPutRepeatTarget({ registerName: 'a', putKind: 'linewise' }));
state = expectOk(recordVimRepeatTarget(state, putTarget));
const registers = new Map([['a', 'one\n'], ['b', 'changed\n']]);
const putReplay = expectOk(replayVimDot(state, {
  snapshot: openSnapshot('one\ntwo'),
  cursorOffset: asOffset(0),
}, (context) => {
  assert.equal(context.target.kind, 'put', 'T024-PUT-01 dot retains the source register');
  const payload = registers.get(context.target.registerName);
  assert.notEqual(payload, undefined, 'T024-PUT-02 register is read at replay time');
  return { ok: true, value: { payload, putKind: context.target.putKind } };
}));
assert.deepEqual(putReplay.resolved, { payload: 'one\n', putKind: 'linewise' },
  'T024-PUT-03 put replay resolves the current register payload');
registers.set('a', 'changed\n');
const changedPut = expectOk(replayVimDot(state, {
  snapshot: openSnapshot('one\ntwo'),
  cursorOffset: asOffset(0),
}, (context) => ({ ok: true, value: registers.get(context.target.kind === 'put' ? context.target.registerName : '') })));
assert.equal(changedPut.resolved, 'changed\n', 'T024-PUT-04 register changes are observed by a later dot');

const failedBefore = state;
for (const kind of ['failed-command', 'yank', 'service', 'undo', 'interrupted-insert'] as const) {
  const preserved = expectOk(applyVimRepeatEvent(state, { kind }));
  assert.strictEqual(preserved, failedBefore, `T024-STATE-01 ${kind} preserves the prior target`);
}
const noTarget = replayVimDot(createVimRepeatState(), {
  snapshot: source,
  cursorOffset: asOffset(0),
}, () => ({ ok: true, value: null }));
assert.deepEqual(noTarget, { ok: false, error: { kind: 'no-target' } }, 'T024-STATE-02 dot without a target is a no-op failure');
const eof = replayVimDot(state, {
  snapshot: source,
  cursorOffset: asOffset(source.lengthUtf16),
}, () => ({ ok: false, error: { kind: 'invalid-cursor' } }));
assert.deepEqual(eof, { ok: false, error: { kind: 'invalid-cursor' } }, 'T024-FAILURE-01 dot at EOF reports resolver failure');

const interrupted = expectOk(applyVimRepeatEvent(state, { kind: 'interrupted-insert' }));
assert.strictEqual(interrupted.target, putTarget, 'T024-FAILURE-02 interrupted insert does not replace target');
assert.deepEqual(expectError(createVimInsertRepeatTarget({ entryKey: 'i', mode: 'insert', text: '\r' })),
  { kind: 'invalid-text' }, 'T024-FAILURE-03 literal control requires textIntent metadata');
console.log(`T024 semantic repeat passed ${catalog.fixtures.length} pinned oracle fixtures; insert/change/visual/put replay, count override, register timing, undo and failure isolation verified`);
console.log(`oracle=Neovim ${generatedTrace.oracle.version}; binary=${generatedTrace.oracle.binarySha256}`);
console.log(`runtime_docs=${generatedTrace.oracle.runtimeDocsSha256}`);

function openSnapshot(text: string): DocumentSnapshot {
  const documentId = asIdentifier<DocumentId>(`t024-${text}`, 'documentId');
  if (!documentId.ok) throw new Error(`invalid fixture id: ${JSON.stringify(documentId.error)}`);
  const opened = openTextDocument(documentId.value, new TextEncoder().encode(text));
  assert.equal(opened.kind, 'editable', 'T024-OWNER-01 fixture opens as editable text');
  if (opened.kind !== 'editable') throw new Error('T024-OWNER-01 fixture did not open');
  return opened.document.snapshot();
}

function asOffset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error(`invalid offset: ${JSON.stringify(result.error)}`);
  return result.value;
}

function expectOk<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }): T {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
}

function expectError<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }): unknown {
  if (!result.ok) return result.error;
  throw new Error('unexpected success');
}
