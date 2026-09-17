import { Renderable, type OptimizedBuffer, type RenderContext, type RenderableOptions, parseColor } from '@opentui/core/renderer';
import type { Disposable } from '../../contracts/src/index';
import { PanelHitMap, PanelScroll, installPanelPointerHandler, type WorkbenchPanelPointerEvent } from '../src/panel-pointer';

export interface ProblemRange { readonly startLine: number; readonly startUtf16: number; readonly endLine: number; readonly endUtf16: number; }
export interface Problem {
  readonly id: string; readonly uri: string; readonly range: ProblemRange; readonly message: string;
  readonly severity: 1 | 2 | 3 | 4 | undefined; readonly source: string | undefined; readonly code: string | number | undefined;
  readonly serverId: string; readonly documentVersion: number | undefined; readonly generation: number;
}
export interface ProblemsReadModel { readonly contractVersion: 1; readonly generation: number; readonly all: readonly Problem[]; /** URIs whose diagnostics were cut at the service's per-URI admission limit. */ readonly truncatedUris?: ReadonlySet<string>; }
export interface ProblemsReadPort { readonly model: ProblemsReadModel; subscribe(listener: (model: ProblemsReadModel) => void): Disposable; }
export interface ProblemsRenderableOptions extends RenderableOptions<ProblemsRenderable> { readonly problems: ProblemsReadPort; readonly maxRows?: number; readonly selectedId?: () => string | undefined; readonly onPointer?: (event: WorkbenchPanelPointerEvent) => boolean; }

