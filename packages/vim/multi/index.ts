import type { CancellationToken, Result } from '../../contracts/src/index';
import {
  createDocumentAnchor,
  DocumentChangeMap,
  type DocumentEdit,
  type DocumentSnapshot,
  type LineIndex,
  type Utf16Offset,
} from '../../document/src/index';
import type {
  DesiredColumn,
  EndpointInput,
  SelectionEndpoint,
  SelectionMember,
  SelectionMemberInput,
  SelectionSetSnapshot,
} from '../../selections/src/index';
import { createSelectionSet, updateSelectionSet } from '../../selections/src/index';
import type { CellColumn } from '../../document/src/index';
import type { SelectionId } from '../../selections/src/index';
import {
  createVimMotionCursor,
  resolveVimMotion,
  type VimMotionCursor,
  type VimMotionFailure,
  type VimMotionInvocation,
  type VimMotionOptions,
  type VimMotionOutcome,
} from '../motions/index';
import {
  resolveVimWordMotion,
  type VimWordMotionInvocation,
  type VimWordMotionKey,
} from '../motions/word';
import {
  extendVimVisualTextObject,
  resolveVimTextObject,
  vimTextObjectMotion,
  type VimTextObjectInvocation,
  type VimTextObjectKey,
  type VimTextObjectOptions,
} from '../text-objects/index';
import type {
  VimCoreOperator,
  VimOperatorMotionFailure,
  VimOperatorPlan,
  VimOperatorPreparationInput,
  VimOperatorSessionState,
} from '../operators/core';
import { multiplyVimOperatorCounts, prepareVimOperator } from '../operators/core';
import { normalizeAtomicEdits, type AtomicEditConflict } from '../transactions/multi-command';
import {
  type VimVisualCursor,
  type VimVisualFailure,
  type VimVisualKind,
  type VimVisualOptions,
  beginVimVisualSelection,
  extendVimVisualSelection,
} from '../visual/index';
import { resolveVimFind, type VimFindFailure, type VimFindInvocation, type VimFindOptions, type VimFindOutcome, type VimLastFind } from '../motions/find';
import type { VimJumpHistory, VimJumpReason, VimNavigationTarget, VimMarkStore } from '../navigation/index';
import { recordVimJump, setVimMark } from '../navigation/index';
import { searchVimBuffer, type VimSearchFailure, type VimSearchOutcome, type VimSearchRequest, type VimSearchState, type VimSearchView, type VimOperatorSearchRange } from '../search/index';

export type VimMultiFailurePolicy = 'retain-failed' | 'reject-command';

/** o_v/o_V/o_CTRL-V: forces an otherwise linewise/characterwise motion to the given wise-ness. */
export type VimOperatorForce = 'v' | 'V' | '<C-v>';
export type VimMultiMotionInvocation = VimMotionInvocation | VimWordMotionInvocation | VimTextObjectInvocation;
export type VimMultiMotionOptions = VimMotionOptions & VimTextObjectOptions;

export type VimMultiMotionFailure =
  | { readonly kind: 'stale-selection' }
  | { readonly kind: 'invalid-selection' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'member-failed'; readonly memberId: SelectionId; readonly memberIndex: number; readonly cause: VimMotionFailure }
  | { readonly kind: 'selection-update-failed' }
  | { readonly kind: 'preview-failed' };

export interface VimMotionPreviewExtent {
  readonly kind: 'characterwise' | 'linewise';
  readonly start: Utf16Offset;
  readonly end: Utf16Offset;
}

/** Presentation-only motion information. It is versioned and never an edit range. */
export interface VimMotionPreview {
  readonly documentId: DocumentSnapshot['id'];
  readonly documentVersion: DocumentSnapshot['version'];
  readonly selectionGeneration: SelectionSetSnapshot['selectionGeneration'];
  readonly operatorKey: VimMultiMotionInvocation['key'];
  readonly count: number;
  readonly members: readonly VimMotionPreviewMember[];
}

export interface VimMotionPreviewMember {
  readonly memberId: SelectionId;
  readonly source: Utf16Offset;
  readonly destination: Utf16Offset;
  readonly moved: boolean;
  readonly extent: VimMotionPreviewExtent;
}

export interface VimMultiMotionInput {
  readonly snapshot: DocumentSnapshot;
  readonly selections: SelectionSetSnapshot;
  readonly invocation: VimMultiMotionInvocation;
  readonly options?: VimMultiMotionOptions;
  readonly failurePolicy?: VimMultiFailurePolicy;
  readonly previewEnabled?: boolean;
  readonly cancellation?: CancellationToken;
  readonly isCancelled?: () => boolean;
}

export interface VimMultiMotionMember {
  readonly id: SelectionId;
  readonly status: 'completed' | 'failed';
  readonly source: Utf16Offset;
  readonly outcome: VimMotionOutcome | null;
  readonly failure: VimMotionFailure | null;
}

export interface VimMultiMotionResult {
  readonly selection: SelectionSetSnapshot;
  readonly members: readonly VimMultiMotionMember[];
  readonly failedMemberIds: readonly SelectionId[];
  readonly preview: VimMotionPreview | null;
}

/** Resolve one parsed motion against every member on one immutable snapshot. */
export function resolveVimMultiMotion(
  input: VimMultiMotionInput,
): Result<VimMultiMotionResult, VimMultiMotionFailure> {
  if (!sameSelectionDocument(input.snapshot, input.selections)) return failure({ kind: 'stale-selection' });
  if (input.selections.members.length === 0) return failure({ kind: 'invalid-selection' });
  const policy = input.failurePolicy ?? 'retain-failed';
  const nextMembers: SelectionMemberInput[] = [];
  const outcomes: VimMultiMotionMember[] = [];
  const previewMembers: VimMotionPreviewMember[] = [];
  const failedMemberIds: SelectionId[] = [];
  for (let index = 0; index < input.selections.members.length; index += 1) {
    if (cancelled(input)) return failure({ kind: 'cancelled' });
    const member = input.selections.members[index];
    if (member === undefined) return failure({ kind: 'invalid-selection' });
    const sourceOffset = memberOffset(member);
    const cursor = motionCursorForMember(input.snapshot, member);
    if (!cursor.ok) return failure({ kind: 'invalid-selection' });
    const resolved = resolveMultiMotion(input.snapshot, cursor.value, input.invocation, input.options);
    if (!resolved.ok) {
      failedMemberIds.push(member.id);
      outcomes.push(Object.freeze({ id: member.id, status: 'failed', source: sourceOffset, outcome: null, failure: resolved.error }));
      if (policy === 'reject-command') {
        return failure({ kind: 'member-failed', memberId: member.id, memberIndex: index, cause: resolved.error });
      }
      nextMembers.push(memberInput(member));
      continue;
    }
    const next = normalMemberFromMotion(input.snapshot, member, resolved.value);
    if (!next.ok) return failure({ kind: 'selection-update-failed' });
    nextMembers.push(next.value);
    outcomes.push(Object.freeze({ id: member.id, status: 'completed', source: sourceOffset, outcome: resolved.value, failure: null }));
    if (input.previewEnabled === true) {
      const extent = motionExtent(input.snapshot, sourceOffset, resolved.value);
      if (!extent.ok) return failure({ kind: 'preview-failed' });
      previewMembers.push(Object.freeze({
        memberId: member.id,
        source: sourceOffset,
        destination: resolved.value.cursor.offset,
        moved: resolved.value.moved,
        extent: extent.value,
      }));
    }
  }
  const updated = updateSelectionSet(input.snapshot, input.selections, {
    primaryId: input.selections.primaryId,
    members: nextMembers,
  });
  if (!updated.ok) return failure({ kind: 'selection-update-failed' });
  // C9: motion previews are opt-in (default off) — no consumer in workbench/ui builds them by default.
  const preview = input.previewEnabled !== true ? null : Object.freeze({
    documentId: input.snapshot.id,
    documentVersion: input.snapshot.version,
    selectionGeneration: input.selections.selectionGeneration,
    operatorKey: input.invocation.key,
    count: input.invocation.count ?? 1,
    members: Object.freeze(previewMembers),
  });
  return {
    ok: true,
    value: Object.freeze({
      selection: updated.value.selectionSet,
      members: Object.freeze(outcomes),
      failedMemberIds: Object.freeze(failedMemberIds),
      preview,
    }),
  };
}

