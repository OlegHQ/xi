import type { CancellationToken, Result } from '../../contracts/src/index';
import { isRegisterName, type VimRegisterName } from '../registers/index';
import type { SelectionSetSnapshot } from '../../selections/src/index';

/** A key token is replayed through the normal parser/mapping path. */
export interface VimMacroKeyToken {
  readonly kind: 'key';
  readonly key: string;
}

/** A semantic nested invocation emitted by the parser for `@{register}`. */
export interface VimMacroCallToken {
  readonly kind: 'macro-call';
  readonly register: VimMacroRegisterName;
  readonly count: number;
}

/** A semantic `@@` invocation emitted by the parser. */
export interface VimMacroRepeatLastToken {
  readonly kind: 'repeat-last';
}

export type VimMacroToken = VimMacroKeyToken | VimMacroCallToken | VimMacroRepeatLastToken;
export type VimMacroRegisterName = Exclude<VimRegisterName, '"' | '-' | '_' | '+' | '*'>;

export interface VimMacroKeyInput {
  readonly key: string;
  /** `mapping` is an expansion of a user key and must not be recorded again. */
  readonly source: 'user' | 'mapping' | 'macro';
}

export interface VimMacroRecordingSession {
  readonly kind: 'recording';
  readonly register: VimMacroRegisterName;
  readonly tokens: readonly VimMacroToken[];
}

export interface VimMacroRecording {
  readonly register: VimMacroRegisterName;
  readonly tokens: readonly VimMacroToken[];
  readonly tokenCount: number;
}

export interface VimMacroRegister {
  readonly register: VimMacroRegisterName;
  readonly recording: VimMacroRecording;
  readonly generation: number;
}

export interface VimMacroStore {
  readonly generation: number;
  readonly values: ReadonlyMap<VimMacroRegisterName, VimMacroRegister>;
}

export type VimMacroFailure =
  | { readonly kind: 'invalid-register' }
  | { readonly kind: 'invalid-token' }
  | { readonly kind: 'already-recording' }
  | { readonly kind: 'not-recording' }
  | { readonly kind: 'empty-macro' }
  | { readonly kind: 'macro-not-found'; readonly register: VimMacroRegisterName }
  | { readonly kind: 'recursive-macro'; readonly register: VimMacroRegisterName }
  | { readonly kind: 'depth-limit'; readonly limit: number }
  | { readonly kind: 'repeat-count-limit'; readonly count: number; readonly limit: number }
  | { readonly kind: 'work-budget'; readonly limit: number }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'dispatch-failed'; readonly message: string };

export type VimMacroResult<T> = Result<T, VimMacroFailure>;

export type VimMacroDispatchEffect =
  | { readonly kind: 'continue'; readonly committed: boolean }
  | { readonly kind: 'invoke'; readonly register: VimMacroRegisterName; readonly count?: number }
  | { readonly kind: 'repeat-last' };

export interface VimMacroDispatchContext {
  readonly token: VimMacroKeyToken;
  readonly register: VimMacroRegisterName;
  readonly depth: number;
  readonly iteration: number;
  readonly commandIndex: number;
  /** Macro output is dispatched as input; mapping expansion remains the parser's job. */
  readonly source: 'macro';
}

export type VimMacroDispatchFailure = { readonly kind: 'dispatch-failed'; readonly message: string };
export type VimMacroDispatchResult = Result<VimMacroDispatchEffect, VimMacroDispatchFailure>;

export interface VimMacroExecutionOptions {
  readonly count?: number;
  /** Register used by `@@`; callers retain this across execute calls. */
  readonly lastRegister?: VimMacroRegisterName;
  readonly maxDepth?: number;
  readonly maxRepeatCount?: number;
  readonly maxCommands?: number;
  readonly sliceSize?: number;
  readonly cancellation?: CancellationToken;
  readonly isCancelled?: () => boolean;
  readonly onSlice?: (progress: VimMacroSliceProgress) => void;
}

export interface VimMacroSliceProgress {
  readonly slices: number;
  readonly consumedTokens: number;
  readonly committedCommands: number;
}

export interface VimMacroExecution {
  readonly status: 'completed' | 'cancelled' | 'failed';
  readonly register: VimMacroRegisterName;
  readonly committedCommands: number;
  readonly consumedTokens: number;
  readonly slices: number;
  readonly lastRegister: VimMacroRegisterName;
  readonly failure?: VimMacroFailure;
}