export class ProblemsRenderable extends Renderable {
  readonly #problems: ProblemsReadPort; readonly #maxRows: number; readonly #subscription: Disposable; readonly #hitMap = new PanelHitMap(); readonly #onPointer: ((event: WorkbenchPanelPointerEvent) => boolean) | undefined; readonly #selectedId: (() => string | undefined) | undefined;
  readonly #scroll = new PanelScroll();
  #lastSelectedId: string | undefined;
  constructor(ctx: RenderContext, options: ProblemsRenderableOptions) {
    const { problems: _problems, maxRows: _maxRows, onPointer: _onPointer, selectedId: _selectedId, ...renderOptions } = options;
    super(ctx, { ...renderOptions, width: options.width ?? '100%', height: options.height ?? 8, buffered: options.buffered ?? true, ...(options.id === undefined ? {} : { id: options.id }) });
    this.#problems = options.problems; this.#maxRows = Math.max(1, Math.trunc(options.maxRows ?? 10));
    this.#onPointer = options.onPointer;
    this.#selectedId = options.selectedId;
    installPanelPointerHandler(this, 'problems', this.#hitMap, () => this.#problems.model.generation, this.#onPointer, {
      scrollbarColumn: () => (this.#scroll.thumb(this.#problems.model.all.length, this.#dataViewport()) === undefined ? undefined : this.width - 1),
      isDragging: () => this.#scroll.dragging,
      scrollBy: (delta) => {
        if (this.#scroll.scrollBy(delta, this.#problems.model.all.length, this.#dataViewport())) this.requestRender();
      },
      beginDrag: (row) => this.#scroll.beginDrag(row),
      dragTo: (row) => {
        if (this.#scroll.dragTo(row, this.#problems.model.all.length, this.#dataViewport())) this.requestRender();
      },
      endDrag: () => this.#scroll.endDrag(),
    });
    this.#subscription = this.#problems.subscribe(() => { if (!this.isDestroyed) this.requestRender(); });
    this.requestRender();
  }
  #dataViewport(heightOverride?: number): number {
    return Math.max(0, (heightOverride ?? this.height) - 1);
  }
  protected override destroySelf(): void { this.#scroll.reset(); this.#subscription.dispose(); super.destroySelf(); }
  protected override onResize(width: number, height: number): void {
    this.#scroll.endDrag();
    this.#scroll.clamp(this.#problems.model.all.length, this.#dataViewport(height));
    super.onResize(width, height);
  }
  override get visible(): boolean { return super.visible; }
  override set visible(value: boolean) {
    if (!value) this.#scroll.endDrag();
    super.visible = value;
  }
  protected override renderSelf(buffer: OptimizedBuffer): void {
    const background = parseColor('#FAF9F6'); const foreground = parseColor('#24292E'); const muted = parseColor('#60666D');
    buffer.fillRect(0, 0, this.width, this.height, background);
    const model = this.#problems.model;
    const viewport = this.#dataViewport();
    const selectedId = this.#selectedId?.();
    if (selectedId !== this.#lastSelectedId) {
      this.#lastSelectedId = selectedId;
      const selectedIndex = selectedId === undefined ? -1 : model.all.findIndex((problem) => problem.id === selectedId);
      if (selectedIndex >= 0) {
        if (selectedIndex < this.#scroll.offset) this.#scroll.scrollBy(selectedIndex - this.#scroll.offset, model.all.length, viewport);
        else if (selectedIndex >= this.#scroll.offset + viewport) this.#scroll.scrollBy(selectedIndex - viewport + 1 - this.#scroll.offset, model.all.length, viewport);
      }
    }
    this.#scroll.clamp(model.all.length, viewport);
    const thumb = this.#scroll.thumb(model.all.length, viewport);
    const width = Math.max(1, thumb === undefined ? this.width : this.width - 1);
    const rows = formatProblemsLines(model, width, Math.min(this.height, this.#maxRows), this.#scroll.offset);
    const hitRows: (string | undefined)[] = Array.from({ length: this.height });
    for (let row = 1; row < rows.length && row < this.height; row += 1) {
      const problem = model.all[row - 1 + this.#scroll.offset];
      if (row < this.height - 1) hitRows[row] = problem?.id;
      const selected = problem?.id !== undefined && problem.id === selectedId;
      if (selected) buffer.fillRect(0, row, this.width, 1, parseColor('#E7EDF4'));
      const text = selected ? `> ${rows[row] ?? ''}` : rows[row] ?? '';
      if (selected) buffer.drawText(text, 0, row, foreground, parseColor('#E7EDF4'), 0);
      else buffer.drawText(text, 0, row, row === 0 ? foreground : muted, background, 0);
    }
    this.#hitMap.publish(model.generation, hitRows);
    if (rows.length > 0) buffer.drawText(rows[0] ?? '', 0, 0, foreground, background, 0);
    if (thumb !== undefined) {
      for (let row = 0; row < viewport; row += 1) {
        const onThumb = row >= thumb.start && row < thumb.start + thumb.size;
        buffer.fillRect(this.width - 1, 1 + row, 1, 1, onThumb ? foreground : background);
      }
    }
  }
}

export function formatProblemsLines(model: ProblemsReadModel, width: number, maxRows = 10, scrollOffset = 0): readonly string[] {
  const rowLimit = Math.max(1, Math.trunc(maxRows));
  const truncated = model.truncatedUris?.size ?? 0;
  const rows: string[] = [`Problems ${model.all.length}${truncated === 0 ? '' : ` (${truncated} file${truncated === 1 ? '' : 's'} truncated)`}`];
  const problemLimit = Math.max(0, rowLimit - 1);
  const safeOffset = Math.max(0, Math.trunc(scrollOffset));
  const slice = model.all.slice(safeOffset, safeOffset + problemLimit);
  for (const problem of slice) rows.push(`${problem.uri}:${problem.range.startLine + 1}:${problem.range.startUtf16 + 1} ${problem.message}`.slice(0, Math.max(1, width)));
  if (safeOffset + problemLimit < model.all.length && rows.length < rowLimit) rows.push(`… ${model.all.length - safeOffset - problemLimit} more`.slice(0, Math.max(1, width)));
  return Object.freeze(rows);
}
