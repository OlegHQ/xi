import type { SelectionKind, SelectionSetSnapshot } from '../../selections/src/index.ts';
import type { Result } from '../../contracts/src/index.ts';
import type { NormalizedVimInput } from '../input/index.ts';
import type { InputModifiers } from '../../contracts/src/index.ts';

export type VimMode = 'normal' | 'insert' | 'replace' | 'virtual-replace'
  | 'visual-character' | 'visual-line' | 'visual-block'
  | 'select-character' | 'select-line' | 'select-block';

export interface VimCount {
  /** A nonzero, safe integer. Oversized decimal input saturates at this bound. */
  readonly value: number;
  readonly saturated: boolean;
  /** True when the user typed count digits explicitly; false for an implied default of 1 (bare `G` vs `1G`). */
  readonly explicit: boolean;
}

export type VimOperator =
  | 'delete' | 'change' | 'yank' | 'indent-right' | 'indent-left' | 'indent-equal' | 'filter'
  | 'format' | 'format-preserve' | 'lowercase' | 'uppercase' | 'swapcase' | 'rot13' | 'user';

export interface VimOperatorPrefix {
  readonly name: VimOperator;
  /** Native key sequence that starts this operator (for example `gq`). */
  readonly key: string;
  /** Final key used by a doubled form (for example `gqq`). */
  readonly repeatKey: string;
}

export type VimGrammarPrefix = 'g' | 'z' | 'ctrl-w' | 'ctrl-w-g' | 'ctrl-backslash' | 'left-bracket' | 'right-bracket' | 'text-object-inner' | 'text-object-around' | 'Z';
/** o_v/o_V/o_CTRL-V: forces an otherwise linewise/characterwise motion to the given wise-ness (`dvj`, `dVj`, `d<C-v>j`). */
export type VimOperatorForce = 'v' | 'V' | '<C-v>';
export type VimLiteralCommand = 'find-forward' | 'find-backward' | 'till-forward' | 'till-backward' | 'replace-character' | 'virtual-replace' | 'set-mark' | 'jump-mark' | 'jump-mark-line' | 'record-macro' | 'play-macro';

export interface VimParserSession {
  readonly mode: VimMode;
  readonly selections: SelectionSetSnapshot;
}

export type VimContinuation =
  | { readonly kind: 'keys'; readonly keys: readonly string[]; readonly label: string }
  | { readonly kind: 'motions'; readonly keys: readonly string[]; readonly label: string }
  | { readonly kind: 'count-digits'; readonly keys: readonly string[]; readonly label: string }
  | { readonly kind: 'register-name'; readonly characters: readonly string[]; readonly label: string }
  | { readonly kind: 'literal-character'; readonly label: string }
  | { readonly kind: 'escape'; readonly label: string };

export type VimPendingInput =
  | { readonly kind: 'none' }
  | { readonly kind: 'count'; readonly count: VimCount }
  | { readonly kind: 'register-name'; readonly count: VimCount | undefined }
  | { readonly kind: 'register-command'; readonly register: string; readonly precount: VimCount | undefined; readonly postCount: VimCount | undefined }
  | { readonly kind: 'operator-motion'; readonly operator: VimOperatorPrefix; readonly operatorCount: VimCount; readonly motionCount: VimCount | undefined; readonly register: string | undefined; readonly force: VimOperatorForce | undefined }
  | { readonly kind: 'command-prefix'; readonly prefix: VimGrammarPrefix; readonly count: VimCount | undefined; readonly register: string | undefined; readonly operator: VimOperatorPrefix | undefined; readonly operatorCount: VimCount | undefined; readonly motionCount: VimCount | undefined }
  | { readonly kind: 'literal-argument'; readonly command: VimLiteralCommand; readonly count: VimCount | undefined; readonly register: string | undefined; readonly operator: VimOperatorPrefix | undefined; readonly operatorCount: VimCount | undefined; readonly motionCount: VimCount | undefined };

export interface VimParserState {
  readonly session: VimParserSession;
  readonly pending: VimPendingInput;
  /** Parser-owned grammar metadata; a help view can consume this without a second parser. */
  readonly legalContinuations: readonly VimContinuation[];
}

export type VimParserStateFailure =
  | { readonly kind: 'mode-selection-mismatch'; readonly mode: VimMode; readonly selectionKind: SelectionKind }
  | { readonly kind: 'empty-selection-set' };

export interface VimCommandContext {
  readonly selections: SelectionSetSnapshot;
  readonly atMilliseconds: number;
}

export type VimCommandIntent =
  | (VimCommandContext & { readonly kind: 'single-key'; readonly key: string; readonly count: VimCount; readonly register?: string })
  | (VimCommandContext & { readonly kind: 'operator-motion'; readonly operator: VimOperatorPrefix; readonly motion: string; readonly operatorCount: VimCount; readonly motionCount: VimCount; readonly register?: string; readonly force?: VimOperatorForce })
  | (VimCommandContext & { readonly kind: 'operator-line'; readonly operator: VimOperatorPrefix; readonly count: VimCount; readonly register?: string })
  | (VimCommandContext & { readonly kind: 'operator-text-object'; readonly operator: VimOperatorPrefix; readonly textObject: string; readonly operatorCount: VimCount; readonly motionCount: VimCount; readonly register?: string })
  | (VimCommandContext & { readonly kind: 'prefixed-key'; readonly prefix: VimGrammarPrefix; readonly key: string; readonly count: VimCount; readonly register?: string })
  | (VimCommandContext & { readonly kind: 'literal-command'; readonly command: VimLiteralCommand; readonly argument: string; readonly operator?: VimOperatorPrefix; readonly operatorCount?: VimCount; readonly motionCount?: VimCount; readonly count: VimCount; readonly register?: string })
  | (VimCommandContext & { readonly kind: 'mode-transition'; readonly from: VimMode; readonly to: VimMode; readonly key: string; readonly count: VimCount })
  | (VimCommandContext & { readonly kind: 'leave-mode'; readonly from: VimMode; readonly to: 'normal'; readonly via: 'escape' | 'ctrl-c' })
  | (VimCommandContext & { readonly kind: 'insert-key'; readonly key: string; readonly modifiers: InputModifiers; readonly mode: 'insert' | 'replace' | 'virtual-replace' })
  | (VimCommandContext & { readonly kind: 'select-key'; readonly key: string; readonly modifiers: InputModifiers; readonly mode: 'select-character' | 'select-line' | 'select-block' })
  | (VimCommandContext & { readonly kind: 'paste'; readonly bytes: Uint8Array; readonly mode: VimMode })
  | (VimCommandContext & { readonly kind: 'begin-command-line'; readonly key: ':'; readonly mode: VimMode })
  | (VimCommandContext & { readonly kind: 'begin-search'; readonly direction: 'forward' | 'backward'; readonly mode: VimMode; readonly count?: VimCount });

