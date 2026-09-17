#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { openTextDocument } from '../../../packages/document/src/index';
import type { DocumentEdit, DocumentId, LineIndex, Utf16Offset } from '../../../packages/document/src/index';
import {
  beginVimSearch,
  EMPTY_VIM_SEARCH_STATE,
  parseVimSubstituteCommand,
  prepareVimSubstitute,
  searchVimBuffer,
  searchVimOperator,
  type VimSearchState,
  type VimSearchView,
} from '../../../packages/vim/src/index';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture } from '../../oracle/types';

const opened = openTextDocument('t027-search' as DocumentId, new TextEncoder().encode('foo x foo\nx foo\nfoo\n'));
assert.equal(opened.kind, 'editable');
if (opened.kind !== 'editable') throw new Error('T027-DOCUMENT');
const document = opened.document;
const snapshot = document.snapshot();
const view: VimSearchView = { cursor: 0 as Utf16Offset, desiredDisplayColumn: 0, scrollTop: 0, scrollLeft: 0 };

function applyEdits(source: string, edits: readonly DocumentEdit[]): string {
  return [...edits].sort((left, right) => (right.start as number) - (left.start as number))
    .reduce((value, edit) => `${value.slice(0, edit.start as number)}${edit.text}${value.slice(edit.end as number)}`, source);
}

const first = searchVimBuffer(snapshot, view, EMPTY_VIM_SEARCH_STATE, {
  command: 'search', pattern: 'foo', direction: 'forward', wrapscan: false,
});
assert.equal(first.ok, true, 'T027-SEARCH-FORWARD-01 finds the next match');
if (!first.ok) throw new Error('T027-SEARCH-FORWARD-01');
assert.equal(first.value.outcome.kind, 'found');
if (first.value.outcome.kind !== 'found') throw new Error('T027-SEARCH-FORWARD-01-NOT-FOUND');
assert.equal(first.value.outcome.match.cursor, 6, 'forward search skips the match under the cursor');
assert.equal(first.value.state.pattern, 'foo');
assert.equal(first.value.state.direction, 'forward');

const next = searchVimBuffer(snapshot, first.value.view, first.value.state, { command: 'next', wrapscan: false });
assert.equal(next.ok, true, 'T027-SEARCH-NEXT-01 finds the following match');
if (!next.ok) throw new Error('T027-SEARCH-NEXT-01');
assert.equal(next.value.outcome.kind, 'found');
if (next.value.outcome.kind !== 'found') throw new Error('T027-SEARCH-NEXT-01-NOT-FOUND');
assert.equal(next.value.outcome.match.cursor, 12);

const backward = searchVimBuffer(snapshot, view, EMPTY_VIM_SEARCH_STATE, {
  command: 'search', pattern: 'foo', direction: 'backward', wrapscan: false,
});
assert.equal(backward.ok, true, 'T027-SEARCH-BACKWARD-01 completes without mutation');
if (!backward.ok) throw new Error('T027-SEARCH-BACKWARD-01');
assert.equal(backward.value.outcome.kind, 'no-match', 'no earlier match is reported without wrap');
assert.equal(backward.value.view.cursor, view.cursor, 'no-match preserves the original view');

const wrapped = searchVimBuffer(snapshot, { ...view, cursor: 18 as Utf16Offset }, first.value.state, {
  command: 'next', wrapscan: true,
});
assert.equal(wrapped.ok, true);
if (!wrapped.ok) throw new Error('T027-SEARCH-WRAP');
assert.equal(wrapped.value.outcome.kind, 'found');
if (wrapped.value.outcome.kind !== 'found') throw new Error('T027-SEARCH-WRAP-NOT-FOUND');
assert.equal(wrapped.value.outcome.match.wrapped, true, 'T027-SEARCH-WRAP-01 records a wrapped search');
assert.equal(wrapped.value.outcome.match.cursor, 0);

