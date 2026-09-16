import { createDocumentAnchor, type DocumentAnchor, type DocumentChangeMap, type DocumentSnapshot } from '../../document/src/entrypoints/launch';
import { asIdentifier } from '../../primitives/src/index';
import type {
  CellColumn,
  DocumentId,
  DocumentVersion,
  LineIndex,
  SelectionGeneration,
  SelectionId,
  Utf16Column,
  Utf16Offset,
} from '../../primitives/src/index';

export type SelectionKind = 'normal-cursor' | 'insert-caret' | 'visual-character' | 'visual-line' | 'visual-block';
export type SelectionDirection = 'forward' | 'backward';
export type EndpointAffinity = 'left' | 'right';
export type SelectionOrdinal = number & { readonly __xiBrand: 'SelectionOrdinal' };

export interface DesiredColumn {
  /** Logical column in UTF-16 code units; null means no preferred logical column. */
  readonly logicalUtf16: Utf16Column | null;
  /** Display-cell column under the active layout width policy; null means unset. */
  readonly displayCell: CellColumn | null;
}

export interface CharacterEndpoint {
  readonly kind: 'character';
  /** Start boundary of the semantic character, in validated UTF-16 coordinates. */
  readonly at: DocumentAnchor;
  /** Exclusive UTF-16 boundary after the semantic character. */
  readonly after: DocumentAnchor;
}

export interface EmptyLineEndpoint {
  readonly kind: 'empty-line';
  readonly at: DocumentAnchor;
  readonly lineIndex: LineIndex;
}

export interface EofEndpoint {
  readonly kind: 'eof';
  readonly at: DocumentAnchor;
}

/** An Insert caret names an insertion gap, not a Normal-mode character. */
export interface GapEndpoint {
  readonly kind: 'gap';
  readonly at: DocumentAnchor;
}

export interface LineEndpoint {
  readonly kind: 'line';
  /** Anchor is normalized to the start of this logical line. */
  readonly at: DocumentAnchor;
  readonly lineIndex: LineIndex;
}

export interface BlockCellEndpoint {
  readonly kind: 'block-cell';
  readonly at: DocumentAnchor;
  readonly lineIndex: LineIndex;
  /** Logical UTF-16 column and display-cell column remain separate units. */
  readonly logicalUtf16Column: Utf16Column;
  readonly displayCellColumn: CellColumn;
  /** Number of virtual display cells beyond the physical line end. */
  readonly virtualCells: number;
}

export type NormalEndpoint = CharacterEndpoint | EmptyLineEndpoint | EofEndpoint;
export type VisualCharacterEndpoint = NormalEndpoint;
export type SelectionEndpoint = NormalEndpoint | GapEndpoint | LineEndpoint | BlockCellEndpoint;

interface MemberBase<K extends SelectionKind, E extends SelectionEndpoint> {
  readonly id: SelectionId;
  readonly kind: K;
  readonly creationOrdinal: SelectionOrdinal;
  readonly direction: SelectionDirection;
  readonly anchor: E;
  readonly head: E;
  readonly desiredColumn: DesiredColumn;
}

export interface NormalCursorMember extends MemberBase<'normal-cursor', NormalEndpoint> {}
export interface InsertCaretMember extends MemberBase<'insert-caret', GapEndpoint> {}
export interface VisualCharacterMember extends MemberBase<'visual-character', VisualCharacterEndpoint> {
  /** Vim's selection option is retained until the range normalizer consumes it. */
  readonly inclusive: boolean;
  /** Cursor column at the Visual anchor, needed when `o` swaps active endpoints. */
  readonly anchorDesiredColumn: DesiredColumn;
}
export interface VisualLineMember extends MemberBase<'visual-line', LineEndpoint> {
  /** Logical/display column of the Normal cursor that became the Visual anchor. */
  readonly anchorDesiredColumn: DesiredColumn;
}
export interface VisualBlockMember extends MemberBase<'visual-block', BlockCellEndpoint> {
  /** Retained for consistent endpoint exchange and virtual-column restoration. */
  readonly anchorDesiredColumn: DesiredColumn;
}

export type SelectionMember = NormalCursorMember | InsertCaretMember | VisualCharacterMember | VisualLineMember | VisualBlockMember;

/** The public value is immutable and owns no text; document APIs validate its versioned anchors. */
export interface SelectionSet {
  readonly documentId: DocumentId;
  readonly documentVersion: DocumentVersion;
  readonly selectionGeneration: SelectionGeneration;
  readonly primaryId: SelectionId;
  readonly members: readonly [SelectionMember, ...SelectionMember[]];
}

/** Kept as the snapshot name used by workbench/Vim read models. */
export type SelectionSetSnapshot = SelectionSet;

export interface SelectionIdMapping {
  readonly from: SelectionId;
  readonly to: SelectionId;
}

export interface CanonicalizedSelectionSet {
  readonly selectionSet: SelectionSet;
  /** Includes identity mappings, so callers can update every old reference explicitly. */
  readonly idMap: readonly SelectionIdMapping[];
}

export type SelectionFailure =
  | { readonly kind: 'empty-selection-set' }
  | { readonly kind: 'invalid-primary' }
  | { readonly kind: 'duplicate-selection-id' }
  | { readonly kind: 'invalid-selection-ordinal' }
  | { readonly kind: 'mixed-selection-kind' }
  | { readonly kind: 'invalid-selection-generation' }
  | { readonly kind: 'invalid-endpoint' }
  | { readonly kind: 'invalid-direction' }
  | { readonly kind: 'invalid-desired-column' }
  | { readonly kind: 'invalid-visual-option' }
  | { readonly kind: 'wrong-document' }
  | { readonly kind: 'stale-version' }
  | { readonly kind: 'invalid-change-map' }
  | { readonly kind: 'document-read-failed' };

