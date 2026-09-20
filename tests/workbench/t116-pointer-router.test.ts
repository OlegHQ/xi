import { strict as assert } from 'node:assert';
import type { ClockPort, Disposable } from '../../packages/contracts/src/index';
import {
  WorkbenchPointerRouter,
  type PointerControlEvent,
  type PointerExplorerPort,
  type PointerPickerModelPort,
  type PointerPickerPort,
  type PointerProblemsPort,
  type PointerSearchPort,
  type PointerWorkbenchEvent,
} from '../../packages/workbench/input/pointer-router';

class FakeSession {
  resizeCalls: readonly { readonly nodeId: string; readonly ratio: number }[] = [];
  resizeSplit(nodeId: string, ratio: number, availableCells: number): { readonly ok: true } {
    this.resizeCalls = [...this.resizeCalls, { nodeId, ratio }];
    return { ok: true };
  }
}

class FakePointerCapture {
  cancelled: readonly string[] = [];
  disposed = false;
  readonly dispatched: unknown[] = [];
  dispatch(event: unknown): boolean { this.dispatched.push(event); return true; }
  cancel(reason: string): void { this.cancelled = [...this.cancelled, reason]; }
  dispose(): void { this.disposed = true; }
}

/** A `ClockPort` whose `monotonicMilliseconds()` is set explicitly, so click-count tests
 * control the interval between clicks without real sleeps. */
class FakeClock implements ClockPort {
  now = 0;
  monotonicMilliseconds(): number { return this.now; }
  schedule(_delayMilliseconds: number, _callback: () => void): Disposable { return Object.freeze({ dispose: () => {} }); }
  async sleep(): Promise<{ readonly ok: true; readonly value: undefined }> { return { ok: true, value: undefined }; }
}

function splitterEvent(action: PointerControlEvent['action'], firstSize: number, secondSize: number): PointerWorkbenchEvent {
  return {
    phase: action === 'begin' ? 'down' : 'move',
    viewId: 'view-1',
    cell: { row: 0, column: 0 },
    button: action === 'begin' ? 0 : null,
    control: { id: 'splitter:root', kind: 'splitter', action, firstSize, secondSize, availableCells: 100 },
  };
}

const noopPicker: PointerPickerPort = { activateEntry: async () => {} };
const noopPickerModel: PointerPickerModelPort = { model: { generation: 0, entries: [] }, select: () => true };
const noopExplorer: PointerExplorerPort = {
  handlePointerActivate: () => true,
  selectForContextMenu: () => undefined,
  activateContextMenuAction: () => {},
};
const noopSearch: PointerSearchPort = { readModel: () => undefined, setSelectedIndex: () => {}, openMatch: async () => {}, previewSelected: () => {}, focusQuery: () => {}, focusReplace: () => {}, toggleCollapsed: () => {} };
const noopProblems: PointerProblemsPort = { model: { generation: 0, all: [] }, setSelectedProblemIndex: () => {}, openProblem: async () => {} };

// T116-POINTER-01: a splitter drag begins, then a resize (e.g. terminal resize) cancels it and
// restores the split to its pre-drag geometry -- mirroring the original `onPointerCancel`
// path's `cancelSplitterDrag()` call.
{
  const session = new FakeSession();
  const pointerCapture = new FakePointerCapture();
  let layoutChanges = 0;
  const router = new WorkbenchPointerRouter({
    onLayoutChange: () => { layoutChanges += 1; },
    session: session as never,
    marker: () => {},
    clock: new FakeClock(),
    pointerCapture: pointerCapture as never,
    contextMenu: { openAt: () => {} },
    picker: noopPicker,
    pickerModel: noopPickerModel,
    explorer: noopExplorer,
    search: noopSearch,
    problems: noopProblems,
  });

  const began = router.handleControl(splitterEvent('begin', 40, 60));
  assert.equal(began, true);

  router.handleControl(splitterEvent('move', 30, 70));
  assert.equal(layoutChanges, 1, 'drag wakes the tab-strip geometry');
  router.handlePointerCancel('resize');
  assert.equal(layoutChanges, 2, 'cancellation wakes the restored tab-strip geometry');

  assert.equal(pointerCapture.cancelled[0], 'resize', 'T116-POINTER-01a the pointer capture engine was cancelled for the resize');
  assert.equal(session.resizeCalls.length, 2, 'T116-POINTER-01b the splitter was restored to its pre-drag geometry');
  assert.equal(session.resizeCalls[0]?.nodeId, 'root');

  router.dispose();
}

