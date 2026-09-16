import {
  CancellationSource,
  type ClockPort,
  type Disposable,
  type PlatformFailure,
  type ProcessHandle,
  type ProcessInput,
  type ProcessPort,
  type ProcessSpec,
  type Result,
} from '../../packages/contracts/src/index';
import { ContentLengthFrameDecoder, encodeContentLengthFrame } from '../../packages/services/language/framing';
import { DiagnosticStore, LanguageServerSession } from '../../packages/services/language';
import type { LanguageServerConfig } from '../../packages/services/config';

type JsonRecord = Record<string, unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate: () => boolean, message: string, timeoutMilliseconds = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

class ByteQueue implements AsyncIterable<Uint8Array> {
  readonly #values: Uint8Array[] = [];
  readonly #readers: ((result: IteratorResult<Uint8Array>) => void)[] = [];
  #closed = false;

  async push(value: Uint8Array): Promise<void> {
    if (this.#closed) return;
    const reader = this.#readers.shift();
    if (reader === undefined) this.#values.push(value);
    else reader({ done: false, value });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const reader of this.#readers.splice(0)) reader({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> { return { next: () => this.next() }; }

  private async next(): Promise<IteratorResult<Uint8Array>> {
    const value = this.#values.shift();
    if (value !== undefined) return { done: false, value };
    if (this.#closed) return { done: true, value: undefined };
    return new Promise((resolve) => this.#readers.push(resolve));
  }
}

class FakeLanguageProcess implements ProcessHandle {
  readonly stdoutQueue = new ByteQueue();
  readonly stderrQueue = new ByteQueue();
  readonly stdout = this.stdoutQueue;
  readonly stderr = this.stderrQueue;
  readonly stdin: ProcessInput;
  readonly exit: Promise<Result<{ readonly code: number | null; readonly signal: string | null }, PlatformFailure>>;
  #resolveExit!: (result: Result<{ readonly code: number | null; readonly signal: string | null }, PlatformFailure>) => void;
  #finished = false;

  constructor() {
    this.exit = new Promise((resolve) => { this.#resolveExit = resolve; });
    const decoder = new ContentLengthFrameDecoder();
    this.stdin = {
      write: async (bytes) => {
        for (const message of decoder.feed(bytes)) {
          if (message === null || typeof message !== 'object' || Array.isArray(message)) continue;
          const record = message as JsonRecord;
          if (record.method === 'initialize' && Object.hasOwn(record, 'id')) {
            await this.send({ jsonrpc: '2.0', id: record.id, result: { capabilities: {} } });
          }
        }
        return { ok: true, value: undefined };
      },
      close: async () => ({ ok: true, value: undefined }),
      dispose() {},
    };
  }

  async send(message: JsonRecord): Promise<void> {
    await this.stdoutQueue.push(encodeContentLengthFrame(new TextEncoder().encode(JSON.stringify(message))));
  }

  async terminate(_forceAfterMilliseconds: number): Promise<void> { this.finish(); }

  dispose(): void { this.finish(); }

  private finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.stdoutQueue.close();
    this.stderrQueue.close();
    this.#resolveExit({ ok: true, value: { code: 0, signal: null } });
  }
}

class FakeProcessPort implements ProcessPort {
  readonly processes: FakeLanguageProcess[] = [];

  async spawn(_spec: ProcessSpec): Promise<Result<ProcessHandle, PlatformFailure>> {
    const process = new FakeLanguageProcess();
    this.processes.push(process);
    return { ok: true, value: process };
  }
}

class FakeClock implements ClockPort {
  now = 0;
  monotonicMilliseconds(): number { return this.now; }
  schedule(_delayMilliseconds: number, callback: () => void): Disposable { callback(); return { dispose() {} }; }
  async sleep(delayMilliseconds: number, cancellation: CancellationSource['token']): Promise<Result<void, { readonly kind: 'cancelled' }>> {
    this.now += delayMilliseconds;
    return cancellation.isCancelled ? { ok: false, error: { kind: 'cancelled' } } : { ok: true, value: undefined };
  }
}

const config: LanguageServerConfig = Object.freeze({ name: 'fake', command: 'fake-lsp', args: [], rootMarkers: [] });
const uri = 'file:///workspace/main.ts';

const store = new DiagnosticStore();
const processPort = new FakeProcessPort();
const session = new LanguageServerSession({
  process: processPort,
  clock: new FakeClock(),
  config,
  root: '/workspace',
  workspaceId: 'workspace-a',
  retry: { maxRetries: 0 },
  diagnostics: store,
});

assert(session.openDocument({ uri, languageId: 'typescript', version: 4, text: 'const value = 1;\n' }).ok, 'T049-E07 document admission');
const ready = await session.waitForReady();
assert(ready.ok, 'T049-E07 production language session starts');
const process = processPort.processes[0];
assert(process !== undefined, 'T049-E07 production process exists');

await process.send({
  jsonrpc: '2.0',
  method: 'textDocument/publishDiagnostics',
  params: {
    uri,
    version: 4,
    diagnostics: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, message: 'unused value', severity: 2, source: 'fake-ts', code: 6133 }],
  },
});
await waitFor(() => store.model.all.length === 1, 'T049-E07 production push notification was not stored');
assert(store.model.all[0]?.message === 'unused value', 'T049-E07 decoded diagnostic message');
assert(store.model.all[0]?.documentVersion === 4, 'T049-E07 decoded document version');

await process.send({
  jsonrpc: '2.0',
  method: 'textDocument/publishDiagnostics',
  params: { uri, version: 3, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'late' }] },
});
await new Promise<void>((resolve) => setTimeout(resolve, 5));
assert(store.model.all[0]?.message === 'unused value', 'T049-E07 stale push notification rejected');

assert(session.openDocument({ uri, languageId: 'typescript', version: 5, text: 'const value = 2;\n' }).ok, 'T049-E07 newer document admitted');
await process.send({
  jsonrpc: '2.0',
  method: 'textDocument/publishDiagnostics',
  params: { uri, version: 5, diagnostics: [] },
});
await waitFor(() => store.model.all.length === 0, 'T049-E07 current empty diagnostic publish clears prior results');

await process.send({
  jsonrpc: '2.0',
  method: 'textDocument/publishDiagnostics',
  params: { uri, version: 5, diagnostics: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, message: 'zero width' }] },
});
await waitFor(() => store.model.all.length === 1, 'T049-E07 second push notification was not stored');
assert(session.closeDocument(uri).ok, 'T049-E07 document close');
assert(store.model.all.length === 0, 'T049-E07 close clears diagnostics');
await session.dispose();
assert(store.model.all.length === 0, 'T049-E07 session shutdown leaves no diagnostics');
store.dispose();
console.log('T049 production push diagnostics passed validated protocol delivery, version rejection, replacement and close cleanup');
