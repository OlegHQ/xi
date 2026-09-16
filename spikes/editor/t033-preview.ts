import {
  RGBA,
  Renderable,
  type OptimizedBuffer,
  type RenderContext,
  type RenderableOptions,
  createCliRenderer,
  parseColor,
  type CliRenderer,
  type KeyEvent,
} from '@opentui/core';
import { asIdentifier, asLineIndex, asUtf16Offset, type DocumentId, type SelectionId, type UndoGroupId, type Utf16Offset } from '../../packages/primitives/src/index';
import { openTextDocument, type DocumentEdit, type DocumentSnapshot, type TextFileDocument } from '../../packages/document/src/index';
import { createSelectionSet, type SelectionSetSnapshot } from '../../packages/selections/src/index';
import {
  beginVimMultiInsert,
  createVimParserState,
  normalizeVimInput,
  parseVimInput,
  planVimMultiInsertInput,
  type VimCommandIntent,
  type VimMultiInsertPlan,
  type VimMultiInsertSession,
  type VimParserState,
} from '../../packages/vim/src/index';
import type { CanonicalInputEvent, InputModifiers } from '../../packages/contracts/src/index';

const DOCUMENT_ID = identifier<DocumentId>('T033-preview-document');
const INSERT_GROUP = identifier<UndoGroupId>('T033-preview-insert');
const NO_MODIFIERS: InputModifiers = Object.freeze({ shift: false, alt: false, ctrl: false, meta: false });

interface PreviewState {
  readonly document: TextFileDocument;
  mode: 'normal' | 'insert';
  parser: VimParserState;
  selections: SelectionSetSnapshot;
  insert: VimMultiInsertSession | null;
  undoOpen: boolean;
  cursorOffset: number;
  readonly latencies: number[];
  readonly commands: string[];
}

interface DocumentPreviewRead {
  readonly snapshot: DocumentSnapshot;
  readonly cursorOffset: number;
}

/**
 * The preview viewport reads the document snapshot during paint. It does not
 * keep a second editable text buffer; all mutations go through TextFileDocument.
 */
class DocumentPreviewViewport extends Renderable {
  readonly #read: () => { readonly snapshot: DocumentSnapshot; readonly cursorOffset: number };
  readonly #fg: RGBA = parseColor('#f8f8f2');
  readonly #bg: RGBA = parseColor('#1e1e1e');

