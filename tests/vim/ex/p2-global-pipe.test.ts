#!/usr/bin/env bun
// Regression test for finding E1-5/task 2: a `:g`/`:v` body may be several
// `|`-chained commands, each run per matched line in order, seeing the
// previous one's result (not the original snapshot). See
// packages/vim/ex/index.ts prepareGlobalChainedBody.
import { strict as assert } from 'node:assert';
import type { DocumentId, LineIndex } from '../../../packages/primitives/src/index';
import { openTextDocument, type DocumentEdit } from '../../../packages/document/src/index';
import { parseVimExCommand, prepareVimEx, type VimExCommand, type VimExPrepareContext } from '../../../packages/vim/ex/index';

function parse(source: string): VimExCommand {
  const result = parseVimExCommand(source);
  assert.equal(result.ok, true, `P2G parse ${source}`);
  if (!result.ok) throw new Error(`P2G parse ${source}`);
  return result.value;
}

function open(id: string, text: string) {
  const result = openTextDocument(id as DocumentId, new TextEncoder().encode(text));
  assert.equal(result.kind, 'editable', `P2G document ${id}`);
  if (result.kind !== 'editable') throw new Error(`P2G document ${id}`);
  return result.document;
}

function context(currentLine: number): VimExPrepareContext {
  return { currentLine: currentLine as LineIndex };
}

function applyEdits(source: string, edits: readonly DocumentEdit[]): string {
  return [...edits].sort((left, right) => (right.start as number) - (left.start as number))
    .reduce((value, edit) => `${value.slice(0, edit.start as number)}${edit.text}${value.slice(edit.end as number)}`, source);
}

// nvim (-c "call setline(1,['aXaYa','bXbYb'])" -c 'g/a/s/X/1/|s/Y/2/'
// -c 'w! ...') -> a1a2a / bXbYb: the second piped `:s` sees the first
// piped `:s`'s result on the same matched line (only line 1 matches /a/).
{
  const pipeCommand = parse(':g/a/s/X/1/|s/Y/2/');
  assert.equal(pipeCommand.arguments.kind, 'global');
  if (pipeCommand.arguments.kind === 'global') assert.equal(pipeCommand.arguments.bodies.length, 2, 'P2G-PARSE-01 collects both piped body commands');
  const document = open('p2g-two', 'aXaYa\nbXbYb');
  const plan = prepareVimEx(document.snapshot(), pipeCommand, context(0));
  assert.equal(plan.ok, true, 'P2G-TWO-01 prepares the chained global');
  if (!plan.ok) throw new Error('P2G-TWO-01');
  assert.equal(applyEdits('aXaYa\nbXbYb', plan.value.edits), 'a1a2a\nbXbYb', 'P2G-TWO-02 both piped substitutes apply in order on the matched line');
}

// nvim (-c "call setline(1,'aXaYaZa')" -c 'g/a/s/X/1/|s/Y/2/|s/Z/3/'
// -c 'w! ...') -> a1a2a3a: three chained bodies compose in order.
{
  const document = open('p2g-three', 'aXaYaZa');
  const plan = prepareVimEx(document.snapshot(), parse(':g/a/s/X/1/|s/Y/2/|s/Z/3/'), context(0));
  assert.equal(plan.ok, true, 'P2G-THREE-01');
  if (!plan.ok) throw new Error('P2G-THREE-01');
  assert.equal(applyEdits('aXaYaZa', plan.value.edits), 'a1a2a3a', 'P2G-THREE-02 three chained bodies apply in order');
}

// A single-body :g keeps its prior (unisolated) fast path and result.
// nvim (-c "call setline(1,['one','two','three','two'])" -c 'g/two/s/two/TWO/g' -c 'w! ...')
{
  const document = open('p2g-single', 'one\ntwo\nthree\ntwo');
  const command = parse(':g/two/s/two/TWO/g');
  assert.equal(command.arguments.kind, 'global');
  if (command.arguments.kind === 'global') assert.equal(command.arguments.bodies.length, 1, 'P2G-SINGLE-01 a plain body has one entry');
  const plan = prepareVimEx(document.snapshot(), command, context(0));
  assert.equal(plan.ok, true, 'P2G-SINGLE-02');
  if (!plan.ok) throw new Error('P2G-SINGLE-02');
  assert.equal(applyEdits('one\ntwo\nthree\ntwo', plan.value.edits), 'one\nTWO\nthree\nTWO', 'P2G-SINGLE-03 single-body :g result is unchanged');
}

console.log('PASS P2G :g pipe-chained bodies run in order per matched line against the previous body\'s result');
