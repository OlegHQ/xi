// F1-3 regression: `LanguageDocumentSync#flushState` cleared `state.pending`/`state.pendingBytes`
// up front and, on a genuine transport failure (the `textDocument/didChange` notify() call
// itself throwing -- e.g. a dropped pipe), the catch block returned without restoring them or
// setting `resyncNeeded`. The edits in that batch were silently dropped: the server never saw
// them and nothing scheduled a resync, so it stayed stale until an unrelated future edit
// happened to trigger another flush. This test asserts the edit is not lost: after one notify()
// failure, the automatic resync retry must still deliver the fully-converged text.
import { LanguageDocumentSync, type LanguageSyncDocument } from '../../packages/services/language';
import { TextFileDocument } from '../../packages/document/src/index';
import { asIdentifier, asUndoGroupId, type DocumentId } from '../../packages/primitives/src/index';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type JsonRecord = Record<string, unknown>;

class FlakyTransport {
  readonly messages: JsonRecord[] = [];
  #didChangeFailuresRemaining: number;
  constructor(didChangeFailures: number) { this.#didChangeFailuresRemaining = didChangeFailures; }
  async notify(method: string, params?: unknown): Promise<void> {
    if (method === 'textDocument/didChange' && this.#didChangeFailuresRemaining > 0) {
      this.#didChangeFailuresRemaining -= 1;
      throw new Error('injected transport failure');
    }
    this.messages.push({ method, params });
  }
}

function document(version: number, text: string): LanguageSyncDocument {
  return { uri: 'file:///workspace/transport-retry.ts', languageId: 'typescript', version, text };
}

async function main(): Promise<void> {
  const transport = new FlakyTransport(1);
  const sync = new LanguageDocumentSync({ transport, capabilities: { positionEncoding: 'utf-16', textDocumentSync: { change: 2, openClose: true } } });
  const idResult = asIdentifier<DocumentId>('sync-transport-retry', 'documentId');
  assert(idResult.ok, 'fixture document id is valid');
  const created = TextFileDocument.create(idResult.value, 'ab', [], 'lf');
  assert(created.ok, 'source document opens');
  const source = created.value;
  const group = asUndoGroupId('sync-transport-retry');
  assert(group.ok, 'fixture has an undo group');

  const opened = await sync.openDocument(document(1, 'ab'));
  assert(opened.ok, 'didOpen accepted');
  await sync.whenIdle();
  assert(transport.messages.length === 1, 'only didOpen sent so far');

  const outcome = source.commit({
    documentId: source.id,
    expectedVersion: source.version,
    edits: [{ start: 2 as never, end: 2 as never, text: 'x' }],
    origin: 'vim',
    undoGroup: group.value,
  });
  assert(outcome.ok && outcome.value.kind === 'committed', 'source commit succeeds');
  if (!outcome.ok || outcome.value.kind !== 'committed') return;

  const accepted = sync.acceptChange(outcome.value.change, 'file:///workspace/transport-retry.ts');
  assert(accepted.ok, 'valid change is admitted');
  // The flush is deferred behind a macrotask; give it a turn, then let the queue drain (the
  // first attempt throws, the catch block must requeue a retry that this same drain picks up).
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await sync.whenIdle();
  // A retry enqueued from inside a running queue operation is itself asynchronous; give it one
  // more drain to be certain it has actually run (belt-and-suspenders, not a hang risk: whenIdle
  // resolves immediately once the queue is empty either way).
  await sync.whenIdle();

  const changeMessages = transport.messages.filter((message) => message.method === 'textDocument/didChange');
  assert(changeMessages.length === 1, `F1-3a exactly one didChange eventually lands after the injected failure, got ${changeMessages.length}`);
  const params = changeMessages[0]?.params as JsonRecord;
  const contentChanges = params.contentChanges as readonly JsonRecord[];
  assert(
    contentChanges.length === 1 && contentChanges[0]?.text === 'abx',
    `F1-3b the edit dropped by the failed attempt must still reach the server via the automatic retry, got ${JSON.stringify(contentChanges)}`,
  );

  console.log('F1-3 sync-transport-failure-retry: PASS');
}

await main();
