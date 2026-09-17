import {
  Renderable,
  type OptimizedBuffer,
  type RenderContext,
  type RenderableOptions,
  parseColor,
} from '@opentui/core/renderer';
import type { Disposable, Result } from '../../contracts/src/index';
import { PanelHitMap, PanelScroll, installPanelPointerHandler, type WorkbenchPanelPointerEvent } from '../src/panel-pointer';
import {
  FocusGraph,
  type FocusGraphFailure,
  type FocusTarget,
} from '../../workbench/src/index';

export type PickerMode = 'file' | 'buffer' | 'command' | 'theme' | 'config' | 'git';
export type PickerEntryKind = 'file' | 'buffer' | 'command' | 'theme' | 'config' | 'git';

/** Structural copy of the navigation service DTO; UI never imports services. */
export interface PickerEntry {
  readonly id: string;
  readonly mode: PickerMode;
  readonly kind: PickerEntryKind;
  readonly label: string;
  readonly detail: string;
  readonly value: string;
  readonly rootId: string | undefined;
  readonly relativePath: string | undefined;
  readonly hidden: boolean;
  readonly score: number;
}

export interface PickerReadModel {
  readonly contractVersion: 1;
  readonly mode: PickerMode;
  readonly query: string;
  readonly generation: number;
  readonly state: 'loading' | 'ready' | 'empty' | 'stale' | 'error';
  readonly entries: readonly PickerEntry[];
  readonly selectedId: string | undefined;
  readonly totalMatches: number;
  readonly truncated: boolean;
  readonly message: string | undefined;
}

export type PickerFailure =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'stale'; readonly generation: number }
  | { readonly kind: 'not-ready'; readonly mode: PickerMode; readonly message: string }
  | { readonly kind: 'provider'; readonly message: string };

export interface PickerQuerySource {
  readonly model: PickerReadModel;
  query(mode: PickerMode, query: string, options?: { readonly limit?: number; readonly includeHidden?: boolean }): Promise<Result<PickerReadModel, PickerFailure>>;
  cancel(): void;
  select(id: string): boolean;
}

export interface PickerReadPort {
  readonly model: PickerReadModel;
  subscribe(listener: (model: PickerReadModel) => void): Disposable;
}

/** Adds a repaint/read subscription around the service's bounded model. */
export class PickerModelBridge implements PickerReadPort, Disposable {
  readonly #source: PickerQuerySource;
  readonly #listeners = new Set<(model: PickerReadModel) => void>();
  #model: PickerReadModel;
  #disposed = false;

  constructor(source: PickerQuerySource) {
    this.#source = source;
    this.#model = source.model;
  }

