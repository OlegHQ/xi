// Regression coverage for two sync.ts fixes:
//  - the well-formedness check (isWellFormed) rejects lone surrogates without
//    building a per-code-point array of the whole document;
//  - a flush failure that leaves `resyncNeeded` set schedules an automatic
//    retry instead of stalling until the next unrelated edit.
import {
  LanguageDocumentSync,
  type LanguageSyncDocument,
} from '../../packages/services/language';
import { TextFileDocument } from '../../packages/document/src/index';
import type { CommittedDocumentChange } from '../../packages/document/src/index';
import { asIdentifier, asUndoGroupId, type DocumentId } from '../../packages/primitives/src/index';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type JsonRecord = Record<string, unknown>;

class FakeTransport {
  readonly messages: JsonRecord[] = [];
  async notify(method: string, params?: unknown): Promise<void> {
    this.messages.push({ method, params });
  }
}

function document(version: number, text: string): LanguageSyncDocument {
  return { uri: 'file:///workspace/resilience.ts', languageId: 'typescript', version, text };
}

async function testLoneSurrogateRejectedWithoutArrayScan(): Promise<void> {
  const sync = new LanguageDocumentSync({ transport: new FakeTransport() });
  const opened = await sync.openDocument(document(1, `a${String.fromCharCode(0xd800)}b`));
  assert(!opened.ok, 'a lone high surrogate is rejected');
  if (!opened.ok) assert(opened.error.kind === 'invalid-document', `expected invalid-document, got ${opened.error.kind}`);

  const wellFormed = await sync.openDocument(document(1, 'aéb\u{1f600}c'));
  assert(wellFormed.ok, 'well-formed BMP and astral text is accepted');
}

async function testFailedFlushSchedulesAutomaticRetry(): Promise<void> {
  const transport = new FakeTransport();
  const sync = new LanguageDocumentSync({ transport, capabilities: { positionEncoding: 'utf-16', textDocumentSync: { change: 2, openClose: true } } });
  const idResult = asIdentifier<DocumentId>('sync-resilience', 'documentId');
  assert(idResult.ok, 'document fixture has a valid id');
  const created = TextFileDocument.create(idResult.value, 'ab', [], 'lf');
  assert(created.ok, 'source document opens');
  const source = created.value;
  const group = asUndoGroupId('sync-resilience');
  assert(group.ok, 'fixture has an undo group');

  const opened = await sync.openDocument(document(1, 'ab'));
  assert(opened.ok, 'didOpen accepted');
  await sync.whenIdle();
  assert(transport.messages.length === 1, 'only didOpen sent so far');

  // Produce a genuinely valid next-version change, then corrupt only its edit
  // coordinates (out of range against the acknowledged baseline) so
  // incrementalChanges fails with 'unsupported-position'. The snapshot itself
  // stays valid, so the automatic resync retry can still materialize it.
  const outcome = source.commit({
    documentId: source.id,
    expectedVersion: source.version,
    edits: [{ start: 2 as never, end: 2 as never, text: 'x' }],
    origin: 'vim',
    undoGroup: group.value,
  });
  assert(outcome.ok && outcome.value.kind === 'committed', 'source commit succeeds');
  if (!outcome.ok || outcome.value.kind !== 'committed') return;
  const realChange = outcome.value.change;
  const corrupted: CommittedDocumentChange = {
    ...realChange,
    edits: Object.freeze([{ start: 999 as never, end: 999 as never, text: 'x' }]),
  };

  const accepted = sync.acceptChange(corrupted, 'file:///workspace/resilience.ts');
  assert(accepted.ok, 'malformed-edit change is admitted (validated only by version, not by coordinates)');
  await sync.whenIdle();

  // Without any further edit, the failed incremental flush must have
  // scheduled and completed a full-text resync on its own.
  const changeMessages = transport.messages.filter((message) => message.method === 'textDocument/didChange');
  assert(changeMessages.length === 1, `exactly one didChange is sent by the automatic retry, got ${changeMessages.length}`);
  const params = changeMessages[0]?.params as JsonRecord;
  const contentChanges = params.contentChanges as readonly JsonRecord[];
  assert(contentChanges.length === 1 && contentChanges[0]?.range === undefined, 'the retry sends a full-document resync, not a range edit');
  assert(contentChanges[0]?.text === 'abx', `retry resync carries the correct converged text, got ${String(contentChanges[0]?.text)}`);
}

await testLoneSurrogateRejectedWithoutArrayScan();
await testFailedFlushSchedulesAutomaticRetry();
console.log('sync-resilience passed lone-surrogate rejection and automatic resync retry fixtures');
