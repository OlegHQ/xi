import { strict as assert } from 'node:assert';
import type { CanonicalInputEvent } from '../../packages/contracts/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type SelectionId } from '../../packages/primitives/src/index';
import { openTextDocument, type TextFileDocument } from '../../packages/document/src/index';
import { createSelectionSet, type EndpointInput, type SelectionMemberInput, type SelectionSetSnapshot } from '../../packages/selections/src/index';
import {
  createVimParserState,
  normalizeVimInput,
  parseVimInput,
  updateVimParserSession,
} from '../../packages/vim/src/index';
import type {
  VimMode,
  VimParseOutcome,
  VimParserState,
} from '../../packages/vim/src/index';
import { runOracleFixture, verifyOracleBundle } from '../oracle/oracle-runner';
import type { OracleFixture } from '../oracle/types';

const inputClock = { now: 0, monotonicMilliseconds() { this.now += 1; return this.now; } };
const allChecks: string[] = [];

function checkNormalizationAndOpaquePaste(): void {
  const rawBytes = new Uint8Array([0x1b, 0x5b, 0x41]);
  const canonicalKey: CanonicalInputEvent = {
    kind: 'key', key: 'd', phase: 'press', modifiers: noModifiers(), rawBytes,
  };
  const normalized = normalizeVimInput(canonicalKey, inputClock);
  assert.equal(normalized.ok, true, 'T013-INPUT-KEY-01 canonical event normalizes');
  if (!normalized.ok || normalized.value.kind !== 'key') throw new Error('T013-INPUT-KEY-01 normalization failed');
  assert.equal(normalized.value.key, 'd', 'T013-INPUT-KEY-01 parser uses canonical key identity rather than terminal bytes');
  assert.equal(normalized.value.atMilliseconds, 1, 'T013-INPUT-CLOCK-01 uses injected deterministic monotonic time');

  const document = openEditable('paste', 'alpha beta');
  const selections = selectionSet(document, 'normal');
  const initial = parserState('normal', selections);
  const payload = new Uint8Array([0x78, 0x1b, 0x5b, 0x41, 0x71, 0x0a]);
  const preserved = new Uint8Array(payload);
  const paste: CanonicalInputEvent = { kind: 'paste', bytes: payload };
  const pasteEvent = normalizeVimInput(paste, inputClock);
  payload[0] = 0;
  assert.equal(pasteEvent.ok, true, 'T013-INPUT-PASTE-ESC-01 paste normalizes');
  if (!pasteEvent.ok || pasteEvent.value.kind !== 'paste') throw new Error('T013-INPUT-PASTE-ESC-01 normalization failed');
  assert.deepEqual(pasteEvent.value.bytes, preserved, 'T013-INPUT-PASTE-ESC-01 normalized payload owns a byte-preserving copy');
  const pasteOutcome = parseVimInput(initial, pasteEvent.value);
  assert.equal(pasteOutcome.kind, 'command', 'T013-INPUT-PASTE-ESC-01 paste is one command intent');
  if (pasteOutcome.kind !== 'command' || pasteOutcome.command.kind !== 'paste') throw new Error('T013-INPUT-PASTE-ESC-01 paste became key grammar');
  assert.deepEqual(pasteOutcome.command.bytes, preserved, 'T013-INPUT-PASTE-ESC-01 embedded Escape and q remain opaque bytes');
  assert.equal(pasteOutcome.state.pending.kind, 'none', 'T013-INPUT-PASTE-ESC-01 does not leave command prefixes from payload bytes');

  const release = feed(initial, 'd', { phase: 'release' });
  assert.equal(release.kind, 'consumed', 'T013-INPUT-RELEASE-01 release events do not duplicate key commands');
  assert.equal(release.state, initial, 'T013-INPUT-RELEASE-01 leaves pending parser state unchanged');
  const pointer = normalizeVimInput({
    kind: 'pointer', phase: 'down', cell: { column0: 0, row0: 0 }, button: 0,
    modifiers: noModifiers(), wheelDelta: 0,
  }, inputClock);
  assert.equal(pointer.ok, true, 'T013-INPUT-POINTER-01 pointer passes canonical normalization');
  if (pointer.ok) assert.equal(parseVimInput(initial, pointer.value).kind, 'unhandled', 'T013-INPUT-POINTER-01 pointer semantics remain outside Vim key grammar');
  allChecks.push('T013-INPUT-KEY-01', 'T013-INPUT-CLOCK-01', 'T013-INPUT-PASTE-ESC-01', 'T013-INPUT-RELEASE-01', 'T013-INPUT-POINTER-01');
}

