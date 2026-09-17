import { createCliRenderer } from '@opentui/core';
import { asIdentifier, asUtf16Offset, type DocumentId, type SelectionId, type ViewId } from '../../packages/primitives/src/index';
import { openTextDocument, type DocumentReadPort, type DocumentSnapshot } from '../../packages/document/src/index';
import { createSelectionSet } from '../../packages/selections/src/index';
import type { WorkbenchReadPort, WorkbenchViewSnapshot } from '../../packages/workbench/src/index';
import { WorkbenchRenderable, type EditorPresentationRead, type WorkbenchTheme } from '../../packages/ui/src/index';

const viewId = id<ViewId>('T087-visual-view');
const documentId = id<DocumentId>('T087-visual-document');

const opened = openTextDocument(documentId, new TextEncoder().encode(
  'const greeting = "alpha 😀 beta";\n// motion trail / operator preview\n\nfunction eof() { return greeting; }',
));
if (opened.kind !== 'editable') throw new Error('T087-visual-document-open');
const snapshot = opened.document.snapshot();
const primary = id<SelectionId>('T087-visual-primary');
const secondary = id<SelectionId>('T087-visual-secondary');
const first = offset(0);
const second = offset(16);
const selections = createSelectionSet(snapshot, {
  primaryId: primary,
  selectionGeneration: 7,
  members: [
    { id: primary, kind: 'normal-cursor', direction: 'forward', anchor: character(first, offset(1)), head: character(first, offset(1)) },
    { id: secondary, kind: 'normal-cursor', direction: 'forward', anchor: character(second, offset(17)), head: character(second, offset(17)) },
  ],
});
if (!selections.ok) throw new Error(`T087-visual-selection:${selections.error.kind}`);
const view: WorkbenchViewSnapshot = {
  session: { viewId, documentId, documentVersion: snapshot.version, selections: selections.value.selectionSet, mode: 'normal' },
  document: snapshot,
  selections: selections.value.selectionSet,
  scrollTop: 0,
  scrollLeft: 0,
};
const document: DocumentReadPort = {
  snapshot: () => snapshot,
  slice: (start, end, expectedVersion) => expectedVersion === snapshot.version
    ? snapshot.slice(start, end)
    : { ok: false, error: { kind: 'stale-version' } },
};
const workbench: WorkbenchReadPort = {
  activeViewId: viewId,
  readView: (candidate) => candidate === viewId ? view : undefined,
  readDocument: (candidate) => candidate === viewId ? document : undefined,
};

const colorMode = process.env.XI_T087_COLOR_MODE === 'no-color'
  ? 'no-color' as const
  : process.env.XI_T087_COLOR_MODE === 'ansi256'
    ? 'ansi256' as const
    : 'truecolor' as const;
const ascii = process.env.XI_T087_ASCII === '1';
const presentation: EditorPresentationRead = {
  motionTrail: 'last-motion',
  reducedMotion: true,
  colorMode,
  motionPreview: {
    documentId,
    documentVersion: snapshot.version,
    selectionGeneration: selections.value.selectionSet.selectionGeneration,
    operatorKey: 'w',
    count: 1,
    members: [
      { memberId: primary, source: 0, destination: 16, moved: true, extent: { kind: 'characterwise', start: 0, end: 17 } },
      { memberId: secondary, source: 16, destination: 31, moved: true, extent: { kind: 'characterwise', start: 16, end: 32 } },
    ],
  },
  operatorPreview: {
    documentId,
    documentVersion: snapshot.version,
    selectionGeneration: selections.value.selectionSet.selectionGeneration,
    members: [{ memberId: primary, kind: 'characterwise', start: 6, end: 14 }],
  },
};

const lowColorTheme: WorkbenchTheme | undefined = colorMode === 'no-color'
  ? {
    background: '#000000', surface: '#202020', surfaceActive: '#404040', foreground: '#FFFFFF', muted: '#AAAAAA',
    border: '#808080', accent: '#FFFFFF', error: '#FFFFFF',
  }
  : undefined;

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
  fileLabel: `T087 ${colorMode}`,
  ascii,
  ...(lowColorTheme === undefined ? {} : { theme: lowColorTheme }),
  presentation: { readPresentation: () => presentation },
});
renderer.root.add(viewport);
let announced = false;
renderer.on('frame', () => {
  if (announced || process.env.XI_UI_TEST_MARKERS !== '1') return;
  announced = true;
  process.stderr.write(`XI_T087_SCREEN_READY ${JSON.stringify({ width: renderer.width, height: renderer.height, colorMode })}\r\n`);
});
renderer.keyInput.on('keypress', (event) => {
  if ((event.ctrl && (event.name === 'c' || event.name === 'C')) || event.name === 'q') renderer.destroy();
});
renderer.start();
setTimeout(() => { if (!renderer.isDestroyed) renderer.destroy(); }, 3500);
await done;

function offset(value: number) {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error(`T087-visual-offset:${value}`);
  return result.value;
}

function character(start: ReturnType<typeof offset>, after: ReturnType<typeof offset>) {
  return { kind: 'character' as const, offset: start, after };
}

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T087-visual-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
