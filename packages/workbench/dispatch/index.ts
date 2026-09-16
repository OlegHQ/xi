import type {
  CanonicalInputEvent,
  CommandAvailabilityContext,
  CommandDispatchFailure,
  CommandInvocationRef,
  Disposable,
  Result,
} from '../../contracts/src/index';
import { CommandRegistry } from '../commands/registry';
import {
  FocusGraph,
  type FocusGraphFailure,
  type FocusTarget,
} from '../focus/index';
import {
  buildPrefixHelpReadModel,
  type PrefixHelpBinding,
  type PrefixHelpReadModel,
  type PrefixHelpRequest,
} from '../commands/prefix-help';

export interface CommandKeyBinding {
  /** One or more canonical key names. The first matching target owns the event. */
  readonly keys: readonly string[];
  readonly command: CommandInvocationRef;
  readonly arguments?: unknown;
  /** Empty/omitted means every context exposed by the focused target. */
  readonly contexts?: readonly string[];
  readonly description?: string;
}

export type BindingFailure =
  | { readonly kind: 'dispatcher-disposed' }
  | { readonly kind: 'missing-target'; readonly targetId: string }
  | { readonly kind: 'invalid-binding'; readonly message: string }
  | { readonly kind: 'unknown-command'; readonly reference: CommandInvocationRef }
  | { readonly kind: 'duplicate-binding'; readonly targetId: string; readonly keys: readonly string[] };

export interface WorkbenchInputEnvelope {
  readonly event: CanonicalInputEvent;
  /** Raw protocol bytes are optional for synthetic events and required for diagnostics. */
  readonly rawBytes?: Uint8Array;
}

export type InputDispatchResult =
  | { readonly kind: 'consumed'; readonly targetId: string; readonly commandId?: string; readonly value?: unknown }
  | { readonly kind: 'pending'; readonly targetId: string; readonly keys: readonly string[] }
  | { readonly kind: 'unhandled'; readonly reason: 'no-focus' | 'focus-target-disposed' | 'no-binding' | 'target-handler-failed'; readonly targetId?: string; readonly detail?: string }
  | { readonly kind: 'failed'; readonly targetId: string; readonly commandId?: string; readonly error: CommandDispatchFailure };

export interface RawInputDiagnostic {
  readonly atSequence: number;
  readonly targetId: string | undefined;
  readonly kind: 'key' | 'mouse' | 'paste' | 'protocol';
  readonly rawHex: string;
}

export interface PaletteEntry {
  readonly id: string;
  readonly title: string;
  readonly help: string;
  readonly category: string;
  readonly owner: string;
  readonly aliases: readonly string[];
  readonly keys: readonly string[];
  readonly available: boolean;
  readonly disabledReason: string | undefined;
}

export interface PaletteReadModel {
  readonly registryGeneration: number;
  readonly focusGeneration: number;
  readonly query: string;
  readonly entries: readonly PaletteEntry[];
}

export interface KeyInspectionReadModel {
  readonly registryGeneration: number;
  readonly focusGeneration: number;
  readonly key: string;
  readonly targetId: string | undefined;
  readonly pending: readonly string[];
  readonly candidates: readonly {
    readonly commandId: string;
    readonly title: string;
    readonly owner: string;
    readonly keys: readonly string[];
    readonly available: boolean;
    readonly disabledReason: string | undefined;
    readonly exact: boolean;
    readonly longerPrefix: boolean;
  }[];
}

interface StoredBinding {
  readonly targetId: string;
  readonly value: CommandKeyBinding;
  readonly sequenceKey: string;
  readonly order: number;
}

interface BindingContribution {
  readonly id: number;
  readonly bindings: readonly StoredBinding[];
}

interface PendingKeys {
  readonly targetId: string;
  readonly keys: readonly string[];
}

/**
 * Routes one canonical input event through the active focus target and the
 * single immutable command registry. Widgets can handle events only after no
 * command binding claims them, so a key cannot execute two handlers.
 */
export class WorkbenchInputDispatcher implements Disposable {
  readonly #registry: CommandRegistry;
  readonly #focus: FocusGraph;
  #contributions: readonly BindingContribution[] = [];
  #nextContributionId = 1;
  #nextBindingOrder = 0;
  #pending: PendingKeys | undefined;
  #diagnostics: RawInputDiagnostic[] = [];
  #sequence = 0;
  #disposed = false;

