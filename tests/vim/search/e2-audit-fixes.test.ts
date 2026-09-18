#!/usr/bin/env bun
// Regression tests for findings E2-1 (wrapped flag scoped across a {count}n),
// E2-2 (`\?` as a literal `?` search delimiter), E2-5 (search operator motion
// exclusive/inclusive/linewise) and E2-6 (`:s` must not inherit `*`'s fullWord
// flag). Run with `bun run tests/vim/search/e2-audit-fixes.test.ts`.
import { strict as assert } from 'node:assert';
import { openTextDocument } from '../../../packages/document/src/index';
import type { DocumentId, LineIndex, Utf16Offset } from '../../../packages/document/src/index';
import {
  EMPTY_VIM_SEARCH_STATE,
  prepareVimSubstitute,
  searchVimBuffer,
  searchVimOperator,
  type VimSearchState,
  type VimSearchView,
} from '../../../packages/vim/search/index';

function doc(id: string, text: string) {
  const opened = openTextDocument(id as DocumentId, new TextEncoder().encode(text));
  assert.equal(opened.kind, 'editable');
  if (opened.kind !== 'editable') throw new Error('E2-DOCUMENT');
  return opened.document;
}

// --- E2-1: `{count}n` must be able to wrap on every iteration, not just once. ----
// Oracle: printf 'foo\nbar' > t.txt
//   nvim --headless --clean -u NONE -c 'e t.txt' -c 'call feedkeys("/foo\<CR>2n", "tx")'
//     -c 'echo line(".").":".col(".")' -c 'q!'   -> 1:1  (found -- stays on the only match)
//   same with 5n also -> 1:1 (found, not no-match)
{
  const document = doc('e2-1', 'foo\nbar');
  const snapshot = document.snapshot();
  const view: VimSearchView = { cursor: 0 as Utf16Offset, desiredDisplayColumn: 0, scrollTop: 0, scrollLeft: 0 };
  const searched = searchVimBuffer(snapshot, view, EMPTY_VIM_SEARCH_STATE, { command: 'search', pattern: 'foo', direction: 'forward' });
  assert.equal(searched.ok, true);
  if (!searched.ok) throw new Error('E2-1-SEARCH');
  const repeated = searchVimBuffer(snapshot, searched.value.view, searched.value.state, { command: 'next', count: 2 });
  assert.equal(repeated.ok, true);
  if (!repeated.ok) throw new Error('E2-1-NEXT');
  assert.equal(repeated.value.outcome.kind, 'found', 'E2-1: 2n on a single-match file must wrap twice, not fail');
  if (repeated.value.outcome.kind === 'found') assert.equal(repeated.value.outcome.match.cursor, 0);
  const repeatedFive = searchVimBuffer(snapshot, searched.value.view, searched.value.state, { command: 'next', count: 5 });
  assert.equal(repeatedFive.ok, true);
  if (repeatedFive.ok) assert.equal(repeatedFive.value.outcome.kind, 'found', 'E2-1: 5n must also wrap repeatedly');
}

// --- E2-2 (search side): `\?` in a `?` (backward) search is a literal `?`, not the
// "0 or 1" quantifier, matching nvim's delimiter-escape stripping. -----------------
// Oracle: printf 'xb\n' > t.txt
//   nvim --headless --clean -u NONE -c 'e t.txt' -c 'call feedkeys("$?a\\?b\<CR>", "tx")'
//     -c 'q!'  -> E486: Pattern not found: a?b   (quantifier reading would have found "b")
{
  const document = doc('e2-2', 'xb\n');
  const snapshot = document.snapshot();
  const view: VimSearchView = { cursor: (snapshot.lengthUtf16 - 1) as Utf16Offset, desiredDisplayColumn: 0, scrollTop: 0, scrollLeft: 0 };
  const searched = searchVimBuffer(snapshot, view, EMPTY_VIM_SEARCH_STATE, { command: 'search', pattern: 'a\\?b', direction: 'backward', wrapscan: false });
  assert.equal(searched.ok, true);
  if (!searched.ok) throw new Error('E2-2-SEARCH');
  assert.equal(searched.value.outcome.kind, 'no-match', 'E2-2: \\? before a ? delimiter must not act as a quantifier');
}
// A `/` (forward) search keeps `\?` as the real quantifier: `fo\?o` on "fo foo" matches "foo" at
// index 4, not "fo" at index 0 (forward search excludes the cursor's own position 0).
// Oracle: nvim -S <<'call feedkeys("/fo\\?o\<CR>") | echo col(".")'  on "fo foo" -> 4
{
  const document = doc('e2-2b', 'fo foo');
  const snapshot = document.snapshot();
  const view: VimSearchView = { cursor: 0 as Utf16Offset, desiredDisplayColumn: 0, scrollTop: 0, scrollLeft: 0 };
  const searched = searchVimBuffer(snapshot, view, EMPTY_VIM_SEARCH_STATE, { command: 'search', pattern: 'fo\\?o', direction: 'forward', wrapscan: false });
  assert.equal(searched.ok, true);
  if (!searched.ok) throw new Error('E2-2B-SEARCH');
  assert.equal(searched.value.outcome.kind, 'found');
  if (searched.value.outcome.kind === 'found') assert.equal(searched.value.outcome.match.cursor, 3, 'E2-2: \\? stays a quantifier for a / search');
}

