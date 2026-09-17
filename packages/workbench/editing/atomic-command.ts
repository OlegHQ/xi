import {
  DocumentChangeMap,
  type DocumentEdit,
  type DocumentSnapshot,
  type DocumentTransactionFailure,
  type EditProposal,
  type EditOrigin,
  type Result,
  type SerializedSelectionValue,
  type UndoGroupId,
  TextFileDocument,
} from '../../document/src/index';
import { createSelectionSet, mapSelectionSet } from '../../selections/src/index';
import type {
  SelectionMember,
  SelectionSet,
  SelectionSetInput,
} from '../../selections/src/index';
import { asIdentifier, cloneSerializedSelectionValue, type ViewId } from '../../contracts/src/index';
import { normalizeAtomicEdits } from '../../vim/src/index';
import type {
  AtomicEditConflict,
  AtomicMemberIntent,
  AtomicRegisterWrite,
  AtomicResolvedMember,
  AtomicSessionDelta,
} from '../../vim/src/index';
import type { VimMode } from '../../vim/src/index';

export interface AtomicViewState {
  readonly viewId: ViewId;
  readonly selections: SelectionSet;
  readonly mode: VimMode;
  readonly repeatTarget: SerializedSelectionValue;
}

export interface AtomicRegisterValue extends AtomicRegisterWrite {}

export interface AtomicWorkbenchState {
  /** Increments for each published selection or session-state transition. */
  readonly generation: number;
  readonly activeViewId: ViewId;
  readonly views: readonly AtomicViewState[];
  readonly registers: readonly AtomicRegisterValue[];
}

export interface AtomicWorkbenchStateInput {
  readonly activeViewId: ViewId;
  readonly views: readonly AtomicViewState[];
  readonly registers?: readonly AtomicRegisterValue[];
}

export type AtomicCommandFailure =
  | { readonly kind: 'invalid-state' }
  | { readonly kind: 'stale-document' }
  | { readonly kind: 'stale-selection' }
  | { readonly kind: 'stale-state' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'member-resolution-failed'; readonly memberIndex: number }
  | { readonly kind: 'session-reduction-failed' }
  | { readonly kind: 'selection-failed' }
  | { readonly kind: 'edit-conflict'; readonly conflict: AtomicEditConflict }
  | { readonly kind: 'preparation-failed'; readonly stage: AtomicPreparationStage }
  | { readonly kind: 'document-commit-failed'; readonly cause: DocumentTransactionFailure | 'commit-threw' | 'preview-diverged' }
  | { readonly kind: 'generation-overflow' };

export type AtomicPreparationStage =
  | 'resolve-member'
  | 'normalize-edits'
  | 'reduce-session'
  | 'preview-document'
  | 'prepare-selections'
  | 'prepare-session-state'
  | 'before-commit';

export interface AtomicCommandRequest<SharedIntent = unknown> {
  /** One grammar/parser result captured for the whole logical command. */
  readonly intent: SharedIntent;
  readonly undoGroup: UndoGroupId;
  /** Origin recorded in the document history for this atomic transaction. */
  readonly origin?: EditOrigin;
  readonly resolveMember: (
    base: DocumentSnapshot,
    member: SelectionMember,
    memberIndex: number,
    sharedIntent: SharedIntent,
  ) => AtomicMemberIntent | Promise<AtomicMemberIntent>;
  readonly reduceSession?: (
    before: AtomicWorkbenchState,
    activeView: AtomicViewState,
    outcomes: readonly AtomicResolvedMember[],
  ) => AtomicSessionDelta | Promise<AtomicSessionDelta>;
  readonly signal?: AbortSignal;
  /** Yield after this many resolved members; defaults to 128. */
  readonly yieldEveryMembers?: number;
  readonly yieldControl?: () => Promise<void>;
  /** Map the active view's anchors through the committed edit when no explicit next selection is supplied. */
  readonly mapActiveSelectionThroughChange?: boolean;
  /** Deterministic fault-injection/trace hook; it runs before publication. */
  readonly onPreparationStage?: (stage: AtomicPreparationStage, memberIndex?: number) => void;
}

export interface AtomicCommandOutcome {
  readonly kind: 'committed' | 'state-only';
  readonly state: AtomicWorkbenchState;
  readonly documentVersion: DocumentSnapshot['version'];
  readonly revisionId: DocumentSnapshot['revisionId'];
  readonly editCount: number;
}

