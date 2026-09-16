import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { asIdentifier, asUtf16Offset, type DocumentId, type LineIndex, type UndoGroupId, type Utf16Offset } from '../../../packages/primitives/src/index';
import { openTextDocument, type DocumentSnapshot, type TextFileDocument } from '../../../packages/document/src/index';
import {
  beginVimInsert,
  planVimInsertInput,
  resumeVimInsert,
  type VimInsertEntryKey,
  type VimInsertOptions,
  type VimInsertPlan,
  type VimInsertSession,
  type VimInsertTransition,
} from '../../../packages/vim/src/index';
import { planVimInsertRegisterPayload } from '../../../packages/vim/insert/index';
import type { VimInsertEntryContext, VimInsertLastContext } from '../../../packages/vim/insert/index';
import {
  DEFAULT_VIM_DIGRAPH_ENTRIES,
  DEFAULT_VIM_DIGRAPH_SOURCE,
  lookupDefaultVimDigraph,
} from '../../../packages/vim/insert/default-digraphs';
import { runOracleFixture, verifyOracleBundle } from '../../oracle/oracle-runner';
import type { OracleFixture } from '../../oracle/types';

interface Case {
  readonly id: string;
  readonly keys: string;
  readonly lines: readonly string[];
  readonly cursor?: { readonly line: number; readonly byteColumn0: number };
  readonly options?: VimInsertOptions;
  readonly compareCursor?: boolean;
}

const cases: readonly Case[] = [
  { id: 'T022-INSERT-ESCAPE-01', keys: 'iX<Esc>', lines: ['abcd'], cursor: { line: 1, byteColumn0: 1 } },
  { id: 'T022-INSERT-CTRLC-01', keys: 'iX<C-C>', lines: ['abcd'], cursor: { line: 1, byteColumn0: 1 } },
  { id: 'T022-INSERT-GROUPED-UNDO-01', keys: 'iXYZ<Esc>u', lines: ['abcd'], cursor: { line: 1, byteColumn0: 1 }, compareCursor: false },
  { id: 'T022-INSERT-COUNT-I-01', keys: '3iX<Esc>', lines: ['abcd'], cursor: { line: 1, byteColumn0: 1 } },
  { id: 'T022-INSERT-COUNT-A-01', keys: '3aX<Esc>', lines: ['abcd'], cursor: { line: 1, byteColumn0: 1 } },
  { id: 'T022-INSERT-COUNT-O-01', keys: '3oX<Esc>', lines: ['abcd'], cursor: { line: 1, byteColumn0: 1 } },
  { id: 'T022-INSERT-COUNT-CAP-O-01', keys: '3OX<Esc>', lines: ['abcd', 'z'], cursor: { line: 1, byteColumn0: 1 } },
  { id: 'T022-INSERT-I-FIRST-NONBLANK-01', keys: 'IX<Esc>', lines: ['  alpha'], cursor: { line: 1, byteColumn0: 4 } },
  { id: 'T022-INSERT-A-TO-EOL-01', keys: 'AX<Esc>', lines: ['abcd'], cursor: { line: 1, byteColumn0: 1 } },
  { id: 'T022-OPEN-LINE-ABOVE-01', keys: 'OX<Esc>', lines: ['  alpha', 'beta'], cursor: { line: 1, byteColumn0: 4 }, options: { autoindent: true } },
  { id: 'T022-REPLACE-BACKSPACE-RESTORE-01', keys: 'RXY<BS><Esc>', lines: ['abcd'], cursor: { line: 1, byteColumn0: 1 } },
  { id: 'T022-REPLACE-TAB-01', keys: 'R<Tab><Esc>', lines: ['abcd'], cursor: { line: 1, byteColumn0: 1 } },
  { id: 'T022-REPLACE-BACKSPACE-ALL-01', keys: 'RXY<BS><BS><Esc>', lines: ['abcd'], cursor: { line: 1, byteColumn0: 1 } },
  { id: 'T022-VREPLACE-ASCII-01', keys: 'gRXY<Esc>', lines: ['abcd'], cursor: { line: 1, byteColumn0: 1 } },
  { id: 'T022-VREPLACE-TAB-01', keys: 'gRX<Esc>', lines: ['a\tcd'], cursor: { line: 1, byteColumn0: 1 } },
  { id: 'T022-VREPLACE-WIDE-01', keys: 'gRX<Esc>', lines: ['a😀cd'], cursor: { line: 1, byteColumn0: 1 } },
  { id: 'T022-BACKSPACE-START-DENIED-01', keys: 'i<BS><Esc>', lines: ['abcd'], cursor: { line: 1, byteColumn0: 1 }, options: { backspace: '' } },
  { id: 'T022-BACKSPACE-START-ALLOWED-01', keys: 'i<BS><Esc>', lines: ['abcd'], cursor: { line: 1, byteColumn0: 1 }, options: { backspace: 'start' } },
  { id: 'T022-OPEN-LINE-AUTOINDENT-EMPTY-01', keys: 'o<Esc>', lines: ['  alpha', 'beta'], cursor: { line: 1, byteColumn0: 4 }, options: { autoindent: true, shiftwidth: 2, expandtab: true } },
  { id: 'T022-INSERT-NEWLINE-AUTOINDENT-01', keys: 'oX<CR>Y<Esc>', lines: ['  alpha', 'beta'], cursor: { line: 1, byteColumn0: 4 }, options: { autoindent: true, shiftwidth: 2, expandtab: true } },
  { id: 'T022-INSERT-AUTOINDENT-BACKSPACE-01', keys: 'o<BS><Esc>', lines: ['  alpha', 'beta'], cursor: { line: 1, byteColumn0: 4 }, options: { autoindent: true, backspace: 'indent,eol,start', shiftwidth: 2, expandtab: true } },
  { id: 'T022-INSERT-CTRL-TD-01', keys: 'i<C-T><C-D><Esc>', lines: ['  a'], cursor: { line: 1, byteColumn0: 2 }, options: { autoindent: true, shiftwidth: 2, expandtab: true } },
  { id: 'T022-INSERT-BACKSPACE-EOL-01', keys: 'iX<CR><BS><Esc>', lines: ['abcd'], cursor: { line: 1, byteColumn0: 1 }, options: { backspace: 'eol' } },
  { id: 'T022-INSERT-CTRL-W-01', keys: 'iabc<C-W><Esc>', lines: ['x'], cursor: { line: 1, byteColumn0: 1 } },
  { id: 'T022-INSERT-CTRL-U-01', keys: 'iabc<C-U><Esc>', lines: ['x'], cursor: { line: 1, byteColumn0: 1 } },
  { id: 'T022-INSERT-TAB-EXPAND-01', keys: 'i<Tab><Esc>', lines: ['a'], cursor: { line: 1, byteColumn0: 0 }, options: { expandtab: true, shiftwidth: 4, tabstop: 8 } },
  { id: 'T022-INSERT-CTRL-O-01', keys: 'iX<C-O>lY<Esc>', lines: ['abcd'], cursor: { line: 1, byteColumn0: 1 } },
  { id: 'T022-INSERT-DIGRAPH-01', keys: 'i<C-K>ox<Esc>', lines: ['ab'], cursor: { line: 1, byteColumn0: 0 } },
  { id: 'T022-DIGRAPH-DEFAULT-ACCENT-01', keys: 'i<C-K>ae<Esc>', lines: ['ab'], cursor: { line: 1, byteColumn0: 0 } },
  { id: 'T022-DIGRAPH-DEFAULT-FRACTION-01', keys: 'i<C-K>12<Esc>', lines: ['ab'], cursor: { line: 1, byteColumn0: 0 } },
  { id: 'T022-DIGRAPH-DEFAULT-ARROW-01', keys: 'i<C-K>-><Esc>', lines: ['ab'], cursor: { line: 1, byteColumn0: 0 } },
  { id: 'T022-DIGRAPH-DEFAULT-KANA-01', keys: 'i<C-K>Ka<Esc>', lines: ['ab'], cursor: { line: 1, byteColumn0: 0 } },
  { id: 'T022-DIGRAPH-DEFAULT-NU-ORACLE-01', keys: 'i<C-K>NU<Esc>', lines: ['ab'], cursor: { line: 1, byteColumn0: 0 } },
  { id: 'T022-DIGRAPH-DEFAULT-LF-ORACLE-01', keys: 'i<C-K>LF<Esc>', lines: ['ab'], cursor: { line: 1, byteColumn0: 0 } },
  { id: 'T022-INSERT-LITERAL-ESCAPE-01', keys: 'i<C-V><Esc><Esc>', lines: ['ab'], cursor: { line: 1, byteColumn0: 0 } },
  { id: 'T022-INSERT-UNDO-BREAK-01', keys: 'iX<C-G>uY<Esc>u', lines: ['ab'], cursor: { line: 1, byteColumn0: 0 }, compareCursor: false },
  { id: 'T022-INSERT-GI-LAST-LOCATION-01', keys: 'iX<Esc>0giY<Esc>', lines: ['abcd'], cursor: { line: 1, byteColumn0: 1 } },
  { id: 'T022-INSERT-GI-NO-LAST-INSERT-01', keys: 'giX<Esc>', lines: ['abcd'], cursor: { line: 1, byteColumn0: 1 } },
  { id: 'T022-INSERT-GI-COUNTED-LAST-LOCATION-01', keys: '3iX<Esc>giY<Esc>', lines: ['abcd'], cursor: { line: 1, byteColumn0: 0 } },
  { id: 'T022-INSERT-GI-CAP-START-01', keys: 'gIX<Esc>', lines: ['  alpha'], cursor: { line: 1, byteColumn0: 5 } },
];

