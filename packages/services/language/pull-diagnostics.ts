import type { CancellationToken, Disposable, Result } from '../../contracts/src/index';

const MAX_RESULT_ID_UTF16 = 16 * 1024;
const MAX_DIAGNOSTIC_ITEMS = 10_000;

export interface PullDiagnosticReport<T> {
  readonly kind: 'full' | 'unchanged';
  /** Full reports may omit an ID; an unchanged report must carry one. */
  readonly resultId?: string;
  readonly items: readonly T[];
}

export interface PullDiagnosticWorkspaceItem<T> {
  readonly uri: string;
  readonly report: PullDiagnosticReport<T>;
}

export interface PullDiagnosticWorkspaceReport<T> {
  readonly items: readonly PullDiagnosticWorkspaceItem<T>[];
}

export type PullDiagnosticProviderFailure = { readonly kind: 'unavailable' | 'failed' | 'stale' | 'cancelled'; readonly message: string };

export interface PullDiagnosticProvider<T> {
  request(uri: string, previousResultId: string | undefined, generation: number, cancellation?: CancellationToken): Promise<Result<PullDiagnosticReport<T>, PullDiagnosticProviderFailure>>;
  requestWorkspace?(items: readonly { readonly uri: string; readonly previousResultId?: string }[], generation: number, cancellation?: CancellationToken): Promise<Result<PullDiagnosticWorkspaceReport<T>, PullDiagnosticProviderFailure>>;
}

export type PullDiagnosticFailure = { readonly kind: 'stale' | 'unavailable' | 'failed' | 'cancelled' | 'invalid-result' | 'disposed'; readonly message: string };

export interface PullDiagnosticSnapshot<T> {
  readonly uri: string;
  readonly generation: number;
  readonly resultId: string | undefined;
  readonly items: readonly T[];
  readonly state: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
  readonly message: string | undefined;
}

/**
 * Owns pull-diagnostic result IDs and immutable snapshots for one server.
 * Refresh generations are per URI, while restart epochs invalidate every
 * outstanding document and workspace request together.
 */
export class PullDiagnosticStore<T> implements Disposable {
  readonly #provider: PullDiagnosticProvider<T>;
  readonly #snapshots = new Map<string, PullDiagnosticSnapshot<T>>();
  readonly #activeGenerations = new Map<string, number>();
  #nextGeneration = 0;
  #restartEpoch = 0;
  #disposed = false;

