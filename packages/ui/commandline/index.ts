import {
  Renderable,
  type OptimizedBuffer,
  type RenderContext,
  type RenderableOptions,
  parseColor,
} from '@opentui/core/renderer';
import type { Disposable } from '../../contracts/src/index';
import type { ExCommandLineReadModel } from '../../workbench/src/index';

export interface ExCommandLineReadPort {
  readonly model: ExCommandLineReadModel | undefined;
  subscribe?(listener: (model: ExCommandLineReadModel | undefined) => void): Disposable;
}

export interface ExCommandLineTheme {
  readonly background: string;
  readonly foreground: string;
  readonly muted: string;
  readonly accent: string;
  readonly error: string;
}

export const DEFAULT_EX_COMMAND_LINE_THEME: ExCommandLineTheme = Object.freeze({
  background: '#F1F0EC', foreground: '#24292E', muted: '#60666D', accent: '#245A88', error: '#A52A36',
});

/** Read-only Ex surface. Parsing, execution and cursor state stay in the workbench/Vim owner (`packages/workbench/commands/ex-command-line.ts`). */
export interface ExCommandLineRenderableOptions extends RenderableOptions<ExCommandLineRenderable> {
  readonly commandLine: ExCommandLineReadPort;
  readonly theme?: ExCommandLineTheme;
  readonly maxRows?: number;
}

export class ExCommandLineRenderable extends Renderable {
  readonly #commandLine: ExCommandLineReadPort;
  readonly #theme: ExCommandLineTheme;
  readonly #maxRows: number;
  readonly #subscription: Disposable | undefined;

  constructor(ctx: RenderContext, options: ExCommandLineRenderableOptions) {
    super(ctx, {
      width: options.width ?? '100%',
      height: options.height ?? 4,
      buffered: options.buffered ?? true,
      ...(options.id === undefined ? {} : { id: options.id }),
    });
    this.#commandLine = options.commandLine;
    this.#theme = options.theme ?? DEFAULT_EX_COMMAND_LINE_THEME;
    this.#maxRows = options.maxRows ?? 8;
    if (!Number.isSafeInteger(this.#maxRows) || this.#maxRows < 1) throw new TypeError('ex-command-line-max-rows-must-be-positive');
    this.#subscription = options.commandLine.subscribe?.(() => {
      if (!this.isDestroyed) this.requestRender();
    });
    this.requestRender();
  }

  protected override destroySelf(): void {
    this.#subscription?.dispose();
    super.destroySelf();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const background = parseColor(this.#theme.background);
    const foreground = parseColor(this.#theme.foreground);
    const muted = parseColor(this.#theme.muted);
    const accent = parseColor(this.#theme.accent);
    const error = parseColor(this.#theme.error);
    buffer.fillRect(0, 0, this.width, this.height, background);
    const model = this.#commandLine.model;
    if (model === undefined) {
      this.ctx.setCursorPosition(0, 0, false);
      return;
    }
    const lines = formatExCommandLineLines(model, this.width, Math.min(this.height, this.#maxRows));
    for (let row = 0; row < lines.length; row += 1) {
      const line = lines[row];
      if (line === undefined) continue;
      drawCommandLineText(buffer, line, 0, row, row === 0 ? accent : row === 1 ? muted : foreground, background, this.width);
    }
    if (model.parseFailure !== undefined && this.height > 0) {
      const detail = 'reason' in model.parseFailure ? model.parseFailure.reason : model.parseFailure.kind;
      drawCommandLineText(buffer, detail, 0, Math.min(this.height - 1, lines.length), error, background, this.width);
    }
    const cursor = Math.max(0, Math.min(this.width - 1, model.cursorOffset));
    this.ctx.setCursorPosition(cursor, 0, true);
  }
}

export function formatExCommandLineLines(model: ExCommandLineReadModel, width: number, maxRows: number): readonly string[] {
  if (width <= 0 || maxRows <= 0) return Object.freeze([]);
  const safeWidth = Math.max(1, Math.trunc(width));
  const rows = Math.max(1, Math.trunc(maxRows));
  const output: string[] = [clip(model.source, safeWidth)];
  if (rows > 1) output.push(clip(model.acceptanceHint, safeWidth));
  for (let index = 0; index < model.candidates.length && output.length < rows; index += 1) {
    const candidate = model.candidates[index];
    if (candidate === undefined) continue;
    const marker = index === model.selectedIndex ? '>' : ' ';
    const state = candidate.available ? '' : ` [${candidate.disabledReason ?? 'unavailable'}]`;
    output.push(clip(`${marker} ${candidate.label} — ${candidate.detail}${state}`, safeWidth));
  }
  return Object.freeze(output);
}

function clip(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return '…';
  return `${value.slice(0, width - 1)}…`;
}

function drawCommandLineText(buffer: OptimizedBuffer, value: string, x: number, y: number, foreground: ReturnType<typeof parseColor>, background: ReturnType<typeof parseColor>, width: number): void {
  const clipped = clip(value, Math.max(0, width - x));
  for (let index = 0; index < clipped.length; index += 1) {
    const character = clipped[index];
    if (character !== undefined) buffer.setCell(x + index, y, character, foreground, background);
  }
}
