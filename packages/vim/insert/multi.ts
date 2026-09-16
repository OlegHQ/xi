import {
  createDocumentAnchor,
  DocumentChangeMap,
  type DocumentEdit,
  type DocumentId,
  type DocumentSnapshot,
  type DocumentVersion,
  type Utf16Offset,
} from '../../document/src/index';
import type { SelectionId } from '../../selections/src/index';
import { normalizeAtomicEdits, type AtomicEditConflict } from '../transactions/multi-command';
import {
  beginVimInsert,
  planVimInsertInput,
  type VimInsertEdit,
  type VimInsertEntryKey,
  type VimInsertFailure,
  type VimInsertLastContext,
  type VimInsertMode,
  type VimInsertOptions,
  type VimInsertPlan,
  type VimInsertSession,
  type VimInsertTransition,
} from './index';

/** One stable selection identity and its Vim-owned Insert session. */
export interface VimMultiInsertMember {
  readonly id: SelectionId;
  readonly session: VimInsertSession;
}

/** A shared Insert/Replace mode with one independent session per selection. */
export interface VimMultiInsertSession {
  readonly documentId: DocumentId;
  readonly mode: VimInsertMode;
  readonly members: readonly [VimMultiInsertMember, ...VimMultiInsertMember[]];
}

export interface VimMultiInsertMemberPlan {
  readonly id: SelectionId;
  readonly transition: VimInsertTransition;
  /** The member's edits before cross-member normalization. */
  readonly edits: readonly VimInsertEdit[];
}

export interface VimMultiInsertPlan {
  readonly documentId: DocumentId;
  readonly expectedVersion: DocumentVersion;
  /** One normalized, atomic batch for all members. */
  readonly edits: readonly VimInsertEdit[];
  readonly members: readonly [VimMultiInsertMemberPlan, ...VimMultiInsertMemberPlan[]];
  readonly nextSession: VimMultiInsertSession | null;
  readonly undoAction: VimInsertPlan['undoAction'];
}

export type VimMultiInsertFailure =
  | VimInsertFailure
  | { readonly kind: 'invalid-members' }
  | { readonly kind: 'member-convergence-failed' }
  | { readonly kind: 'edit-conflict'; readonly conflict: AtomicEditConflict }
  | { readonly kind: 'invalid-change-map' };

export type VimMultiInsertResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: VimMultiInsertFailure };

/**
 * Enter one shared Insert/Replace mode for a non-empty set of carets. Each
 * member uses the singleton planner, while opening edits are prepared as one
 * cross-member batch. Duplicate carets therefore deduplicate their insertion.
 */
export function beginVimMultiInsert(
  snapshot: DocumentSnapshot,
  members: readonly { readonly id: SelectionId; readonly cursorOffset: Utf16Offset }[],
  key: VimInsertEntryKey,
  options: VimInsertOptions = {},
  count = 1,
  lastInsert?: VimInsertLastContext | null,
): VimMultiInsertResult<{ readonly session: VimMultiInsertSession; readonly plan: VimMultiInsertPlan }> {
  if (!Array.isArray(members) || members.length === 0) return failure('invalid-members');
  const ids = new Set<SelectionId>();
  const opened: VimMultiInsertMemberPlan[] = [];
  for (const member of members) {
    if (typeof member !== 'object' || member === null || typeof member.id !== 'string' || ids.has(member.id)) return failure('invalid-members');
    ids.add(member.id);
    const entered = beginVimInsert(snapshot, member.cursorOffset, key, options, count, lastInsert === undefined ? undefined : { lastInsert });
    if (!entered.ok) return entered;
    opened.push(Object.freeze({ id: member.id, transition: entered.value, edits: entered.value.plan.edits }));
  }
  const composed = composeMemberPlans(snapshot, opened, 'open');
  if (!composed.ok) return composed;
  if (composed.value.nextSession === null) return failure('member-convergence-failed');
  return { ok: true, value: Object.freeze({ session: composed.value.nextSession, plan: composed.value }) };
}

/** Plan one key or opaque paste for every member against one document snapshot. */
export function planVimMultiInsertInput(
  snapshot: DocumentSnapshot,
  session: VimMultiInsertSession,
  input: Parameters<typeof planVimInsertInput>[2],
): VimMultiInsertResult<VimMultiInsertPlan> {
  if (!isValidSession(snapshot, session)) return failure('invalid-members');
  const planned: VimMultiInsertMemberPlan[] = [];
  for (const member of session.members) {
    const transition = planVimInsertInput(snapshot, member.session, input);
    if (!transition.ok) return transition;
    planned.push(Object.freeze({ id: member.id, transition: transition.value, edits: transition.value.plan.edits }));
  }
  return composeMemberPlans(snapshot, planned, planned[0]?.transition.plan.undoAction ?? 'none');
}