export interface VimMultiMacroDispatchContext extends VimMacroDispatchContext {
  readonly selections: SelectionSetSnapshot;
}

export interface VimMultiMacroDispatchValue {
  readonly effect: VimMacroDispatchEffect;
  readonly selections: SelectionSetSnapshot;
}

export interface VimMultiMacroExecution extends VimMacroExecution {
  readonly selections: SelectionSetSnapshot;
}

const EMPTY_STORE: VimMacroStore = Object.freeze({
  generation: 0,
  values: new Map<VimMacroRegisterName, VimMacroRegister>(),
});
const DEFAULT_MAX_DEPTH = 1_000;
const DEFAULT_MAX_REPEAT_COUNT = 1_000;
const DEFAULT_MAX_COMMANDS = 100_000;
const DEFAULT_SLICE_SIZE = 64;

export function createVimMacroStore(): VimMacroStore {
  return EMPTY_STORE;
}

/** An uppercase register letter (`qA`) appends to the lowercase register's existing
 * recording instead of replacing it, matching Vim; playback (`@A`) always targets the
 * same lowercase register as `@a`, so only recording start needs to fold the case. */
export function beginVimMacroRecording(register: string, store?: VimMacroStore): VimMacroResult<VimMacroRecordingSession> {
  if (!isMacroRegister(register)) return failure('invalid-register');
  const target = register.toLowerCase();
  if (!isMacroRegister(target)) return failure('invalid-register');
  const appending = target !== register;
  const existing = appending ? store?.values.get(target)?.recording.tokens ?? [] : [];
  return { ok: true, value: Object.freeze({ kind: 'recording', register: target, tokens: Object.freeze([...existing]) }) };
}

/** Append one raw user key; mapping expansions and macro replay are ignored. */
export function recordVimMacroKey(
  session: VimMacroRecordingSession,
  input: VimMacroKeyInput,
): VimMacroResult<VimMacroRecordingSession> {
  if (input === null || typeof input !== 'object' || (input.source !== 'user' && input.source !== 'mapping' && input.source !== 'macro')) {
    return failure('invalid-token');
  }
  if (input.source !== 'user') return { ok: true, value: session };
  if (typeof input.key !== 'string') return failure('invalid-token');
  return recordVimMacroToken(session, { kind: 'key', key: input.key });
}

/** Append a semantic token produced by the parser (for example `@a`). */
export function recordVimMacroToken(
  session: VimMacroRecordingSession,
  token: VimMacroToken,
): VimMacroResult<VimMacroRecordingSession> {
  if (session.kind !== 'recording') return failure('not-recording');
  const checked = normalizeToken(token);
  if (!checked.ok) return checked;
  return {
    ok: true,
    value: Object.freeze({ kind: 'recording', register: session.register, tokens: Object.freeze([...session.tokens, checked.value]) }),
  };
}

export function finishVimMacroRecording(session: VimMacroRecordingSession): VimMacroResult<VimMacroRecording> {
  if (session.kind !== 'recording') return failure('not-recording');
  // 'qaq' (stop immediately) is a valid Vim idiom that clears/records an empty macro,
  // not an error.
  const normalized: VimMacroToken[] = [];
  for (const token of session.tokens) {
    const checked = normalizeToken(token);
    if (!checked.ok) return checked;
    normalized.push(checked.value);
  }
  const tokens = Object.freeze(normalized);
  return { ok: true, value: Object.freeze({ register: session.register, tokens, tokenCount: tokens.length }) };
}

export function writeVimMacro(store: VimMacroStore, recording: VimMacroRecording): VimMacroResult<VimMacroStore> {
  if (!isMacroRegister(recording.register)) return failure('invalid-register');
  const normalized: VimMacroToken[] = [];
  for (const token of recording.tokens) {
    const checked = normalizeToken(token);
    if (!checked.ok) return checked;
    normalized.push(checked.value);
  }
  const tokens = Object.freeze(normalized);
  const nextGeneration = store.generation + 1;
  const prior = store.values.get(recording.register);
  const value = Object.freeze({
    register: recording.register,
    recording: Object.freeze({ register: recording.register, tokens, tokenCount: tokens.length }),
    generation: (prior?.generation ?? 0) + 1,
  });
  const values = new Map(store.values);
  values.set(recording.register, value);
  return { ok: true, value: Object.freeze({ generation: nextGeneration, values }) };
}