// --- E2-5: `/`/`?` as an operator-pending motion is exclusive by default, inclusive
// only with an `/e` offset, and linewise with a numeric line offset. --------------
// Oracle: printf 'abc def\n' > t.txt
//   nvim ... 'd/def\<CR>'    -> "def"   (exclusive: only "abc " deleted)
//   nvim ... 'd/def/e\<CR>'  -> ""      (inclusive: whole line deleted)
//   printf 'one\ntwo\nthree\n'; nvim ... 'd/two/+1\<CR>' -> empty file (linewise, all 3 lines)
{
  const document = doc('e2-5a', 'abc def');
  const snapshot = document.snapshot();
  const view: VimSearchView = { cursor: 0 as Utf16Offset, desiredDisplayColumn: 0, scrollTop: 0, scrollLeft: 0 };
  const operator = searchVimOperator(snapshot, view, EMPTY_VIM_SEARCH_STATE, { command: 'search', pattern: 'def', direction: 'forward' });
  assert.equal(operator.ok, true);
  if (!operator.ok) throw new Error('E2-5A');
  assert.equal(operator.value.range.inclusive, false, 'E2-5: plain / is exclusive');
  assert.equal(operator.value.range.linewise, false);
  assert.equal(operator.value.range.start, 0);
  assert.equal(operator.value.range.end, 4, 'E2-5: exclusive end stops right before the match ("abc " only)');
}
{
  const document = doc('e2-5b', 'abc def');
  const snapshot = document.snapshot();
  const view: VimSearchView = { cursor: 0 as Utf16Offset, desiredDisplayColumn: 0, scrollTop: 0, scrollLeft: 0 };
  const operator = searchVimOperator(snapshot, view, EMPTY_VIM_SEARCH_STATE, {
    command: 'search', pattern: 'def', direction: 'forward', offset: { kind: 'end', amount: 0 },
  });
  assert.equal(operator.ok, true);
  if (!operator.ok) throw new Error('E2-5B');
  assert.equal(operator.value.range.inclusive, true, 'E2-5: an /e offset is inclusive');
  assert.equal(operator.value.range.end, 7, 'E2-5: inclusive end covers the whole match ("abc def")');
}
{
  const document = doc('e2-5c', 'one\ntwo\nthree\n');
  const snapshot = document.snapshot();
  const view: VimSearchView = { cursor: 0 as Utf16Offset, desiredDisplayColumn: 0, scrollTop: 0, scrollLeft: 0 };
  const operator = searchVimOperator(snapshot, view, EMPTY_VIM_SEARCH_STATE, {
    command: 'search', pattern: 'two', direction: 'forward', offset: { kind: 'line', amount: 1 },
  });
  assert.equal(operator.ok, true);
  if (!operator.ok) throw new Error('E2-5C');
  assert.equal(operator.value.range.linewise, true, 'E2-5: a numeric line offset is linewise');
}

// --- E2-6: `:s` must never inherit `*`'s whole-word constraint for a later `n`. --
{
  const document = doc('e2-6', 'cat scatter cat');
  const snapshot = document.snapshot();
  const view: VimSearchView = { cursor: 0 as Utf16Offset, desiredDisplayColumn: 0, scrollTop: 0, scrollLeft: 0 };
  const star = searchVimBuffer(snapshot, view, EMPTY_VIM_SEARCH_STATE, { command: 'star' });
  assert.equal(star.ok, true);
  if (!star.ok) throw new Error('E2-6-STAR');
  assert.equal(star.value.state.fullWord, true, 'sanity: * does set fullWord');
  const substituted = prepareVimSubstitute(snapshot, star.value.state, {
    pattern: 'cat', replacement: 'dog', range: { firstLine: 0 as LineIndex, lastLine: 0 as LineIndex },
  });
  assert.equal(substituted.ok, true);
  if (!substituted.ok) throw new Error('E2-6-SUBSTITUTE');
  assert.equal(substituted.value.state.fullWord, false, 'E2-6: :s must not carry over the * fullWord flag');
}

console.log('tests/vim/search/e2-audit-fixes.test.ts OK');
