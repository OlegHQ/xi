import { strict as assert } from 'node:assert';
import { createTestRenderer } from '@opentui/core/testing';
import { asIdentifier, asUtf16Offset, type DocumentId, type SelectionId, type ViewId } from '../../packages/primitives/src/index';
import { openTextDocument, type DocumentReadPort, type DocumentSnapshot } from '../../packages/document/src/index';
import { createSelectionSet } from '../../packages/selections/src/index';
import type { WorkbenchReadPort, WorkbenchViewSnapshot } from '../../packages/workbench/src/index';
import { WorkbenchRenderable, runOpenTuiWorkbench } from '../../packages/ui/src/index';
import type { CliRenderer } from '@opentui/core/renderer';
import { dispatchKeyFromOnKeypress } from './router-test-helpers';

const VIEW_ID = id<ViewId>('T111-view');
const DOCUMENT_ID = id<DocumentId>('T111-document');

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T111-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function makeCursorView(snapshot: DocumentSnapshot, primary: SelectionId, offset: number, generation: number, scrollTop = 0, scrollLeft = 0): WorkbenchViewSnapshot {
  const head = asUtf16Offset(offset);
  const after = asUtf16Offset(offset + 1);
  if (!head.ok || !after.ok) throw new Error(`T111-offset:${offset}`);
  const selections = createSelectionSet(snapshot, {
    primaryId: primary,
    selectionGeneration: generation,
    members: [{ id: primary, kind: 'normal-cursor', direction: 'forward', anchor: { kind: 'character', offset: head.value, after: after.value }, head: { kind: 'character', offset: head.value, after: after.value } }],
  });
  if (!selections.ok) throw new Error(`T111-selection:${selections.error.kind}`);
  return {
    session: { viewId: VIEW_ID, documentId: DOCUMENT_ID, documentVersion: snapshot.version, selections: selections.value.selectionSet, mode: 'normal' },
    document: snapshot,
    selections: selections.value.selectionSet,
    scrollTop,
    scrollLeft,
  };
}

function makeMutableWorkbench(text: string): {
  readonly workbench: WorkbenchReadPort;
  readonly moveCursor: (offset: number) => void;
  readonly setScroll: (scrollTop: number, scrollLeft?: number) => void;
} {
  const opened = openTextDocument(DOCUMENT_ID, new TextEncoder().encode(text));
  if (opened.kind !== 'editable') throw new Error('T111-document-open');
  const snapshot = opened.document.snapshot();
  const primary = id<SelectionId>('T111-primary');
  let offset = 0;
  let scrollTop = 0;
  let scrollLeft = 0;
  let generation = 0;
  let view = makeCursorView(snapshot, primary, offset, generation, scrollTop, scrollLeft);
  const rebuild = (): void => { generation += 1; view = makeCursorView(snapshot, primary, offset, generation, scrollTop, scrollLeft); };
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
    moveCursor: (nextOffset) => { offset = nextOffset; rebuild(); },
    // Mirrors main.ts's wheel handler writing through `WorkbenchSession.setViewScroll`,
    // which the renderable only observes through the read model, never directly.
    setScroll: (nextScrollTop, nextScrollLeft = 0) => { scrollTop = nextScrollTop; scrollLeft = nextScrollLeft; rebuild(); },
  };
}

/**
 * T111-IDLE-01/02: Xi renders on demand, not on a permanent frame-rate loop
 * (docs/plan/15-keystroke-latency.md). This mirrors production exactly: the
 * production renderer (packages/ui/src/terminal.ts) never calls `renderer.start()`
 * any more -- it renders once up front and thereafter only via `requestRender`
 * on key/resize/pointer/state-change paths. This test never calls `.start()`
 * either, so if `renderSelf` fires without an explicit render request, the
 * renderable (not just this test's harness) is doing unrequested idle work.
 */
