import type {
  DocumentId,
  DocumentSnapshot,
  DocumentVersion,
  LineIndex,
  Utf16Offset,
} from '../../document/src/index.ts';
import { lookupDefaultVimDigraph } from './default-digraphs';

export type VimInsertMode = 'insert' | 'replace' | 'virtual-replace';
export type VimInsertEntryKey = 'i' | 'I' | 'a' | 'A' | 'o' | 'O' | 'R' | 'gR' | 'gi' | 'gI';
export type VimBackspaceOption = 'indent' | 'eol' | 'start';

/** Versioned context retained by the Vim owner for the previous Insert exit. */
export interface VimInsertLastContext {
  readonly documentId: DocumentId;
  readonly documentVersion: DocumentVersion;
  readonly cursorOffset: Utf16Offset;
}

export interface VimInsertEntryContext {
  readonly lastInsert: VimInsertLastContext | null;
}

/** A register lookup request is handed to the register owner; layout never reads registers. */
export interface VimInsertRegisterRequest {
  readonly requestId: number;
  readonly registerName: string;
  readonly documentId: DocumentId;
  readonly expectedVersion: DocumentVersion;
  readonly cursorOffset: Utf16Offset;
}

/** Resolved literal payload returned by the register owner for a prior request. */
export interface VimInsertRegisterPayload {
  readonly requestId: number;
  readonly text: string;
}

export interface VimInsertOptions {
  readonly backspace?: string;
  readonly autoindent?: boolean;
  readonly expandtab?: boolean;
  readonly shiftwidth?: number;
  readonly tabstop?: number;
  readonly softtabstop?: number;
}

export interface NormalizedVimInsertOptions {
  readonly backspace: readonly VimBackspaceOption[];
  readonly autoindent: boolean;
  readonly expandtab: boolean;
  readonly shiftwidth: number;
  readonly tabstop: number;
  readonly softtabstop: number;
}

interface ReplaceFrame {
  readonly start: Utf16Offset;
  readonly insertedText: string;
  readonly replacedText: string;
  readonly cursorBefore: Utf16Offset;
}

export type VimInsertPendingInput =
  | { readonly kind: 'none' }
  | { readonly kind: 'literal' }
  | { readonly kind: 'digraph-first' }
  | { readonly kind: 'digraph-second'; readonly value: string }
  | { readonly kind: 'register-name'; readonly requestId: number }
  | { readonly kind: 'register-payload'; readonly request: VimInsertRegisterRequest }
  | { readonly kind: 'control-g' };

/**
 * Immutable Vim-owned editing state. `cursorOffset` is a UTF-16 boundary in
 * the snapshot supplied to the next planning call. The document remains the
 * only text owner; this session contains only transient replace/undo metadata.
 */
export interface VimInsertSession {
  readonly documentId: DocumentId;
  readonly mode: VimInsertMode;
  readonly cursorOffset: Utf16Offset;
  readonly entryOffset: Utf16Offset;
  readonly count: number;
  readonly nextRegisterRequestId: number;
  /** Prefix needed when a counted open-below command repeats a line block. */
  readonly countRepeatPrefix: string;
  readonly repeatText: string;
  readonly replaceStack: readonly ReplaceFrame[];
  readonly pending: VimInsertPendingInput;
  readonly options: NormalizedVimInsertOptions;
  readonly autoIndentSpan: { readonly start: Utf16Offset; readonly end: Utf16Offset } | null;
  readonly autoIndentLineHasContent: boolean;
  readonly suspendedForNormalCommand: boolean;
  readonly undoEpoch: number;
}

export interface VimInsertEdit {
  readonly start: Utf16Offset;
  readonly end: Utf16Offset;
  readonly text: string;
  readonly textIntent?: 'literal-control';
}

export type VimInsertUndoAction = 'open' | 'continue' | 'break' | 'close' | 'none';

export interface VimInsertPlan {
  readonly documentId: DocumentId;
  readonly expectedVersion: DocumentVersion;
  readonly edits: readonly VimInsertEdit[];
  readonly cursorOffset: Utf16Offset;
  readonly undoAction: VimInsertUndoAction;
}

export interface VimInsertEnteredTransition {
  readonly kind: 'entered';
  readonly mode: VimInsertMode;
  readonly session: VimInsertSession;
  readonly plan: VimInsertPlan;
}

export interface VimInsertResumedTransition {
  readonly kind: 'resumed';
  readonly mode: VimInsertMode;
  readonly session: VimInsertSession;
  readonly plan: VimInsertPlan;
}

export type VimInsertTransition =
  | VimInsertEnteredTransition
  | VimInsertResumedTransition
  | {
    readonly kind: 'continued' | 'suspended';
    readonly mode: VimInsertMode;
    readonly session: VimInsertSession;
    readonly plan: VimInsertPlan;
  }
  | {
    readonly kind: 'exited';
    readonly mode: 'normal';
    readonly session: null;
    readonly exitVia: 'escape' | 'ctrl-c';
    /** Insert-mode insertion boundary after counted replay/indent cleanup, before Normal-mode cursor adjustment. */
    readonly lastInsertCursorOffset: Utf16Offset;
    readonly plan: VimInsertPlan;
  }
  | {
    readonly kind: 'ignored';
    readonly mode: VimInsertMode;
    readonly session: VimInsertSession;
    readonly plan: VimInsertPlan;
  }
  | {
    readonly kind: 'register-request';
    readonly mode: VimInsertMode;
    readonly session: VimInsertSession;
    readonly request: VimInsertRegisterRequest;
    readonly plan: VimInsertPlan;
  };

export type VimInsertFailure =
  | { readonly kind: 'invalid-entry-key' }
  | { readonly kind: 'invalid-count' }
  | { readonly kind: 'repeat-limit' }
  | { readonly kind: 'invalid-options' }
  | { readonly kind: 'invalid-cursor' }
  | { readonly kind: 'wrong-document' }
  | { readonly kind: 'snapshot-read-failed' }
  | { readonly kind: 'invalid-input' }
  | { readonly kind: 'invalid-paste-utf8' }
  | { readonly kind: 'stale-last-insert-context' }
  | { readonly kind: 'stale-register-request' }
  | { readonly kind: 'invalid-session' };

export type VimInsertResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: VimInsertFailure };

const NONE_PENDING: VimInsertPendingInput = Object.freeze({ kind: 'none' });
const MAX_REPEAT_UTF16 = 1_000_000;
const DEFAULT_OPTIONS: NormalizedVimInsertOptions = Object.freeze({
  backspace: Object.freeze(['indent', 'eol', 'start'] as const),
  autoindent: false,
  expandtab: false,
  shiftwidth: 8,
  tabstop: 8,
  softtabstop: 0,
});

interface LineWindow {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly lineIndex: LineIndex;
}

