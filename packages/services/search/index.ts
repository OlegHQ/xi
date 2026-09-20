import { CancellationSource, type CancellationToken, type Disposable, type ProcessPort, type Result } from '../../contracts/src/index';

/** Coordinates are zero-based UTF-16 columns in the source line. */
export interface SearchRange {
  readonly startUtf16: number;
  readonly endUtf16: number;
}

export interface SearchMatch {
  readonly id: string;
  readonly rootId: string;
  readonly path: string;
  readonly line: number;
  /** End line for multiline dialect matches; omitted means `line`. */
  readonly endLine?: number;
  readonly range: SearchRange;
  readonly lineText: string;
  readonly snippet: string;
  readonly source: 'disk' | 'buffer';
  readonly documentVersion?: number;
  readonly diskHash?: string;
  readonly generation: number;
}

export interface SearchQuery {
  readonly rootId: string;
  readonly rootPath: string;
  readonly query: string;
  readonly regex?: boolean;
  readonly caseSensitive?: boolean;
  readonly wholeWord?: boolean;
  readonly includeHidden?: boolean;
  readonly globs?: readonly string[];
  readonly maxResults?: number;
}

export type SearchFailure =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'invalid-regex'; readonly message: string }
  | { readonly kind: 'backend'; readonly message: string }
  | { readonly kind: 'stale'; readonly generation: number };

export interface SearchReadModel {
  readonly contractVersion: 1;
  readonly query: SearchQuery;
  readonly generation: number;
  readonly state: 'idle' | 'loading' | 'ready' | 'empty' | 'stale' | 'error';
  readonly matches: readonly SearchMatch[];
  readonly totalMatches: number;
  readonly truncated: boolean;
  readonly message: string | undefined;
}

export interface SearchBackend {
  search(query: SearchQuery, cancellation: CancellationToken, generation: number, onBatch?: (matches: readonly SearchMatch[]) => void): Promise<Result<readonly SearchMatch[], SearchFailure>>;
}

export interface SearchBufferSource {
  readonly rootId: string;
  readonly path: string;
  readonly version: number;
  readonly text: string;
  readonly diskHash?: string;
}

export interface SearchServiceOptions {
  readonly debounceMilliseconds?: number;
  readonly defaultLimit?: number;
  readonly backend?: SearchBackend;
  /** Read current dirty buffers after debounce, outside the keypress handler. */
  readonly bufferSourceProvider?: () => readonly SearchBufferSource[];
}

export interface RipgrepSearchBackendOptions {
  readonly process: ProcessPort;
  readonly executable?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds?: number;
  readonly maxOutputBytes?: number;
}

const EMPTY_QUERY: SearchQuery = Object.freeze({ rootId: '', rootPath: '', query: '' });
const EMPTY_MODEL: SearchReadModel = Object.freeze({
  contractVersion: 1,
  query: EMPTY_QUERY,
  generation: 0,
  state: 'idle',
  matches: Object.freeze([]),
  totalMatches: 0,
  truncated: false,
  message: undefined,
});

/**
 * Realtime search owner. It debounces requests, cancels the previous backend
 * operation and only publishes a result when its generation is still current.
 * Disk search and open-buffer search are merged before publication.
 */
export class RealtimeSearchService implements Disposable {
  readonly #backend: SearchBackend;
  readonly #debounceMilliseconds: number;
  readonly #defaultLimit: number;
  readonly #bufferSourceProvider: (() => readonly SearchBufferSource[]) | undefined;
  readonly #listeners = new Set<(model: SearchReadModel) => void>();
  #bufferSources: readonly SearchBufferSource[] = Object.freeze([]);
  #model: SearchReadModel = EMPTY_MODEL;
  #generation = 0;
  #requestCancellation: CancellationSource | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pendingResolve: ((result: Result<SearchReadModel, SearchFailure>) => void) | undefined;
  #disposed = false;

