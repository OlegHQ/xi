import type { Message } from 'vscode-jsonrpc/browser';
import {
  type ProcessHandle,
  type ProcessInput,
  type ProcessPort,
  type ProcessSpec,
  type Result,
  CancellationSource,
} from '../../packages/contracts/src/index';
import { ContentLengthFrameDecoder, type FrameDecoderLimits } from '../../packages/services/language/framing';
import { startLanguageTransport, type LanguageTransport } from '../../packages/services/language';

type TestBody = () => void | Promise<void>;
const cases: { readonly id: string; readonly name: string; readonly body: TestBody }[] = [];

function test(id: string, name: string, body: TestBody): void {
  cases.push({ id, name, body });
}

class AsyncByteQueue implements AsyncIterable<Uint8Array> {
  private readonly queued: Uint8Array[] = [];
  private readonly readers: ((result: IteratorResult<Uint8Array>) => void)[] = [];
  private readonly writers: (() => void)[] = [];
  private closed = false;

  constructor(private readonly capacity: number) {}

  async push(bytes: Uint8Array): Promise<void> {
    while (this.queued.length >= this.capacity && this.readers.length === 0 && !this.closed) {
      await new Promise<void>((resolve) => this.writers.push(resolve));
    }
    if (this.closed) throw new Error('fake byte queue is closed');
    const reader = this.readers.shift();
    if (reader !== undefined) reader({ done: false, value: bytes });
    else this.queued.push(bytes);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const reader of this.readers.splice(0)) reader({ done: true, value: undefined });
    for (const writer of this.writers.splice(0)) writer();
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return { next: () => this.take() };
  }

  private async take(): Promise<IteratorResult<Uint8Array>> {
    const value = this.queued.shift();
    if (value !== undefined) {
      this.writers.shift()?.();
      return { done: false, value };
    }
    if (this.closed) return { done: true, value: undefined };
    return new Promise<IteratorResult<Uint8Array>>((resolve) => this.readers.push(resolve));
  }
}

type ServerMessageHandler = (message: Message, peer: FakeLspPeer) => void | Promise<void>;

class FakeProcessHandle implements ProcessHandle {
  readonly stdoutQueue = new AsyncByteQueue(8);
  readonly stderrQueue = new AsyncByteQueue(2);
  readonly writes: Uint8Array[] = [];
  readonly stdin: ProcessInput | null;
  readonly stdout = this.stdoutQueue;
  readonly stderr = this.stderrQueue;
  readonly exit: Promise<Result<{ readonly code: number | null; readonly signal: string | null }, { readonly code: string; readonly message: string; readonly retryable: boolean }>>;
  private resolveExit!: (result: Result<{ readonly code: number | null; readonly signal: string | null }, { readonly code: string; readonly message: string; readonly retryable: boolean }>) => void;
  private completed = false;
  terminated = false;
  disposed = false;

  constructor(withStdin = true, private readonly onClientBytes: (bytes: Uint8Array) => void = () => {}) {
    this.exit = new Promise((resolve) => { this.resolveExit = resolve; });
    this.stdin = withStdin ? {
      write: async (bytes) => {
        const copy = new Uint8Array(bytes);
        this.writes.push(copy);
        this.onClientBytes(copy);
        return { ok: true, value: undefined };
      },
      close: async () => ({ ok: true, value: undefined }),
      dispose() {},
    } : null;
  }

  finish(code: number | null = 0, signal: string | null = null): void {
    if (this.completed) return;
    this.completed = true;
    this.stdoutQueue.close();
    this.stderrQueue.close();
    this.resolveExit({ ok: true, value: { code, signal } });
  }

  async terminate(_forceAfterMilliseconds: number): Promise<void> {
    this.terminated = true;
    this.finish(1, 'SIGTERM');
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (!this.completed) this.finish(1, 'SIGTERM');
  }
}

class FakeLspPeer {
  readonly decoder: ContentLengthFrameDecoder;
  private handler: ServerMessageHandler = async () => {};
  readonly failures: unknown[] = [];
  readonly handle: FakeProcessHandle;