const oracle = await verifyOracleBundle();
checkDefaultDigraphTable(oracle.binaryPath);
await checkCarriageReturnDigraph(oracle.binaryPath);
let differentialCount = 0;
for (const [caseIndex, fixtureCase] of cases.entries()) {
  const fixture = asOracleFixture(fixtureCase);
  const expected = (await runOracleFixture(fixture, oracle.binaryPath)).snapshots[0];
  assert.ok(expected, `T022-ORACLE-01 ${fixtureCase.id} has a result snapshot`);
  if (expected === undefined) throw new Error(`T022-ORACLE-01 ${fixtureCase.id} has no result snapshot`);
  const actual = await executeProduct(fixtureCase, caseIndex);
  assert.deepEqual(actual.lines, expected.lines, `T022-DIFF-TEXT-01 ${fixtureCase.id} matches pinned Neovim`);
  assert.equal(actual.mode, expected.mode, `T022-DIFF-MODE-01 ${fixtureCase.id} mode matches pinned Neovim`);
  assert.equal(actual.modified, expected.buffer.modified, `T022-DIFF-MODIFIED-01 ${fixtureCase.id} modified flag matches pinned Neovim`);
  if (fixtureCase.compareCursor !== false) {
    assert.equal(actual.cursor.line, expected.cursor.line, `T022-DIFF-CURSOR-LINE-01 ${fixtureCase.id} cursor line matches pinned Neovim`);
    assert.equal(actual.cursor.byteColumn, expected.cursor.byteColumn, `T022-DIFF-CURSOR-COLUMN-01 ${fixtureCase.id} cursor byte column matches pinned Neovim`);
  }
  if (fixtureCase.id === 'T022-DIGRAPH-DEFAULT-NU-ORACLE-01'
    || fixtureCase.id === 'T022-DIGRAPH-DEFAULT-LF-ORACLE-01') {
    assert.deepEqual(actual.lines, ['\u0000ab'],
      `T022-DIGRAPH-CONTROL-01 ${fixtureCase.id} matches the pinned live-buffer NUL observation`);
  }
  if (fixtureCase.id === 'T022-DIGRAPH-DEFAULT-NU-ORACLE-01') {
    assert.deepEqual(actual.serializedBytes, [0x00, 0x61, 0x62],
      'T022-DIGRAPH-NU-02 saving the live NU buffer preserves the NUL byte');
    checkNulReadOnlyReopen(fixtureCase.id, actual.serializedBytes);
  }
  differentialCount += 1;
}

checkOpaquePasteAndFailures();
checkLineWindowReads();
checkLastInsertContextFailures();
checkRegisterRequestHandoff(oracle.binaryPath);
console.log(`T022 passed ${differentialCount} pinned Neovim insert/replace differentials; verified all ${DEFAULT_VIM_DIGRAPH_SOURCE.entryCount} default digraph mappings, NU/LF live-buffer NUL behavior and binary reopen policy, CR literal-control serialization/reopen policy, and register handoff, line-window, paste and undo-group contracts`);
console.log(`oracle=Neovim ${oracle.manifest.oracle.version}; binary=${oracle.manifest.oracle.binarySha256}; runtimeDocs=${oracle.manifest.oracle.runtimeDocs.sha256}`);