export function commitVimMacroRecording(
  store: VimMacroStore,
  session: VimMacroRecordingSession,
): VimMacroResult<{ readonly store: VimMacroStore; readonly recording: VimMacroRecording }> {
  const recording = finishVimMacroRecording(session);
  if (!recording.ok) return recording;
  const next = writeVimMacro(store, recording.value);
  if (!next.ok) return next;
  return { ok: true, value: Object.freeze({ store: next.value, recording: recording.value }) };
}

export function readVimMacro(store: VimMacroStore, register: string): VimMacroResult<VimMacroRegister> {
  if (!isMacroRegister(register)) return failure('invalid-register');
  const value = store.values.get(register);
  return value === undefined ? failure('macro-not-found', register) : { ok: true, value };
}

/**
 * Execute a macro through the caller's parser/dispatcher. Every callback is
 * one atomic command; a callback failure stops playback with prior commits
 * retained. Nested calls share the deterministic work budget and slices.
 */
export function executeVimMacro(
  store: VimMacroStore,
  register: string,
  dispatch: (context: VimMacroDispatchContext) => VimMacroDispatchResult,
  options: VimMacroExecutionOptions = {},
): VimMacroResult<VimMacroExecution> {
  const root = register === '@' ? options.lastRegister : register;
  if (root === undefined || !isMacroRegister(root)) return failure('invalid-register');
  const count = normalizeBoundedCount(options.count ?? 1);
  const maxDepth = normalizeLimit(options.maxDepth ?? DEFAULT_MAX_DEPTH);
  const maxRepeatCount = normalizeLimit(options.maxRepeatCount ?? DEFAULT_MAX_REPEAT_COUNT);
  const maxCommands = normalizeLimit(options.maxCommands ?? DEFAULT_MAX_COMMANDS);
  const sliceSize = normalizeLimit(options.sliceSize ?? DEFAULT_SLICE_SIZE);
  if (count === null || maxDepth === null || maxRepeatCount === null || maxCommands === null || sliceSize === null) {
    return failure('repeat-count-limit', options.count ?? 1, options.maxRepeatCount ?? DEFAULT_MAX_REPEAT_COUNT);
  }
  const effectiveMaxDepth = maxDepth;
  const effectiveMaxRepeatCount = maxRepeatCount;
  const effectiveMaxCommands = maxCommands;
  const effectiveSliceSize = sliceSize;

  let consumedTokens = 0;
  let committedCommands = 0;
  let slices = 0;
  let lastRegister: VimMacroRegisterName = root;

  const cancelled = (): boolean => options.cancellation?.isCancelled === true || options.isCancelled?.() === true;
  const progress = (): void => {
    slices += 1;
    options.onSlice?.(Object.freeze({ slices, consumedTokens, committedCommands }));
  };
  const result = run(root, count, 0);
  return { ok: true, value: Object.freeze({
    status: result.status,
    register: root,
    committedCommands,
    consumedTokens,
    slices,
    lastRegister,
    ...(result.failure === undefined ? {} : { failure: result.failure }),
  }) };

  function run(current: VimMacroRegisterName, repeats: number, depth: number): { readonly status: VimMacroExecution['status']; readonly failure?: VimMacroFailure } {
    // Vim allows a macro to invoke itself (e.g. register 'a' recorded with a trailing
    // '@a', a common repeat-to-end-of-file idiom); it terminates naturally when a motion
    // inside it fails, not via a same-register rejection. Only a bounded depth guards
    // against runaway/infinite recursion.
    if (depth > effectiveMaxDepth) return { status: 'failed', failure: { kind: 'depth-limit', limit: effectiveMaxDepth } };
    if (repeats < 1 || repeats > effectiveMaxRepeatCount) return { status: 'failed', failure: { kind: 'repeat-count-limit', count: repeats, limit: effectiveMaxRepeatCount } };
    const macro = store.values.get(current);
    if (macro === undefined) return { status: 'failed', failure: { kind: 'macro-not-found', register: current } };
    lastRegister = current;
    for (let iteration = 0; iteration < repeats; iteration += 1) {
      for (const token of macro.recording.tokens) {
        if (cancelled()) return { status: 'cancelled', failure: { kind: 'cancelled' } };
        if (consumedTokens >= effectiveMaxCommands) return { status: 'failed', failure: { kind: 'work-budget', limit: effectiveMaxCommands } };
        consumedTokens += 1;
        if (consumedTokens % effectiveSliceSize === 0) progress();
        const tokenResult = executeToken(token, current, iteration, depth);
        if (tokenResult.status !== 'completed') return tokenResult;
      }
    }
    return { status: 'completed' };
  }

  function executeToken(
    token: VimMacroToken,
    current: VimMacroRegisterName,
    iteration: number,
    depth: number,
  ): { readonly status: VimMacroExecution['status']; readonly failure?: VimMacroFailure } {
    if (token.kind === 'macro-call') {
      const nested = run(token.register, token.count, depth + 1);
      return nested;
    }
    if (token.kind === 'repeat-last') {
      const nested = run(lastRegister, 1, depth + 1);
      return nested;
    }
    const dispatched = dispatch(Object.freeze({
      token,
      register: current,
      depth,
      iteration,
      commandIndex: consumedTokens,
      source: 'macro',
    }));
    if (!dispatched.ok) return { status: 'failed', failure: dispatched.error };
    if (dispatched.value.kind === 'continue') {
      if (dispatched.value.committed) committedCommands += 1;
      return { status: 'completed' };
    }
    if (dispatched.value.kind === 'invoke') {
      const nested = run(dispatched.value.register, dispatched.value.count ?? 1, depth + 1);
      return nested;
    }
    return run(lastRegister, 1, depth + 1);
  }
}