  constructor(limits: Partial<FrameDecoderLimits> = {}, withStdin = true) {
    this.decoder = new ContentLengthFrameDecoder(limits);
    this.handle = new FakeProcessHandle(withStdin, (bytes) => {
      try {
        for (const message of this.decoder.feed(bytes)) {
          const result = this.handler(message, this);
          if (result instanceof Promise) void result.catch((error: unknown) => this.failures.push(error));
        }
      } catch (error) {
        this.failures.push(error);
      }
    });
  }

  onMessage(handler: ServerMessageHandler): void {
    this.handler = handler;
  }

  async send(message: unknown): Promise<void> {
    await this.handle.stdoutQueue.push(encodeFakeFrame(message));
  }

  async sendBytes(bytes: Uint8Array): Promise<void> {
    await this.handle.stdoutQueue.push(bytes);
  }
}

class FakeProcessPort implements ProcessPort {
  spawnCount = 0;

  constructor(readonly peer: FakeLspPeer, private readonly spawnFailure = false) {}

  async spawn(_spec: ProcessSpec): Promise<Result<ProcessHandle, { readonly code: string; readonly message: string; readonly retryable: boolean }>> {
    this.spawnCount += 1;
    return this.spawnFailure
      ? { ok: false, error: { code: 'injected-spawn', message: 'fake spawn failure', retryable: false } }
      : { ok: true, value: this.peer.handle };
  }
}

function encodeFakeFrame(message: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message));
  const header = new TextEncoder().encode(`Content-Length: ${body.length}\r\n\r\n`);
  const frame = new Uint8Array(header.length + body.length);
  frame.set(header);
  frame.set(body, header.length);
  return frame;
}

function messageRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected JSON-RPC object');
  return value as Record<string, unknown>;
}

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
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

function processSpec(): ProcessSpec {
  return {
    argv: ['fake-lsp'],
    cwd: '/workspace',
    env: {},
    timeoutMilliseconds: 5_000,
    cancellation: new CancellationSource().token,
  };
}

async function start(peer: FakeLspPeer, overrides: Partial<Parameters<typeof startLanguageTransport>[0]> = {}): Promise<LanguageTransport> {
  const result = await startLanguageTransport({ process: new FakeProcessPort(peer), spec: processSpec(), ...overrides });
  if (!result.ok) throw new Error(`transport failed to start: ${result.error.kind}`);
  return result.value;
}

async function expectRejected(promise: Promise<unknown>, includes: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    assert(text.includes(includes), `rejection should include ${includes}, got ${text}`);
    return;
  }
  throw new Error(`expected promise to reject with ${includes}`);
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

test('LSP-T046-SPLIT-UTF8-COALESCED-01', 'decodes split multibyte bodies and coalesced frames; writes byte-counted output', async () => {
  const peer = new FakeLspPeer();
  const transport = await start(peer);
  const received: string[] = [];
  transport.onNotification('test/utf8', (params) => {
    const record = messageRecord(params);
    received.push(String(record.value));
  });

  const split = encodeFakeFrame({ jsonrpc: '2.0', method: 'test/utf8', params: { value: 'λ' } });
  const lambda = new TextEncoder().encode('λ');
  const lambdaOffset = split.findIndex((byte, index) => byte === lambda[0] && split[index + 1] === lambda[1]);
  assert(lambdaOffset >= 0, 'UTF-8 fixture contains lambda bytes');
  await peer.sendBytes(split.subarray(0, lambdaOffset + 1));
  await peer.sendBytes(split.subarray(lambdaOffset + 1));

  const one = encodeFakeFrame({ jsonrpc: '2.0', method: 'test/utf8', params: { value: 'first' } });
  const two = encodeFakeFrame({ jsonrpc: '2.0', method: 'test/utf8', params: { value: 'second' } });
  await peer.sendBytes(concat(one, two));
  await waitFor(() => received.length === 3, 'split and coalesced notification frames were not delivered');
  equal(received.join(','), 'λ,first,second', 'notification order and UTF-8 payload');

  peer.onMessage(async (message, activePeer) => {
    const record = messageRecord(message);
    if (record.method !== 'client/echo') return;
    const params = messageRecord(record.params);
    await activePeer.send({ jsonrpc: '2.0', id: record.id, result: { value: params.value } });
  });
  const reply = await transport.request<{ readonly value: string }>('client/echo', { value: 'é' });
  equal(reply.value, 'é', 'outgoing request round-trips a multibyte parameter');
  const outbound = peer.handle.writes[0];
  assert(outbound !== undefined, 'client wrote one request frame');
  const headerEnd = new TextDecoder().decode(outbound).indexOf('\r\n\r\n');
  assert(headerEnd >= 0, 'client output has a Content-Length header');
  const declared = Number(/^Content-Length: ([0-9]+)$/u.exec(new TextDecoder().decode(outbound.subarray(0, headerEnd)))?.[1]);
  equal(declared, outbound.length - headerEnd - 4, 'Content-Length counts UTF-8 body bytes');
  await transport.dispose();
});

