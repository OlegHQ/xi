import type {
  Disposable,
  DocumentId,
  DocumentVersion,
  RequestId,
  Result,
  WorkspaceId,
} from '../../contracts/src/index';
import {
  initializeTreeSitterRuntime,
  loadTreeSitterGrammar,
  TREE_SITTER_RUNTIME_VERSION,
  type LoadedTreeSitterGrammar,
  type TreeSitterFailure,
  type TreeSitterRuntime,
} from './tree-sitter';

export { initializeTreeSitterRuntime, loadTreeSitterGrammar, TREE_SITTER_RUNTIME_VERSION } from './tree-sitter';
export type { LoadedTreeSitterGrammar, TreeSitterFailure, TreeSitterRuntime } from './tree-sitter';

/** UTF-16 offsets are used throughout the syntax service, matching Document. */
export type SyntaxTokenKind =
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'boolean'
  | 'type'
  | 'function'
  | 'operator'
  | 'punctuation';

export interface SyntaxHighlightSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: SyntaxTokenKind;
}

export interface SyntaxDelta {
  readonly start: number;
  readonly oldEnd: number;
  readonly newEnd: number;
}

export interface SyntaxParseRequest {
  readonly workspaceId?: WorkspaceId;
  readonly documentId: DocumentId;
  readonly documentVersion: DocumentVersion;
  readonly requestId: RequestId;
  /** Service generation. A result from an older generation is never applied. */
  readonly generation: number;
  /** Immutable text from exactly documentVersion, measured in UTF-16 units. */
  readonly text: string;
  readonly delta?: SyntaxDelta;
  /** Language identity is metadata for a future Tree-sitter grammar selection. */
  readonly languageId?: string;
}

export type SyntaxFallback = 'grammar-missing' | 'parser-crash' | 'giant-line' | 'large-file';

export type SyntaxFailure =
  | { readonly kind: 'queue-full'; readonly message: string }
  | { readonly kind: 'stale-result'; readonly message: string }
  | { readonly kind: 'disposed'; readonly message: string }
  | { readonly kind: 'invalid-input'; readonly message: string }
  | { readonly kind: 'grammar-missing'; readonly message: string }
  | { readonly kind: 'parser-crash'; readonly message: string }
  | { readonly kind: 'giant-line'; readonly message: string }
  | { readonly kind: 'large-file'; readonly message: string };

export interface SyntaxParseStats {
  readonly totalLines: number;
  readonly reparsedLines: number;
  readonly reusedLines: number;
  readonly queueDepth: number;
  readonly elapsedMilliseconds: number;
}

export interface SyntaxHighlightResult {
  readonly documentId: DocumentId;
  readonly documentVersion: DocumentVersion;
  readonly requestId: RequestId;
  readonly generation: number;
  readonly status: 'highlighted' | 'plain-text' | 'large-file';
  readonly fallback: SyntaxFallback | null;
  readonly spans: readonly SyntaxHighlightSpan[];
  readonly stats: SyntaxParseStats;
}

export interface SyntaxSubmitAccepted {
  readonly accepted: true;
  readonly sequence: number;
}

export interface SyntaxSubmitRejected {
  readonly accepted: false;
  readonly error: SyntaxFailure;
}

export type SyntaxSubmitResult = SyntaxSubmitAccepted | SyntaxSubmitRejected;

export interface SyntaxHighlighterOptions {
  /** Maximum queued parse requests. Newest input is always retained. */
  readonly maxPendingRequests?: number;
  /** Maximum UTF-16 units retained across queued and active parse requests. */
  readonly maxPendingUtf16Units?: number;
  /** Maximum UTF-16 units before the service displays plain text. */
  readonly maxDocumentUnits?: number;
  /** Maximum UTF-16 units per line before the service displays plain text. */
  readonly maxLineUnits?: number;
  /** Injected task scheduler; production yields through a cancellable timer. */
  readonly schedule?: (task: () => void) => void;
}

export interface SyntaxServiceDiagnostics {
  readonly queued: number;
  readonly completed: number;
  readonly dropped: number;
  readonly staleIgnored: number;
  readonly parserCrashes: number;
  readonly grammarFallbacks: number;
  readonly maxObservedQueue: number;
  readonly queuedUtf16Units: number;
  readonly maxObservedQueuedUtf16Units: number;
  readonly resumableSlices: number;
  readonly resyncs: number;
}

type LexStateKind = 'normal' | 'block-comment' | 'single-string' | 'double-string';
interface LexState {
  readonly kind: LexStateKind;
  readonly escaped: boolean;
}

