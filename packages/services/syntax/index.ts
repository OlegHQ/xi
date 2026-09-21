import type {
  Disposable,
  DocumentId,
  DocumentVersion,
  RequestId,
  Result,
  SyntaxSpan,
  SyntaxTokenKind,
  Utf16Offset,
  WorkspaceId,
} from '../../contracts/src/index';
import type { DocumentSnapshot } from '../../document/src/index';
import type { Node as TSNode, ParseCallback, ParseState, Point as TSPoint, Query as TSQuery, Tree as TSTree } from 'web-tree-sitter';
import {
  initializeTreeSitterRuntime,
  loadTreeSitterGrammar,
  TREE_SITTER_RUNTIME_VERSION,
  type LoadedTreeSitterGrammar,
  type TreeSitterFailure,
  type TreeSitterRuntime,
  type TreeSitterRuntimeOptions,
} from './tree-sitter';

export { initializeTreeSitterRuntime, loadTreeSitterGrammar, resetTreeSitterRuntimeForTesting, TREE_SITTER_RUNTIME_VERSION } from './tree-sitter';
export type { LoadedTreeSitterGrammar, TreeSitterFailure, TreeSitterRuntime, TreeSitterRuntimeOptions } from './tree-sitter';
export type { SyntaxSpan, SyntaxTokenKind } from '../../contracts/src/index';

/** UTF-16 offsets are used throughout the syntax service, matching Document. */
export type SyntaxHighlightSpan = SyntaxSpan;

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
  /** Immutable read replica from exactly documentVersion. Never materialized whole. */
  readonly snapshot: DocumentSnapshot;
  readonly delta?: SyntaxDelta;
  /** Every changed span for this commit, in reverse document order (highest `start` first), so
   * each can be applied with `tree.edit()` against the still-valid pre-edit coordinate space of
   * the spans after it. Preferred over `delta` when present (e.g. a multi-cursor edit); `delta`
   * remains for single-span callers (F1-5). Each entry's `newEnd` must be that span's own LOCAL
   * replacement end (`start + insertedLength`, in `start`'s unshifted base-document coordinate
   * space) -- never a cumulative final-document position -- because `tree.edit()` calls compound
   * automatically across the batch; a cumulative value double-counts already-compounded shift
   * and corrupts the tree. */
  readonly deltas?: readonly SyntaxDelta[];
  /** Language identity selects a Tree-sitter grammar; absent/unknown falls back to plain text. */
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
  /** O(document): implemented as spansInRange(0, document length). For tests/diagnostics only;
   * production reads must call spansInRange with the actual visible/queried range. */
  readonly spans: readonly SyntaxHighlightSpan[];
  /**
   * Non-overlapping spans intersecting [start, end), sorted by start. Computed lazily and
   * cached per fixed-size window; never touches a superseded or disposed result's freed tree
   * (returns an empty array instead).
   */
  spansInRange(start: number, end: number): readonly SyntaxHighlightSpan[];
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

export type SyntaxGrammarFailure = { readonly kind: 'grammar-missing'; readonly message: string };

export interface SyntaxGrammarSource {
  readonly wasm: Uint8Array;
  readonly highlights: string;
}

/** Lazily resolves and caches one grammar per languageId, off the keystroke path. */
export interface SyntaxGrammarProvider {
  resolve(languageId: string): Promise<Result<SyntaxGrammarSource, SyntaxGrammarFailure>>;
}

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
  /** Lazily resolves a Tree-sitter grammar (wasm + highlights query) per languageId. */
  readonly grammars?: SyntaxGrammarProvider;
  /** Forwarded to the Tree-sitter runtime the first time it initializes. */
  readonly runtime?: TreeSitterRuntimeOptions | (() => Promise<TreeSitterRuntimeOptions>);
  /** Milliseconds one parser.parse() slice may run before yielding. Defaults to ~1.5ms. */
  readonly sliceBudgetMilliseconds?: number;
  /** Test/diagnostic hook: called with the elapsed time of each background capture-window tick. */
  readonly onCaptureWindowMeasured?: (elapsedMilliseconds: number) => void;
  /** Test/diagnostic hook: called once per DocumentSnapshot#slice the parse callback issues. */
  readonly onSnapshotSliceCall?: () => void;
  /** Paint syntax-query bracket captures with Helix rainbow scopes. */
  readonly rainbowBrackets?: boolean;
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
    snapshot: request.snapshot,
    ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
    ...(request.delta === undefined ? {} : { delta: Object.freeze({
      start: request.delta.start,
      oldEnd: request.delta.oldEnd,
      newEnd: request.delta.newEnd,
    }) }),
    // F1-5: this allowlist used to drop `deltas` entirely, silently downgrading every
    // multi-span (multi-cursor) submission back into a forced full resync.
    ...(request.deltas === undefined ? {} : { deltas: Object.freeze(request.deltas.map((delta) => Object.freeze({ start: delta.start, oldEnd: delta.oldEnd, newEnd: delta.newEnd }))) }),
    ...(request.languageId === undefined ? {} : { languageId: request.languageId }),
  });
}

const DEFAULT_MAX_PENDING_REQUESTS = 3;
const DEFAULT_MAX_DOCUMENT_UNITS = 2_000_000;
const DEFAULT_MAX_LINE_UNITS = 32_768;
const DEFAULT_SLICE_BUDGET_MS = 1.5;
const PARSE_CHUNK_UNITS = 4_096;

const EMPTY_SPANS: readonly SyntaxHighlightSpan[] = Object.freeze([]);

function emptySpansInRange(): readonly SyntaxHighlightSpan[] { return EMPTY_SPANS; }

function plainResult(request: SyntaxParseRequest, status: 'plain-text' | 'large-file', fallback: SyntaxFallback, queueDepth: number, elapsedMilliseconds: number, totalLines = 1): SyntaxHighlightResult {
  return Object.freeze({
    documentId: request.documentId,
    documentVersion: request.documentVersion,
    requestId: request.requestId,
    generation: request.generation,
    status,
    fallback,
    spans: EMPTY_SPANS,
    spansInRange: emptySpansInRange,
    stats: Object.freeze({ totalLines, reparsedLines: 0, reusedLines: 0, queueDepth, elapsedMilliseconds }),
  });
}

