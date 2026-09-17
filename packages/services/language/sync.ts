import { offsetToPosition as documentOffsetToPosition } from '../../document/src/index';
import type { CommittedDocumentChange, DocumentEdit, DocumentSnapshot, PositionEncoding } from '../../document/src/index';
import type { LanguageTransport } from './transport';

/** The subset of an LSP server's initialize result that controls text sync. */
export interface LanguageSyncServerCapabilities {
  readonly positionEncoding?: unknown;
  readonly textDocumentSync?: unknown;
}

export interface LanguageSyncDocument {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  /** Normalized LF text at exactly version. */
  readonly text: string;
}

export interface LanguageSyncOptions {
  readonly transport: Pick<LanguageTransport, 'notify'>;
  readonly capabilities?: LanguageSyncServerCapabilities;
  /** Keep a service-side queue bounded by collapsing unsent changes to the newest snapshot. */
  readonly maxQueuedChanges?: number;
  /** Bound pending replacement payload bytes before an explicit snapshot resync. */
  readonly maxQueuedBytes?: number;
  /** Full-sync servers are refused above this limit instead of retaining an unbounded snapshot. */
  readonly maxFullSyncUtf16?: number;
}

export type LanguageSyncFailure =
  | { readonly kind: 'invalid-document'; readonly message: string }
  | { readonly kind: 'stale-version'; readonly message: string }
  | { readonly kind: 'closed-document'; readonly message: string }
  | { readonly kind: 'document-too-large'; readonly message: string }
  | { readonly kind: 'unsupported-position'; readonly message: string }
  | { readonly kind: 'transport'; readonly message: string };

export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

export interface LanguageSyncSnapshot {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  readonly text: string;
  readonly openSent: boolean;
  readonly sentVersion: number | null;
}

interface SyncState {
  readonly uri: string;
  readonly languageId: string;
  desiredSnapshot: DocumentSnapshot;
  desiredText: string | undefined;
  sent: SyncSentDocument | undefined;
  pending: SyncChange[];
  pendingBytes: number;
  resyncNeeded: boolean;
  openSent: boolean;
  closeRequested: boolean;
  flushQueued: boolean;
  /** Pending macrotask that defers the flush enqueue off the synchronous commit path;
   * cleared on close/dispose so no stale timer fires against a removed document. */
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Guards a single automatic resync retry per failure episode; reset when new input arrives. */
  retryScheduled: boolean;
}

interface SyncSentDocument {
  readonly version: number;
  readonly snapshot: DocumentSnapshot;
}

interface SyncChange {
  readonly before: number;
  readonly after: number;
  readonly edits: readonly DocumentEdit[];
  readonly snapshot: DocumentSnapshot;
  readonly payloadBytes: number;
}

interface TextDocumentContentChangeEvent {
  readonly range?: LspRange;
  readonly text: string;
}

const DEFAULT_MAX_QUEUED_CHANGES = 64;
const DEFAULT_MAX_QUEUED_BYTES = 1 * 1024 * 1024;
const DEFAULT_MAX_FULL_SYNC_UTF16 = 8 * 1024 * 1024;
const SERIALIZE_CHUNK_UTF16 = 64 * 1024;
/**
 * Owns the versioned LSP text-document stream for one transport. It is fed only
 * committed snapshots; it never mutates a document. While a notification is in
 * flight, later commits replace one bounded pending target and are sent as one
 * valid edit from the server's last acknowledged baseline.
 */
export class LanguageDocumentSync {
  readonly #transport: Pick<LanguageTransport, 'notify'>;
  readonly #positionEncoding: PositionEncoding;
  readonly #changeSync: boolean;
  readonly #fullSync: boolean;
  readonly #maxQueuedChanges: number;
  readonly #maxQueuedBytes: number;
  readonly #maxFullSyncUtf16: number;
  readonly #documents = new Map<string, SyncState>();
  #tail: Promise<void> = Promise.resolve();
  #queuedOperations = 0;
  #lastFailure: LanguageSyncFailure | null = null;

