import {
  CancellationSource,
  DisposableScope,
  type CancellationToken,
  type CommandContributionSet,
  type Disposable,
  type ProviderId,
  type Result,
  type SelectionGeneration,
} from '../../contracts/src/index';
import type {
  ContributionEditPort,
  ContributionInvocationFailure,
  ContributionInvocationResult,
  ContributionModelContext,
  ContributionModuleContext,
  ContributionOrigin,
  ContributionProvider,
  ContributionProviderFailure,
  ContributionProviderInspection,
  ContributionReadModel,
  ContributionReadPort,
  ContributionRegistryHost,
  ContributionRegistrySnapshot,
  ContributionRegistrationFailure,
  ContributionScope,
  ContributionValue,
  FeatureContributionModule,
} from '../../contracts/src/index';
import { CommandRegistry } from '../commands/index';

interface RegisteredProvider {
  readonly moduleId: string;
  readonly contributionId: string;
  readonly provider: ContributionProvider;
  readonly moduleCancellation: CancellationToken;
  readonly activeInvocations: Set<CancellationSource>;
}

interface RegisteredModel {
  readonly moduleId: string;
  readonly model: ContributionReadModel;
  readonly moduleCancellation: CancellationToken;
}

interface ActiveModule {
  readonly module: FeatureContributionModule;
  readonly scope: DisposableScope;
  readonly cancellation: CancellationSource;
  readonly commands: readonly DelegatingHandle[];
  readonly providers: Map<string, RegisteredProvider>;
  readonly models: Map<string, RegisteredModel>;
  readonly handle: ModuleHandle;
}

interface StagedProvider {
  readonly provider: ContributionProvider;
  readonly handle: DelegatingHandle;
}

interface StagedModel {
  readonly model: ContributionReadModel;
  readonly handle: DelegatingHandle;
}

export interface ContributionRegistryOptions<Snapshot extends ContributionValue = ContributionValue> {
  readonly commands: CommandRegistry;
  readonly host: ContributionRegistryHost<Snapshot>;
}

export interface ContributionActivation extends Disposable {
  readonly moduleId: string;
  readonly snapshot: ContributionRegistrySnapshot;
}

export interface ContributionModelReadResult {
  readonly value: ContributionValue;
  readonly origin: ContributionOrigin;
}

export type ContributionModelReadFailure =
  | { readonly kind: 'unknown-model'; readonly modelId: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'model-failed'; readonly modelId: string; readonly message: string };

/**
 * Trusted built-in contribution host. Each activation stages every registration
 * and publishes one immutable generation only after all module checks pass.
 */
export class ContributionRegistry<Snapshot extends ContributionValue = ContributionValue> implements Disposable {
  readonly #commands: CommandRegistry;
  readonly #host: ContributionRegistryHost<Snapshot>;
  readonly #scope = new DisposableScope();
  readonly #modules = new Map<string, ActiveModule>();
  readonly #providers = new Map<string, RegisteredProvider>();
  readonly #models = new Map<string, RegisteredModel>();
  #generation = 0;
  #disposed = false;
  #activationTail: Promise<void> = Promise.resolve();
  #snapshot: ContributionRegistrySnapshot;

  constructor(options: ContributionRegistryOptions<Snapshot>) {
    this.#commands = options.commands;
    this.#host = options.host;
    this.#snapshot = this.makeSnapshot();
  }