export interface VimMultiVisualMotionInput {
  readonly snapshot: DocumentSnapshot;
  readonly selections: SelectionSetSnapshot;
  readonly invocation: VimMultiMotionInvocation;
  readonly options?: VimMultiMotionOptions;
  readonly visualOptions?: VimVisualOptions;
  readonly failurePolicy?: VimMultiFailurePolicy;
  readonly previewEnabled?: boolean;
  readonly cancellation?: CancellationToken;
  readonly isCancelled?: () => boolean;
}

export interface VimMultiVisualMotionResult {
  readonly selection: SelectionSetSnapshot;
  readonly members: readonly VimMultiMotionMember[];
  readonly failedMemberIds: readonly SelectionId[];
  readonly preview: VimMotionPreview | null;
}

export interface VimMultiVisualTextObjectInput {
  readonly snapshot: DocumentSnapshot;
  readonly selections: SelectionSetSnapshot;
  readonly invocation: VimTextObjectInvocation;
  readonly options?: VimMultiMotionOptions;
  readonly failurePolicy?: VimMultiFailurePolicy;
}

export interface VimMultiVisualTextObjectResult {
  readonly selection: SelectionSetSnapshot;
  /** The Visual kind every member now has: `ip`/`ap` turn a characterwise Visual linewise (nvim `vip`). */
  readonly kind: VimVisualKind;
  readonly failedMemberIds: readonly SelectionId[];
}

/** Extend every Visual member by one text object (`viw`, `vi{`, `vap`, ...). Each member is
 * rebuilt through beginVimVisualSelection + extendVimVisualSelection so anchor and head
 * endpoints keep the visual package's own endpoint rules. */
export function resolveVimMultiVisualTextObject(
  input: VimMultiVisualTextObjectInput,
): Result<VimMultiVisualTextObjectResult, VimMultiMotionFailure> {
  if (!sameSelectionDocument(input.snapshot, input.selections)) return failure({ kind: 'stale-selection' });
  if (input.selections.members.length === 0) return failure({ kind: 'invalid-selection' });
  const policy = input.failurePolicy ?? 'retain-failed';
  const members: SelectionMemberInput[] = [];
  const failedMemberIds: SelectionId[] = [];
  let kind: VimVisualKind = 'visual-character';
  const cursorAt = (offset: Utf16Offset): VimVisualCursor => {
    const cursor = createVimMotionCursor(input.snapshot, offset);
    return { documentVersion: input.snapshot.version, offset, displayCellColumn: (cursor.ok ? cursor.value.desiredDisplayCellColumn : null) ?? 0 as CellColumn };
  };
  for (let index = 0; index < input.selections.members.length; index += 1) {
    const member = input.selections.members[index];
    if (member === undefined || !isVisualMember(member)) return failure({ kind: 'invalid-selection' });
    const extended = extendVimVisualTextObject(input.snapshot, {
      documentVersion: input.snapshot.version,
      anchor: member.anchor.at.offset,
      head: member.head.at.offset,
      direction: member.direction,
      kind: member.kind === 'visual-line' ? 'linewise' : 'characterwise',
    }, input.invocation, textObjectOptions(input.options));
    if (!extended.ok) {
      failedMemberIds.push(member.id);
      const cause: VimMotionFailure = { kind: extended.error.kind === 'stale-document-version' ? 'stale-document-version' : extended.error.kind === 'invalid-cursor' ? 'invalid-cursor' : extended.error.kind === 'invalid-count' ? 'invalid-count' : extended.error.kind === 'invalid-option' ? 'invalid-option' : 'document-read-failed' };
      if (policy === 'reject-command') return failure({ kind: 'member-failed', memberId: member.id, memberIndex: index, cause });
      members.push(memberInput(member));
      continue;
    }
    const memberKind: VimVisualKind = extended.value.kind === 'linewise' ? 'visual-line' : member.kind;
    kind = memberKind;
    const begun = beginVimVisualSelection(input.snapshot, member.id, cursorAt(extended.value.anchor), memberKind);
    if (!begun.ok) return failure({ kind: 'selection-update-failed' });
    const moved = extendVimVisualSelection(input.snapshot, begun.value, [{ id: member.id, cursor: cursorAt(extended.value.head) }]);
    const rebuilt = moved.ok ? moved.value.members[0] : undefined;
    if (rebuilt === undefined) return failure({ kind: 'selection-update-failed' });
    members.push({ ...memberInput(rebuilt), creationOrdinal: member.creationOrdinal as number });
  }
  const updated = updateSelectionSet(input.snapshot, input.selections, { primaryId: input.selections.primaryId, members });
  if (!updated.ok) return failure({ kind: 'selection-update-failed' });
  return { ok: true, value: Object.freeze({ selection: updated.value.selectionSet, kind, failedMemberIds: Object.freeze(failedMemberIds) }) };
}

export type VimMultiFindFailure =
  | { readonly kind: 'stale-selection' }
  | { readonly kind: 'invalid-selection' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'member-failed'; readonly memberId: SelectionId; readonly memberIndex: number; readonly cause: VimFindFailure | { readonly kind: 'no-match'; readonly reason: 'target-not-found' | 'no-last-find' } }
  | { readonly kind: 'selection-update-failed' };

export interface VimMultiFindInput {
  readonly snapshot: DocumentSnapshot;
  readonly selections: SelectionSetSnapshot;
  readonly invocation: VimFindInvocation;
  readonly lastFind: VimLastFind | null;
  readonly options?: VimFindOptions;
  readonly failurePolicy?: VimMultiFailurePolicy;
  readonly cancellation?: CancellationToken;
  readonly isCancelled?: () => boolean;
}

export interface VimMultiFindMember {
  readonly id: SelectionId;
  readonly status: 'completed' | 'failed';
  readonly outcome: VimFindOutcome;
}

export interface VimMultiFindResult {
  readonly selection: SelectionSetSnapshot;
  readonly members: readonly VimMultiFindMember[];
  readonly failedMemberIds: readonly SelectionId[];
  /** One shared repeat target; per-member match locations remain in outcomes. */
  readonly lastFind: VimLastFind | null;
}

