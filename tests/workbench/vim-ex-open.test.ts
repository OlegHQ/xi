import { strict as assert } from 'node:assert';
import { TextFileDocument } from '../../packages/document/src/index';
import type { DocumentId, UndoGroupId, Utf16Offset, ViewId } from '../../packages/primitives/src/index';
import { createOwnedVimSession } from '../../packages/workbench/vim-session';

const opened = TextFileDocument.create('ex-open-document' as DocumentId, 'text\n', ['lf'], 'lf');
assert.ok(opened.ok);
const document = opened.value;
const targets: string[] = [];
const messages: string[] = [];
const session = createOwnedVimSession(document, {
  viewId: 'ex-open-view' as ViewId,
  onHostCommand: command => { if (command.kind === 'open-file') targets.push(command.target); },
  onMessage: message => messages.push(message),
});

await session.submitCommandLine(':e next.txt');
assert.deepEqual(targets, ['next.txt'], 'EX-OPEN-01 parsed :e dispatches the file-open effect');
const changed = document.commit({ documentId: document.id, expectedVersion: document.version,
  edits: [{ start: 0 as Utf16Offset, end: 0 as Utf16Offset, text: 'X' }], origin: 'vim', undoGroup: 'ex-open-edit' as UndoGroupId });
assert.ok(changed.ok);
await session.submitCommandLine(':edit blocked.txt');
assert.deepEqual(targets, ['next.txt'], 'EX-OPEN-02 dirty :edit does not abandon the current buffer');
assert.ok(messages.some(message => message.includes('unsaved changes')));
await session.submitCommandLine(':edit! allowed.txt');
assert.deepEqual(targets, ['next.txt', 'allowed.txt'], 'EX-OPEN-03 dirty :edit! opens another path while the host retains the hidden buffer');
assert.equal(document.isDirty, true, 'EX-OPEN-04 opening another path does not silently discard hidden-buffer edits');
session.dispose();
