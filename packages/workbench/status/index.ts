import type { Disposable } from '../../contracts/src/index';

export interface StatusMessageModel {
  readonly text: string;
  readonly kind: 'info' | 'error';
}

export interface StatusMessageReadPort {
  readonly model: StatusMessageModel | undefined;
  subscribe(listener: (model: StatusMessageModel | undefined) => void): Disposable;
}

/** Owns the single most-recent status/error message every feature controller reports through
 * `onError`/`onMessage` (docs/plan/01-architecture.md: platform effects pass through typed
 * ports, never raw process I/O). Replaces `process.stderr.write` at those call sites so a
 * live-session failure renders in the OpenTUI-owned status row instead of writing bytes
 * underneath the renderer's alt-screen buffer. `clear()` is wired to command-line activation so
 * a stale message never sits behind a `:`/`/` prompt. */
export class StatusMessageController implements StatusMessageReadPort {
  #model: StatusMessageModel | undefined;
  readonly #listeners = new Set<(model: StatusMessageModel | undefined) => void>();

  get model(): StatusMessageModel | undefined {
    return this.#model;
  }

  publish(text: string, kind: StatusMessageModel['kind'] = 'error'): void {
    this.#model = { text, kind };
    this.#notify();
  }

  clear(): void {
    if (this.#model === undefined) return;
    this.#model = undefined;
    this.#notify();
  }

  subscribe(listener: (model: StatusMessageModel | undefined) => void): Disposable {
    this.#listeners.add(listener);
    return { dispose: () => { this.#listeners.delete(listener); } };
  }

  #notify(): void {
    for (const listener of this.#listeners) listener(this.#model);
  }
}