/** Validate and defensively freeze workbench-owned session state. */
export function createAtomicWorkbenchState(
  snapshot: DocumentSnapshot,
  input: AtomicWorkbenchStateInput,
  generation = 0,
): Result<AtomicWorkbenchState, AtomicCommandFailure> {
  if (!Number.isSafeInteger(generation) || generation < 0 || !Array.isArray(input.views) || input.views.length === 0) {
    return { ok: false, error: { kind: 'invalid-state' } };
  }
  if (!asIdentifier<ViewId>(input.activeViewId, 'viewId').ok) return { ok: false, error: { kind: 'invalid-state' } };
  const ids = new Set<ViewId>();
  let hasActive = false;
  const views: AtomicViewState[] = [];
  for (const view of input.views) {
    if (!asIdentifier<ViewId>(view.viewId, 'viewId').ok || ids.has(view.viewId)
      || view.selections.documentId !== snapshot.id || view.selections.documentVersion !== snapshot.version
      || !selectionModeMatches(view.mode, view.selections)) {
      return { ok: false, error: { kind: 'invalid-state' } };
    }
    ids.add(view.viewId);
    if (view.viewId === input.activeViewId) hasActive = true;
    const repeatTarget = cloneSerializedSelectionValue(view.repeatTarget);
    if (!repeatTarget.ok) return { ok: false, error: { kind: 'invalid-state' } };
    views.push(Object.freeze({
      viewId: view.viewId,
      selections: view.selections,
      mode: view.mode,
      repeatTarget: repeatTarget.value,
    }));
  }
  if (!hasActive) return { ok: false, error: { kind: 'invalid-state' } };
  const registers = normalizeRegisterValues(input.registers ?? []);
  if (!registers.ok) return { ok: false, error: registers.error };
  return {
    ok: true,
    value: Object.freeze({
      generation,
      activeViewId: input.activeViewId,
      views: Object.freeze(views),
      registers: registers.value,
    }),
  };
}

/**
 * Workbench transaction barrier: every cursor resolves against one snapshot,
 * then one synchronous document commit publishes the already-installed state.
 */
export class AtomicCommandCoordinator {
  #state: AtomicWorkbenchState;
  #publishing = false;

  constructor(
    readonly document: TextFileDocument,
    initialState: AtomicWorkbenchState,
    readonly defaultYield: () => Promise<void> = yieldToEventLoop,
  ) {
    const checked = createAtomicWorkbenchState(document.snapshot(), initialState, initialState.generation);
    if (!checked.ok) throw new TypeError(`invalid-atomic-workbench-state:${checked.error.kind}`);
    this.#state = checked.value;
  }