function checkIncrementalGrammar(): void {
  const document = openEditable('grammar', 'one two three four five six seven');
  const selections = selectionSet(document, 'normal');
  let state = parserState('normal', selections);

  let result = feed(state, 'd');
  assert.equal(result.kind, 'pending', 'T013-GRAMMAR-D-01 operator remains pending between input events');
  if (result.kind !== 'pending') throw new Error('T013-GRAMMAR-D-01 expected pending');
  state = result.state;
  assert.equal(state.pending.kind, 'operator-motion', 'T013-GRAMMAR-D-01 typed state retains operator grammar');
  assert.equal(state.session.selections, selections, 'T013-GRAMMAR-D-01 parser is bound to the immutable selection set');
  assert.ok(result.continuations.some((item) => item.kind === 'motions' && item.keys.includes('w')), 'T013-GRAMMAR-D-01 advertises motion continuation metadata');

  state = parserState('normal', selections);
  result = feed(state, '2');
  assert.equal(result.kind, 'pending', 'T013-GRAMMAR-COUNT-01 leading nonzero digit starts a count');
  if (result.kind !== 'pending') throw new Error('T013-GRAMMAR-COUNT-01 expected count');
  state = result.state;
  result = feed(state, 'd');
  assert.equal(result.kind, 'pending', 'T013-GRAMMAR-COUNT-01 operator count transfers to operator state');
  if (result.kind !== 'pending') throw new Error('T013-GRAMMAR-COUNT-01 expected operator');
  state = result.state;
  result = feed(state, '3');
  assert.equal(result.kind, 'pending', 'T013-GRAMMAR-COUNT-01 motion count stays pending');
  if (result.kind !== 'pending' || result.state.pending.kind !== 'operator-motion') throw new Error('T013-GRAMMAR-COUNT-01 expected motion count');
  assert.equal(result.state.pending.operatorCount.value, 2, 'T013-GRAMMAR-COUNT-01 preserves operator count');
  assert.equal(result.state.pending.motionCount?.value, 3, 'T013-GRAMMAR-COUNT-01 preserves motion count');
  result = feed(result.state, 'w');
  assert.equal(result.kind, 'command', 'T013-GRAMMAR-COUNT-01 motion completes the accumulated command');
  if (result.kind !== 'command' || result.command.kind !== 'operator-motion') throw new Error('T013-GRAMMAR-COUNT-01 expected operator motion intent');
  assert.equal(result.command.operatorCount.value, 2, 'T013-GRAMMAR-COUNT-01 command carries operator count');
  assert.equal(result.command.motionCount.value, 3, 'T013-GRAMMAR-COUNT-01 command carries motion count');
  assert.equal(result.command.selections, selections, 'T013-GRAMMAR-COUNT-01 command captures the shared selection set');

  state = parserState('normal', selections);
  result = feed(state, '"');
  assert.equal(result.kind, 'pending', 'T013-GRAMMAR-REGISTER-01 quote starts a register prefix');
  if (result.kind !== 'pending') throw new Error('T013-GRAMMAR-REGISTER-01 expected register name');
  assert.equal(result.state.pending.kind, 'register-name', 'T013-GRAMMAR-REGISTER-01 uses a typed register state');
  assert.ok(result.continuations.some((item) => item.kind === 'register-name' && item.characters.includes('a')), 'T013-GRAMMAR-REGISTER-01 advertises valid register names');
  result = feed(result.state, 'a');
  assert.equal(result.kind, 'pending', 'T013-GRAMMAR-REGISTER-01 register survives as a command modifier');
  if (result.kind !== 'pending' || result.state.pending.kind !== 'register-command') throw new Error('T013-GRAMMAR-REGISTER-01 expected registered-command state');
  result = feed(result.state, 'd');
  if (result.kind !== 'pending' || result.state.pending.kind !== 'operator-motion') throw new Error('T013-GRAMMAR-REGISTER-01 expected operator state');
  assert.equal(result.state.pending.register, 'a', 'T013-GRAMMAR-REGISTER-01 register identity remains attached');
  result = feed(result.state, 'w');
  assert.equal(result.kind, 'command', 'T013-GRAMMAR-REGISTER-01 completes registered operator');
  if (result.kind !== 'command' || result.command.kind !== 'operator-motion') throw new Error('T013-GRAMMAR-REGISTER-01 expected operator motion');
  assert.equal(result.command.register, 'a', 'T013-GRAMMAR-REGISTER-01 emits selected register');

  state = parserState('normal', selections);
  result = feed(state, 'g');
  assert.equal(result.kind, 'pending', 'T013-GRAMMAR-G-01 g prefix survives incremental input');
  if (result.kind !== 'pending') throw new Error('T013-GRAMMAR-G-01 expected g prefix');
  assert.equal(result.state.pending.kind, 'command-prefix', 'T013-GRAMMAR-G-01 prefix has a typed state');
  assert.ok(result.continuations.some((item) => item.kind === 'keys' && item.keys.includes('j')), 'T013-GRAMMAR-G-01 advertises legal g continuations');
  result = feed(result.state, 'j');
  assert.equal(result.kind, 'command', 'T013-GRAMMAR-G-01 g motion completes');
  if (result.kind !== 'command' || result.command.kind !== 'prefixed-key') throw new Error('T013-GRAMMAR-G-01 expected prefixed command intent');
  assert.equal(result.command.prefix, 'g', 'T013-GRAMMAR-G-01 command retains prefix identity');
  assert.equal(result.command.key, 'j', 'T013-GRAMMAR-G-01 command retains continuation key');

  state = parserState('normal', selections);
  result = feed(feed(state, 'g').state, 'r');
  assert.equal(result.kind, 'pending', 'T013-GRAMMAR-GR-01 virtual replace waits for its literal payload');
  if (result.kind !== 'pending') throw new Error('T013-GRAMMAR-GR-01 expected virtual-replace literal state');
  assert.equal(result.state.pending.kind, 'literal-argument', 'T013-GRAMMAR-GR-01 virtual replace uses typed literal state');
  if (result.state.pending.kind !== 'literal-argument') throw new Error('T013-GRAMMAR-GR-01 expected literal state');
  assert.equal(result.state.pending.command, 'virtual-replace', 'T013-GRAMMAR-GR-01 literal state identifies gr');
  result = feed(result.state, 'X');
  assert.equal(result.kind, 'command', 'T013-GRAMMAR-GR-01 payload completes virtual replace');
  if (result.kind !== 'command' || result.command.kind !== 'literal-command') throw new Error('T013-GRAMMAR-GR-01 expected literal command');
  assert.equal(result.command.command, 'virtual-replace', 'T013-GRAMMAR-GR-01 command retains virtual replace identity');
  assert.equal(result.command.argument, 'X', 'T013-GRAMMAR-GR-01 command retains replacement grapheme');

  state = parserState('normal', selections);
  result = feed(state, '\\', { ctrl: true });
  assert.equal(result.kind, 'pending', 'T013-GRAMMAR-CTRL-BACKSLASH-01 control prefix remains pending');
  if (result.kind !== 'pending') throw new Error('T013-GRAMMAR-CTRL-BACKSLASH-01 expected control prefix');
  assert.equal(result.state.pending.kind, 'command-prefix', 'T013-GRAMMAR-CTRL-BACKSLASH-01 prefix has a typed state');
  if (result.state.pending.kind !== 'command-prefix') throw new Error('T013-GRAMMAR-CTRL-BACKSLASH-01 expected command prefix');
  assert.equal(result.state.pending.prefix, 'ctrl-backslash', 'T013-GRAMMAR-CTRL-BACKSLASH-01 prefix identity is retained');
  result = feed(result.state, 'n', { ctrl: true });
  assert.equal(result.kind, 'command', 'T013-GRAMMAR-CTRL-BACKSLASH-01 Ctrl-N continuation completes');
  if (result.kind !== 'command' || result.command.kind !== 'prefixed-key') throw new Error('T013-GRAMMAR-CTRL-BACKSLASH-01 expected prefixed command');
  assert.equal(result.command.prefix, 'ctrl-backslash', 'T013-GRAMMAR-CTRL-BACKSLASH-01 command retains prefix identity');
  assert.equal(result.command.key, '<C-n>', 'T013-GRAMMAR-CTRL-BACKSLASH-01 command retains control continuation');

  state = parserState('normal', selections);
  result = feed(state, 'f');
  assert.equal(result.kind, 'pending', 'T013-GRAMMAR-LITERAL-01 find command waits for one literal argument');
  if (result.kind !== 'pending' || result.state.pending.kind !== 'literal-argument') throw new Error('T013-GRAMMAR-LITERAL-01 expected literal state');
  assert.equal(result.state.pending.command, 'find-forward', 'T013-GRAMMAR-LITERAL-01 literal state identifies the command');
  assert.ok(result.continuations.some((item) => item.kind === 'literal-character'), 'T013-GRAMMAR-LITERAL-01 exposes a literal prompt, not a filtering key list');
  result = feed(result.state, 'x');
  assert.equal(result.kind, 'command', 'T013-GRAMMAR-LITERAL-01 argument completes find command');
  if (result.kind !== 'command' || result.command.kind !== 'literal-command') throw new Error('T013-GRAMMAR-LITERAL-01 expected literal command');
  assert.equal(result.command.argument, 'x', 'T013-GRAMMAR-LITERAL-01 preserves literal argument');

  state = parserState('normal', selections);
  result = feed(state, 'd');
  if (result.kind !== 'pending') throw new Error('T013-GRAMMAR-TEXT-OBJECT-01 expected operator');
  result = feed(result.state, 'i');
  assert.equal(result.kind, 'pending', 'T013-GRAMMAR-TEXT-OBJECT-01 inner text-object prefix remains pending');
  if (result.kind !== 'pending') throw new Error('T013-GRAMMAR-TEXT-OBJECT-01 expected text-object prefix');
  result = feed(result.state, 'w');
  assert.equal(result.kind, 'command', 'T013-GRAMMAR-TEXT-OBJECT-01 text-object argument completes');
  if (result.kind !== 'command' || result.command.kind !== 'operator-text-object') throw new Error('T013-GRAMMAR-TEXT-OBJECT-01 expected text-object intent');
  assert.equal(result.command.textObject, 'iw', 'T013-GRAMMAR-TEXT-OBJECT-01 retains inner-word identity');

  state = parserState('normal', selections);
  result = feed(state, '0');
  assert.equal(result.kind, 'command', 'T013-GRAMMAR-ZERO-01 idle zero is a motion, not a count');
  if (result.kind !== 'command' || result.command.kind !== 'single-key') throw new Error('T013-GRAMMAR-ZERO-01 expected single motion');
  assert.equal(result.command.key, '0', 'T013-GRAMMAR-ZERO-01 keeps the line-start motion');
  assert.equal(result.command.count.value, 1, 'T013-GRAMMAR-ZERO-01 default motion count is one');

  state = parserState('normal', selections);
  result = feed(state, '3');
  if (result.kind !== 'pending') throw new Error('T013-GRAMMAR-ZERO-03 expected count prefix');
  result = feed(result.state, '0');
  assert.equal(result.kind, 'pending', 'T013-GRAMMAR-ZERO-03 zero after a nonzero count remains a count digit');
  if (result.kind !== 'pending' || result.state.pending.kind !== 'count') throw new Error('T013-GRAMMAR-ZERO-03 expected count state');
  assert.equal(result.state.pending.count.value, 30, 'T013-GRAMMAR-ZERO-03 count digits retain positional value');

  state = parserState('normal', selections);
  result = feed(state, 'd');
  if (result.kind !== 'pending') throw new Error('T013-GRAMMAR-ZERO-02 expected operator');
  result = feed(result.state, '0');
  assert.equal(result.kind, 'command', 'T013-GRAMMAR-ZERO-02 zero after an operator is a motion');
  if (result.kind !== 'command' || result.command.kind !== 'operator-motion') throw new Error('T013-GRAMMAR-ZERO-02 expected operator motion');
  assert.equal(result.command.motion, '0', 'T013-GRAMMAR-ZERO-02 operator receives line-start motion');

  const hugeDigits = '9'.repeat(40);
  state = parserState('normal', selections);
  for (const digit of hugeDigits) {
    result = feed(state, digit);
    if (result.kind !== 'pending') throw new Error('T013-GRAMMAR-COUNT-SATURATION-01 count unexpectedly completed');
    state = result.state;
  }
  assert.equal(state.pending.kind, 'count', 'T013-GRAMMAR-COUNT-SATURATION-01 very large count stays bounded and pending');
  if (state.pending.kind !== 'count') throw new Error('T013-GRAMMAR-COUNT-SATURATION-01 expected count');
  assert.equal(state.pending.count.value, Number.MAX_SAFE_INTEGER, 'T013-GRAMMAR-COUNT-SATURATION-01 count saturates at a safe bound');
  assert.equal(state.pending.count.saturated, true, 'T013-GRAMMAR-COUNT-SATURATION-01 saturation is explicit, never silent overflow');
  result = feed(state, 'l');
  assert.equal(result.kind, 'command', 'T013-GRAMMAR-COUNT-SATURATION-01 bounded count remains executable');
  if (result.kind !== 'command' || result.command.kind !== 'single-key') throw new Error('T013-GRAMMAR-COUNT-SATURATION-01 expected motion');
  assert.equal(result.command.count.value, Number.MAX_SAFE_INTEGER, 'T013-GRAMMAR-COUNT-SATURATION-01 command carries bounded count');
  assert.equal(result.command.count.saturated, true, 'T013-GRAMMAR-COUNT-SATURATION-01 command carries saturation marker');

  allChecks.push('T013-GRAMMAR-D-01', 'T013-GRAMMAR-COUNT-01', 'T013-GRAMMAR-REGISTER-01', 'T013-GRAMMAR-G-01', 'T013-GRAMMAR-GR-01', 'T013-GRAMMAR-CTRL-BACKSLASH-01', 'T013-GRAMMAR-LITERAL-01', 'T013-GRAMMAR-TEXT-OBJECT-01', 'T013-GRAMMAR-ZERO-01', 'T013-GRAMMAR-ZERO-02', 'T013-GRAMMAR-ZERO-03', 'T013-GRAMMAR-COUNT-SATURATION-01');
}

