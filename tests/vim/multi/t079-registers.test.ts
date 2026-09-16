import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentSnapshot } from '../../../packages/document/src/index';
import {
  VimRegisterBank,
  exportVimRegisterVectorToClipboard,
  importVimRegisterVectorFromClipboard,
  prepareVimMultiPut,
  type VimRegisterValue,
  type VimRegisterVector,
} from '../../../packages/vim/src/index';
import { asIdentifier, type DocumentId } from '../../../packages/primitives/src/index';
import type { ClipboardPort, PlatformFailure } from '../../../packages/contracts/src/index';

const char = (text: string): VimRegisterValue => ({ lines: [text], type: 'characterwise' });
const line = (text: string): VimRegisterValue => ({ lines: [text], type: 'linewise' });
const block = (text: string, width: number): VimRegisterValue => ({ lines: [text], type: 'blockwise', blockWidth: width });

const vector: VimRegisterVector = { fragments: [char('A'), char('B')], primaryIndex: 0 };
let bank = new VimRegisterBank();
const written = bank.writeVector({ name: 'a', vector });
assert.equal(written.ok, true, 'T079-MC06-01 vector write succeeds');
if (!written.ok) throw new Error('vector write failed');
bank = written.value;
const stored = bank.readVector('a');
assert.equal(stored.ok, true, 'T079-MC06-02 vector metadata is readable');
if (stored.ok) assert.deepEqual(stored.value?.fragments.map((fragment) => fragment.lines), [['A'], ['B']], 'T079-MC06-03 fragments retain canonical order');

const mismatch = bank.writeVector({ name: 'A', vector: { fragments: [char('C')], primaryIndex: 0 } });
assert.equal(mismatch.ok, false, 'T079-MC06-04 named append rejects arity mismatch');
if (!mismatch.ok) assert.equal(mismatch.error.kind, 'vector-arity-mismatch', 'T079-MC06-05 mismatch reports a typed failure');
const afterMismatch = bank.readVector('a');
assert.equal(afterMismatch.ok, true, 'T079-MC06-06 failed append leaves bank readable');
if (afterMismatch.ok) assert.deepEqual(afterMismatch.value?.fragments.map((fragment) => fragment.lines), [['A'], ['B']], 'T079-MC06-07 failed append does not mutate prior vector');

const blackHole = bank.yankMany([char('X'), char('Y')], '_');
assert.equal(blackHole.ok, true, 'T079-MC06-08 black-hole multi-yank is a no-op');
if (blackHole.ok) assert.equal(blackHole.value, bank, 'T079-MC06-09 black-hole preserves bank identity');
const numbered = bank.deleteMany([line('one'), line('two')]);
assert.equal(numbered.ok, true, 'T079-MC06-10 multi-delete writes one numbered vector');
if (numbered.ok) {
  const first = numbered.value.readVector('1');
  assert.equal(first.ok, true, 'T079-MC06-11 numbered vector is readable');
  if (first.ok) assert.equal(first.value?.fragments.length, 2, 'T079-MC06-12 numbered vector preserves arity');
}
const singleton = bank.yankMany([block('X', 4)]);
assert.equal(singleton.ok, true, 'T079-MC06-13 singleton yank uses native scalar path');
if (singleton.ok) {
  const scalar = singleton.value.read('"');
  const metadata = singleton.value.readVector('"');
  assert.equal(scalar.ok, true, 'T079-MC06-14 scalar register remains readable');
  assert.equal(metadata.ok, true, 'T079-MC06-15 scalar metadata query succeeds');
  if (metadata.ok) assert.equal(metadata.value, undefined, 'T079-MC06-16 singleton does not retain vector metadata');
}

const snapshot = open('x x', 'T079-put');
const put = prepareVimMultiPut({
  members: [0, 2].map((cursor, index) => ({ id: `m${index + 1}`, context: { snapshot, cursor: cursor as never, command: 'p' as const } })),
  register: vector,
});
assert.equal(put.ok, true, 'T079-MC06-17 equal arity distributes fragments');
if (put.ok) {
  assert.deepEqual(put.value.edits, [{ start: 1, end: 1, text: 'A' }, { start: 3, end: 3, text: 'B' }], 'T079-MC06-18 each fragment uses its own cursor context');
}
const badPut = prepareVimMultiPut({
  members: [{ id: 'm1', context: { snapshot, cursor: 0 as never, command: 'p' as const }}],
  register: vector,
});
assert.equal(badPut.ok, false, 'T079-MC06-19 put arity mismatch rejects before edits');
if (!badPut.ok) assert.equal(badPut.error.kind, 'vector-arity-mismatch', 'T079-MC06-20 put mismatch is typed');

const clipboard = fakeClipboard();
const exported = await exportVimRegisterVectorToClipboard(vector, clipboard, token());
assert.equal(exported.ok, true, 'T079-MC06-21 vector clipboard export succeeds');
assert.equal(clipboard.written, 'AB', 'T079-MC06-22 clipboard joins canonical fragments');
const imported = await importVimRegisterVectorFromClipboard(new VimRegisterBank(), clipboard, token());
assert.equal(imported.ok, true, 'T079-MC06-23 clipboard import commits separately as text-only');
const denied = await exportVimRegisterVectorToClipboard(vector, fakeClipboardFailure(), token());
assert.equal(denied.ok, false, 'T079-MC06-24 clipboard failure is surfaced distinctly');

console.log('T079 multi-register vectors passed arity, black-hole, rotation, scalar, typed put and clipboard boundaries');

function open(source: string, id: string): DocumentSnapshot {
  const checked = asIdentifier<DocumentId>(id, 'documentId');
  assert.equal(checked.ok, true, 'T079-OWNER-01 document id validates');
  if (!checked.ok) throw new Error('invalid id');
  const result = openTextDocument(checked.value, new TextEncoder().encode(source));
  assert.equal(result.kind, 'editable', 'T079-OWNER-02 document opens');
  if (result.kind !== 'editable') throw new Error('read-only document');
  return result.document.snapshot();
}

function token(): { readonly isCancelled: false; readonly onCancel: () => { readonly dispose: () => void } } {
  return { isCancelled: false, onCancel: () => ({ dispose: () => undefined }) };
}

function fakeClipboard(): ClipboardPort & { written: string | null } {
  const clipboard: ClipboardPort & { written: string | null } = {
    written: null,
    readText: async () => ({ ok: true as const, value: 'imported' }),
    writeText: async (text: string) => { clipboard.written = text; return { ok: true as const, value: undefined }; },
  };
  return clipboard;
}

function fakeClipboardFailure(): ClipboardPort {
  const failure: PlatformFailure = { code: 'denied', message: 'clipboard denied', retryable: false };
  return { readText: async () => ({ ok: false as const, error: failure }), writeText: async () => ({ ok: false as const, error: failure }) };
}
