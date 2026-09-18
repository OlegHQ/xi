#!/usr/bin/env bun
// Regression tests for `:s` flags `&`/`r` and the trailing `[count]`
// (findings E1-6/E2-6). These are ex-command-layer features (parseOne's
// substitute branch + prepareSubstitute in packages/vim/ex/index.ts), so
// they are exercised through prepareVimEx rather than prepareVimSubstitute
// directly; packages/vim/search/index.ts only accepts the flag letters and
// defers their semantics to the ex layer (see its updated comment).
import { strict as assert } from 'node:assert';
import type { DocumentId, LineIndex } from '../../../packages/primitives/src/index';
import { openTextDocument, type DocumentEdit } from '../../../packages/document/src/index';
import {
  parseVimExCommand,
  prepareVimEx,
  type VimExCommand,
  type VimExPrepareContext,
} from '../../../packages/vim/ex/index';

function parse(source: string): VimExCommand {
  const result = parseVimExCommand(source);
  assert.equal(result.ok, true, `P2 parse ${source}`);
  if (!result.ok) throw new Error(`P2 parse ${source}`);
  return result.value;
}

function open(id: string, text: string) {
  const result = openTextDocument(id as DocumentId, new TextEncoder().encode(text));
  assert.equal(result.kind, 'editable', `P2 document ${id}`);
  if (result.kind !== 'editable') throw new Error(`P2 document ${id}`);
  return result.document;
}

function context(currentLine: number, extra: Partial<VimExPrepareContext> = {}): VimExPrepareContext {
  return { currentLine: currentLine as LineIndex, ...extra };
}

function applyEdits(source: string, edits: readonly DocumentEdit[]): string {
  return [...edits].sort((left, right) => (right.start as number) - (left.start as number))
    .reduce((value, edit) => `${value.slice(0, edit.start as number)}${edit.text}${value.slice(edit.end as number)}`, source);
}

// --- trailing [count]: nvim (-c "call setline(1,['a','a','a','a','a'])" -c 2
// -c 's/a/b/g 3' -c 'w! ...') -> a/b/b/b/a: a count acts on `count` lines
// starting at the range's last line (here, the cursor line, line 2 = index 1).
{
  const document = open('p2-count', 'a\na\na\na\na');
  const command = parse(':s/a/b/g 3');
  assert.equal(command.arguments.kind, 'substitute');
  if (command.arguments.kind === 'substitute') assert.equal(command.arguments.count, 3, 'P2-COUNT-01 parses the trailing count');
  const plan = prepareVimEx(document.snapshot(), command, context(1));
  assert.equal(plan.ok, true, 'P2-COUNT-02 prepares the counted substitute');
  if (!plan.ok) throw new Error('P2-COUNT-02');
  assert.equal(applyEdits('a\na\na\na\na', plan.value.edits), 'a\nb\nb\nb\na', 'P2-COUNT-03 matches pinned Neovim: 3 lines from the cursor line');
}

// nvim (-c "call setline(1,['a','a','a','a','a'])" -c '1,2' -c 's/a/b/ 3'
// -c 'w! ...') -> a/b/b/b/a: the count also overrides an explicit range,
// starting at the range's *last* line (line 2 = index 1), same as `:2s.../3`.
{
  const document = open('p2-count-range', 'a\na\na\na\na');
  const command = parse(':1,2s/a/b/ 3');
  const plan = prepareVimEx(document.snapshot(), command, context(0));
  assert.equal(plan.ok, true, 'P2-COUNT-RANGE-01');
  if (!plan.ok) throw new Error('P2-COUNT-RANGE-01');
  assert.equal(applyEdits('a\na\na\na\na', plan.value.edits), 'a\nb\nb\nb\na', 'P2-COUNT-RANGE-02 count overrides the range, anchored at its last line');
}

// --- `&` flag: nvim (-c "call setline(1,'aXaxa')" -c 's/a/a/i' -c 's/X/Z/&g'
// -c 'w! ...') -> aZaZa: `&` (must be first) unions this invocation's flags
// onto the *previous substitute's* flags (kept `i`, added `g`), not just the
// new flags alone.
{
  const document = open('p2-amp-plain', 'aXaxa');
  const command = parse(':s/X/Z/&g');
  const plan = prepareVimEx(document.snapshot(), command, context(0, { lastSubstitute: { pattern: 'a', replacement: 'a', flags: 'i' } }));
  assert.equal(plan.ok, true, 'P2-AMP-PLAIN-01');
  if (!plan.ok) throw new Error('P2-AMP-PLAIN-01');
  assert.equal(applyEdits('aXaxa', plan.value.edits), 'aZaZa', 'P2-AMP-PLAIN-02 & merges previous+new flags on a plain :s, not just the new ones');
}

