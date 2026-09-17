import type { Disposable } from '../../contracts/src/index';

export interface LanguageDiagnosticRange {
  readonly startLine: number;
  readonly startUtf16: number;
  readonly endLine: number;
  readonly endUtf16: number;
}

export interface LanguageDiagnostic {
  readonly id: string;
  readonly uri: string;
  readonly range: LanguageDiagnosticRange;
  readonly message: string;
  readonly severity: 1 | 2 | 3 | 4 | undefined;
  readonly source: string | undefined;
  readonly code: string | number | undefined;
  readonly serverId: string;
  readonly documentVersion: number | undefined;
  readonly generation: number;
}

export interface DiagnosticPublish {
  readonly serverId: string;
  readonly uri: string;
  readonly generation: number;
  readonly documentVersion?: number;
  readonly diagnostics: readonly Omit<LanguageDiagnostic, 'id' | 'uri' | 'serverId' | 'documentVersion' | 'generation'>[];
}

export interface DiagnosticReadModel {
  readonly contractVersion: 1;
  readonly generation: number;
  readonly byUri: ReadonlyMap<string, readonly LanguageDiagnostic[]>;
  readonly all: readonly LanguageDiagnostic[];
  /** URIs whose merged diagnostics exceeded `DIAGNOSTICS_PER_URI_LIMIT` and were truncated by position, never silently dropped. */
  readonly truncatedUris: ReadonlySet<string>;
}

/** Per-URI cap on merged (across servers) diagnostics kept for display; publishing more sets `truncatedUris` for that URI instead of sorting/rendering an unbounded set. */
export const DIAGNOSTICS_PER_URI_LIMIT = 2_000;

export class DiagnosticStore implements Disposable {
  /** uri -> serverId -> that server's diagnostics for the uri. Indexed by URI so recompute/clear touches only the affected URI, never every open URI. */
  readonly #entriesByUri = new Map<string, Map<string, readonly LanguageDiagnostic[]>>();
  readonly #generations = new Map<string, number>();
  readonly #listeners = new Set<(model: DiagnosticReadModel) => void>();
  /** Sorted per-URI diagnostics, kept current incrementally: only the touched URI is re-sorted on publish/clear. */
  readonly #sortedByUri = new Map<string, readonly LanguageDiagnostic[]>();
  readonly #truncatedUris = new Set<string>();
  #snapshotCache: DiagnosticReadModel | undefined;
  #generation = 0;
  #disposed = false;

  get model(): DiagnosticReadModel { return this.snapshot(); }

