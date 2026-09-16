import { Renderable, type OptimizedBuffer, type RenderContext, type RenderableOptions, parseColor } from '@opentui/core/renderer';
import type { Disposable } from '../../contracts/src/index';

export interface ProblemRange { readonly startLine: number; readonly startUtf16: number; readonly endLine: number; readonly endUtf16: number; }
export interface Problem {
  readonly id: string; readonly uri: string; readonly range: ProblemRange; readonly message: string;
  readonly severity: 1 | 2 | 3 | 4 | undefined; readonly source: string | undefined; readonly code: string | number | undefined;
  readonly serverId: string; readonly documentVersion: number | undefined; readonly generation: number;
}
export interface ProblemsReadModel { readonly contractVersion: 1; readonly generation: number; readonly all: readonly Problem[]; }
export interface ProblemsReadPort { readonly model: ProblemsReadModel; subscribe(listener: (model: ProblemsReadModel) => void): Disposable; }
export interface ProblemsRenderableOptions extends RenderableOptions<ProblemsRenderable> { readonly problems: ProblemsReadPort; readonly maxRows?: number; }

export class ProblemsRenderable extends Renderable {
  readonly #problems: ProblemsReadPort; readonly #maxRows: number; readonly #subscription: Disposable;
  constructor(ctx: RenderContext, options: ProblemsRenderableOptions) {
    super(ctx, { width: options.width ?? '100%', height: options.height ?? 8, buffered: options.buffered ?? true, ...(options.id === undefined ? {} : { id: options.id }) });
    this.#problems = options.problems; this.#maxRows = Math.max(1, Math.trunc(options.maxRows ?? 10));
    this.#subscription = this.#problems.subscribe(() => { if (!this.isDestroyed) this.requestRender(); });
    this.requestRender();
  }
  protected override destroySelf(): void { this.#subscription.dispose(); super.destroySelf(); }
  protected override renderSelf(buffer: OptimizedBuffer): void {
    const background = parseColor('#FAF9F6'); const foreground = parseColor('#24292E'); const muted = parseColor('#60666D');
    buffer.fillRect(0, 0, this.width, this.height, background);
    const rows = formatProblemsLines(this.#problems.model, this.width, Math.min(this.height, this.#maxRows));
    for (let row = 0; row < rows.length && row < this.height; row += 1) buffer.drawText(rows[row] ?? '', 0, row, row === 0 ? foreground : muted, background, 0);
  }
}

export function formatProblemsLines(model: ProblemsReadModel, width: number, maxRows = 10): readonly string[] {
  const rowLimit = Math.max(1, Math.trunc(maxRows));
  const rows: string[] = [`Problems ${model.all.length}`];
  const problemLimit = Math.max(0, rowLimit - 1);
  for (const problem of model.all.slice(0, problemLimit)) rows.push(`${problem.uri}:${problem.range.startLine + 1}:${problem.range.startUtf16 + 1} ${problem.message}`.slice(0, Math.max(1, width)));
  if (model.all.length > problemLimit && rows.length < rowLimit) rows.push(`… ${model.all.length - problemLimit} more`.slice(0, Math.max(1, width)));
  return Object.freeze(rows);
}