  constructor(options: SearchServiceOptions = {}) {
    this.#backend = options.backend ?? new EmptySearchBackend();
    this.#debounceMilliseconds = bounded(options.debounceMilliseconds ?? 40, 0, 2_000);
    this.#defaultLimit = bounded(options.defaultLimit ?? 10_000, 1, 100_000);
    this.#bufferSourceProvider = options.bufferSourceProvider;
  }

  get model(): SearchReadModel { return this.#model; }

  setBufferSources(sources: readonly SearchBufferSource[]): void {
    if (this.#disposed) return;
    this.#bufferSources = Object.freeze(sources.map((source) => Object.freeze({ ...source })));
  }

  subscribe(listener: (model: SearchReadModel) => void): Disposable {
    if (this.#disposed) throw new Error('search-service-disposed');
    this.#listeners.add(listener);
    return Object.freeze({ dispose: () => { this.#listeners.delete(listener); } });
  }

  query(query: SearchQuery): Promise<Result<SearchReadModel, SearchFailure>> {
    if (this.#disposed) return Promise.resolve({ ok: false, error: { kind: 'backend', message: 'search service is disposed' } });
    const previousResolve = this.#pendingResolve;
    this.#pendingResolve = undefined;
    previousResolve?.({ ok: false, error: { kind: 'stale', generation: this.#generation } });
    const generation = ++this.#generation;
    this.#requestCancellation?.cancel();
    this.#requestCancellation?.dispose();
    const cancellation = new CancellationSource();
    this.#requestCancellation = cancellation;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    const normalized = normalizeQuery(query, this.#defaultLimit);
    const regexFailure = validateRegex(normalized);
    if (regexFailure !== undefined) {
      const stale = this.#model.matches.length > 0 ? 'stale' : 'error';
      this.#publish({ ...this.#model, query: normalized, generation, state: stale, message: failureMessage(regexFailure) });
      return Promise.resolve({ ok: false, error: regexFailure });
    }
    this.#publish({
      contractVersion: 1,
      query: normalized,
      generation,
      state: 'loading',
      matches: this.#model.matches,
      totalMatches: this.#model.totalMatches,
      truncated: this.#model.truncated,
      message: undefined,
    });
    return new Promise((resolve) => {
      this.#pendingResolve = resolve;
      this.#timer = setTimeout(() => {
        this.#run(normalized, generation, cancellation, resolve);
      }, this.#debounceMilliseconds);
    });
  }

  cancel(): void {
    if (this.#disposed) return;
    ++this.#generation;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#requestCancellation?.cancel();
    const pendingResolve = this.#pendingResolve;
    this.#pendingResolve = undefined;
    pendingResolve?.({ ok: false, error: { kind: 'stale', generation: this.#generation } });
    const current = this.#model;
    this.#publish({ ...current, generation: this.#generation, state: current.matches.length === 0 ? 'idle' : 'stale', message: 'search cancelled' });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#requestCancellation?.cancel();
    this.#requestCancellation?.dispose();
    const pendingResolve = this.#pendingResolve;
    this.#pendingResolve = undefined;
    pendingResolve?.({ ok: false, error: { kind: 'stale', generation: this.#generation } });
    this.#listeners.clear();
  }

  async #run(query: SearchQuery, generation: number, cancellation: CancellationSource, resolve: (result: Result<SearchReadModel, SearchFailure>) => void): Promise<void> {
    this.#timer = undefined;
    const bufferSources = this.#bufferSourceProvider?.() ?? this.#bufferSources;
    const limit = query.maxResults ?? this.#defaultLimit;
    const ownedPaths = bufferOwnedPaths(bufferSources);
    const streamed: SearchMatch[] = [];
    // Accumulate disk + buffer matches into one array by appending in place instead of
    // re-spreading `[...streamed, ...bufferMatches]` on every batch, which was an
    // O(n^2 / batchSize) copy over a long search.
    const combined: SearchMatch[] = [];
    // Publishes are coalesced to at most one per macrotask instead of once per rg batch: a
    // burst of same-tick batches used to each pay a full `combined.slice(0, limit)` copy and
    // freeze; now every batch in that burst shares one scheduled publish. The very first
    // publish of a run bypasses the setTimeout(0) coalescing hop entirely and goes out
    // synchronously with the first batch that arrives (buffer scan or first rg batch,
    // whichever is first), since there is nothing yet to coalesce it with.
    let publishTimer: ReturnType<typeof setTimeout> | undefined;
    let firstPublishSent = false;
    const publishNow = (): void => {
      if (this.#disposed || generation !== this.#generation || cancellation.token.isCancelled) return;
      firstPublishSent = true;
      this.#publish(Object.freeze({
        contractVersion: 1,
        query,
        generation,
        state: 'loading',
        matches: Object.freeze(combined.slice(0, limit)),
        totalMatches: combined.length,
        truncated: combined.length > limit,
        message: undefined,
      }));
    };
    const schedulePublish = (): void => {
      if (!firstPublishSent) { publishNow(); return; }
      if (publishTimer !== undefined) return;
      publishTimer = setTimeout(() => {
        publishTimer = undefined;
        publishNow();
      }, 0);
    };
    const onBatch = (batch: readonly SearchMatch[]): void => {
      if (batch.length === 0 || this.#disposed || generation !== this.#generation || cancellation.token.isCancelled) return;
      for (const match of batch) {
        if (ownedPaths.has(bufferPathKey(match.rootId, match.path))) continue;
        streamed.push(match);
        combined.push(match);
      }
      // Cheap, unsorted intermediate publish; the final publish below sorts once.
      schedulePublish();
    };
    // Dirty-buffer text does not change while a single search run is in flight, so scan it
    // once instead of on every ripgrep batch. Run concurrently with the disk search: the
    // buffer scan must never delay starting rg (previously `await`ed before spawning it).
    const bufferPromise = computeBufferMatches(query, bufferSources, generation, limit, cancellation.token).then((result) => {
      if (!(this.#disposed || generation !== this.#generation || cancellation.token.isCancelled) && result.matches.length > 0) {
        for (const match of result.matches) combined.push(match);
        schedulePublish();
      }
      return result;
    });
    const diskPromise = this.#backend.search(query, cancellation.token, generation, onBatch);
    const [bufferResult, disk] = await Promise.all([bufferPromise, diskPromise]);
    const bufferMatches = bufferResult.matches;
    // A coalesced intermediate publish must never land after the final model below, or a
    // 'ready' result flips back to 'loading' and replace refuses to run.
    if (publishTimer !== undefined) { clearTimeout(publishTimer); publishTimer = undefined; }
    if (this.#pendingResolve === resolve) this.#pendingResolve = undefined;
    if (this.#disposed || generation !== this.#generation || cancellation.token.isCancelled) {
      resolve({ ok: false, error: { kind: 'stale', generation } });
      return;
    }
    if (!disk.ok) {
      const state = disk.error.kind === 'cancelled' ? 'stale' : 'error';
      const model = { ...this.#model, query, generation, state, message: failureMessage(disk.error) } as SearchReadModel;
      this.#publish(model);
      resolve({ ok: false, error: disk.error });
      return;
    }
    const filteredDisk = disk.value.filter((match) => !ownedPaths.has(bufferPathKey(match.rootId, match.path)));
    // Bounded top-N insertion (mirrors packages/services/navigation's picker index): keeps a
    // sorted, capped-at-`limit` array instead of concatenating every disk+buffer match and
    // sorting/slicing the whole thing, so a query with far more matches than `limit` only ever
    // maintains a small candidate set.
    const merged: SearchMatch[] = [];
    let totalMatches = 0;
    for (const match of filteredDisk) { totalMatches += 1; insertTopN(merged, match, limit); }
    totalMatches += bufferResult.total;
    for (const match of bufferMatches) insertTopN(merged, match, limit);
    const matches = merged;
    const model: SearchReadModel = Object.freeze({
      contractVersion: 1,
      query,
      generation,
      state: matches.length === 0 ? 'empty' : 'ready',
      matches: Object.freeze(matches),
      totalMatches,
      truncated: totalMatches > matches.length,
      message: totalMatches === 0 ? 'No matches' : undefined,
    });
    this.#publish(model);
    resolve({ ok: true, value: model });
  }

  #publish(model: SearchReadModel): void {
    this.#model = Object.freeze(model);
    for (const listener of [...this.#listeners]) listener(this.#model);
  }
}

/** Simple injected backend for tests and hosts that have no optional rg binary. */
export class InMemorySearchBackend implements SearchBackend {
  readonly #files: readonly { readonly rootId: string; readonly path: string; readonly text: string; readonly diskHash?: string }[];

  constructor(files: readonly { readonly rootId: string; readonly path: string; readonly text: string; readonly diskHash?: string }[]) {
    this.#files = Object.freeze(files.map((file) => Object.freeze({ ...file })));
  }

  async search(query: SearchQuery, cancellation: CancellationToken, generation: number, onBatch?: (matches: readonly SearchMatch[]) => void): Promise<Result<readonly SearchMatch[], SearchFailure>> {
    const expression = compileExpression(query);
    if (!expression.ok) return expression;
    const output: SearchMatch[] = [];
    for (const file of this.#files) {
      if (cancellation.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
      if (file.rootId !== query.rootId) continue;
      const lines = file.text.split('\n');
      for (let line = 0; line < lines.length; line += 1) {
        const lineText = lines[line] ?? '';
        expression.value.lastIndex = 0;
        let execMatch: RegExpExecArray | null;
        while ((execMatch = expression.value.exec(lineText)) !== null) {
          const start = execMatch.index;
          const end = start + execMatch[0].length;
          const resultMatch: SearchMatch = {
            id: `${file.rootId}:${file.path}:${line}:${start}:${generation}`,
            rootId: file.rootId,
            path: file.path,
            line,
            range: Object.freeze({ startUtf16: start, endUtf16: end }),
            lineText,
            snippet: lineText,
            source: 'disk',
            generation,
            ...(file.diskHash === undefined ? {} : { diskHash: file.diskHash }),
          };
          output.push(Object.freeze(resultMatch));
          if (execMatch[0].length === 0) expression.value.lastIndex += 1;
        }
      }
    }
    const result = Object.freeze(output);
    onBatch?.(result);
    return { ok: true, value: result };
  }
}

/**
 * Production content-search adapter. ripgrep owns filesystem traversal and
 * dialect execution; this service only parses its machine-readable stream and
 * publishes bounded, generation-tagged matches.
 */
export class RipgrepSearchBackend implements SearchBackend {
  readonly #process: ProcessPort;
  readonly #executable: string;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #timeoutMilliseconds: number;
  readonly #maxOutputBytes: number;

  constructor(options: RipgrepSearchBackendOptions) {
    this.#process = options.process;
    this.#executable = options.executable ?? 'rg';
    this.#environment = Object.freeze({ ...(options.environment ?? {}) });
    this.#timeoutMilliseconds = bounded(options.timeoutMilliseconds ?? 15_000, 1, 120_000);
    this.#maxOutputBytes = bounded(options.maxOutputBytes ?? 8 * 1024 * 1024, 4 * 1024, 64 * 1024 * 1024);
  }

  async search(query: SearchQuery, cancellation: CancellationToken, generation: number, onBatch?: (matches: readonly SearchMatch[]) => void): Promise<Result<readonly SearchMatch[], SearchFailure>> {
    if (cancellation.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
    if (query.query.length === 0) return { ok: true, value: Object.freeze([]) };
    // A minified/generated line with no line breaks can be megabytes long; without a column
    // cap rg still matches and emits it in full, which is exactly the pathological input the
    // output-byte cap below exists to guard against.
    const args: string[] = [this.#executable, '--json', '--no-heading', '--color', 'never', '--line-number', '--max-columns', '4096'];
    if (query.includeHidden === true) args.push('--hidden');
    args.push('--glob', '!.git/**', '--glob', '!node_modules/**');
    if (query.caseSensitive !== true) args.push('--ignore-case');
    if (query.wholeWord === true) args.push('--word-regexp');
    if (query.regex !== true) args.push('--fixed-strings');
    for (const glob of query.globs ?? []) args.push('--glob', glob);
    args.push('--', query.query, query.rootPath);
    const spawned = await this.#process.spawn({
      argv: args as [string, ...string[]],
      cwd: query.rootPath,
      env: this.#environment,
      stdin: 'ignore',
      timeoutMilliseconds: this.#timeoutMilliseconds,
      cancellation,
    });
    if (!spawned.ok) return { ok: false, error: { kind: 'backend', message: spawned.error.message } };
    const handle = spawned.value;
    const closeInput = handle.stdin?.close();
    if (closeInput !== undefined) await closeInput;
    const stderrPromise = readProcessStderr(handle.stderr);
    const maxResults = bounded(query.maxResults ?? 10_000, 1, 1_000_000);
    const { result: parsed, capped } = await parseRipgrepOutput(handle, query, generation, this.#maxOutputBytes, maxResults, cancellation, onBatch);
    const stderr = await stderrPromise;
    const exited = await handle.exit;
    if (!parsed.ok) return parsed;
    if (cancellation.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
    // A capped stop kills rg itself; its exit code/signal reflects that kill, not a failure.
    if (capped) return parsed;
    // A timeout or a killed process (e.g. the output-byte cap terminating rg) still leaves
    // whatever matches were already parsed from stdout before the kill; returning failure here
    // would discard real, already-verified results instead of surfacing them as a (partial)
    // success.
    if (!exited.ok) {
      if (parsed.value.length > 0) return parsed;
      return { ok: false, error: { kind: 'backend', message: exited.error.message } };
    }
    if (exited.value.code !== 0 && exited.value.code !== 1) {
      if (parsed.value.length > 0) return parsed;
      return { ok: false, error: { kind: 'backend', message: stderr.length > 0 ? stderr : `rg exited with code ${String(exited.value.code)}` } };
    }
    return parsed;
  }
}

class EmptySearchBackend implements SearchBackend {
  async search(_query: SearchQuery, cancellation: CancellationToken): Promise<Result<readonly SearchMatch[], SearchFailure>> {
    return cancellation.isCancelled ? { ok: false, error: { kind: 'cancelled' } } : { ok: true, value: Object.freeze([]) };
  }
}

interface ParsedRipgrepOutput {
  readonly result: Result<readonly SearchMatch[], SearchFailure>;
  /** True when parsing stopped early because `maxResults` was reached (rg was terminated by
   * us, not because it finished or failed on its own); the caller must not treat the resulting
   * kill signal/exit code as a backend failure in that case. */
  readonly capped: boolean;
}

async function parseRipgrepOutput(
  handle: { readonly stdout: AsyncIterable<Uint8Array>; terminate(forceAfterMilliseconds: number): Promise<void> },
  query: SearchQuery,
  generation: number,
  maxOutputBytes: number,
  maxResults: number,
  cancellation: CancellationToken,
  onBatch?: (matches: readonly SearchMatch[]) => void,
): Promise<ParsedRipgrepOutput> {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const matches: SearchMatch[] = [];
  let pending = '';
  let outputBytes = 0;
  let capped = false;
  let emitted = 0;
  for await (const chunk of handle.stdout) {
    if (cancellation.isCancelled) return { result: { ok: false, error: { kind: 'cancelled' } }, capped: false };
    outputBytes += chunk.byteLength;
    // The byte cap is checked after parsing this chunk's complete lines (below), not before:
    // a single stdout read can carry many complete lines and cross the cap in the same chunk,
    // and those already-decoded lines must still be kept, not discarded just because the cap
    // was reached partway through the chunk that contained them.
    const overCap = outputBytes > maxOutputBytes;
    pending += decoder.decode(chunk, { stream: true });
    // Index cursor instead of `pending = pending.slice(newline + 1)` per line: that repeated
    // slice re-copies the remaining tail on every line in a chunk (O(n^2) over a chunk with
    // many lines). The tail is sliced off once per chunk instead.
    let cursor = 0;
    let newline = pending.indexOf('\n', cursor);
    while (newline >= 0) {
      const before = matches.length;
      appendRipgrepRecord(pending.slice(cursor, newline), query, generation, matches);
      if (onBatch !== undefined && matches.length > before) {
        const batch = matches.slice(before);
        if (before === 0 || matches.length - emitted >= 32) {
          onBatch(Object.freeze(batch));
          emitted = matches.length;
        }
      }
      cursor = newline + 1;
      // Stop reading/parsing once enough matches are retained. `--max-count` would cap matches
      // per file searched by rg, not the total across the whole tree, so the cutoff is enforced
      // here instead once the result is already at the display bound.
      if (matches.length >= maxResults) { capped = true; break; }
      newline = pending.indexOf('\n', cursor);
    }
    pending = pending.slice(cursor);
    if (overCap) capped = true;
    if (capped) {
      await handle.terminate(50);
      break;
    }
  }
  if (!capped) {
    pending += decoder.decode();
    if (pending.length > 0) {
      const before = matches.length;
      appendRipgrepRecord(pending, query, generation, matches);
      if (onBatch !== undefined && matches.length > before) {
        onBatch(Object.freeze(matches.slice(before)));
        emitted = matches.length;
      }
    }
  }
  if (onBatch !== undefined && emitted < matches.length) onBatch(Object.freeze(matches.slice(emitted)));
  // matches parsed before the byte cap (or maxResults) are kept via `capped`, not discarded.
  return { result: { ok: true, value: Object.freeze(matches) }, capped };
}

async function readProcessStderr(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let output = '';
  for await (const chunk of stream) {
    if (output.length < 64 * 1024) output += decoder.decode(chunk, { stream: true }).slice(0, 64 * 1024 - output.length);
  }
  return `${output}${decoder.decode()}`.slice(0, 64 * 1024);
}

function appendRipgrepRecord(line: string, query: SearchQuery, generation: number, matches: SearchMatch[]): void {
  if (line.length === 0) return;
  let value: unknown;
  try { value = JSON.parse(line) as unknown; } catch { return; }
  if (!isRecord(value) || value['type'] !== 'match') return;
  const data = value['data'];
  if (!isRecord(data)) return;
  const pathValue = data['path'];
  const linesValue = data['lines'];
  const lineNumber = data['line_number'];
  const submatches = data['submatches'];
  if (!isRecord(pathValue) || (!isString(pathValue['text']) && !isString(pathValue['bytes'])) || !isRecord(linesValue) || typeof linesValue['text'] !== 'string' || typeof lineNumber !== 'number' || !Number.isSafeInteger(lineNumber) || !Array.isArray(submatches)) return;
  const rawPath = typeof pathValue['text'] === 'string' ? pathValue['text'] : `base64:${pathValue['bytes']}`;
  const path = normalizeSearchPath(query.rootPath, rawPath);
  const lineText = linesValue['text'].replace(/\r?\n$/u, '');
  for (const rawSubmatch of submatches) {
    if (!isRecord(rawSubmatch) || typeof rawSubmatch['start'] !== 'number' || typeof rawSubmatch['end'] !== 'number' || !Number.isSafeInteger(rawSubmatch['start']) || !Number.isSafeInteger(rawSubmatch['end'])) continue;
    const startByte = rawSubmatch['start'];
    const endByte = rawSubmatch['end'];
    const startUtf16 = utf8ByteToUtf16(lineText, startByte);
    const endUtf16 = utf8ByteToUtf16(lineText, endByte);
    if (startUtf16 === undefined || endUtf16 === undefined || endUtf16 < startUtf16) continue;
    matches.push(Object.freeze({
      id: `${query.rootId}:${path}:${lineNumber - 1}:${startUtf16}:${generation}`,
      rootId: query.rootId,
      path,
      line: lineNumber - 1,
      range: Object.freeze({ startUtf16, endUtf16 }),
      lineText,
      snippet: lineText,
      source: 'disk',
      generation,
    }));
  }
}

function utf8ByteToUtf16(value: string, byteOffset: number): number | undefined {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) return undefined;
  if (byteOffset === 0) return 0;
  let bytes = 0;
  let utf16 = 0;
  for (const character of value) {
    if (bytes === byteOffset) return utf16;
    bytes += utf8Length(character);
    utf16 += character.length;
    if (bytes > byteOffset) return undefined;
  }
  return bytes === byteOffset ? utf16 : undefined;
}

function utf8Length(character: string): number {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return 0;
  return codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string { return typeof value === 'string'; }

function normalizeSearchPath(rootPath: string, path: string): string {
  if (path.startsWith('base64:')) return path;
  const root = rootPath.replaceAll('\\', '/').replace(/\/+$/u, '');
  const normalized = path.replaceAll('\\', '/');
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  return normalized;
}

function normalizeQuery(query: SearchQuery, defaultLimit: number): SearchQuery {
  return Object.freeze({
    ...query,
    query: query.query,
    regex: query.regex === true,
    caseSensitive: query.caseSensitive === true,
    wholeWord: query.wholeWord === true,
    includeHidden: query.includeHidden === true,
    ...(query.globs === undefined ? {} : { globs: Object.freeze([...query.globs]) }),
    maxResults: bounded(query.maxResults ?? defaultLimit, 1, 100_000),
  });
}

function validateRegex(query: SearchQuery): SearchFailure | undefined {
  if (!query.regex) return undefined;
  try { new RegExp(query.query); return undefined; } catch (error: unknown) {
    return { kind: 'invalid-regex', message: error instanceof Error ? error.message : 'invalid regular expression' };
  }
}

function compileExpression(query: SearchQuery): Result<RegExp, SearchFailure> {
  const source = query.regex ? query.query : escapeRegExp(query.query);
  const boundedSource = query.wholeWord ? `\\b(?:${source})\\b` : source;
  try { return { ok: true, value: new RegExp(boundedSource, query.caseSensitive ? 'gu' : 'giu') }; }
  catch (error: unknown) { return { ok: false, error: { kind: 'invalid-regex', message: error instanceof Error ? error.message : 'invalid regular expression' } }; }
}

/** Key used to identify a dirty buffer's disk-owned path, avoiding an O(matches * buffers) scan. */
function bufferPathKey(rootId: string, path: string): string { return `${rootId}\0${path}`; }

function bufferOwnedPaths(buffers: readonly SearchBufferSource[]): Set<string> {
  const owned = new Set<string>();
  for (const buffer of buffers) owned.add(bufferPathKey(buffer.rootId, buffer.path));
  return owned;
}

// Kept well under the repository's 8ms ordinary-stall budget (docs/performance.md)
// so a run of lines between yields, plus `setTimeout(resolve, 0)` scheduling jitter, still lands
// inside that budget rather than merely under the old, looser 15ms test tolerance.
const BUFFER_SCAN_YIELD_BUDGET_MS = 2;

function yieldToMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Scans dirty-buffer text for matches. Call once per query run, not per batch: buffer text is
 * fixed for the run's duration.
 *
 * Walks lines with an `indexOf('\n', cursor)` cursor instead of `text.split('\n')`: a single
 * `split` on an up-to-8-MiB buffer materializes every line up front as one synchronous
 * main-thread step with no opportunity to cancel or yield mid-scan. The cursor walk yields to a
 * macrotask (and re-checks cancellation) whenever a run of lines has consumed more than
 * `BUFFER_SCAN_YIELD_BUDGET_MS`, and keeps only the best `limit` matches via `insertTopN` as it
 * goes rather than accumulating every match in an unbounded array; `total` still counts every
 * match found so truncation is reported accurately.
 */
async function computeBufferMatches(
  query: SearchQuery,
  buffers: readonly SearchBufferSource[],
  generation: number,
  limit: number,
  cancellation: CancellationToken,
): Promise<{ readonly matches: readonly SearchMatch[]; readonly total: number }> {
  const expression = compileExpression(query);
  if (!expression.ok) return { matches: [], total: 0 };
  const matches: SearchMatch[] = [];
  let total = 0;
  let sliceStart = performance.now();
  for (const buffer of buffers) {
    if (buffer.rootId !== query.rootId) continue;
    const text = buffer.text;
    let cursor = 0;
    let line = 0;
    while (cursor <= text.length) {
      if (cancellation.isCancelled) return { matches, total };
      const newline = text.indexOf('\n', cursor);
      const lineEnd = newline === -1 ? text.length : newline;
      const lineText = text.slice(cursor, lineEnd);
      expression.value.lastIndex = 0;
      let execMatch: RegExpExecArray | null;
      while ((execMatch = expression.value.exec(lineText)) !== null) {
        total += 1;
        const resultMatch: SearchMatch = {
          id: `${buffer.rootId}:${buffer.path}:${line}:${execMatch.index}:buffer:${buffer.version}`,
          rootId: buffer.rootId,
          path: buffer.path,
          line,
          range: Object.freeze({ startUtf16: execMatch.index, endUtf16: execMatch.index + execMatch[0].length }),
          lineText,
          snippet: lineText,
          source: 'buffer',
          documentVersion: buffer.version,
          generation,
          ...(buffer.diskHash === undefined ? {} : { diskHash: buffer.diskHash }),
        };
        insertTopN(matches, Object.freeze(resultMatch), limit);
        if (execMatch[0].length === 0) expression.value.lastIndex += 1;
      }
      if (newline === -1) break;
      cursor = lineEnd + 1;
      line += 1;
      if (performance.now() - sliceStart > BUFFER_SCAN_YIELD_BUDGET_MS) {
        await yieldToMacrotask();
        if (cancellation.isCancelled) return { matches, total };
        sliceStart = performance.now();
      }
    }
  }
  return { matches, total };
}

function compareSearchMatches(a: SearchMatch, b: SearchMatch): number {
  // A plain code-unit compare, not localeCompare: this orders a potentially large candidate
  // set on every insertion, and locale-aware collation is unnecessary overhead here (search
  // result ordering is not a user-facing sort key requiring locale correctness).
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.line - b.line || a.range.startUtf16 - b.range.startUtf16;
}

/**
 * Inserts `entry` into `list` (kept sorted by `compareSearchMatches`, ties preserving arrival
 * order), bounded at `cap` entries. See packages/services/navigation's `insertTopN` for the
 * same pattern applied to fuzzy file-picker results.
 */
function insertTopN(list: SearchMatch[], entry: SearchMatch, cap: number): void {
  if (cap <= 0) return;
  if (list.length >= cap) {
    const worst = list[list.length - 1]!;
    if (compareSearchMatches(entry, worst) >= 0) return;
  }
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compareSearchMatches(list[mid]!, entry) <= 0) low = mid + 1; else high = mid;
  }
  list.splice(low, 0, entry);
  if (list.length > cap) list.pop();
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
function bounded(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min;
}

function failureMessage(failure: SearchFailure): string {
  switch (failure.kind) {
    case 'cancelled': return 'search cancelled';
    case 'stale': return `search generation ${failure.generation} is stale`;
    case 'invalid-regex':
    case 'backend': return failure.message;
  }
}
