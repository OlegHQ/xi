import {
  asIdentifier,
  type DocumentId,
  type DocumentVersion,
  type RevisionId,
  type Result,
  cloneSerializedSelectionValue,
  type SerializedSelectionValue,
  type UndoGroupId,
  type Utf16Offset,
} from '../../primitives/src/index';
import type { DocumentReadFailure, DocumentSnapshot, VersionedDocumentChange } from './contracts.ts';
import type { DocumentEdit, DocumentMutationFailure } from './rope';

export type EditOrigin = 'vim' | 'lsp' | 'formatter' | 'workspace-replace' | 'directory';
export type AnchorAffinity = 'left' | 'right';

/** Coincident insertion edits are rejected; callers must compose them before commit. */
export const SAME_POSITION_INSERT_POLICY = 'reject' as const;
/** A zero-width insertion at a replacement edge is ambiguous and is rejected by the generic API. */
export const INSERTION_REPLACEMENT_BOUNDARY_POLICY = 'reject' as const;

export interface EditProposal {
  readonly documentId: DocumentId;
  /** Exact document version against which every UTF-16 half-open edit range is expressed. */
  readonly expectedVersion: DocumentVersion;
  readonly edits: readonly DocumentEdit[];
  readonly origin: EditOrigin;
  readonly undoGroup: UndoGroupId;
  /** Optional inert selection intent captured around this atomic edit. */
  readonly selectionHistory?: {
    readonly before: SerializedSelectionValue;
    readonly after: SerializedSelectionValue;
  };
}

export interface DocumentAnchor {
  readonly documentId: DocumentId;
  readonly version: DocumentVersion;
  /** Zero-based UTF-16 code-unit boundary in `version`; never a grapheme or display-cell index. */
  readonly offset: Utf16Offset;
  readonly affinity: AnchorAffinity;
  readonly [documentAnchorBrand]: true;
}

const documentAnchorBrand: unique symbol = Symbol('DocumentAnchor');

export interface ChangedSpan {
  /** Start in the base document version, measured in UTF-16 code units. */
  readonly start: Utf16Offset;
  /** Exclusive end in the base document version, measured in UTF-16 code units. */
  readonly oldEnd: Utf16Offset;
  /** Start in the committed version, measured in UTF-16 code units. */
  readonly newStart: Utf16Offset;
  /** Exclusive end in the committed version, measured in UTF-16 code units. */
  readonly newEnd: Utf16Offset;
}

export type ChangeMapFailure = DocumentReadFailure
  | { readonly kind: 'invalid-anchor' }
  | { readonly kind: 'invalid-anchor-order' }
  | { readonly kind: 'invalid-affinity' }
  | { readonly kind: 'wrong-document' };

export type DocumentTransactionFailure = DocumentMutationFailure
  | { readonly kind: 'invalid-proposal' }
  | { readonly kind: 'invalid-change-version' }
  | { readonly kind: 'wrong-document' }
  | { readonly kind: 'invalid-origin' }
  | { readonly kind: 'invalid-undo-group' }
  | { readonly kind: 'invalid-selection-history' }
  | { readonly kind: 'undo-history-limit' }
  | { readonly kind: 'history-operation-in-progress' }
  | { readonly kind: 'ambiguous-insertion-boundary' }
  | { readonly kind: 'line-ending-index-mismatch' }
  | { readonly kind: 'reentrant-transaction' };

export interface VersionedAnchor {
  readonly documentId: DocumentId;
  readonly version: DocumentVersion;
  readonly offset: Utf16Offset;
  readonly affinity: AnchorAffinity;
}

export interface CommittedDocumentChange extends VersionedDocumentChange {
  readonly origin: EditOrigin;
  readonly undoGroup: UndoGroupId;
  readonly selectionHistory?: EditProposal['selectionHistory'];
  readonly edits: readonly DocumentEdit[];
  readonly changedSpans: readonly ChangedSpan[];
  readonly changeMap: DocumentChangeMap;
  readonly snapshot: DocumentSnapshot;
}

export type CommitOutcome =
  | { readonly kind: 'committed'; readonly change: CommittedDocumentChange }
  | { readonly kind: 'unchanged'; readonly version: DocumentVersion; readonly revisionId: RevisionId };

export type SaveRevisionFailure = { readonly kind: 'wrong-document' } | { readonly kind: 'unknown-revision' };

export interface SaveRevisionIdentity {
  readonly id: DocumentId;
  readonly revisionId: RevisionId;
}

const EDIT_ORIGINS: readonly EditOrigin[] = ['vim', 'lsp', 'formatter', 'workspace-replace', 'directory'];

/** A validated map from one immutable document version to its immediate successor. */
export class DocumentChangeMap {
  readonly changedSpans: readonly ChangedSpan[];
  readonly #edits: readonly DocumentEdit[];
  readonly #beforeLength: number;

  private constructor(
    readonly documentId: DocumentId,
    readonly beforeVersion: DocumentVersion,
    readonly afterVersion: DocumentVersion,
    beforeLength: number,
    edits: readonly DocumentEdit[],
    spans: readonly ChangedSpan[],
  ) {
    this.#beforeLength = beforeLength;
    this.#edits = edits;
    this.changedSpans = Object.freeze(spans.map((span) => Object.freeze({ ...span })));
    Object.freeze(this);
  }

