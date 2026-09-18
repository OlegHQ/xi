import { Renderable, TextAttributes, type OptimizedBuffer, type RGBA, type RenderContext, type RenderableOptions, parseColor } from '@opentui/core/renderer';
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

/** Panel color tokens, sourced from `WorkbenchTheme` by the terminal adapter (see
 * `panelThemesFromWorkbench` in src/terminal.ts) -- this module never imports the
 * workbench theme type itself, only the small shape it needs. */
export interface SearchTheme {
  readonly background?: string;
  readonly foreground?: string;
  readonly muted?: string;
  readonly accent?: string;
  readonly border?: string;
  /** Row background for the selected match (defaults near `background`). */
  readonly selectedBackground?: string;
  /** Row background for the row under the pointer (defaults near `background`). */
  readonly hoverBackground?: string;
}

export interface SearchRenderableOptions extends RenderableOptions<SearchRenderable>, SearchTheme {
  readonly search: SearchReadPort;
  readonly maxRows?: number;
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
  #hoverRow: number | undefined;
  #theme: Required<SearchTheme>;

  constructor(ctx: RenderContext, options: SearchRenderableOptions) {
    const {
      search: _search, maxRows: _maxRows, selectedId: _selectedId, onPointer: _onPointer,
      background: _background, foreground: _foreground, muted: _muted, accent: _accent, border: _border,
      selectedBackground: _selectedBackground, hoverBackground: _hoverBackground,
      ...renderOptions
    } = options;
    super(ctx, {
      ...renderOptions,
      width: options.width ?? '100%',
      height: options.height ?? 12,
      buffered: options.buffered ?? true,
    });
    this.#search = options.search;
    this.#maxRows = Math.max(1, Math.min(200, Math.trunc(options.maxRows ?? 12)));
    this.#theme = resolveSearchTheme(options);
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
    }, (row) => {
      if (row === this.#hoverRow) return;
      this.#hoverRow = row;
      this.requestRender();
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
    if (!value) { this.#scroll.endDrag(); this.#hoverRow = undefined; }
    super.visible = value;
  }

  /** Apply new colors immediately, live. Colors are recomputed on every `renderSelf` call
   * (never cached beyond this resolved snapshot), so reassigning it and requesting one
   * frame is enough. */
  setTheme(theme: SearchTheme): void {
    this.#theme = resolveSearchTheme(theme);
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
    const rows = buildSearchRows(this.#model, width, this.#maxRows, selectedId, this.#hoverRow, this.#scroll.offset);
    const hitRows: (string | undefined)[] = Array.from({ length: this.height });
    for (let row = 1; row < rows.length && row < this.height; row += 1) {
      const item = items[row - 1 + this.#scroll.offset];
      if (item?.kind === 'match') hitRows[row] = item.match.id;
    }
    this.#hitMap.publish(this.#model.generation, hitRows);
    const colors = {
      background: parseColor(this.#theme.background),
      foreground: parseColor(this.#theme.foreground),
      muted: parseColor(this.#theme.muted),
      accent: parseColor(this.#theme.accent),
      border: parseColor(this.#theme.border),
      selected: parseColor(this.#theme.selectedBackground),
      hover: parseColor(this.#theme.hoverBackground),
    };
    buffer.fillRect(0, 0, this.width, this.height, colors.background);
    for (let row = 0; row < rows.length && row < this.height; row += 1) {
      const line = rows[row];
      if (line === undefined) continue;
      const rowBackground = line.background === 'selected' ? colors.selected : line.background === 'hover' ? colors.hover : colors.background;
      if (line.background !== 'default') buffer.fillRect(0, row, width, 1, rowBackground);
      drawRuns(buffer, 0, row, line.runs, rowBackground, colors);
    }
    if (thumb !== undefined) {
      for (let row = 0; row < viewport; row += 1) {
        const onThumb = row >= thumb.start && row < thumb.start + thumb.size;
        buffer.fillRect(this.width - 1, 1 + row, 1, 1, onThumb ? colors.foreground : colors.background);
      }
    }
  }
}

function resolveSearchTheme(theme: SearchTheme): Required<SearchTheme> {
  const background = theme.background ?? '#FAF9F6';
  const foreground = theme.foreground ?? '#24292E';
  return {
    background,
    foreground,
    muted: theme.muted ?? foreground,
    accent: theme.accent ?? foreground,
    border: theme.border ?? foreground,
    selectedBackground: theme.selectedBackground ?? background,
    hoverBackground: theme.hoverBackground ?? background,
  };
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

function searchFlags(query: SearchQuery): string {
  return [
    query.regex === true ? 'regex' : 'literal',
    query.caseSensitive === true ? 'case' : 'ignore-case',
    query.wholeWord === true ? 'word' : undefined,
    query.includeHidden === true ? 'hidden' : 'no-hidden',
  ].filter((flag): flag is string => flag !== undefined).join(' ');
}

/** Plain-text rows, unchanged in shape from before styled painting existed. Kept as the
 * stable text contract (see tests/search/t043-search.test.ts); `buildSearchRows` below
 * paints the same content with runs instead of one flat string per row. */
export function formatSearchLines(model: SearchReadModel, width: number, maxRows = 12, selectedId?: string, scrollOffset = 0): readonly string[] {
  const rows: string[] = [];
  rows.push(`Search ${model.state} [${searchFlags(model.query)}]  ${model.query.query}`.slice(0, width));
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

type SearchTone = 'plain' | 'bold' | 'dim' | 'accent' | 'muted' | 'border';
interface SearchRun { readonly text: string; readonly tone: SearchTone; }
interface SearchRowPaint { readonly runs: readonly SearchRun[]; readonly background: 'default' | 'selected' | 'hover'; }

function clipRuns(runs: readonly SearchRun[], width: number): readonly SearchRun[] {
  const clipped: SearchRun[] = [];
  let used = 0;
  for (const run of runs) {
    if (used >= width) break;
    const remaining = width - used;
    const text = run.text.length > remaining ? run.text.slice(0, remaining) : run.text;
    if (text.length > 0) clipped.push({ text, tone: run.tone });
    used += text.length;
  }
  return clipped;
}

function rowBackground(rowIndex: number, hoverRow: number | undefined): 'default' | 'hover' {
  return rowIndex === hoverRow ? 'hover' : 'default';
}

/**
 * Styled rows for `renderSelf`: bold file-path headings (dim directory prefix, bright
 * basename) with a right-aligned per-file match count, an inline highlighted match range
 * in each result's snippet, and a bordered, count-carrying header. Produces the same rows
 * (by index) as `formatSearchLines`, so scroll offset / hit-row math stay identical.
 */
function buildSearchRows(
  model: SearchReadModel,
  width: number,
  maxRows: number,
  selectedId: string | undefined,
  hoverRow: number | undefined,
  scrollOffset: number,
): readonly SearchRowPaint[] {
  const rows: SearchRowPaint[] = [];
  const fileCount = new Set(model.matches.map((match) => match.path)).size;
  const matchCount = model.totalMatches;
  const left = `Search ${model.state} [${searchFlags(model.query)}]  ${model.query.query}`;
  const right = `${matchCount} match${matchCount === 1 ? '' : 'es'}, ${fileCount} file${fileCount === 1 ? '' : 's'}`;
  const headerText = clipRuns([
    { text: '┌─ ', tone: 'border' },
    { text: left, tone: 'bold' },
    { text: '  ', tone: 'plain' },
    { text: right, tone: 'muted' },
    { text: ' ─┐', tone: 'border' },
  ], width);
  rows.push({ runs: headerText, background: 'default' });

  if (model.message !== undefined && model.matches.length === 0) {
    rows.push({ runs: clipRuns([{ text: model.message, tone: 'dim' }], width), background: rowBackground(rows.length, hoverRow) });
  }

  const countsByPath = new Map<string, number>();
  for (const match of model.matches) countsByPath.set(match.path, (countsByPath.get(match.path) ?? 0) + 1);
  const items = expandSearchItems(model.matches);
  const safeOffset = Math.max(0, Math.trunc(scrollOffset));
  const sliceEnd = safeOffset + Math.max(0, maxRows - rows.length);
  for (const item of items.slice(safeOffset, sliceEnd)) {
    const rowIndex = rows.length;
    if (item.kind === 'heading') {
      const splitAt = item.path.lastIndexOf('/');
      const dir = splitAt >= 0 ? item.path.slice(0, splitAt + 1) : '';
      const base = splitAt >= 0 ? item.path.slice(splitAt + 1) : item.path;
      const countText = ` (${countsByPath.get(item.path) ?? 0})`;
      const label = `[${dir}${base}]`;
      const pad = Math.max(1, width - label.length - countText.length);
      rows.push({
        runs: clipRuns([
          { text: '[', tone: 'plain' },
          { text: dir, tone: 'dim' },
          { text: base, tone: 'bold' },
          { text: ']', tone: 'plain' },
          { text: ' '.repeat(pad), tone: 'plain' },
          { text: countText, tone: 'muted' },
        ], width),
        background: rowBackground(rowIndex, hoverRow),
      });
      continue;
    }
    const isSelected = item.match.id === selectedId;
    const marker = isSelected ? '> ' : '  ';
    const location = `${item.match.path}:${item.match.line + 1}:${item.match.range.startUtf16 + 1} `;
    const snippet = item.match.snippet;
    const queryText = model.query.query;
    const matchAt = queryText.length > 0 ? snippet.toLowerCase().indexOf(queryText.toLowerCase()) : -1;
    const snippetRuns: SearchRun[] = matchAt < 0
      ? [{ text: snippet, tone: 'plain' }]
      : [
        { text: snippet.slice(0, matchAt), tone: 'plain' },
        { text: snippet.slice(matchAt, matchAt + queryText.length), tone: 'accent' },
        { text: snippet.slice(matchAt + queryText.length), tone: 'plain' },
      ];
    rows.push({
      runs: clipRuns([{ text: marker, tone: 'plain' }, { text: location, tone: 'muted' }, ...snippetRuns], width),
      background: isSelected ? 'selected' : rowBackground(rowIndex, hoverRow),
    });
  }
  if (model.truncated && sliceEnd >= items.length) {
    rows.push({ runs: clipRuns([{ text: `… ${model.totalMatches - model.matches.length} more matches`, tone: 'dim' }], width), background: rowBackground(rows.length, hoverRow) });
  }
  return rows;
}

function drawRuns(
  buffer: OptimizedBuffer,
  x0: number,
  y: number,
  runs: readonly SearchRun[],
  background: RGBA,
  colors: { readonly foreground: RGBA; readonly muted: RGBA; readonly accent: RGBA; readonly border: RGBA },
): void {
  let x = x0;
  for (const run of runs) {
    if (run.text.length === 0) continue;
    const { fg, attributes } = toneStyle(run.tone, colors);
    buffer.drawText(run.text, x, y, fg, background, attributes);
    x += run.text.length;
  }
}

function toneStyle(tone: SearchTone, colors: { readonly foreground: RGBA; readonly muted: RGBA; readonly accent: RGBA; readonly border: RGBA }): { readonly fg: RGBA; readonly attributes: number } {
  switch (tone) {
    case 'bold': return { fg: colors.foreground, attributes: TextAttributes.BOLD };
    case 'dim': return { fg: colors.muted, attributes: TextAttributes.DIM };
    case 'muted': return { fg: colors.muted, attributes: 0 };
    case 'accent': return { fg: colors.accent, attributes: TextAttributes.BOLD };
    case 'border': return { fg: colors.border, attributes: 0 };
    case 'plain':
    default: return { fg: colors.foreground, attributes: 0 };
  }
}