const noWrap = searchVimBuffer(snapshot, { ...view, cursor: 19 as Utf16Offset }, first.value.state, {
  command: 'next', wrapscan: false,
});
assert.equal(noWrap.ok, true);
if (!noWrap.ok) throw new Error('T027-SEARCH-NOWRAP');
assert.equal(noWrap.value.outcome.kind, 'no-match');
if (noWrap.value.outcome.kind !== 'no-match') throw new Error('T027-SEARCH-NOWRAP-NOT-FOUND');
assert.equal(noWrap.value.outcome.reason, 'no-wrap', 'T027-SEARCH-NOWRAP-01 preserves no-wrap failure');

const preview = beginVimSearch(snapshot, view, EMPTY_VIM_SEARCH_STATE, { command: 'search', pattern: 'foo', wrapscan: false });
assert.equal(preview.ok, true);
if (!preview.ok) throw new Error('T027-PREVIEW');
const pending = preview.value.resume(1);
assert.equal(pending.ok, true);
const cancellation = preview.value.cancel();
assert.equal(cancellation.kind, 'cancelled');
assert.deepEqual(cancellation.view, view, 'T027-SEARCH-CANCEL-01 restores cursor and scroll state');
assert.deepEqual(cancellation.state, EMPTY_VIM_SEARCH_STATE, 'T027-SEARCH-CANCEL-02 leaves committed search state unchanged');
const cancelledResume = preview.value.resume(1);
assert.equal(cancelledResume.ok, false, 'T027-SEARCH-CANCEL-03 reports cancellation through the evaluator');
if (cancelledResume.ok) throw new Error('T027-SEARCH-CANCEL-03');
assert.equal(cancelledResume.error.kind, 'pattern-error');
if (cancelledResume.error.kind === 'pattern-error') assert.equal(cancelledResume.error.error.code, 'cancelled');

const stalePreview = beginVimSearch(snapshot, view, EMPTY_VIM_SEARCH_STATE, { command: 'search', pattern: 'foo' });
assert.equal(stalePreview.ok, true);
if (!stalePreview.ok) throw new Error('T027-STALE-PREVIEW');
const staleComplete = stalePreview.value.resume(Number.MAX_SAFE_INTEGER);
assert.equal(staleComplete.ok, true);
const edited = document.apply({ start: 0 as Utf16Offset, end: 0 as Utf16Offset, text: '!' }, snapshot.version);
assert.equal(edited.ok, true);
const staleCommit = stalePreview.value.commit(document.snapshot());
assert.equal(staleCommit.ok, false, 'T027-SEARCH-STALE-01 rejects an old snapshot at commit');
if (staleCommit.ok) throw new Error('T027-SEARCH-STALE-01');
assert.equal(staleCommit.error.kind, 'stale-snapshot');