async function executeProduct(fixtureCase: Case, caseIndex: number): Promise<{
  readonly lines: readonly string[];
  readonly modified: boolean;
  readonly mode: string;
  readonly cursor: { readonly line: number; readonly byteColumn: number };
  readonly serializedBytes: readonly number[];
}> {
  const documentIdResult = asIdentifier<DocumentId>(fixtureCase.id, 'documentId');
  assert.equal(documentIdResult.ok, true, `T022-DOCUMENT-01 ${fixtureCase.id} uses a valid ID`);
  if (!documentIdResult.ok) throw new Error(`T022-DOCUMENT-01 ${fixtureCase.id} has invalid ID`);
  const opened = openTextDocument(documentIdResult.value, new TextEncoder().encode(fixtureCase.lines.join('\n')));
  assert.equal(opened.kind, 'editable', `T022-DOCUMENT-02 ${fixtureCase.id} opens as editable text`);
  if (opened.kind !== 'editable') throw new Error(`T022-DOCUMENT-02 ${fixtureCase.id} is not editable`);
  const document = opened.document;
  const initial = document.snapshot();
  const initialCursor = cursorFromFixture(initial, fixtureCase);
  let currentCursor = initialCursor;
  let session: VimInsertSession | null = null;
  let groupIndex = 0;
  let groupOpen = false;
  let countDigits = '';
  let normalMode = true;
  let lastInsertContext: VimInsertLastContext | null = null;

  const tokens = tokenize(fixtureCase.keys);
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex] ?? '';
    if (session !== null && session.suspendedForNormalCommand) {
      const snapshot = document.snapshot();
      const normalOffset = previousScalarOffset(read(snapshot), session.cursorOffset as number);
      const moved = token === 'l' ? Math.min(read(snapshot).length, nextScalarOffset(read(snapshot), normalOffset)) : normalOffset;
      const resumedGap = nextScalarOffset(read(snapshot), moved);
      const resumed = resumeVimInsert(snapshot, session, toOffset(resumedGap));
      assert.equal(resumed.ok, true, `T022-CTRL-O-01 ${fixtureCase.id} resumes after one Normal command`);
      if (!resumed.ok) throw new Error(`T022-CTRL-O-01 ${fixtureCase.id} resume failed`);
      session = resumed.value.session;
      currentCursor = resumed.value.plan.cursorOffset;
      continue;
    }

    if (session === null) {
      if (/^[1-9]$/.test(token)) { countDigits += token; continue; }
      const count = countDigits.length === 0 ? 1 : Number(countDigits);
      countDigits = '';
      if (token === '0') {
        const snapshot = document.snapshot();
        const line = snapshot.lineIndexAt(currentCursor);
        if (line.ok) {
          const lineStart = snapshot.lineStartOffset(line.value);
          if (lineStart.ok) currentCursor = lineStart.value;
        }
        continue;
      }
      let entryKey: VimInsertEntryKey | undefined;
      if (token === 'g' && tokens[tokenIndex + 1] === 'R') { entryKey = 'gR'; tokenIndex += 1; }
      else if (token === 'g' && tokens[tokenIndex + 1] === 'i') { entryKey = 'gi'; tokenIndex += 1; }
      else if (token === 'g' && tokens[tokenIndex + 1] === 'I') { entryKey = 'gI'; tokenIndex += 1; }
      else if (token === 'i' || token === 'I' || token === 'a' || token === 'A' || token === 'o' || token === 'O' || token === 'R') entryKey = token;
      if (entryKey !== undefined) {
        const entryContext: VimInsertEntryContext = { lastInsert: lastInsertContext };
        const entered = beginVimInsert(document.snapshot(), currentCursor, entryKey, fixtureCase.options, count, entryContext);
        assert.equal(entered.ok, true, `T022-ENTRY-01 ${fixtureCase.id} enters ${entryKey}`);
        const applied = applyPlan(document, entered.value.plan, groupIndex, groupOpen);
        groupIndex = applied.groupIndex;
        groupOpen = applied.groupOpen;
        session = entered.value.session;
        currentCursor = entered.value.plan.cursorOffset;
        normalMode = false;
        continue;
      }
      if (token === 'u') {
        const undone = document.undo();
        assert.equal(undone.ok, true, `T022-UNDO-01 ${fixtureCase.id} undo succeeds`);
        if (!undone.ok) throw new Error(`T022-UNDO-01 ${fixtureCase.id} has no undo entry`);
        currentCursor = toOffset(0);
      }
      continue;
    }

    const inputSnapshot = document.snapshot();
    const outcome = planVimInsertInput(inputSnapshot, session, { kind: 'key', key: token });
    assert.equal(outcome.ok, true, `T022-INPUT-01 ${fixtureCase.id} accepts ${token}`);
    const transition: VimInsertTransition = outcome.value;
    for (const edit of transition.plan.edits) {
      if (edit.text.includes('\r')) {
        assert.equal(edit.textIntent, 'literal-control',
          `T022-DIGRAPH-CR-06 ${fixtureCase.id} marks literal CR content for the document owner`);
      }
    }
    const applied = applyPlan(document, transition.plan, groupIndex, groupOpen);
    groupIndex = applied.groupIndex;
    groupOpen = applied.groupOpen;
    if (transition.kind === 'exited') {
      session = null;
      normalMode = true;
      currentCursor = transition.plan.cursorOffset;
      lastInsertContext = Object.freeze({
        documentId: inputSnapshot.id,
        documentVersion: document.snapshot().version,
        cursorOffset: transition.lastInsertCursorOffset,
      });
    } else {
      session = transition.session;
      currentCursor = transition.plan.cursorOffset;
    }
  }
  if (groupOpen) {
    const ended = document.endUndoGroup(groupId(0, groupIndex));
    assert.equal(ended.ok, true, `T022-UNDO-GROUP-01 ${fixtureCase.id} closes the active group`);
  }
  const finalSnapshot = document.snapshot();
  const whole = finalSnapshot.slice(toOffset(0), toOffset(finalSnapshot.lengthUtf16));
  assert.equal(whole.ok, true, `T022-DOCUMENT-03 ${fixtureCase.id} reads final text`);
  if (!whole.ok) throw new Error(`T022-DOCUMENT-03 ${fixtureCase.id} cannot read final text`);
  const serialized = document.serialize();
  assert.equal(serialized.ok, true, `T022-DOCUMENT-04 ${fixtureCase.id} serializes its document`);
  if (!serialized.ok) throw new Error(`T022-DOCUMENT-04 ${fixtureCase.id} cannot serialize its document`);
  const cursorPoint = resolveCursor(finalSnapshot, currentCursor);
  return {
    lines: whole.value.split('\n'),
    modified: document.snapshot().revisionId !== initial.revisionId,
    mode: normalMode ? 'n' : 'i',
    cursor: cursorPoint,
    serializedBytes: Object.freeze(Array.from(serialized.value)),
  };
}