/** Create insert/replace state and a versioned opening transaction if needed. */
export function beginVimInsert(
  snapshot: DocumentSnapshot,
  cursorOffset: Utf16Offset,
  key: VimInsertEntryKey,
  options: VimInsertOptions = {},
  count = 1,
  entryContext?: VimInsertEntryContext,
): VimInsertResult<VimInsertEnteredTransition> {
  if (!isEntryKey(key)) return failure('invalid-entry-key');
  if (!Number.isSafeInteger(count) || count < 1) return failure('invalid-count');
  const normalizedOptions = normalizeOptions(options);
  if (normalizedOptions === undefined) return failure('invalid-options');
  let effectiveCursor = cursorOffset;
  if (key === 'gi') {
    const lastInsert = entryContext?.lastInsert ?? null;
    if (lastInsert !== null) {
      if (lastInsert.documentId !== snapshot.id) return failure('wrong-document');
      if (lastInsert.documentVersion !== snapshot.version) return failure('stale-last-insert-context');
      effectiveCursor = lastInsert.cursorOffset;
    }
  }
  if ((key === 'i' || key === 'gi' || key === 'R' || key === 'gR')
    && canUseBoundedLineRead(snapshot, effectiveCursor as number)
    && isSafeSnapshotBoundary(snapshot, effectiveCursor as number)) {
    const session = freezeSession({
      documentId: snapshot.id,
      mode: key === 'R' ? 'replace' : key === 'gR' ? 'virtual-replace' : 'insert',
      cursorOffset: effectiveCursor,
      entryOffset: effectiveCursor,
      count,
      nextRegisterRequestId: 1,
      countRepeatPrefix: '',
      repeatText: '',
      replaceStack: [],
      pending: NONE_PENDING,
      options: normalizedOptions,
      autoIndentSpan: null,
      autoIndentLineHasContent: false,
      suspendedForNormalCommand: false,
      undoEpoch: 0,
    });
    return success(Object.freeze({
      kind: 'entered' as const,
      mode: session.mode,
      session,
      plan: makePlan(snapshot, [], effectiveCursor, 'open'),
    }));
  }
  const line = readLineWindow(snapshot, effectiveCursor as number);
  if (line === undefined) return failure('snapshot-read-failed');
  const localCursor = (effectiveCursor as number) - line.start;
  const text = line.text;
  if (!isSafeBoundary(text, localCursor)) return failure('invalid-cursor');

  const prepared = prepareEntry(text, localCursor, key, normalizedOptions);
  if (prepared === undefined) return failure('invalid-cursor');
  const edits = prepared.edit === null ? [] : [translateEdit(prepared.edit, line.start)];
  const session = freezeSession({
    documentId: snapshot.id,
    mode: prepared.mode,
    cursorOffset: offset(line.start + prepared.cursor),
    entryOffset: offset(line.start + prepared.cursor),
    count,
    nextRegisterRequestId: 1,
    countRepeatPrefix: prepared.countRepeatPrefix,
    repeatText: '',
    replaceStack: [],
    pending: NONE_PENDING,
    options: normalizedOptions,
    autoIndentSpan: prepared.autoIndentSpan === null ? null : Object.freeze({
      start: offset(line.start + (prepared.autoIndentSpan.start as number)),
      end: offset(line.start + (prepared.autoIndentSpan.end as number)),
    }),
    autoIndentLineHasContent: false,
    suspendedForNormalCommand: false,
    undoEpoch: 0,
  });
  return success(Object.freeze({
    kind: 'entered' as const,
    mode: session.mode,
    session,
    plan: makePlan(snapshot, edits, session.cursorOffset, 'open'),
  }));
}

/** Resume Insert after the dispatcher has executed the one normal command. */
export function resumeVimInsert(
  snapshot: DocumentSnapshot,
  session: VimInsertSession,
  cursorOffset: Utf16Offset,
): VimInsertResult<VimInsertResumedTransition> {
  if (snapshot.id !== session.documentId) return failure('wrong-document');
  if (!session.suspendedForNormalCommand || !isSessionValid(session)) return failure('invalid-session');
  const line = readLineWindow(snapshot, cursorOffset as number);
  if (line === undefined) return failure('snapshot-read-failed');
  if (!isSafeBoundary(line.text, (cursorOffset as number) - line.start)) return failure('invalid-cursor');
  const next = freezeSession({ ...session, cursorOffset, suspendedForNormalCommand: false });
  return success(Object.freeze({ kind: 'resumed' as const, mode: next.mode, session: next, plan: makePlan(snapshot, [], next.cursorOffset, 'none') }));
}

/**
 * Plan one key or opaque paste while in Insert, Replace, or Virtual Replace.
 * No key is forwarded to a widget/editor text store and paste bytes are decoded
 * once as UTF-8 rather than reparsed as terminal notation.
 */
export function planVimInsertInput(
  snapshot: DocumentSnapshot,
  session: VimInsertSession,
  input: { readonly kind: 'key'; readonly key: string } | { readonly kind: 'paste'; readonly bytes: Uint8Array },
): VimInsertResult<VimInsertTransition> {
  if (snapshot.id !== session.documentId) return failure('wrong-document');
  if (!isSessionValid(session)) return failure('invalid-session');
  let pasted: string | undefined;
  if (input.kind === 'paste') {
    if (!(input.bytes instanceof Uint8Array)) return failure('invalid-input');
    try {
      pasted = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes).replace(/\r\n?/g, '\n');
    } catch {
      return failure('invalid-paste-utf8');
    }
    if (!isWellFormed(pasted)) return failure('invalid-paste-utf8');
    if (session.mode === 'insert' && session.pending.kind === 'none'
      && canUseBoundedLineRead(snapshot, session.cursorOffset as number)
      && isSafeSnapshotBoundary(snapshot, session.cursorOffset as number)) {
      return insertPayload(snapshot, '', session.cursorOffset as number, session, pasted, 'continued');
    }
  }
  if (input.kind === 'key' && session.mode === 'insert' && session.pending.kind === 'none') {
    const text = textKey(input.key);
    if (text !== undefined && canUseBoundedLineRead(snapshot, session.cursorOffset as number)
      && isSafeSnapshotBoundary(snapshot, session.cursorOffset as number)
      && !keyNeedsLineContext(input.key)) {
      return insertPayload(snapshot, '', session.cursorOffset as number, session, text, 'continued');
    }
  }

  // Bounded forward: ordinary keys touch at most a handful of units past the
  // cursor. A paste/register payload can be large, so widen the margin to its
  // known length rather than re-reading the whole (possibly huge) line.
  const forwardMargin = input.kind === 'paste' && pasted !== undefined
    ? pasted.length + INSERT_KEY_FORWARD_MARGIN
    : INSERT_KEY_FORWARD_MARGIN;
  const line = readLineWindow(snapshot, session.cursorOffset as number, forwardMargin);
  if (line === undefined) return failure('snapshot-read-failed');
  const source = line.text;
  const cursor = (session.cursorOffset as number) - line.start;
  if (!isSafeBoundary(source, cursor)) return failure('invalid-cursor');
  if (input.kind === 'paste') {
    if (pasted === undefined) return failure('invalid-input');
    return insertPayload(snapshot, source, line.start, freezeSession({ ...session, pending: NONE_PENDING }), pasted, 'continued');
  }
  if (typeof input.key !== 'string' || input.key.length === 0 || !isWellFormed(input.key)) return failure('invalid-input');
  return planKey(snapshot, source, line.start, session, input.key);
}

/** Apply register text returned by the register owner for the exact pending request. */
export function planVimInsertRegisterPayload(
  snapshot: DocumentSnapshot,
  session: VimInsertSession,
  payload: VimInsertRegisterPayload,
): VimInsertResult<VimInsertTransition> {
  if (snapshot.id !== session.documentId) return failure('wrong-document');
  if (!isSessionValid(session) || session.pending.kind !== 'register-payload') return failure('invalid-session');
  const request = session.pending.request;
  if (payload.requestId !== request.requestId || request.documentId !== snapshot.id
    || request.expectedVersion !== snapshot.version || request.cursorOffset !== session.cursorOffset) {
    return failure('stale-register-request');
  }
  if (typeof payload.text !== 'string' || !isUnicodeScalarText(payload.text)) return failure('invalid-input');
  const line = readLineWindow(snapshot, session.cursorOffset as number, payload.text.length + INSERT_KEY_FORWARD_MARGIN);
  if (line === undefined) return failure('snapshot-read-failed');
  const cursor = (session.cursorOffset as number) - line.start;
  if (!isSafeBoundary(line.text, cursor)) return failure('invalid-cursor');
  const cleared = freezeSession({ ...session, pending: NONE_PENDING });
  return insertPayload(snapshot, line.text, line.start, cleared, payload.text, 'continued', true);
}

