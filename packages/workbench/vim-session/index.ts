import { asCellColumn, asIdentifier, asLineIndex, asUtf16Offset, type UndoGroupId, type ViewId, type Utf16Offset } from '../../contracts/src/index';
import type { CanonicalInputEvent } from '../../contracts/src/index';
import type { CommittedDocumentChange, DocumentEdit, DocumentReadPort, DocumentSnapshot, TextFileDocument } from '../../document/src/index';
import { createDocumentAnchor, DocumentChangeMap } from '../../document/src/index';
import { createSelectionSet, mapSelectionSet, updateSelectionSet, type SelectionSetSnapshot, type SelectionMemberInput } from '../../selections/src/index';
import {
  beginVimMultiInsert,
  createVimMotionCursor,
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
  resolveVimMultiVisualMotion,
  resolveVimCharacterInfo,
  resolveVimFind,
  prepareVimPutFromBank,
  type VimMode,
  type VimMultiMotionInvocation,
  type VimCoreOperator,
  type VimOperatorPreparation,
  type VimLastFind,
  type VimVisualKind,
  type VimVisualCursor,
  type VimCommandIntent,
  type VimDirectChangeKey,
  type VimInsertEntryKey,
  type VimMultiInsertPlan,
  type VimMultiInsertSession,
  type VimMotionCursor,
  type VimMotionKey,
  type VimParserState,
  type VimTextObjectKey,
  type VimWordMotionKey,
  type VimSelectionCommand,
} from '../../vim/src/entrypoints/launch';
import type { WorkbenchReadPort, WorkbenchViewSnapshot } from '../src/read-model';
import type { VimHostCommand } from '../../vim/src/index';
import {
  createVimInsertRepeatTarget,
  createVimOperatorRepeatTarget,
  createVimRepeatState,
  recordVimRepeatTarget,
  replayVimDot,
  type VimRepeatState,
} from '../../vim/src/index';
import {
  beginVimMacroRecording,
  commitVimMacroRecording,
  createVimMacroStore,
  executeVimMacro,
  recordVimMacroKey,
  type VimMacroRecordingSession,
  type VimMacroRegisterName,
  type VimMacroStore,
} from '../../vim/src/index';
import type { PointerCell, PointerSelectionIntent } from '../../vim/src/entrypoints/launch';
import type { PrefixHelpParserContinuation } from '../commands/prefix-help';
import { createVimRegisterBank, type VimRegisterBank, type VimRegisterName, type VimRegisterType } from '../../vim/src/entrypoints/launch';
import type { OwnedVimKeyEvent, OwnedVimSessionOptions, OwnedVimSession, VimPrefixHelpState, VimCommandLineState } from './types';
export type { OwnedVimKeyEvent, OwnedVimSessionOptions, OwnedVimSession, VimPrefixHelpState, VimCommandLineState } from './types';
import { hostTarget, hostWindowAction, isHostTokenCharacter } from './host-commands';
import { parseXiSelectionCommand, selectionModeFor, SELECTION_COMMANDS, PATTERN_SELECTION_COMMANDS, SELECTION_HISTORY_LIMIT, type XiSelectionCommandInput } from './selection-commands';
import { addPointerCaret, pointerVisualCursor, pointerWordRange } from './pointer';
import { commitPlan, makeInsertSelections, mapExternalInsertSession, INSERT_GROUP } from './insert-plan';
import {
  applyRegisterEffect,
  buildParser,
  coreOperator,
  encodeKeyBytes,
  id,
  isDirectChangeKey,
  isInsertEntryKey,
  isInsertMode,
  isMotionKey,
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

export function createOwnedVimSession(document: TextFileDocument, options: OwnedVimSessionOptions): OwnedVimSession {
  const documentId = document.id;
  const viewId = options.viewId;
  const snapshot = document.snapshot();
  let mode: VimMode = options.initialMode ?? 'normal';
  let selections = options.initialSelections ?? makeSelection(snapshot, options.initialLine);
  let parser = buildParser(mode, selections);
  // Reuses the current parser state when neither mode nor the selection set
  // reference changed (a no-op key, e.g. a boundary motion or repeated
  // Escape) instead of rebuilding it every key. `parser` is this session's
  // own closure variable, so this cannot leak across concurrent sessions.
  function makeParser(nextMode: VimMode, nextSelections: SelectionSetSnapshot): VimParserState {
    if (parser.session.mode === nextMode && parser.session.selections === nextSelections) return parser;
    return buildParser(nextMode, nextSelections);
  }
  let insert: VimMultiInsertSession | null = null;
  let motionCursor = makeMotionCursor(document.snapshot(), selections);
  let undoOpen = false;
  let registers: VimRegisterBank = createVimRegisterBank();
  let lastFind: VimLastFind | null = null;
  let commandLine: string | undefined;
  let commandLineCursorOffset = 0;
  let prefixKeys: readonly string[] = EMPTY_PREFIX_KEYS;
  // `prefixKeys` and `parser.legalContinuations` are already frozen at their
  // source (updatePrefixKeys / freezeContinuations), and both are replaced
  // by reference (never mutated in place) whenever their content actually
  // changes. Memoizing on that reference pair turns the common no-pending
  // key into a cache hit instead of reallocating on every keystroke.
  let prefixHelpCache: { readonly keys: readonly string[]; readonly continuations: VimPrefixHelpState['parserContinuations']; readonly value: VimPrefixHelpState } | undefined;
  let selectionHistory: SelectionSetSnapshot[] = [];
  // Dot-repeat (T130): a single most-recent semantic target, matching T024's tested
  // model exactly (operator xor insert xor visual xor put; last completed one wins).
  // Only the delete/change-motion and plain-insert cases below are wired; visual-change
  // and put targets remain unwired. An operator that transitions into insert (e.g. 'ciw')
  // *is* replayed as one atomic "delete then insert" unit, but through a session-local
  // `changeRepeatTarget` alongside T024's own repeatState (its schema has no combined
  // variant) rather than by extending T024's already oracle-tested module itself.
  let repeatState: VimRepeatState = createVimRepeatState();
  let insertEntryKey: VimInsertEntryKey | undefined;
  let insertTypedChars: string[] = [];
  let insertTainted = false;
  let pendingChangeOperatorMotion: { readonly motionKey: string; readonly linewise: boolean } | undefined;
  let changeRepeatTarget: { readonly motionKey: string; readonly text: string; readonly linewise: boolean } | undefined;
  let lastRepeatKind: 'engine' | 'change' = 'engine';
  // Macro record/playback (T130). Starting a recording is exposed through
  // beginMacroRecording (see the leader-key wiring in apps/xi/src/main.ts) rather than
  // through the parser's own 'q'+register literal-command, because bare 'q' in Normal mode
  // is already Xi's documented quick-quit shortcut (docs/evidence/T038.md) and that
  // extensively-relied-upon, already-shipped behavior is out of scope to remove here.
  // Stopping (bare 'q' while a recording is active) and playback (real '@'/'@@' keys) have
  // no such conflict and are wired to their natural Vim keys below.
  let macroStore: VimMacroStore = createVimMacroStore();
  let macroRecording: VimMacroRecordingSession | null = null;
  let lastMacroRegister: VimMacroRegisterName | undefined;
  // No timers or document/prefix-help subscriptions are held by this factory: every
  // handle above is a plain closure variable owned by this session. dispose() only
  // needs to drop pending state and stop publishing further state changes.
  let disposed = false;
  const readPort: DocumentReadPort = {
    snapshot: () => document.snapshot(),
    slice: (start, end, expectedVersion) => document.slice(start, end, expectedVersion),
  };

  function handleKey(event: OwnedVimKeyEvent): boolean | 'quit' | Promise<boolean | 'quit'> {
    if (disposed) return true;
    const key = keyName(event);
    if (canHandleSynchronously(event, key)) {
      const result = handleSynchronousKey(event, key);
      options.onStateChange?.({ selections, mode });
      publishAuxiliaryState();
      return result;
    }
    return handleKeyInternal(event).then((result) => {
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
        commandLine = undefined;
        commandLineCursorOffset = 0;
        return true;
      }
      if (key === '<BS>') {
        commandLine = commandLine.slice(0, -1);
        commandLineCursorOffset = Math.max(1, commandLineCursorOffset - 1);
        return true;
      }
      if (key === '<CR>' || key === '<NL>') {
        return submitCommandLine(`:${commandLine}`);
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
    if (!isInsertMode(mode) && key === ':') {
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
    if (mode === 'normal' && event.ctrl && (key === 'c' || key === 'C')) return false;
      const input: CanonicalInputEvent = {
      kind: 'key',
      key,
      phase: 'press',
      modifiers: Object.freeze({ shift: event.shift, alt: event.option, ctrl: event.ctrl, meta: event.meta }),
      rawBytes: encodeKeyBytes(event.raw),
      };
      const normalized = normalizeVimInput(input, { monotonicMilliseconds: () => performance.now() });
      if (!normalized.ok) return true;
    const outcome = parseVimInput(parser, normalized.value);
    parser = outcome.state;
    updatePrefixKeys(key, outcome.kind);
    if (outcome.kind !== 'command') return true;
      executeCommand(outcome.command);
      return true;
  }

  function canHandleSynchronously(event: OwnedVimKeyEvent, key: string): boolean {
    return commandLine === undefined
      && !(!isInsertMode(mode) && key === ':')
      && !(event.ctrl && (key === 's' || key === 'S'))
      && !(mode === 'normal' && key === 'q')
      && !(mode === 'normal' && event.ctrl && (key === 'c' || key === 'C'));
  }

  function handleSynchronousKey(event: OwnedVimKeyEvent, key: string): boolean {
    recordMacroKeyIfActive(key);
    const input: CanonicalInputEvent = {
      kind: 'key',
      key,
      phase: 'press',
      modifiers: Object.freeze({ shift: event.shift, alt: event.option, ctrl: event.ctrl, meta: event.meta }),
      rawBytes: encodeKeyBytes(event.raw),
    };
    const normalized = normalizeVimInput(input, { monotonicMilliseconds: () => performance.now() });
    if (!normalized.ok) return true;
    const outcome = parseVimInput(parser, normalized.value);
    parser = outcome.state;
    updatePrefixKeys(key, outcome.kind);
    if (outcome.kind === 'command') executeCommand(outcome.command);
    return true;
  }

  function message(value: string): void { options.onMessage?.(value); }

  /** Every user keystroke while a macro is recording is appended verbatim, except the
   * terminating bare 'q' itself (handled separately, see the 'q' branch below). */
  function recordMacroKeyIfActive(key: string): void {
    if (macroRecording === null || (mode === 'normal' && key === 'q')) return;
    const recorded = recordVimMacroKey(macroRecording, { key, source: 'user' });
    if (recorded.ok) macroRecording = recorded.value;
  }

  /** Replay one recorded key through the same parse+execute path a live keystroke uses.
   * Ex-command-line sequences (a ':' key) are not replayed -- a disclosed limitation,
   * not attempted, since the session's Ex submission is asynchronous and this dispatch
   * loop (packages/vim/macros/index.ts's executeVimMacro) is synchronous. */
  function replayMacroKey(key: string): void {
    if (key === ':') return;
    const normalized = { kind: 'key' as const, key, phase: 'press' as const, modifiers: Object.freeze({ shift: false, alt: false, ctrl: false, meta: false }), atMilliseconds: performance.now() };
    const outcome = parseVimInput(parser, normalized);
    parser = outcome.state;
    if (outcome.kind === 'command') executeCommand(outcome.command);
  }

  function beginMacroRecordingInternal(register: string): boolean {
    if (mode !== 'normal' || macroRecording !== null) return false;
    const started = beginVimMacroRecording(register);
    if (!started.ok) return false;
    macroRecording = started.value;
    return true;
  }

  function beginInsertRecording(entryKey: VimInsertEntryKey): void {
    insertEntryKey = entryKey;
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
    if (entryKey === undefined || insertTainted) return;
    const text = insertTypedChars.join('');
    if (changeMotion !== undefined) {
      changeRepeatTarget = { motionKey: changeMotion.motionKey, text, linewise: changeMotion.linewise };
      lastRepeatKind = 'change';
      return;
    }
    if (text.length === 0) return;
    const created = createVimInsertRepeatTarget({ entryKey, mode: 'insert', text });
    if (!created.ok) return;
    const recorded = recordVimRepeatTarget(repeatState, created.value);
    if (recorded.ok) { repeatState = recorded.value; lastRepeatKind = 'engine'; }
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
    get commandLineActive(): boolean { return commandLine !== undefined; },
    get commandLine(): VimCommandLineState | undefined { return readCommandLine(); },
    get prefixHelp(): VimPrefixHelpState { return readPrefixHelp(); },
    readView(candidate): WorkbenchViewSnapshot | undefined {
      return candidate === viewId ? makeView(viewId, documentId, document.snapshot(), selections, mode) : undefined;
    },
    readDocument(candidate): DocumentReadPort | undefined { return candidate === viewId ? readPort : undefined; },
    handleKey,
    cancelPendingOperator(): void {
      if (disposed || commandLine !== undefined) return;
      parser = makeParser(mode, selections);
      prefixKeys = EMPTY_PREFIX_KEYS;
      options.onPrefixStateChange?.(readPrefixHelp());
    },
    applyExternalChange(change): void {
      if (disposed || change.documentId !== documentId || selections.documentVersion !== change.before) return;
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
      if (disposed || mode !== 'normal' || !Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(utf16Column) || utf16Column < 0) return false;
      const current = document.snapshot();
      const lineIndex = asLineIndex(Math.min(line, Math.max(0, current.lineCount - 1)));
      if (!lineIndex.ok) return false;
      const start = current.lineStartOffset(lineIndex.value);
      if (!start.ok) return false;
      const requested = Math.min((start.value as number) + utf16Column, current.lengthUtf16);
      selections = makeNormalSelection(current, requested as Utf16Offset, (selections.selectionGeneration as number) + 1, selections.primaryId);
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
      const started = beginVimVisualSelection(current, primary.id, effectiveAnchor, visualKind);
      if (!started.ok) return false;
      const extended = extendVimVisualSelection(current, started.value, [{ id: primary.id, cursor: effectiveHead }]);
      if (!extended.ok) return false;
      selections = extended.value;
      mode = visualKind;
      motionCursor = undefined;
      parser = makeParser(mode, selections);
      options.onStateChange?.({ selections, mode });
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
      options.onCommandLineChange?.(readCommandLine());
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
        const cursor = transition?.kind === 'exited' ? transition.lastInsertCursorOffset : planned.value.members[0]?.transition.plan.cursorOffset;
        selections = makeNormalSelection(document.snapshot(), cursor ?? offset(0), (selections.selectionGeneration as number) + 1);
        motionCursor = makeMotionCursor(document.snapshot(), selections);
        insertEntryKey = undefined;
      } else {
        selections = makeInsertSelections(document.snapshot(), insert, (selections.selectionGeneration as number) + 1);
      }
      parser = makeParser(mode, selections);
      return true;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      commandLine = undefined;
      commandLineCursorOffset = 0;
      prefixKeys = EMPTY_PREFIX_KEYS;
      macroRecording = null;
      insert = null;
      motionCursor = undefined;
    },
  };

  options.onStateChange?.({ selections, mode });
  publishAuxiliaryState();

  function readCommandLine(): VimCommandLineState | undefined {
    return commandLine === undefined
      ? undefined
      : Object.freeze({ source: `:${commandLine}`, cursorOffset: commandLineCursorOffset });
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
    options.onCommandLineChange?.(readCommandLine());
  }

  function updatePrefixKeys(key: string, outcomeKind: string): void {
    prefixKeys = outcomeKind === 'pending' ? Object.freeze([...prefixKeys, key]) : EMPTY_PREFIX_KEYS;
  }

  async function submitCommandLine(source: string): Promise<boolean | 'quit'> {
    const entered = source.startsWith(':') ? source.slice(1) : source;
    commandLine = undefined;
    commandLineCursorOffset = 0;
    options.onCommandLineChange?.(undefined);
    const hostResult = await options.onExCommand?.(entered);
    if (hostResult === 'handled') return true;
    if (hostResult === 'quit') return 'quit';
    const result = await executeExCommand(entered);
    return result === 'quit' ? 'quit' : true;
  }

    async function executeExCommand(source: string): Promise<'quit' | 'stay'> {
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
            documentId: prepared.value.edits.length > 0 ? current.id : current.id,
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
        ...(command.limit === undefined ? {} : { limit: command.limit }),
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
        selectionHistory = [before, ...selectionHistory].slice(0, SELECTION_HISTORY_LIMIT);
      }
      selections = result.value.selection;
      mode = selectionModeFor(selections.members[0]?.kind);
      motionCursor = mode === 'normal' ? makeMotionCursor(current, selections) : undefined;
      parser = makeParser(mode, selections);
      message(`xi: ${command.command} · ${selections.members.length} selection${selections.members.length === 1 ? '' : 's'}\n`);
    }

    function executeCommand(command: VimCommandIntent): void {
      const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
      if (command.kind === 'mode-transition' && mode === 'normal' && isVisualMode(command.to)) {
        const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
        if (primary === undefined || primary.kind !== 'normal-cursor') return;
        const cellColumn = asCellColumn(0);
        if (!cellColumn.ok) return;
        const started = beginVimVisualSelection(document.snapshot(), primary.id, {
          documentVersion: document.snapshot().version,
          offset: primary.anchor.at.offset,
          displayCellColumn: cellColumn.value,
        }, command.to as VimVisualKind);
        if (!started.ok) return;
        selections = started.value;
        mode = command.to;
        motionCursor = undefined;
        parser = makeParser(mode, selections);
        return;
      }
      if (command.kind === 'mode-transition' && command.to === 'insert' && mode === 'normal') {
        const key = command.key;
        if (!isInsertEntryKey(key)) return;
        const members = selections.members.map((member) => ({ id: member.id, cursorOffset: member.anchor.at.offset }));
        const entered = beginVimMultiInsert(document.snapshot(), members, key, {}, command.count.value);
        if (!entered.ok) throw new Error(`xi-enter-insert:${entered.error.kind}`);
        commitPlan(document, entered.value.plan, undoOpen, (value) => { undoOpen = value; }, options.onDocumentChange);
        mode = entered.value.session.mode;
        insert = entered.value.session;
        motionCursor = undefined;
        selections = makeInsertSelections(document.snapshot(), insert, (selections.selectionGeneration as number) + 1);
        parser = makeParser(mode, selections);
        if (members.length === 1) beginInsertRecording(key); else insertEntryKey = undefined;
        return;
      }
      if (command.kind === 'insert-key' && isInsertMode(mode) && insert !== null) {
        const planned = planVimMultiInsertInput(document.snapshot(), insert, { kind: 'key', key: command.key });
        if (!planned.ok) throw new Error(`xi-insert:${planned.error.kind}`);
        commitPlan(document, planned.value, undoOpen, (value) => { undoOpen = value; }, options.onDocumentChange);
        if (insertEntryKey !== undefined) {
          const character = command.key === '<Space>' ? ' ' : command.key;
          if (character.length === 1) insertTypedChars.push(character);
          else insertTainted = true;
        }
        insert = planned.value.nextSession;
        if (insert === null) {
          mode = 'normal';
          const primary = planned.value.members.find((member) => member.id === selections.primaryId) ?? planned.value.members[0];
          const transition = primary?.transition;
          const cursor = transition?.kind === 'exited' ? transition.lastInsertCursorOffset : planned.value.members[0]?.transition.plan.cursorOffset;
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
        const cursor = transition?.kind === 'exited' ? transition.lastInsertCursorOffset : offset(0);
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
      if (command.kind === 'operator-motion' || command.kind === 'operator-line' || command.kind === 'operator-text-object') {
        executeOperator(command);
        return;
      }
      if (command.kind === 'literal-command') {
        executeLiteral(command);
        return;
      }
      if (command.kind === 'prefixed-key') {
        executePrefixed(command);
        return;
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
      if (command.kind === 'single-key' && isVisualMode(mode) && isMotionLike(command.key)) {
        const invocation = motionInvocation(command.key, command.count.value);
        if (invocation === null) return;
        const moved = resolveVimMultiVisualMotion({ snapshot: document.snapshot(), selections, invocation, failurePolicy: 'reject-command' });
        if (!moved.ok) return;
        selections = moved.value.selection;
        parser = makeParser(mode, selections);
        return;
      }
      if (command.kind === 'single-key' && isVisualMode(mode) && (command.key === 'd' || command.key === 'c' || command.key === 'y')) {
        executeVisualOperator(command.key);
        return;
      }
      if (command.kind === 'single-key' && mode === 'normal' && command.key === '.') {
        executeDotRepeat(command.count.value);
        return;
      }
      if (command.kind === 'single-key' && mode === 'normal' && (command.key === 'p' || command.key === 'P')) {
        const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
        if (primary === undefined || primary.kind !== 'normal-cursor') return;
        const registerName = (command.register ?? '"') as VimRegisterName;
        const planned = prepareVimPutFromBank({
          snapshot: document.snapshot(),
          cursor: primary.anchor.at.offset,
          command: command.key as 'p' | 'P',
          bank: registers,
          registerName,
        });
        if (!planned.ok) return;
        const opened = document.beginUndoGroup(OPERATOR_GROUP, 'vim');
        if (!opened.ok) return;
        const current = document.snapshot();
        const committed = document.commit({ documentId: current.id, expectedVersion: current.version, edits: planned.value.edits, origin: 'vim', undoGroup: OPERATOR_GROUP });
        if (!committed.ok || !document.endUndoGroup(OPERATOR_GROUP).ok) return;
        notifyCommitted(committed, options.onDocumentChange);
        selections = makeNormalSelection(document.snapshot(), planned.value.cursor, (selections.selectionGeneration as number) + 1, selections.primaryId);
        motionCursor = makeMotionCursor(document.snapshot(), selections);
        parser = makeParser(mode, selections);
        return;
      }
      if (command.kind === 'single-key' && mode === 'normal' && isMotionKey(command.key)) {
        if (motionCursor === undefined) return;
        const moved = resolveVimMotion(document.snapshot(), motionCursor, { key: command.key, count: command.count.value });
        if (!moved.ok) return;
        motionCursor = moved.value.cursor;
        selections = makeNormalSelection(document.snapshot(), moved.value.cursor.offset, (selections.selectionGeneration as number) + 1, selections.primaryId);
        parser = makeParser(mode, selections);
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
          const opened = document.beginUndoGroup(DIRECT_GROUP, 'vim');
          if (!opened.ok) return;
          const committed = document.commit({
            documentId: prepared.value.transaction.documentId,
            expectedVersion: prepared.value.transaction.expectedVersion,
            edits: prepared.value.transaction.edits,
            origin: 'vim',
            undoGroup: DIRECT_GROUP,
          });
          if (!committed.ok) {
            document.endUndoGroup(DIRECT_GROUP);
            return;
          }
          if (!document.endUndoGroup(DIRECT_GROUP).ok) return;
          notifyCommitted(committed, options.onDocumentChange);
          if (prepared.value.registerEffect !== null) registers = applyRegisterEffect(registers, prepared.value.registerEffect);
        }
        if (prepared.value.mode === 'insert') {
          const entered = beginVimMultiInsert(document.snapshot(), [{ id: primary.id, cursorOffset: prepared.value.cursorOffset }], 'i');
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
      const motion = motionInvocation(
        motionCommand.kind === 'operator-text-object' ? motionCommand.textObject : motionCommand.motion,
        motionCommand.motionCount.value,
      );
      if (motion === null) return;
      const prepared = prepareVimMultiOperator({
        snapshot: document.snapshot(),
        selections,
        operator,
        motion,
        operatorCount: motionCommand.operatorCount.value,
        motionCount: motionCommand.motionCount.value,
        ...(motionCommand.register === undefined ? {} : { register: motionCommand.register }),
        state: { mode: 'normal', repeatTarget: null },
        failurePolicy: 'reject-command',
      });
      if (!prepared.ok || prepared.value.transaction === null && prepared.value.cursorOffsets.length === 0) return;
      if (prepared.value.transaction !== null) {
        const opened = document.beginUndoGroup(OPERATOR_GROUP, 'vim');
        if (!opened.ok) return;
        const committed = document.commit({
          documentId: prepared.value.transaction.documentId,
          expectedVersion: prepared.value.transaction.expectedVersion,
          edits: prepared.value.transaction.edits,
          origin: 'vim',
          undoGroup: OPERATOR_GROUP,
        });
        if (!committed.ok) {
          document.endUndoGroup(OPERATOR_GROUP);
          return;
        }
        if (!document.endUndoGroup(OPERATOR_GROUP).ok) return;
        notifyCommitted(committed, options.onDocumentChange);
      }
      for (const effect of prepared.value.registerEffects) registers = applyRegisterEffect(registers, effect);
      const primary = prepared.value.cursorOffsets.find((member) => member.id === selections.primaryId) ?? prepared.value.cursorOffsets[0];
      const cursor = primary?.offset ?? selectionOffset(selections.members[0]);
      if (prepared.value.members.some((member) => member.plan?.mode === 'insert')) {
        const entered = beginVimMultiInsert(document.snapshot(), [{ id: selections.primaryId, cursorOffset: cursor }], 'i');
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
      const entered = beginVimMultiInsert(document.snapshot(), [{ id: selections.primaryId, cursorOffset: atOffset }], entryKey);
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
      return transition?.kind === 'exited' ? transition.lastInsertCursorOffset : offset(0);
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

    function executeDotRepeat(explicitCount: number): void {
      const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
      if (primary === undefined || primary.kind !== 'normal-cursor' || selections.members.length !== 1) return;

      if (lastRepeatKind === 'change' && changeRepeatTarget !== undefined) {
        const target = changeRepeatTarget;
        const deleteCursor = target.linewise
          ? replayLinewiseOperator('change', target.motionKey, explicitCount, primary.anchor.at.offset)
          : (() => {
              const motion = motionInvocation(target.motionKey, explicitCount);
              if (motion === null) return undefined;
              const prepared = prepareVimMultiOperator({
                snapshot: document.snapshot(), selections, operator: 'change', motion,
                operatorCount: 1, motionCount: explicitCount, state: { mode: 'normal', repeatTarget: null },
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
        const cursor = replayLinewiseOperator(engineTarget.operator, engineTarget.motionKey, explicitCount, primary.anchor.at.offset);
        if (cursor === undefined) { message('xi: repeat unavailable for the last change\n'); return; }
        mode = 'normal';
        selections = makeNormalSelection(document.snapshot(), cursor, (selections.selectionGeneration as number) + 1, selections.primaryId);
        motionCursor = makeMotionCursor(document.snapshot(), selections);
        parser = makeParser(mode, selections);
        recordOperatorRepeat('delete', engineTarget.motionKey, explicitCount, 'linewise');
        return;
      }

      type Resolved =
        | { readonly kind: 'operator'; readonly prepared: Extract<ReturnType<typeof prepareVimMultiOperator>, { readonly ok: true }>['value']; readonly motionKey: string }
        | { readonly kind: 'insert'; readonly entryKey: VimInsertEntryKey; readonly text: string };
      const replay = replayVimDot(repeatState, {
        snapshot: document.snapshot(),
        cursorOffset: primary.anchor.at.offset,
        count: explicitCount,
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
            state: { mode: 'normal', repeatTarget: null },
            failurePolicy: 'reject-command',
          });
          if (!prepared.ok) return { ok: false, error: { kind: 'invalid-target', reason: 'operator' } };
          return { ok: true, value: { kind: 'operator', prepared: prepared.value, motionKey: context.target.motionKey } };
        }
        if (context.target.kind === 'insert') return { ok: true, value: { kind: 'insert', entryKey: context.target.entryKey, text: context.target.text } };
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
      const cursor = replayInsertText(resolved.entryKey, resolved.text, primary.anchor.at.offset);
      mode = 'normal';
      selections = makeNormalSelection(document.snapshot(), cursor, (selections.selectionGeneration as number) + 1);
      motionCursor = makeMotionCursor(document.snapshot(), selections);
      parser = makeParser(mode, selections);
      const created = createVimInsertRepeatTarget({ entryKey: resolved.entryKey, mode: 'insert', text: resolved.text });
      if (created.ok) {
        const recorded = recordVimRepeatTarget(repeatState, created.value);
        if (recorded.ok) { repeatState = recorded.value; lastRepeatKind = 'engine'; }
      }
    }

    function executeVisualOperator(key: 'd' | 'c' | 'y'): void {
      const prepared = prepareVimMultiOperator({
        snapshot: document.snapshot(),
        selections,
        operator: key === 'd' ? 'delete' : key === 'c' ? 'change' : 'yank',
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
      if (plan.transaction !== null) {
        const opened = document.beginUndoGroup(OPERATOR_GROUP, 'vim');
        if (!opened.ok) return;
        const committed = document.commit({ documentId: plan.transaction.documentId, expectedVersion: plan.transaction.expectedVersion, edits: plan.transaction.edits, origin: 'vim', undoGroup: OPERATOR_GROUP });
        if (!committed.ok || !document.endUndoGroup(OPERATOR_GROUP).ok) return;
        notifyCommitted(committed, options.onDocumentChange);
      }
      registers = applyRegisterEffect(registers, plan.registerEffect);
      // Only the delete/normal-mode cursor needs this: prepareVimOperator's insertionOffset
      // for a 'change' plan is the start of the edit and stays valid pre- and post-commit.
      const cursor = plan.mode === 'insert' ? plan.cursorOffset : mapOffsetThroughCommit(beforeSnapshot, plan.transaction?.edits ?? [], plan.cursorOffset);
      if (plan.mode === 'insert') {
        const primaryId = selections.primaryId;
        const entered = beginVimMultiInsert(document.snapshot(), [{ id: primaryId, cursorOffset: cursor }], 'i');
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
      if (primary === undefined || primary.kind !== 'normal-cursor') return;
      if (command.command === 'record-macro') {
        // Unreachable through the keyboard today (bare 'q' is intercepted earlier for
        // the quit-shortcut/stop-recording split above); kept correct and complete in
        // case another path ever feeds this literal-command synthetically.
        beginMacroRecordingInternal(command.argument);
        parser = makeParser(mode, selections);
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
        const key = command.command === 'find-forward' ? 'f' : command.command === 'find-backward' ? 'F' : command.command === 'till-forward' ? 't' : 'T';
        const cursor = makeMotionCursor(document.snapshot(), selections);
        if (cursor === undefined) return;
        const found = resolveVimFind(document.snapshot(), cursor, { key, target: command.argument, count: command.count.value }, lastFind);
        if (!found.ok || found.value.kind !== 'found') return;
        lastFind = found.value.lastFind;
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

    function executePrefixed(command: Extract<VimCommandIntent, { readonly kind: 'prefixed-key' }>): void {
      const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
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
        const entered = beginVimMultiInsert(document.snapshot(), [{ id: primary.id, cursorOffset: primary.anchor.at.offset }], `g${command.key}` as VimInsertEntryKey, {}, command.count.value);
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