// T116-POINTER-02: two 'down' clicks on the same text cell within 400ms report clickCount 1
// then 2 on the events forwarded to the pointer-capture engine; a third click within the
// window caps at 3, and a click elsewhere (or after the window) resets to 1.
{
  const clock = new FakeClock();
  const pointerCapture = new FakePointerCapture();
  const router = new WorkbenchPointerRouter({
    session: new FakeSession() as never,
    marker: () => {},
    clock,
    pointerCapture: pointerCapture as never,
    contextMenu: { openAt: () => {} },
    picker: noopPicker,
    pickerModel: noopPickerModel,
    explorer: noopExplorer,
    search: noopSearch,
    problems: noopProblems,
  });
  const textDown = (row: number, column: number): PointerWorkbenchEvent => ({ phase: 'down', viewId: 'view-1', cell: { row, column }, button: 0 });

  clock.now = 0;
  router.handlePointer(textDown(2, 5));
  clock.now = 100;
  router.handlePointer(textDown(2, 5));
  clock.now = 200;
  router.handlePointer(textDown(2, 5));
  clock.now = 2000;
  router.handlePointer(textDown(2, 5));
  clock.now = 2050;
  router.handlePointer(textDown(9, 9));

  const clickCounts = pointerCapture.dispatched.map((event) => (event as { readonly clickCount?: number }).clickCount);
  assert.deepEqual(clickCounts, [1, 2, 3, 1, 1], 'T116-POINTER-02 clickCount is 1/2/3-capped within the window and resets after it lapses or the cell changes');

  router.dispose();
}

// T116-POINTER-03: a single click on a `tab.<id>` control activates that tab; a second click
// within the window also pins it (promotes it out of preview).
{
  const clock = new FakeClock();
  let activated: string[] = [];
  let pinned: string[] = [];
  const router = new WorkbenchPointerRouter({
    session: new FakeSession() as never,
    marker: () => {},
    clock,
    onTabActivate: (bufferId) => { activated = [...activated, bufferId]; },
    onTabPin: (bufferId) => { pinned = [...pinned, bufferId]; },
    pointerCapture: new FakePointerCapture() as never,
    contextMenu: { openAt: () => {} },
    picker: noopPicker,
    pickerModel: noopPickerModel,
    explorer: noopExplorer,
    search: noopSearch,
    problems: noopProblems,
  });
  const tabDown: PointerWorkbenchEvent = { phase: 'down', viewId: 'view-1', cell: { row: 0, column: 3 }, button: 0, control: { id: 'doc-1', kind: 'tab', action: 'activate' } };
  const tabUp: PointerWorkbenchEvent = { ...tabDown, phase: 'up', button: null };

  clock.now = 0;
  router.handleControl(tabDown);
  router.handleControl(tabUp);
  assert.deepEqual(activated, ['doc-1'], 'T116-POINTER-03a a single tab click activates it');
  assert.deepEqual(pinned, [], 'T116-POINTER-03b a single tab click does not pin it');

  clock.now = 150;
  router.handleControl(tabDown);
  router.handleControl(tabUp);
  assert.deepEqual(activated, ['doc-1', 'doc-1'], 'T116-POINTER-03c a double click activates again');
  assert.deepEqual(pinned, ['doc-1'], 'T116-POINTER-03d a double tab click within the window pins it');

  router.dispose();
}

// T116-POINTER-04: theme-row hover only selects and previews; it must not activate/close the
// picker as a click does.
{
  let previews = 0;
  let activations = 0;
  let selected: string | undefined;
  const router = new WorkbenchPointerRouter({
    session: new FakeSession() as never,
    marker: () => {},
    clock: new FakeClock(),
    pointerCapture: new FakePointerCapture() as never,
    contextMenu: { openAt: () => {} },
    picker: { activateEntry: async () => { activations += 1; }, previewSelected: () => { previews += 1; } },
    pickerModel: {
      model: { generation: 7, entries: [{ id: 'xi-dark' }] },
      select: (id) => { selected = id; return true; },
    },
    explorer: noopExplorer,
    search: noopSearch,
    problems: noopProblems,
  });
  router.handlePanelPointer({ panel: 'picker', action: 'preview', itemId: 'xi-dark', generation: 7, row: 2, column: 4, screenX: 4, screenY: 2 });
  assert.equal(selected, 'xi-dark', 'T116-POINTER-04a hover selects the row before previewing it');
  assert.equal(previews, 1, 'T116-POINTER-04b hover uses the picker preview path');
  assert.equal(activations, 0, 'T116-POINTER-04c hover never commits a picker entry');
  router.dispose();
}

console.log('T116 WorkbenchPointerRouter passed splitter-drag-cancel, click-count and tab-activate/pin fixtures');
