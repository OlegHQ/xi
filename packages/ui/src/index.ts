export type { TerminalAdapter, TerminalAdapterFactory, UiComposition, UiMountContext } from './contracts';

export {
  ASCII_WORKBENCH_THEME,
  BUILTIN_WORKBENCH_THEMES,
  DARK_WORKBENCH_THEME,
  LIGHT_WORKBENCH_THEME,
  WorkbenchRenderable,
  calculatePaintRanges,
  calculateWorkbenchLayout,
} from './workbench';
export type {
  WorkbenchFrameRead,
  WorkbenchLayout,
  WorkbenchRenderableOptions,
  WorkbenchTheme,
  WorkbenchPointerEvent,
} from './workbench';
export type { WorkbenchPanel, WorkbenchPanelPointerEvent } from './panel-pointer';
export { ContextMenuStore, ContextMenuRenderable, contextMenuBounds } from './context-menu';
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
export { CanonicalInputAdapter, Utf8InputGuard } from '../input/adapter';
export type { InputAdapterListener, InputAdapterOptions, InputAdapterRecord } from '../input/adapter';
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
  PrefixHelpRenderable,
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
  ExCommandLineRenderable,
  ExCommandLineSession,
  formatExCommandLineLines,
} from '../commandline/index';
export type {
  ExCommandLineInput,
  ExCommandLineOptions,
  ExCommandLineReadPort,
  ExCommandLineResult,
  ExCommandLineRenderableOptions,
  ExCommandLineTheme,
} from '../commandline/index';

export {
  DEFAULT_PICKER_THEME,
  PickerModelBridge,
  PickerFocusLifecycle,
  PickerRenderable,
  formatPickerLines,
} from '../picker/index';

export { SearchRenderable, formatSearchLines } from '../search/index';
export type { SearchReadPort, SearchRenderableOptions } from '../search/index';
export { ProblemsRenderable, formatProblemsLines } from '../problems/index';
export type { Problem, ProblemRange, ProblemsReadModel, ProblemsReadPort, ProblemsRenderableOptions } from '../problems/index';
export { projectSemanticRow } from '../editor/semantic-tokens';
export type { SemanticDecoration, SemanticReadModel } from '../editor/semantic-tokens';
export { CompletionRenderable, formatCompletionLines, SignatureRenderable, formatSignatureLines } from '../completion/index';
export type { CompletionItemRead, CompletionReadModel as CompletionUiReadModel, CompletionReadPort, CompletionRenderableOptions, SignatureReadModel, SignatureReadPort, SignatureRenderableOptions } from '../completion/index';
export { OutlineRenderable, formatOutlineLines, HierarchyRenderable, formatHierarchyLines, HoverRenderable, formatHoverLines } from '../navigation/index';
export type { OutlineSymbolRead, OutlineReadModel, OutlineReadPort, OutlineRenderableOptions, HierarchyNodeRead, HierarchyLinkRead, HierarchyReadModel, HierarchyReadPort, HierarchyRenderableOptions, HoverReadModel, HoverReadPort, HoverRenderableOptions } from '../navigation/index';
export { TaskOutputRenderable, formatTaskOutputLines } from '../output/index';
export type { TaskOutputReadModel, TaskOutputReadPort, TaskOutputRenderableOptions } from '../output/index';
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
  PickerRenderableOptions,
} from '../picker/index';

export { DEFAULT_EXPLORER_THEME, ExplorerRenderable, formatExplorerLines } from '../explorer/index';
export type {
  ExplorerGitDecoration,
  ExplorerGitState,
  ExplorerLoadState,
  ExplorerNode,
  ExplorerNodeKind,
  ExplorerReadModel,
  ExplorerReadPort,
  ExplorerRenderableOptions,
  ExplorerTheme,
  ExplorerVisibleRow,
} from '../explorer/index';

export {
  DEFAULT_DIRECTORY_REVIEW_THEME,
  DirectoryReviewFocusLifecycle,
  DirectoryReviewRenderable,
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
  DirectoryReviewRenderableOptions,
  DirectoryReviewTheme,
} from '../directory/index';
