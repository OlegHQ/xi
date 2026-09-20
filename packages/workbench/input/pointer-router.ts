import type { ClockPort, Disposable } from '../../contracts/src/index';
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
  readonly viewId?: string;
  /** `'tab-close'` is the per-tab close glyph; kept distinct from `'tab'` (the tab body,
   * which activates/pins) so both can share the same `id` (the buffer id). */
  readonly kind: 'tree' | 'tab' | 'tab-close' | 'picker' | 'button' | 'splitter';
  readonly action: 'activate' | 'begin' | 'move' | 'commit';
  readonly firstSize?: number;
  readonly secondSize?: number;
  readonly availableCells?: number;
}

/** Narrow port onto `packages/workbench/sidebar`'s `SidebarController` resize methods;
 * `WorkbenchPointerRouter` cannot import `packages/workbench/sidebar` types by value here
 * without creating a cycle risk, so this mirrors its begin/move/commit shape structurally. */
export interface PointerSidebarPort {
  beginResize(): void;
  moveResize(width: number): void;
  commitResize(): void;
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
  /** Single/double/triple click, derived by `WorkbenchPointerRouter` on `phase: 'down'` from
   * same-cell clicks within ~400ms (docs/architecture.md); `undefined` for other
   * phases. Capped at 3 (a click beyond triple still counts as triple). */
  readonly clickCount?: number;
}

/** Mirrors `packages/ui`'s `WorkbenchPanelPointerEvent`. */
export interface PointerPanelEvent {
  readonly panel: 'explorer' | 'picker' | 'search' | 'problems' | 'git' | 'git-diff';
  readonly action: 'activate' | 'context' | 'preview';
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
  previewSelected?(): void;
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
  /** Opens the currently selected match as a preview buffer without closing the panel. */
  previewSelected(): void;
  /** Clicked the query field (row 0): focuses insert mode. */
  focusQuery(): void;
  /** Clicked the replace field (row 1): focuses replace mode. */
  focusReplace(): void;
  /** Clicked a `file:<path>` group heading: toggles that file's collapsed state. */
  toggleCollapsed(path: string): void;
}

/** Narrow pointer port onto `packages/workbench/git`'s `GitPanelController`: a click on a
 * `git-section:<id>` header toggles that section's collapse, a click on a row selects it
 * and opens its diff -- mirrors `packages/workbench/explorer`'s click-opens behavior. */
export interface PointerGitPort {
  onPointerActivate(itemId: string): void;
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
  readonly git?: PointerGitPort;
  readonly problems: PointerProblemsPort;
  readonly splitterMinimumCells?: number;
  /** Wake declarative chrome after a split geometry mutation, including cancellation. */
  readonly onLayoutChange?: () => void;
  /** Drives click-count derivation (`clickCount`, tab single/double-click). */
  readonly clock: ClockPort;
  /** A `tab.<bufferId>` control (see `PointerControlEvent.kind: 'tab'`) was clicked once. */
  readonly onTabActivate?: (bufferId: string, viewId?: string) => void;
  /** The same control was double-clicked -- pins the tab (promotes it out of preview). */
  readonly onTabPin?: (bufferId: string) => void;
  /** The tab's close glyph (`kind: 'tab-close'`) was clicked. */
  readonly onTabClose?: (bufferId: string, viewId?: string) => void;
  /** A button went down on editor text/gutter: keyboard focus returns to the editor, so any
   * focused panel (Files tree, Search) must release it. */
  readonly onEditorPointerDown?: () => void;
  /** Drives the sidebar's own resize splitter (`splitter:sidebar`), separate from the editor
   * pane splitters which resize through `session.resizeSplit`. */
  readonly sidebar?: PointerSidebarPort;
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
  #pressedTab: { readonly id: string; readonly close: boolean; readonly row: number; readonly column: number } | undefined;
  #activeSplitter: { readonly nodeId: string; readonly availableCells: number } | undefined;
  #lastClick: { readonly kind: string; readonly row: number; readonly column: number; readonly time: number; readonly count: number } | undefined;
  #disposed = false;

  constructor(options: WorkbenchPointerRouterOptions) {
    this.#options = options;
    this.#splitterDrag = new SplitterDragController(options.splitterMinimumCells ?? 12);
  }

  get controls(): WorkbenchControlRegistry { return this.#controlRegistry; }

  publishControls(controls: readonly WorkbenchControl[]): void {
    this.#controlRegistry.publish(controls);
  }

  /** Single/double/triple click within ~400ms of the same cell; capped at 3. Independent
   * per `kind` (a tab click does not chain with a text click in the same cell coordinates). */
  #clickCount(kind: string, row: number, column: number): number {
    const time = this.#options.clock.monotonicMilliseconds();
    const previous = this.#lastClick;
    const count = previous !== undefined && previous.kind === kind && previous.row === row && previous.column === column && time - previous.time <= 400
      ? Math.min(3, previous.count + 1)
      : 1;
    this.#lastClick = { kind, row, column, time, count };
    return count;
  }

