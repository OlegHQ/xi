import {
  DocumentChangeMap,
  createDocumentAnchor,
  type CommittedDocumentChange,
  type DocumentAnchor,
  type DocumentSnapshot,
  type RevisionId,
  type UndoOperationFailure,
  type UndoOutcome,
  type CellColumn,
  type LineIndex,
  type SerializedSelectionValue,
  type Utf16Column,
  type Utf16Offset,
} from '../../document/src/index';
import { createSelectionSet, mapSelectionSet } from '../../selections/src/index';
import type {
  BlockCellEndpoint,
  CharacterEndpoint,
  EmptyLineEndpoint,
  EofEndpoint,
  GapEndpoint,
  LineEndpoint,
  SelectionEndpoint,
  SelectionMember,
  SelectionMemberInput,
  SelectionSet,
  SelectionSetInput,
} from '../../selections/src/index';
import {
  asIdentifier,
  cloneSerializedSelectionValue,
  type DocumentId,
  type DocumentVersion,
  type Result,
  type SelectionId,
  type ViewId,
} from '../../contracts/src/index';
import { VimSelectionHistory } from '../../vim/src/index';
import type { SelectionOnlyHistoryFailure, VimMode } from '../../vim/src/index';
import {
  createAtomicWorkbenchState,
  type AtomicCommandCoordinator,
  type AtomicCommandFailure,
  type AtomicViewState,
  type AtomicWorkbenchState,
} from './atomic-command';

export type WorkbenchHistoryFailure =
  | { readonly kind: 'document-undo-failed'; readonly cause: UndoOperationFailure }
  | { readonly kind: 'document-redo-failed'; readonly cause: UndoOperationFailure }
  | { readonly kind: 'selection-history-failed'; readonly cause: SelectionOnlyHistoryFailure }
  | { readonly kind: 'selection-failed' }
  | { readonly kind: 'state-failed'; readonly cause: AtomicCommandFailure }
  | { readonly kind: 'history-mapping-failed'; readonly viewId: ViewId };

export interface DocumentHistoryTransition {
  readonly kind: 'undone' | 'redone';
  readonly outcome: UndoOutcome;
  readonly state: AtomicWorkbenchState;
  readonly restoredOrigin: boolean;
}

export interface SelectionHistoryTransition {
  readonly kind: 'selection-undone' | 'selection-redone';
  readonly state: AtomicWorkbenchState;
}

export type HistoryChangeListener = (failure: WorkbenchHistoryFailure) => void;

/**
 * Applies document history outcomes to live view selection state and owns the
 * independent bounded history for selection-only commands. Construct this next
 * to the atomic command coordinator, before UI/service change observers.
 */
export class WorkbenchHistoryCoordinator {
  readonly #atomic: AtomicCommandCoordinator;
  readonly #selectionHistories = new Map<ViewId, VimSelectionHistory>();
  readonly #listeners = new Set<HistoryChangeListener>();
  readonly #subscription: { dispose(): void };
  #lastFailure: WorkbenchHistoryFailure | undefined;
  #disposed = false;

  constructor(atomic: AtomicCommandCoordinator) {
    this.#atomic = atomic;
    this.#subscription = atomic.document.subscribeChanges((change) => this.onDocumentChange(change));
  }

