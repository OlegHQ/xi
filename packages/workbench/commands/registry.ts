import {
  CancellationSource,
  type CommandId,
  type Disposable,
  type Result,
  type ValidationIssue,
  type CommandAlias,
  type CommandAvailabilityContext,
  type CommandContributionSet,
  type CommandDescriptor,
  type CommandDescriptorCandidate,
  type CommandDispatchFailure,
  type CommandDispatchResult,
  type CommandInspection,
  type CommandInvocationContext,
  type CommandInvocationRef,
  type CommandRegistryFailure,
  type CommandRegistrySnapshot,
  type CommandRegistration,
  type CommandSchema,
  type NativeExReservation,
  type RegisteredCommandDescriptor,
} from '../../contracts/src/index';

interface CommandRecord {
  readonly descriptor: CommandDescriptor<unknown, unknown>;
  readonly registration: CommandRegistration;
  readonly contributionId: number;
  readonly activeInvocations: Set<CancellationSource>;
}

interface StoredContribution {
  readonly id: number;
  readonly value: CommandContributionSet;
  readonly records: readonly CommandRecord[];
}

interface RegistryState {
  readonly snapshot: CommandRegistrySnapshot;
  readonly commandsById: ReadonlyMap<string, CommandRecord>;
  readonly aliasesByName: ReadonlyMap<string, CommandAlias>;
  readonly aliasTargets: ReadonlyMap<string, CommandRecord>;
  readonly aliasKeysByCommand: ReadonlyMap<string, readonly string[]>;
}

export interface CommandRegistryOptions {
  /** The active profile's native Ex names are mandatory input to collision checks. */
  readonly nativeExNames: readonly string[];
}

export interface CommandRegistrationResult {
  readonly handles: readonly Disposable[];
  readonly snapshot: CommandRegistrySnapshot;
}

const selectionPolicies = new Set([
  'per-selection', 'selection-set', 'document-once', 'primary-navigation', 'primary-state', 'workspace-once',
]);
const effects = new Set(['read', 'selection', 'document', 'workspace', 'external']);
const undoPolicies = new Set(['none', 'native-group', 'single-transaction', 'service-proposal']);
const replayPolicies = new Set(['never', 'dot', 'macro', 'dot-and-macro']);
const cancellationPolicies = new Set(['cancellable', 'non-cancellable', 'cancel-on-unregister']);
const commandIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u;
const aliasPattern = /^[a-z][a-z0-9_-]*$/u;

/**
 * Builds each candidate generation before publishing it. A failed batch leaves
 * the exact last-good snapshot object and all of its handlers available.
 */
export class CommandRegistry implements Disposable {
  private readonly nativeReservations: ReadonlyMap<string, string>;
  private contributions: readonly StoredContribution[] = [];
  private nextContributionId = 1;
  private state: RegistryState;
  private disposed = false;

  constructor(options: CommandRegistryOptions) {
    if (!isNativeExNameList(options.nativeExNames)) {
      throw new TypeError('command registry requires a nonempty native Ex command inventory');
    }
    const reservations = new Map<string, string>([['xi', 'Xi']]);
    for (const reservation of buildNativeExReservations(options.nativeExNames)) {
      for (const abbreviation of reservation.reservedAs) {
        const key = normalizeAlias(abbreviation);
        if (key !== undefined) reservations.set(key, reservation.name);
      }
    }
    this.nativeReservations = reservations;
    const initial = this.compile([], 0);
    if (!initial.ok) throw new Error(`command-registry-initialization:${initial.error.kind}`);
    this.state = initial.value;
  }

  get snapshot(): CommandRegistrySnapshot {
    return this.state.snapshot;
  }

  register(contribution: CommandContributionSet): Result<Disposable, CommandRegistryFailure> {
    const result = this.registerBatch([contribution]);
    return result.ok
      ? { ok: true, value: result.value.handles[0] ?? noOpDisposable }
      : result;
  }