  constructor(provider: PullDiagnosticProvider<T>) { this.#provider = provider; }

  get(uri: string): PullDiagnosticSnapshot<T> | undefined { return this.#snapshots.get(uri); }

  async refresh(uri: string, cancellation?: CancellationToken): Promise<Result<PullDiagnosticSnapshot<T>, PullDiagnosticFailure>> {
    if (this.#disposed) return failure('disposed', 'pull diagnostics disposed');
    if (!validUri(uri)) return failure('invalid-result', 'pull diagnostic URI must be nonempty');
    if (cancellation?.isCancelled) return failure('cancelled', 'pull diagnostic refresh was cancelled');

    const generation = ++this.#nextGeneration;
    const epoch = this.#restartEpoch;
    const previous = this.#snapshots.get(uri);
    const previousResultId = previous?.state === 'ready' ? previous.resultId : undefined;
    this.#activeGenerations.set(uri, generation);
    this.#snapshots.set(uri, loadingSnapshot(uri, generation));

    let result: Result<PullDiagnosticReport<T>, PullDiagnosticProviderFailure>;
    try {
      result = await this.#provider.request(uri, previousResultId, generation, cancellation);
    } catch (error) {
      return this.finishFailure(uri, generation, epoch, 'failed', errorMessage(error));
    }
    if (!this.current(uri, generation, epoch)) return failure('stale', 'pull diagnostic refresh is stale');
    if (cancellation?.isCancelled) return this.finishFailure(uri, generation, epoch, 'cancelled', 'pull diagnostic refresh was cancelled');
    if (!result.ok) {
      const kind = result.error.kind === 'unavailable' ? 'unavailable' : result.error.kind === 'cancelled' ? 'cancelled' : result.error.kind === 'stale' ? 'stale' : 'failed';
      return this.finishFailure(uri, generation, epoch, kind, result.error.message);
    }

    const checked = validateReport(result.value, previousResultId, previous);
    if (!checked.ok) return this.finishFailure(uri, generation, epoch, checked.error.kind, checked.error.message);
    const snapshot = readySnapshot(uri, generation, checked.value.resultId, checked.value.items);
    this.#snapshots.set(uri, snapshot);
    return { ok: true, value: snapshot };
  }

  /** Apply one workspace response atomically; a malformed or partial response publishes nothing. */
  async refreshWorkspace(uris: readonly string[], cancellation?: CancellationToken): Promise<Result<readonly PullDiagnosticSnapshot<T>[], PullDiagnosticFailure>> {
    if (this.#disposed) return failure('disposed', 'pull diagnostics disposed');
    if (this.#provider.requestWorkspace === undefined) return failure('unavailable', 'workspace diagnostic pull is unavailable');
    if (!validUriList(uris)) return failure('invalid-result', 'workspace diagnostic URIs are invalid or duplicated');
    if (cancellation?.isCancelled) return failure('cancelled', 'workspace diagnostic refresh was cancelled');

    const generation = ++this.#nextGeneration;
    const epoch = this.#restartEpoch;
    const previous = new Map<string, PullDiagnosticSnapshot<T> | undefined>();
    const requestItems = uris.map((uri) => {
      const snapshot = this.#snapshots.get(uri);
      previous.set(uri, snapshot);
      this.#activeGenerations.set(uri, generation);
      this.#snapshots.set(uri, loadingSnapshot(uri, generation));
      return Object.freeze({ uri, ...(snapshot?.state === 'ready' && snapshot.resultId !== undefined ? { previousResultId: snapshot.resultId } : {}) });
    });

    let result: Result<PullDiagnosticWorkspaceReport<T>, PullDiagnosticProviderFailure>;
    try {
      result = await this.#provider.requestWorkspace(requestItems, generation, cancellation);
    } catch (error) {
      return this.finishWorkspaceFailure(uris, generation, epoch, 'failed', errorMessage(error));
    }
    if (!uris.every((uri) => this.current(uri, generation, epoch))) return failure('stale', 'workspace diagnostic refresh is stale');
    if (cancellation?.isCancelled) return this.finishWorkspaceFailure(uris, generation, epoch, 'cancelled', 'workspace diagnostic refresh was cancelled');
    if (!result.ok) {
      const kind = result.error.kind === 'unavailable' ? 'unavailable' : result.error.kind === 'cancelled' ? 'cancelled' : result.error.kind === 'stale' ? 'stale' : 'failed';
      return this.finishWorkspaceFailure(uris, generation, epoch, kind, result.error.message);
    }
    if (!isRecord(result.value) || !Array.isArray(result.value['items']) || result.value['items'].length !== uris.length) {
      return this.finishWorkspaceFailure(uris, generation, epoch, 'invalid-result', 'workspace diagnostic response is partial or duplicated');
    }

    const requested = new Set(uris);
    const decoded = new Map<string, { readonly resultId: string | undefined; readonly items: readonly T[] }>();
    for (const item of result.value.items) {
      if (!isRecord(item) || typeof item['uri'] !== 'string' || !requested.has(item['uri']) || decoded.has(item['uri'])) {
        return this.finishWorkspaceFailure(uris, generation, epoch, 'invalid-result', 'workspace diagnostic response contains an unknown or duplicate URI');
      }
      const report = item['report'];
      const prior = previous.get(item['uri']);
      const priorId = prior?.state === 'ready' ? prior.resultId : undefined;
      const checked = validateReport(report, priorId, prior);
      if (!checked.ok) return this.finishWorkspaceFailure(uris, generation, epoch, checked.error.kind, checked.error.message);
      if (!isRecord(report)) return this.finishWorkspaceFailure(uris, generation, epoch, 'invalid-result', 'workspace diagnostic report is not an object');
      decoded.set(item['uri'], { resultId: optionalResultId(report['resultId']), items: checked.value.items });
    }
    if (decoded.size !== uris.length) return this.finishWorkspaceFailure(uris, generation, epoch, 'invalid-result', 'workspace diagnostic response omitted a requested URI');

    const snapshots: PullDiagnosticSnapshot<T>[] = [];
    for (const uri of uris) {
      const value = decoded.get(uri);
      if (value === undefined) return this.finishWorkspaceFailure(uris, generation, epoch, 'invalid-result', 'workspace diagnostic response could not be indexed');
      const snapshot = readySnapshot(uri, generation, value.resultId, value.items);
      this.#snapshots.set(uri, snapshot);
      snapshots.push(snapshot);
    }
    return { ok: true, value: Object.freeze(snapshots) };
  }

  restart(): void {
    if (this.#disposed) return;
    this.#restartEpoch += 1;
    this.#activeGenerations.clear();
    for (const uri of this.#snapshots.keys()) {
      const generation = ++this.#nextGeneration;
      this.#snapshots.set(uri, Object.freeze({ uri, generation, resultId: undefined, items: Object.freeze([]), state: 'idle', message: undefined }));
    }
  }

  clear(uri: string): void {
    if (this.#disposed) return;
    this.#activeGenerations.delete(uri);
    this.#snapshots.delete(uri);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#restartEpoch += 1;
    this.#activeGenerations.clear();
    this.#snapshots.clear();
  }

  private current(uri: string, generation: number, epoch: number): boolean {
    return !this.#disposed && epoch === this.#restartEpoch && this.#activeGenerations.get(uri) === generation;
  }

  private finishFailure(uri: string, generation: number, epoch: number, kind: PullDiagnosticFailure['kind'], message: string): Result<never, PullDiagnosticFailure> {
    if (!this.current(uri, generation, epoch)) return failure('stale', 'pull diagnostic refresh is stale');
    this.#snapshots.set(uri, Object.freeze({ uri, generation, resultId: undefined, items: Object.freeze([]), state: kind === 'unavailable' ? 'unavailable' : 'error', message }));
    return failure(kind, message);
  }

  private finishWorkspaceFailure(uris: readonly string[], generation: number, epoch: number, kind: PullDiagnosticFailure['kind'], message: string): Result<never, PullDiagnosticFailure> {
    if (!uris.every((uri) => this.current(uri, generation, epoch))) return failure('stale', 'workspace diagnostic refresh is stale');
    for (const uri of uris) this.#snapshots.set(uri, Object.freeze({ uri, generation, resultId: undefined, items: Object.freeze([]), state: kind === 'unavailable' ? 'unavailable' : 'error', message }));
    return failure(kind, message);
  }
}

function validateReport<T>(value: unknown, previousResultId: string | undefined, previous: PullDiagnosticSnapshot<T> | undefined): Result<{ readonly resultId: string | undefined; readonly items: readonly T[] }, PullDiagnosticFailure> {
  if (!isRecord(value) || (value['kind'] !== 'full' && value['kind'] !== 'unchanged') || !Array.isArray(value['items']) || value['items'].length > MAX_DIAGNOSTIC_ITEMS) {
    return failure('invalid-result', 'pull diagnostic report has an invalid shape or exceeds the item limit');
  }
  const kind = value['kind'];
  const resultId = optionalResultId(value['resultId']);
  if (value['resultId'] !== undefined && resultId === undefined) return failure('invalid-result', 'pull diagnostic result ID is invalid');
  if (kind === 'unchanged') {
    if (previousResultId === undefined || previous?.state !== 'ready' || previous.resultId !== previousResultId || resultId === undefined || value['items'].length !== 0) {
      return failure('invalid-result', 'unchanged diagnostics require the current result ID and a valid baseline');
    }
    return { ok: true, value: { resultId, items: Object.freeze([...(previous.items)]) } };
  }
  return { ok: true, value: { resultId, items: Object.freeze([...(value['items'] as T[])]) } };
}

function loadingSnapshot<T>(uri: string, generation: number): PullDiagnosticSnapshot<T> {
  return Object.freeze({ uri, generation, resultId: undefined, items: Object.freeze([]), state: 'loading', message: undefined });
}

function readySnapshot<T>(uri: string, generation: number, resultId: string | undefined, items: readonly T[]): PullDiagnosticSnapshot<T> {
  return Object.freeze({ uri, generation, resultId, items: Object.freeze([...items]), state: 'ready', message: undefined });
}

function optionalResultId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_RESULT_ID_UTF16 ? value : undefined;
}

function validUri(value: string): boolean { return typeof value === 'string' && value.length > 0 && value.length <= MAX_RESULT_ID_UTF16; }
function validUriList(values: readonly string[]): boolean { return Array.isArray(values) && values.length > 0 && values.length <= MAX_DIAGNOSTIC_ITEMS && values.every(validUri) && new Set(values).size === values.length; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function failure(kind: PullDiagnosticFailure['kind'], message: string): Result<never, PullDiagnosticFailure> { return { ok: false, error: { kind, message } }; }