/** Map all member state after an external document edit or view merge. */
export function mapVimMultiInsertSession(
  before: DocumentSnapshot,
  after: DocumentSnapshot,
  changeMap: DocumentChangeMap,
  session: VimMultiInsertSession,
): VimMultiInsertResult<VimMultiInsertSession> {
  if (!isValidSession(before, session) || after.id !== before.id || changeMap.documentId !== before.id
    || changeMap.beforeVersion !== before.version || changeMap.afterVersion !== after.version) {
    return failure('invalid-change-map');
  }
  const mapped: VimMultiInsertMember[] = [];
  for (const member of session.members) {
    const next = mapSessionOffsets(before, after, changeMap, member.session, undefined);
    if (!next.ok) return next;
    mapped.push(Object.freeze({ id: member.id, session: next.value }));
  }
  return { ok: true, value: Object.freeze({ documentId: after.id, mode: session.mode, members: tuple(mapped) }) };
}

function composeMemberPlans(
  snapshot: DocumentSnapshot,
  members: readonly VimMultiInsertMemberPlan[],
  defaultUndoAction: VimInsertPlan['undoAction'],
): VimMultiInsertResult<VimMultiInsertPlan> {
  if (members.length === 0) return failure('invalid-members');
  const allEdits = members.flatMap((member) => member.edits);
  const normalized = normalizeAtomicEdits(snapshot, allEdits);
  if (!normalized.ok) return { ok: false, error: { kind: 'edit-conflict', conflict: normalized.error.conflict } };
  const edits = attachEditIntent(normalized.value, allEdits);
  const hasEdits = edits.length > 0;
  const actions = members.map((member) => member.transition.plan.undoAction);
  const exited = members.map((member) => member.transition.kind === 'exited');
  const allExited = exited.every(Boolean);
  const noneExited = exited.every((value) => !value);
  if (!allExited && !noneExited) return failure('member-convergence-failed');
  let nextSession: VimMultiInsertSession | null = null;
  if (noneExited) {
    const mode = members[0]?.transition.mode;
    if (mode === undefined || mode === 'normal' || members.some((member) => member.transition.mode !== mode || member.transition.session === null)) {
      return failure('member-convergence-failed');
    }
    const map = createBatchMap(snapshot, edits);
    if (!map.ok) return map;
    const mappedMembers: VimMultiInsertMember[] = [];
    for (const member of members) {
      const transition = member.transition;
      if (transition.session === null) return failure('member-convergence-failed');
      const localEdit = member.edits.length === 0 ? undefined : member.edits[0];
      const mapped = mapSessionOffsets(snapshot, snapshot, map.value, transition.session, localEdit);
      if (!mapped.ok) return mapped;
      mappedMembers.push(Object.freeze({ id: member.id, session: mapped.value }));
    }
    nextSession = Object.freeze({ documentId: snapshot.id, mode, members: tuple(mappedMembers) });
  }
  const undoAction = chooseUndoAction(actions, defaultUndoAction, hasEdits, allExited);
  return {
    ok: true,
    value: Object.freeze({
      documentId: snapshot.id,
      expectedVersion: snapshot.version,
      edits,
      members: tuple(members),
      nextSession,
      undoAction,
    }),
  };
}

function mapSessionOffsets(
  before: DocumentSnapshot,
  after: DocumentSnapshot,
  changeMap: DocumentChangeMap,
  session: VimInsertSession,
  localEdit: VimInsertEdit | undefined,
): VimMultiInsertResult<VimInsertSession> {
  const map = (position: Utf16Offset, affinity: 'left' | 'right', local = true): VimMultiInsertResult<Utf16Offset> => {
    const mapped = local
      ? mapLocalOffset(before, changeMap, localEdit, position, affinity)
      : mapExternalOffset(before, changeMap, position, affinity);
    return mapped;
  };
  const cursor = map(session.cursorOffset, 'right');
  const entry = map(session.entryOffset, 'left');
  if (!cursor.ok || !entry.ok) return failure('invalid-change-map');
  const autoIndent = session.autoIndentSpan === null ? null : (() => {
    const start = map(session.autoIndentSpan.start, 'left');
    const end = map(session.autoIndentSpan.end, 'right');
    return start.ok && end.ok ? Object.freeze({ start: start.value, end: end.value }) : undefined;
  })();
  if (autoIndent === undefined) return failure('invalid-change-map');
  const replaceStack: { readonly start: Utf16Offset; readonly insertedText: string; readonly replacedText: string; readonly cursorBefore: Utf16Offset }[] = [];
  for (const frame of session.replaceStack) {
    const start = map(frame.start, 'left');
    const cursorBefore = map(frame.cursorBefore, 'left');
    if (!start.ok || !cursorBefore.ok) return failure('invalid-change-map');
    replaceStack.push(Object.freeze({ ...frame, start: start.value, cursorBefore: cursorBefore.value }));
  }
  return {
    ok: true,
    value: Object.freeze({
      ...session,
      cursorOffset: cursor.value,
      entryOffset: entry.value,
      autoIndentSpan: autoIndent,
      replaceStack: Object.freeze(replaceStack),
    }),
  };
}

