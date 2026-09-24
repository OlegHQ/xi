export type SidebarSectionId = 'files' | 'outline';
/** The sidebar's top tab bar: which panel occupies the column below it. */
export type SidebarPanelId = 'files' | 'search' | 'git';

export interface SidebarSection {
  readonly id: SidebarSectionId;
  readonly label: string;
  readonly expanded: boolean;
}

/** Read model the UI layout call renders; see also `sidebarWidth` passed alongside it. */
export interface SidebarReadModel {
  readonly sections: readonly SidebarSection[];
  readonly activeSection: SidebarSectionId;
  /** Derived from the open panels (search open -> 'search', git picker -> 'git', else 'files'). */
  readonly panel: SidebarPanelId;
  readonly width: number;
  readonly visible?: boolean;
  /** Outline content rows chosen by dragging its header; undefined keeps the default split. */
  readonly outlineHeight?: number;
}

/** Persist only committed widths, never transient drag positions. */
export interface SidebarWidthPersistencePort {
  readonly width: number | undefined;
  setWidth(width: number): void;
}

export interface SidebarControllerOptions {
  readonly persistence?: SidebarWidthPersistencePort;
  readonly initialWidth?: number;
  readonly initiallyVisible?: boolean;
  readonly initialPanel?: SidebarPanelId;
  readonly onPanelChange?: (panel: SidebarPanelId) => void;
  readonly onVisibilityChange?: (visible: boolean) => void;
  /** Which top tab is active; defaults to 'files' when absent. */
  readonly panelState?: () => SidebarPanelId;
  /** Clamped 22-40 cells (docs/architecture.md:11). */
  readonly minimumWidth?: number;
  readonly maximumWidth?: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Owns the sidebar's section (Files/Outline) expand state and its resizable width: Files
 * starts collapsed (its tree loads lazily, so an expanded-but-empty header would lie) and
 * expands when the Explorer opens; Outline starts collapsed and only the user expands it
 * (its symbols load while it is visible, so it cannot drive its own expansion). Resize mirrors `packages/workbench/input/controls`' `SplitterDragController`
 * begin/move/commit shape.
 */
export class SidebarController {
  readonly #options: SidebarControllerOptions;
  readonly #minimumWidth: number;
  readonly #maximumWidth: number;
  #activeSection: SidebarSectionId = 'files';
  #filesExpanded = false;
  #outlineExpanded = false;
  #outlineHeight: number | undefined;
  #width: number;
  #resizing = false;
  #visible = true;
  #lastPanel: SidebarPanelId = 'files';
  // readModel() is called many times per keystroke (layout, sidebar paint, ...); memoize by a
  // cheap key of the fields it reads so unchanged state returns the same frozen object instead
  // of allocating four new ones every call.
  #cachedModel: SidebarReadModel | undefined;
  #cachedModelKey = '';
  #disposed = false;

  constructor(options: SidebarControllerOptions) {
    this.#options = options;
    this.#visible = options.initiallyVisible ?? true;
    this.#lastPanel = options.initialPanel ?? 'files';
    // A restored Files panel paints expanded on the first frame; the Explorer fills it after.
    this.#filesExpanded = this.#visible && this.#lastPanel === 'files';
    this.#minimumWidth = options.minimumWidth ?? 22;
    this.#maximumWidth = options.maximumWidth ?? 40;
    const initial = options.persistence?.width ?? options.initialWidth ?? 28;
    this.#width = clamp(initial, this.#minimumWidth, this.#maximumWidth);
  }

  get activeSection(): SidebarSectionId { return this.#activeSection; }
  get width(): number { return this.#width; }
  get visible(): boolean { return this.#visible; }
  get lastPanel(): SidebarPanelId { return this.#lastPanel; }
  setPanel(panel: SidebarPanelId): void {
    if (panel === this.#lastPanel) return;
    this.#lastPanel = panel;
    this.#options.onPanelChange?.(panel);
  }
  setVisible(visible: boolean): void {
    if (visible === this.#visible) return;
    if (!visible && this.#visible) this.setPanel(this.#options.panelState?.() ?? this.#lastPanel);
    this.#visible = visible;
    this.#options.onVisibilityChange?.(visible);
  }

  setActiveSection(id: SidebarSectionId): void {
    this.#activeSection = id;
  }

  collapseSection(id: SidebarSectionId): void {
    if (id === 'files') this.#filesExpanded = false;
    else this.#outlineExpanded = false;
  }

  expandSection(id: SidebarSectionId): void {
    if (id === 'files') this.#filesExpanded = true;
    else this.#outlineExpanded = true;
  }

  toggleSection(id: SidebarSectionId): void {
    if (id === 'files') this.#filesExpanded = !this.#filesExpanded;
    else this.#outlineExpanded = !this.#outlineExpanded;
  }

  /** True when the Outline section's rows are on screen (sidebar shown on the Files tab). */
  get outlineVisible(): boolean {
    return this.#visible && this.#outlineExpanded && (this.#options.panelState?.() ?? 'files') === 'files';
  }

  beginResize(): void {
    this.#resizing = true;
  }

  moveResize(width: number): void {
    if (!this.#resizing) return;
    this.#width = clamp(width, this.#minimumWidth, this.#maximumWidth);
  }

  commitResize(): void {
    if (!this.#resizing) return;
    this.#resizing = false;
    this.#options.persistence?.setWidth(this.#width);
  }

  /** Outline height drag (the layout clamps it to the rows that exist). */
  resizeOutline(height: number): void {
    this.#outlineHeight = Math.max(3, Math.trunc(height));
  }

  readModel(): SidebarReadModel {
    const panel = this.#visible ? this.#options.panelState?.() ?? 'files' : this.#lastPanel;
    const key = `${this.#visible}|${this.#filesExpanded}|${this.#outlineExpanded}|${this.#activeSection}|${this.#width}|${panel}|${this.#outlineHeight}`;
    if (this.#cachedModel !== undefined && this.#cachedModelKey === key) return this.#cachedModel;
    const model = Object.freeze({
      sections: Object.freeze([
        Object.freeze({ id: 'files' as const, label: 'Files', expanded: this.#filesExpanded }),
        Object.freeze({ id: 'outline' as const, label: 'Outline', expanded: this.#outlineExpanded }),
      ]),
      activeSection: this.#activeSection,
      panel,
      width: this.#width,
      visible: this.#visible,
      ...(this.#outlineHeight === undefined ? {} : { outlineHeight: this.#outlineHeight }),
    });
    this.#cachedModel = model;
    this.#cachedModelKey = key;
    return model;
  }

  /** H2-5 follow-up: `SidebarController` owns no subscription or timer today, but every other
   * workbench controller `apps/xi/src/main.ts` tears down exposes `dispose()`, so callers can
   * treat the teardown list uniformly instead of special-casing this one. Idempotent, and
   * drops the memoized read model so a disposed-but-still-referenced controller cannot hand
   * out stale state. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cachedModel = undefined;
  }
}