function planKey(
  snapshot: DocumentSnapshot,
  source: string,
  base: number,
  session: VimInsertSession,
  key: string,
): VimInsertResult<VimInsertTransition> {
  if (session.suspendedForNormalCommand) return failure('invalid-session');
  if (session.pending.kind === 'register-payload') return failure('invalid-session');
  if (session.pending.kind === 'register-name') {
    if (key === '<Esc>' || key === '<C-c>') {
      const cleared = freezeSession({ ...session, pending: NONE_PENDING });
      return success(continued(snapshot, cleared, [], 'continued'));
    }
    const registerName = textKey(key);
    if (registerName === undefined) return failure('invalid-input');
    const request: VimInsertRegisterRequest = Object.freeze({
      requestId: session.pending.requestId,
      registerName,
      documentId: snapshot.id,
      expectedVersion: snapshot.version,
      cursorOffset: session.cursorOffset,
    });
    const next = freezeSession({ ...session, pending: Object.freeze({ kind: 'register-payload', request }) });
    return success(Object.freeze({
      kind: 'register-request' as const,
      mode: session.mode,
      session: next,
      request,
      plan: makePlan(snapshot, [], session.cursorOffset, 'none'),
    }));
  }
  if (session.pending.kind === 'literal') {
    const literal = literalText(key);
    if (literal === undefined) return failure('invalid-input');
    const cleared = freezeSession({ ...session, pending: NONE_PENDING });
    return insertPayload(snapshot, source, base, cleared, literal, 'continued');
  }
  if (session.pending.kind === 'digraph-first') {
    const value = textKey(key);
    if (value === undefined) return failure('invalid-input');
    const next = freezeSession({ ...session, pending: Object.freeze({ kind: 'digraph-second', value }) });
    return success(continued(snapshot, next, [], 'continued'));
  }
  if (session.pending.kind === 'digraph-second') {
    const value = textKey(key);
    if (value === undefined) return failure('invalid-input');
    const digraph = digraphValue(session.pending.value, value);
    if (digraph === undefined) return failure('invalid-input');
    const cleared = freezeSession({ ...session, pending: NONE_PENDING });
    const textIntent = digraph === '\r' ? 'literal-control' : undefined;
    return insertPayload(snapshot, source, base, cleared, digraph, 'continued', true, textIntent);
  }
  if (session.pending.kind === 'control-g') {
    const next = freezeSession({ ...session, pending: NONE_PENDING });
    if (key === 'u') {
      const broken = freezeSession({ ...next, undoEpoch: next.undoEpoch + 1 });
      return success(continued(snapshot, broken, [], 'continued', 'break'));
    }
    return success(ignored(snapshot, next));
  }

  if (key === '<Esc>' || key === '<C-c>') return exitInsert(snapshot, source, base, session, key === '<Esc>' ? 'escape' : 'ctrl-c');
  if (key === '<C-r>') {
    if (!Number.isSafeInteger(session.nextRegisterRequestId + 1)) return failure('invalid-session');
    const next = freezeSession({
      ...session,
      nextRegisterRequestId: session.nextRegisterRequestId + 1,
      pending: Object.freeze({ kind: 'register-name', requestId: session.nextRegisterRequestId }),
    });
    return success(continued(snapshot, next, [], 'continued'));
  }
  if (key === '<C-o>') {
    const next = freezeSession({ ...session, suspendedForNormalCommand: true });
    return success(continued(snapshot, next, [], 'suspended', 'none'));
  }
  if (key === '<C-g>u') {
    const next = freezeSession({ ...session, undoEpoch: session.undoEpoch + 1 });
    return success(continued(snapshot, next, [], 'continued', 'break'));
  }
  if (key === '<C-g>') {
    const next = freezeSession({ ...session, pending: Object.freeze({ kind: 'control-g' }) });
    return success(continued(snapshot, next, [], 'continued'));
  }
  if (key === '<C-v>' || key === '<C-q>') {
    const next = freezeSession({ ...session, pending: Object.freeze({ kind: 'literal' }) });
    return success(continued(snapshot, next, [], 'continued'));
  }
  if (key === '<C-k>') {
    const next = freezeSession({ ...session, pending: Object.freeze({ kind: 'digraph-first' }) });
    return success(continued(snapshot, next, [], 'continued'));
  }
  if (key === '<BS>' || key === '<C-h>') return backspace(snapshot, source, base, session);
  if (key === '<Del>') return deleteForward(snapshot, source, base, session);
  if (key === '<CR>' || key === '<Enter>' || key === '<NL>') return insertNewline(snapshot, source, base, session);
  if (key === '<Tab>') return insertPayload(snapshot, source, base, session, tabText(source, base, session), 'continued');
  if (key === '<C-t>') return indentByShiftwidth(snapshot, source, base, session, true);
  if (key === '<C-d>') return indentByShiftwidth(snapshot, source, base, session, false);
  if (key === '<C-w>') return deletePreviousWord(snapshot, source, base, session);
  if (key === '<C-u>') return deleteToLineStart(snapshot, source, base, session);
  const text = textKey(key);
  if (text === undefined) return success(ignored(snapshot, session));
  return insertPayload(snapshot, source, base, session, text, 'continued');
}

function prepareEntry(
  source: string,
  cursor: number,
  key: VimInsertEntryKey,
  options: NormalizedVimInsertOptions,
): { readonly mode: VimInsertMode; readonly cursor: number; readonly edit: VimInsertEdit | null; readonly autoIndentSpan: { readonly start: Utf16Offset; readonly end: Utf16Offset } | null; readonly countRepeatPrefix: string } | undefined {
  const lines = lineRanges(source);
  const line = lines.find((range) => range.start <= cursor && cursor <= range.end);
  if (line === undefined) return undefined;
  let entry = cursor;
  let edit: VimInsertEdit | null = null;
  let autoIndentSpan: { readonly start: Utf16Offset; readonly end: Utf16Offset } | null = null;
  let countRepeatPrefix = '';
  let mode: VimInsertMode = key === 'R' ? 'replace' : key === 'gR' ? 'virtual-replace' : 'insert';
  switch (key) {
    case 'i': break;
    case 'gi': break;
    case 'gI': entry = line.start; break;
    case 'I': entry = firstNonblank(source, line.start, line.end); break;
    case 'a': entry = nextGrapheme(source, cursor, line.end); break;
    case 'A': entry = line.end; break;
    case 'o': {
      const indent = options.autoindent ? leadingIndent(source, line.start, line.end) : '';
      const at = line.end;
      edit = makeEdit(at, at, `\n${indent}`);
      entry = at + 1 + indent.length;
      countRepeatPrefix = `\n${indent}`;
      if (indent.length > 0) autoIndentSpan = { start: offset(at + 1), end: offset(entry) };
      break;
    }
    case 'O': {
      const indent = options.autoindent ? leadingIndent(source, line.start, line.end) : '';
      const at = line.start;
      edit = makeEdit(at, at, `${indent}\n`);
      entry = at + indent.length;
      countRepeatPrefix = `\n${indent}`;
      if (indent.length > 0) autoIndentSpan = { start: offset(at), end: offset(entry) };
      break;
    }
    case 'R':
    case 'gR': break;
  }
  return { mode, cursor: entry, edit, autoIndentSpan, countRepeatPrefix };
}

