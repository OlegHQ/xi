import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { verifyOracleBundle, runOracleFixture } from '../oracle/oracle-runner';
import { TextFileDocument } from '../../packages/document/src/index';
import type { DocumentId, ViewId } from '../../packages/primitives/src/index';
import { createOwnedVimSession } from '../../packages/workbench/vim-session';
import { WorkbenchSession } from '../../packages/workbench/session';
import { executeViewCommand } from '../../packages/workbench/input/view-commands';

const oracle = await verifyOracleBundle();
await mkdir('.artifacts/selection-fixes', { recursive: true });
const traces = [];
const lines = Array.from({ length: 60 }, (_, i) => `word${i} next`);
const sequences = [
  ['i<C-v>u<Up>Z<Esc>'],
  ['i<C-v>u<Esc>iZ<Esc>'],
  ['i<C-r><Up>Z<Esc>'],
  ['i<C-k><Esc>iZ<Esc>'],
  ...['v', 'V', '<C-v>'].flatMap(first => ['v', 'V', '<C-v>'].map(second => [first, 'j', second, '<Esc>', 'iZ<Esc>'])),
  ['<C-v>', 'iw', '<Esc>', 'iZ<Esc>'],
  ['<C-v>', 'iw', 'd', 'u', 'iZ<Esc>'],
  ...['v', 'V', '<C-v>'].map(mode => [mode, '<C-d>', '<C-u>', 'j', 'o', '<Esc>']),
];
for (const [index, keys] of sequences.entries()) {
  const result = await runOracleFixture({ id: `visual-recovery-${index}`, title: 'Visual transition and recovery', purpose: 'Compare production session state after every key barrier', modes: ['normal', 'visual', 'insert'], lines, options: { scroll: 5 }, steps: keys.map((key, index) => ({ label: `${index}:${key}`, keys: key })) }, oracle.binaryPath);
  traces.push(result);
  const text = lines.join('\n');
  const document = TextFileDocument.create(`oracle-${index}` as DocumentId, text, Array(59).fill('lf'), 'lf');
  assert.ok(document.ok);
  const viewId = `oracle-${index}` as ViewId;
  const workbench = new WorkbenchSession();
  assert.ok(workbench.openBuffer(document.value, { viewId }).ok);
  const vim = createOwnedVimSession(document.value, { viewId, onStateChange: state => { assert.ok(workbench.syncViewSession(viewId, state.selections, state.mode).ok); } });
  for (const [step, key] of keys.entries()) {
    if (key === '<C-d>' || key === '<C-u>') executeViewCommand(key === '<C-d>' ? 'view.half-page-down' : 'view.half-page-up', { workbench, getSession: () => vim, viewId, viewportHeight: 10, scrollLines: 3 });
    else for (const token of key.match(/<[^>]+>|./gu) ?? []) await vim.handleKey({ name: token, raw: token, ctrl: false, shift: false, meta: false, option: false });
    const view = vim.readView(viewId)!;
    const expected = result.snapshots[step]!;
    const member = view.selections.members[0]!;
    const at = view.document.lineIndexAt(member.head.at.offset);
    assert.ok(at.ok);
    const start = view.document.lineStartOffset(at.value);
    assert.ok(start.ok);
    const label = `${index}/${step} ${keys.slice(0, step + 1).join('')}`;
    assert.equal(view.session.mode, expected.mode === 'n' ? 'normal' : expected.mode === 'i' ? 'insert' : 'visual', label);
    if (view.session.mode === 'visual') assert.equal(member.kind, expected.mode === 'V' ? 'visual-line' : expected.mode === '\x16' ? 'visual-block' : 'visual-character', label);
    assert.equal(at.value + 1, expected.cursor.line, label);
    assert.equal(member.head.at.offset - start.value, expected.cursor.byteColumn - 1, label);
    const actual = view.document.slice(0 as never, view.document.lengthUtf16 as never);
    assert.ok(actual.ok);
    assert.equal(actual.value, expected.lines.join('\n'), label);
  }
  vim.dispose(); workbench.dispose();
}
await mkdir('.artifacts/selection-fixes', { recursive: true });
await writeFile('.artifacts/selection-fixes/oracle.json', JSON.stringify({ oracle: oracle.manifest.oracle, traces }, null, 2));
console.log(`Pinned Neovim ${oracle.manifest.oracle.version}: ${sequences.length} Visual transition/scroll/recovery traces passed`);