const star = searchVimBuffer(snapshot, { ...view, cursor: 0 as Utf16Offset }, EMPTY_VIM_SEARCH_STATE, { command: 'star', wrapscan: false });
assert.equal(star.ok, true, 'T027-SEARCH-STAR-01 derives a literal full-word pattern');
if (!star.ok) throw new Error('T027-SEARCH-STAR-01');
assert.equal(star.value.outcome.kind, 'found');
if (star.value.outcome.kind !== 'found') throw new Error('T027-SEARCH-STAR-01-NOT-FOUND');
assert.equal(star.value.outcome.match.cursor, 6);
const hash = searchVimBuffer(snapshot, { ...view, cursor: 12 as Utf16Offset }, EMPTY_VIM_SEARCH_STATE, { command: 'hash', wrapscan: false });
assert.equal(hash.ok, true, 'T027-SEARCH-HASH-01 derives a backward full-word pattern');
if (!hash.ok) throw new Error('T027-SEARCH-HASH-01');
assert.equal(hash.value.outcome.kind, 'found');
if (hash.value.outcome.kind !== 'found') throw new Error('T027-SEARCH-HASH-01-NOT-FOUND');
assert.equal(hash.value.outcome.match.cursor, 6);
const partialStar = searchVimBuffer(snapshot, { ...view, cursor: 0 as Utf16Offset }, EMPTY_VIM_SEARCH_STATE, { command: 'gstar', wrapscan: false });
assert.equal(partialStar.ok, true, 'T027-SEARCH-GSTAR-01 derives a partial literal word pattern');
if (!partialStar.ok) throw new Error('T027-SEARCH-GSTAR-01');
assert.equal(partialStar.value.outcome.kind, 'found');
if (partialStar.value.outcome.kind !== 'found') throw new Error('T027-SEARCH-GSTAR-01-NOT-FOUND');
assert.equal(partialStar.value.outcome.match.cursor, 6);
const partialHash = searchVimBuffer(snapshot, { ...view, cursor: 12 as Utf16Offset }, EMPTY_VIM_SEARCH_STATE, { command: 'ghash', wrapscan: false });
assert.equal(partialHash.ok, true, 'T027-SEARCH-GHASH-01 derives a backward partial literal word pattern');
if (!partialHash.ok) throw new Error('T027-SEARCH-GHASH-01');
assert.equal(partialHash.value.outcome.kind, 'found');
if (partialHash.value.outcome.kind !== 'found') throw new Error('T027-SEARCH-GHASH-01-NOT-FOUND');
assert.equal(partialHash.value.outcome.match.cursor, 6);
const forwardStarAfterBackward = searchVimBuffer(snapshot, { ...view, cursor: 0 as Utf16Offset }, { ...EMPTY_VIM_SEARCH_STATE, direction: 'backward' }, { command: 'star', wrapscan: false });
assert.equal(forwardStarAfterBackward.ok, true, 'T027-SEARCH-STAR-02 keeps star direction independent of prior N/? state');
if (!forwardStarAfterBackward.ok) throw new Error('T027-SEARCH-STAR-02');
assert.equal(forwardStarAfterBackward.value.outcome.kind, 'found');
if (forwardStarAfterBackward.value.outcome.kind !== 'found') throw new Error('T027-SEARCH-STAR-02-NOT-FOUND');
assert.equal(forwardStarAfterBackward.value.outcome.match.cursor, 6);
const offsetSearch = searchVimBuffer(snapshot, view, EMPTY_VIM_SEARCH_STATE, { command: 'search', pattern: 'foo', offset: { kind: 'end', amount: 0 }, wrapscan: false });
assert.equal(offsetSearch.ok, true);
if (!offsetSearch.ok) throw new Error('T027-SEARCH-OFFSET');
assert.equal(offsetSearch.value.outcome.kind, 'found');
if (offsetSearch.value.outcome.kind !== 'found') throw new Error('T027-SEARCH-OFFSET-NOT-FOUND');
assert.equal(offsetSearch.value.outcome.match.cursor, 8, 'T027-SEARCH-OFFSET-01 lands on the match end');
const operatorSearch = searchVimOperator(snapshot, view, EMPTY_VIM_SEARCH_STATE, { command: 'search', pattern: 'foo', direction: 'forward', wrapscan: false });
assert.equal(operatorSearch.ok, true, 'T027-SEARCH-OPERATOR-01 resolves a search target for operator composition');
if (!operatorSearch.ok) throw new Error('T027-SEARCH-OPERATOR-01');
assert.equal(operatorSearch.value.range.start, 0);
assert.equal(operatorSearch.value.range.target, 6);
assert.equal(operatorSearch.value.range.end, 7, 'T027-SEARCH-OPERATOR-02 uses an inclusive grapheme endpoint');
const backwardOperatorSearch = searchVimOperator(snapshot, { ...view, cursor: 12 as Utf16Offset }, EMPTY_VIM_SEARCH_STATE, { command: 'search', pattern: 'foo', direction: 'backward', wrapscan: false });
assert.equal(backwardOperatorSearch.ok, true, 'T027-SEARCH-OPERATOR-03 resolves a backward target for operator composition');
if (!backwardOperatorSearch.ok) throw new Error('T027-SEARCH-OPERATOR-03');
assert.equal(backwardOperatorSearch.value.range.target, 6);
assert.equal(backwardOperatorSearch.value.range.start, 6);
assert.equal(backwardOperatorSearch.value.range.end, 13, 'T027-SEARCH-OPERATOR-04 includes the origin when the target is backward');