  /** All additions publish together, or none do. */
  registerBatch(contributions: readonly CommandContributionSet[]): Result<CommandRegistrationResult, CommandRegistryFailure> {
    if (this.disposed) return fail({ kind: 'registry-disposed', message: 'command registry is disposed' });
    if (contributions.length === 0) {
      return { ok: true, value: { handles: Object.freeze([]), snapshot: this.state.snapshot } };
    }

    const startId = this.nextContributionId;
    const additions: StoredContribution[] = [];
    for (let offset = 0; offset < contributions.length; offset += 1) {
      const input = contributions[offset];
      if (input === undefined || !Array.isArray(input.commands) || !Array.isArray(input.aliases ?? [])) {
        return fail({ kind: 'invalid-descriptor', message: 'contribution must contain command and alias arrays' });
      }
      if (input.commands.length === 0 && (input.aliases?.length ?? 0) === 0) {
        return fail({ kind: 'invalid-descriptor', message: 'empty command contribution is not registerable' });
      }
      for (const alias of input.aliases ?? []) {
        if (!isRecord(alias) || !isNonemptyText(alias.name) || !isRecord(alias.target)) {
          return fail({ kind: 'invalid-descriptor', message: 'alias contribution has an invalid name or target' });
        }
        if ((alias.target.kind === 'command' && typeof alias.target.id !== 'string')
          || (alias.target.kind === 'alias' && !isNonemptyText(alias.target.name))
          || (alias.target.kind !== 'command' && alias.target.kind !== 'alias')) {
          return fail({ kind: 'invalid-descriptor', message: `alias ${alias.name} has an invalid target` });
        }
      }
      const id = startId + offset;
      const records: CommandRecord[] = [];
      for (const registration of input.commands) {
        const normalized = normalizeRegistration(registration);
        if (!normalized.ok) return normalized;
        records.push({
          descriptor: normalized.value.descriptor,
          registration: normalized.value.registration,
          contributionId: id,
          activeInvocations: new Set(),
        });
      }
      additions.push({ id, value: freezeContribution(input), records: Object.freeze(records) });
    }

    const candidate = [...this.contributions, ...additions];
    const compiled = this.compile(candidate, this.state.snapshot.generation + 1);
    if (!compiled.ok) return compiled;

    this.contributions = candidate;
    this.state = compiled.value;
    this.nextContributionId += additions.length;
    const handles = additions.map((addition) => new ContributionHandle(this, addition.id));
    return {
      ok: true,
      value: { handles: Object.freeze(handles), snapshot: this.state.snapshot },
    };
  }

  inspect(
    reference: CommandInvocationRef,
    availability: CommandAvailabilityContext = emptyAvailability,
  ): CommandInspection | undefined {
    const resolved = this.resolve(this.state, reference);
    if (!resolved.ok) return undefined;
    const available = checkAvailability(resolved.value.record.descriptor, availability);
    return Object.freeze({
      generation: this.state.snapshot.generation,
      descriptor: resolved.value.record.descriptor,
      alias: resolved.value.alias,
      available: available.available,
      disabledReason: available.reason,
    });
  }

