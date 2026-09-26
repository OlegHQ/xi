import { strict as assert } from 'node:assert';
import { runOracleFixture, verifyOracleBundle } from '../oracle/oracle-runner';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { createOwnedVimSession } from '../../packages/workbench/vim-session/index';
import { WorkbenchSession } from '../../packages/workbench/src/index';
import type { VimHostCommand } from '../../packages/vim/src/index';

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T071-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(value: string): TextFileDocument {
  const result = TextFileDocument.create(id<DocumentId>('T071-document'), value, Array.from({ length: value.split('\n').length - 1 }, () => 'lf' as const), 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function event(name: string, raw = name, modifiers: Partial<{ shift: boolean; option: boolean; ctrl: boolean; meta: boolean }> = {}) {
  return {
    name,
    raw,
    shift: modifiers.shift ?? false,
    option: modifiers.option ?? false,
    ctrl: modifiers.ctrl ?? false,
    meta: modifiers.meta ?? false,
  };
}

const source = document('src/other.ts:3\nFoo\n');
const commands: VimHostCommand[] = [];
const vim = createOwnedVimSession(source, {
  viewId: id<ViewId>('T071-source-view'),
  onHostCommand: (command) => { commands.push(command); },
});

assert.equal(vim.handleKey(event('g')), true, 'T071-GF-01 g remains a pending native prefix');
assert.equal(vim.handleKey(event('f')), true, 'T071-GF-01 gf is accepted without waiting on the host');
assert.deepEqual(commands.pop(), { kind: 'open-file', target: 'src/other.ts', split: false }, 'T071-GF-01 gf emits a file navigation intent');

assert.equal(vim.handleKey(event('g')), true);
assert.equal(vim.handleKey(event('f', 'f', { shift: true })), true, 'T071-GF-02 gF is accepted');
assert.deepEqual(commands.pop(), { kind: 'open-file', target: 'src/other.ts', line: 2, split: false }, 'T071-GF-02 gF carries the one based file line as zero based host state');

assert.equal(vim.handleKey(event('w', '\u0017', { ctrl: true })), true, 'T071-CW-01 Ctrl-W starts the native window grammar');
assert.equal(vim.handleKey(event('g')), true, 'T071-CW-01 Ctrl-W g keeps its nested prefix pending');
assert.equal(vim.handleKey(event('f')), true, 'T071-CW-01 Ctrl-W gf completes the nested file command');
assert.deepEqual(commands.pop(), { kind: 'open-file', target: 'src/other.ts', split: true }, 'T071-CW-01 Ctrl-W gf requests a split file open');

for (const [name, action] of [['left', 'focus-left'], ['right', 'focus-right'], ['up', 'focus-up'], ['down', 'focus-down']] as const) {
  vim.handleKey(event('w', '\u0017', { ctrl: true }));
  assert.equal(vim.handleKey(event(name, '')), true);
  assert.deepEqual(commands.pop(), { kind: 'window', action, count: 1 }, `Ctrl-W ${name} emits the matching focus intent`);
}
const oracle = await verifyOracleBundle();
const arrows = await runOracleFixture({ id: 'WINDOW-ARROW-ALIASES', title: 'Ctrl-W arrow focus', purpose: 'Verify arrow aliases switch native windows and retain their independent cursors.', modes: ['normal'], lines: ['one', 'two'], steps: [{ label: 'left-pane', keys: '<C-w>vj' }, { label: 'right-pane', keys: '<C-w><Right>' }, { label: 'left-again', keys: '<C-w><Left>' }] }, oracle.binaryPath);
assert.equal(arrows.snapshots[1]!.cursor.line, 1);
assert.equal(arrows.snapshots[2]!.cursor.line, 2);

assert.equal(vim.handleKey(event(']', ']', { ctrl: true })), true, 'T071-TAG-01 direct tag key is consumed even when no provider is installed');
assert.deepEqual(commands.pop(), { kind: 'open-tag', name: 'src/other.ts', split: false }, 'T071-TAG-01 Ctrl-] emits the bounded word under the cursor');
assert.equal(vim.handleKey(event('g')), true);
assert.equal(vim.handleKey(event(']')), true, 'T071-TAG-02 g] completes its native tag selection prefix');
assert.deepEqual(commands.pop(), { kind: 'open-tag', name: 'src/other.ts', split: false, selection: 'select' }, 'T071-TAG-02 g] asks the host for tag selection semantics');
assert.equal(vim.handleKey(event('[')), true);
assert.equal(vim.handleKey(event('d')), true, 'T071-INCLUDE-01 [d completes its include/define prefix');
assert.deepEqual(commands.pop(), { kind: 'include', target: 'src/other.ts', direction: 'previous', list: false }, 'T071-INCLUDE-01 [d emits a typed previous include search');
assert.equal(vim.handleKey(event(']')), true);
assert.equal(vim.handleKey(event('D')), true, 'T071-INCLUDE-02 ]D completes its list form');
assert.deepEqual(commands.pop(), { kind: 'include', target: 'src/other.ts', direction: 'next', list: true }, 'T071-INCLUDE-02 ]D preserves list versus jump behavior');
assert.equal(vim.handleKey(event('K')), true);
assert.deepEqual(commands.pop(), { kind: 'lookup', target: 'src/other.ts', lookup: 'keyword' }, 'T071-LOOKUP-01 K routes through the host provider boundary');
assert.equal(vim.handleKey(event('g')), true);
assert.equal(vim.handleKey(event('d')), true);
assert.deepEqual(commands.pop(), { kind: 'lookup', target: 'src/other.ts', lookup: 'definition' }, 'T071-LOOKUP-02 gd has an explicit definition-provider outcome');

const workbench = new WorkbenchSession({ minimumPaneSize: 4 });
const opened = workbench.openBuffer(document('alpha\n'), { path: '/workspace/alpha.ts', viewId: id<ViewId>('T071-window-a') });
assert.equal(opened.ok, true, 'T071-WINDOW-01 opens a native editor view');
if (!opened.ok) throw new Error('T071 source view did not open');
const firstView = opened.value.viewIds[0] as ViewId;
const split = workbench.splitView(firstView, 'vertical', id<ViewId>('T071-window-b'));
assert.equal(split.ok, true, 'T071-WINDOW-01 creates an editor split');
if (!split.ok) throw new Error('T071 split did not open');
assert.equal(workbench.focusAdjacent(split.value.viewId, 'left').ok, true, 'T071-WINDOW-02 Ctrl-W h focuses the neighboring editor window');
assert.equal(workbench.activeViewId, firstView, 'T071-WINDOW-02 panel focus is not involved in native window movement');
assert.equal(workbench.focusAdjacent(firstView, 'next').ok, true, 'T071-WINDOW-03 Ctrl-W w cycles editor windows');
assert.equal(workbench.activeViewId, split.value.viewId, 'T071-WINDOW-03 cycling focuses the split view');
assert.equal(workbench.closeOtherViews(split.value.viewId, 'discard').ok, true, 'T071-WINDOW-04 Ctrl-W o can retain one editor window');
assert.equal(workbench.views().length, 1, 'T071-WINDOW-04 sibling editor windows are closed');
workbench.dispose();
console.log('T071 native navigation passed gf/gF extraction, nested Ctrl-W grammar, tag intent and editor-window focus semantics');