export type EndpointInput =
  | { readonly kind: 'character'; readonly offset: Utf16Offset; readonly after: Utf16Offset; readonly affinity?: EndpointAffinity; readonly afterAffinity?: EndpointAffinity }
  | { readonly kind: 'empty-line'; readonly lineIndex: LineIndex; readonly affinity?: EndpointAffinity }
  | { readonly kind: 'eof'; readonly affinity?: EndpointAffinity }
  | { readonly kind: 'gap'; readonly offset: Utf16Offset; readonly affinity?: EndpointAffinity }
  | { readonly kind: 'line'; readonly lineIndex: LineIndex; readonly affinity?: EndpointAffinity }
  | { readonly kind: 'block-cell'; readonly offset: Utf16Offset; readonly logicalUtf16Column: Utf16Column; readonly displayCellColumn: CellColumn; readonly virtualCells: number; readonly affinity?: EndpointAffinity };

interface MemberInputBase<K extends SelectionKind> {
  readonly id: SelectionId;
  readonly kind: K;
  readonly direction: SelectionDirection;
  readonly anchor: EndpointInput;
  readonly head: EndpointInput;
  readonly desiredColumn?: DesiredColumn;
  readonly creationOrdinal?: number;
}

export interface NormalCursorInput extends MemberInputBase<'normal-cursor'> {}
export interface InsertCaretInput extends MemberInputBase<'insert-caret'> {}
export interface VisualCharacterInput extends MemberInputBase<'visual-character'> {
  readonly inclusive: boolean;
  readonly anchorDesiredColumn?: DesiredColumn;
}
export interface VisualLineInput extends MemberInputBase<'visual-line'> {
  /** Defaults to desiredColumn for older serialized/test inputs. */
  readonly anchorDesiredColumn?: DesiredColumn;
}
export interface VisualBlockInput extends MemberInputBase<'visual-block'> { readonly anchorDesiredColumn?: DesiredColumn }
export type SelectionMemberInput = NormalCursorInput | InsertCaretInput | VisualCharacterInput | VisualLineInput | VisualBlockInput;

export interface SelectionSetInput {
  readonly primaryId: SelectionId;
  readonly members: readonly SelectionMemberInput[];
  readonly selectionGeneration?: number;
}

export interface SelectionUpdateInput {
  readonly primaryId: SelectionId;
  readonly members: readonly SelectionMemberInput[];
}

const ZERO_GENERATION = 0 as SelectionGeneration;
const NO_DESIRED_COLUMN: DesiredColumn = Object.freeze({ logicalUtf16: null, displayCell: null });

/** Build, validate and canonicalize an initial set against one immutable document snapshot. */
export function createSelectionSet(
  snapshot: DocumentSnapshot,
  input: SelectionSetInput,
): { readonly ok: true; readonly value: CanonicalizedSelectionSet } | { readonly ok: false; readonly error: SelectionFailure } {
  const generation = input.selectionGeneration ?? ZERO_GENERATION;
  if (!isNonnegativeSafeInteger(generation)) return failure('invalid-selection-generation');
  const members: SelectionMember[] = [];
  for (let index = 0; index < input.members.length; index += 1) {
    const item = input.members[index];
    if (item === undefined) return failure('empty-selection-set');
    const member = createMember(snapshot, item, item.creationOrdinal ?? index);
    if (!member.ok) return member;
    members.push(member.value);
  }
  return canonicalize(snapshot, members, input.primaryId, generation as SelectionGeneration);
}

/**
 * Apply a selection-only update. Document version is copied exactly and only the
 * selection generation advances; text, dirty state and document history are outside this owner.
 */
export function updateSelectionSet(
  snapshot: DocumentSnapshot,
  current: SelectionSet,
  input: SelectionUpdateInput,
): { readonly ok: true; readonly value: CanonicalizedSelectionSet } | { readonly ok: false; readonly error: SelectionFailure } {
  if (current.documentId !== snapshot.id) return failure('wrong-document');
  if (current.documentVersion !== snapshot.version) return failure('stale-version');
  const nextGeneration = (current.selectionGeneration as number) + 1;
  if (!Number.isSafeInteger(nextGeneration)) return failure('invalid-selection-generation');
  const members: SelectionMember[] = [];
  let nextOrdinal = Math.max(...current.members.map((member) => member.creationOrdinal as number)) + 1;
  for (let index = 0; index < input.members.length; index += 1) {
    const item = input.members[index];
    if (item === undefined) return failure('empty-selection-set');
    const old = current.members.find((candidate) => candidate.id === item.id);
    const ordinal = item.creationOrdinal ?? old?.creationOrdinal ?? nextOrdinal++;
    const member = createMember(snapshot, item, ordinal);
    if (!member.ok) return member;
    members.push(member.value);
  }
  return canonicalize(snapshot, members, input.primaryId, nextGeneration as SelectionGeneration);
}

/** Canonicalize an already constructed immutable set and return every identity remap. */
export function canonicalizeSelectionSet(
  snapshot: DocumentSnapshot,
  set: SelectionSet,
): { readonly ok: true; readonly value: CanonicalizedSelectionSet } | { readonly ok: false; readonly error: SelectionFailure } {
  if (set.documentId !== snapshot.id) return failure('wrong-document');
  if (set.documentVersion !== snapshot.version) return failure('stale-version');
  return canonicalize(snapshot, set.members, set.primaryId, set.selectionGeneration);
}

/**
 * Map all semantic endpoints as one sorted batch through an immediate document change,
 * then re-anchor to the destination snapshot and canonicalize post-map collisions.
 */
