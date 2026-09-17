import { Renderable, type OptimizedBuffer, type RenderContext, type RenderableOptions, type MouseEvent, type KeyEvent, parseColor } from '@opentui/core/renderer';
import type { Disposable } from '../../contracts/src/index';

export interface ContextMenuItem {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
}

export interface ContextMenuState {
  readonly items: readonly ContextMenuItem[];
  readonly selectedIndex: number;
  readonly left: number;
  readonly top: number;
}

/** Application-owned ephemeral menu state; the renderable only displays it. */
export class ContextMenuStore {
  #state: ContextMenuState | undefined;
  #listeners = new Set<() => void>();
  #onActivate: ((id: string) => void) | undefined;

  get state(): ContextMenuState | undefined { return this.#state; }
  get open(): boolean { return this.#state !== undefined; }

  subscribe(listener: () => void): Disposable {
    this.#listeners.add(listener);
    return Object.freeze({ dispose: () => { this.#listeners.delete(listener); } });
  }

  openAt(left: number, top: number, items: readonly ContextMenuItem[], onActivate: (id: string) => void): void {
    const selectedIndex = items.findIndex((item) => item.enabled);
    this.#state = Object.freeze({ items: Object.freeze([...items]), selectedIndex, left, top });
    this.#onActivate = onActivate;
    this.#notify();
  }

  dismiss(): void {
    if (this.#state === undefined) return;
    this.#state = undefined;
    this.#onActivate = undefined;
    this.#notify();
  }

  move(delta: number): void {
    const current = this.#state;
    if (current === undefined || current.items.length === 0) return;
    const count = current.items.length;
    let next = current.selectedIndex;
    for (let step = 0; step < count; step += 1) {
      next = (next + delta + count) % count;
      if (current.items[next]?.enabled === true) break;
    }
    this.#state = Object.freeze({ ...current, selectedIndex: next });
    this.#notify();
  }

  /** Activates the selected item if enabled; a disabled item never executes. */
  activateSelected(): boolean {
    const current = this.#state;
    if (current === undefined) return false;
    const item = current.items[current.selectedIndex];
    if (item === undefined || !item.enabled) return false;
    const onActivate = this.#onActivate;
    this.dismiss();
    onActivate?.(item.id);
    return true;
  }

  /** Activates a specific item by id if enabled; used for pointer clicks on a menu row. */
  activate(id: string): boolean {
    const current = this.#state;
    if (current === undefined) return false;
    const item = current.items.find((candidate) => candidate.id === id);
    if (item === undefined || !item.enabled) return false;
    const onActivate = this.#onActivate;
    this.dismiss();
    onActivate?.(item.id);
    return true;
  }

  /**
   * Keyboard equivalent of the mouse actions above: navigable and modal while open. Returns
   * `true` for every key while open, since the menu owns input focus until dismissed/activated.
   */
  handleKey(event: KeyEvent): boolean {
    if (this.#state === undefined) return false;
    const key = event.name.toLowerCase();
    if (key === 'escape' || event.raw === '') {
      this.dismiss();
      return true;
    }
    if (key === 'up' || key === 'k') {
      this.move(-1);
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.move(1);
      return true;
    }
    if (key === 'enter' || key === 'return' || event.raw === '\r' || event.raw === '\n') {
      this.activateSelected();
      return true;
    }
    return true;
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

export interface ContextMenuTheme {
  readonly background: string;
  readonly foreground: string;
  readonly muted: string;
  readonly selectedBackground: string;
}

export const DEFAULT_CONTEXT_MENU_THEME: ContextMenuTheme = Object.freeze({
  background: '#24292E',
  foreground: '#FAF9F6',
  muted: '#8A9099',
  selectedBackground: '#36415B',
});

export interface ContextMenuRenderableOptions extends RenderableOptions<ContextMenuRenderable> {
  readonly store: ContextMenuStore;
  readonly theme?: ContextMenuTheme;
}

/** Small floating menu. All item/selection state lives in the store; this only paints it. */
export class ContextMenuRenderable extends Renderable {
  readonly #store: ContextMenuStore;
  readonly #subscription: Disposable;
  #theme: ContextMenuTheme;

  constructor(ctx: RenderContext, options: ContextMenuRenderableOptions) {
    const { store: _store, theme: _theme, ...renderOptions } = options;
    super(ctx, { ...renderOptions, width: options.width ?? 1, height: options.height ?? 1, buffered: options.buffered ?? true });
    this.#store = options.store;
    this.#theme = options.theme ?? DEFAULT_CONTEXT_MENU_THEME;
    this.onMouse = (event: MouseEvent): void => {
      if (event.type !== 'down') return;
      const row = event.y - this.screenY;
      const item = this.#store.state?.items[row];
      if (item !== undefined) this.#store.activate(item.id);
      else this.#store.dismiss();
      event.preventDefault();
      event.stopPropagation();
    };
    this.#subscription = this.#store.subscribe(() => { if (!this.isDestroyed) this.requestRender(); });
    this.requestRender();
  }

  protected override destroySelf(): void {
    this.#subscription.dispose();
    super.destroySelf();
  }

  /** Apply a new theme immediately, live. Colors are recomputed from `#theme` on every
   * `renderSelf` call (never cached), so reassigning it and requesting one frame is enough. */
  setTheme(theme: ContextMenuTheme): void {
    this.#theme = theme;
    this.requestRender();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const state = this.#store.state;
    if (state === undefined) return;
    const background = parseColor(this.#theme.background);
    const foreground = parseColor(this.#theme.foreground);
    const muted = parseColor(this.#theme.muted);
    const selectedBackground = parseColor(this.#theme.selectedBackground);
    buffer.fillRect(0, 0, this.width, this.height, background);
    for (let row = 0; row < state.items.length && row < this.height; row += 1) {
      const item = state.items[row];
      if (item === undefined) continue;
      const selected = row === state.selectedIndex;
      const rowBackground = selected ? selectedBackground : background;
      buffer.fillRect(0, row, this.width, 1, rowBackground);
      const label = ` ${item.label}`.slice(0, this.width);
      const color = !item.enabled ? muted : foreground;
      for (let index = 0; index < [...label].length; index += 1) {
        const character = [...label][index];
        if (character !== undefined) buffer.setCell(index, row, character, color, rowBackground);
      }
    }
  }
}

export interface ContextMenuBackdropOptions extends RenderableOptions<ContextMenuBackdrop> {
  readonly store: ContextMenuStore;
}

/**
 * Invisible full-screen layer mounted directly beneath the menu (lower z-index) so a click
 * anywhere else dismisses the modal menu instead of falling through to the panel or editor
 * underneath on that same click.
 */
export class ContextMenuBackdrop extends Renderable {
  readonly #store: ContextMenuStore;

  constructor(ctx: RenderContext, options: ContextMenuBackdropOptions) {
    const { store: _store, ...renderOptions } = options;
    super(ctx, { ...renderOptions, buffered: false });
    this.#store = options.store;
    this.onMouse = (event: MouseEvent): void => {
      if (event.type !== 'down') return;
      this.#store.dismiss();
      event.preventDefault();
      event.stopPropagation();
    };
  }

  protected override renderSelf(): void {
    // Intentionally blank: this layer exists only to intercept pointer input.
  }
}

/** Menu box size for a given item set, clamped to fit within the terminal. */
export function contextMenuBounds(items: readonly ContextMenuItem[], requestedLeft: number, requestedTop: number, terminalWidth: number, terminalHeight: number): { readonly width: number; readonly height: number; readonly left: number; readonly top: number } {
  const width = Math.max(8, Math.min(40, Math.max(...items.map((item) => item.label.length + 2), 8)));
  const height = Math.max(1, Math.min(items.length, terminalHeight));
  const left = Math.max(0, Math.min(requestedLeft, Math.max(0, terminalWidth - width)));
  const top = Math.max(0, Math.min(requestedTop, Math.max(0, terminalHeight - height)));
  return { width, height, left, top };
}