  get lastFailure(): WorkbenchHistoryFailure | undefined { return this.#lastFailure; }

  subscribeFailures(listener: HistoryChangeListener): { dispose(): void } {
    this.#listeners.add(listener);
    return { dispose: () => { this.#listeners.delete(listener); } };
  }

  /** Release a closed view's independent selection history immediately. */
  closeView(viewId: ViewId): void {
    this.#selectionHistories.delete(viewId);
  }

  /**
   * Record and publish one selection-only transition for a live view. Selection
   * endpoints use validated UTF-16 offsets and both sets belong to the current
   * document version; the operation does not create a text-history entry.
   */
  recordSelectionTransition(
    viewId: ViewId,
    nextView: AtomicViewState,
  ): Result<AtomicWorkbenchState, WorkbenchHistoryFailure> {
    if (this.#disposed) return stateFailure({ kind: 'invalid-state' });
    const before = this.#atomic.readState();
    const prior = before.views.find((view) => view.viewId === viewId);
    if (prior === undefined || nextView.viewId !== viewId || nextView.selections.documentVersion !== this.#atomic.document.version) {
      return { ok: false, error: { kind: 'selection-failed' } };
    }
    const views = before.views.map((view) => view.viewId === viewId ? nextView : view);
    const checked = createAtomicWorkbenchState(this.#atomic.document.snapshot(), {
      activeViewId: before.activeViewId,
      views,
      registers: before.registers,
    }, before.generation + 1);
    if (!checked.ok) return stateFailure(checked.error);

    const history = this.historyFor(viewId);
    const recorded = history.record(serializeView(prior), serializeView(nextView));
    if (!recorded.ok) return { ok: false, error: { kind: 'selection-history-failed', cause: recorded.error } };
    const replaced = this.#atomic.replaceState({
      activeViewId: checked.value.activeViewId,
      views: checked.value.views,
      registers: checked.value.registers,
    });
    if (!replaced.ok) {
      return { ok: false, error: { kind: 'state-failed', cause: replaced.error } };
    }
    return { ok: true, value: replaced.value };
  }

  selectionUndo(): Result<SelectionHistoryTransition, WorkbenchHistoryFailure> {
    return this.restoreSelectionOnly('undo');
  }

  selectionRedo(): Result<SelectionHistoryTransition, WorkbenchHistoryFailure> {
    return this.restoreSelectionOnly('redo');
  }

  undo(): Result<DocumentHistoryTransition, WorkbenchHistoryFailure> {
    const invocation = this.#atomic.readState();
    const outcome = this.#atomic.document.undo();
    if (!outcome.ok) return { ok: false, error: { kind: 'document-undo-failed', cause: outcome.error } };
    const restoredOrigin = this.restoreDocumentSelection(invocation, outcome.value);
    return {
      ok: true,
      value: Object.freeze({ kind: 'undone', outcome: outcome.value, state: this.#atomic.readState(), restoredOrigin }),
    };
  }

  redo(branchId?: RevisionId): Result<DocumentHistoryTransition, WorkbenchHistoryFailure> {
    const invocation = this.#atomic.readState();
    const outcome = this.#atomic.document.redo(branchId);
    if (!outcome.ok) return { ok: false, error: { kind: 'document-redo-failed', cause: outcome.error } };
    const restoredOrigin = this.restoreDocumentSelection(invocation, outcome.value);
    return {
      ok: true,
      value: Object.freeze({ kind: 'redone', outcome: outcome.value, state: this.#atomic.readState(), restoredOrigin }),
    };
  }

  /** Dispose subscriptions and release per-view history, including closed views. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#subscription.dispose();
    this.#selectionHistories.clear();
    this.#listeners.clear();
  }

  private restoreSelectionOnly(direction: 'undo' | 'redo'): Result<SelectionHistoryTransition, WorkbenchHistoryFailure> {
    if (this.#disposed) return { ok: false, error: { kind: 'selection-failed' } };
    const before = this.#atomic.readState();
    const view = before.views.find((candidate) => candidate.viewId === before.activeViewId);
    if (view === undefined) return { ok: false, error: { kind: 'selection-failed' } };
    const history = this.#selectionHistories.get(view.viewId);
    if (history === undefined) {
      return { ok: false, error: { kind: 'selection-history-failed', cause: { kind: direction === 'undo' ? 'nothing-to-undo' : 'nothing-to-redo' } } };
    }
    const current = serializeView(view);
    const restored = direction === 'undo' ? history.undo(current) : history.redo(current);
    if (!restored.ok) return { ok: false, error: { kind: 'selection-history-failed', cause: restored.error } };
    const decoded = restoreView(restored.value, this.#atomic.document.snapshot(), view.selections.selectionGeneration as number + 1, view.repeatTarget);
    if (!decoded.ok || decoded.value.viewId !== view.viewId) {
      return { ok: false, error: { kind: 'selection-history-failed', cause: { kind: 'unmappable-history' } } };
    }
    const views = before.views.map((candidate) => candidate.viewId === view.viewId ? decoded.value : candidate);
    const replaced = this.#atomic.replaceState({ activeViewId: before.activeViewId, views, registers: before.registers });
    if (!replaced.ok) return stateFailure(replaced.error);
    return {
      ok: true,
      value: Object.freeze({ kind: direction === 'undo' ? 'selection-undone' : 'selection-redone', state: replaced.value }),
    };
  }

  private restoreDocumentSelection(invocation: AtomicWorkbenchState, outcome: UndoOutcome): boolean {
    const raw = outcome.restoredSelection;
    if (raw === undefined) return false;
    const identity = readViewIdentity(raw);
    if (identity === undefined || identity.viewId !== invocation.activeViewId) return false;
    const latest = this.#atomic.readState();
    const currentOrigin = latest.views.find((view) => view.viewId === identity.viewId);
    if (currentOrigin === undefined) return false;
    const decoded = restoreView(raw, this.#atomic.document.snapshot(), currentOrigin.selections.selectionGeneration as number + 1, currentOrigin.repeatTarget);
    if (!decoded.ok) {
      this.report({ kind: 'history-mapping-failed', viewId: identity.viewId });
      return false;
    }
    const views = latest.views.map((view) => view.viewId === identity.viewId ? decoded.value : view);
    const replaced = this.#atomic.replaceState({ activeViewId: latest.activeViewId, views, registers: latest.registers });
    if (!replaced.ok) {
      this.report({ kind: 'state-failed', cause: replaced.error });
      return false;
    }
    return true;
  }

  private onDocumentChange(change: CommittedDocumentChange): void {
    if (this.#disposed) return;
    const state = this.#atomic.readState();
    const views: AtomicViewState[] = [];
    let needsStateUpdate = false;
    for (const view of state.views) {
      if (view.selections.documentId === change.documentId && view.selections.documentVersion === change.after) {
        views.push(view);
        continue;
      }
      if (view.selections.documentId !== change.documentId || view.selections.documentVersion !== change.before) {
        this.report({ kind: 'history-mapping-failed', viewId: view.viewId });
        views.push(view);
        continue;
      }
      const mapped = mapSelectionSet(view.selections, change.changeMap, change.snapshot);
      if (!mapped.ok) {
        this.report({ kind: 'history-mapping-failed', viewId: view.viewId });
        views.push(view);
        continue;
      }
      views.push(Object.freeze({ ...view, selections: mapped.value.selectionSet }));
      needsStateUpdate = true;
    }

    const liveIds = new Set(views.map((view) => view.viewId));
    for (const viewId of this.#selectionHistories.keys()) {
      if (!liveIds.has(viewId)) this.#selectionHistories.delete(viewId);
    }
    for (const [viewId, history] of this.#selectionHistories) {
      history.map((value) => mapSerializedView(value, change));
      if (!liveIds.has(viewId)) this.#selectionHistories.delete(viewId);
    }

    if (!needsStateUpdate) return;
    const replaced = this.#atomic.replaceState({
      activeViewId: state.activeViewId,
      views,
      registers: state.registers,
    });
    if (!replaced.ok) {
      for (const view of views) {
        if (view.selections.documentVersion !== change.after) this.report({ kind: 'history-mapping-failed', viewId: view.viewId });
      }
    }
  }

  private historyFor(viewId: ViewId): VimSelectionHistory {
    let history = this.#selectionHistories.get(viewId);
    if (history === undefined) {
      history = new VimSelectionHistory();
      this.#selectionHistories.set(viewId, history);
    }
    return history;
  }

  private report(failure: WorkbenchHistoryFailure): void {
    this.#lastFailure = failure;
    for (const listener of this.#listeners) listener(failure);
  }
}

function serializeView(view: AtomicViewState): SerializedSelectionValue {
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

function serializeEndpoint(endpoint: SelectionEndpoint): SerializedSelectionValue {
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

function restoreView(
  raw: SerializedSelectionValue,
  snapshot: DocumentSnapshot,
  selectionGeneration: number,
  repeatTarget: SerializedSelectionValue,
): Result<AtomicViewState, 'invalid'> {
  if (!isObject(raw)) return invalid();
  const viewId = asIdentifier<ViewId>(raw.viewId, 'viewId');
  const primaryId = asIdentifier<SelectionId>(raw.primaryId, 'selectionId');
  if (!viewId.ok || !primaryId.ok || !isMode(raw.mode) || !Array.isArray(raw.members)) return invalid();
  if (raw.documentId !== undefined && raw.documentId !== snapshot.id) return invalid();
  const inputs: SelectionMemberInput[] = [];
  for (let index = 0; index < raw.members.length; index += 1) {
    const member = raw.members[index];
    if (!isObject(member)) return invalid();
    const id = asIdentifier<SelectionId>(member.id, 'selectionId');
    if (!id.ok || !isSelectionKind(member.kind) || (member.direction !== 'forward' && member.direction !== 'backward')) return invalid();
    const direction: 'forward' | 'backward' = member.direction === 'forward' ? 'forward' : 'backward';
    const anchor = endpointInput(member.anchor);
    const head = endpointInput(member.head);
    const desiredColumn = parseDesiredColumn(member.desiredColumn);
    if (anchor === undefined || head === undefined || desiredColumn === undefined) return invalid();
    const ordinal = member.creationOrdinal === undefined ? index : member.creationOrdinal;
    if (!Number.isSafeInteger(ordinal) || (ordinal as number) < 0) return invalid();
    const base = {
      id: id.value,
      direction,
      anchor,
      head,
      desiredColumn,
      creationOrdinal: ordinal as number,
    };
    switch (member.kind) {
      case 'normal-cursor': inputs.push({ ...base, kind: member.kind }); break;
      case 'insert-caret': inputs.push({ ...base, kind: member.kind }); break;
      case 'visual-character':
        if (typeof member.inclusive !== 'boolean') return invalid();
        inputs.push({ ...base, kind: member.kind, inclusive: member.inclusive });
        break;
      case 'visual-line': {
        const anchorDesiredColumn = member.anchorDesiredColumn === undefined ? desiredColumn : parseDesiredColumn(member.anchorDesiredColumn);
        if (anchorDesiredColumn === undefined) return invalid();
        inputs.push({ ...base, kind: member.kind, anchorDesiredColumn });
        break;
      }
      case 'visual-block': inputs.push({ ...base, kind: member.kind }); break;
    }
  }
  const created = createSelectionSet(snapshot, {
    primaryId: primaryId.value,
    selectionGeneration,
    members: inputs,
  });
  if (!created.ok) return invalid();
  const clonedRepeat = cloneSerializedSelectionValue(repeatTarget);
  if (!clonedRepeat.ok) return invalid();
  return {
    ok: true,
    value: Object.freeze({
      viewId: viewId.value,
      selections: created.value.selectionSet,
      mode: raw.mode,
      repeatTarget: clonedRepeat.value,
    }),
  };
}

function mapSerializedView(value: SerializedSelectionValue, change: CommittedDocumentChange): Result<SerializedSelectionValue, string> {
  if (!isObject(value) || value.documentId !== change.documentId || value.documentVersion !== change.before) {
    return { ok: false, error: 'history-source-version-mismatch' };
  }
  const identity = readViewIdentity(value);
  if (identity === undefined) return { ok: false, error: 'invalid-history-view' };
  const pseudoBefore = makeAnchorSnapshot(change.documentId, change.before, change.snapshot.lengthUtf16 as number - netEditDelta(change.changeMap));
  const set = selectionSetForMapping(value, pseudoBefore);
  if (!set.ok) return set;
  const mapped = mapSelectionSet(set.value, change.changeMap, change.snapshot);
  if (!mapped.ok) return { ok: false, error: mapped.error.kind };
  return {
    ok: true,
    value: serializeMappedView(value, mapped.value.selectionSet, change.snapshot.version),
  };
}

function selectionSetForMapping(value: Record<string, unknown>, source: DocumentSnapshot): Result<SelectionSet, string> {
  if (!Array.isArray(value.members)) return { ok: false, error: 'invalid-history-members' };
  const primary = asIdentifier<SelectionId>(value.primaryId, 'selectionId');
  const docId = asIdentifier<DocumentId>(value.documentId, 'documentId');
  const version = safeInteger(value.documentVersion);
  const generation = value.selectionGeneration;
  if (!primary.ok || !docId.ok || version === undefined || !Number.isSafeInteger(generation) || (generation as number) < 0) return { ok: false, error: 'invalid-history-header' };
  const members: SelectionMember[] = [];
  for (const candidate of value.members) {
    if (!isObject(candidate)) return { ok: false, error: 'invalid-history-member' };
    const id = asIdentifier<SelectionId>(candidate.id, 'selectionId');
    const anchor = endpointFromSerialized(candidate.anchor, source);
    const head = endpointFromSerialized(candidate.head, source);
    const desired = parseDesiredColumn(candidate.desiredColumn);
    const ordinal = candidate.creationOrdinal;
    if (!id.ok || anchor === undefined || head === undefined || desired === undefined
      || !isSelectionKind(candidate.kind) || (candidate.direction !== 'forward' && candidate.direction !== 'backward')
      || !Number.isSafeInteger(ordinal) || (ordinal as number) < 0) return { ok: false, error: 'invalid-history-member' };
    const direction: 'forward' | 'backward' = candidate.direction === 'forward' ? 'forward' : 'backward';
    const common = {
      id: id.value,
      kind: candidate.kind,
      creationOrdinal: ordinal as SelectionMember['creationOrdinal'],
      direction,
      anchor,
      head,
      desiredColumn: desired,
    };
    switch (candidate.kind) {
      case 'normal-cursor': members.push(Object.freeze(common) as SelectionMember); break;
      case 'insert-caret': members.push(Object.freeze(common) as SelectionMember); break;
      case 'visual-character':
        if (typeof candidate.inclusive !== 'boolean') return { ok: false, error: 'invalid-history-member' };
        members.push(Object.freeze({ ...common, inclusive: candidate.inclusive }) as SelectionMember);
        break;
      case 'visual-line': {
        const anchorDesiredColumn = parseDesiredColumn(candidate.anchorDesiredColumn) ?? desired;
        members.push(Object.freeze({ ...common, anchorDesiredColumn }) as SelectionMember);
        break;
      }
      case 'visual-block': members.push(Object.freeze(common) as SelectionMember); break;
    }
  }
  if (members.length === 0) return { ok: false, error: 'invalid-history-members' };
  return {
    ok: true,
    value: Object.freeze({
      documentId: docId.value,
      documentVersion: version as DocumentVersion,
      selectionGeneration: generation as SelectionSet['selectionGeneration'],
      primaryId: primary.value,
      members: Object.freeze(members) as unknown as SelectionSet['members'],
    }),
  };
}

function endpointFromSerialized(value: unknown, snapshot: DocumentSnapshot): SelectionEndpoint | undefined {
  if (!isObject(value) || typeof value.kind !== 'string') return undefined;
  const offset = checkedOffset(value.offset);
  const affinity = value.affinity === undefined ? 'right' : value.affinity;
  if (!offset.ok || (affinity !== 'left' && affinity !== 'right')) return undefined;
  const at = createDocumentAnchor(snapshot, offset.value, affinity);
  if (!at.ok) return undefined;
  switch (value.kind) {
    case 'character': {
      const after = checkedOffset(value.after);
      const afterAffinity = value.afterAffinity === undefined ? 'right' : value.afterAffinity;
      if (!after.ok || (afterAffinity !== 'left' && afterAffinity !== 'right')) return undefined;
      const end = createDocumentAnchor(snapshot, after.value, afterAffinity);
      return end.ok ? Object.freeze({ kind: 'character', at: at.value, after: end.value }) satisfies CharacterEndpoint : undefined;
    }
    case 'empty-line': {
      const line = checkedLine(value.lineIndex);
      return line.ok ? Object.freeze({ kind: 'empty-line', at: at.value, lineIndex: line.value }) satisfies EmptyLineEndpoint : undefined;
    }
    case 'eof': return Object.freeze({ kind: 'eof', at: at.value }) satisfies EofEndpoint;
    case 'gap': return Object.freeze({ kind: 'gap', at: at.value }) satisfies GapEndpoint;
    case 'line': {
      const line = checkedLine(value.lineIndex);
      return line.ok ? Object.freeze({ kind: 'line', at: at.value, lineIndex: line.value }) satisfies LineEndpoint : undefined;
    }
    case 'block-cell': {
      const line = checkedLine(value.lineIndex);
      const logical = checkedUtf16Column(value.logicalUtf16Column);
      const display = checkedCellColumn(value.displayCellColumn);
      const virtualCells = value.virtualCells;
      if (!line.ok || !logical.ok || !display.ok || !Number.isSafeInteger(virtualCells) || (virtualCells as number) < 0) return undefined;
      return Object.freeze({ kind: 'block-cell', at: at.value, lineIndex: line.value, logicalUtf16Column: logical.value, displayCellColumn: display.value, virtualCells: virtualCells as number }) satisfies BlockCellEndpoint;
    }
    default: return undefined;
  }
}

function serializeMappedView(value: Record<string, unknown>, selections: SelectionSet, documentVersion: DocumentVersion): SerializedSelectionValue {
  const members = selections.members.map((member) => ({
    id: member.id,
    kind: member.kind,
    creationOrdinal: member.creationOrdinal as number,
    direction: member.direction,
    anchor: serializeEndpoint(member.anchor),
    head: serializeEndpoint(member.head),
    desiredColumn: { logicalUtf16: member.desiredColumn.logicalUtf16, displayCell: member.desiredColumn.displayCell },
    ...(member.kind === 'visual-character' ? { inclusive: member.inclusive } : {}),
    ...(member.kind === 'visual-line' ? { anchorDesiredColumn: { logicalUtf16: member.anchorDesiredColumn.logicalUtf16, displayCell: member.anchorDesiredColumn.displayCell } } : {}),
  }));
  return Object.freeze({
    viewId: value.viewId as string,
    documentId: selections.documentId,
    documentVersion: documentVersion as number,
    mode: value.mode as string,
    primaryId: selections.primaryId,
    selectionGeneration: selections.selectionGeneration as number,
    members: Object.freeze(members),
  });
}

function makeAnchorSnapshot(documentId: DocumentId, version: DocumentVersion, lengthUtf16: number): DocumentSnapshot {
  const fake = {
    id: documentId,
    version,
    lengthUtf16,
    lineIndexAt(position: number) {
      if (!Number.isSafeInteger(position) || position < 0 || position > lengthUtf16) return { ok: false as const, error: { kind: 'invalid-range' as const } };
      return { ok: true as const, value: 0 as LineIndex };
    },
  };
  return fake as unknown as DocumentSnapshot;
}

function netEditDelta(map: DocumentChangeMap): number {
  return map.orderedEdits.reduce((delta, edit) => delta + edit.text.length - ((edit.end as number) - (edit.start as number)), 0);
}

function parseDesiredColumn(value: unknown): SelectionSetInput['members'][number]['desiredColumn'] | undefined {
  if (!isObject(value)) return undefined;
  const logical = value.logicalUtf16 === null ? null : checkedUtf16Column(value.logicalUtf16);
  const display = value.displayCell === null ? null : checkedCellColumn(value.displayCell);
  if (logical === undefined || display === undefined) return undefined;
  if ((logical !== null && !logical.ok) || (display !== null && !display.ok)) return undefined;
  return {
    logicalUtf16: logical === null ? null : logical.value,
    displayCell: display === null ? null : display.value,
  };
}

function endpointInput(value: unknown): SelectionMemberInput['anchor'] | undefined {
  if (!isObject(value) || typeof value.kind !== 'string') return undefined;
  const offset = checkedOffset(value.offset);
  const line = value.lineIndex === undefined ? undefined : checkedLine(value.lineIndex);
  const affinity = value.affinity === undefined ? 'right' : value.affinity;
  if (!offset.ok || (affinity !== 'left' && affinity !== 'right') || (line !== undefined && !line.ok)) return undefined;
  switch (value.kind) {
    case 'character': {
      const after = checkedOffset(value.after);
      const afterAffinity = value.afterAffinity === undefined ? 'right' : value.afterAffinity;
      return after.ok && (afterAffinity === 'left' || afterAffinity === 'right')
        ? { kind: 'character', offset: offset.value, after: after.value, affinity, afterAffinity }
        : undefined;
    }
    case 'empty-line': return line?.ok === true ? { kind: 'empty-line', lineIndex: line.value, affinity } : undefined;
    case 'eof': return { kind: 'eof', affinity };
    case 'gap': return { kind: 'gap', offset: offset.value, affinity };
    case 'line': return line?.ok === true ? { kind: 'line', lineIndex: line.value, affinity } : undefined;
    case 'block-cell': {
      const logical = checkedUtf16Column(value.logicalUtf16Column);
      const display = checkedCellColumn(value.displayCellColumn);
      const virtualCells = value.virtualCells;
      if (line?.ok !== true || !logical.ok || !display.ok || !Number.isSafeInteger(virtualCells) || (virtualCells as number) < 0) return undefined;
      return { kind: 'block-cell', offset: offset.value, logicalUtf16Column: logical.value, displayCellColumn: display.value, virtualCells: virtualCells as number, affinity };
    }
    default: return undefined;
  }
}

function readViewIdentity(value: SerializedSelectionValue): { readonly viewId: ViewId } | undefined {
  if (!isObject(value)) return undefined;
  const viewId = asIdentifier<ViewId>(value.viewId, 'viewId');
  return viewId.ok ? { viewId: viewId.value } : undefined;
}

function isSelectionKind(value: unknown): value is SelectionMember['kind'] {
  return value === 'normal-cursor' || value === 'insert-caret' || value === 'visual-character'
    || value === 'visual-line' || value === 'visual-block';
}

function isMode(value: unknown): value is VimMode {
  return value === 'normal' || value === 'insert' || value === 'replace' || value === 'virtual-replace'
    || value === 'visual-character' || value === 'visual-line' || value === 'visual-block'
    || value === 'select-character' || value === 'select-line' || value === 'select-block';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid<T>(): Result<T, 'invalid'> { return { ok: false, error: 'invalid' }; }
function stateFailure(cause: AtomicCommandFailure): Result<never, WorkbenchHistoryFailure> {
  return { ok: false, error: { kind: 'state-failed', cause } };
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function checkedOffset(value: unknown): Result<Utf16Offset, 'invalid'> {
  const number = safeInteger(value);
  return number === undefined ? invalid() : { ok: true, value: number as Utf16Offset };
}

function checkedLine(value: unknown): Result<LineIndex, 'invalid'> {
  const number = safeInteger(value);
  return number === undefined ? invalid() : { ok: true, value: number as LineIndex };
}

function checkedUtf16Column(value: unknown): Result<Utf16Column, 'invalid'> {
  const number = safeInteger(value);
  return number === undefined ? invalid() : { ok: true, value: number as Utf16Column };
}

function checkedCellColumn(value: unknown): Result<CellColumn, 'invalid'> {
  const number = safeInteger(value);
  return number === undefined ? invalid() : { ok: true, value: number as CellColumn };
}
