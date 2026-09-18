#!/usr/bin/env bun
// Oracle-verified parity fixes (nvim --headless --clean 0.12.4):
//   1. visual-mode d/c/y/</>/= must not become a pending operator-motion.
//   2. text-object keys `b`/`>` must reach the operator-pending text-object branch.
//   3. VimCount exposes `explicit` so bare G differs from 1G.
import { strict as assert } from 'node:assert';
import type { CanonicalInputEvent } from '../../packages/contracts/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type SelectionId } from '../../packages/primitives/src/index';
import { openTextDocument, type TextFileDocument } from '../../packages/document/src/index';
import { createSelectionSet, type EndpointInput, type SelectionMemberInput, type SelectionSetSnapshot } from '../../packages/selections/src/index';
import {
  createVimParserState,
  normalizeVimInput,
  parseVimInput,
} from '../../packages/vim/src/index';
import type { VimMode, VimParserState } from '../../packages/vim/src/index';

const inputClock = { now: 0, monotonicMilliseconds() { this.now += 1; return this.now; } };

function openEditable(label: string, text: string): TextFileDocument {
  const documentId = asIdentifier<DocumentId>(`parser-visual-${label}`, 'documentId');
  if (!documentId.ok) throw new Error(documentId.error.message);
  const opened = openTextDocument(documentId.value, new TextEncoder().encode(text));
  if (opened.kind !== 'editable') throw new Error(`expected-editable:${label}`);
  return opened.document;
}

function id(value: string): SelectionId {
  const result = asIdentifier<SelectionId>(value, 'selectionId');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function selectionSet(document: TextFileDocument, mode: VimMode): SelectionSetSnapshot {
  const selectionId = id(`parser-visual-selection-${mode}-${document.id}`);
  const start = asUtf16Offset(0);
  const after = asUtf16Offset(1);
  if (!start.ok || !after.ok) throw new Error('invalid fixture offsets');
  const endpoint: EndpointInput = { kind: 'character', offset: start.value, after: after.value };
  const kind = mode === 'normal' ? 'normal-cursor' : mode === 'visual-character' ? 'visual-character' : 'normal-cursor';
  const member: SelectionMemberInput = kind === 'visual-character'
    ? { id: selectionId, kind, direction: 'forward', anchor: endpoint, head: endpoint, inclusive: true }
    : { id: selectionId, kind: 'normal-cursor', direction: 'forward', anchor: endpoint, head: endpoint };
  const result = createSelectionSet(document.snapshot(), { primaryId: selectionId, selectionGeneration: 0, members: [member] });
  if (!result.ok) throw new Error(`invalid-selection:${result.error.kind}`);
  return result.value.selectionSet;
}

function parserState(mode: VimMode, selections: SelectionSetSnapshot): VimParserState {
  const result = createVimParserState(mode, selections);
  if (!result.ok) throw new Error(`test-state:${mode}:${result.error.kind}`);
  return result.value;
}

function feed(state: VimParserState, key: string) {
  const event: CanonicalInputEvent = {
    kind: 'key', key, phase: 'press',
    modifiers: { shift: false, alt: false, ctrl: false, meta: false },
    rawBytes: new TextEncoder().encode(key),
  };
  const normalized = normalizeVimInput(event, inputClock);
  if (!normalized.ok) throw new Error(`test-input:${normalized.error.kind}`);
  return parseVimInput(state, normalized.value);
}

// --- 1: visual-mode d/c/y/</>/= are immediate single-key commands ---
{
  const document = openEditable('vld', 'abc');
  const state = parserState('visual-character', selectionSet(document, 'visual-character'));
  const outcome = feed(state, 'd');
  assert.equal(outcome.kind, 'command', 'PARSER-VISUAL-01 visual d is an immediate command, not pending');
  if (outcome.kind === 'command') assert.equal(outcome.command.kind, 'single-key', 'PARSER-VISUAL-01 visual d dispatches as single-key');
}
for (const key of ['c', 'y', '<', '>', '='] as const) {
  const document = openEditable(`vis-${key}`, 'abc');
  const state = parserState('visual-character', selectionSet(document, 'visual-character'));
  const outcome = feed(state, key);
  assert.equal(outcome.kind, 'command', `PARSER-VISUAL-02 visual ${key} is immediate`);
}
// Normal mode is unaffected: d still opens an operator-pending motion.
{
  const document = openEditable('normal-d', 'abc');
  const state = parserState('normal', selectionSet(document, 'normal'));
  const outcome = feed(state, 'd');
  assert.equal(outcome.kind, 'pending', 'PARSER-VISUAL-03 normal-mode d still awaits a motion');
}

// --- 2: text-object keys b/> reach the text-object branch under an operator ---
{
  const document = openEditable('textobj-b', '(ab)');
  const state = parserState('normal', selectionSet(document, 'normal'));
  const afterD = feed(state, 'd');
  assert.equal(afterD.kind, 'pending', 'PARSER-TEXTOBJ-01 d is pending');
  if (afterD.kind !== 'pending') throw new Error('unreachable');
  const afterI = feed(afterD.state, 'i');
  assert.equal(afterI.kind, 'pending', 'PARSER-TEXTOBJ-01 di is pending');
  if (afterI.kind !== 'pending') throw new Error('unreachable');
  const afterB = feed(afterI.state, 'b');
  assert.equal(afterB.kind, 'command', 'PARSER-TEXTOBJ-01 dib resolves as a text-object command');
}

// --- 3: VimCount.explicit distinguishes bare G from 1G ---
{
  const document = openEditable('count-g', 'a\nb\nc\n');
  const state = parserState('normal', selectionSet(document, 'normal'));
  const bare = feed(state, 'G');
  assert.equal(bare.kind, 'command', 'PARSER-COUNT-01 bare G is a command');
  if (bare.kind === 'command' && bare.command.kind === 'mode-transition') {
    assert.equal(bare.command.count.explicit, false, 'PARSER-COUNT-01 bare G has no explicit count');
  } else if (bare.kind === 'command' && 'count' in bare.command) {
    assert.equal((bare.command as { count: { explicit: boolean } }).count.explicit, false, 'PARSER-COUNT-01 bare G has no explicit count');
  }
  const afterOne = feed(state, '1');
  assert.equal(afterOne.kind, 'pending', 'PARSER-COUNT-02 1 is a pending count');
  if (afterOne.kind !== 'pending') throw new Error('unreachable');
  const explicit = feed(afterOne.state, 'G');
  assert.equal(explicit.kind, 'command', 'PARSER-COUNT-02 1G is a command');
  if (explicit.kind === 'command' && 'count' in explicit.command) {
    assert.equal((explicit.command as { count: { explicit: boolean; value: number } }).count.explicit, true, 'PARSER-COUNT-02 1G has an explicit count');
    assert.equal((explicit.command as { count: { explicit: boolean; value: number } }).count.value, 1, 'PARSER-COUNT-02 1G count value is 1');
  }
}

console.log('PASS parser-visual-operator: visual single-key ordering, text-object keys, explicit count');
