#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { asUndoGroupId, type DocumentId, type LineIndex, type UndoGroupId, type Utf16Offset } from '../../../packages/primitives/src/index';
import { openTextDocument, type DocumentEdit } from '../../../packages/document/src/index';
import {
  parseVimExCommand,
  parseVimExSequence,
  prepareVimEx,
  resolveVimExCommandName,
  resolveVimExRange,
  type VimExCommand,
  type VimExPrepareContext,
} from '../../../packages/vim/ex/index';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture } from '../../oracle/types';

function parse(source: string): VimExCommand {
  const result = parseVimExCommand(source);
  assert.equal(result.ok, true, `T028 parse ${source}`);
  if (!result.ok) throw new Error(`T028 parse ${source}`);
  return result.value;
}

function open(id: string, text: string) {
  const result = openTextDocument(id as DocumentId, new TextEncoder().encode(text));
  assert.equal(result.kind, 'editable', `T028 document ${id}`);
  if (result.kind !== 'editable') throw new Error(`T028 document ${id}`);
  return result.document;
}

function context(currentLine: number, extra: Partial<VimExPrepareContext> = {}): VimExPrepareContext {
  return { currentLine: currentLine as LineIndex, ...extra };
}

function applyPlan(document: ReturnType<typeof open>, command: VimExCommand, planEdits: readonly DocumentEdit[], undoGroup: string) {
  const group = asUndoGroupId(undoGroup);
  assert.equal(group.ok, true, 'T028 transaction undo group is valid');
  if (!group.ok) throw new Error('T028 transaction undo group');
  const committed = document.commit({
    documentId: document.id,
    expectedVersion: document.version,
    edits: planEdits,
    origin: 'vim',
    undoGroup: group.value,
  });
  assert.equal(committed.ok, true, `T028 transaction for ${command.name} commits atomically`);
  if (!committed.ok) throw new Error(`T028 transaction for ${command.name}`);
  return document.snapshot();
}

function text(snapshot: ReturnType<ReturnType<typeof open>['snapshot']>): string {
  const value = snapshot.slice(0 as Utf16Offset, snapshot.lengthUtf16 as Utf16Offset);
  assert.equal(value.ok, true, 'T028 snapshot text read');
  if (!value.ok) throw new Error('T028 snapshot text read');
  return value.value;
}

function applyEdits(source: string, edits: readonly DocumentEdit[]): string {
  return [...edits].sort((left, right) => (right.start as number) - (left.start as number))
    .reduce((value, edit) => `${value.slice(0, edit.start as number)}${edit.text}${value.slice(edit.end as number)}`, source);
}

const resolvedS = resolveVimExCommandName('s');
assert.equal(resolvedS.ok, true);
if (!resolvedS.ok) throw new Error('T028-COMMAND-ABBREV-01');
assert.equal(resolvedS.value, 'substitute', 'T028-COMMAND-ABBREV-01 resolves :s');
const resolvedNorm = resolveVimExCommandName('norm');
assert.equal(resolvedNorm.ok, true);
if (!resolvedNorm.ok) throw new Error('T028-COMMAND-ABBREV-02');
assert.equal(resolvedNorm.value, 'normal', 'T028-COMMAND-ABBREV-02 resolves the reviewed :norm abbreviation');
const resolvedCo = resolveVimExCommandName('co');
assert.equal(resolvedCo.ok, true);
if (!resolvedCo.ok) throw new Error('T028-COMMAND-ABBREV-03');
assert.equal(resolvedCo.value, 'copy', 'T028-COMMAND-ABBREV-03 resolves :co');
const resolvedWrite = resolveVimExCommandName('write');
assert.equal(resolvedWrite.ok, true);
if (!resolvedWrite.ok) throw new Error('T028-COMMAND-ABBREV-04');
assert.equal(resolvedWrite.value, 'write', 'T028-COMMAND-ABBREV-04 resolves :write');
assert.equal(resolveVimExCommandName('unknown').ok, false, 'T028-COMMAND-FAIL-01 rejects unknown native commands');

