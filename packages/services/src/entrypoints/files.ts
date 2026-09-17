/**
 * Directory-draft ("Space O" Explore-as-text) and journaled filesystem operations. Lightweight
 * (contracts/document only, no process/search/syntax deps), so unlike `launch.ts`'s services
 * this loads eagerly with the rest of the launch critical path instead of behind
 * `initializeOptionalServices`.
 */
export { DirectoryDraft } from '../../files/directory-draft';
export type {
  DirectoryDraftAnchor,
  DirectoryDraftEntryKind,
  DirectoryDraftMetadata,
  DirectoryDraftRow,
  DirectoryDraftRowOrigin,
  DirectoryDraftSourceEntry,
  DirectoryDraftValidationFailure,
  DirectoryOperation,
  DirectoryOperationPlan,
} from '../../files/directory-draft';
export { JournaledFilesystemOperations } from '../../files/journaled-operations';
export type {
  FileFingerprint,
  FileOperationFailure,
  FileOperationHooks,
  FileOperationJournal,
  FileOperationResult,
  FileOperationRecoveryResult,
  FileOperationStep,
  JournaledFileOperationOptions,
  JournaledFilesystemPort,
} from '../../files/journaled-operations';
