import '../../../packages/ui/src/entrypoints/preload';
import { CancellationSource, type DocumentId } from '../../../packages/primitives/src/entrypoints/launch';
// Value imports of the UI entrypoint would evaluate OpenTUI before main() runs; keep the UI lazy.
import type { TextFileDocument } from '../../../packages/document/src/entrypoints/launch';
import type { PersistenceService } from '../../../packages/services/src/entrypoints/launch';
import { languageIdForPath, VIEW_COMMAND_IDS, StatusMessageController } from '../../../packages/workbench/src/entrypoints/launch';
import { loadStartupXiConfig } from '../../../packages/services/src/entrypoints/config';
import { parseCliArgs, resolveFileArgument } from './cli';
import { installCrashHandlers } from './lifecycle';
import { createThemeWiring, themeStateDirectory } from './wiring/theme';
import { createControllers, id, type Controllers } from './wiring/controllers';
import { wireControllerPanels } from './wiring/pointer';
import { buildWorkbenchUiOptions } from './wiring/ui';

const XI_VERSION = '0.0.1';

// Parsed once at the process boundary: every PTY-visible test marker below funnels
// through this instead of re-reading `process.env` per call site. `marker()` is a
// no-op when disabled, so callers may pass trivial payloads unconditionally; a
// payload built by iterating a collection should stay behind its own `if (...)`
// guard to skip that work when markers are off.
const XI_UI_TEST_MARKERS_ENABLED = process.env.XI_UI_TEST_MARKERS === '1';
const marker: (name: string, payload?: unknown) => void = XI_UI_TEST_MARKERS_ENABLED
  ? (name, payload) => process.stderr.write(payload === undefined ? `${name}\r\n` : `${name} ${JSON.stringify(payload)}\r\n`)
  : () => {};

/** Keep the composition root limited to CLI, ports, lifecycle and renderer wiring: parse CLI ->
 * construct ports -> construct services -> construct workbench controllers (one call) -> wire
 * UI (one call) -> start -> await shutdown. */
