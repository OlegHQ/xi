import {
  cloneSerializedSelectionValue,
  asUndoGroupId,
  type DocumentId,
  type DocumentVersion,
  type RevisionId,
  type Result,
  type SerializedSelectionValue,
  type UndoGroupId,
  type Utf16Offset,
} from '../../primitives/src/index';
import type { DocumentEdit } from './rope';
import type { DocumentSnapshot } from './contracts';
import type { CommittedDocumentChange, EditOrigin } from './transactions';
import { LineEndingSequence, type LineEnding } from './line-endings';

export const UNDO_HISTORY_FORMAT_VERSION = 1 as const;
export const UNDO_HISTORY_POLICY = Object.freeze({
  maxEntries: 256,
  /** Sum of retained forward and inverse UTF-16 replacement text across undo entries. */
  maxRetainedUtf16: 32 * 1024 * 1024,
  /** Estimated private metadata ceiling; large deleted roots are charged separately. */
  maxRetainedPrivateBytes: 64 * 1024 * 1024,
  /** A source snapshot is retained once even when several history edits refer to it. */
  maxRetainedRootUtf16: 512 * 1024 * 1024,
});

export interface UndoEntryInfo {
  readonly id: RevisionId;
  readonly groupId: UndoGroupId;
  readonly origin: EditOrigin;
  readonly beforeRevisionId: RevisionId;
  readonly afterRevisionId: RevisionId;
  readonly stepCount: number;
  readonly beforeSelection?: SerializedSelectionValue;
  readonly afterSelection?: SerializedSelectionValue;
}

export type UndoGroupFailure =
  | { readonly kind: 'undo-group-already-open' }
  | { readonly kind: 'undo-group-not-open' }
  | { readonly kind: 'undo-group-id-mismatch' }
  | { readonly kind: 'invalid-selection-history' };

export type UndoOperationFailure =
  | { readonly kind: 'nothing-to-undo' }
  | { readonly kind: 'nothing-to-redo' }
  | { readonly kind: 'unknown-redo-branch' }
  | { readonly kind: 'history-operation-in-progress' }
  | { readonly kind: 'history-replay-failed'; readonly stepIndex: number }
  | { readonly kind: 'undo-history-limit' };

export interface UndoOutcome {
  readonly kind: 'undone' | 'redone';
  readonly entry: UndoEntryInfo;
  readonly version: DocumentVersion;
  readonly revisionId: RevisionId;
  /** The final transition emitted by this grouped history operation. */
  readonly change: CommittedDocumentChange;
  readonly restoredSelection?: SerializedSelectionValue;
}

export interface RedoBranchInfo {
  readonly id: RevisionId;
  readonly groupId: UndoGroupId;
  readonly origin: EditOrigin;
  readonly afterRevisionId: RevisionId;
  readonly stepCount: number;
}

export interface UndoHistoryStats {
  readonly entries: number;
  readonly retainedUtf16: number;
  /** Estimated private bytes: copied UTF-16 payload plus history metadata. */
  readonly retainedPrivateBytes: number;
  /** UTF-16 units pinned by distinct source snapshot roots. */
  readonly retainedRootUtf16: number;
  readonly retainedRootSnapshots: number;
  readonly retainedMetadataBytes: number;
  readonly stepCount: number;
  readonly canUndo: boolean;
  readonly redoBranches: number;
}

export interface UndoTextSource {
  readonly editIndex: number;
  /** An immutable document snapshot that owns the deleted text. */
  readonly snapshot: DocumentSnapshot;
  /** Source range in UTF-16 units of `snapshot`. */
  readonly start: Utf16Offset;
  readonly end: Utf16Offset;
  /** EOL metadata aligned with the source snapshot, retained for exact root restore. */
  readonly lineEndings?: LineEndingSequence;
}

export interface UndoRetention {
  readonly retainedUtf16: number;
  readonly retainedRootUtf16: number;
  readonly retainedMetadataBytes: number;
  readonly coalescibleInsert: boolean;
}

export interface UndoStep {
  readonly beforeRevisionId: RevisionId;
  readonly afterRevisionId: RevisionId;
  readonly forwardEdits: readonly DocumentEdit[];
  /** Coalesced insert payloads are kept in bounded chunks and joined only on replay/serialization. */
  readonly forwardTextRuns: readonly UndoTextRun[];
  readonly inverseEdits: readonly DocumentEdit[];
  /** Large inverse payloads read from a retained immutable source snapshot on replay. */
  readonly inverseSources: readonly UndoTextSource[];
  readonly inverseLineEndings: readonly InverseLineEndingPatch[];
  readonly retainedUtf16: number;
  readonly retainedRootUtf16: number;
  readonly retainedMetadataBytes: number;
  readonly coalescibleInsert: boolean;
}

export interface UndoTextRun {
  readonly editIndex: number;
  readonly chunks: string[];
  length: number;
  readonly pending: string[];
  pendingLength: number;
}

export interface InverseLineEndingPatch {
  /** Index in the canonical inverse edit array. */
  readonly editIndex: number;
  readonly removeCount: number;
  readonly insert: readonly LineEnding[];
  /** Large EOL payloads share the immutable metadata sequence instead of making one value per line. */
  readonly insertSequence?: LineEndingSequence;
}

export interface UndoReplayPlan {
  readonly node: UndoTreeEntry;
  readonly steps: readonly UndoStep[];
  readonly direction: 'undo' | 'redo';
  readonly targetRevisionId: RevisionId;
  readonly restoredSelection?: SerializedSelectionValue;
}

export interface UndoTreeEntry {
  readonly id: RevisionId;
  readonly groupId: UndoGroupId;
  readonly origin: EditOrigin;
  readonly beforeRevisionId: RevisionId;
  afterRevisionId: RevisionId;
  beforeSelection?: SerializedSelectionValue;
  afterSelection?: SerializedSelectionValue;
  readonly steps: UndoStep[];
  readonly order: number;
  parent: UndoTreeEntry | null;
  readonly children: UndoTreeEntry[];
  retainedUtf16: number;
  retainedRootUtf16: number;
  retainedMetadataBytes: number;
}

