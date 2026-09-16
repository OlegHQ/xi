import assert from 'node:assert/strict';
import { CancellationSource, type ClockPort, type Disposable, type PlatformFailure, type ProcessHandle, type ProcessInput, type ProcessPort, type ProcessSpec, type Result } from '../../packages/contracts/src/index';
import { ContentLengthFrameDecoder, encodeContentLengthFrame } from '../../packages/services/language/framing';
import { DiagnosticStore, LanguageServerSession } from '../../packages/services/language';
import type { LanguageServerConfig } from '../../packages/services/config';

type JsonRecord = Record<string, unknown>;

class ByteQueue implements AsyncIterable<Uint8Array> {
  readonly #values: Uint8Array[] = [];
  readonly #readers: ((result: IteratorResult<Uint8Array>) => void)[] = [];
  #closed = false;
  async push(value: Uint8Array): Promise<void> { if (this.#closed) return; const reader = this.#readers.shift(); if (reader === undefined) this.#values.push(value); else reader({ done: false, value }); }
  close(): void { if (this.#closed) return; this.#closed = true; for (const reader of this.#readers.splice(0)) reader({ done: true, value: undefined }); }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> { return { next: () => this.next() }; }
  private async next(): Promise<IteratorResult<Uint8Array>> { const value = this.#values.shift(); if (value !== undefined) return { done: false, value }; if (this.#closed) return { done: true, value: undefined }; return new Promise((resolve) => this.#readers.push(resolve)); }
}

class FakePullProcess implements ProcessHandle {
  readonly stdoutQueue = new ByteQueue();
  readonly stderrQueue = new ByteQueue();
  readonly stdout = this.stdoutQueue;
  readonly stderr = this.stderrQueue;
  readonly writes: JsonRecord[] = [];
  readonly stdin: ProcessInput;
  readonly exit: Promise<Result<{ readonly code: number | null; readonly signal: string | null }, PlatformFailure>>;
  #resolveExit!: (result: Result<{ readonly code: number | null; readonly signal: string | null }, PlatformFailure>) => void;
  #finished = false;
  #documentPulls = 0;

  constructor() {
    this.exit = new Promise((resolve) => { this.#resolveExit = resolve; });
    const decoder = new ContentLengthFrameDecoder();
    this.stdin = {
      write: async (bytes) => {
        for (const message of decoder.feed(bytes)) {
          if (message === null || typeof message !== 'object' || Array.isArray(message)) continue;
          const record = message as JsonRecord;
          this.writes.push(record);
          this.handle(record);
        }
        return { ok: true, value: undefined };
      },
      close: async () => ({ ok: true, value: undefined }),
      dispose() {},
    };
  }

  async send(message: JsonRecord): Promise<void> { await this.stdoutQueue.push(encodeContentLengthFrame(new TextEncoder().encode(JSON.stringify(message)))); }
  async terminate(): Promise<void> { this.finish(); }
  dispose(): void { this.finish(); }

  private handle(message: JsonRecord): void {
    const method = message.method;
    const id = message.id;
    if (method === 'initialize' && Object.hasOwn(message, 'id')) {
      void this.send({ jsonrpc: '2.0', id, result: { capabilities: { diagnosticProvider: { workspaceDiagnostics: true } } } });
    } else if (method === 'textDocument/diagnostic' && Object.hasOwn(message, 'id')) {
      this.#documentPulls += 1;
      const params = message.params as JsonRecord;
      const textDocument = params.textDocument as JsonRecord;
      const previous = params.previousResultId;
      void this.send({ jsonrpc: '2.0', id, result: previous === 'doc-r1' ? { kind: 'unchanged', resultId: 'doc-r1' } : { kind: 'full', resultId: `doc-r${this.#documentPulls}`, items: [diagnostic(`${String(textDocument.uri)} current`)] } });
    } else if (method === 'workspace/diagnostic' && Object.hasOwn(message, 'id')) {
      const params = message.params as JsonRecord;
      const previous = Array.isArray(params.previousResultIds) ? params.previousResultIds : [];
      const items = previous.map((entry) => {
        const request = entry as JsonRecord;
        const uri = String(request.uri);
        const value = request.value;
        return value === `workspace-${uri}`
          ? { uri, kind: 'unchanged', resultId: value }
          : { uri, kind: 'full', resultId: `workspace-${uri}`, items: [diagnostic(`${uri} workspace`)] };
      });
      void this.send({ jsonrpc: '2.0', id, result: { items } });
    } else if (method === 'shutdown' && Object.hasOwn(message, 'id')) {
      void this.send({ jsonrpc: '2.0', id, result: null });
    } else if (method === 'exit') {
      this.finish();
    }
  }

  private finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.stdoutQueue.close();
    this.stderrQueue.close();
    this.#resolveExit({ ok: true, value: { code: 0, signal: null } });
  }
}

class FakePullProcessPort implements ProcessPort {
  readonly processes: FakePullProcess[] = [];
  async spawn(_spec: ProcessSpec): Promise<Result<ProcessHandle, PlatformFailure>> { const process = new FakePullProcess(); this.processes.push(process); return { ok: true, value: process }; }
}

class FakeClock implements ClockPort {
  monotonicMilliseconds(): number { return Date.now(); }
  schedule(_delayMilliseconds: number, callback: () => void): Disposable { const timer = setTimeout(callback, 0); return { dispose: () => clearTimeout(timer) }; }
  async sleep(_delayMilliseconds: number, cancellation: CancellationSource['token']): Promise<Result<void, { readonly kind: 'cancelled' }>> { return cancellation.isCancelled ? { ok: false, error: { kind: 'cancelled' } } : { ok: true, value: undefined }; }
}

function diagnostic(message: string): JsonRecord { return { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message, severity: 2, source: 'fake-pull' }; }
async function waitFor(predicate: () => boolean, message: string): Promise<void> { const deadline = Date.now() + 1_000; while (!predicate()) { if (Date.now() >= deadline) throw new Error(message); await new Promise<void>((resolve) => setTimeout(resolve, 1)); } }

const config: LanguageServerConfig = Object.freeze({ name: 'fake-pull', command: 'fake-pull-lsp', args: [], rootMarkers: [] });
const processPort = new FakePullProcessPort();
const diagnostics = new DiagnosticStore();
const session = new LanguageServerSession({ process: processPort, clock: new FakeClock(), config, root: '/workspace', workspaceId: 'pull-workspace', retry: { maxRetries: 0 }, diagnostics });
const firstUri = 'file:///workspace/first.ts';
const secondUri = 'file:///workspace/second.ts';
assert.equal(session.openDocument({ uri: firstUri, languageId: 'typescript', version: 1, text: 'const first = 1;\n' }).ok, true);
assert.equal(session.openDocument({ uri: secondUri, languageId: 'typescript', version: 1, text: 'const second = 2;\n' }).ok, true);
assert.equal((await session.waitForReady()).ok, true, 'T068-PTY-01 pull-capable server reaches ready');

const first = await session.refreshPullDiagnostics(firstUri);
assert.equal(first.ok, true, 'T068-PTY-01 document pull request uses the live JSON-RPC transport');
assert.equal(first.ok && first.value.resultId, 'doc-r1');
assert.equal(diagnostics.model.all.length, 1, 'T068-PTY-01 pull diagnostics enter the shared Problems owner');
const unchanged = await session.refreshPullDiagnostics(firstUri);
assert.equal(unchanged.ok, true, 'T068-RESULT-ID-02 unchanged server response is accepted');
assert.equal(unchanged.ok && unchanged.value.items[0]?.message, `${firstUri} current`, 'T068-RESULT-ID-02 unchanged response reuses the prior item');
assert.equal(diagnostics.model.all.length, 1, 'T068-RESULT-ID-02 pull refresh replaces the same server source without duplication');

const workspace = await session.refreshWorkspacePullDiagnostics();
assert.equal(workspace.ok, true, 'T068-WORKSPACE-02 workspace pull uses advertised workspace diagnostics');
assert.equal(diagnostics.model.all.length, 2, 'T068-WORKSPACE-02 workspace publication replaces both URI entries atomically');

const currentProcess = processPort.processes[0];
assert(currentProcess !== undefined, 'T068-PTY-01 fake process exists');
const workspacePullCount = currentProcess.writes.filter((message) => message.method === 'workspace/diagnostic').length;
await currentProcess.send({ jsonrpc: '2.0', id: 20, method: 'workspace/diagnostic/refresh', params: {} });
await waitFor(() => currentProcess.writes.some((message) => message.id === 20 && Object.hasOwn(message, 'result')), 'T068-CAP-REFRESH-01 server diagnostic refresh request was not answered');
assert.equal(currentProcess.writes.filter((message) => message.method === 'workspace/diagnostic').length, workspacePullCount + 1, 'T068-CAP-REFRESH-01 request handler refreshes negotiated diagnostics');
await currentProcess.send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: firstUri, version: 1, diagnostics: [diagnostic('push duplicate')] } });
await waitFor(() => diagnostics.diagnosticsFor(firstUri)[0]?.message === 'push duplicate', 'T068-SOURCE-01 push diagnostic was not delivered');
const afterPush = await session.refreshPullDiagnostics(firstUri);
assert.equal(afterPush.ok, true, 'T068-SOURCE-01 pull refresh remains available after push delivery');
assert.equal(diagnostics.diagnosticsFor(firstUri).length, 1, 'T068-SOURCE-01 push and pull share one per-server source instead of duplicating');

await session.restart();
assert.equal(diagnostics.model.all.length, 0, 'T068-RESTART-02 server restart clears old push/pull diagnostics');
assert.equal(session.health.state, 'ready', 'T068-RESTART-02 restarted session becomes ready again');
await session.dispose();
diagnostics.dispose();
console.log('T068 production pull PTY passed document/workspace requests, result-id reuse, unified source ownership and restart cleanup');