/** Resolve one literal find/repeat against every member without partial selection publication. */
export function resolveVimMultiFind(
  input: VimMultiFindInput,
): Result<VimMultiFindResult, VimMultiFindFailure> {
  if (!sameSelectionDocument(input.snapshot, input.selections)) return failure({ kind: 'stale-selection' });
  if (input.selections.members.length === 0) return failure({ kind: 'invalid-selection' });
  const policy = input.failurePolicy ?? 'retain-failed';
  const nextMembers: SelectionMemberInput[] = [];
  const members: VimMultiFindMember[] = [];
  const failedMemberIds: SelectionId[] = [];
  let sharedLastFind: VimLastFind | null = input.lastFind;
  for (let index = 0; index < input.selections.members.length; index += 1) {
    if (cancelled(input)) return failure({ kind: 'cancelled' });
    const member = input.selections.members[index];
    if (member === undefined) return failure({ kind: 'invalid-selection' });
    const cursor = motionCursorForMember(input.snapshot, member);
    if (!cursor.ok) return failure({ kind: 'invalid-selection' });
    const outcome = resolveVimFind(input.snapshot, cursor.value, input.invocation, input.lastFind, input.options);
    if (!outcome.ok) return failure({ kind: 'member-failed', memberId: member.id, memberIndex: index, cause: outcome.error });
    if (sharedLastFind === input.lastFind || sharedLastFind === null) sharedLastFind = outcome.value.lastFind;
    if (outcome.value.kind !== 'found') {
      failedMemberIds.push(member.id);
      members.push(Object.freeze({ id: member.id, status: 'failed', outcome: outcome.value }));
      nextMembers.push(memberInput(member));
      if (policy === 'reject-command') return failure({ kind: 'member-failed', memberId: member.id, memberIndex: index, cause: { kind: 'no-match', reason: outcome.value.reason } });
      continue;
    }
    const motionOutcome: VimMotionOutcome = Object.freeze({ cursor: outcome.value.cursor, kind: 'characterwise', moved: outcome.value.moved });
    const next = normalMemberFromMotion(input.snapshot, member, motionOutcome);
    if (!next.ok) return failure({ kind: 'selection-update-failed' });
    members.push(Object.freeze({ id: member.id, status: 'completed', outcome: outcome.value }));
    nextMembers.push(next.value);
  }
  const updated = updateSelectionSet(input.snapshot, input.selections, { primaryId: input.selections.primaryId, members: nextMembers });
  if (!updated.ok) return failure({ kind: 'selection-update-failed' });
  return { ok: true, value: Object.freeze({ selection: updated.value.selectionSet, members: Object.freeze(members), failedMemberIds: Object.freeze(failedMemberIds), lastFind: sharedLastFind }) };
}

export interface VimMultiVisualFindInput {
  readonly snapshot: DocumentSnapshot;
  readonly selections: SelectionSetSnapshot;
  readonly invocation: VimFindInvocation;
  readonly lastFind: VimLastFind | null;
  readonly options?: VimFindOptions;
  readonly visualOptions?: VimVisualOptions;
  readonly failurePolicy?: VimMultiFailurePolicy;
  readonly cancellation?: CancellationToken;
  readonly isCancelled?: () => boolean;
}

export interface VimMultiVisualFindResult {
  readonly selection: SelectionSetSnapshot;
  readonly members: readonly VimMultiFindMember[];
  readonly failedMemberIds: readonly SelectionId[];
  readonly lastFind: VimLastFind | null;
}

/**
 * Visual-mode mirror of `resolveVimMultiFind`: repeats/reverses the last `f`/`F`/`t`/`T`
 * literal find via `;`/`,`, extending each visual member's head (not collapsing it to a
 * Normal cursor, unlike the Normal-mode resolver above).
 */
export function resolveVimMultiVisualFind(
  input: VimMultiVisualFindInput,
): Result<VimMultiVisualFindResult, VimMultiFindFailure> {
  if (!sameSelectionDocument(input.snapshot, input.selections)) return failure({ kind: 'stale-selection' });
  if (!input.selections.members.every(isVisualMember)) return failure({ kind: 'invalid-selection' });
  const policy = input.failurePolicy ?? 'retain-failed';
  const targets: { readonly id: SelectionId; readonly cursor: VimVisualCursor }[] = [];
  const members: VimMultiFindMember[] = [];
  const failedMemberIds: SelectionId[] = [];
  let sharedLastFind: VimLastFind | null = input.lastFind;
  for (let index = 0; index < input.selections.members.length; index += 1) {
    if (cancelled(input)) return failure({ kind: 'cancelled' });
    const member = input.selections.members[index];
    if (member === undefined) return failure({ kind: 'invalid-selection' });
    const cursor = motionCursorForMember(input.snapshot, member);
    if (!cursor.ok) return failure({ kind: 'invalid-selection' });
    const outcome = resolveVimFind(input.snapshot, cursor.value, input.invocation, input.lastFind, input.options);
    if (!outcome.ok) return failure({ kind: 'member-failed', memberId: member.id, memberIndex: index, cause: outcome.error });
    if (sharedLastFind === input.lastFind || sharedLastFind === null) sharedLastFind = outcome.value.lastFind;
    if (outcome.value.kind !== 'found') {
      failedMemberIds.push(member.id);
      members.push(Object.freeze({ id: member.id, status: 'failed', outcome: outcome.value }));
      targets.push({ id: member.id, cursor: visualCursorForMember(member) });
      if (policy === 'reject-command') return failure({ kind: 'member-failed', memberId: member.id, memberIndex: index, cause: { kind: 'no-match', reason: outcome.value.reason } });
      continue;
    }
    const motionOutcome: VimMotionOutcome = Object.freeze({ cursor: outcome.value.cursor, kind: 'characterwise', moved: outcome.value.moved });
    targets.push({ id: member.id, cursor: visualCursorFromMotion(motionOutcome) });
    members.push(Object.freeze({ id: member.id, status: 'completed', outcome: outcome.value }));
  }
  const extended = extendVimVisualSelection(input.snapshot, input.selections, targets, input.visualOptions);
  if (!extended.ok) return failure({ kind: 'selection-update-failed' });
  return { ok: true, value: Object.freeze({ selection: extended.value, members: Object.freeze(members), failedMemberIds: Object.freeze(failedMemberIds), lastFind: sharedLastFind }) };
}

export type VimMultiSearchFailure =
  | { readonly kind: 'stale-selection' }
  | { readonly kind: 'invalid-selection' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'member-failed'; readonly memberId: SelectionId; readonly memberIndex: number; readonly cause: VimSearchFailure | { readonly kind: 'no-match'; readonly pattern: string } }
  | { readonly kind: 'selection-update-failed' };

export interface VimMultiSearchInput {
  readonly snapshot: DocumentSnapshot;
  readonly selections: SelectionSetSnapshot;
  readonly request: VimSearchRequest;
  readonly state: VimSearchState;
  readonly failurePolicy?: VimMultiFailurePolicy;
  readonly cancellation?: CancellationToken;
  readonly isCancelled?: () => boolean;
}

export interface VimMultiSearchMember {
  readonly id: SelectionId;
  readonly status: 'completed' | 'failed';
  readonly outcome: VimSearchOutcome;
}

export interface VimMultiSearchResult {
  readonly selection: SelectionSetSnapshot;
  readonly members: readonly VimMultiSearchMember[];
  readonly failedMemberIds: readonly SelectionId[];
  readonly state: VimSearchState;
}