  subscribe(listener: (model: DiagnosticReadModel) => void): Disposable {
    if (this.#disposed) throw new Error('diagnostic-store-disposed');
    this.#listeners.add(listener);
    return Object.freeze({ dispose: () => { this.#listeners.delete(listener); } });
  }

  /** Record a document generation before sending it to a server. */
  markDocumentGeneration(uri: string, generation: number): void {
    if (this.#disposed || !Number.isSafeInteger(generation) || generation < 0) return;
    const current = this.#generations.get(uri) ?? -1;
    if (generation > current) this.#generations.set(uri, generation);
  }

  publish(input: DiagnosticPublish): boolean {
    if (this.#disposed) return false;
    const currentGeneration = this.#generations.get(input.uri) ?? -1;
    if (input.generation < currentGeneration) return false;
    if (input.documentVersion !== undefined && !Number.isSafeInteger(input.documentVersion)) return false;
    this.#generations.set(input.uri, input.generation);
    // Individual diagnostics are not frozen (only the per-source and per-URI
    // arrays are): freezing every one of up to 10k objects on a bulk publish is
    // measurably expensive and the array freeze already prevents callers from
    // adding/removing entries, which is what the read model contract needs.
    // A monomorphic object literal (same key order every iteration) is built
    // with an explicit field list instead of object-spread, which is
    // measurably faster for a batch of up to 10k diagnostics on one publish.
    // Admission bound: a single oversized publish is cut in array order before any
    // object building/sorting, so the integration cost is O(limit), not O(payload).
    const admitted = Math.min(input.diagnostics.length, DIAGNOSTICS_PER_URI_LIMIT);
    const idPrefix = `${input.serverId}:${input.uri}:${input.generation}:`;
    const diagnostics: LanguageDiagnostic[] = new Array(admitted);
    for (let index = 0; index < admitted; index += 1) {
      const source = input.diagnostics[index]!;
      diagnostics[index] = {
        range: source.range,
        message: source.message,
        severity: source.severity,
        source: source.source,
        code: source.code,
        id: idPrefix + index,
        uri: input.uri,
        serverId: input.serverId,
        documentVersion: input.documentVersion,
        generation: input.generation,
      };
    }
    const perServer = this.#entriesByUri.get(input.uri) ?? new Map<string, readonly LanguageDiagnostic[]>();
    perServer.set(input.serverId, Object.freeze(diagnostics));
    this.#entriesByUri.set(input.uri, perServer);
    this.recomputeUri(input.uri);
    if (admitted < input.diagnostics.length) this.#truncatedUris.add(input.uri);
    this.#generation += 1;
    this.notify();
    return true;
  }

  clearUri(uri: string): void {
    if (this.#disposed) return;
    const changed = this.#entriesByUri.delete(uri);
    this.#generations.delete(uri);
    if (changed) {
      this.recomputeUri(uri);
      this.#generation += 1;
      this.notify();
    }
  }

  clearServer(serverId: string): void {
    if (this.#disposed) return;
    const affectedUris: string[] = [];
    for (const [uri, perServer] of this.#entriesByUri) {
      if (!perServer.delete(serverId)) continue;
      affectedUris.push(uri);
      if (perServer.size === 0) this.#entriesByUri.delete(uri);
    }
    if (affectedUris.length > 0) {
      for (const uri of affectedUris) this.recomputeUri(uri);
      this.#generation += 1;
      this.notify();
    }
  }

  diagnosticsFor(uri: string): readonly LanguageDiagnostic[] {
    return this.#sortedByUri.get(uri) ?? Object.freeze([]);
  }

  /** Immutable per-generation snapshot. `byUri`/`truncatedUris` are O(URIs) copies of frozen
   * arrays; flattening `all` across every URI is O(total diagnostics) and only the Problems
   * panel reads it, so it is memoized lazily on the snapshot instead of built on every publish. */
  snapshot(): DiagnosticReadModel {
    if (this.#snapshotCache !== undefined) return this.#snapshotCache;
    const byUri: ReadonlyMap<string, readonly LanguageDiagnostic[]> = new Map(this.#sortedByUri);
    let all: readonly LanguageDiagnostic[] | undefined;
    this.#snapshotCache = Object.freeze({
      contractVersion: 1 as const,
      generation: this.#generation,
      byUri,
      get all(): readonly LanguageDiagnostic[] { return all ??= Object.freeze([...byUri.values()].flat()); },
      truncatedUris: new Set(this.#truncatedUris),
    });
    return this.#snapshotCache;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#entriesByUri.clear();
    this.#generations.clear();
    this.#sortedByUri.clear();
    this.#truncatedUris.clear();
    this.#snapshotCache = undefined;
    this.#listeners.clear();
  }

  private notify(): void { const model = this.snapshot(); for (const listener of [...this.#listeners]) listener(model); }

  /** Re-sort only the URI whose entries changed; touches just that URI's servers, never the other open URIs. Invalidates the cached flattened/grouped snapshot views. */
  private recomputeUri(uri: string): void {
    const perServer = this.#entriesByUri.get(uri);
    if (perServer === undefined || perServer.size === 0) {
      this.#sortedByUri.delete(uri);
      this.#truncatedUris.delete(uri);
    } else {
      const values: LanguageDiagnostic[] = [];
      for (const entries of perServer.values()) values.push(...entries);
      values.sort(compareDiagnostics);
      const truncated = values.length > DIAGNOSTICS_PER_URI_LIMIT;
      this.#sortedByUri.set(uri, Object.freeze(truncated ? values.slice(0, DIAGNOSTICS_PER_URI_LIMIT) : values));
      if (truncated) this.#truncatedUris.add(uri); else this.#truncatedUris.delete(uri);
    }
    this.#snapshotCache = undefined;
  }
}

/** Numeric-only comparator (no locale-aware string comparison): position, then severity, then a cheap ordinal id tiebreak for determinism. */
function compareDiagnostics(a: LanguageDiagnostic, b: LanguageDiagnostic): number {
  return a.range.startLine - b.range.startLine
    || a.range.startUtf16 - b.range.startUtf16
    || (a.severity ?? 5) - (b.severity ?? 5)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
