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
import {
  ContentLengthFrameDecoder,
  encodeContentLengthFrame,
} from '../../packages/services/language/framing';
import {
  LanguageServerPool,
  LanguageServerSession,
  resolveLanguageRoot,
  type LanguageWorkspaceFolder,
} from '../../packages/services/language';
import { LanguageServerNavigationProvider, type NavigationRequest } from '../../packages/services/language/navigation';
import { LanguageServerCompletionProvider, type CompletionRequest } from '../../packages/services/language/completion';
import { LanguageServerSignatureProvider } from '../../packages/services/language/signature';
import { LanguageServerHierarchyProvider } from '../../packages/services/language/hierarchy';
import { LanguageServerWorkspaceEditProvider } from '../../packages/services/language/workspace-edits';
import type { LanguageServerConfig } from '../../packages/services/config';

type JsonRecord = Record<string, unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
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
    if (reader !== undefined) reader({ done: false, value });
    else this.#values.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const reader of this.#readers.splice(0)) reader({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return { next: () => this.next() };
  }

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
  readonly writes: unknown[] = [];
  readonly stdin: ProcessInput;
  readonly exit: Promise<Result<{ readonly code: number | null; readonly signal: string | null }, PlatformFailure>>;
  #resolveExit!: (result: Result<{ readonly code: number | null; readonly signal: string | null }, PlatformFailure>) => void;
  #finished = false;

  constructor(private readonly onMessage: (message: JsonRecord, process: FakeLanguageProcess) => void) {
    this.exit = new Promise((resolve) => { this.#resolveExit = resolve; });
    const decoder = new ContentLengthFrameDecoder();
    this.stdin = {
      write: async (bytes) => {
        for (const message of decoder.feed(bytes)) {
          if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
            this.writes.push(message);
            this.onMessage(message as JsonRecord, this);
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

  finish(code = 1): void {
    if (this.#finished) return;
    this.#finished = true;
    this.stdoutQueue.close();
    this.stderrQueue.close();
    this.#resolveExit({ ok: true, value: { code, signal: null } });
  }

  async terminate(): Promise<void> { this.finish(); }
  dispose(): void { this.finish(); }
}

class FakeLanguageProcessPort implements ProcessPort {
  readonly processes: FakeLanguageProcess[] = [];
  constructor(private readonly mode: 'ready' | 'unavailable' | 'crash' | 'spawn-retry', private readonly capabilities: unknown = { hoverProvider: true }) {}

  async spawn(_spec: ProcessSpec): Promise<Result<ProcessHandle, PlatformFailure>> {
    if (this.mode === 'unavailable') return { ok: false, error: { code: 'ENOENT', message: 'language server executable not found', retryable: false } };
    if (this.mode === 'spawn-retry' && this.processes.length < 100) return { ok: false, error: { code: 'EAGAIN', message: 'injected launch failure', retryable: true } };
    const process = new FakeLanguageProcess((message, active) => {
      if (message.method === 'initialize' && Object.hasOwn(message, 'id')) {
        void active.send({ jsonrpc: '2.0', id: message.id, result: { capabilities: this.capabilities } });
        if (this.mode === 'crash') queueMicrotask(() => active.finish());
      }
      if (message.method === 'shutdown' && Object.hasOwn(message, 'id')) {
        void active.send({ jsonrpc: '2.0', id: message.id, result: null });
      }
      if (message.method === 'textDocument/hover' && Object.hasOwn(message, 'id')) {
        void active.send({ jsonrpc: '2.0', id: message.id, result: { contents: { kind: 'plaintext', value: 'fixture hover' } } });
      }
      if (message.method === 'textDocument/completion' && Object.hasOwn(message, 'id')) {
        void active.send({ jsonrpc: '2.0', id: message.id, result: [] });
      }
      if (message.method === 'workspace/configuration' && Object.hasOwn(message, 'id')) {
        void active.send({ jsonrpc: '2.0', id: message.id, result: [{ fromServer: true }] });
      }
    });
    this.processes.push(process);
    return { ok: true, value: process };
  }
}

class FakeClock implements ClockPort {
  now = 0;
  delays: number[] = [];
  monotonicMilliseconds(): number { return this.now; }
  schedule(_delayMilliseconds: number, callback: () => void): Disposable { callback(); return { dispose() {} }; }
  async sleep(delayMilliseconds: number, cancellation: CancellationSource['token']): Promise<Result<void, { readonly kind: 'cancelled' }>> {
    this.delays.push(delayMilliseconds);
    this.now += delayMilliseconds;
    return cancellation.isCancelled ? { ok: false, error: { kind: 'cancelled' } } : { ok: true, value: undefined };
  }
}

const config: LanguageServerConfig = Object.freeze({ name: 'fake', command: 'fake-lsp', args: [], rootMarkers: ['package.json', '.git'] });
const workspaceFolders: readonly LanguageWorkspaceFolder[] = Object.freeze([{ uri: 'file:///workspace/root-a', name: 'root-a' }]);
const document = Object.freeze({ uri: 'file:///workspace/root-a/src/main.ts', languageId: 'typescript', version: 7, text: 'const smile = "😀";\n' });

async function testRootResolution(): Promise<void> {
  const probes = new Set(['/workspace/package.json']);
  const root = await resolveLanguageRoot({ filePath: '/workspace/src/main.ts', rootMarkers: ['package.json', '.git'] }, async (path) => ({ ok: true, value: probes.has(path) }));
  assert(root.ok, 'nearest configured root marker should resolve');
  equal(root.value.root, '/workspace', 'root marker directory');
  equal(root.value.marker, 'package.json', 'marker order/result');

  const fallback = await resolveLanguageRoot({ filePath: '/workspace/loose.ts', rootMarkers: ['package.json'], singleFileFallback: true }, async () => ({ ok: true, value: false }));
  assert(fallback.ok, 'single-file fallback should resolve when no marker exists');
  equal(fallback.value.root, '/workspace', 'single-file fallback directory');

  const ambiguous = await resolveLanguageRoot({ filePath: '/workspace/src/main.ts', rootMarkers: ['package.json', 'package.json'] }, async () => ({ ok: true, value: true }));
  assert(!ambiguous.ok && ambiguous.error.kind === 'ambiguous-marker', 'duplicate marker configuration should be explicit ambiguity');
}

async function testAsyncLifecycleAndReplay(): Promise<void> {
  const process = new FakeLanguageProcessPort('ready');
  const clock = new FakeClock();
  const session = new LanguageServerSession({
    process,
    clock,
    config,
    root: '/workspace/root-a',
    workspaceId: 'workspace-a',
    workspaceFolders,
    configuration: { typescript: { strict: true } },
    retry: { maxRetries: 2, baseDelayMilliseconds: 3, maxDelayMilliseconds: 10 },
  });
  const admitted = session.openDocument(document);
  assert(admitted.ok, 'document admission is synchronous while server starts');
  session.activate();
  equal(session.state, 'starting', 'activate returns before asynchronous spawn/initialize completes');
  const ready = await session.waitForReady();
  assert(ready.ok, 'fake server reaches ready state');
  equal(session.health.capabilities?.hoverProvider, true, 'initialize capabilities retained in health');
  equal(session.health.openDocumentCount, 1, 'open document retained');
  equal(session.health.replayCount, 1, 'initial replay happens once');

  const first = process.processes[0];
  assert(first !== undefined, 'first process exists');
  await waitFor(() => first.writes.some((message) => (message as JsonRecord).method === 'textDocument/didOpen'), 'didOpen replay was sent');
  await first.send({ jsonrpc: '2.0', id: 4, method: 'client/registerCapability', params: { registrations: [{ id: 'hover', method: 'textDocument/hover' }] } });
  await first.send({ jsonrpc: '2.0', id: 6, method: 'client/unregisterCapability', params: { unregisterations: [{ id: 'missing', method: 'textDocument/definition' }] } });
  await first.send({ jsonrpc: '2.0', method: '$/progress', params: { token: 'index', value: { kind: 'begin', title: 'Index' } } });
  await first.send({ jsonrpc: '2.0', id: 5, method: 'workspace/configuration', params: { items: [{ section: 'typescript' }] } });
  await waitFor(() => session.health.registeredCapabilities.length === 1, 'dynamic capability registration retained');
  await waitFor(() => session.health.progress.length === 1, 'progress notification retained');
  await waitFor(() => session.health.lastFailure?.includes('unknown capability') === true, 'unknown dynamic unregister is diagnosed');

  // A process crash begins a bounded background restart. The file/config replay is ordered once on the new process.
  first.finish();
  await waitFor(() => process.processes.length >= 2, 'crash schedules a replacement process');
  await waitFor(() => session.state === 'ready' && session.health.replayCount === 2, 'replacement reaches ready and replays state');
  const second = process.processes[1];
  assert(second !== undefined, 'replacement process exists');
  const replayed = second.writes.map((message) => (message as JsonRecord).method).filter((method) => method === 'workspace/didChangeConfiguration' || method === 'textDocument/didOpen');
  equal(replayed.join(','), 'workspace/didChangeConfiguration,textDocument/didOpen', 'replacement replay order/cardinality');
  await session.dispose();
  equal(session.state, 'stopped', 'session shutdown reaches stopped');
}

async function testIsolationAndFailures(): Promise<void> {
  const pool = new LanguageServerPool();
  const options = (root: string): ConstructorParameters<typeof LanguageServerSession>[0] => ({ process: new FakeLanguageProcessPort('ready'), clock: new FakeClock(), config, root, workspaceId: 'workspace-a' });
  const a = pool.getOrCreate(options('/workspace/root-a'));
  const b = pool.getOrCreate(options('/workspace/root-b'));
  assert(a !== b, 'different roots must receive isolated sessions');
  equal(pool.size, 2, 'pool retains both root identities');
  assert(a.identity.key !== b.identity.key, 'root participates in identity key');
  await pool.dispose();

  const unavailable = new LanguageServerSession({ process: new FakeLanguageProcessPort('unavailable'), clock: new FakeClock(), config, root: '/workspace', workspaceId: 'workspace-a' });
  unavailable.activate();
  await waitFor(() => unavailable.state === 'disabled', 'missing executable reports disabled state');
  assert((await unavailable.waitForReady()).ok === false, 'unavailable health is a typed failure');
  await unavailable.dispose();

  const storm = new LanguageServerSession({ process: new FakeLanguageProcessPort('spawn-retry'), clock: new FakeClock(), config, root: '/workspace', workspaceId: 'workspace-a', retry: { maxRetries: 2, baseDelayMilliseconds: 1, maxDelayMilliseconds: 2 } });
  storm.activate();
  await waitFor(() => storm.state === 'failed', 'restart storm stops at retry limit');
  equal(storm.health.retries, 3, 'restart storm retry count is bounded');
  await storm.dispose();
}

async function testNegotiatedCapabilitiesAndDynamicChanges(): Promise<void> {
  const process = new FakeLanguageProcessPort('ready', { positionEncoding: 'utf-16', definitionProvider: true, completionProvider: [], hoverProvider: 'yes' });
  const session = new LanguageServerSession({ process, clock: new FakeClock(), config, root: '/workspace/root-a', workspaceId: 'workspace-a' });
  const admitted = session.openDocument(document);
  assert(admitted.ok, 'capability fixture document admission succeeds');
  const request: NavigationRequest = Object.freeze({ documentId: 'doc-a', documentVersion: 7, selectionGeneration: 9, uri: document.uri, position: { line: 0, utf16: 0 } });
  const capabilityGenerations: number[] = [];
  const capabilitySubscription = session.onCapabilitiesChange((change) => capabilityGenerations.push(change.generation));
  session.activate();
  assert((await session.waitForReady()).ok, 'partial-capability fake peer reaches ready');
  assert(session.supportsRequest('textDocument/definition', document.uri), 'static definition capability is available');
  equal(session.health.capabilities?.positionEncoding, 'utf-16', 'server negotiates the only advertised feature encoding');
  assert(!session.supportsRequest('textDocument/completion', document.uri), 'malformed completion capability is unavailable');
  assert(!session.supportsRequest('completionItem/resolve'), 'completion resolve is unavailable unless explicitly advertised');
  assert(!session.supportsRequest('textDocument/hover', document.uri), 'malformed hover capability is unavailable');
  assert(!session.supportsRequest('textDocument/signatureHelp', document.uri), 'absent signature capability stays unavailable');

  const active = process.processes[0];
  assert(active !== undefined, 'capability fake process exists');
  const initialize = active.writes.find((message) => (message as JsonRecord).method === 'initialize') as JsonRecord | undefined;
  const initializeParams = initialize?.params as JsonRecord | undefined;
  const clientCaps = initializeParams?.capabilities as JsonRecord | undefined;
  const general = clientCaps?.general as JsonRecord | undefined;
  const encodings = (general?.positionEncodings as readonly string[] | undefined) ?? [];
  equal(encodings.join(','), 'utf-16', 'client advertises only the implemented feature coordinate encoding');
  const textDocumentCaps = clientCaps?.textDocument as JsonRecord | undefined;
  const completionCaps = textDocumentCaps?.completion as JsonRecord | undefined;
  const completionItemCaps = completionCaps?.completionItem as JsonRecord | undefined;
  equal(completionItemCaps?.snippetSupport, true, 'client advertises implemented snippet insertion');
  assert(!Object.hasOwn(clientCaps ?? {}, 'workspaceFolders'), 'client does not claim workspace folder query/change support');
  equal(initializeParams?.workspaceFolders, null, 'initialize reports unsupported workspace folder state as null');
  const diagnosticsCaps = textDocumentCaps?.diagnostic as JsonRecord | undefined;
  assert(!Object.hasOwn(diagnosticsCaps ?? {}, 'relatedDocumentSupport'), 'client does not claim ignored related diagnostic support');
  await active.send({ jsonrpc: '2.0', id: 9, method: 'workspace/diagnostic/refresh', params: {} });
  await waitFor(() => active.writes.some((message) => (message as JsonRecord).id === 9), 'diagnostic refresh request receives a response');
  const refreshResponse = active.writes.find((message) => (message as JsonRecord).id === 9) as JsonRecord | undefined;
  equal(refreshResponse?.result, null, 'unsupported diagnostic refresh is acknowledged without issuing a diagnostic pull');

  const navigation = new LanguageServerNavigationProvider(session);
  const completion = new LanguageServerCompletionProvider(session);
  const signature = new LanguageServerSignatureProvider(session);
  const hierarchy = new LanguageServerHierarchyProvider(session);
  const workspaceEdits = new LanguageServerWorkspaceEditProvider({ session });
  const completionRequest: CompletionRequest = Object.freeze({ documentId: 'doc-a', documentVersion: 7, selectionGeneration: 9, position: { line: 0, utf16: 0 }, trigger: 'invoked', uri: document.uri });
  const workspaceRequest = { documentId: 'doc-a', uri: document.uri, version: 7, position: { line: 0, utf16: 0 } };
  const beforeUnsupported = active.writes.length;
  const unavailableHover = await navigation.hover(request);
  assert(!unavailableHover.ok && unavailableHover.error.kind === 'unavailable', 'absent hover is an explicit unavailable result');
  const unavailableCompletion = await completion.complete(completionRequest);
  assert(!unavailableCompletion.ok && unavailableCompletion.error.kind === 'unavailable', 'malformed completion is explicit unavailable');
  assert(!(await signature.request({ documentId: 'doc-a', documentVersion: 7, selectionGeneration: 9, position: request.position, uri: document.uri })).ok, 'absent signature help is unavailable');
  assert(!(await workspaceEdits.codeActions(workspaceRequest)).ok, 'absent code action provider is unavailable');
  assert(!(await workspaceEdits.prepareRename(workspaceRequest)).ok, 'absent prepareRename provider is unavailable');
  assert(!(await workspaceEdits.rename(workspaceRequest, 'renamed')).ok, 'absent rename provider is unavailable');
  assert(!(await hierarchy.prepare(request)).ok, 'absent call hierarchy provider is unavailable');
  assert(!(await hierarchy.links(request)).ok, 'absent document-link provider is unavailable');
  equal(active.writes.length, beforeUnsupported, 'unsupported providers send no request');

  await active.send({ jsonrpc: '2.0', id: 10, method: 'client/registerCapability', params: { registrations: [{ id: 'hover-ts', method: 'textDocument/hover', registerOptions: { documentSelector: [{ language: 'typescript', scheme: 'file', pattern: '**/*.ts' }] } }] } });
  await waitFor(() => session.supportsRequest('textDocument/hover', document.uri), 'matching dynamic registration makes hover available');
  assert(!session.supportsRequest('textDocument/hover', 'file:///workspace/root-a/other.go'), 'dynamic language selector excludes other documents');
  const availableHover = await navigation.hover(request);
  assert(availableHover.ok && availableHover.value.markdown === 'fixture hover', 'registered hover reaches the server and returns a result');
  assert(active.writes.some((message) => (message as JsonRecord).method === 'textDocument/hover'), 'registered hover emits the supported request');

  await active.send({ jsonrpc: '2.0', id: 14, method: 'client/registerCapability', params: { registrations: [{ id: 'completion-ts', method: 'textDocument/completion', registerOptions: { documentSelector: [{ language: 'typescript', scheme: 'file' }], resolveProvider: false } }] } });
  await waitFor(() => session.supportsRequest('textDocument/completion', document.uri), 'completion registration makes provider available');
  const dynamicCompletion = await completion.complete(completionRequest);
  assert(dynamicCompletion.ok && dynamicCompletion.value.items.length === 0, 'registered completion reaches the server');
  assert(active.writes.some((message) => (message as JsonRecord).method === 'textDocument/completion'), 'registered completion emits its request');

  await active.send({ jsonrpc: '2.0', id: 17, method: 'client/registerCapability', params: { registrations: [
    { id: 'diagnostics-ts', method: 'textDocument/diagnostic', registerOptions: { documentSelector: [{ language: 'typescript', scheme: 'file' }], workspaceDiagnostics: true } },
    { id: 'call-hierarchy-ts', method: 'textDocument/prepareCallHierarchy', registerOptions: { documentSelector: [{ language: 'typescript', scheme: 'file' }] } },
    { id: 'type-hierarchy-ts', method: 'textDocument/prepareTypeHierarchy', registerOptions: { documentSelector: [{ language: 'typescript', scheme: 'file' }] } },
    { id: 'document-links-ts', method: 'textDocument/documentLink', registerOptions: { documentSelector: [{ language: 'typescript', scheme: 'file' }], resolveProvider: true } },
  ] } });
  await waitFor(() => session.supportsRequest('textDocument/diagnostic', document.uri), 'dynamic diagnostic registration makes pull available');
  assert(session.supportsRequest('workspace/diagnostic'), 'dynamic diagnostic workspace option enables workspace pulls');
  assert(session.supportsRequest('callHierarchy/incomingCalls', document.uri), 'dynamic call hierarchy registration enables child requests');
  assert(session.supportsRequest('typeHierarchy/subtypes', document.uri), 'dynamic type hierarchy registration enables child requests');
  assert(session.supportsRequest('documentLink/resolve', document.uri), 'dynamic document link registration enables resolve when advertised');

  await active.send({ jsonrpc: '2.0', id: 11, method: 'client/registerCapability', params: { registrations: [
    { id: 'unknown', method: 'textDocument/notImplemented' },
    { id: 'signature', method: 'textDocument/signatureHelp' },
  ] } });
  await waitFor(() => session.health.lastFailure?.includes('unsupported or duplicate capability') === true, 'unknown registration is diagnosed');
  equal(session.health.registeredCapabilities.length, 6, 'unknown registration rejects the complete capability batch');
  assert(!session.supportsRequest('textDocument/signatureHelp', document.uri), 'valid entry in a rejected batch does not become active');

  await active.send({ jsonrpc: '2.0', id: 15, method: 'client/registerCapability', params: { registrations: [
    { id: 'signature-malformed', method: 'textDocument/signatureHelp' },
    { id: 5, method: 'textDocument/definition' },
  ] } });
  await waitFor(() => session.health.lastFailure?.includes('invalid client/registerCapability parameters') === true, 'malformed registration is diagnosed');
  equal(session.health.registeredCapabilities.length, 6, 'malformed registration leaves existing capabilities unchanged');
  equal(session.health.openDocumentCount, 1, 'malformed and unknown capabilities preserve admitted document state');

  await active.send({ jsonrpc: '2.0', id: 12, method: 'client/unregisterCapability', params: { unregisterations: [{ id: 'hover-ts', method: 'textDocument/definition' }] } });
  await waitFor(() => session.health.lastFailure?.includes('unregister an unknown capability') === true, 'mismatched unregister is diagnosed');
  assert(session.supportsRequest('textDocument/hover', document.uri), 'mismatched unregister leaves the valid capability intact');

  await active.send({ jsonrpc: '2.0', id: 13, method: 'client/unregisterCapability', params: { unregisterations: [{ id: 'hover-ts', method: 'textDocument/hover' }] } });
  await waitFor(() => !session.supportsRequest('textDocument/hover', document.uri), 'valid dynamic unregister removes provider availability');
  const beforeUnregistered = active.writes.length;
  const unregisteredHover = await navigation.hover(request);
  assert(!unregisteredHover.ok && unregisteredHover.error.kind === 'unavailable', 'unregistered hover becomes unavailable');
  equal(active.writes.length, beforeUnregistered, 'unregistered hover sends no stale request');
  await active.send({ jsonrpc: '2.0', id: 16, method: 'client/unregisterCapability', params: { unregisterations: [{ id: 'completion-ts', method: 'textDocument/completion' }] } });
  await waitFor(() => !session.supportsRequest('textDocument/completion', document.uri), 'valid dynamic completion unregister removes provider availability');
  assert(capabilityGenerations.length >= 5, 'initialize, register, and unregister publish capability changes');
  equal(request.selectionGeneration, 9, 'capability failures do not mutate the caller selection generation');
  capabilitySubscription.dispose();
  await session.dispose();
  assert(!session.supportsRequest('textDocument/definition', document.uri), 'disposed session clears stale capability availability');

  const invalidEncoding = new LanguageServerSession({ process: new FakeLanguageProcessPort('ready', { hoverProvider: true, positionEncoding: 'utf-8' }), clock: new FakeClock(), config, root: '/workspace/root-a', workspaceId: 'workspace-invalid-encoding', retry: { maxRetries: 0, baseDelayMilliseconds: 0, maxDelayMilliseconds: 0 } });
  const retained = invalidEncoding.openDocument(document);
  assert(retained.ok, 'invalid-encoding fixture admits its source snapshot');
  invalidEncoding.activate();
  await waitFor(() => invalidEncoding.state === 'failed', `server choosing an unoffered encoding fails initialization (state=${invalidEncoding.state}, failure=${invalidEncoding.health.lastFailure ?? 'none'})`, 5_000);
  assert(!invalidEncoding.supportsRequest('textDocument/hover', document.uri), 'invalid encoding never exposes provider availability');
  equal(invalidEncoding.health.openDocumentCount, 1, 'invalid negotiated encoding does not mutate the document');
  await invalidEncoding.dispose();
}

async function testOversizedDocumentAdmission(): Promise<void> {
  const process = new FakeLanguageProcessPort('ready');
  const session = new LanguageServerSession({
    process,
    clock: new FakeClock(),
    config,
    root: '/workspace/root-a',
    workspaceId: 'workspace-oversized',
    maxDocumentUtf16: 8,
  });
  const oversized = { ...document, text: 'x'.repeat(9) };
  const rejected = session.openDocument(oversized);
  assert(!rejected.ok && rejected.error.kind === 'document-too-large', 'oversized document is rejected at admission, not sent to the transport');
  equal(session.health.openDocumentCount, 0, 'rejected document is never stored for replay');

  const small = { ...document, text: 'ok' };
  const admitted = session.openDocument(small);
  assert(admitted.ok, 'a document within the bound is still admitted normally');
  equal(session.health.openDocumentCount, 1, 'admitted document is retained');
  await session.dispose();
}

await testRootResolution();
await testAsyncLifecycleAndReplay();
await testIsolationAndFailures();
await testNegotiatedCapabilitiesAndDynamicChanges();
await testOversizedDocumentAdmission();
console.log('T047 lifecycle passed root resolution, asynchronous startup, initialize/configuration/progress, crash replay, identity isolation and failure health fixtures');
