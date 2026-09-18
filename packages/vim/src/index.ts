import type { DocumentId, DocumentSnapshot, DocumentVersion } from '../../document/src/index.ts';
import type { ViewId } from '../../contracts/src/index.ts';
import type { SelectionSetSnapshot } from '../../selections/src/index.ts';

export interface VimSessionSnapshot {
  readonly viewId: ViewId;
  readonly documentId: DocumentId;
  readonly documentVersion: DocumentVersion;
  readonly selections: SelectionSetSnapshot;
  readonly mode: 'normal' | 'insert' | 'replace' | 'visual';
}

/** Read-only public session view; parser and edit semantics remain Vim-owned. */
export interface VimSessionReader {
  snapshot(viewId: ViewId): VimSessionSnapshot | undefined;
}

/**
 * Effects that require an editor host rather than Vim text semantics.
 * Paths and tag names are extracted from the immutable document snapshot;
 * the host resolves them through its typed filesystem/navigation ports.
 */
export type VimHostCommand =
  | {
      readonly kind: 'open-file';
      readonly target: string;
      readonly line?: number;
      readonly split: boolean;
    }
  | {
      readonly kind: 'open-tag';
      readonly name: string;
      readonly split: boolean;
      readonly selection?: 'unique' | 'select';
    }
  | { readonly kind: 'tag-back' }
  | {
      readonly kind: 'include';
      readonly target: string;
      readonly direction: 'previous' | 'next';
      readonly list: boolean;
    }
  | { readonly kind: 'lookup'; readonly target: string; readonly lookup: 'definition' | 'keyword' | 'command-output' }
  | VimHostWindowCommand;
export type VimHostWindowCommand = {
      readonly kind: 'window';
      readonly action:
        | 'focus-left' | 'focus-right' | 'focus-up' | 'focus-down'
        | 'focus-next' | 'focus-previous' | 'focus-first' | 'focus-last'
        | 'close' | 'only' | 'split-horizontal' | 'split-vertical'
        | 'equalize' | 'resize-increase' | 'resize-decrease'
        | 'resize-left' | 'resize-right' | 'resize-top' | 'resize-bottom'
        | 'exchange-next' | 'exchange-previous' | 'rotate' | 'rotate-reverse'
        | 'move-top' | 'move-bottom' | 'move-left' | 'move-right' | 'move-tab'
        | 'new-window';
      readonly count: number;
    };

export interface EngineDocumentView {
  readonly document: DocumentSnapshot;
  readonly session: VimSessionSnapshot;
}

