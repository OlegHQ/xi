import {
  createDocumentAnchor,
  type AnchorAffinity,
  type DocumentAnchor,
  type DocumentChangeMap,
  type DocumentSnapshot,
  type VersionedAnchor,
} from '../../document/src/index';
import type {
  DocumentId,
  DocumentVersion,
  Result,
  Utf16Offset,
} from '../../document/src/index';

/** Local, global and special Vim mark names accepted by the navigation owner. */
export type VimMarkName =
  | Lowercase<string>
  | Uppercase<string>
  | '<' | '>' | '[' | ']' | '(' | ')' | '{' | '}' | '.' | '^' | '"';

export type VimMarkKind = 'local' | 'global' | 'special';

/** A mark's offset is always a UTF-16 boundary in the recorded document version. */
export interface VimMark {
  readonly name: VimMarkName;
  readonly kind: VimMarkKind;
  readonly documentId: DocumentId;
  readonly version: DocumentVersion;
  readonly offset: Utf16Offset;
  readonly affinity: AnchorAffinity;
  readonly anchor: DocumentAnchor;
}

export interface VimMarkStore {
  readonly generation: number;
  readonly local: ReadonlyMap<DocumentId, ReadonlyMap<string, VimMark>>;
  readonly global: ReadonlyMap<string, VimMark>;
  readonly special: ReadonlyMap<string, VimMark>;
}

export type VimMarkFailure =
  | { readonly kind: 'invalid-mark-name' }
  | { readonly kind: 'invalid-cursor' }
  | { readonly kind: 'map-failed' }
  | { readonly kind: 'wrong-document' }
  | { readonly kind: 'stale-mark' }
  | { readonly kind: 'missing-mark' };

export interface VimMarkTarget {
  readonly kind: 'ready' | 'missing-document';
  readonly mark: VimMark;
}

const SPECIAL_MARKS = new Set(['<', '>', '[', ']', '(', ')', '{', '}', '.', '^', '"']);

export function createVimMarkStore(): VimMarkStore {
  return Object.freeze({
    generation: 0,
    local: new Map(),
    global: new Map(),
    special: new Map(),
  });
}

export function classifyVimMarkName(name: string): VimMarkKind | null {
  if (name.length !== 1) return null;
  if (SPECIAL_MARKS.has(name)) return 'special';
  if (/^[a-z]$/u.test(name)) return 'local';
  if (/^[A-Z]$/u.test(name)) return 'global';
  return null;
}

export function setVimMark(
  store: VimMarkStore,
  name: string,
  snapshot: DocumentSnapshot,
  offset: Utf16Offset,
  affinity: AnchorAffinity = 'right',
): Result<VimMarkStore, VimMarkFailure> {
  const kind = classifyVimMarkName(name);
  if (kind === null) return failure('invalid-mark-name');
  const anchor = createDocumentAnchor(snapshot, offset, affinity);
  if (!anchor.ok) return failure('invalid-cursor');
  const mark: VimMark = Object.freeze({
    name: name as VimMarkName,
    kind,
    documentId: snapshot.id,
    version: snapshot.version,
    offset,
    affinity,
    anchor: anchor.value,
  });
  const generation = store.generation + 1;
  if (!Number.isSafeInteger(generation)) return failure('map-failed');
  if (kind === 'local') {
    const documents = new Map(store.local);
    const marks = new Map(documents.get(snapshot.id) ?? []);
    marks.set(name, mark);
    documents.set(snapshot.id, marks);
    return Object.freeze({ ok: true, value: Object.freeze({ generation, local: documents, global: store.global, special: store.special }) });
  }
  if (kind === 'global') {
    const marks = new Map(store.global);
    marks.set(name, mark);
    return Object.freeze({ ok: true, value: Object.freeze({ generation, local: store.local, global: marks, special: store.special }) });
  }
  const marks = new Map(store.special);
  marks.set(name, mark);
  return Object.freeze({ ok: true, value: Object.freeze({ generation, local: store.local, global: store.global, special: marks }) });
}

export function deleteVimMark(store: VimMarkStore, name: string, documentId?: DocumentId): Result<VimMarkStore, VimMarkFailure> {
  const kind = classifyVimMarkName(name);
  if (kind === null) return failure('invalid-mark-name');
  const generation = store.generation + 1;
  if (kind === 'local') {
    if (documentId === undefined) return failure('wrong-document');
    const documents = new Map(store.local);
    const marks = new Map(documents.get(documentId) ?? []);
    marks.delete(name);
    if (marks.size === 0) documents.delete(documentId); else documents.set(documentId, marks);
    return Object.freeze({ ok: true, value: Object.freeze({ generation, local: documents, global: store.global, special: store.special }) });
  }
  if (kind === 'global') {
    const marks = new Map(store.global); marks.delete(name);
    return Object.freeze({ ok: true, value: Object.freeze({ generation, local: store.local, global: marks, special: store.special }) });
  }
  const marks = new Map(store.special); marks.delete(name);
  return Object.freeze({ ok: true, value: Object.freeze({ generation, local: store.local, global: store.global, special: marks }) });
}