function mapLocalOffset(
  before: DocumentSnapshot,
  changeMap: DocumentChangeMap,
  localEdit: VimInsertEdit | undefined,
  position: Utf16Offset,
  affinity: 'left' | 'right',
): VimMultiInsertResult<Utf16Offset> {
  if (localEdit === undefined) return mapExternalOffset(before, changeMap, position, affinity);
  const start = localEdit.start as number;
  const end = localEdit.end as number;
  const insertedLength = localEdit.text.length;
  const local = position as number;
  if (local >= start && local <= start + insertedLength) {
    const mappedStart = mapExternalOffset(before, changeMap, localEdit.start, 'left');
    if (!mappedStart.ok) return mappedStart;
    return { ok: true, value: (mappedStart.value as number + local - start) as Utf16Offset };
  }
  const basePosition = local < start ? local : end + (local - (start + insertedLength));
  return mapExternalOffset(before, changeMap, basePosition as Utf16Offset, affinity);
}

function mapExternalOffset(
  before: DocumentSnapshot,
  changeMap: DocumentChangeMap,
  position: Utf16Offset,
  affinity: 'left' | 'right',
): VimMultiInsertResult<Utf16Offset> {
  const anchor = createDocumentAnchor(before, position, affinity);
  if (!anchor.ok) return failure('invalid-change-map');
  const mapped = changeMap.mapAnchor(anchor.value);
  if (!mapped.ok) return failure('invalid-change-map');
  return { ok: true, value: mapped.value.offset };
}

function createBatchMap(
  snapshot: DocumentSnapshot,
  edits: readonly DocumentEdit[],
): VimMultiInsertResult<DocumentChangeMap> {
  if (edits.length === 0) {
    const map = DocumentChangeMap.create(snapshot, ((snapshot.version as number) + 1) as DocumentVersion, []);
    return map.ok ? { ok: true, value: map.value } : failure('invalid-change-map');
  }
  const map = DocumentChangeMap.create(snapshot, ((snapshot.version as number) + 1) as DocumentVersion, edits);
  return map.ok ? { ok: true, value: map.value } : failure('invalid-change-map');
}

function attachEditIntent(
  normalized: readonly DocumentEdit[],
  original: readonly VimInsertEdit[],
): readonly VimInsertEdit[] {
  return Object.freeze(normalized.map((edit) => {
    const source = original.find((candidate) => candidate.start === edit.start && candidate.end === edit.end && candidate.text === edit.text);
    return Object.freeze({ ...edit, ...(source?.textIntent === undefined ? {} : { textIntent: source.textIntent }) });
  }));
}

function chooseUndoAction(
  actions: readonly VimInsertPlan['undoAction'][],
  fallback: VimInsertPlan['undoAction'],
  hasEdits: boolean,
  allExited: boolean,
): VimInsertPlan['undoAction'] {
  if (allExited) return 'close';
  if (actions.includes('break')) return 'break';
  if (fallback === 'open') return 'open';
  if (hasEdits) return 'continue';
  return 'none';
}

function isValidSession(snapshot: DocumentSnapshot, session: VimMultiInsertSession): boolean {
  if (typeof session !== 'object' || session === null || session.documentId !== snapshot.id
    || !Array.isArray(session.members) || session.members.length === 0) return false;
  const ids = new Set<SelectionId>();
  let mode: VimInsertMode | undefined;
  for (const member of session.members) {
    if (typeof member !== 'object' || member === null || typeof member.id !== 'string'
      || typeof member.session !== 'object' || member.session === null
      || ids.has(member.id) || member.session.documentId !== snapshot.id) return false;
    if (member.session.mode !== 'insert' && member.session.mode !== 'replace' && member.session.mode !== 'virtual-replace') return false;
    ids.add(member.id);
    mode ??= member.session.mode;
    if (member.session.mode !== mode) return false;
  }
  return session.mode === mode;
}

function tuple<T>(values: readonly T[]): readonly [T, ...T[]] {
  return Object.freeze([...values]) as readonly [T, ...T[]];
}

function failure<T>(kind: VimMultiInsertFailure['kind'] | VimInsertFailure['kind']): VimMultiInsertResult<T> {
  return { ok: false, error: { kind } as VimMultiInsertFailure };
}
