import type {
  CancellationToken,
  DisposableScope,
  Disposable,
  DocumentVersion,
  ProviderId,
  Result,
  SelectionGeneration,
  SerializedSelectionValue,
  UndoGroupId,
  Utf16Offset,
  ValidationIssue,
} from '../../primitives/src/index.ts';
import type { CommandContributionSet } from './commands.ts';

/** Lifetime at which a trusted built-in feature is installed. */
export type ContributionScope = 'workspace' | 'document' | 'view' | 'feature';

/** The one inert shape allowed for model data crossing a contribution boundary. */
export type ContributionValue = SerializedSelectionValue;

export interface ContributionOrigin {
  readonly moduleId: string;
  readonly contributionId: string;
  readonly providerId?: ProviderId;
  readonly capability?: string;
  readonly registryGeneration: number;
}

export interface ContributionReadPort<Snapshot extends ContributionValue = ContributionValue> {
  /** Returns an immutable snapshot. Implementations must not expose live owners. */
  read(): Snapshot;
}

export interface ContributionTextEdit {
  /** UTF-16 code-unit offsets in the version named by the proposal. */
  readonly start: Utf16Offset;
  readonly end: Utf16Offset;
  readonly text: string;
}

export interface ContributionEditProposal {
  readonly expectedVersion: DocumentVersion;
  readonly edits: readonly ContributionTextEdit[];
  readonly origin: string;
  readonly undoGroup: UndoGroupId;
}

export type ContributionEditFailure =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'stale-version'; readonly expected: DocumentVersion; readonly actual: DocumentVersion }
  | { readonly kind: 'reentrant-commit' }
  | { readonly kind: 'read-only'; readonly message: string }
  | { readonly kind: 'invalid-proposal'; readonly issues: readonly ValidationIssue[] }
  | { readonly kind: 'commit-failed'; readonly message: string };

export interface ContributionEditResult {
  readonly version: DocumentVersion;
  readonly origin: string;
}

/** A proposal port is intentionally narrower than the document owner. */
export interface ContributionEditPort {
  propose(
    proposal: ContributionEditProposal,
    cancellation: CancellationToken,
  ): Promise<Result<ContributionEditResult, ContributionEditFailure>>;
}

export interface ContributionInvocationContext<Snapshot extends ContributionValue = ContributionValue> {
  readonly read: ContributionReadPort<Snapshot>;
  readonly edit: ContributionEditPort | undefined;
  readonly selectionGeneration: SelectionGeneration;
  readonly cancellation: CancellationToken;
  readonly capability: string;
  readonly origin: ContributionOrigin;
}

export type ContributionProviderFailure =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

export interface ContributionProvider<
  Query extends ContributionValue = ContributionValue,
  Output extends ContributionValue = ContributionValue,
> {
  readonly id: ProviderId;
  readonly contractVersion: number;
  readonly owner: string;
  readonly capabilities: readonly string[];
  readonly priority: number;
  readonly scope: ContributionScope;
  provide(
    query: Query,
    context: ContributionInvocationContext,
  ): Result<Output, ContributionProviderFailure> | Promise<Result<Output, ContributionProviderFailure>>;
}

export interface ContributionModelContext<Snapshot extends ContributionValue = ContributionValue> {
  readonly read: ContributionReadPort<Snapshot>;
  readonly selectionGeneration: SelectionGeneration;
  readonly cancellation: CancellationToken;
}

/** Picker and panel models are inert read models; they never contain UI nodes. */
export interface ContributionReadModel<Snapshot extends ContributionValue = ContributionValue> {
  readonly id: string;
  readonly contractVersion: number;
  readonly owner: string;
  readonly kind: 'picker' | 'panel';
  readonly priority: number;
  readonly scope: ContributionScope;
  read(context: ContributionModelContext<Snapshot>): ContributionValue;
}

export type ContributionRegistrationFailure =
  | { readonly kind: 'invalid-module'; readonly message: string }
  | { readonly kind: 'duplicate-module'; readonly moduleId: string }
  | { readonly kind: 'missing-dependency'; readonly moduleId: string; readonly dependency: string }
  | { readonly kind: 'duplicate-provider'; readonly providerId: string }
  | { readonly kind: 'provider-capability-conflict'; readonly capability: string; readonly providers: readonly string[] }
  | { readonly kind: 'duplicate-model'; readonly modelId: string }
  | { readonly kind: 'invalid-contribution'; readonly message: string }
  | { readonly kind: 'command-registration-failed'; readonly message: string }
  | { readonly kind: 'activation-failed'; readonly message: string }
  | { readonly kind: 'registry-disposed' };

export interface ContributionModuleContext<Snapshot extends ContributionValue = ContributionValue> {
  readonly moduleId: string;
  /** Resource scope owned by this module. Registrations should be added here. */
  readonly scope: DisposableScope;
  readonly lifetime: ContributionScope;
  readonly cancellation: CancellationToken;
  readonly read: ContributionReadPort<Snapshot>;
  readonly edit: ContributionEditPort | undefined;
  readonly selectionGeneration: SelectionGeneration;
  registerCommands(contribution: CommandContributionSet): Result<Disposable, ContributionRegistrationFailure>;
  registerProvider(provider: ContributionProvider): Result<Disposable, ContributionRegistrationFailure>;
  registerModel(model: ContributionReadModel): Result<Disposable, ContributionRegistrationFailure>;
}

export interface FeatureContributionModule<Snapshot extends ContributionValue = ContributionValue> {
  readonly id: string;
  readonly contractVersion: number;
  readonly owner: string;
  readonly priority: number;
  readonly scope: ContributionScope;
  readonly dependsOn?: readonly string[];
  activate(context: ContributionModuleContext<Snapshot>): void | Promise<void>;
}

export interface ContributionProviderInspection {
  readonly id: ProviderId;
  readonly moduleId: string;
  readonly owner: string;
  readonly capabilities: readonly string[];
  readonly priority: number;
  readonly scope: ContributionScope;
  readonly active: boolean;
}

export interface ContributionRegistrySnapshot {
  readonly generation: number;
  readonly modules: readonly string[];
  readonly providers: readonly ContributionProviderInspection[];
  readonly models: readonly { readonly id: string; readonly moduleId: string; readonly kind: 'picker' | 'panel'; readonly priority: number }[];
}

export interface ContributionInvocationResult<Output extends ContributionValue = ContributionValue> {
  readonly value: Output;
  readonly origin: ContributionOrigin;
}

export type ContributionInvocationFailure =
  | { readonly kind: 'unknown-capability'; readonly capability: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'provider-unavailable'; readonly providerId: string; readonly message: string }
  | { readonly kind: 'provider-failed'; readonly providerId: string; readonly message: string };

export interface ContributionRegistryHost<Snapshot extends ContributionValue = ContributionValue> {
  readonly read: ContributionReadPort<Snapshot>;
  readonly edit?: ContributionEditPort;
  readonly selectionGeneration: SelectionGeneration;
}
