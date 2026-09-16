import type { PlatformAdapterFactory } from '../../../packages/platform/src/index';
import type { PlatformFailure, PlatformPorts, ServiceFactoryContext } from '../../../packages/contracts/src/index';
import { DisposableScope, type Disposable } from '../../../packages/primitives/src/index';
import type { WorkbenchReadPort } from '../../../packages/workbench/src/index';
import type { TerminalAdapter, UiComposition } from '../../../packages/ui/src/index';

export interface ApplicationDependencies<Services, Workbench extends WorkbenchReadPort> {
  readonly requestId: ServiceFactoryContext['requestId'];
  readonly platform: PlatformAdapterFactory;
  readonly createServices: (context: ServiceFactoryContext) => Promise<Services>;
  readonly createWorkbench: (context: ServiceFactoryContext & { readonly services: Services }) => Promise<Workbench>;
  readonly ui?: UiComposition;
}

export interface RunningApplication<Services, Workbench extends WorkbenchReadPort> extends Disposable {
  readonly ports: PlatformPorts;
  readonly services: Services;
  readonly workbench: Workbench;
}

export class ApplicationStartupError extends Error {
  constructor(
    readonly startupError: unknown,
    readonly cleanupErrors: readonly unknown[],
  ) {
    super('application-startup-failed', { cause: startupError });
    this.name = 'ApplicationStartupError';
  }
}

/**
 * The composition root accepts every effectful adapter by injection. With no UI
 * composition, this function creates a headless core and imports no terminal API.
 * Factories register each acquired disposable in the supplied child scope before
 * awaiting another fallible operation.
 */
export async function createApplication<Services, Workbench extends WorkbenchReadPort>(
  dependencies: ApplicationDependencies<Services, Workbench>,
): Promise<RunningApplication<Services, Workbench>> {
  const applicationScope = new DisposableScope();
  try {
    const platformScope = applicationScope.child();
    const ports = await dependencies.platform.create(platformScope);

    const serviceScope = applicationScope.child();
    const serviceContext: ServiceFactoryContext = {
      ports,
      scope: serviceScope,
      requestId: dependencies.requestId,
    };
    const services = await dependencies.createServices(serviceContext);

    const workbenchScope = applicationScope.child();
    const workbench = await dependencies.createWorkbench({
      ...serviceContext,
      scope: workbenchScope,
      services,
    });

    if (dependencies.ui !== undefined) {
      const uiScope = applicationScope.child();
      const terminal: TerminalAdapter = await dependencies.ui.terminal.create(uiScope);
      uiScope.add({ dispose: () => disposeTerminal(terminal) });
      const started = await terminal.start();
      if (!started.ok) throw new TerminalStartupError(started.error);
      const mounted = await dependencies.ui.mount({ workbench, terminal, scope: uiScope });
      uiScope.add(mounted);
    }

    return {
      ports,
      services,
      workbench,
      dispose: () => applicationScope.dispose(),
    };
  } catch (startupError: unknown) {
    try {
      await applicationScope.dispose();
    } catch (cleanupError: unknown) {
      const cleanupErrors = cleanupError instanceof AggregateError
        ? cleanupError.errors
        : [cleanupError];
      throw new ApplicationStartupError(startupError, cleanupErrors);
    }
    throw startupError;
  }
}

async function disposeTerminal(terminal: TerminalAdapter): Promise<void> {
  const failures: unknown[] = [];
  try {
    await terminal.restore();
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    await terminal.dispose();
  } catch (error: unknown) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'terminal-cleanup-failed');
}

export class TerminalStartupError extends Error {
  constructor(readonly failure: PlatformFailure) {
    super('terminal-adapter-start-failed');
    this.name = 'TerminalStartupError';
  }
}