  /** Decode untrusted arguments, then execute the single registered handler. */
  async dispatch(
    reference: CommandInvocationRef,
    input: unknown,
    options: {
      readonly cancellation?: CommandInvocationContext['cancellation'];
      readonly availability?: CommandAvailabilityContext;
    } = {},
  ): Promise<CommandDispatchResult> {
    const generation = this.state;
    const resolved = this.resolve(generation, reference);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    const { record, alias } = resolved.value;
    void alias;
    const availability = checkAvailability(record.descriptor, options.availability ?? emptyAvailability);
    if (!availability.available) {
      return { ok: false, error: { kind: 'unavailable', reason: availability.reason ?? record.descriptor.availability.unavailableReason } };
    }

    const decoded = decodeSafely(record.descriptor.arguments, input);
    if (!decoded.ok) return { ok: false, error: { kind: 'invalid-arguments', issues: decoded.error } };

    const source = new CancellationSource();
    record.activeInvocations.add(source);
    const cancellationPolicy = record.descriptor.cancellationPolicy;
    const acceptsCallerCancellation = cancellationPolicy === 'cancellable';
    const externalSubscription = acceptsCallerCancellation
      ? options.cancellation?.onCancel(() => source.cancel())
      : undefined;
    if (acceptsCallerCancellation && options.cancellation?.isCancelled === true) source.cancel();

    try {
      if (source.token.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
      const context: CommandInvocationContext = Object.freeze({
        cancellation: source.token,
        registryGeneration: generation.snapshot.generation,
        availability: options.availability ?? emptyAvailability,
      });
      type HandlerOutcome = { readonly kind: 'output'; readonly value: unknown }
        | { readonly kind: 'failure'; readonly error: unknown }
        | { readonly kind: 'cancelled' };
      const cancellationOutcome = new Promise<HandlerOutcome>((resolve) => {
        source.token.onCancel(() => resolve({ kind: 'cancelled' }));
      });
      const handlerOutcome: Promise<HandlerOutcome> = Promise.resolve()
        .then(() => record.registration.handler(decoded.value, context))
        .then(
          (value) => ({ kind: 'output' as const, value }),
          (error: unknown) => ({ kind: 'failure' as const, error }),
        );
      const outcome = await Promise.race([handlerOutcome, cancellationOutcome]);
      if (outcome.kind === 'cancelled' || source.token.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
      if (outcome.kind === 'failure') return { ok: false, error: { kind: 'handler-failed', message: errorMessage(outcome.error) } };
      const validatedOutput = decodeSafely(record.descriptor.output, outcome.value);
      if (!validatedOutput.ok) return { ok: false, error: { kind: 'invalid-output', issues: validatedOutput.error } };
      return { ok: true, value: validatedOutput.value };
    } finally {
      externalSubscription?.dispose();
      record.activeInvocations.delete(source);
      source.dispose();
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const contribution of this.contributions) {
      for (const record of contribution.records) {
        for (const invocation of record.activeInvocations) invocation.cancel();
      }
    }
    this.contributions = [];
    const compiled = this.compile([], this.state.snapshot.generation + 1);
    if (compiled.ok) this.state = compiled.value;
  }

  /** @internal Used by registration handles to publish removal generations. */
  unregister(contributionId: number): void {
    if (this.disposed) return;
    const removed = this.contributions.find((contribution) => contribution.id === contributionId);
    if (removed === undefined) return;
    for (const record of removed.records) {
      for (const invocation of record.activeInvocations) invocation.cancel();
    }
    const candidate = this.contributions.filter((contribution) => contribution.id !== contributionId);
    const compiled = this.compile(candidate, this.state.snapshot.generation + 1);
    if (!compiled.ok) {
      // Removing a whole registration bundle can only remove graph nodes; it
      // cannot introduce a collision. Keep the existing state if that invariant
      // is ever violated rather than publishing a partially valid registry.
      throw new Error(`command-registry-invariant:${compiled.error.kind}`);
    }
    this.contributions = candidate;
    this.state = compiled.value;
  }

  private compile(
    contributions: readonly StoredContribution[],
    generationNumber: number,
  ): Result<RegistryState, CommandRegistryFailure> {
    const records: CommandRecord[] = [];
    const aliases: CommandAlias[] = [];
    for (const contribution of contributions) {
      records.push(...contribution.records);
      aliases.push(...(contribution.value.aliases ?? []));
    }

    const commandsById = new Map<string, CommandRecord>();
    for (const record of records) {
      const id = record.descriptor.id as string;
      if (commandsById.has(id)) {
        return fail({ kind: 'duplicate-command-id', message: `command ID is already registered: ${id}`, commandId: id });
      }
      commandsById.set(id, record);
    }

    const aliasesByName = new Map<string, CommandAlias>();
    const sourceNameByKey = new Map<string, string>();
    for (const rawAlias of aliases) {
      const key = normalizeAlias(rawAlias.name);
      if (key === undefined) {
        return fail({ kind: 'invalid-descriptor', message: `invalid command alias: ${String(rawAlias.name)}` });
      }
      const previous = aliasesByName.get(key);
      if (previous !== undefined) {
        return fail({ kind: 'duplicate-alias', message: `ambiguous alias ${rawAlias.name} conflicts with ${previous.name}`, alias: rawAlias.name });
      }
      const nativeCommand = this.nativeReservations.get(key);
      if (nativeCommand !== undefined) {
        return fail({ kind: 'native-ex-collision', message: `alias ${rawAlias.name} is reserved by native Ex command ${nativeCommand}`, alias: rawAlias.name, nativeCommand });
      }
      const alias = freezeAlias(rawAlias);
      aliasesByName.set(key, alias);
      sourceNameByKey.set(key, rawAlias.name);
    }

    const aliasTargets = new Map<string, CommandRecord>();
    const visiting: string[] = [];
    const resolveAlias = (key: string): Result<CommandRecord, CommandRegistryFailure> => {
      const cached = aliasTargets.get(key);
      if (cached !== undefined) return { ok: true, value: cached };
      const cycleIndex = visiting.indexOf(key);
      if (cycleIndex >= 0) {
        const cycleKeys = [...visiting.slice(cycleIndex), key];
        return fail({ kind: 'alias-cycle', message: `alias cycle: ${cycleKeys.map((item) => sourceNameByKey.get(item) ?? item).join(' -> ')}`, aliases: cycleKeys.map((item) => sourceNameByKey.get(item) ?? item) });
      }
      const alias = aliasesByName.get(key);
      if (alias === undefined) {
        return fail({ kind: 'missing-alias', message: `alias target does not exist: ${sourceNameByKey.get(key) ?? key}`, alias: sourceNameByKey.get(key) ?? key });
      }
      visiting.push(key);
      let target: Result<CommandRecord, CommandRegistryFailure>;
      if (alias.target.kind === 'command') {
        const record = commandsById.get(alias.target.id as string);
        target = record === undefined
          ? fail({ kind: 'missing-command', message: `alias ${alias.name} targets an unknown command`, commandId: alias.target.id as string })
          : { ok: true, value: record };
      } else if (alias.target.kind === 'alias') {
        const targetKey = normalizeAlias(alias.target.name);
        target = targetKey === undefined
          ? fail({ kind: 'invalid-descriptor', message: `alias ${alias.name} has an invalid alias target` })
          : resolveAlias(targetKey);
      } else {
        target = fail({ kind: 'invalid-descriptor', message: `alias ${alias.name} has an unknown target kind` });
      }
      visiting.pop();
      if (!target.ok) return target;
      aliasTargets.set(key, target.value);
      return target;
    };

    for (const key of aliasesByName.keys()) {
      const result = resolveAlias(key);
      if (!result.ok) return result;
    }
    const aliasKeysByCommand = new Map<string, string[]>();
    for (const [key, record] of aliasTargets) {
      const keyList = aliasKeysByCommand.get(record.descriptor.id as string) ?? [];
      keyList.push(key);
      aliasKeysByCommand.set(record.descriptor.id as string, keyList);
    }
    for (const names of aliasKeysByCommand.values()) names.sort(compareText);

    const commandRows: RegisteredCommandDescriptor[] = records
      .slice()
      .sort((left, right) => right.descriptor.priority - left.descriptor.priority || compareText(left.descriptor.id, right.descriptor.id))
      .map((record) => Object.freeze({
        descriptor: record.descriptor,
        aliases: Object.freeze((aliasKeysByCommand.get(record.descriptor.id as string) ?? []).map((key) => sourceNameByKey.get(key) ?? key)),
      }));
    const snapshot: CommandRegistrySnapshot = Object.freeze({
      generation: generationNumber,
      commands: Object.freeze(commandRows),
      aliases: Object.freeze([...aliasesByName.values()].sort((left, right) => compareText(normalizeAlias(left.name)!, normalizeAlias(right.name)!))),
    });
    return {
      ok: true,
      value: {
        snapshot,
        commandsById,
        aliasesByName,
        aliasTargets,
        aliasKeysByCommand: new Map([...aliasKeysByCommand].map(([id, keys]) => [id, Object.freeze(keys)])),
      },
    };
  }

  private resolve(
    state: RegistryState,
    reference: CommandInvocationRef,
  ): Result<{ readonly record: CommandRecord; readonly alias: CommandAlias | undefined }, CommandDispatchFailure> {
    if (reference.kind === 'command') {
      const record = state.commandsById.get(reference.id as string);
      return record === undefined
        ? { ok: false, error: { kind: 'unknown-command', commandId: reference.id as string } }
        : { ok: true, value: { record, alias: undefined } };
    }
    if (reference.kind !== 'alias') return { ok: false, error: { kind: 'unknown-alias', alias: String(reference) } };
    const key = normalizeAlias(reference.name);
    const alias = key === undefined ? undefined : state.aliasesByName.get(key);
    const record = key === undefined ? undefined : state.aliasTargets.get(key);
    return alias === undefined || record === undefined
      ? { ok: false, error: { kind: 'unknown-alias', alias: reference.name } }
      : { ok: true, value: { record, alias } };
  }
}

class ContributionHandle implements Disposable {
  private active = true;

  constructor(private readonly registry: CommandRegistry, private readonly contributionId: number) {}

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    this.registry.unregister(this.contributionId);
  }
}

const noOpDisposable: Disposable = Object.freeze({ dispose() {} });
const emptyAvailability: CommandAvailabilityContext = Object.freeze({ contexts: Object.freeze([]), capabilities: Object.freeze([]) });

function normalizeRegistration(
  registration: CommandRegistration,
): Result<{ readonly descriptor: CommandDescriptor<unknown, unknown>; readonly registration: CommandRegistration }, CommandRegistryFailure> {
  if (registration === null || typeof registration !== 'object' || registration.descriptor === null || typeof registration.descriptor !== 'object') {
    return fail({ kind: 'invalid-descriptor', message: 'command registration is missing its descriptor' });
  }
  const candidate = registration.descriptor as CommandDescriptorCandidate<unknown, unknown>;
  const idValue: unknown = candidate.id;
  if (typeof idValue !== 'string' || !commandIdPattern.test(idValue)) {
    return fail({ kind: 'invalid-descriptor', message: 'command IDs must use a stable xi.<namespace>.<name> form' });
  }
  if (candidate.selectionPolicy === undefined) {
    return fail({ kind: 'missing-selection-policy', message: `command ${idValue} must declare a selection policy`, commandId: idValue });
  }
  if (!selectionPolicies.has(candidate.selectionPolicy)) {
    return fail({ kind: 'invalid-descriptor', message: `command ${idValue} has an unknown selection policy`, commandId: idValue });
  }
  if (!Number.isSafeInteger(candidate.contractVersion) || candidate.contractVersion < 1) {
    return fail({ kind: 'invalid-descriptor', message: `command ${idValue} has an invalid contract version`, commandId: idValue });
  }
  if (candidate.priority !== undefined && !Number.isSafeInteger(candidate.priority)) {
    return fail({ kind: 'invalid-descriptor', message: `command ${idValue} has an invalid priority`, commandId: idValue });
  }
  for (const [label, value] of [['owner', candidate.owner], ['title', candidate.title], ['help', candidate.help], ['category', candidate.category]] as const) {
    if (!isNonemptyText(value)) return fail({ kind: 'invalid-descriptor', message: `command ${idValue} has an invalid ${label}`, commandId: idValue });
  }
  if (!effects.has(candidate.effect) || !undoPolicies.has(candidate.undoPolicy) || !replayPolicies.has(candidate.replayPolicy) || !cancellationPolicies.has(candidate.cancellationPolicy)) {
    return fail({ kind: 'invalid-descriptor', message: `command ${idValue} has an unknown effect or execution policy`, commandId: idValue });
  }
  if (!isSchema(candidate.arguments) || !isSchema(candidate.output)) {
    return fail({ kind: 'invalid-descriptor', message: `command ${idValue} must provide argument and output decoders`, commandId: idValue });
  }
  const availability = candidate.availability;
  if (!isRecord(availability) || !isStringArray(availability.contexts) || !isStringArray(availability.requiredCapabilities) || !isNonemptyText(availability.unavailableReason)) {
    return fail({ kind: 'invalid-descriptor', message: `command ${idValue} has an invalid availability policy`, commandId: idValue });
  }
  if (typeof registration.handler !== 'function') {
    return fail({ kind: 'invalid-descriptor', message: `command ${idValue} has no handler`, commandId: idValue });
  }
  const frozenAvailability = Object.freeze({
    contexts: Object.freeze([...availability.contexts]),
    requiredCapabilities: Object.freeze([...availability.requiredCapabilities]),
    unavailableReason: availability.unavailableReason,
  });
  const frozenArguments = captureSchema(candidate.arguments);
  const frozenOutput = captureSchema(candidate.output);
  const descriptor = Object.freeze({
    ...candidate,
    arguments: frozenArguments,
    output: frozenOutput,
    selectionPolicy: candidate.selectionPolicy,
    priority: candidate.priority ?? 0,
    availability: frozenAvailability,
  }) as CommandDescriptor<unknown, unknown>;
  return { ok: true, value: { descriptor, registration } };
}

function freezeContribution(value: CommandContributionSet): CommandContributionSet {
  return Object.freeze({
    commands: Object.freeze([...value.commands]),
    aliases: Object.freeze((value.aliases ?? []).map(freezeAlias)),
  });
}

function freezeAlias(alias: CommandAlias): CommandAlias {
  const target = alias.target.kind === 'command'
    ? Object.freeze({ kind: 'command' as const, id: alias.target.id })
    : alias.target.kind === 'alias'
      ? Object.freeze({ kind: 'alias' as const, name: alias.target.name })
      : alias.target;
  return Object.freeze({ name: alias.name, target });
}

function normalizeAlias(value: unknown): string | undefined {
  if (typeof value !== 'string' || !aliasPattern.test(value)) return undefined;
  return value.toLowerCase();
}

function checkAvailability(
  descriptor: CommandDescriptor<unknown, unknown>,
  context: CommandAvailabilityContext,
): { readonly available: boolean; readonly reason: string | undefined } {
  const policy = descriptor.availability;
  const contextsMatch = policy.contexts.length === 0 || policy.contexts.some((item) => context.contexts.includes(item));
  const capabilitiesMatch = policy.requiredCapabilities.every((item) => context.capabilities.includes(item));
  return contextsMatch && capabilitiesMatch
    ? { available: true, reason: undefined }
    : { available: false, reason: policy.unavailableReason };
}

function decodeSafely<Value>(schema: CommandDescriptor<unknown, unknown>['arguments'] | CommandDescriptor<unknown, unknown>['output'], input: unknown): Result<Value, readonly ValidationIssue[]> {
  try {
    const result: unknown = schema.decode(input);
    if (!isRecord(result) || typeof result.ok !== 'boolean') {
      return { ok: false, error: [schemaIssue('schema returned an invalid result')] };
    }
    if (result.ok) return { ok: true, value: result.value as Value };
    if (Array.isArray(result.error)) return { ok: false, error: result.error as ValidationIssue[] };
    return { ok: false, error: [schemaIssue('schema returned malformed validation issues')] };
  } catch (error: unknown) {
    return { ok: false, error: [schemaIssue(`schema threw: ${errorMessage(error)}`)] };
  }
}

export function buildNativeExReservations(names: readonly string[]): readonly NativeExReservation[] {
  const normalized = [...new Set(names.filter(isNonemptyText).map((name) => name.toLowerCase()))];
  const counts = new Map<string, number>();
  for (const name of normalized) {
    for (let length = 1; length <= name.length; length += 1) {
      const prefix = name.slice(0, length);
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }
  return Object.freeze(normalized
    .sort(compareText)
    .map((name) => Object.freeze({
      name,
      reservedAs: Object.freeze(Array.from({ length: name.length }, (_, index) => name.slice(0, index + 1))
        .filter((prefix) => prefix === name || counts.get(prefix) === 1)),
    })));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSchema(value: unknown): value is { decode(input: unknown): unknown } {
  return isRecord(value) && typeof value.decode === 'function';
}

function captureSchema<Value>(schema: CommandSchema<Value>): CommandSchema<Value> {
  const decode = schema.decode;
  return Object.freeze({ decode: (input: unknown) => decode.call(schema, input) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isNonemptyText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item: unknown) => isNonemptyText(item));
}

function isNativeExNameList(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item: unknown) => typeof item === 'string' && /^[A-Za-z][A-Za-z0-9]*$/u.test(item));
}

function schemaIssue(message: string): ValidationIssue {
  return { path: '$', code: 'invalid-value', message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail<Success = never>(error: CommandRegistryFailure): Result<Success, CommandRegistryFailure> {
  return { ok: false, error };
}
