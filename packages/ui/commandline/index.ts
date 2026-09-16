import {
  Renderable,
  type OptimizedBuffer,
  type RenderContext,
  type RenderableOptions,
  parseColor,
} from '@opentui/core/renderer';
import type { Disposable } from '../../contracts/src/index';
import type { CommandAvailabilityContext } from '../../contracts/src/index';
import {
  acceptExCompletion,
  buildExCommandLineReadModel,
  resolveExExecution,
  type ExCommandCandidate,
  type ExCommandLineReadModel,
  type ExExecution,
  type ExExecutionFailure,
} from '../../workbench/src/index';
import type { CommandRegistry } from '../../workbench/src/index';

export interface ExCommandLineOptions {
  readonly registry: CommandRegistry;
  readonly source?: string;
  readonly cursorOffset?: number;
  readonly availability?: CommandAvailabilityContext;
}

export type ExCommandLineInput =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'key'; readonly key: 'Enter' | 'Tab' | 'Escape' | 'Backspace' | 'Delete' | 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' };

export type ExCommandLineResult =
  | { readonly kind: 'changed'; readonly source: string; readonly cursorOffset: number }
  | { readonly kind: 'completion-accepted'; readonly source: string; readonly cursorOffset: number; readonly candidate: ExCommandCandidate }
  | { readonly kind: 'execute'; readonly source: string; readonly execution: ExExecution }
  | { readonly kind: 'error'; readonly source: string; readonly error: ExExecutionFailure }
  | { readonly kind: 'cancel'; readonly source: string };

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

/** UI-owned text/cursor state; parsing and execution remain workbench/Vim-owned. */
export class ExCommandLineSession {
  readonly #registry: CommandRegistry;
  readonly #availability: CommandAvailabilityContext | undefined;
  #source: string;
  #cursorOffset: number;
  #selectedIndex = 0;
  #disposed = false;

  constructor(options: ExCommandLineOptions) {
    this.#registry = options.registry;
    this.#availability = options.availability;
    this.#source = options.source ?? ':';
    this.#cursorOffset = options.cursorOffset ?? this.#source.length;
    this.assertCursor();
  }

  get source(): string { return this.#source; }
  get cursorOffset(): number { return this.#cursorOffset; }
  get disposed(): boolean { return this.#disposed; }

  readModel(): ExCommandLineReadModel {
    if (this.#disposed) throw new Error('Ex command-line session is disposed');
    const context = this.#availability === undefined
      ? { source: this.#source, cursorOffset: this.#cursorOffset, registry: this.#registry }
      : { source: this.#source, cursorOffset: this.#cursorOffset, registry: this.#registry, availability: this.#availability };
    return buildExCommandLineReadModel(context, this.#selectedIndex);
  }

  setSource(source: string, cursorOffset = source.length): ExCommandLineReadModel {
    if (this.#disposed) throw new Error('Ex command-line session is disposed');
    this.#source = source;
    this.#cursorOffset = cursorOffset;
    this.#selectedIndex = 0;
    this.assertCursor();
    return this.readModel();
  }

  moveSelection(delta: -1 | 1): ExCommandLineReadModel {
    const model = this.readModel();
    if (model.candidates.length > 0) this.#selectedIndex = (model.selectedIndex + delta + model.candidates.length) % model.candidates.length;
    return this.readModel();
  }

  handleInput(input: ExCommandLineInput): ExCommandLineResult {
    if (this.#disposed) return { kind: 'error', source: this.#source, error: { kind: 'empty-command', message: 'Ex command-line session is disposed' } };
    if (input.kind === 'text') {
      if (input.text.length === 0) return { kind: 'changed', source: this.#source, cursorOffset: this.#cursorOffset };
      this.#source = `${this.#source.slice(0, this.#cursorOffset)}${input.text}${this.#source.slice(this.#cursorOffset)}`;
      this.#cursorOffset += input.text.length;
      this.#selectedIndex = 0;
      return { kind: 'changed', source: this.#source, cursorOffset: this.#cursorOffset };
    }
    switch (input.key) {
      case 'Enter': {
        // A highlighted suggestion never changes typed execution. Tab must
        // visibly replace the source before Enter can execute another name.
        const resolved = this.#availability === undefined
          ? resolveExExecution(this.#source, this.#registry)
          : resolveExExecution(this.#source, this.#registry, { availability: this.#availability });
        return resolved.ok ? { kind: 'execute', source: this.#source, execution: resolved.value } : { kind: 'error', source: this.#source, error: resolved.error };
      }
      case 'Tab': {
        const model = this.readModel();
        const candidate = model.candidates[model.selectedIndex];
        if (candidate === undefined || !candidate.available) return { kind: 'changed', source: this.#source, cursorOffset: this.#cursorOffset };
        this.#source = acceptExCompletion(this.#source, candidate);
        this.#cursorOffset = candidate.replaceStart + candidate.insertText.length;
        this.#selectedIndex = 0;
        return { kind: 'completion-accepted', source: this.#source, cursorOffset: this.#cursorOffset, candidate };
      }
      case 'Escape': return { kind: 'cancel', source: this.#source };
      case 'ArrowUp': this.moveSelection(-1); return { kind: 'changed', source: this.#source, cursorOffset: this.#cursorOffset };
      case 'ArrowDown': this.moveSelection(1); return { kind: 'changed', source: this.#source, cursorOffset: this.#cursorOffset };
      case 'ArrowLeft': this.#cursorOffset = Math.max(0, this.#cursorOffset - 1); return { kind: 'changed', source: this.#source, cursorOffset: this.#cursorOffset };
      case 'ArrowRight': this.#cursorOffset = Math.min(this.#source.length, this.#cursorOffset + 1); return { kind: 'changed', source: this.#source, cursorOffset: this.#cursorOffset };
      case 'Backspace':
        if (this.#cursorOffset > 0) {
          this.#source = `${this.#source.slice(0, this.#cursorOffset - 1)}${this.#source.slice(this.#cursorOffset)}`;
          this.#cursorOffset -= 1;
        }
        this.#selectedIndex = 0;
        return { kind: 'changed', source: this.#source, cursorOffset: this.#cursorOffset };
      case 'Delete':
        if (this.#cursorOffset < this.#source.length) this.#source = `${this.#source.slice(0, this.#cursorOffset)}${this.#source.slice(this.#cursorOffset + 1)}`;
        this.#selectedIndex = 0;
        return { kind: 'changed', source: this.#source, cursorOffset: this.#cursorOffset };
    }
  }

  dispose(): void { this.#disposed = true; }

  private assertCursor(): void {
    if (!Number.isSafeInteger(this.#cursorOffset) || this.#cursorOffset < 0 || this.#cursorOffset > this.#source.length) throw new TypeError('Ex command-line cursor must be a UTF-16 source offset');
  }
}

/** Read-only Ex surface. Parsing and execution stay in the workbench/Vim owner. */
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
