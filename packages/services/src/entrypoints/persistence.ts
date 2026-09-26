/** Minimal persistence surface used before the optional editor services load. */
export { PersistenceService } from '../../persistence';
export type {
  FileIdentity,
  OpenedEditableFile,
  OpenedFile,
  OpenedReadOnlyFile,
  OpenFileOptions,
  PersistenceFailure,
  SaveFileOptions,
  SaveFileResult,
} from '../../persistence';

export { loadJumpHistory, saveJumpHistory } from '../../persistence/jumps';