/** Zero-based UTF-16 offset -> Tree-sitter row/column point, using a document snapshot's line index. */
function pointAt(snapshot: DocumentSnapshot, offset: number): TSPoint {
  const bounded = Math.max(0, Math.min(offset, snapshot.lengthUtf16));
  const lineResult = snapshot.lineIndexAt(toOffset(bounded));
  if (!lineResult.ok) return { row: 0, column: bounded };
  const startResult = snapshot.lineStartOffset(lineResult.value);
  const lineStart = startResult.ok ? (startResult.value as unknown as number) : 0;
  return { row: lineResult.value as unknown as number, column: bounded - lineStart };
}

function toOffset(value: number): Utf16Offset { return value as Utf16Offset; }

// --- Lua pattern -> JS RegExp source translation for `#lua-match?` predicates. ------------

const LUA_ESCAPE_MAP: Readonly<Record<string, string>> = Object.freeze({ d: '\\d', a: '[A-Za-z]', w: '[A-Za-z0-9]', s: '\\s', '.': '\\.', '%': '%' });

function translateLuaPattern(pattern: string): string | undefined {
  let out = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '%') {
      const next = pattern[index + 1];
      const replacement = next === undefined ? undefined : LUA_ESCAPE_MAP[next];
      if (replacement === undefined) return undefined;
      out += replacement;
      index += 1;
      continue;
    }
    out += character;
  }
  return out;
}

/** A predicate text a capture's text can never equal; used to neuter an untranslatable pattern in place. */
const NEVER_MATCHES_SENTINEL = '\0-xi-untranslatable-lua-pattern';

/**
 * Preprocess a nvim-treesitter highlights.scm source for web-tree-sitter, which leaves
 * unknown predicates such as `#lua-match?` in `query.predicates` and matches those
 * patterns unconditionally. Translatable Lua patterns become `#match?`. A predicate
 * with an untranslatable Lua class is replaced by an `#eq?` predicate that can never
 * be satisfied, so the pattern it guards never fires (in place, so no other predicate
 * or capture in the same top-level pattern is disturbed).
 */