export function mapSelectionSet(
  set: SelectionSet,
  changeMap: DocumentChangeMap,
  destination: DocumentSnapshot,
): { readonly ok: true; readonly value: CanonicalizedSelectionSet } | { readonly ok: false; readonly error: SelectionFailure } {
  if (set.documentId !== changeMap.documentId || set.documentId !== destination.id) return failure('wrong-document');
  if (set.documentVersion !== changeMap.beforeVersion) return failure('stale-version');
  if (destination.version !== changeMap.afterVersion) return failure('invalid-change-map');

  const anchors: { readonly token: number; readonly anchor: DocumentAnchor }[] = [];
  const endpoints: { readonly memberIndex: number; readonly field: 'anchor' | 'head'; readonly part: 'at' | 'after'; readonly endpoint: SelectionEndpoint }[] = [];
  for (let memberIndex = 0; memberIndex < set.members.length; memberIndex += 1) {
    const member = set.members[memberIndex];
    if (member === undefined) return failure('empty-selection-set');
    for (const field of ['anchor', 'head'] as const) {
      const endpoint = member[field];
      endpoints.push({ memberIndex, field, part: 'at', endpoint });
      if (endpoint.kind === 'character') endpoints.push({ memberIndex, field, part: 'after', endpoint });
    }
  }
  for (let token = 0; token < endpoints.length; token += 1) {
    const entry = endpoints[token];
    if (entry === undefined) return failure('invalid-endpoint');
    anchors.push({ token, anchor: entry.part === 'after' && entry.endpoint.kind === 'character' ? entry.endpoint.after : entry.endpoint.at });
  }
  anchors.sort((left, right) => (left.anchor.offset as number) - (right.anchor.offset as number) || left.token - right.token);
  const mappedResult = changeMap.mapSortedAnchors(anchors.map((entry) => entry.anchor));
  if (!mappedResult.ok) return failure(mappedResult.error.kind === 'wrong-document' ? 'wrong-document' : mappedResult.error.kind === 'stale-version' ? 'stale-version' : 'invalid-change-map');

  const mappedOffsets = new Map<number, { readonly offset: Utf16Offset; readonly affinity: EndpointAffinity }>();
  for (let index = 0; index < anchors.length; index += 1) {
    const original = anchors[index];
    const mapped = mappedResult.value[index];
    if (original === undefined || mapped === undefined) return failure('invalid-change-map');
    mappedOffsets.set(original.token, { offset: mapped.offset, affinity: mapped.affinity });
  }

  const endpointParts = new Map<string, { at?: DocumentAnchor; after?: DocumentAnchor }>();
  for (let token = 0; token < endpoints.length; token += 1) {
    const descriptor = endpoints[token];
    const mapped = mappedOffsets.get(token);
    if (descriptor === undefined || mapped === undefined) return failure('invalid-change-map');
    let offset = mapped.offset;
    const oldEndpoint = descriptor.endpoint;
    if (oldEndpoint.kind === 'line' && descriptor.part === 'at') {
      const lineAt = destination.lineIndexAt(offset);
      if (!lineAt.ok) return failure('document-read-failed');
      const start = destination.lineStartOffset(lineAt.value);
      if (!start.ok) return failure('document-read-failed');
      offset = start.value;
    }
    const anchorResult = createDocumentAnchor(destination, offset, mapped.affinity);
    if (!anchorResult.ok) return failure('invalid-change-map');
    const key = `${descriptor.memberIndex}:${descriptor.field}`;
    const prior = endpointParts.get(key) ?? {};
    if (descriptor.part === 'at') prior.at = anchorResult.value;
    else prior.after = anchorResult.value;
    endpointParts.set(key, prior);
  }

  const mappedMembers: SelectionMember[] = [];
  for (let index = 0; index < set.members.length; index += 1) {
    const source = set.members[index];
    if (source === undefined) return failure('empty-selection-set');
    const anchorParts = endpointParts.get(`${index}:anchor`);
    const headParts = endpointParts.get(`${index}:head`);
    if (anchorParts?.at === undefined || headParts?.at === undefined) return failure('invalid-change-map');
    const anchor = remapEndpoint(source.anchor, anchorParts, destination);
    const head = remapEndpoint(source.head, headParts, destination);
    if (!anchor.ok || !head.ok) return failure('invalid-change-map');
    mappedMembers.push(cloneMember(source, anchor.value, head.value));
  }
  return canonicalize(destination, mappedMembers, set.primaryId, set.selectionGeneration);
}

function remapEndpoint(
  previous: SelectionEndpoint,
  parts: { readonly at?: DocumentAnchor; readonly after?: DocumentAnchor },
  snapshot: DocumentSnapshot,
): { readonly ok: true; readonly value: SelectionEndpoint } | { readonly ok: false; readonly error: SelectionFailure } {
  const at = parts.at;
  if (at === undefined) return failure('invalid-change-map');
  switch (previous.kind) {
    case 'character': {
      if (parts.after === undefined) return failure('invalid-change-map');
      if ((parts.after.offset as number) > (at.offset as number)) {
        const text = snapshot.slice(at.offset, parts.after.offset);
        if (!text.ok || text.value.length === 0 || text.value.includes('\n')) return failure('invalid-change-map');
        return success(Object.freeze({ kind: 'character', at, after: parts.after }));
      }
      return semanticEndpointAt(snapshot, at);
    }
    case 'empty-line': {
      const line = snapshot.lineIndexAt(at.offset);
      if (!line.ok) return failure('invalid-change-map');
      const span = lineSpan(snapshot, line.value);
      return span !== undefined && span.contentStart === span.contentEnd
        ? success(Object.freeze({ kind: 'empty-line', at, lineIndex: line.value }))
        : semanticEndpointAt(snapshot, at);
    }
    case 'eof':
      return (at.offset as number) === snapshot.lengthUtf16
        ? success(Object.freeze({ kind: 'eof', at }))
        : semanticEndpointAt(snapshot, at);
    case 'gap': return success(Object.freeze({ kind: 'gap', at }));
    case 'line': {
      const line = snapshot.lineIndexAt(at.offset);
      return line.ok ? success(Object.freeze({ kind: 'line', at, lineIndex: line.value })) : failure('invalid-change-map');
    }
    case 'block-cell': {
      const line = snapshot.lineIndexAt(at.offset);
      return line.ok
        ? success(Object.freeze({ ...previous, at, lineIndex: line.value }))
        : failure('invalid-change-map');
    }
  }
}

