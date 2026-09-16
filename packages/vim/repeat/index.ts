import type {
  DocumentSnapshot,
  Result,
  SerializedSelectionValue,
  Utf16Offset,
} from '../../document/src/index';
import { cloneSerializedSelectionValue } from '../../contracts/src/index';
import type { SelectionSetSnapshot } from '../../selections/src/index';
import type { VimInsertEntryKey, VimInsertMode } from '../insert/index';
import type { VimCoreOperator } from '../operators/core';

/**
 * A semantic target is the command recipe that dot replays.  It deliberately
 * contains no source-document offsets: operators resolve their motion again
 * at replay time, and visual selections are restored by the selection owner.
 */
export type VimSemanticRepeatTarget =
  | VimOperatorRepeatTarget
  | VimInsertRepeatTarget
  | VimVisualRepeatTarget
  | VimPutRepeatTarget;

export interface VimOperatorRepeatTarget {
  readonly kind: 'operator';
  readonly operator: Exclude<VimCoreOperator, 'yank'>;
  readonly motionKey: string;
  readonly count: number;
  readonly forcedKind?: 'characterwise' | 'linewise' | 'blockwise';
}

export interface VimInsertRepeatTarget {
  readonly kind: 'insert';
  readonly entryKey: VimInsertEntryKey;
  readonly mode: VimInsertMode;
  readonly text: string;
  readonly count: number;
  readonly textIntent?: 'literal-control';
}

export interface VimVisualRepeatTarget {
  readonly kind: 'visual';
  /** Selection shape/metadata owned by the selection package. */
  readonly selection: SerializedSelectionValue;
  readonly replacementText: string;
  readonly count: number;
}

export interface VimPutRepeatTarget {
  readonly kind: 'put';
  /** Register lookup is intentionally deferred until replay. */
  readonly registerName: string;
  readonly putKind: 'characterwise' | 'linewise' | 'blockwise';
  readonly count: number;
}

export type VimRepeatFailure =
  | { readonly kind: 'invalid-count' }
  | { readonly kind: 'invalid-target'; readonly reason: 'operator' | 'insert' | 'visual' | 'put' }
  | { readonly kind: 'invalid-text' }
  | { readonly kind: 'invalid-selection' }
  | { readonly kind: 'no-target' }
  | { readonly kind: 'invalid-cursor' };

export type VimRepeatResult<T> = Result<T, VimRepeatFailure>;

export interface VimRepeatState {
  readonly target: VimSemanticRepeatTarget | null;
  /** Monotonic semantic-target sequence for history/undo coordinators. */
  readonly sequence: number;
}

const EMPTY_STATE: VimRepeatState = Object.freeze({ target: null, sequence: 0 });
const ENTRY_KEYS: ReadonlySet<string> = new Set(['i', 'I', 'a', 'A', 'o', 'O', 'R', 'gR', 'gi', 'gI']);
const INSERT_MODES: ReadonlySet<string> = new Set(['insert', 'replace', 'virtual-replace']);
const FORCED_KINDS: ReadonlySet<string> = new Set(['characterwise', 'linewise', 'blockwise']);
const PUT_KINDS: ReadonlySet<string> = new Set(['characterwise', 'linewise', 'blockwise']);

/** Return a state with no prior dot target (used at Vim-session creation). */
export function createVimRepeatState(): VimRepeatState {
  return EMPTY_STATE;
}

export interface VimOperatorRepeatInput {
  readonly operator: Exclude<VimCoreOperator, 'yank'>;
  readonly motionKey: string;
  readonly count?: number;
  readonly forcedKind?: 'characterwise' | 'linewise' | 'blockwise';
}

export function createVimOperatorRepeatTarget(input: VimOperatorRepeatInput): VimRepeatResult<VimOperatorRepeatTarget> {
  if (input.operator !== 'delete' && input.operator !== 'change') return failure('invalid-target', 'operator');
  if (input.motionKey.length === 0) return failure('invalid-target', 'operator');
  const count = normalizeCount(input.count);
  if (count === null || (input.forcedKind !== undefined && !FORCED_KINDS.has(input.forcedKind))) {
    return failure('invalid-target', 'operator');
  }
  return {
    ok: true,
    value: Object.freeze({
      kind: 'operator',
      operator: input.operator,
      motionKey: input.motionKey,
      count,
      ...(input.forcedKind === undefined ? {} : { forcedKind: input.forcedKind }),
    }),
  };
}

