import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTestRenderer } from '@opentui/core/testing';
import { asIdentifier, asUtf16Offset, type DocumentId, type SelectionId, type ViewId } from '../../packages/primitives/src/index';
import { openTextDocument, type DocumentReadPort, type DocumentSnapshot } from '../../packages/document/src/index';
import { createSelectionSet } from '../../packages/selections/src/index';
import type { WorkbenchReadPort, WorkbenchViewSnapshot } from '../../packages/workbench/src/index';
import { ASCII_WORKBENCH_THEME, OpenTuiTerminalAdapter, WorkbenchRenderable, calculateWorkbenchLayout, type WorkbenchTheme } from '../../packages/ui/src/index';

const VIEW_ID = id<ViewId>('T034-view');
const DOCUMENT_ID = id<DocumentId>('T034-document');

function makeWorkbench(text = 'alpha 😀 beta\nsecond line\nthird line'): { readonly workbench: WorkbenchReadPort; readonly snapshot: DocumentSnapshot } {
  const opened = openTextDocument(DOCUMENT_ID, new TextEncoder().encode(text));
  assert.equal(opened.kind, 'editable', 'T034-DOC-OWNER-01 fixture uses the document owner');
  if (opened.kind !== 'editable') throw new Error('T034-document-open');
  const snapshot = opened.document.snapshot();
  const first = asUtf16Offset(0);
  const second = asUtf16Offset(6);
  const firstAfter = asUtf16Offset(1);
  const secondAfter = asUtf16Offset(8);
  if (!first.ok || !second.ok || !firstAfter.ok || !secondAfter.ok) throw new Error('T034-offset');
  const primary = id<SelectionId>('T034-primary');
  const secondary = id<SelectionId>('T034-secondary');
  const selections = createSelectionSet(snapshot, {
    primaryId: primary,
    selectionGeneration: 0,
    members: [
      { id: primary, kind: 'normal-cursor', direction: 'forward', anchor: { kind: 'character', offset: first.value, after: firstAfter.value }, head: { kind: 'character', offset: first.value, after: firstAfter.value } },
      { id: secondary, kind: 'normal-cursor', direction: 'forward', anchor: { kind: 'character', offset: second.value, after: secondAfter.value }, head: { kind: 'character', offset: second.value, after: secondAfter.value } },
    ],
  });
  if (selections.ok === false) throw new Error(`T034-selection:${selections.error.kind}`);
  const view: WorkbenchViewSnapshot = {
    session: { viewId: VIEW_ID, documentId: DOCUMENT_ID, documentVersion: snapshot.version, selections: selections.value.selectionSet, mode: 'normal' },
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
  return {
    snapshot,
    workbench: {
      activeViewId: VIEW_ID,
      readView: (viewId) => viewId === VIEW_ID ? view : undefined,
      readDocument: (viewId) => viewId === VIEW_ID ? document : undefined,
    },
  };
}

function makeMutableWorkbench(): { readonly workbench: WorkbenchReadPort; readonly moveCursor: (offset: number) => void } {
  const opened = openTextDocument(DOCUMENT_ID, new TextEncoder().encode('alpha 😀 beta\nsecond line\nthird line'));
  assert.equal(opened.kind, 'editable', 'T034-DAMAGE-01 fixture uses the document owner');
  if (opened.kind !== 'editable') throw new Error('T034-damage-document');
  const snapshot = opened.document.snapshot();
  const primary = id<SelectionId>('T034-damage-primary');
  let view = makeCursorView(snapshot, primary, 0, 0);
  const document: DocumentReadPort = {
    snapshot: () => snapshot,
    slice: (start, end, expectedVersion) => expectedVersion === snapshot.version
      ? snapshot.slice(start, end)
      : { ok: false, error: { kind: 'stale-version' } },
  };
  const workbench: WorkbenchReadPort = {
    activeViewId: VIEW_ID,
    readView: (viewId) => viewId === VIEW_ID ? view : undefined,
    readDocument: (viewId) => viewId === VIEW_ID ? document : undefined,
  };
  return {
    workbench,
    moveCursor: (offset) => { view = makeCursorView(snapshot, primary, offset, view.selections.selectionGeneration + 1); },
  };
}

function makeCursorView(snapshot: DocumentSnapshot, primary: SelectionId, offset: number, generation: number): WorkbenchViewSnapshot {
  const head = asUtf16Offset(offset);
  const after = asUtf16Offset(offset + 1);
  if (!head.ok || !after.ok) throw new Error(`T034-damage-offset:${offset}`);
  const selections = createSelectionSet(snapshot, {
    primaryId: primary,
    selectionGeneration: generation,
    members: [{ id: primary, kind: 'normal-cursor', direction: 'forward', anchor: { kind: 'character', offset: head.value, after: after.value }, head: { kind: 'character', offset: head.value, after: after.value } }],
  });
  if (!selections.ok) throw new Error(`T034-damage-selection:${selections.error.kind}`);
  return {
    session: { viewId: VIEW_ID, documentId: DOCUMENT_ID, documentVersion: snapshot.version, selections: selections.value.selectionSet, mode: 'normal' },
    document: snapshot,
    selections: selections.value.selectionSet,
    scrollTop: 0,
    scrollLeft: 0,
  };
}

async function renderAt(width: number, height: number, options: { readonly ascii?: boolean; readonly bottom?: boolean } = {}): Promise<{ readonly frame: WorkbenchRenderable['lastFrame']; readonly chars: string; readonly viewport: WorkbenchRenderable; readonly setup: Awaited<ReturnType<typeof createTestRenderer>> }> {
  const { workbench } = makeWorkbench();
  const setup = await createTestRenderer({ width, height, bufferedOutput: 'memory', gatherStats: true });
  const renderOptions = {
    workbench,
    fileLabel: 'editor.ts',
    ...(options.ascii === undefined ? {} : { ascii: options.ascii }),
    ...(options.bottom === undefined ? {} : { showBottomPanel: options.bottom }),
  };
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, renderOptions);
  setup.renderer.root.add(viewport);
  await setup.renderOnce();
  return { frame: viewport.lastFrame, chars: setup.captureCharFrame(), viewport, setup };
}