export function resolveVimMark(store: VimMarkStore, name: string, documentId: DocumentId): Result<VimMarkTarget, VimMarkFailure> {
  const kind = classifyVimMarkName(name);
  if (kind === null) return failure('invalid-mark-name');
  const mark = kind === 'local'
    ? store.local.get(documentId)?.get(name)
    : kind === 'global' ? store.global.get(name) : store.special.get(name);
  if (mark === undefined) return failure('missing-mark');
  if (kind === 'local' && mark.documentId !== documentId) return failure('missing-mark');
  return { ok: true, value: Object.freeze({ kind: 'ready', mark }) };
}

/** Resolve a mark while making a missing cross-buffer target explicit. */
export function resolveVimMarkForWorkspace(
  store: VimMarkStore,
  name: string,
  currentDocumentId: DocumentId,
  availableDocuments: ReadonlySet<DocumentId>,
): Result<VimMarkTarget, VimMarkFailure> {
  const resolved = resolveVimMark(store, name, currentDocumentId);
  if (!resolved.ok) return resolved;
  return availableDocuments.has(resolved.value.mark.documentId)
    ? resolved
    : { ok: true, value: Object.freeze({ kind: 'missing-document', mark: resolved.value.mark }) };
}

/** Map all marks in one document through its committed transaction. Deleted ranges land at the mapped affinity edge. */
export function mapVimMarksThroughChange(
  store: VimMarkStore,
  changeMap: DocumentChangeMap,
  afterSnapshot: DocumentSnapshot,
): Result<VimMarkStore, VimMarkFailure> {
  if (afterSnapshot.id !== changeMap.documentId || afterSnapshot.version !== changeMap.afterVersion) return failure('wrong-document');
  const mapMark = (mark: VimMark): VimMark | null => {
    if (mark.documentId !== changeMap.documentId || mark.version !== changeMap.beforeVersion) return mark;
    const mapped = changeMap.mapAnchor(mark.anchor);
    if (!mapped.ok) return null;
    const anchor = createDocumentAnchor(afterSnapshot, mapped.value.offset, mark.affinity);
    if (!anchor.ok) return null;
    return Object.freeze({ ...mark, version: afterSnapshot.version, offset: mapped.value.offset, anchor: anchor.value });
  };
  const local = new Map(store.local);
  const localMarks = local.get(changeMap.documentId);
  if (localMarks !== undefined) {
    const mapped = mapMarkMap(localMarks, mapMark); if (mapped === null) return failure('map-failed');
    local.set(changeMap.documentId, mapped);
  }
  const global = mapMarkMap(store.global, mapMark); if (global === null) return failure('map-failed');
  const special = mapMarkMap(store.special, mapMark); if (special === null) return failure('map-failed');
  return { ok: true, value: Object.freeze({ generation: store.generation + 1, local, global, special }) };
}

function mapMarkMap<T extends string>(marks: ReadonlyMap<T, VimMark>, mapMark: (mark: VimMark) => VimMark | null): ReadonlyMap<T, VimMark> | null {
  const output = new Map<T, VimMark>();
  for (const [name, mark] of marks) {
    const mapped = mapMark(mark);
    if (mapped === null) return null;
    output.set(name, mapped);
  }
  return output;
}

export type VimJumpReason = 'command' | 'search' | 'tag' | 'buffer' | 'manual';

export interface VimNavigationTarget {
  readonly documentId: DocumentId;
  readonly documentVersion: DocumentVersion;
  readonly offset: Utf16Offset;
}

export interface VimJumpEntry {
  readonly target: VimNavigationTarget;
  readonly reason: VimJumpReason;
  readonly sequence: number;
}

export interface VimJumpHistory {
  /** Entries before `index` are behind the current position; entries at/after it are forward candidates. */
  readonly entries: readonly VimJumpEntry[];
  readonly index: number;
  readonly sequence: number;
}

export type VimJumpFailure =
  | { readonly kind: 'invalid-target' }
  | { readonly kind: 'nothing-back' }
  | { readonly kind: 'nothing-forward' };

export function createVimJumpHistory(): VimJumpHistory {
  return Object.freeze({ entries: Object.freeze([]), index: 0, sequence: 0 });
}

export function recordVimJump(
  state: VimJumpHistory,
  target: VimNavigationTarget,
  reason: VimJumpReason = 'command',
): Result<VimJumpHistory, VimJumpFailure> {
  if (!validTarget(target)) return { ok: false, error: { kind: 'invalid-target' } };
  const last = state.entries.at(-1);
  if (last !== undefined && sameTarget(last.target, target)) {
    return { ok: true, value: Object.freeze({ ...state, index: state.entries.length }) };
  }
  const sequence = state.sequence + 1;
  if (!Number.isSafeInteger(sequence)) return { ok: false, error: { kind: 'invalid-target' } };
  const entry = Object.freeze({ target, reason, sequence });
  const entries = Object.freeze([...state.entries.slice(0, state.index), entry]);
  return { ok: true, value: Object.freeze({ entries, index: entries.length, sequence }) };
}