const rangeCommand = parse(":'a+1,'b-1d");
assert.equal(rangeCommand.range?.separator, ',', 'T028-RANGE-01 parses comma-separated marked addresses');
assert.equal(rangeCommand.range?.start.address.kind, 'mark');
assert.equal(rangeCommand.range?.start.offset, 1);
assert.equal(rangeCommand.metadata.commandNameStart, 10, 'T028-METADATA-01 reports source command position');
const sequence = parseVimExSequence(':s/foo|bar/baz/|2,3d');
assert.equal(sequence.ok, true, 'T028-SEPARATOR-01 parses a command sequence');
if (!sequence.ok) throw new Error('T028-SEPARATOR-01');
assert.equal(sequence.value.length, 2);
assert.equal(sequence.value[0]?.arguments.kind, 'substitute');
if (sequence.value[0]?.arguments.kind === 'substitute') assert.equal(sequence.value[0].arguments.pattern, 'foo|bar', 'T028-SEPARATOR-02 keeps a pipe inside a pattern');
assert.equal(sequence.value[1]?.name, 'delete');
const escapedDelimiter = parse(':s#foo\\#bar#baz#gi');
assert.equal(escapedDelimiter.arguments.kind, 'substitute');
if (escapedDelimiter.arguments.kind === 'substitute') {
  assert.equal(escapedDelimiter.arguments.pattern, 'foo\\#bar', 'T028-DELIMITER-01 preserves escaped delimiters for Vim pattern parsing');
  assert.equal(escapedDelimiter.arguments.flags, 'gi');
}
assert.equal(parseVimExSequence(':g/foo/g/bar/d').ok, false, 'T028-GLOBAL-FAIL-01 rejects nested global commands before editing');

const markedDocument = open('t028-range', 'one\ntwo\nthree\nfour');
const markedSnapshot = markedDocument.snapshot();
const marked = new Map<string, LineIndex>([['a', 0 as LineIndex], ['b', 3 as LineIndex]]);
const resolvedMarked = resolveVimExRange(markedSnapshot, rangeCommand.range, context(1, { marks: marked }));
assert.equal(resolvedMarked.ok, true, 'T028-RANGE-02 resolves marks and offsets against one snapshot');
if (!resolvedMarked.ok) throw new Error('T028-RANGE-02');
assert.deepEqual([resolvedMarked.value.firstLine, resolvedMarked.value.lastLine], [1, 2]);
const percent = resolveVimExRange(markedSnapshot, parse(':%d').range, context(2));
assert.equal(percent.ok, true);
if (!percent.ok) throw new Error('T028-RANGE-PERCENT');
assert.deepEqual([percent.value.firstLine, percent.value.lastLine], [0, 3]);
const semicolon = resolveVimExRange(markedSnapshot, parse(':2;+1d').range, context(3));
assert.equal(semicolon.ok, true, 'T028-RANGE-03 resolves ; relative to the first address');
if (!semicolon.ok) throw new Error('T028-RANGE-03');
assert.deepEqual([semicolon.value.firstLine, semicolon.value.lastLine], [1, 2]);
const searchAddress = resolveVimExRange(markedSnapshot, parse(':/three/d').range, context(0, { wrapscan: false }));
assert.equal(searchAddress.ok, true, 'T028-RANGE-04 resolves a Vim search address with the owned pattern evaluator');
if (!searchAddress.ok) throw new Error('T028-RANGE-04');
assert.equal(searchAddress.value.firstLine, 2);

const deleteDocument = open('t028-delete', 'one\ntwo\nthree\ntwo');
const deleteCommand = parse(':2,3delete a');
const deletePlan = prepareVimEx(deleteDocument.snapshot(), deleteCommand, context(0));
assert.equal(deletePlan.ok, true, 'T028-DELETE-01 prepares a linewise delete');
if (!deletePlan.ok) throw new Error('T028-DELETE-01');
assert.deepEqual(deletePlan.value.registerEffect, { operation: 'delete', destination: 'a', lines: ['two', 'three'], type: 'V' });
assert.equal(applyEdits('one\ntwo\nthree\ntwo', deletePlan.value.edits), 'one\ntwo');
const deleteSnapshot = applyPlan(deleteDocument, deleteCommand, deletePlan.value.edits, deletePlan.value.undoGroup);
assert.equal(text(deleteSnapshot), 'one\ntwo', 'T028-TRANSACTION-01 Ex delete uses the shared document transaction');
const undone = deleteDocument.undo();
assert.equal(undone.ok, true, 'T028-TRANSACTION-02 the Ex edit is in document undo history');
assert.equal(text(deleteDocument.snapshot()), 'one\ntwo\nthree\ntwo');

const yankDocument = open('t028-yank', 'one\ntwo\nthree');
const yankPlan = prepareVimEx(yankDocument.snapshot(), parse(':2yank a'), context(0));
assert.equal(yankPlan.ok, true);
if (!yankPlan.ok) throw new Error('T028-YANK');
assert.equal(yankPlan.value.edits.length, 0, 'T028-YANK-01 yank does not mutate the document');
assert.deepEqual(yankPlan.value.registerEffect?.lines, ['two']);