export { normalizeVimInput } from '../input/index';
export type { InputNormalizationFailure, NormalizedVimInput, VimInputClock } from '../input/index';
export {
  createVimParserState,
  parseVimInput,
  updateVimParserSession,
} from '../parser/index';
export type {
  VimCommandContext,
  VimCommandIntent,
  VimContinuation,
  VimCount,
  VimGrammarPrefix,
  VimLiteralCommand,
  VimMode,
  VimOperator,
  VimOperatorPrefix,
  VimParseFailure,
  VimParseOutcome,
  VimParserSession,
  VimParserState,
  VimParserStateFailure,
  VimPendingInput,
} from '../parser/index';
export {
  createVimMotionCursor,
  resolveVimMotion,
  VIM_END_OF_LINE_COLUMN,
} from '../motions/index';
export type {
  VimMotionCursor,
  VimMotionInvocation,
  VimMotionKey,
  VimMotionKind,
  VimMotionOptions,
  VimMotionOutcome,
  VimMotionFailure,
} from '../motions/index';
export { resolveVimStructuralMotion } from '../motions/structural';
export type {
  VimStructuralMotionCursor,
  VimStructuralMotionFailure,
  VimStructuralMotionInvocation,
  VimStructuralMotionKey,
  VimStructuralMotionOptions,
  VimStructuralMotionOutcome,
} from '../motions/structural';
export { resolveVimWordMotion } from '../motions/word';
export { tokenBoundsAt } from '../motions/token-scan';
export type {
  VimWordMotionCursor,
  VimWordMotionFailure,
  VimWordMotionInvocation,
  VimWordMotionKey,
  VimWordMotionOptions,
  VimWordMotionOutcome,
} from '../motions/word';
export {
  applyVimOptionChanges,
  compileVimMappings,
  createVimOptionState,
  flushVimMapping,
  initialVimMappingState,
  resolveVimMapping,
  vimOptionScope,
} from '../config/index';
export type {
  VimConfigProfile,
  VimKeyMapping,
  VimMappingCompileFailure,
  VimMappingCompileOptions,
  VimMappingFailure,
  VimMappingMode,
  VimMappingResolution,
  VimMappingState,
  VimMappingTable,
  VimOptionChange,
  VimOptionFailure,
  VimOptionName,
  VimOptionScope,
  VimOptionState,
  VimOptionTransaction,
  VimOptionValue,
} from '../config/index';
export { resolveVimFind } from '../motions/find';
export type {
  VimFindContext,
  VimFindDirectKey,
  VimFindFailure,
  VimFindInvocation,
  VimFindKey,
  VimFindMotion,
  VimFindOptions,
  VimFindOutcome,
  VimFindRecovery,
  VimLastFind,
} from '../motions/find';
export { normalizeVimOperatorRange } from '../ranges/normalize';
export type {
  VimNormalizedOperatorRange,
  VimOperatorEndpoint,
  VimOperatorForceKind,
  VimOperatorMotionDirection,
  VimOperatorRangeFailure,
  VimOperatorRangeInput,
  VimOperatorRangeKind,
  VimOperatorTextRange,
} from '../ranges/normalize';
export { multiplyVimOperatorCounts, prepareVimOperator } from '../operators/core';
export type {
  VimCoreOperator,
  VimFailedOperatorPlan,
  VimOperatorCountFailure,
  VimOperatorCursorIntent,
  VimOperatorMotionFailure,
  VimOperatorPlan,
  VimOperatorPreparation,
  VimOperatorPreparationInput,
  VimOperatorRegisterEffect,
  VimOperatorSessionState,
  VimRepeatTarget,
} from '../operators/core';
export { prepareVimDirectChange } from '../operators/direct-changes';
export type {
  VimDirectChangeFailure,
  VimDirectChangeInput,
  VimDirectChangeKey,
  VimDirectChangePlan,
  VimDirectChangeResult,
} from '../operators/direct-changes';
export { prepareVimTextTransform } from '../operators/text-transform';
export type {
  VimTextTransformCursorIntent,
  VimTextTransformFailure,
  VimTextTransformHistoryEffect,
  VimTextTransformInput,
  VimTextTransformOperator,
  VimTextTransformOptions,
  VimTextTransformPlan,
  VimTextTransformProvider,
  VimTextTransformProviderContext,
  VimTextTransformProviderFailure,
  VimTextTransformProviderKind,
  VimTextTransformProviders,
  VimTextTransformResult,
} from '../operators/text-transform';
export {
  prepareVimAdvancedOperator,
  prepareVimFilterOperator,
  prepareVimFoldOperator,
  prepareVimNumericOperator,
} from '../operators/advanced';
export type {
  VimAdvancedOperator,
  VimAdvancedFailure,
  VimAdvancedHistoryEffect,
  VimAdvancedPlan,
  VimAdvancedRegisterEffect,
  VimAdvancedResult,
  VimAdvancedTransaction,
  VimAdvancedCursorIntent,
  VimFilterInput,
  VimFilterOperator,
  VimFilterOutput,
  VimFilterPlan,
  VimFilterProvider,
  VimFilterProviderContext,
  VimFilterProviderFailure,
  VimFoldChange,
  VimFoldInput,
  VimFoldOperator,
  VimFoldPlan,
  VimFoldProvider,
  VimFoldProviderContext,
  VimFoldProviderFailure,
  VimFoldProviderOutput,
  VimNumericInput,
  VimNumericOperator,
  VimNumericOptions,
  VimNumericPlan,
} from '../operators/advanced';
export { normalizeAtomicEdits } from '../transactions/multi-command';
export type {
  AtomicEditConflict,
  AtomicMemberIntent,
  AtomicRegisterWrite,
  AtomicResolvedMember,
  AtomicSessionDelta,
} from '../transactions/multi-command';
export {
  prepareVimMultiOperator,
  recordVimMultiPrimaryJump,
  reduceVimMultiFindState,
  reduceVimMultiSearchState,
  reselectVimMultiVisualSelection,
  rememberVimMultiVisualShapes,
  resolveVimMultiFind,
  resolveVimMultiMotion,
  resolveVimMultiSearch,
  resolveVimMultiVisualFind,
  resolveVimMultiVisualMotion,
  setVimMultiPrimaryMark,
} from '../multi';
export type {
  VimMotionPreview,
  VimMotionPreviewExtent,
  VimMotionPreviewMember,
  VimMultiFailurePolicy,
  VimMultiFindFailure,
  VimMultiFindInput,
  VimMultiFindMember,
  VimMultiFindResult,
  VimMultiSearchFailure,
  VimMultiSearchInput,
  VimMultiSearchMember,
  VimMultiSearchResult,
  VimMultiMotionInput,
  VimMultiMotionInvocation,
  VimMultiMotionMember,
  VimMultiMotionOptions,
  VimMultiMotionResult,
  VimMultiMotionFailure,
  VimMultiOperatorFailure,
  VimMultiOperatorInput,
  VimMultiOperatorMember,
  VimMultiOperatorPlan,
  VimMultiStateFailure,
  VimMultiVisualFindInput,
  VimMultiVisualFindResult,
  VimMultiVisualMotionInput,
  VimMultiVisualMotionResult,
} from '../multi';
export {
  extendVimVisualTextObject,
  resolveVimTextObject,
  vimTextObjectMotion,
} from '../text-objects/index';
export type {
  VimTextObjectCursor,
  VimTextObjectDirection,
  VimTextObjectFailure,
  VimTextObjectInvocation,
  VimTextObjectKey,
  VimTextObjectOptions,
  VimTextObjectRange,
  VimTextObjectRangeKind,
  VimVisualTextSelection,
  VimVisualTextSelectionInput,
} from '../text-objects/index';
export {
  beginVimVisualSelection,
  exchangeVimVisualBlockColumns,
  exchangeVimVisualEndpoints,
  extendVimVisualSelection,
  planVimSelectReplacement,
  planVimVisualReplacement,
  reselectVimVisualSelection,
  vimVisualSelectionMotion,
} from '../visual/index';
export type {
  VimSelectMode,
  VimSelectReplacementFailure,
  VimSelectReplacementPlan,
  VimVisualCursor,
  VimVisualFailure,
  VimVisualKind,
  VimVisualOptions,
  VimVisualReplacementFailure,
  VimVisualReplacementPlan,
} from '../visual/index';
export {
  beginVimInsert,
  calculateVimVirtualReplace,
  planVimInsertRegisterPayload,
  planVimInsertInput,
  resumeVimInsert,
} from '../insert/index';
export type {
  NormalizedVimInsertOptions,
  VimBackspaceOption,
  VimInsertEntryContext,
  VimInsertEdit,
  VimInsertEnteredTransition,
  VimInsertEntryKey,
  VimInsertFailure,
  VimInsertLastContext,
  VimInsertMode,
  VimInsertOptions,
  VimInsertPendingInput,
  VimInsertPlan,
  VimInsertRegisterPayload,
  VimInsertRegisterRequest,
  VimInsertResumedTransition,
  VimInsertResult,
  VimInsertSession,
  VimInsertTransition,
  VimInsertUndoAction,
} from '../insert/index';
export {
  applyVimRepeatEvent,
  createVimInsertRepeatTarget,
  createVimOperatorRepeatTarget,
  createVimPutRepeatTarget,
  createVimRepeatState,
  createVimVisualRepeatTarget,
  recordVimRepeatTarget,
  replayVimDot,
  replayVimMultiDot,
} from '../repeat/index';
export type {
  VimDotReplay,
  VimDotReplayContext,
  VimDotRequest,
  VimMultiDotFailure,
  VimMultiDotReplay,
  VimMultiDotReplayContext,
  VimMultiDotRequest,
  VimInsertRepeatInput,
  VimInsertRepeatTarget,
  VimOperatorRepeatInput,
  VimOperatorRepeatTarget,
  VimPutRepeatInput,
  VimPutRepeatTarget,
  VimRepeatEvent,
  VimRepeatFailure,
  VimRepeatResult,
  VimRepeatState,
  VimSemanticRepeatTarget,
  VimVisualRepeatInput,
  VimVisualRepeatTarget,
} from '../repeat/index';
export {
  beginVimMacroRecording,
  commitVimMacroRecording,
  createVimMacroStore,
  executeVimMacro,
  executeVimMultiMacro,
  finishVimMacroRecording,
  readVimMacro,
  recordVimMacroKey,
  recordVimMacroToken,
  writeVimMacro,
} from '../macros/index';
export type {
  VimMacroCallToken,
  VimMacroDispatchContext,
  VimMacroDispatchEffect,
  VimMacroDispatchFailure,
  VimMacroDispatchResult,
  VimMacroExecution,
  VimMultiMacroDispatchContext,
  VimMultiMacroDispatchValue,
  VimMultiMacroExecution,
  VimMacroExecutionOptions,
  VimMacroFailure,
  VimMacroKeyInput,
  VimMacroKeyToken,
  VimMacroRegister,
  VimMacroRegisterName,
  VimMacroRecording,
  VimMacroRecordingSession,
  VimMacroRepeatLastToken,
  VimMacroResult,
  VimMacroSliceProgress,
  VimMacroStore,
  VimMacroToken,
} from '../macros/index';
export {
  beginVimMultiInsert,
  planVimMultiInsertInput,
  mapVimMultiInsertSession,
} from '../insert/multi';
export type {
  VimMultiInsertMember,
  VimMultiInsertSession,
  VimMultiInsertMemberPlan,
  VimMultiInsertPlan,
  VimMultiInsertFailure,
  VimMultiInsertResult,
} from '../insert/multi';
export {
  beginVimJumpPreview,
  cancelVimJumpPreview,
  changeBackward,
  changeForward,
  classifyVimMarkName,
  commitVimJumpPreview,
  createVimChangeHistory,
  createVimJumpHistory,
  createVimMarkStore,
  deleteVimMark,
  jumpBackward,
  jumpForward,
  mapVimMarksThroughChange,
  recordVimChange,
  recordVimJump,
  resolveVimMark,
  resolveVimMarkForWorkspace,
  setVimMark,
} from '../navigation/index';
export { resolveVimCharacterInfo } from '../navigation/character-info';
export type { VimCharacterInfo, VimCharacterInfoFailure } from '../navigation/character-info';
export type {
  VimChangeEntry,
  VimChangeHistory,
  VimJumpEntry,
  VimJumpFailure,
  VimJumpHistory,
  VimJumpPreview,
  VimJumpReason,
  VimMark,
  VimMarkFailure,
  VimMarkKind,
  VimMarkName,
  VimMarkStore,
  VimMarkTarget,
  VimNavigationTarget,
} from '../navigation/index';
export {
  EMPTY_VIM_SEARCH_STATE,
  VimSearchPreview,
  beginVimSearch,
  literalPattern,
  parseVimSubstituteCommand,
  prepareVimSubstitute,
  searchVimBuffer,
  searchVimOperator,
} from '../search/index';
export type {
  VimOperatorSearchCommit,
  VimOperatorSearchRange,
  VimSearchCancellation,
  VimSearchCommit,
  VimSearchCommand,
  VimSearchDirection,
  VimSearchFailure,
  VimSearchMatch,
  VimSearchOffset,
  VimSearchOutcome,
  VimSearchProgress,
  VimSearchRequest,
  VimSearchState,
  VimSearchView,
  VimSubstitutePlan,
  VimSubstituteRange,
  VimSubstituteRequest,
} from '../search/index';
export {
  parseVimExCommand,
  parseVimExSequence,
  prepareVimEx,
  resolveVimExCommandName,
  resolveVimExRange,
} from '../ex/index';
export type {
  VimExAddress,
  VimExAddressExpression,
  VimExArguments,
  VimExCommand,
  VimExCommandMetadata,
  VimExCommandName,
  VimExHostEffect,
  VimExParseFailure,
  VimExPrepareContext,
  VimExPrepareFailure,
  VimExPlan,
  VimExRegisterEffect,
  VimExResolutionContext,
  VimExResolvedRange,
  VimExRangeSpec,
  VimExSubstituteState,
} from '../ex/index';
export {
  VimRegisterBank,
  createVimRegisterBank,
  isRegisterName,
  isUppercaseNamedRegister,
  prepareVimPut,
  prepareVimPutFromBank,
  prepareVimMultiPut,
  exportVimRegisterToClipboard,
  exportVimRegisterVectorToClipboard,
  importVimRegisterFromClipboard,
  importVimRegisterVectorFromClipboard,
} from '../registers/index';
export type {
  VimRegisterName,
  VimRegisterType,
  VimRegisterValue,
  VimRegisterVector,
  VimRegisterVectorWrite,
  VimRegisterWrite,
  VimRegisterFailure,
  VimRegisterSnapshot,
  VimPutCommand,
  VimPutSelectionKind,
  VimPutSelection,
  VimPutContext,
  VimPutPlan,
  VimPutFailure,
  VimMultiPutMemberInput,
  VimMultiPutMember,
  VimMultiPutPlan,
  VimMultiPutFailure,
} from '../registers/index';
export { applyVimSelectionCommand } from '../selections/index';
export type {
  VimSelectionCommand,
  VimSelectionCommandFailure,
  VimSelectionCommandInput,
  VimSelectionCommandResult,
} from '../selections/index';
export { VIM_SELECTION_HISTORY_LIMIT, VIM_SELECTION_HISTORY_MAX_BYTES, VimSelectionHistory } from '../history/index';
export type { SelectionOnlyHistoryFailure } from '../history/index';
export type {
  PatternCharacterClassContext,
  PatternPositionContext,
  PatternVisualArea,
  PositionAxis,
  PositionPredicate,
  PositionRelation,
} from '../pattern/index';
export { PointerGestureController, pointerDisplayColumn } from '../pointer/index';
export type { PointerGestureKind, PointerCell, PointerTextTarget, PointerEvent, PointerSelectionIntent, PointerEnginePort } from '../pointer/index';