/** Resolve a bounded buffer search for every member, committing selection and shared search state once. */
export function resolveVimMultiSearch(
  input: VimMultiSearchInput,
): Result<VimMultiSearchResult, VimMultiSearchFailure> {
  if (!sameSelectionDocument(input.snapshot, input.selections)) return failure({ kind: 'stale-selection' });
  if (input.selections.members.length === 0) return failure({ kind: 'invalid-selection' });
  const policy = input.failurePolicy ?? 'retain-failed';
  const nextMembers: SelectionMemberInput[] = [];
  const members: VimMultiSearchMember[] = [];
  const failedMemberIds: SelectionId[] = [];
  let sharedState = input.state;
  for (let index = 0; index < input.selections.members.length; index += 1) {
    if (cancelled(input)) return failure({ kind: 'cancelled' });
    const member = input.selections.members[index];
    if (member === undefined) return failure({ kind: 'invalid-selection' });
    const cursor = motionCursorForMember(input.snapshot, member);
    if (!cursor.ok) return failure({ kind: 'invalid-selection' });
    const view: VimSearchView = { cursor: cursor.value.offset, desiredDisplayColumn: (cursor.value.desiredDisplayCellColumn ?? 0) as number, scrollTop: 0, scrollLeft: 0 };
    const result = searchVimBuffer(input.snapshot, view, input.state, input.request);
    if (!result.ok) return failure({ kind: 'member-failed', memberId: member.id, memberIndex: index, cause: result.error });
    const outcome = result.value.outcome;
    sharedState = index === 0 ? result.value.state : sharedState;
    if (outcome.kind !== 'found') {
      failedMemberIds.push(member.id);
      members.push(Object.freeze({ id: member.id, status: 'failed', outcome }));
      nextMembers.push(memberInput(member));
      if (policy === 'reject-command') return failure({ kind: 'member-failed', memberId: member.id, memberIndex: index, cause: { kind: 'no-match', pattern: input.request.pattern ?? '' } });
      continue;
    }
    const motionOutcome: VimMotionOutcome = Object.freeze({
      cursor: Object.freeze({ documentVersion: input.snapshot.version, offset: outcome.view.cursor, desiredDisplayCellColumn: outcome.view.desiredDisplayColumn as CellColumn }),
      kind: 'characterwise',
      moved: outcome.view.cursor !== cursor.value.offset,
    });
    const next = normalMemberFromMotion(input.snapshot, member, motionOutcome);
    if (!next.ok) return failure({ kind: 'selection-update-failed' });
    members.push(Object.freeze({ id: member.id, status: 'completed', outcome }));
    nextMembers.push(next.value);
  }
  const updated = updateSelectionSet(input.snapshot, input.selections, { primaryId: input.selections.primaryId, members: nextMembers });
  if (!updated.ok) return failure({ kind: 'selection-update-failed' });
  return { ok: true, value: Object.freeze({ selection: updated.value.selectionSet, members: Object.freeze(members), failedMemberIds: Object.freeze(failedMemberIds), state: sharedState }) };
}

/** Extend every Visual member while retaining each member's anchor and desired column. */
export function resolveVimMultiVisualMotion(
  input: VimMultiVisualMotionInput,
): Result<VimMultiVisualMotionResult, VimMultiMotionFailure> {
  if (!sameSelectionDocument(input.snapshot, input.selections)) return failure({ kind: 'stale-selection' });
  if (!input.selections.members.every(isVisualMember)) return failure({ kind: 'invalid-selection' });
  const policy = input.failurePolicy ?? 'retain-failed';
  const targets: { readonly id: SelectionId; readonly cursor: VimVisualCursor }[] = [];
  const outcomes: VimMultiMotionMember[] = [];
  const failedMemberIds: SelectionId[] = [];
  const previewMembers: VimMotionPreviewMember[] = [];
  for (let index = 0; index < input.selections.members.length; index += 1) {
    if (cancelled(input)) return failure({ kind: 'cancelled' });
    const member = input.selections.members[index];
    if (member === undefined) return failure({ kind: 'invalid-selection' });
    const sourceOffset = memberOffset(member);
    const cursor = motionCursorForMember(input.snapshot, member);
    if (!cursor.ok) return failure({ kind: 'invalid-selection' });
    const resolved = resolveMultiMotion(input.snapshot, cursor.value, input.invocation, input.options);
    if (!resolved.ok) {
      failedMemberIds.push(member.id);
      outcomes.push(Object.freeze({ id: member.id, status: 'failed', source: sourceOffset, outcome: null, failure: resolved.error }));
      if (policy === 'reject-command') return failure({ kind: 'member-failed', memberId: member.id, memberIndex: index, cause: resolved.error });
      targets.push({ id: member.id, cursor: visualCursorForMember(member) });
      continue;
    }
    targets.push({ id: member.id, cursor: visualCursorFromMotion(resolved.value) });
    outcomes.push(Object.freeze({ id: member.id, status: 'completed', source: sourceOffset, outcome: resolved.value, failure: null }));
    if (input.previewEnabled === true) {
      const extent = motionExtent(input.snapshot, sourceOffset, resolved.value);
      if (!extent.ok) return failure({ kind: 'preview-failed' });
      previewMembers.push(Object.freeze({ memberId: member.id, source: sourceOffset, destination: resolved.value.cursor.offset, moved: resolved.value.moved, extent: extent.value }));
    }
  }
  const extended = extendVimVisualSelection(input.snapshot, input.selections, targets, input.visualOptions);
  if (!extended.ok) return failure({ kind: 'selection-update-failed' });
  // C9: motion previews are opt-in (default off).
  const preview = input.previewEnabled !== true ? null : Object.freeze({
    documentId: input.snapshot.id,
    documentVersion: input.snapshot.version,
    selectionGeneration: input.selections.selectionGeneration,
    operatorKey: input.invocation.key,
    count: input.invocation.count ?? 1,
    members: Object.freeze(previewMembers),
  });
  return { ok: true, value: Object.freeze({ selection: extended.value, members: Object.freeze(outcomes), failedMemberIds: Object.freeze(failedMemberIds), preview }) };
}

export type VimMultiOperatorFailure =
  | { readonly kind: 'stale-selection' }
  | { readonly kind: 'invalid-selection' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'member-failed'; readonly memberId: SelectionId; readonly memberIndex: number; readonly cause: VimOperatorMotionFailure }
  | { readonly kind: 'edit-conflict'; readonly conflict: AtomicEditConflict }
  | { readonly kind: 'invalid-count' }
  | { readonly kind: 'invalid-operator' };

export interface VimMultiOperatorInput {
  readonly snapshot: DocumentSnapshot;
  readonly selections: SelectionSetSnapshot;
  readonly operator: VimCoreOperator;
  /** One parsed motion shared by all normal members. Visual members use their stored shape. */
  readonly motion?: VimMultiMotionInvocation;
  readonly motionOptions?: VimMultiMotionOptions;
  readonly force?: VimOperatorForce;
  /** A `/pat<CR>` or `?pat<CR>` search-motion range (searchVimOperator), used
   * instead of `motion` for normal-cursor members (e.g. `d/two/+1<CR>`). */
  readonly searchRange?: VimOperatorSearchRange;
  readonly operatorCount?: number;
  readonly motionCount?: number;
  readonly doubled?: boolean;
  readonly register?: string;
  readonly state?: VimOperatorSessionState;
  readonly failurePolicy?: VimMultiFailurePolicy;
  readonly cancellation?: CancellationToken;
  readonly isCancelled?: () => boolean;
}

export interface VimMultiOperatorMember {
  readonly id: SelectionId;
  readonly status: 'prepared' | 'failed';
  readonly plan: VimOperatorPlan | null;
  readonly failure: VimOperatorMotionFailure | null;
  readonly cursorOffset: Utf16Offset;
}

export interface VimMultiOperatorPlan {
  readonly operator: VimCoreOperator;
  readonly transaction: {
    readonly documentId: DocumentSnapshot['id'];
    readonly expectedVersion: DocumentSnapshot['version'];
    readonly edits: readonly DocumentEdit[];
  } | null;
  readonly members: readonly VimMultiOperatorMember[];
  readonly registerEffects: readonly VimOperatorPlan['registerEffect'][];
  readonly cursorOffsets: readonly { readonly id: SelectionId; readonly offset: Utf16Offset }[];
  readonly historyEffect: { readonly kind: 'single-command'; readonly breaksInsert: true };
}