function checkParserStateDeepImmutability(): void {
  const document = openEditable('immutable-parser-state', 'one two three');
  const selections = selectionSet(document, 'normal');
  let result = feed(parserState('normal', selections), 'd');
  if (result.kind !== 'pending' || result.state.pending.kind !== 'operator-motion') {
    throw new Error('T013-STATE-IMMUTABLE-01 expected direct operator prefix');
  }

  const directOperator = result.state.pending.operator;
  assert.equal(Object.isFrozen(result.state), true, 'T013-STATE-IMMUTABLE-01 parser state is frozen');
  assert.equal(Object.isFrozen(result.state.pending), true, 'T013-STATE-IMMUTABLE-01 pending discriminant is frozen');
  assert.equal(Object.isFrozen(directOperator), true, 'T013-STATE-IMMUTABLE-01 nested direct operator prefix is frozen');
  assert.equal(Reflect.set(directOperator, 'key', 'c'), false, 'T013-STATE-IMMUTABLE-01 cannot mutate a direct operator prefix');
  assert.equal(result.state.pending.operator.key, 'd', 'T013-STATE-IMMUTABLE-01 mutation cannot alter pending delete command');

  const continuations = result.state.legalContinuations;
  const motionContinuation = continuations.find((item) => item.kind === 'motions');
  if (motionContinuation?.kind !== 'motions') throw new Error('T013-STATE-IMMUTABLE-01 expected motion continuation');
  assert.equal(Object.isFrozen(continuations), true, 'T013-STATE-IMMUTABLE-01 continuation list is frozen');
  assert.equal(Object.isFrozen(motionContinuation), true, 'T013-STATE-IMMUTABLE-01 continuation record is frozen');
  assert.equal(Object.isFrozen(motionContinuation.keys), true, 'T013-STATE-IMMUTABLE-01 continuation keys are frozen');
  assert.equal(Reflect.set(motionContinuation, 'label', 'corrupted'), false, 'T013-STATE-IMMUTABLE-01 cannot mutate continuation record');
  assert.equal(Reflect.set(motionContinuation.keys, 0, 'x'), false, 'T013-STATE-IMMUTABLE-01 cannot mutate nested continuation keys');
  assert.ok(motionContinuation.keys.includes('w'), 'T013-STATE-IMMUTABLE-01 continuation keys retain their grammar');

  result = feed(feed(parserState('normal', selections), 'g').state, 'q');
  if (result.kind !== 'pending' || result.state.pending.kind !== 'operator-motion') {
    throw new Error('T013-STATE-IMMUTABLE-02 expected gq operator prefix');
  }
  const gOperator = result.state.pending.operator;
  assert.equal(Object.isFrozen(gOperator), true, 'T013-STATE-IMMUTABLE-02 nested gq operator prefix is frozen');
  assert.equal(Reflect.set(gOperator, 'repeatKey', 'x'), false, 'T013-STATE-IMMUTABLE-02 cannot mutate a gq operator prefix');
  assert.equal(result.state.pending.operator.repeatKey, 'q', 'T013-STATE-IMMUTABLE-02 pending format command keeps its doubled key');

  result = feed(result.state, 'w');
  if (result.kind !== 'command' || result.command.kind !== 'operator-motion') {
    throw new Error('T013-STATE-IMMUTABLE-03 expected completed gq motion');
  }
  assert.equal(Object.isFrozen(result.command.operator), true, 'T013-STATE-IMMUTABLE-03 command intent operator is frozen');
  assert.equal(Reflect.set(result.command.operator, 'name', 'delete'), false, 'T013-STATE-IMMUTABLE-03 cannot mutate emitted operator intent');
  assert.equal(result.command.operator.name, 'format', 'T013-STATE-IMMUTABLE-03 emitted format command remains unchanged');

  allChecks.push('T013-STATE-IMMUTABLE-01', 'T013-STATE-IMMUTABLE-02', 'T013-STATE-IMMUTABLE-03');
}