interface LineCache {
  readonly text: string;
  readonly startState: LexState;
  readonly endState: LexState;
  readonly spans: readonly SyntaxHighlightSpan[];
}

interface ParseCache {
  readonly documentId: DocumentId;
  readonly documentVersion: DocumentVersion;
  readonly text: string;
  readonly lineStarts: readonly number[];
  readonly lines: readonly LineCache[];
}

interface QueuedRequest {
  readonly request: SyntaxParseRequest;
  readonly sequence: number;
}

function freezeSyntaxRequest(request: SyntaxParseRequest): SyntaxParseRequest {
  return Object.freeze({
    documentId: request.documentId,
    documentVersion: request.documentVersion,
    requestId: request.requestId,
    generation: request.generation,
    text: request.text,
    ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
    ...(request.delta === undefined ? {} : { delta: Object.freeze({
      start: request.delta.start,
      oldEnd: request.delta.oldEnd,
      newEnd: request.delta.newEnd,
    }) }),
    ...(request.languageId === undefined ? {} : { languageId: request.languageId }),
  });
}

const DEFAULT_MAX_PENDING_REQUESTS = 3;
const DEFAULT_MAX_DOCUMENT_UNITS = 2_000_000;
const DEFAULT_MAX_LINE_UNITS = 32_768;
const EMPTY_STATE: LexState = Object.freeze({ kind: 'normal', escaped: false });

const KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements',
  'import', 'in', 'instanceof', 'interface', 'let', 'new', 'of', 'package', 'private', 'protected', 'public',
  'return', 'set', 'static', 'super', 'switch', 'this', 'throw', 'try', 'type', 'typeof', 'var', 'void', 'while',
  'with', 'yield', 'enum', 'namespace', 'declare', 'readonly', 'keyof', 'satisfies',
]);
const BOOLEAN_LITERALS = new Set(['true', 'false', 'null', 'undefined']);
const TYPE_WORDS = new Set(['string', 'number', 'boolean', 'unknown', 'never', 'any', 'object', 'bigint', 'symbol']);

function freezeSpan(start: number, end: number, kind: SyntaxTokenKind): SyntaxHighlightSpan {
  return Object.freeze({ start, end, kind });
}

function copyState(state: LexState): LexState {
  return Object.freeze({ kind: state.kind, escaped: state.escaped });
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (next < 0xDC00 || next > 0xDFFF) return true;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

function isIdentifierStart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z_$]/u.test(character);
}

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_$]/u.test(character);
}