function createMember(
  snapshot: DocumentSnapshot,
  input: SelectionMemberInput,
  ordinal: number,
): { readonly ok: true; readonly value: SelectionMember } | { readonly ok: false; readonly error: SelectionFailure } {
  if (!isNonnegativeSafeInteger(ordinal)) return failure('invalid-selection-ordinal');
  if (!asIdentifier<SelectionId>(input.id, 'selectionId').ok) return failure('invalid-endpoint');
  if (input.direction !== 'forward' && input.direction !== 'backward') return failure('invalid-direction');
  const desired = validateDesiredColumn(input.desiredColumn ?? NO_DESIRED_COLUMN);
  if (!desired.ok) return desired;
  const anchorDesired = input.kind === 'visual-character' || input.kind === 'visual-line' || input.kind === 'visual-block'
    ? validateDesiredColumn(input.anchorDesiredColumn ?? input.desiredColumn ?? NO_DESIRED_COLUMN)
    : undefined;
  if (anchorDesired !== undefined && !anchorDesired.ok) return anchorDesired;
  const anchor = createEndpoint(snapshot, input.anchor);
  const head = createEndpoint(snapshot, input.head);
  if (!anchor.ok || !head.ok) return failure('invalid-endpoint');
  const base = {
    id: input.id,
    direction: input.direction,
    creationOrdinal: ordinal as SelectionOrdinal,
    anchor: anchor.value,
    head: head.value,
    desiredColumn: desired.value,
  };
  switch (input.kind) {
    case 'normal-cursor':
      if (!isNormalEndpoint(anchor.value) || !isNormalEndpoint(head.value)) return failure('invalid-endpoint');
      return success(Object.freeze({ ...base, kind: input.kind }) as NormalCursorMember);
    case 'insert-caret':
      if (anchor.value.kind !== 'gap' || head.value.kind !== 'gap') return failure('invalid-endpoint');
      return success(Object.freeze({ ...base, kind: input.kind }) as InsertCaretMember);
    case 'visual-character':
      if (!isNormalEndpoint(anchor.value) || !isNormalEndpoint(head.value)) return failure('invalid-endpoint');
      if (typeof input.inclusive !== 'boolean') return failure('invalid-visual-option');
      return success(Object.freeze({ ...base, kind: input.kind, inclusive: input.inclusive, anchorDesiredColumn: anchorDesired?.value ?? desired.value }) as VisualCharacterMember);
    case 'visual-line':
      if (anchor.value.kind !== 'line' || head.value.kind !== 'line') return failure('invalid-endpoint');
      return success(Object.freeze({ ...base, kind: input.kind, anchorDesiredColumn: anchorDesired?.value ?? desired.value }) as VisualLineMember);
    case 'visual-block':
      if (anchor.value.kind !== 'block-cell' || head.value.kind !== 'block-cell') return failure('invalid-endpoint');
      return success(Object.freeze({ ...base, kind: input.kind, anchorDesiredColumn: anchorDesired?.value ?? desired.value }) as VisualBlockMember);
  }
}

function createEndpoint(
  snapshot: DocumentSnapshot,
  input: EndpointInput,
): { readonly ok: true; readonly value: SelectionEndpoint } | { readonly ok: false; readonly error: SelectionFailure } {
  const affinity = input.affinity ?? 'right';
  if (affinity !== 'left' && affinity !== 'right') return failure('invalid-endpoint');
  switch (input.kind) {
    case 'character': {
      if (!isSafeOffset(input.offset) || !isSafeOffset(input.after) || input.after <= input.offset) return failure('invalid-endpoint');
      const text = snapshot.slice(input.offset, input.after);
      if (!text.ok || text.value.length === 0 || text.value.includes('\n')) return failure('invalid-endpoint');
      const at = createDocumentAnchor(snapshot, input.offset, affinity);
      const after = createDocumentAnchor(snapshot, input.after, input.afterAffinity ?? 'right');
      if (!at.ok || !after.ok) return failure('invalid-endpoint');
      return success(Object.freeze({ kind: 'character', at: at.value, after: after.value }));
    }
    case 'empty-line': {
      const span = lineSpan(snapshot, input.lineIndex);
      if (span === undefined || span.contentStart !== span.contentEnd) return failure('invalid-endpoint');
      const at = createDocumentAnchor(snapshot, span.contentStart, affinity);
      if (!at.ok) return failure('invalid-endpoint');
      return success(Object.freeze({ kind: 'empty-line', at: at.value, lineIndex: input.lineIndex }));
    }
    case 'eof': {
      if (affinity !== 'right') return failure('invalid-endpoint');
      const at = createDocumentAnchor(snapshot, snapshot.lengthUtf16 as Utf16Offset, 'right');
      return at.ok ? success(Object.freeze({ kind: 'eof', at: at.value })) : failure('invalid-endpoint');
    }
    case 'gap': {
      const at = createDocumentAnchor(snapshot, input.offset, affinity);
      return at.ok ? success(Object.freeze({ kind: 'gap', at: at.value })) : failure('invalid-endpoint');
    }
    case 'line': {
      const start = snapshot.lineStartOffset(input.lineIndex);
      if (!start.ok) return failure('invalid-endpoint');
      const at = createDocumentAnchor(snapshot, start.value, affinity);
      return at.ok ? success(Object.freeze({ kind: 'line', at: at.value, lineIndex: input.lineIndex })) : failure('invalid-endpoint');
    }
    case 'block-cell': {
      if (!isNonnegativeSafeInteger(input.virtualCells) || !isNonnegativeSafeInteger(input.logicalUtf16Column) || !isNonnegativeSafeInteger(input.displayCellColumn)) return failure('invalid-endpoint');
      const line = snapshot.lineIndexAt(input.offset);
      const at = createDocumentAnchor(snapshot, input.offset, affinity);
      if (!line.ok || !at.ok) return failure('invalid-endpoint');
      return success(Object.freeze({
        kind: 'block-cell',
        at: at.value,
        lineIndex: line.value,
        logicalUtf16Column: input.logicalUtf16Column,
        displayCellColumn: input.displayCellColumn,
        virtualCells: input.virtualCells,
      }));
    }
  }
}