  constructor(ctx: RenderContext, read: () => DocumentPreviewRead, options: RenderableOptions<DocumentPreviewViewport> = {}) {
    super(ctx, { width: '100%', height: '100%', buffered: true, ...options });
    this.#read = read;
    this.requestRender();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const { snapshot, cursorOffset } = this.#read();
    for (let row = 0; row < this.height; row += 1) {
      buffer.fillRect(0, row, this.width, 1, this.#bg);
      if (row >= snapshot.lineCount) continue;
      const line = asLineIndex(row);
      const start = line.ok ? snapshot.lineStartOffset(line.value) : line;
      const nextLine = asLineIndex(row + 1);
      const nextStart = row + 1 < snapshot.lineCount
        ? (nextLine.ok ? snapshot.lineStartOffset(nextLine.value) : nextLine)
        : offset(snapshot.lengthUtf16);
      if (!start.ok || !nextStart.ok) continue;
      const lineEnd = row + 1 < snapshot.lineCount
        ? offset((nextStart.value as number) - 1)
        : nextStart;
      if (!lineEnd.ok) continue;
      const text = snapshot.slice(start.value, lineEnd.value);
      if (text.ok) buffer.drawText(text.value.slice(0, this.width), 0, row, this.#fg, this.#bg, 0);
    }

    const cursor = cursorCell(snapshot, cursorOffset);
    if (cursor.row >= 0 && cursor.row < this.height && cursor.column >= 0 && cursor.column < this.width) {
      this.ctx.setCursorPosition(cursor.column + 1, cursor.row + 1, true);
    } else {
      this.ctx.setCursorPosition(0, 0, false);
    }
  }
}

async function main(): Promise<void> {
  const opened = openTextDocument(DOCUMENT_ID, new TextEncoder().encode('alpha beta\nalpha beta'));
  if (opened.kind !== 'editable') throw new Error(`T033-open:${opened.kind}`);
  const document = opened.document;
  const initial = makeNormalSelections(document.snapshot(), [0, 11], 0);
  const parser = createVimParserState('normal', initial);
  if (!parser.ok) throw new Error(`T033-parser:${parser.error.kind}`);
  const state: PreviewState = {
    document,
    mode: 'normal',
    parser: parser.value,
    selections: initial,
    insert: null,
    undoOpen: false,
    cursorOffset: 0,
    latencies: [],
    commands: [],
  };

  let renderer: CliRenderer | undefined;
  let viewport: DocumentPreviewViewport | undefined;
  let firstFrame = false;
  let exitReason = 'running';
  const rawBefore = process.stdin.isRaw ?? false;

  renderer = await createCliRenderer({
    screenMode: 'alternate-screen',
    clearOnShutdown: true,
    exitOnCtrlC: false,
    useMouse: false,
    consoleMode: 'disabled',
    targetFps: 30,
    onDestroy: () => {
      const text = readText(document);
      const sorted = [...state.latencies].sort((a, b) => a - b);
      const result = {
        ticket: 'T033',
        exitReason,
        text,
        commands: state.commands,
        documentVersion: document.version,
        cursorOffset: state.cursorOffset,
        localTyping: {
          samples: sorted.length,
          p50Milliseconds: percentile(sorted, 0.5),
          p95Milliseconds: percentile(sorted, 0.95),
          maxMilliseconds: sorted.at(-1) ?? 0,
          boundary: 'OpenTUI keypress callback through owned parser/planner/document commit',
        },
        terminal: {
          rawBefore,
          rawAfter: process.stdin.isRaw ?? false,
          restored: (process.stdin.isRaw ?? false) === rawBefore,
        },
      };
      process.stderr.write(`XI_PREVIEW_RESULT ${JSON.stringify(result)}\r\n`);
      setImmediate(() => process.exit(0));
    },
  });

  viewport = new DocumentPreviewViewport(renderer.root.ctx, () => ({ snapshot: document.snapshot(), cursorOffset: state.cursorOffset }));
  renderer.root.add(viewport);
  renderer.on('frame', () => {
    if (firstFrame) return;
    firstFrame = true;
    process.stderr.write(`XI_PREVIEW_READY ${JSON.stringify({ width: renderer?.width ?? 0, height: renderer?.height ?? 0, rawMode: process.stdin.isRaw ?? false })}\r\n`);
  });
  renderer.keyInput.on('keypress', (event) => {
    const started = performance.now();
    const key = keyName(event);
    if (event.ctrl && key === 'c') {
      exitReason = 'ctrl-c';
      renderer?.destroy();
      return;
    }
    if (state.mode === 'normal' && key === 'q') {
      exitReason = 'q';
      renderer?.destroy();
      return;
    }
    const eventValue: CanonicalInputEvent = {
      kind: 'key',
      key,
      phase: 'press',
      modifiers: Object.freeze({ shift: event.shift, alt: event.option, ctrl: event.ctrl, meta: event.meta }),
      rawBytes: new TextEncoder().encode(event.raw),
    };
    const normalized = normalizeVimInput(eventValue, { monotonicMilliseconds: () => performance.now() });
    if (!normalized.ok) return;
    const outcome = parseVimInput(state.parser, normalized.value);
    state.parser = outcome.state;
    if (outcome.kind === 'command') {
      state.commands.push(outcome.command.kind);
      executeCommand(state, outcome.command);
    }
    state.latencies.push(performance.now() - started);
    viewport?.requestRender();
  });
  renderer.start();
}

function executeCommand(state: PreviewState, command: VimCommandIntent): void {
  if (command.kind === 'mode-transition' && command.to === 'insert' && state.mode === 'normal') {
    const members = state.selections.members.map((member) => ({ id: member.id, cursorOffset: member.anchor.at.offset }));
    const entered = beginVimMultiInsert(state.document.snapshot(), members, 'i');
    if (!entered.ok) throw new Error(`T033-enter:${entered.error.kind}`);
    commitPlan(state, entered.value.plan);
    if (entered.value.session.members[0] === undefined) throw new Error('T033-empty-session');
    state.mode = 'insert';
    state.insert = entered.value.session;
    state.cursorOffset = entered.value.session.members[0].session.cursorOffset as number;
    state.selections = makeInsertSelections(state.document.snapshot(), state.insert, state.selections.selectionGeneration as number + 1);
    const next = createVimParserState('insert', state.selections);
    if (!next.ok) throw new Error(`T033-insert-parser:${next.error.kind}`);
    state.parser = next.value;
    return;
  }
  if (command.kind === 'insert-key' && state.mode === 'insert' && state.insert !== null) {
    const planned = planVimMultiInsertInput(state.document.snapshot(), state.insert, { kind: 'key', key: command.key });
    if (!planned.ok) throw new Error(`T033-key:${planned.error.kind}`);
    commitPlan(state, planned.value);
    state.insert = planned.value.nextSession;
    if (state.insert === null) {
      state.mode = 'normal';
      state.selections = makeNormalSelections(state.document.snapshot(), [state.cursorOffset], state.selections.selectionGeneration as number + 1);
    } else {
      const primary = state.insert.members.find((member) => member.id === state.selections.primaryId) ?? state.insert.members[0];
      if (primary === undefined) throw new Error('T033-primary-session');
      state.cursorOffset = primary.session.cursorOffset as number;
      state.selections = makeInsertSelections(state.document.snapshot(), state.insert, state.selections.selectionGeneration as number + 1);
    }
    return;
  }
  if (command.kind === 'leave-mode' && state.mode === 'insert' && state.insert !== null) {
    const planned = planVimMultiInsertInput(state.document.snapshot(), state.insert, { kind: 'key', key: '<Esc>' });
    if (!planned.ok) throw new Error(`T033-escape:${planned.error.kind}`);
    commitPlan(state, planned.value);
    const primary = state.insert.members.find((member) => member.id === state.selections.primaryId) ?? state.insert.members[0];
    if (primary !== undefined) state.cursorOffset = primary.session.cursorOffset as number;
    state.insert = null;
    state.mode = 'normal';
    state.selections = makeNormalSelections(state.document.snapshot(), [state.cursorOffset], state.selections.selectionGeneration as number + 1);
    const next = createVimParserState('normal', state.selections);
    if (!next.ok) throw new Error(`T033-normal-parser:${next.error.kind}`);
    state.parser = next.value;
  }
}

function commitPlan(state: PreviewState, plan: VimMultiInsertPlan): void {
  if (plan.undoAction === 'open' && !state.undoOpen) {
    const opened = state.document.beginUndoGroup(INSERT_GROUP, 'vim');
    if (!opened.ok) throw new Error(`T033-undo-open:${opened.error.kind}`);
    state.undoOpen = true;
  }
  if (plan.edits.length > 0) {
    const committed = state.document.commit({
      documentId: plan.documentId,
      expectedVersion: plan.expectedVersion,
      edits: plan.edits.map((edit) => ({ start: edit.start, end: edit.end, text: edit.text } satisfies DocumentEdit)),
      origin: 'vim',
      undoGroup: INSERT_GROUP,
    });
    if (!committed.ok) throw new Error(`T033-commit:${committed.error.kind}`);
  }
  if (plan.undoAction === 'close' && state.undoOpen) {
    const closed = state.document.endUndoGroup(INSERT_GROUP);
    if (!closed.ok) throw new Error(`T033-undo-close:${closed.error.kind}`);
    state.undoOpen = false;
  }
}

function makeNormalSelections(snapshot: DocumentSnapshot, offsets: readonly number[], generation: number): SelectionSetSnapshot {
  const members = offsets.map((value, index) => {
    const max = Math.max(0, snapshot.lengthUtf16 - 1);
    const at = Math.min(Math.max(value, 0), max);
    const offset = asUtf16Offset(at);
    const after = asUtf16Offset(Math.min(at + 1, snapshot.lengthUtf16));
    if (!offset.ok || !after.ok) throw new Error('T033-normal-offset');
    const id = identifier<SelectionId>(`T033-member-${index}`);
    return { id, kind: 'normal-cursor' as const, direction: 'forward' as const, anchor: { kind: 'character' as const, offset: offset.value, after: after.value }, head: { kind: 'character' as const, offset: offset.value, after: after.value } };
  });
  const created = createSelectionSet(snapshot, { primaryId: members[0]?.id as SelectionId, selectionGeneration: generation, members });
  if (!created.ok) throw new Error(`T033-normal-selection:${created.error.kind}`);
  return created.value.selectionSet;
}

function makeInsertSelections(snapshot: DocumentSnapshot, session: VimMultiInsertSession, generation: number): SelectionSetSnapshot {
  const members = session.members.map((member) => {
    const endpoint = { kind: 'gap' as const, offset: member.session.cursorOffset };
    return { id: member.id, kind: 'insert-caret' as const, direction: 'forward' as const, anchor: endpoint, head: endpoint };
  });
  const created = createSelectionSet(snapshot, { primaryId: members[0]?.id as SelectionId, selectionGeneration: generation, members });
  if (!created.ok) throw new Error(`T033-insert-selection:${created.error.kind}`);
  return created.value.selectionSet;
}

function cursorCell(snapshot: DocumentSnapshot, offset: number): { readonly row: number; readonly column: number } {
  const safe = asUtf16Offset(Math.min(Math.max(offset, 0), snapshot.lengthUtf16));
  if (!safe.ok) return { row: 0, column: 0 };
  const line = snapshot.lineIndexAt(safe.value);
  const start = line.ok ? snapshot.lineStartOffset(line.value) : { ok: false as const };
  if (!line.ok || !start.ok) return { row: 0, column: 0 };
  const prefix = snapshot.slice(start.value, safe.value);
  return { row: line.value as number, column: prefix.ok ? Array.from(prefix.value).length : 0 };
}

function keyName(event: KeyEvent): string {
  return event.name === 'ESC' || event.name === 'Escape' || event.name === 'escape' ? '<Esc>' : event.name;
}

function readText(document: TextFileDocument): string {
  const snapshot = document.snapshot();
  const start = offset(0);
  const end = offset(snapshot.lengthUtf16);
  if (!start.ok || !end.ok) throw new Error('T033-read-offset');
  const result = snapshot.slice(start.value, end.value);
  if (!result.ok) throw new Error(`T033-read:${result.error.kind}`);
  return result.value;
}

function offset(value: number): { readonly ok: true; readonly value: Utf16Offset } | { readonly ok: false } {
  const result = asUtf16Offset(value);
  return result.ok ? result : { ok: false };
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  return Number((values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))] ?? 0).toFixed(3));
}

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T033-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

await main();
