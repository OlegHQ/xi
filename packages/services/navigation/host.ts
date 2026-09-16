import type { Disposable, Result } from '../../contracts/src/index';

export interface HostLocation {
  readonly uri: string;
  /** Zero-based logical line, independent of the display or file's EOL bytes. */
  readonly line: number;
  /** Zero-based UTF-16 column on that line. */
  readonly utf16: number;
  readonly viewId?: string;
}
export type HostNavigationFailure = { readonly kind: 'missing' | 'ambiguous' | 'unavailable' | 'cancelled' | 'stale'; readonly message: string };
export interface HostNavigationProvider {
  file(path: string, line?: number): Promise<Result<HostLocation, HostNavigationFailure>>;
  tag(name: string): Promise<Result<readonly HostLocation[], HostNavigationFailure>>;
}
export interface HostNavigationResult { readonly location: HostLocation; readonly previous: HostLocation | undefined; readonly historyIndex: number; }

export class HostNavigationController implements Disposable {
  readonly #provider: HostNavigationProvider; readonly #history: HostLocation[] = []; #generation = 0; #disposed = false; #current: HostLocation | undefined;
  constructor(provider: HostNavigationProvider) { this.#provider = provider; }
  get current(): HostLocation | undefined { return this.#current; } get history(): readonly HostLocation[] { return Object.freeze([...this.#history]); }
  async openFile(path: string, line?: number): Promise<Result<HostNavigationResult, HostNavigationFailure>> { return this.commit(await this.#provider.file(path, line)); }
  async openTag(name: string): Promise<Result<HostNavigationResult, HostNavigationFailure>> { const generation = ++this.#generation; const result = await this.#provider.tag(name); if (generation !== this.#generation) return { ok: false, error: { kind: 'stale', message: 'tag request is stale' } }; if (!result.ok) return result; if (result.value.length === 0) return { ok: false, error: { kind: 'missing', message: `tag ${name} was not found` } }; if (result.value.length > 1) return { ok: false, error: { kind: 'ambiguous', message: `tag ${name} has multiple matches` } }; return this.commit({ ok: true, value: result.value[0]! }); }
  back(): HostLocation | undefined { if (this.#history.length < 2) return this.#current; this.#history.pop(); this.#current = this.#history.at(-1); return this.#current; }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.#generation += 1; this.#history.length = 0; this.#current = undefined; }
  private commit(result: Result<HostLocation, HostNavigationFailure>): Result<HostNavigationResult, HostNavigationFailure> { if (this.#disposed) return { ok: false, error: { kind: 'cancelled', message: 'navigation disposed' } }; if (!result.ok) return result; const previous = this.#current; this.#current = result.value; this.#history.push(result.value); return { ok: true, value: Object.freeze({ location: result.value, previous, historyIndex: this.#history.length - 1 }) }; }
}
