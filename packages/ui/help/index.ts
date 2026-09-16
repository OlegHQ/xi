import type {
  Disposable,
  CommandAvailabilityContext,
} from '../../contracts/src/index';
import type {
  PrefixHelpHint,
  PrefixHelpReadModel,
  PrefixHelpRequest,
} from '../../workbench/src/index';

export interface PrefixHelpClock {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PrefixHelpGenerations {
  readonly registryGeneration: number;
  readonly configGeneration: number;
  readonly focusGeneration: number;
}

/** Read-only bridge to the workbench. It never dispatches input. */
export interface PrefixHelpSource {
  readGenerations(): PrefixHelpGenerations;
  readPrefixHelp(request: PrefixHelpRequest): PrefixHelpReadModel;
}

export interface PrefixHelpReadPort {
  readonly model: PrefixHelpReadModel | undefined;
  subscribe(listener: (model: PrefixHelpReadModel | undefined) => void): Disposable;
}

export interface PrefixHelpControllerOptions {
  readonly delayMilliseconds?: number;
  readonly clock?: PrefixHelpClock;
}

const systemClock: PrefixHelpClock = Object.freeze({
  setTimeout: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds),
  clearTimeout: (handle: unknown) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
});

/**
 * Schedules one passive hint read per pending prefix. The timer is independent
 * from mapping/native parser timeout and cannot execute or cancel a command.
 */
export class PrefixHelpController implements PrefixHelpReadPort, Disposable {
  readonly #source: PrefixHelpSource;
  readonly #delayMilliseconds: number;
  readonly #clock: PrefixHelpClock;
  readonly #listeners = new Set<(model: PrefixHelpReadModel | undefined) => void>();
  #timer: unknown;
  #serial = 0;
  #disposed = false;
  #model: PrefixHelpReadModel | undefined;

