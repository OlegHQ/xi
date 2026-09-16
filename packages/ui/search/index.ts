import { Renderable, type OptimizedBuffer, type RenderContext, type RenderableOptions, parseColor } from '@opentui/core/renderer';
import type { Disposable } from '../../contracts/src/index';

export interface SearchRange { readonly startUtf16: number; readonly endUtf16: number; }
export interface SearchQuery { readonly rootId: string; readonly rootPath: string; readonly query: string; readonly regex?: boolean; readonly caseSensitive?: boolean; readonly wholeWord?: boolean; readonly includeHidden?: boolean; readonly globs?: readonly string[]; readonly maxResults?: number; }
export interface SearchMatch { readonly id: string; readonly rootId: string; readonly path: string; readonly line: number; readonly range: SearchRange; readonly lineText: string; readonly snippet: string; readonly source: 'disk' | 'buffer'; readonly documentVersion?: number; readonly diskHash?: string; readonly generation: number; }
export interface SearchReadModel { readonly contractVersion: 1; readonly query: SearchQuery; readonly generation: number; readonly state: 'idle' | 'loading' | 'ready' | 'empty' | 'stale' | 'error'; readonly matches: readonly SearchMatch[]; readonly totalMatches: number; readonly truncated: boolean; readonly message: string | undefined; }

export interface SearchReadPort {
  readonly model: SearchReadModel;
  subscribe(listener: (model: SearchReadModel) => void): Disposable;
}

export interface SearchRenderableOptions extends RenderableOptions<SearchRenderable> {
  readonly search: SearchReadPort;
  readonly maxRows?: number;
  readonly background?: string;
  readonly foreground?: string;
  readonly selectedId?: () => string | undefined;
}

/** Small bounded result surface; query and matching remain service-owned. */
export class SearchRenderable extends Renderable {
  readonly #search: SearchReadPort;
  readonly #maxRows: number;
  readonly #selectedId: (() => string | undefined) | undefined;
  #subscription: Disposable | undefined;
  #model: SearchReadModel;

  constructor(ctx: RenderContext, options: SearchRenderableOptions) {
    const { search: _search, maxRows: _maxRows, background: _background, foreground: _foreground, selectedId: _selectedId, ...renderOptions } = options;
    super(ctx, {
      ...renderOptions,
      width: options.width ?? '100%',
      height: options.height ?? 12,
      buffered: options.buffered ?? true,
    });
    this.#search = options.search;
    this.#maxRows = Math.max(1, Math.min(200, Math.trunc(options.maxRows ?? 12)));
    this.#selectedId = options.selectedId;
    this.#model = options.search.model;
    this.#subscription = this.#search.subscribe((model) => {
      this.#model = model;
      if (!this.isDestroyed) this.requestRender();
    });
    this.requestRender();
  }

  protected override destroySelf(): void { this.#subscription?.dispose(); this.#subscription = undefined; super.destroySelf(); }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const width = Math.max(1, this.width);
    const lines = formatSearchLines(this.#model, width, this.#maxRows, this.#selectedId?.());
    const background = parseColor('#FAF9F6');
    const foreground = parseColor('#24292E');
    buffer.fillRect(0, 0, this.width, this.height, background);
    for (let row = 0; row < lines.length && row < this.height; row += 1) buffer.drawText(lines[row] ?? '', 0, row, foreground, background, 0);
  }
}

export function formatSearchLines(model: SearchReadModel, width: number, maxRows = 12, selectedId?: string): readonly string[] {
  const rows: string[] = [];
  const flags = [
    model.query.regex === true ? 'regex' : 'literal',
    model.query.caseSensitive === true ? 'case' : 'ignore-case',
    model.query.wholeWord === true ? 'word' : undefined,
    model.query.includeHidden === true ? 'hidden' : 'no-hidden',
  ].filter((flag): flag is string => flag !== undefined).join(' ');
  rows.push(`Search ${model.state} [${flags}]  ${model.query.query}`.slice(0, width));
  let previousPath: string | undefined;
  if (model.message !== undefined && model.matches.length === 0) rows.push(model.message.slice(0, width));
  for (const match of model.matches.slice(0, Math.max(0, maxRows - rows.length))) {
    if (match.path !== previousPath && rows.length < maxRows) {
      rows.push(`[${match.path}]`.slice(0, width));
      previousPath = match.path;
    }
    const marker = match.id === selectedId ? '> ' : '  ';
    rows.push(`${marker}${match.path}:${match.line + 1}:${match.range.startUtf16 + 1} ${match.snippet}`.slice(0, width));
  }
  if (model.truncated) rows.push(`… ${model.totalMatches - model.matches.length} more matches`.slice(0, width));
  return Object.freeze(rows);
}