function* scanLine(text: string, initial: LexState): Generator<void, LineCache, void> {
  const spans: SyntaxHighlightSpan[] = [];
  let state = copyState(initial);
  let index = 0;
  let nextYield = 2_048;
  const span = (start: number, end: number, kind: SyntaxTokenKind): void => {
    if (end > start) spans.push(freezeSpan(start, end, kind));
  };

  while (index < text.length) {
    if (state.kind === 'block-comment') {
      const start = index;
      let close = -1;
      while (index < text.length) {
        if (text[index] === '*' && text[index + 1] === '/') {
          close = index;
          break;
        }
        index += 1;
        if (index >= nextYield) {
          nextYield = index + 2_048;
          yield;
        }
      }
      if (close < 0) {
        span(start, text.length, 'comment');
        return Object.freeze({ text, startState: initial, endState: state, spans: Object.freeze(spans) });
      }
      span(start, close + 2, 'comment');
      index = close + 2;
      if (index >= nextYield) {
        nextYield = index + 2_048;
        yield;
      }
      state = EMPTY_STATE;
      continue;
    }
    if (state.kind === 'single-string' || state.kind === 'double-string') {
      const quote = state.kind === 'single-string' ? "'" : '"';
      const start = index;
      let escaped = state.escaped;
      while (index < text.length) {
        const character = text[index];
        if (character === undefined) break;
        if (escaped) {
          escaped = false;
          index += 1;
          if (index >= nextYield) {
            nextYield = index + 2_048;
            yield;
          }
          continue;
        }
        if (character === '\\') {
          escaped = true;
          index += 1;
          if (index >= nextYield) {
            nextYield = index + 2_048;
            yield;
          }
          continue;
        }
        index += 1;
        if (index >= nextYield) {
          nextYield = index + 2_048;
          yield;
        }
        if (character === quote) {
          state = EMPTY_STATE;
          break;
        }
      }
      span(start, index, 'string');
      if (state.kind !== 'normal') state = Object.freeze({ kind: state.kind, escaped });
      continue;
    }

    const character = text[index];
    const next = text[index + 1];
    if (character === undefined) break;
    if (character === '/' && next === '/') {
      span(index, text.length, 'comment');
      break;
    }
    if (character === '/' && next === '*') {
      const close = text.indexOf('*/', index + 2);
      if (close < 0) {
        span(index, text.length, 'comment');
        state = Object.freeze({ kind: 'block-comment', escaped: false });
        break;
      }
      span(index, close + 2, 'comment');
      index = close + 2;
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      const start = index;
      let escaped = false;
      index += 1;
      let closed = false;
      while (index < text.length) {
        const current = text[index];
        if (current === undefined) break;
        if (escaped) {
          escaped = false;
          index += 1;
          if (index >= nextYield) {
            nextYield = index + 2_048;
            yield;
          }
          continue;
        }
        if (current === '\\') {
          escaped = true;
          index += 1;
          if (index >= nextYield) {
            nextYield = index + 2_048;
            yield;
          }
          continue;
        }
        index += 1;
        if (index >= nextYield) {
          nextYield = index + 2_048;
          yield;
        }
        if (current === quote) { closed = true; break; }
      }
      span(start, index, 'string');
      if (!closed) state = Object.freeze({ kind: quote === "'" ? 'single-string' : 'double-string', escaped });
      continue;
    }
    if (/[0-9]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < text.length && /[0-9A-Fa-f_xobn.]/u.test(text[index] ?? '')) {
        index += 1;
        if (index >= nextYield) {
          nextYield = index + 2_048;
          yield;
        }
      }
      span(start, index, 'number');
      continue;
    }
    if (isIdentifierStart(character)) {
      const start = index;
      index += 1;
      while (isIdentifierPart(text[index])) {
        index += 1;
        if (index >= nextYield) {
          nextYield = index + 2_048;
          yield;
        }
      }
      const word = text.slice(start, index);
      const kind: SyntaxTokenKind | undefined = BOOLEAN_LITERALS.has(word)
        ? 'boolean'
        : TYPE_WORDS.has(word)
          ? 'type'
          : KEYWORDS.has(word)
            ? 'keyword'
            : (() => {
              let look = index;
              while (/\s/u.test(text[look] ?? '')) look += 1;
              return text[look] === '(' ? 'function' : undefined;
            })();
      if (kind !== undefined) span(start, index, kind);
      continue;
    }
    if (/[+\-*%=!<>?&|^~]/u.test(character)) {
      const start = index;
      index += 1;
      while (/[=|&>]/u.test(text[index] ?? '') && index < text.length) {
        index += 1;
        if (index >= nextYield) {
          nextYield = index + 2_048;
          yield;
        }
      }
      span(start, index, 'operator');
      continue;
    }
    if (/[{}()[\];,.:]/u.test(character)) {
      span(index, index + 1, 'punctuation');
    }
    index += 1;
    if (index >= nextYield) {
      nextYield = index + 2_048;
      yield;
    }
  }
  return Object.freeze({ text, startState: initial, endState: state, spans: Object.freeze(spans) });
}

function plainResult(request: SyntaxParseRequest, status: 'plain-text' | 'large-file', fallback: SyntaxFallback, totalLines: number, queueDepth: number, elapsedMilliseconds: number): SyntaxHighlightResult {
  return Object.freeze({
    documentId: request.documentId,
    documentVersion: request.documentVersion,
    requestId: request.requestId,
    generation: request.generation,
    status,
    fallback,
    spans: Object.freeze([]),
    stats: Object.freeze({ totalLines, reparsedLines: 0, reusedLines: 0, queueDepth, elapsedMilliseconds }),
  });
}

interface ResumableParseOutcome {
  readonly result: SyntaxHighlightResult;
  readonly cache: ParseCache | undefined;
}

type ResumableParse = Generator<void, ResumableParseOutcome, void>;

interface LineBoundary {
  readonly end: number;
  readonly newline: number;
  readonly tooLong: boolean;
}

/** Find one line cooperatively and stop before copying an overlong line. */
function* findLineBoundary(text: string, start: number, maxLineUnits: number): Generator<void, LineBoundary, void> {
  let index = start;
  let nextYield = start + 2_048;
  while (index < text.length) {
    if (text[index] === '\n') return { end: index, newline: index, tooLong: false };
    if (index - start >= maxLineUnits) return { end: index, newline: -1, tooLong: true };
    index += 1;
    if (index >= nextYield) {
      nextYield = index + 2_048;
      yield;
    }
  }
  return { end: index, newline: -1, tooLong: false };
}