  get snapshot(): ContributionRegistrySnapshot { return this.#snapshot; }

  /** Activation is serialized so two async modules cannot stage against one generation. */
  activate(module: FeatureContributionModule<Snapshot>): Promise<Result<ContributionActivation, ContributionRegistrationFailure>> {
    const result = this.#activationTail.then(() => this.activateOne(module), () => this.activateOne(module));
    this.#activationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  inspectProviders(capability?: string): readonly ContributionProviderInspection[] {
    const rows = [...this.#providers.values()]
      .filter((record) => capability === undefined || record.provider.capabilities.includes(capability))
      .map((record) => Object.freeze({
        id: record.provider.id,
        moduleId: record.moduleId,
        owner: record.provider.owner,
        capabilities: Object.freeze([...record.provider.capabilities]),
        priority: record.provider.priority,
        scope: record.provider.scope,
        active: true,
      }));
    return Object.freeze(rows.sort(compareProviderInspection));
  }

  inspectModels(kind?: 'picker' | 'panel'): readonly ContributionRegistrySnapshot['models'][number][] {
    const rows = [...this.#models.values()]
      .filter((record) => kind === undefined || record.model.kind === kind)
      .map((record) => Object.freeze({
        id: record.model.id,
        moduleId: record.moduleId,
        kind: record.model.kind,
        priority: record.model.priority,
      }));
    return Object.freeze(rows.sort((left, right) => right.priority - left.priority || compareText(left.id, right.id)));
  }

  async invokeProvider<Output extends ContributionValue = ContributionValue>(
    capability: string,
    query: ContributionValue,
    options: { readonly cancellation?: CancellationToken } = {},
  ): Promise<Result<ContributionInvocationResult<Output>, ContributionInvocationFailure>> {
    const candidate = this.providersFor(capability)[0];
    if (candidate === undefined) return { ok: false, error: { kind: 'unknown-capability', capability } };

    const source = new CancellationSource();
    candidate.activeInvocations.add(source);
    const parentSubscription = candidate.moduleCancellation.onCancel(() => source.cancel());
    const externalSubscription = options.cancellation?.onCancel(() => source.cancel());
    if (options.cancellation?.isCancelled === true) source.cancel();
    const origin = this.origin(candidate, capability);
    const context = Object.freeze({
      read: this.#host.read,
      edit: this.#host.edit,
      selectionGeneration: this.#host.selectionGeneration,
      cancellation: source.token,
      capability,
      origin,
    });
    type ProviderOutcome =
      | { readonly kind: 'value'; readonly result: unknown }
      | { readonly kind: 'failed'; readonly error: unknown }
      | { readonly kind: 'cancelled' };
    const cancellation = new Promise<ProviderOutcome>((resolve) => {
      source.token.onCancel(() => resolve({ kind: 'cancelled' }));
    });
    try {
      if (source.token.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
      const pending = Promise.resolve()
        .then(() => candidate.provider.provide(query, context))
        .then(
          (result) => ({ kind: 'value' as const, result }),
          (error: unknown) => ({ kind: 'failed' as const, error }),
        );
      const outcome = await Promise.race([pending, cancellation]);
      if (outcome.kind === 'cancelled' || source.token.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
      if (outcome.kind === 'failed') return { ok: false, error: { kind: 'provider-failed', providerId: candidate.contributionId, message: errorMessage(outcome.error) } };
      const normalized = normalizeProviderResult(outcome.result);
      if (!normalized.ok) {
        if (normalized.error.kind === 'cancelled') return { ok: false, error: { kind: 'cancelled' } };
        return normalized.error.kind === 'unavailable'
          ? { ok: false, error: { kind: 'provider-unavailable', providerId: candidate.contributionId, message: normalized.error.message } }
          : { ok: false, error: { kind: 'provider-failed', providerId: candidate.contributionId, message: normalized.error.message } };
      }
      return { ok: true, value: { value: normalized.value as Output, origin } };
    } finally {
      parentSubscription.dispose();
      externalSubscription?.dispose();
      candidate.activeInvocations.delete(source);
      source.dispose();
    }
  }

  async readModel(
    modelId: string,
    options: { readonly cancellation?: CancellationToken } = {},
  ): Promise<Result<ContributionModelReadResult, ContributionModelReadFailure>> {
    const record = this.#models.get(modelId);
    if (record === undefined) return { ok: false, error: { kind: 'unknown-model', modelId } };
    const source = new CancellationSource();
    const parentSubscription = record.moduleCancellation.onCancel(() => source.cancel());
    const externalSubscription = options.cancellation?.onCancel(() => source.cancel());
    if (options.cancellation?.isCancelled === true) source.cancel();
    try {
      if (source.token.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
      const context: ContributionModelContext = Object.freeze({
        read: this.#host.read,
        selectionGeneration: this.#host.selectionGeneration,
        cancellation: source.token,
      });
      const output = record.model.read(context);
      if (source.token.isCancelled) return { ok: false, error: { kind: 'cancelled' } };
      return { ok: true, value: { value: normalizeValue(output), origin: this.modelOrigin(record) } };
    } catch (error: unknown) {
      return { ok: false, error: { kind: 'model-failed', modelId, message: errorMessage(error) } };
    } finally {
      parentSubscription.dispose();
      externalSubscription?.dispose();
      source.dispose();
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const modules = [...this.#modules.values()];
    for (const active of modules) await this.deactivate(active.module.id);
    this.#modules.clear();
    this.#providers.clear();
    this.#models.clear();
    await this.#scope.dispose();
    this.publishSnapshot();
  }

  private async activateOne(module: FeatureContributionModule<Snapshot>): Promise<Result<ContributionActivation, ContributionRegistrationFailure>> {
    const moduleFailure = validateModule(module);
    if (!moduleFailure.ok) return moduleFailure;
    if (this.#disposed) return { ok: false, error: { kind: 'registry-disposed' } };
    if (this.#modules.has(module.id)) return { ok: false, error: { kind: 'duplicate-module', moduleId: module.id } };
    for (const dependency of module.dependsOn ?? []) {
      if (!this.#modules.has(dependency)) return { ok: false, error: { kind: 'missing-dependency', moduleId: module.id, dependency } };
    }

    const scope = this.#scope.child();
    const cancellation = scope.add(new CancellationSource());
    const commandContributions: { readonly value: CommandContributionSet; readonly handle: DelegatingHandle }[] = [];
    const stagedProviders: StagedProvider[] = [];
    const stagedModels: StagedModel[] = [];
    let stagedFailure: ContributionRegistrationFailure | undefined;
    const context: ContributionModuleContext<Snapshot> = Object.freeze({
      moduleId: module.id,
      scope,
      lifetime: module.scope,
      cancellation: cancellation.token,
      read: this.#host.read,
      edit: this.#host.edit,
      selectionGeneration: this.#host.selectionGeneration,
      registerCommands: (contribution: CommandContributionSet): Result<Disposable, ContributionRegistrationFailure> => {
        if (stagedFailure !== undefined) return { ok: false, error: stagedFailure };
        if (!Array.isArray(contribution.commands) || !Array.isArray(contribution.aliases ?? [])
          || (contribution.commands.length === 0 && (contribution.aliases?.length ?? 0) === 0)) {
          stagedFailure = { kind: 'invalid-contribution', message: `module ${module.id} supplied an empty or malformed command contribution` };
          return { ok: false, error: stagedFailure };
        }
        const handle = new DelegatingHandle();
        const entry = { value: contribution, handle };
        commandContributions.push(entry);
        handle.setBeforeCommit(() => {
          const index = commandContributions.indexOf(entry);
          if (index >= 0) commandContributions.splice(index, 1);
        });
        scope.add(handle);
        return { ok: true, value: handle };
      },
      registerProvider: (provider: ContributionProvider): Result<Disposable, ContributionRegistrationFailure> => {
        if (stagedFailure !== undefined) return { ok: false, error: stagedFailure };
        const failure = validateProvider(provider, module.id, this.#providers, stagedProviders);
        if (failure !== undefined) {
          stagedFailure = failure;
          return { ok: false, error: failure };
        }
        const handle = new DelegatingHandle();
        const entry = { provider, handle };
        stagedProviders.push(entry);
        handle.setBeforeCommit(() => {
          const index = stagedProviders.indexOf(entry);
          if (index >= 0) stagedProviders.splice(index, 1);
        });
        scope.add(handle);
        return { ok: true, value: handle };
      },
      registerModel: (model: ContributionReadModel): Result<Disposable, ContributionRegistrationFailure> => {
        if (stagedFailure !== undefined) return { ok: false, error: stagedFailure };
        const failure = validateModel(model, this.#models, stagedModels);
        if (failure !== undefined) {
          stagedFailure = failure;
          return { ok: false, error: failure };
        }
        const handle = new DelegatingHandle();
        const entry = { model, handle };
        stagedModels.push(entry);
        handle.setBeforeCommit(() => {
          const index = stagedModels.indexOf(entry);
          if (index >= 0) stagedModels.splice(index, 1);
        });
        scope.add(handle);
        return { ok: true, value: handle };
      },
    });

    try {
      await module.activate(context);
    } catch (error: unknown) {
      await scope.dispose();
      return { ok: false, error: { kind: 'activation-failed', message: errorMessage(error) } };
    }
    if (stagedFailure !== undefined) {
      await scope.dispose();
      return { ok: false, error: stagedFailure };
    }

    const registeredCommands = commandContributions.length === 0
      ? { ok: true as const, value: { handles: Object.freeze([]) } }
      : this.#commands.registerBatch(commandContributions.map((entry) => entry.value));
    if (!registeredCommands.ok) {
      await scope.dispose();
      return { ok: false, error: { kind: 'command-registration-failed', message: registeredCommands.error.message } };
    }

    const providers = new Map<string, RegisteredProvider>();
    for (const staged of stagedProviders) {
      const record: RegisteredProvider = {
        moduleId: module.id,
        contributionId: String(staged.provider.id),
        provider: staged.provider,
        moduleCancellation: cancellation.token,
        activeInvocations: new Set(),
      };
      providers.set(record.contributionId, record);
      this.#providers.set(record.contributionId, record);
    }
    const models = new Map<string, RegisteredModel>();
    for (const staged of stagedModels) {
      const record: RegisteredModel = { moduleId: module.id, model: staged.model, moduleCancellation: cancellation.token };
      models.set(staged.model.id, record);
      this.#models.set(staged.model.id, record);
    }
    const commands = commandContributions.map((entry, index) => {
      const handle = registeredCommands.value.handles[index];
      if (handle === undefined) throw new Error('command-registration-handle-missing');
      entry.handle.setTarget(handle);
      return entry.handle;
    });
    const handle = new ModuleHandle(this, module.id);
    const active: ActiveModule = { module, scope, cancellation, commands, providers, models, handle };
    this.#modules.set(module.id, active);
    for (const staged of stagedProviders) {
      staged.handle.setBeforeCommit(() => this.removeProvider(module.id, String(staged.provider.id)));
    }
    for (const staged of stagedModels) {
      staged.handle.setBeforeCommit(() => this.removeModel(module.id, staged.model.id));
    }
    this.publishSnapshot();
    return { ok: true, value: handle.withSnapshot(this.#snapshot) };
  }

  async deactivate(moduleId: string): Promise<void> {
    const active = this.#modules.get(moduleId);
    if (active === undefined) return;
    active.cancellation.cancel();
    for (const provider of active.providers.values()) {
      for (const invocation of provider.activeInvocations) invocation.cancel();
      this.#providers.delete(provider.contributionId);
    }
    for (const modelId of active.models.keys()) this.#models.delete(modelId);
    this.#modules.delete(moduleId);
    for (const command of active.commands) command.dispose();
    await active.scope.dispose();
    this.publishSnapshot();
  }

  private removeProvider(moduleId: string, providerId: string): void {
    const active = this.#modules.get(moduleId);
    const provider = active?.providers.get(providerId);
    if (active === undefined || provider === undefined) return;
    for (const invocation of provider.activeInvocations) invocation.cancel();
    active.providers.delete(providerId);
    this.#providers.delete(providerId);
    this.publishSnapshot();
  }

  private removeModel(moduleId: string, modelId: string): void {
    const active = this.#modules.get(moduleId);
    if (active === undefined || !active.models.has(modelId)) return;
    active.models.delete(modelId);
    this.#models.delete(modelId);
    this.publishSnapshot();
  }

  private providersFor(capability: string): RegisteredProvider[] {
    return [...this.#providers.values()]
      .filter((record) => record.provider.capabilities.includes(capability))
      .sort((left, right) => right.provider.priority - left.provider.priority || compareText(left.contributionId, right.contributionId));
  }

  private origin(provider: RegisteredProvider, capability: string): ContributionOrigin {
    return Object.freeze({
      moduleId: provider.moduleId,
      contributionId: provider.contributionId,
      providerId: provider.provider.id,
      capability,
      registryGeneration: this.#generation,
    });
  }

  private modelOrigin(model: RegisteredModel): ContributionOrigin {
    return Object.freeze({ moduleId: model.moduleId, contributionId: model.model.id, registryGeneration: this.#generation });
  }

  private publishSnapshot(): void {
    this.#generation += 1;
    this.#snapshot = this.makeSnapshot();
  }

  private makeSnapshot(): ContributionRegistrySnapshot {
    const providers = this.inspectProviders();
    const models = this.inspectModels();
    return Object.freeze({
      generation: this.#generation,
      modules: Object.freeze([...this.#modules.keys()].sort(compareText)),
      providers,
      models: Object.freeze([...models]),
    });
  }

  /** Internal callback target for handles created during activation. */
  _removeProvider(moduleId: string, providerId: string): void { this.removeProvider(moduleId, providerId); }
  _removeModel(moduleId: string, modelId: string): void { this.removeModel(moduleId, modelId); }
  async _deactivate(moduleId: string): Promise<void> { await this.deactivate(moduleId); }
}

class ModuleHandle implements ContributionActivation {
  #active = true;
  #snapshot: ContributionRegistrySnapshot | undefined;

  constructor(private readonly registry: ContributionRegistry, readonly moduleId: string) {}

  withSnapshot(snapshot: ContributionRegistrySnapshot): ModuleHandle {
    this.#snapshot = snapshot;
    return this;
  }

  get snapshot(): ContributionRegistrySnapshot {
    if (this.#snapshot === undefined) throw new Error('activation-snapshot-unavailable');
    return this.#snapshot;
  }

  async dispose(): Promise<void> {
    if (!this.#active) return;
    this.#active = false;
    await this.registry._deactivate(this.moduleId);
  }
}

class DelegatingHandle implements Disposable {
  #active = true;
  #target: Disposable | undefined;
  #beforeCommit: (() => void) | undefined;

  setTarget(target: Disposable): void {
    this.#target = target;
    if (!this.#active) target.dispose();
  }

  setBeforeCommit(callback: () => void): void { this.#beforeCommit = callback; }

  dispose(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#beforeCommit?.();
    this.#target?.dispose();
  }
}

function validateModule(module: FeatureContributionModule): Result<void, ContributionRegistrationFailure> {
  if (module === null || typeof module !== 'object') return { ok: false, error: { kind: 'invalid-module', message: 'module must be an object' } };
  if (!isIdentifier(module.id) || !isIdentifier(module.owner) || !isScope(module.scope)
    || !Number.isSafeInteger(module.contractVersion) || module.contractVersion < 1
    || !Number.isSafeInteger(module.priority) || typeof module.activate !== 'function') {
    return { ok: false, error: { kind: 'invalid-module', message: 'module identity, version, priority, scope or activation is invalid' } };
  }
  if (module.dependsOn !== undefined && (!Array.isArray(module.dependsOn) || !module.dependsOn.every(isIdentifier))) {
    return { ok: false, error: { kind: 'invalid-module', message: 'module dependencies must be identifiers' } };
  }
  return { ok: true, value: undefined };
}

function validateProvider(
  provider: ContributionProvider,
  moduleId: string,
  current: ReadonlyMap<string, RegisteredProvider>,
  staged: readonly StagedProvider[],
): ContributionRegistrationFailure | undefined {
  if (provider === null || typeof provider !== 'object' || !isIdentifier(String(provider.id)) || !isIdentifier(provider.owner)
    || !isScope(provider.scope) || !Number.isSafeInteger(provider.contractVersion) || provider.contractVersion < 1
    || !Number.isSafeInteger(provider.priority) || typeof provider.provide !== 'function'
    || !Array.isArray(provider.capabilities) || provider.capabilities.length === 0
    || !provider.capabilities.every(isIdentifier) || new Set(provider.capabilities).size !== provider.capabilities.length) {
    return { kind: 'invalid-contribution', message: `module ${moduleId} supplied an invalid provider` };
  }
  const providerId = String(provider.id);
  if (current.has(providerId) || staged.some((item) => String(item.provider.id) === providerId)) {
    return { kind: 'duplicate-provider', providerId };
  }
  for (const capability of provider.capabilities) {
    const conflicts = [...current.values(), ...staged.map((item) => ({ provider: item.provider, moduleId }))]
      .filter((item) => item.provider.capabilities.includes(capability) && item.provider.priority === provider.priority)
      .map((item) => String(item.provider.id));
    if (conflicts.length > 0) return { kind: 'provider-capability-conflict', capability, providers: Object.freeze([...conflicts, providerId].sort(compareText)) };
  }
  return undefined;
}

function validateModel(
  model: ContributionReadModel,
  current: ReadonlyMap<string, RegisteredModel>,
  staged: readonly StagedModel[],
): ContributionRegistrationFailure | undefined {
  if (model === null || typeof model !== 'object' || !isIdentifier(model.id) || !isIdentifier(model.owner)
    || !isScope(model.scope) || !Number.isSafeInteger(model.contractVersion) || model.contractVersion < 1
    || !Number.isSafeInteger(model.priority) || (model.kind !== 'picker' && model.kind !== 'panel') || typeof model.read !== 'function') {
    return { kind: 'invalid-contribution', message: 'model identity, version, priority, kind or reader is invalid' };
  }
  if (current.has(model.id) || staged.some((item) => item.model.id === model.id)) return { kind: 'duplicate-model', modelId: model.id };
  return undefined;
}

function normalizeProviderResult(value: unknown): Result<ContributionValue, { readonly kind: 'cancelled' } | { readonly kind: 'unavailable' | 'failed'; readonly message: string }> {
  if (value === null || typeof value !== 'object' || !('ok' in value) || typeof value.ok !== 'boolean') {
    return { ok: false, error: { kind: 'failed', message: 'provider returned an invalid result' } };
  }
  const result = value as { readonly ok: boolean; readonly error?: unknown; readonly value?: unknown };
  if (result.ok === false) {
    const failure = result.error;
    if (!isProviderFailure(failure)) return { ok: false, error: { kind: 'failed', message: 'provider returned an invalid failure' } };
    if (failure.kind === 'cancelled') return { ok: false, error: { kind: 'cancelled' } };
    return { ok: false, error: { kind: failure.kind, message: failure.message } };
  }
  return { ok: true, value: normalizeValue(result.value) };
}

function normalizeValue(value: unknown): ContributionValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return Object.freeze(value.map(normalizeValue));
  if (typeof value === 'object') {
    const output: Record<string, ContributionValue> = Object.create(null) as Record<string, ContributionValue>;
    for (const [key, child] of Object.entries(value)) output[key] = normalizeValue(child);
    return Object.freeze(output);
  }
  return null;
}

function isProviderFailure(value: unknown): value is ContributionProviderFailure {
  return value !== null && typeof value === 'object' && 'kind' in value
    && (value.kind === 'cancelled' || value.kind === 'unavailable' || value.kind === 'failed')
    && ('message' in value ? typeof value.message === 'string' : value.kind === 'cancelled');
}

function isScope(value: unknown): value is ContributionScope {
  return value === 'workspace' || value === 'document' || value === 'view' || value === 'feature';
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && !value.includes('\0');
}

function compareProviderInspection(left: ContributionProviderInspection, right: ContributionProviderInspection): number {
  return right.priority - left.priority || compareText(String(left.id), String(right.id));
}

function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