async function main(): Promise<void> {
  const startupStarted = process.hrtime.bigint();
  const startupTrace = (label: string): void => {
    if (process.env.XI_STARTUP_TRACE === '1') process.stderr.write(`XI_STARTUP_TRACE ${label} ${Number(process.hrtime.bigint() - startupStarted) / 1_000_000}\n`);
  };
  startupTrace('main');
  const action = parseCliArgs(process.argv.slice(2), XI_VERSION);
  if (action.kind !== 'launch') {
    process.stdout.write(action.text);
    return;
  }
  const filePath = action.fileArgument === undefined ? undefined : resolveFileArgument(action.fileArgument, process.cwd());
  const languageId = languageIdForPath(filePath?.path);
  // Keep CLI startup free of the optional service barrel. The small persistence
  // entrypoint, OpenTUI, Vim and the service graph can load concurrently.
  const persistenceModule = import('../../../packages/services/src/entrypoints/persistence');
  const coreServicesModule = import('../../../packages/services/src/entrypoints/launch-core');
  const platformModule = import('../../../packages/platform/src/entrypoints/launch');
  const documentModule = import('../../../packages/document/src/entrypoints/launch');
  // Loading OpenTUI can briefly occupy the event loop while its native module
  // is evaluated. For an explicit file, finish the small open first so that
  // the launch read is not serialized behind native renderer startup.
  const earlyUi = filePath?.path === undefined ? import('../../../packages/ui/src/entrypoints/launch') : undefined;
  const vimSession = import('../../../packages/workbench/src/entrypoints/launch');
  const [{ PersistenceService }, { NodeFilesystemPort, NodeProcessPort, createNodeClock, installJobControl }, { openTextDocument, openTextDocumentChunks, TextFileDocument, positionToOffset }] = await Promise.all([persistenceModule, platformModule, documentModule]);
  startupTrace('base-modules');
  const filesystem = new NodeFilesystemPort();
  const clock = createNodeClock();
  // PersistenceService (a service) never constructs documents itself
  // (docs/plan/01-architecture.md); this composition root owns that and hands it a factory.
  const persistence = new PersistenceService(filesystem, undefined, {
    openText: (documentId, bytes, seed, options) => openTextDocument(documentId, bytes, seed, options),
    openTextChunks: (documentId, chunks, seed, options) => openTextDocumentChunks(documentId, chunks, seed, options),
    restoreCheckpoint: (documentId, text, lineEndings, defaultLineEnding, hasUtf8Bom, seed, textIntent) =>
      TextFileDocument.create(documentId, text, lineEndings, defaultLineEnding, hasUtf8Bom, seed, textIntent),
  });
  const configCancellation = new CancellationSource();
  // Owns every feature-reported status/error message from here on, including ones raised
  // before the renderer exists (recovery notices below): the OpenTUI status row picks up
  // whatever is already published the moment it mounts, so nothing is lost, and nothing is
  // written to stderr underneath the alt-screen buffer once the renderer is live.
  const statusMessages = new StatusMessageController(clock);
  // Kicked off now, alongside the other startup filesystem work, so the awaits below (once,
  // before it's first needed) do not add a second sequential round-trip on top of it.
  const startupConfigPromise = loadStartupXiConfig(filesystem, themeStateDirectory(), configCancellation.token, VIEW_COMMAND_IDS, `${process.env.HOME ?? process.cwd()}/.xi.toml`);
  // The document open and the theme-state read are independent IO: overlap them. Custom
  // theme files are only enumerated before the first frame when the persisted theme is not
  // builtin; otherwise they load after the first frame for the picker.
  const themeWiringPromise = createThemeWiring(filesystem, statusMessages);
  const documentPromise = openDocument(openTextDocument, persistence, filePath?.path, id<DocumentId>('xi-launch-document'), statusMessages);
  const themeWiring = await themeWiringPromise;
  const document = await documentPromise;
  if (document === undefined) {
    // The renderer never exists on this path, so the status row that would otherwise show
    // `openDocument`'s failure message never mounts to display it -- flush it to stderr here
    // as the one case where that message must still reach the user.
    if (statusMessages.model !== undefined) process.stderr.write(`${statusMessages.model.text}\n`);
    statusMessages.dispose();
    return;
  }
  startupTrace('document');
  const ui = earlyUi ?? import('../../../packages/ui/src/entrypoints/launch');
  const renderer = ui.then(({ createOpenTuiRenderer }) => createOpenTuiRenderer());
  // A failure anywhere below is otherwise silent (the renderer promise settles with nobody
  // awaiting it) and leaves the terminal in raw mode. Swallow so this is never an unhandled
  // rejection; the try/catch around the rest of this function destroys the renderer (if it
  // was created) before rethrowing.
  renderer.catch(() => {});
  installCrashHandlers(renderer);
  try {
    const coreServices = await coreServicesModule;
    const [, { runOpenTuiWorkbench, ContextMenuStore }] = await Promise.all([vimSession, ui]);
    startupTrace('core-modules');

    const controllers = await createControllers({
      filesystem,
      clock,
      persistence,
      document,
      filePath,
      languageId,
      NodeProcessPort,
      createClock: createNodeClock,
      positionToOffset,
      statusMessages,
      openDocumentAt: (path, documentId) => openDocument(openTextDocument, persistence, path, documentId, statusMessages),
      marker,
      xiUiTestMarkersEnabled: XI_UI_TEST_MARKERS_ENABLED,
      startupTrace,
      startupConfigPromise,
      themeWiring,
      coreServices,
      ContextMenuStore,
    });

    wireControllerPanels(controllers);

    startupTrace('renderer-call');
    await runOpenTuiWorkbench(controllers.workbench, filePath?.label ?? '[No Name]', buildWorkbenchUiOptions(controllers, {
      renderer,
      themeWiring,
      marker,
      startupTrace,
      installJobControl,
    }));
    marker('XI_TEARDOWN', { step: 'workbench-returned' });
    await teardownControllers(controllers, persistence, marker);
    statusMessages.dispose();
    // Bun can retain the PTY stdin reference after OpenTUI has restored the terminal. Every
    // Xi-owned disposable is closed above, so finish the successful process boundary here.
    process.exit(0);
  } catch (error) {
    const created = await renderer.catch(() => undefined);
    if (created !== undefined && !created.isDestroyed) created.destroy();
    statusMessages.dispose();
    throw error;
  }
}

/** Every disposable `createControllers` constructed, torn down in the order main() used
 * before this extraction. Mechanical split out of `main()` to stay under
 * ARCH-APP-FUNCTION-LENGTH-01's line budget; no ordering or behavior change. */
