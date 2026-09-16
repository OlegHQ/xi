import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentEdit, type DocumentSnapshot } from '../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type Utf16Offset } from '../../packages/primitives/src/index';
import {
  normalizeVimOperatorRange,
  prepareVimDirectChange,
  prepareVimTextTransform,
  type VimOperatorSessionState,
} from '../../packages/vim/src/index';
import { runOracleFixture, verifyOracleBundle } from '../oracle/oracle-runner';

const state: VimOperatorSessionState = Object.freeze({ mode: 'normal', repeatTarget: null });

await compareDirect('T061-DIRECT-X-ORACLE-01', 'x', 'abc def', 3, ['abcdef'], [' ']);
await compareDirect('T061-DIRECT-X-COUNT-ORACLE-01', '2x', 'abc def', 3, ['abcef'], [' d']);
await compareDirect('T061-DIRECT-X-BACKWARD-ORACLE-01', 'X', 'abc def', 3, ['ab def'], ['c']);
await compareDirect('T061-DIRECT-X-BACKWARD-COUNT-ORACLE-01', '2X', 'abc def', 3, ['a def'], ['bc']);
await compareDirect('T061-DIRECT-D-ORACLE-01', 'D', 'abc def', 3, ['abc'], [' def']);
await compareDirect('T061-DIRECT-CASE-ORACLE-01', '~', 'aBc d', 0, ['ABc d'], []);
await compareDirect('T061-DIRECT-CASE-COUNT-ORACLE-01', '2~', 'aBc d', 0, ['Abc d'], []);
await compareVirtualReplace('T061-VIRTUAL-REPLACE-ORACLE-01', 'grX', 'a😀c', 0, ['X😀c']);
await compareVirtualReplace('T061-VIRTUAL-REPLACE-WIDTH-ORACLE-01', '2grX', 'a😀c', 0, ['XX c']);
await compareVirtualReplace('T061-VIRTUAL-REPLACE-EOL-ORACLE-01', 'grX', 'abc', 3, ['abX']);

checkNoTargetBoundaries();
await checkRot13Transform();
console.log('T061 direct gaps passed pinned x/X/D/~ text, cursor, register and boundary fixtures; g? ROT13 transform passed');

async function compareDirect(
  id: string,
  keys: string,
  source: string,
  cursor: number,
  expectedLines: readonly string[],
  expectedRegister: readonly string[],
): Promise<void> {
  const opened = open(source, id);
  const plan = prepareVimDirectChange({
    snapshot: opened,
    key: keys.replace(/^\d+/u, '') as 'x' | 'X' | 'D' | '~',
    cursorOffset: toOffset(cursor),
    count: Number.parseInt(keys, 10) || 1,
    state,
  });
  assert.equal(plan.ok, true, `${id} planner accepts the direct command`);
  if (!plan.ok) return;
  assert.equal(apply(opened, plan.value.transaction?.edits ?? []), expectedLines.join('\n'), `${id} Xi text matches expected result`);
  assert.deepEqual(plan.value.registerEffect?.lines ?? [], expectedRegister, `${id} register payload is retained by the direct plan`);
  assert.equal(plan.value.registerEffect?.type ?? 'v', 'v', `${id} characterwise register metadata is explicit`);

  const oracle = await verifyOracleBundle();
  const expected = await runOracleFixture({
    id,
    title: id,
    purpose: 'Audit direct Normal-mode command parity against pinned Neovim.',
    modes: ['normal'],
    lines: [source],
    cursor: { line: 1, byteColumn0: cursor },
    steps: [{ label: 'after', keys, drain: true }],
  }, oracle.binaryPath);
  const snapshot = expected.snapshots[0];
  assert.ok(snapshot, `${id} oracle snapshot exists`);
  if (snapshot === undefined) return;
  assert.deepEqual(snapshot.lines, expectedLines, `${id} pinned Neovim text is retained`);
  const register = snapshot.registers['"'];
  const registerRecord = typeof register === 'object' && register !== null && !Array.isArray(register)
    ? register as { readonly type?: unknown; readonly lines?: unknown }
    : {};
  assert.equal(registerRecord.type ?? '', expectedRegister.length === 0 ? '' : 'v', `${id} pinned register type matches`);
  assert.deepEqual(registerRecord.lines ?? [], expectedRegister, `${id} pinned register payload matches`);
}

async function compareVirtualReplace(
  id: string,
  keys: string,
  source: string,
  cursor: number,
  expectedLines: readonly string[],
): Promise<void> {
  const opened = open(source, id);
  const countText = keys.match(/^\d+/u)?.[0] ?? '';
  const plan = prepareVimDirectChange({
    snapshot: opened,
    key: 'gr',
    cursorOffset: toOffset(cursor),
    count: Number.parseInt(countText, 10) || 1,
    replacement: 'X',
    state,
  });
  assert.equal(plan.ok, true, `${id} planner accepts virtual replace`);
  if (!plan.ok) return;
  assert.equal(apply(opened, plan.value.transaction?.edits ?? []), expectedLines.join('\n'), `${id} Xi text matches expected result`);
  assert.equal(plan.value.registerEffect, null, `${id} does not write a register`);

  const oracle = await verifyOracleBundle();
  const expected = await runOracleFixture({
    id, title: id, purpose: 'Audit virtual replace width preservation against pinned Neovim.', modes: ['normal'],
    lines: [source], cursor: { line: 1, byteColumn0: cursor },
    steps: [{ label: 'after', keys, drain: true }],
  }, oracle.binaryPath);
  assert.deepEqual(expected.snapshots[0]?.lines, expectedLines, `${id} pinned Neovim text is retained`);
}