/** Resolve and compose a shared operator over one base snapshot. */
export function prepareVimMultiOperator(
  input: VimMultiOperatorInput,
): Result<VimMultiOperatorPlan, VimMultiOperatorFailure> {
  if (!sameSelectionDocument(input.snapshot, input.selections)) return failure({ kind: 'stale-selection' });
  if (input.selections.members.length === 0) return failure({ kind: 'invalid-selection' });
  if (input.operator !== 'delete' && input.operator !== 'change' && input.operator !== 'yank') return failure({ kind: 'invalid-operator' });
  if (input.motion === undefined && input.searchRange === undefined && input.selections.members.some((member) => member.kind === 'normal-cursor')) return failure({ kind: 'invalid-selection' });
  const policy = input.failurePolicy ?? 'reject-command';
  const state = input.state ?? { mode: 'normal', repeatTarget: null };
  const members: VimMultiOperatorMember[] = [];
  const allEdits: DocumentEdit[] = [];
  const registerEffects: VimOperatorPlan['registerEffect'][] = [];
  for (let index = 0; index < input.selections.members.length; index += 1) {
    if (cancelled(input)) return failure({ kind: 'cancelled' });
    const member = input.selections.members[index];
    if (member === undefined) return failure({ kind: 'invalid-selection' });
    const motion = member.kind === 'visual-character' || member.kind === 'visual-line' || member.kind === 'visual-block'
      ? visualMemberMotion(input.snapshot, member)
      : input.searchRange !== undefined
        ? searchMemberMotion(input.snapshot, input.searchRange)
        : normalMemberMotion(input.snapshot, member, input.motion as VimMultiMotionInvocation, input.motionOptions, input.force);
    if (!motion.ok) {
      if (input.operator !== 'yank' || policy === 'reject-command') {
        return failure({ kind: 'member-failed', memberId: member.id, memberIndex: index, cause: motion.error });
      }
      members.push(Object.freeze({ id: member.id, status: 'failed', plan: null, failure: motion.error, cursorOffset: memberOffset(member) }));
      continue;
    }
    const preparation: VimOperatorPreparationInput = { operator: input.operator, motion, state };
    if (input.operatorCount !== undefined) (preparation as { operatorCount: number }).operatorCount = input.operatorCount;
    if (input.motionCount !== undefined) (preparation as { motionCount: number }).motionCount = input.motionCount;
    if (input.doubled !== undefined) (preparation as { doubled: boolean }).doubled = input.doubled;
    if (input.register !== undefined) (preparation as { register: string }).register = input.register;
    const prepared = prepareVimOperator(input.snapshot, preparation);
    if (!prepared.ok) return prepared.error.kind === 'invalid-operator' || prepared.error.kind === 'invalid-state' || prepared.error.kind === 'invalid-count'
      ? failure({ kind: prepared.error.kind === 'invalid-operator' ? 'invalid-operator' : prepared.error.kind === 'invalid-count' ? 'invalid-count' : 'invalid-selection' })
      : failure({ kind: 'invalid-selection' });
    if (prepared.value.kind === 'failed') {
      if (input.operator !== 'yank' || policy === 'reject-command') return failure({ kind: 'member-failed', memberId: member.id, memberIndex: index, cause: prepared.value.failure });
      members.push(Object.freeze({ id: member.id, status: 'failed', plan: null, failure: prepared.value.failure, cursorOffset: memberOffset(member) }));
      continue;
    }
    allEdits.push(...(prepared.value.transaction?.edits ?? []));
    registerEffects.push(prepared.value.registerEffect);
    members.push(Object.freeze({ id: member.id, status: 'prepared', plan: prepared.value, failure: null, cursorOffset: prepared.value.cursorOffset }));
  }
  const normalized = normalizeAtomicEdits(input.snapshot, allEdits);
  if (!normalized.ok) return failure({ kind: 'edit-conflict', conflict: normalized.error.conflict });
  const edits = normalized.value;
  const transaction = edits.length === 0 ? null : Object.freeze({ documentId: input.snapshot.id, expectedVersion: input.snapshot.version, edits: Object.freeze(edits) });
  const cursorOffsets = mapOperatorCursors(input.snapshot, edits, members);
  if (!cursorOffsets.ok) return failure({ kind: 'invalid-selection' });
  return {
    ok: true,
    value: Object.freeze({
      operator: input.operator,
      transaction,
      members: Object.freeze(members),
      registerEffects: Object.freeze(registerEffects),
      cursorOffsets: Object.freeze(cursorOffsets.value),
      historyEffect: Object.freeze({ kind: 'single-command', breaksInsert: true }),
    }),
  };
}

export type VimMultiStateFailure =
  | { readonly kind: 'empty-outcomes' }
  | { readonly kind: 'inconsistent-shared-state' }
  | { readonly kind: 'invalid-primary' }
  | { readonly kind: 'missing-visual-shape'; readonly memberId: SelectionId }
  | { readonly kind: 'selection-update-failed' };

/** Reduce shared search state once; per-member match positions remain in outcomes. */
export function reduceVimMultiSearchState(
  outcomes: readonly VimSearchOutcome[],
  primaryIndex = 0,
): Result<VimSearchState, VimMultiStateFailure> {
  const primary = outcomes[primaryIndex];
  if (primary === undefined) return { ok: false, error: { kind: 'invalid-primary' } };
  for (const outcome of outcomes) {
    if (outcome.state.pattern !== primary.state.pattern || outcome.state.direction !== primary.state.direction
      || outcome.state.previousReplacement !== primary.state.previousReplacement) return { ok: false, error: { kind: 'inconsistent-shared-state' } };
  }
  return { ok: true, value: Object.freeze({ ...primary.state }) };
}

/** Reduce the last-find key/target once while retaining the primary match coordinate. */
export function reduceVimMultiFindState(
  outcomes: readonly VimFindOutcome[],
  primaryIndex = 0,
): Result<VimLastFind | null, VimMultiStateFailure> {
  const primary = outcomes[primaryIndex];
  if (primary === undefined) return { ok: false, error: { kind: 'invalid-primary' } };
  const state = primary.lastFind;
  for (const outcome of outcomes) {
    const candidate = outcome.lastFind;
    if (candidate?.key !== state?.key || candidate?.target !== state?.target) return { ok: false, error: { kind: 'inconsistent-shared-state' } };
  }
  return { ok: true, value: state === null ? null : Object.freeze({ ...state }) };
}

/** A mark is scalar Vim state: set it from the primary member exactly once. */
export function setVimMultiPrimaryMark(
  store: VimMarkStore,
  name: string,
  snapshot: DocumentSnapshot,
  selections: SelectionSetSnapshot,
): Result<VimMarkStore, import('../navigation/index').VimMarkFailure> {
  if (!sameSelectionDocument(snapshot, selections)) return { ok: false, error: { kind: 'wrong-document' } };
  const primary = selections.members.find((member) => member.id === selections.primaryId);
  if (primary === undefined) return { ok: false, error: { kind: 'invalid-cursor' } };
  return setVimMark(store, name, snapshot, memberOffset(primary));
}

/** A jump-list mutation is shared and records one primary location. */
export function recordVimMultiPrimaryJump(
  state: VimJumpHistory,
  target: VimNavigationTarget,
  reason: VimJumpReason = 'search',
): ReturnType<typeof recordVimJump> {
  return recordVimJump(state, target, reason);
}

/** Store each Visual shape by stable member ID for later `gv` reselect. */
export function rememberVimMultiVisualShapes(
  selections: SelectionSetSnapshot,
): ReadonlyMap<SelectionId, SelectionMember> {
  const shapes = new Map<SelectionId, SelectionMember>();
  for (const member of selections.members) {
    if (isVisualMember(member)) shapes.set(member.id, member);
  }
  return shapes;
}

