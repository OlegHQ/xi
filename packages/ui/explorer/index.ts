import {
  Renderable,
  type OptimizedBuffer,
  type RenderContext,
  type RenderableOptions,
  parseColor,
} from '@opentui/core/renderer';
import type { Disposable } from '../../contracts/src/index.ts';
import { PanelHitMap, PanelScroll, installPanelPointerHandler, type WorkbenchPanelPointerEvent } from '../src/panel-pointer';

export type ExplorerNodeKind = 'root' | 'directory' | 'file' | 'symlink' | 'other' | 'state';
export type ExplorerLoadState = 'unloaded' | 'loading' | 'ready' | 'empty' | 'permission-denied' | 'symlink-cycle' | 'overflow' | 'error';

/** Structural copy of the service read model; UI does not import service implementations. */
export interface ExplorerNode {
  readonly id: string;
  readonly rootId: string;
  readonly parentId: string | undefined;
  readonly name: string;
  readonly relativePath: string;
  readonly path: string;
  readonly kind: ExplorerNodeKind;
  readonly depth: number;
  readonly expanded: boolean;
  readonly hidden: boolean;
  readonly ignored: boolean;
  readonly loadState: ExplorerLoadState;
  readonly children: readonly string[];
  readonly stableIdentity: string;
  readonly sizeBytes: number | undefined;
  readonly modifiedMilliseconds: number | undefined;
  readonly permissions: string | undefined;
  readonly symlinkTarget: string | undefined;
  readonly git: ExplorerGitDecoration | undefined;
  readonly message: string | undefined;
}

export type ExplorerGitState = 'clean' | 'modified' | 'staged' | 'untracked' | 'ignored' | 'conflicted';
export interface ExplorerGitDecoration {
  readonly state: ExplorerGitState;
  readonly label: string;
  readonly colorToken: string;
}

export interface ExplorerVisibleRow {
  readonly nodeId: string;
  readonly depth: number;
  readonly kind: ExplorerNodeKind;
  readonly selected: boolean;
}

export interface ExplorerReadModel {
  readonly contractVersion: 1;
  readonly generation: number;
  readonly roots: readonly string[];
  readonly nodes: readonly ExplorerNode[];
  readonly visibleRows: readonly ExplorerVisibleRow[];
  readonly selectedId: string | undefined;
  readonly filter: string;
  readonly includeHidden: boolean;
  readonly includeIgnored: boolean;
  readonly focused: boolean;
  readonly state: 'ready' | 'loading' | 'empty' | 'error';
  readonly message: string | undefined;
}

export interface ExplorerReadPort {
  readonly model: ExplorerReadModel;
  subscribe(listener: (model: ExplorerReadModel) => void): Disposable;
}

export interface ExplorerTheme {
  readonly background: string;
  readonly surface: string;
  readonly surfaceActive: string;
  readonly foreground: string;
  readonly muted: string;
  readonly border: string;
  readonly accent: string;
  readonly error: string;
  readonly gitModified: string;
  readonly gitAdded: string;
  readonly gitConflict: string;
}

export const DEFAULT_EXPLORER_THEME: ExplorerTheme = Object.freeze({
  background: '#FAF9F6',
  surface: '#F1F0EC',
  surfaceActive: '#E7EDF4',
  foreground: '#24292E',
  muted: '#60666D',
  border: '#D5D4CF',
  accent: '#245A88',
  error: '#A52A36',
  gitModified: '#9B6A16',
  gitAdded: '#367C4A',
  gitConflict: '#A52A36',
});

export interface ExplorerRenderableOptions extends RenderableOptions<ExplorerRenderable> {
  readonly explorer: ExplorerReadPort;
  readonly theme?: ExplorerTheme;
  readonly maxRows?: number;
  readonly showHeader?: boolean;
  readonly onPointer?: (event: WorkbenchPanelPointerEvent) => boolean;
}

/** Bounded panel renderer. All tree state comes from an immutable read model. */
export class ExplorerRenderable extends Renderable {
  readonly #explorer: ExplorerReadPort;
  #theme: ExplorerTheme;
  readonly #maxRows: number;
  readonly #showHeader: boolean;
  readonly #hitMap = new PanelHitMap();
  readonly #onPointer: ((event: WorkbenchPanelPointerEvent) => boolean) | undefined;
  readonly #subscription: Disposable;
  readonly #scroll = new PanelScroll();
  #lastSelectedId: string | undefined;