export function preprocessHighlightsQuerySource(source: string): string {
  return source.replace(
    /\(#lua-match\?\s+(@[\w.]+)\s+"((?:[^"\\]|\\.)*)"\)/gu,
    (whole: string, capture: string, luaPattern: string) => {
      const translated = translateLuaPattern(luaPattern);
      if (translated === undefined) return `(#eq? ${capture} "${NEVER_MATCHES_SENTINEL}")`;
      return `(#match? ${capture} "${translated}")`;
    },
  );
}

const RAINBOW_BRACKET_SCOPES: Readonly<Record<string, string>> = Object.freeze({ '(': ')', '[': ']', '{': '}' });
const RAINBOW_PALETTE_LENGTH = 8;

function isRainbowBracket(text: string | undefined): boolean {
  return text !== undefined && (Object.hasOwn(RAINBOW_BRACKET_SCOPES, text) || Object.values(RAINBOW_BRACKET_SCOPES).includes(text));
}

function isRainbowScope(node: TSNode): boolean {
  const first = node.firstChild?.text;
  const last = node.lastChild?.text;
  return first !== undefined && last !== undefined && RAINBOW_BRACKET_SCOPES[first] === last;
}

/** Existing language queries already classify delimiter nodes as punctuation.bracket. Derive
 * the containing delimiter depth from the parsed tree so rainbow painting stays language-aware
 * without a second parser pass or a whole-document scan. */
function rainbowScopeFor(node: TSNode): string {
  let depth = 0;
  for (let parent = node.parent; parent !== null; parent = parent.parent) if (isRainbowScope(parent)) depth += 1;
  return `rainbow.${Math.max(0, depth - 1) % RAINBOW_PALETTE_LENGTH}`;
}

// --- Capture name -> SyntaxTokenKind mapping. ---------------------------------------------

function captureNameToKind(name: string): SyntaxTokenKind | undefined {
  if (name === 'keyword.operator') return 'operator';
  if (name.startsWith('comment')) return 'comment';
  // JSON object keys are `@string.special.key`; painting them as properties keeps keys and
  // string values distinguishable (they would otherwise both fall into the `string` prefix).
  if (name === 'string.special.key') return 'property';
  if (name.startsWith('string') || name.startsWith('character') || name === 'escape') return 'string';
  if (name.startsWith('number') || name === 'float') return 'number';
  if (name.startsWith('keyword') || name === 'include' || name === 'conditional' || name === 'repeat' || name === 'exception') return 'keyword';
  if (name === 'boolean') return 'boolean';
  if (name.startsWith('type') || name === 'constructor') return 'type';
  if (name.startsWith('function') || name.startsWith('method')) return 'function';
  if (name === 'operator') return 'operator';
  if (name.startsWith('punctuation')) return 'punctuation';
  if (name === 'variable.member' || name === 'property') return 'property';
  if (name === 'variable' || name === 'variable.parameter' || name === 'variable.builtin') return 'variable';
  if (name.startsWith('constant')) return 'constant';
  // Markdown (`markup.*`) has no dedicated token kinds; it reuses the closest existing ones.
  if (name.startsWith('markup.heading')) return 'keyword';
  if (name.startsWith('markup.raw') || name.startsWith('markup.quote')) return 'string';
  if (name.startsWith('markup.link')) return 'property';
  if (name.startsWith('markup.list')) return 'punctuation';
  if (name === 'markup.italic' || name === 'markup.strong' || name === 'markup.strikethrough' || name === 'label') return 'type';
  // These are documented Helix syntax-scope families without a distinct legacy Xi palette
  // category. Keep the exact capture for theme lookup and use the neutral category only for
  // old themes that do not provide Helix scopes.
  if (name === 'attribute' || name.startsWith('tag') || name.startsWith('namespace')
    || name.startsWith('special') || name.startsWith('diff') || name.startsWith('markup')) return 'variable';
  return undefined;
}

interface ResolvedCapture {
  readonly start: number;
  readonly end: number;
  readonly kind: SyntaxTokenKind;
  readonly scope: string;
  readonly order: number;
}

/** Sweep-line overlay: the narrowest (innermost) active capture wins each sub-range; ties go to the latest. */
function resolveSpans(captures: readonly ResolvedCapture[]): SyntaxHighlightSpan[] {
  if (captures.length === 0) return [];
  const sorted = [...captures].sort((left, right) => left.start - right.start || left.order - right.order);
  const boundarySet = new Set<number>();
  for (const capture of captures) { boundarySet.add(capture.start); boundarySet.add(capture.end); }
  const boundaries = [...boundarySet].sort((left, right) => left - right);
  const active: ResolvedCapture[] = [];
  let cursor = 0;
  const result: SyntaxHighlightSpan[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const segmentStart = boundaries[index] as number;
    const segmentEnd = boundaries[index + 1] as number;
    while (cursor < sorted.length && (sorted[cursor] as ResolvedCapture).start <= segmentStart) {
      active.push(sorted[cursor] as ResolvedCapture);
      cursor += 1;
    }
    for (let activeIndex = active.length - 1; activeIndex >= 0; activeIndex -= 1) {
      if ((active[activeIndex] as ResolvedCapture).end <= segmentStart) active.splice(activeIndex, 1);
    }
    if (segmentStart >= segmentEnd || active.length === 0) continue;
    let best = active[0] as ResolvedCapture;
    for (const candidate of active) {
      const bestLength = best.end - best.start;
      const candidateLength = candidate.end - candidate.start;
      if (candidateLength < bestLength || (candidateLength === bestLength && candidate.order > best.order)) best = candidate;
    }
    const previous = result[result.length - 1];
    if (previous !== undefined && previous.kind === best.kind && previous.scope === best.scope && previous.end === segmentStart) {
      result[result.length - 1] = Object.freeze({ start: previous.start, end: segmentEnd, kind: previous.kind, scope: previous.scope });
    } else {
      result.push(Object.freeze({ start: segmentStart, end: segmentEnd, kind: best.kind, scope: best.scope }));
    }
  }
  return result;
}

// --- Lazy, windowed, cached, non-blocking highlight result. ---------------------------------

const CAPTURE_WINDOW_UNITS = 256;
const CAPTURE_WINDOW_PAD = 64;
const MAX_CACHED_WINDOWS = 128;
const MAX_QUEUED_WINDOWS = 64;

/**
 * Owns an independent `tree.copy()` (never edited; the highlighter keeps editing its own
 * working tree separately) and the grammar's shared, unowned `Query`. `spansInRange` never
 * runs `query.captures()` on the caller's stack: it returns only already-cached windows and
 * enqueues any uncached window it touches (deduplicated, most-recently-requested first, bounded)
 * for background computation via the injected `schedule` (one window per tick). When a
 * background window finishes, `notifyWindowReady` re-fires the highlighter's listeners with
 * this same result so a caller (the UI, through `host.notifySurfaceChange()`) repaints.
 * `dispose()` frees the owned tree copy and drops the queue; a superseded/disposed result's
 * `spansInRange` always returns only whatever was already cached, never touching a freed tree,
 * and never resumes background work.
 */
class LiveHighlightResult implements SyntaxHighlightResult {
  readonly documentId: DocumentId;
  readonly documentVersion: DocumentVersion;
  readonly requestId: RequestId;
  readonly generation: number;
  readonly status = 'highlighted' as const;
  readonly fallback = null;
  readonly stats: SyntaxParseStats;
  readonly #total: number;
  readonly #schedule: (task: () => void) => void;
  readonly #notifyWindowReady: () => void;
  readonly #onWindowMeasured: ((elapsedMilliseconds: number) => void) | undefined;
  readonly #rainbowBrackets: boolean;
  #tree: TSTree | null;
  #query: TSQuery | null;
  readonly #windowCache = new Map<number, readonly SyntaxHighlightSpan[]>();
  readonly #queuedWindows: number[] = [];
  readonly #queuedSet = new Set<number>();
  #backgroundScheduled = false;

  constructor(
    request: SyntaxParseRequest,
    tree: TSTree,
    query: TSQuery,
    stats: SyntaxParseStats,
    schedule: (task: () => void) => void,
    notifyWindowReady: () => void,
    onWindowMeasured?: (elapsedMilliseconds: number) => void,
    rainbowBrackets = false,
  ) {
    this.documentId = request.documentId;
    this.documentVersion = request.documentVersion;
    this.requestId = request.requestId;
    this.generation = request.generation;
    this.stats = stats;
    this.#total = request.snapshot.lengthUtf16;
    this.#tree = tree;
    this.#query = query;
    this.#schedule = schedule;
    this.#notifyWindowReady = notifyWindowReady;
    this.#onWindowMeasured = onWindowMeasured;
    this.#rainbowBrackets = rainbowBrackets;
  }

  /** O(cached-so-far), not O(document): tests/diagnostics only; see spansInRange. */
  get spans(): readonly SyntaxHighlightSpan[] { return this.spansInRange(0, this.#total); }

  /**
   * Never blocks: returns spans only from windows already cached, and enqueues any uncached
   * window this range touches for background computation. A caller painting a frame with an
   * incomplete result simply shows plain text for the rows whose window has not resolved yet;
   * the next `onResult` (fired when a queued window finishes) triggers a repaint.
   */
  spansInRange(start: number, end: number): readonly SyntaxHighlightSpan[] {
    if (this.#tree === null || this.#query === null) return EMPTY_SPANS;
    const boundedStart = Math.max(0, Math.min(start, this.#total));
    const boundedEnd = Math.max(boundedStart, Math.min(end, this.#total));
    if (boundedEnd <= boundedStart) return EMPTY_SPANS;
    const firstWindow = Math.floor(boundedStart / CAPTURE_WINDOW_UNITS);
    const lastWindow = Math.floor((boundedEnd - 1) / CAPTURE_WINDOW_UNITS);
    const merged: SyntaxHighlightSpan[] = [];
    let lastEnd = -Infinity;
    for (let windowIndex = firstWindow; windowIndex <= lastWindow; windowIndex += 1) {
      const cached = this.#windowCache.get(windowIndex);
      if (cached === undefined) {
        this.#enqueueWindow(windowIndex);
        continue;
      }
      for (const span of cached) {
        if (span.end <= boundedStart || span.start >= boundedEnd) continue;
        if (span.start < lastEnd) continue;
        merged.push(span);
        lastEnd = span.end;
      }
    }
    return Object.freeze(merged);
  }

  /** Frees the owned tree copy and drops the queue; safe to call more than once. */
  dispose(): void {
    this.#tree?.delete();
    this.#tree = null;
    this.#query = null;
    this.#windowCache.clear();
    this.#queuedWindows.length = 0;
    this.#queuedSet.clear();
  }

  #enqueueWindow(windowIndex: number): void {
    if (this.#queuedSet.has(windowIndex)) {
      // Most-recently-requested first: move it to the front of the queue.
      const at = this.#queuedWindows.indexOf(windowIndex);
      if (at > 0) { this.#queuedWindows.splice(at, 1); this.#queuedWindows.unshift(windowIndex); }
    } else {
      this.#queuedSet.add(windowIndex);
      this.#queuedWindows.unshift(windowIndex);
      while (this.#queuedWindows.length > MAX_QUEUED_WINDOWS) {
        const dropped = this.#queuedWindows.pop();
        if (dropped !== undefined) this.#queuedSet.delete(dropped);
      }
    }
    if (!this.#backgroundScheduled && this.#tree !== null) {
      this.#backgroundScheduled = true;
      this.#schedule(() => this.#processOneQueuedWindow());
    }
  }

  #processOneQueuedWindow(): void {
    this.#backgroundScheduled = false;
    if (this.#tree === null || this.#query === null) { this.#queuedWindows.length = 0; this.#queuedSet.clear(); return; }
    const windowIndex = this.#queuedWindows.shift();
    if (windowIndex === undefined) return;
    this.#queuedSet.delete(windowIndex);
    const started = performance.now();
    const computed = this.#computeWindow(windowIndex);
    this.#onWindowMeasured?.(performance.now() - started);
    if (this.#windowCache.size >= MAX_CACHED_WINDOWS) {
      const oldest = this.#windowCache.keys().next().value;
      if (oldest !== undefined) this.#windowCache.delete(oldest);
    }
    this.#windowCache.set(windowIndex, computed);
    this.#notifyWindowReady();
    if (this.#queuedWindows.length > 0 && !this.#backgroundScheduled && this.#tree !== null) {
      this.#backgroundScheduled = true;
      this.#schedule(() => this.#processOneQueuedWindow());
    }
  }

  #computeWindow(windowIndex: number): readonly SyntaxHighlightSpan[] {
    const tree = this.#tree;
    const query = this.#query;
    if (tree === null || query === null) return EMPTY_SPANS;
    const windowStart = windowIndex * CAPTURE_WINDOW_UNITS;
    const windowEnd = Math.min(windowStart + CAPTURE_WINDOW_UNITS, this.#total);
    // A whole document that fits in a single window is queried unwindowed: web-tree-sitter's
    // windowed `captures()` can under-return near a small document's root boundary even when
    // the window covers the whole content (verified empirically: a tiny 29-unit fixture
    // silently dropped its last statement with a tight [0,total) window, but returned every
    // capture once unwindowed). Padding a genuinely multi-window query by CAPTURE_WINDOW_PAD
    // units on each side avoids the same issue at interior window seams.
    const qs = Math.max(0, windowStart - CAPTURE_WINDOW_PAD);
    const qe = Math.min(this.#total, windowEnd + CAPTURE_WINDOW_PAD);
    // web-tree-sitter 0.25.10's Query#captures `startIndex`/`endIndex` window options are in
    // UTF-16 BYTE units (2 bytes per code unit), unlike `Node#startIndex`/`endIndex` on the
    // returned captures, which are UTF-16 CODE-UNIT offsets (verified empirically: an
    // unscaled window silently returned captures from exactly half the intended offset).
    // `resolveSpans`/callers below only ever see the code-unit-based node offsets.
    const captures = this.#total <= CAPTURE_WINDOW_UNITS
      ? query.captures(tree.rootNode, { matchLimit: 4_096 })
      : query.captures(tree.rootNode, { startIndex: qs * 2, endIndex: qe * 2, matchLimit: 4_096 });
    const resolved: ResolvedCapture[] = [];
    let order = 0;
    for (const capture of captures) {
      const kind = captureNameToKind(capture.name);
      if (kind === undefined) continue;
      const node: TSNode = capture.node;
      const scope = this.#rainbowBrackets && capture.name === 'punctuation.bracket' && isRainbowBracket(node.text)
        ? rainbowScopeFor(node)
        : capture.name;
      resolved.push({ start: node.startIndex, end: node.endIndex, kind, scope, order: order++ });
    }
    return Object.freeze(resolveSpans(resolved));
  }
}

// --- Grammar cache. ------------------------------------------------------------------------

interface CompiledGrammar {
  readonly runtime: TreeSitterRuntime;
  readonly grammar: LoadedTreeSitterGrammar;
  readonly query: TSQuery;
}

type GrammarLookup = Result<CompiledGrammar, SyntaxFailure>;

// --- Per-document parse state. --------------------------------------------------------------

interface DocumentParseState {
  documentVersion: DocumentVersion;
  snapshot: DocumentSnapshot;
  tree: TSTree | null;
  languageId: string | undefined;
}

const CALLBACK_CACHE_CHUNKS = 8;

/**
 * A `ParseCallback` wrapping a small LRU of 4,096-unit-aligned chunk strings. Tree-sitter's own
 * text-for-predicate retrieval (`#match?`/`#eq?`/`#any-of?` during `Query#captures`, and any
 * `Node#text` access) replays the *same* callback the tree was parsed with, once per captured
 * node -- so without this cache, one `query.captures()` call issues one full O(window-size)
 * `DocumentSnapshot#slice` rope read per capture, dominating cost far more than the query
 * itself (verified: `snapshot.slice` cost scales with the returned length, and an uncached
 * predicate-driven refetch always requested up to PARSE_CHUNK_UNITS units regardless of how
 * few characters the predicate actually needed). A cache hit only pays a cheap JS string
 * `slice` (a view, not a copy, in V8/JSC) instead of a fresh rope traversal.
 */
function createCachedSnapshotCallback(snapshot: DocumentSnapshot, active: ActiveParse, onSliceCall: (() => void) | undefined): ParseCallback {
  const cache = new Map<number, string>();
  const total = snapshot.lengthUtf16;
  return (index) => {
    if (index >= total) return undefined;
    const alignedStart = Math.floor(index / PARSE_CHUNK_UNITS) * PARSE_CHUNK_UNITS;
    let chunk = cache.get(alignedStart);
    if (chunk === undefined) {
      const alignedEnd = Math.min(alignedStart + PARSE_CHUNK_UNITS, total);
      const sliced = snapshot.slice(toOffset(alignedStart), toOffset(alignedEnd));
      onSliceCall?.();
      if (!sliced.ok) return undefined;
      chunk = sliced.value;
      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk.charCodeAt(i) === 10) { active.longestLineUnits = Math.max(active.longestLineUnits, active.currentLineUnits); active.currentLineUnits = 0; }
        else active.currentLineUnits += 1;
      }
      if (cache.size >= CALLBACK_CACHE_CHUNKS) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) cache.delete(oldestKey);
      }
      cache.set(alignedStart, chunk);
    } else {
      // Touch for simple insertion-order LRU eviction above.
      cache.delete(alignedStart);
      cache.set(alignedStart, chunk);
    }
    const offsetWithinChunk = index - alignedStart;
    return offsetWithinChunk >= chunk.length ? undefined : chunk.slice(offsetWithinChunk);
  };
}

interface ActiveParse {
  readonly item: QueuedRequest;
  readonly grammar: CompiledGrammar;
  readonly startedAt: number;
  oldTree: TSTree | null;
  longestLineUnits: number;
  currentLineUnits: number;
  /** Created once per active parse (not per resumed slice) and reused so the chunk cache
   * above stays warm across resumed ticks and is retained by the resulting tree for later
   * predicate evaluation during captures. */
  callback?: ParseCallback;
}

/**
 * Versioned asynchronous syntax service backed by web-tree-sitter. `submit` only
 * enqueues an immutable snapshot reference and returns synchronously; grammar
 * loading and parsing never run on the typing call stack. Parses are resumed in
 * bounded CPU slices via Tree-sitter's own progress callback.
 */
export class IncrementalSyntaxHighlighter {
  readonly #maxPendingRequests: number;
  readonly #maxPendingUtf16Units: number;
  readonly #maxDocumentUnits: number;
  readonly #maxLineUnits: number;
  readonly #sliceBudgetMilliseconds: number;
  readonly #onCaptureWindowMeasured: ((elapsedMilliseconds: number) => void) | undefined;
  readonly #onSnapshotSliceCall: (() => void) | undefined;
  readonly #rainbowBrackets: boolean;
  readonly #schedule: (task: () => void) => void;
  readonly #grammarProvider: SyntaxGrammarProvider | undefined;
  readonly #runtimeOptions: TreeSitterRuntimeOptions | (() => Promise<TreeSitterRuntimeOptions>) | undefined;
  readonly #listeners = new Set<(result: SyntaxHighlightResult) => void>();
  readonly #queue: QueuedRequest[] = [];
  readonly #flushWaiters = new Set<() => void>();
  readonly #documents = new Map<DocumentId, DocumentParseState>();
  readonly #publishedResults = new Map<DocumentId, LiveHighlightResult>();
  readonly #grammarCache = new Map<string, Promise<GrammarLookup>>();
  readonly #grammarResults = new Map<string, GrammarLookup>();
  #runtime: TreeSitterRuntime | undefined;
  #runtimePromise: Promise<Result<TreeSitterRuntime, TreeSitterFailure>> | undefined;
  #sharedParser: InstanceType<TreeSitterRuntime['Parser']> | undefined;
  #sharedParserLanguageName: string | null = null;
  #active: ActiveParse | undefined;
  #queuedUtf16Units = 0;
  #activeUtf16Units = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #scheduled = false;
  #disposed = false;
  #sequence = 0;
  /** Per-document, not global: a shared highlighter serves many open documents, and a newer
   * request for document B must not mark document A's own still-current queued/active
   * request stale (that would leave A never highlighted whenever any other document is
   * touched). */
  readonly #latestSequenceByDocument = new Map<DocumentId, number>();
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
    this.#sliceBudgetMilliseconds = Math.max(0.1, options.sliceBudgetMilliseconds ?? DEFAULT_SLICE_BUDGET_MS);
    this.#onCaptureWindowMeasured = options.onCaptureWindowMeasured;
    this.#onSnapshotSliceCall = options.onSnapshotSliceCall;
    this.#rainbowBrackets = options.rainbowBrackets === true;
    this.#grammarProvider = options.grammars;
    this.#runtimeOptions = options.runtime;
    // Yield between requests. This does not bound the CPU cost of one slice;
    // the Tree-sitter progress callback bounds the slice itself.
    this.#schedule = options.schedule ?? ((task) => {
      this.#timer = setTimeout(() => { this.#timer = undefined; task(); }, 0);
    });
  }

  submit(request: SyntaxParseRequest): SyntaxSubmitResult {
    if (this.#disposed) return { accepted: false, error: { kind: 'disposed', message: 'syntax service has been disposed' } };
    if (request.snapshot === undefined || !Number.isSafeInteger(request.generation) || request.generation < 0) {
      return { accepted: false, error: { kind: 'invalid-input', message: 'syntax request has invalid immutable input' } };
    }
    const units = request.snapshot.lengthUtf16;
    if (units > this.#maxPendingUtf16Units
      || (this.#active !== undefined && this.#activeUtf16Units + this.#queuedUtf16Units + units > this.#maxPendingUtf16Units)) {
      return { accepted: false, error: { kind: 'queue-full', message: 'syntax request exceeds the bounded service byte credit' } };
    }
    const sequence = ++this.#sequence;
    this.#latestSequenceByDocument.set(request.documentId, sequence);
    while (this.#queue.length >= this.#maxPendingRequests
      || this.#activeUtf16Units + this.#queuedUtf16Units + units > this.#maxPendingUtf16Units) {
      const dropped = this.#queue.shift();
      if (dropped === undefined) break;
      this.#queuedUtf16Units -= dropped.request.snapshot.lengthUtf16;
      this.#diagnostics = Object.freeze({ ...this.#diagnostics, dropped: this.#diagnostics.dropped + 1 });
    }
    this.#queue.push(Object.freeze({ request: freezeSyntaxRequest(request), sequence }));
    this.#queuedUtf16Units += units;
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

  /** Drop all retained state for one document; frees its Tree-sitter tree. */
  closeDocument(documentId: DocumentId): void {
    const state = this.#documents.get(documentId);
    if (state?.tree != null) state.tree.delete();
    this.#documents.delete(documentId);
    this.#publishedResults.get(documentId)?.dispose();
    this.#publishedResults.delete(documentId);
    // Drop this document's own tracked sequence so any queued/active request for it is
    // recognized as stale by the existing per-document sequence check, and actively remove
    // it now instead of leaving it to be discovered on the next pump.
    this.#latestSequenceByDocument.delete(documentId);
    const remaining = this.#queue.filter((item) => item.request.documentId !== documentId);
    if (remaining.length !== this.#queue.length) {
      for (const item of this.#queue) {
        if (item.request.documentId === documentId) this.#queuedUtf16Units -= item.request.snapshot.lengthUtf16;
      }
      this.#queue.length = 0;
      this.#queue.push(...remaining);
    }
    if (this.#active !== undefined && this.#active.item.request.documentId === documentId) this.#abandonActive();
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
    for (const state of this.#documents.values()) { if (state.tree != null) state.tree.delete(); }
    this.#documents.clear();
    for (const published of this.#publishedResults.values()) published.dispose();
    this.#publishedResults.clear();
    this.#sharedParser?.delete();
    this.#sharedParser = undefined;
    this.#latestResult = undefined;
    this.#resolveFlush();
  }

  #schedulePump(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#schedule(() => this.#pump());
  }

  #resolveFlush(): void {
    for (const resolve of this.#flushWaiters) resolve();
    this.#flushWaiters.clear();
  }

  async #ensureRuntime(): Promise<Result<TreeSitterRuntime, TreeSitterFailure>> {
    if (this.#runtime !== undefined) return { ok: true, value: this.#runtime };
    this.#runtimePromise ??= (async () => {
      const options = typeof this.#runtimeOptions === 'function' ? await this.#runtimeOptions() : this.#runtimeOptions;
      return initializeTreeSitterRuntime(options);
    })();
    const runtime = await this.#runtimePromise;
    if (runtime.ok) this.#runtime = runtime.value;
    return runtime;
  }

  #ensureGrammar(languageId: string): Promise<GrammarLookup> {
    const cached = this.#grammarCache.get(languageId);
    if (cached !== undefined) return cached;
    const pending = this.#loadGrammar(languageId).then((result) => {
      this.#grammarResults.set(languageId, result);
      return result;
    });
    this.#grammarCache.set(languageId, pending);
    return pending;
  }

  async #loadGrammar(languageId: string): Promise<GrammarLookup> {
    const runtime = await this.#ensureRuntime();
    if (!runtime.ok) return { ok: false, error: runtime.error };
    if (this.#grammarProvider === undefined) {
      return { ok: false, error: { kind: 'grammar-missing', message: `no grammar provider configured for ${languageId}` } };
    }
    const source = await this.#grammarProvider.resolve(languageId);
    if (!source.ok) return { ok: false, error: source.error };
    const grammar = await loadTreeSitterGrammar(source.value.wasm);
    if (!grammar.ok) return { ok: false, error: grammar.error };
    const querySource = preprocessHighlightsQuerySource(source.value.highlights);
    try {
      const query = new runtime.value.Query(grammar.value.language, querySource);
      return { ok: true, value: { runtime: runtime.value, grammar: grammar.value, query } };
    } catch {
      return { ok: false, error: { kind: 'grammar-missing', message: `highlights query failed to compile for ${languageId}` } };
    }
  }

  #pump(): void {
    try { this.#runPump(); }
    finally {
      if (!this.#scheduled && this.#queue.length === 0) this.#resolveFlush();
    }
  }

  #runPump(): void {
    this.#scheduled = false;
    if (this.#disposed) return;
    if (this.#active === undefined) {
      const item = this.#queue[0];
      if (item === undefined) return;
      if (item.sequence !== this.#latestSequenceByDocument.get(item.request.documentId)) {
        this.#queue.shift();
        this.#queuedUtf16Units -= item.request.snapshot.lengthUtf16;
        this.#diagnostics = Object.freeze({ ...this.#diagnostics, staleIgnored: this.#diagnostics.staleIgnored + 1 });
        if (this.#queue.length !== 0) this.#schedulePump();
        return;
      }
      if (!this.#beginActive(item)) {
        // #beginActive returns false for two different reasons: (a) it is still waiting on an
        // async grammar/runtime resolution -- the item stays queued and its own `.then(() =>
        // this.#schedulePump())` will resume the pump; or (b) it already published a
        // synchronous fallback result (large-file/grammar-missing) and shifted the item off
        // the queue. Only case (b) needs a reschedule here, or a second queued document (or a
        // second request for the same document) is left waiting forever for a pump that
        // already ran to completion.
        if (this.#queue[0] !== item && this.#queue.length !== 0) this.#schedulePump();
        return;
      }
    }
    const active = this.#active;
    if (active === undefined) return;
    if (active.item.sequence !== this.#latestSequenceByDocument.get(active.item.request.documentId)) {
      this.#abandonActive();
      if (this.#queue.length !== 0) this.#schedulePump();
      return;
    }
    this.#stepActive(active);
  }

  /** Returns false when the item cannot start synchronously yet (grammar/runtime still loading). */
  #beginActive(item: QueuedRequest): boolean {
    const { request } = item;
    if (request.snapshot.lengthUtf16 > this.#maxDocumentUnits) {
      this.#queue.shift();
      this.#queuedUtf16Units -= request.snapshot.lengthUtf16;
      this.#publishParsed(item, plainResult(request, 'large-file', 'large-file', this.#queue.length, 0));
      return false;
    }
    if (request.languageId === undefined) {
      this.#queue.shift();
      this.#queuedUtf16Units -= request.snapshot.lengthUtf16;
      this.#diagnostics = Object.freeze({ ...this.#diagnostics, grammarFallbacks: this.#diagnostics.grammarFallbacks + 1 });
      this.#publishParsed(item, plainResult(request, 'plain-text', 'grammar-missing', this.#queue.length, 0));
      return false;
    }
    const resolved = this.#grammarResults.get(request.languageId);
    if (resolved === undefined) {
      // Not yet settled; kick off (or await) resolution and retry once it lands.
      this.#ensureGrammar(request.languageId).then(() => this.#schedulePump()).catch(() => {});
      return false;
    }
    this.#queue.shift();
    this.#queuedUtf16Units -= request.snapshot.lengthUtf16;
    if (!resolved.ok) {
      this.#diagnostics = Object.freeze({ ...this.#diagnostics, grammarFallbacks: this.#diagnostics.grammarFallbacks + 1 });
      this.#publishParsed(item, plainResult(request, 'plain-text', 'grammar-missing', this.#queue.length, 0));
      return false;
    }
    this.#activeUtf16Units = request.snapshot.lengthUtf16;
    const documentState = this.#documents.get(request.documentId);
    const deltas = request.deltas ?? (request.delta === undefined ? undefined : [request.delta]);
    const contiguousDelta = deltas !== undefined && deltas.length > 0 && documentState !== undefined
      && (request.documentVersion as number) === (documentState.documentVersion as number) + 1
      && documentState.tree !== null && documentState.languageId === request.languageId;
    let oldTree: TSTree | null = null;
    if (contiguousDelta && documentState !== undefined && documentState.tree !== null) {
      // Every span is applied against `documentState.tree`, whose coordinate space is only
      // disturbed by spans already applied. Callers hand these in reverse document order
      // (highest `start` first) so an earlier (lower-start) span's indices, still read from
      // the original before/after snapshots, stay correct when its turn comes (F1-5).
      for (const delta of deltas) {
        // startIndex/oldEndIndex/startPosition/oldEndPosition are the pre-edit (unshifted) base
        // offset -- correct as-is, since nothing before this span's own position has been
        // touched yet at this point in the reverse pass. newEndIndex is this span's own LOCAL
        // replacement end (see the `deltas` field doc); web-tree-sitter only uses
        // newEndPosition/oldEndPosition for node.startPosition()/endPosition() bookkeeping, not
        // for deciding what to re-lex (that is byte-index-driven), so looking its row/col up in
        // `request.snapshot` -- a real position, just not always exactly this span's local one
        // for a multi-span batch -- is an accepted, tested-correct (F1-5) approximation rather
        // than plumbing the actual inserted text through SyntaxDelta.
        documentState.tree.edit({
          startIndex: delta.start,
          oldEndIndex: delta.oldEnd,
          newEndIndex: delta.newEnd,
          startPosition: pointAt(documentState.snapshot, delta.start),
          oldEndPosition: pointAt(documentState.snapshot, delta.oldEnd),
          newEndPosition: pointAt(request.snapshot, delta.newEnd),
        });
      }
      oldTree = documentState.tree;
    } else if (documentState !== undefined) {
      this.#diagnostics = Object.freeze({ ...this.#diagnostics, resyncs: this.#diagnostics.resyncs + 1 });
    }
    this.#active = { item, grammar: resolved.value, startedAt: performance.now(), oldTree, longestLineUnits: 0, currentLineUnits: 0 };
    return true;
  }

  #abandonActive(): void {
    this.#active = undefined;
    this.#activeUtf16Units = 0;
    this.#sharedParser?.reset();
    this.#diagnostics = Object.freeze({ ...this.#diagnostics, staleIgnored: this.#diagnostics.staleIgnored + 1 });
  }

  #parser(runtime: TreeSitterRuntime): InstanceType<TreeSitterRuntime['Parser']> {
    this.#sharedParser ??= new runtime.Parser();
    return this.#sharedParser;
  }

  #stepActive(active: ActiveParse): void {
    const { request } = active.item;
    const runtime = active.grammar.runtime;
    const parser = this.#parser(runtime);
    // Keyed by languageId, not `Language.name` (nvim-treesitter-vendored grammars
    // often have no embedded name). Only touch `setLanguage` on an actual language
    // switch: it resets the parser's internal state, which would silently discard
    // a cancelled parse's resumable progress if called on every resumed slice.
    const languageKey = request.languageId ?? null;
    if (this.#sharedParserLanguageName !== languageKey) {
      parser.reset();
      parser.setLanguage(active.grammar.grammar.language);
      this.#sharedParserLanguageName = languageKey;
    }
    active.callback ??= createCachedSnapshotCallback(request.snapshot, active, this.#onSnapshotSliceCall);
    const callback = active.callback;
    const sliceStarted = performance.now();
    const progressCallback = (_state: ParseState): boolean => performance.now() - sliceStarted > this.#sliceBudgetMilliseconds;
    let tree: TSTree | null;
    try {
      tree = parser.parse(callback, active.oldTree, { progressCallback });
    } catch {
      this.#active = undefined;
      this.#activeUtf16Units = 0;
      parser.reset();
      this.#sharedParserLanguageName = null;
      this.#diagnostics = Object.freeze({ ...this.#diagnostics, parserCrashes: this.#diagnostics.parserCrashes + 1 });
      this.#publishParsed(active.item, plainResult(request, 'plain-text', 'parser-crash', this.#queue.length, performance.now() - active.startedAt));
      if (this.#queue.length !== 0) this.#schedulePump();
      return;
    }
    if (tree === null) {
      // Cancelled mid-slice: web-tree-sitter resumes on the next identical parse() call.
      active.longestLineUnits = Math.max(active.longestLineUnits, active.currentLineUnits);
      this.#diagnostics = Object.freeze({ ...this.#diagnostics, resumableSlices: this.#diagnostics.resumableSlices + 1 });
      this.#schedulePump();
      return;
    }
    active.longestLineUnits = Math.max(active.longestLineUnits, active.currentLineUnits);
    // The active slot stays occupied (do not clear `this.#active` here): the highlight-query
    // pass below continues to run against this same `active` across further pump ticks.
    const previousDocumentTree = this.#documents.get(request.documentId)?.tree;
    if (active.oldTree != null && active.oldTree !== tree) active.oldTree.delete();
    if (previousDocumentTree != null && previousDocumentTree !== tree && previousDocumentTree !== active.oldTree) previousDocumentTree.delete();
    this.#documents.set(request.documentId, {
      documentVersion: request.documentVersion,
      snapshot: request.snapshot,
      tree,
      languageId: request.languageId,
    });
    if (active.longestLineUnits > this.#maxLineUnits) {
      tree.delete();
      this.#documents.set(request.documentId, { documentVersion: request.documentVersion, snapshot: request.snapshot, tree: null, languageId: request.languageId });
      this.#active = undefined;
      this.#activeUtf16Units = 0;
      this.#publishParsed(active.item, plainResult(request, 'plain-text', 'giant-line', this.#queue.length, performance.now() - active.startedAt, request.snapshot.lineCount));
      if (this.#queue.length !== 0) this.#schedulePump();
      return;
    }
    // Publish immediately: the highlight-query pass is no longer run here at all. It is
    // computed lazily, per fixed-size window, the first time a reader actually calls
    // spansInRange (see LiveHighlightResult) -- an eager, whole-document capture pass (even
    // chunked across pump ticks) cost real wall time on every edit regardless of how small the
    // edit was, since it always rescanned the entire tree.
    this.#active = undefined;
    this.#activeUtf16Units = 0;
    const stats: SyntaxParseStats = Object.freeze({
      totalLines: request.snapshot.lineCount,
      reparsedLines: active.oldTree === null ? request.snapshot.lineCount : 0,
      reusedLines: active.oldTree === null ? 0 : request.snapshot.lineCount,
      queueDepth: this.#queue.length,
      elapsedMilliseconds: performance.now() - active.startedAt,
    });
    let result: LiveHighlightResult;
    result = new LiveHighlightResult(
      request,
      tree.copy(),
      active.grammar.query,
      stats,
      this.#schedule,
      () => this.#notifyListeners(result),
      this.#onCaptureWindowMeasured,
      this.#rainbowBrackets,
    );
    this.#publishParsed(active.item, result);
    if (this.#queue.length !== 0) this.#schedulePump();
  }

  #publishParsed(item: QueuedRequest, result: SyntaxHighlightResult): void {
    if (item.sequence !== this.#latestSequenceByDocument.get(item.request.documentId)) {
      // A dropped, never-exposed result still needs its owned tree copy freed.
      if (result instanceof LiveHighlightResult) result.dispose();
      this.#diagnostics = Object.freeze({ ...this.#diagnostics, staleIgnored: this.#diagnostics.staleIgnored + 1 });
      return;
    }
    if (result instanceof LiveHighlightResult) {
      this.#publishedResults.get(item.request.documentId)?.dispose();
      this.#publishedResults.set(item.request.documentId, result);
    }
    this.#latestResult = result;
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      completed: this.#diagnostics.completed + 1,
      queuedUtf16Units: this.#activeUtf16Units + this.#queuedUtf16Units,
    });
    this.#notifyListeners(result);
  }

  /** Also used to re-notify listeners when a result's background capture window finishes. */
  #notifyListeners(result: SyntaxHighlightResult): void {
    for (const listener of this.#listeners) listener(result);
  }
}

