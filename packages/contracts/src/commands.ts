import type {
  CancellationToken,
  CommandId,
  Result,
  ValidationIssue,
} from '../../primitives/src/index.ts';

export type SelectionPolicy =
  | 'per-selection'
  | 'selection-set'
  | 'document-once'
  | 'primary-navigation'
  | 'primary-state'
  | 'workspace-once';

export type CommandEffect = 'read' | 'selection' | 'document' | 'workspace' | 'external';
export type CommandUndoPolicy = 'none' | 'native-group' | 'single-transaction' | 'service-proposal';
export type CommandReplayPolicy = 'never' | 'dot' | 'macro' | 'dot-and-macro';
export type CommandCancellationPolicy = 'cancellable' | 'non-cancellable' | 'cancel-on-unregister';

/** Schemas consume unknown input, including values arriving from config or Ex. */
export interface CommandSchema<Value> {
  decode(input: unknown): Result<Value, readonly ValidationIssue[]>;
}

export interface CommandAvailabilityPolicy {
  /** Empty means available in every context. Context IDs are owned by workbench/UI. */
  readonly contexts: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly unavailableReason: string;
}

export interface CommandAvailabilityContext {
  readonly contexts: readonly string[];
  readonly capabilities: readonly string[];
}

/**
 * Inert, stable command metadata. Handlers live in a workbench registration and
 * are deliberately absent from the contract package.
 */
export interface CommandDescriptor<Arguments, Output> {
  readonly id: CommandId;
  readonly contractVersion: number;
  readonly priority: number;
  readonly owner: string;
  readonly title: string;
  readonly help: string;
  readonly category: string;
  readonly arguments: CommandSchema<Arguments>;
  readonly output: CommandSchema<Output>;
  readonly selectionPolicy: SelectionPolicy;
  readonly effect: CommandEffect;
  readonly undoPolicy: CommandUndoPolicy;
  readonly replayPolicy: CommandReplayPolicy;
  readonly cancellationPolicy: CommandCancellationPolicy;
  readonly availability: CommandAvailabilityPolicy;
}

/** Candidate shape keeps runtime validation meaningful at config/plugin edges. */
export type CommandDescriptorCandidate<Arguments, Output> =
  Omit<CommandDescriptor<Arguments, Output>, 'selectionPolicy' | 'priority'> & {
    readonly selectionPolicy?: SelectionPolicy;
    readonly priority?: number;
  };

export type CommandAliasTarget =
  | { readonly kind: 'command'; readonly id: CommandId }
  | { readonly kind: 'alias'; readonly name: string };

/** Aliases route to one stable command; they never contain executable text. */
export interface CommandAlias {
  readonly name: string;
  readonly target: CommandAliasTarget;
}

export type CommandInvocationRef =
  | { readonly kind: 'command'; readonly id: CommandId }
  | { readonly kind: 'alias'; readonly name: string };

export interface CommandInvocationContext {
  readonly cancellation: CancellationToken;
  readonly registryGeneration: number;
  readonly availability: CommandAvailabilityContext;
}

export interface CommandHandler<Arguments, Output> {
  (arguments_: Arguments, context: CommandInvocationContext): Output | Promise<Output>;
}

export interface TypedCommandRegistration<Arguments, Output> {
  readonly descriptor: CommandDescriptorCandidate<Arguments, Output>;
  readonly handler: CommandHandler<Arguments, Output>;
}

/** Runtime-erased registration after its argument decoder has been validated. */
export interface CommandRegistration {
  readonly descriptor: CommandDescriptorCandidate<unknown, unknown>;
  readonly handler: CommandHandler<unknown, unknown>;
}

/** Preserve typed authoring while keeping the registry's heterogeneous table safe. */
export const defineCommandRegistration = <Arguments, Output>(
  registration: TypedCommandRegistration<Arguments, Output>,
): CommandRegistration => ({
  descriptor: registration.descriptor,
  handler: (arguments_, context) => registration.handler(arguments_ as Arguments, context),
});

export interface CommandContributionSet {
  readonly commands: readonly CommandRegistration[];
  readonly aliases?: readonly CommandAlias[];
}

export interface RegisteredCommandDescriptor {
  readonly descriptor: CommandDescriptor<unknown, unknown>;
  readonly aliases: readonly string[];
}

export interface CommandRegistrySnapshot {
  readonly generation: number;
  readonly commands: readonly RegisteredCommandDescriptor[];
  readonly aliases: readonly CommandAlias[];
}

export interface CommandInspection {
  readonly generation: number;
  readonly descriptor: CommandDescriptor<unknown, unknown>;
  readonly alias: CommandAlias | undefined;
  readonly available: boolean;
  readonly disabledReason: string | undefined;
}

export type CommandRegistryFailure =
  | { readonly kind: 'invalid-descriptor'; readonly message: string; readonly commandId?: string }
  | { readonly kind: 'missing-selection-policy'; readonly message: string; readonly commandId: string }
  | { readonly kind: 'duplicate-command-id'; readonly message: string; readonly commandId: string }
  | { readonly kind: 'duplicate-alias'; readonly message: string; readonly alias: string }
  | { readonly kind: 'missing-command'; readonly message: string; readonly commandId: string }
  | { readonly kind: 'missing-alias'; readonly message: string; readonly alias: string }
  | { readonly kind: 'alias-cycle'; readonly message: string; readonly aliases: readonly string[] }
  | { readonly kind: 'native-ex-collision'; readonly message: string; readonly alias: string; readonly nativeCommand: string }
  | { readonly kind: 'registry-disposed'; readonly message: string };

export type CommandDispatchFailure =
  | { readonly kind: 'unknown-command'; readonly commandId: string }
  | { readonly kind: 'unknown-alias'; readonly alias: string }
  | { readonly kind: 'invalid-arguments'; readonly issues: readonly ValidationIssue[] }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'handler-failed'; readonly message: string }
  | { readonly kind: 'invalid-output'; readonly issues: readonly ValidationIssue[] };

export type CommandDispatchResult = Result<unknown, CommandDispatchFailure>;

/** One native Ex command name may reserve its unambiguous abbreviations. */
export interface NativeExReservation {
  readonly name: string;
  readonly reservedAs: readonly string[];
}
