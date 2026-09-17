import type { Disposable } from '../../contracts/src/index';
import type { WorkbenchSession } from '../session';
import { WorkbenchControlRegistry, SplitterDragController, type WorkbenchControl } from './controls';
import { WorkbenchPointerCapture } from './pointer-capture';
import type { PointerEvent } from '../../vim/src/entrypoints/launch';
import type { WorkbenchSearchMatch, WorkbenchSearchModel } from '../search';
import type { ProblemsDiagnostic, ProblemsReadModel } from '../problems';

/** Mirrors `packages/ui`'s `WorkbenchPointerEvent`'s `control` field; workbench cannot
 * import `packages/ui`, not even types. */
export interface PointerControlEvent {
  readonly id: string;
  readonly kind: 'tree' | 'tab' | 'picker' | 'button' | 'splitter';
  readonly action: 'activate' | 'begin' | 'move' | 'commit';
  readonly firstSize?: number;
  readonly secondSize?: number;
  readonly availableCells?: number;
}

/** Mirrors `packages/ui`'s `WorkbenchPointerEvent`. */
export interface PointerWorkbenchEvent {
  readonly phase: 'down' | 'move' | 'up' | 'wheel';
  readonly viewId: string;
  readonly cell: { readonly row: number; readonly column: number };
  readonly target?: {
    readonly lineIndex: number;
    readonly offset: number;
    readonly displayCellColumn: number;
    readonly virtualCell: number;
    readonly cellPart: 'glyph' | 'wide-continuation' | 'tab-fill' | 'clipped-glyph' | 'padding';
  };
  readonly button: number | null;
  readonly control?: PointerControlEvent;
}

/** Mirrors `packages/ui`'s `WorkbenchPanelPointerEvent`. */
export interface PointerPanelEvent {
  readonly panel: 'explorer' | 'picker' | 'search' | 'problems';
  readonly action: 'activate' | 'context';
  readonly itemId: string;
  readonly generation: number;
  readonly row: number;
  readonly column: number;
  readonly screenX: number;
  readonly screenY: number;
}

/** Mirrors `packages/services/navigation`'s `PickerEntry`, subset read here. */
export interface PointerPickerEntry {
  readonly id: string;
}

/** Narrow port onto the composition root's `BoundedPickerModel`. */
export interface PointerPickerModelPort {
  readonly model: { readonly generation: number; readonly entries: readonly PointerPickerEntry[] };
  select(id: string): boolean;
}

export interface PointerPickerPort {
  activateEntry(id: string): Promise<void>;
}

export interface PointerExplorerPort {
  handlePointerActivate(itemId: string, generation: number): boolean;
  selectForContextMenu(itemId: string, generation: number): { readonly nodeId: string; readonly isContainer: boolean; readonly expanded: boolean } | undefined;
  activateContextMenuAction(nodeId: string, action: 'open' | 'toggle'): void;
}

export interface PointerSearchPort {
  /** `undefined` while the backing service has not loaded yet. */
  readModel(): WorkbenchSearchModel | undefined;
  setSelectedIndex(index: number): void;
  openMatch(match: WorkbenchSearchMatch): Promise<void>;
}

export interface PointerProblemsPort {
  readonly model: ProblemsReadModel;
  setSelectedProblemIndex(index: number): void;
  openProblem(problem: ProblemsDiagnostic): Promise<void>;
}

export interface ContextMenuItemInput {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
}

/** Structural port onto `packages/ui`'s `ContextMenuStore`; workbench cannot import `packages/ui`. */
export interface ContextMenuPort {
  openAt(left: number, top: number, items: readonly ContextMenuItemInput[], onActivate: (id: string) => void): void;
}

export interface WorkbenchPointerRouterOptions {
  readonly session: WorkbenchSession;
  readonly marker: (name: string, payload?: unknown) => void;
  readonly pointerCapture: WorkbenchPointerCapture;
  readonly contextMenu: ContextMenuPort;
  readonly picker: PointerPickerPort;
  readonly pickerModel: PointerPickerModelPort;
  readonly explorer: PointerExplorerPort;
  readonly search: PointerSearchPort;
  readonly problems: PointerProblemsPort;
  readonly splitterMinimumCells?: number;
}