function checkCancellationErrorsAndModes(): void {
  const document = openEditable('cancel', 'alpha beta');
  const normalSelections = selectionSet(document, 'normal');
  let result = feed(parserState('normal', normalSelections), 'd');
  if (result.kind !== 'pending') throw new Error('T013-CANCEL-ESC-01 expected operator pending');
  result = feed(result.state, 'Escape');
  assert.equal(result.kind, 'cancelled', 'T013-CANCEL-ESC-01 Escape cancels pending operator');
  assert.equal(result.state.pending.kind, 'none', 'T013-CANCEL-ESC-01 cancelled grammar is cleared');
  assert.equal(result.state.session.mode, 'normal', 'T013-CANCEL-ESC-01 mode remains Normal');

  result = feed(parserState('normal', normalSelections), 'd');
  if (result.kind !== 'pending') throw new Error('T013-CANCEL-INVALID-01 expected operator pending');
  result = feed(result.state, 'F13');
  assert.equal(result.kind, 'failed', 'T013-CANCEL-INVALID-01 invalid continuation is a failure outcome');
  assert.equal(result.state.pending.kind, 'none', 'T013-CANCEL-INVALID-01 failure clears incomplete command');

  result = feed(parserState('normal', normalSelections), 'd');
  if (result.kind !== 'pending') throw new Error('T013-CANCEL-FOCUS-01 expected operator pending');
  const lostFocus = normalizeVimInput({ kind: 'focus', focused: false }, inputClock);
  assert.equal(lostFocus.ok, true, 'T013-CANCEL-FOCUS-01 focus event normalizes');
  if (!lostFocus.ok) throw new Error('T013-CANCEL-FOCUS-01 normalization failed');
  result = parseVimInput(result.state, lostFocus.value);
  assert.equal(result.kind, 'cancelled', 'T013-CANCEL-FOCUS-01 focus loss cancels pending operator');
  assert.equal(result.state.pending.kind, 'none', 'T013-CANCEL-FOCUS-01 no stale operator remains');
  result = feed(result.state, 'w');
  assert.equal(result.kind, 'command', 'T013-CANCEL-FOCUS-01 later key is parsed as a fresh command');
  if (result.kind !== 'command' || result.command.kind !== 'single-key') throw new Error('T013-CANCEL-FOCUS-01 expected fresh motion');

  const insertSelections = selectionSet(document, 'insert');
  let state = parserState('normal', normalSelections);
  result = feed(state, 'i');
  assert.equal(result.kind, 'command', 'T013-MODE-INSERT-01 insert key produces a typed mode intent');
  if (result.kind !== 'command' || result.command.kind !== 'mode-transition') throw new Error('T013-MODE-INSERT-01 expected mode transition');
  assert.equal(result.command.to, 'insert', 'T013-MODE-INSERT-01 targets Insert mode');
  const updated = updateVimParserSession(result.state, 'insert', insertSelections);
  assert.equal(updated.ok, true, 'T013-MODE-INSERT-01 installs Insert selection-set snapshot');
  if (!updated.ok) throw new Error('T013-MODE-INSERT-01 mode/session mismatch');
  state = updated.value.state;
  result = feed(state, 'x');
  assert.equal(result.kind, 'command', 'T013-MODE-INSERT-01 Insert key becomes literal input intent');
  if (result.kind !== 'command' || result.command.kind !== 'insert-key') throw new Error('T013-MODE-INSERT-01 expected insert key');
  assert.equal(result.command.key, 'x', 'T013-MODE-INSERT-01 preserves text key');
  result = feed(state, 'Escape');
  assert.equal(result.kind, 'command', 'T013-MODE-ESCAPE-01 Escape is an Insert mode transition intent');
  if (result.kind !== 'command' || result.command.kind !== 'leave-mode') throw new Error('T013-MODE-ESCAPE-01 expected mode exit');
  assert.equal(result.command.via, 'escape', 'T013-MODE-ESCAPE-01 preserves Escape origin');
  result = feed(state, 'c', { ctrl: true });
  assert.equal(result.kind, 'command', 'T013-MODE-CTRLC-01 Ctrl-C is an Insert mode transition intent');
  if (result.kind !== 'command' || result.command.kind !== 'leave-mode') throw new Error('T013-MODE-CTRLC-01 expected mode exit');
  assert.equal(result.command.via, 'ctrl-c', 'T013-MODE-CTRLC-01 Ctrl-C remains distinct from Escape');
  const insertPasteBytes = new Uint8Array([0x45, 0x53, 0x43, 0x1b, 0x71]);
  const insertPaste = normalizeVimInput({ kind: 'paste', bytes: insertPasteBytes }, inputClock);
  assert.equal(insertPaste.ok, true, 'T013-MODE-PASTE-01 Insert paste normalizes');
  if (!insertPaste.ok) throw new Error('T013-MODE-PASTE-01 normalization failed');
  const insertPasteResult = parseVimInput(state, insertPaste.value);
  assert.equal(insertPasteResult.kind, 'command', 'T013-MODE-PASTE-01 Insert paste is one literal payload intent');
  if (insertPasteResult.kind !== 'command' || insertPasteResult.command.kind !== 'paste') throw new Error('T013-MODE-PASTE-01 paste became key grammar');
  assert.deepEqual(insertPasteResult.command.bytes, insertPasteBytes, 'T013-MODE-PASTE-01 escape bytes remain in the paste payload');
  assert.equal(insertPasteResult.command.mode, 'insert', 'T013-MODE-PASTE-01 paste retains the active mode');
  const replaceState = createVimParserState('replace', insertSelections);
  assert.equal(replaceState.ok, true, 'T013-MODE-REPLACE-01 Replace uses the shared Insert caret set');
  if (replaceState.ok) {
    const replaceKey = feed(replaceState.value, 'x');
    assert.equal(replaceKey.kind, 'command', 'T013-MODE-REPLACE-01 key is passed through typed Insert grammar');
    if (replaceKey.kind === 'command' && replaceKey.command.kind === 'insert-key') assert.equal(replaceKey.command.mode, 'replace', 'T013-MODE-REPLACE-01 preserves Replace mode');
  }

  const changedSelections = selectionSet(document, 'normal', 1);
  const pending = feed(parserState('normal', normalSelections), 'd');
  if (pending.kind !== 'pending') throw new Error('T013-SESSION-GENERATION-01 expected pending operator');
  const sameGeneration = updateVimParserSession(pending.state, 'normal', normalSelections);
  assert.equal(sameGeneration.ok, true, 'T013-SESSION-GENERATION-02 same session snapshot may be reinstalled');
  if (sameGeneration.ok) {
    assert.equal(sameGeneration.value.cancelledPending, false, 'T013-SESSION-GENERATION-02 unrelated refresh preserves pending grammar');
    assert.equal(sameGeneration.value.state.pending.kind, 'operator-motion', 'T013-SESSION-GENERATION-02 operator survives unchanged session refresh');
  }
  const replaced = updateVimParserSession(pending.state, 'normal', changedSelections);
  assert.equal(replaced.ok, true, 'T013-SESSION-GENERATION-01 new immutable selection set installs');
  if (replaced.ok) {
    assert.equal(replaced.value.cancelledPending, true, 'T013-SESSION-GENERATION-01 changed selection generation cancels stale grammar');
    assert.equal(replaced.value.state.pending.kind, 'none', 'T013-SESSION-GENERATION-01 no stale prefix crosses session generation');
  }

  const visualSelections = selectionSet(document, 'visual-character');
  result = feed(parserState('normal', normalSelections), 'v');
  assert.equal(result.kind, 'command', 'T013-MODE-VISUAL-01 v produces a typed Visual transition');
  if (result.kind !== 'command' || result.command.kind !== 'mode-transition') throw new Error('T013-MODE-VISUAL-01 expected mode intent');
  assert.equal(result.command.to, 'visual-character', 'T013-MODE-VISUAL-01 selects character Visual mode');
  const visualState = updateVimParserSession(result.state, 'visual-character', visualSelections);
  assert.equal(visualState.ok, true, 'T013-MODE-VISUAL-01 installs matching Visual selection-set state');
  if (visualState.ok) {
    // nvim ('abc' vld -> 'c'): Visual d/c/y (and <, >, =) act immediately on
    // the selection instead of opening an operator-pending motion.
    const visualOperator = feed(visualState.value.state, 'd');
    assert.equal(visualOperator.kind, 'command', 'T013-MODE-VISUAL-01 Visual d is immediate, not a pending operator-motion');
    if (visualOperator.kind === 'command') assert.equal(visualOperator.command.kind, 'single-key', 'T013-MODE-VISUAL-01 Visual d dispatches as single-key');
    const visualEscape = feed(visualState.value.state, 'Escape');
    assert.equal(visualEscape.kind, 'command', 'T013-MODE-VISUAL-01 Escape exits Visual mode');
  }

  const wrongMode = createVimParserState('insert', normalSelections);
  assert.equal(wrongMode.ok, false, 'T013-MODE-VALIDATION-01 a Normal set cannot back an Insert session');

  allChecks.push('T013-CANCEL-ESC-01', 'T013-CANCEL-INVALID-01', 'T013-CANCEL-FOCUS-01', 'T013-MODE-INSERT-01', 'T013-MODE-ESCAPE-01', 'T013-MODE-CTRLC-01', 'T013-MODE-PASTE-01', 'T013-MODE-REPLACE-01', 'T013-MODE-VISUAL-01', 'T013-MODE-VALIDATION-01', 'T013-SESSION-GENERATION-01', 'T013-SESSION-GENERATION-02');
}