async function testNoIdleLoop(): Promise<void> {
  const { workbench } = makeMutableWorkbench('alpha\nbeta\ngamma\n');
  const setup = await createTestRenderer({ width: 80, height: 24, bufferedOutput: 'memory', gatherStats: true });
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, { workbench, fileLabel: 'editor.ts' });
  setup.renderer.root.add(viewport);

  let renderCount = 0;
  const renderable = viewport as unknown as { renderSelf: (buffer: unknown) => void };
  const original = renderable.renderSelf.bind(viewport);
  renderable.renderSelf = (buffer: unknown) => {
    renderCount += 1;
    original(buffer);
  };

  await setup.renderOnce();
  // OpenTUI's own initial mount can trigger one internal settle render (e.g. a
  // layout pass marking itself dirty); drain that before measuring idle behavior
  // so the assertion is about Xi's own render-request discipline, not framework
  // mount noise.
  await setup.waitForVisualIdle();
  assert.equal(setup.renderer.getSchedulerState().isRunning, false, 'T111-IDLE-01 renderer never enters the continuous 30fps loop');
  renderCount = 0;

  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  assert.equal(renderCount, 0, 'T111-IDLE-02 an idle renderer performs no renderSelf calls over 200ms');

  // `refresh()` only marks the renderable dirty now (see workbench.ts and
  // packages/ui/src/terminal.ts's `scheduleFlush`); production drives the actual
  // frame with one explicit synchronous render after every key, which `renderOnce()`
  // mirrors here.
  viewport.refresh();
  await setup.renderOnce();
  assert.equal(renderCount, 1, 'T111-IDLE-03 a state change (refresh + one driven render) triggers exactly one renderSelf');

  setup.renderer.destroy();
}

/**
 * T111-SCROLL-01: the viewport must follow the cursor past the first screen
 * (docs/plan/01-architecture.md "Input, effects and rendering"). Before this
 * fix, `project()` always fell back to `defaultAnchor` (line 0), so a cursor
 * below the fold projected to `position: null` and the requested line was
 * never painted.
 */
async function testCursorFollowScroll(): Promise<void> {
  const lines: string[] = [];
  for (let i = 0; i < 200; i += 1) lines.push(`line${String(i).padStart(3, '0')}`);
  const text = lines.join('\n');
  const lineStart = (index: number): number => lines.slice(0, index).reduce((sum, line) => sum + line.length + 1, 0);
  const { workbench, moveCursor } = makeMutableWorkbench(text);
  moveCursor(lineStart(150));

  const setup = await createTestRenderer({ width: 120, height: 42, bufferedOutput: 'memory', gatherStats: true });
  const anchorChanges: Array<{ readonly viewId: string; readonly scrollTop: number; readonly scrollLeft: number }> = [];
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, {
    workbench,
    fileLabel: 'editor.ts',
    onViewportAnchorChange: (viewId, scrollTop, scrollLeft) => { anchorChanges.push({ viewId, scrollTop, scrollLeft }); },
  });
  setup.renderer.root.add(viewport);
  await setup.renderOnce();

  const geometry = viewport.layout;
  assert.equal(geometry.editorHeight, 40, 'T111-SCROLL-00 fixture viewport is 40 rows tall');
  const frame = viewport.lastFrame?.frame;
  assert.ok(frame !== undefined, 'T111-SCROLL-01 a frame is projected for a cursor below the first screen');
  assert.equal(frame?.anchor.lineIndex, 111, 'T111-SCROLL-02 anchor follows the cursor to keep it on-screen (150 - 40 + 1)');
  const primary = frame?.selections.find((selection) => selection.primary);
  assert.notEqual(primary?.head.position, null, 'T111-SCROLL-03 the cursor line has a real screen position, not null');
  assert.equal(primary?.head.position?.row, 150 - 111, 'T111-SCROLL-04 the cursor renders at the expected row inside the viewport');
  assert.ok(anchorChanges.some((change) => change.scrollTop === 111), 'T111-SCROLL-05 the resolved scroll top is reported back through onViewportAnchorChange');

  setup.renderer.destroy();
}

/**
 * T111-WHEEL-01: a wheel scroll is written to the session through
 * `WorkbenchSession.setViewScroll` (apps/xi/src/main.ts's wheel handler), which only
 * changes the read model's `scrollTop`, not the selection. Before this fix the
 * renderable seeded `resolveScrollAnchor` from its own private last-anchor map, so a
 * wheel scroll with the cursor still on-screen had no visible effect. The cursor here
 * stays inside the requested window, so cursor-follow does not itself force a scroll --
 * the resolved anchor must come from the read model's `scrollTop`.
 */
