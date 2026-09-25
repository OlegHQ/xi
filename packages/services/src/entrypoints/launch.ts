/** Small public service surface used by the standalone launcher. */
export { PersistenceService, type RecoveryCheckpoint } from '../../persistence';
export {
  BoundedPickerModel,
  BufferPickerProvider,
  FilePathIndex,
  FilePickerProvider,
  StaticPickerProvider,
  createNavigationContributionModule,
} from '../../navigation';
export type { BufferPickerEntry } from '../../navigation';
export { lookupCtags, parseCtags, createCtagsNavigationHost } from '../../navigation/ctags';
export type { CtagsRecord, CtagsFilesystemPort, CtagsNavigationHostOptions } from '../../navigation/ctags';
export { InMemorySearchBackend, RealtimeSearchService, RipgrepSearchBackend } from '../../search';
export type {
  RipgrepSearchBackendOptions,
  SearchBackend,
  SearchBufferSource,
  SearchFailure,
  SearchMatch,
  SearchQuery,
  SearchRange,
  SearchReadModel,
} from '../../search';
export type {
  FileIndexFailure,
  FileIndexSnapshot,
  FilePickerQueryOptions,
  FilePickerQueryResult,
  IndexedPath,
  NavigationContributionOptions,
  PickerEntry,
  PickerEntryKind,
  PickerFailure,
  PickerMode,
  PickerProvider,
  PickerQueryOptions,
  PickerQueryRequest,
  PickerReadModel,
  StaticPickerEntry,
  WorkspaceRoot,
} from '../../navigation';
export {
  EXPLORER_CONTRACT_VERSION,
  ExplorerNavigationController,
  ExplorerTree,
} from '../../files';
export type {
  ExplorerDirectoryEntry,
  ExplorerFailure,
  ExplorerFilesystemPort,
  ExplorerGitDecoration,
  ExplorerGitDecorationPort,
  ExplorerGitState,
  ExplorerLoadState,
  ExplorerMetadata,
  ExplorerMetadataPort,
  ExplorerNavigationControllerOptions,
  ExplorerNode,
  ExplorerNodeKind,
  ExplorerOptions,
  ExplorerReadModel,
  ExplorerReadPort,
  ExplorerRoot,
  ExplorerVisibleRow,
  ExplorerWatchEvent,
} from '../../files';
export type {
  FileIdentity,
  OpenedFile,
  OpenedEditableFile,
  OpenedReadOnlyFile,
  OpenFileOptions,
  PersistenceFailure,
  SaveFileOptions,
  SaveFileResult,
} from '../../persistence';
export type { ReplaceTarget, ReplacementEdit, ReplacePlan, ReplaceApplyPort, ReplaceFailure, ReplaceJournal, ReplaceJournalEntry, ReplaceApplyResult } from '../../search/replace';
export { WorkspaceReplaceService, applyReplacementEdits } from '../../search/replace';
export { HostNavigationController } from '../../navigation/host';
export type { HostLocation, HostNavigationFailure, HostNavigationProvider, HostNavigationResult } from '../../navigation/host';
export { DiagnosticStore } from '../../language/diagnostics';
export { executeLanguageCodeAction } from '../../language/workspace-edits';
export {
  WorkspaceEditResourceExecutor,
  applyWorkspaceEditProposal,
  applyWorkspaceResources,
  fileUri,
  planWorkspaceResources,
  renameWithBoundedRetry,
  serverSupportsFileOperation,
  validateWorkspaceTextEditRanges,
  workspacePathFromUri,
  workspaceRelativePathFromUri,
} from '../../language/workspace-edit-resources';
export type {
  ApplyWorkspaceEditProposalOptions,
  RenameRetryOptions,
  WorkspaceEditableDocument,
  WorkspaceEditProposalProvider,
  WorkspaceEditResourceExecutorOptions,
  WorkspaceResourceApplyOptions,
  WorkspaceResourceFilesystemPort,
  WorkspaceResourcePlanItem,
  WorkspaceResourcePlanOptions,
  WorkspacePathState,
} from '../../language/workspace-edit-resources';
export { HierarchyController, LanguageServerHierarchyProvider } from '../../language/hierarchy';
export type { HierarchyKind, HierarchyRelation, HierarchyItem, DocumentLink, HierarchyProvider, HierarchyFailure, HierarchyReadState, HierarchyReadModel } from '../../language/hierarchy';
export { expandSnippet, SnippetSession } from '../../language/snippets';
export type { SnippetEdit, SnippetTabstop, SnippetTransform, SnippetExpansion, SnippetFailure } from '../../language/snippets';
export { FormatterPipeline, createExternalFormatter, createLspFormatter } from '../../formatting';
export type {
  ExternalFormatterOptions,
  FormatDocument,
  FormatRange,
  FormatterEdit,
  FormatterSpec,
  FormatterFailure,
  FormatResult,
  LspFormatterProvider,
} from '../../formatting';
