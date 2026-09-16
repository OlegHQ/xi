export { buildNativeExReservations, CommandRegistry } from './registry';
export type { CommandRegistryOptions, CommandRegistrationResult } from './registry';
export {
  acceptExCompletion,
  buildExCommandLineReadModel,
  DEFAULT_NATIVE_EX_COMMANDS,
  registerNativeSafeAliases,
  resolveExExecution,
  validateNativeSafeAliases,
} from './ex-discovery';
export type {
  ExAliasSpec,
  ExAliasValidationFailure,
  ExCommandCandidate,
  ExCommandCandidateKind,
  ExCommandLineContext,
  ExCommandLineReadModel,
  ExCommandPosition,
  ExExecution,
  ExExecutionFailure,
  ExExecutionResult,
  NativeExCommandSpec,
} from './ex-discovery';