export type VimParseFailure =
  | { readonly kind: 'unknown-key'; readonly key: string }
  | { readonly kind: 'invalid-continuation'; readonly key: string; readonly pendingKind: VimPendingInput['kind'] }
  | { readonly kind: 'invalid-register'; readonly key: string }
  | { readonly kind: 'invalid-literal-argument'; readonly key: string };

export type VimParseOutcome =
  | { readonly kind: 'pending'; readonly state: VimParserState; readonly continuations: readonly VimContinuation[] }
  | { readonly kind: 'command'; readonly state: VimParserState; readonly command: VimCommandIntent; readonly cancelledPending?: VimPendingInput }
  | { readonly kind: 'consumed'; readonly state: VimParserState; readonly reason: 'key-release' | 'focus-restored' | 'idle-escape' }
  | { readonly kind: 'cancelled'; readonly state: VimParserState; readonly reason: 'escape' | 'focus-lost' | 'paste-interrupted-prefix'; readonly cancelled: VimPendingInput }
  | { readonly kind: 'failed'; readonly state: VimParserState; readonly failure: VimParseFailure }
  | { readonly kind: 'unhandled'; readonly state: VimParserState; readonly reason: 'pointer-event' };

const MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER;
const NONE: VimPendingInput = Object.freeze({ kind: 'none' });
const REGISTER_NAMES = Object.freeze(Array.from('"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-+*/_%#:.='));
const DIGITS = Object.freeze(Array.from('0123456789'));
const MOTION_KEYS = Object.freeze(Array.from('hl0^$|+_-jkwWbBeEgE%(){}[];,:nN*#fFtT`\'/?HMLG').concat(['<Left>', '<Right>', '<Up>', '<Down>', '<Home>', '<End>', '<PageUp>', '<PageDown>', '<C-b>', '<C-f>', '<C-d>', '<C-u>', '<CR>', '<Space>']));
const G_KEYS = Object.freeze(['g', 'j', 'k', '0', '^', '$', '_', 'm', 'M', ';', ',', '*', '#', '?', 'e', 'E', 'J', 'I', 'R', 'U', 'u', '~', 'q', 'w', 'r', 'v', 'V', 'x', 'X', '<', '>', '%', 'd', 'f', 'F', 'h', 'l', 'n', 'N', 'p', 'P', 't', 'T', 'a', 'A', 'o', 'O', 's', 'S', 'c', 'C', 'D', 'K', ']', '<C-]>', '<', '>', '<C-a>', '<C-x>']);
const Z_KEYS = Object.freeze(['z', 't', 'b', '<CR>', '<Space>', '=', 'f', 'F', 'o', 'O', 'H', 'L', 'M', 'w', 'W', 'h', 'l', 'z']);
const CTRL_W_KEYS = Object.freeze(['h', 'j', 'k', 'l', 't', 'w', 'W', 'b', 'B', 'p', 'P', 'n', 'o', 'O', 'c', 'q', 'v', 'T', 'g', 'f', 'F', ']', '}', '=', '+', '-', '<', '>', '_', '|', 's', 'S', 'x', 'X', 'r', 'R']);
const CTRL_W_G_KEYS = Object.freeze(['f', 'F', ']', '}', 't', 'T', 'g', 'G', '+', '-', '<', '>', '_', '|']);
const TEXT_OBJECT_KEYS = Object.freeze(['w', 'W', 's', 'p', '"', "'", '`', '(', '[', '{', '<', '>', ')', 'b', 'B', ']', '}', 't']);
const BRACKET_HOST_KEYS = Object.freeze(['[', ']', '(', ')', '{', '}', 'd', 'D', '<C-d>', '<C-i>']);

const noContinuations: readonly VimContinuation[] = Object.freeze([]);

export function createVimParserState(
  mode: VimMode,
  selections: SelectionSetSnapshot,
): Result<VimParserState, VimParserStateFailure> {
  const expectedKind = selectionKindForMode(mode);
  const selectionKind = selections.members[0]?.kind;
  if (selectionKind === undefined) return { ok: false, error: { kind: 'empty-selection-set' } };
  if (selectionKind !== expectedKind) return { ok: false, error: { kind: 'mode-selection-mismatch', mode, selectionKind } };
  return { ok: true, value: makeState({ mode, selections }, NONE) };
}

/**
 * Install a committed session snapshot after command execution. Any pending
 * grammar tied to the prior mode or selection generation is discarded.
 */
export function updateVimParserSession(
  state: VimParserState,
  mode: VimMode,
  selections: SelectionSetSnapshot,
): Result<{ readonly state: VimParserState; readonly cancelledPending: boolean }, VimParserStateFailure> {
  const next = createVimParserState(mode, selections);
  if (!next.ok) return next;
  const compatible = state.session.mode === mode
    && state.session.selections.documentId === selections.documentId
    && state.session.selections.documentVersion === selections.documentVersion
    && state.session.selections.selectionGeneration === selections.selectionGeneration;
  return {
    ok: true,
    value: {
      state: makeState(next.value.session, compatible ? state.pending : NONE),
      cancelledPending: !compatible && state.pending.kind !== 'none',
    },
  };
}

/** Parse one normalized event. No text, register, or selection is mutated here. */
export function parseVimInput(state: VimParserState, input: NormalizedVimInput): VimParseOutcome {
  if (input.kind === 'pointer') return { kind: 'unhandled', state, reason: 'pointer-event' };
  if (input.kind === 'focus') {
    if (input.focused) return { kind: 'consumed', state, reason: 'focus-restored' };
    if (state.pending.kind === 'none') return { kind: 'cancelled', state, reason: 'focus-lost', cancelled: NONE };
    return { kind: 'cancelled', state: makeState(state.session, NONE), reason: 'focus-lost', cancelled: state.pending };
  }
  if (input.kind === 'paste') {
    const next = makeState(state.session, NONE);
    const command: VimCommandIntent = {
      kind: 'paste',
      bytes: new Uint8Array(input.bytes),
      mode: state.session.mode,
      selections: state.session.selections,
      atMilliseconds: input.atMilliseconds,
    };
    // Paste is an opaque input event. It cancels an incomplete key grammar but
    // its bytes remain one paste intent and are never recursively parsed.
    return state.pending.kind === 'none'
      ? { kind: 'command', state: next, command }
      : { kind: 'command', state: next, command, cancelledPending: state.pending };
  }

  if (input.phase === 'release') return { kind: 'consumed', state, reason: 'key-release' };
  const key = keyToken(input);
  if (key === '<Esc>') return escape(state, input.atMilliseconds);
  if (state.session.mode === 'insert' || state.session.mode === 'replace' || state.session.mode === 'virtual-replace') {
    return parseInsertKey(state, input, key);
  }
  if (isSelectMode(state.session.mode)) return parseSelectKey(state, input, key, state.session.mode);
  return parseCommandKey(state, input, key);
}

