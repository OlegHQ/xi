import { Renderable, type OptimizedBuffer, type RenderContext, type RenderableOptions, parseColor } from '@opentui/core/renderer';
import type { Disposable } from '../../contracts/src/index';

export interface OutlineSymbolRead { readonly id: string; readonly name: string; readonly detail?: string; readonly kind: number; readonly children: readonly OutlineSymbolRead[]; }
export interface OutlineReadModel { readonly state: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'; readonly symbols: readonly OutlineSymbolRead[]; readonly message: string | undefined; }
export interface OutlineReadPort { readonly model: OutlineReadModel; subscribe(listener: (model: OutlineReadModel) => void): Disposable; }
export interface OutlineRenderableOptions extends RenderableOptions<OutlineRenderable> { readonly outline: OutlineReadPort; readonly maxRows?: number; }
export class OutlineRenderable extends Renderable {
  readonly #outline: OutlineReadPort; readonly #maxRows: number; readonly #subscription: Disposable;
  constructor(ctx: RenderContext, options: OutlineRenderableOptions) { super(ctx, { width: options.width ?? 32, height: options.height ?? 12, buffered: options.buffered ?? true, ...(options.id === undefined ? {} : { id: options.id }) }); this.#outline = options.outline; this.#maxRows = Math.max(2, Math.trunc(options.maxRows ?? 12)); this.#subscription = options.outline.subscribe(() => { if (!this.isDestroyed) this.requestRender(); }); this.requestRender(); }
  protected override destroySelf(): void { this.#subscription.dispose(); super.destroySelf(); }
  protected override renderSelf(buffer: OptimizedBuffer): void { const bg = parseColor('#F1F0EC'); const fg = parseColor('#24292E'); buffer.fillRect(0, 0, this.width, this.height, bg); const rows = formatOutlineLines(this.#outline.model, this.width, this.#maxRows); for (let i = 0; i < rows.length && i < this.height; i += 1) buffer.drawText(rows[i] ?? '', 0, i, fg, bg, 0); }
}
export function formatOutlineLines(model: OutlineReadModel, width: number, maxRows = 12): readonly string[] { const rows = [model.message ?? (model.state === 'loading' ? 'Outline loading…' : model.state === 'unavailable' ? 'Outline unavailable' : 'Outline')]; const visit = (symbols: readonly OutlineSymbolRead[], depth: number): void => { for (const symbol of symbols) { if (rows.length >= maxRows) return; rows.push(`${'  '.repeat(depth)}${symbol.name}${symbol.detail === undefined ? '' : ` — ${symbol.detail}`}`.slice(0, Math.max(1, width))); visit(symbol.children, depth + 1); } }; visit(model.symbols, 0); return Object.freeze(rows); }

export interface HierarchyNodeRead { readonly id: string; readonly name: string; readonly detail?: string; readonly kind: number; readonly children: readonly HierarchyNodeRead[]; readonly cycle?: boolean; }
export interface HierarchyLinkRead { readonly target?: string; readonly tooltip?: string; }
export interface HierarchyReadModel { readonly state: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'; readonly nodes: readonly HierarchyNodeRead[]; readonly links: readonly HierarchyLinkRead[]; readonly message: string | undefined; }
export interface HierarchyReadPort { readonly model: HierarchyReadModel; subscribe(listener: (model: HierarchyReadModel) => void): Disposable; }
export interface HierarchyRenderableOptions extends RenderableOptions<HierarchyRenderable> { readonly hierarchy: HierarchyReadPort; readonly maxRows?: number; }

/** Bounded hierarchy presentation. Expansion and link opening remain application-owned actions. */
export class HierarchyRenderable extends Renderable {
  readonly #hierarchy: HierarchyReadPort; readonly #maxRows: number; readonly #subscription: Disposable;
  constructor(ctx: RenderContext, options: HierarchyRenderableOptions) {
    super(ctx, { width: options.width ?? 40, height: options.height ?? 14, buffered: options.buffered ?? true, ...(options.id === undefined ? {} : { id: options.id }) });
    this.#hierarchy = options.hierarchy;
    this.#maxRows = Math.max(2, Math.trunc(options.maxRows ?? 14));
    this.#subscription = options.hierarchy.subscribe(() => { if (!this.isDestroyed) this.requestRender(); });
    this.requestRender();
  }
  protected override destroySelf(): void { this.#subscription.dispose(); super.destroySelf(); }
  protected override renderSelf(buffer: OptimizedBuffer): void {
    const background = parseColor('#F1F0EC'); const foreground = parseColor('#24292E');
    buffer.fillRect(0, 0, this.width, this.height, background);
    const rows = formatHierarchyLines(this.#hierarchy.model, this.width, this.#maxRows);
    for (let row = 0; row < rows.length && row < this.height; row += 1) buffer.drawText(rows[row] ?? '', 0, row, foreground, background, 0);
  }
}

export function formatHierarchyLines(model: HierarchyReadModel, width: number, maxRows = 14): readonly string[] {
  const title = model.message ?? (model.state === 'loading' ? 'Hierarchy loading…' : model.state === 'unavailable' ? 'Hierarchy unavailable' : 'Hierarchy');
  const rows = [title];
  const visit = (nodes: readonly HierarchyNodeRead[], depth: number): void => {
    for (const node of nodes) {
      if (rows.length >= Math.max(1, Math.trunc(maxRows))) return;
      rows.push(`${'  '.repeat(depth)}${node.cycle === true ? '↻ ' : ''}${node.name}${node.detail === undefined ? '' : ` — ${node.detail}`}`.slice(0, Math.max(1, width)));
      visit(node.children, depth + 1);
    }
  };
  visit(model.nodes, 0);
  return Object.freeze(rows);
}

export interface HoverReadModel { readonly state: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'; readonly hover: string | undefined; readonly message: string | undefined; }
export interface HoverReadPort { readonly model: HoverReadModel; subscribe(listener: (model: HoverReadModel) => void): Disposable; }
export interface HoverRenderableOptions extends RenderableOptions<HoverRenderable> { readonly hover: HoverReadPort; readonly maxRows?: number; }

/** Bounded read-only hover surface; markdown is already sanitized by the service owner. */
export class HoverRenderable extends Renderable {
  readonly #hover: HoverReadPort; readonly #maxRows: number; readonly #subscription: Disposable;
  constructor(ctx: RenderContext, options: HoverRenderableOptions) {
    super(ctx, { width: options.width ?? 80, height: options.height ?? 8, buffered: options.buffered ?? true, ...(options.id === undefined ? {} : { id: options.id }) });
    this.#hover = options.hover;
    this.#maxRows = Math.max(2, Math.trunc(options.maxRows ?? 12));
    this.#subscription = options.hover.subscribe(() => { if (!this.isDestroyed) this.requestRender(); });
    this.requestRender();
  }
  protected override destroySelf(): void { this.#subscription.dispose(); super.destroySelf(); }
  protected override renderSelf(buffer: OptimizedBuffer): void {
    const background = parseColor('#F1F0EC'); const foreground = parseColor('#24292E');
    buffer.fillRect(0, 0, this.width, this.height, background);
    const rows = formatHoverLines(this.#hover.model, this.width, Math.min(this.height, this.#maxRows));
    for (let row = 0; row < rows.length && row < this.height; row += 1) buffer.drawText(rows[row] ?? '', 0, row, foreground, background, 0);
  }
}

export function formatHoverLines(model: HoverReadModel, width: number, maxRows = 12): readonly string[] {
  const title = model.message ?? (model.state === 'loading' ? 'Hover loading…' : model.state === 'unavailable' ? 'Hover unavailable' : 'Hover');
  const rows = [title];
  const content = model.hover ?? '';
  for (const line of content.split(/\r?\n/u)) {
    if (rows.length >= Math.max(1, Math.trunc(maxRows))) break;
    rows.push(line.slice(0, Math.max(1, width)));
  }
  return Object.freeze(rows);
}