export function jumpBackward(state: VimJumpHistory): Result<{ readonly state: VimJumpHistory; readonly target: VimNavigationTarget }, VimJumpFailure> {
  if (state.index <= 0) return { ok: false, error: { kind: 'nothing-back' } };
  const index = state.index - 1;
  const entry = state.entries[index];
  if (entry === undefined) return { ok: false, error: { kind: 'nothing-back' } };
  return { ok: true, value: Object.freeze({ state: Object.freeze({ ...state, index }), target: entry.target }) };
}

export function jumpForward(state: VimJumpHistory): Result<{ readonly state: VimJumpHistory; readonly target: VimNavigationTarget }, VimJumpFailure> {
  if (state.index >= state.entries.length) return { ok: false, error: { kind: 'nothing-forward' } };
  const index = state.index;
  const entry = state.entries[index];
  if (entry === undefined) return { ok: false, error: { kind: 'nothing-forward' } };
  return { ok: true, value: Object.freeze({ state: Object.freeze({ ...state, index }), target: entry.target }) };
}

export interface VimJumpPreview {
  readonly baseSequence: number;
  readonly target: VimNavigationTarget;
  readonly reason: VimJumpReason;
}

export function beginVimJumpPreview(state: VimJumpHistory, target: VimNavigationTarget, reason: VimJumpReason = 'search'): Result<VimJumpPreview, VimJumpFailure> {
  if (!validTarget(target)) return { ok: false, error: { kind: 'invalid-target' } };
  return { ok: true, value: Object.freeze({ baseSequence: state.sequence, target, reason }) };
}

export function commitVimJumpPreview(state: VimJumpHistory, preview: VimJumpPreview): Result<VimJumpHistory, VimJumpFailure> {
  if (preview.baseSequence !== state.sequence) return { ok: false, error: { kind: 'invalid-target' } };
  return recordVimJump(state, preview.target, preview.reason);
}

export function cancelVimJumpPreview(state: VimJumpHistory, _preview: VimJumpPreview): VimJumpHistory {
  return state;
}

export interface VimChangeEntry {
  readonly target: VimNavigationTarget;
  readonly sequence: number;
}

export interface VimChangeHistory {
  readonly entries: readonly VimChangeEntry[];
  readonly index: number;
  readonly sequence: number;
}

export function createVimChangeHistory(): VimChangeHistory {
  return Object.freeze({ entries: Object.freeze([]), index: 0, sequence: 0 });
}

export function recordVimChange(state: VimChangeHistory, target: VimNavigationTarget): Result<VimChangeHistory, VimJumpFailure> {
  if (!validTarget(target)) return { ok: false, error: { kind: 'invalid-target' } };
  const last = state.entries.at(-1);
  if (last !== undefined && sameTarget(last.target, target)) return { ok: true, value: state };
  const sequence = state.sequence + 1;
  const entry = Object.freeze({ target, sequence });
  const entries = Object.freeze([...state.entries.slice(0, state.index), entry]);
  return { ok: true, value: Object.freeze({ entries, index: entries.length, sequence }) };
}

export function changeBackward(state: VimChangeHistory): Result<{ readonly state: VimChangeHistory; readonly target: VimNavigationTarget }, VimJumpFailure> {
  if (state.index <= 0) return { ok: false, error: { kind: 'nothing-back' } };
  const index = state.index - 1; const entry = state.entries[index];
  return entry === undefined ? { ok: false, error: { kind: 'nothing-back' } } : { ok: true, value: Object.freeze({ state: Object.freeze({ ...state, index }), target: entry.target }) };
}

export function changeForward(state: VimChangeHistory): Result<{ readonly state: VimChangeHistory; readonly target: VimNavigationTarget }, VimJumpFailure> {
  if (state.index >= state.entries.length) return { ok: false, error: { kind: 'nothing-forward' } };
  const index = state.index; const entry = state.entries[index];
  return entry === undefined ? { ok: false, error: { kind: 'nothing-forward' } } : { ok: true, value: Object.freeze({ state: Object.freeze({ ...state, index }), target: entry.target }) };
}

function validTarget(target: VimNavigationTarget): boolean {
  return Number.isSafeInteger(target.documentVersion) && (target.documentVersion as number) >= 0
    && Number.isSafeInteger(target.offset) && (target.offset as number) >= 0;
}

function sameTarget(left: VimNavigationTarget, right: VimNavigationTarget): boolean {
  return left.documentId === right.documentId && left.documentVersion === right.documentVersion && left.offset === right.offset;
}

function failure(kind: VimMarkFailure['kind']): { readonly ok: false; readonly error: VimMarkFailure } {
  return { ok: false, error: { kind } };
}
