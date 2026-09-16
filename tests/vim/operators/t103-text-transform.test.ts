#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeVimOperatorRange,
  prepareVimTextTransform,
  type VimNormalizedOperatorRange,
  type VimTextTransformProvider,
  type VimTextTransformOperator,
} from '../../../packages/vim/src/index';
import { openTextDocument, type DocumentEdit, type DocumentSnapshot } from '../../../packages/document/src/index';
import type { LineIndex } from '../../../packages/primitives/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type Utf16Offset } from '../../../packages/primitives/src/index';
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
const catalog = JSON.parse(await readFile(resolve(root, 'tests/vim/operators/t103-fixtures.json'), 'utf8')) as FixtureCatalog;
const trace = JSON.parse(await readFile(resolve(root, 'tests/vim/operators/t103-oracle-traces.json'), 'utf8')) as OracleTrace;
assert.equal(catalog.schemaVersion, 1, 'T103-ORACLE-CATALOG-01 fixture schema is supported');
assert.equal(trace.schemaVersion, 1, 'T103-ORACLE-TRACE-01 trace schema is supported');
assert.deepEqual(trace.fixtureIds, catalog.fixtures.map((fixture) => fixture.id),
  'T103-ORACLE-CATALOG-02 trace order matches fixture order');

const oracleFinalLines = new Map<string, readonly string[]>();
for (const fixture of trace.fixtures) {
  const final = fixture.snapshots.at(-1);
  assert.notEqual(final, undefined, `T103-ORACLE-TEXT-01 ${fixture.id} has final snapshot`);
  if (final !== undefined) oracleFinalLines.set(fixture.id, final.lines);
}

const caseSource = open('One TWO', 'T103-case');
const lowerRange = characterRange(caseSource, 0, 2);
const lower = expectOk(prepareVimTextTransform({ snapshot: caseSource, range: lowerRange, operator: 'gu' }));
assert.deepEqual(lower.transaction?.edits, [{ start: offset(0), end: offset(3), text: 'one' }],
  'T103-CASE-01 gu creates one UTF-16 replacement');
assert.equal(lower.historyEffect.kind, 'single-command', 'T103-HISTORY-01 case edits are one history command');
assert.equal(lower.historyEffect.breaksInsert, true, 'T103-HISTORY-02 case edits leave Insert mode');
assert.equal(lower.registerEffect, null, 'T103-REGISTER-01 case edits do not write a register');
assert.equal(applyEdits(text(caseSource), lower.transaction?.edits ?? []), 'one TWO',
  'T103-CASE-02 gu matches the pinned characterwise output');

const upper = expectOk(prepareVimTextTransform({ snapshot: caseSource, range: lowerRange, operator: 'gU' }));
assert.equal(applyEdits(text(caseSource), upper.transaction?.edits ?? []), 'ONE TWO', 'T103-CASE-03 gU uppercases the range');
const swap = expectOk(prepareVimTextTransform({ snapshot: caseSource, range: lowerRange, operator: 'g~' }));
assert.equal(applyEdits(text(caseSource), swap.transaction?.edits ?? []), 'oNE TWO', 'T103-CASE-04 g~ swaps case');

const lineSource = open('One TWO\nThree FOUR', 'T103-line');
const lineRange = lineRangeFor(lineSource, 0, 1);
const lineLower = expectOk(prepareVimTextTransform({ snapshot: lineSource, range: lineRange, operator: 'gu' }));
assert.equal(applyEdits(text(lineSource), lineLower.transaction?.edits ?? []), 'one two\nthree four',
  'T103-CASE-05 gu handles linewise ranges by composing per-line edits');

const blockSource = open('abCD\nefGH', 'T103-block');
const blockRange = blockRangeFor(blockSource, 0, 5, 0, 1);
const blockUpper = expectOk(prepareVimTextTransform({ snapshot: blockSource, range: blockRange, operator: 'gU' }));
assert.equal(applyEdits(text(blockSource), blockUpper.transaction?.edits ?? []), 'ABCD\nEFGH',
  'T103-CASE-06 gU preserves block rows while transforming selected cells');

const joinSource = open('Hello.  \n  world\nnext', 'T103-join');
const joinRange = lineRangeFor(joinSource, 0, 1);
const joined = expectOk(prepareVimTextTransform({
  snapshot: joinSource, range: joinRange, operator: 'J', options: { joinspaces: true },
}));
assert.equal(applyEdits(text(joinSource), joined.transaction?.edits ?? []), 'Hello.  world\nnext',
  'T103-JOIN-01 J uses joinspaces and trims only the joining edges');
const singleSpace = expectOk(prepareVimTextTransform({
  snapshot: joinSource, range: joinRange, operator: 'J', options: { joinspaces: false },
}));
assert.equal(applyEdits(text(joinSource), singleSpace.transaction?.edits ?? []), 'Hello. world\nnext',
  'T103-JOIN-02 J supports the one-space option');