const copyDocument = open('t028-copy', 'one\ntwo\nthree\nfour');
const copyCommand = parse(':1,2copy4');
const copyPlan = prepareVimEx(copyDocument.snapshot(), copyCommand, context(0));
assert.equal(copyPlan.ok, true, 'T028-COPY-01 prepares a linewise copy');
if (!copyPlan.ok) throw new Error('T028-COPY-01');
assert.equal(applyEdits('one\ntwo\nthree\nfour', copyPlan.value.edits), 'one\ntwo\nthree\nfour\none\ntwo');

const moveDocument = open('t028-move', 'one\ntwo\nthree\nfour');
const moveCommand = parse(':1,2move4');
const movePlan = prepareVimEx(moveDocument.snapshot(), moveCommand, context(0));
assert.equal(movePlan.ok, true, 'T028-MOVE-01 prepares a linewise move');
if (!movePlan.ok) throw new Error('T028-MOVE-01');
assert.equal(applyEdits('one\ntwo\nthree\nfour', movePlan.value.edits), 'three\nfour\none\ntwo');
assert.equal(prepareVimEx(moveDocument.snapshot(), parse(':1,2move1'), context(0)).ok, false, 'T028-MOVE-FAIL-01 rejects destinations inside the source range');

const globalDocument = open('t028-global', 'one\ntwo\nthree\ntwo');
const globalCommand = parse(':g/two/s/two/TWO/g');
const globalPlan = prepareVimEx(globalDocument.snapshot(), globalCommand, context(0));
assert.equal(globalPlan.ok, true, 'T028-GLOBAL-01 prepares a global substitute from one marked-line pass');
if (!globalPlan.ok) throw new Error('T028-GLOBAL-01');
assert.equal(applyEdits('one\ntwo\nthree\ntwo', globalPlan.value.edits), 'one\nTWO\nthree\nTWO');
assert.equal(globalPlan.value.nestedPlans.length, 2);
const vglobalDocument = open('t028-vglobal', 'one\ntwo\nthree\ntwo');
const vglobalPlan = prepareVimEx(vglobalDocument.snapshot(), parse(':v/two/d'), context(0));
assert.equal(vglobalPlan.ok, true, 'T028-VGLOBAL-01 prepares the inverse marked-line operation');
if (!vglobalPlan.ok) throw new Error('T028-VGLOBAL-01');
assert.equal(applyEdits('one\ntwo\nthree\ntwo', vglobalPlan.value.edits), 'two\ntwo');
const normalGlobal = prepareVimEx(globalDocument.snapshot(), parse(':g/two/normal x'), context(0));
assert.equal(normalGlobal.ok, true, 'T028-NORMAL-01 composes a supported normal command through global');
if (!normalGlobal.ok) throw new Error('T028-NORMAL-01');
assert.equal(applyEdits('one\ntwo\nthree\ntwo', normalGlobal.value.edits), 'one\nwo\nthree\nwo');
const nestedGlobal = parseVimExCommand(':g/two/g/bar/d');
assert.equal(nestedGlobal.ok, false, 'T028-GLOBAL-FAIL-02 nested global has no partial plan');

const substituteDocument = open('t028-repeat-substitute', 'two\ntwo');
const substituteCommand = parse(':s/two/T/g');
const substitutePlan = prepareVimEx(substituteDocument.snapshot(), substituteCommand, context(0, { searchState: { pattern: null, direction: null, lastMatch: null, previousReplacement: null } }));
assert.equal(substitutePlan.ok, true, 'T028-SUBSTITUTE-01 prepares the first substitute and state');
if (!substitutePlan.ok) throw new Error('T028-SUBSTITUTE-01');
assert.deepEqual(substitutePlan.value.substituteState, { pattern: 'two', replacement: 'T', flags: 'g' });
const repeated = prepareVimEx(substituteDocument.snapshot(), parse(':&'), context(0, { lastSubstitute: substitutePlan.value.substituteState ?? undefined }));
assert.equal(repeated.ok, true, 'T028-SUBSTITUTE-02 repeats the previous substitute');
if (!repeated.ok) throw new Error('T028-SUBSTITUTE-02');
assert.equal(applyEdits('two\ntwo', repeated.value.edits), 'T\ntwo');
const unsupportedScript = prepareVimEx(substituteDocument.snapshot(), parse(':s/two/\\=system("touch")/'), context(0));
assert.equal(unsupportedScript.ok, false, 'T028-SCRIPT-FAIL-01 rejects expression replacement without an unintended edit');
if (unsupportedScript.ok) throw new Error('T028-SCRIPT-FAIL-01');
assert.equal(unsupportedScript.error.kind, 'unsupported-script');