const parsed = parseVimSubstituteCommand(':s/foo/\\u&/g');
assert.equal(parsed.ok, true, 'T027-SUBSTITUTE-PARSE-01 parses escaped delimiter payloads');
if (!parsed.ok) throw new Error('T027-SUBSTITUTE-PARSE-01');
assert.deepEqual(parsed.value, { pattern: 'foo', replacement: '\\u&', flags: 'g' });
const parsedReuse = parseVimSubstituteCommand(':s//bar/', 'foo');
assert.equal(parsedReuse.ok, true, 'T027-SUBSTITUTE-EMPTY-REUSE-01 reuses the previous pattern');
if (!parsedReuse.ok) throw new Error('T027-SUBSTITUTE-EMPTY-REUSE-01');
assert.equal(parsedReuse.value.pattern, 'foo');
assert.equal(parseVimSubstituteCommand(':s///').ok, false, 'T027-SUBSTITUTE-EMPTY-FAIL-01 rejects empty reuse without a pattern');
assert.equal(parseVimSubstituteCommand(':s/foo/bar/z').ok, false, 'T027-SUBSTITUTE-FLAG-FAIL-01 rejects unknown flags');

const substitutionState: VimSearchState = { ...first.value.state, previousReplacement: null };
const substitute = prepareVimSubstitute(snapshot, substitutionState, {
  pattern: 'foo', replacement: 'bar', flags: 'g', range: { firstLine: 0 as LineIndex, lastLine: 3 as LineIndex },
});
assert.equal(substitute.ok, true, 'T027-SUBSTITUTE-GLOBAL-01 prepares one atomic edit per match');
if (!substitute.ok) throw new Error('T027-SUBSTITUTE-GLOBAL-01');
assert.equal(substitute.value.replacedCount, 4);
assert.equal(applyEdits('foo x foo\nx foo\nfoo\n', substitute.value.edits), 'bar x bar\nx bar\nbar\n');
assert.equal(substitute.value.edits.length, 4);
assert.equal(substitute.value.undoGroup, `vim-substitute-${snapshot.version as number}`);

const firstOnly = prepareVimSubstitute(snapshot, substitutionState, { pattern: 'foo', replacement: 'X' });
assert.equal(firstOnly.ok, true);
if (!firstOnly.ok) throw new Error('T027-SUBSTITUTE-FIRST');
assert.equal(firstOnly.value.replacedCount, 1, 'T027-SUBSTITUTE-FIRST-01 defaults to the current line');
assert.equal(applyEdits('foo x foo\nx foo\nfoo\n', firstOnly.value.edits), 'X x foo\nx foo\nfoo\n');

const captures = prepareVimSubstitute(snapshot, substitutionState, { pattern: '\\(foo\\) x', replacement: '\\1-&' });
assert.equal(captures.ok, true, 'T027-SUBSTITUTE-CAPTURE-01 expands captures and whole-match references');
if (!captures.ok) throw new Error('T027-SUBSTITUTE-CAPTURE-01');
assert.equal(applyEdits('foo x foo\nx foo\nfoo\n', captures.value.edits), 'foo-foo x foo\nx foo\nfoo\n');

const allLines = { firstLine: 0 as LineIndex, lastLine: 3 as LineIndex };
const caseConverted = prepareVimSubstitute(snapshot, substitutionState, { pattern: 'foo', replacement: '\\U&\\E', flags: 'g', range: allLines });
assert.equal(caseConverted.ok, true);
if (!caseConverted.ok) throw new Error('T027-SUBSTITUTE-CASE');
assert.equal(applyEdits('foo x foo\nx foo\nfoo\n', caseConverted.value.edits), 'FOO x FOO\nx FOO\nFOO\n');
const insensitive = prepareVimSubstitute(snapshot, substitutionState, { pattern: 'FOO', replacement: 'z', flags: 'gi', range: allLines });
assert.equal(insensitive.ok, true, 'T027-SUBSTITUTE-CASE-01 i flag enables case-insensitive matching');
if (!insensitive.ok) throw new Error('T027-SUBSTITUTE-CASE-01');
assert.equal(insensitive.value.replacedCount, 4);
const sensitive = prepareVimSubstitute(snapshot, substitutionState, { pattern: 'FOO', replacement: 'z', flags: 'gI', range: allLines });
assert.equal(sensitive.ok, true, 'T027-SUBSTITUTE-CASE-02 I flag forces case-sensitive matching');
if (!sensitive.ok) throw new Error('T027-SUBSTITUTE-CASE-02');
assert.equal(sensitive.value.replacedCount, 0);

