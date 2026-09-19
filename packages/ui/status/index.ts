import type { Disposable } from '../../contracts/src/index';

/** Read-only status surface contract; presentation is owned by the Solid adapter. */
export interface StatusMessageReadModel { readonly text: string; readonly kind: 'info' | 'error'; }
export interface StatusMessageReadPort {
  readonly model: StatusMessageReadModel | undefined;
  subscribe(listener: (model: StatusMessageReadModel | undefined) => void): Disposable;
}
