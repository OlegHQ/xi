import {
  LanguageDocumentSync,
  offsetToPosition,
  positionToOffset,
  type LanguageSyncDocument,
  type LspRange,
} from '../../packages/services/language';
import { TextFileDocument, type PositionEncoding } from '../../packages/document/src/index';
import { asIdentifier, asUndoGroupId, type DocumentId } from '../../packages/primitives/src/index';

type JsonRecord = Record<string, unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

class FakePeer {
  text = '';
  version = 0;
  readonly messages: JsonRecord[] = [];
  constructor(private readonly encoding: PositionEncoding) {}

  apply(message: JsonRecord): void {
    this.messages.push(message);
    if (message.method === 'textDocument/didOpen') {
      const params = message.params as JsonRecord;
      const document = params.textDocument as JsonRecord;
      this.text = String(document.text);
      this.version = Number(document.version);
      return;
    }
    if (message.method === 'textDocument/didChange') {
      const params = message.params as JsonRecord;
      const document = params.textDocument as JsonRecord;
      const changes = params.contentChanges as readonly JsonRecord[];
      for (const raw of changes) {
        const text = String(raw.text);
        const range = raw.range as LspRange | undefined;
        if (range === undefined) {
          this.text = text;
          continue;
        }
        const start = positionToOffset(this.text, range.start, this.encoding);
        const end = positionToOffset(this.text, range.end, this.encoding);
        assert(start.ok && end.ok, 'fake peer receives valid encoded range');
        this.text = this.text.slice(0, start.value) + text + this.text.slice(end.value);
      }
      this.version = Number(document.version);
      return;
    }
    if (message.method === 'textDocument/didClose') return;
    throw new Error(`unexpected LSP notification ${String(message.method)}`);
  }
}

class FakeTransport {
  constructor(readonly peer: FakePeer) {}
  async notify(method: string, params?: unknown): Promise<void> {
    this.peer.apply({ method, params });
  }
}

function document(version: number, text: string): LanguageSyncDocument {
  return { uri: 'file:///workspace/main.ts', languageId: 'typescript', version, text };
}

function utf16OffsetAtScalar(text: string, scalarIndex: number): number {
  return [...text].slice(0, scalarIndex).join('').length;
}

async function testRandomizedStream(encoding: PositionEncoding): Promise<void> {
  const peer = new FakePeer(encoding);
  const transport = new FakeTransport(peer);
  const sync = new LanguageDocumentSync({ transport, capabilities: { positionEncoding: encoding, textDocumentSync: { change: 2, openClose: true } } });
  let text = '😀 alpha\né beta\n東京';
  const idResult = asIdentifier<DocumentId>(`T048-${encoding}`, 'documentId');
  assert(idResult.ok, 'document fixture has a valid ID');
  const documentResult = TextFileDocument.create(idResult.value, text, ['lf', 'lf'], 'lf');
  assert(documentResult.ok, 'committed document fixture opens');
  const source = documentResult.value;
  const group = asUndoGroupId(`t048-${encoding}`);
  assert(group.ok, 'document fixture has an undo group');
  const committedFailures: unknown[] = [];
  source.subscribeChanges((change) => {
    const accepted = sync.acceptChange(change, 'file:///workspace/main.ts');
    if (!accepted.ok) committedFailures.push(accepted.error);
  });
  const opened = await sync.openDocument(document(1, text));
  assert(opened.ok, `${encoding} didOpen accepted`);
  await sync.whenIdle();
  for (let index = 0; index < 40; index += 1) {
    const scalars = [...text];
    const scalarIndex = (index * 7 + 3) % (scalars.length + 1);
    const offset = utf16OffsetAtScalar(text, scalarIndex);
    const replacement = index % 4 === 0 ? '🚀' : index % 4 === 1 ? 'λ' : index % 4 === 2 ? 'x' : '字';
    text = text.slice(0, offset) + replacement + text.slice(offset);
    const committed = source.commit({
      documentId: source.id,
      expectedVersion: source.version,
      edits: [{ start: offset as never, end: offset as never, text: replacement }],
      origin: 'vim',
      undoGroup: group.value,
    });
    assert(committed.ok && committed.value.kind === 'committed', `${encoding} randomized edit ${index} committed: ${committed.ok ? committed.value.kind : committed.error.kind}`);
    // Every fourth batch is deliberately left pending so coalescing is exercised.
    if (index % 4 === 3) await sync.whenIdle();
  }
  await sync.whenIdle();
  assert(committedFailures.length === 0, `${encoding} committed stream contains no stale admissions`);
  equal(peer.text, text, `${encoding} fake peer converges to Xi after randomized edits`);
  equal(peer.version, 41, `${encoding} peer reaches final committed version`);
  const closed = await sync.closeDocument('file:///workspace/main.ts');
  assert(closed.ok, `${encoding} close succeeds`);
  equal(peer.messages.at(-1)?.method, 'textDocument/didClose', `${encoding} didClose is last`);
  assert(peer.messages.findIndex((message) => message.method === 'textDocument/didOpen') < peer.messages.findIndex((message) => message.method === 'textDocument/didChange'), `${encoding} didOpen precedes didChange`);
}

