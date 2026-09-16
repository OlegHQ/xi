import type { CommandAvailabilityContext } from '../../contracts/src/index';
import {
  acceptExCompletion,
  resolveExExecution,
  buildExCommandLineReadModel,
  type ExCommandCandidate,
  type ExCommandLineReadModel,
  type ExExecution,
  type ExExecutionFailure,
} from './ex-discovery';
import type { CommandRegistry } from './registry';

export type ExCommandLineInput =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'key'; readonly key: 'Enter' | 'Tab' | 'Escape' | 'Backspace' | 'Delete' | 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' };

export type ExCommandLineResult =
  | { readonly kind: 'changed'; readonly source: string; readonly cursorOffset: number }
  | { readonly kind: 'completion-accepted'; readonly source: string; readonly cursorOffset: number; readonly candidate: ExCommandCandidate }
  | { readonly kind: 'execute'; readonly source: string; readonly execution: ExExecution }
  | { readonly kind: 'error'; readonly source: string; readonly error: ExExecutionFailure }
  | { readonly kind: 'cancel'; readonly source: string };

/** Workbench-owned Ex source and cursor; UI only presents and edits this model. */
export class ExCommandLineSession {
  readonly #registry: CommandRegistry;
  readonly #availability: CommandAvailabilityContext | undefined;
  #source: string;
  #cursorOffset: number;
  #selectedIndex = 0;
  #disposed = false;

  constructor(options: { readonly registry: CommandRegistry; readonly source?: string; readonly cursorOffset?: number; readonly availability?: CommandAvailabilityContext }) {
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
        if (this.#cursorOffset > 0) { this.#source = `${this.#source.slice(0, this.#cursorOffset - 1)}${this.#source.slice(this.#cursorOffset)}`; this.#cursorOffset -= 1; }
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