function insertPayload(
  snapshot: DocumentSnapshot,
  source: string,
  base: number,
  session: VimInsertSession,
  payload: string,
  kind: 'continued',
  allowCarriageReturn = false,
  textIntent?: VimInsertEdit['textIntent'],
): VimInsertResult<VimInsertTransition> {
  if (payload.length === 0) return success(continued(snapshot, session, [], kind));
  if (!(allowCarriageReturn ? isUnicodeScalarText(payload) : isWellFormed(payload))) return failure('invalid-input');
  const current = (session.cursorOffset as number) - base;
  const result = session.mode === 'insert' || payload.includes('\n')
    ? insertionEdit(current, payload)
    : session.mode === 'replace'
      ? replacePayload(source, current, payload)
      : virtualReplace(source, current, payload, session.options.tabstop);
  const nextTextLength = session.repeatText.length + payload.length;
  if (session.count > 1 && nextTextLength * session.count > MAX_REPEAT_UTF16) return failure('repeat-limit');
  const frame = 'frame' in result ? result.frame as ReplaceFrame : undefined;
  const globalFrame = frame === undefined ? undefined : translateFrame(frame, base);
  const stack: readonly ReplaceFrame[] = globalFrame === undefined ? session.replaceStack : appendReplaceFrame(session.replaceStack, globalFrame);
  const cursorAfter = result.cursorAfter;
  const autoIndentHasContent = session.autoIndentSpan !== null
    && base + cursorAfter > (session.autoIndentSpan.end as number)
    ? true
    : session.autoIndentLineHasContent;
  const next = freezeSession({
    ...session,
    cursorOffset: offset(base + cursorAfter),
    repeatText: session.repeatText + payload,
    replaceStack: stack,
    autoIndentLineHasContent: autoIndentHasContent,
  });
  return success(continued(snapshot, next, [translateEdit(result.edit, base, textIntent)], kind));
}

function insertionEdit(cursor: number, value: string): { readonly edit: VimInsertEdit; readonly cursorAfter: number } {
  const edit = makeEdit(cursor, cursor, value);
  return { edit, cursorAfter: cursor + value.length };
}

function replacePayload(source: string, cursor: number, value: string): { readonly edit: VimInsertEdit; readonly cursorAfter: number; readonly frame: ReplaceFrame } {
  // `source` is always a single physical line (readLineWindow never crosses a
  // line boundary), so the line range is trivially the whole string; scanning
  // it with `lineRanges` on every keystroke cost O(line length) for nothing.
  const line = { start: 0, end: source.length };
  let end = cursor;
  for (const _grapheme of graphemes(value)) {
    if (end >= line.end) break;
    end = nextGrapheme(source, end, line.end);
  }
  const replaced = source.slice(cursor, end);
  const edit = makeEdit(cursor, end, value);
  const frame: ReplaceFrame = Object.freeze({ start: offset(cursor), insertedText: value, replacedText: replaced, cursorBefore: offset(cursor) });
  return { edit, cursorAfter: cursor + value.length, frame };
}

function virtualReplace(source: string, cursor: number, value: string, tabstop: number): { readonly edit: VimInsertEdit; readonly cursorAfter: number; readonly frame: ReplaceFrame } {
  // See replacePayload: `source` is always a single line, so the range is trivial.
  const line = { start: 0, end: source.length };
  if (cursor >= line.end) {
    const inserted = insertionEdit(cursor, value);
    return { ...inserted, frame: Object.freeze({ start: offset(cursor), insertedText: value, replacedText: '', cursorBefore: offset(cursor) }) };
  }
  const initialColumn = displayColumn(source, line.start, cursor, tabstop);
  let insertedWidth = 0;
  let payloadColumn = initialColumn;
  for (const grapheme of graphemes(value)) {
    const width = graphemeWidth(grapheme, payloadColumn, tabstop);
    insertedWidth += width;
    payloadColumn += width;
  }
  let position = cursor;
  let column = initialColumn;
  let replacedWidth = 0;
  let lastWasTab = false;
  while (position < line.end && replacedWidth < insertedWidth) {
    const end = nextGrapheme(source, position, line.end);
    const grapheme = source.slice(position, end);
    const width = graphemeWidth(grapheme, column, tabstop);
    lastWasTab = grapheme === '\t';
    replacedWidth += width;
    column += width;
    position = end;
  }
  let remainder = '';
  if (replacedWidth > insertedWidth) {
    remainder = lastWasTab ? '\t' : ' '.repeat(replacedWidth - insertedWidth);
  }
  const effective = value + remainder;
  const edit = makeEdit(cursor, position, effective);
  const frame: ReplaceFrame = Object.freeze({ start: offset(cursor), insertedText: effective, replacedText: source.slice(cursor, position), cursorBefore: offset(cursor) });
  return { edit, cursorAfter: cursor + value.length, frame };
}

/**
 * Apply one virtual-replace payload against a line-local source. The direct
 * Normal-mode `gr{char}` command shares this exact display-width behavior
 * with `gR`; callers translate the returned line-local edit to document
 * coordinates and keep the document as the only text owner.
 */
export function calculateVimVirtualReplace(
  source: string,
  cursor: number,
  value: string,
  tabstop: number,
): { readonly edit: VimInsertEdit; readonly cursorAfter: number } {
  const result = virtualReplace(source, cursor, value, tabstop);
  return Object.freeze({ edit: result.edit, cursorAfter: result.cursorAfter });
}

function insertNewline(snapshot: DocumentSnapshot, source: string, base: number, session: VimInsertSession): VimInsertResult<VimInsertTransition> {
  const cursor = (session.cursorOffset as number) - base;
  if (!isSafeBoundary(source, cursor)) return failure('invalid-cursor');
  const indent = session.options.autoindent ? leadingIndent(source, 0, source.length) : '';
  const value = `\n${indent}`;
  const nextCursor = base + cursor + value.length;
  const next = freezeSession({
    ...session,
    cursorOffset: offset(nextCursor),
    repeatText: session.repeatText + value,
    replaceStack: [],
    autoIndentSpan: indent.length > 0 ? { start: offset(base + cursor + 1), end: offset(nextCursor) } : null,
    autoIndentLineHasContent: false,
  });
  return success(continued(snapshot, next, [makeEdit(base + cursor, base + cursor, value)], 'continued'));
}