  /** Top-level `onPointer` decision: control events go to `handleControl`, everything else
   * is a text/gutter gesture forwarded to the Vim-side pointer capture engine. */
  handlePointer(event: PointerWorkbenchEvent): boolean {
    if (event.control !== undefined) return this.handleControl(event);
    if (event.phase === 'down') this.#options.onEditorPointerDown?.();
    const clickCount = event.phase === 'down' ? this.#clickCount('text', event.cell.row, event.cell.column) : undefined;
    return this.#options.pointerCapture.dispatch({
      ...event,
      cell: { ...event.cell, ...(event.target === undefined ? {} : { target: event.target }) },
      ...(clickCount === undefined ? {} : { clickCount }),
    } as PointerEvent);
  }

  handleControl(event: PointerWorkbenchEvent): boolean {
    const control = event.control;
    if (control?.kind === 'tab') {
      if (event.phase === 'down' && event.button === 0) {
        this.#pressedTab = { id: control.id, close: false, row: event.cell.row, column: event.cell.column };
        return true;
      }
      if (event.phase === 'up' && this.#pressedTab?.id === control.id && this.#pressedTab.close === false) {
        const pressed = this.#pressedTab;
        this.#pressedTab = undefined;
        const count = this.#clickCount('tab', pressed.row, pressed.column);
        this.#options.onTabActivate?.(control.id, control.viewId);
        if (count >= 2) this.#options.onTabPin?.(control.id);
        this.#options.marker('XI_TAB_POINTER', { id: control.id, clickCount: count });
      }
      return event.phase === 'up' || event.phase === 'move';
    }
    if (control?.kind === 'tab-close') {
      if (event.phase === 'down' && event.button === 0) {
        this.#pressedTab = { id: control.id, close: true, row: event.cell.row, column: event.cell.column };
        return true;
      }
      if (event.phase === 'up' && this.#pressedTab?.id === control.id && this.#pressedTab.close === true) {
        this.#pressedTab = undefined;
        this.#options.onTabClose?.(control.id, control.viewId);
        this.#options.marker('XI_TAB_CLOSE_POINTER', { id: control.id });
      }
      return event.phase === 'up' || event.phase === 'move';
    }
    if (control?.kind === 'splitter') {
      this.#pressedTab = undefined;
      const nodeId = control.id.startsWith('splitter:') ? control.id.slice('splitter:'.length) : '';
      const isSidebar = nodeId === 'sidebar';
      if (nodeId.length === 0 || control.firstSize === undefined || control.secondSize === undefined || control.availableCells === undefined) return true;
      if (control.action === 'begin' && event.button === 0) {
        if (this.#splitterDrag.begin({ firstSize: control.firstSize, secondSize: control.secondSize })) {
          this.#activeSplitter = { nodeId, availableCells: control.availableCells };
          if (isSidebar) this.#options.sidebar?.beginResize();
          this.#options.marker('XI_WORKBENCH_SPLITTER', { action: 'begin', nodeId, firstSize: control.firstSize, secondSize: control.secondSize });
        }
        return true;
      }
      if (this.#activeSplitter?.nodeId !== nodeId || this.#activeSplitter.availableCells !== control.availableCells) return true;
      if (control.action === 'move') {
        if (this.#splitterDrag.move(control.firstSize, control.secondSize)) {
          if (isSidebar) {
            this.#options.sidebar?.moveResize(control.firstSize);
            this.#options.marker('XI_WORKBENCH_SPLITTER', { action: 'move', nodeId, firstSize: control.firstSize, secondSize: control.secondSize, resized: true });
          } else {
            const resized = this.#options.session.resizeSplit(nodeId, control.firstSize / control.availableCells, control.availableCells);
            if (!resized.ok) this.#splitterDrag.cancel();
            else this.#options.onLayoutChange?.();
            this.#options.marker('XI_WORKBENCH_SPLITTER', { action: 'move', nodeId, firstSize: control.firstSize, secondSize: control.secondSize, resized: resized.ok });
          }
        }
        return true;
      }
      if (control.action === 'commit') {
        const committed = this.#splitterDrag.commit();
        this.#activeSplitter = undefined;
        if (isSidebar && committed !== undefined) this.#options.sidebar?.commitResize();
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
      if (event.action === 'preview') {
        this.#options.picker.previewSelected?.();
        return true;
      }
      void this.#options.picker.activateEntry(entry.id);
      return true;
    }
    if (event.panel === 'search') {
      if (event.itemId === 'query') { this.#options.search.focusQuery(); return true; }
      if (event.itemId === 'replace') { this.#options.search.focusReplace(); return true; }
      if (event.itemId.startsWith('file:')) { this.#options.search.toggleCollapsed(event.itemId.slice('file:'.length)); return true; }
      const model = this.#options.search.readModel();
      if (model === undefined || model.generation !== event.generation) return true;
      const index = model.matches.findIndex((match) => match.id === event.itemId);
      const match = model.matches[index];
      if (index < 0 || match === undefined) return true;
      // A single click selects and previews (VS Code Search-view style) rather than opening
      // and immediately closing the panel; the panel's own context menu offers "Open match".
      this.#options.search.setSelectedIndex(index);
      this.#options.search.previewSelected();
      return true;
    }
    if (event.panel === 'git') {
      this.#options.git?.onPointerActivate(event.itemId);
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
    if (event.panel === 'git') return true;
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
      if (capture.nodeId === 'sidebar') this.#options.sidebar?.moveResize(initial.firstSize);
      else if (this.#options.session.resizeSplit(capture.nodeId, initial.firstSize / capture.availableCells, capture.availableCells).ok) this.#options.onLayoutChange?.();
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
