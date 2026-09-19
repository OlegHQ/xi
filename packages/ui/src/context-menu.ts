import type { KeyEvent } from '@opentui/core/renderer';
import type { Disposable } from '../../contracts/src/index';
export interface ContextMenuItem { readonly id: string; readonly label: string; readonly enabled: boolean; }
export interface ContextMenuState { readonly items: readonly ContextMenuItem[]; readonly selectedIndex: number; readonly left: number; readonly top: number; }
export class ContextMenuStore {
  #state: ContextMenuState | undefined; #listeners = new Set<() => void>(); #onActivate: ((id: string) => void) | undefined;
  get state(): ContextMenuState | undefined { return this.#state; } get open(): boolean { return this.#state !== undefined; }
  subscribe(listener: () => void): Disposable { this.#listeners.add(listener); return { dispose: () => { this.#listeners.delete(listener); } }; }
  openAt(left: number, top: number, items: readonly ContextMenuItem[], onActivate: (id: string) => void): void { this.#state = Object.freeze({ items: Object.freeze([...items]), selectedIndex: items.findIndex(item => item.enabled), left, top }); this.#onActivate = onActivate; this.notify(); }
  dismiss(): void { if (this.#state === undefined) return; this.#state = undefined; this.#onActivate = undefined; this.notify(); }
  move(delta: number): void { const state = this.#state; if (state === undefined || state.items.length === 0) return; let index = state.selectedIndex; for (let step = 0; step < state.items.length; step += 1) { index = (index + delta + state.items.length) % state.items.length; if (state.items[index]?.enabled === true) break; } this.#state = Object.freeze({ ...state, selectedIndex: index }); this.notify(); }
  activateSelected(): boolean { const item = this.#state?.items[this.#state.selectedIndex]; if (item === undefined || !item.enabled) return false; const onActivate = this.#onActivate; this.dismiss(); onActivate?.(item.id); return true; }
  activate(id: string): boolean { const item = this.#state?.items.find(candidate => candidate.id === id); if (item === undefined || !item.enabled) return false; const onActivate = this.#onActivate; this.dismiss(); onActivate?.(id); return true; }
  handleKey(event: KeyEvent): boolean { if (this.#state === undefined) return false; const key = event.name.toLowerCase(); if (key === 'escape' || event.raw === '\u001b') this.dismiss(); else if (key === 'up' || key === 'k') this.move(-1); else if (key === 'down' || key === 'j') this.move(1); else if (key === 'enter' || key === 'return' || event.raw === '\r' || event.raw === '\n') this.activateSelected(); return true; }
  dispose(): void { this.#state = undefined; this.#onActivate = undefined; this.#listeners.clear(); }
  private notify(): void { for (const listener of [...this.#listeners]) listener(); }
}
export interface ContextMenuTheme { readonly background: string; readonly foreground: string; readonly muted: string; readonly selectedBackground: string; }
export const DEFAULT_CONTEXT_MENU_THEME: ContextMenuTheme = Object.freeze({ background: '#24292E', foreground: '#FAF9F6', muted: '#8A9099', selectedBackground: '#36415B' });
export function formatContextMenuLines(state: ContextMenuState | undefined, width: number): readonly string[] { if (state === undefined) return Object.freeze([]); return Object.freeze(state.items.map((item, index) => `${index === state.selectedIndex ? '› ' : '  '}${item.label}`.slice(0, Math.max(1, width)))); }
export function contextMenuBounds(items: readonly ContextMenuItem[], requestedLeft: number, requestedTop: number, terminalWidth: number, terminalHeight: number): { readonly width: number; readonly height: number; readonly left: number; readonly top: number } { const width = Math.max(8, Math.min(40, Math.max(...items.map(item => item.label.length + 2), 8))); const height = Math.max(1, Math.min(items.length, terminalHeight)); return { width, height, left: Math.max(0, Math.min(requestedLeft, Math.max(0, terminalWidth - width))), top: Math.max(0, Math.min(requestedTop, Math.max(0, terminalHeight - height))) }; }
