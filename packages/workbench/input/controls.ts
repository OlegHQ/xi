import type { Disposable } from '../../contracts/src/index';

export interface WorkbenchControl { readonly id: string; readonly kind: 'tree' | 'tab' | 'picker' | 'button' | 'splitter'; readonly enabled: boolean; readonly activate: () => void; }
export interface SplitGeometry { readonly firstSize: number; readonly secondSize: number; }
export class WorkbenchControlRegistry implements Disposable {
  #controls = new Map<string, WorkbenchControl>(); #disposed = false;
  publish(controls: readonly WorkbenchControl[]): void { if (this.#disposed) return; this.#controls = new Map(controls.map((control) => [control.id, Object.freeze({ ...control })])); }
  get(id: string): WorkbenchControl | undefined { return this.#controls.get(id); }
  activate(id: string): boolean { const control = this.#controls.get(id); if (control === undefined || !control.enabled) return false; control.activate(); return true; }
  dispose(): void { this.#disposed = true; this.#controls.clear(); }
}
export class SplitterDragController implements Disposable {
  #initial: SplitGeometry | undefined; #current: SplitGeometry | undefined; #minimum: number; #disposed = false;
  constructor(minimum = 12) { this.#minimum = Math.max(1, Math.trunc(minimum)); }
  begin(geometry: SplitGeometry): boolean { if (this.#disposed || geometry.firstSize < this.#minimum || geometry.secondSize < this.#minimum) return false; this.#initial = geometry; this.#current = geometry; return true; }
  move(firstSize: number, secondSize: number): boolean { if (this.#initial === undefined || firstSize < this.#minimum || secondSize < this.#minimum) return false; this.#current = Object.freeze({ firstSize, secondSize }); return true; }
  commit(): SplitGeometry | undefined { const value = this.#current; this.#initial = undefined; this.#current = undefined; return value; }
  cancel(): SplitGeometry | undefined { const value = this.#initial; this.#initial = undefined; this.#current = undefined; return value; }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.#initial = undefined; this.#current = undefined; }
}
export interface TerminalModePort { enterMouse(): void; leaveMouse(): void; restoreCursor(): void; }
export class TerminalRestoration implements Disposable {
  readonly #terminal: TerminalModePort; #active = false; #disposed = false;
  constructor(terminal: TerminalModePort) { this.#terminal = terminal; }
  start(): void { if (this.#disposed || this.#active) return; this.#active = true; this.#terminal.enterMouse(); }
  restore(): void { if (!this.#active) return; this.#active = false; this.#terminal.leaveMouse(); this.#terminal.restoreCursor(); }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.restore(); }
}