function canonicalize(
  snapshot: DocumentSnapshot,
  inputMembers: readonly SelectionMember[],
  primaryId: SelectionId,
  selectionGeneration: SelectionGeneration,
): { readonly ok: true; readonly value: CanonicalizedSelectionSet } | { readonly ok: false; readonly error: SelectionFailure } {
  if (inputMembers.length === 0) return failure('empty-selection-set');
  if (!isNonnegativeSafeInteger(selectionGeneration)) return failure('invalid-selection-generation');
  const ids = new Set<SelectionId>();
  const ordinals = new Set<number>();
  let kind: SelectionKind | undefined;
  let visualInclusive: boolean | undefined;
  let primaryExists = false;
  for (const member of inputMembers) {
    if (ids.has(member.id)) return failure('duplicate-selection-id');
    ids.add(member.id);
    const ordinal = member.creationOrdinal as number;
    if (!isNonnegativeSafeInteger(ordinal) || ordinals.has(ordinal)) return failure('invalid-selection-ordinal');
    ordinals.add(ordinal);
    if (kind !== undefined && member.kind !== kind) return failure('mixed-selection-kind');
    kind = member.kind;
    if (member.kind === 'visual-character') {
      if (visualInclusive !== undefined && member.inclusive !== visualInclusive) return failure('invalid-visual-option');
      visualInclusive = member.inclusive;
    }
    if (member.id === primaryId) primaryExists = true;
    if (!validateMember(snapshot, member)) return failure('invalid-endpoint');
  }
  if (!primaryExists) return failure('invalid-primary');

  const ordered = [...inputMembers].sort(compareMembers);
  const groups: SelectionGroup[] = [];
  const duplicateCarets = new Map<string, SelectionGroup>();
  for (const member of ordered) {
    if (member.kind === 'normal-cursor' || member.kind === 'insert-caret') {
      const key = caretIdentity(member);
      const duplicate = duplicateCarets.get(key);
      if (duplicate !== undefined) extendGroup(duplicate, member);
      else {
        const created = makeGroup(member);
        groups.push(created);
        duplicateCarets.set(key, created);
      }
      continue;
    }
    const last = groups[groups.length - 1];
    if (last !== undefined && canJoinGroup(last, member)) extendGroup(last, member);
    else groups.push(makeGroup(member));
  }

  const finalMembers: SelectionMember[] = [];
  const oldToNew = new Map<SelectionId, SelectionId>();
  let finalPrimary = primaryId;
  for (const grouped of groups) {
    const group = grouped.members;
    const retained = chooseRetained(group, primaryId);
    const merged = mergeGroup(group, retained);
    finalMembers.push(merged);
    for (const oldMember of group) oldToNew.set(oldMember.id, retained.id);
    if (group.some((member) => member.id === primaryId)) finalPrimary = retained.id;
  }
  finalMembers.sort(compareMembers);
  const tuple = finalMembers as [SelectionMember, ...SelectionMember[]];
  const selectionSet: SelectionSet = Object.freeze({
    documentId: snapshot.id,
    documentVersion: snapshot.version,
    selectionGeneration,
    primaryId: finalPrimary,
    members: Object.freeze(tuple),
  });
  // Keep the identity-map ordering linear to construct. Looking up an
  // ordinal by scanning inputMembers here made 10k-member creation and
  // post-edit canonicalization quadratic even though all other passes are
  // sorted or linear.
  const inputOrdinals = new Map(inputMembers.map((member) => [member.id, member.creationOrdinal as number]));
  const idMap = [...oldToNew.entries()]
    .sort((left, right) => (inputOrdinals.get(left[0]) ?? 0) - (inputOrdinals.get(right[0]) ?? 0))
    .map(([from, to]) => Object.freeze({ from, to }));
  return success(Object.freeze({ selectionSet, idMap: Object.freeze(idMap) }));
}

function validateMember(snapshot: DocumentSnapshot, member: SelectionMember): boolean {
  if (!validateDesiredColumn(member.desiredColumn).ok) return false;
  if (member.kind === 'visual-character' && typeof member.inclusive !== 'boolean') return false;
  if (member.kind === 'normal-cursor' || member.kind === 'insert-caret') {
    if (!sameEndpoint(member.anchor, member.head)) return false;
  }
  const anchors: DocumentAnchor[] = [];
  for (const endpoint of [member.anchor, member.head]) {
    anchors.push(endpoint.at);
    if (endpoint.kind === 'character') anchors.push(endpoint.after);
    if (member.kind === 'normal-cursor' && !isNormalEndpoint(endpoint)) return false;
    if (member.kind === 'insert-caret' && endpoint.kind !== 'gap') return false;
    if (member.kind === 'visual-character' && !isNormalEndpoint(endpoint)) return false;
    if (member.kind === 'visual-line' && endpoint.kind !== 'line') return false;
    if (member.kind === 'visual-block' && endpoint.kind !== 'block-cell') return false;
    if (endpoint.kind === 'line' || endpoint.kind === 'empty-line' || endpoint.kind === 'block-cell') {
      const line = snapshot.lineIndexAt(endpoint.at.offset);
      if (!line.ok || line.value !== endpoint.lineIndex) return false;
      if (endpoint.kind === 'line') {
        const start = snapshot.lineStartOffset(endpoint.lineIndex);
        if (!start.ok || start.value !== endpoint.at.offset) return false;
      }
      if (endpoint.kind === 'empty-line') {
        const span = lineSpan(snapshot, endpoint.lineIndex);
        if (span === undefined || span.contentStart !== span.contentEnd) return false;
      }
      if (endpoint.kind === 'block-cell' && (!isNonnegativeSafeInteger(endpoint.virtualCells) || !isNonnegativeSafeInteger(endpoint.logicalUtf16Column) || !isNonnegativeSafeInteger(endpoint.displayCellColumn))) return false;
    }
    if (endpoint.kind === 'character') {
      if ((endpoint.after.offset as number) <= (endpoint.at.offset as number)) return false;
      const text = snapshot.slice(endpoint.at.offset, endpoint.after.offset);
      if (!text.ok || text.value.length === 0 || text.value.includes('\n')) return false;
    }
    if (endpoint.kind === 'eof' && (endpoint.at.offset as number) !== snapshot.lengthUtf16) return false;
  }
  for (const anchor of anchors) {
    if (anchor.documentId !== snapshot.id || anchor.version !== snapshot.version) return false;
    if (anchor.affinity !== 'left' && anchor.affinity !== 'right') return false;
    if (!snapshot.lineIndexAt(anchor.offset).ok) return false;
  }
  return true;
}

interface SelectionGroup {
  readonly members: SelectionMember[];
  span: { readonly start: number; readonly end: number } | undefined;
  block: BlockShape | undefined;
}

