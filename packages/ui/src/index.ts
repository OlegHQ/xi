export type { TerminalAdapter, TerminalAdapterFactory, UiComposition, UiMountContext } from './contracts';

export {
  ASCII_WORKBENCH_THEME,
  BUILTIN_WORKBENCH_THEMES,
  DARK_WORKBENCH_THEME,
  LIGHT_WORKBENCH_THEME,
  themeColor,
  helixTextAttributes,
  WorkbenchRenderable,
  calculatePaintRanges,
  calculateWorkbenchLayout,
} from './workbench';
export type {
  WorkbenchFrameRead,
  WorkbenchLayout,
  WorkbenchRenderableOptions,
  WorkbenchTheme,
  ThemeColor,
  WorkbenchPointerEvent,
} from './workbench';
export type { WorkbenchPanel, WorkbenchPanelPointerEvent } from './panel-pointer';
export { ContextMenuStore, contextMenuBounds } from './context-menu';
export type { ContextMenuItem } from './context-menu';
export { paintEditorFrame } from '../editor/motion-paint';
export type {
  EditorPresentationRead,
  EditorPresentationReadPort,
  MotionPaintOptions,
  MotionPaintStats,
  MotionPreviewMemberRead,
  MotionPreviewRead,
  OperatorPreviewMemberRead,
  OperatorPreviewRead,
} from '../editor/motion-paint';
export { DEFAULT_MOTION_PAINT_TOKENS, resolveMotionPaintTokens, resolvePaintColor } from '../theme/motion-tokens';
export type { EditorColorMode, MotionPaintTokens, MotionTrailMode } from '../theme/motion-tokens';
export { OpenTuiTerminalAdapter, createOpenTuiUiComposition, runOpenTuiWorkbench } from './terminal';
export type { OpenTuiTerminalAdapterOptions, OpenTuiUiCompositionOptions, OpenTuiWorkbenchOptions } from './terminal';
export { clipSyntaxSpans, projectSyntaxRow } from '../editor/index';
export type {
  ClippedSyntaxSpan,
  EditorSyntaxSpan,
  EditorSyntaxTokenKind,
  SyntaxRowProjection,
} from '../editor/index';
export {
  DEFAULT_PREFIX_HELP_THEME,
  PrefixHelpController,
  formatPrefixHelpLines,
} from '../help/index';
export type {
  PrefixHelpClock,
  PrefixHelpControllerOptions,
  PrefixHelpGenerations,
  PrefixHelpHint,
  PrefixHelpPanelTheme,
  PrefixHelpReadPort,
  PrefixHelpSource,
} from '../help/index';
export {
  DEFAULT_EX_COMMAND_LINE_THEME,
  formatExCommandLineLines,
} from '../commandline/index';
export type {
  ExCommandLineReadPort,
  ExCommandLineTheme,
} from '../commandline/index';

export {
  DEFAULT_PICKER_THEME,
  PickerModelBridge,
  PickerFocusLifecycle,
  formatPickerLines,
} from '../picker/index';

export { formatSearchLines } from '../search/index';
export type { SearchReadPort } from '../search/index';
export { formatProblemsLines } from '../problems/index';
export type { Problem, ProblemRange, ProblemsReadModel, ProblemsReadPort } from '../problems/index';
export { projectSemanticRow } from '../editor/semantic-tokens';
export type { SemanticDecoration, SemanticReadModel } from '../editor/semantic-tokens';
export { formatCompletionLines, formatSignatureLines } from '../completion/index';
export type { CompletionItemRead, CompletionReadModel as CompletionUiReadModel, CompletionReadPort, SignatureReadModel, SignatureReadPort } from '../completion/index';
export { formatOutlineLines, formatHierarchyLines, formatHoverLines, measureHover } from '../navigation/index';
export type { OutlineRowRead, OutlineReadModel, OutlineReadPort, HierarchyNodeRead, HierarchyLinkRead, HierarchyReadModel, HierarchyReadPort, HoverReadModel, HoverReadPort } from '../navigation/index';
export { formatTaskOutputLines } from '../output/index';
export type { TaskOutputReadModel, TaskOutputReadPort } from '../output/index';
export type {
  PickerMode,
  PickerEntryKind,
  PickerEntry,
  PickerReadModel,
  PickerFailure,
  PickerQuerySource,
  PickerReadPort,
  PickerFocusLifecycleOptions,
  PickerFocusFailure,
  PickerTheme,
} from '../picker/index';

export { DEFAULT_EXPLORER_THEME, formatExplorerLines } from '../explorer/index';
export type {
  ExplorerGitDecoration,
  ExplorerGitState,
  ExplorerLoadState,
  ExplorerNode,
  ExplorerNodeKind,
  ExplorerReadModel,
  ExplorerReadPort,
  ExplorerTheme,
  ExplorerVisibleRow,
} from '../explorer/index';

export {
  DEFAULT_DIRECTORY_REVIEW_THEME,
  DirectoryReviewFocusLifecycle,
  formatDirectoryReviewLines,
} from '../directory/index';
export type {
  DirectoryDraftEntryKind,
  DirectoryDraftError,
  DirectoryDraftMetadata,
  DirectoryDraftReadModel,
  DirectoryDraftReadPort,
  DirectoryDraftRow,
  DirectoryDraftRowOrigin,
  DirectoryOperation,
  DirectoryOperationPlan,
  DirectoryReviewFocusFailure,
  DirectoryReviewFocusLifecycleOptions,
  DirectoryReviewTheme,
} from '../directory/index';