function testLayoutPolicy(): void {
  const wide = calculateWorkbenchLayout(120, 40);
  assert.equal(wide.sidebarVisible, true, 'T034-LAYOUT-120-01 120x40 shows the sidebar');
  assert.ok(wide.sidebarWidth >= 22 && wide.sidebarWidth <= 40, 'T034-LAYOUT-120-02 sidebar is within the cell bounds');
  assert.ok(wide.editorWidth >= 60, 'T034-LAYOUT-120-03 editor retains the minimum width');
  const narrow = calculateWorkbenchLayout(80, 24);
  assert.equal(narrow.sidebarVisible, false, 'T034-LAYOUT-80-01 80x24 hides the sidebar by default');
  const tiny = calculateWorkbenchLayout(39, 9);
  assert.equal(tiny.compact, true, 'T034-LAYOUT-TINY-01 tiny terminals use the compact state');
}

async function testRenderedFrames(): Promise<void> {
  const rendered = await renderAt(120, 40, { bottom: true });
  assert.equal(rendered.frame?.layout.sidebarVisible, true, 'T034-FRAME-120-01 sidebar layout is published');
  assert.equal(rendered.frame?.frame?.selections.length, 2, 'T034-FRAME-120-02 primary and secondary selections are projected');
  assert.match(rendered.chars, /Files  Search  Git/u, 'T034-FRAME-120-03 shell labels are visible');
  assert.match(rendered.chars, /NORMAL/u, 'T034-FRAME-120-04 mode is textual and discoverable');
  rendered.setup.resize(80, 24);
  await rendered.setup.renderOnce();
  assert.equal(rendered.viewport.layout.sidebarVisible, false, 'T034-RESIZE-80-01 resize hides the sidebar without replacing the document');
  assert.equal(rendered.viewport.isDestroyed, false, 'T034-RESIZE-80-02 renderer remains mounted after resize');
  rendered.setup.renderer.destroy();
  assert.equal(rendered.viewport.isDestroyed, true, 'T034-CLEANUP-01 renderer disposal destroys the workbench renderable');
}

async function testAsciiAndSmallTerminal(): Promise<void> {
  const ascii = await renderAt(160, 50, { ascii: true });
  assert.match(ascii.chars, /> editor\.ts/u, 'T034-ASCII-01 ASCII disclosure is width-one');
  assert.doesNotMatch(ascii.chars, /▾|▌|●/u, 'T034-ASCII-02 ASCII mode replaces non-ASCII disclosure/cursor/status glyphs');
  ascii.setup.renderer.destroy();

  const tiny = await renderAt(30, 9);
  assert.match(tiny.chars, /terminal too small/u, 'T034-TINY-01 compact state is explicit');
  tiny.setup.renderer.destroy();
}

async function testDamageLimitedCursorRepaint(): Promise<void> {
  const incremental = makeMutableWorkbench();
  const incrementalSetup = await createTestRenderer({ width: 120, height: 40, bufferedOutput: 'memory', gatherStats: true });
  const incrementalViewport = new WorkbenchRenderable(incrementalSetup.renderer.root.ctx, { workbench: incremental.workbench, fileLabel: 'editor.ts' });
  incrementalSetup.renderer.root.add(incrementalViewport);
  await incrementalSetup.renderOnce();
  incremental.moveCursor(14);
  incrementalViewport.refresh();
  await incrementalSetup.renderOnce();
  const incrementalFrame = incrementalSetup.captureCharFrame();

  const full = makeMutableWorkbench();
  full.moveCursor(14);
  const fullSetup = await createTestRenderer({ width: 120, height: 40, bufferedOutput: 'memory', gatherStats: true });
  const fullViewport = new WorkbenchRenderable(fullSetup.renderer.root.ctx, { workbench: full.workbench, fileLabel: 'editor.ts' });
  fullSetup.renderer.root.add(fullViewport);
  await fullSetup.renderOnce();
  assert.equal(incrementalFrame, fullSetup.captureCharFrame(), 'T034-DAMAGE-01 cursor movement produces the same terminal frame as a fresh full paint');
  incrementalSetup.renderer.destroy();
  fullSetup.renderer.destroy();
}

