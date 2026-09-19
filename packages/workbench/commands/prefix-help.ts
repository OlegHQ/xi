import type {
  CommandAvailabilityContext,
  CommandInvocationRef,
  CommandRegistrySnapshot,
  Disposable,
} from '../../contracts/src/index.ts';
import { CommandRegistry } from './registry';

/** Parser-owned continuation metadata forwarded to discovery. */
export type PrefixHelpParserContinuation =
  | { readonly kind: 'keys'; readonly keys: readonly string[]; readonly label: string }
  | { readonly kind: 'motions'; readonly keys: readonly string[]; readonly label: string }
  | { readonly kind: 'count-digits'; readonly keys: readonly string[]; readonly label: string }
  | { readonly kind: 'register-name'; readonly characters: readonly string[]; readonly label: string }
  | { readonly kind: 'literal-character'; readonly label: string }
  | { readonly kind: 'escape'; readonly label: string };

/** Immutable binding projection used by the passive help builder. */
export interface PrefixHelpBinding {
  readonly targetId: string;
  readonly keys: readonly string[];
  readonly command: CommandInvocationRef;
  readonly contexts: readonly string[];
  readonly description: string | undefined;
}

export interface PrefixHelpRequest {
  readonly targetId: string | undefined;
  readonly pendingKeys: readonly string[];
  readonly parserContinuations: readonly PrefixHelpParserContinuation[];
  /** Config generation captured by the input/parser session. */
  readonly configGeneration: number;
  readonly availability?: CommandAvailabilityContext;
}

export interface PrefixHelpHint {
  readonly kind: 'mapping' | 'parser' | 'literal' | 'escape';
  /** Keys after the currently pending prefix. Empty means a literal prompt. */
  readonly keys: readonly string[];
  /** Human-readable key or key group shown by the panel. */
  readonly keyLabel: string;
  readonly sequence: readonly string[];
  readonly title: string;
  readonly description: string;
  readonly commandId: string | undefined;
  readonly aliases: readonly string[];
  readonly available: boolean;
  readonly disabledReason: string | undefined;
}

export interface PrefixHelpReadModel {
  readonly registryGeneration: number;
  readonly focusGeneration: number;
  readonly configGeneration: number;
  readonly targetId: string | undefined;
  readonly pendingKeys: readonly string[];
  readonly hints: readonly PrefixHelpHint[];
  /** One bounded status-row hint used when a full panel cannot fit. */
  readonly compactHint: string | undefined;
}

export interface PrefixHelpBuildInput {
  readonly request: PrefixHelpRequest;
  readonly registry: CommandRegistry;
  readonly registrySnapshot?: CommandRegistrySnapshot;
  readonly focusGeneration: number;
  readonly bindings: readonly PrefixHelpBinding[];
}

/**
 * Build passive discovery data from the same registry and bindings used for
 * dispatch. This function never resolves, dispatches or changes parser state.
 */
export function buildPrefixHelpReadModel(input: PrefixHelpBuildInput): PrefixHelpReadModel {
  const request = input.request;
  if (!Number.isSafeInteger(request.configGeneration) || request.configGeneration < 0) {
    throw new TypeError('prefix-help-config-generation-must-be-nonnegative');
  }
  if (!Number.isSafeInteger(input.focusGeneration) || input.focusGeneration < 0) {
    throw new TypeError('prefix-help-focus-generation-must-be-nonnegative');
  }
  const pendingKeys = Object.freeze([...request.pendingKeys]);
  const targetBindings = input.bindings.filter((binding) => binding.targetId === request.targetId
    && bindingMatchesContexts(binding.contexts, request.availability?.contexts ?? []));
  const hints: PrefixHelpHint[] = [];

  for (const binding of targetBindings) {
    if (!isPrefix(pendingKeys, binding.keys) || binding.keys.length <= pendingKeys.length) continue;
    const inspection = input.registry.inspect(binding.command, request.availability);
    const commandId = binding.command.kind === 'command' ? String(binding.command.id) : inspection === undefined ? undefined : String(inspection.descriptor.id);
    if (commandId === undefined) continue;
    const aliases = aliasesFor(input.registrySnapshot ?? input.registry.snapshot, commandId);
    const keys = Object.freeze(binding.keys.slice(pendingKeys.length));
    hints.push(Object.freeze({
      kind: 'mapping',
      keys,
      keyLabel: formatKeys(keys),
      sequence: Object.freeze([...binding.keys]),
      title: inspection?.descriptor.title ?? commandTitle(commandId),
      description: binding.description ?? inspection?.descriptor.help ?? commandTitle(commandId),
      commandId,
      aliases,
      available: inspection?.available ?? true,
      disabledReason: inspection?.disabledReason,
    }));
  }

  for (const continuation of request.parserContinuations) {
    hints.push(parserHint(continuation, pendingKeys));
  }

  const deduped = dedupeHints(hints);
  const compactHint = deduped.length === 0
    ? undefined
    : `Prefix ${formatKeys(pendingKeys)}: ${deduped.slice(0, 2).map((hint) => `${hint.keyLabel} ${hint.description}`).join(' · ')}${deduped.length > 2 ? ` · +${deduped.length - 2}` : ''}`;
  return Object.freeze({
    registryGeneration: input.registrySnapshot?.generation ?? input.registry.snapshot.generation,
    focusGeneration: input.focusGeneration,
    configGeneration: request.configGeneration,
    targetId: request.targetId,
    pendingKeys,
    hints: Object.freeze(deduped),
    compactHint,
  });
}