  /** Canonical UTF-16 document-order edits validated against `beforeVersion`. */
  get orderedEdits(): readonly DocumentEdit[] { return this.#edits; }

  static create(
    snapshot: DocumentSnapshot,
    afterVersion: DocumentVersion,
    edits: readonly DocumentEdit[],
  ): Result<DocumentChangeMap, DocumentTransactionFailure> {
    const expectedAfter = (snapshot.version as number) + 1;
    if (!Number.isSafeInteger(expectedAfter) || afterVersion !== expectedAfter) {
      return { ok: false, error: { kind: 'invalid-change-version' } };
    }
    const validation = validateEdits(snapshot, edits);
    if (!validation.ok) return validation;

    let delta = 0;
    const spans: ChangedSpan[] = [];
    for (const edit of validation.value) {
      const newStart = (edit.start as number) + delta;
      const newEnd = newStart + edit.text.length;
      spans.push({
        start: edit.start,
        oldEnd: edit.end,
        newStart: offset(newStart),
        newEnd: offset(newEnd),
      });
      delta += edit.text.length - ((edit.end as number) - (edit.start as number));
    }
    return {
      ok: true,
      value: new DocumentChangeMap(snapshot.id, snapshot.version, afterVersion, snapshot.lengthUtf16, validation.value, spans),
    };
  }

  /**
   * Map canonical, document-order endpoints in O(endpoint count + edit count).
   * Endpoints at the same offset may differ by affinity and retain their input order.
   */
  mapSortedAnchors(anchors: readonly DocumentAnchor[]): Result<readonly VersionedAnchor[], ChangeMapFailure> {
    const mapped: VersionedAnchor[] = [];
    let editIndex = 0;
    let delta = 0;
    let previousOffset = -1;

    for (const anchor of anchors) {
      const position = anchor.offset as number;
      if (anchor[documentAnchorBrand] !== true) return { ok: false, error: { kind: 'invalid-anchor' } };
      if (anchor.documentId !== this.documentId) return { ok: false, error: { kind: 'wrong-document' } };
      if (anchor.version !== this.beforeVersion) return { ok: false, error: { kind: 'stale-version' } };
      if (anchor.affinity !== 'left' && anchor.affinity !== 'right') return { ok: false, error: { kind: 'invalid-affinity' } };
      if (!Number.isSafeInteger(position) || position < 0 || position > this.#beforeLength) {
        return { ok: false, error: { kind: 'invalid-range' } };
      }
      if (position < previousOffset) return { ok: false, error: { kind: 'invalid-anchor-order' } };
      previousOffset = position;

      while (editIndex < this.#edits.length) {
        const edit = this.#edits[editIndex];
        if (edit === undefined) break;
        const start = edit.start as number;
        const end = edit.end as number;
        if (start === end && position === start) break;
        if (position >= end) {
          delta += edit.text.length - (end - start);
          editIndex += 1;
          continue;
        }
        break;
      }

      const edit = this.#edits[editIndex];
      let mappedOffset = position + delta;
      if (edit !== undefined) {
        const start = edit.start as number;
        const end = edit.end as number;
        if (position >= start && position < end || start === end && position === start) {
          mappedOffset = start + delta + (anchor.affinity === 'right' ? edit.text.length : 0);
        } else if (position === start) {
          mappedOffset = start + delta + (anchor.affinity === 'right' ? edit.text.length : 0);
        }
      }
      mapped.push(Object.freeze({
        documentId: this.documentId,
        version: this.afterVersion,
        offset: offset(mappedOffset),
        affinity: anchor.affinity,
      }));
    }
    return { ok: true, value: Object.freeze(mapped) };
  }

  mapAnchor(anchor: DocumentAnchor): Result<VersionedAnchor, ChangeMapFailure> {
    const result = this.mapSortedAnchors([anchor]);
    if (!result.ok) return result;
    const mapped = result.value[0];
    return mapped === undefined
      ? { ok: false, error: { kind: 'invalid-anchor' } }
      : { ok: true, value: mapped };
  }
}

/** Construct an anchor only at a safe UTF-16 boundary of the supplied immutable version. */
export function createDocumentAnchor(
  snapshot: DocumentSnapshot,
  position: Utf16Offset,
  affinity: AnchorAffinity,
): Result<DocumentAnchor, ChangeMapFailure> {
  if (affinity !== 'left' && affinity !== 'right') return { ok: false, error: { kind: 'invalid-affinity' } };
  const valid = snapshot.lineIndexAt(position);
  if (!valid.ok) return valid;
  return {
    ok: true,
    value: Object.freeze({
      documentId: snapshot.id,
      version: snapshot.version,
      offset: position,
      affinity,
      [documentAnchorBrand]: true as const,
    }),
  };
}

/** Strict runtime validation keeps malformed plugin/service proposals out of the mutation path. */
export function validateEditProposal(
  input: unknown,
  documentId: DocumentId,
): Result<EditProposal, DocumentTransactionFailure> {
  if (typeof input !== 'object' || input === null) return { ok: false, error: { kind: 'invalid-proposal' } };
  const proposal = input as Partial<EditProposal>;
  if (proposal.documentId !== documentId) return { ok: false, error: { kind: 'wrong-document' } };
  if (typeof proposal.expectedVersion !== 'number' || !Number.isSafeInteger(proposal.expectedVersion) || proposal.expectedVersion < 0) {
    return { ok: false, error: { kind: 'stale-version' } };
  }
  if (!EDIT_ORIGINS.includes(proposal.origin as EditOrigin)) return { ok: false, error: { kind: 'invalid-origin' } };
  const undoGroup = asIdentifier<UndoGroupId>(proposal.undoGroup, 'undoGroupId');
  if (!undoGroup.ok) return { ok: false, error: { kind: 'invalid-undo-group' } };
  if (!Array.isArray(proposal.edits)) return { ok: false, error: { kind: 'invalid-text' } };

  let selectionHistory: EditProposal['selectionHistory'];
  if (proposal.selectionHistory !== undefined) {
    const state = proposal.selectionHistory;
    if (typeof state !== 'object' || state === null || Array.isArray(state)
      || (Object.getPrototypeOf(state) !== Object.prototype && Object.getPrototypeOf(state) !== null)
      || !Object.hasOwn(state, 'before') || !Object.hasOwn(state, 'after')) {
      return { ok: false, error: { kind: 'invalid-selection-history' } };
    }
    try {
      const before = cloneSerializedSelectionValue((state as { readonly before?: unknown }).before);
      const after = cloneSerializedSelectionValue((state as { readonly after?: unknown }).after);
      if (!before.ok || !after.ok) return { ok: false, error: { kind: 'invalid-selection-history' } };
      selectionHistory = Object.freeze({ before: before.value, after: after.value });
    } catch {
      return { ok: false, error: { kind: 'invalid-selection-history' } };
    }
  }

  const edits: DocumentEdit[] = [];
  for (const candidate of proposal.edits as readonly unknown[]) {
    if (typeof candidate !== 'object' || candidate === null) return { ok: false, error: { kind: 'invalid-text' } };
    const edit = candidate as { readonly start?: unknown; readonly end?: unknown; readonly text?: unknown; readonly textIntent?: unknown };
    if (!isSafeOffset(edit.start) || !isSafeOffset(edit.end) || typeof edit.text !== 'string') {
      return { ok: false, error: { kind: 'invalid-text' } };
    }
    if (edit.textIntent !== undefined && edit.textIntent !== 'literal-control') {
      return { ok: false, error: { kind: 'invalid-text' } };
    }
    edits.push(Object.freeze({
      start: offset(edit.start),
      end: offset(edit.end),
      text: edit.text,
      ...(edit.textIntent === undefined ? {} : { textIntent: edit.textIntent }),
    }));
  }
  const result: EditProposal = {
    documentId,
    expectedVersion: proposal.expectedVersion as DocumentVersion,
    edits: Object.freeze(edits),
    origin: proposal.origin as EditOrigin,
    undoGroup: undoGroup.value,
    ...(selectionHistory === undefined ? {} : { selectionHistory }),
  };
  return {
    ok: true,
    value: Object.freeze(result),
  };
}

function validateEdits(
  snapshot: DocumentSnapshot,
  edits: readonly DocumentEdit[],
): Result<readonly DocumentEdit[], DocumentTransactionFailure> {
  const ordered = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);
  let previous: DocumentEdit | undefined;
  for (const edit of ordered) {
    if ((edit.start as number) > (edit.end as number) || !isNormalizedWellFormedText(edit.text, edit.textIntent)) {
      return { ok: false, error: { kind: 'invalid-text' } };
    }
    const startValid = snapshot.lineIndexAt(edit.start);
    if (!startValid.ok) return startValid;
    const endValid = snapshot.lineIndexAt(edit.end);
    if (!endValid.ok) return endValid;
    if (previous !== undefined) {
      const previousStart = previous.start as number;
      const previousEnd = previous.end as number;
      const start = edit.start as number;
      const end = edit.end as number;
      if (start < previousEnd || start === previousStart) return { ok: false, error: { kind: 'overlapping-edits' } };
      const currentIsInsertion = start === end;
      const previousIsInsertion = previousStart === previousEnd;
      if (currentIsInsertion && start === previousEnd || previousIsInsertion && previousStart === start) {
        return { ok: false, error: { kind: 'ambiguous-insertion-boundary' } };
      }
    }
    previous = edit;
  }
  return { ok: true, value: Object.freeze(ordered.map((edit) => Object.freeze({ ...edit }))) };
}

function isSafeOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNormalizedWellFormedText(text: string, textIntent?: DocumentEdit['textIntent']): boolean {
  if (textIntent === undefined ? text.includes('\r') : textIntent !== 'literal-control' || !text.includes('\r')) return false;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function offset(value: number): Utf16Offset { return value as Utf16Offset; }
