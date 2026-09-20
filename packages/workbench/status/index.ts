import type { ClockPort, Disposable } from '../../contracts/src/index';

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
 * underneath the renderer's alt-screen buffer. Messages expire so a one-time warning cannot
 * permanently replace the normal status line. */
export class StatusMessageController implements StatusMessageReadPort {
  #model: StatusMessageModel | undefined;
  #expiry: Disposable | undefined;
  readonly #clock: Pick<ClockPort, 'schedule'>;
  readonly #listeners = new Set<(model: StatusMessageModel | undefined) => void>();

  constructor(clock: Pick<ClockPort, 'schedule'>) { this.#clock = clock; }

  get model(): StatusMessageModel | undefined {
    return this.#model;
  }

  publish(text: string, kind: StatusMessageModel['kind'] = 'error'): void {
    this.#expiry?.dispose();
    this.#model = { text, kind };
    this.#expiry = this.#clock.schedule(kind === 'info' ? 5_000 : 8_000, () => this.clear());
    this.#notify();
  }

  clear(): void {
    this.#expiry?.dispose();
    this.#expiry = undefined;
    if (this.#model === undefined) return;
    this.#model = undefined;
    this.#notify();
  }

  subscribe(listener: (model: StatusMessageModel | undefined) => void): Disposable {
    this.#listeners.add(listener);
    return { dispose: () => { this.#listeners.delete(listener); } };
  }

  dispose(): void {
    this.clear();
    this.#listeners.clear();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener(this.#model);
  }
}