async function testLowColorAndTerminalFailure(): Promise<void> {
  const lowColorTheme: WorkbenchTheme = {
    background: '#000000',
    surface: '#202020',
    surfaceActive: '#404040',
    foreground: '#FFFFFF',
    muted: '#AAAAAA',
    border: '#808080',
    accent: '#FFFFFF',
    error: '#FFFFFF',
  };
  const lowColorSetup = await createTestRenderer({ width: 120, height: 40, bufferedOutput: 'memory', gatherStats: true });
  const lowColor = new WorkbenchRenderable(lowColorSetup.renderer.root.ctx, {
    workbench: makeWorkbench().workbench,
    fileLabel: 'editor.ts',
    theme: lowColorTheme,
  });
  lowColorSetup.renderer.root.add(lowColor);
  await lowColorSetup.renderOnce();
  assert.equal(lowColor.lastFrame?.frame?.selections.length, 2, 'T034-LOW-COLOR-01 cursor markers remain projected with a restricted palette');
  assert.match(lowColorSetup.captureCharFrame(), /NORMAL/u, 'T034-LOW-COLOR-02 status remains readable with a restricted palette');
  lowColorSetup.renderer.destroy();

  const failed = new OpenTuiTerminalAdapter({ createRenderer: async () => { throw new Error('injected renderer failure'); } });
  const start = await failed.start();
  assert.equal(start.ok, false, 'T034-PARTIAL-01 renderer startup failure is returned as a typed result');
  if (start.ok) throw new Error('T034-partial-start-expected-failure');
  assert.equal(start.error.code, 'terminal-adapter-start-failed', 'T034-PARTIAL-02 startup failure code is stable');
  failed.dispose();
  assert.equal(failed.renderer, undefined, 'T034-PARTIAL-03 failed adapter disposal leaves no renderer owned');
}

async function captureFrameMatrix(): Promise<void> {
  const matrix: Array<{ readonly size: string; readonly layout: WorkbenchRenderable['layout']; readonly cursorCount: number; readonly firstRows: string[] }> = [];
  for (const [width, height] of [[80, 24], [120, 40], [160, 50], [240, 70], [60, 18], [30, 9]] as const) {
    const rendered = await renderAt(width, height, { ascii: width === 60 });
    matrix.push({
      size: `${width}x${height}`,
      layout: rendered.viewport.layout,
      cursorCount: rendered.frame?.frame?.selections.length ?? 0,
      firstRows: rendered.chars.split('\n').slice(0, Math.min(8, height)),
    });
    rendered.setup.renderer.destroy();
  }
  const artifactRoot = resolve(process.cwd(), '.artifacts/ui');
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(resolve(artifactRoot, 't034-frame-matrix.json'), `${JSON.stringify({ sizes: matrix }, null, 2)}\n`, 'utf8');
}

async function testGitBranchStatus(): Promise<void> {
  const { workbench } = makeWorkbench();
  const setup = await createTestRenderer({ width: 120, height: 40, bufferedOutput: 'memory', gatherStats: true });
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, {
    workbench,
    fileLabel: 'editor.ts',
    gitBranch: () => 'feature/status-branch',
  });
  setup.renderer.root.add(viewport);
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /editor\.ts \(feature\/status-branch\)/u, 'T034-GIT-BRANCH-01 status line shows the branch next to the file name');
  setup.renderer.destroy();

  const withoutBranch = await createTestRenderer({ width: 120, height: 40, bufferedOutput: 'memory', gatherStats: true });
  const plainViewport = new WorkbenchRenderable(withoutBranch.renderer.root.ctx, { workbench, fileLabel: 'editor.ts' });
  withoutBranch.renderer.root.add(plainViewport);
  await withoutBranch.renderOnce();
  assert.doesNotMatch(withoutBranch.captureCharFrame(), /\(feature/u, 'T034-GIT-BRANCH-02 no branch reader omits the parenthetical');
  withoutBranch.renderer.destroy();
}

testLayoutPolicy();
await testRenderedFrames();
await testAsciiAndSmallTerminal();
await testDamageLimitedCursorRepaint();
await testLowColorAndTerminalFailure();
await testGitBranchStatus();
await captureFrameMatrix();
console.log('T034 workbench frames passed responsive shell, layout projection, primary/secondary cursors, ASCII fallback, small-terminal, git branch status and cleanup fixtures');

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T034-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