function checkAuditFindingsE1(): void {
  const document = openEditable('e1', 'one two three four five six seven');
  const normalSelections = selectionSet(document, 'normal');

  // E1-1. nvim (.artifacts/oracle/nvim-linux-arm64/bin/nvim --headless --clean -u NONE
  //   -c "call setline(1,['1','2','3','4','5','6','7','8'])" -c 'normal 2"a3yy'):
  //   "6 lines yanked into "a" -- precount and postcount multiply (2*3=6), not concatenate (23).
  let state = parserState('normal', normalSelections);
  let result = feed(state, '2');
  if (result.kind !== 'pending') throw new Error('T013-E1-1-COUNT expected pending count');
  result = feed(result.state, '"');
  if (result.kind !== 'pending') throw new Error('T013-E1-1-QUOTE expected pending register-name');
  result = feed(result.state, 'a');
  if (result.kind !== 'pending' || result.state.pending.kind !== 'register-command') throw new Error('T013-E1-1-REG expected pending register-command');
  result = feed(result.state, '3');
  if (result.kind !== 'pending') throw new Error('T013-E1-1-POSTCOUNT expected pending postcount digit');
  result = feed(result.state, 'y');
  if (result.kind !== 'pending') throw new Error('T013-E1-1-Y expected pending operator');
  result = feed(result.state, 'y');
  assert.equal(result.kind, 'command', 'T013-E1-1-MULTIPLY yy completes the linewise operator');
  if (result.kind !== 'command' || result.command.kind !== 'operator-line') throw new Error('T013-E1-1-MULTIPLY expected operator-line');
  assert.equal(result.command.count.value, 6, 'T013-E1-1-MULTIPLY 2"a3yy multiplies precount*postcount (6), not 23');
  assert.equal(result.command.register, 'a', 'T013-E1-1-MULTIPLY keeps the selected register');

  // nvim (-c "call setline(1,'abcdef')" -c 'normal 3l2"a0' -c 'echo col(".")'): col 1 --
  // a leading 0 right after the register is the '0' motion, not a postcount digit,
  // so the command fires immediately instead of staying pending forever.
  state = parserState('normal', normalSelections);
  result = feed(state, '2');
  if (result.kind !== 'pending') throw new Error('T013-E1-1-ZERO-COUNT expected pending');
  result = feed(result.state, '"');
  if (result.kind !== 'pending') throw new Error('T013-E1-1-ZERO-QUOTE expected pending');
  result = feed(result.state, 'a');
  if (result.kind !== 'pending') throw new Error('T013-E1-1-ZERO-REG expected pending');
  result = feed(result.state, '0');
  assert.equal(result.kind, 'command', 'T013-E1-1-ZERO 2"a0 fires the 0 motion instead of accumulating a count of 20');
  if (result.kind !== 'command' || result.command.kind !== 'single-key') throw new Error('T013-E1-1-ZERO expected single-key command');
  assert.equal(result.command.key, '0', 'T013-E1-1-ZERO the key is the 0 motion');

  // E1-2. nvim (-c "call setline(1,'ABC')" -c 'normal vllgu'): "abc" -- Visual gu acts on the
  // selection immediately, the same as plain d/c/y, instead of opening an operator-pending wait.
  const visualSelections = selectionSet(document, 'visual-character');
  result = feed(parserState('visual-character', visualSelections), 'g');
  if (result.kind !== 'pending') throw new Error('T013-E1-2-G expected pending g-prefix');
  result = feed(result.state, 'u');
  assert.equal(result.kind, 'command', 'T013-E1-2-GU Visual gu is immediate, not a pending operator-motion');
  if (result.kind !== 'command' || result.command.kind !== 'single-key') throw new Error('T013-E1-2-GU expected single-key command');
  assert.equal(result.command.key, 'gu', 'T013-E1-2-GU dispatches the whole gu key');

  // E1-3. nvim (-c "call setline(1,'abcdef')" -c "normal 0mallld\`a"): "def" -- `` d`a `` deletes
  // from the cursor to a mark; the literal-argument continuation for a mark jump must be legal
  // after an operator, not rejected before isMotionKey/isOperatorMotionLiteral get a look.
  result = feed(parserState('normal', normalSelections), 'd');
  if (result.kind !== 'pending') throw new Error('T013-E1-3-BACKTICK-D expected pending operator');
  result = feed(result.state, '`');
  assert.equal(result.kind, 'pending', 'T013-E1-3-BACKTICK d` waits for the mark name instead of failing');
  if (result.kind !== 'pending' || result.state.pending.kind !== 'literal-argument') throw new Error('T013-E1-3-BACKTICK expected literal-argument pending');
  result = feed(result.state, 'a');
  assert.equal(result.kind, 'command', 'T013-E1-3-BACKTICK completes the mark-jump operator motion');
  if (result.kind !== 'command' || result.command.kind !== 'operator-motion') throw new Error('T013-E1-3-BACKTICK expected operator-motion');
  assert.equal(result.command.motion, '`a', 'T013-E1-3-BACKTICK motion is the mark jump `a');

  result = feed(parserState('normal', normalSelections), 'd');
  if (result.kind !== 'pending') throw new Error("T013-E1-3-QUOTE-D expected pending operator");
  result = feed(result.state, "'");
  assert.equal(result.kind, 'pending', "T013-E1-3-QUOTE y'a waits for the mark name instead of failing");
  if (result.kind !== 'pending' || result.state.pending.kind !== 'literal-argument') throw new Error('T013-E1-3-QUOTE expected literal-argument pending');

  // MOTION_KEYS must include <Space>/<CR> so operators can take them as a motion.
  result = feed(parserState('normal', normalSelections), 'd');
  if (result.kind !== 'pending') throw new Error('T013-E1-3-SPACE-D expected pending operator');
  result = feed(result.state, 'Space');
  assert.equal(result.kind, 'command', 'T013-E1-3-SPACE d<Space> is a legal operator motion');
  if (result.kind !== 'command' || result.command.kind !== 'operator-motion') throw new Error('T013-E1-3-SPACE expected operator-motion');
  assert.equal(result.command.motion, '<Space>', 'T013-E1-3-SPACE motion is <Space>');

  // nvim (-c "call setline(1,['abc','def','ghi'])" -c 'normal 0ldvj'): "aef"/"ghi" (vs. plain
  // dj's linewise no-op-looking full-line delete) -- v/V/<C-v> right after an operator forces
  // the following motion's wise-ness; the parser must carry that as a `force` flag on the
  // eventual operator-motion command. Consumer note: packages/vim/multi must read
  // VimCommandIntent.force ('v' | 'V' | '<C-v>') on 'operator-motion' commands and apply
  // characterwise/linewise/blockwise range computation accordingly -- it is not honored yet.
  for (const [pressed, expectedForce] of [['v', 'v'], ['V', 'V']] as const) {
    result = feed(parserState('normal', normalSelections), 'd');
    if (result.kind !== 'pending') throw new Error('T013-E1-3-FORCE-D expected pending operator');
    result = feed(result.state, pressed);
    assert.equal(result.kind, 'pending', `T013-E1-3-FORCE-${pressed} force key stays pending, does not fail or start Visual`);
    if (result.kind !== 'pending' || result.state.pending.kind !== 'operator-motion') throw new Error(`T013-E1-3-FORCE-${pressed} expected operator-motion pending`);
    assert.equal(result.state.pending.force, expectedForce, `T013-E1-3-FORCE-${pressed} pending records the force key`);
    result = feed(result.state, 'j');
    assert.equal(result.kind, 'command', `T013-E1-3-FORCE-${pressed} completes with the forced motion`);
    if (result.kind !== 'command' || result.command.kind !== 'operator-motion') throw new Error(`T013-E1-3-FORCE-${pressed} expected operator-motion command`);
    assert.equal(result.command.force, expectedForce, `T013-E1-3-FORCE-${pressed} command carries the force flag`);
    assert.equal(result.command.motion, 'j', `T013-E1-3-FORCE-${pressed} motion is unchanged`);
  }
  result = feed(parserState('normal', normalSelections), 'd');
  if (result.kind !== 'pending') throw new Error('T013-E1-3-FORCE-CV-D expected pending operator');
  result = feed(result.state, 'v', { ctrl: true });
  if (result.kind !== 'pending' || result.state.pending.kind !== 'operator-motion') throw new Error('T013-E1-3-FORCE-CV expected operator-motion pending');
  assert.equal(result.state.pending.force, '<C-v>', 'T013-E1-3-FORCE-CV d<C-v> records the blockwise force key');
  result = feed(result.state, 'j');
  if (result.kind !== 'command' || result.command.kind !== 'operator-motion') throw new Error('T013-E1-3-FORCE-CV expected operator-motion command');
  assert.equal(result.command.force, '<C-v>', 'T013-E1-3-FORCE-CV command carries the blockwise force flag');

  // E1-4. nvim (-c "call setline(1,'abcdef')" -c 'call feedkeys("3lr\<CR>","x")'):
  // "abc"/"ef" -- r<CR> replaces a character with a newline; f<Tab> similarly needs a named
  // single-character key accepted as a literal argument, not just printable characters.
  result = feed(parserState('normal', normalSelections), 'r');
  if (result.kind !== 'pending') throw new Error('T013-E1-4-R-D expected pending literal-argument');
  result = feed(result.state, 'Return');
  assert.equal(result.kind, 'command', 'T013-E1-4-R-CR r<CR> is a legal literal argument');
  if (result.kind !== 'command' || result.command.kind !== 'literal-command') throw new Error('T013-E1-4-R-CR expected literal-command');
  assert.equal(result.command.argument, '\n', 'T013-E1-4-R-CR argument is a real newline character');

  result = feed(parserState('normal', normalSelections), 'f');
  if (result.kind !== 'pending') throw new Error('T013-E1-4-F-D expected pending literal-argument');
  result = feed(result.state, 'Tab');
  assert.equal(result.kind, 'command', 'T013-E1-4-F-TAB f<Tab> is a legal literal argument');
  if (result.kind !== 'command' || result.command.kind !== 'literal-command') throw new Error('T013-E1-4-F-TAB expected literal-command');
  assert.equal(result.command.argument, '\t', 'T013-E1-4-F-TAB argument is a real tab character');

  allChecks.push(
    'T013-E1-1-MULTIPLY', 'T013-E1-1-ZERO', 'T013-E1-2-GU',
    'T013-E1-3-BACKTICK', 'T013-E1-3-QUOTE', 'T013-E1-3-SPACE', 'T013-E1-3-FORCE-v', 'T013-E1-3-FORCE-V', 'T013-E1-3-FORCE-CV',
    'T013-E1-4-R-CR', 'T013-E1-4-F-TAB',
  );
}

