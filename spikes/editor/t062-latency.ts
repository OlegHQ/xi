/**
 * Production WorkbenchRenderable input-to-visible-text probe.
 *
 * The PTY driver owns the clock and waits for the text emitted by the real
 * renderer. This process owns the document, selection and workbench read model
 * exactly as the first editor shell does; it deliberately does not claim a
 * physical key-to-photon measurement.
 */
import { createCliRenderer } from '@opentui/core';
import { asIdentifier, asUtf16Offset, type DocumentId, type SelectionId, type ViewId } from '../../packages/primitives/src/index';
import { openTextDocument, type DocumentReadPort, type DocumentSnapshot } from '../../packages/document/src/index';
import { createSelectionSet } from '../../packages/selections/src/index';
import type { WorkbenchReadPort, WorkbenchViewSnapshot } from '../../packages/workbench/src/index';
import { WorkbenchRenderable } from '../../packages/ui/src/index';

const documentId = id<DocumentId>('T062-latency-document');
const viewId = id<ViewId>('T062-latency-view');
const primaryId = id<SelectionId>('T062-latency-primary');
const encoder = new TextEncoder();
const opened = openTextDocument(documentId, encoder.encode('_'));
if (opened.kind !== 'editable') throw new Error(`T062-latency-open:${opened.kind}`);
const document = opened.document;

let snapshot = document.snapshot();
let selections = makeSelections(snapshot, 0);
let view = makeView(snapshot, selections);
const documentRead: DocumentReadPort = {
  snapshot: () => snapshot,
  slice: (start, end, expectedVersion) => expectedVersion === snapshot.version
    ? snapshot.slice(start, end)
    : { ok: false, error: { kind: 'stale-version' } },
};
const workbench: WorkbenchReadPort = {
  activeViewId: viewId,
  readView: (candidate) => candidate === viewId ? view : undefined,
  readDocument: (candidate) => candidate === viewId ? documentRead : undefined,
};

let finish!: () => void;
const done = new Promise<void>((resolve) => { finish = resolve; });
const renderer = await createCliRenderer({
  screenMode: 'alternate-screen',
  clearOnShutdown: true,
  exitOnCtrlC: false,
  useMouse: false,
  consoleMode: 'disabled',
  openConsoleOnError: false,
  targetFps: 1_000,
  maxFps: 1_000,
  onDestroy: () => {
    process.stderr.write(`XI_T062_LATENCY_STOPPED ${JSON.stringify({ documentVersion: snapshot.version })}\r\n`);
    finish();
  },
});
const viewport = new WorkbenchRenderable(renderer.root.ctx, {
  workbench,
  fileLabel: 'T062 latency',
  colorMode: 'truecolor',
});
renderer.root.add(viewport);
let ready = false;
let paintedVersion = -1;
renderer.on('frame', () => {
  const renderedVersion = (viewport.lastFrame?.view?.document.version as number | undefined) ?? (snapshot.version as number);
  if (!ready) {
    ready = true;
    process.stderr.write(`XI_T062_LATENCY_READY ${JSON.stringify({ width: renderer.width, height: renderer.height, documentVersion: snapshot.version, boundary: 'PTY write to WorkbenchRenderable frame marker; physical display excluded' })}\r\n`);
  }
  if (renderedVersion <= paintedVersion) return;
  paintedVersion = renderedVersion;
  if (renderedVersion === 0) return;
  const renderedView = viewport.lastFrame?.view;
  const renderedText = renderedView === undefined ? undefined : renderedView.document.slice(zeroOffset(), prefixEnd(renderedView.document));
  const prefix = renderedText?.ok === true ? renderedText.value.slice(0, 18) : '';
  process.stderr.write(`XI_T062_LATENCY_FRAME ${JSON.stringify({ version: renderedVersion, prefix })}\r\n`);
});
renderer.keyInput.on('keypress', (event) => {
  const key = event.name;
  if (event.ctrl && key.toLowerCase() === 'c') {
    renderer.destroy();
    return;
  }
  if (key === 'q') {
    renderer.destroy();
    return;
  }
  if (key.length !== 1 || !/^[a-pr-zA-PR-Z0-9]$/u.test(key)) return;
  const before = document.snapshot();
  const zero = asUtf16Offset(0);
  if (!zero.ok) throw new Error('T062-latency-zero-offset');
  const committed = document.commit({
    documentId,
    expectedVersion: before.version,
    edits: [{ start: zero.value, end: zero.value, text: key }],
    origin: 'vim',
    undoGroup: id(`T062-latency-group-${before.version}`),
  });
  if (!committed.ok || committed.value.kind !== 'committed') throw new Error(`T062-latency-commit:${committed.ok ? committed.value.kind : committed.error.kind}`);
  snapshot = document.snapshot();
  selections = makeSelections(snapshot, (selections.selectionGeneration as number) + 1);
  view = makeView(snapshot, selections);
  viewport.refresh();
});
renderer.start();
await done;

function makeView(nextSnapshot: DocumentSnapshot, nextSelections: ReturnType<typeof makeSelections>): WorkbenchViewSnapshot {
  return {
    session: { viewId, documentId, documentVersion: nextSnapshot.version, selections: nextSelections, mode: 'normal' },
    document: nextSnapshot,
    selections: nextSelections,
  };
}

function makeSelections(nextSnapshot: DocumentSnapshot, generation: number) {
  // Keep the cursor on the sentinel at the end so the inserted prefix stays
  // visible in the PTY screen and remains an observable output boundary.
  const cursorOffset = Math.max(0, nextSnapshot.lengthUtf16 - 1);
  const offset = asUtf16Offset(cursorOffset);
  const after = asUtf16Offset(Math.min(nextSnapshot.lengthUtf16, cursorOffset + 1));
  if (!offset.ok || !after.ok) throw new Error('T062-latency-selection-offset');
  const result = createSelectionSet(nextSnapshot, {
    primaryId,
    selectionGeneration: generation,
    members: [{
      id: primaryId,
      kind: 'normal-cursor',
      direction: 'forward',
      anchor: { kind: 'character', offset: offset.value, after: after.value },
      head: { kind: 'character', offset: offset.value, after: after.value },
    }],
  });
  if (!result.ok) throw new Error(`T062-latency-selection:${result.error.kind}`);
  return result.value.selectionSet;
}

function zeroOffset() {
  const value = asUtf16Offset(0);
  if (!value.ok) throw new Error('T062-latency-prefix-zero');
  return value.value;
}

function prefixEnd(nextSnapshot: DocumentSnapshot) {
  const value = asUtf16Offset(Math.min(nextSnapshot.lengthUtf16, 18));
  if (!value.ok) throw new Error('T062-latency-prefix-end');
  return value.value;
}

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T062-latency-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