function backspace(snapshot: DocumentSnapshot, source: string, base: number, session: VimInsertSession): VimInsertResult<VimInsertTransition> {
  const top = session.replaceStack.at(-1);
  if (top !== undefined && session.mode !== 'insert') {
    const start = top.start as number;
    const end = start + top.insertedText.length;
    const nextStack = popReplaceFrame(session.replaceStack);
    const next = freezeSession({
      ...session,
      cursorOffset: top.cursorBefore,
      replaceStack: nextStack,
      repeatText: session.repeatText.slice(0, Math.max(0, session.repeatText.length - top.insertedText.length)),
    });
    return success(continued(snapshot, next, [makeEdit(start, end, top.replacedText, literalControlIntent(top.replacedText))], 'continued'));
  }
  const cursor = (session.cursorOffset as number) - base;
  const absoluteCursor = base + cursor;
  if (cursor < 0 || cursor > source.length) return failure('invalid-cursor');
  if (cursor === 0 && base === 0) return success(ignored(snapshot, session));
  const crossesLine = cursor === 0;
  const previous = crossesLine ? absoluteCursor - 1 : base + previousGrapheme(source, cursor, 0);
  const absoluteEnd = absoluteCursor;
  const isNewline = crossesLine;
  if (isNewline && !hasOption(session.options, 'eol') && !hasOption(session.options, 'start')) return success(ignored(snapshot, session));
  const beforeEntry = previous < (session.entryOffset as number);
  const previousChar = crossesLine ? '\n' : source.charAt(previous - base);
  const deletingIndent = !crossesLine && previous < absoluteCursor && isIndentCharacter(previousChar) && previous < (session.entryOffset as number);
  const indentSpan = session.autoIndentSpan;
  const deletingAutoIndent = indentSpan !== null
    && previous >= (indentSpan.start as number)
    && absoluteCursor <= (indentSpan.end as number);
  if (beforeEntry && !hasOption(session.options, 'start') && !(deletingAutoIndent && hasOption(session.options, 'indent'))) return success(ignored(snapshot, session));
  if (deletingIndent && !hasOption(session.options, 'indent') && beforeEntry) return success(ignored(snapshot, session));
  const deletedText = crossesLine ? '\n' : source.slice(previous - base, cursor);
  const nextIndentSpan = adjustSpanAfterEdit(session.autoIndentSpan, previous, absoluteEnd, '');
  const next = freezeSession({
    ...session,
    cursorOffset: offset(previous),
    repeatText: removeSuffix(session.repeatText, deletedText),
    autoIndentSpan: nextIndentSpan,
    autoIndentLineHasContent: session.autoIndentSpan !== null
      && previous > (session.autoIndentSpan.end as number),
  });
  return success(continued(snapshot, next, [makeEdit(previous, absoluteEnd, '')], 'continued'));
}

function deleteForward(snapshot: DocumentSnapshot, source: string, base: number, session: VimInsertSession): VimInsertResult<VimInsertTransition> {
  const cursor = (session.cursorOffset as number) - base;
  if (!isSafeBoundary(source, cursor) || cursor >= source.length) return success(ignored(snapshot, session));
  const end = nextGrapheme(source, cursor, source.length);
  const absoluteCursor = base + cursor;
  const absoluteEnd = base + end;
  const deleted = source.slice(cursor, end);
  const next = freezeSession({
    ...session,
    repeatText: removeSuffix(session.repeatText, deleted),
    autoIndentSpan: adjustSpanAfterEdit(session.autoIndentSpan, absoluteCursor, absoluteEnd, ''),
  });
  return success(continued(snapshot, next, [makeEdit(absoluteCursor, absoluteEnd, '')], 'continued'));
}

function deletePreviousWord(snapshot: DocumentSnapshot, source: string, base: number, session: VimInsertSession): VimInsertResult<VimInsertTransition> {
  const cursor = (session.cursorOffset as number) - base;
  if (!isSafeBoundary(source, cursor) || cursor <= 0) return success(ignored(snapshot, session));
  const lowerBound = Math.max(0, (session.entryOffset as number) - base);
  if (cursor <= lowerBound) return success(ignored(snapshot, session));
  let start = cursor;
  while (start > lowerBound) {
    const previous = previousGrapheme(source, start, lowerBound);
    if (!/\s/u.test(source.slice(previous, start))) break;
    start = previous;
  }
  while (start > lowerBound) {
    const previous = previousGrapheme(source, start, lowerBound);
    if (/\s/u.test(source.slice(previous, start))) break;
    start = previous;
  }
  const removed = source.slice(start, cursor);
  const absoluteStart = base + start;
  const absoluteCursor = base + cursor;
  const next = freezeSession({
    ...session,
    cursorOffset: offset(absoluteStart),
    repeatText: removeSuffix(session.repeatText, removed),
    replaceStack: [],
    autoIndentSpan: adjustSpanAfterEdit(session.autoIndentSpan, absoluteStart, absoluteCursor, ''),
    autoIndentLineHasContent: false,
  });
  return success(continued(snapshot, next, [makeEdit(absoluteStart, absoluteCursor, '')], 'continued'));
}

function deleteToLineStart(snapshot: DocumentSnapshot, source: string, base: number, session: VimInsertSession): VimInsertResult<VimInsertTransition> {
  const cursor = (session.cursorOffset as number) - base;
  if (!isSafeBoundary(source, cursor) || cursor === 0) return success(ignored(snapshot, session));
  const removableStart = Math.max(0, (session.entryOffset as number) - base);
  if (removableStart >= cursor) return success(ignored(snapshot, session));
  const removed = source.slice(removableStart, cursor);
  const absoluteStart = base + removableStart;
  const absoluteCursor = base + cursor;
  const next = freezeSession({ ...session, cursorOffset: offset(absoluteStart), repeatText: removeSuffix(session.repeatText, removed), replaceStack: [] });
  return success(continued(snapshot, next, [makeEdit(absoluteStart, absoluteCursor, '')], 'continued'));
}

function indentByShiftwidth(snapshot: DocumentSnapshot, source: string, base: number, session: VimInsertSession, increase: boolean): VimInsertResult<VimInsertTransition> {
  const cursor = (session.cursorOffset as number) - base;
  if (!isSafeBoundary(source, cursor)) return failure('invalid-cursor');
  const prefix = source.slice(0, cursor);
  if (prefix.trim().length > 0) return success(ignored(snapshot, session));
  const cells = displayColumn(source, 0, cursor, session.options.tabstop);
  const nextCells = increase
    ? Math.ceil((cells + 1) / session.options.shiftwidth) * session.options.shiftwidth
    : Math.max(0, Math.floor((Math.max(0, cells - 1)) / session.options.shiftwidth) * session.options.shiftwidth);
  const delta = nextCells - cells;
  if (delta === 0) return success(ignored(snapshot, session));
  const value = increase ? indentText(delta, session.options) : '';
  const removeStart = increase ? cursor : indentationStart(source, 0, cursor);
  const replacement = increase ? value : prefix.slice(0, Math.max(0, prefix.length - -delta));
  const edit = makeEdit(base + removeStart, base + cursor, replacement);
  const nextCursor = base + removeStart + replacement.length;
  const next = freezeSession({
    ...session,
    cursorOffset: offset(nextCursor),
    replaceStack: [],
    repeatText: increase ? session.repeatText + value : removeSuffix(session.repeatText, source.slice(removeStart, cursor)),
    autoIndentSpan: adjustSpanAfterEdit(session.autoIndentSpan, base + removeStart, base + cursor, replacement),
  });
  return success(continued(snapshot, next, [edit], 'continued'));
}

