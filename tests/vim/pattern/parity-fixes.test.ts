#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { openTextDocument } from '../../../packages/document/src/index';
import type { DocumentId, Utf16Offset } from '../../../packages/document/src/index';
import type { DocumentVersion } from '../../../packages/primitives/src/index';
import {
  compilePattern,
  createPatternTextSnapshot,
  findAllMatches,
  substituteAll,
} from '../../../packages/vim/pattern/index';
import {
  EMPTY_VIM_SEARCH_STATE,
  searchVimBuffer,
  type VimSearchState,
  type VimSearchView,
} from '../../../packages/vim/src/index';

const version = 1 as DocumentVersion;
function snap(text: string) { return createPatternTextSnapshot(version, text); }

/**
 * Every expectation below was checked against pinned Neovim 0.12.4
 * (`nvim --headless --clean`); the exact command is noted per case.
 */
function main(): void {
  // 1. Bracket classes never case-folded. Verified:
  // `nvim --headless --clean -c 'call setline(1,["xABC"])' -c 's/\c[abc]/Y/g' -c 'echo getline(1)'` -> xYYY
  // `nvim --headless --clean -u NONE -c 'set ignorecase' -c 'call setline(1,["ABC"])' -c 's/[a-z]/Y/g' -c 'echo getline(1)'` -> YYY
  {
    const withDirective = findAllMatches(compilePattern(String.raw`\c[abc]`), snap('xABC')).matches;
    assert.deepEqual(withDirective.map((m) => m.start as number), [1, 2, 3], 'ITEM-1: \\c[abc] folds case in the bracket class');
    const withIgnoreCase = findAllMatches(compilePattern('[a-z]', { ignoreCase: true }), snap('ABC')).matches;
    assert.deepEqual(withIgnoreCase.map((m) => m.start as number), [0, 1, 2], 'ITEM-1: ignorecase folds case in a bracket range');
  }

  // 2. Negated classes and \S/\D/\W etc. don't match \n unless the class is
  // extended with \_. Verified:
  // `nvim --headless --clean -c 'call setline(1,["b","c"])' -c '%s/[^a]\+/X/g' -c 'echo join(getline(1,"$"),"|")'` -> X|X
  // `nvim --headless --clean -c 'call setline(1,["b","c"])' -c '%s/\_[^a]\+/X/g' -c 'echo join(getline(1,"$"),"|")'` -> X (spans the line break)
  {
    const negated = findAllMatches(compilePattern(String.raw`[^a]\+`), snap('b\nc')).matches;
    assert.deepEqual(negated.map((m) => [m.start as number, m.end as number]), [[0, 1], [2, 3]], 'ITEM-2: [^a]+ does not cross the line break');
    const notSpace = findAllMatches(compilePattern(String.raw`\S\+`), snap('b\nc')).matches;
    assert.deepEqual(notSpace.map((m) => [m.start as number, m.end as number]), [[0, 1], [2, 3]], 'ITEM-2: \\S+ does not cross the line break');
    const extended = findAllMatches(compilePattern(String.raw`\_[^a]\+`), snap('b\nc')).matches;
    assert.deepEqual(extended.map((m) => [m.start as number, m.end as number]), [[0, 3]], 'ITEM-2: \\_[^a]+ does cross the line break');
  }

  // 3. \v (very magic) was missing <, >, =, %(, and ^/$ as anchors anywhere.
  // Verified: `matchstr("foo bar", '\v<bar>')` -> bar
  //           `matchstr("foobar", '\v%(foo)(bar)')` submatch(1) -> bar
  //           `matchstr("color colour", '\vcolou=r')` (both occurrences replace)
  //           `s/\va^b/X/` on "a^b" -> E486 (^ is an anchor, not literal, mid-pattern)
  {
    const wordBoundary = findAllMatches(compilePattern(String.raw`\v<bar>`), snap('foo bar')).matches[0];
    assert(wordBoundary !== undefined && wordBoundary.start === 4 && wordBoundary.end === 7, 'ITEM-3: \\v<bar> matches the word "bar" via bare < >');
    const nonCapturing = findAllMatches(compilePattern(String.raw`\v%(foo)(bar)`), snap('foobar')).matches[0];
    assert(nonCapturing !== undefined, 'ITEM-3: \\v%(foo)(bar) matches');
    assert.equal(snap('foobar').text.slice(nonCapturing.captures.get(1)?.start, nonCapturing.captures.get(1)?.end), 'bar', 'ITEM-3: %( ) is non-capturing, group 1 is "bar"');
    const bareEquals = findAllMatches(compilePattern(String.raw`\vcolou=r`), snap('color colour')).matches;
    assert.equal(bareEquals.length, 2, 'ITEM-3: bare = is a 0-or-1 quantifier in \\v');
    const anchorMidPattern = findAllMatches(compilePattern(String.raw`\va^b`), snap('a^b')).matches;
    assert.equal(anchorMidPattern.length, 0, 'ITEM-3: ^ is an anchor anywhere in \\v, not just at branch start');
  }

  // 4. \c / \C apply to the whole pattern regardless of position.
  // Verified: `matchstr("foo", 'Foo\c')` -> foo
  {
    const trailingDirective = findAllMatches(compilePattern(String.raw`Foo\c`), snap('foo')).matches;
    assert.equal(trailingDirective.length, 1, 'ITEM-4: a trailing \\c still makes the whole pattern case-insensitive');
  }

  // 5. The default step budget must scale with input length; a fixed
  // 250_000-step budget failed `/foo` on a long single line.
  {
    const filler = 'x'.repeat(200_000);
    const text = `${filler}foo`;
    const opened = openTextDocument('parity-fixes-budget' as DocumentId, new TextEncoder().encode(text));
    assert.equal(opened.kind, 'editable');
    if (opened.kind !== 'editable') throw new Error('ITEM-5-DOCUMENT');
    const snapshot = opened.document.snapshot();
    const view: VimSearchView = { cursor: 0 as Utf16Offset, desiredDisplayColumn: 0, scrollTop: 0, scrollLeft: 0 };
    const result = searchVimBuffer(snapshot, view, EMPTY_VIM_SEARCH_STATE, { command: 'search', pattern: 'foo', wrapscan: false });
    assert.equal(result.ok, true, 'ITEM-5: /foo on a 200KB line does not fail to compile/evaluate');
    if (!result.ok) throw new Error('ITEM-5-NOT-OK');
    assert.equal(result.value.outcome.kind, 'found', 'ITEM-5: /foo on a 200KB line finds the match within the scaled step budget');
  }

  // 6a. A global scan must resume from the *reported* (\ze) end, not the
  // fully consumed end.
  // Verified: `nvim --headless --clean -c 'call setline(1,["aaaa"])' -c 's/a\ze./X/g' -c 'echo getline(1)'` -> XXXa (3 matches)
  {
    const result = substituteAll(compilePattern(String.raw`a\ze.`), snap('aaaa'), 'X');
    assert.equal(result.matches.length, 3, 'ITEM-6A: global scan resumes from \\ze, finding 3 overlapping-consumption matches');
  }

  // 6b. An unset backreference (group never participated) matches empty,
  // not a failure.
  // Verified: `matchstr("y", '\(x\)\=\1y')` -> y
  {
    const result = findAllMatches(compilePattern(String.raw`\(x\)\=\1y`), snap('y')).matches;
    assert.equal(result.length, 1, 'ITEM-6B: an unset backreference matches empty');
  }

  // 6c. `/e` offsets count Unicode characters (code points), not UTF-16
  // code units, so stepping never splits a surrogate pair.
  {
    const text = 'x\u{1F600}Y'; // 'x', astral emoji (2 UTF-16 units), 'Y'
    const opened = openTextDocument('parity-fixes-offset' as DocumentId, new TextEncoder().encode(text));
    assert.equal(opened.kind, 'editable');
    if (opened.kind !== 'editable') throw new Error('ITEM-6C-DOCUMENT');
    const snapshot = opened.document.snapshot();
    const view: VimSearchView = { cursor: 0 as Utf16Offset, desiredDisplayColumn: 0, scrollTop: 0, scrollLeft: 0 };
    const result = searchVimBuffer(snapshot, view, EMPTY_VIM_SEARCH_STATE, {
      command: 'search',
      pattern: text,
      offset: { kind: 'end', amount: -1 },
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('ITEM-6C-NOT-OK');
    assert.equal(result.value.outcome.kind, 'found');
    if (result.value.outcome.kind !== 'found') throw new Error('ITEM-6C-NOT-FOUND');
    // One character back from 'Y' is the astral emoji, which starts at
    // UTF-16 offset 1. A UTF-16-unit-based offset would land on 2, splitting
    // the emoji's surrogate pair.
    assert.equal(result.value.outcome.match.cursor, 1, 'ITEM-6C: /e-1 steps back one whole character, not one UTF-16 unit');
  }

  // 6d. A backward search candidate needs its match START before the
  // cursor, not its match END at-or-before the cursor.
  // Verified: `call cursor(1,4) | call search('ooba','b')` on "fooobar" -> lands on column 3
  // (the match "ooba" spans columns 3-6, i.e. it straddles the cursor).
  {
    const opened = openTextDocument('parity-fixes-backward' as DocumentId, new TextEncoder().encode('fooobar'));
    assert.equal(opened.kind, 'editable');
    if (opened.kind !== 'editable') throw new Error('ITEM-6D-DOCUMENT');
    const snapshot = opened.document.snapshot();
    const view: VimSearchView = { cursor: 3 as Utf16Offset, desiredDisplayColumn: 0, scrollTop: 0, scrollLeft: 0 };
    const result = searchVimBuffer(snapshot, view, EMPTY_VIM_SEARCH_STATE, {
      command: 'search',
      pattern: 'ooba',
      direction: 'backward',
      wrapscan: false,
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('ITEM-6D-NOT-OK');
    assert.equal(result.value.outcome.kind, 'found');
    if (result.value.outcome.kind !== 'found') throw new Error('ITEM-6D-NOT-FOUND');
    assert.equal(result.value.outcome.match.cursor, 2, 'ITEM-6D: backward search finds a match whose start (2) precedes the cursor (3), even though its end (6) does not');
  }

  // 7a. `\{n\}` (closing brace also escaped) is valid, like `\{n}`.
  // Verified: `matchstr("aaa", 'a\{2\}')` -> aa
  {
    const result = findAllMatches(compilePattern(String.raw`a\{2\}`), snap('aaa')).matches[0];
    assert(result !== undefined && result.start === 0 && result.end === 2, 'ITEM-7A: \\{n\\} (escaped close) is accepted');
  }

  // 7b. An unclosed `[` is a literal `[`, not a parse error.
  // Verified: `matchstr("a[b", "a[b")` -> a[b
  {
    const result = findAllMatches(compilePattern('a[b'), snap('a[b')).matches[0];
    assert(result !== undefined && result.start === 0 && result.end === 3, 'ITEM-7B: an unclosed [ is a literal [');
  }

  // 7c. `^*` : a `*` right after the `^` anchor is a literal `*`, not a
  // quantifier of the anchor. Verified: `matchstr("*abc", "^*abc")` -> *abc;
  // `matchstr("abc", "^*abc")` -> "" (no match)
  {
    const matched = findAllMatches(compilePattern('^*abc'), snap('*abc')).matches;
    assert.equal(matched.length, 1, 'ITEM-7C: ^*abc matches the literal "*abc"');
    const notMatched = findAllMatches(compilePattern('^*abc'), snap('abc')).matches;
    assert.equal(notMatched.length, 0, 'ITEM-7C: ^*abc must not match "abc" (the * is not a quantifier here)');
  }

  // 7d. A stray `}` or `]` (no matching opener) is literal in \v, not an
  // error. Verified: `matchstr("a}b", '\va}b')` -> a}b ; `matchstr("a]b", '\va]b')` -> a]b
  {
    const brace = findAllMatches(compilePattern(String.raw`\va}b`), snap('a}b')).matches;
    assert.equal(brace.length, 1, 'ITEM-7D: a stray } is literal in \\v');
    const bracket = findAllMatches(compilePattern(String.raw`\va]b`), snap('a]b')).matches;
    assert.equal(bracket.length, 1, 'ITEM-7D: a stray ] is literal in \\v');
  }

  // 7e. Named class escapes (\d, \s, ...) lose their special meaning inside
  // `[...]`; `[\d]` matches the letter "d", not a digit.
  // Verified: `matchstr("5", '[\d]')` -> "" ; `matchstr("d", '[\d]')` -> d
  {
    const digit = findAllMatches(compilePattern(String.raw`[\d]`), snap('5')).matches;
    assert.equal(digit.length, 0, 'ITEM-7E: [\\d] does not match a digit');
    const letter = findAllMatches(compilePattern(String.raw`[\d]`), snap('d')).matches;
    assert.equal(letter.length, 1, 'ITEM-7E: [\\d] matches the literal letter "d"');
  }

  // 7f. `\^` is an anchor in \V (very nomagic), not a literal caret.
  // Verified: `matchstr("abc", '\V\^abc')` -> abc ; `matchstr("xabc", '\V\^abc')` -> "" (no match)
  {
    const anchored = findAllMatches(compilePattern(String.raw`\V\^abc`), snap('abc')).matches;
    assert.equal(anchored.length, 1, 'ITEM-7F: \\V\\^abc matches at true start of pattern text');
    const notAnchored = findAllMatches(compilePattern(String.raw`\V\^abc`), snap('xabc')).matches;
    assert.equal(notAnchored.length, 0, 'ITEM-7F: \\V\\^ does not match once something precedes it');
  }

  // 7g. `~` matches the last `:substitute` replacement text literally.
  // Verified: after `s/foo/xyz/`, `matchstr("xyz bar", '~')` -> xyz
  {
    const result = findAllMatches(compilePattern('~', { previousSubstituteText: 'xyz' }), snap('xyz bar')).matches[0];
    assert(result !== undefined && result.start === 0 && result.end === 3, 'ITEM-7G: ~ matches the previous substitute text literally');
  }

  // 8a. smartcase treats an uppercase bound inside a bracket range (e.g.
  // [A-Z]) as "the pattern has uppercase", forcing case-sensitive matching.
  // Verified: `set ignorecase smartcase` then `matchstr("abc", '[A-Z]')` -> "" (no match)
  {
    const result = findAllMatches(compilePattern('[A-Z]', { ignoreCase: true, smartCase: true }), snap('abc')).matches;
    assert.equal(result.length, 0, 'ITEM-8A: smartcase treats [A-Z] as containing uppercase, so it stays case-sensitive');
  }

  // 8b. `$` immediately before `\&` (intersection) is an anchor.
  // Verified: `matchstr("foo", 'foo$\&foo')` -> foo
  {
    const result = findAllMatches(compilePattern(String.raw`foo$\&foo`), snap('foo')).matches;
    assert.equal(result.length, 1, 'ITEM-8B: $ before \\& is an anchor, and the intersection matches "foo"');
  }

  console.log('T-PARITY-FIXES-01 passed: all 15 verified parity fixes hold.');
}

main();