const previous = prepareVimSubstitute(snapshot, { ...substitutionState, previousReplacement: 'Q' }, { pattern: 'foo', replacement: '~', flags: 'g', range: allLines });
assert.equal(previous.ok, true);
if (!previous.ok) throw new Error('T027-SUBSTITUTE-PREVIOUS');
assert.equal(applyEdits('foo x foo\nx foo\nfoo\n', previous.value.edits), 'Q x Q\nx Q\nQ\n');

const zero = openTextDocument('t027-zero' as DocumentId, new TextEncoder().encode('a\nb'));
assert.equal(zero.kind, 'editable');
if (zero.kind !== 'editable') throw new Error('T027-ZERO-DOCUMENT');
const zeroSnapshot = zero.document.snapshot();
const zeroResult = prepareVimSubstitute(zeroSnapshot, substitutionState, { pattern: '^', replacement: '>', flags: 'g', range: { firstLine: 0 as LineIndex, lastLine: 1 as LineIndex } });
assert.equal(zeroResult.ok, true, 'T027-SUBSTITUTE-ZERO-01 terminates line-start matches');
if (!zeroResult.ok) throw new Error('T027-SUBSTITUTE-ZERO-01');
assert.equal(zeroResult.value.replacedCount, 2);
assert.equal(applyEdits('a\nb', zeroResult.value.edits), '>a\n>b');
const noWord = searchVimBuffer(snapshot, { ...view, cursor: 3 as Utf16Offset }, EMPTY_VIM_SEARCH_STATE, { command: 'star', wrapscan: false });
assert.equal(noWord.ok, false, 'T027-SEARCH-STAR-FAIL-01 rejects a star search outside a keyword');
if (noWord.ok) throw new Error('T027-SEARCH-STAR-FAIL-01');
assert.equal(noWord.error.kind, 'word-not-found');

const multiline = openTextDocument('t027-multiline' as DocumentId, new TextEncoder().encode('ab\ncd'));
assert.equal(multiline.kind, 'editable');
if (multiline.kind !== 'editable') throw new Error('T027-MULTILINE-DOCUMENT');
const multilineResult = prepareVimSubstitute(multiline.document.snapshot(), substitutionState, { pattern: 'b\\n', replacement: 'X', flags: 'g' });
assert.equal(multilineResult.ok, true, 'T027-SUBSTITUTE-MULTILINE-01 handles a newline-spanning match');
if (!multilineResult.ok) throw new Error('T027-SUBSTITUTE-MULTILINE-01');
assert.equal(applyEdits('ab\ncd', multilineResult.value.edits), 'aXcd');

const countOnly = prepareVimSubstitute(snapshot, substitutionState, { pattern: 'foo', replacement: 'bar', flags: 'gn', range: allLines });
assert.equal(countOnly.ok, true);
if (!countOnly.ok) throw new Error('T027-SUBSTITUTE-COUNT');
assert.equal(countOnly.value.matchedCount, 4, 'T027-SUBSTITUTE-COUNT-01 n flag counts without materializing an edit');
assert.equal(countOnly.value.edits.length, 0, 'T027-SUBSTITUTE-COUNT-02 n flag does not edit the document');