function exitInsert(snapshot: DocumentSnapshot, source: string, base: number, session: VimInsertSession, exitVia: 'escape' | 'ctrl-c'): VimInsertResult<VimInsertTransition> {
  const edits: VimInsertEdit[] = [];
  let finalSource = source;
  let finalCursor = (session.cursorOffset as number) - base;
  const indentSpan = session.autoIndentSpan;
  if (indentSpan !== null && !session.autoIndentLineHasContent) {
    const start = (indentSpan.start as number) - base;
    const end = (indentSpan.end as number) - base;
    if (start <= end && source.slice(start, end).trim().length === 0) {
      edits.push(makeEdit(base + start, base + end, ''));
      finalSource = source.slice(0, start) + source.slice(end);
      finalCursor = start;
    }
  }
  const repeatUnit = session.countRepeatPrefix + session.repeatText;
  if (session.count > 1 && repeatUnit.length > 0 && session.mode === 'insert') {
    const repeat = repeatUnit.repeat(session.count - 1);
    if (repeat.length + repeatUnit.length > MAX_REPEAT_UTF16) return failure('repeat-limit');
    const at = finalCursor;
    edits.push(makeEdit(base + at, base + at, repeat, literalControlIntent(repeat)));
    finalSource = finalSource.slice(0, at) + repeat + finalSource.slice(at);
    finalCursor += repeat.length;
  }
  const normalCursor = previousGrapheme(finalSource, finalCursor, lineStartAt(finalSource, finalCursor));
  const plan = makePlan(snapshot, edits, offset(base + normalCursor), 'close');
  return success(Object.freeze({
    kind: 'exited',
    mode: 'normal',
    session: null,
    exitVia,
    lastInsertCursorOffset: offset(base + finalCursor),
    plan,
  }));
}

function continued(
  snapshot: DocumentSnapshot,
  session: VimInsertSession,
  edits: readonly VimInsertEdit[],
  kind: 'continued' | 'suspended' | 'resumed' = 'continued',
  undoAction: VimInsertUndoAction = edits.length === 0 ? 'none' : 'continue',
): VimInsertTransition {
  return Object.freeze({ kind, mode: session.mode, session, plan: makePlan(snapshot, edits, session.cursorOffset, undoAction) });
}

function ignored(snapshot: DocumentSnapshot, session: VimInsertSession): VimInsertTransition {
  return Object.freeze({ kind: 'ignored', mode: session.mode, session, plan: makePlan(snapshot, [], session.cursorOffset, 'none') });
}

function makePlan(snapshot: DocumentSnapshot, edits: readonly VimInsertEdit[], cursorOffset: Utf16Offset, undoAction: VimInsertUndoAction): VimInsertPlan {
  return Object.freeze({
    documentId: snapshot.id,
    expectedVersion: snapshot.version,
    edits: Object.freeze(edits.map((edit) => Object.freeze({ ...edit }))),
    cursorOffset,
    undoAction,
  });
}

function freezeSession(session: VimInsertSession): VimInsertSession {
  const pending = session.pending.kind === 'none'
    ? NONE_PENDING
    : session.pending.kind === 'register-payload'
      ? Object.freeze({ ...session.pending, request: Object.freeze({ ...session.pending.request }) })
      : Object.freeze({ ...session.pending });
  return Object.freeze({
    ...session,
    pending,
    // Frames are already frozen where they are created (translateFrame,
    // replacePayload, virtualReplace); re-cloning and re-freezing every
    // frame here on every keystroke made a long Replace/Virtual-replace
    // session's per-key cost grow with the stack depth. The array itself is
    // deliberately left extensible (not frozen) so appendReplaceFrame/
    // popReplaceFrame below can keep mutating it in place at O(1); nothing
    // outside this session chain retains an older generation's reference.
    replaceStack: session.replaceStack,
    options: Object.freeze({ ...session.options, backspace: Object.freeze([...session.options.backspace]) }),
    autoIndentSpan: session.autoIndentSpan === null ? null : Object.freeze({ ...session.autoIndentSpan }),
  });
}

/**
 * Append onto the session's privately-owned frame stack in place when it is
 * still extensible, avoiding an O(n) copy per keystroke in a long Replace/
 * Virtual-replace session. Falls back to a copy for a stack that arrived
 * frozen (e.g. remapped through an external edit by another session), since
 * that array may be shared or the shared frozen singleton.
 */
function appendReplaceFrame(stack: readonly ReplaceFrame[], frame: ReplaceFrame): readonly ReplaceFrame[] {
  if (Object.isExtensible(stack)) {
    (stack as ReplaceFrame[]).push(frame);
    return stack;
  }
  return [...stack, frame];
}

/** Symmetric in-place pop for backspace over a Replace/Virtual-replace frame; see appendReplaceFrame. */
function popReplaceFrame(stack: readonly ReplaceFrame[]): readonly ReplaceFrame[] {
  if (Object.isExtensible(stack)) {
    (stack as ReplaceFrame[]).pop();
    return stack;
  }
  return stack.slice(0, -1);
}

function normalizeOptions(options: VimInsertOptions): NormalizedVimInsertOptions | undefined {
  if (typeof options !== 'object' || options === null) return undefined;
  const backspaceText = options.backspace ?? 'indent,eol,start';
  if (typeof backspaceText !== 'string') return undefined;
  const backspaceSet = new Set(backspaceText === '' ? [] : backspaceText.split(',').map((part) => part.trim()));
  if ([...backspaceSet].some((value) => value !== 'indent' && value !== 'eol' && value !== 'start')) return undefined;
  const shiftwidth = options.shiftwidth ?? DEFAULT_OPTIONS.shiftwidth;
  const tabstop = options.tabstop ?? DEFAULT_OPTIONS.tabstop;
  const softtabstop = options.softtabstop ?? DEFAULT_OPTIONS.softtabstop;
  if (![shiftwidth, tabstop, softtabstop].every((value) => Number.isSafeInteger(value) && value >= 0)
    || tabstop === 0 || shiftwidth > 256 || tabstop > 256 || softtabstop > 256) return undefined;
  if (options.autoindent !== undefined && typeof options.autoindent !== 'boolean') return undefined;
  if (options.expandtab !== undefined && typeof options.expandtab !== 'boolean') return undefined;
  return Object.freeze({
    backspace: Object.freeze(['indent', 'eol', 'start'].filter((value): value is VimBackspaceOption => backspaceSet.has(value))),
    autoindent: options.autoindent ?? false,
    expandtab: options.expandtab ?? false,
    shiftwidth: shiftwidth === 0 ? tabstop : shiftwidth,
    tabstop,
    softtabstop,
  });
}

function isSessionValid(session: VimInsertSession): boolean {
  // `repeatText` and `replaceStack` are append-only for the life of a
  // session: every increment is already validated at the point it is added
  // (insertPayload checks the incoming payload with isWellFormed/
  // isUnicodeScalarText before appending; every frame is built from that
  // same validated payload or from existing, already-well-formed document
  // text). Re-scanning the whole accumulated string/array here on every
  // public entry call made a long Replace/Virtual-replace session's
  // per-keystroke validation cost grow with the session's length, turning
  // ordinary typing quadratic. Only the cheap, non-accumulating fields are
  // re-checked on every call.
  return (session.mode === 'insert' || session.mode === 'replace' || session.mode === 'virtual-replace')
    && Number.isSafeInteger(session.count) && session.count >= 1
    && Number.isSafeInteger(session.nextRegisterRequestId) && session.nextRegisterRequestId >= 1
    && Number.isSafeInteger(session.undoEpoch) && session.undoEpoch >= 0
    && isPendingValid(session.pending);
}

function isPendingValid(pending: VimInsertPendingInput): boolean {
  switch (pending.kind) {
    case 'none':
    case 'literal':
    case 'digraph-first':
    case 'control-g': return true;
    case 'digraph-second': return isUnicodeScalarText(pending.value);
    case 'register-name': return Number.isSafeInteger(pending.requestId) && pending.requestId >= 1;
    case 'register-payload': {
      const request = pending.request;
      return Number.isSafeInteger(request.requestId) && request.requestId >= 1
        && typeof request.registerName === 'string' && request.registerName.length > 0
        && Number.isSafeInteger(request.cursorOffset as number);
    }
  }
}

/** Single-key insert payloads never exceed a few units; this covers digraphs, tabs and control keys generously. */
const INSERT_KEY_FORWARD_MARGIN = 256;