test('LSP-T046-BIDIRECTIONAL-REQUEST-01', 'supports client and server requests on one process transport', async () => {
  const peer = new FakeLspPeer();
  const transport = await start(peer);
  transport.onRequest('server/compute', (params) => ({ result: Number(messageRecord(params).value) + 1 }));
  let serverResponse: Record<string, unknown> | undefined;
  peer.onMessage(async (message, activePeer) => {
    const record = messageRecord(message);
    if (record.method === 'client/ping') {
      await activePeer.send({ jsonrpc: '2.0', id: record.id, result: 'pong' });
      await activePeer.send({ jsonrpc: '2.0', id: 'server-1', method: 'server/compute', params: { value: 41 } });
    } else if (record.id === 'server-1') {
      serverResponse = record;
    }
  });
  const response = await transport.request<string>('client/ping', {});
  equal(response, 'pong', 'client request response');
  await waitFor(() => serverResponse !== undefined, 'client did not answer a server request');
  equal(messageRecord(messageRecord(serverResponse).result).result, 42, 'server request handler response');
  await transport.dispose();
});

test('LSP-T046-UNKNOWN-METHOD-01', 'returns MethodNotFound for unknown server requests and accounts for unknown notifications', async () => {
  const peer = new FakeLspPeer();
  const transport = await start(peer);
  let unknownResponse: Record<string, unknown> | undefined;
  peer.onMessage((message) => {
    const record = messageRecord(message);
    if (record.id === 'unknown-1') unknownResponse = record;
  });
  await peer.send({ jsonrpc: '2.0', id: 'unknown-1', method: 'server/unsupported', params: {} });
  await peer.send({ jsonrpc: '2.0', method: 'server/unsupported-notification', params: {} });
  await waitFor(() => unknownResponse !== undefined && transport.diagnostics.unknownNotifications === 1,
    'unknown method behavior was not observable');
  const error = messageRecord(messageRecord(unknownResponse).error);
  equal(error.code, -32601, 'unknown request error code');
  equal(transport.state, 'running', 'unknown method does not corrupt transport state');
  await transport.dispose();
});

test('LSP-T046-MALFORMED-JSON-01', 'malformed body JSON fails the transport cleanly', async () => {
  const peer = new FakeLspPeer();
  const transport = await start(peer);
  await peer.sendBytes(new TextEncoder().encode('Content-Length: 2\r\n\r\n{?'));
  await waitFor(() => transport.state === 'failed', 'malformed JSON did not fail the transport');
  assert(transport.diagnostics.failure?.includes('invalid-json'), 'failure records malformed JSON without body text');
  await transport.dispose();
});

test('LSP-T046-OVERSIZED-FRAME-01', 'rejects a declared frame over the configured body bound before allocation', async () => {
  const peer = new FakeLspPeer();
  const transport = await start(peer, { maxBodyBytes: 32 });
  await peer.sendBytes(new TextEncoder().encode('Content-Length: 33\r\n\r\n'));
  await waitFor(() => transport.state === 'failed', 'oversized frame did not fail the transport');
  assert(transport.diagnostics.failure?.includes('frame-too-large'), 'failure records the configured frame bound');
  await transport.dispose();
});

test('LSP-T046-OVERSIZED-OUTGOING-BODY-01', 'rejects only an oversized outgoing notification; the transport stays alive for other messages', async () => {
  const peer = new FakeLspPeer();
  const received: unknown[] = [];
  peer.onMessage((message) => {
    received.push(message);
  });
  const transport = await start(peer, { maxBodyBytes: 100 });
  await expectRejected(transport.notify('textDocument/didOpen', { text: 'x'.repeat(200) }), 'exceeds 100 bytes');
  equal(transport.state, 'running', 'oversized outgoing body does not fail the transport');
  await transport.notify('textDocument/didOpen', { text: 'small' });
  await waitFor(() => received.length === 1, 'transport still delivers a normal-size message after the rejection');
  await transport.dispose();
});