/**
 * Parse one immutable request in bounded line slices. The request string is a
 * read replica supplied by the caller; it is never transferred or mutated. A
 * slice yields through the scheduler before another line batch is scanned.
 */
function* parseResumable(
  request: SyntaxParseRequest,
  previous: ParseCache | undefined,
  maxDocumentUnits: number,
  maxLineUnits: number,
  queueDepth: number,
): ResumableParse {
  const started = performance.now();
  if (request.text.length > maxDocumentUnits) {
    return {
      result: plainResult(request, 'large-file', 'large-file', 1, queueDepth, performance.now() - started),
      cache: undefined,
    };
  }

  const lineStarts: number[] = [];
  const lines: LineCache[] = [];
  const spans: SyntaxHighlightSpan[] = [];
  let state = EMPTY_STATE;
  let lineStart = 0;
  let lineIndex = 0;
  let sliceUnits = 0;
  let reparsedLines = 0;
  let reusedLines = 0;
  let lastYield = performance.now();
  const canReuse = request.delta !== undefined && previous !== undefined
    && previous.documentId === request.documentId
    && (request.documentVersion as number) === (previous.documentVersion as number) + 1;

  while (lineStart <= request.text.length) {
    const boundary = yield* findLineBoundary(request.text, lineStart, maxLineUnits);
    if (boundary.tooLong) {
      return {
        result: plainResult(request, 'plain-text', 'giant-line', lineIndex + 1, queueDepth, performance.now() - started),
        cache: undefined,
      };
    }
    const text = request.text.slice(lineStart, boundary.end);
    if (hasUnpairedSurrogate(text)) throw new Error('syntax-parser-input-surrogate-failure');
    lineStarts.push(lineStart);

    const old = canReuse ? previous.lines[lineIndex] : undefined;
    const cached = old !== undefined && old.text === text
      && old.startState.kind === state.kind && old.startState.escaped === state.escaped;
    const parsed = cached ? old : yield* scanLine(text, state);
    if (cached) reusedLines += 1;
    else reparsedLines += 1;
    lines.push(parsed);
    state = parsed.endState;
    for (const item of parsed.spans) spans.push(freezeSpan(item.start + lineStart, item.end + lineStart, item.kind));

    lineIndex += 1;
    lineStart = boundary.newline < 0 ? request.text.length + 1 : boundary.newline + 1;
    sliceUnits += text.length + 1;
    if (lineStart <= request.text.length && (sliceUnits >= 8_192 || performance.now() - lastYield >= 1.5)) {
      sliceUnits = 0;
      lastYield = performance.now();
      yield;
    }
  }

  const cache: ParseCache = Object.freeze({
    documentId: request.documentId,
    documentVersion: request.documentVersion,
    text: request.text,
    lineStarts: Object.freeze(lineStarts),
    lines: Object.freeze(lines),
  });
  return {
    result: Object.freeze({
      documentId: request.documentId,
      documentVersion: request.documentVersion,
      requestId: request.requestId,
      generation: request.generation,
      status: 'highlighted',
      fallback: null,
      spans: Object.freeze(spans),
      stats: Object.freeze({
        totalLines: lines.length,
        reparsedLines,
        reusedLines,
        queueDepth,
        elapsedMilliseconds: performance.now() - started,
      }),
    }),
    cache,
  };
}

/**
 * Versioned asynchronous syntax service. `submit` only enqueues immutable
 * input and returns synchronously; grammar loading and parsing are never on the
 * typing call stack. The event-loop worker is deliberately bounded and keeps a
 * versioned read replica, with no writable document state.
 */
