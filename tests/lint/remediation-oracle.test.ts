import { test, expect } from 'bun:test';
import { openTextDocument } from '../../packages/document/src/index';
import { resolveVimTextObject, resolveVimWordMotion } from '../../packages/vim/src/index';
import type { CellColumn, DocumentId, Utf16Offset } from '../../packages/primitives/src/index';
import { runOracleFixture, verifyOracleBundle } from '../oracle/oracle-runner';

// Install a fixture-local clipboard before the first capture. The older full
// snapshot suites read host clipboard registers; their failure is tracked in
// the remediation evidence and is not repaired by approving new goldens.
const clipboard = ":lua local c={}; vim.g.clipboard={name='xi-lint-isolated', copy={['+']=function(l,t)c['+']={l,t}end,['*']=function(l,t)c['*']={l,t}end},paste={['+']=function()return c['+'] or {{},'v'}end,['*']=function()return c['*'] or {{},'v'}end},cache_enabled=0}<CR>";

test('windowed quote ranges match live pinned Neovim across escapes and surrogate boundaries', async () => {
  const oracle = await verifyOracleBundle();
  for (const count of [1, 2, 3, 4]) {
    const text = '"' + 'a'.repeat(254) + '\\'.repeat(count) + '"😀b" tail';
    const opened = openTextDocument('lint-quote-oracle' as DocumentId, new TextEncoder().encode(text));
    if (opened.kind !== 'editable') throw new Error('fixture open failed');
    const snapshot = opened.document.snapshot();
    const range = resolveVimTextObject(snapshot, { documentVersion: snapshot.version, offset: 0 as Utf16Offset }, { key: 'i"' });
    if (!range.ok) throw new Error(range.error.kind);
    const actual = await runOracleFixture({
      id: `T119-QUOTE-${count}`, title: 'Window-boundary quote', purpose: 'i_quote escape parity at a 256-unit boundary',
      modes: ['normal'], lines: [text], options: { clipboard: '' },
      steps: [{ label: 'isolate', keys: clipboard }, { label: 'yank', keys: 'yi"' }],
    }, oracle.binaryPath);
    const final = actual.snapshots.at(-1);
    expect(final?.lines).toEqual([text]);
    expect(final?.registers['"']).toEqual({ lines: [text.slice(range.value.start, range.value.end)], type: 'v' });
  }
}, 30000);

test('long combining word position and desired column match live pinned Neovim', async () => {
  const oracle = await verifyOracleBundle();
  const text = 'a' + '\u0301'.repeat(8192) + ' b';
  const opened = openTextDocument('lint-word-oracle' as DocumentId, new TextEncoder().encode(text));
  if (opened.kind !== 'editable') throw new Error('fixture open failed');
  const snapshot = opened.document.snapshot();
  const outcome = resolveVimWordMotion(snapshot, {
    documentVersion: snapshot.version, offset: 0 as Utf16Offset, desiredDisplayCellColumn: 0 as CellColumn,
  }, { key: 'w' });
  if (!outcome.ok) throw new Error(outcome.error.kind);
  const actual = await runOracleFixture({
    id: 'T119-COMBINING-WORD', title: 'Long combining word', purpose: 'word desired-column and UTF-8/UTF-16 coordinate parity',
    modes: ['normal'], lines: [text], options: { clipboard: '' },
    steps: [{ label: 'isolate', keys: clipboard }, { label: 'word', keys: 'w' }],
  }, oracle.binaryPath);
  const final = actual.snapshots.at(-1);
  if (final === undefined) throw new Error('missing oracle snapshot');
  const prefix = new TextEncoder().encode(text).subarray(0, final.cursor.byteColumn - 1);
  expect(outcome.value.cursor.offset as number).toBe(new TextDecoder().decode(prefix).length);
  expect(outcome.value.cursor.desiredDisplayCellColumn as number).toBe(final.cursor.desiredColumn);
  expect(final.lines).toEqual([text]);
}, 30000);
