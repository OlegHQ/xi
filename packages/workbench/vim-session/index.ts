import { asCellColumn, asLineIndex, asUtf16Offset, CancellationSource, type InputModifiers, type UndoGroupId, type ViewId, type Utf16Offset } from '../../contracts/src/index';
import type { CanonicalInputEvent } from '../../contracts/src/index';
import type { DocumentEdit, DocumentReadPort, DocumentSnapshot, TextFileDocument } from '../../document/src/index';
import { createDocumentAnchor, DocumentChangeMap } from '../../document/src/index';
import { mapSelectionSet, updateSelectionSet, type SelectionSetSnapshot, type SelectionMemberInput } from '../../selections/src/index';
import {
  createVimMotionGhost,
  convertVimVisualSelection,
  exchangeVimVisualEndpoints,
  exchangeVimVisualBlockColumns,
  type VimMotionGhost,
  beginVimMultiInsert,
  normalizeVimInput,
  parseVimInput,
  prepareVimDirectChange,
  planVimMultiInsertInput,
  parseVimExSequence,
  resolveVimMotion,
  prepareVimEx,
  prepareVimMultiOperator,
  prepareVimOperator,
  beginVimVisualSelection,
  extendVimVisualSelection,
  applyVimSelectionCommand,
  resolveVimMultiVisualFind,
  resolveVimMultiVisualMotion,
  resolveVimMultiVisualTextObject,
  resolveVimCharacterInfo,
  resolveVimFind,
  prepareVimPutFromBank,
  type VimMode,
  type VimCoreOperator,
  type VimOperatorPreparation,
  type VimLastFind,
  type VimVisualKind,
  type VimVisualCursor,
  type VimCommandIntent,
  type VimInsertEntryKey,
  type VimMultiInsertPlan,
  type VimMultiInsertSession,
  type VimParserState,
  type VimTextObjectKey,
  type VimWordMotionKey,
  type VimSelectionCommand,
} from '../../vim/src/entrypoints/launch';
import type { WorkbenchReadPort, WorkbenchViewSnapshot } from '../src/read-model';
import type { VimHostCommand, VimInsertOptions } from '../../vim/src/index';
import { searchVimBufferInteractive } from '../../vim/src/index';
import {
  createVimMotionCursor,
  createVimInsertRepeatTarget,
  createVimOperatorRepeatTarget,
  createVimRepeatState,
  recordVimRepeatTarget,
  replayVimDot,
  resolveVimMultiMotion,
  resolveVimStructuralMotion,
  EMPTY_VIM_SEARCH_STATE,
  literalPattern,
  normalizeVimOperatorRange,
  searchVimBuffer,
  type VimRepeatState,
  type VimSearchCommand,
  type VimSearchDirection,
  type VimSearchMatch,
  type VimSearchOffset,
  type VimSearchState,
  type VimStructuralMotionKey,
} from '../../vim/src/index';
import {
  beginVimMacroRecording,
  commitVimMacroRecording,
  createVimMacroStore,
  executeVimMacro,
  recordVimMacroKey,
  isRegisterName,
  type VimMacroRecordingSession,
  type VimMacroRegisterName,
  type VimMacroStore,
  type VimRegisterValue,
} from '../../vim/src/index';
import type { PointerCell, PointerSelectionIntent } from '../../vim/src/entrypoints/launch';
import type { PrefixHelpParserContinuation } from '../commands/prefix-help';
import { createVimRegisterBank, type VimRegisterBank, type VimRegisterName, type VimRegisterType } from '../../vim/src/entrypoints/launch';
import type { OwnedVimKeyEvent, OwnedVimSessionOptions, OwnedVimSession, VimPrefixHelpState, VimCommandLineState, VimSearchHighlightState } from './types';
export type { OwnedVimKeyEvent, OwnedVimSessionOptions, OwnedVimSession, VimPrefixHelpState, VimCommandLineState, VimSearchHighlightState } from './types';
import { hostTarget, hostWindowAction, isHostTokenCharacter } from './host-commands';
import { parseXiSelectionCommand, selectionModeFor, SELECTION_COMMANDS, PATTERN_SELECTION_COMMANDS, SELECTION_HISTORY_LIMIT, type XiSelectionCommandInput } from './selection-commands';
import { addPointerCaret, pointerVisualCursor, pointerWordRange } from './pointer';
import { commitPlan, makeInsertSelections, mapExternalInsertSession, INSERT_GROUP } from './insert-plan';
import {
  applyRegisterEffect as applyRegisterEffectToBank,
  buildParser,
  coreOperator,
  id,
  isDirectChangeKey,
  isInsertEntryKey,
  isInsertMode,
  isMotionLike,
  isVisualMode,
  keyName,
  makeMotionCursor,
  makeNormalSelection,
  makeSelection,
  makeView,
  motionInvocation,
  nonEmptyTuple,
  notifyCommitted,
  offset,
  selectionOffset,
} from './helpers';

const DIRECT_GROUP = id<UndoGroupId>('xi-workbench-direct');
const EX_GROUP = id<UndoGroupId>('xi-workbench-ex');
const OPERATOR_GROUP = id<UndoGroupId>('xi-workbench-operator');
const EMPTY_PREFIX_KEYS: readonly string[] = Object.freeze([]);
// normalizeVimInput's `key`-kind output (packages/vim/input/index.ts) never carries
// rawBytes through -- only `atMilliseconds` and a copied `modifiers` object survive into
// NormalizedVimInput -- so encoding real terminal bytes into `CanonicalInputEvent.rawBytes`
// on every keystroke is pure waste on the ordinary key path; the contract still requires a
// Uint8Array, so a shared empty sentinel satisfies it without allocating.
const EMPTY_RAW_BYTES: Uint8Array = new Uint8Array(0);
// One shared monotonic clock object instead of a fresh `{ monotonicMilliseconds: () => ... }`
// closure allocation per key.
const MONOTONIC_CLOCK: { readonly monotonicMilliseconds: () => number } = Object.freeze({ monotonicMilliseconds: () => performance.now() });
// All 16 shift/alt/ctrl/meta combinations, interned once instead of freezing a fresh
// modifiers object on every keystroke.
const MODIFIER_COMBOS: readonly InputModifiers[] = Object.freeze(
  Array.from({ length: 16 }, (_, mask) => Object.freeze({
    shift: (mask & 1) !== 0,
    alt: (mask & 2) !== 0,
    ctrl: (mask & 4) !== 0,
    meta: (mask & 8) !== 0,
  })),
);
function internModifiers(shift: boolean, alt: boolean, ctrl: boolean, meta: boolean): InputModifiers {
  const mask = (shift ? 1 : 0) | (alt ? 2 : 0) | (ctrl ? 4 : 0) | (meta ? 8 : 0);
  return MODIFIER_COMBOS[mask] as InputModifiers;
}

/** Split a typed `/`/`?` command-line body at its own (possibly backslash-escaped)
 * delimiter into the pattern and the trailing search-offset text, matching nvim's
 * `/{pattern}/{offset}` grammar. The pattern keeps any backslash escapes verbatim (the
 * pattern compiler owns interpreting `\/`), mirroring how `:s{delim}...{delim}` is split
 * elsewhere in this engine (packages/vim/search/index.ts's own readDelimited). */
function splitSearchCommandLine(source: string, delimiter: '/' | '?'): { readonly pattern: string; readonly offsetText: string | undefined } {
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') { index += 2; continue; }
    if (character === delimiter) break;
    index += 1;
  }
  if (index >= source.length) return { pattern: source, offsetText: undefined };
  return { pattern: source.slice(0, index), offsetText: source.slice(index + 1) };
}

function visualCursorAt(snapshot: DocumentSnapshot, at: Utf16Offset): VimVisualCursor | undefined {
  const cursor = createVimMotionCursor(snapshot, at);
  if (!cursor.ok) return undefined;
  return { documentVersion: snapshot.version, offset: at, displayCellColumn: cursor.value.desiredDisplayCellColumn ?? 0 as VimVisualCursor['displayCellColumn'] };
}

/** Parse nvim's `search-offset` suffix: the `e[+-N]`/`s[+-N]`/`b[+-N]` character forms
 * (end-of-match / start-of-match) plus the bare line-count form (`[+-]N`, or a lone `+`/`-`
 * for 1) that puts the cursor N lines below/above the match's line, in column 1, and makes
 * an operator motion using it linewise (`:help search-offset`). An empty suffix (`/pat/`)
 * means no offset at all, same as `/pat` with no trailing delimiter. */
function parseSearchOffsetSuffix(text: string): VimSearchOffset | undefined {
  if (text.length === 0) return undefined;
  const kindChar = text[0];
  if (kindChar === 'e' || kindChar === 's' || kindChar === 'b') {
    const rest = text.slice(1);
    const amount = rest.length === 0 ? 0 : Number.parseInt(rest, 10);
    if (!Number.isSafeInteger(amount)) return undefined;
    return { kind: kindChar === 'e' ? 'end' : 'start', amount };
  }
  if (kindChar === '+' || kindChar === '-' || (kindChar !== undefined && kindChar >= '0' && kindChar <= '9')) {
    const rest = kindChar === '+' || kindChar === '-' ? text.slice(1) : text;
    const magnitude = rest.length === 0 ? 1 : Number.parseInt(rest, 10);
    if (!Number.isSafeInteger(magnitude)) return undefined;
    const amount = kindChar === '-' ? -magnitude : magnitude;
    return { kind: 'line', amount };
  }
  return undefined;
}

/** Literal text a register contributes to `<C-r>` in Insert mode: a linewise
 * register carries its trailing newline (`:help i_CTRL-R`), everything else
 * inserts exactly its stored text. */
function registerValueText(value: VimRegisterValue): string {
  if (value.lines.length === 0) return '';
  const joined = value.lines.join('\n');
  return value.type === 'linewise' ? `${joined}\n` : joined;
}

