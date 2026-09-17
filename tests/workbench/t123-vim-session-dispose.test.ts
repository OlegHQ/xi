import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { createOwnedVimSession, type OwnedVimKeyEvent } from '../../packages/workbench/vim-session/index';

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T123-dispose-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(value: string): TextFileDocument {
  const result = TextFileDocument.create(id<DocumentId>('T123-dispose-document'), value, Array.from({ length: value.split('\n').length - 1 }, () => 'lf' as const), 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function event(name: string, raw = name): OwnedVimKeyEvent {
  return { name, raw, shift: false, option: false, ctrl: false, meta: false };
}

// T123: dispose() must release the session's pending state (command line, prefix keys,
// macro recording) and stop publishing further state through the option callbacks, so a
// closed view's `sessions.delete(viewId)` in apps/xi/src/main.ts leaves nothing behind
// that could still fire a callback into a torn-down view. It must also be idempotent.
const source = document('alpha\nbeta\n');
let stateChanges = 0;
let prefixChanges = 0;
const vim = createOwnedVimSession(source, {
  viewId: id<ViewId>('T123-dispose-view'),
  onStateChange: () => { stateChanges += 1; },
  onPrefixStateChange: () => { prefixChanges += 1; },
});

const baselineStateChanges = stateChanges;
assert.equal(vim.handleKey(event('l')), true, 'T123-DISPOSE-01 a live session still handles keys');
assert.ok(stateChanges > baselineStateChanges, 'T123-DISPOSE-02 a live session publishes state changes');

// Leave a pending prefix so dispose() has state to release.
assert.equal(vim.handleKey(event('g')), true, 'T123-DISPOSE-03 g is accepted as a pending native prefix');
assert.ok(vim.prefixHelp.pendingKeys.length > 0, 'T123-DISPOSE-04 the prefix is pending before dispose');

vim.dispose();
assert.equal(vim.prefixHelp.pendingKeys.length, 0, 'T123-DISPOSE-05 dispose() clears the pending prefix');
assert.equal(vim.commandLineActive, false, 'T123-DISPOSE-06 dispose() clears any active command line');

const afterDisposeStateChanges = stateChanges;
const afterDisposePrefixChanges = prefixChanges;
assert.equal(vim.handleKey(event('l')), true, 'T123-DISPOSE-07 handleKey after dispose is a harmless no-op, not an error');
assert.equal(stateChanges, afterDisposeStateChanges, 'T123-DISPOSE-08 a disposed session publishes no further state changes');
assert.equal(prefixChanges, afterDisposePrefixChanges, 'T123-DISPOSE-09 a disposed session publishes no further prefix state');
assert.equal(vim.setCursorPosition(0, 0), false, 'T123-DISPOSE-10 a disposed session refuses further cursor placement');

// Idempotent: a second dispose() must not throw or change anything further.
vim.dispose();
assert.equal(stateChanges, afterDisposeStateChanges, 'T123-DISPOSE-11 a second dispose() is a no-op (idempotent)');

console.log('T123 OwnedVimSession dispose passed idempotency and publication-stop fixtures');