/** Reselect all remembered Visual members; missing member history fails explicitly. */
export function reselectVimMultiVisualSelection(
  snapshot: DocumentSnapshot,
  primaryId: SelectionId,
  memberIds: readonly SelectionId[],
  shapes: ReadonlyMap<SelectionId, SelectionMember>,
  count = 1,
): Result<SelectionSetSnapshot, VimMultiStateFailure> {
  if (!Number.isSafeInteger(count) || count < 1) return { ok: false, error: { kind: 'selection-update-failed' } };
  const members: SelectionMemberInput[] = [];
  for (const id of memberIds) {
    const member = shapes.get(id);
    if (member === undefined || !isVisualMember(member)) return { ok: false, error: { kind: 'missing-visual-shape', memberId: id } };
    members.push(memberInput(member));
  }
  const created = createSelectionSet(snapshot, { primaryId, members });
  return created.ok ? { ok: true, value: created.value.selectionSet } : { ok: false, error: { kind: 'selection-update-failed' } };
}

function resolveMultiMotion(
  snapshot: DocumentSnapshot,
  cursor: VimMotionCursor,
  invocation: VimMultiMotionInvocation,
  options?: VimMultiMotionOptions,
): Result<VimMotionOutcome, VimMotionFailure> {
  if (isTextObjectKey(invocation.key)) {
    const motion = textObjectMotion(snapshot, cursor, invocation.key, invocation.count, options);
    if (!motion.ok) return motion;
    return {
      ok: true,
      value: Object.freeze({
        cursor: Object.freeze({
          documentVersion: snapshot.version,
          offset: motion.value.target.offset,
          desiredDisplayCellColumn: cursor.desiredDisplayCellColumn,
        }),
        kind: motion.value.motionKind,
        moved: motion.value.target.offset !== cursor.offset,
      }),
    };
  }
  if (isWordMotionKey(invocation.key)) {
    const wordOptions = {
      ...(options?.tabSize === undefined ? {} : { tabSize: options.tabSize }),
      ...(options?.widthPolicy === undefined ? {} : { widthPolicy: options.widthPolicy }),
    };
    const wordInvocation: VimWordMotionInvocation = invocation.count === undefined
      ? { key: invocation.key }
      : { key: invocation.key, count: invocation.count };
    const outcome = resolveVimWordMotion(snapshot, cursor, wordInvocation, wordOptions);
    if (!outcome.ok) return outcome;
    return { ok: true, value: Object.freeze({ ...outcome.value, cursor: outcome.value.cursor }) };
  }
  const motionInvocation: VimMotionInvocation = invocation.count === undefined
    ? { key: invocation.key }
    : { key: invocation.key, count: invocation.count };
  return resolveVimMotion(snapshot, cursor, motionInvocation, options);
}

function textObjectOptions(options?: VimMultiMotionOptions): VimTextObjectOptions {
  return {
    ...(options?.isKeyword === undefined ? {} : { isKeyword: options.isKeyword }),
    ...(options?.quoteEscape === undefined ? {} : { quoteEscape: options.quoteEscape }),
    ...(options?.cpOptions === undefined ? {} : { cpOptions: options.cpOptions }),
    ...(options?.paragraphs === undefined ? {} : { paragraphs: options.paragraphs }),
    ...(options?.maxScanUtf16 === undefined ? {} : { maxScanUtf16: options.maxScanUtf16 }),
  };
}

/** A text object is a range, not a cursor move: its origin is the object's start,
 * which differs from the cursor whenever the cursor sits inside the object
 * (`ciw` mid-word, `di(` after the opening paren). Operators must use this full
 * range; collapsing it to a target offset silently deletes from the cursor instead. */
function textObjectMotion(
  snapshot: DocumentSnapshot,
  cursor: VimMotionCursor,
  key: VimTextObjectKey,
  count: number | undefined,
  options?: VimMultiMotionOptions,
): Result<Omit<import('../ranges/normalize').VimOperatorRangeInput, 'operator'>, VimMotionFailure> {
  const object = resolveVimTextObject(snapshot, {
    documentVersion: cursor.documentVersion,
    offset: cursor.offset,
    ...(cursor.desiredDisplayCellColumn === null ? {} : { displayCellColumn: cursor.desiredDisplayCellColumn }),
  }, count === undefined ? { key } : { key, count }, textObjectOptions(options));
  if (!object.ok) return { ok: false, error: { kind: object.error.kind === 'stale-document-version' ? 'stale-document-version' : object.error.kind === 'invalid-cursor' ? 'invalid-cursor' : object.error.kind === 'invalid-count' ? 'invalid-count' : object.error.kind === 'invalid-option' ? 'invalid-option' : 'document-read-failed' } };
  const motion = vimTextObjectMotion(snapshot, object.value);
  return motion.ok ? motion : { ok: false, error: { kind: 'document-read-failed' } };
}

function isWordMotionKey(key: VimMultiMotionInvocation['key']): key is VimWordMotionKey {
  return key === 'w' || key === 'W' || key === 'b' || key === 'B' || key === 'e' || key === 'E' || key === 'ge' || key === 'gE';
}

const TEXT_OBJECT_KEYS: ReadonlySet<string> = new Set([
  'iw', 'aw', 'iW', 'aW', 'is', 'as', 'ip', 'ap', 'i"', 'a"', "i'", "a'", 'i`', 'a`',
  'i(', 'a(', 'i)', 'a)', 'ib', 'ab', 'i[', 'a[', 'i]', 'a]', 'i{', 'a{', 'i}', 'a}', 'iB', 'aB',
  'i<', 'a<', 'i>', 'a>', 'it', 'at',
]);

function isTextObjectKey(key: VimMultiMotionInvocation['key']): key is VimTextObjectKey {
  return TEXT_OBJECT_KEYS.has(key);
}