const noSpace = expectOk(prepareVimTextTransform({ snapshot: joinSource, range: joinRange, operator: 'gJ' }));
assert.equal(applyEdits(text(joinSource), noSpace.transaction?.edits ?? []), 'Hello.world\nnext',
  'T103-JOIN-03 gJ joins without a separator');
assert.deepEqual(oracleFinalLines.get('T103-ORACLE-J-JOINSPACES-01'), ['Hello.  world', 'next'],
  'T103-JOIN-04 J result remains pinned to Neovim');

const indentSource = open('one\n  two', 'T103-indent');
const firstLine = lineRangeFor(indentSource, 0, 0);
const shifted = expectOk(prepareVimTextTransform({ snapshot: indentSource, range: firstLine, operator: '>' }));
assert.equal(applyEdits(text(indentSource), shifted.transaction?.edits ?? []), '\tone\n  two',
  'T103-INDENT-01 > uses a tab at the default shiftwidth');
const dedentSource = open('\t  one', 'T103-dedent');
const dedented = expectOk(prepareVimTextTransform({ snapshot: dedentSource, range: lineRangeFor(dedentSource, 0, 0), operator: '<' }));
assert.equal(applyEdits(text(dedentSource), dedented.transaction?.edits ?? []), '  one',
  'T103-INDENT-02 < removes one default shiftwidth including a tab');
const spaces = open('one', 'T103-spaces');
const expanded = expectOk(prepareVimTextTransform({
  snapshot: spaces, range: lineRangeFor(spaces, 0, 0), operator: '>',
  options: { shiftwidth: 2, tabstop: 8, expandtab: true },
}));
assert.equal(applyEdits(text(spaces), expanded.transaction?.edits ?? []), '  one',
  'T103-INDENT-03 expandtab uses spaces');

const formatSource = open('one two\nthree four', 'T103-format');
const formatRange = lineRangeFor(formatSource, 0, 1);
assert.deepEqual(prepareVimTextTransform({ snapshot: formatSource, range: formatRange, operator: '=' }),
  { ok: false, error: { kind: 'provider-unavailable', provider: 'indent' } },
  'T103-PROVIDER-01 = reports a missing indentation provider');
assert.deepEqual(prepareVimTextTransform({ snapshot: formatSource, range: formatRange, operator: 'gq' }),
  { ok: false, error: { kind: 'provider-unavailable', provider: 'format' } },
  'T103-PROVIDER-02 gq reports a missing format provider');
assert.deepEqual(prepareVimTextTransform({ snapshot: formatSource, range: formatRange, operator: 'gw' }),
  { ok: false, error: { kind: 'provider-unavailable', provider: 'format' } },
  'T103-PROVIDER-03 gw reports a missing format provider');

const indentProvider: VimTextTransformProvider = {
  id: 'test-indent',
  provide: (context) => ({ ok: true, value: [{ start: context.range.start, end: context.range.end, text: '  one\nthree four' }] }),
};
const providedIndent = expectOk(prepareVimTextTransform({
  snapshot: formatSource, range: formatRange, operator: '=', providers: { indent: indentProvider },
}));
assert.equal(providedIndent.transaction?.edits[0]?.text, '  one\nthree four',
  'T103-PROVIDER-04 = composes a typed provider replacement');
const formatProvider: VimTextTransformProvider = {
  id: 'test-format',
  provide: (context) => ({ ok: true, value: [{ start: context.range.start, end: context.range.end, text: 'one\nthree four' }] }),
};
const providedFormat = expectOk(prepareVimTextTransform({
  snapshot: formatSource, range: formatRange, operator: 'gw', providers: { format: formatProvider },
}));
assert.equal(providedFormat.cursorIntent.placement, 'preserve', 'T103-PROVIDER-05 gw preserves cursor intent');
assert.equal(providedFormat.transaction?.expectedVersion, formatSource.version, 'T103-PROVIDER-06 provider transaction is versioned');
const badProvider: VimTextTransformProvider = {
  id: 'bad-format',
  provide: () => ({ ok: true, value: [{ start: offset(0), end: offset(1), text: '\ud800' }] }),
};
assert.deepEqual(prepareVimTextTransform({
  snapshot: formatSource, range: formatRange, operator: 'gq', providers: { format: badProvider },
}), { ok: false, error: { kind: 'provider-invalid-edit', provider: 'format' } },
  'T103-PROVIDER-07 malformed provider text is rejected before commit');
let providerCancelled = false;
const cancellingProvider: VimTextTransformProvider = {
  id: 'cancelling-format',
  provide: () => {
    providerCancelled = true;
    return { ok: true, value: [] };
  },
};
assert.deepEqual(prepareVimTextTransform({
  snapshot: formatSource, range: formatRange, operator: 'gq', providers: { format: cancellingProvider },
  isCancelled: () => providerCancelled,
}), { ok: false, error: { kind: 'cancelled' } }, 'T103-PROVIDER-08 cancellation after provider is explicit');