async function testSessionScrollRenders(): Promise<void> {
  const lines: string[] = [];
  for (let i = 0; i < 200; i += 1) lines.push(`line${String(i).padStart(3, '0')}`);
  const text = lines.join('\n');
  const lineStart = (index: number): number => lines.slice(0, index).reduce((sum, line) => sum + line.length + 1, 0);
  const { workbench, setScroll, moveCursor } = makeMutableWorkbench(text);
  moveCursor(lineStart(60));
  setScroll(50);

  const setup = await createTestRenderer({ width: 120, height: 42, bufferedOutput: 'memory', gatherStats: true });
  const viewport = new WorkbenchRenderable(setup.renderer.root.ctx, { workbench, fileLabel: 'editor.ts' });
  setup.renderer.root.add(viewport);
  await setup.renderOnce();

  const frame = viewport.lastFrame?.frame;
  assert.ok(frame !== undefined, 'T111-WHEEL-02 a frame is projected after a session-set scroll');
  assert.equal(frame?.anchor.lineIndex, 50, 'T111-WHEEL-03 the renderable renders from the read model scrollTop written by setViewScroll');

  setup.renderer.destroy();
}

/**
 * T111-KEY-01/02: the real production entrypoint (`runOpenTuiWorkbench`) used to
 * render twice per key -- once from its own explicit synchronous `flushFrame`
 * (`renderer.intermediateRender()`), and once more when the OpenTUI renderer's own
 * scheduled frame (from `WorkbenchRenderable.refresh()`'s old `requestRender()` call)
 * fired later via `process.nextTick`. It also flushed once per key even when several
 * keys arrived in the same synchronous stdin chunk. Both are fixed: `refresh()` only
 * marks the renderable dirty (see workbench.ts), and `terminal.ts` coalesces every
 * key processed before the current synchronous stack unwinds into one microtask-
 * scheduled flush. This drives keys through the real `renderer.stdin` -> key-parser
 * -> `keypress` pipeline, not a direct method call, so it exercises the same path a
 * real keystroke does.
 */
async function testKeyBurstRendersOnce(): Promise<void> {
  const { workbench, moveCursor } = makeMutableWorkbench('alpha\nbeta\ngamma\n');
  const setup = await createTestRenderer({ width: 80, height: 24, bufferedOutput: 'memory', gatherStats: true });
  let frames = 0;
  let nextOffset = 0;
  const run = runOpenTuiWorkbench(workbench, 'editor.ts', {
    renderer: Promise.resolve(setup.renderer as unknown as CliRenderer),
    onFrame: () => { frames += 1; },
    dispatchKey: dispatchKeyFromOnKeypress(() => {
      nextOffset += 1;
      moveCursor(nextOffset);
      return true;
    }),
  });
  // Let `runOpenTuiWorkbench`'s synchronous setup (including its own initial
  // `renderer.intermediateRender()`) finish before measuring key-driven frames.
  await new Promise((resolveWait) => setTimeout(resolveWait, 0));
  frames = 0;

  setup.mockInput.pressKey('a');
  await new Promise((resolveWait) => setTimeout(resolveWait, 0));
  assert.equal(frames, 1, 'T111-KEY-01 a single keystroke renders exactly once, not twice');

  frames = 0;
  await setup.mockInput.pressKeys(['a', 'b', 'c'], 0);
  await new Promise((resolveWait) => setTimeout(resolveWait, 0));
  assert.equal(frames, 1, 'T111-KEY-02 three keys parsed from one synchronous burst share exactly one render');
  assert.equal(nextOffset, 4, 'T111-KEY-03 every key in the burst is still applied, in order (1 + 3 keys)');

  setup.renderer.destroy();
  await run;
}

await testNoIdleLoop();
await testCursorFollowScroll();
await testSessionScrollRenders();
await testKeyBurstRendersOnce();
console.log('T111 render scheduling passed on-demand rendering, cursor-follow scroll, session-scroll and key-burst/double-render fixtures');