function makeGroup(member: SelectionMember): SelectionGroup {
  return {
    members: [member],
    span: member.kind === 'visual-character' ? characterCoverage(member) : member.kind === 'visual-line' ? lineCoverage(member) : undefined,
    block: member.kind === 'visual-block' ? blockShape(member) : undefined,
  };
}

function extendGroup(group: SelectionGroup, member: SelectionMember): void {
  group.members.push(member);
  if (member.kind === 'visual-character' || member.kind === 'visual-line') {
    const next = member.kind === 'visual-character' ? characterCoverage(member) : lineCoverage(member);
    const current = group.span;
    group.span = current === undefined
      ? next
      : { start: Math.min(current.start, next.start), end: Math.max(current.end, next.end) };
  }
  if (member.kind === 'visual-block') {
    const next = blockShape(member);
    group.block = group.block === undefined ? next : unionBounds(group.block, next);
  }
}

function canJoinGroup(group: SelectionGroup, candidate: SelectionMember): boolean {
  const kind = candidate.kind;
  const previous = group.members[0];
  if (previous === undefined || previous.kind !== kind) return false;
  if (kind === 'normal-cursor' || kind === 'insert-caret') return exactCaret(previous, candidate);
  if (kind === 'visual-character') {
    return previous.kind === 'visual-character' && previous.inclusive === candidate.inclusive
      && group.span !== undefined && characterIntervalsJoin(group.span, characterCoverage(candidate));
  }
  if (kind === 'visual-line') {
    return group.span !== undefined && lineIntervalsJoin(group.span, lineCoverage(candidate));
  }
  if (kind === 'visual-block') {
    if (!blockVirtualCompatible(previous, candidate) || group.block === undefined) return false;
    return blockUnionIsRectangle(group.block, blockShape(candidate));
  }
  return false;
}

function mergeGroup(group: readonly SelectionMember[], retained: SelectionMember): SelectionMember {
  if (group.length === 1) return retained;
  switch (retained.kind) {
    case 'normal-cursor':
    case 'insert-caret': return retained;
    case 'visual-character': return mergeVisualCharacter(group as readonly VisualCharacterMember[], retained);
    case 'visual-line': return mergeVisualLine(group as readonly VisualLineMember[], retained);
    case 'visual-block': return mergeVisualBlock(group as readonly VisualBlockMember[], retained);
  }
}

function mergeVisualCharacter(group: readonly VisualCharacterMember[], retained: VisualCharacterMember): VisualCharacterMember {
  const ranges = group.map((member) => characterCoverage(member));
  const low = Math.min(...ranges.map((range) => range.start));
  const high = Math.max(...ranges.map((range) => range.end));
  const starts = group.flatMap((member) => [member.anchor, member.head]);
  const lowAt = chooseEndpoint(starts, (endpoint) => {
    const boundary = retained.direction === 'backward' && !retained.inclusive ? endpointEnd(endpoint) : endpoint.at.offset as number;
    return boundary === low;
  });
  const highAt = chooseEndpoint(starts, (endpoint) => {
    const boundary = retained.direction === 'forward' && !retained.inclusive ? endpoint.at.offset as number : endpointEnd(endpoint);
    return boundary === high;
  });
  let anchor: VisualCharacterEndpoint;
  let head: VisualCharacterEndpoint;
  if (retained.direction === 'forward') { anchor = lowAt; head = highAt; }
  else { anchor = highAt; head = lowAt; }
  return Object.freeze({
    ...retained, anchor, head,
    anchorDesiredColumn: visualEndpointDesiredColumn(group, anchor, retained.anchorDesiredColumn),
    desiredColumn: visualEndpointDesiredColumn(group, head, retained.desiredColumn),
  });
}

function mergeVisualLine(group: readonly VisualLineMember[], retained: VisualLineMember): VisualLineMember {
  const endpoints = group.flatMap((member) => [member.anchor, member.head]);
  const minLine = Math.min(...endpoints.map((endpoint) => endpoint.lineIndex as number));
  const maxLine = Math.max(...endpoints.map((endpoint) => endpoint.lineIndex as number));
  const low = chooseEndpoint(endpoints, (endpoint) => endpoint.lineIndex === minLine);
  const high = chooseEndpoint(endpoints, (endpoint) => endpoint.lineIndex === maxLine);
  const anchor = retained.direction === 'forward' ? low : high;
  const head = retained.direction === 'forward' ? high : low;
  return Object.freeze({
    ...retained,
    anchor,
    head,
    anchorDesiredColumn: visualEndpointDesiredColumn(group, anchor, retained.anchorDesiredColumn),
    desiredColumn: visualEndpointDesiredColumn(group, head, retained.desiredColumn),
  });
}

function mergeVisualBlock(group: readonly VisualBlockMember[], retained: VisualBlockMember): VisualBlockMember {
  const endpoints = group.flatMap((member) => [member.anchor, member.head]);
  const shape = group.map(blockShape).reduce(unionBounds);
  const anchor = chooseEndpoint(endpoints, (endpoint) => endpoint.lineIndex as number === shape.top && endpoint.displayCellColumn as number === shape.left);
  const head = chooseEndpoint(endpoints, (endpoint) => endpoint.lineIndex as number === shape.bottom && endpoint.displayCellColumn as number === shape.right);
  const directedAnchor = retained.direction === 'forward' ? anchor : head;
  const directedHead = retained.direction === 'forward' ? head : anchor;
  return Object.freeze({
    ...retained,
    anchor: directedAnchor,
    head: directedHead,
    anchorDesiredColumn: visualEndpointDesiredColumn(group, directedAnchor, retained.anchorDesiredColumn),
    desiredColumn: visualEndpointDesiredColumn(group, directedHead, retained.desiredColumn),
  });
}

function visualEndpointDesiredColumn(
  group: readonly (VisualCharacterMember | VisualLineMember | VisualBlockMember)[],
  endpoint: SelectionEndpoint,
  fallback: DesiredColumn,
): DesiredColumn {
  for (const member of group) {
    if (sameEndpoint(member.anchor, endpoint)) return member.anchorDesiredColumn;
    if (sameEndpoint(member.head, endpoint)) return member.desiredColumn;
  }
  return fallback;
}