  get model(): PickerReadModel { return this.#model; }

  subscribe(listener: (model: PickerReadModel) => void): Disposable {
    if (this.#disposed) throw new Error('picker-model-bridge-disposed');
    this.#listeners.add(listener);
    return Object.freeze({ dispose: () => { this.#listeners.delete(listener); } });
  }

  async query(mode: PickerMode, query: string, options: { readonly limit?: number; readonly includeHidden?: boolean } = {}): Promise<Result<PickerReadModel, PickerFailure>> {
    if (this.#disposed) return { ok: false, error: { kind: 'provider', message: 'picker model bridge is disposed' } };
    const result = await this.#source.query(mode, query, options);
    if (result.ok) {
      this.#model = result.value;
      this.notify();
    }
    return result;
  }

  cancel(): void {
    if (this.#disposed) return;
    this.#source.cancel();
    this.#model = this.#source.model;
    this.notify();
  }

  select(id: string): boolean {
    if (this.#disposed) return false;
    const selected = this.#source.select(id);
    if (selected) {
      this.#model = this.#source.model;
      this.notify();
    }
    return selected;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#source.cancel();
    this.#listeners.clear();
  }

  private notify(): void {
    for (const listener of [...this.#listeners]) listener(this.#model);
  }
}

export interface PickerFocusLifecycleOptions {
  readonly focus: FocusGraph;
  readonly targetId?: string;
  readonly onPreview?: (entry: PickerEntry) => void | Promise<void>;
  readonly onCancelPreview?: () => void | Promise<void>;
}

export type PickerFocusFailure =
  | { readonly kind: 'already-open' }
  | { readonly kind: 'not-open' }
  | { readonly kind: 'focus'; readonly cause: FocusGraphFailure };

/**
 * Owns the picker overlay's focus token and preview lifecycle. FocusGraph keeps
 * the original editor target, so dismiss/cancel restores it by stable identity.
 */
export class PickerFocusLifecycle implements Disposable {
  readonly #focus: FocusGraph;
  readonly #target: FocusTarget;
  readonly #onPreview: ((entry: PickerEntry) => void | Promise<void>) | undefined;
  readonly #onCancelPreview: (() => void | Promise<void>) | undefined;
  #registration: Disposable | undefined;
  #disposed = false;
  #previewEntry: PickerEntry | undefined;

  constructor(options: PickerFocusLifecycleOptions) {
    this.#focus = options.focus;
    this.#onPreview = options.onPreview;
    this.#onCancelPreview = options.onCancelPreview;
    this.#target = Object.freeze({
      id: options.targetId ?? 'xi.picker',
      kind: 'picker',
      contexts: Object.freeze(['picker', 'query-input']),
    });
  }

  get isOpen(): boolean { return this.#registration !== undefined; }
  get previewEntry(): PickerEntry | undefined { return this.#previewEntry; }
  get targetId(): string { return this.#target.id; }

  open(): Result<void, PickerFocusFailure> {
    if (this.#disposed) return { ok: false, error: { kind: 'focus', cause: { kind: 'graph-disposed' } } };
    if (this.#registration !== undefined) return { ok: false, error: { kind: 'already-open' } };
    const opened = this.#focus.openOverlay(this.#target);
    if (!opened.ok) return { ok: false, error: { kind: 'focus', cause: opened.error } };
    this.#registration = opened.value;
    return { ok: true, value: undefined };
  }

  async preview(entry: PickerEntry): Promise<Result<void, PickerFocusFailure>> {
    if (this.#registration === undefined) return { ok: false, error: { kind: 'not-open' } };
    try {
      await this.#onPreview?.(entry);
      this.#previewEntry = entry;
      return { ok: true, value: undefined };
    } catch {
      return { ok: false, error: { kind: 'focus', cause: { kind: 'invalid-target', message: 'preview failed' } } };
    }
  }

  async cancel(): Promise<Result<void, PickerFocusFailure>> {
    if (this.#registration === undefined) return { ok: false, error: { kind: 'not-open' } };
    try {
      await this.#onCancelPreview?.();
      this.#previewEntry = undefined;
      this.#registration.dispose();
      this.#registration = undefined;
      return { ok: true, value: undefined };
    } catch {
      return { ok: false, error: { kind: 'focus', cause: { kind: 'invalid-target', message: 'preview cancellation failed' } } };
    }
  }

  close(): Result<void, PickerFocusFailure> {
    if (this.#registration === undefined) return { ok: false, error: { kind: 'not-open' } };
    this.#registration.dispose();
    this.#registration = undefined;
    this.#previewEntry = undefined;
    return { ok: true, value: undefined };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#registration?.dispose();
    this.#registration = undefined;
    this.#previewEntry = undefined;
  }
}

export interface PickerTheme {
  readonly background: string;
  readonly surface: string;
  readonly surfaceActive: string;
  readonly foreground: string;
  readonly muted: string;
  readonly accent: string;
  readonly error: string;
}

export const DEFAULT_PICKER_THEME: PickerTheme = Object.freeze({
  background: '#FAF9F6',
  surface: '#F1F0EC',
  surfaceActive: '#E7EDF4',
  foreground: '#24292E',
  muted: '#60666D',
  accent: '#245A88',
  error: '#A52A36',
});

export interface PickerRenderableOptions extends RenderableOptions<PickerRenderable> {
  readonly picker: PickerReadPort;
  readonly theme?: PickerTheme;
  readonly maxRows?: number;
  readonly onPointer?: (event: WorkbenchPanelPointerEvent) => boolean;
}

/** Bounded picker surface: all selection/query state remains in the read model. */
export class PickerRenderable extends Renderable {
  readonly #picker: PickerReadPort;
  #theme: PickerTheme;
  readonly #maxRows: number;
  readonly #subscription: Disposable;
  readonly #hitMap = new PanelHitMap();
  readonly #onPointer: ((event: WorkbenchPanelPointerEvent) => boolean) | undefined;
  readonly #scroll = new PanelScroll();
  #lastSelectedId: string | undefined;

  constructor(ctx: RenderContext, options: PickerRenderableOptions) {
    const { picker: _picker, theme: _theme, maxRows: _maxRows, onPointer: _onPointer, ...renderableOptions } = options;
    super(ctx, {
      ...renderableOptions,
      width: options.width ?? '100%',
      height: options.height ?? 8,
      buffered: options.buffered ?? true,
    });
    this.#picker = options.picker;
    this.#theme = options.theme ?? DEFAULT_PICKER_THEME;
    this.#maxRows = options.maxRows ?? 10;
    this.#onPointer = options.onPointer;
    if (!Number.isSafeInteger(this.#maxRows) || this.#maxRows < 3) throw new TypeError('picker-max-rows-must-be-at-least-three');
    installPanelPointerHandler(this, 'picker', this.#hitMap, () => this.#picker.model.generation, this.#onPointer, {
      scrollbarColumn: () => (this.#scroll.thumb(this.#picker.model.entries.length, this.#dataViewport()) === undefined ? undefined : this.width - 1),
      isDragging: () => this.#scroll.dragging,
      scrollBy: (delta) => {
        if (this.#scroll.scrollBy(delta, this.#picker.model.entries.length, this.#dataViewport())) this.requestRender();
      },
      beginDrag: (row) => this.#scroll.beginDrag(row),
      dragTo: (row) => {
        if (this.#scroll.dragTo(row, this.#picker.model.entries.length, this.#dataViewport())) this.requestRender();
      },
      endDrag: () => this.#scroll.endDrag(),
    });
    this.#subscription = this.#picker.subscribe(() => {
      if (!this.isDestroyed) this.requestRender();
    });
    this.requestRender();
  }

  #dataViewport(heightOverride?: number): number {
    return Math.max(0, (heightOverride ?? this.height) - 2);
  }

  protected override destroySelf(): void {
    this.#scroll.reset();
    this.#subscription.dispose();
    super.destroySelf();
  }

  protected override onResize(width: number, height: number): void {
    this.#scroll.endDrag();
    this.#scroll.clamp(this.#picker.model.entries.length, this.#dataViewport(height));
    super.onResize(width, height);
  }

  override get visible(): boolean { return super.visible; }
  override set visible(value: boolean) {
    if (!value) this.#scroll.endDrag();
    super.visible = value;
  }

  /** Apply a new theme immediately, live. Colors are recomputed from `#theme` on every
   * `renderSelf` call (never cached), so reassigning it and requesting one frame is enough. */
  setTheme(theme: PickerTheme): void {
    this.#theme = theme;
    this.requestRender();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const background = parseColor(this.#theme.background);
    const surface = parseColor(this.#theme.surface);
    const active = parseColor(this.#theme.surfaceActive);
    const foreground = parseColor(this.#theme.foreground);
    const muted = parseColor(this.#theme.muted);
    const accent = parseColor(this.#theme.accent);
    const error = parseColor(this.#theme.error);
    buffer.fillRect(0, 0, this.width, this.height, background);
    const model = this.#picker.model;
    const viewport = this.#dataViewport();
    if (model.selectedId !== this.#lastSelectedId) {
      this.#lastSelectedId = model.selectedId;
      const selectedIndex = model.selectedId === undefined ? -1 : model.entries.findIndex((entry) => entry.id === model.selectedId);
      if (selectedIndex >= 0) {
        if (selectedIndex < this.#scroll.offset) this.#scroll.scrollBy(selectedIndex - this.#scroll.offset, model.entries.length, viewport);
        else if (selectedIndex >= this.#scroll.offset + viewport) this.#scroll.scrollBy(selectedIndex - viewport + 1 - this.#scroll.offset, model.entries.length, viewport);
      }
    }
    this.#scroll.clamp(model.entries.length, viewport);
    const thumb = this.#scroll.thumb(model.entries.length, viewport);
    const textWidth = thumb === undefined ? this.width : Math.max(1, this.width - 1);
    const rows = formatPickerLines(model, textWidth, Math.min(this.height, this.#maxRows), this.#scroll.offset);
    const hitRows: (string | undefined)[] = Array.from({ length: this.height });
    for (let row = 0; row < rows.length && row < this.height; row += 1) {
      const line = rows[row];
      if (line === undefined) continue;
      const entry = model.entries[row - 1 + this.#scroll.offset];
      const selected = row > 0 && row - 1 + this.#scroll.offset < model.entries.length && entry?.id === model.selectedId;
      if (row > 0 && row < this.height - 1) hitRows[row] = entry?.id;
      const rowBackground = selected ? active : surface;
      buffer.fillRect(0, row, this.width, 1, rowBackground);
      const color = model.state === 'error' ? error : row === 0 ? accent : selected ? foreground : muted;
      drawPickerText(buffer, line, 0, row, color, rowBackground, textWidth);
    }
    this.#hitMap.publish(model.generation, hitRows);
    if (thumb !== undefined) {
      for (let row = 0; row < viewport; row += 1) {
        const onThumb = row >= thumb.start && row < thumb.start + thumb.size;
        buffer.fillRect(this.width - 1, 1 + row, 1, 1, onThumb ? accent : surface);
      }
    }
    this.ctx.setCursorPosition(Math.min(this.width - 1, Math.max(0, model.query.length + 2)), 0, true);
  }
}

export function formatPickerLines(model: PickerReadModel, width: number, maxRows: number, scrollOffset = 0): readonly string[] {
  const safeWidth = Math.max(1, Math.trunc(width));
  const safeRows = Math.max(1, Math.trunc(maxRows));
  const safeOffset = Math.max(0, Math.trunc(scrollOffset));
  if (safeRows === 1) return Object.freeze([clipPicker(`>${model.query}`, safeWidth)]);
  const header = `${modeLabel(model.mode)}  >${model.query}`;
  const lines: string[] = [clipPicker(header, safeWidth)];
  const rowLimit = Math.max(0, safeRows - 2);
  for (let index = 0; index < rowLimit; index += 1) {
    const entry = model.entries[index + safeOffset];
    if (entry === undefined) break;
    const marker = entry.id === model.selectedId ? '▸ ' : '  ';
    const detail = entry.detail.length === 0 ? '' : `  ${entry.detail}`;
    lines.push(clipPicker(`${marker}${entry.label}${detail}`, safeWidth));
  }
  const footer = model.message ?? `${model.totalMatches}${model.truncated ? '+' : ''} matches · Esc cancel`;
  lines.push(clipPicker(footer, safeWidth));
  return Object.freeze(lines);
}

function drawPickerText(buffer: OptimizedBuffer, value: string, x: number, y: number, foreground: ReturnType<typeof parseColor>, background: ReturnType<typeof parseColor>, width: number): void {
  const clipped = clipPicker(value, Math.max(0, width - x));
  for (let index = 0; index < [...clipped].length; index += 1) {
    const character = [...clipped][index];
    if (character !== undefined) buffer.setCell(x + index, y, character, foreground, background);
  }
}

function clipPicker(value: string, width: number): string {
  if (width <= 0) return '';
  const points = [...value];
  if (points.length <= width) return value;
  if (width === 1) return '…';
  return `${points.slice(0, width - 1).join('')}…`;
}
function modeLabel(mode: PickerMode): string {
  switch (mode) {
    case 'file': return 'Files';
    case 'buffer': return 'Buffers';
    case 'command': return 'Commands';
    case 'theme': return 'Themes';
    case 'config': return 'Config';
    case 'git': return 'Git';
  }
}