function applyPlan(
  document: TextFileDocument,
  plan: VimInsertPlan,
  groupIndex: number,
  groupOpen: boolean,
): { readonly groupIndex: number; readonly groupOpen: boolean } {
  let nextGroup = groupIndex;
  let open = groupOpen;
  if (plan.undoAction === 'break' && open) {
    const ended = document.endUndoGroup(groupId(0, nextGroup));
    assert.equal(ended.ok, true, 'T022-UNDO-BREAK-01 current insert group ends');
    open = false;
    nextGroup += 1;
  }
  if ((plan.undoAction === 'open' || plan.undoAction === 'continue') && !open) {
    const started = document.beginUndoGroup(groupId(0, nextGroup), 'vim');
    assert.equal(started.ok, true, 'T022-UNDO-GROUP-02 document opens insert group');
    open = true;
  }
  if (plan.edits.length > 0) {
    assert.equal(open, true, 'T022-UNDO-GROUP-03 edits have an explicit Vim undo group');
    const committed = document.commit({
      documentId: plan.documentId,
      expectedVersion: plan.expectedVersion,
      edits: plan.edits,
      origin: 'vim',
      undoGroup: groupId(0, nextGroup),
    });
    assert.equal(committed.ok, true, 'T022-TRANSACTION-01 plan commits against its source version');
  }
  if (plan.undoAction === 'close' && open) {
    const ended = document.endUndoGroup(groupId(0, nextGroup));
    assert.equal(ended.ok, true, 'T022-UNDO-GROUP-04 document closes insert group');
    open = false;
  }
  return { groupIndex: nextGroup, groupOpen: open };
}

function checkOpaquePasteAndFailures(): void {
  const id = asIdentifier<DocumentId>('T022-OPAQUE-PASTE', 'documentId');
  assert.equal(id.ok, true, 'T022-PASTE-01 test document ID validates');
  if (!id.ok) return;
  const opened = openTextDocument(id.value, new TextEncoder().encode('ab'));
  assert.equal(opened.kind, 'editable', 'T022-PASTE-02 paste document opens');
  if (opened.kind !== 'editable') return;
  const snapshot = opened.document.snapshot();
  const entry = beginVimInsert(snapshot, toOffset(1), 'i');
  assert.equal(entry.ok, true, 'T022-PASTE-03 insert entry succeeds');
  if (!entry.ok) return;
  const payload = new TextEncoder().encode('<Esc>😀');
  const pasted = planVimInsertInput(snapshot, entry.value.session, { kind: 'paste', bytes: payload });
  assert.equal(pasted.ok, true, 'T022-PASTE-04 valid UTF-8 paste is accepted');
  if (!pasted.ok) return;
  assert.deepEqual(pasted.value.plan.edits.map((edit) => edit.text), ['<Esc>😀'], 'T022-PASTE-05 pasted key notation stays opaque literal text');
  assert.equal(pasted.value.plan.edits[0]?.start, toOffset(1), 'T022-PASTE-06 paste is one document edit at the cursor');
  const pasteGroup = groupId(901, 1);
  const pasteGroupStarted = opened.document.beginUndoGroup(pasteGroup, 'vim');
  assert.equal(pasteGroupStarted.ok, true, 'T022-PASTE-08 paste uses a Vim-owned document undo group');
  const pasteCommitted = opened.document.commit({
    documentId: pasted.value.plan.documentId,
    expectedVersion: pasted.value.plan.expectedVersion,
    edits: pasted.value.plan.edits,
    origin: 'vim',
    undoGroup: pasteGroup,
  });
  assert.equal(pasteCommitted.ok, true, 'T022-PASTE-09 opaque paste commits through TextFileDocument');
  const pasteGroupEnded = opened.document.endUndoGroup(pasteGroup);
  assert.equal(pasteGroupEnded.ok, true, 'T022-PASTE-10 paste undo group closes');
  const pastedText = read(opened.document.snapshot());
  assert.equal(pastedText, 'a<Esc>😀b', 'T022-PASTE-11 the document, not a widget, owns pasted text');
  assert.equal(planVimInsertInput(snapshot, entry.value.session, { kind: 'paste', bytes: Uint8Array.from([0xc0, 0xaf]) }).ok, false,
    'T022-PASTE-07 malformed UTF-8 is rejected before publication');
  const otherId = asIdentifier<DocumentId>('other-document', 'documentId');
  assert.equal(otherId.ok, true, 'T022-FAILURE-STALE-SESSION-00 alternate document ID validates');
  if (!otherId.ok) return;
  const staleSession = { ...entry.value.session, documentId: otherId.value };
  assert.deepEqual(planVimInsertInput(snapshot, staleSession, { kind: 'key', key: 'x' }),
    { ok: false, error: { kind: 'wrong-document' } }, 'T022-FAILURE-STALE-SESSION-01 rejects a session for another document');
  assert.deepEqual(beginVimInsert(snapshot, toOffset(1), 'i', {}, 0),
    { ok: false, error: { kind: 'invalid-count' } }, 'T022-FAILURE-COUNT-01 zero count fails without a plan');
  assert.deepEqual(beginVimInsert(snapshot, toOffset(1), 'i', { shiftwidth: -1 }),
    { ok: false, error: { kind: 'invalid-options' } }, 'T022-FAILURE-OPTIONS-01 invalid options fail before publication');
}