const confirmations: string[] = [];
const confirmed = prepareVimSubstitute(snapshot, substitutionState, {
  pattern: 'foo', replacement: 'C', flags: 'gc', range: allLines,
  confirm: (match) => { confirmations.push(String(match.start)); return confirmations.length === 1 ? 'yes' : 'no'; },
});
assert.equal(confirmed.ok, true);
if (!confirmed.ok) throw new Error('T027-SUBSTITUTE-CONFIRM');
assert.equal(confirmed.value.replacedCount, 1);
assert.equal(confirmed.value.skippedCount, 3);
assert.equal(applyEdits('foo x foo\nx foo\nfoo\n', confirmed.value.edits), 'C x foo\nx foo\nfoo\n');
assert.equal(prepareVimSubstitute(snapshot, substitutionState, { pattern: 'foo', replacement: 'x', flags: 'c', range: allLines }).ok, false, 'T027-SUBSTITUTE-CONFIRM-FAIL requires a confirmation callback');

const oracle = await verifyOracleBundle();
const searchOracleFixture: OracleFixture = {
  id: 'T027-SEARCH-ORACLE',
  title: 'Pinned directional search and repeat state',
  purpose: 'Compare forward/backward search, n/N repeat and committed search-register state with Neovim.',
  modes: ['normal'],
  lines: ['foo x foo', 'x foo', 'foo'],
  cursor: { line: 1, byteColumn0: 0 },
  steps: [
    { label: 'forward', keys: '/foo<CR>' },
    { label: 'next', keys: 'n' },
    { label: 'previous', keys: 'N' },
    { label: 'backward', keys: '?foo<CR>' },
  ],
};
const searchOracle = await runOracleFixture(searchOracleFixture, oracle.binaryPath);
assert.deepEqual(searchOracle.snapshots.map((item) => [item.cursor.line, item.cursor.byteColumn - 1]), [[1, 6], [2, 2], [1, 6], [1, 0]], 'T027-ORACLE-SEARCH-01 directional and repeat cursor state');
assert.deepEqual(searchOracle.snapshots.map((item) => item.search), [
  { pattern: 'foo', forward: 1, highlighting: 1 },
  { pattern: 'foo', forward: 1, highlighting: 1 },
  { pattern: 'foo', forward: 1, highlighting: 1 },
  { pattern: 'foo', forward: 0, highlighting: 1 },
], 'T027-ORACLE-SEARCH-02 committed pattern/direction state');

const substituteOracleFixture: OracleFixture = {
  id: 'T027-SUBSTITUTE-ORACLE',
  title: 'Pinned line substitute state',
  purpose: 'Compare a global substitute result, cursor preservation and search register state with Neovim.',
  modes: ['normal'],
  lines: ['foo x foo', 'x foo', 'foo'],
  cursor: { line: 1, byteColumn0: 0 },
  steps: [{ label: 'substitute', keys: ':s/foo/bar/g<CR>' }],
};
const substituteOracle = await runOracleFixture(substituteOracleFixture, oracle.binaryPath);
const substituteSnapshot = substituteOracle.snapshots[0];
assert(substituteSnapshot !== undefined, 'T027-ORACLE-SUBSTITUTE-01 snapshot exists');
if (substituteSnapshot !== undefined) {
  assert.deepEqual(substituteSnapshot.lines, ['bar x bar', 'x foo', 'foo'], 'T027-ORACLE-SUBSTITUTE-01 current-line global result');
  assert.deepEqual(substituteSnapshot.cursor, { line: 1, byteColumn: 1, coladd: 0, virtualColumn: 1, desiredColumn: 0, screenRow: 1, screenColumn: 1 }, 'T027-ORACLE-SUBSTITUTE-02 cursor remains at the line start');
  assert.deepEqual(substituteSnapshot.search, { pattern: 'foo', forward: 1, highlighting: 1 }, 'T027-ORACLE-SUBSTITUTE-03 search register is committed');
}

console.log('PASS T027 buffer search/substitute: directional preview/commit/cancel, n/N and star/hash variants, no-wrap/stale handling, ranges, flags, captures, case conversion, prior replacement, zero-width/multiline termination and confirmation; pinned search/substitute snapshots passed');