interface ActiveUndoGroup {
  readonly id: UndoGroupId;
  readonly origin: EditOrigin;
  readonly beforeSelection?: SerializedSelectionValue;
  node?: UndoTreeEntry;
}

interface UndoTreeRoot {
  revisionId: RevisionId;
  children: UndoTreeEntry[];
}

export interface SerializedUndoHistory {
  readonly schema: 'xi.undo-history';
  readonly version: typeof UNDO_HISTORY_FORMAT_VERSION;
  readonly documentId: string;
  readonly rootRevisionId: number;
  readonly currentEntryId: number | null;
  readonly currentRevisionId: number;
  readonly savedRevisionId: number;
  readonly maximumRevisionId: number;
  readonly nextOrder: number;
  readonly entries: readonly SerializedUndoEntry[];
  readonly checksum: string;
}

interface SerializedUndoEntry {
  readonly id: number;
  readonly parentId: number | null;
  readonly groupId: string;
  readonly origin: EditOrigin;
  readonly beforeRevisionId: number;
  readonly afterRevisionId: number;
  readonly beforeSelection?: SerializedSelectionValue;
  readonly afterSelection?: SerializedSelectionValue;
  readonly order: number;
  readonly steps: readonly SerializedUndoStep[];
}

interface SerializedUndoStep {
  readonly beforeRevisionId: number;
  readonly afterRevisionId: number;
  readonly forwardEdits: readonly {
    readonly start: number;
    readonly end: number;
    readonly text: string;
    readonly textIntent?: 'literal-control';
  }[];
  readonly inverseEdits: readonly {
    readonly start: number;
    readonly end: number;
    readonly text: string;
    readonly textIntent?: 'literal-control';
  }[];
  readonly inverseLineEndings: readonly {
    readonly editIndex: number;
    readonly removeCount: number;
    readonly insert: readonly LineEnding[];
  }[];
  readonly retainedUtf16: number;
}

export type UndoHistoryFailure =
  | { readonly kind: 'invalid-history-bytes' }
  | { readonly kind: 'unsupported-history-version' }
  | { readonly kind: 'history-checksum-mismatch' }
  | { readonly kind: 'history-document-mismatch' }
  | { readonly kind: 'history-content-mismatch' }
  | { readonly kind: 'history-current-revision-mismatch' }
  | { readonly kind: 'history-not-empty' }
  | { readonly kind: 'history-operation-in-progress' }
  | { readonly kind: 'invalid-history-graph' }
  | { readonly kind: 'invalid-selection-history' }
  | { readonly kind: 'undo-history-limit' };

/**
 * Mutable document-owned branching history. Text remains in the document; entries
 * retain only bounded forward/inverse edit text and inert selection values.
 */
export class UndoTree {
  #root: UndoTreeRoot;
  #current: UndoTreeEntry | null = null;
  #activeGroup: ActiveUndoGroup | undefined;
  #nextOrder = 1;
  #entryCount = 0;
  #retainedUtf16 = 0;
  #retainedMetadataBytes = 0;
  #retainedRootUtf16 = 0;
  #retainedRootSnapshots = new Map<DocumentSnapshot, number>();
  #stepCount = 0;

  constructor(initialRevisionId: RevisionId) {
    this.#root = { revisionId: initialRevisionId, children: [] };
  }

  get currentRevisionId(): RevisionId {
    return this.#current?.afterRevisionId ?? this.#root.revisionId;
  }