function escape(state: VimParserState, atMilliseconds: number): VimParseOutcome {
  if (state.pending.kind !== 'none') {
    return { kind: 'cancelled', state: makeState(state.session, NONE), reason: 'escape', cancelled: state.pending };
  }
  if (state.session.mode === 'normal') return { kind: 'consumed', state, reason: 'idle-escape' };
  return command(state, NONE, {
    kind: 'leave-mode', from: state.session.mode, to: 'normal', via: 'escape',
    selections: state.session.selections, atMilliseconds,
  });
}

function parseInsertKey(
  state: VimParserState,
  input: Extract<NormalizedVimInput, { readonly kind: 'key' }>,
  key: string,
): VimParseOutcome {
  if (key === '<C-c>') {
    return command(state, NONE, {
      kind: 'leave-mode', from: state.session.mode, to: 'normal', via: 'ctrl-c',
      selections: state.session.selections, atMilliseconds: input.atMilliseconds,
    });
  }
  if (key === '<C-o>') {
    return command(state, NONE, {
      kind: 'insert-key', key, modifiers: input.modifiers, mode: state.session.mode as 'insert' | 'replace' | 'virtual-replace',
      selections: state.session.selections, atMilliseconds: input.atMilliseconds,
    });
  }
  return command(state, NONE, {
    kind: 'insert-key', key, modifiers: input.modifiers, mode: state.session.mode as 'insert' | 'replace' | 'virtual-replace',
    selections: state.session.selections, atMilliseconds: input.atMilliseconds,
  });
}

function parseSelectKey(
  state: VimParserState,
  input: Extract<NormalizedVimInput, { readonly kind: 'key' }>,
  key: string,
  mode: 'select-character' | 'select-line' | 'select-block',
): VimParseOutcome {
  if (key === '<C-g>') {
    const to = visualModeForSelect(mode);
    return command(state, NONE, {
      kind: 'mode-transition', from: state.session.mode, to, key,
      count: oneCount(), selections: state.session.selections, atMilliseconds: input.atMilliseconds,
    });
  }
  if (key === '<C-c>') return command(state, NONE, {
    kind: 'leave-mode', from: state.session.mode, to: 'normal', via: 'ctrl-c',
    selections: state.session.selections, atMilliseconds: input.atMilliseconds,
  });
  // In Select mode printable keys replace the selected text. Non-printing
  // navigation keys continue through normal command dispatch so the session
  // can extend the selection without storing text in the input adapter.
  if (isSelectNavigationKey(key)) return command(state, NONE, {
    kind: 'single-key', key, count: oneCount(),
    selections: state.session.selections, atMilliseconds: input.atMilliseconds,
  });
  return command(state, NONE, {
    kind: 'select-key', key, modifiers: input.modifiers,
    mode,
    selections: state.session.selections, atMilliseconds: input.atMilliseconds,
  });
}

function isSelectNavigationKey(key: string): boolean {
  return key === '<Left>' || key === '<Right>' || key === '<Up>' || key === '<Down>'
    || key === '<Home>' || key === '<End>' || key === '<PageUp>' || key === '<PageDown>'
    || key === '<C-b>' || key === '<C-f>' || key === '<C-d>' || key === '<C-u>'
    || key === '<C-o>' || key === '<C-i>';
}

function parseCommandKey(
  state: VimParserState,
  input: Extract<NormalizedVimInput, { readonly kind: 'key' }>,
  key: string,
): VimParseOutcome {
  switch (state.pending.kind) {
    case 'none': return parseRootKey(state, input.atMilliseconds, key);
    case 'count': return parseCountKey(state, input.atMilliseconds, key, state.pending.count);
    case 'register-name': {
      if (!isRegisterName(key)) return fail(state, { kind: 'invalid-register', key });
      return pending(state, { kind: 'register-command', register: key, precount: state.pending.count, postCount: undefined });
    }
    case 'register-command': {
      // Vim: [count1]"x[count2]command multiplies count1 and count2; a leading
      // 0 after the register is the '0' motion (line start), not a digit,
      // unless count2 digits have already started (e.g. `"a10`).
      if (isDigit(key) && (key !== '0' || state.pending.postCount !== undefined)) {
        return pending(state, { kind: 'register-command', register: state.pending.register, precount: state.pending.precount, postCount: appendCount(state.pending.postCount, key) });
      }
      return parseRootWithContext(state, input.atMilliseconds, key, context(mergeRegisterCounts(state.pending.precount, state.pending.postCount), state.pending.register));
    }
    case 'operator-motion': return parseOperatorKey(state, input.atMilliseconds, key, state.pending);
    case 'command-prefix': return parsePrefixKey(state, input.atMilliseconds, key, state.pending);
    case 'literal-argument': return parseLiteralKey(state, input.atMilliseconds, key, state.pending);
  }
}

function parseRootKey(state: VimParserState, atMilliseconds: number, key: string): VimParseOutcome {
  if (isDigit(key) && key !== '0') return pending(state, { kind: 'count', count: appendCount(undefined, key) });
  return parseRootWithContext(state, atMilliseconds, key, {});
}

function parseCountKey(state: VimParserState, atMilliseconds: number, key: string, count: VimCount): VimParseOutcome {
  if (isDigit(key)) return pending(state, { kind: 'count', count: appendCount(count, key) });
  return parseRootWithContext(state, atMilliseconds, key, { count });
}

interface CommandContext {
  readonly count?: VimCount;
  readonly register?: string;
}

const VISUAL_IMMEDIATE_KEYS = Object.freeze(['o', 'O', 'd', 'c', 'y', '<', '>', '=']);

function parseRootWithContext(state: VimParserState, atMilliseconds: number, key: string, ctx: CommandContext): VimParseOutcome {
  if (key === '"') return pending(state, { kind: 'register-name', count: ctx.count });
  if (state.session.mode.startsWith('visual-') && VISUAL_IMMEDIATE_KEYS.includes(key)) {
    return command(state, NONE, {
      kind: 'single-key', key, count: ctx.count ?? oneCount(),
      ...(ctx.register === undefined ? {} : { register: ctx.register }),
      selections: state.session.selections, atMilliseconds,
    });
  }
  const operator = directOperator(key);
  if (operator !== undefined) {
    return pending(state, {
      kind: 'operator-motion', operator,
      operatorCount: ctx.count ?? oneCount(), motionCount: undefined,
      register: ctx.register, force: undefined,
    });
  }
  const literal = literalCommand(key);
  if (literal !== undefined) return pending(state, {
    kind: 'literal-argument', command: literal, count: ctx.count, register: ctx.register,
    operator: undefined, operatorCount: undefined, motionCount: undefined,
  });
  if (key === 'g' || key === 'z' || key === '<C-w>' || key === '<C-\\>' || key === '[' || key === ']' || key === 'Z') {
    return pending(state, {
      kind: 'command-prefix', prefix: prefixName(key), count: ctx.count, register: ctx.register,
      operator: undefined, operatorCount: undefined, motionCount: undefined,
    });
  }
  if (key === ':') return command(state, NONE, {
    kind: 'begin-command-line', key: ':', mode: state.session.mode,
    selections: state.session.selections, atMilliseconds,
  });
  if (key === '/' || key === '?') return command(state, NONE, {
    kind: 'begin-search', direction: key === '/' ? 'forward' : 'backward', mode: state.session.mode,
    ...(ctx.count === undefined ? {} : { count: ctx.count }),
    selections: state.session.selections, atMilliseconds,
  });

  const modeIntent = modeKeyIntent(state.session.mode, key);
  if (modeIntent !== undefined) return command(state, NONE, {
    kind: 'mode-transition', from: state.session.mode, to: modeIntent, key,
    count: ctx.count ?? oneCount(), selections: state.session.selections, atMilliseconds,
  });

  if (!isRecognizedSingleKey(key, state.session.mode)) return fail(state, { kind: 'unknown-key', key });
  return command(state, NONE, {
    kind: 'single-key', key, count: ctx.count ?? oneCount(),
    ...(ctx.register === undefined ? {} : { register: ctx.register }),
    selections: state.session.selections, atMilliseconds,
  });
}