  constructor(source: PrefixHelpSource, options: PrefixHelpControllerOptions = {}) {
    this.#source = source;
    this.#delayMilliseconds = options.delayMilliseconds ?? 250;
    if (!Number.isSafeInteger(this.#delayMilliseconds) || this.#delayMilliseconds < 0) {
      throw new TypeError('prefix-help-delay-must-be-nonnegative');
    }
    this.#clock = options.clock ?? systemClock;
  }

  get model(): PrefixHelpReadModel | undefined { return this.#model; }

  subscribe(listener: (model: PrefixHelpReadModel | undefined) => void): Disposable {
    if (this.#disposed) throw new Error('prefix-help-controller-disposed');
    this.#listeners.add(listener);
    return Object.freeze({ dispose: () => { this.#listeners.delete(listener); } });
  }

  /** Replace the pending request and arm the independent hint timer. */
  schedule(request: PrefixHelpRequest): void {
    if (this.#disposed) return;
    this.clearTimer();
    this.clearModel();
    if (request.pendingKeys.length === 0 && request.parserContinuations.length === 0) return;
    const serial = ++this.#serial;
    const captured = this.#source.readGenerations();
    const timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      if (this.#disposed || serial !== this.#serial) return;
      const current = this.#source.readGenerations();
      if (!sameGenerations(captured, current) || current.configGeneration !== request.configGeneration) return;
      const model = this.#source.readPrefixHelp(Object.freeze({
        ...request,
        ...(request.availability === undefined ? {} : {
          availability: Object.freeze({
            contexts: Object.freeze([...request.availability.contexts]),
            capabilities: Object.freeze([...request.availability.capabilities]),
          } as CommandAvailabilityContext),
        }),
      }));
      if (!sameGenerations(captured, {
        registryGeneration: model.registryGeneration,
        focusGeneration: model.focusGeneration,
        configGeneration: model.configGeneration,
      })) return;
      if (model.hints.length === 0) return;
      this.#model = model;
      this.notify();
    }, this.#delayMilliseconds);
    this.#timer = timer;
  }

  /** Clear help after a command, Escape, focus transfer or parser cancel. */
  cancel(): void {
    if (this.#disposed) return;
    this.#serial += 1;
    this.clearTimer();
    this.clearModel();
  }

  completeCommand(): void { this.cancel(); }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#serial += 1;
    this.clearTimer();
    this.#model = undefined;
    this.#listeners.clear();
  }

  private clearTimer(): void {
    if (this.#timer === undefined) return;
    this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  private clearModel(): void {
    if (this.#model === undefined) return;
    this.#model = undefined;
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.#listeners]) listener(this.#model);
  }
}

/**
 * Format a bounded panel/status representation. A narrow screen gets one
 * compact line; neither variant changes focus or owns keyboard dispatch.
 */
export function formatPrefixHelpLines(model: PrefixHelpReadModel | undefined, width: number, maxRows: number): readonly string[] {
  if (model === undefined || maxRows <= 0 || width <= 0) return Object.freeze([]);
  const safeWidth = Math.max(1, Math.trunc(width));
  const rows = Math.max(1, Math.trunc(maxRows));
  const prefix = model.pendingKeys.length === 0 ? 'Prefix' : `Prefix ${model.pendingKeys.join(' ')}`;
  const compact = model.compactHint ?? `${prefix}: no legal continuation`;
  if (safeWidth < 48 || rows === 1) return Object.freeze([clip(compact, safeWidth)]);
  const output: string[] = [clip(`${prefix}  (${model.hints.length} hints)`, safeWidth)];
  for (const hint of model.hints) {
    if (output.length >= rows) break;
    const state = hint.available ? '' : ` [${hint.disabledReason ?? 'unavailable'}]`;
    const alias = hint.aliases.length === 0 ? '' : ` (${hint.aliases.join(', ')})`;
    output.push(clip(`  ${hint.keyLabel}  ${hint.title}${alias} — ${hint.description}${state}`, safeWidth));
  }
  return Object.freeze(output);
}

function sameGenerations(left: PrefixHelpGenerations, right: PrefixHelpGenerations): boolean {
  return left.registryGeneration === right.registryGeneration
    && left.configGeneration === right.configGeneration
    && left.focusGeneration === right.focusGeneration;
}

function clip(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return '…';
  return `${value.slice(0, width - 1)}…`;
}

import {
  Renderable,
  type OptimizedBuffer,
  type RenderContext,
  type RenderableOptions,
  parseColor,
} from '@opentui/core/renderer';

export interface PrefixHelpPanelTheme {
  readonly background: string;
  readonly foreground: string;
  readonly muted: string;
  readonly accent: string;
  readonly unavailable: string;
}

export const DEFAULT_PREFIX_HELP_THEME: PrefixHelpPanelTheme = Object.freeze({
  background: '#F1F0EC', foreground: '#24292E', muted: '#60666D', accent: '#245A88', unavailable: '#A52A36',
});

export interface PrefixHelpRenderableOptions extends RenderableOptions<PrefixHelpRenderable> {
  readonly help: PrefixHelpReadPort;
  readonly theme?: PrefixHelpPanelTheme;
  readonly maxRows?: number;
}

/** Passive bounded panel. It subscribes only for repaint and never handles keys. */
export class PrefixHelpRenderable extends Renderable {
  readonly #help: PrefixHelpReadPort;
  readonly #theme: PrefixHelpPanelTheme;
  readonly #maxRows: number;
  readonly #subscription: Disposable;

  constructor(ctx: RenderContext, options: PrefixHelpRenderableOptions) {
    super(ctx, {
      width: options.width ?? '100%',
      height: options.height ?? 1,
      buffered: options.buffered ?? true,
      ...(options.id === undefined ? {} : { id: options.id }),
    });
    this.#help = options.help;
    this.#theme = options.theme ?? DEFAULT_PREFIX_HELP_THEME;
    this.#maxRows = options.maxRows ?? 8;
    if (!Number.isSafeInteger(this.#maxRows) || this.#maxRows < 1) throw new TypeError('prefix-help-max-rows-must-be-positive');
    this.#subscription = this.#help.subscribe(() => {
      if (!this.isDestroyed) this.requestRender();
    });
    this.requestRender();
  }

  protected override destroySelf(): void {
    this.#subscription.dispose();
    super.destroySelf();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const background = parseColor(this.#theme.background);
    const foreground = parseColor(this.#theme.foreground);
    const muted = parseColor(this.#theme.muted);
    const accent = parseColor(this.#theme.accent);
    const unavailable = parseColor(this.#theme.unavailable);
    buffer.fillRect(0, 0, this.width, this.height, background);
    const model = this.#help.model;
    if (model === undefined) {
      this.ctx.setCursorPosition(0, 0, false);
      return;
    }
    const lines = formatPrefixHelpLines(model, this.width, Math.min(this.height, this.#maxRows));
    for (let row = 0; row < lines.length; row += 1) {
      const line = lines[row];
      if (line === undefined) continue;
      drawHelpText(buffer, line, 0, row, row === 0 ? accent : foreground, background, this.width);
    }
    const hasUnavailable = model.hints.some((hint) => !hint.available);
    if (hasUnavailable && this.height > 0) {
      drawHelpText(buffer, 'Unavailable capability', 0, Math.min(this.height - 1, lines.length), unavailable, background, this.width);
    }
    void muted;
    this.ctx.setCursorPosition(0, 0, false);
  }
}

function drawHelpText(buffer: OptimizedBuffer, text: string, x: number, y: number, foreground: ReturnType<typeof parseColor>, background: ReturnType<typeof parseColor>, width: number): void {
  const clipped = clip(text, Math.max(0, width - x));
  for (let index = 0; index < clipped.length; index += 1) {
    const character = clipped[index];
    if (character !== undefined) buffer.setCell(x + index, y, character, foreground, background);
  }
}

export type { PrefixHelpHint };