export interface VimInsertRepeatInput {
  readonly entryKey: VimInsertEntryKey;
  readonly mode: VimInsertMode;
  readonly text: string;
  readonly count?: number;
  readonly textIntent?: 'literal-control';
}

export function createVimInsertRepeatTarget(input: VimInsertRepeatInput): VimRepeatResult<VimInsertRepeatTarget> {
  if (!ENTRY_KEYS.has(input.entryKey) || !INSERT_MODES.has(input.mode)) return failure('invalid-target', 'insert');
  const count = normalizeCount(input.count);
  if (count === null) return failure('invalid-target', 'insert');
  if (!isWellFormedText(input.text)) return failure('invalid-text');
  if (input.text.includes('\r') && input.textIntent !== 'literal-control') return failure('invalid-text');
  return {
    ok: true,
    value: Object.freeze({
      kind: 'insert',
      entryKey: input.entryKey,
      mode: input.mode,
      text: input.text,
      count,
      ...(input.textIntent === undefined ? {} : { textIntent: input.textIntent }),
    }),
  };
}

export interface VimVisualRepeatInput {
  readonly selection: unknown;
  readonly replacementText: string;
  readonly count?: number;
}

export function createVimVisualRepeatTarget(input: VimVisualRepeatInput): VimRepeatResult<VimVisualRepeatTarget> {
  const count = normalizeCount(input.count);
  if (count === null) return failure('invalid-target', 'visual');
  if (!isWellFormedText(input.replacementText)) return failure('invalid-text');
  const selection = cloneSerializedSelectionValue(input.selection);
  if (!selection.ok) return failure('invalid-selection');
  return {
    ok: true,
    value: Object.freeze({
      kind: 'visual',
      selection: freezeSerializedSelection(selection.value),
      replacementText: input.replacementText,
      count,
    }),
  };
}

export interface VimPutRepeatInput {
  readonly registerName: string;
  readonly putKind: 'characterwise' | 'linewise' | 'blockwise';
  readonly count?: number;
}

export function createVimPutRepeatTarget(input: VimPutRepeatInput): VimRepeatResult<VimPutRepeatTarget> {
  const count = normalizeCount(input.count);
  if (count === null || input.registerName.length === 0 || !PUT_KINDS.has(input.putKind)) {
    return failure('invalid-target', 'put');
  }
  return {
    ok: true,
    value: Object.freeze({
      kind: 'put',
      registerName: input.registerName,
      putKind: input.putKind,
      count,
    }),
  };
}

/** Publish one completed native change as the new semantic dot target. */
export function recordVimRepeatTarget(
  state: VimRepeatState,
  target: VimSemanticRepeatTarget,
): VimRepeatResult<VimRepeatState> {
  if (!Number.isSafeInteger(state.sequence) || state.sequence < 0) return failure('invalid-target', target.kind);
  const sequence = state.sequence + 1;
  if (!Number.isSafeInteger(sequence)) return failure('invalid-target', target.kind);
  return { ok: true, value: Object.freeze({ target, sequence }) };
}

/**
 * Apply command completion to repeat state. Failed commands, yank/service
 * actions, undo, and interrupted inserts preserve the prior successful target.
 */
export type VimRepeatEvent =
  | { readonly kind: 'operator' | 'insert' | 'visual' | 'put'; readonly target: VimSemanticRepeatTarget }
  | { readonly kind: 'failed-command' | 'yank' | 'service' | 'undo' | 'interrupted-insert' };

export function applyVimRepeatEvent(state: VimRepeatState, event: VimRepeatEvent): VimRepeatResult<VimRepeatState> {
  if (!('target' in event)) {
    return { ok: true, value: state };
  }
  if (event.target.kind !== event.kind) return failure('invalid-target', event.kind);
  return recordVimRepeatTarget(state, event.target);
}

export interface VimDotRequest {
  readonly snapshot: DocumentSnapshot;
  readonly cursorOffset: Utf16Offset;
  readonly count?: number;
}

