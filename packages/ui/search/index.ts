import { Renderable, type OptimizedBuffer, type RenderContext, type RenderableOptions, parseColor } from '@opentui/core/renderer';
import type { Disposable } from '../../contracts/src/index';
import { PanelHitMap, PanelScroll, installPanelPointerHandler, type WorkbenchPanelPointerEvent } from '../src/panel-pointer';

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
  readonly onPointer?: (event: WorkbenchPanelPointerEvent) => boolean;
}

/** Small bounded result surface; query and matching remain service-owned. */
export class SearchRenderable extends Renderable {
  readonly #search: SearchReadPort;
  readonly #maxRows: number;
  readonly #selectedId: (() => string | undefined) | undefined;
  readonly #onPointer: ((event: WorkbenchPanelPointerEvent) => boolean) | undefined;
  readonly #hitMap = new PanelHitMap();
  readonly #scroll = new PanelScroll();
  #lastSelectedId: string | undefined;
  #subscription: Disposable | undefined;
  #model: SearchReadModel;
  #background: string;
  #foreground: string;

  constructor(ctx: RenderContext, options: SearchRenderableOptions) {
    const { search: _search, maxRows: _maxRows, background: _background, foreground: _foreground, selectedId: _selectedId, onPointer: _onPointer, ...renderOptions } = options;
    super(ctx, {
      ...renderOptions,
      width: options.width ?? '100%',
      height: options.height ?? 12,
      buffered: options.buffered ?? true,
    });
    this.#search = options.search;
    this.#maxRows = Math.max(1, Math.min(200, Math.trunc(options.maxRows ?? 12)));
    this.#background = options.background ?? '#FAF9F6';
    this.#foreground = options.foreground ?? '#24292E';
    this.#selectedId = options.selectedId;
    this.#onPointer = options.onPointer;
    this.#model = options.search.model;
    installPanelPointerHandler(this, 'search', this.#hitMap, () => this.#model.generation, this.#onPointer, {
      scrollbarColumn: () => (this.#scroll.thumb(expandSearchItems(this.#model.matches).length, this.#dataViewport()) === undefined ? undefined : this.width - 1),
      isDragging: () => this.#scroll.dragging,
      scrollBy: (delta) => {
        if (this.#scroll.scrollBy(delta, expandSearchItems(this.#model.matches).length, this.#dataViewport())) this.requestRender();
      },
      beginDrag: (row) => this.#scroll.beginDrag(row),
      dragTo: (row) => {
        if (this.#scroll.dragTo(row, expandSearchItems(this.#model.matches).length, this.#dataViewport())) this.requestRender();
      },
      endDrag: () => this.#scroll.endDrag(),
    });
    this.#subscription = this.#search.subscribe((model) => {
      this.#model = model;
      if (!this.isDestroyed) this.requestRender();
    });
    this.requestRender();
  }

