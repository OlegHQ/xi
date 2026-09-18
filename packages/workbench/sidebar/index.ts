export type SidebarSectionId = 'files' | 'outline';

export interface SidebarSection {
  readonly id: SidebarSectionId;
  readonly label: string;
  readonly expanded: boolean;
}

/** Read model the UI layout call renders; see also `sidebarWidth` passed alongside it. */
export interface SidebarReadModel {
  readonly sections: readonly SidebarSection[];
  readonly activeSection: SidebarSectionId;
  readonly width: number;
}

/** Narrow port onto whatever tracks outline symbols (the language overlay feature); only
 * whether there is anything to show is needed here. */
export interface SidebarOutlineModelPort {
  readonly hasSymbols: boolean;
}

/** Optional narrow port for persisting the sidebar width across sessions (mirrors
 * `packages/workbench/session`'s own persisted-state fields). Left unwired by default --
 * no existing persistence slot for this was trivial to hook up, so the width is in-memory
 * only (defaults to `initialWidth`) unless a caller supplies one. */
export interface SidebarWidthPersistencePort {
  readonly width: number | undefined;
  setWidth(width: number): void;
}

export interface SidebarControllerOptions {
  readonly outline: SidebarOutlineModelPort;
  readonly persistence?: SidebarWidthPersistencePort;
  readonly initialWidth?: number;
  /** Clamped 22-40 cells (docs/plan/03-ux.md:11). */
  readonly minimumWidth?: number;
  readonly maximumWidth?: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Owns the sidebar's section (Files/Outline) expand state and its resizable width: Files
 * starts expanded; Outline auto-expands once the outline model has symbols and auto-collapses
 * once it doesn't, except that a user's own toggle sticks until the symbol presence actually
 * changes. Resize mirrors `packages/workbench/input/controls`' `SplitterDragController`
 * begin/move/commit shape.
 */
export class SidebarController {
  readonly #options: SidebarControllerOptions;
  readonly #minimumWidth: number;
  readonly #maximumWidth: number;
  #activeSection: SidebarSectionId = 'files';
  #filesExpanded = true;
  #outlineExpanded: boolean;
  #outlineUserOverride = false;
  #hadSymbols: boolean;
  #width: number;
  #resizing = false;
  // readModel() is called many times per keystroke (layout, sidebar paint, ...); memoize by a
  // cheap key of the fields it reads so unchanged state returns the same frozen object instead
  // of allocating four new ones every call.
  #cachedModel: SidebarReadModel | undefined;
  #cachedModelKey = '';
  #disposed = false;

  constructor(options: SidebarControllerOptions) {
    this.#options = options;
    this.#minimumWidth = options.minimumWidth ?? 22;
    this.#maximumWidth = options.maximumWidth ?? 40;
    const initial = options.persistence?.width ?? options.initialWidth ?? 28;
    this.#width = clamp(initial, this.#minimumWidth, this.#maximumWidth);
    this.#hadSymbols = options.outline.hasSymbols;
    this.#outlineExpanded = this.#hadSymbols;
  }

  get activeSection(): SidebarSectionId { return this.#activeSection; }
  get width(): number { return this.#width; }

  setActiveSection(id: SidebarSectionId): void {
    this.#activeSection = id;
  }

  /** User-driven expand/collapse; Outline's toggle sticks until `refreshOutline` sees the
   * symbol-presence flip. */
  toggleSection(id: SidebarSectionId): void {
    if (id === 'files') { this.#filesExpanded = !this.#filesExpanded; return; }
    this.#outlineExpanded = !this.#outlineExpanded;
    this.#outlineUserOverride = true;
  }

  /** Call after the outline model may have changed (new symbols computed, or cleared). A
   * transition between "has symbols" and "has none" always resets any user override. */
  refreshOutline(): void {
    const hasSymbols = this.#options.outline.hasSymbols;
    if (hasSymbols === this.#hadSymbols) return;
    this.#hadSymbols = hasSymbols;
    this.#outlineUserOverride = false;
    this.#outlineExpanded = hasSymbols;
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

  readModel(): SidebarReadModel {
    const key = `${this.#filesExpanded}|${this.#outlineExpanded}|${this.#activeSection}|${this.#width}`;
    if (this.#cachedModel !== undefined && this.#cachedModelKey === key) return this.#cachedModel;
    const model = Object.freeze({
      sections: Object.freeze([
        Object.freeze({ id: 'files' as const, label: 'Files', expanded: this.#filesExpanded }),
        Object.freeze({ id: 'outline' as const, label: 'Outline', expanded: this.#outlineExpanded }),
      ]),
      activeSection: this.#activeSection,
      width: this.#width,
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
