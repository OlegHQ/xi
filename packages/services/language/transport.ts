import {
  AbstractMessageReader,
  AbstractMessageWriter,
  CancellationTokenSource as JsonRpcCancellationTokenSource,
  type Message,
  type DataCallback,
} from 'vscode-jsonrpc/browser';
import {
  createProtocolConnection,
  ExitNotification,
  InitializedNotification,
  InitializeRequest,
  ShutdownRequest,
  type InitializeParams,
  type InitializeResult,
  type ProtocolConnection,
} from 'vscode-languageserver-protocol/browser';
import type {
  CancellationToken,
  Disposable,
  PlatformFailure,
  ProcessHandle,
  ProcessInput,
  ProcessPort,
  ProcessSpec,
  Result,
} from '../../contracts/src/index';
import { ContentLengthFrameDecoder, encodeContentLengthFrame, FrameProtocolError, FRAME_HARD_LIMITS } from './framing';

export type LanguageTransportState = 'running' | 'stopping' | 'stopped' | 'failed';

export interface LanguageTransportStateChange {
  readonly previous: LanguageTransportState;
  readonly current: LanguageTransportState;
  readonly failure: string | null;
}

const MAX_TIMEOUT_MILLISECONDS = 2_147_483_647;
const MAX_PENDING_REQUESTS_LIMIT = 10_000;
const MAX_STDERR_RECORDS = 1_024;

export type LanguageStartFailure =
  | { readonly kind: 'spawn-failed'; readonly failure: PlatformFailure }
  | { readonly kind: 'missing-stdin'; readonly message: string }
  | { readonly kind: 'invalid-options'; readonly message: string };

export interface StderrRecord {
  readonly bytes: number;
}

export interface LanguageTransportDiagnostics {
  readonly stderrBytesRead: number;
  readonly stderrChunksRead: number;
  readonly stderrBytesDiscarded: number;
  readonly stderrRecords: readonly StderrRecord[];
  readonly unknownNotifications: number;
  readonly lastExit: { readonly code: number | null; readonly signal: string | null } | null;
  readonly failure: string | null;
}

export interface LanguageTransportOptions {
  readonly process: ProcessPort;
  readonly spec: ProcessSpec;
  readonly maxHeaderBytes?: number;
  readonly maxBodyBytes?: number;
  readonly maxPendingRequests?: number;
  readonly requestTimeoutMilliseconds?: number;
  readonly shutdownTimeoutMilliseconds?: number;
  readonly forceAfterMilliseconds?: number;
  readonly stderrRecordLimit?: number;
}

type JsonRpcRecord = Record<string, unknown>;

class LanguageProtocolError extends Error {
  constructor(readonly kind: string, message: string) {
    super(message);
    this.name = 'LanguageProtocolError';
  }
}

function asRecord(value: unknown): JsonRpcRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRpcRecord
    : undefined;
}

function idKey(value: unknown): string | undefined {
  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return `n:${value}`;
  return undefined;
}

function asErrorMessage(error: unknown): string {
  if (error instanceof FrameProtocolError) return `${error.kind}: ${error.message}`;
  if (error instanceof LanguageProtocolError) return `${error.kind}: ${error.message}`;
  if (error instanceof Error) return `${error.name}: language transport operation failed`;
  return 'language transport failed';
}

function makePlatformError(message: string): Error {
  return new Error(message);
}

class ResponseTracker {
  private readonly pending = new Set<string>();
  private readonly cancelled = new Map<string, 'awaiting-response' | 'responded'>();
  private readonly completed = new Set<string>();
  private readonly completedOrder: string[] = [];
  private readonly historyLimit: number;

  constructor(private readonly maxPending: number) {
    this.historyLimit = Math.max(64, maxPending * 2);
  }

