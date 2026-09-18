/** Vim surface required by the production launch session. */
export { normalizeVimInput } from '../../input';
export { createVimParserState, parseVimInput } from '../../parser';
export { createVimMotionCursor, resolveVimMotion } from '../../motions';
export { resolveVimFind } from '../../motions/find';
export { prepareVimOperator } from '../../operators/core';
export { prepareVimDirectChange } from '../../operators/direct-changes';
export { beginVimMultiInsert, planVimMultiInsertInput } from '../../insert/multi';
export { parseVimExSequence, prepareVimEx } from '../../ex';
export { prepareVimMultiOperator, resolveVimMultiVisualFind, resolveVimMultiVisualMotion } from '../../multi';
export { beginVimVisualSelection, extendVimVisualSelection } from '../../visual';
export { applyVimSelectionCommand } from '../../selections';
export { resolveVimCharacterInfo } from '../../navigation/character-info';
export { createVimRegisterBank, prepareVimPutFromBank } from '../../registers';
export { PointerGestureController } from '../../pointer';
export type { PointerEnginePort, PointerEvent, PointerSelectionIntent, PointerTextTarget, PointerCell } from '../../pointer';

export type { NormalizedVimInput } from '../../input';
export type { VimHostCommand } from '../index';
export type { VimCommandIntent, VimMode, VimParserState } from '../../parser';
export type {
  VimMotionCursor,
  VimMotionKey,
} from '../../motions';
export type { VimFindFailure, VimLastFind } from '../../motions/find';
export type {
  VimCoreOperator,
  VimOperatorPreparation,
} from '../../operators/core';
export type { VimDirectChangeKey } from '../../operators/direct-changes';
export type {
  VimInsertEntryKey,
} from '../../insert';
export type { VimMultiInsertPlan, VimMultiInsertSession } from '../../insert/multi';
export type { VimMultiMotionInvocation } from '../../multi';
export type { VimVisualKind, VimVisualCursor } from '../../visual';
export type { VimCharacterInfo, VimCharacterInfoFailure } from '../../navigation/character-info';
export type { VimRegisterBank, VimRegisterName, VimRegisterType } from '../../registers';
export type { VimTextObjectKey } from '../../text-objects';
export type { VimWordMotionKey } from '../../motions/word';
export type {
  VimSelectionCommand,
  VimSelectionCommandFailure,
  VimSelectionCommandInput,
  VimSelectionCommandResult,
} from '../../selections';