function parseOperatorKey(
  state: VimParserState,
  atMilliseconds: number,
  key: string,
  pendingInput: Extract<VimPendingInput, { readonly kind: 'operator-motion' }>,
): VimParseOutcome {
  if (isDigit(key)) {
    if (key === '0' && pendingInput.motionCount === undefined) {
      return operatorMotion(state, atMilliseconds, pendingInput, '0');
    }
    return pending(state, { ...pendingInput, motionCount: appendCount(pendingInput.motionCount, key) });
  }
  // nvim (dvj/dVj/d<C-v>j): v/V/<C-v> right after the operator forces the
  // following motion's wise-ness instead of starting Visual mode.
  if (pendingInput.force === undefined && (key === 'v' || key === 'V' || key === '<C-v>')) {
    return pending(state, { ...pendingInput, force: key });
  }
  if (key === pendingInput.operator.repeatKey) return command(state, NONE, {
    kind: 'operator-line', operator: pendingInput.operator, count: multiplyCounts(pendingInput.operatorCount, pendingInput.motionCount ?? oneCount()),
    ...(pendingInput.register === undefined ? {} : { register: pendingInput.register }),
    selections: state.session.selections, atMilliseconds,
  });
  if (key === 'g' || key === 'z' || key === '<C-w>' || key === '[' || key === ']') {
    return pending(state, {
      kind: 'command-prefix', prefix: prefixName(key), count: undefined, register: pendingInput.register,
      operator: pendingInput.operator, operatorCount: pendingInput.operatorCount, motionCount: pendingInput.motionCount,
    });
  }
  if (key === 'i' || key === 'a') return pending(state, {
    kind: 'command-prefix', prefix: key === 'i' ? 'text-object-inner' : 'text-object-around',
    count: undefined, register: pendingInput.register, operator: pendingInput.operator,
    operatorCount: pendingInput.operatorCount, motionCount: pendingInput.motionCount,
  });
  const literal = literalCommand(key);
  if (literal !== undefined) {
    if (!isOperatorMotionLiteral(literal)) return fail(state, { kind: 'invalid-continuation', key, pendingKind: pendingInput.kind });
    return pending(state, {
      kind: 'literal-argument', command: literal, count: undefined, register: pendingInput.register,
      operator: pendingInput.operator, operatorCount: pendingInput.operatorCount, motionCount: pendingInput.motionCount,
    });
  }
  if (isMotionKey(key)) return operatorMotion(state, atMilliseconds, pendingInput, key);
  return fail(state, { kind: 'invalid-continuation', key, pendingKind: pendingInput.kind });
}

function parsePrefixKey(
  state: VimParserState,
  atMilliseconds: number,
  key: string,
  prefix: Extract<VimPendingInput, { readonly kind: 'command-prefix' }>,
): VimParseOutcome {
  if (prefix.prefix === 'text-object-inner' || prefix.prefix === 'text-object-around') {
    if (prefix.operator !== undefined && TEXT_OBJECT_KEYS.includes(key)) return operatorTextObject(state, atMilliseconds, prefix, key);
    return fail(state, { kind: 'invalid-continuation', key, pendingKind: prefix.kind });
  }
  if (prefix.prefix === 'left-bracket' || prefix.prefix === 'right-bracket') {
    if (BRACKET_HOST_KEYS.includes(key)) {
      return prefixed(state, atMilliseconds, prefix, key);
    }
    return fail(state, { kind: 'invalid-continuation', key, pendingKind: prefix.kind });
  }

  if (prefix.prefix === 'ctrl-backslash') {
    if (key !== '<C-n>' && key !== '<C-g>') return fail(state, { kind: 'invalid-continuation', key, pendingKind: prefix.kind });
    return prefixed(state, atMilliseconds, prefix, key);
  }

  if (prefix.prefix === 'g') {
    if (prefix.operator === undefined && key === 'r') return pending(state, {
      kind: 'literal-argument', command: 'virtual-replace', count: prefix.count,
      register: prefix.register, operator: undefined, operatorCount: undefined, motionCount: undefined,
    });
    if (prefix.operator === undefined) {
      const selectMode = selectModeForKey(key);
      if (selectMode !== undefined) return command(state, NONE, {
        kind: 'mode-transition', from: state.session.mode, to: selectMode, key: `g${key}`,
        count: prefix.count ?? oneCount(), selections: state.session.selections, atMilliseconds,
      });
    }
    const gOperator = gOperatorPrefix(key);
    if (gOperator !== undefined) {
      // nvim (visual, 'gu' etc.): a g-operator typed while a selection is
      // active acts immediately on the selection, like plain d/c/y do.
      if (prefix.operator === undefined && state.session.mode.startsWith('visual-')) return command(state, NONE, {
        kind: 'single-key', key: `g${key}`, count: prefix.count ?? oneCount(),
        ...(prefix.register === undefined ? {} : { register: prefix.register }),
        selections: state.session.selections, atMilliseconds,
      });
      if (prefix.operator !== undefined) {
        if (key === prefix.operator.repeatKey) return command(state, NONE, {
          kind: 'operator-line', operator: prefix.operator,
          count: multiplyCounts(prefix.operatorCount ?? oneCount(), prefix.motionCount ?? oneCount()),
          ...(prefix.register === undefined ? {} : { register: prefix.register }),
          selections: state.session.selections, atMilliseconds,
        });
        return fail(state, { kind: 'invalid-continuation', key, pendingKind: prefix.kind });
      }
      return pending(state, {
        kind: 'operator-motion', operator: gOperator, operatorCount: prefix.count ?? oneCount(),
        motionCount: undefined, register: prefix.register, force: undefined,
      });
    }
    if (!G_KEYS.includes(key)) return fail(state, { kind: 'invalid-continuation', key, pendingKind: prefix.kind });
    if (prefix.operator !== undefined && !isMotionKey(`g${key}`)) return fail(state, { kind: 'invalid-continuation', key, pendingKind: prefix.kind });
    if (prefix.operator !== undefined) return command(state, NONE, {
      kind: 'operator-motion', operator: prefix.operator, motion: `g${key}`,
      operatorCount: prefix.operatorCount ?? oneCount(), motionCount: prefix.motionCount ?? oneCount(),
      ...(prefix.register === undefined ? {} : { register: prefix.register }),
      selections: state.session.selections, atMilliseconds,
    });
    return prefixed(state, atMilliseconds, prefix, key);
  }

  if (prefix.prefix === 'z') {
    if (!Z_KEYS.includes(key)) return fail(state, { kind: 'invalid-continuation', key, pendingKind: prefix.kind });
    if (prefix.operator !== undefined) return command(state, NONE, {
      kind: 'operator-motion', operator: prefix.operator, motion: `z${key}`,
      operatorCount: prefix.operatorCount ?? oneCount(), motionCount: prefix.motionCount ?? oneCount(),
      ...(prefix.register === undefined ? {} : { register: prefix.register }),
      selections: state.session.selections, atMilliseconds,
    });
    return prefixed(state, atMilliseconds, prefix, key);
  }

  if (prefix.prefix === 'ctrl-w') {
    if (!CTRL_W_KEYS.includes(key)) return fail(state, { kind: 'invalid-continuation', key, pendingKind: prefix.kind });
    if (prefix.operator !== undefined) return fail(state, { kind: 'invalid-continuation', key, pendingKind: prefix.kind });
    if (key === 'g') return pending(state, {
      kind: 'command-prefix', prefix: 'ctrl-w-g', count: prefix.count, register: prefix.register,
      operator: undefined, operatorCount: undefined, motionCount: undefined,
    });
    return prefixed(state, atMilliseconds, prefix, key);
  }

  if (prefix.prefix === 'ctrl-w-g') {
    if (!CTRL_W_G_KEYS.includes(key)) return fail(state, { kind: 'invalid-continuation', key, pendingKind: prefix.kind });
    if (prefix.operator !== undefined) return fail(state, { kind: 'invalid-continuation', key, pendingKind: prefix.kind });
    return prefixed(state, atMilliseconds, prefix, key);
  }

  if (prefix.prefix === 'Z') {
    if (key !== 'Z' && key !== 'Q') return fail(state, { kind: 'invalid-continuation', key, pendingKind: prefix.kind });
    return prefixed(state, atMilliseconds, prefix, key);
  }

  return fail(state, { kind: 'invalid-continuation', key, pendingKind: prefix.kind });
}

