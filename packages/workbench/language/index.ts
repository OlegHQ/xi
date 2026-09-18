export { languageIdForPath } from './file-language';

export { buildNavigationRequest, LanguageOverlayController } from './overlays';
export type {
  HoverOverlayModel,
  LanguageOverlayControllerOptions,
  LanguageOverlayKeyEvent,
  LanguageOverlayReadPort,
  LanguageServerSessionPort,
  LanguageWorkbenchSessionPort,
  NavigationControllerPort,
  OutlineOverlayModel,
  WorkbenchNavigationModel,
  WorkbenchNavigationRequest,
  WorkbenchNavigationSymbol,
} from './overlays';

export { CompletionSnippetController, nonOverlappingDocumentEdits, planCompletionEdits } from './completion';
export type {
  CompletionControllerPort,
  CompletionKeyEvent,
  CompletionModelRead,
  CompletionProviderPort,
  CompletionSnippetControllerOptions,
  ExpandSnippetFn,
  SignatureControllerPort,
  SignatureModelRead,
  SnippetSessionCtor,
  SnippetSessionPort,
  SnippetSupport,
  WorkbenchCompletionAction,
  WorkbenchCompletionFailure,
  WorkbenchCompletionItem,
  WorkbenchCompletionList,
  WorkbenchCompletionModel,
  WorkbenchCompletionPosition,
  WorkbenchCompletionRequest,
  WorkbenchCompletionTextEdit,
  WorkbenchSignatureFailure,
  WorkbenchSignatureInformation,
  WorkbenchSignatureList,
  WorkbenchSignatureModel,
  WorkbenchSignatureParameter,
  WorkbenchSnippetEdit,
  WorkbenchSnippetExpansion,
  WorkbenchSnippetFailure,
  WorkbenchSnippetTabstop,
  WorkbenchSnippetTransform,
} from './completion';

export { WorkspaceEditsController } from './workspace-edits';
export type {
  AppliedWorkspaceEditProposal,
  ExecuteLanguageCodeActionFn,
  LanguageCodeActionPort,
  RenameRetryOptionsPort,
  WorkspaceEditableDocumentPort,
  WorkspaceEditFailurePort,
  WorkspaceEditFilesystemPort,
  WorkspaceEditPosition,
  WorkspaceEditProposalPort,
  WorkspaceEditProviderFailurePort,
  WorkspaceEditProviderPort,
  WorkspaceEditRequestPort,
  WorkspaceEditsControllerOptions,
  WorkspaceEditTargetPort,
  WorkspaceResourceOperationPort,
  WorkspaceTextEditPort,
} from './workspace-edits';
