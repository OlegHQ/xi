import { createCliRenderer } from '@opentui/core';
import { asIdentifier, asUtf16Offset, type DocumentId, type SelectionId, type ViewId } from '../../packages/primitives/src/index';
import { openTextDocument, type DocumentReadPort, type DocumentSnapshot } from '../../packages/document/src/index';
import { createSelectionSet, type SelectionMemberInput } from '../../packages/selections/src/index';
import type { WorkbenchReadPort, WorkbenchViewSnapshot } from '../../packages/workbench/src/index';
import { WorkbenchRenderable, type WorkbenchTheme } from '../../packages/ui/src/index';

const fixture = process.env.XI_T063_CASE ?? 'visual-character';
const colorMode = process.env.XI_T063_COLOR_MODE === 'no-color'
  ? 'no-color' as const
  : process.env.XI_T063_COLOR_MODE === 'ansi256'
    ? 'ansi256' as const
    : 'truecolor' as const;
const ascii = process.env.XI_T063_ASCII === '1';
const documentId = id<DocumentId>('T063-terminal-document');
const viewId = id<ViewId>('T063-terminal-view');
const source = 'alpha 😀 beta\n\n\tCJK界 é 👩‍💻\nlast line';
const lowColorTheme: WorkbenchTheme = {
  background: '#000000', surface: '#202020', surfaceActive: '#404040', foreground: '#FFFFFF', muted: '#AAAAAA',
  border: '#808080', accent: '#FFFFFF', error: '#FFFFFF',
};

const opened = openTextDocument(documentId, new TextEncoder().encode(source));
if (opened.kind !== 'editable') throw new Error(`T063-terminal-open:${opened.kind}`);
const snapshot = opened.document.snapshot();
const selections = makeSet(snapshot, fixture);
const mode = fixture.startsWith('visual') ? 'visual' as const : 'normal' as const;
const view: WorkbenchViewSnapshot = {
  session: { viewId, documentId, documentVersion: snapshot.version, selections, mode },
  document: snapshot,
  selections,
};
const document: DocumentReadPort = {
  snapshot: () => snapshot,
  slice: (start, end, expectedVersion) => expectedVersion === snapshot.version ? snapshot.slice(start, end) : { ok: false, error: { kind: 'stale-version' } },
};
const workbench: WorkbenchReadPort = {
  activeViewId: viewId,
  readView: (candidate) => candidate === viewId ? view : undefined,
  readDocument: (candidate) => candidate === viewId ? document : undefined,
};

let finish!: () => void;
const done = new Promise<void>((resolve) => { finish = resolve; });
const renderer = await createCliRenderer({
  screenMode: 'alternate-screen',
  clearOnShutdown: true,
  exitOnCtrlC: false,
  consoleMode: 'disabled',
  onDestroy: finish,
});
const viewport = new WorkbenchRenderable(renderer.root.ctx, {
  workbench,
  fileLabel: `T063 ${fixture}`,
  colorMode,
  ascii,
  ...(colorMode === 'no-color' ? { theme: lowColorTheme } : {}),
});
renderer.root.add(viewport);
let announced = false;
renderer.on('frame', () => {
  if (announced || process.env.XI_UI_TEST_MARKERS !== '1') return;
  announced = true;
  process.stderr.write(`XI_T063_SCREEN_READY ${JSON.stringify({ width: renderer.width, height: renderer.height, fixture, colorMode, ascii })}\r\n`);
});
renderer.keyInput.on('keypress', (event) => {
  if ((event.ctrl && (event.name === 'c' || event.name === 'C')) || event.name === 'q') renderer.destroy();
});
renderer.start();
setTimeout(() => { if (!renderer.isDestroyed) renderer.destroy(); }, 4_000);
await done;

function makeSet(base: DocumentSnapshot, name: string) {
  const members: SelectionMemberInput[] = name === 'visual-character'
    ? [{ id: id<SelectionId>('T063-terminal-primary'), kind: 'visual-character', direction: 'forward', anchor: character(0, 1), head: character(4, 5), inclusive: true }]
    : name === 'visual-line'
      ? [{ id: id<SelectionId>('T063-terminal-primary'), kind: 'visual-line', direction: 'forward', anchor: { kind: 'line', lineIndex: line(0) }, head: { kind: 'line', lineIndex: line(2) } }]
      : name === 'visual-block'
        ? [{ id: id<SelectionId>('T063-terminal-primary'), kind: 'visual-block', direction: 'forward', anchor: block(0, 1, 1), head: block(15, 2, 2) }]
        : name === 'empty-line'
          ? [{ id: id<SelectionId>('T063-terminal-primary'), kind: 'normal-cursor', direction: 'forward', anchor: { kind: 'empty-line', lineIndex: line(1) }, head: { kind: 'empty-line', lineIndex: line(1) } }]
          : name === 'eof'
            ? [{ id: id<SelectionId>('T063-terminal-primary'), kind: 'normal-cursor', direction: 'forward', anchor: { kind: 'eof' }, head: { kind: 'eof' } }]
            : [
              { id: id<SelectionId>('T063-terminal-primary'), kind: 'normal-cursor', direction: 'forward', anchor: character(0, 1), head: character(0, 1) },
              { id: id<SelectionId>('T063-terminal-secondary'), kind: 'normal-cursor', direction: 'forward', anchor: character(6, 8), head: character(6, 8) },
            ];
  const result = createSelectionSet(base, { primaryId: members[0]?.id ?? id<SelectionId>('T063-terminal-primary'), selectionGeneration: 1, members });
  if (!result.ok) throw new Error(`T063-terminal-selection:${result.error.kind}`);
  return result.value.selectionSet;
}

function character(start: number, after: number) { return { kind: 'character' as const, offset: offset(start), after: offset(after) }; }
function block(value: number, lineIndex: number, displayColumn: number) {
  return { kind: 'block-cell' as const, offset: offset(value), lineIndex: line(lineIndex), logicalUtf16Column: column(displayColumn), displayCellColumn: cell(displayColumn), virtualCells: 0 };
}
function offset(value: number) {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error(`T063-terminal-offset:${value}`);
  return result.value;
}
function line(value: number) { return value as number & { readonly __xiBrand: 'LineIndex' }; }
function column(value: number) { return value as number & { readonly __xiBrand: 'Utf16Column' }; }
function cell(value: number) { return value as number & { readonly __xiBrand: 'CellColumn' }; }
function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T063-terminal-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