function parseLiteralKey(
  state: VimParserState,
  atMilliseconds: number,
  key: string,
  pendingInput: Extract<VimPendingInput, { readonly kind: 'literal-argument' }>,
): VimParseOutcome {
  // nvim (r<CR>, f<Tab>): named single-character keys are literal arguments too,
  // not just the printable characters isSingleLiteral otherwise accepts.
  const argument = key === '<Space>' ? ' ' : key === '<CR>' ? '\n' : key === '<Tab>' ? '\t' : key;
  if (!isSingleLiteral(argument)) return fail(state, { kind: 'invalid-literal-argument', key });
  if (pendingInput.operator !== undefined && isOperatorMotionLiteral(pendingInput.command)) {
    return command(state, NONE, {
      kind: 'operator-motion', operator: pendingInput.operator, motion: `${literalKey(pendingInput.command)}${argument}`,
      operatorCount: pendingInput.operatorCount ?? oneCount(), motionCount: pendingInput.motionCount ?? pendingInput.count ?? oneCount(),
      ...(pendingInput.register === undefined ? {} : { register: pendingInput.register }),
      selections: state.session.selections, atMilliseconds,
    });
  }
  return command(state, NONE, {
    kind: 'literal-command', command: pendingInput.command, argument,
    ...(pendingInput.operator === undefined ? {} : { operator: pendingInput.operator }),
    ...(pendingInput.operatorCount === undefined ? {} : { operatorCount: pendingInput.operatorCount }),
    ...(pendingInput.motionCount === undefined ? {} : { motionCount: pendingInput.motionCount }),
    count: pendingInput.count ?? oneCount(),
    ...(pendingInput.register === undefined ? {} : { register: pendingInput.register }),
    selections: state.session.selections, atMilliseconds,
  });
}

function parseRootLiteralCommand(key: string): VimLiteralCommand | undefined {
  switch (key) {
    case 'f': return 'find-forward';
    case 'F': return 'find-backward';
    case 't': return 'till-forward';
    case 'T': return 'till-backward';
    case 'r': return 'replace-character';
    case 'gr': return 'virtual-replace';
    case 'm': return 'set-mark';
    case '`': return 'jump-mark';
    case '\'': return 'jump-mark-line';
    case 'q': return 'record-macro';
    case '@': return 'play-macro';
    default: return undefined;
  }
}

function literalCommand(key: string): VimLiteralCommand | undefined { return parseRootLiteralCommand(key); }

function directOperator(key: string): VimOperatorPrefix | undefined {
  switch (key) {
    case 'd': return freezeOperatorPrefix({ name: 'delete', key, repeatKey: key });
    case 'c': return freezeOperatorPrefix({ name: 'change', key, repeatKey: key });
    case 'y': return freezeOperatorPrefix({ name: 'yank', key, repeatKey: key });
    case '>': return freezeOperatorPrefix({ name: 'indent-right', key, repeatKey: key });
    case '<': return freezeOperatorPrefix({ name: 'indent-left', key, repeatKey: key });
    case '=': return freezeOperatorPrefix({ name: 'indent-equal', key, repeatKey: key });
    case '!': return freezeOperatorPrefix({ name: 'filter', key, repeatKey: key });
    default: return undefined;
  }
}

function gOperatorPrefix(key: string): VimOperatorPrefix | undefined {
  switch (key) {
    case 'q': return freezeOperatorPrefix({ name: 'format', key: 'gq', repeatKey: 'q' });
    case 'w': return freezeOperatorPrefix({ name: 'format-preserve', key: 'gw', repeatKey: 'w' });
    case 'u': return freezeOperatorPrefix({ name: 'lowercase', key: 'gu', repeatKey: 'u' });
    case 'U': return freezeOperatorPrefix({ name: 'uppercase', key: 'gU', repeatKey: 'U' });
    case '~': return freezeOperatorPrefix({ name: 'swapcase', key: 'g~', repeatKey: '~' });
    case '?': return freezeOperatorPrefix({ name: 'rot13', key: 'g?', repeatKey: '?' });
    case '@': return freezeOperatorPrefix({ name: 'user', key: 'g@', repeatKey: '@' });
    default: return undefined;
  }
}

