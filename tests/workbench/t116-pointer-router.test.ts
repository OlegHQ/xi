import { strict as assert } from 'node:assert';
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
  dispatch(): boolean { return true; }
  cancel(reason: string): void { this.cancelled = [...this.cancelled, reason]; }
  dispose(): void { this.disposed = true; }
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
const noopSearch: PointerSearchPort = { readModel: () => undefined, setSelectedIndex: () => {}, openMatch: async () => {} };
const noopProblems: PointerProblemsPort = { model: { generation: 0, all: [] }, setSelectedProblemIndex: () => {}, openProblem: async () => {} };

// T116-POINTER-01: a splitter drag begins, then a resize (e.g. terminal resize) cancels it and
// restores the split to its pre-drag geometry -- mirroring the original `onPointerCancel`
// path's `cancelSplitterDrag()` call.
{
  const session = new FakeSession();
  const pointerCapture = new FakePointerCapture();
  const router = new WorkbenchPointerRouter({
    session: session as never,
    marker: () => {},
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

  router.handlePointerCancel('resize');

  assert.equal(pointerCapture.cancelled[0], 'resize', 'T116-POINTER-01a the pointer capture engine was cancelled for the resize');
  assert.equal(session.resizeCalls.length, 1, 'T116-POINTER-01b the splitter was restored to its pre-drag geometry');
  assert.equal(session.resizeCalls[0]?.nodeId, 'root');

  router.dispose();
}

console.log('T116 WorkbenchPointerRouter passed splitter-drag-cancel-on-resize fixture');