  #dataViewport(heightOverride?: number): number {
    return Math.max(0, (heightOverride ?? this.height) - 1);
  }

  protected override destroySelf(): void { this.#scroll.reset(); this.#subscription?.dispose(); this.#subscription = undefined; super.destroySelf(); }

  protected override onResize(width: number, height: number): void {
    this.#scroll.endDrag();
    this.#scroll.clamp(expandSearchItems(this.#model.matches).length, this.#dataViewport(height));
    super.onResize(width, height);
  }

  override get visible(): boolean { return super.visible; }
  override set visible(value: boolean) {
    if (!value) this.#scroll.endDrag();
    super.visible = value;
  }

  /** Apply new colors immediately, live. Colors are recomputed on every `renderSelf` call
   * (never cached), so reassigning these fields and requesting one frame is enough. */
  setTheme(theme: { readonly background: string; readonly foreground: string }): void {
    this.#background = theme.background;
    this.#foreground = theme.foreground;
    this.requestRender();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const items = expandSearchItems(this.#model.matches);
    const selectedId = this.#selectedId?.();
    const viewport = this.#dataViewport();
    if (selectedId !== this.#lastSelectedId) {
      this.#lastSelectedId = selectedId;
      const selectedIndex = selectedId === undefined ? -1 : items.findIndex((item) => item.kind === 'match' && item.match.id === selectedId);
      if (selectedIndex >= 0) {
        if (selectedIndex < this.#scroll.offset) this.#scroll.scrollBy(selectedIndex - this.#scroll.offset, items.length, viewport);
        else if (selectedIndex >= this.#scroll.offset + viewport) this.#scroll.scrollBy(selectedIndex - viewport + 1 - this.#scroll.offset, items.length, viewport);
      }
    }
    this.#scroll.clamp(items.length, viewport);
    const thumb = this.#scroll.thumb(items.length, viewport);
    const width = Math.max(1, thumb === undefined ? this.width : this.width - 1);
    const lines = formatSearchLines(this.#model, width, this.#maxRows, selectedId, this.#scroll.offset);
    const hitRows: (string | undefined)[] = Array.from({ length: this.height });
    for (let row = 1; row < lines.length && row < this.height; row += 1) {
      const item = items[row - 1 + this.#scroll.offset];
      if (item?.kind === 'match') hitRows[row] = item.match.id;
    }
    this.#hitMap.publish(this.#model.generation, hitRows);
    const background = parseColor(this.#background);
    const foreground = parseColor(this.#foreground);
    buffer.fillRect(0, 0, this.width, this.height, background);
    for (let row = 0; row < lines.length && row < this.height; row += 1) buffer.drawText(lines[row] ?? '', 0, row, foreground, background, 0);
    if (thumb !== undefined) {
      for (let row = 0; row < viewport; row += 1) {
        const onThumb = row >= thumb.start && row < thumb.start + thumb.size;
        buffer.fillRect(this.width - 1, 1 + row, 1, 1, onThumb ? foreground : background);
      }
    }
  }
}

type SearchContentItem = { readonly kind: 'heading'; readonly path: string } | { readonly kind: 'match'; readonly match: SearchMatch };

function expandSearchItems(matches: readonly SearchMatch[]): readonly SearchContentItem[] {
  const items: SearchContentItem[] = [];
  let previousPath: string | undefined;
  for (const match of matches) {
    if (match.path !== previousPath) {
      items.push({ kind: 'heading', path: match.path });
      previousPath = match.path;
    }
    items.push({ kind: 'match', match });
  }
  return items;
}

export function formatSearchLines(model: SearchReadModel, width: number, maxRows = 12, selectedId?: string, scrollOffset = 0): readonly string[] {
  const rows: string[] = [];
  const flags = [
    model.query.regex === true ? 'regex' : 'literal',
    model.query.caseSensitive === true ? 'case' : 'ignore-case',
    model.query.wholeWord === true ? 'word' : undefined,
    model.query.includeHidden === true ? 'hidden' : 'no-hidden',
  ].filter((flag): flag is string => flag !== undefined).join(' ');
  rows.push(`Search ${model.state} [${flags}]  ${model.query.query}`.slice(0, width));
  if (model.message !== undefined && model.matches.length === 0) rows.push(model.message.slice(0, width));
  const items = expandSearchItems(model.matches);
  const safeOffset = Math.max(0, Math.trunc(scrollOffset));
  const sliceEnd = safeOffset + Math.max(0, maxRows - rows.length);
  for (const item of items.slice(safeOffset, sliceEnd)) {
    if (item.kind === 'heading') {
      rows.push(`[${item.path}]`.slice(0, width));
      continue;
    }
    const marker = item.match.id === selectedId ? '> ' : '  ';
    rows.push(`${marker}${item.match.path}:${item.match.line + 1}:${item.match.range.startUtf16 + 1} ${item.match.snippet}`.slice(0, width));
  }
  if (model.truncated && sliceEnd >= items.length) rows.push(`… ${model.totalMatches - model.matches.length} more matches`.slice(0, width));
  return Object.freeze(rows);
}
