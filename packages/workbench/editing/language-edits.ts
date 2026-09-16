import type { Disposable, Result } from '../../contracts/src/index';

export interface SelectionEdit { readonly memberId: string; readonly start: number; readonly end: number; readonly text: string; }
export interface AdditionalEdit { readonly start: number; readonly end: number; readonly text: string; }
export interface MultiCursorLanguageResponse { readonly documentVersion: number; readonly selectionGeneration: number; readonly primary: SelectionEdit; readonly additional: readonly AdditionalEdit[]; }
export type MultiCursorEditFailure = { readonly kind: 'stale' | 'overlap' | 'incompatible' | 'disposed'; readonly message: string };
export interface MultiCursorEditPort { apply(edits: readonly SelectionEdit[], additional: readonly AdditionalEdit[]): Result<void, MultiCursorEditFailure>; }

export class MultiCursorLanguageEditCoordinator implements Disposable {
  readonly #port: MultiCursorEditPort; #version: number; #selectionGeneration: number; #disposed = false;
  constructor(port: MultiCursorEditPort, version: number, selectionGeneration: number) { this.#port = port; this.#version = version; this.#selectionGeneration = selectionGeneration; }
  updateVersion(version: number, selectionGeneration: number): void { this.#version = version; this.#selectionGeneration = selectionGeneration; }
  apply(response: MultiCursorLanguageResponse): Result<void, MultiCursorEditFailure> { if (this.#disposed) return { ok: false, error: { kind: 'disposed', message: 'multi-cursor edit disposed' } }; if (response.documentVersion !== this.#version || response.selectionGeneration !== this.#selectionGeneration) return { ok: false, error: { kind: 'stale', message: 'language edit targets a moved selection or newer document' } }; const deduped: AdditionalEdit[] = []; const seen = new Set<string>(); for (const edit of response.additional) { const key = `${edit.start}:${edit.end}:${edit.text}`; if (seen.has(key)) continue; seen.add(key); deduped.push(edit); } const all = [...deduped.map((edit) => ({ start: edit.start, end: edit.end })), { start: response.primary.start, end: response.primary.end }].sort((a, b) => a.start - b.start || a.end - b.end); for (let i = 1; i < all.length; i += 1) { const prior = all[i - 1]; const current = all[i]; if (prior && current && current.start < prior.end) return { ok: false, error: { kind: 'overlap', message: 'language edits overlap' } }; } return this.#port.apply([response.primary], deduped); }
  dispose(): void { this.#disposed = true; }
}