  get hasEntries(): boolean { return this.#entryCount > 0; }
  get hasActiveGroup(): boolean { return this.#activeGroup !== undefined; }

  stats(): UndoHistoryStats {
    return Object.freeze({
      entries: this.#entryCount,
      retainedUtf16: this.#retainedUtf16,
      retainedPrivateBytes: this.#retainedUtf16 * 2 + this.#retainedMetadataBytes,
      retainedRootUtf16: this.#retainedRootUtf16,
      retainedRootSnapshots: this.#retainedRootSnapshots.size,
      retainedMetadataBytes: this.#retainedMetadataBytes,
      stepCount: this.#stepCount,
      canUndo: this.#current !== null,
      redoBranches: this.#current?.children.length ?? this.#root.children.length,
    });
  }

  beginGroup(
    id: UndoGroupId,
    origin: EditOrigin,
    beforeSelection?: unknown,
  ): Result<void, UndoGroupFailure> {
    if (this.#activeGroup !== undefined) return { ok: false, error: { kind: 'undo-group-already-open' } };
    let selection: SerializedSelectionValue | undefined;
    if (beforeSelection !== undefined) {
      const cloned = cloneSerializedSelectionValue(beforeSelection);
      if (!cloned.ok) return { ok: false, error: { kind: 'invalid-selection-history' } };
      selection = cloned.value;
    }
    this.#activeGroup = {
      id,
      origin,
      ...(selection === undefined ? {} : { beforeSelection: selection }),
    };
    return { ok: true, value: undefined };
  }

  endGroup(id: UndoGroupId, afterSelection?: unknown): Result<void, UndoGroupFailure> {
    const group = this.#activeGroup;
    if (group === undefined) return { ok: false, error: { kind: 'undo-group-not-open' } };
    if (group.id !== id) return { ok: false, error: { kind: 'undo-group-id-mismatch' } };
    if (afterSelection !== undefined) {
      const cloned = cloneSerializedSelectionValue(afterSelection);
      if (!cloned.ok) return { ok: false, error: { kind: 'invalid-selection-history' } };
      if (group.node !== undefined) {
        const previousMetadata = group.node.retainedMetadataBytes;
        group.node.afterSelection = cloned.value;
        group.node.retainedMetadataBytes = entryMetadataBytes(group.node);
        this.#retainedMetadataBytes += group.node.retainedMetadataBytes - previousMetadata;
        this.prune();
      }
    }
    this.#activeGroup = undefined;
    return { ok: true, value: undefined };
  }

  closeGroup(): void { this.#activeGroup = undefined; }

  canAppend(retention: number | UndoRetention, id: UndoGroupId, origin: EditOrigin): boolean {
    const normalized = typeof retention === 'number'
      ? { retainedUtf16: retention, retainedRootUtf16: 0, retainedMetadataBytes: 0, coalescibleInsert: false }
      : retention;
    if (!validRetention(normalized)
      || normalized.retainedUtf16 > UNDO_HISTORY_POLICY.maxRetainedUtf16
      || normalized.retainedRootUtf16 > UNDO_HISTORY_POLICY.maxRetainedRootUtf16) return false;
    const group = this.#activeGroup;
    const sameGroup = group !== undefined && group.id === id && group.origin === origin && group.node !== undefined;
    const addedMetadata = sameGroup && normalized.coalescibleInsert ? 0 : normalized.retainedMetadataBytes;
    return this.#retainedUtf16 + normalized.retainedUtf16 <= UNDO_HISTORY_POLICY.maxRetainedUtf16
      && this.#retainedMetadataBytes + addedMetadata <= UNDO_HISTORY_POLICY.maxRetainedPrivateBytes
      && this.#retainedRootUtf16 + normalized.retainedRootUtf16 <= UNDO_HISTORY_POLICY.maxRetainedRootUtf16;
  }

  record(change: CommittedDocumentChange, step: UndoStep): void {
    const group = this.#activeGroup;
    const matchesGroup = group !== undefined && group.id === change.undoGroup && group.origin === change.origin;
    if (!matchesGroup) this.#activeGroup = undefined;

    if (matchesGroup && group?.node !== undefined && group.node === this.#current) {
      const node = group.node;
      const previousStep = node.steps.at(-1);
      const coalesced = previousStep === undefined ? undefined : coalesceInsertSteps(previousStep, step);
      const previousMetadata = node.retainedMetadataBytes;
      const textDelta = coalesced === undefined
        ? step.retainedUtf16
        : coalesced.retainedUtf16 - (previousStep?.retainedUtf16 ?? 0);
      const rootDelta = coalesced === undefined
        ? step.retainedRootUtf16
        : coalesced.retainedRootUtf16 - (previousStep?.retainedRootUtf16 ?? 0);
      if (coalesced === undefined) {
        node.steps.push(step);
      } else {
        node.steps[node.steps.length - 1] = coalesced;
      }
      node.afterRevisionId = change.afterRevisionId;
      node.retainedUtf16 += textDelta;
      node.retainedRootUtf16 += rootDelta;
      if (node.beforeSelection === undefined && change.selectionHistory !== undefined) {
        node.beforeSelection = change.selectionHistory.before;
      }
      if (change.selectionHistory !== undefined) node.afterSelection = change.selectionHistory.after;
      node.retainedMetadataBytes = entryMetadataBytes(node);
      this.#retainedUtf16 += textDelta;
      this.#retainedMetadataBytes += node.retainedMetadataBytes - previousMetadata;
      if (coalesced === undefined) this.addSources(step);
      this.#stepCount += coalesced === undefined ? 1 : 0;
      this.prune();
      return;
    }

    const beforeSelection = matchesGroup && group?.beforeSelection !== undefined
      ? group.beforeSelection
      : change.selectionHistory?.before;
    const node: UndoTreeEntry = {
      id: change.afterRevisionId,
      groupId: change.undoGroup,
      origin: change.origin,
      beforeRevisionId: change.beforeRevisionId,
      afterRevisionId: change.afterRevisionId,
      ...(beforeSelection === undefined ? {} : { beforeSelection }),
      ...(change.selectionHistory === undefined ? {} : { afterSelection: change.selectionHistory.after }),
      steps: [step],
      order: this.#nextOrder,
      parent: this.#current,
      children: [],
      retainedUtf16: step.retainedUtf16,
      retainedRootUtf16: step.retainedRootUtf16,
      retainedMetadataBytes: 0,
    };
    node.retainedMetadataBytes = entryMetadataBytes(node, change.selectionHistory);
    this.#nextOrder += 1;
    this.childrenOf(this.#current).push(node);
    this.#current = node;
    this.#entryCount += 1;
    this.#retainedUtf16 += step.retainedUtf16;
    this.#retainedMetadataBytes += node.retainedMetadataBytes;
    this.#stepCount += 1;
    this.addSources(step);
    if (matchesGroup && group !== undefined) group.node = node;
    this.prune();
  }

  undoPlan(): UndoReplayPlan | undefined {
    this.#activeGroup = undefined;
    const node = this.#current;
    if (node === null) return undefined;
    return Object.freeze({
      node,
      steps: Object.freeze([...node.steps].reverse()),
      direction: 'undo',
      targetRevisionId: node.beforeRevisionId,
      ...(node.beforeSelection === undefined ? {} : { restoredSelection: node.beforeSelection }),
    });
  }

  redoPlan(branchId?: RevisionId): Result<UndoReplayPlan, UndoOperationFailure> {
    this.#activeGroup = undefined;
    const children = this.childrenOf(this.#current);
    if (children.length === 0) return { ok: false, error: { kind: 'nothing-to-redo' } };
    const node = branchId === undefined
      ? children.reduce((latest, candidate) => candidate.order > latest.order ? candidate : latest)
      : children.find((candidate) => candidate.id === branchId);
    if (node === undefined) return { ok: false, error: { kind: 'unknown-redo-branch' } };
    return {
      ok: true,
      value: Object.freeze({
        node,
        steps: Object.freeze([...node.steps]),
        direction: 'redo',
        targetRevisionId: node.afterRevisionId,
        ...(node.afterSelection === undefined ? {} : { restoredSelection: node.afterSelection }),
      }),
    };
  }

  complete(plan: UndoReplayPlan): void {
    if (plan.direction === 'undo') {
      if (this.#current !== plan.node) throw new Error('undo-history-cursor-changed');
      this.#current = plan.node.parent;
    } else {
      if (this.childrenOf(this.#current).includes(plan.node) === false) throw new Error('redo-history-branch-changed');
      this.#current = plan.node;
    }
  }

  redoBranches(): readonly RedoBranchInfo[] {
    return Object.freeze(this.childrenOf(this.#current).map((node) => Object.freeze({
      id: node.id,
      groupId: node.groupId,
      origin: node.origin,
      afterRevisionId: node.afterRevisionId,
      stepCount: node.steps.length,
    })));
  }

  entryInfo(node: UndoTreeEntry): UndoEntryInfo {
    return Object.freeze({
      id: node.id,
      groupId: node.groupId,
      origin: node.origin,
      beforeRevisionId: node.beforeRevisionId,
      afterRevisionId: node.afterRevisionId,
      stepCount: node.steps.length,
      ...(node.beforeSelection === undefined ? {} : { beforeSelection: node.beforeSelection }),
      ...(node.afterSelection === undefined ? {} : { afterSelection: node.afterSelection }),
    });
  }

  serialize(
    documentId: DocumentId,
    currentRevisionId: RevisionId,
    savedRevisionId: RevisionId,
    maximumRevisionId: RevisionId,
    contentFingerprint: string,
  ): Uint8Array {
    this.#activeGroup = undefined;
    const payload = {
      schema: 'xi.undo-history' as const,
      version: UNDO_HISTORY_FORMAT_VERSION,
      documentId,
      contentFingerprint,
      rootRevisionId: this.#root.revisionId as number,
      currentEntryId: this.#current?.id as number | null ?? null,
      currentRevisionId: currentRevisionId as number,
      savedRevisionId: savedRevisionId as number,
      maximumRevisionId: maximumRevisionId as number,
      nextOrder: this.#nextOrder,
      entries: this.serializedEntries(),
    };
    const checksum = checksumOf(payload);
    return new TextEncoder().encode(canonicalJson({ ...payload, checksum }));
  }

  restore(
    archive: ValidatedUndoHistory,
  ): void {
    const entries = new Map<number, UndoTreeEntry>();
    const root: UndoTreeRoot = { revisionId: revision(archive.rootRevisionId), children: [] };
    for (const saved of archive.entries) {
      const parent = saved.parentId === null ? null : entries.get(saved.parentId) ?? null;
      const node: UndoTreeEntry = {
        id: revision(saved.id),
        groupId: saved.groupId as UndoGroupId,
        origin: saved.origin,
        beforeRevisionId: revision(saved.beforeRevisionId),
        afterRevisionId: revision(saved.afterRevisionId),
        ...(saved.beforeSelection === undefined ? {} : { beforeSelection: saved.beforeSelection }),
        ...(saved.afterSelection === undefined ? {} : { afterSelection: saved.afterSelection }),
        steps: saved.steps.map(toUndoStep),
        order: saved.order,
        parent,
        children: [],
        retainedUtf16: saved.retainedUtf16,
        retainedRootUtf16: 0,
        retainedMetadataBytes: 0,
      };
      node.retainedMetadataBytes = entryMetadataBytes(node);
      if (parent === null) root.children.push(node);
      else parent.children.push(node);
      entries.set(saved.id, node);
    }
    this.#root = root;
    this.#current = archive.currentEntryId === null ? null : entries.get(archive.currentEntryId) ?? null;
    this.#activeGroup = undefined;
    this.#nextOrder = archive.nextOrder;
    this.#entryCount = archive.entries.length;
    this.#retainedUtf16 = archive.entries.reduce((total, entry) => total + entry.retainedUtf16, 0);
    this.#retainedMetadataBytes = 0;
    this.#retainedRootUtf16 = 0;
    this.#retainedRootSnapshots.clear();
    this.#stepCount = archive.entries.reduce((total, entry) => total + entry.steps.length, 0);
    for (const node of entries.values()) {
      this.#retainedMetadataBytes += node.retainedMetadataBytes;
      // Serialized history has flattened payloads and therefore no source roots.
    }
  }

  private childrenOf(node: UndoTreeEntry | null): UndoTreeEntry[] {
    return node?.children ?? this.#root.children;
  }

  private prune(): void {
    while (this.#entryCount > UNDO_HISTORY_POLICY.maxEntries
      || this.#retainedUtf16 > UNDO_HISTORY_POLICY.maxRetainedUtf16
      || this.#retainedMetadataBytes > UNDO_HISTORY_POLICY.maxRetainedPrivateBytes) {
      const ancestry = new Set<UndoTreeEntry>();
      let cursor = this.#current;
      while (cursor !== null) {
        ancestry.add(cursor);
        cursor = cursor.parent;
      }
      const leaves = this.allEntries().filter((node) => node.children.length === 0 && !ancestry.has(node));
      if (leaves.length > 0) {
        const leaf = leaves.reduce((oldest, candidate) => candidate.order < oldest.order ? candidate : oldest);
        this.detach(leaf);
        continue;
      }
      const chain: UndoTreeEntry[] = [];
      cursor = this.#current;
      while (cursor !== null) {
        chain.push(cursor);
        cursor = cursor.parent;
      }
      chain.reverse();
      const first = chain[0];
      if (first === undefined) break;
      const discardedUtf16 = first.retainedUtf16;
      const discardedMetadataBytes = first.retainedMetadataBytes;
      const discardedSteps = first.steps.length;
      const oldRoot = this.#root;
      const keptChildren = [...first.children];
      for (const sibling of [...oldRoot.children]) {
        if (sibling !== first) this.removeSubtree(sibling);
      }
      this.removeSources(first.steps);
      this.#root = { revisionId: first.afterRevisionId, children: keptChildren };
      for (const child of keptChildren) child.parent = null;
      first.children.splice(0);
      first.steps.splice(0);
      first.retainedUtf16 = 0;
      first.retainedRootUtf16 = 0;
      first.retainedMetadataBytes = 0;
      this.#entryCount -= 1;
      this.#retainedUtf16 -= discardedUtf16;
      this.#retainedMetadataBytes -= discardedMetadataBytes;
      this.#stepCount -= discardedSteps;
      if (this.#retainedRootUtf16 < 0) throw new Error('undo-root-retention-underflow');
      delete first.beforeSelection;
      delete first.afterSelection;
    }
  }

  private allEntries(): UndoTreeEntry[] {
    const values: UndoTreeEntry[] = [];
    const stack = [...this.#root.children];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) continue;
      values.push(node);
      stack.push(...node.children);
    }
    return values;
  }

  private detach(node: UndoTreeEntry): void {
    const siblings = this.childrenOf(node.parent);
    const index = siblings.indexOf(node);
    if (index >= 0) siblings.splice(index, 1);
    this.removeSubtree(node);
  }

  private removeSubtree(node: UndoTreeEntry, preserved = new Set<UndoTreeEntry>()): void {
    if (preserved.has(node)) return;
    for (const child of [...node.children]) {
      if (!preserved.has(child)) this.removeSubtree(child, preserved);
    }
    this.#entryCount -= 1;
    this.#retainedUtf16 -= node.retainedUtf16;
    this.#retainedMetadataBytes -= node.retainedMetadataBytes;
    this.#stepCount -= node.steps.length;
    this.removeSources(node.steps);
    node.children.splice(0);
  }

  private addSources(step: UndoStep): void {
    for (const source of step.inverseSources) {
      const prior = this.#retainedRootSnapshots.get(source.snapshot) ?? 0;
      this.#retainedRootSnapshots.set(source.snapshot, prior + 1);
      if (prior === 0) this.#retainedRootUtf16 += source.snapshot.lengthUtf16;
    }
  }

  private removeSources(steps: readonly UndoStep[]): void {
    for (const step of steps) {
      for (const source of step.inverseSources) {
        const prior = this.#retainedRootSnapshots.get(source.snapshot);
        if (prior === undefined) continue;
        if (prior <= 1) {
          this.#retainedRootSnapshots.delete(source.snapshot);
          this.#retainedRootUtf16 -= source.snapshot.lengthUtf16;
        } else this.#retainedRootSnapshots.set(source.snapshot, prior - 1);
      }
    }
  }

  private serializedEntries(): readonly SerializedUndoEntry[] {
    return Object.freeze(this.allEntries().sort((left, right) => left.order - right.order).map((node) => Object.freeze({
      id: node.id as number,
      parentId: node.parent?.id as number | null ?? null,
      groupId: node.groupId,
      origin: node.origin,
      beforeRevisionId: node.beforeRevisionId as number,
      afterRevisionId: node.afterRevisionId as number,
      ...(node.beforeSelection === undefined ? {} : { beforeSelection: node.beforeSelection }),
      ...(node.afterSelection === undefined ? {} : { afterSelection: node.afterSelection }),
      order: node.order,
      steps: Object.freeze(node.steps.map((step) => {
        const forwardEdits = encodeEdits(step.forwardEdits, step.forwardTextRuns);
        const inverseEdits = encodeEdits(step.inverseEdits, []);
        return Object.freeze({
          beforeRevisionId: step.beforeRevisionId as number,
          afterRevisionId: step.afterRevisionId as number,
          forwardEdits,
          inverseEdits,
          inverseLineEndings: Object.freeze(step.inverseLineEndings.map((patch) => Object.freeze({
            editIndex: patch.editIndex,
            removeCount: patch.removeCount,
            insert: patch.insertSequence?.toArray() ?? patch.insert,
          }))),
          retainedUtf16: textLength(forwardEdits) + textLength(inverseEdits),
        });
      })),
    })));
  }
}

export interface ValidatedUndoHistory {
  readonly documentId: string;
  readonly contentFingerprint: string;
  readonly rootRevisionId: number;
  readonly currentEntryId: number | null;
  readonly currentRevisionId: number;
  readonly savedRevisionId: number;
  readonly maximumRevisionId: number;
  readonly nextOrder: number;
  readonly entries: readonly ValidatedUndoEntry[];
}

interface ValidatedUndoEntry extends Omit<SerializedUndoEntry, 'steps'> {
  readonly steps: readonly ValidatedUndoStep[];
  readonly retainedUtf16: number;
}

interface ValidatedUndoStep extends Omit<SerializedUndoStep, 'forwardEdits' | 'inverseEdits'> {
  readonly forwardEdits: readonly DocumentEdit[];
  readonly inverseEdits: readonly DocumentEdit[];
}

export function decodeUndoHistory(bytes: Uint8Array, expectedDocumentId: DocumentId): Result<ValidatedUndoHistory, UndoHistoryFailure> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > UNDO_HISTORY_POLICY.maxRetainedUtf16 * 6 + 1_048_576) {
    return { ok: false, error: { kind: 'invalid-history-bytes' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, error: { kind: 'invalid-history-bytes' } };
  }
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, [
    'schema', 'version', 'documentId', 'contentFingerprint', 'rootRevisionId', 'currentEntryId',
    'currentRevisionId', 'savedRevisionId', 'maximumRevisionId', 'nextOrder', 'entries', 'checksum',
  ])) return { ok: false, error: { kind: 'invalid-history-graph' } };
  if (parsed.schema !== 'xi.undo-history' || parsed.version !== UNDO_HISTORY_FORMAT_VERSION) {
    return { ok: false, error: { kind: 'unsupported-history-version' } };
  }
  const { checksum, ...payload } = parsed;
  if (typeof checksum !== 'string' || checksum !== checksumOf(payload)) {
    return { ok: false, error: { kind: 'history-checksum-mismatch' } };
  }
  if (parsed.documentId !== expectedDocumentId) return { ok: false, error: { kind: 'history-document-mismatch' } };

  const rootRevisionId = positiveSafeInteger(parsed.rootRevisionId);
  const currentRevisionId = positiveSafeInteger(parsed.currentRevisionId);
  const savedRevisionId = positiveSafeInteger(parsed.savedRevisionId);
  const maximumRevisionId = positiveSafeInteger(parsed.maximumRevisionId);
  const currentEntryIdValue = parsed.currentEntryId === null ? null : positiveSafeInteger(parsed.currentEntryId);
  const nextOrder = positiveSafeInteger(parsed.nextOrder);
  if (rootRevisionId === undefined || currentRevisionId === undefined || savedRevisionId === undefined
    || maximumRevisionId === undefined || currentEntryIdValue === undefined && parsed.currentEntryId !== null
    || nextOrder === undefined || maximumRevisionId < currentRevisionId || savedRevisionId > maximumRevisionId
    || rootRevisionId > maximumRevisionId
    || typeof parsed.contentFingerprint !== 'string' || !/^[0-9a-f]{16}$/u.test(parsed.contentFingerprint)
    || !Array.isArray(parsed.entries) || parsed.entries.length > UNDO_HISTORY_POLICY.maxEntries) {
    return { ok: false, error: { kind: 'invalid-history-graph' } };
  }
  const currentEntryId: number | null = currentEntryIdValue === null ? null : currentEntryIdValue as number;

  const entries: ValidatedUndoEntry[] = [];
  const byId = new Map<number, ValidatedUndoEntry>();
  let retainedTotal = 0;
  let largestOrder = 0;
  let previousOrder = 0;
  for (const raw of parsed.entries as unknown[]) {
    const entry = validateEntry(raw, maximumRevisionId);
    if (entry === undefined || byId.has(entry.id)) return { ok: false, error: { kind: 'invalid-history-graph' } };
    if (entry.parentId !== null && !byId.has(entry.parentId)) return { ok: false, error: { kind: 'invalid-history-graph' } };
    const parentRevisionId: number | undefined = entry.parentId === null
      ? rootRevisionId
      : byId.get(entry.parentId)?.afterRevisionId;
    if (parentRevisionId !== entry.beforeRevisionId) return { ok: false, error: { kind: 'invalid-history-graph' } };
    if (entry.steps[0]?.beforeRevisionId !== entry.beforeRevisionId
      || entry.steps.at(-1)?.afterRevisionId !== entry.afterRevisionId
      || entry.steps[0]?.afterRevisionId !== entry.id || entry.id === rootRevisionId
      || entry.order <= previousOrder || entry.beforeRevisionId > maximumRevisionId) {
      return { ok: false, error: { kind: 'invalid-history-graph' } };
    }
    for (let index = 1; index < entry.steps.length; index += 1) {
      if (entry.steps[index - 1]?.afterRevisionId !== entry.steps[index]?.beforeRevisionId) {
        return { ok: false, error: { kind: 'invalid-history-graph' } };
      }
    }
    byId.set(entry.id, entry);
    entries.push(entry);
    retainedTotal += entry.retainedUtf16;
    largestOrder = Math.max(largestOrder, entry.order);
    previousOrder = entry.order;
  }
  if (retainedTotal > UNDO_HISTORY_POLICY.maxRetainedUtf16 || nextOrder <= largestOrder) {
    return { ok: false, error: { kind: 'undo-history-limit' } };
  }
  const currentRevision = currentEntryId === null
    ? rootRevisionId
    : byId.get(currentEntryId)?.afterRevisionId;
  if (currentRevision !== currentRevisionId) return { ok: false, error: { kind: 'invalid-history-graph' } };
  return {
    ok: true,
    value: Object.freeze({
      documentId: expectedDocumentId,
      contentFingerprint: parsed.contentFingerprint,
      rootRevisionId,
      currentEntryId,
      currentRevisionId,
      savedRevisionId,
      maximumRevisionId,
      nextOrder,
      entries: Object.freeze(entries),
    }),
  };
}

export function fingerprintUndoContent(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function validateEntry(input: unknown, maximumRevisionId: number): ValidatedUndoEntry | undefined {
  if (!isRecord(input) || !hasOnlyKeys(input, [
    'id', 'parentId', 'groupId', 'origin', 'beforeRevisionId', 'afterRevisionId', 'beforeSelection',
    'afterSelection', 'order', 'steps',
  ])) return undefined;
  const id = positiveSafeInteger(input.id);
  const parentIdValue = input.parentId === null ? null : positiveSafeInteger(input.parentId);
  const validGroupId = asUndoGroupId(input.groupId);
  const groupId = validGroupId.ok ? validGroupId.value : undefined;
  const origin = input.origin;
  const beforeRevisionId = positiveSafeInteger(input.beforeRevisionId);
  const afterRevisionId = positiveSafeInteger(input.afterRevisionId);
  const order = positiveSafeInteger(input.order);
  if (id === undefined || (parentIdValue === undefined && input.parentId !== null) || groupId === undefined
    || !isEditOrigin(origin) || beforeRevisionId === undefined || afterRevisionId === undefined
    || order === undefined || !Array.isArray(input.steps) || input.steps.length === 0
    || afterRevisionId > maximumRevisionId || id > maximumRevisionId) return undefined;
  const beforeSelection = validateOptionalSelection(input, 'beforeSelection');
  const afterSelection = validateOptionalSelection(input, 'afterSelection');
  if (beforeSelection === INVALID_SELECTION || afterSelection === INVALID_SELECTION) return undefined;
  const parentId: number | null = parentIdValue === null ? null : parentIdValue as number;
  const steps: ValidatedUndoStep[] = [];
  let retainedUtf16 = 0;
  for (const rawStep of input.steps as unknown[]) {
    const step = validateStep(rawStep, maximumRevisionId);
    if (step === undefined) return undefined;
    retainedUtf16 += step.retainedUtf16;
    steps.push(step);
  }
  if (!Number.isSafeInteger(retainedUtf16) || retainedUtf16 > UNDO_HISTORY_POLICY.maxRetainedUtf16) return undefined;
  if (input.retainedUtf16 !== undefined && input.retainedUtf16 !== retainedUtf16) return undefined;
  return Object.freeze({
    id,
    parentId,
    groupId,
    origin,
    beforeRevisionId,
    afterRevisionId,
    ...(beforeSelection === undefined ? {} : { beforeSelection }),
    ...(afterSelection === undefined ? {} : { afterSelection }),
    order,
    steps: Object.freeze(steps),
    retainedUtf16,
  });
}

const INVALID_SELECTION = Symbol('invalid-selection');
function validateOptionalSelection(input: Record<string, unknown>, key: string): SerializedSelectionValue | undefined | typeof INVALID_SELECTION {
  if (!Object.hasOwn(input, key)) return undefined;
  const cloned = cloneSerializedSelectionValue(input[key]);
  return cloned.ok ? cloned.value : INVALID_SELECTION;
}

function validateStep(input: unknown, maximumRevisionId: number): ValidatedUndoStep | undefined {
  if (!isRecord(input) || !hasOnlyKeys(input, [
    'beforeRevisionId', 'afterRevisionId', 'forwardEdits', 'inverseEdits', 'inverseLineEndings', 'retainedUtf16',
  ])) return undefined;
  const beforeRevisionId = positiveSafeInteger(input.beforeRevisionId);
  const afterRevisionId = positiveSafeInteger(input.afterRevisionId);
  if (beforeRevisionId === undefined || afterRevisionId === undefined
    || beforeRevisionId > maximumRevisionId || afterRevisionId > maximumRevisionId
    || !Array.isArray(input.forwardEdits) || !Array.isArray(input.inverseEdits)
    || !Array.isArray(input.inverseLineEndings)) return undefined;
  const forwardEdits = decodeEdits(input.forwardEdits);
  const inverseEdits = decodeEdits(input.inverseEdits);
  if (forwardEdits === undefined || inverseEdits === undefined || forwardEdits.length !== inverseEdits.length) return undefined;
  const inverseLineEndings: InverseLineEndingPatch[] = [];
  const seen = new Set<number>();
  for (const raw of input.inverseLineEndings as unknown[]) {
    if (!isRecord(raw) || !hasOnlyKeys(raw, ['editIndex', 'removeCount', 'insert'])) return undefined;
    const editIndex = nonnegativeSafeInteger(raw.editIndex);
    const removeCount = nonnegativeSafeInteger(raw.removeCount);
    if (editIndex === undefined || removeCount === undefined || editIndex >= inverseEdits.length || seen.has(editIndex)
      || !Array.isArray(raw.insert) || !raw.insert.every(isLineEnding)) return undefined;
    const inverse = inverseEdits[editIndex];
    const forward = forwardEdits[editIndex];
    if (inverse === undefined || forward === undefined || countLineFeeds(inverse.text) !== raw.insert.length
      || countLineFeeds(forward.text) !== removeCount) return undefined;
    seen.add(editIndex);
    inverseLineEndings.push(Object.freeze({ editIndex, removeCount, insert: Object.freeze([...raw.insert]) }));
  }
  for (let index = 0; index < forwardEdits.length; index += 1) {
    const forward = forwardEdits[index];
    const inverse = inverseEdits[index];
    if (forward === undefined || inverse === undefined) return undefined;
    const patch = inverseLineEndings.find((candidate) => candidate.editIndex === index);
    if ((countLineFeeds(forward.text) > 0 || countLineFeeds(inverse.text) > 0) && patch === undefined) return undefined;
  }
  let retainedUtf16 = 0;
  for (const edit of [...forwardEdits, ...inverseEdits]) retainedUtf16 += edit.text.length;
  if (!Number.isSafeInteger(input.retainedUtf16) || input.retainedUtf16 !== retainedUtf16) return undefined;
  return Object.freeze({
    beforeRevisionId,
    afterRevisionId,
    forwardEdits: Object.freeze(forwardEdits),
    inverseEdits: Object.freeze(inverseEdits),
    inverseLineEndings: Object.freeze(inverseLineEndings),
    retainedUtf16,
  });
}

function decodeEdits(input: readonly unknown[]): readonly DocumentEdit[] | undefined {
  const edits: DocumentEdit[] = [];
  let previousEnd = -1;
  let previousStart = -1;
  for (const raw of input) {
    if (!isRecord(raw) || !hasOnlyKeys(raw, ['start', 'end', 'text', 'textIntent']) || !nonnegativeSafeInteger(raw.start) && raw.start !== 0
      || !nonnegativeSafeInteger(raw.end) && raw.end !== 0 || typeof raw.text !== 'string'
      || hasInvalidUtf16(raw.text)
      || raw.textIntent === undefined && raw.text.includes('\r')
      || raw.textIntent !== undefined && (raw.textIntent !== 'literal-control' || !raw.text.includes('\r'))) return undefined;
    const start = raw.start as number;
    const end = raw.end as number;
    if (start > end || start < previousEnd || start === previousStart) return undefined;
    previousStart = start;
    previousEnd = end;
    edits.push(Object.freeze({
      start: start as DocumentEdit['start'],
      end: end as DocumentEdit['end'],
      text: raw.text,
      ...(raw.textIntent === undefined ? {} : { textIntent: raw.textIntent }),
    }));
  }
  return edits;
}

function toUndoStep(step: ValidatedUndoStep): UndoStep {
  return Object.freeze({
    beforeRevisionId: revision(step.beforeRevisionId),
    afterRevisionId: revision(step.afterRevisionId),
    forwardEdits: step.forwardEdits,
    forwardTextRuns: Object.freeze([]),
    inverseEdits: step.inverseEdits,
    inverseSources: Object.freeze([]),
    inverseLineEndings: step.inverseLineEndings,
    retainedUtf16: step.retainedUtf16,
    retainedRootUtf16: 0,
    retainedMetadataBytes: estimateUndoStepMetadata(step.forwardEdits, step.inverseEdits, step.inverseLineEndings),
    coalescibleInsert: false,
  });
}

function encodeEdits(edits: readonly DocumentEdit[], runs: readonly UndoTextRun[]): SerializedUndoStep['forwardEdits'] {
  return Object.freeze(edits.map((edit, editIndex) => Object.freeze({
    start: edit.start as number,
    end: edit.end as number,
    text: textForEdit(edit, editIndex, runs),
    ...(edit.textIntent === undefined ? {} : { textIntent: edit.textIntent }),
  })));
}

function textLength(edits: readonly { readonly text: string }[]): number {
  let length = 0;
  for (const edit of edits) length += edit.text.length;
  return length;
}

function textForEdit(edit: DocumentEdit, editIndex: number, runs: readonly UndoTextRun[]): string {
  const run = runs.find((candidate) => candidate.editIndex === editIndex);
  return run === undefined ? edit.text : materializeTextRun(run);
}

/** Materialize only at history replay/serialization; ordinary edit commits keep source text lazy. */
export function materializeUndoEdits(
  step: UndoStep,
  direction: 'forward' | 'inverse',
): Result<readonly DocumentEdit[], 'history-source-read-failed'> {
  const sourceByEdit = direction === 'inverse'
    ? new Map(step.inverseSources.map((source) => [source.editIndex, source] as const))
    : new Map<number, UndoTextSource>();
  const runs = direction === 'forward' ? step.forwardTextRuns : [];
  const edits = direction === 'forward' ? step.forwardEdits : step.inverseEdits;
  const materialized: DocumentEdit[] = [];
  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index];
    if (edit === undefined) return { ok: false, error: 'history-source-read-failed' };
    const source = sourceByEdit.get(index);
    let text = textForEdit(edit, index, runs);
    if (source !== undefined) {
      const read = source.snapshot.slice(source.start, source.end);
      if (!read.ok) return { ok: false, error: 'history-source-read-failed' };
      text = read.value;
    }
    materialized.push(Object.freeze({
      start: edit.start,
      end: edit.end,
      text,
      ...(text.includes('\r') ? { textIntent: 'literal-control' as const } : edit.textIntent === undefined ? {} : { textIntent: edit.textIntent }),
    }));
  }
  return { ok: true, value: Object.freeze(materialized) };
}

const MAX_UNDO_TEXT_RUN_CHUNK = 8192;

function coalesceInsertSteps(previous: UndoStep, current: UndoStep): UndoStep | undefined {
  if (previous.inverseSources.length !== 0 || current.inverseSources.length !== 0
    || previous.inverseLineEndings.length !== 0 || current.inverseLineEndings.length !== 0
    || previous.inverseEdits.length !== 1 || current.inverseEdits.length !== 1
    || previous.forwardEdits.length !== 1 || current.forwardEdits.length !== 1) return undefined;
  const previousForward = previous.forwardEdits[0];
  const currentForward = current.forwardEdits[0];
  const previousInverse = previous.inverseEdits[0];
  const currentInverse = current.inverseEdits[0];
  if (previousForward === undefined || currentForward === undefined
    || previousInverse === undefined || currentInverse === undefined
    || previousForward.start !== previousForward.end || currentForward.start !== currentForward.end
    || previousInverse.text !== '' || currentInverse.text !== ''
    || (currentForward.start as number) !== (previousForward.start as number) + editTextLength(previousForward, 0, previous.forwardTextRuns)
    || (currentInverse.start as number) !== (previousInverse.end as number)
    || previousForward.text.includes('\n') || currentForward.text.includes('\n')
    || previousForward.text.includes('\r') || currentForward.text.includes('\r')) return undefined;

  const run = previous.forwardTextRuns[0] ?? createTextRun(0, previousForward.text);
  appendTextRun(run, textForEdit(currentForward, 0, current.forwardTextRuns));
  return Object.freeze({
    beforeRevisionId: previous.beforeRevisionId,
    afterRevisionId: current.afterRevisionId,
    forwardEdits: Object.freeze([Object.freeze({
      start: previousForward.start,
      end: previousForward.end,
      text: '',
    })]),
    forwardTextRuns: Object.freeze([run]),
    inverseEdits: Object.freeze([Object.freeze({
      start: previousInverse.start,
      end: currentInverse.end,
      text: '',
    })]),
    inverseSources: Object.freeze([]),
    inverseLineEndings: Object.freeze([]),
    retainedUtf16: previous.retainedUtf16 + current.retainedUtf16,
    retainedRootUtf16: 0,
    retainedMetadataBytes: previous.retainedMetadataBytes,
    coalescibleInsert: true,
  });
}

function editTextLength(edit: DocumentEdit, editIndex: number, runs: readonly UndoTextRun[]): number {
  return runs.find((run) => run.editIndex === editIndex)?.length ?? edit.text.length;
}

function createTextRun(editIndex: number, text: string): UndoTextRun {
  const run: UndoTextRun = { editIndex, chunks: [], length: 0, pending: [], pendingLength: 0 };
  appendTextRun(run, text);
  return run;
}

function appendTextRun(run: UndoTextRun, text: string): void {
  for (let start = 0; start < text.length;) {
    const room = MAX_UNDO_TEXT_RUN_CHUNK - run.pendingLength;
    const end = Math.min(text.length, start + room);
    run.pending.push(text.slice(start, end));
    run.pendingLength += end - start;
    run.length += end - start;
    start = end;
    if (run.pendingLength === MAX_UNDO_TEXT_RUN_CHUNK) flushTextRun(run);
  }
}

function flushTextRun(run: UndoTextRun): void {
  if (run.pendingLength === 0) return;
  run.chunks.push(run.pending.join(''));
  run.pending.length = 0;
  run.pendingLength = 0;
}

function materializeTextRun(run: UndoTextRun): string {
  flushTextRun(run);
  return run.chunks.join('');
}

function validRetention(retention: UndoRetention): boolean {
  return Number.isSafeInteger(retention.retainedUtf16) && retention.retainedUtf16 >= 0
    && Number.isSafeInteger(retention.retainedRootUtf16) && retention.retainedRootUtf16 >= 0
    && Number.isSafeInteger(retention.retainedMetadataBytes) && retention.retainedMetadataBytes >= 0;
}

function entryMetadataBytes(
  node: Pick<UndoTreeEntry, 'steps' | 'beforeSelection' | 'afterSelection'>,
  selectionHistory?: { readonly before: SerializedSelectionValue; readonly after: SerializedSelectionValue },
): number {
  const before = node.beforeSelection ?? selectionHistory?.before;
  const after = node.afterSelection ?? selectionHistory?.after;
  return 128 + node.steps.reduce((total, step) => total + step.retainedMetadataBytes, 0)
    + (before === undefined ? 0 : estimateSerializedValueBytes(before))
    + (after === undefined ? 0 : estimateSerializedValueBytes(after));
}

export function estimateUndoStepMetadata(
  forwardEdits: readonly DocumentEdit[],
  inverseEdits: readonly DocumentEdit[],
  inverseLineEndings: readonly InverseLineEndingPatch[],
): number {
  return 96 + (forwardEdits.length + inverseEdits.length) * 48
    + inverseLineEndings.reduce((total, patch) => total + 32 + patch.insert.length * 2, 0);
}

function estimateSerializedValueBytes(value: SerializedSelectionValue): number {
  return canonicalJson(value).length * 2;
}

function checksumOf(value: unknown): string {
  const input = canonicalJson(value);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${fields.join(',')}}`;
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonnegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === Reflect.ownKeys(value).length && keys.every((key) => allowed.includes(key));
}

function isEditOrigin(value: unknown): value is EditOrigin {
  return value === 'vim' || value === 'lsp' || value === 'formatter' || value === 'workspace-replace' || value === 'directory';
}

function isLineEnding(value: unknown): value is LineEnding {
  return value === 'lf' || value === 'crlf' || value === 'cr';
}

function countLineFeeds(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) if (value.charCodeAt(index) === 10) count += 1;
  return count;
}

function hasInvalidUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function revision(value: number): RevisionId { return value as RevisionId; }