const stale = prepareVimTextTransform({ snapshot: formatSource, range: formatRange, operator: 'gu', expectedVersion: asVersion(99) });
assert.deepEqual(stale, { ok: false, error: { kind: 'stale-document-version' } }, 'T103-FAILURE-01 stale plans fail before reads');
const invalidOptions = prepareVimTextTransform({ snapshot: caseSource, range: lowerRange, operator: 'gu', options: { shiftwidth: 0 } });
assert.deepEqual(invalidOptions, { ok: false, error: { kind: 'invalid-option' } }, 'T103-FAILURE-02 invalid indentation options are typed');
const emptyRange = Object.freeze({ ...lowerRange, start: offset(0), end: offset(0), ranges: Object.freeze([]) });
assert.deepEqual(prepareVimTextTransform({ snapshot: caseSource, range: emptyRange, operator: 'gu' }),
  { ok: false, error: { kind: 'invalid-range' } }, 'T103-FAILURE-03 empty ranges fail before a transaction');

console.log('T103 text-transform operators passed pinned case/join/indent traces; provider absence/composition, cancellation, malformed text and version failures verified');
console.log(`oracle=Neovim ${trace.oracle.version}; binary=${trace.oracle.binarySha256}`);

function open(source: string, id: string): DocumentSnapshot {
  const documentId = asIdentifier<DocumentId>(id, 'documentId');
  assert.equal(documentId.ok, true, 'T103-OWNER-01 fixture document id is valid');
  if (!documentId.ok) throw new Error('invalid document id');
  const opened = openTextDocument(documentId.value, new TextEncoder().encode(source));
  assert.equal(opened.kind, 'editable', 'T103-OWNER-02 fixture opens as editable text');
  if (opened.kind !== 'editable') throw new Error('fixture was not editable');
  return opened.document.snapshot();
}

function text(snapshot: DocumentSnapshot): string {
  const result = snapshot.slice(offset(0), offset(snapshot.lengthUtf16));
  assert.equal(result.ok, true, 'T103-COORDINATE-01 fixture text is readable');
  if (!result.ok) throw new Error('fixture text unavailable');
  return result.value;
}

function characterRange(snapshot: DocumentSnapshot, start: number, endInclusive: number): VimNormalizedOperatorRange {
  const normalized = normalizeVimOperatorRange(snapshot, {
    origin: endpoint(snapshot, start), target: endpoint(snapshot, endInclusive), direction: 'forward',
    motionKind: 'characterwise', inclusive: true, motionKey: 'l', operator: 'delete',
  });
  return expectOk(normalized);
}

function lineRangeFor(snapshot: DocumentSnapshot, first: number, last: number): VimNormalizedOperatorRange {
  const normalized = normalizeVimOperatorRange(snapshot, {
    origin: endpoint(snapshot, lineStart(snapshot, first)), target: endpoint(snapshot, lineStart(snapshot, last)),
    direction: 'forward', motionKind: 'linewise', inclusive: true, motionKey: 'j', operator: 'delete', forceKind: 'linewise',
  });
  return expectOk(normalized);
}

function blockRangeFor(snapshot: DocumentSnapshot, firstOffset: number, lastOffset: number, left: number, right: number): VimNormalizedOperatorRange {
  const normalized = normalizeVimOperatorRange(snapshot, {
    origin: { ...endpoint(snapshot, firstOffset), displayCellColumn: left },
    target: { ...endpoint(snapshot, lastOffset), displayCellColumn: right },
    direction: 'forward', motionKind: 'characterwise', inclusive: true, motionKey: 'l', operator: 'delete', forceKind: 'blockwise',
  });
  return expectOk(normalized);
}

function endpoint(snapshot: DocumentSnapshot, at: number) {
  return { documentVersion: snapshot.version, offset: offset(at) };
}

function lineStart(snapshot: DocumentSnapshot, line: number): number {
  const result = snapshot.lineStartOffset(line as LineIndex);
  assert.equal(result.ok, true, 'T103-COORDINATE-02 line exists');
  if (!result.ok) throw new Error('line unavailable');
  return result.value as number;
}

function applyEdits(source: string, edits: readonly DocumentEdit[]): string {
  return [...edits].sort((left, right) => (right.start as number) - (left.start as number))
    .reduce((value, edit) => `${value.slice(0, edit.start as number)}${edit.text}${value.slice(edit.end as number)}`, source);
}

function offset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  assert.equal(result.ok, true, 'T103-COORDINATE-03 offset is safe');
  if (!result.ok) throw new Error('invalid offset');
  return result.value;
}

function asVersion(value: number) {
  const result = (value >= 1 && Number.isSafeInteger(value)) ? value : 1;
  return result as DocumentSnapshot['version'];
}

function expectOk<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }): T {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
}
