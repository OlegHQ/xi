#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asIdentifier, asUtf16Offset, type DocumentId } from '../../../packages/primitives/src/index';
import { openTextDocument } from '../../../packages/document/src/index';
import { createVimJumpHistory, recordVimJump, jumpBackward, createVimChangeHistory, recordVimChange } from '../../../packages/vim/src/index';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture } from '../../oracle/types';

interface Catalog { readonly schemaVersion: number; readonly fixtures: readonly OracleFixture[] }
const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const catalog = JSON.parse(await readFile(resolve(root, 'tests/vim/navigation/t030-fixtures.json'), 'utf8')) as Catalog;
assert.equal(catalog.schemaVersion, 1, 'T030-ORACLE-CATALOG-01 fixture schema');
const oracle = await verifyOracleBundle();
const jumpFixture = catalog.fixtures.find((fixture) => fixture.id === 'T030-ORACLE-JUMP-01');
const changeFixture = catalog.fixtures.find((fixture) => fixture.id === 'T030-ORACLE-CHANGE-01');
assert.ok(jumpFixture && changeFixture, 'T030-ORACLE-CATALOG-02 required fixtures present');
if (jumpFixture === undefined || changeFixture === undefined) throw new Error('missing T030 oracle fixture');
const jumpOracle = await runOracleFixture(jumpFixture, oracle.binaryPath);
const jumpFinal = jumpOracle.snapshots.at(-1);
assert.ok(jumpFinal, 'T030-ORACLE-JUMP-02 final snapshot present');
if (jumpFinal === undefined) throw new Error('missing jump final snapshot');
assert.equal(jumpFinal.cursor.line, 3, 'T030-ORACLE-JUMP-03 Ctrl-O returns the prior jump location');
const jumpList = objectValue(jumpFinal.jumpList, 'jump list');
const jumpPayload = jumpList.entries;
assert.ok(Array.isArray(jumpPayload), 'T030-ORACLE-JUMP-04 oracle has jump entries');
if (!Array.isArray(jumpPayload)) throw new Error('invalid jump payload');
const jumpEntries = Array.isArray(jumpPayload[0]) ? jumpPayload[0] : jumpPayload;
const jumpIndex = Array.isArray(jumpPayload[0]) ? jumpPayload[1] : jumpList.index;
assert.equal(jumpEntries.length, 2, 'T030-ORACLE-JUMP-04 oracle has two jump entries');
assert.equal(jumpIndex, 0, 'T030-ORACLE-JUMP-05 oracle index points at the older entry');

const documentIdResult = asIdentifier<DocumentId>('t030-oracle-jump', 'document-id');
assert.equal(documentIdResult.ok, true);
if (!documentIdResult.ok) throw new Error('invalid T030 oracle document id');
const opened = openTextDocument(documentIdResult.value, new TextEncoder().encode(jumpFixture.lines.join('\n')));
assert.equal(opened.kind, 'editable');
if (opened.kind !== 'editable') throw new Error('T030 oracle document did not open');
const snapshot = opened.document.snapshot();
const lineOffset = (line: number): ReturnType<typeof asUtf16Offset> => {
  const start = snapshot.lineStartOffset((line - 1) as never);
  return start.ok
    ? asUtf16Offset(start.value as number)
    : { ok: false, error: { path: 'line', code: 'invalid-value', message: 'missing line' } };
};
const atLine = (line: number) => {
  const result = lineOffset(line); assert.equal(result.ok, true); if (!result.ok) throw new Error('line offset failed'); return result.value;
};
let jumps = createVimJumpHistory();
jumps = expectOk(recordVimJump(jumps, { documentId: snapshot.id, documentVersion: snapshot.version, offset: atLine(1) }, 'manual'));
jumps = expectOk(recordVimJump(jumps, { documentId: snapshot.id, documentVersion: snapshot.version, offset: atLine(3) }, 'manual'));
const movedBack = expectOk(jumpBackward(jumps));
assert.equal(movedBack.target.offset, atLine(3), 'T030-ORACLE-JUMP-06 Xi jump target matches oracle entry');
assert.equal(movedBack.state.index, 1, 'T030-ORACLE-JUMP-07 Xi jump index matches the pre-forward position');

const changeOracle = await runOracleFixture(changeFixture, oracle.binaryPath);
const changeFinal = changeOracle.snapshots.at(-1);
assert.ok(changeFinal, 'T030-ORACLE-CHANGE-01 final snapshot present');
if (changeFinal === undefined) throw new Error('missing change final snapshot');
assert.deepEqual(changeFinal.lines, ['one', 'two'], 'T030-ORACLE-CHANGE-08 undo restores source text');
const changeList = objectValue(changeFinal.changeList, 'change list');
const changePayload = changeList.entries;
assert.ok(Array.isArray(changePayload), 'T030-ORACLE-CHANGE-09 change list payload exists');
if (!Array.isArray(changePayload)) throw new Error('invalid change payload');
const changeEntries = Array.isArray(changePayload[0]) ? changePayload[0] : changePayload;
assert.ok(changeEntries.length >= 1, 'T030-ORACLE-CHANGE-09 change list retains the edit location after undo');
let changes = createVimChangeHistory();
changes = expectOk(recordVimChange(changes, { documentId: snapshot.id, documentVersion: snapshot.version, offset: atLine(1) }));
assert.equal(changes.entries.length, 1, 'T030-ORACLE-CHANGE-10 Xi change list retains one edit location');
console.log(`T030 oracle navigation passed ${catalog.fixtures.length} pinned fixtures; jump/change list observations match Neovim ${oracle.manifest.oracle.version}`);

function expectOk<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }): T {
  if (result.ok) return result.value;
  throw new Error(`unexpected T030 oracle failure: ${JSON.stringify(result.error)}`);
}

function objectValue(value: unknown, label: string): { readonly [key: string]: unknown } {
  assert.equal(typeof value, 'object', `T030-ORACLE-OBJECT-01 ${label} is an object`);
  assert.notEqual(value, null, `T030-ORACLE-OBJECT-02 ${label} is not null`);
  assert.equal(Array.isArray(value), false, `T030-ORACLE-OBJECT-03 ${label} is not an array`);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`invalid ${label}`);
  return value as { readonly [key: string]: unknown };
}