/**
 * Owns splitter-drag state and the control/panel pointer dispatch that used to live as
 * closure state inside `apps/xi/src/main.ts`'s `main()`: `handleWorkbenchControl`,
 * `handlePanelPointer`, `openPanelContextMenu`, `cancelSplitterDrag`. `pointerCapture`
 * (the Vim-side gesture engine) is still constructed by the composition root and passed in,
 * matching how `BufferHost` is passed to every other feature controller.
 */
export class WorkbenchPointerRouter implements Disposable {
  readonly #options: WorkbenchPointerRouterOptions;
  readonly #controlRegistry = new WorkbenchControlRegistry();
  readonly #splitterDrag: SplitterDragController;
  #activeSplitter: { readonly nodeId: string; readonly availableCells: number } | undefined;
  #disposed = false;

  constructor(options: WorkbenchPointerRouterOptions) {
    this.#options = options;
    this.#splitterDrag = new SplitterDragController(options.splitterMinimumCells ?? 12);
  }

  get controls(): WorkbenchControlRegistry { return this.#controlRegistry; }

  publishControls(controls: readonly WorkbenchControl[]): void {
    this.#controlRegistry.publish(controls);
  }

  /** Top-level `onPointer` decision: control events go to `handleControl`, everything else
   * is a text/gutter gesture forwarded to the Vim-side pointer capture engine. */
  handlePointer(event: PointerWorkbenchEvent): boolean {
    if (event.control !== undefined) return this.handleControl(event);
    return this.#options.pointerCapture.dispatch({
      ...event,
      cell: { ...event.cell, ...(event.target === undefined ? {} : { target: event.target }) },
    } as PointerEvent);
  }

  handleControl(event: PointerWorkbenchEvent): boolean {
    const control = event.control;
    if (control?.kind === 'splitter') {
      const nodeId = control.id.startsWith('splitter:') ? control.id.slice('splitter:'.length) : '';
      if (nodeId.length === 0 || control.firstSize === undefined || control.secondSize === undefined || control.availableCells === undefined) return true;
      if (control.action === 'begin' && event.button === 0) {
        if (this.#splitterDrag.begin({ firstSize: control.firstSize, secondSize: control.secondSize })) {
          this.#activeSplitter = { nodeId, availableCells: control.availableCells };
          this.#options.marker('XI_WORKBENCH_SPLITTER', { action: 'begin', nodeId, firstSize: control.firstSize, secondSize: control.secondSize });
        }
        return true;
      }
      if (this.#activeSplitter?.nodeId !== nodeId || this.#activeSplitter.availableCells !== control.availableCells) return true;
      if (control.action === 'move') {
        if (this.#splitterDrag.move(control.firstSize, control.secondSize)) {
          const resized = this.#options.session.resizeSplit(nodeId, control.firstSize / control.availableCells, control.availableCells);
          if (!resized.ok) this.#splitterDrag.cancel();
          this.#options.marker('XI_WORKBENCH_SPLITTER', { action: 'move', nodeId, firstSize: control.firstSize, secondSize: control.secondSize, resized: resized.ok });
        }
        return true;
      }
      if (control.action === 'commit') {
        const committed = this.#splitterDrag.commit();
        this.#activeSplitter = undefined;
        this.#options.marker('XI_WORKBENCH_SPLITTER', { action: 'commit', nodeId, committed: committed !== undefined });
        return true;
      }
      return true;
    }
    if (event.phase === 'down' && event.button === 0) {
      const activated = this.#controlRegistry.activate(control?.id ?? '');
      this.#options.marker('XI_WORKBENCH_CONTROL', { id: control?.id, action: control?.action, activated });
      return activated;
    }
    return event.phase === 'up' || event.phase === 'move';
  }

  handlePanelPointer(event: PointerPanelEvent): boolean {
    this.#options.marker('XI_PANEL_POINTER', { panel: event.panel, action: event.action, itemId: event.itemId, generation: event.generation, row: event.row, column: event.column });
    if (event.action === 'context') return this.openPanelContextMenu(event);
    if (event.panel === 'explorer') return this.#options.explorer.handlePointerActivate(event.itemId, event.generation);
    if (event.panel === 'picker') {
      const model = this.#options.pickerModel.model;
      if (model.generation !== event.generation) return true;
      const entry = model.entries.find((candidate) => candidate.id === event.itemId);
      if (entry === undefined || !this.#options.pickerModel.select(entry.id)) return true;
      void this.#options.picker.activateEntry(entry.id);
      return true;
    }
    if (event.panel === 'search') {
      const model = this.#options.search.readModel();
      if (model === undefined || model.generation !== event.generation) return true;
      const index = model.matches.findIndex((match) => match.id === event.itemId);
      const match = model.matches[index];
      if (index < 0 || match === undefined) return true;
      this.#options.search.setSelectedIndex(index);
      void this.#options.search.openMatch(match);
      return true;
    }
    const model = this.#options.problems.model;
    if (model.generation !== event.generation) return true;
    const index = model.all.findIndex((problem) => problem.id === event.itemId);
    const problem = model.all[index];
    if (index < 0 || problem === undefined) return true;
    this.#options.problems.setSelectedProblemIndex(index);
    void this.#options.problems.openProblem(problem);
    return true;
  }

  /** Right-click equivalent of `handlePanelPointer`'s activate branch, per panel, as a menu. */
  openPanelContextMenu(event: PointerPanelEvent): boolean {
    if (event.panel === 'explorer') {
      const target = this.#options.explorer.selectForContextMenu(event.itemId, event.generation);
      if (target === undefined) return true;
      this.#options.contextMenu.openAt(event.screenX, event.screenY, [
        { id: 'open', label: 'Open', enabled: !target.isContainer },
        { id: 'toggle', label: target.expanded ? 'Collapse' : 'Expand', enabled: target.isContainer },
      ], (id) => {
        this.#options.explorer.activateContextMenuAction(target.nodeId, id === 'open' ? 'open' : 'toggle');
      });
      return true;
    }
    if (event.panel === 'picker') {
      const model = this.#options.pickerModel.model;
      if (model.generation !== event.generation) return true;
      const entry = model.entries.find((candidate) => candidate.id === event.itemId);
      if (entry === undefined) return true;
      this.#options.contextMenu.openAt(event.screenX, event.screenY, [{ id: 'open', label: 'Open', enabled: true }], () => {
        if (this.#options.pickerModel.select(entry.id)) void this.#options.picker.activateEntry(entry.id);
      });
      return true;
    }
    if (event.panel === 'search') {
      const model = this.#options.search.readModel();
      if (model === undefined || model.generation !== event.generation) return true;
      const match = model.matches.find((candidate) => candidate.id === event.itemId);
      if (match === undefined) return true;
      this.#options.contextMenu.openAt(event.screenX, event.screenY, [{ id: 'open', label: 'Open match', enabled: true }], () => {
        void this.#options.search.openMatch(match);
      });
      return true;
    }
    const model = this.#options.problems.model;
    if (model.generation !== event.generation) return true;
    const problem = model.all.find((candidate) => candidate.id === event.itemId);
    if (problem === undefined) return true;
    this.#options.contextMenu.openAt(event.screenX, event.screenY, [{ id: 'open', label: 'Open problem', enabled: true }], () => {
      void this.#options.problems.openProblem(problem);
    });
    return true;
  }

  cancelSplitterDrag(): void {
    const capture = this.#activeSplitter;
    if (capture === undefined) return;
    const initial = this.#splitterDrag.cancel();
    this.#activeSplitter = undefined;
    if (initial !== undefined) {
      this.#options.session.resizeSplit(capture.nodeId, initial.firstSize / capture.availableCells, capture.availableCells);
      this.#options.marker('XI_WORKBENCH_SPLITTER', { action: 'cancel', nodeId: capture.nodeId, firstSize: initial.firstSize, secondSize: initial.secondSize });
    }
  }

  handlePointerCancel(reason: 'resize' | 'dispose' | 'escape' | 'suspend'): void {
    if (reason === 'resize') this.#options.pointerCapture.cancel('resize');
    else if (reason === 'dispose') this.#options.pointerCapture.dispose();
    else if (reason === 'suspend') this.#options.pointerCapture.cancel('focus-loss');
    else this.#options.pointerCapture.cancel('escape');
    this.cancelSplitterDrag();
    this.#options.marker('XI_POINTER_CANCEL', { reason });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#controlRegistry.dispose();
    this.#splitterDrag.dispose();
  }
}