  constructor(registry: CommandRegistry, focus: FocusGraph) {
    this.#registry = registry;
    this.#focus = focus;
  }

  get registry(): CommandRegistry { return this.#registry; }
  get focus(): FocusGraph { return this.#focus; }

  registerBindings(targetId: string, bindings: readonly CommandKeyBinding[]): Result<Disposable, BindingFailure> {
    if (this.#disposed) return { ok: false, error: { kind: 'dispatcher-disposed' } };
    if (this.#focus.snapshot.targets.every((target) => target.id !== targetId)) {
      return { ok: false, error: { kind: 'missing-target', targetId } };
    }
    const existing = this.#allBindings();
    const candidate: StoredBinding[] = [];
    for (const binding of bindings) {
      const checked = validateBinding(binding, this.#registry);
      if (!checked.ok) return checked;
      const sequenceKey = bindingSequenceKey(targetId, binding.keys, binding.contexts ?? []);
      if (existing.some((item) => item.sequenceKey === sequenceKey) || candidate.some((item) => item.sequenceKey === sequenceKey)) {
        return { ok: false, error: { kind: 'duplicate-binding', targetId, keys: binding.keys } };
      }
      candidate.push(Object.freeze({
        targetId,
        value: freezeBinding(binding),
        sequenceKey,
        order: this.#nextBindingOrder,
      }));
      this.#nextBindingOrder += 1;
    }
    const id = this.#nextContributionId;
    this.#nextContributionId += 1;
    const contribution: BindingContribution = Object.freeze({ id, bindings: Object.freeze(candidate) });
    this.#contributions = Object.freeze([...this.#contributions, contribution]);
    return { ok: true, value: new BindingHandle(() => this.removeContribution(id)) };
  }

  /** Clear an operator/key prefix before transferring focus to a panel. */
  openOverlay(target: FocusTarget): Result<Disposable, FocusGraphFailure> {
    this.#pending = undefined;
    return this.#focus.openOverlay(target);
  }

  focusTarget(targetId: string): Result<void, FocusGraphFailure> {
    this.#pending = undefined;
    return this.#focus.focus(targetId);
  }

  moveFocus(direction: Parameters<FocusGraph['move']>[0]): Result<string, FocusGraphFailure> {
    this.#pending = undefined;
    return this.#focus.move(direction);
  }

  async dispatch(input: WorkbenchInputEnvelope, availability: CommandAvailabilityContext = emptyAvailability): Promise<InputDispatchResult> {
    if (this.#disposed) return { kind: 'unhandled', reason: 'no-focus', detail: 'dispatcher-disposed' };
    const event = input.event;
    this.recordDiagnostic(input);
    const active = this.#focus.activeState();
    if (active.kind === 'disposed') {
      this.#pending = undefined;
      return { kind: 'unhandled', reason: 'focus-target-disposed', targetId: active.targetId };
    }
    if (active.kind === 'empty') {
      this.#pending = undefined;
      return { kind: 'unhandled', reason: 'no-focus' };
    }
    const target = active.target;

    if (event.kind === 'key' && event.phase !== 'release') {
      if (isEscape(event)) {
        if (this.#pending !== undefined) {
          this.#pending = undefined;
          return { kind: 'consumed', targetId: target.id, value: 'pending-cancelled' };
        }
        if (this.#focus.snapshot.overlayDepth > 0 && this.#focus.dismissOverlay()) {
          return { kind: 'consumed', targetId: target.id, value: 'overlay-dismissed' };
        }
      }
      const routed = await this.routeKey(target, keyChord(event), withTargetContexts(target, availability));
      if (routed !== undefined) return routed;
    }

    if (target.handleInput !== undefined) {
      try {
        const handled = await target.handleInput(event);
        if (handled.kind === 'consumed') return { kind: 'consumed', targetId: target.id };
        if (handled.kind === 'pending') return { kind: 'pending', targetId: target.id, keys: Object.freeze([]) };
      } catch (error: unknown) {
        return { kind: 'unhandled', reason: 'target-handler-failed', targetId: target.id, detail: errorMessage(error) };
      }
    }
    return { kind: 'unhandled', reason: 'no-binding', targetId: target.id };
  }

  readPalette(query = '', availability: CommandAvailabilityContext = emptyAvailability): PaletteReadModel {
    const activeTarget = this.#focus.activeTarget();
    const effectiveAvailability = activeTarget === undefined ? availability : withTargetContexts(activeTarget, availability);
    const normalizedQuery = query.trim().toLocaleLowerCase('en-US');
    const keyByCommand = new Map<string, string[]>();
    for (const binding of this.#allBindings()) {
      const command = this.#registry.inspect(binding.value.command, effectiveAvailability);
      if (command === undefined) continue;
      const id = command.descriptor.id as string;
      const values = keyByCommand.get(id) ?? [];
      values.push(formatKeySequence(binding.value.keys));
      keyByCommand.set(id, values);
    }
    const entries: PaletteEntry[] = [];
    for (const row of this.#registry.snapshot.commands) {
      const descriptor = row.descriptor;
      const inspection = this.#registry.inspect({ kind: 'command', id: descriptor.id }, effectiveAvailability);
      const keys = [...new Set(keyByCommand.get(descriptor.id as string) ?? [])].sort(compareText);
      const aliases = [...row.aliases].sort(compareText);
      const haystack = [descriptor.id as string, descriptor.title, descriptor.help, descriptor.category, ...aliases, ...keys]
        .join(' ').toLocaleLowerCase('en-US');
      if (normalizedQuery !== '' && !haystack.includes(normalizedQuery)) continue;
      entries.push(Object.freeze({
        id: descriptor.id as string,
        title: descriptor.title,
        help: descriptor.help,
        category: descriptor.category,
        owner: descriptor.owner,
        aliases: Object.freeze(aliases),
        keys: Object.freeze(keys),
        available: inspection?.available ?? false,
        disabledReason: inspection?.disabledReason,
      }));
    }
    entries.sort((left, right) => compareText(left.category, right.category) || compareText(left.title, right.title) || compareText(left.id, right.id));
    return Object.freeze({
      registryGeneration: this.#registry.snapshot.generation,
      focusGeneration: this.#focus.snapshot.generation,
      query,
      entries: Object.freeze(entries),
    });
  }

  inspectKey(key: string, availability: CommandAvailabilityContext = emptyAvailability): KeyInspectionReadModel {
    const active = this.#focus.activeState();
    const targetId = active.kind === 'active' ? active.target.id : active.kind === 'disposed' ? active.targetId : undefined;
    const target = active.kind === 'active' ? active.target : undefined;
    const effectiveAvailability = target === undefined ? availability : withTargetContexts(target, availability);
    const pendingState = this.#pending;
    const pending = pendingState !== undefined && pendingState.targetId === targetId ? pendingState.keys : Object.freeze([]);
    const keys = [...pending, key];
    const candidates = target === undefined ? [] : this.#allBindings()
      .filter((binding) => binding.targetId === target.id && bindingMatchesContexts(binding.value, target.contexts))
      .map((binding) => {
        const inspection = this.#registry.inspect(binding.value.command, effectiveAvailability);
        const candidate = binding.value.keys;
        const exact = sameKeys(candidate, keys);
        const longerPrefix = isPrefix(keys, candidate) && !exact;
        if (!isPrefix(keys, candidate) && !isPrefix(candidate, keys)) return undefined;
        if (inspection === undefined) return undefined;
        return Object.freeze({
          commandId: inspection.descriptor.id as string,
          title: inspection.descriptor.title,
          owner: inspection.descriptor.owner,
          keys: Object.freeze([...candidate]),
          available: inspection.available,
          disabledReason: inspection.disabledReason,
          exact,
          longerPrefix,
        });
      })
      .filter((item): item is NonNullable<typeof item> => item !== undefined)
      .sort((left, right) => left.keys.length - right.keys.length || compareText(left.commandId, right.commandId));
    return Object.freeze({
      registryGeneration: this.#registry.snapshot.generation,
      focusGeneration: this.#focus.snapshot.generation,
      key,
      targetId,
      pending: Object.freeze([...pending]),
      candidates: Object.freeze(candidates),
    });
  }

  /**
   * Read passive prefix hints without touching the dispatcher's pending
   * sequence. Parser continuation metadata is supplied by Vim; mappings and
   * availability are read from this dispatcher's active generation.
   */
  readPrefixHelp(request: PrefixHelpRequest): PrefixHelpReadModel {
    const active = this.#focus.activeState();
    const activeTarget = active.kind === 'active' ? active.target : undefined;
    const targetId = request.targetId ?? activeTarget?.id;
    const effectiveAvailability = activeTarget === undefined
      ? request.availability
      : withTargetContexts(activeTarget, request.availability ?? emptyAvailability);
    const bindings: PrefixHelpBinding[] = this.#allBindings().map((binding) => Object.freeze({
      targetId: binding.targetId,
      keys: Object.freeze([...binding.value.keys]),
      command: Object.freeze({ ...binding.value.command }),
      contexts: Object.freeze([...(binding.value.contexts ?? [])]),
      description: binding.value.description,
    }));
    return buildPrefixHelpReadModel({
      request: Object.freeze({
        ...request,
        targetId,
        ...(effectiveAvailability === undefined ? {} : { availability: effectiveAvailability }),
      }),
      registry: this.#registry,
      registrySnapshot: this.#registry.snapshot,
      focusGeneration: this.#focus.snapshot.generation,
      bindings,
    });
  }

  readDiagnostics(): readonly RawInputDiagnostic[] { return Object.freeze(this.#diagnostics.map((item) => item)); }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#contributions = [];
    this.#pending = undefined;
    this.#diagnostics = [];
  }

  async routeKey(target: FocusTarget, key: string, availability: CommandAvailabilityContext): Promise<InputDispatchResult | undefined> {
    const prefix = this.#pending?.targetId === target.id ? this.#pending.keys : [];
    const sequence = [...prefix, key];
    const bindings = this.#allBindings()
      .filter((binding) => binding.targetId === target.id && bindingMatchesContexts(binding.value, target.contexts));
    const matching = bindings.filter((binding) => isPrefix(sequence, binding.value.keys));
    const exact = matching.find((binding) => sameKeys(sequence, binding.value.keys));
    const longer = matching.some((binding) => binding.value.keys.length > sequence.length);
    if (matching.length === 0) {
      this.#pending = undefined;
      return undefined;
    }
    if (longer) {
      this.#pending = Object.freeze({ targetId: target.id, keys: Object.freeze(sequence) });
      return { kind: 'pending', targetId: target.id, keys: Object.freeze(sequence) };
    }
    if (exact === undefined) {
      this.#pending = undefined;
      return undefined;
    }
    this.#pending = undefined;
    const dispatched = await this.#registry.dispatch(exact.value.command, exact.value.arguments, { availability });
    if (dispatched.ok) {
      const commandId = commandIdFor(this.#registry, exact.value.command);
      return {
        kind: 'consumed',
        targetId: target.id,
        ...(commandId === undefined ? {} : { commandId }),
        ...(dispatched.value === undefined ? {} : { value: dispatched.value }),
      };
    }
    const commandId = commandIdFor(this.#registry, exact.value.command);
    return {
      kind: 'failed',
      targetId: target.id,
      ...(commandId === undefined ? {} : { commandId }),
      error: dispatched.error,
    };
  }

  #allBindings(): readonly StoredBinding[] {
    return this.#contributions.flatMap((contribution) => contribution.bindings)
      .slice()
      .sort((left, right) => left.order - right.order || compareText(left.sequenceKey, right.sequenceKey));
  }

  private removeContribution(id: number): void {
    this.#contributions = Object.freeze(this.#contributions.filter((contribution) => contribution.id !== id));
    this.#pending = undefined;
  }

  private recordDiagnostic(input: WorkbenchInputEnvelope): void {
    const rawBytes = input.rawBytes ?? (input.event.kind === 'key' ? input.event.rawBytes : undefined);
    if (rawBytes === undefined) return;
    const kind = input.event.kind === 'pointer' ? 'mouse' : input.event.kind;
    if (kind === 'focus') return;
    const active = this.#focus.activeState();
    const targetId = active.kind === 'active' ? active.target.id : undefined;
    const diagnostic: RawInputDiagnostic = Object.freeze({
      atSequence: this.#sequence,
      targetId,
      kind,
      rawHex: bytesToHex(rawBytes),
    });
    this.#sequence += 1;
    this.#diagnostics.push(diagnostic);
    if (this.#diagnostics.length > 256) this.#diagnostics.shift();
  }
}

class BindingHandle implements Disposable {
  #active = true;
  readonly #disposeBinding: () => void;
  constructor(disposeBinding: () => void) { this.#disposeBinding = disposeBinding; }
  dispose(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#disposeBinding();
  }
}

function validateBinding(binding: CommandKeyBinding, registry: CommandRegistry): Result<void, BindingFailure> {
  if (binding === null || typeof binding !== 'object' || !Array.isArray(binding.keys) || binding.keys.length === 0
    || binding.keys.length > 32 || !binding.keys.every((key) => typeof key === 'string' && key.length > 0 && key.length <= 256)
    || (binding.contexts !== undefined && (!Array.isArray(binding.contexts) || !binding.contexts.every(isIdentifier)))
    || (binding.description !== undefined && typeof binding.description !== 'string')) {
    return { ok: false, error: { kind: 'invalid-binding', message: 'key bindings require bounded nonempty canonical key sequences' } };
  }
  if (registry.inspect(binding.command) === undefined) return { ok: false, error: { kind: 'unknown-command', reference: binding.command } };
  return { ok: true, value: undefined };
}

function freezeBinding(binding: CommandKeyBinding): CommandKeyBinding {
  return Object.freeze({
    keys: Object.freeze([...binding.keys]),
    command: Object.freeze({ ...binding.command }),
    ...(binding.arguments === undefined ? {} : { arguments: cloneInput(binding.arguments) }),
    ...(binding.contexts === undefined ? {} : { contexts: Object.freeze([...binding.contexts]) }),
    ...(binding.description === undefined ? {} : { description: binding.description }),
  });
}

function cloneInput(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return Object.freeze(value.map(cloneInput));
  const record = value as Record<string, unknown>;
  return Object.freeze(Object.fromEntries(Object.entries(record).map(([key, item]) => [key, cloneInput(item)])));
}

function bindingMatchesContexts(binding: CommandKeyBinding, contexts: readonly string[]): boolean {
  return binding.contexts === undefined || binding.contexts.length === 0 || binding.contexts.some((context) => contexts.includes(context));
}

function bindingSequenceKey(targetId: string, keys: readonly string[], contexts: readonly string[]): string {
  return JSON.stringify([targetId, keys, [...contexts].sort(compareText)]);
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  return prefix.length <= full.length && prefix.every((value, index) => value === full[index]);
}

function formatKeySequence(keys: readonly string[]): string { return keys.join(' '); }

function keyChord(event: Extract<CanonicalInputEvent, { readonly kind: 'key' }>): string {
  const modifiers = [event.modifiers.ctrl ? 'Ctrl' : '', event.modifiers.alt ? 'Alt' : '', event.modifiers.meta ? 'Meta' : '', event.modifiers.shift ? 'Shift' : '']
    .filter((item) => item !== '');
  return [...modifiers, event.key].join('+');
}

function withTargetContexts(target: FocusTarget, availability: CommandAvailabilityContext): CommandAvailabilityContext {
  return Object.freeze({
    contexts: Object.freeze([...new Set([...target.contexts, ...availability.contexts])]),
    capabilities: Object.freeze([...availability.capabilities]),
  });
}

function isEscape(event: Extract<CanonicalInputEvent, { readonly kind: 'key' }>): boolean {
  return !event.modifiers.ctrl && !event.modifiers.alt && !event.modifiers.meta
    && (event.key === 'escape' || event.key === 'Esc' || event.key === '<Esc>');
}

function commandIdFor(registry: CommandRegistry, reference: CommandInvocationRef): string | undefined {
  return registry.inspect(reference)?.descriptor.id as string | undefined;
}

const hexDecoder = new TextDecoder();
function bytesToHex(bytes: Uint8Array): string {
  const digits = '0123456789abcdef';
  const output = new Uint8Array(bytes.length * 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    output[index * 2] = digits.charCodeAt(byte >>> 4);
    output[index * 2 + 1] = digits.charCodeAt(byte & 0x0f);
  }
  return hexDecoder.decode(output);
}

function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function isIdentifier(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.trim() === value && !value.includes('\0'); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
const emptyAvailability: CommandAvailabilityContext = Object.freeze({ contexts: Object.freeze([]), capabilities: Object.freeze([]) });