/**
 * Read the current line, bounded forward of `absoluteOffset` by `forwardMargin`
 * units when given. Backward reach always extends to the true line start,
 * since Tab/`<C-t>`/`<C-d>`/`<C-u>`/autoindent semantics need the exact
 * column-from-line-start context; only the trailing portion past the cursor,
 * which ordinary keys never touch beyond a small bounded amount, is capped so
 * a single keystroke on a huge line does not re-materialize the whole line.
 */
function readLineWindow(snapshot: DocumentSnapshot, absoluteOffset: number, forwardMargin?: number): LineWindow | undefined {
  if (!Number.isSafeInteger(absoluteOffset) || absoluteOffset < 0 || absoluteOffset > snapshot.lengthUtf16) return undefined;
  const lineResult = snapshot.lineIndexAt(offset(absoluteOffset));
  if (!lineResult.ok) return undefined;
  const lineIndex = lineResult.value;
  const startResult = snapshot.lineStartOffset(lineIndex);
  if (!startResult.ok) return undefined;
  const start = startResult.value as number;
  let lineEnd = snapshot.lengthUtf16;
  if ((lineIndex as number) + 1 < snapshot.lineCount) {
    const nextStartResult = snapshot.lineStartOffset((lineIndex as number + 1) as LineIndex);
    if (!nextStartResult.ok) return undefined;
    lineEnd = (nextStartResult.value as number) - 1;
  }
  const end = forwardMargin === undefined ? lineEnd : Math.min(lineEnd, absoluteOffset + forwardMargin);
  const textResult = snapshot.slice(offset(start), offset(end));
  if (!textResult.ok) return undefined;
  return Object.freeze({ text: textResult.value, start, end, lineIndex });
}

/** Validate one UTF-16 cursor boundary using at most two code units of text. */
function isSafeSnapshotBoundary(snapshot: DocumentSnapshot, absoluteOffset: number): boolean {
  if (!Number.isSafeInteger(absoluteOffset) || absoluteOffset < 0 || absoluteOffset > snapshot.lengthUtf16) return false;
  if (absoluteOffset === 0 || absoluteOffset === snapshot.lengthUtf16) return true;
  const sample = snapshot.slice(offset(absoluteOffset - 1), offset(absoluteOffset + 1));
  if (!sample.ok) return false;
  return !(sample.value.length === 2
    && isHighSurrogate(sample.value.charCodeAt(0))
    && isLowSurrogate(sample.value.charCodeAt(1)));
}

const MAX_SEMANTIC_LINE_READ_UTF16 = 8_192;

/** Use local reads only after checking the line is large enough to make a full read costly. */
function canUseBoundedLineRead(snapshot: DocumentSnapshot, absoluteOffset: number): boolean {
  if (!Number.isSafeInteger(absoluteOffset) || absoluteOffset < 0 || absoluteOffset > snapshot.lengthUtf16) return false;
  const lineResult = snapshot.lineIndexAt(offset(absoluteOffset));
  if (!lineResult.ok) return false;
  const startResult = snapshot.lineStartOffset(lineResult.value);
  if (!startResult.ok) return false;
  const lineIndex = lineResult.value as number;
  let end = snapshot.lengthUtf16;
  if (lineIndex + 1 < snapshot.lineCount) {
    const nextStart = snapshot.lineStartOffset((lineIndex + 1) as LineIndex);
    if (!nextStart.ok) return false;
    end = (nextStart.value as number) - 1;
  }
  return end - (startResult.value as number) > MAX_SEMANTIC_LINE_READ_UTF16;
}

function keyNeedsLineContext(key: string): boolean {
  return key === '<CR>' || key === '<Enter>' || key === '<NL>' || key === '<Tab>'
    || key === '<BS>' || key === '<C-h>' || key === '<Del>' || key === '<C-t>'
    || key === '<C-d>' || key === '<C-w>' || key === '<C-u>' || key === '<Esc>'
    || key === '<C-c>' || key === '<C-o>' || key === '<C-r>' || key === '<C-g>'
    || key === '<C-g>u' || key === '<C-v>' || key === '<C-q>' || key === '<C-k>';
}

function translateEdit(edit: VimInsertEdit, base: number, textIntent?: VimInsertEdit['textIntent']): VimInsertEdit {
  return makeEdit(
    base + (edit.start as number),
    base + (edit.end as number),
    edit.text,
    textIntent ?? edit.textIntent,
  );
}

function translateFrame(frame: ReplaceFrame, base: number): ReplaceFrame {
  return Object.freeze({
    ...frame,
    start: offset(base + (frame.start as number)),
    cursorBefore: offset(base + (frame.cursorBefore as number)),
  });
}

function lineRanges(text: string): { readonly start: number; readonly end: number }[] {
  const lines: { start: number; end: number }[] = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index === text.length || text.charAt(index) === '\n') {
      lines.push({ start, end: index });
      start = index + 1;
    }
  }
  return lines;
}

function firstNonblank(source: string, start: number, end: number): number {
  let offsetValue = start;
  while (offsetValue < end && (source.charAt(offsetValue) === ' ' || source.charAt(offsetValue) === '\t')) offsetValue = nextScalar(source, offsetValue, end);
  return offsetValue;
}

function leadingIndent(source: string, start: number, end: number): string {
  let cursor = start;
  while (cursor < end && (source.charAt(cursor) === ' ' || source.charAt(cursor) === '\t')) cursor = nextScalar(source, cursor, end);
  return source.slice(start, cursor);
}

function tabText(source: string, base: number, session: VimInsertSession): string {
  if (!session.options.expandtab) return '\t';
  const cursor = (session.cursorOffset as number) - base;
  const column = displayColumn(source, 0, cursor, session.options.tabstop);
  const width = session.options.softtabstop > 0 ? session.options.softtabstop : session.options.shiftwidth;
  const spaces = width - (column % width || 0);
  return ' '.repeat(spaces === 0 ? width : spaces);
}

function indentText(cells: number, options: NormalizedVimInsertOptions): string {
  return options.expandtab ? ' '.repeat(cells) : '\t'.repeat(Math.floor(cells / options.tabstop)) + ' '.repeat(cells % options.tabstop);
}

function indentationStart(source: string, lineStart: number, cursor: number): number {
  let start = cursor;
  while (start > lineStart && (source.charAt(start - 1) === ' ' || source.charAt(start - 1) === '\t')) start -= 1;
  return start;
}

function firstGrapheme(value: string): string {
  return graphemes(value)[0] ?? '';
}

function graphemes(value: string): readonly string[] {
  const result: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    if (value.charAt(cursor) === '\n') {
      result.push('\n');
      cursor += 1;
      continue;
    }
    const newline = value.indexOf('\n', cursor);
    const lineEnd = newline < 0 ? value.length : newline;
    const end = nextGrapheme(value, cursor, lineEnd);
    if (end <= cursor) {
      result.push(scalarAt(value, cursor));
      cursor = nextScalar(value, cursor, lineEnd);
    } else {
      result.push(value.slice(cursor, end));
      cursor = end;
    }
  }
  return Object.freeze(result);
}

function nextGrapheme(source: string, cursor: number, lineEnd: number): number {
  if (cursor >= lineEnd) return cursor;
  let next = nextScalar(source, cursor, lineEnd);
  let joinNext = false;
  while (next < lineEnd) {
    const scalar = scalarAt(source, next);
    if (joinNext || scalar === '\u200d' || /\p{M}|\p{Emoji_Modifier}/u.test(scalar) || /[\uFE00-\uFE0F]/u.test(scalar)) {
      joinNext = scalar === '\u200d';
      next = nextScalar(source, next, lineEnd);
    } else break;
  }
  return next;
}