export function createOwnedVimSession(document: TextFileDocument, options: OwnedVimSessionOptions): OwnedVimSession {
  const documentId = document.id;
  const viewId = options.viewId;
  const defaultYankRegister = options.defaultYankRegister ?? '"';
  const mouseYankRegister = options.mouseYankRegister ?? '*';
  const clock: { readonly monotonicMilliseconds: () => number } = options.clock ?? MONOTONIC_CLOCK;
  // H/M/L need the host's visible-line range; snapshot.lineCount is read fresh each call
  // since the fallback (whole document) must track edits.
  function viewportMotionOptions(): { readonly viewport: { readonly topLine: number; readonly bottomLine: number } } {
    const port = options.viewport;
    if (port === undefined) return { viewport: { topLine: 0, bottomLine: document.snapshot().lineCount - 1 } };
    return { viewport: { topLine: port.topLine(), bottomLine: port.bottomLine() } };
  }
  const snapshot = document.snapshot();
  let mode: VimMode = options.initialMode ?? 'normal';
  let selections = options.initialSelections ?? makeSelection(snapshot, options.initialLine);
  let parser = buildParser(mode, selections);
  // Reuses the current parser state when neither mode nor the selection set
  // reference changed (a no-op key, e.g. a boundary motion or repeated
  // Escape) instead of rebuilding it every key. `parser` is this session's
  // own closure variable, so this cannot leak across concurrent sessions.
  function makeParser(nextMode: VimMode, nextSelections: SelectionSetSnapshot): VimParserState {
    if (parser.pending.kind === 'none' && parser.session.mode === nextMode && parser.session.selections === nextSelections) return parser;
    return buildParser(nextMode, nextSelections);
  }
  let insert: VimMultiInsertSession | null = null;
  let motionCursor = makeMotionCursor(document.snapshot(), selections);
  let undoOpen = false;
  let registers: VimRegisterBank = createVimRegisterBank();
  function applyRegisterEffect(bank: VimRegisterBank, effect: { readonly operation: string; readonly destination: string; readonly lines: readonly string[]; readonly type: string }): VimRegisterBank {
    const next = applyRegisterEffectToBank(bank, effect);
    const clipboard = options.clipboard;
    if (next !== bank && clipboard !== undefined && (effect.destination === '+' || effect.destination === '*')) {
      const read = next.read(effect.destination as VimRegisterName);
      if (read.ok) {
        const cancellation = new CancellationSource();
        const text = registerValueText(read.value);
        const write = effect.destination === '*' ? clipboard.writePrimaryText?.(text, cancellation.token) : clipboard.writeText(text, cancellation.token);
        if (write !== undefined) void write.finally(() => cancellation.dispose());
        else cancellation.dispose();
      }
    }
    return next;
  }
  function yankPointerSelection(): void {
    const prepared = prepareVimMultiOperator({
      snapshot: document.snapshot(),
      selections,
      operator: 'yank',
      defaultYankRegister: mouseYankRegister,
      state: { mode: 'normal', repeatTarget: null },
      failurePolicy: 'retain-failed',
    });
    if (!prepared.ok) return;
    for (const effect of prepared.value.registerEffects) registers = applyRegisterEffect(registers, effect);
  }
  let lastFind: VimLastFind | null = null;
  let searchState: VimSearchState = EMPTY_VIM_SEARCH_STATE;
  // Every interactive search (n/N/*/#/g*/g#/`/`/`?`) runs through this generation
  // counter: starting a new one flips the previous call's abort signal so a stale,
  // still-resuming search (e.g. an adversarial pattern mid-slice) neither keeps
  // stealing event-loop slices nor overwrites searchState/selections once a newer
  // keystroke has already moved on.
  let searchGeneration = 0;
  let activeSearchAbort: { aborted: boolean } | undefined;
  /** Run a search through the bounded, yielding entry point and discard the result if a
   * newer search started (and thus aborted this one) while it was resuming. */
  async function runInteractiveVimSearch(
    snapshotAt: DocumentSnapshot,
    view: Parameters<typeof searchVimBufferInteractive>[1],
    request: Parameters<typeof searchVimBufferInteractive>[3],
  ): Promise<Awaited<ReturnType<typeof searchVimBufferInteractive>> | undefined> {
    if (activeSearchAbort !== undefined) activeSearchAbort.aborted = true;
    searchGeneration += 1;
    const generation = searchGeneration;
    const signal = { aborted: false };
    activeSearchAbort = signal;
    const result = await searchVimBufferInteractive(snapshotAt, view, searchState, request, signal);
    if (generation !== searchGeneration) return undefined;
    if (activeSearchAbort === signal) activeSearchAbort = undefined;
    return result;
  }
  // nvim: a search that wraps prints "search hit BOTTOM/TOP, continuing at ..."; one that
  // finds nothing prints "E486: Pattern not found: {pattern}" (or E35 with no prior pattern
  // at all). Shared by n/N/*/#/g*/g# and the `/`/`?` prompt below.
  function reportSearchOutcome(outcome: Extract<ReturnType<typeof searchVimBuffer>, { readonly ok: true }>['value']['outcome']): void {
    if (outcome.kind === 'found') {
      if (outcome.match.wrapped) {
        message(outcome.match.direction === 'forward' ? 'xi: search hit BOTTOM, continuing at TOP\n' : 'xi: search hit TOP, continuing at BOTTOM\n');
      }
      return;
    }
    const pattern = outcome.state.pattern;
    message(pattern !== null && pattern.length > 0 ? `xi: E486: Pattern not found: ${pattern}\n` : 'xi: E35: No previous regular expression\n');
  }
  async function runSearchCommand(command: VimSearchCommand, count: number): Promise<boolean> {
    const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
    const origin = isVisualMode(mode) ? primary === undefined ? undefined : selectionOffset(primary) : motionCursor?.offset;
    if (origin === undefined) return false;
    const view = { cursor: origin, desiredDisplayColumn: 0, scrollTop: 0, scrollLeft: 0 };
    const result = await runInteractiveVimSearch(document.snapshot(), view, { command, count });
    if (result === undefined) return false;
    if (!result.ok) return false;
    searchState = result.value.state;
    reportSearchOutcome(result.value.outcome);
    if (result.value.outcome.kind !== 'found') return false;
    if (isVisualMode(mode)) {
      const cursor = visualCursorAt(document.snapshot(), result.value.outcome.match.cursor);
      if (cursor === undefined) return false;
      const extended = extendVimVisualSelection(document.snapshot(), selections, selections.members.map((member) => ({ id: member.id, cursor })));
      if (!extended.ok) return false;
      selections = extended.value;
    } else {
      selections = makeNormalSelection(document.snapshot(), result.value.outcome.match.cursor, (selections.selectionGeneration as number) + 1, selections.primaryId);
      motionCursor = makeMotionCursor(document.snapshot(), selections);
    }
    parser = makeParser(mode, selections);
    return true;
  }
  let commandLine: string | undefined;
  let commandLineCursorOffset = 0;
  let commandLineKind: 'ex' | 'search-forward' | 'search-backward' = 'ex';
  // A count typed before `/`/`?` (e.g. `3/foo<CR>`), consumed once the search prompt submits.
  let pendingSearchCount = 1;
  // Set only for `d/foo<CR>`-style operator-pending search motions; consumed (and cleared)
  // by the same submit that consumes pendingSearchCount.
  let pendingOperatorSearch: { readonly operator: VimCoreOperator; readonly register: string | undefined } | undefined;
  let prefixKeys: readonly string[] = EMPTY_PREFIX_KEYS;
  // `prefixKeys` and `parser.legalContinuations` are already frozen at their
  // source (updatePrefixKeys / freezeContinuations), and both are replaced
  // by reference (never mutated in place) whenever their content actually
  // changes. Memoizing on that reference pair turns the common no-pending
  // key into a cache hit instead of reallocating on every keystroke.
  let prefixHelpCache: { readonly keys: readonly string[]; readonly continuations: VimPrefixHelpState['parserContinuations']; readonly value: VimPrefixHelpState } | undefined;
  // Same memo pattern as prefixHelpCache: commandLine/commandLineCursorOffset are
  // primitives, so readCommandLine() is memoized on their value pair and
  // publishAuxiliaryState only notifies listeners when that reference changed,
  // instead of re-freezing and re-notifying on every keystroke (most of which
  // don't touch the command line at all).
  let commandLineStateCache: { readonly source: string | undefined; readonly cursorOffset: number; readonly kind: VimCommandLineState['kind']; readonly value: VimCommandLineState | undefined } | undefined;
  let lastPublishedCommandLine: VimCommandLineState | undefined;
  function finishMotion(before: SelectionSetSnapshot, beforeMode: VimMode, key: string): void {
    if (options.motionGhost === true && beforeMode === 'normal' && mode === 'normal' && before !== selections) {
      motionGhost = createVimMotionGhost(document.snapshot(), before, selections, ghostMotionKey ?? key, ghostMotionCount);
      ghostTarget = motionGhost === undefined ? undefined : selections;
    }
  }
  let selectionHistory: SelectionSetSnapshot[] = [];
  let motionGhost: VimMotionGhost | undefined;
  let ghostMotionCount = 1;
  let ghostMotionKey: string | undefined;
  let ghostTarget: SelectionSetSnapshot | undefined;
  function clearMotionGhost(): void { motionGhost = undefined; ghostTarget = undefined; }
  function currentMotionGhost(): VimMotionGhost | undefined {
    return mode === 'normal' && selections === ghostTarget && motionGhost?.preview.documentVersion === document.snapshot().version ? motionGhost : undefined;
  }
  // Dot-repeat (T130): a single most-recent semantic target, matching T024's tested
  // model exactly (operator xor insert xor visual xor put; last completed one wins).
  // Only the delete/change-motion and plain-insert cases below are wired; visual-change
  // and put targets remain unwired. An operator that transitions into insert (e.g. 'ciw')
  // *is* replayed as one atomic "delete then insert" unit, but through a session-local
  // `changeRepeatTarget` alongside T024's own repeatState (its schema has no combined
  // variant) rather than by extending T024's already oracle-tested module itself.
  let repeatState: VimRepeatState = createVimRepeatState();
  let insertEntryKey: VimInsertEntryKey | undefined;
  let insertEntryCount = 1;
  let macroExBuffer: string[] | null = null;
  let insertTypedChars: string[] = [];
  let insertTainted = false;
  // <C-a> ("insert previously inserted text"): the literal chars typed in the last
  // completed Insert/Replace session, independent of and alongside dot-repeat's own
  // (stricter) engine-replay target below.
  let lastInsertedText = '';
  let pendingChangeOperatorMotion: { readonly motionKey: string; readonly linewise: boolean } | undefined;
  let changeRepeatTarget: { readonly motionKey: string; readonly text: string; readonly linewise: boolean } | undefined;
  let lastRepeatKind: 'engine' | 'change' = 'engine';
  // Macro record/playback (T130). Starting a recording is exposed through
  // beginMacroRecording (see the leader-key wiring in apps/xi/src/main.ts) rather than
  // through the parser's own 'q'+register literal-command, because bare 'q' in Normal mode
  // is already Xi's shipped quick-quit shortcut and that
  // extensively-relied-upon, already-shipped behavior is out of scope to remove here.
  // Stopping (bare 'q' while a recording is active) and playback (real '@'/'@@' keys) have
  // no such conflict and are wired to their natural Vim keys below.
  let macroStore: VimMacroStore = createVimMacroStore();
  let macroRecording: VimMacroRecordingSession | null = null;
  let lastMacroRegister: VimMacroRegisterName | undefined;
  let lastExCommand: string | undefined;
  const clipboardReads = new Set<CancellationSource>();
  let disposed = false;
  const readPort: DocumentReadPort = {
    snapshot: () => document.snapshot(),
    slice: (start, end, expectedVersion) => document.slice(start, end, expectedVersion),
  };

  function handleKey(event: OwnedVimKeyEvent): boolean | 'quit' | Promise<boolean | 'quit'> {
    if (disposed) return true;
    // Neovim `:help i_ALT` / `:help <M-`: an unmapped Alt/Meta chord is processed as <Esc>
    // followed by the plain key. Xi has no Vim-level <M-...> mappings (config bindings resolve
    // earlier in the input router), so every chord that reaches here splits. This also makes
    // an ESC byte that a stalled read coalesced with the next byte behave exactly like the two
    // keystrokes the user typed, instead of dropping both.
    if ((event.option || event.meta) && !event.ctrl && event.raw !== '\x1b') {
      const escape: OwnedVimKeyEvent = { name: 'Escape', raw: '\x1b', shift: false, option: false, ctrl: false, meta: false };
      const plain: OwnedVimKeyEvent = { ...event, option: false, meta: false };
      const first = handleKey(escape);
      if (first instanceof Promise) return first.then((result) => (result === 'quit' ? result : handleKey(plain)));
      return first === 'quit' ? first : handleKey(plain);
    }
    const key = keyName(event);
    const before = selections;
    const beforeMode = mode;
    ghostMotionCount = 1;
    ghostMotionKey = undefined;
    if (key !== 'v') clearMotionGhost();
    if (canHandleSynchronously(event, key)) {
      const result = handleSynchronousKey(event, key);
      finishMotion(before, beforeMode, key);
      options.onStateChange?.({ selections, mode });
      publishAuxiliaryState();
      return result;
    }
    return handleKeyInternal(event).then((result) => {
      finishMotion(before, beforeMode, key);
      options.onStateChange?.({ selections, mode });
      publishAuxiliaryState();
      return result;
    });
  }

  async function handleKeyInternal(event: OwnedVimKeyEvent): Promise<boolean | 'quit'> {
    const key = keyName(event);
    recordMacroKeyIfActive(key);
    if (commandLine !== undefined) {
      if (key === '<Esc>') {
        closeCommandLine();
        return true;
      }
      if (key === '<BS>') {
        // Backspacing an empty `/`/`?` prompt closes it (nvim leaves the command line the
        // same way Esc would); an empty `:` prompt keeps its own existing behavior.
        if (commandLine.length === 0 && commandLineKind !== 'ex') {
          closeCommandLine();
          return true;
        }
        commandLine = commandLine.slice(0, -1);
        commandLineCursorOffset = Math.max(1, commandLineCursorOffset - 1);
        return true;
      }
      if (key === '<CR>' || key === '<NL>') {
        return commandLineKind === 'ex' ? submitCommandLine(`:${commandLine}`) : submitSearchCommandLine();
      }
      if (!event.ctrl && !event.meta && !event.option) {
        const character = key === '<Space>' ? ' ' : key;
        if (character.length === 1) {
          commandLine += character;
          commandLineCursorOffset += character.length;
        }
      }
      return true;
    }
    // A ':' that completes a pending multi-key sequence (e.g. the register argument of
    // '@:'/'q:') feeds the parser below instead of opening a fresh command line.
    if (!isInsertMode(mode) && key === ':' && parser.pending.kind === 'none') {
      commandLine = '';
      commandLineCursorOffset = 1;
      prefixKeys = EMPTY_PREFIX_KEYS;
      return true;
    }
    if (event.ctrl && (key === 's' || key === 'S')) {
      // Saving and format-on-save run behind the input boundary. Waiting here
      // would turn disk/formatter latency into an editor freeze and would
      // queue later user edits behind an obsolete snapshot.
      if (options.onSave !== undefined) void options.onSave().catch(() => options.onMessage?.('xi: save failed\n'));
      return true;
    }
      // Bare 'q' while a macro is recording stops it (real Vim needs no register key to
      // stop). Otherwise 'q' is Xi's documented quick-quit shortcut (see the placeholder
      // buffer's own "Press q or Ctrl-C to quit" text), but it must carry the exact same
      // unsaved-changes refusal as ':q' rather than silently discarding a dirty buffer —
      // route it through the identical Ex-quit path instead of destroying the renderer
      // unconditionally.
    if (mode === 'normal' && key === 'q') {
      if (macroRecording !== null) {
        const committed = commitVimMacroRecording(macroStore, macroRecording);
        if (committed.ok) {
          macroStore = committed.value.store;
          lastMacroRegister = committed.value.recording.register;
        } else {
          message(`xi: macro recording ${committed.error.kind}\n`);
        }
        macroRecording = null;
        return true;
      }
      return submitCommandLine('q');
    }
    // Real Vim's Normal-mode Ctrl-C is an interrupt: it cancels a pending operator/count
    // prefix, it does not quit. The UI adapter no longer decides quit on unhandled keys
    // (see packages/ui/src/terminal.ts), so this must resolve the interrupt itself rather
    // than return false and rely on a caller-side fallback.
    if (mode === 'normal' && event.ctrl && (key === 'c' || key === 'C')) {
      parser = makeParser(mode, selections);
      prefixKeys = EMPTY_PREFIX_KEYS;
      options.onPrefixStateChange?.(readPrefixHelp());
      return true;
    }
      const input: CanonicalInputEvent = {
      kind: 'key',
      key,
      phase: 'press',
      modifiers: internModifiers(event.shift, event.option, event.ctrl, event.meta),
      rawBytes: EMPTY_RAW_BYTES,
      };
      const normalized = normalizeVimInput(input, clock);
      if (!normalized.ok) return true;
    const outcome = parseVimInput(parser, normalized.value);
    parser = outcome.state;
    updatePrefixKeys(key, outcome.kind, event.ctrl);
    if (outcome.kind !== 'command') return true;
      const pending = executeCommand(outcome.command);
      if (pending !== undefined) await pending;
      return true;
  }

  // n/N/*/#, Visual */#, and g*/g# all resolve through runInteractiveVimSearch (a search
  // can take multiple yielding slices), so they cannot run on the fully synchronous key
  // path -- routing them through handleKeyInternal instead lets it await the result.
  function isSearchTriggerKey(key: string): boolean {
    return key === 'n' || key === 'N' || key === '*' || key === '#';
  }
  function canHandleSynchronously(event: OwnedVimKeyEvent, key: string): boolean {
    return commandLine === undefined
      && !(!isInsertMode(mode) && key === ':' && parser.pending.kind === 'none')
      && !(event.ctrl && (key === 's' || key === 'S'))
      && !(mode === 'normal' && key === 'q')
      && !(mode === 'normal' && event.ctrl && (key === 'c' || key === 'C'))
      && !((mode === 'normal' || isVisualMode(mode)) && isSearchTriggerKey(key))
      && !(parser.pending.kind === 'command-prefix' && parser.pending.prefix === 'g' && (key === '*' || key === '#'));
  }

  function handleSynchronousKey(event: OwnedVimKeyEvent, key: string): boolean {
    recordMacroKeyIfActive(key);
    const input: CanonicalInputEvent = {
      kind: 'key',
      key,
      phase: 'press',
      modifiers: internModifiers(event.shift, event.option, event.ctrl, event.meta),
      rawBytes: EMPTY_RAW_BYTES,
    };
    const normalized = normalizeVimInput(input, clock);
    if (!normalized.ok) return true;
    const outcome = parseVimInput(parser, normalized.value);
    parser = outcome.state;
    updatePrefixKeys(key, outcome.kind, event.ctrl);
    // canHandleSynchronously already excludes every command that can return a search
    // Promise, so this call is always void in practice; the cast just documents that
    // rather than silently dropping a Promise if that invariant is ever broken.
    if (outcome.kind === 'command') void executeCommand(outcome.command);
    return true;
  }

  function message(value: string): void { options.onMessage?.(value); }

  function closeCommandLine(): void {
    commandLine = undefined;
    commandLineCursorOffset = 0;
    commandLineKind = 'ex';
    pendingOperatorSearch = undefined;
  }

  /** Every user keystroke while a macro is recording is appended verbatim, except the
   * terminating bare 'q' itself (handled separately, see the 'q' branch below). */
  function recordMacroKeyIfActive(key: string): void {
    if (macroRecording === null || (mode === 'normal' && key === 'q')) return;
    const recorded = recordVimMacroKey(macroRecording, { key, source: 'user' });
    if (recorded.ok) macroRecording = recorded.value;
  }

  /** Replay one recorded key through the same parse+execute path a live keystroke uses.
   * A recorded ':' begins buffering an Ex command line (mirroring live command-line entry
   * in handleKeyInternal) instead of being fed to the Normal-mode parser; on <CR> the
   * buffered line runs through the same executeExCommand the live ':' path uses. This calls
   * executeExCommand directly rather than through submitCommandLine, whose unconditional
   * `await options.onExCommand?.(entered)` always yields a tick -- executeVimMacro's
   * dispatch loop (packages/vim/macros/index.ts) is synchronous and cannot await. An Ex
   * command whose own effects need a host await (:write, :quit) still resolves, just without
   * this replay waiting on it -- a disclosed limitation for those effects only. A replayed
   * n, N, star, hash or g-star/g-hash search is the same: it still runs through the
   * bounded, yielding, cancellable path, just without this synchronous replay loop
   * awaiting its result. */
  function replayMacroKey(key: string): void {
    if (macroExBuffer !== null) {
      if (key === '<CR>' || key === '<NL>') {
        const source = macroExBuffer.join('');
        macroExBuffer = null;
        void executeExCommand(source);
        return;
      }
      if (key === '<Esc>' || key === '<C-c>') { macroExBuffer = null; return; }
      const character = key === '<Space>' ? ' ' : key;
      if (character.length === 1) macroExBuffer.push(character);
      return;
    }
    if (key === ':') { macroExBuffer = []; return; }
    const normalized = { kind: 'key' as const, key, phase: 'press' as const, modifiers: MODIFIER_COMBOS[0] as InputModifiers, atMilliseconds: clock.monotonicMilliseconds() };
    const outcome = parseVimInput(parser, normalized);
    parser = outcome.state;
    if (outcome.kind === 'command') void executeCommand(outcome.command);
  }

  function beginMacroRecordingInternal(register: string): boolean {
    if (mode !== 'normal' || macroRecording !== null) return false;
    const started = beginVimMacroRecording(register, macroStore);
    if (!started.ok) return false;
    macroRecording = started.value;
    return true;
  }

  function beginInsertRecording(entryKey: VimInsertEntryKey, count = 1): void {
    insertEntryKey = entryKey;
    insertEntryCount = count;
    insertTypedChars = [];
    insertTainted = false;
    pendingChangeOperatorMotion = undefined;
  }

  /** Called once an insert session ends (Escape/Ctrl-C). If this insert was entered by a
   * 'change' operator (pendingChangeOperatorMotion set by executeOperator/applyOperatorPlan),
   * records the combined "delete then insert" as one atomic changeRepeatTarget instead of a
   * plain insert target -- real Vim's '.' after 'ciw<text><Esc>' redoes both, not just the
   * retype. Otherwise records the typed text as T024's own plain insert target, unless a
   * non-literal key (Backspace, arrows, Enter, ...) was seen. */
  function finishInsertRecording(): void {
    const entryKey = insertEntryKey;
    const changeMotion = pendingChangeOperatorMotion;
    insertEntryKey = undefined;
    pendingChangeOperatorMotion = undefined;
    if (entryKey === undefined) return;
    const text = insertTypedChars.join('');
    if (text.length > 0) lastInsertedText = text;
    if (insertTainted) return;
    if (changeMotion !== undefined) {
      changeRepeatTarget = { motionKey: changeMotion.motionKey, text, linewise: changeMotion.linewise };
      lastRepeatKind = 'change';
      return;
    }
    if (text.length === 0) return;
    const created = createVimInsertRepeatTarget({ entryKey, mode: 'insert', text, count: insertEntryCount });
    if (!created.ok) return;
    const recorded = recordVimRepeatTarget(repeatState, created.value);
    if (recorded.ok) { repeatState = recorded.value; lastRepeatKind = 'engine'; }
  }

  /**
   * `<C-r>{register}` in Insert/Replace mode: the literal text the register
   * owner hands back for the insert engine's `register-request`/
   * `register-payload` hand-off. Read-only registers this session already
   * tracks (`.`/`:`/`/`) resolve here too; `%`/`#` have no filename tracked
   * at this layer yet, so they resolve to empty text rather than crash the
   * prompt. `=` (the expression register) is explicitly out of scope -- Xi
   * has no expression evaluator -- so it prints nvim's own advisory message
   * and inserts nothing, like a cancelled prompt.
   */
  function resolveInsertRegisterText(name: string): string {
    if (name === '=') { message('xi: E15: expression register is not supported\n'); return ''; }
    if (name === '.') return lastInsertedText;
    if (name === ':') return lastExCommand ?? '';
    if (name === '/') return searchState.pattern ?? '';
    if (name === '%') return options.files?.currentPath() ?? '';
    if (name === '#') return options.files?.alternatePath() ?? '';
    if (!isRegisterName(name)) return '';
    const read = registers.read(name);
    if (!read.ok) return '';
    return registerValueText(read.value);
  }

  function executePut(command: 'p' | 'P', registerName: VimRegisterName, count = 1): boolean {
    const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
    if (primary === undefined || primary.kind !== 'normal-cursor') return false;
    const planned = prepareVimPutFromBank({ snapshot: document.snapshot(), cursor: primary.anchor.at.offset, command, bank: registers, registerName, count });
    if (!planned.ok) return false;
    const opened = document.beginUndoGroup(OPERATOR_GROUP, 'vim');
    if (!opened.ok) return false;
    const current = document.snapshot();
    const committed = document.commit({ documentId: current.id, expectedVersion: current.version, edits: planned.value.edits, origin: 'vim', undoGroup: OPERATOR_GROUP });
    if (!committed.ok || !document.endUndoGroup(OPERATOR_GROUP).ok) return false;
    notifyCommitted(committed, options.onDocumentChange);
    selections = makeNormalSelection(document.snapshot(), planned.value.cursor, (selections.selectionGeneration as number) + 1, selections.primaryId);
    motionCursor = makeMotionCursor(document.snapshot(), selections);
    parser = makeParser(mode, selections);
    return true;
  }

  async function readClipboardText(selection: 'clipboard' | 'primary'): Promise<string | undefined> {
    const clipboard = options.clipboard;
    if (clipboard === undefined) { message('xi: clipboard is unavailable\n'); return undefined; }
    const cancellation = new CancellationSource();
    const version = document.version;
    const generation = selections.selectionGeneration;
    const currentMode = mode;
    const currentInsert = insert;
    clipboardReads.add(cancellation);
    try {
      const read = selection === 'primary' ? clipboard.readPrimaryText?.(cancellation.token) : clipboard.readText(cancellation.token);
      if (read === undefined) { message('xi: primary selection is unavailable\n'); return undefined; }
      const result = await read;
      if (disposed || options.isActive?.() === false || document.version !== version || selections.selectionGeneration !== generation || mode !== currentMode || insert !== currentInsert) return undefined;
      if (!result.ok) { message(`xi: clipboard read failed: ${result.error.message}\n`); return undefined; }
      return result.value;
    } finally { clipboardReads.delete(cancellation); cancellation.dispose(); }
  }

  function storeClipboardTextAndPut(text: string, registerName: VimRegisterName, command: 'p' | 'P', count = 1): boolean {
    const linewise = text.endsWith('\n');
    const stored = registers.write({ name: registerName, value: { lines: (linewise ? text.slice(0, -1) : text).split('\n'), type: linewise ? 'linewise' : 'characterwise' } });
    if (!stored.ok) { message(`xi: clipboard paste failed: ${stored.error.kind}\n`); return true; }
    registers = stored.value;
    executePut(command, registerName, count);
    return true;
  }

  async function importClipboardAndPut(selection: 'clipboard' | 'primary', command: 'p' | 'P', count: number): Promise<boolean> {
    const text = await readClipboardText(selection);
    return text === undefined ? true : storeClipboardTextAndPut(text, selection === 'primary' ? '*' : '+', command, count);
  }

  function recordOperatorRepeat(operator: 'delete' | 'change', motionKey: string, count: number, forcedKind?: 'linewise'): void {
    const created = createVimOperatorRepeatTarget({ operator, motionKey, count, ...(forcedKind === undefined ? {} : { forcedKind }) });
    if (!created.ok) return;
    lastRepeatKind = 'engine';
    const recorded = recordVimRepeatTarget(repeatState, created.value);
    if (recorded.ok) repeatState = recorded.value;
  }

  function emitHostCommand(command: VimHostCommand): void {
    const result = options.onHostCommand?.(command);
    if (result !== undefined && typeof (result as Promise<void>).then === 'function') {
      void (result as Promise<void>).catch(() => message('xi: native host command failed\n'));
    }
  }

  const session: OwnedVimSession = {
    get activeViewId(): ViewId { return viewId; },
    get indentStyle(): string {
      if (options.insertOptions?.expandtab !== true) return 'tabs';
      const tabstop = options.insertOptions.tabstop ?? 8;
      const width = options.insertOptions.shiftwidth || tabstop;
      return `${width} space${width === 1 ? '' : 's'}`;
    },
    clearMotionGhost,
    get motionGhost(): VimMotionGhost | undefined { return currentMotionGhost(); },
    get commandLineActive(): boolean { return commandLine !== undefined; },
    get commandLine(): VimCommandLineState | undefined { return readCommandLine(); },
    get prefixHelp(): VimPrefixHelpState { return readPrefixHelp(); },
    get searchHighlight(): VimSearchHighlightState | undefined { return readSearchHighlight(); },
    readView(candidate): WorkbenchViewSnapshot | undefined {
      return candidate === viewId ? makeView(viewId, documentId, document.snapshot(), selections, mode) : undefined;
    },
    readDocument(candidate): DocumentReadPort | undefined { return candidate === viewId ? readPort : undefined; },
    handleKey,
    cancelPendingOperator(): void {
      clearMotionGhost();
      if (disposed || commandLine !== undefined) return;
      parser = makeParser(mode, selections);
      prefixKeys = EMPTY_PREFIX_KEYS;
      options.onPrefixStateChange?.(readPrefixHelp());
    },
    applyExternalChange(change): void {
      if (disposed || change.documentId !== documentId || selections.documentVersion !== change.before) return;
      clearMotionGhost();
      if (change.origin !== 'vim') {
        insert = insert === null ? null : mapExternalInsertSession(insert, change.changeMap.orderedEdits);
        // The document undo tree closes a Vim group when another origin commits.
        // Keep the local mode state consistent so Esc does not close a group twice.
        undoOpen = false;
      }
      const mapped = mapSelectionSet(selections, change.changeMap, document.snapshot());
      if (!mapped.ok) return;
      selections = mapped.value.selectionSet;
      parser = makeParser(mode, selections);
      motionCursor = mode === 'normal' ? makeMotionCursor(document.snapshot(), selections) : undefined;
    },
    closeInsertUndoGroup(): boolean {
      if (!undoOpen) return true;
      const closed = document.endUndoGroup(INSERT_GROUP);
      if (!closed.ok) {
        undoOpen = false;
        return false;
      }
      undoOpen = false;
      return true;
    },
    setInsertCursor(value): boolean {
      if (disposed) return false;
      const current = document.snapshot();
      const target = asUtf16Offset(value);
      if (!target.ok || !isInsertMode(mode)) return false;
      const primaryId = selections.primaryId;
      const members: SelectionMemberInput[] = [];
      for (const member of selections.members) {
        if (member.kind !== 'insert-caret') return false;
        const cursor = member.id === primaryId ? target.value : member.anchor.at.offset;
        members.push({
          id: member.id,
          kind: 'insert-caret',
          direction: member.direction,
          anchor: { kind: 'gap', offset: cursor },
          head: { kind: 'gap', offset: cursor },
          desiredColumn: member.desiredColumn,
          creationOrdinal: member.creationOrdinal,
        });
      }
      const updated = updateSelectionSet(current, selections, { primaryId, members });
      if (!updated.ok) return false;
      selections = updated.value.selectionSet;
      if (insert !== null) {
        insert = Object.freeze({
          ...insert,
          members: nonEmptyTuple(insert.members.map((member) => member.id === primaryId
            ? Object.freeze({ ...member, session: Object.freeze({ ...member.session, cursorOffset: target.value }) })
            : member)),
        });
      }
      parser = makeParser(mode, selections);
      options.onStateChange?.({ selections, mode });
      return true;
    },
    setInsertCursors(offsets): boolean {
      if (disposed) return false;
      const current = document.snapshot();
      if (!isInsertMode(mode) || offsets.size === 0) return false;
      const members: SelectionMemberInput[] = [];
      const nextInsertMembers = insert?.members.map((member) => {
        const requested = offsets.get(String(member.id));
        if (requested === undefined) return member;
        const target = asUtf16Offset(requested);
        return target.ok
          ? Object.freeze({ ...member, session: Object.freeze({ ...member.session, cursorOffset: target.value }) })
          : undefined;
      });
      if (nextInsertMembers?.some((member) => member === undefined) === true) return false;
      for (const member of selections.members) {
        if (member.kind !== 'insert-caret') return false;
        const requested = offsets.get(String(member.id));
        const cursor = requested === undefined
          ? { ok: true as const, value: member.anchor.at.offset }
          : asUtf16Offset(requested);
        if (!cursor.ok) return false;
        members.push({
          id: member.id,
          kind: 'insert-caret',
          direction: member.direction,
          anchor: { kind: 'gap', offset: cursor.value },
          head: { kind: 'gap', offset: cursor.value },
          desiredColumn: member.desiredColumn,
          creationOrdinal: member.creationOrdinal,
        });
      }
      const updated = updateSelectionSet(current, selections, { primaryId: selections.primaryId, members });
      if (!updated.ok) return false;
      selections = updated.value.selectionSet;
      if (insert !== null && nextInsertMembers !== undefined) {
        const validInsertMembers = nextInsertMembers.filter((member): member is NonNullable<typeof member> => member !== undefined);
        insert = Object.freeze({ ...insert, members: nonEmptyTuple(validInsertMembers) });
      }
      parser = makeParser(mode, selections);
      options.onStateChange?.({ selections, mode });
      return true;
    },
    setCursorPosition(line, utf16Column = 0): boolean {
      if (disposed || (mode !== 'normal' && !isVisualMode(mode)) || !Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(utf16Column) || utf16Column < 0) return false;
      const current = document.snapshot();
      const lineIndex = asLineIndex(Math.min(line, Math.max(0, current.lineCount - 1)));
      if (!lineIndex.ok) return false;
      const start = current.lineStartOffset(lineIndex.value);
      if (!start.ok) return false;
      const next = lineIndex.value + 1 < current.lineCount ? current.lineStartOffset((lineIndex.value + 1) as typeof lineIndex.value) : undefined;
      const end = next?.ok === true ? next.value - 1 : current.lengthUtf16;
      const requested = Math.min(start.value + utf16Column, Math.max(start.value, end - 1));
      const target = makeNormalSelection(current, requested as Utf16Offset, (selections.selectionGeneration as number) + 1, selections.primaryId);
      if (isVisualMode(mode)) {
        const cursor = visualCursorAt(current, target.members[0]!.head.at.offset);
        if (cursor === undefined) return false;
        const targets = [];
        for (const member of selections.members) {
          const memberCursor = member.id === selections.primaryId ? cursor : visualCursorAt(current, member.head.at.offset);
          if (memberCursor === undefined) return false;
          targets.push({ id: member.id, cursor: memberCursor });
        }
        const extended = extendVimVisualSelection(current, selections, targets);
        if (!extended.ok) return false;
        selections = extended.value;
      } else selections = target;
      motionCursor = makeMotionCursor(current, selections);
      parser = makeParser(mode, selections);
      options.onStateChange?.({ selections, mode });
      return true;
    },
    placePointer(intent): boolean {
      if (disposed || commandLine !== undefined || intent.viewId !== String(viewId)) return false;
      const current = document.snapshot();
      const target = intent.head.target;
      if (target === undefined || !Number.isSafeInteger(target.offset) || target.offset < 0 || target.offset > current.lengthUtf16) return false;
      if (intent.kind === 'add-caret') {
        const base = selections.members.every((member) => member.kind === 'normal-cursor')
          ? selections
          : makeNormalSelection(current, target.offset as Utf16Offset, (selections.selectionGeneration as number) + 1, selections.primaryId);
        return addPointerCaret(current, target, base, (next) => {
        selections = next;
        mode = 'normal';
        motionCursor = makeMotionCursor(current, selections);
        parser = makeParser(mode, selections);
        options.onStateChange?.({ selections, mode });
        });
      }
      if (intent.kind === 'click') {
        if (mode === 'normal' || isVisualMode(mode)) {
          selections = makeNormalSelection(current, target.offset as Utf16Offset, (selections.selectionGeneration as number) + 1, selections.primaryId);
          mode = 'normal';
          motionCursor = makeMotionCursor(current, selections);
          parser = makeParser(mode, selections);
          options.onStateChange?.({ selections, mode });
          return true;
        }
        if (isInsertMode(mode)) return session.setInsertCursor(target.offset);
        return false;
      }
      const visualKind = intent.kind === 'line' ? 'visual-line' : intent.kind === 'block' ? 'visual-block' : 'visual-character';
      const anchor = intent.anchor.target ?? target;
      const anchorCursor = pointerVisualCursor(current, anchor);
      const headCursor = pointerVisualCursor(current, target);
      if (anchorCursor === undefined || headCursor === undefined) return false;
      const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
      if (primary === undefined) return false;
      const word = intent.kind === 'word' ? pointerWordRange(current, anchorCursor, headCursor) : undefined;
      const effectiveAnchor = word === undefined ? anchorCursor : word.anchor;
      const effectiveHead = word === undefined ? headCursor : word.head;
      // A fresh generation per pointer move: the renderer's row diff keys selection repaints
      // on it, so a drag whose head moves inside one generation would never repaint.
      const started = beginVimVisualSelection(current, primary.id, effectiveAnchor, visualKind, { selectionGeneration: (selections.selectionGeneration as number) + 1 });
      if (!started.ok) return false;
      const extended = extendVimVisualSelection(current, started.value, [{ id: primary.id, cursor: effectiveHead }]);
      if (!extended.ok) return false;
      selections = extended.value;
      mode = visualKind;
      motionCursor = undefined;
      parser = makeParser(mode, selections);
      options.onStateChange?.({ selections, mode });
      if (intent.completed === true) yankPointerSelection();
      return true;
    },
    setCommandLineSource(source, cursorOffset = source.length): boolean {
      if (disposed || commandLine === undefined || typeof source !== 'string' || !Number.isSafeInteger(cursorOffset)) return false;
      const hasColon = source.startsWith(':');
      const internal = hasColon ? source.slice(1) : source;
      const internalOffset = hasColon ? cursorOffset - 1 : cursorOffset;
      if (internalOffset < 0 || internalOffset > internal.length) return false;
      commandLine = internal;
      commandLineCursorOffset = internalOffset + 1;
      lastPublishedCommandLine = readCommandLine();
      options.onCommandLineChange?.(lastPublishedCommandLine);
      return true;
    },
    submitCommandLine(source): Promise<boolean | 'quit'> {
      if (disposed) return Promise.resolve(true);
      return submitCommandLine(source ?? readCommandLine()?.source ?? ':');
    },
    beginMacroRecording(register: string): boolean {
      return !disposed && beginMacroRecordingInternal(register);
    },
    handlePaste(bytes: Uint8Array): boolean {
      if (disposed) return true;
      if (!isInsertMode(mode) || insert === null) {
        message('xi: paste is only supported while inserting\n');
        return true;
      }
      const planned = planVimMultiInsertInput(document.snapshot(), insert, { kind: 'paste', bytes });
      if (!planned.ok) { message(`xi: paste failed: ${planned.error.kind}\n`); return true; }
      commitPlan(document, planned.value, undoOpen, (value) => { undoOpen = value; }, options.onDocumentChange);
      // Pasted text is one opaque, atomic insertion, not a stream of single keys -- taint
      // any in-progress dot-repeat recording rather than risk misrepresenting it (T130).
      insertTainted = true;
      insert = planned.value.nextSession;
      if (insert === null) {
        mode = 'normal';
        const primary = planned.value.members.find((member) => member.id === selections.primaryId) ?? planned.value.members[0];
        const transition = primary?.transition;
        const cursor = transition?.kind === 'exited' ? transition.plan.cursorOffset : planned.value.members[0]?.transition.plan.cursorOffset;
        selections = makeNormalSelection(document.snapshot(), cursor ?? offset(0), (selections.selectionGeneration as number) + 1);
        motionCursor = makeMotionCursor(document.snapshot(), selections);
        insertEntryKey = undefined;
      } else {
        selections = makeInsertSelections(document.snapshot(), insert, (selections.selectionGeneration as number) + 1);
      }
      parser = makeParser(mode, selections);
      return true;
    },
    async handleClipboardPaste(selection = 'clipboard'): Promise<boolean> {
      if (disposed) return true;
      const text = await readClipboardText(selection);
      if (text === undefined) return true;
      if (isInsertMode(mode)) return session.handlePaste(new TextEncoder().encode(text));
      if (mode !== 'normal') { message('xi: clipboard paste requires Normal or Insert mode\n'); return true; }
      return storeClipboardTextAndPut(text, selection === 'primary' ? '*' : '+', 'p');
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const read of clipboardReads) read.cancel();
      clearMotionGhost();
      closeCommandLine();
      prefixKeys = EMPTY_PREFIX_KEYS;
      macroRecording = null;
      insert = null;
      motionCursor = undefined;
    },
  };

  options.onStateChange?.({ selections, mode });
  publishAuxiliaryState();

  function commandLinePrefix(): string {
    return commandLineKind === 'ex' ? ':' : commandLineKind === 'search-forward' ? '/' : '?';
  }

  function readCommandLine(): VimCommandLineState | undefined {
    if (commandLineStateCache !== undefined && commandLineStateCache.source === commandLine
      && commandLineStateCache.cursorOffset === commandLineCursorOffset && commandLineStateCache.kind === commandLineKind) {
      return commandLineStateCache.value;
    }
    const value = commandLine === undefined
      ? undefined
      : Object.freeze({ source: `${commandLinePrefix()}${commandLine}`, cursorOffset: commandLineCursorOffset, kind: commandLineKind });
    commandLineStateCache = { source: commandLine, cursorOffset: commandLineCursorOffset, kind: commandLineKind, value };
    return value;
  }

  function readSearchHighlight(): VimSearchHighlightState | undefined {
    if (searchState.pattern === null || searchState.pattern.length === 0) return undefined;
    return Object.freeze({ pattern: searchState.pattern, active: commandLineKind !== 'ex' && commandLine !== undefined });
  }

  function readPrefixHelp(): VimPrefixHelpState {
    const continuations = parser.legalContinuations;
    if (prefixHelpCache !== undefined && prefixHelpCache.keys === prefixKeys && prefixHelpCache.continuations === continuations) {
      return prefixHelpCache.value;
    }
    const value = Object.freeze({ pendingKeys: prefixKeys, parserContinuations: continuations });
    prefixHelpCache = { keys: prefixKeys, continuations, value };
    return value;
  }

  function publishAuxiliaryState(): void {
    options.onPrefixStateChange?.(readPrefixHelp());
    const commandLineState = readCommandLine();
    if (commandLineState !== lastPublishedCommandLine) {
      lastPublishedCommandLine = commandLineState;
      options.onCommandLineChange?.(commandLineState);
    }
  }

  /** Pending keys use Vim key notation (`<C-w>`), as prefix help and the router expect. */
  function updatePrefixKeys(key: string, outcomeKind: string, ctrl: boolean): void {
    prefixKeys = outcomeKind === 'pending' ? Object.freeze([...prefixKeys, ctrl && key.length === 1 ? `<C-${key}>` : key]) : EMPTY_PREFIX_KEYS;
  }

  async function submitCommandLine(source: string): Promise<boolean | 'quit'> {
    const entered = source.startsWith(':') ? source.slice(1) : source;
    closeCommandLine();
    lastPublishedCommandLine = undefined;
    options.onCommandLineChange?.(undefined);
    const hostResult = await options.onExCommand?.(entered);
    if (hostResult === 'handled') return true;
    if (hostResult === 'quit') return 'quit';
    const result = await executeExCommand(entered);
    return result === 'quit' ? 'quit' : true;
  }

  /** Submit a `/`/`?` command line: resolves the pattern (and any typed search-offset)
   * against the engine's search module, updates the persisted last-pattern/direction so
   * `n`/`N` continue correctly, and either resolves a pending `d/foo`-style operator
   * motion, extends the active Visual selection to the match (nvim's v_/ behavior), or
   * moves the Normal cursor there. */
  async function submitSearchCommandLine(): Promise<boolean> {
    const raw = commandLine ?? '';
    const kind = commandLineKind;
    const count = pendingSearchCount;
    const pendingOperator = pendingOperatorSearch;
    closeCommandLine();
    lastPublishedCommandLine = undefined;
    options.onCommandLineChange?.(undefined);
    const delimiter = kind === 'search-backward' ? '?' : '/';
    const direction: VimSearchDirection = kind === 'search-backward' ? 'backward' : 'forward';
    const { pattern, offsetText } = splitSearchCommandLine(raw, delimiter);
    const searchOffset = offsetText === undefined ? undefined : parseSearchOffsetSuffix(offsetText);
    const current = document.snapshot();
    const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
    const origin = primary === undefined ? offset(0) : selectionOffset(primary);
    const view = { cursor: origin, desiredDisplayColumn: 0, scrollTop: 0, scrollLeft: 0 };
    const result = await runInteractiveVimSearch(current, view, {
      command: 'search',
      pattern,
      direction,
      count,
      ...(searchOffset === undefined ? {} : { offset: searchOffset }),
    });
    if (result === undefined) return true; // superseded by a newer search
    if (!result.ok) { message('xi: E486: Pattern not found\n'); return true; }
    searchState = result.value.state;
    reportSearchOutcome(result.value.outcome);
    if (result.value.outcome.kind !== 'found') return true;
    const match = result.value.outcome.match;
    if (pendingOperator !== undefined) {
      applySearchOperator(pendingOperator, current, primary, match, searchOffset);
      return true;
    }
    if (isVisualMode(mode)) {
      const cursor = visualCursorAt(current, match.cursor);
      if (cursor === undefined) return true;
      const targets = selections.members.map((member) => ({ id: member.id, cursor }));
      const extended = extendVimVisualSelection(current, selections, targets);
      if (extended.ok) selections = extended.value;
    } else {
      selections = makeNormalSelection(current, match.cursor, (selections.selectionGeneration as number) + 1, selections.primaryId);
      motionCursor = makeMotionCursor(current, selections);
    }
    parser = makeParser(mode, selections);
    return true;
  }

  /** Resolve a `d/foo<CR>`-style operator-pending search motion: the range runs from the
   * pre-search cursor to the match (exclusive, unless the typed offset was `/e`, which nvim
   * makes inclusive), reusing the same single-cursor operator pipeline `dd`/`cc` use. */
  function applySearchOperator(
    pendingOperator: { readonly operator: VimCoreOperator; readonly register: string | undefined },
    current: DocumentSnapshot,
    primary: SelectionSetSnapshot['members'][number] | undefined,
    match: VimSearchMatch,
    searchOffset: VimSearchOffset | undefined,
  ): void {
    if (primary === undefined || primary.kind !== 'normal-cursor') return;
    // `d/pat/+1<CR>`-style: a `line` search-offset makes the motion linewise (`:help
    // search-offset`), spanning whole lines from the cursor's line to the offset line.
    const linewise = searchOffset?.kind === 'line';
    const motion = {
      origin: { documentVersion: current.version, offset: primary.anchor.at.offset },
      target: { documentVersion: current.version, offset: match.cursor },
      direction: match.direction,
      motionKind: linewise ? 'linewise' as const : 'characterwise' as const,
      inclusive: linewise ? true : searchOffset?.kind === 'end',
      motionKey: match.direction === 'forward' ? '/' : '?',
    };
    const prepared = prepareVimOperator(current, {
      operator: pendingOperator.operator,
      motion: { ok: true, value: motion },
      operatorCount: 1,
      motionCount: 1,
      ...(pendingOperator.register === undefined ? {} : { register: pendingOperator.register }),
      defaultYankRegister,
      state: { mode: 'normal', repeatTarget: null },
    });
    if (!prepared.ok || prepared.value.kind === 'failed') { message('xi: search motion failed\n'); return; }
    applyOperatorPlan(prepared.value);
  }

    async function executeExCommand(source: string): Promise<'quit' | 'stay'> {
      // '@:' repeats the last Ex command line (see the 'play-macro' branch in
      // executeLiteral); tracked here so both live ':' entry and a macro-replayed
      // ':' line (replayMacroKey) feed the same repeat target.
      lastExCommand = source;
      const normalized = source.trim();
      const selectionCommand = parseXiSelectionCommand(normalized);
      if (selectionCommand !== undefined) {
        executeXiSelectionCommand(selectionCommand);
        return 'stay';
      }
      const exSource = normalized === 'wq' || normalized === 'x' ? ':write|quit' : `:${source}`;
      const parsed = parseVimExSequence(exSource);
      if (!parsed.ok) {
        message(`xi: ${parsed.error.kind}\n`);
        return 'stay';
    }
      for (const command of parsed.value) {
        const current = document.snapshot();
        const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
        const line = primary === undefined ? asLineIndex(0) : current.lineIndexAt(primary.anchor.at.offset);
        if (!line.ok) return 'stay';
        const prepared = prepareVimEx(current, command, {
          currentLine: line.value,
          cursor: primary?.anchor.at.offset,
          selectionCount: selections.members.length,
        });
        if (!prepared.ok) {
          message(`xi: ${prepared.error.kind}\n`);
          return 'stay';
        }
        if (prepared.value.edits.length > 0) {
          const committed = document.commit({
            documentId: current.id,
            expectedVersion: current.version,
            edits: prepared.value.edits,
            origin: 'vim',
            undoGroup: EX_GROUP,
          });
          if (!committed.ok) {
            message(`xi: ex edit failed: ${committed.error.kind}\n`);
            return 'stay';
          }
          notifyCommitted(committed, options.onDocumentChange);
          selections = makeNormalSelection(document.snapshot(), primary?.anchor.at.offset ?? offset(0), (selections.selectionGeneration as number) + 1, selections.primaryId);
          motionCursor = makeMotionCursor(document.snapshot(), selections);
        }
        for (const effect of prepared.value.hostEffects) {
          if (effect.kind === 'write') {
            if (options.onSave === undefined || !(await options.onSave(effect.path ?? undefined))) return 'stay';
          } else if (effect.kind === 'open') {
            if (document.isDirty && !effect.bang) { message('xi: unsaved changes (use :e! to open anyway)\n'); return 'stay'; }
            if (effect.path === null || options.onHostCommand === undefined) { message('xi: :edit requires an available file path\n'); return 'stay'; }
            await options.onHostCommand({ kind: 'open-file', target: effect.path, split: false });
          } else if (effect.kind === 'quit') {
            if (document.isDirty && !effect.bang) {
              message('xi: unsaved changes (use :q! or :wq)\n');
              return 'stay';
            }
            return 'quit';
          }
        }
      }
      return 'stay';
    }

    function executeXiSelectionCommand(command: XiSelectionCommandInput): void {
      const current = document.snapshot();
      const before = selections;
      const result = applyVimSelectionCommand({
        snapshot: current,
        selections: before,
        command: command.command,
        ...(command.pattern === undefined ? {} : { pattern: command.pattern }),
        ...(command.limit === undefined && options.selectionLimit === undefined ? {} : { limit: command.limit ?? options.selectionLimit }),
        ...(command.ignoreCase === undefined ? {} : { ignoreCase: command.ignoreCase }),
        ...(command.command === 'selection.undo' ? { history: selectionHistory } : {}),
      });
      if (!result.ok) {
        const detail = result.error.kind === 'selection-limit'
          ? `selection limit ${result.error.limit} exceeded`
          : result.error.kind === 'empty-filter-result'
            ? 'no selections remain; prior set preserved'
            : result.error.kind;
        message(`xi: ${detail}\n`);
        return;
      }
      if (command.command === 'selection.undo') {
        selectionHistory = selectionHistory.slice(1);
      } else {
        selectionHistory = [before, ...selectionHistory].slice(0, options.selectionHistoryLimit ?? SELECTION_HISTORY_LIMIT);
      }
      selections = result.value.selection;
      mode = selectionModeFor(selections.members[0]?.kind);
      motionCursor = mode === 'normal' ? makeMotionCursor(current, selections) : undefined;
      parser = makeParser(mode, selections);
      message(`xi: ${command.command} · ${selections.members.length} selection${selections.members.length === 1 ? '' : 's'}\n`);
    }

    function executeCommand(command: VimCommandIntent): void | Promise<void> {
      const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
      if (command.kind === 'mode-transition' && isVisualMode(mode)) {
        if (command.to === 'normal') {
          executeCommand({ kind: 'leave-mode', via: 'escape', from: mode, to: 'normal', selections, atMilliseconds: command.atMilliseconds });
        } else if (isVisualMode(command.to)) {
          const converted = convertVimVisualSelection(document.snapshot(), selections, command.to);
          if (!converted.ok) return;
          selections = converted.value;
          mode = command.to;
          parser = makeParser(mode, selections);
        }
        return;
      }
      if (command.kind === 'single-key' && isVisualMode(mode) && (command.key === 'o' || command.key === 'O')) {
        const exchanged = command.key === 'O' && mode === 'visual-block'
          ? exchangeVimVisualBlockColumns(document.snapshot(), selections)
          : exchangeVimVisualEndpoints(document.snapshot(), selections);
        if (exchanged.ok) { selections = exchanged.value; parser = makeParser(mode, selections); }
        return;
      }
      if (command.kind === 'mode-transition' && mode === 'normal' && isVisualMode(command.to)) {
        const ghost = command.to === 'visual-character' ? currentMotionGhost() : undefined;
        if (ghost !== undefined) {
          selections = ghost.selection;
          mode = command.to;
          clearMotionGhost();
          motionCursor = undefined;
          parser = makeParser(mode, selections);
          return;
        }
        const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
        if (primary === undefined || primary.kind !== 'normal-cursor') return;
        const cursor = visualCursorAt(document.snapshot(), primary.anchor.at.offset);
        if (cursor === undefined) return;
        const started = beginVimVisualSelection(document.snapshot(), primary.id, cursor, command.to);
        if (!started.ok) return;
        selections = started.value;
        mode = command.to;
        motionCursor = undefined;
        parser = makeParser(mode, selections);
        return;
      }
      if (command.kind === 'mode-transition' && (command.to === 'insert' || command.to === 'replace') && mode === 'normal') {
        const key = command.key;
        if (!isInsertEntryKey(key)) return;
        const members = selections.members.map((member) => ({ id: member.id, cursorOffset: member.anchor.at.offset }));
        const entered = beginVimMultiInsert(document.snapshot(), members, key, options.insertOptions ?? {}, command.count.value);
        if (!entered.ok) throw new Error(`xi-enter-insert:${entered.error.kind}`);
        commitPlan(document, entered.value.plan, undoOpen, (value) => { undoOpen = value; }, options.onDocumentChange);
        mode = entered.value.session.mode;
        insert = entered.value.session;
        motionCursor = undefined;
        selections = makeInsertSelections(document.snapshot(), insert, (selections.selectionGeneration as number) + 1);
        parser = makeParser(mode, selections);
        if (members.length === 1) beginInsertRecording(key, command.count.value); else insertEntryKey = undefined;
        return;
      }
      if (command.kind === 'insert-key' && isInsertMode(mode) && insert !== null && command.key === '<C-a>') {
        // nvim: with nothing inserted yet this session, <C-a> is "E29: No inserted text
        // yet" -- a no-op, not a literal control byte (which the generic key path below
        // would otherwise produce via its textKey fallback).
        if (lastInsertedText.length === 0) { message('xi: E29: No inserted text yet\n'); return; }
        const planned = planVimMultiInsertInput(document.snapshot(), insert, { kind: 'paste', bytes: new TextEncoder().encode(lastInsertedText) });
        if (!planned.ok) throw new Error(`xi-insert:${planned.error.kind}`);
        commitPlan(document, planned.value, undoOpen, (value) => { undoOpen = value; }, options.onDocumentChange);
        // One opaque insertion, like a paste, not a stream of single keys -- see
        // handlePaste's identical reasoning for tainting rather than misrepresenting dot.
        insertTainted = true;
        insert = planned.value.nextSession;
        if (insert === null) {
          mode = 'normal';
          const primary = planned.value.members.find((member) => member.id === selections.primaryId) ?? planned.value.members[0];
          const transition = primary?.transition;
          const cursor = transition?.kind === 'exited' ? transition.plan.cursorOffset : planned.value.members[0]?.transition.plan.cursorOffset;
          selections = makeNormalSelection(document.snapshot(), cursor ?? offset(0), (selections.selectionGeneration as number) + 1);
          motionCursor = makeMotionCursor(document.snapshot(), selections);
          insertEntryKey = undefined;
        } else {
          selections = makeInsertSelections(document.snapshot(), insert, (selections.selectionGeneration as number) + 1);
        }
        parser = makeParser(mode, selections);
        return;
      }
      if (command.kind === 'insert-key' && isInsertMode(mode) && insert !== null) {
        const planned = planVimMultiInsertInput(document.snapshot(), insert, { kind: 'key', key: command.key });
        if (!planned.ok) throw new Error(`xi-insert:${planned.error.kind}`);
        commitPlan(document, planned.value, undoOpen, (value) => { undoOpen = value; }, options.onDocumentChange);
        const primaryTransition = (planned.value.members.find((member) => member.id === selections.primaryId) ?? planned.value.members[0])?.transition;
        // `<C-r>` itself and its `<C-r><C-o>`/`<C-r><C-p>` modifier keys only open/hold the
        // register-name prompt -- no text yet, so they neither become part of dot's typed
        // text nor taint it; the resolved register text below is spliced in instead.
        const isRegisterPrompt = command.key === '<C-r>' || command.key === '<C-o>' || command.key === '<C-p>'
          || primaryTransition?.kind === 'register-request';
        if (insertEntryKey !== undefined) {
          if (planned.value.undoAction === 'break') {
            // A cursor move: nvim starts a new undo/dot-repeat piece here, so only text
            // typed after this point is replayed by '.'.
            insertTypedChars = [];
          } else if (!isRegisterPrompt) {
            const character = command.key === '<Space>' ? ' ' : command.key;
            if (character.length === 1) insertTypedChars.push(character);
            else insertTainted = true;
          }
        }
        insert = planned.value.nextSession;
        if (insert !== null && primaryTransition?.kind === 'register-request') {
          // The register owner resolves the name into literal text; feed it back through
          // the same opaque-insert path Insert mode's own `<C-a>` reuses, which also clears
          // the `register-payload` wait on every member regardless of that member's own
          // request id.
          const text = resolveInsertRegisterText(primaryTransition.request.registerName);
          const payloadPlanned = planVimMultiInsertInput(document.snapshot(), insert, { kind: 'paste', bytes: new TextEncoder().encode(text) });
          if (!payloadPlanned.ok) throw new Error(`xi-insert-register:${payloadPlanned.error.kind}`);
          commitPlan(document, payloadPlanned.value, undoOpen, (value) => { undoOpen = value; }, options.onDocumentChange);
          if (insertEntryKey !== undefined && text.length > 0) insertTypedChars.push(text);
          insert = payloadPlanned.value.nextSession;
        }
        if (insert === null) {
          mode = 'normal';
          const primary = planned.value.members.find((member) => member.id === selections.primaryId) ?? planned.value.members[0];
          const transition = primary?.transition;
          const cursor = transition?.kind === 'exited' ? transition.plan.cursorOffset : planned.value.members[0]?.transition.plan.cursorOffset;
          selections = makeNormalSelection(document.snapshot(), cursor ?? offset(0), (selections.selectionGeneration as number) + 1);
          motionCursor = makeMotionCursor(document.snapshot(), selections);
          // Not the explicit Escape/Ctrl-C leave-mode path below; whether the closing
          // key itself was inserted text is ambiguous here, so discard rather than
          // risk recording a wrong dot target.
          insertEntryKey = undefined;
        } else {
          selections = makeInsertSelections(document.snapshot(), insert, (selections.selectionGeneration as number) + 1);
        }
        parser = makeParser(mode, selections);
      }
      if (command.kind === 'leave-mode' && isInsertMode(mode) && insert !== null) {
        const planned = planVimMultiInsertInput(document.snapshot(), insert, { kind: 'key', key: command.via === 'ctrl-c' ? '<C-c>' : '<Esc>' });
        if (!planned.ok) throw new Error(`xi-leave:${planned.error.kind}`);
        commitPlan(document, planned.value, undoOpen, (value) => { undoOpen = value; }, options.onDocumentChange);
        const primary = planned.value.members.find((member) => member.id === selections.primaryId) ?? planned.value.members[0];
        const transition = primary?.transition;
        if (transition?.kind !== 'exited') {
          // A pending sub-prompt (e.g. `<C-r>`'s register-name/register-payload wait)
          // absorbed this Escape/Ctrl-C as its own cancel -- Insert/Replace mode itself
          // is unaffected, unlike a real leave-mode.
          insert = planned.value.nextSession;
          if (insert !== null) selections = makeInsertSelections(document.snapshot(), insert, (selections.selectionGeneration as number) + 1);
          parser = makeParser(mode, selections);
          return;
        }
        const cursor = transition.plan.cursorOffset;
        insert = null;
        mode = 'normal';
        selections = makeNormalSelection(document.snapshot(), cursor, (selections.selectionGeneration as number) + 1);
        motionCursor = makeMotionCursor(document.snapshot(), selections);
        parser = makeParser(mode, selections);
        // Real Vim's dot never replays an insert interrupted by Ctrl-C; only a clean
        // Escape finalizes the recorded text as the new dot target.
        if (command.via === 'ctrl-c') insertEntryKey = undefined; else finishInsertRecording();
      }
      if (command.kind === 'leave-mode' && isVisualMode(mode)) {
        const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
        const cursor = primary === undefined ? offset(0) : selectionOffset(primary);
        mode = 'normal';
        selections = makeNormalSelection(document.snapshot(), cursor, (selections.selectionGeneration as number) + 1, selections.primaryId);
        motionCursor = makeMotionCursor(document.snapshot(), selections);
        parser = makeParser(mode, selections);
        return;
      }
      if (command.kind === 'begin-search') {
        commandLine = '';
        commandLineCursorOffset = 1;
        commandLineKind = command.direction === 'forward' ? 'search-forward' : 'search-backward';
        pendingSearchCount = command.count?.value ?? 1;
        pendingOperatorSearch = undefined;
        return;
      }
      // `d/foo<CR>`/`y?foo<CR>`: the parser resolves a `/`/`?` operator motion key
      // immediately (packages/vim/parser's own MOTION_KEYS include '/'/'?'), but the
      // pattern text has not been typed yet -- open the same search prompt and resolve
      // the operator once the pattern is entered (submitSearchCommandLine).
      if (command.kind === 'operator-motion' && (command.motion === '/' || command.motion === '?')) {
        const operator = coreOperator(command.operator.name);
        if (operator === null) return;
        commandLine = '';
        commandLineCursorOffset = 1;
        commandLineKind = command.motion === '/' ? 'search-forward' : 'search-backward';
        pendingSearchCount = command.operatorCount.value * command.motionCount.value;
        pendingOperatorSearch = { operator, register: command.register };
        return;
      }
      if (command.kind === 'operator-motion' || command.kind === 'operator-line' || command.kind === 'operator-text-object') {
        executeOperator(command);
        return;
      }
      if (command.kind === 'literal-command') {
        executeLiteral(command);
        return;
      }
      if (command.kind === 'prefixed-key') {
        return executePrefixed(command);
      }
      if (command.kind === 'single-key' && mode === 'normal' && (command.key === '<C-]>' || command.key === '<C-t>')) {
        if (command.key === '<C-t>') {
          emitHostCommand({ kind: 'tag-back' });
        } else {
          const target = hostTarget(document.snapshot(), primary);
          if (target !== undefined) emitHostCommand({ kind: 'open-tag', name: target.target, split: false });
        }
        return;
      }
      if (command.kind === 'single-key' && mode === 'normal' && command.key === 'K') {
        if (primary !== undefined) emitHostCommand({ kind: 'lookup', target: hostTarget(document.snapshot(), primary)?.target ?? '', lookup: 'keyword' });
        return;
      }
      if (command.kind === 'visual-text-object' && isVisualMode(mode)) {
        const extended = resolveVimMultiVisualTextObject({
          snapshot: document.snapshot(),
          selections,
          invocation: { key: command.textObject as VimTextObjectKey, count: command.count.value },
          failurePolicy: 'reject-command',
        });
        if (!extended.ok) return;
        selections = extended.value.selection;
        mode = extended.value.kind;
        parser = makeParser(mode, selections);
        return;
      }
      if (command.kind === 'single-key' && isVisualMode(mode) && isMotionLike(command.key)) {
        const invocation = motionInvocation(command.key, command.count.explicit ? command.count.value : undefined);
        if (invocation === null) return;
        const motionOptions = (command.key === 'H' || command.key === 'M' || command.key === 'L') ? viewportMotionOptions() : undefined;
        const moved = resolveVimMultiVisualMotion({ snapshot: document.snapshot(), selections, invocation, failurePolicy: 'reject-command', ...(motionOptions ? { options: motionOptions } : {}) });
        if (!moved.ok) return;
        selections = moved.value.selection;
        parser = makeParser(mode, selections);
        return;
      }
      if (command.kind === 'single-key' && isVisualMode(mode) && ['%', '(', ')', '{', '}'].includes(command.key)) {
        const invocation = { key: command.key as VimStructuralMotionKey, ...(command.count.explicit ? { count: command.count.value } : {}) };
        const moved = resolveVimMultiVisualMotion({ snapshot: document.snapshot(), selections, invocation, failurePolicy: 'reject-command' });
        if (!moved.ok) return;
        selections = moved.value.selection;
        parser = makeParser(mode, selections);
        return;
      }
      if (command.kind === 'single-key' && isVisualMode(mode) && (command.key === ';' || command.key === ',')) {
        const found = resolveVimMultiVisualFind({ snapshot: document.snapshot(), selections, invocation: { key: command.key, count: command.count.value }, lastFind, failurePolicy: 'reject-command' });
        if (!found.ok) return;
        lastFind = found.value.lastFind;
        selections = found.value.selection;
        parser = makeParser(mode, selections);
        return;
      }
      // nvim --clean v_star-default/v_#-default: Visual `*`/`#` searches forward/backward
      // for the exact selected text as a literal (`\V`) pattern -- no `\<...\>` word
      // boundaries (unlike Normal `*`/`#`) -- and leaves Visual mode on the primary member.
      if (command.kind === 'single-key' && (mode === 'visual-character' || mode === 'visual-line') && (command.key === '*' || command.key === '#')) {
        return executeVisualStarHash(command.key, mode);
      }
      if (command.kind === 'single-key' && isVisualMode(mode) && (command.key === 'd' || command.key === 'c' || command.key === 'y')) {
        executeVisualOperator(command.key);
        return;
      }
      if (command.kind === 'single-key' && mode === 'normal' && command.key === '.') {
        executeDotRepeat(command.count.explicit ? command.count.value : undefined);
        return;
      }
      if (command.kind === 'single-key' && mode === 'normal' && (command.key === 'p' || command.key === 'P')) {
        const registerName = (command.register ?? defaultYankRegister) as VimRegisterName;
        if (registerName === '+' || registerName === '*') return importClipboardAndPut(registerName === '*' ? 'primary' : 'clipboard', command.key as 'p' | 'P', command.count.value).then(() => undefined);
        executePut(command.key as 'p' | 'P', registerName, command.count.value);
        return;
      }
      if (command.kind === 'single-key' && mode === 'normal' && isMotionLike(command.key)) {
        ghostMotionCount = command.count.value;
        ghostMotionKey = command.key;
        const invocation = motionInvocation(command.key, command.count.explicit ? command.count.value : undefined);
        if (invocation === null) return;
        const motionOptions = (command.key === 'H' || command.key === 'M' || command.key === 'L') ? viewportMotionOptions() : undefined;
        const moved = resolveVimMultiMotion({ snapshot: document.snapshot(), selections, invocation, failurePolicy: 'reject-command', ...(motionOptions ? { options: motionOptions } : {}) });
        if (!moved.ok) return;
        selections = moved.value.selection;
        motionCursor = makeMotionCursor(document.snapshot(), selections);
        parser = makeParser(mode, selections);
        return;
      }
      if (command.kind === 'single-key' && mode === 'normal'
        && (command.key === '%' || command.key === '(' || command.key === ')' || command.key === '{' || command.key === '}')) {
        if (motionCursor === undefined) return;
        const moved = resolveVimStructuralMotion(document.snapshot(), motionCursor, {
          key: command.key,
          ...(command.count.explicit ? { count: command.count.value } : {}),
        });
        if (!moved.ok) return;
        motionCursor = moved.value.cursor;
        selections = makeNormalSelection(document.snapshot(), moved.value.cursor.offset, (selections.selectionGeneration as number) + 1, selections.primaryId);
        parser = makeParser(mode, selections);
        return;
      }
      if (command.kind === 'single-key' && mode === 'normal' && (command.key === ';' || command.key === ',')) {
        if (motionCursor === undefined) return;
        const found = resolveVimFind(document.snapshot(), motionCursor, { key: command.key, count: command.count.value }, lastFind);
        if (!found.ok) return;
        lastFind = found.value.lastFind;
        if (found.value.kind !== 'found') { parser = makeParser(mode, selections); return; }
        selections = makeNormalSelection(document.snapshot(), found.value.cursor.offset, (selections.selectionGeneration as number) + 1, selections.primaryId);
        motionCursor = found.value.cursor;
        parser = makeParser(mode, selections);
        return;
      }
      if (command.kind === 'single-key' && (mode === 'normal' || isVisualMode(mode))
        && (command.key === 'n' || command.key === 'N' || (mode === 'normal' && (command.key === '*' || command.key === '#')))) {
        const searchCommand: VimSearchCommand = command.key === '*' ? 'star' : command.key === '#' ? 'hash' : command.key === 'n' ? 'next' : 'previous';
        return runSearchCommand(searchCommand, command.count.value).then(() => undefined);
      }
      if (command.kind === 'single-key' && mode === 'normal' && command.key === 'u') {
        for (let count = 0; count < command.count.value; count += 1) {
          const undone = document.undo();
          if (!undone.ok) break;
        }
        selections = makeNormalSelection(document.snapshot(), selections.members[0]?.anchor.at.offset ?? offset(0), (selections.selectionGeneration as number) + 1, selections.primaryId);
        motionCursor = makeMotionCursor(document.snapshot(), selections);
        parser = makeParser(mode, selections);
      }
      if (command.kind === 'single-key' && mode === 'normal' && isDirectChangeKey(command.key)) {
        const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
        if (primary === undefined || primary.kind !== 'normal-cursor') return;
        const prepared = prepareVimDirectChange({
          snapshot: document.snapshot(),
          key: command.key,
          cursorOffset: primary.anchor.at.offset,
          count: command.count.value,
          state: { mode: 'normal', repeatTarget: null },
        });
        if (!prepared.ok) return;
        if (prepared.value.transaction !== null) {
          // A direct change that enters Insert (s/S/C) shares one undo group with the
          // insert text that follows, matching Neovim's single undo step; the group
          // is left open here and closed by commitPlan when Insert mode exits.
          const group = prepared.value.mode === 'insert' ? INSERT_GROUP : DIRECT_GROUP;
          const opened = document.beginUndoGroup(group, 'vim');
          if (!opened.ok) return;
          const committed = document.commit({
            documentId: prepared.value.transaction.documentId,
            expectedVersion: prepared.value.transaction.expectedVersion,
            edits: prepared.value.transaction.edits,
            origin: 'vim',
            undoGroup: group,
          });
          if (!committed.ok) {
            document.endUndoGroup(group);
            return;
          }
          if (prepared.value.mode === 'insert') {
            undoOpen = true;
          } else if (!document.endUndoGroup(group).ok) return;
          notifyCommitted(committed, options.onDocumentChange);
          if (prepared.value.registerEffect !== null) registers = applyRegisterEffect(registers, prepared.value.registerEffect);
        }
        if (prepared.value.mode === 'insert') {
          const entered = beginVimMultiInsert(document.snapshot(), [{ id: primary.id, cursorOffset: prepared.value.cursorOffset }], 'i', options.insertOptions ?? {});
          if (!entered.ok) return;
          commitPlan(document, entered.value.plan, undoOpen, (value) => { undoOpen = value; }, options.onDocumentChange);
          mode = entered.value.session.mode;
          insert = entered.value.session;
          selections = makeInsertSelections(document.snapshot(), insert, (selections.selectionGeneration as number) + 1);
          parser = makeParser(mode, selections);
          beginInsertRecording('i');
          return;
        }
        if (prepared.value.transaction === null) return;
        selections = makeNormalSelection(document.snapshot(), prepared.value.cursorOffset, (selections.selectionGeneration as number) + 1, selections.primaryId);
        motionCursor = makeMotionCursor(document.snapshot(), selections);
        parser = makeParser(mode, selections);
      }
    }

    function executeOperator(command: Extract<VimCommandIntent, { readonly kind: 'operator-motion' | 'operator-line' | 'operator-text-object' }>): void {
      const operator = coreOperator(command.operator.name);
      if (operator === null) return;
      if (command.kind === 'operator-line') {
        const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
        if (primary === undefined || primary.kind !== 'normal-cursor') return;
        const current = document.snapshot();
        const lineMotion = {
          origin: { documentVersion: current.version, offset: primary.anchor.at.offset },
          target: { documentVersion: current.version, offset: primary.anchor.at.offset },
          direction: 'forward' as const,
          motionKind: 'linewise' as const,
          inclusive: true,
          motionKey: command.operator.key,
          forceKind: 'linewise' as const,
          lineCount: command.count.value,
        };
        const single = prepareVimOperator(current, {
          operator,
          motion: { ok: true, value: lineMotion },
          operatorCount: 1,
          motionCount: command.count.value,
          doubled: true,
          ...(command.register === undefined ? {} : { register: command.register }),
          defaultYankRegister,
          state: { mode: 'normal', repeatTarget: null },
        });
        if (!single.ok || single.value.kind === 'failed') return;
        applyOperatorPlan(
          single.value,
          operator === 'delete' ? { motionKey: command.operator.key, count: command.count.value } : undefined,
          operator === 'change' ? command.operator.key : undefined,
        );
        return;
      }
      const motionCommand = command.kind === 'operator-text-object' || command.kind === 'operator-motion' ? command : null;
      if (motionCommand === null) return;
      // The motion itself must move by operatorCount * motionCount ("2d3w" deletes 6 words):
      // prepareVimMultiOperator/prepareVimOperator only validate that product against limits,
      // they do not re-derive the range from the separate counts (see operators/core.ts).
      const motion = motionInvocation(
        motionCommand.kind === 'operator-text-object' ? motionCommand.textObject : motionCommand.motion,
        motionCommand.motionCount.value * motionCommand.operatorCount.value,
      );
      if (motion === null) return;
      const motionKeyForViewport = motionCommand.kind === 'operator-motion' ? motionCommand.motion : undefined;
      const motionOptions = (motionKeyForViewport === 'H' || motionKeyForViewport === 'M' || motionKeyForViewport === 'L') ? viewportMotionOptions() : undefined;
      const force = motionCommand.kind === 'operator-motion' ? motionCommand.force : undefined;
      const prepared = prepareVimMultiOperator({
        snapshot: document.snapshot(),
        selections,
        operator,
        motion,
        operatorCount: motionCommand.operatorCount.value,
        motionCount: motionCommand.motionCount.value,
        ...(motionCommand.register === undefined ? {} : { register: motionCommand.register }),
        ...(motionOptions === undefined ? {} : { motionOptions }),
        ...(force === undefined ? {} : { force }),
        defaultYankRegister,
        state: { mode: 'normal', repeatTarget: null },
        failurePolicy: 'reject-command',
      });
      if (!prepared.ok || prepared.value.transaction === null && prepared.value.cursorOffsets.length === 0) return;
      const entersInsert = prepared.value.members.some((member) => member.plan?.mode === 'insert');
      if (prepared.value.transaction !== null) {
        // A change (cw/ciw/...) shares one undo group with the insert text that
        // follows the delete, matching Neovim's single undo step; the group is left
        // open here and closed by commitPlan when Insert mode exits.
        const group = entersInsert ? INSERT_GROUP : OPERATOR_GROUP;
        const opened = document.beginUndoGroup(group, 'vim');
        if (!opened.ok) return;
        const committed = document.commit({
          documentId: prepared.value.transaction.documentId,
          expectedVersion: prepared.value.transaction.expectedVersion,
          edits: prepared.value.transaction.edits,
          origin: 'vim',
          undoGroup: group,
        });
        if (!committed.ok) {
          document.endUndoGroup(group);
          return;
        }
        if (entersInsert) {
          undoOpen = true;
        } else if (!document.endUndoGroup(group).ok) return;
        notifyCommitted(committed, options.onDocumentChange);
      }
      for (const effect of prepared.value.registerEffects) registers = applyRegisterEffect(registers, effect);
      const primary = prepared.value.cursorOffsets.find((member) => member.id === selections.primaryId) ?? prepared.value.cursorOffsets[0];
      const cursor = primary?.offset ?? selectionOffset(selections.members[0]);
      if (entersInsert) {
        const entered = beginVimMultiInsert(document.snapshot(), [{ id: selections.primaryId, cursorOffset: cursor }], 'i', options.insertOptions ?? {});
        if (!entered.ok) return;
        commitPlan(document, entered.value.plan, undoOpen, (value) => { undoOpen = value; }, options.onDocumentChange);
        insert = entered.value.session;
        mode = entered.value.session.mode;
        selections = makeInsertSelections(document.snapshot(), insert, (selections.selectionGeneration as number) + 1);
        motionCursor = undefined;
        beginInsertRecording('i');
        if (operator === 'change') {
          pendingChangeOperatorMotion = { motionKey: motionCommand.kind === 'operator-text-object' ? motionCommand.textObject : motionCommand.motion, linewise: false };
        }
      } else {
        mode = 'normal';
        selections = makeNormalSelection(document.snapshot(), cursor, (selections.selectionGeneration as number) + 1, selections.primaryId);
        motionCursor = makeMotionCursor(document.snapshot(), selections);
        // 'change' always transitions through insert above; only 'delete' finishes here
        // directly, and only 'delete'/'change' are dot-repeatable operators (T024).
        if (operator === 'delete') {
          const motionKey = motionCommand.kind === 'operator-text-object' ? motionCommand.textObject : motionCommand.motion;
          recordOperatorRepeat('delete', motionKey, motionCommand.motionCount.value * motionCommand.operatorCount.value);
        }
      }
      parser = makeParser(mode, selections);
    }

    /** T130: dot-repeat, wired only for the single-cursor delete-operator and plain-insert
     * targets T024 already models and tests; visual-change and put targets, and treating
     * an operator that entered insert as one atomic replay unit, remain unimplemented. */
    /** Replay one recorded insert session's literal text at `atOffset`, ending in Normal
     * mode exactly as a live Escape would; returns the cursor Escape would leave. Shared by
     * plain insert-target replay and the "delete then insert" combined change replay below. */
    /** prepareVimOperator's cursorOffset for a linewise delete's "next line" case is
     * computed against the pre-edit snapshot (see packages/vim/operators/core.ts's
     * cursorAfterOperator and its own oracle test's mapOffsetThroughEdits helper, which
     * exists precisely because callers, not that function, own translating it) -- it is
     * not yet a valid offset into the document the edit just produced. Map it through the
     * same DocumentChangeMap/anchor machinery packages/vim/multi.ts's mapOperatorCursors
     * already uses for the multi-cursor path, so a single delete-line cursor lands
     * correctly instead of one deleted-span's-length too far into the document. */
    function mapOffsetThroughCommit(beforeSnapshot: DocumentSnapshot, edits: readonly DocumentEdit[], offset: Utf16Offset): Utf16Offset {
      if (edits.length === 0) return offset;
      const afterVersion = ((beforeSnapshot.version as number) + 1) as DocumentSnapshot['version'];
      const changeMap = DocumentChangeMap.create(beforeSnapshot, afterVersion, edits);
      if (!changeMap.ok) return offset;
      const anchor = createDocumentAnchor(beforeSnapshot, offset, 'right');
      if (!anchor.ok) return offset;
      const mapped = changeMap.value.mapAnchor(anchor.value);
      return mapped.ok ? mapped.value.offset : offset;
    }

    function replayInsertText(entryKey: VimInsertEntryKey, text: string, atOffset: Utf16Offset): Utf16Offset {
      const entered = beginVimMultiInsert(document.snapshot(), [{ id: selections.primaryId, cursorOffset: atOffset }], entryKey, options.insertOptions ?? {});
      if (!entered.ok) return atOffset;
      commitPlan(document, entered.value.plan, undoOpen, (value) => { undoOpen = value; }, options.onDocumentChange);
      let session: VimMultiInsertSession | null = entered.value.session;
      for (const char of text) {
        if (session === null) break;
        const planned = planVimMultiInsertInput(document.snapshot(), session, { kind: 'key', key: char });
        if (!planned.ok) break;
        commitPlan(document, planned.value, undoOpen, (value) => { undoOpen = value; }, options.onDocumentChange);
        session = planned.value.nextSession;
      }
      let closedMembers: VimMultiInsertPlan['members'] | undefined;
      if (session !== null) {
        const closing = planVimMultiInsertInput(document.snapshot(), session, { kind: 'key', key: '<Esc>' });
        if (closing.ok) {
          commitPlan(document, closing.value, undoOpen, (value) => { undoOpen = value; }, options.onDocumentChange);
          closedMembers = closing.value.members;
        }
      }
      insert = null;
      const closedPrimary = closedMembers?.find((member) => member.id === selections.primaryId) ?? closedMembers?.[0];
      const transition = closedPrimary?.transition;
      return transition?.kind === 'exited' ? transition.plan.cursorOffset : offset(0);
    }

    /** Prepare+commit a linewise delete/change (e.g. 'dd'/'cc') at the current primary
     * cursor for `count` lines; returns the resulting cursor offset, or undefined on
     * failure. Mirrors the manual lineMotion construction in executeOperator's
     * operator-line branch above, since motionInvocation()/prepareVimMultiOperator only
     * understand real motion/text-object keys, not a linewise operator's own doubled key. */
    function replayLinewiseOperator(operator: 'delete' | 'change', motionKey: string, count: number, atOffset: Utf16Offset): Utf16Offset | undefined {
      const current = document.snapshot();
      const lineMotion = {
        origin: { documentVersion: current.version, offset: atOffset },
        target: { documentVersion: current.version, offset: atOffset },
        direction: 'forward' as const,
        motionKind: 'linewise' as const,
        inclusive: true,
        motionKey,
        forceKind: 'linewise' as const,
        lineCount: count,
      };
      const prepared = prepareVimOperator(current, {
        operator,
        motion: { ok: true, value: lineMotion },
        operatorCount: 1,
        motionCount: count,
        doubled: true,
        defaultYankRegister,
        state: { mode: 'normal', repeatTarget: null },
      });
      if (!prepared.ok || prepared.value.kind === 'failed') return undefined;
      const plan = prepared.value;
      if (plan.transaction !== null) {
        const opened = document.beginUndoGroup(OPERATOR_GROUP, 'vim');
        if (!opened.ok) return undefined;
        const committed = document.commit({ documentId: plan.transaction.documentId, expectedVersion: plan.transaction.expectedVersion, edits: plan.transaction.edits, origin: 'vim', undoGroup: OPERATOR_GROUP });
        if (!committed.ok) { document.endUndoGroup(OPERATOR_GROUP); return undefined; }
        if (!document.endUndoGroup(OPERATOR_GROUP).ok) return undefined;
        notifyCommitted(committed, options.onDocumentChange);
      }
      registers = applyRegisterEffect(registers, plan.registerEffect);
      // Only the delete/normal-mode cursor needs remapping; see mapOffsetThroughCommit's own
      // comment. The 'change' case's insertionOffset is the edit's own start and needs none.
      return plan.mode === 'insert' ? plan.cursorOffset : mapOffsetThroughCommit(current, plan.transaction?.edits ?? [], plan.cursorOffset);
    }

    function executeDotRepeat(providedCount: number | undefined): void {
      const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
      if (primary === undefined || primary.kind !== 'normal-cursor' || selections.members.length !== 1) return;
      // changeRepeatTarget carries no recorded count of its own (unlike the engine's
      // operator/insert targets below), so an explicit override or the Vim default of 1 apply.
      const explicitCount = providedCount ?? 1;

      if (lastRepeatKind === 'change' && changeRepeatTarget !== undefined) {
        const target = changeRepeatTarget;
        const deleteCursor = target.linewise
          ? replayLinewiseOperator('change', target.motionKey, explicitCount, primary.anchor.at.offset)
          : (() => {
              const motion = motionInvocation(target.motionKey, explicitCount);
              if (motion === null) return undefined;
              const prepared = prepareVimMultiOperator({
                snapshot: document.snapshot(), selections, operator: 'change', motion,
                operatorCount: 1, motionCount: explicitCount, defaultYankRegister, state: { mode: 'normal', repeatTarget: null },
                failurePolicy: 'reject-command',
              });
              if (!prepared.ok) return undefined;
              if (prepared.value.transaction !== null) {
                const opened = document.beginUndoGroup(OPERATOR_GROUP, 'vim');
                if (!opened.ok) return undefined;
                const committed = document.commit({
                  documentId: prepared.value.transaction.documentId, expectedVersion: prepared.value.transaction.expectedVersion,
                  edits: prepared.value.transaction.edits, origin: 'vim', undoGroup: OPERATOR_GROUP,
                });
                if (!committed.ok) { document.endUndoGroup(OPERATOR_GROUP); return undefined; }
                if (!document.endUndoGroup(OPERATOR_GROUP).ok) return undefined;
                notifyCommitted(committed, options.onDocumentChange);
              }
              for (const effect of prepared.value.registerEffects) registers = applyRegisterEffect(registers, effect);
              const primaryOffset = prepared.value.cursorOffsets.find((member) => member.id === selections.primaryId) ?? prepared.value.cursorOffsets[0];
              return primaryOffset?.offset ?? selectionOffset(selections.members[0]);
            })();
        if (deleteCursor === undefined) { message('xi: repeat unavailable for the last change\n'); return; }
        const cursor = replayInsertText('i', target.text, deleteCursor);
        mode = 'normal';
        selections = makeNormalSelection(document.snapshot(), cursor, (selections.selectionGeneration as number) + 1);
        motionCursor = makeMotionCursor(document.snapshot(), selections);
        parser = makeParser(mode, selections);
        changeRepeatTarget = target;
        lastRepeatKind = 'change';
        return;
      }

      const engineTarget = repeatState.target;
      if (engineTarget !== null && engineTarget.kind === 'operator' && engineTarget.forcedKind === 'linewise') {
        const linewiseCount = providedCount ?? engineTarget.count;
        const cursor = replayLinewiseOperator(engineTarget.operator, engineTarget.motionKey, linewiseCount, primary.anchor.at.offset);
        if (cursor === undefined) { message('xi: repeat unavailable for the last change\n'); return; }
        mode = 'normal';
        selections = makeNormalSelection(document.snapshot(), cursor, (selections.selectionGeneration as number) + 1, selections.primaryId);
        motionCursor = makeMotionCursor(document.snapshot(), selections);
        parser = makeParser(mode, selections);
        recordOperatorRepeat('delete', engineTarget.motionKey, linewiseCount, 'linewise');
        return;
      }

      type Resolved =
        | { readonly kind: 'operator'; readonly prepared: Extract<ReturnType<typeof prepareVimMultiOperator>, { readonly ok: true }>['value']; readonly motionKey: string }
        | { readonly kind: 'insert'; readonly entryKey: VimInsertEntryKey; readonly text: string; readonly count: number };
      const replay = replayVimDot(repeatState, {
        snapshot: document.snapshot(),
        cursorOffset: primary.anchor.at.offset,
        ...(providedCount === undefined ? {} : { count: providedCount }),
      }, (context): { ok: true; value: Resolved } | { ok: false; error: { readonly kind: 'invalid-target'; readonly reason: 'operator' | 'insert' | 'visual' | 'put' } } => {
        if (context.target.kind === 'operator') {
          const motion = motionInvocation(context.target.motionKey, context.count);
          if (motion === null) return { ok: false, error: { kind: 'invalid-target', reason: 'operator' } };
          const prepared = prepareVimMultiOperator({
            snapshot: context.snapshot,
            selections,
            operator: context.target.operator,
            motion,
            operatorCount: 1,
            motionCount: context.count,
            defaultYankRegister,
            state: { mode: 'normal', repeatTarget: null },
            failurePolicy: 'reject-command',
          });
          if (!prepared.ok) return { ok: false, error: { kind: 'invalid-target', reason: 'operator' } };
          return { ok: true, value: { kind: 'operator', prepared: prepared.value, motionKey: context.target.motionKey } };
        }
        if (context.target.kind === 'insert') return { ok: true, value: { kind: 'insert', entryKey: context.target.entryKey, text: context.target.text, count: context.count } };
        return { ok: false, error: { kind: 'invalid-target', reason: context.target.kind } };
      });
      if (!replay.ok) {
        message(replay.error.kind === 'no-target' ? 'xi: nothing to repeat\n' : 'xi: repeat unavailable for the last change\n');
        return;
      }
      const resolved = replay.value.resolved;
      if (resolved.kind === 'operator') {
        const prepared = resolved.prepared;
        if (prepared.transaction !== null) {
          const opened = document.beginUndoGroup(OPERATOR_GROUP, 'vim');
          if (!opened.ok) return;
          const committed = document.commit({
            documentId: prepared.transaction.documentId,
            expectedVersion: prepared.transaction.expectedVersion,
            edits: prepared.transaction.edits,
            origin: 'vim',
            undoGroup: OPERATOR_GROUP,
          });
          if (!committed.ok) { document.endUndoGroup(OPERATOR_GROUP); return; }
          if (!document.endUndoGroup(OPERATOR_GROUP).ok) return;
          notifyCommitted(committed, options.onDocumentChange);
        }
        for (const effect of prepared.registerEffects) registers = applyRegisterEffect(registers, effect);
        const primaryOffset = prepared.cursorOffsets.find((member) => member.id === selections.primaryId) ?? prepared.cursorOffsets[0];
        const cursor = primaryOffset?.offset ?? selectionOffset(selections.members[0]);
        mode = 'normal';
        selections = makeNormalSelection(document.snapshot(), cursor, (selections.selectionGeneration as number) + 1, selections.primaryId);
        motionCursor = makeMotionCursor(document.snapshot(), selections);
        parser = makeParser(mode, selections);
        recordOperatorRepeat('delete', resolved.motionKey, replay.value.count);
        return;
      }
      // A recorded insert's count multiplies the replayed text just as it multiplied the
      // original insertion (see packages/vim/insert/index.ts's own count-repeat at Escape).
      const cursor = replayInsertText(resolved.entryKey, resolved.text.repeat(resolved.count), primary.anchor.at.offset);
      mode = 'normal';
      selections = makeNormalSelection(document.snapshot(), cursor, (selections.selectionGeneration as number) + 1);
      motionCursor = makeMotionCursor(document.snapshot(), selections);
      parser = makeParser(mode, selections);
      const created = createVimInsertRepeatTarget({ entryKey: resolved.entryKey, mode: 'insert', text: resolved.text, count: resolved.count });
      if (created.ok) {
        const recorded = recordVimRepeatTarget(repeatState, created.value);
        if (recorded.ok) { repeatState = recorded.value; lastRepeatKind = 'engine'; }
      }
    }

    // nvim --clean v_star-default/v_#-default: Visual `*`/`#` searches forward/backward
    // for the exact selected text as a literal (`\V`) pattern -- no `\<...\>` word
    // boundaries (unlike Normal `*`/`#`) -- and leaves Visual mode on the primary member.
    async function executeVisualStarHash(key: '*' | '#', atMode: VimMode): Promise<void> {
      const target = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
      let resultCursor = target === undefined ? offset(0) : selectionOffset(target);
      if (target !== undefined) {
        const snapshotNow = document.snapshot();
        const range = normalizeVimOperatorRange(snapshotNow, {
          origin: { documentVersion: snapshotNow.version, offset: target.anchor.at.offset },
          target: { documentVersion: snapshotNow.version, offset: target.head.at.offset },
          direction: (target.head.at.offset as number) >= (target.anchor.at.offset as number) ? 'forward' : 'backward',
          motionKind: atMode === 'visual-line' ? 'linewise' : 'characterwise',
          inclusive: true,
          motionKey: key,
          operator: 'yank',
        });
        const text = range.ok ? snapshotNow.slice(range.value.start, range.value.end) : undefined;
        if (text?.ok && text.value.length > 0) {
          const view = { cursor: target.anchor.at.offset, desiredDisplayColumn: 0, scrollTop: 0, scrollLeft: 0 };
          const result = await runInteractiveVimSearch(snapshotNow, view, {
            command: 'search',
            pattern: literalPattern(text.value),
            direction: key === '*' ? 'forward' : 'backward',
          });
          if (result !== undefined && result.ok) {
            searchState = result.value.state;
            if (result.value.outcome.kind === 'found') resultCursor = result.value.outcome.match.cursor;
          }
        }
      }
      mode = 'normal';
      selections = makeNormalSelection(document.snapshot(), resultCursor, (selections.selectionGeneration as number) + 1, selections.primaryId);
      motionCursor = makeMotionCursor(document.snapshot(), selections);
      parser = makeParser(mode, selections);
    }

    function executeVisualOperator(key: 'd' | 'c' | 'y'): void {
      const prepared = prepareVimMultiOperator({
        snapshot: document.snapshot(),
        selections,
        operator: key === 'd' ? 'delete' : key === 'c' ? 'change' : 'yank',
        defaultYankRegister,
        state: { mode: 'normal', repeatTarget: null },
        failurePolicy: 'reject-command',
      });
      if (!prepared.ok) return;
      if (prepared.value.transaction !== null) {
        const opened = document.beginUndoGroup(OPERATOR_GROUP, 'vim');
        if (!opened.ok) return;
        const committed = document.commit({ documentId: prepared.value.transaction.documentId, expectedVersion: prepared.value.transaction.expectedVersion, edits: prepared.value.transaction.edits, origin: 'vim', undoGroup: OPERATOR_GROUP });
        if (!committed.ok || !document.endUndoGroup(OPERATOR_GROUP).ok) return;
        notifyCommitted(committed, options.onDocumentChange);
      }
      for (const effect of prepared.value.registerEffects) registers = applyRegisterEffect(registers, effect);
      const primary = prepared.value.cursorOffsets.find((member) => member.id === selections.primaryId) ?? prepared.value.cursorOffsets[0];
      mode = 'normal';
      selections = makeNormalSelection(document.snapshot(), primary?.offset ?? offset(0), (selections.selectionGeneration as number) + 1, selections.primaryId);
      motionCursor = makeMotionCursor(document.snapshot(), selections);
      parser = makeParser(mode, selections);
    }

    function applyOperatorPlan(
      plan: Extract<VimOperatorPreparation, { readonly kind: 'prepared' }>,
      deleteLineRepeat?: { readonly motionKey: string; readonly count: number },
      changeLineMotionKey?: string,
    ): void {
      const beforeSnapshot = document.snapshot();
      // A change (cc/...) shares one undo group with the insert text that follows the
      // delete, matching Neovim's single undo step; left open here, closed by commitPlan.
      const group = plan.mode === 'insert' ? INSERT_GROUP : OPERATOR_GROUP;
      if (plan.transaction !== null) {
        const opened = document.beginUndoGroup(group, 'vim');
        if (!opened.ok) return;
        const committed = document.commit({ documentId: plan.transaction.documentId, expectedVersion: plan.transaction.expectedVersion, edits: plan.transaction.edits, origin: 'vim', undoGroup: group });
        if (!committed.ok) { document.endUndoGroup(group); return; }
        if (plan.mode === 'insert') { undoOpen = true; } else if (!document.endUndoGroup(group).ok) return;
        notifyCommitted(committed, options.onDocumentChange);
      }
      registers = applyRegisterEffect(registers, plan.registerEffect);
      // Only the delete/normal-mode cursor needs this: prepareVimOperator's insertionOffset
      // for a 'change' plan is the start of the edit and stays valid pre- and post-commit.
      const cursor = plan.mode === 'insert' ? plan.cursorOffset : mapOffsetThroughCommit(beforeSnapshot, plan.transaction?.edits ?? [], plan.cursorOffset);
      if (plan.mode === 'insert') {
        const primaryId = selections.primaryId;
        const entered = beginVimMultiInsert(document.snapshot(), [{ id: primaryId, cursorOffset: cursor }], 'i', options.insertOptions ?? {});
        if (!entered.ok) return;
        commitPlan(document, entered.value.plan, undoOpen, (value) => { undoOpen = value; }, options.onDocumentChange);
        insert = entered.value.session;
        mode = entered.value.session.mode;
        selections = makeInsertSelections(document.snapshot(), insert, (selections.selectionGeneration as number) + 1);
        motionCursor = undefined;
        beginInsertRecording('i');
        if (changeLineMotionKey !== undefined) pendingChangeOperatorMotion = { motionKey: changeLineMotionKey, linewise: true };
      } else {
        mode = 'normal';
        selections = makeNormalSelection(document.snapshot(), cursor, (selections.selectionGeneration as number) + 1, selections.primaryId);
        motionCursor = makeMotionCursor(document.snapshot(), selections);
        if (deleteLineRepeat !== undefined) recordOperatorRepeat('delete', deleteLineRepeat.motionKey, deleteLineRepeat.count, 'linewise');
      }
      parser = makeParser(mode, selections);
    }

    function executeLiteral(command: Extract<VimCommandIntent, { readonly kind: 'literal-command' }>): void {
      const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
      if (isVisualMode(mode) && (command.command === 'find-forward' || command.command === 'find-backward'
        || command.command === 'till-forward' || command.command === 'till-backward')) {
        const key = command.command === 'find-forward' ? 'f' : command.command === 'find-backward' ? 'F' : command.command === 'till-forward' ? 't' : 'T';
        const found = resolveVimMultiVisualFind({ snapshot: document.snapshot(), selections,
          invocation: { key, target: command.argument, count: command.count.value }, lastFind, failurePolicy: 'retain-failed' });
        if (!found.ok) return;
        lastFind = found.value.lastFind;
        selections = found.value.selection;
        parser = makeParser(mode, selections);
        return;
      }
      if (primary === undefined || primary.kind !== 'normal-cursor') return;
      if (command.command === 'record-macro') {
        // Unreachable through the keyboard today (bare 'q' is intercepted earlier for
        // the quit-shortcut/stop-recording split above); kept correct and complete in
        // case another path ever feeds this literal-command synthetically.
        beginMacroRecordingInternal(command.argument);
        parser = makeParser(mode, selections);
        return;
      }
      if (command.command === 'play-macro' && command.argument === ':') {
        if (lastExCommand === undefined) { message('xi: no previous command line\n'); return; }
        for (let repeat = 0; repeat < command.count.value; repeat += 1) void executeExCommand(lastExCommand);
        return;
      }
      if (command.command === 'play-macro') {
        const execution = executeVimMacro(macroStore, command.argument, (context) => {
          if (context.token.kind === 'key') replayMacroKey(context.token.key);
          return { ok: true, value: { kind: 'continue', committed: true } };
        }, { count: command.count.value, ...(lastMacroRegister === undefined ? {} : { lastRegister: lastMacroRegister }) });
        if (!execution.ok) { message(`xi: macro ${execution.error.kind}\n`); return; }
        lastMacroRegister = execution.value.lastRegister;
        return;
      }
      if (command.command === 'find-forward' || command.command === 'find-backward' || command.command === 'till-forward' || command.command === 'till-backward') {
        ghostMotionKey = 'find';
        const key = command.command === 'find-forward' ? 'f' : command.command === 'find-backward' ? 'F' : command.command === 'till-forward' ? 't' : 'T';
        const cursor = makeMotionCursor(document.snapshot(), selections);
        if (cursor === undefined) return;
        const found = resolveVimFind(document.snapshot(), cursor, { key, target: command.argument, count: command.count.value }, lastFind);
        if (!found.ok) return;
        // A direct f/F/t/T becomes the repeat target even without a match (Neovim
        // parity, see motions/find.ts's own contract), so lastFind updates either way.
        lastFind = found.value.lastFind;
        if (found.value.kind !== 'found') { parser = makeParser(mode, selections); return; }
        selections = makeNormalSelection(document.snapshot(), found.value.cursor.offset, (selections.selectionGeneration as number) + 1, selections.primaryId);
        motionCursor = found.value.cursor;
        parser = makeParser(mode, selections);
        return;
      }
      if (command.command === 'replace-character' || command.command === 'virtual-replace') {
        const key = command.command === 'replace-character' ? 'r' : 'gr';
        const prepared = prepareVimDirectChange({
          snapshot: document.snapshot(), key, cursorOffset: primary.anchor.at.offset,
          count: command.count.value, replacement: command.argument,
          state: { mode: 'normal', repeatTarget: null },
        });
        if (!prepared.ok || prepared.value.transaction === null) return;
        const opened = document.beginUndoGroup(DIRECT_GROUP, 'vim');
        if (!opened.ok) return;
        const committed = document.commit({ documentId: prepared.value.transaction.documentId, expectedVersion: prepared.value.transaction.expectedVersion, edits: prepared.value.transaction.edits, origin: 'vim', undoGroup: DIRECT_GROUP });
        if (!committed.ok || !document.endUndoGroup(DIRECT_GROUP).ok) return;
        notifyCommitted(committed, options.onDocumentChange);
        selections = makeNormalSelection(document.snapshot(), prepared.value.cursorOffset, (selections.selectionGeneration as number) + 1, selections.primaryId);
        motionCursor = makeMotionCursor(document.snapshot(), selections);
        parser = makeParser(mode, selections);
      }
    }

    function executePrefixed(command: Extract<VimCommandIntent, { readonly kind: 'prefixed-key' }>): void | Promise<void> {
      const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
      if (isVisualMode(mode) && (command.prefix === 'left-bracket' || command.prefix === 'right-bracket')
        && ['[', ']', '(', ')', '{', '}'].includes(command.key)) {
        const key = `${command.prefix === 'left-bracket' ? '[' : ']'}${command.key}` as VimStructuralMotionKey;
        const invocation = { key, ...(command.count.explicit ? { count: command.count.value } : {}) };
        const moved = resolveVimMultiVisualMotion({ snapshot: document.snapshot(), selections, invocation, failurePolicy: 'reject-command' });
        if (moved.ok) {
          selections = moved.value.selection;
          parser = makeParser(mode, selections);
        }
        return;
      }
      if (isVisualMode(mode) && command.prefix === 'g') {
        const invocation = motionInvocation(`g${command.key}`, command.count.explicit ? command.count.value : undefined);
        if (invocation !== null) {
          const moved = resolveVimMultiVisualMotion({ snapshot: document.snapshot(), selections, invocation, failurePolicy: 'reject-command' });
          if (moved.ok) {
            selections = moved.value.selection;
            parser = makeParser(mode, selections);
          }
          return;
        }
      }
      if (mode === 'normal' && command.prefix === 'g' && (command.key === ']' || command.key === '<C-]>')) {
        const target = hostTarget(document.snapshot(), primary);
        if (target !== undefined) emitHostCommand({ kind: 'open-tag', name: target.target, split: false, selection: 'select' });
        return;
      }
      if (mode === 'normal' && command.prefix === 'g' && (command.key === 'd' || command.key === 'D')) {
        const target = hostTarget(document.snapshot(), primary);
        if (target !== undefined) emitHostCommand({ kind: 'lookup', target: target.target, lookup: 'definition' });
        return;
      }
      if (mode === 'normal' && command.prefix === 'g' && command.key === '<') {
        emitHostCommand({ kind: 'lookup', target: '', lookup: 'command-output' });
        return;
      }
      if (mode === 'normal' && command.prefix === 'g' && (command.key === '*' || command.key === '#')) {
        return runSearchCommand(command.key === '*' ? 'gstar' : 'ghash', command.count.value).then(() => undefined);
      }
      if (mode === 'normal' && (command.prefix === 'g' || command.prefix === 'ctrl-w' || command.prefix === 'ctrl-w-g')
        && (command.key === 'f' || command.key === 'F')) {
        const target = hostTarget(document.snapshot(), primary, command.key === 'F');
        if (target !== undefined) emitHostCommand({
          kind: 'open-file', target: target.target,
          ...(target.line === undefined ? {} : { line: target.line }),
          split: command.prefix !== 'g',
        });
        return;
      }
      if (mode === 'normal' && (command.prefix === 'ctrl-w' || command.prefix === 'ctrl-w-g')
        && (command.key === ']' || command.key === '}')) {
        const target = hostTarget(document.snapshot(), primary);
        if (target !== undefined) emitHostCommand({ kind: 'open-tag', name: target.target, split: true, selection: 'unique' });
        return;
      }
      if (mode === 'normal' && (command.prefix === 'left-bracket' || command.prefix === 'right-bracket')
        && (command.key === 'd' || command.key === 'D' || command.key === '<C-d>' || command.key === '<C-i>')) {
        const target = hostTarget(document.snapshot(), primary);
        if (target !== undefined) emitHostCommand({
          kind: 'include', target: target.target,
          direction: command.prefix === 'left-bracket' ? 'previous' : 'next',
          list: command.key === 'D',
        });
        return;
      }
      if (mode === 'normal' && (command.prefix === 'ctrl-w' || command.prefix === 'ctrl-w-g')) {
        const action = hostWindowAction(command.prefix, command.key);
        if (action !== undefined) emitHostCommand({ kind: 'window', action, count: command.count.value });
        return;
      }
      if (mode === 'normal' && command.prefix === 'g' && (command.key === 'R' || command.key === 'I')) {
        const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
        if (primary === undefined) return;
        const entered = beginVimMultiInsert(document.snapshot(), [{ id: primary.id, cursorOffset: primary.anchor.at.offset }], `g${command.key}` as VimInsertEntryKey, options.insertOptions ?? {}, command.count.value);
        if (!entered.ok) return;
        commitPlan(document, entered.value.plan, undoOpen, (value) => { undoOpen = value; }, options.onDocumentChange);
        insert = entered.value.session;
        mode = entered.value.session.mode;
        selections = makeInsertSelections(document.snapshot(), insert, (selections.selectionGeneration as number) + 1);
        motionCursor = undefined;
        parser = makeParser(mode, selections);
        beginInsertRecording(`g${command.key}` as VimInsertEntryKey);
        return;
      }
      if (mode === 'normal' && command.prefix === 'g') {
        const key = `g${command.key}`;
        if (key === 'ga' || key === 'g8') {
          const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
          if (primary !== undefined) {
            const info = resolveVimCharacterInfo(document.snapshot(), primary.anchor.at.offset);
            if (info.ok) {
              const codePoints = info.value.codePoints.map((point) => `U+${point.toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
              message(`xi: ${key === 'ga' ? `${info.value.grapheme} ${codePoints}` : info.value.utf8Hex}\n`);
            }
          }
          return;
        }
        // The ghost classifies the whole `gg`/`g_`/`ge` motion, not the final raw `g` keystroke.
        ghostMotionKey = key;
        ghostMotionCount = command.count.value;
        const invocation = motionInvocation(key, command.count.value);
        if (invocation !== null && motionCursor !== undefined) {
          const moved = resolveVimMotion(document.snapshot(), motionCursor, invocation as Parameters<typeof resolveVimMotion>[2]);
          if (moved.ok) {
            motionCursor = moved.value.cursor;
            selections = makeNormalSelection(document.snapshot(), moved.value.cursor.offset, (selections.selectionGeneration as number) + 1, selections.primaryId);
            parser = makeParser(mode, selections);
    }

  }
}
    }
  return session;
  }