function chooseRetained(group: readonly SelectionMember[], primaryId: SelectionId): SelectionMember {
  const primary = group.find((member) => member.id === primaryId);
  if (primary !== undefined) return primary;
  return [...group].sort((left, right) => (left.creationOrdinal as number) - (right.creationOrdinal as number))[0] as SelectionMember;
}

function exactCaret(left: SelectionMember, right: SelectionMember): boolean {
  return left.kind === right.kind
    && sameEndpoint(left.anchor, right.anchor)
    && sameEndpoint(left.head, right.head)
    && sameDesiredColumn(left.desiredColumn, right.desiredColumn);
}

function caretIdentity(member: NormalCursorMember | InsertCaretMember): string {
  const endpoint = (value: SelectionEndpoint): string => {
    if (value.kind === 'character') return `character:${value.at.offset}:${value.at.affinity}:${value.after.offset}:${value.after.affinity}`;
    if (value.kind === 'block-cell') return `block:${value.at.offset}:${value.at.affinity}:${value.lineIndex}:${value.logicalUtf16Column}:${value.displayCellColumn}:${value.virtualCells}`;
    if (value.kind === 'line' || value.kind === 'empty-line') return `${value.kind}:${value.at.offset}:${value.at.affinity}:${value.lineIndex}`;
    return `${value.kind}:${value.at.offset}:${value.at.affinity}`;
  };
  return `${member.kind}|${endpoint(member.anchor)}|${endpoint(member.head)}|desired:${member.desiredColumn.logicalUtf16}:${member.desiredColumn.displayCell}`;
}

function sameDesiredColumn(left: DesiredColumn, right: DesiredColumn): boolean {
  return left.logicalUtf16 === right.logicalUtf16 && left.displayCell === right.displayCell;
}

function sameEndpoint(left: SelectionEndpoint, right: SelectionEndpoint): boolean {
  if (left.kind !== right.kind || left.at.offset !== right.at.offset || left.at.affinity !== right.at.affinity) return false;
  if (left.kind === 'character' && right.kind === 'character') return left.after.offset === right.after.offset && left.after.affinity === right.after.affinity;
  if (left.kind === 'line' && right.kind === 'line' || left.kind === 'empty-line' && right.kind === 'empty-line') return left.lineIndex === right.lineIndex;
  if (left.kind === 'block-cell' && right.kind === 'block-cell') return left.lineIndex === right.lineIndex && left.logicalUtf16Column === right.logicalUtf16Column && left.displayCellColumn === right.displayCellColumn && left.virtualCells === right.virtualCells;
  return true;
}

function characterCoverage(member: VisualCharacterMember): { readonly start: number; readonly end: number } {
  const anchorStart = member.anchor.at.offset as number;
  const headStart = member.head.at.offset as number;
  const anchorEnd = endpointEnd(member.anchor);
  const headEnd = endpointEnd(member.head);
  if (member.direction === 'forward') return { start: anchorStart, end: member.inclusive ? headEnd : headStart };
  return { start: member.inclusive ? headStart : headEnd, end: anchorEnd };
}

function endpointEnd(endpoint: VisualCharacterEndpoint): number {
  return endpoint.kind === 'character' ? endpoint.after.offset as number : endpoint.at.offset as number;
}

function characterIntervalsJoin(left: { readonly start: number; readonly end: number }, right: { readonly start: number; readonly end: number }): boolean {
  const leftPoint = left.start === left.end;
  const rightPoint = right.start === right.end;
  if (leftPoint) return left.start >= right.start && left.start < right.end;
  if (rightPoint) return right.start >= left.start && right.start < left.end;
  return left.start < right.end && right.start < left.end;
}

function lineCoverage(member: VisualLineMember): { readonly start: number; readonly end: number } {
  const first = Math.min(member.anchor.lineIndex as number, member.head.lineIndex as number);
  const last = Math.max(member.anchor.lineIndex as number, member.head.lineIndex as number);
  return { start: first, end: last + 1 };
}

function lineIntervalsJoin(left: { readonly start: number; readonly end: number }, right: { readonly start: number; readonly end: number }): boolean {
  return left.start < right.end && right.start < left.end;
}

interface BlockShape { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number }

function blockShape(member: SelectionMember): BlockShape {
  if (member.kind !== 'visual-block') throw new Error('invalid-block-member');
  return {
    top: Math.min(member.anchor.lineIndex as number, member.head.lineIndex as number),
    bottom: Math.max(member.anchor.lineIndex as number, member.head.lineIndex as number),
    left: Math.min(member.anchor.displayCellColumn as number, member.head.displayCellColumn as number),
    right: Math.max(member.anchor.displayCellColumn as number, member.head.displayCellColumn as number),
  };
}

function blockVirtualCompatible(left: SelectionMember, right: SelectionMember): boolean {
  if (left.kind !== 'visual-block' || right.kind !== 'visual-block') return false;
  const a = blockCornerVirtualCells(left);
  const b = blockCornerVirtualCells(right);
  return a.topLeft === b.topLeft && a.bottomRight === b.bottomRight;
}

function blockCornerVirtualCells(member: VisualBlockMember): { readonly topLeft: number; readonly bottomRight: number } {
  const top = Math.min(member.anchor.lineIndex as number, member.head.lineIndex as number);
  const left = Math.min(member.anchor.displayCellColumn as number, member.head.displayCellColumn as number);
  const anchorIsTopLeft = member.anchor.lineIndex as number === top && member.anchor.displayCellColumn as number === left;
  const topLeft = anchorIsTopLeft ? member.anchor.virtualCells : member.head.virtualCells;
  const bottomRight = anchorIsTopLeft ? member.head.virtualCells : member.anchor.virtualCells;
  return { topLeft, bottomRight };
}

function blockUnionIsRectangle(left: BlockShape, right: BlockShape): boolean {
  const union = unionBounds(left, right);
  const area = (shape: BlockShape): bigint => BigInt(shape.bottom - shape.top + 1) * BigInt(shape.right - shape.left + 1);
  const intersectionHeight = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) + 1);
  const intersectionWidth = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left) + 1);
  return area(union) === area(left) + area(right) - BigInt(intersectionHeight) * BigInt(intersectionWidth);
}