function previousGrapheme(source: string, cursor: number, lowerBound: number): number {
  if (cursor <= lowerBound) return cursor;
  let start = previousScalar(source, cursor, lowerBound);
  while (start > lowerBound) {
    const scalar = scalarAt(source, start);
    if (!/\p{M}|\p{Emoji_Modifier}/u.test(scalar) && scalar !== '\u200d' && source.charCodeAt(start - 1) !== 0x200d) break;
    start = previousScalar(source, start, lowerBound);
  }
  return start;
}

function displayColumn(source: string, start: number, end: number, tabstop: number): number {
  let column = 0;
  for (let cursor = start; cursor < end;) {
    const next = nextGrapheme(source, cursor, end);
    const grapheme = source.slice(cursor, next);
    column += graphemeWidth(grapheme, column, tabstop);
    cursor = next;
  }
  return column;
}

function graphemeWidth(value: string, column: number, tabstop: number): number {
  if (value === '\t') return tabstop - (column % tabstop);
  if (value.length === 0) return 0;
  if (value.includes('\u200d') || /\p{Extended_Pictographic}|\p{Emoji_Modifier}/u.test(value) || /\uFE0F/u.test(value)) return 2;
  let width = 0;
  for (const scalar of value) {
    if (/\p{M}/u.test(scalar)) continue;
    const code = scalar.codePointAt(0) ?? 0;
    if (isWide(code)) return 2;
    width = Math.max(width, 1);
  }
  return width;
}

function isWide(code: number): boolean {
  return code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x20000 && code <= 0x3fffd));
}

function nextScalar(source: string, cursor: number, end: number): number {
  if (cursor >= end) return cursor;
  const point = source.codePointAt(cursor);
  return Math.min(end, cursor + (point !== undefined && point > 0xffff ? 2 : 1));
}

function previousScalar(source: string, cursor: number, start: number): number {
  if (cursor <= start) return cursor;
  const unit = source.charCodeAt(cursor - 1);
  return cursor - (unit >= 0xdc00 && unit <= 0xdfff && cursor - 2 >= start ? 2 : 1);
}

function scalarAt(source: string, cursor: number): string { return String.fromCodePoint(source.codePointAt(cursor) ?? 0); }

function lineStartAt(source: string, cursor: number): number {
  const newline = source.lastIndexOf('\n', Math.max(-1, cursor - 1));
  return newline + 1;
}

function isSafeBoundary(source: string, cursor: number): boolean {
  return Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= source.length
    && !(cursor > 0 && cursor < source.length && isHighSurrogate(source.charCodeAt(cursor - 1)) && isLowSurrogate(source.charCodeAt(cursor)));
}

function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }

function textKey(key: string): string | undefined {
  const named: Readonly<Record<string, string>> = {
    '<Space>': ' ', '<Tab>': '\t', '<CR>': '\n', '<Enter>': '\n', '<NL>': '\n', '<Esc>': '\u001b',
    '<BS>': '\b', '<Del>': '\u007f', '<C-@>': '\u0000', '<C-a>': '\u0001', '<C-b>': '\u0002',
    '<C-c>': '\u0003', '<C-d>': '\u0004', '<C-e>': '\u0005', '<C-f>': '\u0006', '<C-g>': '\u0007',
    '<C-h>': '\b', '<C-i>': '\t', '<C-j>': '\n', '<C-k>': '\u000b', '<C-l>': '\u000c',
    '<C-m>': '\n', '<C-n>': '\u000e', '<C-o>': '\u000f', '<C-p>': '\u0010', '<C-q>': '\u0011',
    '<C-r>': '\u0012', '<C-s>': '\u0013', '<C-t>': '\u0014', '<C-u>': '\u0015', '<C-v>': '\u0016',
    '<C-w>': '\u0017', '<C-x>': '\u0018', '<C-y>': '\u0019', '<C-z>': '\u001a',
  };
  const value = named[key] ?? (key.startsWith('<') ? undefined : key);
  if (value === undefined || value.length === 0 || !isWellFormed(value)) return undefined;
  return firstGrapheme(value);
}

function literalText(key: string): string | undefined {
  if (key === '<Esc>') return '\u001b';
  if (key === '<CR>' || key === '<Enter>') return '\n';
  if (key === '<Tab>') return '\t';
  if (key === '<BS>') return '\b';
  return textKey(key);
}

function digraphValue(first: string, second: string): string | undefined {
  const sequence = `${first}${second}`;
  const value = lookupDefaultVimDigraph(sequence);
  if (value === undefined) return undefined;
  // The pinned default-table API returns "\n" for both NU and LF. In a live
  // buffer, Neovim's nvim_buf_get_lines() exposes either sequence as an
  // in-line NUL; neither result is a logical line break in that observation.
  if (sequence === 'NU' || sequence === 'LF') return '\u0000';
  return value;
}

function hasOption(options: NormalizedVimInsertOptions, value: VimBackspaceOption): boolean { return options.backspace.includes(value); }
function isIndentCharacter(value: string): boolean { return value === ' ' || value === '\t'; }
function removeSuffix(source: string, suffix: string): string { return source.endsWith(suffix) ? source.slice(0, -suffix.length) : source; }
function adjustSpanAfterEdit(
  span: VimInsertSession['autoIndentSpan'],
  editStart: number,
  editEnd: number,
  replacement: string,
): VimInsertSession['autoIndentSpan'] {
  if (span === null) return null;
  const start = span.start as number;
  const end = span.end as number;
  const insertedLength = replacement.length;
  const removedLength = editEnd - editStart;
  if (editEnd <= start) return { start: offset(start + insertedLength - removedLength), end: offset(end + insertedLength - removedLength) };
  if (editStart >= end) return span;
  if (editStart <= start && editEnd >= end) return null;
  if (editStart <= start) return { start: offset(editStart + insertedLength), end: offset(end + insertedLength - removedLength) };
  if (editStart >= start && editEnd <= end) return { start: offset(start), end: offset(end + insertedLength - removedLength) };
  return { start: offset(start), end: offset(Math.max(start, editStart + insertedLength)) };
}
function makeEdit(start: number, end: number, text: string, textIntent?: VimInsertEdit['textIntent']): VimInsertEdit {
  return Object.freeze({
    start: offset(start),
    end: offset(end),
    text,
    ...(textIntent === undefined ? {} : { textIntent }),
  });
}
function literalControlIntent(text: string): VimInsertEdit['textIntent'] | undefined {
  return text.includes('\r') ? 'literal-control' : undefined;
}
function offset(value: number): Utf16Offset { return value as Utf16Offset; }
function isEntryKey(value: string): value is VimInsertEntryKey { return ['i', 'I', 'a', 'A', 'o', 'O', 'R', 'gR', 'gi', 'gI'].includes(value); }
function isWellFormed(value: string): boolean {
  return isUnicodeScalarText(value) && !value.includes('\r');
}
function isUnicodeScalarText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (isHighSurrogate(code)) {
      if (!isLowSurrogate(value.charCodeAt(index + 1))) return false;
      index += 1;
    } else if (isLowSurrogate(code)) return false;
  }
  return true;
}
function success<T>(value: T): VimInsertResult<T> { return { ok: true, value }; }
function failure(kind: VimInsertFailure['kind']): VimInsertResult<never> { return { ok: false, error: { kind } }; }