export class IncrementalSyntaxHighlighter {
  readonly #maxPendingRequests: number;
  readonly #maxPendingUtf16Units: number;
  readonly #maxDocumentUnits: number;
  readonly #maxLineUnits: number;
  readonly #schedule: (task: () => void) => void;
  readonly #listeners = new Set<(result: SyntaxHighlightResult) => void>();
  readonly #queue: QueuedRequest[] = [];
  readonly #flushWaiters = new Set<() => void>();
  #active: { readonly item: QueuedRequest; readonly parser: ResumableParse } | undefined;
  #queuedUtf16Units = 0;
  #activeUtf16Units = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #scheduled = false;
  #disposed = false;
  #sequence = 0;
  #latestSequence = 0;
  #cache: ParseCache | undefined;
  #latestResult: SyntaxHighlightResult | undefined;
  #diagnostics: SyntaxServiceDiagnostics = Object.freeze({
    queued: 0,
    completed: 0,
    dropped: 0,
    staleIgnored: 0,
    parserCrashes: 0,
    grammarFallbacks: 0,
    maxObservedQueue: 0,
    queuedUtf16Units: 0,
    maxObservedQueuedUtf16Units: 0,
    resumableSlices: 0,
    resyncs: 0,
  });

  constructor(options: SyntaxHighlighterOptions = {}) {
    this.#maxPendingRequests = Math.max(1, Math.floor(options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS));
    this.#maxPendingUtf16Units = Math.max(1, Math.floor(options.maxPendingUtf16Units ?? 4 * 1024 * 1024));
    this.#maxDocumentUnits = Math.max(1, Math.floor(options.maxDocumentUnits ?? DEFAULT_MAX_DOCUMENT_UNITS));
    this.#maxLineUnits = Math.max(1, Math.floor(options.maxLineUnits ?? DEFAULT_MAX_LINE_UNITS));
    // Yield between requests. This does not bound the CPU cost of one parse;
    // resumable parsing and the replica/worker budget remain T112 obligations.
    this.#schedule = options.schedule ?? ((task) => {
      this.#timer = setTimeout(() => { this.#timer = undefined; task(); }, 0);
    });
  }

  submit(request: SyntaxParseRequest): SyntaxSubmitResult {
    if (this.#disposed) return { accepted: false, error: { kind: 'disposed', message: 'syntax service has been disposed' } };
    if (typeof request.text !== 'string' || !Number.isSafeInteger(request.generation) || request.generation < 0) {
      return { accepted: false, error: { kind: 'invalid-input', message: 'syntax request has invalid immutable input' } };
    }
    if (request.text.length > this.#maxPendingUtf16Units
      || (this.#active !== undefined
        && this.#activeUtf16Units + this.#queuedUtf16Units + request.text.length > this.#maxPendingUtf16Units)) {
      return { accepted: false, error: { kind: 'queue-full', message: 'syntax request exceeds the bounded service byte credit' } };
    }
    const sequence = ++this.#sequence;
    this.#latestSequence = sequence;
    while (this.#queue.length >= this.#maxPendingRequests
      || this.#activeUtf16Units + this.#queuedUtf16Units + request.text.length > this.#maxPendingUtf16Units) {
      const dropped = this.#queue.shift();
      if (dropped === undefined) break;
      this.#queuedUtf16Units -= dropped.request.text.length;
      this.#diagnostics = Object.freeze({ ...this.#diagnostics, dropped: this.#diagnostics.dropped + 1 });
    }
    this.#queue.push(Object.freeze({ request: freezeSyntaxRequest(request), sequence }));
    this.#queuedUtf16Units += request.text.length;
    const queuedUtf16Units = this.#activeUtf16Units + this.#queuedUtf16Units;
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      queued: this.#diagnostics.queued + 1,
      maxObservedQueue: Math.max(this.#diagnostics.maxObservedQueue, this.#queue.length + (this.#active === undefined ? 0 : 1)),
      queuedUtf16Units,
      maxObservedQueuedUtf16Units: Math.max(this.#diagnostics.maxObservedQueuedUtf16Units, queuedUtf16Units),
    });
    this.#schedulePump();
    return { accepted: true, sequence };
  }

  onResult(listener: (result: SyntaxHighlightResult) => void): Disposable {
    if (this.#disposed) return { dispose: () => {} };
    this.#listeners.add(listener);
    return { dispose: () => { this.#listeners.delete(listener); } };
  }

  latest(): SyntaxHighlightResult | undefined { return this.#latestResult; }
  diagnostics(): SyntaxServiceDiagnostics { return this.#diagnostics; }
  pendingRequests(): number { return this.#queue.length + (this.#active === undefined ? (this.#scheduled ? 1 : 0) : 1); }

  async flush(): Promise<void> {
    if (this.#disposed || (!this.#scheduled && this.#queue.length === 0)) return;
    return new Promise<void>((resolve) => { this.#flushWaiters.add(resolve); });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#scheduled = false;
    this.#queue.length = 0;
    this.#queuedUtf16Units = 0;
    this.#active = undefined;
    this.#activeUtf16Units = 0;
    this.#listeners.clear();
    this.#cache = undefined;
    this.#latestResult = undefined;
    this.#resolveFlush();
  }

  #schedulePump(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#schedule(() => this.#pump());
  }

  #pump(): void {
    try { this.#runPump(); }
    finally {
      if (!this.#scheduled && this.#queue.length === 0) this.#resolveFlush();
    }
  }

  #resolveFlush(): void {
    for (const resolve of this.#flushWaiters) resolve();
    this.#flushWaiters.clear();
  }

  #runPump(): void {
    this.#scheduled = false;
    if (this.#disposed) return;
    if (this.#active === undefined) {
      const item = this.#queue.shift();
      if (item === undefined) return;
      this.#queuedUtf16Units -= item.request.text.length;
      if (item.sequence !== this.#latestSequence) {
        this.#diagnostics = Object.freeze({ ...this.#diagnostics, staleIgnored: this.#diagnostics.staleIgnored + 1 });
        if (this.#queue.length !== 0) this.#schedulePump();
        return;
      }
      this.#active = {
        item,
        parser: parseResumable(item.request, this.#cache, this.#maxDocumentUnits, this.#maxLineUnits, this.#queue.length),
      };
      this.#activeUtf16Units = item.request.text.length;
      const previousVersion = this.#cache?.documentVersion as number | undefined;
      const requestVersion = item.request.documentVersion as number;
      const contiguousDelta = item.request.delta !== undefined && previousVersion !== undefined
        && requestVersion === previousVersion + 1;
      if (previousVersion !== undefined && !contiguousDelta) {
        this.#diagnostics = Object.freeze({ ...this.#diagnostics, resyncs: this.#diagnostics.resyncs + 1 });
      }
      this.#diagnostics = Object.freeze({
        ...this.#diagnostics,
        queuedUtf16Units: this.#activeUtf16Units + this.#queuedUtf16Units,
      });
    }
    const active = this.#active;
    if (active === undefined) return;
    if (active.item.sequence !== this.#latestSequence) {
      this.#active = undefined;
      this.#activeUtf16Units = 0;
      this.#diagnostics = Object.freeze({
        ...this.#diagnostics,
        staleIgnored: this.#diagnostics.staleIgnored + 1,
        queuedUtf16Units: this.#queuedUtf16Units,
      });
      if (this.#queue.length !== 0) this.#schedulePump();
      return;
    }
    let step: IteratorResult<void, ResumableParseOutcome>;
    try {
      step = active.parser.next();
    } catch {
      this.#diagnostics = Object.freeze({ ...this.#diagnostics, parserCrashes: this.#diagnostics.parserCrashes + 1 });
      this.#active = undefined;
      this.#activeUtf16Units = 0;
      const parsed = { result: plainResult(active.item.request, 'plain-text', 'parser-crash', 1, this.#queue.length, 0), cache: undefined };
      this.#publishParsed(active.item, parsed);
      if (this.#queue.length !== 0) this.#schedulePump();
      return;
    }
    if (!step.done) {
      this.#diagnostics = Object.freeze({ ...this.#diagnostics, resumableSlices: this.#diagnostics.resumableSlices + 1 });
      this.#schedulePump();
      return;
    }
    this.#active = undefined;
    this.#activeUtf16Units = 0;
    this.#publishParsed(active.item, step.value);
    if (this.#queue.length !== 0) this.#schedulePump();
  }

  #publishParsed(item: QueuedRequest, parsed: ResumableParseOutcome): void {
    if (item.sequence !== this.#latestSequence) {
      this.#diagnostics = Object.freeze({ ...this.#diagnostics, staleIgnored: this.#diagnostics.staleIgnored + 1 });
      return;
    }
    this.#cache = parsed.cache;
    this.#latestResult = parsed.result;
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      completed: this.#diagnostics.completed + 1,
      grammarFallbacks: this.#diagnostics.grammarFallbacks + (parsed.result.fallback === 'grammar-missing' ? 1 : 0),
      queuedUtf16Units: this.#activeUtf16Units + this.#queuedUtf16Units,
    });
    for (const listener of this.#listeners) listener(parsed.result);
  }
}

/** Convenience wrapper for tests and adapters that need one asynchronous parse. */
export async function highlightOnce(request: SyntaxParseRequest, options?: SyntaxHighlighterOptions): Promise<SyntaxHighlightResult> {
  const service = new IncrementalSyntaxHighlighter(options);
  service.submit(request);
  await service.flush();
  const result = service.latest();
  service.dispose();
  if (result === undefined) throw new Error('syntax parse did not produce a result');
  return result;
}