async function teardownControllers(controllers: Controllers, persistence: PersistenceService, marker: (name: string, payload?: unknown) => void): Promise<void> {
  await controllers.editorState.dispose();
  controllers.fileIndexStarter.cancel();
  // H2-4: `awaitPending()` hands back the same typed bundle `ensure()` resolved to (or
  // `undefined` if the optional services never loaded) -- teardown reads it once instead of
  // going back through twelve independent nullable getters on `optionalServices`.
  const resolvedOptionalServices = await controllers.optionalServices.awaitPending();
  controllers.pointerRouter.dispose();

  controllers.picker.dispose();
  controllers.pickerModel.dispose();
  controllers.fileIndex.dispose();
  controllers.hostCommands.dispose();
  controllers.directoryDraftController.dispose();
  resolvedOptionalServices?.explorerSubscription.dispose();
  controllers.searchFeature.dispose();
  controllers.gitPanelFeature.dispose();
  controllers.languageWiring.completionSubscription?.dispose();
  controllers.languageWiring.signatureSubscription?.dispose();
  resolvedOptionalServices?.searchService.dispose();
  resolvedOptionalServices?.replaceService.dispose();
  marker('XI_TEARDOWN', { step: 'language-dispose' });
  await controllers.languageWiring.session?.dispose();
  marker('XI_TEARDOWN', { step: 'language-disposed' });
  controllers.syntaxResultSubscription.dispose();
  controllers.gitDiffFeature.dispose();
  controllers.syntaxTracker.dispose();
  controllers.syntaxAssetsCancellation.dispose();
  resolvedOptionalServices?.hostNavigation.dispose();
  controllers.languageWiring.navigationController?.dispose();
  controllers.languageWiring.navigationSubscription?.dispose();
  controllers.overlayFeature.dispose();
  controllers.languageWiring.completionController?.dispose();
  controllers.languageWiring.signatureController?.dispose();
  controllers.languageWiring.workspaceEditCoordinator?.dispose();
  controllers.workspaceEditsFeature.dispose();
  controllers.diagnostics.dispose();
  controllers.problemsFeature.dispose();
  controllers.taskWiring.dispose();
  resolvedOptionalServices?.explorerController.dispose();
  resolvedOptionalServices?.explorerTree.dispose();
  controllers.explorerFeature.dispose();
  // Clears the coalesced git-refresh timer and disposes the git status subscription plus
  // gitStatusService/gitMutationCoordinator, none of which any other dispose call above
  // touches (H2-5).
  controllers.optionalServices.dispose();
  controllers.commandAliasRegistration?.dispose();
  marker('XI_TEARDOWN', { step: 'contributions-dispose' });
  await controllers.contributionRegistry.dispose();
  marker('XI_TEARDOWN', { step: 'contributions-disposed' });
  controllers.commandRegistry.dispose();
  controllers.completionFeature.dispose();
  controllers.inputRouter.dispose();
  controllers.pointerCapture.dispose();
  controllers.saveCoordinator.dispose();
  controllers.host.dispose();
  persistence.dispose();
  controllers.sidebarController.dispose();
  controllers.contextMenuStore.dispose();
  for (const disposable of controllers.jobControlDisposables) disposable.dispose();
  marker('XI_TEARDOWN', { step: 'done' });
}

async function openDocument(
  openTextDocument: typeof import('../../../packages/document/src/entrypoints/launch').openTextDocument,
  persistence: PersistenceService,
  path: string | undefined,
  documentId: DocumentId,
  statusMessages: StatusMessageController,
): Promise<TextFileDocument | undefined> {
  if (path === undefined) {
    const opened = openTextDocument(documentId, new TextEncoder().encode(''));
    if (opened.kind !== 'editable') throw new Error(`xi cannot edit this input: ${opened.kind}`);
    return opened.document;
  }
  const cancellation = new CancellationSource();
  try {
    const opened = await persistence.openFile(path, documentId, cancellation.token);
    if (!opened.ok) {
      statusMessages.publish(`xi: cannot open ${path}: ${opened.error.kind}`);
      return undefined;
    }
    if (opened.value.kind !== 'editable') {
      statusMessages.publish(`xi: cannot edit ${path}: ${opened.value.document.reason}`);
      return undefined;
    }
    // E13 crash recovery: a checkpoint from a previous session that never reached a clean
    // save/quit takes over only when the file on disk has not changed since that
    // checkpoint's own baseline -- an unexpected external change always wins, so a crash
    // never silently overwrites someone else's newer edit with older recovered content.
    const recovered = await persistence.recover(path, documentId, cancellation.token);
    if (recovered.ok && recovered.value.kind === 'recovered') {
      statusMessages.publish(`xi: recovered unsaved changes for ${path} from an earlier session that did not exit cleanly`, 'info');
      marker('XI_RECOVERY', { path, kind: 'recovered' });
      return recovered.value.document;
    }
    if (recovered.ok && recovered.value.kind === 'disk-diverged') {
      statusMessages.publish(`xi: a recovery checkpoint exists for ${path} but the file changed on disk since; opened the current file instead`, 'info');
      marker('XI_RECOVERY', { path, kind: 'disk-diverged' });
    }
    return opened.value.document;
  } finally {
    cancellation.dispose();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`xi: fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