  readState(): AtomicWorkbenchState { return this.#state; }

  /** Install an external immutable selection/session update, invalidating pending plans. */
  replaceState(input: AtomicWorkbenchStateInput): Result<AtomicWorkbenchState, AtomicCommandFailure> {
    if (this.#publishing) return { ok: false, error: { kind: 'stale-state' } };
    if (isSameAtomicState(this.#state, input)) return { ok: true, value: this.#state };
    if (this.#state.generation >= Number.MAX_SAFE_INTEGER) return { ok: false, error: { kind: 'generation-overflow' } };
    const checked = createAtomicWorkbenchState(this.document.snapshot(), input, this.#state.generation + 1);
    if (!checked.ok) return checked;
    this.#state = checked.value;
    return { ok: true, value: this.#state };
  }

  async execute<SharedIntent>(request: AtomicCommandRequest<SharedIntent>): Promise<Result<AtomicCommandOutcome, AtomicCommandFailure>> {
    const beforeState = this.#state;
    const base = this.document.snapshot();
    const active = beforeState.views.find((view) => view.viewId === beforeState.activeViewId);
    if (active === undefined || beforeState.generation >= Number.MAX_SAFE_INTEGER) {
      return { ok: false, error: { kind: active === undefined ? 'invalid-state' : 'generation-overflow' } };
    }
    if (active.selections.documentId !== base.id) return { ok: false, error: { kind: 'stale-selection' } };
    if (active.selections.documentVersion !== base.version) return { ok: false, error: { kind: 'stale-selection' } };
    const isFresh = (): AtomicCommandFailure | undefined => {
      if (request.signal?.aborted === true) return { kind: 'cancelled' };
      if (this.#state !== beforeState) return { kind: 'stale-state' };
      if (this.document.version !== base.version) return { kind: 'stale-document' };
      return undefined;
    };
    const stage = (name: AtomicPreparationStage, memberIndex?: number): Result<void, AtomicCommandFailure> => {
      try {
        request.onPreparationStage?.(name, memberIndex);
      } catch {
        return { ok: false, error: { kind: 'preparation-failed', stage: name } };
      }
      const stale = isFresh();
      return stale === undefined ? { ok: true, value: undefined } : { ok: false, error: stale };
    };
    const outcomes: AtomicResolvedMember[] = [];
    const yieldEvery = request.yieldEveryMembers ?? 128;
    if (!Number.isSafeInteger(yieldEvery) || yieldEvery < 1) return { ok: false, error: { kind: 'invalid-state' } };
    for (let memberIndex = 0; memberIndex < active.selections.members.length; memberIndex += 1) {
      const member = active.selections.members[memberIndex];
      if (member === undefined) return { ok: false, error: { kind: 'selection-failed' } };
      const beforeResolve = stage('resolve-member', memberIndex);
      if (!beforeResolve.ok) return beforeResolve;
      let intent: AtomicMemberIntent;
      try {
        intent = await request.resolveMember(base, member, memberIndex, request.intent);
      } catch {
        return { ok: false, error: { kind: 'member-resolution-failed', memberIndex } };
      }
      const afterResolve = isFresh();
      if (afterResolve !== undefined) return { ok: false, error: afterResolve };
      if (intent === null || typeof intent !== 'object' || !Array.isArray(intent.edits)) {
        return { ok: false, error: { kind: 'member-resolution-failed', memberIndex } };
      }
      outcomes.push(Object.freeze({ source: member, nextSelection: intent.nextSelection, edits: Object.freeze([...intent.edits]) }));
      if ((memberIndex + 1) % yieldEvery === 0 && memberIndex + 1 < active.selections.members.length) {
        try { await (request.yieldControl ?? this.defaultYield)(); }
        catch { return { ok: false, error: { kind: 'preparation-failed', stage: 'resolve-member' } }; }
        const afterYield = isFresh();
        if (afterYield !== undefined) return { ok: false, error: afterYield };
      }
    }

    const normalizedStage = stage('normalize-edits');
    if (!normalizedStage.ok) return normalizedStage;
    const combined = normalizeAtomicEdits(base, outcomes.flatMap((outcome) => outcome.edits));
    if (!combined.ok) return { ok: false, error: combined.error };

    const reduceStage = stage('reduce-session');
    if (!reduceStage.ok) return reduceStage;
    let delta: AtomicSessionDelta;
    try {
      delta = await request.reduceSession?.(beforeState, active, Object.freeze(outcomes)) ?? {};
    } catch {
      return { ok: false, error: { kind: 'session-reduction-failed' } };
    }
    if (typeof delta !== 'object' || delta === null) return { ok: false, error: { kind: 'session-reduction-failed' } };
    const reductionFresh = isFresh();
    if (reductionFresh !== undefined) return { ok: false, error: reductionFresh };

    const previewStage = stage('preview-document');
    if (!previewStage.ok) return previewStage;
    const candidateResult = this.document.previewTextEdits(combined.value, base.version);
    if (!candidateResult.ok) return { ok: false, error: { kind: 'document-commit-failed', cause: candidateResult.error } };
    const candidate = candidateResult.value;
    const textChanged = candidate.version !== base.version;
    let changeMap: DocumentChangeMap | undefined;
    if (textChanged) {
      const mapped = DocumentChangeMap.create(base, candidate.version, combined.value);
      if (!mapped.ok) return { ok: false, error: { kind: 'document-commit-failed', cause: mapped.error } };
      changeMap = mapped.value;
    }

    const selectionStage = stage('prepare-selections');
    if (!selectionStage.ok) return selectionStage;
    const nextActive = request.mapActiveSelectionThroughChange === true && changeMap !== undefined
      ? mapSelectionSet(active.selections, changeMap, candidate)
      : createSelectionSet(candidate, {
        primaryId: active.selections.primaryId,
        members: outcomes.map((outcome) => outcome.nextSelection),
        selectionGeneration: (active.selections.selectionGeneration as number) + 1,
      });
    if (!nextActive.ok) return { ok: false, error: { kind: 'selection-failed' } };
    const nextViews: AtomicViewState[] = [];
    let nextRepeatTarget = active.repeatTarget;
    if (delta.repeatTarget !== undefined) {
      const clonedRepeatTarget = cloneSerializedSelectionValue(delta.repeatTarget);
      if (!clonedRepeatTarget.ok) return { ok: false, error: { kind: 'session-reduction-failed' } };
      nextRepeatTarget = clonedRepeatTarget.value;
    }
    for (const view of beforeState.views) {
      if (view.viewId === active.viewId) {
        nextViews.push(Object.freeze({
          ...view,
          selections: nextActive.value.selectionSet,
          mode: delta.mode ?? view.mode,
          repeatTarget: nextRepeatTarget,
        }));
        continue;
      }
      if (changeMap === undefined) {
        nextViews.push(view);
        continue;
      }
      const mapped = mapSelectionSet(view.selections, changeMap, candidate);
      if (!mapped.ok) return { ok: false, error: { kind: 'selection-failed' } };
      nextViews.push(Object.freeze({ ...view, selections: mapped.value.selectionSet }));
    }

    const sessionStage = stage('prepare-session-state');
    if (!sessionStage.ok) return sessionStage;
    const activeIndex = nextViews.findIndex((view) => view.viewId === active.viewId);
    if (activeIndex < 0 || nextViews[activeIndex] === undefined) return { ok: false, error: { kind: 'invalid-state' } };
    const registers = applyRegisterWrites(beforeState.registers, delta.registerWrites ?? []);
    if (!registers.ok) return { ok: false, error: registers.error };
    const nextStateResult = createAtomicWorkbenchState(candidate, {
      activeViewId: beforeState.activeViewId,
      views: nextViews,
      registers: registers.value,
    }, beforeState.generation + 1);
    if (!nextStateResult.ok) return nextStateResult;

    const commitStage = stage('before-commit');
    if (!commitStage.ok) return commitStage;
    if (this.#state !== beforeState || this.document.version !== base.version || request.signal?.aborted === true) {
      return { ok: false, error: isFresh() ?? { kind: 'stale-state' } };
    }
    const nextState = nextStateResult.value;
    if (!textChanged) {
      this.#state = nextState;
      return {
        ok: true,
        value: Object.freeze({
          kind: 'state-only',
          state: nextState,
          documentVersion: base.version,
          revisionId: base.revisionId,
          editCount: 0,
        }),
      };
    }

    const proposal: EditProposal = {
      documentId: base.id,
      expectedVersion: base.version,
      edits: combined.value,
      origin: request.origin ?? 'vim',
      undoGroup: request.undoGroup,
      selectionHistory: Object.freeze({
        before: serializeViewState(active),
        after: serializeViewState(nextState.views[activeIndex] ?? active),
      }),
    };
    this.#publishing = true;
    this.#state = nextState;
    try {
      const committed = this.document.commit(proposal);
      if (!committed.ok) {
        this.#state = beforeState;
        return { ok: false, error: { kind: 'document-commit-failed', cause: committed.error } };
      }
      if (committed.value.kind !== 'committed' || committed.value.change.after !== candidate.version) {
        this.#state = beforeState;
        return { ok: false, error: { kind: 'document-commit-failed', cause: 'preview-diverged' } };
      }
      return {
        ok: true,
        value: Object.freeze({
          kind: 'committed',
          state: nextState,
          documentVersion: committed.value.change.after,
          revisionId: committed.value.change.afterRevisionId,
          editCount: combined.value.length,
        }),
      };
    } catch {
      this.#state = beforeState;
      return { ok: false, error: { kind: 'document-commit-failed', cause: 'commit-threw' } };
    } finally {
      this.#publishing = false;
    }
  }
}

/**
 * Cheap reference-equality check: a `replaceState` call whose views already
 * match the installed state (same selections/mode/repeatTarget objects, in
 * the same order) is a no-op republish and can skip validation, cloning and
 * a generation bump entirely. Callers that rebuild every view's wrapper
 * object per key (e.g. workbench session sync) rely on this to collapse
 * redundant calls instead of paying full state reconstruction each time.
 */
function isSameAtomicState(current: AtomicWorkbenchState, input: AtomicWorkbenchStateInput): boolean {
  if (current.activeViewId !== input.activeViewId) return false;
  if (input.registers !== undefined && input.registers !== current.registers) return false;
  if (input.views.length !== current.views.length) return false;
  for (let index = 0; index < input.views.length; index += 1) {
    const before = current.views[index];
    const after = input.views[index];
    if (before === undefined || after === undefined) return false;
    if (before.viewId !== after.viewId || before.selections !== after.selections
      || before.mode !== after.mode || before.repeatTarget !== after.repeatTarget) return false;
  }
  return true;
}

function applyRegisterWrites(
  current: readonly AtomicRegisterValue[],
  writes: readonly AtomicRegisterValue[],
): Result<readonly AtomicRegisterValue[], AtomicCommandFailure> {
  const values = new Map(current.map((register) => [register.name, register.value] as const));
  for (const write of writes) {
    if (!isRegisterName(write.name)) return { ok: false, error: { kind: 'session-reduction-failed' } };
    const value = cloneSerializedSelectionValue(write.value);
    if (!value.ok) return { ok: false, error: { kind: 'session-reduction-failed' } };
    values.set(write.name, value.value);
  }
  return { ok: true, value: Object.freeze([...values.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => Object.freeze({ name, value }))) };
}

function normalizeRegisterValues(values: readonly AtomicRegisterValue[]): Result<readonly AtomicRegisterValue[], AtomicCommandFailure> {
  const seen = new Set<string>();
  const normalized: AtomicRegisterValue[] = [];
  for (const value of values) {
    if (!isRegisterName(value.name) || seen.has(value.name)) return { ok: false, error: { kind: 'invalid-state' } };
    seen.add(value.name);
    const cloned = cloneSerializedSelectionValue(value.value);
    if (!cloned.ok) return { ok: false, error: { kind: 'invalid-state' } };
    normalized.push(Object.freeze({ name: value.name, value: cloned.value }));
  }
  normalized.sort((left, right) => left.name.localeCompare(right.name));
  return { ok: true, value: Object.freeze(normalized) };
}

function serializeViewState(view: AtomicViewState): SerializedSelectionValue {
  return Object.freeze({
    viewId: view.viewId,
    documentId: view.selections.documentId,
    documentVersion: view.selections.documentVersion as number,
    mode: view.mode,
    primaryId: view.selections.primaryId,
    selectionGeneration: view.selections.selectionGeneration as number,
    members: Object.freeze(view.selections.members.map((member) => ({
      id: member.id,
      kind: member.kind,
      creationOrdinal: member.creationOrdinal as number,
      direction: member.direction,
      anchor: serializeEndpoint(member.anchor),
      head: serializeEndpoint(member.head),
      desiredColumn: {
        logicalUtf16: member.desiredColumn.logicalUtf16,
        displayCell: member.desiredColumn.displayCell,
      },
      ...(member.kind === 'visual-character' ? { inclusive: member.inclusive } : {}),
      ...(member.kind === 'visual-line' ? { anchorDesiredColumn: {
        logicalUtf16: member.anchorDesiredColumn.logicalUtf16,
        displayCell: member.anchorDesiredColumn.displayCell,
      } } : {}),
    }))),
  });
}

function serializeEndpoint(endpoint: SelectionMember['anchor']): SerializedSelectionValue {
  const common = { kind: endpoint.kind, offset: endpoint.at.offset as number, affinity: endpoint.at.affinity };
  switch (endpoint.kind) {
    case 'character': return Object.freeze({ ...common, after: endpoint.after.offset as number, afterAffinity: endpoint.after.affinity });
    case 'empty-line':
    case 'line': return Object.freeze({ ...common, lineIndex: endpoint.lineIndex as number });
    case 'block-cell': return Object.freeze({ ...common, lineIndex: endpoint.lineIndex as number, logicalUtf16Column: endpoint.logicalUtf16Column as number, displayCellColumn: endpoint.displayCellColumn as number, virtualCells: endpoint.virtualCells });
    case 'eof':
    case 'gap': return Object.freeze(common);
  }
}

function isRegisterName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 32 && value.trim() === value && !value.includes('\0');
}

function selectionModeMatches(mode: VimMode, selections: SelectionSet): boolean {
  const member = selections.members[0];
  if (member === undefined) return false;
  switch (mode) {
    case 'normal': return member.kind === 'normal-cursor';
    case 'insert':
    case 'replace':
    case 'virtual-replace': return member.kind === 'insert-caret';
    case 'visual-character': return member.kind === 'visual-character';
    case 'visual-line': return member.kind === 'visual-line';
    case 'visual-block': return member.kind === 'visual-block';
    case 'select-character': return member.kind === 'visual-character';
    case 'select-line': return member.kind === 'visual-line';
    case 'select-block': return member.kind === 'visual-block';
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