function normalMemberMotion(
  snapshot: DocumentSnapshot,
  member: SelectionMember,
  invocation: VimMultiMotionInvocation,
  options?: VimMultiMotionOptions,
  force?: VimOperatorForce,
): Result<Omit<import('../ranges/normalize').VimOperatorRangeInput, 'operator'>, VimOperatorMotionFailure> {
  const cursor = motionCursorForMember(snapshot, member);
  if (!cursor.ok) return { ok: false, error: { kind: 'motion-failed', reason: cursor.error.kind } };
  if (isTextObjectKey(invocation.key)) {
    const motion = textObjectMotion(snapshot, cursor.value, invocation.key, invocation.count, options);
    if (!motion.ok) return { ok: false, error: { kind: 'motion-failed', reason: motion.error.kind } };
    return {
      ok: true,
      value: {
        ...motion.value,
        ...(force === 'V' ? { forceKind: 'linewise' as const } : force === '<C-v>' ? { forceKind: 'blockwise' as const, blockTabPolicy: 'preserve' as const } : {}),
        ...(options?.tabSize === undefined ? {} : { tabSize: options.tabSize }),
        ...(options?.widthPolicy === undefined ? {} : { widthPolicy: options.widthPolicy }),
        ...(options?.folds === undefined ? {} : { folds: options.folds }),
      },
    };
  }
  const outcome = resolveMultiMotion(snapshot, cursor.value, invocation, options);
  if (!outcome.ok) return { ok: false, error: { kind: 'motion-failed', reason: outcome.error.kind } };
  const start = memberOffset(member) as number;
  const target = outcome.value.cursor.offset as number;
  // o_v/o_V/o_CTRL-V (:help o_v): v forces characterwise, toggling
  // inclusive/exclusive if the motion already was characterwise (a
  // linewise motion's recorded inclusive is always false, so toggling and
  // forcing false coincide); V forces linewise; <C-v> forces blockwise.
  // nvim: normal! d1G|call cursor(1,2)|normal! dvj / dVl / dv$ / dve / d<C-v>j on ['abc','def','ghi'] cursor (1,2)
  const forceKind = force === 'V' ? ('linewise' as const)
    : force === '<C-v>' ? ('blockwise' as const)
    : force === 'v' ? ('characterwise' as const)
    : undefined;
  const baseInclusive = operatorMotionInclusive(invocation.key);
  return {
    ok: true,
    value: {
      origin: { documentVersion: snapshot.version, offset: memberOffset(member), ...(cursor.value.desiredDisplayCellColumn === null ? {} : { displayCellColumn: cursor.value.desiredDisplayCellColumn }) },
      target: { documentVersion: snapshot.version, offset: outcome.value.cursor.offset, ...(outcome.value.cursor.desiredDisplayCellColumn === null ? {} : { displayCellColumn: outcome.value.cursor.desiredDisplayCellColumn }) },
      direction: target >= start ? 'forward' : 'backward',
      motionKind: outcome.value.kind,
      inclusive: force === 'v' ? (outcome.value.kind === 'linewise' ? false : !baseInclusive) : baseInclusive,
      motionKey: invocation.key,
      ...(forceKind === undefined ? {} : { forceKind }),
      ...(forceKind === 'blockwise' ? { blockTabPolicy: 'preserve' as const } : {}),
      ...(options?.tabSize === undefined ? {} : { tabSize: options.tabSize }),
      ...(options?.widthPolicy === undefined ? {} : { widthPolicy: options.widthPolicy }),
      ...(options?.folds === undefined ? {} : { folds: options.folds }),
    },
  };
}

function visualMemberMotion(
  snapshot: DocumentSnapshot,
  member: SelectionMember,
): Result<Omit<import('../ranges/normalize').VimOperatorRangeInput, 'operator'>, VimOperatorMotionFailure> {
  if (!isVisualMember(member)) return { ok: false, error: { kind: 'invalid-endpoint' } };
  const origin = member.anchor;
  const target = member.head;
  const originColumn = origin.kind === 'block-cell' ? origin.displayCellColumn as number : member.desiredColumn.displayCell as number | null;
  const targetColumn = target.kind === 'block-cell' ? target.displayCellColumn as number : member.desiredColumn.displayCell as number | null;
  return {
    ok: true,
    value: {
      origin: { documentVersion: snapshot.version, offset: origin.at.offset, ...(originColumn === null ? {} : { displayCellColumn: originColumn }) },
      target: { documentVersion: snapshot.version, offset: target.at.offset, ...(targetColumn === null ? {} : { displayCellColumn: targetColumn }) },
      direction: member.direction,
      motionKind: member.kind === 'visual-line' ? 'linewise' : 'characterwise',
      inclusive: member.kind === 'visual-character' ? member.inclusive : true,
      motionKey: 'visual',
      ...(member.kind === 'visual-line' ? { forceKind: 'linewise' as const } : {}),
      ...(member.kind === 'visual-block' ? { forceKind: 'blockwise' as const, blockTabPolicy: 'preserve' as const } : {}),
    },
  };
}

// A `/pat<CR>` or `?pat<CR>` search-motion range from searchVimOperator. Its
// `linewise` flag (set by a numeric search-offset like `/pat/+1`) expands the
// range to whole lines via forceKind, reusing normalizeLinewise.
// nvim: :call setline(1,['one','two','three']) | normal! d/two/+1<CR> -> [''] (all 3 lines removed)
function searchMemberMotion(
  snapshot: DocumentSnapshot,
  range: VimOperatorSearchRange,
): Result<Omit<import('../ranges/normalize').VimOperatorRangeInput, 'operator'>, VimOperatorMotionFailure> {
  return {
    ok: true,
    value: {
      // range.start/end are already sorted low/high; the cursor (origin) is
      // whichever endpoint isn't the match (range.target).
      origin: { documentVersion: snapshot.version, offset: range.direction === 'forward' ? range.start : range.end },
      target: { documentVersion: snapshot.version, offset: range.target },
      direction: range.direction === 'forward' ? 'forward' : 'backward',
      motionKind: 'characterwise',
      inclusive: range.inclusive,
      motionKey: range.direction === 'forward' ? '/' : '?',
      ...(range.linewise ? { forceKind: 'linewise' as const } : {}),
    },
  };
}

// C3: Vim motion inclusivity is an explicit allow-list, not "everything
// except a few keys" — most motions (0 ^ | ( ) n N ` gg G H M L h l w W b B
// arrows...) are exclusive. Only these land on and must consume their own
// target character. Text objects (iw/aw/ip/...) are always inclusive — they
// already resolve to the exact span to act on.
// nvim: :call setline(1,['abcdef']) | normal! 03ld0 -> 'ef' (0 is exclusive: def is removed)
const INCLUSIVE_MOTION_KEYS: ReadonlySet<string> = new Set(['e', 'E', 'ge', 'gE', '$', 'g_', 'f', 'F', 't', 'T', '%']);

function operatorMotionInclusive(key: string): boolean {
  if (TEXT_OBJECT_KEYS.has(key)) return true;
  return INCLUSIVE_MOTION_KEYS.has(key);
}

function mapOperatorCursors(
  snapshot: DocumentSnapshot,
  edits: readonly DocumentEdit[],
  members: readonly VimMultiOperatorMember[],
): Result<readonly { readonly id: SelectionId; readonly offset: Utf16Offset }[], VimMultiOperatorFailure> {
  if (edits.length === 0) return { ok: true, value: Object.freeze(members.map((member) => Object.freeze({ id: member.id, offset: member.cursorOffset }))) };
  const afterVersion = ((snapshot.version as number) + 1) as DocumentSnapshot['version'];
  const changeMap = DocumentChangeMap.create(snapshot, afterVersion, edits);
  if (!changeMap.ok) return { ok: false, error: { kind: 'invalid-selection' } };
  const mapped: { id: SelectionId; offset: Utf16Offset }[] = [];
  for (const member of members) {
    const anchor = createDocumentAnchor(snapshot, member.cursorOffset, 'right');
    if (!anchor.ok) return { ok: false, error: { kind: 'invalid-selection' } };
    const next = changeMap.value.mapAnchor(anchor.value);
    if (!next.ok) return { ok: false, error: { kind: 'invalid-selection' } };
    mapped.push(Object.freeze({ id: member.id, offset: next.value.offset }));
  }
  return { ok: true, value: Object.freeze(mapped) };
}

function motionCursorForMember(
  snapshot: DocumentSnapshot,
  member: SelectionMember,
): Result<VimMotionCursor, VimMotionFailure> {
  const desired = member.desiredColumn.displayCell;
  const options: VimMotionOptions = desired === null ? {} : { tabSize: 8 };
  const cursor = createVimMotionCursor(snapshot, memberOffset(member), options);
  if (!cursor.ok || desired === null) return cursor;
  return { ok: true, value: Object.freeze({ ...cursor.value, desiredDisplayCellColumn: desired }) };
}