// nvim (-c "call setline(1,'FOO')" -c "call setline(2,'FOO')" -c '1' -c
// 's/foo/X/i' -c '2' -c '&&g' -c 'w! ...') -> X / X: `:&&` with an extra
// flag also merges (kept `i`, added `g`), it does not replace the previous
// flags outright.
{
  const document = open('p2-ampamp-merge', 'FOO');
  const command = parse(':&&g');
  const plan = prepareVimEx(document.snapshot(), command, context(0, { lastSubstitute: { pattern: 'foo', replacement: 'X', flags: 'i' } }));
  assert.equal(plan.ok, true, 'P2-AMPAMP-MERGE-01');
  if (!plan.ok) throw new Error('P2-AMPAMP-MERGE-01');
  assert.equal(applyEdits('FOO', plan.value.edits), 'X', 'P2-AMPAMP-MERGE-02 :&&g keeps i (case-insensitive) while adding g');
}

// --- `r` flag / `:~`: nvim (-c "call setline(1,'blue sky')" -c "call
// setline(2,'green grass')" -c "call setline(3,'blue ocean')" -c "call
// setline(4,'green field')" -c '1' -c 's/blue/red/' -c '/green' -c '3' -c '&'
// -c '4' -c '~' -c 'w! ...') -> red sky / green grass / red ocean / red
// field: bare `:&` (no r) keeps reusing the last *substitute* pattern
// ("blue") even after an intervening search; `:~` (== `:&r`) reuses the
// last *search* pattern ("green") instead.
const TILDE_TEXT = 'blue sky\ngreen grass\nblue ocean\ngreen field';
{
  const document = open('p2-tilde', TILDE_TEXT);
  const ctx = context(2, { lastSubstitute: { pattern: 'blue', replacement: 'red', flags: '' }, searchState: { pattern: 'green', direction: 'forward', lastMatch: null, fullWord: false, previousReplacement: null } });
  const ampPlan = prepareVimEx(document.snapshot(), parse(':&'), ctx);
  assert.equal(ampPlan.ok, true, 'P2-TILDE-AMP-01');
  if (!ampPlan.ok) throw new Error('P2-TILDE-AMP-01');
  assert.equal(applyEdits(TILDE_TEXT, ampPlan.value.edits), 'blue sky\ngreen grass\nred ocean\ngreen field', 'P2-TILDE-AMP-02 bare :& ignores the intervening search, reuses "blue"');
  const tildeCtx: VimExPrepareContext = { ...ctx, currentLine: 3 as LineIndex };
  const tildePlan = prepareVimEx(document.snapshot(), parse(':~'), tildeCtx);
  assert.equal(tildePlan.ok, true, 'P2-TILDE-03');
  if (!tildePlan.ok) throw new Error('P2-TILDE-03');
  assert.equal(applyEdits(TILDE_TEXT, tildePlan.value.edits), 'blue sky\ngreen grass\nblue ocean\nred field', 'P2-TILDE-04 :~ reuses the last search pattern "green" instead');
}

// `&r` flag combination on a plain :& reproduces :~'s behavior directly.
{
  const document = open('p2-amp-r', TILDE_TEXT);
  const ctx = context(3, { lastSubstitute: { pattern: 'blue', replacement: 'red', flags: '' }, searchState: { pattern: 'green', direction: 'forward', lastMatch: null, fullWord: false, previousReplacement: null } });
  const plan = prepareVimEx(document.snapshot(), parse(':&r'), ctx);
  assert.equal(plan.ok, true, 'P2-AMP-R-01');
  if (!plan.ok) throw new Error('P2-AMP-R-01');
  assert.equal(applyEdits(TILDE_TEXT, plan.value.edits), 'blue sky\ngreen grass\nblue ocean\nred field', 'P2-AMP-R-02 :&r behaves like :~');
}

console.log('PASS P2 substitute flags/count: & flag merges previous+new flags, ~/r reuse the last search pattern instead of the last substitute pattern, and a trailing [count] applies to that many lines from the range end');