function commandTitle(commandId: string): string {
  return commandId.split(/[.-]/u).map((part) => part.length === 0 ? part : `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' ');
}

function parserHint(continuation: PrefixHelpParserContinuation, pendingKeys: readonly string[]): PrefixHelpHint {
  if (continuation.kind === 'literal-character') {
    return Object.freeze({
      kind: 'literal', keys: Object.freeze([]), keyLabel: 'one character', sequence: Object.freeze([...pendingKeys]),
      title: 'Literal input', description: continuation.label, commandId: undefined,
      aliases: Object.freeze([]), available: true, disabledReason: undefined,
    });
  }
  if (continuation.kind === 'escape') {
    return Object.freeze({
      kind: 'escape', keys: Object.freeze(['<Esc>']), keyLabel: 'Esc', sequence: Object.freeze([...pendingKeys, '<Esc>']),
      title: 'Cancel', description: continuation.label, commandId: undefined,
      aliases: Object.freeze([]), available: true, disabledReason: undefined,
    });
  }
  const source = continuation.kind === 'register-name' ? continuation.characters : continuation.keys;
  const keys = Object.freeze([...source]);
  return Object.freeze({
    kind: 'parser', keys, keyLabel: continuation.kind === 'count-digits' ? '0–9' : formatKeys(source),
    sequence: Object.freeze([...pendingKeys]), title: continuation.kind === 'motions' ? 'Motion' : continuation.label,
    description: continuation.label, commandId: undefined, aliases: Object.freeze([]), available: true, disabledReason: undefined,
  });
}

function dedupeHints(hints: readonly PrefixHelpHint[]): PrefixHelpHint[] {
  const seen = new Set<string>();
  return hints.slice().sort((left, right) => compareText(left.kind, right.kind) || compareText(left.keyLabel, right.keyLabel) || compareText(left.title, right.title))
    .filter((hint) => {
      const key = `${hint.kind}\u0000${hint.keyLabel}\u0000${hint.title}\u0000${hint.description}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function aliasesFor(snapshot: CommandRegistrySnapshot, commandId: string): readonly string[] {
  const descriptor = snapshot.commands.find((row) => String(row.descriptor.id) === commandId);
  return Object.freeze([...(descriptor?.aliases ?? [])]);
}

function bindingMatchesContexts(bindingContexts: readonly string[], availabilityContexts: readonly string[]): boolean {
  return bindingContexts.length === 0 || bindingContexts.some((context) => availabilityContexts.includes(context));
}

function isPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  return prefix.length <= full.length && prefix.every((value, index) => value === full[index]);
}

function formatKeys(keys: readonly string[]): string {
  if (keys.length === 0) return '·';
  if (keys.length <= 8) return keys.join(' ');
  return `${keys.slice(0, 6).join(' ')} … +${keys.length - 6}`;
}

export interface PrefixHelpClock {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PrefixHelpGenerations {
  readonly registryGeneration: number;
  readonly configGeneration: number;
  readonly focusGeneration: number;
}

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

/** Schedules passive help independently from Vim mapping/parser timeouts. */
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
    if (!Number.isSafeInteger(this.#delayMilliseconds) || this.#delayMilliseconds < 0) throw new TypeError('prefix-help-delay-must-be-nonnegative');
    this.#clock = options.clock ?? systemClock;
  }

  get model(): PrefixHelpReadModel | undefined { return this.#model; }

  subscribe(listener: (model: PrefixHelpReadModel | undefined) => void): Disposable {
    if (this.#disposed) throw new Error('prefix-help-controller-disposed');
    this.#listeners.add(listener);
    return Object.freeze({ dispose: () => { this.#listeners.delete(listener); } });
  }

  schedule(request: PrefixHelpRequest): void {
    if (this.#disposed) return;
    this.clearTimer();
    this.clearModel();
    if (request.pendingKeys.length === 0 && request.parserContinuations.length === 0) return;
    const serial = ++this.#serial;
    const captured = this.#source.readGenerations();
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      if (this.#disposed || serial !== this.#serial) return;
      const current = this.#source.readGenerations();
      if (!sameGenerations(captured, current) || current.configGeneration !== request.configGeneration) return;
      const model = this.#source.readPrefixHelp(request);
      if (!sameGenerations(captured, { registryGeneration: model.registryGeneration, focusGeneration: model.focusGeneration, configGeneration: model.configGeneration })) return;
      if (model.hints.length === 0) return;
      this.#model = model;
      this.notify();
    }, this.#delayMilliseconds);
  }

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

function sameGenerations(left: PrefixHelpGenerations, right: PrefixHelpGenerations): boolean {
  return left.registryGeneration === right.registryGeneration
    && left.configGeneration === right.configGeneration
    && left.focusGeneration === right.focusGeneration;
}