function checkAuditFindingE1_8ContinuationsPerf(): void {
  const document = openEditable('e1-8', 'one two three four five six seven');
  const selections = selectionSet(document, 'normal');
  const state = parserState('normal', selections);

  // continuationsFor's output for a given pending shape (operator identity + force state,
  // or prefix + hasOperator) is now cached, so re-parsing the same 'd' operator twice
  // returns the identical frozen continuations array rather than rebuilding/cloning it.
  const first = feed(state, 'd');
  const second = feed(state, 'd');
  if (first.kind !== 'pending' || second.kind !== 'pending') throw new Error('T013-E1-8-IDENTITY expected pending');
  assert.equal(first.continuations, second.continuations, 'T013-E1-8-IDENTITY same operator/force shape reuses the same frozen continuations array');

  // Engine-step budget (docs/plan/15-keystroke-latency.md, AGENTS.md): ordinary engine
  // steps must meet p95 <=1ms / p99 <=2ms. Measure parseVimInput producing a 'pending'
  // continuation list (the path continuationsFor runs on) over many iterations.
  const samples: number[] = [];
  const iterations = 2000;
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    feed(state, 'd');
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
  const p99 = samples[Math.floor(samples.length * 0.99)] ?? 0;
  assert.ok(p95 <= 1, `T013-E1-8-PERF p95 ${p95.toFixed(4)}ms must be <=1ms over ${iterations} iterations`);
  assert.ok(p99 <= 2, `T013-E1-8-PERF p99 ${p99.toFixed(4)}ms must be <=2ms over ${iterations} iterations`);
  console.log(`T013-E1-8-PERF p95=${p95.toFixed(4)}ms p99=${p99.toFixed(4)}ms over ${iterations} iterations`);

  allChecks.push('T013-E1-8-IDENTITY', 'T013-E1-8-PERF');
}