export interface VimDotReplayContext {
  readonly snapshot: DocumentSnapshot;
  readonly cursorOffset: Utf16Offset;
  readonly target: VimSemanticRepeatTarget;
  /** Count supplied before dot overrides the recorded target count. */
  readonly count: number;
}

export interface VimDotReplay<T> {
  readonly target: VimSemanticRepeatTarget;
  readonly count: number;
  readonly resolved: T;
  /** State is unchanged; callers publish it only after the replay succeeds. */
  readonly state: VimRepeatState;
}

export interface VimMultiDotRequest {
  readonly snapshot: DocumentSnapshot;
  readonly selections: SelectionSetSnapshot;
  readonly count?: number;
}

export interface VimMultiDotReplayContext {
  readonly snapshot: DocumentSnapshot;
  readonly selections: SelectionSetSnapshot;
  readonly target: VimSemanticRepeatTarget;
  readonly count: number;
}

export interface VimMultiDotReplay<T> {
  readonly target: VimSemanticRepeatTarget;
  readonly count: number;
  readonly resolved: T;
  readonly state: VimRepeatState;
}

export type VimMultiDotFailure = VimRepeatFailure | { readonly kind: 'stale-selection' | 'invalid-selection' };

/** Resolve one semantic dot recipe against the complete current selection set. */
export function replayVimMultiDot<T>(
  state: VimRepeatState,
  request: VimMultiDotRequest,
  resolve: (context: VimMultiDotReplayContext) => VimRepeatResult<T>,
): Result<VimMultiDotReplay<T>, VimMultiDotFailure> {
  const target = state.target;
  if (target === null) return failure('no-target');
  if (request.selections.documentId !== request.snapshot.id || request.selections.documentVersion !== request.snapshot.version) {
    return { ok: false, error: { kind: 'stale-selection' } };
  }
  if (request.selections.members.length === 0) return { ok: false, error: { kind: 'invalid-selection' } };
  const count = request.count === undefined ? target.count : normalizeCount(request.count);
  if (count === null) return failure('invalid-count');
  const resolved = resolve(Object.freeze({ snapshot: request.snapshot, selections: request.selections, target, count }));
  if (!resolved.ok) return resolved;
  return { ok: true, value: Object.freeze({ target, count, resolved: resolved.value, state }) };
}

/** Resolve a semantic target against the current document/cursor. */
export function replayVimDot<T>(
  state: VimRepeatState,
  request: VimDotRequest,
  resolve: (context: VimDotReplayContext) => VimRepeatResult<T>,
): VimRepeatResult<VimDotReplay<T>> {
  const target = state.target;
  if (target === null) return failure('no-target');
  const cursor = Number(request.cursorOffset);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > request.snapshot.lengthUtf16) {
    return failure('invalid-cursor');
  }
  const count = request.count === undefined ? target.count : normalizeCount(request.count);
  if (count === null) return failure('invalid-count');
  const resolved = resolve(Object.freeze({
    snapshot: request.snapshot,
    cursorOffset: request.cursorOffset,
    target,
    count,
  }));
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    value: Object.freeze({ target, count, resolved: resolved.value, state }),
  };
}

function normalizeCount(value: number | undefined): number | null {
  const count = value ?? 1;
  return Number.isSafeInteger(count) && count >= 1 ? count : null;
}

function isWellFormedText(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function freezeSerializedSelection(value: SerializedSelectionValue): SerializedSelectionValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => freezeSerializedSelection(entry))) as unknown as SerializedSelectionValue;
  }
  if (value !== null && typeof value === 'object') {
    const output: Record<string, SerializedSelectionValue> = {};
    for (const [key, entry] of Object.entries(value)) output[key] = freezeSerializedSelection(entry);
    return Object.freeze(output);
  }
  return value;
}

function failure(kind: 'invalid-target', reason: 'operator' | 'insert' | 'visual' | 'put'): VimRepeatResult<never>;
function failure(kind: 'invalid-text' | 'invalid-selection' | 'no-target' | 'invalid-count' | 'invalid-cursor'): VimRepeatResult<never>;
function failure(kind: VimRepeatFailure['kind'], reason?: 'operator' | 'insert' | 'visual' | 'put'): VimRepeatResult<never> {
  return reason === undefined
    ? { ok: false, error: { kind } as VimRepeatFailure }
    : { ok: false, error: { kind, reason } as VimRepeatFailure };
}
