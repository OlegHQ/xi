import type { Disposable, DisposableScope, PlatformFailure, Result } from '../../contracts/src/index.ts';
import type { WorkbenchReadPort } from '../../workbench/src/index.ts';

export interface TerminalAdapter extends Disposable {
  start(): Promise<Result<void, PlatformFailure>>;
  suspend(): Promise<Result<void, PlatformFailure>>;
  resume(): Promise<Result<void, PlatformFailure>>;
  restore(): Promise<void>;
}

export interface TerminalAdapterFactory {
  create(scope: DisposableScope): Promise<TerminalAdapter>;
}

export interface UiMountContext {
  readonly workbench: WorkbenchReadPort;
  readonly terminal: TerminalAdapter;
  readonly scope: DisposableScope;
}

export interface UiComposition {
  readonly terminal: TerminalAdapterFactory;
  mount(context: UiMountContext): Promise<Disposable>;
}