async function checkPinnedOracle(): Promise<void> {
  const oracle = await verifyOracleBundle(process.env.XI_NVIM);
  const fixtures: readonly OracleFixture[] = [
    {
      id: 'T013-ORACLE-COUNTS-01', title: 'Operator and motion counts multiply',
      purpose: 'Check the oracle effect of separately typed operator and motion counts.',
      modes: ['normal'], lines: ['one two three four five six seven'],
      steps: [{ label: '2d3w uses both counts', keys: '2d3w' }],
    },
    {
      id: 'T013-ORACLE-REGISTER-01', title: 'Named register before operator',
      purpose: 'Check the quote-register prefix and resulting named register state.',
      modes: ['normal'], lines: ['alpha beta'],
      steps: [{ label: 'delete into register a', keys: '"adw' }],
    },
    {
      id: 'T013-ORACLE-ESCAPE-01', title: 'Escape cancels an incomplete operator',
      purpose: 'Check that Escape after d leaves text and registers unchanged.',
      modes: ['normal', 'operator-pending'], lines: ['alpha beta'],
      steps: [{ label: 'cancel delete', keys: 'd<Esc>' }],
    },
    {
      id: 'T013-ORACLE-ESCAPE-02', title: 'Escape cancels an incomplete count and operator',
      purpose: 'Check cancellation after an operator count and a motion count.',
      modes: ['normal', 'operator-pending'], lines: ['alpha beta'],
      steps: [{ label: 'cancel counted delete', keys: '2d3<Esc>' }],
    },
    {
      id: 'T013-ORACLE-G-PREFIX-01', title: 'g-prefixed motion',
      purpose: 'Check a completed g-prefixed command against a nontrivial cursor position.',
      modes: ['normal'], lines: ['alpha beta'], cursor: { line: 1, byteColumn0: 0 },
      steps: [{ label: 'g$ moves to line end', keys: 'g$' }],
    },
    {
      id: 'T013-ORACLE-COUNT-SATURATION-01', title: 'Very large count remains bounded by the document',
      purpose: 'Check that an oversized count does not overflow into an error or block input.',
      modes: ['normal'], lines: ['alpha beta'],
      steps: [{ label: 'huge count motion reaches line end', keys: `${'9'.repeat(40)}l` }],
    },
    {
      id: 'T013-ORACLE-INVALID-01', title: 'Invalid operator continuation is inert',
      purpose: 'Check a non-motion control key after d does not edit or set a register.',
      modes: ['normal', 'operator-pending'], lines: ['alpha beta'],
      steps: [{ label: 'invalid control continuation', keys: 'd<C-a>' }],
    },
  ];

  for (const fixture of fixtures) {
    const result = await runOracleFixture(fixture, oracle.binaryPath);
    const snapshot = result.snapshots[0];
    assert.ok(snapshot, `${fixture.id} returned one pinned oracle snapshot`);
    switch (fixture.id) {
      case 'T013-ORACLE-COUNTS-01':
        assert.deepEqual(snapshot.lines, ['seven'], `${fixture.id} applies count 2 × 3`);
        assert.deepEqual(snapshot.registers['"'], { lines: ['one two three four five six '], type: 'v' }, `${fixture.id} captures counted delete`);
        break;
      case 'T013-ORACLE-REGISTER-01':
        assert.deepEqual(snapshot.lines, ['beta'], `${fixture.id} deletes first word`);
        assert.deepEqual(snapshot.registers.a, { lines: ['alpha '], type: 'v' }, `${fixture.id} writes selected register`);
        break;
      case 'T013-ORACLE-ESCAPE-01':
      case 'T013-ORACLE-ESCAPE-02':
      case 'T013-ORACLE-INVALID-01':
        assert.deepEqual(snapshot.lines, ['alpha beta'], `${fixture.id} does not edit text`);
        assert.equal(snapshot.mode, 'n', `${fixture.id} returns to Normal mode`);
        assert.deepEqual(snapshot.registers['"'], { lines: [], type: '' }, `${fixture.id} leaves the unnamed register unchanged`);
        break;
      case 'T013-ORACLE-G-PREFIX-01':
        assert.equal(snapshot.cursor.byteColumn, 10, `${fixture.id} reaches end of line`);
        break;
      case 'T013-ORACLE-COUNT-SATURATION-01':
        assert.equal(snapshot.cursor.byteColumn, 10, `${fixture.id} clamps the motion to end of line`);
        assert.equal(snapshot.error, '', `${fixture.id} reports no oracle error`);
        break;
    }
    assert.equal(snapshot.error, '', `${fixture.id} has no Vim error`);
    console.log(`PASS ${fixture.id}`);
  }
  allChecks.push(...fixtures.map((fixture) => fixture.id));
}

