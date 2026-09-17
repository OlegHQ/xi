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
}

export class DiagnosticStore implements Disposable {
  readonly #entries = new Map<string, readonly LanguageDiagnostic[]>();
  readonly #generations = new Map<string, number>();
  readonly #listeners = new Set<(model: DiagnosticReadModel) => void>();
  /** Sorted per-URI diagnostics, kept current incrementally: only the touched URI is re-sorted on publish/clear. */
  readonly #sortedByUri = new Map<string, readonly LanguageDiagnostic[]>();
  #byUriCache: ReadonlyMap<string, readonly LanguageDiagnostic[]> | undefined;
  #allCache: readonly LanguageDiagnostic[] | undefined;
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
    const diagnostics: LanguageDiagnostic[] = input.diagnostics.map((diagnostic, index) => Object.freeze({
      ...diagnostic,
      id: `${input.serverId}:${input.uri}:${input.generation}:${index}`,
      uri: input.uri,
      serverId: input.serverId,
      documentVersion: input.documentVersion,
      generation: input.generation,
    }));
    const key = sourceKey(input.serverId, input.uri);
    this.#entries.set(key, Object.freeze(diagnostics));
    this.recomputeUri(input.uri);
    this.#generation += 1;
    this.notify();
    return true;
  }

  clearUri(uri: string): void {
    if (this.#disposed) return;
    let changed = false;
    for (const key of this.#entries.keys()) {
      if (key.endsWith(`\u0000${uri}`)) { this.#entries.delete(key); changed = true; }
    }
    this.#generations.delete(uri);
    if (changed) {
      this.recomputeUri(uri);
      this.#generation += 1;
      this.notify();
    }
  }

  clearServer(serverId: string): void {
    if (this.#disposed) return;
    const prefix = `${serverId}\u0000`;
    const affectedUris = new Set<string>();
    let changed = false;
    for (const key of this.#entries.keys()) {
      if (key.startsWith(prefix)) {
        affectedUris.add(key.slice(prefix.length));
        this.#entries.delete(key);
        changed = true;
      }
    }
    if (changed) {
      for (const uri of affectedUris) this.recomputeUri(uri);
      this.#generation += 1;
      this.notify();
    }
  }

  diagnosticsFor(uri: string): readonly LanguageDiagnostic[] {
    return this.#sortedByUri.get(uri) ?? Object.freeze([]);
  }

  snapshot(): DiagnosticReadModel {
    if (this.#byUriCache === undefined) this.#byUriCache = new Map(this.#sortedByUri);
    if (this.#allCache === undefined) this.#allCache = Object.freeze([...this.#sortedByUri.values()].flat());
    return Object.freeze({ contractVersion: 1, generation: this.#generation, byUri: this.#byUriCache, all: this.#allCache });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#entries.clear();
    this.#generations.clear();
    this.#sortedByUri.clear();
    this.#byUriCache = undefined;
    this.#allCache = undefined;
    this.#listeners.clear();
  }

  private notify(): void { const model = this.snapshot(); for (const listener of [...this.#listeners]) listener(model); }

  /** Re-sort only the URI whose entries changed; invalidates the cached flattened/grouped snapshot views. */
  private recomputeUri(uri: string): void {
    const suffix = `\u0000${uri}`;
    const values: LanguageDiagnostic[] = [];
    for (const [key, entries] of this.#entries) if (key.endsWith(suffix)) values.push(...entries);
    if (values.length === 0) this.#sortedByUri.delete(uri);
    else this.#sortedByUri.set(uri, Object.freeze(values.sort(compareDiagnostics)));
    this.#byUriCache = undefined;
    this.#allCache = undefined;
  }
}

function sourceKey(serverId: string, uri: string): string { return `${serverId}\u0000${uri}`; }
function compareDiagnostics(a: LanguageDiagnostic, b: LanguageDiagnostic): number { return a.range.startLine - b.range.startLine || a.range.startUtf16 - b.range.startUtf16 || a.message.localeCompare(b.message); }