  outgoing(message: Message): void {
    const record = asRecord(message);
    if (record === undefined) return;
    const method = record.method;
    if (typeof method === 'string' && Object.hasOwn(record, 'id')) {
      const key = idKey(record.id);
      if (key === undefined) throw new LanguageProtocolError('invalid-request-id', 'outgoing JSON-RPC request has an invalid ID');
      const cancelledWithoutResponse = [...this.cancelled.values()].filter((state) => state === 'awaiting-response').length;
      if (this.pending.size + cancelledWithoutResponse >= this.maxPending) {
        throw new LanguageProtocolError('pending-request-limit', 'language transport pending-request limit reached');
      }
      if (this.pending.has(key) || this.cancelled.has(key) || this.completed.has(key)) {
        throw new LanguageProtocolError('reused-request-id', 'language transport reused a JSON-RPC request ID');
      }
      this.pending.add(key);
      return;
    }
    if (method === '$/cancelRequest') {
      const params = asRecord(record.params);
      const key = idKey(params?.id);
      if (key !== undefined && this.pending.delete(key)) this.rememberCancelled(key);
    }
  }

  writeFailed(message: Message): void {
    const record = asRecord(message);
    if (record === undefined || typeof record.method !== 'string' || !Object.hasOwn(record, 'id')) return;
    const key = idKey(record.id);
    if (key !== undefined) this.pending.delete(key);
  }

  incoming(message: Message): void {
    const record = asRecord(message);
    if (record === undefined || Object.hasOwn(record, 'method') || !Object.hasOwn(record, 'id')) return;
    const key = idKey(record.id);
    if (key === undefined) throw new LanguageProtocolError('invalid-response-id', 'incoming JSON-RPC response has an invalid ID');
    if (this.pending.delete(key)) {
      this.rememberCompleted(key);
      return;
    }
    const cancelledState = this.cancelled.get(key);
    if (cancelledState === 'awaiting-response') {
      this.cancelled.set(key, 'responded');
      return;
    }
    if (cancelledState === 'responded' || this.completed.has(key)) {
      throw new LanguageProtocolError('duplicate-response', 'duplicate JSON-RPC response');
    }
    throw new LanguageProtocolError('unknown-response', 'JSON-RPC response has no matching request');
  }

  private rememberCompleted(key: string): void {
    this.completed.add(key);
    this.completedOrder.push(key);
    this.trimHistory();
  }

  private rememberCancelled(key: string): void {
    this.cancelled.set(key, 'awaiting-response');
    this.trimHistory();
  }

  private trimHistory(): void {
    while (this.completedOrder.length + this.respondedCancellationCount() > this.historyLimit) {
      const oldestCompleted = this.completedOrder.shift();
      if (oldestCompleted !== undefined) {
        this.completed.delete(oldestCompleted);
      } else {
        const oldestCancelled = [...this.cancelled.entries()].find(([, state]) => state === 'responded')?.[0];
        if (oldestCancelled === undefined) break;
        this.cancelled.delete(oldestCancelled);
      }
    }
  }

  private respondedCancellationCount(): number {
    let count = 0;
    for (const state of this.cancelled.values()) if (state === 'responded') count += 1;
    return count;
  }
}

class ProcessMessageReader extends AbstractMessageReader {
  private callback: DataCallback | undefined;
  private pump: Promise<void> | undefined;
  private readonly decoder: ContentLengthFrameDecoder;

  constructor(private readonly stdout: AsyncIterable<Uint8Array>, decoder: ContentLengthFrameDecoder,
    private readonly tracker: ResponseTracker, private readonly onFailure: (error: unknown) => void) {
    super();
    this.decoder = decoder;
  }

  listen(callback: DataCallback): Disposable {
    if (this.callback !== undefined) throw new Error('LSP reader can only be listened to once');
    this.callback = callback;
    this.pump = this.readLoop();
    return { dispose: () => {} };
  }

  override dispose(): void {
    super.dispose();
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const chunk of this.stdout) {
        this.decoder.feedEach(chunk, (message) => {
          this.tracker.incoming(message);
          this.callback?.(message);
        });
      }
      this.decoder.finish();
      this.fireClose();
    } catch (error) {
      this.onFailure(error);
      this.fireError(error);
      this.fireClose();
    }
  }
}