function modeKeyIntent(mode: VimMode, key: string): VimMode | undefined {
  if (mode === 'normal') {
    if (key === 'i' || key === 'I' || key === 'a' || key === 'A' || key === 'o' || key === 'O') return 'insert';
    if (key === 'R') return 'replace';
    if (key === 'v') return 'visual-character';
    if (key === 'V') return 'visual-line';
    if (key === '<C-v>') return 'visual-block';
    return undefined;
  }
  if (isSelectMode(mode)) {
    if (key === '<C-g>') return visualModeForSelect(mode);
    return undefined;
  }
  if (isVisualMode(mode)) {
    if (key === '<C-g>') return selectModeForVisual(mode);
    if (key === 'v') return mode === 'visual-character' ? 'normal' : 'visual-character';
    if (key === 'V') return mode === 'visual-line' ? 'normal' : 'visual-line';
    if (key === '<C-v>') return mode === 'visual-block' ? 'normal' : 'visual-block';
  }
  return undefined;
}

function isRecognizedSingleKey(key: string, mode: VimMode): boolean {
  if (MOTION_KEYS.includes(key)) return true;
  if (key === '<CR>' || key === '<Space>' || key === '<Tab>' || key === '<BS>' || key === '<Del>') return true;
  if (key === 'x' || key === 'X' || key === 's' || key === 'S' || key === 'D' || key === 'C'
    || key === '~' || key === 'J' || key === 'g' || key === 'G' || key === 'H' || key === 'M' || key === 'L'
    || key === 'p' || key === 'P' || key === 'gp' || key === 'gP' || key === '.' || key === 'u'
    || key === 'U' || key === '<C-r>' || key === '<C-o>' || key === '<C-i>' || key === '<C-g>'
    || key === '<C-a>' || key === '<C-x>' || key === '<C-e>' || key === '<C-y>' || key === '<C-d>'
    || key === '<C-u>' || key === '<C-f>' || key === '<C-b>' || key === '<C-]>' || key === '<C-t>'
    || key === '<C-^>' || key === '<C-w>' || key === '<C-c>' || key === '<C-v>' || key === 'K' || key === '"') return true;
  return mode.startsWith('visual-') && (key === 'o' || key === 'O' || key === 'd' || key === 'c' || key === 'y');
}

function isMotionKey(key: string): boolean {
  if (MOTION_KEYS.includes(key)) return true;
  return ['gg', 'g_', 'g$', 'g0', 'g^', 'gm', 'gM', 'gj', 'gk', 'ge', 'gE', 'g;', 'g,', 'g*', 'g#', 'g?', 'g%', 'gJ', 'gI', 'gD', 'go'].includes(key);
}

function modeSelectionKind(mode: VimMode): SelectionKind {
  switch (mode) {
    case 'normal': return 'normal-cursor';
    case 'insert':
    case 'replace':
    case 'virtual-replace': return 'insert-caret';
    case 'visual-character': return 'visual-character';
    case 'visual-line': return 'visual-line';
    case 'visual-block': return 'visual-block';
    case 'select-character': return 'visual-character';
    case 'select-line': return 'visual-line';
    case 'select-block': return 'visual-block';
  }
}

function selectModeForKey(key: string): VimMode | undefined {
  if (key === 'h') return 'select-character';
  if (key === 'H') return 'select-line';
  if (key === '<C-h>') return 'select-block';
  return undefined;
}

function selectModeForVisual(mode: 'visual-character' | 'visual-line' | 'visual-block'): VimMode {
  switch (mode) {
    case 'visual-character': return 'select-character';
    case 'visual-line': return 'select-line';
    case 'visual-block': return 'select-block';
  }
}

function visualModeForSelect(mode: 'select-character' | 'select-line' | 'select-block'): VimMode {
  switch (mode) {
    case 'select-character': return 'visual-character';
    case 'select-line': return 'visual-line';
    case 'select-block': return 'visual-block';
  }
}

function isSelectMode(mode: VimMode): mode is 'select-character' | 'select-line' | 'select-block' {
  return mode === 'select-character' || mode === 'select-line' || mode === 'select-block';
}

function isVisualMode(mode: VimMode): mode is 'visual-character' | 'visual-line' | 'visual-block' {
  return mode === 'visual-character' || mode === 'visual-line' || mode === 'visual-block';
}

function selectionKindForMode(mode: VimMode): SelectionKind { return modeSelectionKind(mode); }

function keyToken(input: Extract<NormalizedVimInput, { readonly kind: 'key' }>): string {
  let key = canonicalKeyName(input.key);
  // A named key is already bracketed ('<Left>'); a modifier wraps its bare name, not the
  // brackets, so Ctrl+Left is '<C-Left>' rather than '<C-<Left>>'.
  const bare = key.length > 2 && key.startsWith('<') && key.endsWith('>') ? key.slice(1, -1) : key;
  if (input.modifiers.ctrl) {
    if (key === '[') return '<Esc>';
    return `<C-${bare.length === 1 ? bare.toLowerCase() : bare}>`;
  }
  if (input.modifiers.alt || input.modifiers.meta) return `<M-${bare}>`;
  if (input.modifiers.shift && key.length === 1 && key >= 'a' && key <= 'z') key = key.toUpperCase();
  return key;
}

function canonicalKeyName(key: string): string {
  switch (key) {
    case 'Escape':
    case 'Esc':
    case 'ESC': return '<Esc>';
    case 'Enter':
    case 'Return': return '<CR>';
    case 'Space': return '<Space>';
    case ' ': return '<Space>';
    case 'Tab': return '<Tab>';
    case 'Backspace': return '<BS>';
    case 'Delete': return '<Del>';
    case 'ArrowLeft':
    case 'Left': return '<Left>';
    case 'ArrowRight':
    case 'Right': return '<Right>';
    case 'ArrowUp':
    case 'Up': return '<Up>';
    case 'ArrowDown':
    case 'Down': return '<Down>';
    case 'Home': return '<Home>';
    case 'End': return '<End>';
    case 'PageUp': return '<PageUp>';
    case 'PageDown': return '<PageDown>';
    default: return key;
  }
}

function prefixName(key: string): VimGrammarPrefix {
  switch (key) {
    case 'g': return 'g';
    case 'z': return 'z';
    case '<C-w>': return 'ctrl-w';
    case '<C-\\>': return 'ctrl-backslash';
    case '[': return 'left-bracket';
    case ']': return 'right-bracket';
    case 'Z': return 'Z';
    default: throw new Error(`unsupported-grammar-prefix:${key}`);
  }
}

function pending(state: VimParserState, value: VimPendingInput): VimParseOutcome {
  const next = makeState(state.session, value);
  return { kind: 'pending', state: next, continuations: next.legalContinuations };
}

function command(state: VimParserState, pendingInput: VimPendingInput, value: VimCommandIntent): VimParseOutcome {
  return { kind: 'command', state: makeState(state.session, pendingInput), command: freezeCommand(value) };
}

function fail(state: VimParserState, failure: VimParseFailure): VimParseOutcome {
  return { kind: 'failed', state: makeState(state.session, NONE), failure };
}

