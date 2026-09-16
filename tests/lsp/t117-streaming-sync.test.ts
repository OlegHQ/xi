#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import {
  LanguageDocumentSync,
  type LanguageSyncDocument,
  type LspRange,
} from '../../packages/services/language';
import { TextFileDocument, type DocumentSnapshot } from '../../packages/document/src/index';
import { asIdentifier, asUndoGroupId, asUtf16Offset, type DocumentId } from '../../packages/primitives/src/index';

interface Message { readonly method: string; readonly params: Record<string, unknown> | undefined; }

class BlockingTransport {
  readonly messages: Message[] = [];
  blocked = true;
  #release: (() => void) | undefined;

  async notify(method: string, params?: unknown): Promise<void> {
    if (method === 'textDocument/didChange' && this.blocked) {
      await new Promise<void>((resolve) => { this.#release = resolve; });
    }
    this.messages.push({ method, params: params as Record<string, unknown> | undefined });
  }

  release(): void {
    this.blocked = false;
    this.#release?.();
    this.#release = undefined;
  }
}

function document(version: number, text: string): LanguageSyncDocument {
  return { uri: 'file:///workspace/stream.ts', languageId: 'typescript', version, text };
}

function guarded(snapshot: DocumentSnapshot, reads: { full: number }): DocumentSnapshot {
  return Object.freeze({
    ...snapshot,
    slice(start: Parameters<DocumentSnapshot['slice']>[0], end: Parameters<DocumentSnapshot['slice']>[1]) {
      if ((start as number) === 0 && (end as number) === snapshot.lengthUtf16) reads.full += 1;
      return snapshot.slice(start, end);
    },
  });
}

const idResult = asIdentifier<DocumentId>('T117-streaming', 'documentId');
assert.equal(idResult.ok, true, 'T117-SETUP-01 document ID is valid');
if (!idResult.ok) throw new Error('invalid test document ID');
const groupResult = asUndoGroupId('T117-streaming-group');
assert.equal(groupResult.ok, true, 'T117-SETUP-02 undo group is valid');
if (!groupResult.ok) throw new Error('invalid test undo group');

const opened = TextFileDocument.create(idResult.value, 'alpha\n😀 beta\nomega', ['lf', 'lf'], 'lf');
assert.equal(opened.ok, true, 'T117-SETUP-03 source document opens');
if (!opened.ok) throw new Error('source document did not open');
const source = opened.value;
const transport = new BlockingTransport();
const reads = { full: 0 };
const sync = new LanguageDocumentSync({
  transport,
  capabilities: { positionEncoding: 'utf-16', textDocumentSync: { change: 2, openClose: true } },
  maxQueuedChanges: 8,
  maxQueuedBytes: 1_024,
});
const openedToPeer = await sync.openDocument(document(source.version as number, 'alpha\n😀 beta\nomega'));
assert.equal(openedToPeer.ok, true, 'T117-STREAM-01 didOpen succeeds');
await sync.whenIdle();

let acceptance: boolean | undefined;
source.subscribeChanges((change) => {
  const boundedChange = { ...change, snapshot: guarded(change.snapshot, reads) };
  const result = sync.acceptChange(boundedChange, 'file:///workspace/stream.ts');
  acceptance = result.ok;
});
const insertAt = asUtf16Offset(6);
assert.equal(insertAt.ok, true, 'T117-STREAM-02 insertion boundary is valid');
if (!insertAt.ok) throw new Error('invalid insertion boundary');
const firstCommit = source.commit({
  documentId: source.id,
  expectedVersion: source.version,
  edits: [{ start: insertAt.value, end: insertAt.value, text: 'λ' }],
  origin: 'vim',
  undoGroup: groupResult.value,
});
assert.equal(firstCommit.ok, true, 'T117-STREAM-03 source change commits');
assert.equal(acceptance, true, 'T117-STREAM-04 change admission does not read the complete after snapshot');
assert.equal(reads.full, 0, 'T117-STREAM-05 blocked change admission performs no full snapshot read');
assert.ok(sync.queuedBytes > 0 && sync.queuedBytes <= 1_024, 'T117-STREAM-06 queued replacement bytes stay bounded');

await Promise.resolve();
transport.release();
await sync.whenIdle();
const incremental = transport.messages.find((message) => message.method === 'textDocument/didChange');
assert.ok(incremental, 'T117-STREAM-07 incremental change is published');
if (incremental === undefined) throw new Error('missing incremental message');
const firstParams = incremental.params ?? {};
const changes = firstParams.contentChanges as readonly { readonly range?: LspRange; readonly text: string }[];
assert.equal(changes.length, 1, 'T117-STREAM-08 one local edit creates one LSP change');
assert.equal(changes[0]?.text, 'λ', 'T117-STREAM-09 replacement payload comes from the committed edit span');
assert.deepEqual(changes[0]?.range, { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, 'T117-STREAM-10 range uses document coordinates without flattening');

const overflowTransport = new BlockingTransport();
const overflowReads = { full: 0 };
const overflowSync = new LanguageDocumentSync({
  transport: overflowTransport,
  capabilities: { positionEncoding: 'utf-16', textDocumentSync: { change: 2, openClose: true } },
  maxQueuedChanges: 4,
  maxQueuedBytes: 8,
});
const overflowOpened = await overflowSync.openDocument(document(1, 'seed'));
assert.equal(overflowOpened.ok, true, 'T117-STREAM-11 overflow peer opens');
await overflowSync.whenIdle();
const overflowSourceResult = TextFileDocument.create(idResult.value + '-overflow' as DocumentId, 'seed', [], 'lf');
assert.equal(overflowSourceResult.ok, true, 'T117-STREAM-12 overflow source opens');
if (!overflowSourceResult.ok) throw new Error('overflow source did not open');
const overflowSource = overflowSourceResult.value;
overflowSource.subscribeChanges((change) => {
  overflowSync.acceptChange({ ...change, snapshot: guarded(change.snapshot, overflowReads) }, 'file:///workspace/stream.ts');
});
for (let index = 0; index < 20; index += 1) {
  const at = asUtf16Offset(overflowSource.snapshot().lengthUtf16);
  assert.equal(at.ok, true, `T117-STREAM-13 edit ${index} boundary is valid`);
  if (!at.ok) throw new Error('overflow boundary invalid');
  const committed = overflowSource.commit({
    documentId: overflowSource.id,
    expectedVersion: overflowSource.version,
    edits: [{ start: at.value, end: at.value, text: 'x' }],
    origin: 'vim',
    undoGroup: groupResult.value,
  });
  assert.equal(committed.ok, true, `T117-STREAM-14 edit ${index} commits`);
}
assert.ok(overflowSync.queuedBytes <= 8, 'T117-STREAM-15 overflow keeps only bounded pending payload bytes');
assert.equal(overflowReads.full, 0, 'T117-STREAM-16 queue overflow still avoids flattening on the input path');
overflowTransport.release();
await overflowSync.whenIdle();
assert.ok(overflowReads.full > 0, 'T117-STREAM-17 explicit resync materializes only in the queued operation');
const resync = overflowTransport.messages.find((message) => message.method === 'textDocument/didChange');
assert.ok(resync, 'T117-STREAM-18 overflow publishes a resync');
if (resync !== undefined) {
  const resyncChanges = (resync.params ?? {}).contentChanges as readonly { readonly range?: LspRange; readonly text: string }[];
  assert.equal(resyncChanges[0]?.range, undefined, 'T117-STREAM-19 resync is explicit full content');
  assert.equal(resyncChanges[0]?.text, 'seed'.concat('x'.repeat(20)), 'T117-STREAM-20 resync target is the newest immutable snapshot');
}
console.log('T117 streaming sync passed bounded edit admission, UTF-16 range mapping, queue-byte caps and explicit resync behavior');