function parserState(mode: VimMode, selections: SelectionSetSnapshot): VimParserState {
  const result = createVimParserState(mode, selections);
  if (!result.ok) throw new Error(`T013-test-state:${mode}:${result.error.kind}`);
  return result.value;
}

function feed(state: VimParserState, key: string, options: { readonly phase?: 'press' | 'repeat' | 'release'; readonly ctrl?: boolean; readonly alt?: boolean; readonly shift?: boolean; readonly meta?: boolean } = {}): VimParseOutcome {
  const event: CanonicalInputEvent = {
    kind: 'key', key, phase: options.phase ?? 'press',
    modifiers: { shift: options.shift ?? false, alt: options.alt ?? false, ctrl: options.ctrl ?? false, meta: options.meta ?? false },
    rawBytes: new TextEncoder().encode(key),
  };
  const normalized = normalizeVimInput(event, inputClock);
  if (!normalized.ok) throw new Error(`T013-test-input:${normalized.error.kind}`);
  return parseVimInput(state, normalized.value);
}

function selectionSet(document: TextFileDocument, mode: 'normal' | 'insert' | 'visual-character' = 'normal', generation = 0): SelectionSetSnapshot {
  const selectionId = id(`T013-selection-${mode}-${generation}-${document.id}`);
  const start = asUtf16Offset(0);
  const after = asUtf16Offset(1);
  if (!start.ok || !after.ok) throw new Error('T013-test-selection:invalid fixture offsets');
  const endpoint: EndpointInput = mode === 'normal'
    ? { kind: 'character', offset: start.value, after: after.value }
    : mode === 'insert'
      ? { kind: 'gap', offset: start.value }
      : { kind: 'character', offset: start.value, after: after.value };
  let member: SelectionMemberInput;
  if (mode === 'normal') {
    member = { id: selectionId, kind: 'normal-cursor', direction: 'forward', anchor: endpoint, head: endpoint };
  } else if (mode === 'insert') {
    member = { id: selectionId, kind: 'insert-caret', direction: 'forward', anchor: endpoint, head: endpoint };
  } else {
    member = { id: selectionId, kind: 'visual-character', direction: 'forward', anchor: endpoint, head: endpoint, inclusive: true };
  }
  const result = createSelectionSet(document.snapshot(), { primaryId: selectionId, selectionGeneration: generation, members: [member] });
  if (!result.ok) throw new Error(`T013-test-selection:${result.error.kind}`);
  return result.value.selectionSet;
}

function openEditable(label: string, text: string): TextFileDocument {
  const documentId = asIdentifier<DocumentId>(`T013-${label}`, 'documentId');
  if (!documentId.ok) throw new Error(documentId.error.message);
  const opened = openTextDocument(documentId.value, new TextEncoder().encode(text));
  if (opened.kind !== 'editable') throw new Error(`T013-expected-editable:${label}`);
  return opened.document;
}

function id(value: string): SelectionId {
  const result = asIdentifier<SelectionId>(value, 'selectionId');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function noModifiers(): { readonly shift: false; readonly alt: false; readonly ctrl: false; readonly meta: false } {
  return { shift: false, alt: false, ctrl: false, meta: false };
}

checkNormalizationAndOpaquePaste();
checkIncrementalGrammar();
checkParserStateDeepImmutability();
checkCancellationErrorsAndModes();
checkAuditFindingsE1();
checkAuditFindingE1_8ContinuationsPerf();
await checkPinnedOracle();
console.log(`T013 passed ${allChecks.length} focused input/parser fixtures: ${allChecks.join(', ')}`);
