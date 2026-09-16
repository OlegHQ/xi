import type { Disposable } from '../../contracts/src/index';
import { PointerGestureController, type PointerEnginePort, type PointerEvent } from '../../vim/src/entrypoints/launch';

export class WorkbenchPointerCapture implements Disposable {
  readonly #pointer: PointerGestureController;
  constructor(engine: PointerEnginePort) { this.#pointer = new PointerGestureController(engine); }
  get capturedViewId(): string | undefined { return this.#pointer.capturedViewId; }
  dispatch(event: PointerEvent): boolean { return this.#pointer.handle(event); }
  cancel(reason: 'focus-loss' | 'resize' | 'escape' = 'escape'): void { this.#pointer.cancel(reason); }
  dispose(): void { this.#pointer.dispose(); }
}