function operatorMotion(
  state: VimParserState,
  atMilliseconds: number,
  pendingInput: Extract<VimPendingInput, { readonly kind: 'operator-motion' }>,
  motion: string,
): VimParseOutcome {
  return command(state, NONE, {
    kind: 'operator-motion', operator: pendingInput.operator, motion,
    operatorCount: pendingInput.operatorCount, motionCount: pendingInput.motionCount ?? oneCount(),
    ...(pendingInput.register === undefined ? {} : { register: pendingInput.register }),
    ...(pendingInput.force === undefined ? {} : { force: pendingInput.force }),
    selections: state.session.selections, atMilliseconds,
  });
}

function operatorTextObject(
  state: VimParserState,
  atMilliseconds: number,
  prefix: Extract<VimPendingInput, { readonly kind: 'command-prefix' }>,
  key: string,
): VimParseOutcome {
  if (prefix.operator === undefined) return fail(state, { kind: 'invalid-continuation', key, pendingKind: prefix.kind });
  return command(state, NONE, {
    kind: 'operator-text-object', operator: prefix.operator, textObject: `${prefix.prefix === 'text-object-inner' ? 'i' : 'a'}${key}`,
    operatorCount: prefix.operatorCount ?? oneCount(), motionCount: prefix.motionCount ?? oneCount(),
    ...(prefix.register === undefined ? {} : { register: prefix.register }),
    selections: state.session.selections, atMilliseconds,
  });
}

function prefixed(
  state: VimParserState,
  atMilliseconds: number,
  prefix: Extract<VimPendingInput, { readonly kind: 'command-prefix' }>,
  key: string,
): VimParseOutcome {
  if (prefix.operator !== undefined) return command(state, NONE, {
    kind: 'operator-motion', operator: prefix.operator, motion: `${prefix.prefix === 'ctrl-w' ? '<C-w>' : prefix.prefix === 'ctrl-backslash' ? '<C-\\>' : prefix.prefix === 'left-bracket' ? '[' : prefix.prefix === 'right-bracket' ? ']' : prefix.prefix}${key}`,
    operatorCount: prefix.operatorCount ?? oneCount(), motionCount: prefix.motionCount ?? prefix.count ?? oneCount(),
    ...(prefix.register === undefined ? {} : { register: prefix.register }),
    selections: state.session.selections, atMilliseconds,
  });
  return command(state, NONE, {
    kind: 'prefixed-key', prefix: prefix.prefix, key,
    count: prefix.count ?? oneCount(),
    ...(prefix.register === undefined ? {} : { register: prefix.register }),
    selections: state.session.selections, atMilliseconds,
  });
}

function makeState(session: VimParserSession, pendingInput: VimPendingInput): VimParserState {
  const frozenPending = freezePending(pendingInput);
  return Object.freeze({
    session: Object.freeze({ mode: session.mode, selections: session.selections }),
    pending: frozenPending,
    legalContinuations: continuationsFor(frozenPending),
  });
}

const ESCAPE_CONTINUATION: VimContinuation = Object.freeze({ kind: 'escape', label: 'Cancel pending input' });

// continuationsFor runs on every pending keystroke (T013-PERF budget). Its
// output only depends on a handful of discrete pendingInput shapes, so each
// shape's continuation list is built once and cached rather than re-cloning
// already-frozen constant key arrays on every call.
const COUNT_CONTINUATIONS = freezeContinuations([
  { kind: 'count-digits', keys: DIGITS, label: 'Continue count' },
  { kind: 'keys', keys: ['command keys', 'operators', 'g', 'z'], label: 'Continue command' },
  ESCAPE_CONTINUATION,
]);
const REGISTER_NAME_CONTINUATIONS = freezeContinuations([
  { kind: 'register-name', characters: REGISTER_NAMES, label: 'Choose register' }, ESCAPE_CONTINUATION,
]);
const LITERAL_ARGUMENT_CONTINUATIONS = freezeContinuations([
  { kind: 'literal-character', label: 'Type one literal character' }, ESCAPE_CONTINUATION,
]);
const operatorMotionContinuationCache = new Map<string, readonly VimContinuation[]>();
const commandPrefixContinuationCache = new Map<string, readonly VimContinuation[]>();

function continuationsFor(pendingInput: VimPendingInput): readonly VimContinuation[] {
  switch (pendingInput.kind) {
    case 'none': return noContinuations;
    case 'count':
    case 'register-command': return COUNT_CONTINUATIONS;
    case 'register-name': return REGISTER_NAME_CONTINUATIONS;
    case 'operator-motion': {
      const cacheKey = `${pendingInput.operator.repeatKey}:${pendingInput.force ?? ''}`;
      const cached = operatorMotionContinuationCache.get(cacheKey);
      if (cached !== undefined) return cached;
      const built = freezeContinuations([
        { kind: 'count-digits', keys: DIGITS, label: 'Set motion count' },
        { kind: 'motions', keys: MOTION_KEYS, label: 'Choose motion' },
        { kind: 'keys', keys: pendingInput.force === undefined ? [pendingInput.operator.repeatKey, 'g', 'z', 'i', 'a', 'v', 'V', '<C-v>'] : [pendingInput.operator.repeatKey, 'g', 'z'], label: pendingInput.force === undefined ? 'Linewise, prefixed, text-object, or forced-wise form' : 'Forced-wise motion' },
        ESCAPE_CONTINUATION,
      ]);
      operatorMotionContinuationCache.set(cacheKey, built);
      return built;
    }
    case 'command-prefix': {
      const cacheKey = `${pendingInput.prefix}:${pendingInput.operator === undefined ? '0' : '1'}`;
      const cached = commandPrefixContinuationCache.get(cacheKey);
      if (cached !== undefined) return cached;
      const keys = pendingInput.prefix === 'g' ? G_KEYS
        : pendingInput.prefix === 'z' ? Z_KEYS
          : pendingInput.prefix === 'ctrl-w' ? CTRL_W_KEYS
            : pendingInput.prefix === 'ctrl-w-g' ? CTRL_W_G_KEYS
            : pendingInput.prefix === 'ctrl-backslash' ? ['<C-n>', '<C-g>']
              : pendingInput.prefix === 'Z' ? ['Z', 'Q']
              : pendingInput.prefix === 'left-bracket' || pendingInput.prefix === 'right-bracket' ? BRACKET_HOST_KEYS
                : TEXT_OBJECT_KEYS;
      const built = freezeContinuations([
        { kind: 'keys', keys, label: pendingInput.operator === undefined ? `Continue ${pendingInput.prefix} command` : 'Continue operator motion' },
        ESCAPE_CONTINUATION,
      ]);
      commandPrefixContinuationCache.set(cacheKey, built);
      return built;
    }
    case 'literal-argument': return LITERAL_ARGUMENT_CONTINUATIONS;
  }
}