  constructor(ctx: RenderContext, options: ExplorerRenderableOptions) {
    const { explorer: _explorer, theme: _theme, maxRows: _maxRows, showHeader: _showHeader, onPointer: _onPointer, ...renderOptions } = options;
    super(ctx, {
      ...renderOptions,
      width: options.width ?? '100%',
      height: options.height ?? 20,
      buffered: options.buffered ?? true,
    });
    this.#explorer = options.explorer;
    this.#theme = options.theme ?? DEFAULT_EXPLORER_THEME;
    this.#maxRows = options.maxRows ?? 10_000;
    this.#showHeader = options.showHeader ?? true;
    this.#onPointer = options.onPointer;
    if (!Number.isSafeInteger(this.#maxRows) || this.#maxRows < 1) throw new TypeError('explorer-max-rows-must-be-positive');
    installPanelPointerHandler(this, 'explorer', this.#hitMap, () => this.#explorer.model.generation, this.#onPointer, {
      scrollbarColumn: () => (this.#scroll.thumb(this.#explorer.model.visibleRows.length, this.#dataViewport()) === undefined ? undefined : this.width - 1),
      isDragging: () => this.#scroll.dragging,
      scrollBy: (delta) => {
        if (this.#scroll.scrollBy(delta, this.#explorer.model.visibleRows.length, this.#dataViewport())) this.requestRender();
      },
      beginDrag: (row) => this.#scroll.beginDrag(row),
      dragTo: (row) => {
        if (this.#scroll.dragTo(row, this.#explorer.model.visibleRows.length, this.#dataViewport())) this.requestRender();
      },
      endDrag: () => this.#scroll.endDrag(),
    });
    this.#subscription = this.#explorer.subscribe(() => {
      if (!this.isDestroyed) this.requestRender();
    });
    this.requestRender();
  }

  #dataViewport(heightOverride?: number): number {
    return Math.max(0, (heightOverride ?? this.height) - (this.#showHeader ? 1 : 0) - 1);
  }

  protected override destroySelf(): void {
    this.#scroll.reset();
    this.#subscription.dispose();
    super.destroySelf();
  }

  protected override onResize(width: number, height: number): void {
    this.#scroll.endDrag();
    this.#scroll.clamp(this.#explorer.model.visibleRows.length, this.#dataViewport(height));
    super.onResize(width, height);
  }

  override get visible(): boolean { return super.visible; }
  override set visible(value: boolean) {
    if (!value) this.#scroll.endDrag();
    super.visible = value;
  }

  /** Apply a new theme immediately, live. Colors are recomputed from `#theme` on every
   * `renderSelf` call (never cached), so reassigning it and requesting one frame is enough. */
  setTheme(theme: ExplorerTheme): void {
    this.#theme = theme;
    this.requestRender();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const background = parseColor(this.#theme.background);
    const surface = parseColor(this.#theme.surface);
    const active = parseColor(this.#theme.surfaceActive);
    const foreground = parseColor(this.#theme.foreground);
    const muted = parseColor(this.#theme.muted);
    const border = parseColor(this.#theme.border);
    const accent = parseColor(this.#theme.accent);
    const error = parseColor(this.#theme.error);
    const model = this.#explorer.model;
    buffer.fillRect(0, 0, this.width, this.height, background);
    const viewport = this.#dataViewport();
    if (model.selectedId !== this.#lastSelectedId) {
      this.#lastSelectedId = model.selectedId;
      const selectedIndex = model.selectedId === undefined ? -1 : model.visibleRows.findIndex((row) => row.nodeId === model.selectedId);
      if (selectedIndex >= 0) {
        if (selectedIndex < this.#scroll.offset) this.#scroll.scrollBy(selectedIndex - this.#scroll.offset, model.visibleRows.length, viewport);
        else if (selectedIndex >= this.#scroll.offset + viewport) this.#scroll.scrollBy(selectedIndex - viewport + 1 - this.#scroll.offset, model.visibleRows.length, viewport);
      }
    }
    this.#scroll.clamp(model.visibleRows.length, viewport);
    const thumb = this.#scroll.thumb(model.visibleRows.length, viewport);
    const textWidth = thumb === undefined ? this.width : Math.max(1, this.width - 1);
    const lines = formatExplorerLines(model, textWidth, Math.min(this.height, this.#maxRows), this.#showHeader, this.#scroll.offset);
    const hitRows: (string | undefined)[] = Array.from({ length: this.height });
    for (let row = 0; row < lines.length && row < this.height; row += 1) {
      const line = lines[row];
      if (line === undefined) continue;
      const dataRow = this.#showHeader ? row - 1 : row;
      const visible = dataRow >= 0 ? model.visibleRows[dataRow + this.#scroll.offset] : undefined;
      if (row > 0 && row < this.height - 1 && visible?.kind !== 'state') hitRows[row] = visible?.nodeId;
      const selected = visible?.selected === true;
      const rowBackground = selected ? active : surface;
      buffer.fillRect(0, row, this.width, 1, rowBackground);
      const lineColor = model.state === 'error' || visible?.kind === 'state' ? error : row === 0 && this.#showHeader ? accent : selected ? foreground : muted;
      drawExplorerText(buffer, line, 0, row, lineColor, rowBackground, textWidth);
    }
    this.#hitMap.publish(model.generation, hitRows);
    if (thumb !== undefined) {
      const trackTop = this.#showHeader ? 1 : 0;
      for (let row = 0; row < viewport; row += 1) {
        const onThumb = row >= thumb.start && row < thumb.start + thumb.size;
        buffer.fillRect(this.width - 1, trackTop + row, 1, 1, onThumb ? accent : border);
      }
    }
    if (this.height > 0) {
      buffer.fillRect(0, this.height - 1, this.width, 1, surface);
      const footer = model.filter.length > 0 ? `/${model.filter}` : model.message ?? `${model.visibleRows.length} items`;
      drawExplorerText(buffer, footer, 1, this.height - 1, model.state === 'error' ? error : muted, surface, Math.max(0, this.width - 2));
    }
    this.ctx.setCursorPosition(model.focused && model.filter.length > 0 ? Math.min(this.width - 1, model.filter.length + 1) : 0, 0, model.focused && model.filter.length > 0);
  }
}

/** Format rows with stable identity markers and explicit empty/error states. */
export function formatExplorerLines(model: ExplorerReadModel, width: number, maxRows: number, showHeader = true, scrollOffset = 0): readonly string[] {
  const safeWidth = Math.max(1, Math.trunc(width));
  const safeRows = Math.max(1, Math.trunc(maxRows));
  const lines: string[] = [];
  if (showHeader && lines.length < safeRows) lines.push(clipExplorer(model.filter.length > 0 ? `Files  /${model.filter}` : 'Files', safeWidth));
  if (model.visibleRows.length === 0 && lines.length < safeRows) {
    lines.push(clipExplorer(model.state === 'error' ? (model.message ?? 'Unable to read workspace') : model.state === 'loading' ? 'Loading…' : 'No files', safeWidth));
  }
  for (const row of model.visibleRows.slice(Math.max(0, Math.trunc(scrollOffset)))) {
    if (lines.length >= safeRows) break;
    const node = model.nodes.find((candidate) => candidate.id === row.nodeId);
    if (node === undefined) continue;
    lines.push(clipExplorer(formatNodeLine(node, row.depth), safeWidth));
  }
  return Object.freeze(lines);
}

function formatNodeLine(node: ExplorerNode, depth: number): string {
  if (node.kind === 'state') return `${'  '.repeat(depth)}${node.message ?? node.name}`;
  const disclosure = node.kind === 'directory' || node.kind === 'root' || node.kind === 'symlink'
    ? node.loadState === 'loading' ? '·' : node.expanded ? '▾' : '▸'
    : ' ';
  const icon = node.kind === 'root' ? '⌂' : node.kind === 'directory' ? '□' : node.kind === 'symlink' ? '↪' : node.kind === 'file' ? '·' : '?';
  const git = node.git === undefined ? '' : ` ${node.git.label}`;
  const suffix = node.loadState === 'permission-denied' ? '  [permission denied]' : node.loadState === 'symlink-cycle' ? '  [symlink cycle]' : node.loadState === 'empty' && (node.kind === 'directory' || node.kind === 'root') ? '  [empty]' : '';
  return `${'  '.repeat(depth)}${disclosure} ${icon} ${node.name}${git}${suffix}`;
}

function drawExplorerText(buffer: OptimizedBuffer, value: string, x: number, y: number, foreground: ReturnType<typeof parseColor>, background: ReturnType<typeof parseColor>, width: number): void {
  const clipped = clipExplorer(value, Math.max(0, width - x));
  const characters = [...clipped];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character !== undefined) buffer.setCell(x + index, y, character, foreground, background);
  }
}

function clipExplorer(value: string, width: number): string {
  if (width <= 0) return '';
  const points = [...value];
  if (points.length <= width) return value;
  if (width === 1) return '…';
  return `${points.slice(0, width - 1).join('')}…`;
}