const hostSnapshot = open('t028-host', 'text').snapshot();
const writePlan = prepareVimEx(hostSnapshot, parse(':write! target.txt'), context(0));
assert.equal(writePlan.ok, true, 'T028-HOST-01 prepares write as a typed host effect');
if (!writePlan.ok) throw new Error('T028-HOST-01');
assert.deepEqual(writePlan.value.hostEffects, [{ kind: 'write', documentId: hostSnapshot.id, expectedVersion: hostSnapshot.version, path: 'target.txt', bang: true }]);
assert.equal(writePlan.value.edits.length, 0);
const openPlan = prepareVimEx(hostSnapshot, parse(':edit other.txt'), context(0));
assert.equal(openPlan.ok, true);
if (!openPlan.ok) throw new Error('T028-HOST-OPEN');
assert.deepEqual(openPlan.value.hostEffects, [{ kind: 'open', path: 'other.txt', bang: false }]);
const quitPlan = prepareVimEx(hostSnapshot, parse(':quit!'), context(0));
assert.equal(quitPlan.ok, true);
if (!quitPlan.ok) throw new Error('T028-HOST-QUIT');
assert.deepEqual(quitPlan.value.hostEffects, [{ kind: 'quit', bang: true }]);
const multiPlan = prepareVimEx(hostSnapshot, parse(':delete'), context(0, { selectionCount: 4 }));
assert.equal(multiPlan.ok, true);
if (!multiPlan.ok) throw new Error('T028-MULTI');
assert.deepEqual(multiPlan.value.execution, { kind: 'document-once', primaryRange: true, selectionCount: 4 }, 'T028-MULTI-01 Ex edits execute once for the primary document range');

const oracle = await verifyOracleBundle();
const deleteOracleFixture: OracleFixture = {
  id: 'T028-EX-DELETE-ORACLE',
  title: 'Pinned Ex line delete',
  purpose: 'Compare Ex range resolution, resulting lines and cursor state with Neovim.',
  modes: ['normal'],
  lines: ['one', 'two', 'three', 'two'],
  cursor: { line: 1, byteColumn0: 0 },
  steps: [{ label: 'delete', keys: ':2,3delete<CR>' }],
};
const deleteOracle = await runOracleFixture(deleteOracleFixture, oracle.binaryPath);
const deleteOracleSnapshot = deleteOracle.snapshots[0];
assert(deleteOracleSnapshot !== undefined, 'T028-ORACLE-DELETE-01 snapshot exists');
if (deleteOracleSnapshot !== undefined) {
  assert.deepEqual(deleteOracleSnapshot.lines, ['one', 'two'], 'T028-ORACLE-DELETE-01 result lines match');
  assert.deepEqual([deleteOracleSnapshot.cursor.line, deleteOracleSnapshot.cursor.byteColumn], [2, 1], 'T028-ORACLE-DELETE-02 cursor matches');
}
const globalOracleFixture: OracleFixture = {
  id: 'T028-EX-GLOBAL-ORACLE',
  title: 'Pinned Ex global substitute',
  purpose: 'Compare global line selection and nested substitute output with Neovim.',
  modes: ['normal'],
  lines: ['one', 'two', 'three', 'two'],
  cursor: { line: 1, byteColumn0: 0 },
  steps: [{ label: 'global-substitute', keys: ':g/two/s/two/TWO/g<CR>' }],
};
const globalOracle = await runOracleFixture(globalOracleFixture, oracle.binaryPath);
const globalOracleSnapshot = globalOracle.snapshots[0];
assert(globalOracleSnapshot !== undefined, 'T028-ORACLE-GLOBAL-01 snapshot exists');
if (globalOracleSnapshot !== undefined) {
  assert.deepEqual(globalOracleSnapshot.lines, ['one', 'TWO', 'three', 'TWO'], 'T028-ORACLE-GLOBAL-01 result lines match');
  assert.deepEqual(globalOracleSnapshot.search, { pattern: 'two', forward: 1, highlighting: 1 }, 'T028-ORACLE-GLOBAL-02 search state matches');
}

console.log('PASS T028 Ex parser/commands: addresses/marks/offsets/separators, global/vglobal/normal, move/copy/delete/yank, repeated substitute, typed host effects, shared transaction/history and pinned Neovim editing snapshots');