/** Execute one macro input stream once through the current selection set. The callback owns atomic commit. */
export function executeVimMultiMacro(
  store: VimMacroStore,
  register: string,
  selections: SelectionSetSnapshot,
  dispatch: (context: VimMultiMacroDispatchContext) => Result<VimMultiMacroDispatchValue, VimMacroDispatchFailure>,
  options: VimMacroExecutionOptions = {},
): VimMacroResult<VimMultiMacroExecution> {
  let current = selections;
  const execution = executeVimMacro(store, register, (context) => {
    const result = dispatch(Object.freeze({ ...context, selections: current }));
    if (!result.ok) return result;
    current = result.value.selections;
    return { ok: true, value: result.value.effect };
  }, options);
  if (!execution.ok) return execution;
  return { ok: true, value: Object.freeze({ ...execution.value, selections: current }) };
}

function normalizeToken(token: VimMacroToken): VimMacroResult<VimMacroToken> {
  if (token === null || typeof token !== 'object') return failure('invalid-token');
  if (token.kind === 'key') {
    return typeof token.key !== 'string' || token.key.length === 0 || token.key.includes('\0')
      ? failure('invalid-token')
      : { ok: true, value: Object.freeze({ kind: 'key', key: token.key }) };
  }
  if (token.kind === 'macro-call') {
    if (typeof token.register !== 'string' || !isMacroRegister(token.register) || normalizeBoundedCount(token.count) === null) return failure('invalid-token');
    return { ok: true, value: Object.freeze({ kind: 'macro-call', register: token.register, count: token.count }) };
  }
  if (token.kind === 'repeat-last') return { ok: true, value: Object.freeze({ kind: 'repeat-last' }) };
  return failure('invalid-token');
}

function isMacroRegister(value: string): value is VimMacroRegisterName {
  return isRegisterName(value) && /^[a-zA-Z0-9]$/u.test(value);
}

function normalizeBoundedCount(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function normalizeLimit(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function failure(kind: 'invalid-register' | 'invalid-token' | 'already-recording' | 'not-recording' | 'empty-macro' | 'cancelled'): VimMacroResult<never>;
function failure(kind: 'macro-not-found' | 'recursive-macro', register: VimMacroRegisterName): VimMacroResult<never>;
function failure(kind: 'repeat-count-limit', count: number, limit: number): VimMacroResult<never>;
function failure(kind: VimMacroFailure['kind'], value?: VimMacroRegisterName | number, limit?: number): VimMacroResult<never> {
  if (kind === 'macro-not-found' || kind === 'recursive-macro') return { ok: false, error: { kind, register: value as VimMacroRegisterName } };
  if (kind === 'repeat-count-limit') return { ok: false, error: { kind, count: value as number, limit: limit as number } };
  return { ok: false, error: { kind } as VimMacroFailure };
}