function normalMemberFromMotion(
  snapshot: DocumentSnapshot,
  source: SelectionMember,
  outcome: VimMotionOutcome,
): Result<SelectionMemberInput, VimMultiMotionFailure> {
  const endpoint = endpointForOffset(snapshot, outcome.cursor.offset);
  if (!endpoint.ok) return endpoint;
  const desired: DesiredColumn = Object.freeze({ logicalUtf16: source.desiredColumn.logicalUtf16, displayCell: outcome.cursor.desiredDisplayCellColumn });
  return { ok: true, value: { id: source.id, kind: 'normal-cursor', direction: 'forward', anchor: endpoint.value, head: endpoint.value, desiredColumn: desired, creationOrdinal: source.creationOrdinal as number } };
}

function endpointForOffset(snapshot: DocumentSnapshot, offset: Utf16Offset): Result<EndpointInput, VimMultiMotionFailure> {
  const line = snapshot.lineIndexAt(offset);
  if (!line.ok) return failure({ kind: 'selection-update-failed' });
  const start = snapshot.lineStartOffset(line.value);
  if (!start.ok) return failure({ kind: 'selection-update-failed' });
  const lineStart = start.value as number;
  const next = line.value as number + 1 < snapshot.lineCount ? snapshot.lineStartOffset((line.value as number + 1) as LineIndex) : null;
  if (next !== null && !next.ok) return failure({ kind: 'selection-update-failed' });
  const lineEnd = next?.ok === true ? (next.value as number) - 1 : snapshot.lengthUtf16;
  if ((offset as number) === snapshot.lengthUtf16 && snapshot.lengthUtf16 > lineEnd) return { ok: true, value: { kind: 'eof' } };
  // C8: bound the read to a small window instead of slicing the rest of the
  // line — only the first grapheme's length is needed.
  const windowEnd = Math.min(lineEnd, (offset as number) + 16);
  const content = snapshot.slice(offset, windowEnd as Utf16Offset);
  if (!content.ok) return failure({ kind: 'selection-update-failed' });
  if (content.value.length === 0) return { ok: true, value: { kind: 'empty-line', lineIndex: line.value } };
  const first = firstGrapheme(content.value);
  if (first === null) return failure({ kind: 'selection-update-failed' });
  return { ok: true, value: { kind: 'character', offset, after: (offset as number + first.length) as Utf16Offset } };
}

const MULTI_GRAPHEME_SEGMENTER = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('und', { granularity: 'grapheme' }) : undefined;

function firstGrapheme(text: string): string | null {
  if (MULTI_GRAPHEME_SEGMENTER !== undefined) {
    const first = MULTI_GRAPHEME_SEGMENTER.segment(text)[Symbol.iterator]().next();
    return first.done === true ? null : first.value.segment;
  }
  return [...text][0] ?? null;
}

function motionExtent(snapshot: DocumentSnapshot, source: Utf16Offset, outcome: VimMotionOutcome): Result<VimMotionPreviewExtent, VimMultiMotionFailure> {
  const destination = outcome.cursor.offset;
  if (outcome.kind === 'linewise') {
    const sourceLine = snapshot.lineIndexAt(source);
    const destinationLine = snapshot.lineIndexAt(destination);
    if (!sourceLine.ok || !destinationLine.ok) return failure({ kind: 'preview-failed' });
    const first = Math.min(sourceLine.value as number, destinationLine.value as number);
    const last = Math.max(sourceLine.value as number, destinationLine.value as number);
    const start = snapshot.lineStartOffset(first as LineIndex);
    if (!start.ok) return failure({ kind: 'preview-failed' });
    const next = last + 1 < snapshot.lineCount ? snapshot.lineStartOffset((last + 1) as LineIndex) : null;
    if (next !== null && !next.ok) return failure({ kind: 'preview-failed' });
    return { ok: true, value: Object.freeze({ kind: 'linewise', start: start.value, end: next?.ok === true ? ((next.value as number)) as Utf16Offset : snapshot.lengthUtf16 as Utf16Offset }) };
  }
  const low = Math.min(source as number, destination as number) as Utf16Offset;
  const high = Math.max(source as number, destination as number) as Utf16Offset;
  const endpoint = endpointForOffset(snapshot, high);
  if (!endpoint.ok) return endpoint;
  const end = endpoint.value.kind === 'character' ? endpoint.value.after : high;
  return { ok: true, value: Object.freeze({ kind: 'characterwise', start: low, end }) };
}

function visualCursorForMember(member: SelectionMember): VimVisualCursor {
  return Object.freeze({
    documentVersion: member.anchor.at.version,
    offset: member.head.at.offset,
    displayCellColumn: (member.head.kind === 'block-cell' ? member.head.displayCellColumn : member.desiredColumn.displayCell ?? 0) as CellColumn,
    ...(member.desiredColumn.logicalUtf16 === null ? {} : { desiredColumn: member.desiredColumn }),
  });
}

function visualCursorFromMotion(outcome: VimMotionOutcome): VimVisualCursor {
  return Object.freeze({ documentVersion: outcome.cursor.documentVersion, offset: outcome.cursor.offset, displayCellColumn: outcome.cursor.desiredDisplayCellColumn ?? 0 as CellColumn });
}

function memberOffset(member: SelectionMember): Utf16Offset { return member.head.at.offset; }

function memberInput(member: SelectionMember): SelectionMemberInput {
  const base = { id: member.id, direction: member.direction, anchor: endpointInput(member.anchor), head: endpointInput(member.head), desiredColumn: member.desiredColumn, creationOrdinal: member.creationOrdinal as number };
  switch (member.kind) {
    case 'normal-cursor': return { ...base, kind: member.kind };
    case 'insert-caret': return { ...base, kind: member.kind };
    case 'visual-character': return { ...base, kind: member.kind, inclusive: member.inclusive, anchorDesiredColumn: member.anchorDesiredColumn };
    case 'visual-line': return { ...base, kind: member.kind, anchorDesiredColumn: member.anchorDesiredColumn };
    case 'visual-block': return { ...base, kind: member.kind, anchorDesiredColumn: member.anchorDesiredColumn };
  }
}

function endpointInput(endpoint: SelectionEndpoint): EndpointInput {
  switch (endpoint.kind) {
    case 'character': return { kind: 'character', offset: endpoint.at.offset, after: endpoint.after.offset, affinity: endpoint.at.affinity, afterAffinity: endpoint.after.affinity };
    case 'empty-line': return { kind: 'empty-line', lineIndex: endpoint.lineIndex, affinity: endpoint.at.affinity };
    case 'eof': return { kind: 'eof', affinity: endpoint.at.affinity };
    case 'gap': return { kind: 'gap', offset: endpoint.at.offset, affinity: endpoint.at.affinity };
    case 'line': return { kind: 'line', lineIndex: endpoint.lineIndex, affinity: endpoint.at.affinity };
    case 'block-cell': return { kind: 'block-cell', offset: endpoint.at.offset, logicalUtf16Column: endpoint.logicalUtf16Column, displayCellColumn: endpoint.displayCellColumn, virtualCells: endpoint.virtualCells, affinity: endpoint.at.affinity };
  }
}

function isVisualMember(member: SelectionMember): member is Extract<SelectionMember, { readonly kind: 'visual-character' | 'visual-line' | 'visual-block' }> {
  return member.kind === 'visual-character' || member.kind === 'visual-line' || member.kind === 'visual-block';
}

function sameSelectionDocument(snapshot: DocumentSnapshot, selection: SelectionSetSnapshot): boolean {
  return selection.documentId === snapshot.id && selection.documentVersion === snapshot.version;
}

function cancelled(input: { readonly cancellation?: CancellationToken; readonly isCancelled?: () => boolean }): boolean {
  return input.cancellation?.isCancelled === true || input.isCancelled?.() === true;
}

function failure<E>(error: E): { readonly ok: false; readonly error: E } { return { ok: false, error }; }
