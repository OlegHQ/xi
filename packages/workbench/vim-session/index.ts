import { asCellColumn, asIdentifier, asLineIndex, asUtf16Offset, type DocumentId, type SelectionId, type UndoGroupId, type ViewId, type Utf16Offset } from '../../contracts/src/index';
import type { CanonicalInputEvent } from '../../contracts/src/index';
import type { CommittedDocumentChange, DocumentEdit, DocumentReadPort, DocumentSnapshot, TextFileDocument } from '../../document/src/index';
import { createSelectionSet, mapSelectionSet, updateSelectionSet, type EndpointInput, type SelectionSetSnapshot, type SelectionMemberInput } from '../../selections/src/index';
import {
  beginVimMultiInsert,
  createVimMotionCursor,
  createVimParserState,
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
import type { PointerCell, PointerSelectionIntent } from '../../vim/src/entrypoints/launch';
import type { PrefixHelpParserContinuation } from '../commands/prefix-help';
import { createVimRegisterBank, type VimRegisterBank, type VimRegisterName, type VimRegisterType } from '../../vim/src/entrypoints/launch';

export interface OwnedVimKeyEvent {
  readonly name: string;
  readonly raw: string;
  readonly shift: boolean;
  readonly option: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
}

export interface OwnedVimSessionOptions {
  readonly viewId: ViewId;
  readonly initialLine?: number;
  readonly initialSelections?: SelectionSetSnapshot;
  readonly initialMode?: VimMode;
  readonly onMessage?: (message: string) => void;
  readonly onSave?: (path?: string) => Promise<boolean>;
  /** Give the workbench first refusal for host commands such as split/close. */
  readonly onExCommand?: (source: string) => Promise<'handled' | 'unhandled' | 'quit'> | 'handled' | 'unhandled' | 'quit';
  /** Route host-dependent native commands without putting I/O on the key path. */
  readonly onHostCommand?: (command: VimHostCommand) => void | Promise<void>;
  /** Publish the owned engine state to the workbench after each input event. */
  readonly onStateChange?: (state: { readonly selections: SelectionSetSnapshot; readonly mode: VimMode }) => void;
  /** Publish parser-owned continuation metadata to the passive help surface. */
  readonly onPrefixStateChange?: (state: VimPrefixHelpState) => void;
  /** Publish the command-line source to the read-only Ex surface. */
  readonly onCommandLineChange?: (state: VimCommandLineState | undefined) => void;
  /** Publish each committed document change to language/service owners. */
  readonly onDocumentChange?: (change: CommittedDocumentChange) => void;
}

export interface VimPrefixHelpState {
  readonly pendingKeys: readonly string[];
  readonly parserContinuations: readonly PrefixHelpParserContinuation[];
}

export interface VimCommandLineState {
  /** The leading ':' is included; cursorOffset is UTF-16 based. */
  readonly source: string;
  readonly cursorOffset: number;
}

export interface OwnedVimSession extends WorkbenchReadPort {
  handleKey(event: OwnedVimKeyEvent): boolean | 'quit' | Promise<boolean | 'quit'>;
  readonly commandLineActive: boolean;
  readonly commandLine: VimCommandLineState | undefined;
  readonly prefixHelp: VimPrefixHelpState;
  /** Re-anchor the engine after a document owner commits an external edit. */
  applyExternalChange(change: CommittedDocumentChange): void;
  /** Close a Vim Insert group before a service-originated edit takes ownership of history. */
  closeInsertUndoGroup(): boolean;
  /** Move the active insert caret after a service inserts a snippet field. */
  setInsertCursor(offset: number): boolean;
  /** Move every insert caret in one selection-only update. */
  setInsertCursors(offsets: ReadonlyMap<string, number>): boolean;
  /** Place the primary Normal cursor at a host-resolved zero-based line/column. */
  setCursorPosition(line: number, utf16Column?: number): boolean;
  /** Apply a versioned pointer intent after layout has resolved its text target. */
  placePointer(intent: PointerSelectionIntent): boolean;
  /** Cancel a pending Vim prefix before a pointer placement. */
  cancelPendingOperator(): void;
  /** Replace the accepted Ex source while its command line is active. */
  setCommandLineSource(source: string, cursorOffset?: number): boolean;
  /** Execute the displayed Ex source through the owning session. */
  submitCommandLine(source?: string): Promise<boolean | 'quit'>;
}

const INSERT_GROUP = id<UndoGroupId>('xi-workbench-insert');
const DIRECT_GROUP = id<UndoGroupId>('xi-workbench-direct');
const EX_GROUP = id<UndoGroupId>('xi-workbench-ex');
const OPERATOR_GROUP = id<UndoGroupId>('xi-workbench-operator');

export function createOwnedVimSession(document: TextFileDocument, options: OwnedVimSessionOptions): OwnedVimSession {
  const documentId = document.id;
  const viewId = options.viewId;
  const snapshot = document.snapshot();
  let mode: VimMode = options.initialMode ?? 'normal';
  let selections = options.initialSelections ?? makeSelection(snapshot, options.initialLine);
  let parser = makeParser(mode, selections);
  let insert: VimMultiInsertSession | null = null;
  let motionCursor = makeMotionCursor(document.snapshot(), selections);
  let undoOpen = false;
  let registers: VimRegisterBank = createVimRegisterBank();
  let lastFind: VimLastFind | null = null;
  let commandLine: string | undefined;
  let commandLineCursorOffset = 0;
  let prefixKeys: string[] = [];
  let selectionHistory: SelectionSetSnapshot[] = [];
  const readPort: DocumentReadPort = {
    snapshot: () => document.snapshot(),
    slice: (start, end, expectedVersion) => document.slice(start, end, expectedVersion),
  };

  function handleKey(event: OwnedVimKeyEvent): boolean | 'quit' | Promise<boolean | 'quit'> {
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
      prefixKeys = [];
      return true;
    }
    if (event.ctrl && (key === 's' || key === 'S')) {
      // Saving and format-on-save run behind the input boundary. Waiting here
      // would turn disk/formatter latency into an editor freeze and would
      // queue later user edits behind an obsolete snapshot.
      if (options.onSave !== undefined) void options.onSave().catch(() => options.onMessage?.('xi: save failed\n'));
      return true;
    }
    if (mode === 'normal' && key === 'q') return false;
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
      if (commandLine !== undefined) return;
      parser = makeParser(mode, selections);
      prefixKeys = [];
      options.onPrefixStateChange?.(readPrefixHelp());
    },
    applyExternalChange(change): void {
      if (change.documentId !== documentId || selections.documentVersion !== change.before) return;
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
      if (mode !== 'normal' || !Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(utf16Column) || utf16Column < 0) return false;
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
      if (commandLine !== undefined || intent.viewId !== String(viewId)) return false;
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
      if (commandLine === undefined || typeof source !== 'string' || !Number.isSafeInteger(cursorOffset)) return false;
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
      return submitCommandLine(source ?? readCommandLine()?.source ?? ':');
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
    return Object.freeze({
      pendingKeys: Object.freeze([...prefixKeys]),
      parserContinuations: Object.freeze(parser.legalContinuations.map((item) => Object.freeze({ ...item }))),
    });
  }

  function publishAuxiliaryState(): void {
    options.onPrefixStateChange?.(readPrefixHelp());
    options.onCommandLineChange?.(readCommandLine());
  }

  function updatePrefixKeys(key: string, outcomeKind: string): void {
    prefixKeys = outcomeKind === 'pending' ? [...prefixKeys, key] : [];
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
        return;
      }
      if (command.kind === 'insert-key' && isInsertMode(mode) && insert !== null) {
        const planned = planVimMultiInsertInput(document.snapshot(), insert, { kind: 'key', key: command.key });
        if (!planned.ok) throw new Error(`xi-insert:${planned.error.kind}`);
        commitPlan(document, planned.value, undoOpen, (value) => { undoOpen = value; }, options.onDocumentChange);
        insert = planned.value.nextSession;
        if (insert === null) {
          mode = 'normal';
          const primary = planned.value.members.find((member) => member.id === selections.primaryId) ?? planned.value.members[0];
          const transition = primary?.transition;
          const cursor = transition?.kind === 'exited' ? transition.lastInsertCursorOffset : planned.value.members[0]?.transition.plan.cursorOffset;
          selections = makeNormalSelection(document.snapshot(), cursor ?? offset(0), (selections.selectionGeneration as number) + 1);
          motionCursor = makeMotionCursor(document.snapshot(), selections);
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
        applyOperatorPlan(single.value);
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
      } else {
        mode = 'normal';
        selections = makeNormalSelection(document.snapshot(), cursor, (selections.selectionGeneration as number) + 1, selections.primaryId);
        motionCursor = makeMotionCursor(document.snapshot(), selections);
      }
      parser = makeParser(mode, selections);
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

    function applyOperatorPlan(plan: Extract<VimOperatorPreparation, { readonly kind: 'prepared' }>): void {
      if (plan.transaction !== null) {
        const opened = document.beginUndoGroup(OPERATOR_GROUP, 'vim');
        if (!opened.ok) return;
        const committed = document.commit({ documentId: plan.transaction.documentId, expectedVersion: plan.transaction.expectedVersion, edits: plan.transaction.edits, origin: 'vim', undoGroup: OPERATOR_GROUP });
        if (!committed.ok || !document.endUndoGroup(OPERATOR_GROUP).ok) return;
        notifyCommitted(committed, options.onDocumentChange);
      }
      registers = applyRegisterEffect(registers, plan.registerEffect);
      const cursor = plan.cursorOffset;
      if (plan.mode === 'insert') {
        const primaryId = selections.primaryId;
        const entered = beginVimMultiInsert(document.snapshot(), [{ id: primaryId, cursorOffset: cursor }], 'i');
        if (!entered.ok) return;
        commitPlan(document, entered.value.plan, undoOpen, (value) => { undoOpen = value; }, options.onDocumentChange);
        insert = entered.value.session;
        mode = entered.value.session.mode;
        selections = makeInsertSelections(document.snapshot(), insert, (selections.selectionGeneration as number) + 1);
        motionCursor = undefined;
      } else {
        mode = 'normal';
        selections = makeNormalSelection(document.snapshot(), cursor, (selections.selectionGeneration as number) + 1, selections.primaryId);
        motionCursor = makeMotionCursor(document.snapshot(), selections);
      }
      parser = makeParser(mode, selections);
    }

    function executeLiteral(command: Extract<VimCommandIntent, { readonly kind: 'literal-command' }>): void {
      const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
      if (primary === undefined || primary.kind !== 'normal-cursor') return;
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
function makeView(viewId: ViewId, documentId: DocumentId, snapshot: DocumentSnapshot, selections: SelectionSetSnapshot, mode: VimMode): WorkbenchViewSnapshot {
  return {
    session: { viewId, documentId, documentVersion: snapshot.version, selections, mode: publicMode(mode) },
    document: snapshot,
    selections,
  };
}

interface HostTarget {
  readonly target: string;
  readonly line?: number;
}

/** Extract only the bounded current line needed by gf/gF and tag commands. */
function hostTarget(snapshot: DocumentSnapshot, member: SelectionSetSnapshot['members'][number] | undefined, lineAware = false): HostTarget | undefined {
  if (member === undefined) return undefined;
  const line = snapshot.lineIndexAt(member.anchor.at.offset);
  if (!line.ok) return undefined;
  const start = snapshot.lineStartOffset(line.value);
  if (!start.ok) return undefined;
  const nextLine = (line.value as number) + 1;
  const nextLineIndex = asLineIndex(nextLine);
  const end = nextLine < snapshot.lineCount && nextLineIndex.ok
    ? snapshot.lineStartOffset(nextLineIndex.value)
    : asUtf16Offset(snapshot.lengthUtf16);
  if (!end.ok) return undefined;
  const text = snapshot.slice(start.value, end.value);
  if (!text.ok) return undefined;
  const cursor = Math.min(Math.max(0, (member.anchor.at.offset as number) - (start.value as number)), text.value.length);
  if (cursor >= text.value.length || !isHostTokenCharacter(text.value[cursor] ?? '')) return undefined;
  let tokenStart = cursor;
  while (tokenStart > 0 && isHostTokenCharacter(text.value[tokenStart - 1] ?? '')) tokenStart -= 1;
  let tokenEnd = cursor + 1;
  while (tokenEnd < text.value.length && isHostTokenCharacter(text.value[tokenEnd] ?? '')) tokenEnd += 1;
  const raw = text.value.slice(tokenStart, tokenEnd);
  if (raw.length === 0 || raw.length > 4096) return undefined;
  const numbered = /^(.*):([1-9][0-9]*)$/u.exec(raw);
  if (numbered?.[1] === undefined || numbered[1].length === 0) return { target: raw };
  const parsedLine = Number(numbered[2]);
  if (!Number.isSafeInteger(parsedLine) || parsedLine < 1) return { target: raw };
  return { target: numbered[1], ...(lineAware ? { line: parsedLine - 1 } : {}) };
}

function isHostTokenCharacter(value: string): boolean {
  return value.length === 1 && !/\s/u.test(value) && !"'\"`<>()[]{};,".includes(value);
}

function hostWindowAction(
  prefix: 'ctrl-w' | 'ctrl-w-g',
  key: string,
): Extract<VimHostCommand, { readonly kind: 'window' }>['action'] | undefined {
  if (prefix === 'ctrl-w-g') {
    switch (key) {
      case 't': return 'move-tab';
      case 'T': return 'move-tab';
      case 'g': return 'focus-first';
      case 'G': return 'focus-last';
      case '+': return 'resize-increase';
      case '-': return 'resize-decrease';
      case '<': return 'resize-left';
      case '>': return 'resize-right';
      case '_': return 'resize-top';
      case '|': return 'resize-right';
      default: return undefined;
    }
  }
  switch (key) {
    case 'h': return 'focus-left';
    case 'j': return 'focus-down';
    case 'k': return 'focus-up';
    case 'l': return 'focus-right';
    case 'w': return 'focus-next';
    case 'W': return 'focus-previous';
    case 'p': return 'focus-previous';
    case 't': return 'focus-first';
    case 'b': return 'focus-last';
    case 'c':
    case 'q': return 'close';
    case 'o':
    case 'O': return 'only';
    case 's': return 'split-horizontal';
    case 'S': return 'split-vertical';
    case 'v': return 'split-vertical';
    case '=': return 'equalize';
    case '+': return 'resize-increase';
    case '-': return 'resize-decrease';
    case '<': return 'resize-left';
    case '>': return 'resize-right';
    case '_': return 'resize-top';
    case '|': return 'resize-right';
    case 'x': return 'exchange-next';
    case 'X': return 'exchange-previous';
    case 'r': return 'rotate';
    case 'R': return 'rotate-reverse';
    case 'B': return 'move-bottom';
    case 'P': return 'move-top';
    case 'T': return 'move-tab';
    case 'n': return 'focus-next';
    case 'C': return 'new-window';
    default: return undefined;
  }
}

const SELECTION_HISTORY_LIMIT = 100;

interface XiSelectionCommandInput {
  readonly command: VimSelectionCommand;
  readonly pattern?: string;
  readonly limit?: number;
  readonly ignoreCase?: boolean;
}

function parseXiSelectionCommand(source: string): XiSelectionCommandInput | undefined {
  const match = /^xi\s+(selection\.[a-z-]+)(?:\s+([\s\S]*))?$/iu.exec(source);
  if (match === null) return undefined;
  const command = match[1] as VimSelectionCommand;
  if (!SELECTION_COMMANDS.has(command)) return undefined;
  const argument = match[2]?.trim() ?? '';
  if (PATTERN_SELECTION_COMMANDS.has(command)) {
    if (argument.length === 0) return { command };
    const flags = /\s+--(ignore-case|limit=\d+)$/u.exec(argument);
    const pattern = flags === null ? argument : argument.slice(0, flags.index).trimEnd();
    const limitFlag = flags?.[1]?.startsWith('limit=') === true ? Number(flags[1].slice('limit='.length)) : undefined;
    return {
      command,
      ...(pattern.length === 0 ? {} : { pattern }),
      ...(flags?.[1] === 'ignore-case' ? { ignoreCase: true } : {}),
      ...(limitFlag === undefined ? {} : { limit: limitFlag }),
    };
  }
  if (argument.length !== 0) return undefined;
  return { command };
}

const SELECTION_COMMANDS: ReadonlySet<string> = new Set([
  'selection.add-above', 'selection.add-below', 'selection.add-next-match', 'selection.skip-next-match',
  'selection.select-all-matches', 'selection.split-lines', 'selection.select-regex', 'selection.keep-matching',
  'selection.remove-primary', 'selection.keep-primary', 'selection.rotate-primary-next',
  'selection.rotate-primary-previous', 'selection.collapse', 'selection.flip', 'selection.merge', 'selection.undo',
]);

const PATTERN_SELECTION_COMMANDS: ReadonlySet<VimSelectionCommand> = new Set([
  'selection.add-next-match', 'selection.skip-next-match', 'selection.select-all-matches',
  'selection.select-regex', 'selection.keep-matching',
]);

function selectionModeFor(kind: SelectionSetSnapshot['members'][number]['kind'] | undefined): VimMode {
  switch (kind) {
    case 'insert-caret': return 'insert';
    case 'visual-character': return 'visual-character';
    case 'visual-line': return 'visual-line';
    case 'visual-block': return 'visual-block';
    case 'normal-cursor':
    default: return 'normal';
  }
}

function makeParser(mode: VimMode, selections: SelectionSetSnapshot): VimParserState {
  const created = createVimParserState(mode, selections);
  if (!created.ok) throw new Error(`xi-parser:${created.error.kind}`);
  return created.value;
}

function publicMode(mode: VimMode): 'normal' | 'insert' | 'replace' | 'visual' {
  if (mode === 'visual-character' || mode === 'visual-line' || mode === 'visual-block' || mode === 'select-character' || mode === 'select-line' || mode === 'select-block') return 'visual';
  if (mode === 'virtual-replace') return 'replace';
  return mode;
}

function isInsertMode(mode: VimMode): mode is 'insert' | 'replace' | 'virtual-replace' {
  return mode === 'insert' || mode === 'replace' || mode === 'virtual-replace';
}

function isVisualMode(mode: VimMode): mode is 'visual-character' | 'visual-line' | 'visual-block' {
  return mode === 'visual-character' || mode === 'visual-line' || mode === 'visual-block';
}

function selectionOffset(member: SelectionSetSnapshot['members'][number] | undefined): Utf16Offset {
  return member?.head.at.offset ?? offset(0);
}

function coreOperator(name: string): VimCoreOperator | null {
  return name === 'delete' || name === 'change' || name === 'yank' ? name : null;
}

function isMotionLike(key: string): boolean {
  return isMotionKey(key) || isWordMotionKey(key) || isTextObjectKey(key);
}

function motionInvocation(key: string, count: number): VimMultiMotionInvocation | null {
  if (isMotionKey(key)) return { key, count };
  if (isWordMotionKey(key)) return { key, count };
  if (isTextObjectKey(key)) return { key, count };
  return null;
}

function isWordMotionKey(key: string): key is VimWordMotionKey {
  return key === 'w' || key === 'W' || key === 'b' || key === 'B' || key === 'e' || key === 'E' || key === 'ge' || key === 'gE';
}

function isTextObjectKey(key: string): key is VimTextObjectKey {
  return /^([ia])(?:w|W|s|p|["'`()[\]{}<>bBit])$/u.test(key);
}

function applyRegisterEffect(bank: VimRegisterBank, effect: { readonly operation: string; readonly destination: string; readonly lines: readonly string[]; readonly type: string }): VimRegisterBank {
  const type: VimRegisterType = effect.type === 'V' || effect.type === 'linewise'
    ? 'linewise'
    : effect.type === 'blockwise' || effect.type === '\u0016'
      ? 'blockwise'
      : 'characterwise';
  const value = { lines: effect.lines, type };
  const destination = effect.destination as VimRegisterName;
  const result = effect.operation === 'yank'
    ? bank.yank(value, destination)
    : bank.delete(value, { destination, small: destination === '-' });
  return result.ok ? result.value : bank;
}

function makeMotionCursor(snapshot: DocumentSnapshot, selections: SelectionSetSnapshot): VimMotionCursor | undefined {
  const primary = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
  if (primary === undefined || primary.kind !== 'normal-cursor') return undefined;
  const created = createVimMotionCursor(snapshot, primary.anchor.at.offset);
  return created.ok ? created.value : undefined;
}

function makeSelection(snapshot: DocumentSnapshot, lineNumber?: number): SelectionSetSnapshot {
  const selectionId = id<SelectionId>('xi-launch-selection');
  return makeNormalSelection(snapshot, lineStart(snapshot, lineNumber), 0, selectionId);
}

function lineStart(snapshot: DocumentSnapshot, lineNumber?: number): Utf16Offset {
  if (lineNumber === undefined || !Number.isSafeInteger(lineNumber)) return offset(0);
  const requested = Math.max(1, lineNumber) - 1;
  const line = asLineIndex(Math.min(requested, Math.max(0, snapshot.lineCount - 1)));
  if (!line.ok) return offset(0);
  const start = snapshot.lineStartOffset(line.value);
  return start.ok ? start.value : offset(0);
}

function makeNormalSelection(snapshot: DocumentSnapshot, value: Utf16Offset, generation: number, selectionId = id<SelectionId>('xi-launch-selection')): SelectionSetSnapshot {
  let at = Math.min(Math.max(value as number, 0), Math.max(0, snapshot.lengthUtf16 - 1));
  while (at > 0) {
    const character = snapshot.slice(at as Utf16Offset, (at + 1) as Utf16Offset);
    if (!character.ok || character.value !== '\n') break;
    at -= 1;
  }
  const endpoint = snapshot.lengthUtf16 === 0
    ? { kind: 'eof' as const }
    : (() => {
      const offset = asUtf16Offset(at);
      const after = asUtf16Offset(Math.min(at + 1, snapshot.lengthUtf16));
      if (!offset.ok || !after.ok) throw new Error('xi selection offset');
      return { kind: 'character' as const, offset: offset.value, after: after.value };
    })();
  const created = createSelectionSet(snapshot, {
    primaryId: selectionId,
    selectionGeneration: generation,
    members: [{ id: selectionId, kind: 'normal-cursor', direction: 'forward', anchor: endpoint, head: endpoint }],
  });
  if (!created.ok) throw new Error(`xi selection: ${created.error.kind}`);
  return created.value.selectionSet;
}

function addPointerCaret(
  snapshot: DocumentSnapshot,
  target: PointerCell['target'],
  current: SelectionSetSnapshot,
  install: (next: SelectionSetSnapshot) => void,
): boolean {
  if (target === undefined || current.members.some((member) => member.kind !== 'normal-cursor')) return false;
  const nextId = id<SelectionId>(`xi-pointer-selection-${current.selectionGeneration as number}-${current.members.length}`);
  const targetOffset = asUtf16Offset(target.offset);
  if (!targetOffset.ok) return false;
  const single = makeNormalSelection(snapshot, targetOffset.value, current.selectionGeneration as number, nextId);
  const member = single.members[0];
  if (member === undefined || member.kind !== 'normal-cursor') return false;
  const existing: SelectionMemberInput[] = current.members.map((source): SelectionMemberInput => {
    if (source.kind !== 'normal-cursor') throw new Error('xi-pointer-mixed-selection');
    return {
      id: source.id,
      kind: source.kind,
      direction: source.direction,
      anchor: pointerNormalEndpoint(source.anchor),
      head: pointerNormalEndpoint(source.head),
      desiredColumn: source.desiredColumn,
      creationOrdinal: source.creationOrdinal,
    };
  });
  const updated = updateSelectionSet(snapshot, current, {
    primaryId: nextId,
    members: [...existing, pointerNormalEndpointMember(member, false)],
  });
  if (!updated.ok) return false;
  install(updated.value.selectionSet);
  return true;
}

function pointerNormalEndpointMember(member: Extract<SelectionSetSnapshot['members'][number], { readonly kind: 'normal-cursor' }>, preserveOrdinal = true): SelectionMemberInput {
  return {
    id: member.id,
    kind: member.kind,
    direction: member.direction,
    anchor: pointerNormalEndpoint(member.anchor),
    head: pointerNormalEndpoint(member.head),
    desiredColumn: member.desiredColumn,
    ...(preserveOrdinal ? { creationOrdinal: member.creationOrdinal } : {}),
  };
}

function pointerNormalEndpoint(endpoint: Extract<SelectionSetSnapshot['members'][number], { readonly kind: 'normal-cursor' }>['anchor']): EndpointInput {
  switch (endpoint.kind) {
    case 'character': return { kind: 'character', offset: endpoint.at.offset, after: endpoint.after.offset, affinity: endpoint.at.affinity, afterAffinity: endpoint.after.affinity };
    case 'empty-line': return { kind: 'empty-line', lineIndex: endpoint.lineIndex, affinity: endpoint.at.affinity };
    case 'eof': return { kind: 'eof', affinity: endpoint.at.affinity };
  }
}

function pointerVisualCursor(snapshot: DocumentSnapshot, target: NonNullable<PointerCell['target']>): VimVisualCursor | undefined {
  if (!Number.isSafeInteger(target.lineIndex) || target.lineIndex < 0
    || !Number.isSafeInteger(target.offset) || target.offset < 0 || target.offset > snapshot.lengthUtf16
    || !Number.isSafeInteger(target.displayCellColumn) || target.displayCellColumn < 0
    || !Number.isSafeInteger(target.virtualCell) || target.virtualCell < 0) return undefined;
  const safeOffset = target.cellPart === 'padding' ? pointerPreviousCharacter(snapshot, target.offset) : target.offset;
  const offsetValue = asUtf16Offset(safeOffset);
  const displayValue = asCellColumn(target.displayCellColumn);
  if (!offsetValue.ok || !displayValue.ok) return undefined;
  return {
    documentVersion: snapshot.version,
    offset: offsetValue.value,
    displayCellColumn: displayValue.value,
    virtualCells: target.virtualCell,
  };
}

function pointerWordRange(
  snapshot: DocumentSnapshot,
  anchor: VimVisualCursor,
  head: VimVisualCursor,
): { readonly anchor: VimVisualCursor; readonly head: VimVisualCursor } | undefined {
  const anchorRange = pointerWordAt(snapshot, anchor.offset as number);
  const headRange = pointerWordAt(snapshot, head.offset as number);
  if (anchorRange === undefined || headRange === undefined) return undefined;
  const forward = (anchor.offset as number) <= (head.offset as number);
  const anchorOffset = forward ? anchorRange.start : pointerLastCharacter(snapshot, anchorRange.end);
  const headOffset = forward ? pointerLastCharacter(snapshot, headRange.end) : headRange.start;
  const anchorTarget = pointerTargetAt(snapshot, anchorOffset);
  const headTarget = pointerTargetAt(snapshot, headOffset);
  if (anchorTarget === undefined || headTarget === undefined) return undefined;
  const anchorCursor = pointerVisualCursor(snapshot, anchorTarget);
  const headCursor = pointerVisualCursor(snapshot, headTarget);
  return anchorCursor === undefined || headCursor === undefined ? undefined : { anchor: anchorCursor, head: headCursor };
}

function pointerWordAt(snapshot: DocumentSnapshot, offsetValue: number): { readonly start: number; readonly end: number } | undefined {
  const safeOffset = asUtf16Offset(Math.max(0, Math.min(offsetValue, snapshot.lengthUtf16)));
  if (!safeOffset.ok) return undefined;
  const line = snapshot.lineIndexAt(safeOffset.value);
  if (!line.ok) return undefined;
  const start = snapshot.lineStartOffset(line.value);
  if (!start.ok) return undefined;
  const next = (line.value as number) + 1;
  const nextLine = asLineIndex(next);
  const end = next < snapshot.lineCount && nextLine.ok ? snapshot.lineStartOffset(nextLine.value) : asUtf16Offset(snapshot.lengthUtf16);
  if (!end.ok) return undefined;
  const text = snapshot.slice(start.value, end.value);
  if (!text.ok) return undefined;
  const units = [...text.value].map((value, index) => ({ value, start: index, end: index + value.length }));
  if (units.length === 0) return undefined;
  let local = Math.max(0, offsetValue - (start.value as number));
  let selected = units.findIndex((unit) => local >= unit.start && local < unit.end);
  if (selected < 0) selected = units.length - 1;
  const kind = pointerWordKind(units[selected]?.value ?? '');
  let first = selected;
  while (first > 0 && pointerWordKind(units[first - 1]?.value ?? '') === kind) first -= 1;
  let last = selected;
  while (last + 1 < units.length && pointerWordKind(units[last + 1]?.value ?? '') === kind) last += 1;
  return { start: (start.value as number) + (units[first]?.start ?? 0), end: (start.value as number) + (units[last]?.end ?? 0) };
}

function pointerWordKind(value: string): 'space' | 'keyword' | 'punctuation' {
  if (/\s/u.test(value)) return 'space';
  return /^[\p{L}\p{N}_]$/u.test(value) ? 'keyword' : 'punctuation';
}

function pointerTargetAt(snapshot: DocumentSnapshot, offsetValue: number): NonNullable<PointerCell['target']> | undefined {
  const safeOffset = asUtf16Offset(offsetValue);
  if (!safeOffset.ok) return undefined;
  const line = snapshot.lineIndexAt(safeOffset.value);
  if (!line.ok) return undefined;
  const start = snapshot.lineStartOffset(line.value);
  if (!start.ok) return undefined;
  return {
    lineIndex: line.value as number,
    offset: offsetValue,
    displayCellColumn: pointerDisplayColumn(snapshot, offsetValue, start.value as number),
    virtualCell: 0,
    cellPart: 'glyph',
  };
}

function pointerDisplayColumn(snapshot: DocumentSnapshot, offsetValue: number, lineStartValue: number): number {
  const start = asUtf16Offset(lineStartValue);
  const end = asUtf16Offset(Math.max(lineStartValue, offsetValue));
  if (!start.ok || !end.ok) return 0;
  const prefix = snapshot.slice(start.value, end.value);
  if (!prefix.ok) return 0;
  let column = 0;
  for (const cluster of prefix.value) column += cluster === '\t' ? 8 - (column % 8) : pointerClusterWidth(cluster);
  return column;
}

function pointerClusterWidth(cluster: string): number {
  const codePoint = cluster.codePointAt(0) ?? 0;
  if (/\p{Mark}/u.test(cluster) || codePoint === 0x200d) return 0;
  return codePoint >= 0x1100 && (codePoint <= 0x115f || codePoint >= 0x2e80) ? 2 : 1;
}

function pointerPreviousCharacter(snapshot: DocumentSnapshot, offsetValue: number): number {
  if (offsetValue <= 0) return 0;
  const candidate = offsetValue - 1;
  const start = asUtf16Offset(candidate);
  const end = asUtf16Offset(offsetValue);
  if (!start.ok || !end.ok) return candidate;
  const unit = snapshot.slice(start.value, end.value);
  if (unit.ok && unit.value.length === 1) {
    const code = unit.value.charCodeAt(0);
    if (code >= 0xdc00 && code <= 0xdfff) return Math.max(0, offsetValue - 2);
  }
  return candidate;
}

function pointerLastCharacter(snapshot: DocumentSnapshot, endValue: number): number {
  return pointerPreviousCharacter(snapshot, endValue);
}

function makeInsertSelections(snapshot: DocumentSnapshot, session: VimMultiInsertSession, generation: number): SelectionSetSnapshot {
  const members = session.members.map((member) => ({
    id: member.id,
    kind: 'insert-caret' as const,
    direction: 'forward' as const,
    anchor: { kind: 'gap' as const, offset: member.session.cursorOffset },
    head: { kind: 'gap' as const, offset: member.session.cursorOffset },
  }));
  const primaryId = session.members[0]?.id;
  if (primaryId === undefined) throw new Error('xi-empty-insert-session');
  const created = createSelectionSet(snapshot, { primaryId, selectionGeneration: generation, members });
  if (!created.ok) throw new Error(`xi-insert-selection:${created.error.kind}`);
  return created.value.selectionSet;
}

function commitPlan(document: TextFileDocument, plan: VimMultiInsertPlan, undoOpen: boolean, setUndoOpen: (value: boolean) => void, onDocumentChange?: (change: CommittedDocumentChange) => void): void {
  if (plan.undoAction === 'open' && !undoOpen) {
    const opened = document.beginUndoGroup(INSERT_GROUP, 'vim');
    if (!opened.ok) throw new Error(`xi-undo-open:${opened.error.kind}`);
    setUndoOpen(true);
  }
  if (plan.edits.length > 0) {
    const committed = document.commit({
      documentId: plan.documentId,
      expectedVersion: plan.expectedVersion,
      edits: plan.edits.map((edit) => ({ start: edit.start, end: edit.end, text: edit.text } satisfies DocumentEdit)),
      origin: 'vim',
      undoGroup: INSERT_GROUP,
    });
    if (!committed.ok) throw new Error(`xi-commit:${committed.error.kind}`);
    notifyCommitted(committed, onDocumentChange);
  }
  if (plan.undoAction === 'close' && undoOpen) {
    const closed = document.endUndoGroup(INSERT_GROUP);
    if (!closed.ok) throw new Error(`xi-undo-close:${closed.error.kind}`);
    setUndoOpen(false);
  }
}

function mapExternalInsertSession(session: VimMultiInsertSession, edits: readonly DocumentEdit[]): VimMultiInsertSession {
  const map = (value: Utf16Offset, affinity: 'left' | 'right'): Utf16Offset => offset(mapExternalInsertOffset(value as number, edits, affinity));
  return Object.freeze({
    ...session,
    members: nonEmptyTuple(session.members.map((member) => Object.freeze({
      ...member,
      session: Object.freeze({
        ...member.session,
        cursorOffset: map(member.session.cursorOffset, 'right'),
        entryOffset: map(member.session.entryOffset, 'left'),
        autoIndentSpan: member.session.autoIndentSpan === null
          ? null
          : Object.freeze({ start: map(member.session.autoIndentSpan.start, 'left'), end: map(member.session.autoIndentSpan.end, 'right') }),
        replaceStack: Object.freeze(member.session.replaceStack.map((frame) => Object.freeze({
          ...frame,
          start: map(frame.start, 'left'),
          cursorBefore: map(frame.cursorBefore, 'left'),
        }))),
      }),
    }))),
  });
}

function mapExternalInsertOffset(value: number, edits: readonly DocumentEdit[], affinity: 'left' | 'right'): number {
  let delta = 0;
  for (const edit of edits) {
    const start = edit.start as number;
    const end = edit.end as number;
    if (start === end && value === start) return start + delta + (affinity === 'right' ? edit.text.length : 0);
    if (value >= end) {
      delta += edit.text.length - (end - start);
      continue;
    }
    if (value >= start) return start + delta + (affinity === 'right' ? edit.text.length : 0);
    break;
  }
  return value + delta;
}

function nonEmptyTuple<T>(values: readonly T[]): readonly [T, ...T[]] {
  const first = values[0];
  if (first === undefined) throw new Error('xi-empty-tuple');
  return [first, ...values.slice(1)];
}

function notifyCommitted(result: ReturnType<TextFileDocument['commit']>, listener: ((change: CommittedDocumentChange) => void) | undefined): void {
  if (listener !== undefined && result.ok && result.value.kind === 'committed') listener(result.value.change);
}

function isInsertEntryKey(key: string): key is VimInsertEntryKey {
  return key === 'i' || key === 'I' || key === 'a' || key === 'A' || key === 'o' || key === 'O' || key === 'R' || key === 'gR' || key === 'gi' || key === 'gI';
}

function isDirectChangeKey(key: string): key is VimDirectChangeKey {
  return key === 's' || key === 'S' || key === 'C' || key === 'x' || key === 'X' || key === 'D' || key === '~';
}

function isMotionKey(key: string): key is VimMotionKey {
  return key === 'h' || key === 'l' || key === 'j' || key === 'k' || key === '0' || key === '^' || key === '$'
    || key === 'g_' || key === '|' || key === '+' || key === '-' || key === '_' || key === 'gg' || key === 'G'
    || key === '<Left>' || key === '<Right>' || key === '<Up>' || key === '<Down>' || key === '<Home>' || key === '<End>'
    || key === '<C-Home>' || key === '<C-End>' || key === '<BS>' || key === '<C-H>' || key === '<Space>'
    || key === '<NL>' || key === '<CR>' || key === '<C-M>' || key === '<C-J>' || key === '<C-N>' || key === '<C-P>';
}

function keyName(event: OwnedVimKeyEvent): string {
  switch (event.name) {
    case 'ESC':
    case 'Escape':
    case 'escape': return '<Esc>';
    case 'return': return '<CR>';
    case 'linefeed': return '<NL>';
    case 'space': return '<Space>';
    case 'backspace': return '<BS>';
    default: return event.name;
  }
}

function encodeKeyBytes(raw: string): Uint8Array {
  if (raw.length === 1) {
    const code = raw.charCodeAt(0);
    if (code <= 0x7f) return Uint8Array.of(code);
  }
  return new TextEncoder().encode(raw);
}

function offset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error('xi-offset');
  return result.value;
}

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'xi-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