function unionBounds(left: BlockShape, right: BlockShape): BlockShape {
  return {
    top: Math.min(left.top, right.top),
    bottom: Math.max(left.bottom, right.bottom),
    left: Math.min(left.left, right.left),
    right: Math.max(left.right, right.right),
  };
}

function compareMembers(left: SelectionMember, right: SelectionMember): number {
  if (left.kind === 'visual-block' && right.kind === 'visual-block') {
    const a = blockShape(left);
    const b = blockShape(right);
    return a.top - b.top || a.left - b.left || a.bottom - b.bottom || a.right - b.right
      || (left.creationOrdinal as number) - (right.creationOrdinal as number);
  }
  const a = memberSpan(left);
  const b = memberSpan(right);
  return a.start - b.start || a.end - b.end || (left.creationOrdinal as number) - (right.creationOrdinal as number);
}

function memberSpan(member: SelectionMember): { readonly start: number; readonly end: number } {
  if (member.kind === 'visual-character') return characterCoverage(member);
  if (member.kind === 'visual-line') return lineCoverage(member);
  if (member.kind === 'visual-block') return { start: Math.min(member.anchor.at.offset as number, member.head.at.offset as number), end: Math.max(member.anchor.at.offset as number, member.head.at.offset as number) };
  const at = member.anchor.at.offset as number;
  return { start: at, end: at };
}

function chooseEndpoint<E>(endpoints: readonly E[], predicate: (endpoint: E) => boolean): E {
  const selected = endpoints.find(predicate);
  if (selected === undefined) throw new Error('canonical-endpoint-not-found');
  return selected;
}

function semanticEndpointAt(
  snapshot: DocumentSnapshot,
  original: DocumentAnchor,
): { readonly ok: true; readonly value: NormalEndpoint } | { readonly ok: false; readonly error: SelectionFailure } {
  const offset = original.offset as number;
  if (offset >= snapshot.lengthUtf16) {
    const eof = createDocumentAnchor(snapshot, snapshot.lengthUtf16 as Utf16Offset, 'right');
    return eof.ok ? success(Object.freeze({ kind: 'eof', at: eof.value })) : failure('invalid-change-map');
  }
  const line = snapshot.lineIndexAt(original.offset);
  if (!line.ok) return failure('invalid-change-map');
  const span = lineSpan(snapshot, line.value);
  if (span === undefined) return failure('invalid-change-map');
  let start = offset;
  if (offset >= (span.contentEnd as number)) {
    if (span.contentStart === span.contentEnd) {
      const at = createDocumentAnchor(snapshot, span.contentStart, original.affinity);
      return at.ok ? success(Object.freeze({ kind: 'empty-line', at: at.value, lineIndex: line.value })) : failure('invalid-change-map');
    }
    start = previousScalarStart(snapshot, span.contentEnd as number, span.contentStart as number);
  }
  const first = snapshot.slice(start as Utf16Offset, (start + 1) as Utf16Offset);
  if (!first.ok) return failure('invalid-change-map');
  const firstUnit = first.value.charCodeAt(0);
  const end = start + (firstUnit >= 0xd800 && firstUnit <= 0xdbff ? 2 : 1);
  const at = createDocumentAnchor(snapshot, start as Utf16Offset, original.affinity);
  const after = createDocumentAnchor(snapshot, end as Utf16Offset, 'right');
  if (!at.ok || !after.ok) return failure('invalid-change-map');
  return success(Object.freeze({ kind: 'character', at: at.value, after: after.value }));
}

function previousScalarStart(snapshot: DocumentSnapshot, exclusiveEnd: number, minimum: number): number {
  let candidate = Math.max(minimum, exclusiveEnd - 1);
  if (candidate > minimum) {
    const previous = snapshot.slice((candidate - 1) as Utf16Offset, candidate as Utf16Offset);
    if (previous.ok && previous.value.charCodeAt(0) >= 0xdc00 && previous.value.charCodeAt(0) <= 0xdfff) candidate -= 1;
  }
  return candidate;
}

function lineSpan(snapshot: DocumentSnapshot, lineIndex: LineIndex): { readonly contentStart: Utf16Offset; readonly contentEnd: Utf16Offset } | undefined {
  const start = snapshot.lineStartOffset(lineIndex);
  if (!start.ok) return undefined;
  const next = snapshot.lineStartOffset((lineIndex as number + 1) as LineIndex);
  const end = next.ok ? (next.value as number) - 1 : snapshot.lengthUtf16;
  return { contentStart: start.value, contentEnd: end as Utf16Offset };
}

function validateDesiredColumn(value: DesiredColumn): { readonly ok: true; readonly value: DesiredColumn } | { readonly ok: false; readonly error: SelectionFailure } {
  if (typeof value !== 'object' || value === null) return failure('invalid-desired-column');
  if (value.logicalUtf16 !== null && !isNonnegativeSafeInteger(value.logicalUtf16)) return failure('invalid-desired-column');
  if (value.displayCell !== null && !isNonnegativeSafeInteger(value.displayCell)) return failure('invalid-desired-column');
  return success(Object.freeze({ logicalUtf16: value.logicalUtf16, displayCell: value.displayCell }));
}

function cloneMember(member: SelectionMember, anchor: SelectionEndpoint, head: SelectionEndpoint): SelectionMember {
  return Object.freeze({ ...member, anchor, head }) as SelectionMember;
}

function isNormalEndpoint(endpoint: SelectionEndpoint): endpoint is NormalEndpoint {
  return endpoint.kind === 'character' || endpoint.kind === 'empty-line' || endpoint.kind === 'eof';
}

function isSafeOffset(value: unknown): value is Utf16Offset {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function success<T>(value: T): { readonly ok: true; readonly value: T } { return { ok: true, value }; }
function failure(kind: SelectionFailure['kind']): { readonly ok: false; readonly error: SelectionFailure } { return { ok: false, error: { kind } }; }

export type { SelectionGeneration, SelectionId } from '../../primitives/src/index';