class ProcessMessageWriter extends AbstractMessageWriter {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly stdin: ProcessInput, private readonly tracker: ResponseTracker,
    private readonly maxBodyBytes: number, private readonly onFailure: (error: unknown) => void) {
    super();
  }

  write(message: Message): Promise<void> {
    const write = this.writeQueue.then(() => this.writeOne(message));
    this.writeQueue = write.catch(() => {});
    return write;
  }

  end(): void {
    void this.stdin.close();
  }

  private async writeOne(message: Message): Promise<void> {
    let bytes: Uint8Array;
    try {
      const serialized = JSON.stringify(message);
      if (serialized === undefined) throw new Error('JSON-RPC message is not serializable');
      const body = new TextEncoder().encode(serialized);
      if (body.byteLength > this.maxBodyBytes) throw new Error(`outgoing LSP body exceeds ${this.maxBodyBytes} bytes`);
      bytes = encodeContentLengthFrame(body);
      this.tracker.outgoing(message);
    } catch (error) {
      this.fireError(error, message);
      this.onFailure(error);
      throw error;
    }

    try {
      const result = await this.stdin.write(bytes);
      if (!result.ok) throw makePlatformError(`${result.error.code}: ${result.error.message}`);
    } catch (error) {
      this.tracker.writeFailed(message);
      this.fireError(error, message);
      this.onFailure(error);
      throw error;
    }
  }
}

class BoundedStderrLog {
  private bytesRead = 0;
  private chunksRead = 0;
  private bytesDiscarded = 0;
  private readonly records: StderrRecord[] = [];

  constructor(private readonly recordLimit: number) {}

  append(chunk: Uint8Array): void {
    this.bytesRead += chunk.byteLength;
    this.chunksRead += 1;
    this.records.push(Object.freeze({ bytes: chunk.byteLength }));
    while (this.records.length > this.recordLimit) {
      const removed = this.records.shift();
      this.bytesDiscarded += removed?.bytes ?? 0;
    }
  }

  snapshot(): Pick<LanguageTransportDiagnostics, 'stderrBytesRead' | 'stderrChunksRead' | 'stderrBytesDiscarded' | 'stderrRecords'> {
    return Object.freeze({
      stderrBytesRead: this.bytesRead,
      stderrChunksRead: this.chunksRead,
      stderrBytesDiscarded: this.bytesDiscarded,
      stderrRecords: Object.freeze([...this.records]),
    });
  }
}

function raceTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export class LanguageTransport implements Disposable {
  private currentState: LanguageTransportState = 'running';
  private disposePromise: Promise<void> | undefined;
  private unknownNotifications = 0;
  private exitValue: { readonly code: number | null; readonly signal: string | null } | null = null;
  private failureValue: string | null = null;
  private readonly stateListeners = new Set<(change: LanguageTransportStateChange) => void>();
  private readonly stderrLog: BoundedStderrLog;
  private readonly requestTimeoutMilliseconds: number;
  private readonly shutdownTimeoutMilliseconds: number;
  private readonly forceAfterMilliseconds: number;

  private constructor(
    private readonly handle: ProcessHandle,
    private readonly input: ProcessInput,
    private readonly connection: ProtocolConnection,
    private readonly reader: ProcessMessageReader,
    private readonly writer: ProcessMessageWriter,
    stderrRecordLimit: number,
    requestTimeoutMilliseconds: number,
    shutdownTimeoutMilliseconds: number,
    forceAfterMilliseconds: number,
  ) {
    this.stderrLog = new BoundedStderrLog(stderrRecordLimit);
    this.requestTimeoutMilliseconds = requestTimeoutMilliseconds;
    this.shutdownTimeoutMilliseconds = shutdownTimeoutMilliseconds;
    this.forceAfterMilliseconds = forceAfterMilliseconds;
    this.connection.onError(([error]) => this.fail(error));
    this.connection.onClose(() => {
      if (this.currentState === 'running') this.fail(new Error('language server closed its output unexpectedly'));
    });
    this.connection.onUnhandledNotification(() => { this.unknownNotifications += 1; });
    void this.drainStderr();
    void this.monitorExit();
  }

  static async start(options: LanguageTransportOptions): Promise<Result<LanguageTransport, LanguageStartFailure>> {
    const maxHeaderBytes = options.maxHeaderBytes ?? 8 * 1024;
    const maxBodyBytes = options.maxBodyBytes ?? 8 * 1024 * 1024;
    const maxPendingRequests = options.maxPendingRequests ?? 1024;
    const requestTimeoutMilliseconds = options.requestTimeoutMilliseconds ?? 30_000;
    const shutdownTimeoutMilliseconds = options.shutdownTimeoutMilliseconds ?? 2_000;
    const forceAfterMilliseconds = options.forceAfterMilliseconds ?? 500;
    const stderrRecordLimit = options.stderrRecordLimit ?? 64;
    if (!Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes < 4 || maxHeaderBytes > FRAME_HARD_LIMITS.maxHeaderBytes
      || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > FRAME_HARD_LIMITS.maxBodyBytes
      || !Number.isSafeInteger(maxPendingRequests) || maxPendingRequests < 1
      || maxPendingRequests > MAX_PENDING_REQUESTS_LIMIT
      || !Number.isSafeInteger(requestTimeoutMilliseconds) || requestTimeoutMilliseconds < 1 || requestTimeoutMilliseconds > MAX_TIMEOUT_MILLISECONDS
      || !Number.isSafeInteger(shutdownTimeoutMilliseconds) || shutdownTimeoutMilliseconds < 1 || shutdownTimeoutMilliseconds > MAX_TIMEOUT_MILLISECONDS
      || !Number.isSafeInteger(forceAfterMilliseconds) || forceAfterMilliseconds < 0 || forceAfterMilliseconds > MAX_TIMEOUT_MILLISECONDS
      || !Number.isSafeInteger(stderrRecordLimit) || stderrRecordLimit < 0 || stderrRecordLimit > MAX_STDERR_RECORDS) {
      return { ok: false, error: { kind: 'invalid-options', message: 'language transport limits must be valid non-negative safe integers' } };
    }

    let spawned: Result<ProcessHandle, PlatformFailure>;
    try {
      spawned = await options.process.spawn(options.spec);
    } catch {
      return {
        ok: false,
        error: { kind: 'spawn-failed', failure: { code: 'process-port-threw', message: 'process launch adapter failed', retryable: true } },
      };
    }
    if (!spawned.ok) return { ok: false, error: { kind: 'spawn-failed', failure: spawned.error } };
    const handle = spawned.value;
    if (handle.stdin === null) {
      try {
        await raceTimeout(handle.terminate(forceAfterMilliseconds), Math.max(forceAfterMilliseconds, 1), 'process cleanup');
      } catch {
        // Return the missing-pipe error even if a defective adapter misses its cleanup deadline.
      }
      try {
        await raceTimeout(Promise.resolve(handle.dispose()), Math.max(shutdownTimeoutMilliseconds, 1), 'process disposal');
      } catch {
        // The process port remains responsible for its own final OS-handle cleanup.
      }
      return { ok: false, error: { kind: 'missing-stdin', message: 'language server process has no stdin pipe' } };
    }

    const tracker = new ResponseTracker(maxPendingRequests);
    let transport: LanguageTransport | undefined;
    const onFailure = (error: unknown): void => transport?.fail(error);
    const decoder = new ContentLengthFrameDecoder({ maxHeaderBytes, maxBodyBytes });
    const reader = new ProcessMessageReader(handle.stdout, decoder, tracker, onFailure);
    const writer = new ProcessMessageWriter(handle.stdin, tracker, maxBodyBytes, onFailure);
    const connection = createProtocolConnection(reader, writer);
    transport = new LanguageTransport(handle, handle.stdin, connection, reader, writer,
      stderrRecordLimit, requestTimeoutMilliseconds, shutdownTimeoutMilliseconds, forceAfterMilliseconds);
    connection.listen();
    return { ok: true, value: transport };
  }

  get state(): LanguageTransportState {
    return this.currentState;
  }

  get diagnostics(): LanguageTransportDiagnostics {
    return Object.freeze({
      ...this.stderrLog.snapshot(),
      unknownNotifications: this.unknownNotifications,
      lastExit: this.exitValue,
      failure: this.failureValue,
    });
  }

  /** Subscribe to process/connection state changes without exposing the transport internals. */
  onStateChange(listener: (change: LanguageTransportStateChange) => void): Disposable {
    this.stateListeners.add(listener);
    return { dispose: () => { this.stateListeners.delete(listener); } };
  }

  request<Response>(method: string, params?: unknown, cancellation?: CancellationToken): Promise<Response> {
    this.ensureRunning();
    if (typeof method !== 'string' || method.length === 0) return Promise.reject(new TypeError('JSON-RPC method must be nonempty'));
    if (cancellation?.isCancelled) return Promise.reject(new Error(`language request ${method} was cancelled`));
    const source = new JsonRpcCancellationTokenSource();
    let rejectCancellation!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    const cancelSource = (): void => {
      try {
        source.cancel();
      } catch {
        // JSON-RPC may dispose its connection while a cancellation event is being delivered.
      }
    };
    const cancelRequest = (): void => {
      cancelSource();
      rejectCancellation(new Error(`language request ${method} was cancelled`));
    };
    const subscription = cancellation?.onCancel(cancelRequest);
    if (cancellation?.isCancelled) cancelRequest();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        cancelSource();
        reject(new Error(`language request ${method} timed out after ${this.requestTimeoutMilliseconds} ms`));
      }, this.requestTimeoutMilliseconds);
    });
    let operation: Promise<Response>;
    try {
      operation = params === undefined
        ? this.connection.sendRequest<Response>(method, source.token)
        : this.connection.sendRequest<Response>(method, params, source.token);
    } catch (error) {
      if (timer !== undefined) clearTimeout(timer);
      subscription?.dispose();
      source.dispose();
      return Promise.reject(error);
    }
    return Promise.race([operation, timeout, cancelled]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      subscription?.dispose();
      source.dispose();
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    this.ensureRunning();
    if (typeof method !== 'string' || method.length === 0) return Promise.reject(new TypeError('JSON-RPC method must be nonempty'));
    return params === undefined
      ? this.connection.sendNotification(method)
      : this.connection.sendNotification(method, params);
  }

  onRequest(method: string, handler: (params: unknown) => unknown | Promise<unknown>): Disposable {
    this.ensureRunning();
    return this.connection.onRequest(method, (params) => handler(params));
  }

  onNotification(method: string, handler: (params: unknown) => void): Disposable {
    this.ensureRunning();
    return this.connection.onNotification(method, (params) => handler(params));
  }

  initialize(params: InitializeParams): Promise<InitializeResult> {
    this.ensureRunning();
    return this.request<InitializeResult>(InitializeRequest.type.method, params);
  }

  initialized(): Promise<void> {
    this.ensureRunning();
    return this.connection.sendNotification(InitializedNotification.type, {});
  }

  async shutdown(): Promise<void> {
    if (this.currentState === 'stopped') return;
    if (this.currentState === 'failed') {
      await this.dispose();
      return;
    }
    try {
      // A server that ignores shutdown must not hold application teardown for
      // the ordinary feature-request timeout. Shutdown is bounded by the
      // process lifecycle deadline and escalates through dispose below.
      await raceTimeout(this.request<unknown>(ShutdownRequest.type.method), this.shutdownTimeoutMilliseconds, 'language shutdown request');
      this.currentState = 'stopping';
      await this.connection.sendNotification(ExitNotification.type);
    } catch (error) {
      this.failureValue ??= asErrorMessage(error);
    }
    await this.dispose();
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise;
    this.disposePromise = this.stopProcess();
    return this.disposePromise;
  }

  private ensureRunning(): void {
    if (this.currentState !== 'running') throw new Error(`language transport is ${this.currentState}`);
  }

  private fail(error: unknown): void {
    if (this.currentState !== 'running') return;
    const previous = this.currentState;
    this.failureValue = asErrorMessage(error);
    this.currentState = 'failed';
    this.emitStateChange(previous, this.currentState);
    this.connection.dispose();
    try {
      void this.handle.terminate(this.forceAfterMilliseconds).catch(() => {});
    } catch {
      // The failure is already recorded; callers can still await explicit disposal for cleanup.
    }
  }

  private async drainStderr(): Promise<void> {
    try {
      for await (const chunk of this.handle.stderr) this.stderrLog.append(chunk);
    } catch (error) {
      if (this.currentState === 'running') this.fail(new Error(`language stderr pipe failed: ${asErrorMessage(error)}`));
    }
  }

  private async monitorExit(): Promise<void> {
    try {
      const exit = await this.handle.exit;
      if (!exit.ok) {
        if (this.currentState === 'running') this.fail(new Error(`language process exit status unavailable: ${exit.error.code}`));
        return;
      }
      this.exitValue = Object.freeze({ code: exit.value.code, signal: exit.value.signal });
      if (this.currentState === 'running') {
        this.fail(new Error(`language server exited (code ${String(exit.value.code)}, signal ${String(exit.value.signal)})`));
      }
    } catch (error) {
      if (this.currentState === 'running') this.fail(error);
    }
  }

  private async stopProcess(): Promise<void> {
    if (this.currentState === 'stopped') return;
    const previousState = this.currentState;
    this.currentState = 'stopping';
    this.emitStateChange(previousState, this.currentState);
    this.connection.dispose();
    this.reader.dispose();
    this.writer.dispose();

    try {
      const closed = await raceTimeout(this.input.close(), this.shutdownTimeoutMilliseconds, 'language stdin close');
      if (!closed.ok) this.failureValue ??= `${closed.error.code}: process stdin close failed`;
    } catch (error) {
      this.failureValue ??= asErrorMessage(error);
    }

    let exited = false;
    try {
      await raceTimeout(this.handle.exit, this.shutdownTimeoutMilliseconds, 'language process exit');
      exited = true;
    } catch {
      // Terminate below; process adapters may not observe stdin close as a clean exit.
    }
    if (!exited) {
      try {
        await raceTimeout(this.handle.terminate(this.forceAfterMilliseconds),
          Math.max(this.forceAfterMilliseconds + this.shutdownTimeoutMilliseconds, 1), 'language process termination');
      } catch (error) {
        this.failureValue ??= asErrorMessage(error);
      }
      try {
        await raceTimeout(this.handle.exit, Math.max(this.forceAfterMilliseconds, 1), 'language process termination');
      } catch {
        this.failureValue ??= 'language process did not exit after termination';
      }
    }
    try {
      await raceTimeout(Promise.resolve(this.handle.dispose()), this.shutdownTimeoutMilliseconds, 'language process disposal');
    } catch (error) {
      this.failureValue ??= asErrorMessage(error);
    }
    const finalState = previousState === 'failed' ? 'failed' : 'stopped';
    this.currentState = finalState;
    this.emitStateChange('stopping', finalState);
  }

  private emitStateChange(previous: LanguageTransportState, current: LanguageTransportState): void {
    const change = Object.freeze({ previous, current, failure: this.failureValue });
    for (const listener of [...this.stateListeners]) {
      try {
        listener(change);
      } catch {
        // Observers cannot make transport cleanup fail or alter protocol state.
      }
    }
  }
}

export async function startLanguageTransport(options: LanguageTransportOptions): Promise<Result<LanguageTransport, LanguageStartFailure>> {
  return LanguageTransport.start(options);
}

export type { InitializeParams, InitializeResult } from 'vscode-languageserver-protocol/browser';