function freezeContinuations(items: readonly VimContinuation[]): readonly VimContinuation[] {
  return Object.freeze(items.map((item): VimContinuation => {
    switch (item.kind) {
      case 'keys':
      case 'motions':
      case 'count-digits': return Object.freeze({ ...item, keys: Object.freeze([...item.keys]) });
      case 'register-name': return Object.freeze({ ...item, characters: Object.freeze([...item.characters]) });
      case 'literal-character':
      case 'escape': return Object.freeze({ ...item });
    }
  }));
}

function freezePending(value: VimPendingInput): VimPendingInput {
  switch (value.kind) {
    case 'none': return NONE;
    case 'count': return Object.freeze({ kind: 'count', count: freezeCount(value.count) });
    case 'register-name': return Object.freeze({ kind: 'register-name', count: freezeOptionalCount(value.count) });
    case 'register-command': return Object.freeze({
      kind: 'register-command', register: value.register,
      precount: freezeOptionalCount(value.precount), postCount: freezeOptionalCount(value.postCount),
    });
    case 'operator-motion': return Object.freeze({
      kind: 'operator-motion', operator: freezeOperatorPrefix(value.operator),
      operatorCount: freezeCount(value.operatorCount), motionCount: freezeOptionalCount(value.motionCount),
      register: value.register, force: value.force,
    });
    case 'command-prefix': return Object.freeze({
      kind: 'command-prefix', prefix: value.prefix, count: freezeOptionalCount(value.count),
      register: value.register, operator: freezeOptionalOperator(value.operator),
      operatorCount: freezeOptionalCount(value.operatorCount), motionCount: freezeOptionalCount(value.motionCount),
    });
    case 'literal-argument': return Object.freeze({
      kind: 'literal-argument', command: value.command, count: freezeOptionalCount(value.count),
      register: value.register, operator: freezeOptionalOperator(value.operator),
      operatorCount: freezeOptionalCount(value.operatorCount), motionCount: freezeOptionalCount(value.motionCount),
    });
  }
}

function freezeCommand(value: VimCommandIntent): VimCommandIntent {
  switch (value.kind) {
    case 'operator-motion':
    case 'operator-line':
    case 'operator-text-object': return Object.freeze({
      ...value, operator: freezeOperatorPrefix(value.operator),
      ...('operatorCount' in value ? { operatorCount: freezeCount(value.operatorCount) } : {}),
      ...('motionCount' in value ? { motionCount: freezeCount(value.motionCount) } : {}),
      ...('count' in value ? { count: freezeCount(value.count) } : {}),
    });
    case 'literal-command': return Object.freeze({
      ...value,
      ...(value.operator === undefined ? {} : { operator: freezeOperatorPrefix(value.operator) }),
      ...(value.operatorCount === undefined ? {} : { operatorCount: freezeCount(value.operatorCount) }),
      ...(value.motionCount === undefined ? {} : { motionCount: freezeCount(value.motionCount) }),
      count: freezeCount(value.count),
    });
    case 'single-key':
    case 'mode-transition':
    case 'prefixed-key': return Object.freeze({ ...value, count: freezeCount(value.count) });
    case 'insert-key': return Object.freeze({ ...value, modifiers: Object.freeze({ ...value.modifiers }) });
    case 'select-key': return Object.freeze({ ...value, modifiers: Object.freeze({ ...value.modifiers }) });
    case 'paste': return Object.freeze({ ...value, bytes: new Uint8Array(value.bytes) });
    case 'leave-mode':
    case 'begin-command-line':
    case 'begin-search': return Object.freeze({ ...value });
  }
}

function freezeCount(value: VimCount): VimCount {
  return Object.freeze({ value: value.value, saturated: value.saturated, explicit: value.explicit });
}

function freezeOptionalCount(value: VimCount | undefined): VimCount | undefined {
  return value === undefined ? undefined : freezeCount(value);
}

function freezeOperatorPrefix(value: VimOperatorPrefix): VimOperatorPrefix {
  return Object.freeze({ name: value.name, key: value.key, repeatKey: value.repeatKey });
}

function freezeOptionalOperator(value: VimOperatorPrefix | undefined): VimOperatorPrefix | undefined {
  return value === undefined ? undefined : freezeOperatorPrefix(value);
}

function context(count: VimCount | undefined, register: string): CommandContext {
  return count === undefined ? { register } : { count, register };
}

function oneCount(): VimCount { return Object.freeze({ value: 1, saturated: false, explicit: false }); }

function appendCount(previous: VimCount | undefined, digit: string): VimCount {
  const base = previous?.value ?? 0;
  const value = Number(digit);
  if (previous?.saturated === true || base > Math.floor((MAX_SAFE_COUNT - value) / 10)) {
    return Object.freeze({ value: MAX_SAFE_COUNT, saturated: true, explicit: true });
  }
  return Object.freeze({ value: base * 10 + value, saturated: false, explicit: true });
}

function mergeRegisterCounts(precount: VimCount | undefined, postCount: VimCount | undefined): VimCount | undefined {
  if (precount === undefined && postCount === undefined) return undefined;
  return multiplyCounts(precount ?? oneCount(), postCount ?? oneCount());
}

function multiplyCounts(left: VimCount, right: VimCount): VimCount {
  const explicit = left.explicit || right.explicit;
  if (left.saturated || right.saturated || left.value > MAX_SAFE_COUNT / right.value) return Object.freeze({ value: MAX_SAFE_COUNT, saturated: true, explicit });
  return Object.freeze({ value: left.value * right.value, saturated: false, explicit });
}

function isDigit(value: string): boolean { return value.length === 1 && value >= '0' && value <= '9'; }
function isRegisterName(value: string): boolean { return value.length === 1 && REGISTER_NAMES.includes(value); }
function isSingleLiteral(value: string): boolean { return value.length > 0 && Array.from(value).length === 1 && !value.startsWith('<'); }

function isFindLiteral(commandKind: VimLiteralCommand): boolean {
  return commandKind === 'find-forward' || commandKind === 'find-backward'
    || commandKind === 'till-forward' || commandKind === 'till-backward';
}

// nvim (d`a, y'a): mark jumps take a literal mark-register argument and are
// valid operator motions, just like f/F/t/T.
function isOperatorMotionLiteral(commandKind: VimLiteralCommand): boolean {
  return isFindLiteral(commandKind) || commandKind === 'jump-mark' || commandKind === 'jump-mark-line';
}

function literalKey(commandKind: VimLiteralCommand): string {
  switch (commandKind) {
    case 'find-forward': return 'f';
    case 'find-backward': return 'F';
    case 'till-forward': return 't';
    case 'till-backward': return 'T';
    case 'replace-character': return 'r';
    case 'virtual-replace': return 'gr';
    case 'set-mark': return 'm';
    case 'jump-mark': return '`';
    case 'jump-mark-line': return '\'';
    case 'record-macro': return 'q';
    case 'play-macro': return '@';
  }
}