test('LSP-T046-EOF-MID-BODY-01', 'fails a truncated body on stdout EOF', async () => {
  const peer = new FakeLspPeer();
  const transport = await start(peer);
  const partial = new TextEncoder().encode('Content-Length: 40\r\n\r\n{"jsonrpc":"2.0"');
  await peer.sendBytes(partial);
  peer.handle.stdoutQueue.close();
  await waitFor(() => transport.state === 'failed', 'EOF during a body did not fail the transport');
  assert(transport.diagnostics.failure?.includes('eof-mid-body'), 'failure records EOF mid-body');
  await transport.dispose();
});

test('LSP-T046-DUPLICATE-RESPONSE-01', 'a duplicate response ID is a recorded protocol issue, not a connection-killing transport failure (F1-4)', async () => {
  // Before F1-4, ResponseTracker#incoming throwing (invalid-response-id/duplicate-response/
  // unknown-response) escaped feedEach uncaught, aborting the whole stdout read loop for one
  // malformed/duplicate message and tearing down the entire connection via fail(). That is a
  // server protocol slip, not a transport failure: the read loop must keep running so every
  // later message (including a completely unrelated request/response) still gets through.
  const peer = new FakeLspPeer();
  const transport = await start(peer);
  peer.onMessage(async (message, activePeer) => {
    const record = messageRecord(message);
    if (record.method === 'client/once') {
      const response = { jsonrpc: '2.0', id: record.id, result: true };
      await activePeer.send(response);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      await activePeer.send(response); // duplicate: the original request already completed
    } else if (record.method === 'client/after') {
      await activePeer.send({ jsonrpc: '2.0', id: record.id, result: 'still-alive' });
    }
  });
  const result = await transport.request<boolean>('client/once', {});
  equal(result, true, 'first response is delivered');
  // Give the duplicate a turn to arrive and be discarded.
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  equal(transport.state, 'running', 'a duplicate response is recorded but must not fail the transport');
  const after = await transport.request<string>('client/after', {});
  equal(after, 'still-alive', 'the read loop keeps delivering messages after the duplicate response');
  await transport.dispose();
});

test('LSP-T046-CANCEL-REQUEST-01', 'maps Xi cancellation to JSON-RPC cancellation notifications', async () => {
  const peer = new FakeLspPeer();
  const transport = await start(peer);
  const source = new CancellationSource();
  let requestId: unknown;
  let cancelId: unknown;
  let resolveRequest!: () => void;
  const requestSeen = new Promise<void>((resolve) => { resolveRequest = resolve; });
  peer.onMessage((message) => {
    const record = messageRecord(message);
    if (record.method === 'client/slow') {
      requestId = record.id;
      resolveRequest();
    } else if (record.method === '$/cancelRequest') {
      cancelId = messageRecord(record.params).id;
    }
  });
  const result = transport.request('client/slow', {}, source.token);
  await requestSeen;
  source.cancel();
  await expectRejected(result, 'cancel');
  await waitFor(() => cancelId !== undefined, 'JSON-RPC cancellation notification was not written');
  equal(cancelId, requestId, 'cancellation references its request ID');
  await transport.dispose();
});

test('LSP-T046-STDERR-FLOOD-01', 'drains a backpressured stderr flood without blocking JSON-RPC requests', async () => {
  const peer = new FakeLspPeer();
  const transport = await start(peer, { stderrRecordLimit: 4 });
  peer.onMessage(async (message, activePeer) => {
    const record = messageRecord(message);
    if (record.method === 'client/ping') await activePeer.send({ jsonrpc: '2.0', id: record.id, result: 'ok' });
  });
  const flood = (async () => {
    for (let chunk = 0; chunk < 512; chunk += 1) {
      await peer.handle.stderrQueue.push(new Uint8Array(1024).fill(0x78));
    }
  })();
  const response = await Promise.race([
    transport.request<string>('client/ping', {}),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('request blocked behind stderr flood')), 1_000)),
  ]);
  equal(response, 'ok', 'request succeeds during stderr flood');
  await Promise.race([
    flood,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('stderr pump did not drain bounded queue')), 1_000)),
  ]);
  const diagnostics = transport.diagnostics;
  equal(diagnostics.stderrBytesRead, 512 * 1024, 'stderr byte count');
  equal(diagnostics.stderrChunksRead, 512, 'stderr chunk count');
  equal(diagnostics.stderrRecords.length, 4, 'stderr record retention bound');
  assert(diagnostics.stderrBytesDiscarded > 0, 'discarded stderr is accounted for');
  await transport.dispose();
});