/**
 * Convenience wrapper for tests and adapters that need one asynchronous, fully-materialized
 * parse. Unlike the live service/tracker path, this eagerly realizes `spans` (touching every
 * window, forcing all of its captures) before disposing the underlying service, and returns a
 * plain, tree-independent snapshot: `dispose()` frees every published result's owned tree, so a
 * caller that kept the live result past that point would otherwise see it go empty.
 */
export async function highlightOnce(request: SyntaxParseRequest, options?: SyntaxHighlighterOptions): Promise<SyntaxHighlightResult> {
  // `spansInRange` is non-blocking and only enqueues background work now, so a one-shot
  // caller needs to actively drain both the parse queue and every background capture window
  // to get a fully materialized result. Overriding `schedule` with a manually-drained array
  // (ignoring any caller-supplied one) makes that deterministic instead of racing real timers.
  const tasks: Array<() => void> = [];
  const service = new IncrementalSyntaxHighlighter({ ...(options ?? {}), schedule: (task) => { tasks.push(task); } });
  service.submit(request);
  // Grammar/runtime loading is real (bounded) async I/O ahead of the first parse tick, so the
  // task queue can legitimately be empty for a moment even though more work is coming.
  for (let round = 0; round < 5_000 && service.latest() === undefined; round += 1) {
    const task = tasks.shift();
    if (task !== undefined) { task(); continue; }
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  }
  const result = service.latest();
  if (result === undefined) {
    service.dispose();
    throw new Error('syntax parse did not produce a result');
  }
  const total = request.snapshot.lengthUtf16;
  for (let round = 0; round < 200; round += 1) {
    result.spansInRange(0, total);
    if (tasks.length === 0) break;
    while (tasks.length > 0) { const task = tasks.shift(); task?.(); }
  }
  const spans = result.spans;
  const materialized: SyntaxHighlightResult = Object.freeze({
    documentId: result.documentId,
    documentVersion: result.documentVersion,
    requestId: result.requestId,
    generation: result.generation,
    status: result.status,
    fallback: result.fallback,
    spans,
    spansInRange: (start: number, end: number) => spans.filter((span) => span.end > start && span.start < end),
    stats: result.stats,
  });
  service.dispose();
  return materialized;
}

export { SyntaxDocumentTracker } from './tracker';
export type { SyntaxDocumentTrackerOptions, SyntaxOpenDocumentRequest } from './tracker';