async function testFullSyncAndQueueBound(): Promise<void> {
  const peer = new FakePeer('utf-16');
  const transport = new FakeTransport(peer);
  const sync = new LanguageDocumentSync({ transport, capabilities: { positionEncoding: 'utf-16', textDocumentSync: 1 }, maxQueuedChanges: 2 });
  const opened = await sync.openDocument(document(1, 'base😀'));
  assert(opened.ok, 'full-sync didOpen accepted');
  await sync.whenIdle();
  for (let version = 2; version <= 30; version += 1) {
    const accepted = sync.acceptSnapshot(document(version, `${version}-base😀`));
    assert(accepted.ok, `full-sync edit ${version} admitted`);
  }
  await sync.whenIdle();
  equal(peer.text, '30-base😀', 'full-sync peer receives newest bounded target');
  equal(peer.version, 30, 'full-sync version skips only coalesced intermediate notifications');
  const changes = peer.messages.filter((message) => message.method === 'textDocument/didChange');
  assert(changes.every((message) => Array.isArray((message.params as JsonRecord).contentChanges)
    && ((message.params as JsonRecord).contentChanges as readonly JsonRecord[]).every((change) => change.range === undefined)), 'full sync emits snapshots without ranges');

  const limited = new LanguageDocumentSync({ transport, capabilities: { positionEncoding: 'utf-16', textDocumentSync: 1 }, maxFullSyncUtf16: 4 });
  const oversized = await limited.openDocument(document(1, '12345'));
  assert(!oversized.ok && oversized.error.kind === 'document-too-large', 'full-sync open enforces the documented size bound');
}

async function testStaleCloseAndAstralGuards(): Promise<void> {
  const peer = new FakePeer('utf-16');
  const sync = new LanguageDocumentSync({ transport: new FakeTransport(peer), capabilities: { positionEncoding: 'utf-16', textDocumentSync: { change: 2 } } });
  const opened = await sync.openDocument(document(1, 'a😀b'));
  assert(opened.ok, 'guard fixture opened');
  await sync.whenIdle();
  const stale = sync.acceptSnapshot(document(3, 'stale'));
  assert(!stale.ok && stale.error.kind === 'stale-version', 'version jump is rejected');
  const rangeStart = offsetToPosition('a😀b', 3, 'utf-16');
  equal(rangeStart.character, 3, 'UTF-16 astral column counts surrogate code units');
  const range32 = offsetToPosition('a😀b', 3, 'utf-32');
  equal(range32.character, 2, 'UTF-32 astral column counts scalar values');
  const pending = sync.acceptSnapshot(document(2, 'a😀b!'));
  assert(pending.ok, 'change before close admitted');
  const close = sync.closeDocument('file:///workspace/main.ts');
  const closed = await close;
  assert(closed.ok, 'close during pending change succeeds');
  const afterClose = sync.acceptSnapshot(document(3, 'after-close'));
  assert(!afterClose.ok && afterClose.error.kind === 'closed-document', 'post-close stale change is rejected');
  const methods = peer.messages.map((message) => message.method);
  const openIndex = methods.indexOf('textDocument/didOpen');
  const changeIndex = methods.indexOf('textDocument/didChange');
  const closeIndex = methods.indexOf('textDocument/didClose');
  assert(openIndex >= 0 && changeIndex > openIndex && closeIndex > changeIndex, 'close during change preserves open/change/close order');
}

async function testRestartReplaysLatestCommittedSnapshot(): Promise<void> {
  const firstPeer = new FakePeer('utf-16');
  const first = new LanguageDocumentSync({ transport: new FakeTransport(firstPeer), capabilities: { positionEncoding: 'utf-16', textDocumentSync: { change: 2 } } });
  const initial = document(1, 'before😀');
  const opened = await first.openDocument(initial);
  assert(opened.ok, 'restart fixture opens the first server');
  await first.whenIdle();
  const changed = first.acceptSnapshot(document(2, 'after😀'));
  assert(changed.ok, 'restart fixture admits the edit before server failure');
  await first.whenIdle();

  // A replacement transport has no old baseline. Lifecycle replay therefore
  // opens the latest committed snapshot exactly once and never replays stale
  // didChange ranges against the new server.
  const replacementPeer = new FakePeer('utf-16');
  const replacement = new LanguageDocumentSync({ transport: new FakeTransport(replacementPeer), capabilities: { positionEncoding: 'utf-16', textDocumentSync: { change: 2 } } });
  const replayed = await replacement.openDocument(document(2, 'after😀'));
  assert(replayed.ok, 'replacement server accepts latest replay snapshot');
  await replacement.whenIdle();
  equal(replacementPeer.text, 'after😀', 'replacement server starts from latest committed text');
  equal(replacementPeer.messages.map((message) => message.method).join(','), 'textDocument/didOpen', 'replacement replay has one didOpen and no stale change');
}

await testRandomizedStream('utf-8');
await testRandomizedStream('utf-16');
await testRandomizedStream('utf-32');
await testFullSyncAndQueueBound();
await testStaleCloseAndAstralGuards();
await testRestartReplaysLatestCommittedSnapshot();
console.log('T048 language sync passed randomized UTF-8/16/32 convergence, full-sync queue coalescing, version guards, astral ranges, restart replay and close ordering');