test('LSP-T046-PROCESS-LIFECYCLE-01', 'performs LSP shutdown and exits the child with bounded cleanup', async () => {
  const peer = new FakeLspPeer();
  const transport = await start(peer, { shutdownTimeoutMilliseconds: 100 });
  let shutdownSeen = false;
  let exitSeen = false;
  peer.onMessage(async (message, activePeer) => {
    const record = messageRecord(message);
    if (record.method === 'shutdown') {
      shutdownSeen = true;
      await activePeer.send({ jsonrpc: '2.0', id: record.id, result: null });
    } else if (record.method === 'exit') {
      exitSeen = true;
      activePeer.handle.finish(0, null);
    }
  });
  await transport.shutdown();
  assert(shutdownSeen && exitSeen, 'shutdown and exit messages reached the child');
  equal(transport.state, 'stopped', 'graceful lifecycle reaches stopped state');
  assert(peer.handle.disposed, 'child resources are disposed');
  assert(!peer.handle.terminated, 'graceful process exit avoids termination escalation');
});

test('LSP-T046-SHUTDOWN-ESCALATION-01', 'bounds shutdown when the server ignores the request and escalates process termination', async () => {
  const peer = new FakeLspPeer();
  const transport = await start(peer, {
    requestTimeoutMilliseconds: 10,
    shutdownTimeoutMilliseconds: 10,
    forceAfterMilliseconds: 5,
  });
  peer.onMessage(() => {});
  const started = Date.now();
  await transport.shutdown();
  assert(Date.now() - started < 250, 'shutdown returned within the combined bounded deadlines');
  assert(peer.handle.terminated, 'unresponsive child was terminated');
  assert(peer.handle.disposed, 'unresponsive child resources were disposed');
  equal(transport.state, 'stopped', 'escalated lifecycle reaches stopped state');
  assert(transport.diagnostics.failure !== null, 'shutdown timeout remains observable in diagnostics');
});

test('LSP-T046-SPAWN-FAILURE-01', 'reports process spawn and missing-stdin failures', async () => {
  const peer = new FakeLspPeer();
  const spawnFailurePort = new FakeProcessPort(peer, true);
  const failed = await startLanguageTransport({ process: spawnFailurePort, spec: processSpec() });
  assert(!failed.ok && failed.error.kind === 'spawn-failed', 'spawn failure is returned through Result');

  const noInputPeer = new FakeLspPeer({}, false);
  const noInputProcess = new FakeProcessPort(noInputPeer);
  const noInput = await startLanguageTransport({ process: noInputProcess, spec: processSpec() });
  assert(!noInput.ok && noInput.error.kind === 'missing-stdin', 'missing stdin is rejected and child cleaned up');
  assert(noInputPeer.handle.terminated && noInputPeer.handle.disposed, 'child without stdin is terminated and disposed');

  const invalidLimitsPort = new FakeProcessPort(new FakeLspPeer());
  const invalidLimits = await startLanguageTransport({
    process: invalidLimitsPort,
    spec: processSpec(),
    maxBodyBytes: 64 * 1024 * 1024 + 1,
  });
  assert(!invalidLimits.ok && invalidLimits.error.kind === 'invalid-options', 'hard frame limit is rejected before spawn');
  equal(invalidLimitsPort.spawnCount, 0, 'invalid options never spawn a child');
});

for (const testCase of cases) {
  await testCase.body();
  console.log(`${testCase.id} passed: ${testCase.name}`);
}
console.log(`T046 fake-peer cases passed: ${cases.length}`);
