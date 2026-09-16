import { Renderable, type OptimizedBuffer, type RenderContext, type RenderableOptions, parseColor } from '@opentui/core/renderer';
import type { Disposable } from '../../contracts/src/index';

export interface CompletionItemRead { readonly id: string; readonly label: string; readonly detail?: string; readonly documentation?: string; }
export interface CompletionReadModel { readonly state: 'idle' | 'loading' | 'ready' | 'error'; readonly items: readonly CompletionItemRead[]; readonly selectedId: string | undefined; readonly documentation: string | undefined; readonly documentationOffset?: number; readonly message: string | undefined; }
export interface CompletionReadPort { readonly model: CompletionReadModel; subscribe(listener: (model: CompletionReadModel) => void): Disposable; }
export interface CompletionRenderableOptions extends RenderableOptions<CompletionRenderable> { readonly completion: CompletionReadPort; readonly maxRows?: number; }

export class CompletionRenderable extends Renderable {
  readonly #completion: CompletionReadPort; readonly #maxRows: number; readonly #subscription: Disposable;
  constructor(ctx: RenderContext, options: CompletionRenderableOptions) {
    super(ctx, { width: options.width ?? 40, height: options.height ?? 8, buffered: options.buffered ?? true, ...(options.id === undefined ? {} : { id: options.id }) });
    this.#completion = options.completion; this.#maxRows = Math.max(2, Math.trunc(options.maxRows ?? 8)); this.#subscription = this.#completion.subscribe(() => { if (!this.isDestroyed) this.requestRender(); }); this.requestRender();
  }
  protected override destroySelf(): void { this.#subscription.dispose(); super.destroySelf(); }
  protected override renderSelf(buffer: OptimizedBuffer): void { const bg = parseColor('#F1F0EC'); const fg = parseColor('#24292E'); const accent = parseColor('#245A88'); buffer.fillRect(0, 0, this.width, this.height, bg); const rows = formatCompletionLines(this.#completion.model, this.width, this.#maxRows); for (let row = 0; row < rows.length && row < this.height; row += 1) buffer.drawText(rows[row] ?? '', 0, row, row > 0 && this.#completion.model.items[row - 1]?.id === this.#completion.model.selectedId ? accent : fg, bg, 0); }
}
export function formatCompletionLines(model: CompletionReadModel, width: number, maxRows = 8): readonly string[] { const rows: string[] = []; if (model.state === 'idle') return Object.freeze([]); rows.push(model.message ?? (model.state === 'loading' ? 'Loading completions…' : 'Completions')); const itemRows = Math.max(0, maxRows - 1); for (const item of model.items.slice(0, itemRows)) rows.push(`${item.id === model.selectedId ? '▸ ' : '  '}${item.label}${item.detail === undefined ? '' : ` — ${item.detail}`}`.slice(0, Math.max(1, width))); return Object.freeze(rows); }

export interface SignatureReadModel { readonly state: 'idle' | 'loading' | 'ready' | 'error'; readonly label: string | undefined; readonly documentation: string | undefined; readonly activeParameter: number | undefined; readonly message: string | undefined; }
export interface SignatureReadPort { readonly model: SignatureReadModel; subscribe(listener: (model: SignatureReadModel) => void): Disposable; }
export interface SignatureRenderableOptions extends RenderableOptions<SignatureRenderable> { readonly signature: SignatureReadPort; }

export class SignatureRenderable extends Renderable {
  readonly #signature: SignatureReadPort; readonly #subscription: Disposable;
  constructor(ctx: RenderContext, options: SignatureRenderableOptions) { super(ctx, { width: options.width ?? 60, height: options.height ?? 5, buffered: options.buffered ?? true, ...(options.id === undefined ? {} : { id: options.id }) }); this.#signature = options.signature; this.#subscription = options.signature.subscribe(() => { if (!this.isDestroyed) this.requestRender(); }); this.requestRender(); }
  protected override destroySelf(): void { this.#subscription.dispose(); super.destroySelf(); }
  protected override renderSelf(buffer: OptimizedBuffer): void { const bg = parseColor('#F1F0EC'); const fg = parseColor('#24292E'); buffer.fillRect(0, 0, this.width, this.height, bg); const rows = formatSignatureLines(this.#signature.model, this.width, this.height); for (let row = 0; row < rows.length; row += 1) buffer.drawText(rows[row] ?? '', 0, row, fg, bg, 0); }
}
export function formatSignatureLines(model: SignatureReadModel, width: number, maxRows: number): readonly string[] { if (model.state === 'idle') return Object.freeze([]); const rows = [model.label ?? model.message ?? (model.state === 'loading' ? 'Loading signature…' : 'Signature help')]; if (model.documentation !== undefined) rows.push(...model.documentation.split('\n').slice(0, Math.max(0, maxRows - 1))); return Object.freeze(rows.map((row) => row.slice(0, Math.max(1, width)))); }