function checkNoTargetBoundaries(): void {
  const empty = open('', 'T061-empty');
  for (const key of ['x', 'X', 'D', '~'] as const) {
    const result = prepareVimDirectChange({ snapshot: empty, key, cursorOffset: toOffset(0), state });
    assert.equal(result.ok, true, `T061-DIRECT-BOUNDARY-01 ${key} on an empty line is a valid no-op`);
    if (result.ok) {
      assert.equal(result.value.transaction, null, `T061-DIRECT-BOUNDARY-02 ${key} has no empty transaction`);
      assert.equal(result.value.mode, 'normal', `T061-DIRECT-BOUNDARY-03 ${key} remains Normal`);
      assert.equal(result.value.registerEffect, null, `T061-DIRECT-BOUNDARY-04 ${key} does not write a register`);
    }
  }
  const before = prepareVimDirectChange({ snapshot: open('abc', 'T061-x-boundary'), key: 'x', cursorOffset: toOffset(0), count: 1, state });
  assert.equal(before.ok, true, 'T061-DIRECT-BOUNDARY-05 forward delete at line start remains valid');
  const after = prepareVimDirectChange({ snapshot: open('abc', 'T061-X-boundary'), key: 'X', cursorOffset: toOffset(0), count: 1, state });
  assert.equal(after.ok, true, 'T061-DIRECT-BOUNDARY-06 backward delete at line start is a no-op');
  if (after.ok) assert.equal(after.value.transaction, null);
}

async function checkRot13Transform(): Promise<void> {
  const snapshot = open('Hello, 世界!', 'T061-rot13');
  const range = normalizeVimOperatorRange(snapshot, {
    origin: { documentVersion: snapshot.version, offset: toOffset(0) },
    target: { documentVersion: snapshot.version, offset: toOffset(8) },
    direction: 'forward', motionKind: 'characterwise', inclusive: true, motionKey: 'g?', operator: 'change',
  });
  assert.equal(range.ok, true, 'T061-ROT13-01 range normalizes');
  if (!range.ok) return;
  const plan = prepareVimTextTransform({ snapshot, range: range.value, operator: 'g?' });
  assert.equal(plan.ok, true, 'T061-ROT13-02 g? prepares a pure text transaction');
  if (plan.ok) {
    assert.equal(apply(snapshot, plan.value.transaction?.edits ?? []), 'Uryyb, 世界!', 'T061-ROT13-03 ASCII letters rotate and Unicode is preserved');
    assert.equal(plan.value.registerEffect, null, 'T061-ROT13-04 g? does not write a delete register');
  }
  const oracle = await verifyOracleBundle();
  const traced = await runOracleFixture({
    id: 'T061-ROT13-ORACLE-01', title: 'g?g?', purpose: 'Pin built-in ROT13 operator behavior.', modes: ['normal'],
    lines: ['Hello, 世界!'], cursor: { line: 1, byteColumn0: 0 },
    steps: [{ label: 'after', keys: 'g?g?', drain: true }],
  }, oracle.binaryPath);
  assert.deepEqual(traced.snapshots[0]?.lines, ['Uryyb, 世界!'], 'T061-ROT13-05 g?g? matches pinned Neovim');
}

function open(source: string, id: string): DocumentSnapshot {
  const documentId = asIdentifier<DocumentId>(id, 'documentId');
  assert.equal(documentId.ok, true, 'T061-DIRECT-OWNER-01 fixture ID is valid');
  if (!documentId.ok) throw new Error('invalid document ID');
  const opened = openTextDocument(documentId.value, new TextEncoder().encode(source));
  assert.equal(opened.kind, 'editable', 'T061-DIRECT-OWNER-02 fixture opens as editable');
  if (opened.kind !== 'editable') throw new Error('fixture did not open');
  return opened.document.snapshot();
}

function toOffset(value: number): Utf16Offset {
  const offset = asUtf16Offset(value);
  assert.equal(offset.ok, true, 'T061-DIRECT-COORDINATE-01 offset is safe');
  if (!offset.ok) throw new Error('invalid offset');
  return offset.value;
}

function apply(snapshot: DocumentSnapshot, edits: readonly DocumentEdit[]): string {
  const source = snapshot.slice(toOffset(0), toOffset(snapshot.lengthUtf16));
  assert.equal(source.ok, true, 'T061-DIRECT-OWNER-03 source is readable');
  if (!source.ok) throw new Error('source is unavailable');
  return [...edits].sort((left, right) => (right.start as number) - (left.start as number))
    .reduce((value, edit) => `${value.slice(0, edit.start as number)}${edit.text}${value.slice(edit.end as number)}`, source.value);
}