function checkLineWindowReads(): void {
  const id = asIdentifier<DocumentId>('T022-LINE-WINDOW', 'documentId');
  assert.equal(id.ok, true, 'T022-LINE-WINDOW-01 document ID validates');
  if (!id.ok) return;
  const lineCount = 5_000;
  const lines = Array.from({ length: lineCount }, (_unused, index) => `row${index}`);
  const opened = openTextDocument(id.value, new TextEncoder().encode(lines.join('\n')));
  assert.equal(opened.kind, 'editable', 'T022-LINE-WINDOW-02 large document opens');
  if (opened.kind !== 'editable') return;
  const snapshot = opened.document.snapshot();
  const targetLine = 4_321;
  const startResult = snapshot.lineStartOffset(targetLine as LineIndex);
  const nextStartResult = snapshot.lineStartOffset((targetLine + 1) as LineIndex);
  assert.equal(startResult.ok, true, 'T022-LINE-WINDOW-03 target line start is available');
  assert.equal(nextStartResult.ok, true, 'T022-LINE-WINDOW-04 following line start is available');
  if (!startResult.ok || !nextStartResult.ok) return;
  const start = startResult.value as number;
  const end = (nextStartResult.value as number) - 1;
  const readRanges: Array<readonly [number, number]> = [];
  const observed = new Proxy(snapshot, {
    get(target, property) {
      if (property === 'slice') {
        return (from: Utf16Offset, to: Utf16Offset) => {
          readRanges.push([from as number, to as number]);
          return target.slice(from, to);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as DocumentSnapshot;
  const entered = beginVimInsert(observed, toOffset(start + 1), 'i');
  assert.equal(entered.ok, true, 'T022-LINE-WINDOW-05 insert entry succeeds on a late line');
  if (!entered.ok) return;
  const planned = planVimInsertInput(observed, entered.value.session, { kind: 'key', key: 'X' });
  assert.equal(planned.ok, true, 'T022-LINE-WINDOW-06 key planning succeeds on a late line');
  assert.deepEqual(readRanges, [[start, end], [start, end]],
    'T022-LINE-WINDOW-07 entry and key read only the active logical line, not the full document');
}

function cursorFromFixture(snapshot: ReturnType<TextFileDocument['snapshot']>, fixtureCase: Case): Utf16Offset {
  const lineNumber = (fixtureCase.cursor?.line ?? 1) - 1;
  const lineStart = snapshot.lineStartOffset(lineNumber as LineIndex);
  assert.equal(lineStart.ok, true, `T022-COORDINATE-01 ${fixtureCase.id} has a line start`);
  if (!lineStart.ok) throw new Error(`T022-COORDINATE-01 ${fixtureCase.id} line start unavailable`);
  const line = fixtureCase.lines[lineNumber] ?? '';
  const byteTarget = fixtureCase.cursor?.byteColumn0 ?? 0;
  let bytes = 0;
  let units = 0;
  for (const scalar of line) {
    const width = new TextEncoder().encode(scalar).length;
    if (bytes + width > byteTarget) break;
    bytes += width;
    units += scalar.length;
  }
  assert.equal(bytes, byteTarget, `T022-COORDINATE-02 ${fixtureCase.id} starts on a UTF-8 boundary`);
  return toOffset((lineStart.value as number) + units);
}

function resolveCursor(snapshot: ReturnType<TextFileDocument['snapshot']>, cursor: Utf16Offset): { readonly line: number; readonly byteColumn: number } {
  const lineResult = snapshot.lineIndexAt(cursor);
  assert.equal(lineResult.ok, true, 'T022-CURSOR-01 result is on a document line');
  if (!lineResult.ok) return { line: 1, byteColumn: 1 };
  const start = snapshot.lineStartOffset(lineResult.value);
  assert.equal(start.ok, true, 'T022-CURSOR-02 line start is available');
  if (!start.ok) return { line: (lineResult.value as number) + 1, byteColumn: 1 };
  const prefix = snapshot.slice(start.value, cursor);
  assert.equal(prefix.ok, true, 'T022-CURSOR-03 cursor prefix is readable');
  return { line: (lineResult.value as number) + 1, byteColumn: prefix.ok ? new TextEncoder().encode(prefix.value).length + 1 : 1 };
}

function asOracleFixture(fixtureCase: Case): OracleFixture {
  return {
    id: fixtureCase.id,
    title: 'T022 Insert and Replace differential',
    purpose: 'Compare Xi-owned insert/replace plans with the pinned Neovim oracle.',
    modes: ['normal', 'insert'],
    lines: fixtureCase.lines,
    ...(fixtureCase.cursor === undefined ? {} : { cursor: fixtureCase.cursor }),
    ...(fixtureCase.options === undefined ? {} : { options: fixtureCase.options as Readonly<Record<string, string | number | boolean>> }),
    steps: [{ label: 'run', keys: fixtureCase.keys }],
  };
}

function tokenize(keys: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < keys.length;) {
    if (keys.charAt(index) === '<') {
      const closing = keys.indexOf('>', index + 1);
      if (closing >= 0) {
        const token = keys.slice(index, closing + 1).replace(/^<C-([A-Z])>$/u, (_match, letter: string) => `<C-${letter.toLowerCase()}>`);
        result.push(token);
        index = closing + 1;
        continue;
      }
    }
    const point = keys.codePointAt(index);
    const scalar = String.fromCodePoint(point ?? 0);
    result.push(scalar);
    index += scalar.length;
  }
  return result;
}

function read(snapshot: ReturnType<TextFileDocument['snapshot']>): string {
  const value = snapshot.slice(toOffset(0), toOffset(snapshot.lengthUtf16));
  assert.equal(value.ok, true, 'T022-TEST-READ-01 snapshot can be read');
  return value.ok ? value.value : '';
}

function toOffset(value: number): Utf16Offset {
  const result = asUtf16Offset(value);
  assert.equal(result.ok, true, 'T022-COORDINATE-03 generated UTF-16 offset validates');
  if (!result.ok) throw new Error('T022-COORDINATE-03 invalid UTF-16 offset');
  return result.value;
}

function previousScalarOffset(text: string, cursor: number): number {
  if (cursor <= 0) return 0;
  const unit = text.charCodeAt(cursor - 1);
  return cursor - (unit >= 0xdc00 && unit <= 0xdfff ? 2 : 1);
}

function nextScalarOffset(text: string, cursor: number): number {
  const point = text.codePointAt(cursor);
  return Math.min(text.length, cursor + (point !== undefined && point > 0xffff ? 2 : 1));
}

function groupId(caseIndex: number, groupIndex: number): UndoGroupId {
  const result = asIdentifier<UndoGroupId>(`t022-${caseIndex}-${groupIndex}`, 'undoGroupId');
  assert.equal(result.ok, true, 'T022-UNDO-GROUP-05 group ID validates');
  if (!result.ok) throw new Error('T022-UNDO-GROUP-05 invalid group ID');
  return result.value;
}

function checkDefaultDigraphTable(binaryPath: string): void {
  const probe = spawnSync(binaryPath, [
    '--headless', '--clean', '-u', 'NONE',
    '+lua io.write(vim.json.encode(vim.fn.digraph_getlist(1)))',
    '+qa!',
  ], { encoding: 'utf8', maxBuffer: 2_000_000 });
  assert.equal(probe.error, undefined, 'T022-DIGRAPH-TABLE-01 pinned Neovim process starts');
  assert.equal(probe.status, 0, `T022-DIGRAPH-TABLE-02 pinned Neovim exits cleanly: ${probe.stderr}`);
  const response = probe.stdout;
  assert.equal(createHash('sha256').update(response).digest('hex'), DEFAULT_VIM_DIGRAPH_SOURCE.responseSha256,
    'T022-DIGRAPH-TABLE-03 queried default table matches its retained source hash');
  const decoded: unknown = JSON.parse(response);
  assert.ok(Array.isArray(decoded), 'T022-DIGRAPH-TABLE-04 oracle returned a row array');
  if (!Array.isArray(decoded)) return;
  const rows: Array<readonly [string, string]> = [];
  for (const [index, row] of decoded.entries()) {
    assert.ok(Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && typeof row[1] === 'string',
      `T022-DIGRAPH-TABLE-05 row ${index} is a pair of strings`);
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || typeof row[1] !== 'string') return;
    rows.push([row[0], row[1]]);
  }
  assert.equal(rows.length, DEFAULT_VIM_DIGRAPH_SOURCE.entryCount, 'T022-DIGRAPH-TABLE-06 table has the pinned entry count');
  assert.deepEqual(DEFAULT_VIM_DIGRAPH_ENTRIES, rows, 'T022-DIGRAPH-TABLE-07 checked-in default table is byte-for-byte equivalent in order and values');
  assert.equal(new Set(rows.map(([sequence]) => sequence)).size, rows.length, 'T022-DIGRAPH-TABLE-08 table keys are unique');
  for (const [sequence, value] of rows) {
    assert.equal(lookupDefaultVimDigraph(sequence), value, `T022-DIGRAPH-TABLE-09 lookup preserves ${sequence}`);
  }
}

function checkRegisterRequestHandoff(binaryPath: string): void {
  const directProbe = spawnSync(binaryPath, [
    '--headless', '--clean', '-u', 'NONE',
    '+lua vim.api.nvim_buf_set_lines(0,0,-1,false,{"ab"}); vim.api.nvim_win_set_cursor(0,{1,0}); vim.fn.setreg("a","R"); vim.fn.feedkeys(vim.api.nvim_replace_termcodes("i<C-r>a<Esc>",true,false,true),"xt"); io.write(vim.json.encode({lines=vim.api.nvim_buf_get_lines(0,0,-1,true),mode=vim.api.nvim_get_mode().mode}))',
    '+qa!',
  ], { encoding: 'utf8', maxBuffer: 2_000_000 });
  assert.equal(directProbe.error, undefined, 'T022-REGISTER-ORACLE-01 pinned Neovim register probe starts');
  assert.equal(directProbe.status, 0, `T022-REGISTER-ORACLE-02 pinned Neovim register probe exits: ${directProbe.stderr}`);
  const oracleResult: unknown = JSON.parse(directProbe.stdout);
  assert.deepEqual(oracleResult, { lines: ['Rab'], mode: 'n' }, 'T022-REGISTER-ORACLE-03 Ctrl-R inserts the selected register payload before returning to Normal');

  const id = asIdentifier<DocumentId>('T022-REGISTER-HANDOFF', 'documentId');
  assert.equal(id.ok, true, 'T022-REGISTER-01 document ID validates');
  if (!id.ok) return;
  const opened = openTextDocument(id.value, new TextEncoder().encode('ab'));
  assert.equal(opened.kind, 'editable', 'T022-REGISTER-02 handoff document opens');
  if (opened.kind !== 'editable') return;
  const document = opened.document;
  const entered = beginVimInsert(document.snapshot(), toOffset(0), 'i');
  assert.equal(entered.ok, true, 'T022-REGISTER-03 insert mode opens');
  if (!entered.ok) return;
  const group = groupId(902, 1);
  const started = document.beginUndoGroup(group, 'vim');
  assert.equal(started.ok, true, 'T022-REGISTER-04 insert undo group opens');
  if (!started.ok) return;

  const controlR = planVimInsertInput(document.snapshot(), entered.value.session, { kind: 'key', key: '<C-r>' });
  assert.equal(controlR.ok, true, 'T022-REGISTER-05 Ctrl-R starts a register lookup request');
  if (!controlR.ok) return;
  assert.equal(controlR.value.kind, 'continued', 'T022-REGISTER-06 register-name prompt remains a pure insert transition');
  if (controlR.value.kind !== 'continued') return;
  const name = planVimInsertInput(document.snapshot(), controlR.value.session, { kind: 'key', key: 'a' });
  assert.equal(name.ok, true, 'T022-REGISTER-07 register name is accepted');
  if (!name.ok) return;
  assert.equal(name.value.kind, 'register-request', 'T022-REGISTER-08 register lookup is handed to its owner');
  if (name.value.kind !== 'register-request') return;
  assert.deepEqual(name.value.request, {
    requestId: 1,
    registerName: 'a',
    documentId: id.value,
    expectedVersion: document.snapshot().version,
    cursorOffset: toOffset(0),
  }, 'T022-REGISTER-09 request carries a typed document/version/cursor identity without reading a register');
  assert.deepEqual(name.value.plan.edits, [], 'T022-REGISTER-10 lookup request does not edit the document');
  assert.equal(read(document.snapshot()), 'ab', 'T022-REGISTER-11 document is unchanged while lookup is delegated');

  const resolved = planVimInsertRegisterPayload(document.snapshot(), name.value.session, { requestId: 1, text: 'R' });
  assert.equal(resolved.ok, true, 'T022-REGISTER-12 owner payload resolves the matching request');
  if (!resolved.ok) return;
  assert.equal(resolved.value.kind, 'continued', 'T022-REGISTER-12A resolved payload leaves the insert session active');
  if (resolved.value.kind !== 'continued') return;
  assert.deepEqual(resolved.value.plan.edits.map(({ text }) => text), ['R'], 'T022-REGISTER-13 resolved payload is inserted as literal text');
  const committed = document.commit({
    documentId: resolved.value.plan.documentId,
    expectedVersion: resolved.value.plan.expectedVersion,
    edits: resolved.value.plan.edits,
    origin: 'vim',
    undoGroup: group,
  });
  assert.equal(committed.ok, true, 'T022-REGISTER-14 payload plan commits through the document owner');
  if (!committed.ok) return;
  const secondControlR = planVimInsertInput(document.snapshot(), resolved.value.session, { kind: 'key', key: '<C-r>' });
  assert.equal(secondControlR.ok, true, 'T022-REGISTER-14A subsequent Ctrl-R is accepted');
  if (!secondControlR.ok || secondControlR.value.kind !== 'continued') return;
  const missingRegisterName = planVimInsertInput(document.snapshot(), secondControlR.value.session, { kind: 'key', key: 'z' });
  assert.equal(missingRegisterName.ok, true, 'T022-REGISTER-14B missing register name is routed to the owner');
  if (!missingRegisterName.ok || missingRegisterName.value.kind !== 'register-request') return;
  assert.equal(missingRegisterName.value.request.requestId, 2, 'T022-REGISTER-14C successive requests have distinct IDs within a session');
  const missingRegister = planVimInsertRegisterPayload(document.snapshot(), missingRegisterName.value.session, { requestId: 2, text: '' });
  assert.equal(missingRegister.ok, true, 'T022-REGISTER-14D empty owner payload handles an absent register');
  if (!missingRegister.ok || missingRegister.value.kind !== 'continued') return;
  assert.deepEqual(missingRegister.value.plan.edits, [], 'T022-REGISTER-14E absent register inserts no text');
  const exit = planVimInsertInput(document.snapshot(), missingRegister.value.session, { kind: 'key', key: '<Esc>' });
  assert.equal(exit.ok, true, 'T022-REGISTER-15 insert exits after payload resolution');
  if (!exit.ok) return;
  assert.equal(exit.value.kind, 'exited', 'T022-REGISTER-16 Escape closes the insert session');
  if (exit.value.kind !== 'exited') return;
  const exitedCommit = document.commit({
    documentId: exit.value.plan.documentId,
    expectedVersion: exit.value.plan.expectedVersion,
    edits: exit.value.plan.edits,
    origin: 'vim',
    undoGroup: group,
  });
  assert.equal(exitedCommit.ok, true, 'T022-REGISTER-17 exit plan commits');
  const closed = document.endUndoGroup(group);
  assert.equal(closed.ok, true, 'T022-REGISTER-18 insert undo group closes');
  assert.deepEqual(read(document.snapshot()).split('\n'), (oracleResult as { readonly lines: readonly string[] }).lines,
    'T022-REGISTER-19 delegated register payload produces the pinned oracle document');

  const staleId = asIdentifier<DocumentId>('T022-REGISTER-STALE', 'documentId');
  assert.equal(staleId.ok, true, 'T022-REGISTER-20 stale-request document ID validates');
  if (!staleId.ok) return;
  const staleOpened = openTextDocument(staleId.value, new TextEncoder().encode('ab'));
  assert.equal(staleOpened.kind, 'editable', 'T022-REGISTER-21 stale-request document opens');
  if (staleOpened.kind !== 'editable') return;
  const staleDoc = staleOpened.document;
  const staleEntry = beginVimInsert(staleDoc.snapshot(), toOffset(0), 'i');
  assert.equal(staleEntry.ok, true, 'T022-REGISTER-22 stale-request insert mode opens');
  if (!staleEntry.ok) return;
  const staleGroup = groupId(903, 1);
  const staleGroupStarted = staleDoc.beginUndoGroup(staleGroup, 'vim');
  assert.equal(staleGroupStarted.ok, true, 'T022-REGISTER-23 stale-request undo group opens');
  if (!staleGroupStarted.ok) return;
  const staleControlR = planVimInsertInput(staleDoc.snapshot(), staleEntry.value.session, { kind: 'key', key: '<C-r>' });
  assert.equal(staleControlR.ok, true, 'T022-REGISTER-24 stale request begins');
  if (!staleControlR.ok || staleControlR.value.kind !== 'continued') return;
  const staleName = planVimInsertInput(staleDoc.snapshot(), staleControlR.value.session, { kind: 'key', key: 'a' });
  assert.equal(staleName.ok, true, 'T022-REGISTER-25 stale request captures the selected name');
  if (!staleName.ok || staleName.value.kind !== 'register-request') return;
  const staleEdit = staleDoc.commit({
    documentId: staleDoc.snapshot().id,
    expectedVersion: staleDoc.snapshot().version,
    edits: [{ start: toOffset(2), end: toOffset(2), text: '!' }],
    origin: 'vim',
    undoGroup: staleGroup,
  });
  assert.equal(staleEdit.ok, true, 'T022-REGISTER-26 intervening document edit advances the version');
  if (!staleEdit.ok) return;
  assert.deepEqual(planVimInsertRegisterPayload(staleDoc.snapshot(), staleName.value.session, { requestId: 1, text: 'R' }),
    { ok: false, error: { kind: 'stale-register-request' } }, 'T022-REGISTER-27 stale payload is rejected before producing a plan');
  const staleGroupClosed = staleDoc.endUndoGroup(staleGroup);
  assert.equal(staleGroupClosed.ok, true, 'T022-REGISTER-28 stale-request fixture closes its group');
}

function checkLastInsertContextFailures(): void {
  const id = asIdentifier<DocumentId>('T022-GI-CONTEXT', 'documentId');
  const otherId = asIdentifier<DocumentId>('T022-GI-OTHER', 'documentId');
  assert.equal(id.ok, true, 'T022-GI-CONTEXT-01 document ID validates');
  assert.equal(otherId.ok, true, 'T022-GI-CONTEXT-02 alternate document ID validates');
  if (!id.ok || !otherId.ok) return;
  const opened = openTextDocument(id.value, new TextEncoder().encode('ab'));
  assert.equal(opened.kind, 'editable', 'T022-GI-CONTEXT-03 document opens');
  if (opened.kind !== 'editable') return;
  const initial = opened.document.snapshot();
  const noPriorInsert = beginVimInsert(initial, toOffset(1), 'gi');
  assert.equal(noPriorInsert.ok, true, 'T022-GI-CONTEXT-04 gi falls back to the current cursor when no prior insert location exists');
  if (noPriorInsert.ok) assert.equal(noPriorInsert.value.session.cursorOffset, toOffset(1), 'T022-GI-CONTEXT-04A missing last-insert context preserves the current cursor');
  assert.deepEqual(beginVimInsert(initial, toOffset(0), 'gi', {}, 1, {
    lastInsert: { documentId: otherId.value, documentVersion: initial.version, cursorOffset: toOffset(0) },
  }), { ok: false, error: { kind: 'wrong-document' } }, 'T022-GI-CONTEXT-05 gi rejects a location from another document');
  assert.deepEqual(beginVimInsert(initial, toOffset(0), 'gi', {}, 1, {
    lastInsert: { documentId: id.value, documentVersion: initial.version, cursorOffset: toOffset(initial.lengthUtf16 + 1) },
  }), { ok: false, error: { kind: 'snapshot-read-failed' } }, 'T022-GI-CONTEXT-06 gi rejects an out-of-range last-insert offset');

  const group = groupId(904, 1);
  const started = opened.document.beginUndoGroup(group, 'vim');
  assert.equal(started.ok, true, 'T022-GI-CONTEXT-07 context mutation group opens');
  if (!started.ok) return;
  const advanced = opened.document.commit({
    documentId: id.value,
    expectedVersion: initial.version,
    edits: [{ start: toOffset(2), end: toOffset(2), text: '!' }],
    origin: 'vim',
    undoGroup: group,
  });
  assert.equal(advanced.ok, true, 'T022-GI-CONTEXT-08 intervening edit advances the document version');
  if (!advanced.ok) return;
  assert.deepEqual(beginVimInsert(opened.document.snapshot(), toOffset(0), 'gi', {}, 1, {
    lastInsert: { documentId: id.value, documentVersion: initial.version, cursorOffset: toOffset(1) },
  }), { ok: false, error: { kind: 'stale-last-insert-context' } }, 'T022-GI-CONTEXT-09 gi rejects an unmapped stale context');
  const ended = opened.document.endUndoGroup(group);
  assert.equal(ended.ok, true, 'T022-GI-CONTEXT-10 context mutation group closes');
}

async function checkCarriageReturnDigraph(binaryPath: string): Promise<void> {
  const fixtureCase: Case = {
    id: 'T022-DIGRAPH-CR-MODEL-GAP-01',
    keys: 'i<C-K>CR<Esc>',
    lines: ['ab'],
    cursor: { line: 1, byteColumn0: 0 },
  };
  assert.equal(lookupDefaultVimDigraph('CR'), '\r', 'T022-DIGRAPH-CR-01 pinned CR entry remains in the static table');
  const expected = (await runOracleFixture(asOracleFixture(fixtureCase), binaryPath)).snapshots[0];
  assert.ok(expected, `T022-DIGRAPH-CR-02 ${fixtureCase.id} has a pinned observation`);
  if (expected === undefined) return;
  const actual = await executeProduct(fixtureCase, 950);
  assert.deepEqual(expected.lines, ['\rab'],
    `T022-DIGRAPH-CR-03 ${fixtureCase.id} records Neovim's in-line CR result`);
  assert.deepEqual(actual.lines, expected.lines,
    `T022-DIGRAPH-CR-04 ${fixtureCase.id} preserves the pinned in-line CR result`);
  assert.deepEqual(actual.serializedBytes, [0x0d, 0x61, 0x62],
    `T022-DIGRAPH-CR-05 ${fixtureCase.id} serializes literal CR content without making a line break`);

  const originalBytes = Uint8Array.from(actual.serializedBytes);
  const unixId = asIdentifier<DocumentId>(`${fixtureCase.id}-unix-reopen`, 'documentId');
  assert.equal(unixId.ok, true, `T022-DIGRAPH-CR-07 ${fixtureCase.id} has an explicit-reopen document ID`);
  if (!unixId.ok) throw new Error(`T022-DIGRAPH-CR-07 ${fixtureCase.id} has an invalid explicit-reopen document ID`);
  const unixReopened = openTextDocument(unixId.value, originalBytes, 41027, { fileFormat: 'unix' });
  assert.equal(unixReopened.kind, 'editable',
    `T022-DIGRAPH-CR-08 ${fixtureCase.id} reopens literal CR under explicit Unix fileformat`);
  if (unixReopened.kind !== 'editable') return;
  assert.equal(read(unixReopened.document.snapshot()), '\rab',
    `T022-DIGRAPH-CR-09 ${fixtureCase.id} explicit reopen retains same-line content`);
  const roundTrip = unixReopened.document.serialize();
  assert.equal(roundTrip.ok, true, `T022-DIGRAPH-CR-10 ${fixtureCase.id} explicit reopen serializes`);
  if (!roundTrip.ok) throw new Error(`T022-DIGRAPH-CR-10 ${fixtureCase.id} explicit reopen cannot serialize`);
  assert.deepEqual(roundTrip.value, originalBytes,
    `T022-DIGRAPH-CR-11 ${fixtureCase.id} explicit reopen preserves the original CR bytes`);

  const autoId = asIdentifier<DocumentId>(`${fixtureCase.id}-auto-reopen`, 'documentId');
  assert.equal(autoId.ok, true, `T022-DIGRAPH-CR-12 ${fixtureCase.id} has a strict-auto document ID`);
  if (!autoId.ok) throw new Error(`T022-DIGRAPH-CR-12 ${fixtureCase.id} has an invalid strict-auto document ID`);
  const autoReopened = openTextDocument(autoId.value, originalBytes, 41027, { fileFormat: 'auto' });
  assert.equal(autoReopened.kind, 'read-only',
    `T022-DIGRAPH-CR-13 ${fixtureCase.id} strict auto leaves ambiguous lone CR content read-only`);
  if (autoReopened.kind === 'read-only') {
    assert.equal(autoReopened.document.reason, 'ambiguous-line-endings',
      `T022-DIGRAPH-CR-14 ${fixtureCase.id} reports the literal-versus-legacy-EOL ambiguity`);
    assert.deepEqual(autoReopened.document.copyOriginalBytes(), originalBytes,
      `T022-DIGRAPH-CR-15 ${fixtureCase.id} strict auto preserves the original bytes`);
  }
}

function checkNulReadOnlyReopen(fixtureId: string, bytes: readonly number[]): void {
  const documentIdResult = asIdentifier<DocumentId>(`${fixtureId}-reopen`, 'documentId');
  assert.equal(documentIdResult.ok, true, `T022-DIGRAPH-NU-03 ${fixtureId} has a valid reopen document ID`);
  if (!documentIdResult.ok) throw new Error(`T022-DIGRAPH-NU-03 ${fixtureId} has an invalid reopen document ID`);
  const originalBytes = Uint8Array.from(bytes);
  const reopened = openTextDocument(documentIdResult.value, originalBytes);
  assert.equal(reopened.kind, 'read-only',
    `T022-DIGRAPH-NU-04 ${fixtureId} reopened NUL-containing file follows T010's binary read-only policy`);
  if (reopened.kind !== 'read-only') return;
  assert.equal(reopened.document.reason, 'binary-content',
    `T022-DIGRAPH-NU-05 ${fixtureId} identifies the reopened NUL file as binary content`);
  assert.deepEqual(reopened.document.copyOriginalBytes(), originalBytes,
    `T022-DIGRAPH-NU-06 ${fixtureId} preserves the exact bytes while read-only`);
}