  constructor(options: LanguageSyncOptions) {
    this.#transport = options.transport;
    this.#positionEncoding = negotiatePositionEncoding(options.capabilities?.positionEncoding);
    this.#changeSync = negotiatedChangeSync(options.capabilities?.textDocumentSync);
    this.#fullSync = negotiatedFullSync(options.capabilities?.textDocumentSync);
    this.#maxQueuedChanges = positiveBound(options.maxQueuedChanges, DEFAULT_MAX_QUEUED_CHANGES);
    this.#maxQueuedBytes = positiveBound(options.maxQueuedBytes, DEFAULT_MAX_QUEUED_BYTES);
    this.#maxFullSyncUtf16 = positiveBound(options.maxFullSyncUtf16, DEFAULT_MAX_FULL_SYNC_UTF16);
  }

  get positionEncoding(): PositionEncoding { return this.#positionEncoding; }
  get fullSync(): boolean { return this.#fullSync; }
  get supportsChangeSync(): boolean { return this.#changeSync; }
  get queuedChanges(): number { return this.#queuedOperations; }
  get queuedBytes(): number {
    let bytes = 0;
    for (const state of this.#documents.values()) bytes += state.pendingBytes;
    return bytes;
  }
  get lastFailure(): LanguageSyncFailure | null { return this.#lastFailure; }

  snapshot(uri: string): LanguageSyncSnapshot | undefined {
    const state = this.#documents.get(uri);
    if (state === undefined) return undefined;
    const text = state.desiredText === undefined
      ? materializeSnapshot(state.desiredSnapshot)
      : { ok: true as const, value: state.desiredText };
    if (!text.ok) throw new Error(text.error.message);
    return Object.freeze({
      uri: state.uri,
      languageId: state.languageId,
      version: state.desiredSnapshot.version as number,
      text: text.value,
      openSent: state.openSent,
      sentVersion: state.sent?.version ?? null,
    });
  }

  /** Admit an initial committed snapshot and enqueue didOpen before any didChange. */
  openDocument(document: LanguageSyncDocument): Promise<Result<void, LanguageSyncFailure>> {
    const valid = validateDocument(document);
    if (!valid.ok) return Promise.resolve(valid);
    if (this.#fullSync && document.text.length > this.#maxFullSyncUtf16) {
      const result: Result<void, LanguageSyncFailure> = { ok: false, error: { kind: 'document-too-large', message: `full-sync document ${document.uri} exceeds ${this.#maxFullSyncUtf16} UTF-16 units` } };
      this.#lastFailure = result.error;
      return Promise.resolve(result);
    }
    if (this.#documents.has(document.uri)) {
      return Promise.resolve(failure('closed-document', `document ${document.uri} is already open`));
    }
    // Build the open-time line table once; it is reused as-is for the
    // acknowledged "sent" baseline below instead of re-scanning the whole
    // document a second time.
    const openSnapshot = snapshotLike(document);
    const state: SyncState = {
      uri: document.uri,
      languageId: document.languageId,
      desiredSnapshot: openSnapshot,
      desiredText: document.text,
      sent: undefined,
      pending: [],
      pendingBytes: 0,
      resyncNeeded: false,
      openSent: false,
      closeRequested: false,
      flushQueued: false,
      flushTimer: undefined,
      retryScheduled: false,
    };
    this.#documents.set(document.uri, state);
    return this.enqueue(async () => {
      if (this.#documents.get(document.uri) !== state) return failure('closed-document', `document ${document.uri} was closed before didOpen`);
      try {
        await this.#transport.notify('textDocument/didOpen', { textDocument: { uri: state.uri, languageId: state.languageId, version: document.version, text: document.text } });
        state.sent = { version: document.version, snapshot: openSnapshot };
        state.openSent = true;
        return ok();
      } catch (error: unknown) {
        return this.transportFailure(error);
      }
    });
  }

  open(document: LanguageSyncDocument): Promise<Result<void, LanguageSyncFailure>> {
    return this.openDocument(document);
  }

  /**
   * Admit a committed document change. The change must be exactly the next Xi
   * version; stale or post-close changes are rejected before they can queue I/O.
   */
  acceptChange(change: CommittedDocumentChange, uri = String(change.documentId)): Result<void, LanguageSyncFailure> {
    const state = this.#documents.get(uri);
    if (state === undefined || state.closeRequested) return failure('closed-document', `document ${String(change.documentId)} is closed`);
    const desiredVersion = state.desiredSnapshot.version as number;
    if (change.before !== desiredVersion || change.after !== change.before + 1) {
      return failure('stale-version', `expected change ${desiredVersion}->${desiredVersion + 1}, got ${change.before}->${change.after}`);
    }
    const payloadBytes = editPayloadBytes(change.edits);
    state.desiredSnapshot = change.snapshot;
    state.desiredText = undefined;
    // New input may resolve whatever made the previous flush fail; allow one
    // more automatic retry to be scheduled for it.
    state.retryScheduled = false;
    if (!state.resyncNeeded && (state.pending.length >= this.#maxQueuedChanges || state.pendingBytes + payloadBytes > this.#maxQueuedBytes)) {
      // The latest immutable snapshot is enough for an explicit resync. Do not
      // retain every intermediate text version or flatten the committed root.
      state.pending = [];
      state.pendingBytes = 0;
      state.resyncNeeded = true;
    }
    if (!state.resyncNeeded) {
      state.pending.push(Object.freeze({ before: change.before as number, after: change.after as number, edits: Object.freeze([...change.edits]), snapshot: change.snapshot, payloadBytes }));
      state.pendingBytes += payloadBytes;
    }
    if (!state.flushQueued) {
      state.flushQueued = true;
      // Deferred to a macrotask: the caller's synchronous commit path (and the
      // frame it paints) must not pay for materializing/JSON-encoding the
      // document on backpressure or full-sync. `flushTimer` is cleared on
      // close/dispose so a stale timer never fires against a removed document.
      state.flushTimer = setTimeout(() => {
        state.flushTimer = undefined;
        this.enqueue(async () => this.flushState(state));
      }, 0);
    }
    return ok();
  }

  change(change: CommittedDocumentChange, uri?: string): Result<void, LanguageSyncFailure> {
    return this.acceptChange(change, uri);
  }

  /** Convenience for adapters that only have the newest immutable snapshot. */
  acceptSnapshot(document: LanguageSyncDocument): Result<void, LanguageSyncFailure> {
    const state = this.#documents.get(document.uri);
    if (state === undefined || state.closeRequested) return failure('closed-document', `document ${document.uri} is closed`);
    if (!Number.isSafeInteger(document.version) || document.version !== (state.desiredSnapshot.version as number) + 1) {
      return failure('stale-version', `expected document version ${(state.desiredSnapshot.version as number) + 1}, got ${document.version}`);
    }
    const previousText = state.desiredText === undefined
      ? materializeSnapshot(state.desiredSnapshot)
      : { ok: true as const, value: state.desiredText };
    if (!previousText.ok) return previousText;
    const change = diff(previousText.value, document.text);
    const synthetic = {
      documentId: document.uri,
      before: state.desiredSnapshot.version,
      after: document.version,
      edits: [{ start: change.start as never, end: change.oldEnd as never, text: change.replacement }],
      snapshot: snapshotLike(document),
    } as unknown as CommittedDocumentChange;
    return this.acceptChange(synthetic);
  }

  /** Drain the accepted changes, then send didClose exactly once. */
  closeDocument(uri: string): Promise<Result<void, LanguageSyncFailure>> {
    const state = this.#documents.get(uri);
    if (state === undefined) return Promise.resolve(ok());
    if (state.closeRequested) return this.whenIdle().then(() => ok());
    state.closeRequested = true;
    if (state.flushTimer !== undefined) {
      clearTimeout(state.flushTimer);
      state.flushTimer = undefined;
    }
    return this.enqueue(async () => {
      const flushed = await this.flushState(state);
      if (!flushed.ok) {
        this.#documents.delete(uri);
        return flushed;
      }
      if (!state.openSent) {
        this.#documents.delete(uri);
        return ok();
      }
      try {
        await this.#transport.notify('textDocument/didClose', { textDocument: { uri } });
        this.#documents.delete(uri);
        return ok();
      } catch (error: unknown) {
        this.#documents.delete(uri);
        return this.transportFailure(error);
      }
    });
  }

  close(uri: string): Promise<Result<void, LanguageSyncFailure>> {
    return this.closeDocument(uri);
  }

  /** Wait for all accepted notifications, useful for lifecycle and deterministic tests. */
  async whenIdle(): Promise<void> {
    await this.#tail;
  }

  /** Stop accepting new state and wait for already admitted notifications. */
  async dispose(): Promise<void> {
    const uris = [...this.#documents.keys()];
    for (const uri of uris) void this.closeDocument(uri);
    await this.whenIdle();
  }

  private async flushState(state: SyncState): Promise<Result<void, LanguageSyncFailure>> {
    state.flushQueued = false;
    if (!state.openSent || state.sent === undefined) {
      // didOpen is always earlier in the same serial queue. A state can only
      // reach this branch after a failed/open-disposed operation.
      return failure('closed-document', `document ${state.uri} didOpen was not acknowledged`);
    }
    if (state.pending.length === 0 && !state.resyncNeeded) return ok();
    const sent = state.sent;
    const pending = state.pending;
    const pendingBytes = state.pendingBytes;
    const needsResync = state.resyncNeeded;
    state.pending = [];
    state.pendingBytes = 0;
    state.resyncNeeded = false;
    if (!this.#changeSync) {
      state.sent = { version: state.desiredSnapshot.version as number, snapshot: state.desiredSnapshot };
      return ok();
    }
    const target = state.desiredSnapshot;
    let contentChanges: readonly TextDocumentContentChangeEvent[];
    if (needsResync || this.#fullSync) {
      const text = materializeSnapshot(target);
      if (!text.ok) {
        state.pending = pending;
        state.pendingBytes = pendingBytes;
        state.resyncNeeded = true;
        this.scheduleResyncRetry(state);
        return text;
      }
      if (text.value.length > this.#maxFullSyncUtf16) {
        const result: Result<void, LanguageSyncFailure> = { ok: false, error: { kind: 'document-too-large', message: `full-sync document ${state.uri} exceeds ${this.#maxFullSyncUtf16} UTF-16 units` } };
        state.pending = pending;
        state.pendingBytes = pendingBytes;
        state.resyncNeeded = needsResync || pending.length !== 0;
        this.#lastFailure = result.error;
        this.scheduleResyncRetry(state);
        return result;
      }
      contentChanges = [{ text: text.value }];
    } else {
      const changes: TextDocumentContentChangeEvent[] = [];
      let baseline = sent;
      for (const change of pending) {
        if (baseline === undefined || baseline.version !== change.before) {
          state.pending = pending;
          state.pendingBytes = pendingBytes;
          state.resyncNeeded = true;
          return this.flushState(state);
        }
        const mapped = this.incrementalChanges(baseline.snapshot, change.edits);
        if (!mapped.ok) {
          state.pending = pending;
          state.pendingBytes = pendingBytes;
          state.resyncNeeded = true;
          this.scheduleResyncRetry(state);
          return mapped;
        }
        changes.push(...mapped.value);
        baseline = { version: change.after, snapshot: change.snapshot };
      }
      contentChanges = changes;
    }
    try {
      await this.#transport.notify('textDocument/didChange', {
        textDocument: { uri: state.uri, version: target.version as number },
        contentChanges,
      });
      state.sent = { version: target.version as number, snapshot: target };
      if ((state.pending.length !== 0 || state.resyncNeeded) && !state.closeRequested && !state.flushQueued) {
        state.flushQueued = true;
        this.enqueue(async () => this.flushState(state));
      }
      return ok();
    } catch (error: unknown) {
      const result: Result<void, LanguageSyncFailure> = this.transportFailure(error);
      if (!result.ok) this.#lastFailure = result.error;
      return result;
    }
  }

  private incrementalChanges(snapshot: DocumentSnapshot, edits: readonly DocumentEdit[]): Result<readonly TextDocumentContentChangeEvent[], LanguageSyncFailure> {
    const output: TextDocumentContentChangeEvent[] = [];
    // LSP applies a notification's ranges in order. Reverse document-order
    // edits keep every range in the unchanged base snapshot coordinate space.
    for (let index = edits.length - 1; index >= 0; index -= 1) {
      const edit = edits[index];
      if (edit === undefined) continue;
      const start = documentOffsetToPosition(snapshot, edit.start, this.#positionEncoding);
      const end = documentOffsetToPosition(snapshot, edit.end, this.#positionEncoding);
      if (!start.ok || !end.ok) return failure('unsupported-position', `cannot encode ${snapshot.version} edit coordinates for ${snapshot.id}`);
      output.push({
        range: {
          start: { line: start.value.line as number, character: start.value.character as number },
          end: { line: end.value.line as number, character: end.value.character as number },
        },
        text: edit.text,
      });
    }
    return { ok: true, value: Object.freeze(output) };
  }

  /**
   * A failed resync/materialize attempt otherwise leaves `resyncNeeded` set
   * with nothing scheduled to act on it, so the document silently stops
   * syncing until the next edit. Schedule exactly one automatic retry per
   * failure episode (bounded by `retryScheduled`, reset on new input) so a
   * transient failure heals itself without spinning the queue forever on a
   * persistent one.
   */
  private scheduleResyncRetry(state: SyncState): void {
    if (state.closeRequested || state.flushQueued || state.retryScheduled) return;
    state.retryScheduled = true;
    state.flushQueued = true;
    this.enqueue(async () => this.flushState(state));
  }

  private enqueue(operation: () => Promise<Result<void, LanguageSyncFailure>>): Promise<Result<void, LanguageSyncFailure>> {
    this.#queuedOperations += 1;
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined).finally(() => {
      this.#queuedOperations = Math.max(0, this.#queuedOperations - 1);
    });
    return result;
  }

  private transportFailure(error: unknown): Result<void, LanguageSyncFailure> {
    const message = error instanceof Error ? error.message : 'language transport notification failed';
    return failure('transport', message);
  }
}

export function negotiatePositionEncoding(value: unknown): PositionEncoding {
  return value === 'utf-8' || value === 'utf-16' || value === 'utf-32' ? value : 'utf-16';
}

export function offsetToPosition(text: string, offset: number, encoding: PositionEncoding): LspPosition {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || isSurrogateMidpoint(text, offset)) {
    throw new RangeError('position offset is not a safe text boundary');
  }
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const segment = text.slice(lineStart, offset);
  return Object.freeze({
    line: countLineFeeds(text, lineStart),
    character: encodedLength(segment, encoding),
  });
}

export function positionToOffset(text: string, position: LspPosition, encoding: PositionEncoding): Result<number, LanguageSyncFailure> {
  if (!Number.isSafeInteger(position.line) || position.line < 0 || !Number.isSafeInteger(position.character) || position.character < 0) {
    return failure('invalid-document', 'LSP position line/character must be non-negative safe integers');
  }
  let lineStart = 0;
  for (let line = 0; line < position.line; line += 1) {
    const lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd < 0) return failure('invalid-document', 'LSP position line is outside the document');
    lineStart = lineEnd + 1;
  }
  const lineEnd = text.indexOf('\n', lineStart);
  const end = lineEnd < 0 ? text.length : lineEnd;
  const lineText = text.slice(lineStart, end);
  let offset = encodedOffset(lineText, position.character, encoding);
  if (offset === undefined) return failure('invalid-document', 'LSP position is outside the line or splits a Unicode scalar');
  offset += lineStart;
  return { ok: true, value: offset };
}

function encodedLength(text: string, encoding: PositionEncoding): number {
  switch (encoding) {
    case 'utf-8': return new TextEncoder().encode(text).byteLength;
    case 'utf-16': return text.length;
    case 'utf-32': return [...text].length;
    default: return 0;
  }
}

function encodedOffset(text: string, character: number, encoding: PositionEncoding): number | undefined {
  if (character === 0) return 0;
  if (encoding === 'utf-16') {
    if (character > text.length || isSurrogateMidpoint(text, character)) return undefined;
    return character;
  }
  let measured = 0;
  let offset = 0;
  for (const scalar of text) {
    const units = encodedLength(scalar, encoding);
    if (measured + units > character) return undefined;
    measured += units;
    offset += scalar.length;
    if (measured === character) return offset;
  }
  return measured === character ? offset : undefined;
}

function diff(before: string, after: string): { readonly start: number; readonly oldEnd: number; readonly replacement: string } {
  let start = 0;
  const limit = Math.min(before.length, after.length);
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
  if (isSurrogateMidpoint(before, start) || isSurrogateMidpoint(after, start)) start -= 1;
  let suffix = 0;
  while (suffix < before.length - start && suffix < after.length - start
    && before.charCodeAt(before.length - suffix - 1) === after.charCodeAt(after.length - suffix - 1)) suffix += 1;
  if (isSurrogateMidpoint(before, before.length - suffix) || isSurrogateMidpoint(after, after.length - suffix)) suffix -= 1;
  const oldEnd = before.length - suffix;
  const newEnd = after.length - suffix;
  return { start, oldEnd, replacement: after.slice(start, newEnd) };
}

function isSurrogateMidpoint(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

function countLineFeeds(text: string, endExclusive: number): number {
  let count = 0;
  for (let index = 0; index < endExclusive; index += 1) if (text.charCodeAt(index) === 10) count += 1;
  return count;
}

function negotiatedFullSync(value: unknown): boolean {
  if (value === 1) return true;
  if (value === 2) return false;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const change = (value as { readonly change?: unknown }).change;
    return change === 1;
  }
  return false;
}

function negotiatedChangeSync(value: unknown): boolean {
  if (value === 0) return false;
  if (value === 1 || value === 2) return true;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const change = (value as { readonly change?: unknown }).change;
    return change !== 0;
  }
  return true;
}

function positiveBound(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fallback;
}

function validateDocument(document: LanguageSyncDocument): Result<void, LanguageSyncFailure> {
  return typeof document.uri === 'string' && document.uri.length > 0
    && typeof document.languageId === 'string' && document.languageId.length > 0
    && Number.isSafeInteger(document.version) && document.version >= 0
    && typeof document.text === 'string' && isWellFormed(document.text)
    ? ok()
    : failure('invalid-document', 'language document URI, language ID, version or text is invalid');
}

// Pinned Bun/V8 exposes String.prototype.isWellFormed (no lone surrogates).
// Fall back to a plain charCode scan; either way this avoids allocating a
// per-code-point array (Array.from(text)) for the whole document.
const SUPPORTS_IS_WELL_FORMED = typeof (String.prototype as { isWellFormed?: unknown }).isWellFormed === 'function';

function isWellFormed(text: string): boolean {
  if (SUPPORTS_IS_WELL_FORMED) return (text as unknown as { isWellFormed(): boolean }).isWellFormed();
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function editPayloadBytes(edits: readonly DocumentEdit[]): number {
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const edit of edits) bytes += encoder.encode(edit.text).byteLength;
  return bytes;
}

function materializeSnapshot(snapshot: DocumentSnapshot): Result<string, LanguageSyncFailure> {
  const chunks: string[] = [];
  let start = 0;
  while (start < snapshot.lengthUtf16) {
    let end = Math.min(snapshot.lengthUtf16, start + SERIALIZE_CHUNK_UTF16);
    let read = false;
    while (end > start) {
      const result = snapshot.slice(start as never, end as never);
      if (result.ok) {
        chunks.push(result.value);
        start = end;
        read = true;
        break;
      }
      if (result.error.kind !== 'surrogate-split') return failure('invalid-document', `snapshot serialization failed: ${result.error.kind}`);
      end -= 1;
    }
    if (!read) return failure('invalid-document', 'snapshot serialization could not find a safe UTF-16 chunk');
  }
  return { ok: true, value: chunks.join('') };
}

function snapshotLike(document: LanguageSyncDocument): DocumentSnapshot {
  const lineStarts = [0];
  const lineUtf8Starts = [0];
  const lineUtf32Starts = [0];
  let utf8 = 0;
  let utf32 = 0;
  for (let offset = 0; offset < document.text.length;) {
    const codePoint = document.text.codePointAt(offset) ?? 0;
    const units = codePoint > 0xffff ? 2 : 1;
    utf8 += utf8Length(codePoint);
    utf32 += 1;
    offset += units;
    if (codePoint === 10) {
      lineStarts.push(offset);
      lineUtf8Starts.push(utf8);
      lineUtf32Starts.push(utf32);
    }
  }
  return {
    id: document.uri as never,
    version: document.version as never,
    revisionId: 1 as never,
    lengthUtf16: document.text.length,
    lineCount: lineStarts.length,
    readOnly: false,
    slice: (start: never, end: never) => {
      const startValue = start as number;
      const endValue = end as number;
      return validTextRange(document.text, startValue, endValue)
        ? { ok: true, value: document.text.slice(startValue, endValue) }
        : { ok: false, error: { kind: 'invalid-range' as const } };
    },
    lineIndexAt: (offset: never) => {
      const value = offset as number;
      if (!validTextBoundary(document.text, value)) return { ok: false, error: boundaryFailure(document.text, value) };
      return { ok: true, value: upperBound(lineStarts, value) as never };
    },
    lineStartOffset: (line: never) => {
      const value = line as number;
      return value >= 0 && value < lineStarts.length
        ? { ok: true, value: lineStarts[value] as never }
        : { ok: false, error: { kind: 'invalid-line' as const } };
    },
    utf8OffsetAt: (offset: never) => {
      const value = offset as number;
      if (!validTextBoundary(document.text, value)) return { ok: false, error: boundaryFailure(document.text, value) };
      const line = upperBound(lineStarts, value);
      let bytes = lineUtf8Starts[line] ?? 0;
      for (let cursor = lineStarts[line] ?? 0; cursor < value;) {
        const codePoint = document.text.codePointAt(cursor) ?? 0;
        bytes += utf8Length(codePoint);
        cursor += codePoint > 0xffff ? 2 : 1;
      }
      return { ok: true, value: bytes as never };
    },
    utf32OffsetAt: (offset: never) => {
      const value = offset as number;
      if (!validTextBoundary(document.text, value)) return { ok: false, error: boundaryFailure(document.text, value) };
      const line = upperBound(lineStarts, value);
      let scalars = lineUtf32Starts[line] ?? 0;
      for (let cursor = lineStarts[line] ?? 0; cursor < value;) {
        const codePoint = document.text.codePointAt(cursor) ?? 0;
        scalars += 1;
        cursor += codePoint > 0xffff ? 2 : 1;
      }
      return { ok: true, value: scalars as never };
    },
    offsetAtUtf8: (offset: never) => offsetInEncodedText(document.text, lineStarts, lineUtf8Starts, offset as number, 'utf-8'),
    offsetAtUtf32: (offset: never) => offsetInEncodedText(document.text, lineStarts, lineUtf32Starts, offset as number, 'utf-32'),
  } as DocumentSnapshot;
}

function validTextRange(text: string, start: number, end: number): boolean {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && end <= text.length
    && validTextBoundary(text, start) && validTextBoundary(text, end);
}

function validTextBoundary(text: string, offset: number): boolean {
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= text.length && !isSurrogateMidpoint(text, offset);
}

function boundaryFailure(text: string, offset: number): { readonly kind: 'invalid-range' | 'surrogate-split' } {
  return isSurrogateMidpoint(text, offset) ? { kind: 'surrogate-split' } : { kind: 'invalid-range' };
}

function upperBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low + 1 < high) {
    const middle = low + Math.floor((high - low) / 2);
    const value = values[middle];
    if (value === undefined || value > target) high = middle;
    else low = middle;
  }
  return low;
}

function utf8Length(codePoint: number): number {
  return codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
}

function offsetInEncodedText(
  text: string,
  lineStarts: readonly number[],
  lineEncodedStarts: readonly number[],
  encodedOffset: number,
  encoding: 'utf-8' | 'utf-32',
): Result<never, LanguageSyncFailure> | { readonly ok: true; readonly value: never } {
  if (!Number.isSafeInteger(encodedOffset) || encodedOffset < 0) return { ok: false, error: { kind: 'invalid-document', message: 'encoded position is invalid' } };
  const line = upperBound(lineEncodedStarts, encodedOffset);
  let cursor = lineStarts[line] ?? 0;
  let measured = lineEncodedStarts[line] ?? 0;
  while (cursor < text.length) {
    const codePoint = text.codePointAt(cursor) ?? 0;
    const width = encoding === 'utf-8' ? utf8Length(codePoint) : 1;
    if (measured + width > encodedOffset) return { ok: false, error: { kind: 'invalid-document', message: 'encoded position splits a Unicode scalar' } };
    measured += width;
    cursor += codePoint > 0xffff ? 2 : 1;
    if (measured === encodedOffset) return { ok: true, value: cursor as never };
    if (codePoint === 10) break;
  }
  return { ok: false, error: { kind: 'invalid-document', message: 'encoded position is outside the document' } };
}

type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };
function ok(): Result<void, LanguageSyncFailure> { return { ok: true, value: undefined }; }
function failure(kind: LanguageSyncFailure['kind'], message: string): Result<never, LanguageSyncFailure> { return { ok: false, error: { kind, message } }; }
