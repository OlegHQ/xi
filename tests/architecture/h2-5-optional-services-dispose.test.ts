import assert from 'node:assert/strict';

// H2-5: apps/xi/src/wiring/optional-services.ts previously never cleared its coalesced
// git-refresh `setTimeout`, never disposed the git status subscription, and never disposed
// gitStatusService/gitMutationCoordinator -- main.ts's teardown list touched every other
// optional-services-owned disposable except these. This regression test fails against the
// pre-fix `OptionalServicesWiring` (no `dispose()` method at all) and passes once `dispose()`
// clears the timer and disposes the git pieces.

const { createOptionalServicesWiring } = await import('../../apps/xi/src/wiring/optional-services');
const { NodeFilesystemPort } = await import('../../packages/platform/src/entrypoints/launch');

async function* emptyAsync(): AsyncIterable<Uint8Array> {}

/** Always reports a clean, empty `git status --porcelain=v2 -z --branch` -- never latches
 * GitStatusService's internal "not a repo" state, so a second `refresh()` after `dispose()`
 * is a meaningful check (an unconditional early-return from a latched not-a-repo flag would
 * pass even with a broken dispose()). */
class FakeGitProcessPort {
  spawn(): ReturnType<import('../../packages/contracts/src/index').ProcessPort['spawn']> {
    return Promise.resolve({
      ok: true,
      value: {
        stdin: null,
        stdout: emptyAsync(),
        stderr: emptyAsync(),
        exit: Promise.resolve({ ok: true, value: { code: 0, signal: null } }),
        terminate: async () => {},
        dispose: () => {},
      },
    });
  }
}

// Intercept the global timer functions for the duration of this test only, so the
// scheduleGitRefresh()/dispose() pair can be checked against the exact handle involved
// instead of guessing from wall-clock behavior.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let scheduledHandle: ReturnType<typeof setTimeout> | undefined;
let clearedHandle: unknown;
(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((handler: (...timerArgs: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  scheduledHandle = realSetTimeout(handler, ms, ...args);
  return scheduledHandle;
}) as typeof setTimeout;
(globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = ((handle: unknown) => {
  clearedHandle = handle;
  return realClearTimeout(handle as Parameters<typeof clearTimeout>[0]);
}) as typeof clearTimeout;

try {
  const optionalServices = createOptionalServicesWiring({
    filesystem: new NodeFilesystemPort(),
    ProcessPort: FakeGitProcessPort as unknown as typeof import('../../packages/platform/src/entrypoints/launch').NodeProcessPort,
    workspaceRoot: '/architecture-smoke-h2-5',
    fileUri: (path) => `file://${path}`,
    processEnvironment: () => ({}),
    notifySurfaceChange: () => {},
    createExplorerFilesystem: () => ({
      enumerateDirectory: async () => ({ ok: true, value: [] }),
      watchDirectory: async () => ({ ok: true, value: { dispose() {} } }),
    }),
    createGitDecorationPort: () => ({ read: async () => ({ ok: true, value: undefined }) }),
    getExplorerFeature: () => ({
      openNode: () => {},
      attachTree: () => ({ dispose() {} }),
    }),
    getSearchFeature: () => ({
      readBuffers: () => [],
      createReplacePort: () => ({
        apply: (): Promise<never> => { throw new Error('h2-5 smoke never calls the replace port'); },
        readTarget: (): Promise<never> => { throw new Error('h2-5 smoke never calls the replace port'); },
        restore: (): Promise<never> => { throw new Error('h2-5 smoke never calls the replace port'); },
      }),
      attachServices: () => {},
    }),
  });

  const resolved = await optionalServices.ensure();
  const gitStatusService: typeof resolved.gitStatusService | undefined = resolved.gitStatusService;
  assert.notEqual(gitStatusService, undefined, 'H2-5: ensure() must construct gitStatusService');
  // ensure()'s own initial `void nextGitStatus.refresh()` is fire-and-forget; give it a real
  // macrotask to settle (the fake process resolves synchronously once scheduled) before
  // asserting on the published snapshot.
  await new Promise((resolve) => realSetTimeout(resolve, 0));
  assert.notEqual(gitStatusService!.snapshot, undefined, 'H2-5: the automatic post-construction refresh() must have published a snapshot');

  optionalServices.scheduleGitRefresh();
  assert.notEqual(scheduledHandle, undefined, 'H2-5 setup: scheduleGitRefresh() must arm a real timer for this test to be meaningful');
  const armedHandle = scheduledHandle;

  assert.doesNotThrow(() => optionalServices.dispose(), 'H2-5: dispose() must not throw');
  assert.equal(clearedHandle, armedHandle, 'H2-5: dispose() must clearTimeout() the coalesced git-refresh timer');

  // gitStatusService.dispose() disposes its snapshot cache and sets an internal disposed flag
  // that makes any further refresh() an immediate no-op -- both only true once dispose()
  // actually reaches it, which is exactly what optional-services.ts's dispose() previously
  // never did.
  assert.equal(gitStatusService!.snapshot, undefined, 'H2-5: dispose() must dispose gitStatusService (its cache clears on dispose)');
  await gitStatusService!.refresh();
  assert.equal(gitStatusService!.snapshot, undefined, 'H2-5: dispose() must dispose gitStatusService so a later refresh() is inert');

  assert.doesNotThrow(() => optionalServices.dispose(), 'H2-5: dispose() must be safe to call twice');

  // H2-5 follow-up: SidebarController and ContextMenuStore previously had no dispose() at
  // all, so main.ts's teardown list could never touch them. Both must exist, clear their own
  // state and be safe to call twice.
  const { SidebarController } = await import('../../packages/workbench/sidebar/index');
  const { ContextMenuStore } = await import('../../packages/ui/src/context-menu');

  const sidebar = new SidebarController({ outline: { hasSymbols: false } });
  sidebar.readModel();
  assert.doesNotThrow(() => sidebar.dispose(), 'H2-5: SidebarController.dispose() must not throw');
  assert.doesNotThrow(() => sidebar.dispose(), 'H2-5: SidebarController.dispose() must be safe to call twice');

  const contextMenu = new ContextMenuStore();
  let notified = 0;
  const subscription = contextMenu.subscribe(() => { notified += 1; });
  contextMenu.openAt(0, 0, [{ id: 'a', label: 'A', enabled: true }], () => {});
  assert.equal(notified, 1, 'H2-5 setup: openAt() must notify subscribers for this check to be meaningful');
  assert.doesNotThrow(() => contextMenu.dispose(), 'H2-5: ContextMenuStore.dispose() must not throw');
  assert.equal(contextMenu.open, false, 'H2-5: ContextMenuStore.dispose() must dismiss any open menu');
  contextMenu.openAt(0, 0, [{ id: 'b', label: 'B', enabled: true }], () => {});
  assert.equal(notified, 1, 'H2-5: ContextMenuStore.dispose() must drop subscribers so a later notify never reaches them');
  assert.doesNotThrow(() => contextMenu.dispose(), 'H2-5: ContextMenuStore.dispose() must be safe to call twice');
  subscription.dispose();

  console.log('H2-5 optional-services/SidebarController/ContextMenuStore dispose() clear timers, subscriptions and state');
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}
