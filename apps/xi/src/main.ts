import { asIdentifier, asUtf16Offset, CancellationSource, type DocumentId, type ViewId } from '../../../packages/primitives/src/entrypoints/launch';
import type { SelectionSetSnapshot } from '../../../packages/selections/src/entrypoints/launch';
import type { WorkbenchTheme, DirectoryDraftReadPort, DirectoryDraftReadModel } from '../../../packages/ui/src/entrypoints/launch';
// Value imports of the UI entrypoint would evaluate OpenTUI before main() runs; keep the UI lazy.
import { BUILTIN_WORKBENCH_THEMES } from '../../../packages/ui/src/entrypoints/theme';
import type { TextFileDocument } from '../../../packages/document/src/entrypoints/launch';
import type { encodeTextFile, openTextDocument } from '../../../packages/document/src/entrypoints/launch';
import type { DocumentSnapshot } from '../../../packages/document/src/entrypoints/launch';
import type {
  NodeFilesystemPort,
  NodeProcessPort,
  WorkspaceDirectoryEntry,
  WorkspaceDirectoryWatchEvent,
} from '../../../packages/platform/src/entrypoints/launch';
import type {
  BoundedPickerModel,
  createNavigationContributionModule,
  ExplorerNavigationController,
  ExplorerTree,
  FilePathIndex,
  FilePickerProvider,
  PersistenceService,
  RealtimeSearchService,
  RipgrepSearchBackend,
  StaticPickerProvider,
  PickerEntry,
  ExplorerDirectoryEntry,
  ExplorerFailure,
  ExplorerFilesystemPort,
  WorkspaceReplaceService,
  FormatterPipeline,
  createExternalFormatter,
  HostNavigationController,
  SnippetSession,
  expandSnippet,
} from '../../../packages/services/src/entrypoints/launch';
import type { CancellationToken, Result } from '../../../packages/primitives/src/entrypoints/launch';
import {
  BufferHost,
  buildNavigationRequest,
  CompletionSnippetController,
  ExplorerController,
  LanguageOverlayController,
  PickerController,
  ProblemsController,
  SaveCoordinator,
  SearchController,
  ThemeController,
  WorkbenchHostCommands,
  WorkbenchInputRouter,
  WorkbenchPointerRouter,
  WorkspaceEditsController,
} from '../../../packages/workbench/src/entrypoints/launch';
import type { PointerPanelEvent } from '../../../packages/workbench/src/entrypoints/launch';
import { SyntaxDocumentTracker } from '../../../packages/services/src/entrypoints/syntax';
import { createBundledGrammarProvider, resolveTreeSitterRuntimeOptions } from './syntax-assets';
import { DirectoryDraft, JournaledFilesystemOperations, type DirectoryOperationPlan } from '../../../packages/services/src/entrypoints/files';
import { DirectoryDraftController } from '../../../packages/workbench/src/entrypoints/launch';

const XI_VERSION = '0.0.1';

const EMPTY_DIRECTORY_REVIEW_MODEL: DirectoryDraftReadModel = Object.freeze({
  contractVersion: 1,
  generation: 0,
  directoryPath: '',
  text: '',
  rows: Object.freeze([]),
  dirty: false,
  focus: 'edit',
  review: undefined,
  error: undefined,
});

type LaunchServices = typeof import('../../../packages/services/src/entrypoints/launch');
type GitServices = typeof import('../../../packages/services/src/entrypoints/git');
type WorkspaceEditResourceExecutor = import('../../../packages/services/src/entrypoints/language').WorkspaceEditResourceExecutor;
type CompiledXiConfig = import('../../../packages/services/src/entrypoints/config').CompiledConfig;

// Parsed once at the process boundary: every PTY-visible test marker below funnels
// through this instead of re-reading `process.env` per call site. `marker()` is a
// no-op when disabled, so callers may pass trivial payloads unconditionally; a
// payload built by iterating a collection should stay behind its own `if (...)`
// guard to skip that work when markers are off.
const XI_UI_TEST_MARKERS_ENABLED = process.env.XI_UI_TEST_MARKERS === '1';
const marker: (name: string, payload?: unknown) => void = XI_UI_TEST_MARKERS_ENABLED
  ? (name, payload) => process.stderr.write(payload === undefined ? `${name}\r\n` : `${name} ${JSON.stringify(payload)}\r\n`)
  : () => {};

/** Keep the composition root limited to CLI, ports, lifecycle and renderer wiring. */
async function main(): Promise<void> {
  const startupStarted = process.hrtime.bigint();
  const startupTrace = (label: string): void => {
    if (process.env.XI_STARTUP_TRACE === '1') process.stderr.write(`XI_STARTUP_TRACE ${label} ${Number(process.hrtime.bigint() - startupStarted) / 1_000_000}\n`);
  };
  startupTrace('main');
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Xi editor\n\nUsage: xi [options] [file[:line]]\n\nOptions:\n  --help       Show this help\n  --version    Show the version\n  --health     Check the local runtime\n');
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`xi ${XI_VERSION}\n`);
    return;
  }
  if (args.includes('--health')) {
    process.stdout.write(`xi ${XI_VERSION} health: OpenTUI workbench available\n`);
    return;
  }

  const fileArgument = args.find((arg) => !arg.startsWith('-'));
  const filePath = fileArgument === undefined ? undefined : resolveFileArgument(fileArgument);
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
  const [{ PersistenceService }, { NodeFilesystemPort, NodeProcessPort, createNodeClock, installJobControl }, { openTextDocument, encodeTextFile, positionToOffset }] = await Promise.all([persistenceModule, platformModule, documentModule]);
  startupTrace('base-modules');
  const filesystem = new NodeFilesystemPort();
  const persistence = new PersistenceService(filesystem);
  const configCancellation = new CancellationSource();
  // Kicked off now, alongside the other startup filesystem work, so the awaits below (once,
  // before it's first needed) do not add a second sequential round-trip on top of it.
  const startupConfigPromise = loadStartupConfig(filesystem, configCancellation);
  const themeStateCancellation = new CancellationSource();
  const themeController = new ThemeController<WorkbenchTheme>({
    initial: new Map(Object.entries(BUILTIN_WORKBENCH_THEMES)),
    defaultId: 'xi-light',
    filesystem,
    statePath: themeStatePath(),
    stateDirectory: themeStateDirectory(),
    onPersistError: (message) => process.stderr.write(`xi: ${message}\n`),
  });
  // The document open and the theme-state read are independent IO: overlap them. Custom
  // theme files are only enumerated before the first frame when the persisted theme is not
  // builtin; otherwise they load after the first frame for the picker.
  const documentPromise = openDocument(openTextDocument, persistence, filePath?.path, id<DocumentId>('xi-launch-document'));
  const persistedThemeId = await themeController.readPersistedId(themeStateCancellation.token);
  const loadCustomThemes = async (): Promise<void> => {
    for (const [customId, custom] of await discoverCustomThemes(filesystem, themeStateCancellation)) {
      themeController.addCustomTheme(customId, custom.label, custom.theme);
    }
  };
  const needsCustomThemeNow = persistedThemeId !== undefined && !themeController.has(persistedThemeId);
  if (needsCustomThemeNow) await loadCustomThemes();
  if (persistedThemeId !== undefined && themeController.has(persistedThemeId)) themeController.setActiveId(persistedThemeId);
  const document = await documentPromise;
  if (document === undefined) return;
  startupTrace('document');
  const launchDocument = document;
  const ui = earlyUi ?? import('../../../packages/ui/src/entrypoints/launch');
  const renderer = ui.then(({ createOpenTuiRenderer }) => createOpenTuiRenderer());
  // A failure anywhere below is otherwise silent (the renderer promise settles with nobody
  // awaiting it) and leaves the terminal in raw mode. Swallow so this is never an unhandled
  // rejection; the try/catch around the rest of this function destroys the renderer (if it
  // was created) before rethrowing.
  renderer.catch(() => {});
  try {
  const coreServices = await coreServicesModule;
  const [{ WorkbenchSession, CommandRegistry, ContributionRegistry, DEFAULT_NATIVE_EX_COMMANDS, WorkbenchPointerCapture, scrollViewBy }, { runOpenTuiWorkbench, ContextMenuStore }] = await Promise.all([vimSession, ui]);
  startupTrace('core-modules');
  const {
    BoundedPickerModel,
    BufferPickerProvider,
    createNavigationContributionModule,
    DiagnosticStore,
    FilePathIndex,
    FilePickerProvider,
    StaticPickerProvider,
    fileUri,
    workspacePathFromUri,
    workspaceRelativePathFromUri,
  } = coreServices;
  let host: BufferHost;
  // Constructed once the feature controllers they delegate to exist (below); every
  // reference to them before that point is a closure invoked only later, matching the
  // existing `host` forward-declaration pattern.
  let saveCoordinator: SaveCoordinator;
  let hostCommands: WorkbenchHostCommands;
  let inputRouter: WorkbenchInputRouter;
  let pointerRouter: WorkbenchPointerRouter;
  let languageSession: import('../../../packages/services/src/entrypoints/language').LanguageServerSession | undefined;
  let navigationController: import('../../../packages/services/src/entrypoints/language').LanguageNavigationController | undefined;
  let completionController: import('../../../packages/services/src/entrypoints/language').CompletionController | undefined;
  let completionProvider: import('../../../packages/services/src/entrypoints/language').LanguageServerCompletionProvider | undefined;
  let signatureController: import('../../../packages/services/src/entrypoints/language').SignatureController | undefined;
  let signatureProvider: import('../../../packages/services/src/entrypoints/language').LanguageServerSignatureProvider | undefined;
  let workspaceEditProvider: import('../../../packages/services/src/entrypoints/language').LanguageServerWorkspaceEditProvider | undefined;
  let workspaceEditCoordinator: import('../../../packages/services/src/entrypoints/language').WorkspaceEditCoordinator | undefined;
  let workspaceEditExecutor: WorkspaceEditResourceExecutor | undefined;
  let languageInitialization: Promise<void> | undefined;
  const languageSyncWarnedDocumentIds = new Set<DocumentId>();
  // Grammar/runtime wasm loads lazily on the first request for a known languageId,
  // never here: constructing the tracker does no filesystem or wasm work.
  const syntaxAssetsCancellation = new CancellationSource();
  const syntaxTracker = new SyntaxDocumentTracker({
    grammars: createBundledGrammarProvider(filesystem, syntaxAssetsCancellation.token),
    runtime: resolveTreeSitterRuntimeOptions,
  });
  const workbench = new WorkbenchSession({
    saveBuffer: async (buffer) => {
      if (buffer.path === undefined) return { ok: false, error: 'no file name' };
      const bufferDocument = host.documents.get(buffer.documentId);
      if (bufferDocument === undefined) return { ok: false, error: 'document is no longer open' };
      const saved = await saveCoordinator.requestSave(bufferDocument, buffer.path, undefined);
      return saved ? { ok: true, value: undefined } : { ok: false, error: 'save failed' };
    },
    onDocumentChange: (change) => {
      syntaxTracker.changeDocument(change);
      const admitted = languageSession?.changeDocument(change);
      if (admitted !== undefined && !admitted.ok && !languageSyncWarnedDocumentIds.has(change.documentId)) {
        languageSyncWarnedDocumentIds.add(change.documentId);
        process.stderr.write(`xi: language sync unavailable: ${admitted.error.message}\n`);
      }
      // Vim-originated commits already advanced their owning session during
      // command execution. Remapping those sessions would add avoidable work
      // to every typed character; external LSP/workspace commits still map
      // every live session sharing the document.
      if (change.origin !== 'vim') for (const session of host.sessions.values()) session.applyExternalChange(change);
      completionFeature.cancelSnippetOnExternalChange();
      saveCoordinator.scheduleCheckpoint(change.snapshot.id);
    },
  });
  const opened = workbench.openBuffer(document, {
    ...(filePath?.path === undefined ? {} : { path: filePath.path }),
    viewId: id<ViewId>('xi-launch-view'),
  });
  if (!opened.ok) throw new Error(`xi-workbench-open:${opened.error.kind}`);
  syntaxTracker.openDocument({ documentId: launchDocument.id, languageId, snapshot: launchDocument.snapshot() });
  startupTrace('workbench');
  const workspaceRoot = process.cwd();
  // Config finished loading (started above, in parallel with the rest of startup) by the time
  // any of it is actually needed: format-on-save/formatter selection here, and language-server
  // selection in initializeLanguage() below. XI_FORMAT_ON_SAVE stays a hard override for tests
  // that set it (tests/e2e/t055-formatting-pty.py) rather than a second, conflicting source.
  const startupConfig = await startupConfigPromise;
  const configuredLanguages = startupConfig?.languages;
  const formatOnSave = process.env.XI_FORMAT_ON_SAVE === '1' || (languageId !== undefined && (configuredLanguages?.find((entry) => entry.name === languageId)?.autoFormat ?? false));
  const diagnostics = new DiagnosticStore();
  const contextMenuStore = new ContextMenuStore();
  let hostNavigation: InstanceType<LaunchServices['HostNavigationController']> | undefined;
  let explorerTree: InstanceType<LaunchServices['ExplorerTree']> | undefined;
  let gitStatusService: InstanceType<GitServices['GitStatusService']> | undefined;
  let gitMutationCoordinator: InstanceType<GitServices['GitMutationCoordinator']> | undefined;
  let gitWatchRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let explorerController: InstanceType<LaunchServices['ExplorerNavigationController']> | undefined;
  let searchService: InstanceType<LaunchServices['RealtimeSearchService']> | undefined;
  let replaceService: InstanceType<LaunchServices['WorkspaceReplaceService']> | undefined;
  let expandSnippet: LaunchServices['expandSnippet'] | undefined;
  let SnippetSession: LaunchServices['SnippetSession'] | undefined;
  let executeLanguageCodeAction: LaunchServices['executeLanguageCodeAction'] | undefined;
  let explorerSubscription: import('../../../packages/primitives/src/entrypoints/launch').Disposable | undefined;
  const jobControlDisposables: import('../../../packages/primitives/src/entrypoints/launch').Disposable[] = [];
  let optionalServicesInitialization: Promise<void> | undefined;
  // On-demand rendering only paints after a keypress/resize/pointer event requests a frame.
  // Every service/model subscription below that can change what a surface reads (diagnostics,
  // explorer, search, picker, outline/hover/completion/signature, task output, file index) must
  // notify `host` so the next tick's frame reflects it even without further input.
  diagnostics.subscribe(() => host.notifySurfaceChange());
  const syntaxResultSubscription = syntaxTracker.onResult((result) => {
    // spans are lazy/windowed now: sample the first 4,096 units instead of the O(document) spans getter.
    if (XI_UI_TEST_MARKERS_ENABLED) marker('XI_SYNTAX_STATE', { documentId: result.documentId, version: result.documentVersion, status: result.status, spanCount: result.spansInRange(0, 4096).length });
    host.notifySurfaceChange();
  });
  // Configured languages.toml [[language]] entries take priority over the hardcoded ts/js
  // defaults in `languageIdForPath` -- a language a config maps to a file-type Xi has no
  // built-in mapping for still resolves, and a remapped extension follows the config.
  function resolveLanguageId(path: string | undefined): string | undefined {
    if (path !== undefined && configuredLanguages !== undefined) {
      const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
      const configured = configuredLanguages.find((entry) => entry.fileTypes.includes(extension));
      if (configured !== undefined) return configured.name;
    }
    return languageIdForPath(path);
  }
  // The language server command/args/rootMarkers a resolved languageId should launch, from
  // languages.toml's [[language]].language-servers -> [language-server.<name>] indirection,
  // falling back to today's hardcoded typescript-language-server when nothing configures it.
  function resolveLanguageServerConfig(resolvedLanguageId: string): { readonly name: string; readonly command: string; readonly args: readonly string[]; readonly rootMarkers: readonly string[] } {
    const fallback = { name: 'typescript', command: 'typescript-language-server', args: ['--stdio'], rootMarkers: ['tsconfig.json', 'package.json', '.git'] };
    const language = configuredLanguages?.find((entry) => entry.name === resolvedLanguageId);
    const serverName = language?.languageServers[0];
    const server = serverName === undefined ? undefined : startupConfig?.languageServers.find((entry) => entry.name === serverName);
    return server ?? fallback;
  }
  // Shared by the launch document (below) and by onBufferOpened, so every buffer -- not only
  // the one opened at process launch -- gets a didOpen once a language session exists, whether
  // it was already open before the session started (backfilled below) or opened afterward.
  function admitBufferToLanguageSession(path: string | undefined, documentId: DocumentId, document: TextFileDocument): void {
    if (languageSession === undefined || path === undefined) return;
    const bufferLanguageId = resolveLanguageId(path);
    if (bufferLanguageId === undefined) return;
    const text = readDocumentText(document);
    if (text === undefined) return;
    const admitted = languageSession.openDocument({ uri: fileUri(path), documentId: String(documentId), languageId: bufferLanguageId, version: document.version, text });
    if (!admitted.ok) process.stderr.write(`xi: language document unavailable: ${admitted.error.message}\n`);
  }
  async function initializeLanguage(): Promise<void> {
    const resolvedLanguageId = resolveLanguageId(filePath?.path);
    if (resolvedLanguageId === undefined || filePath?.path === undefined) return;
    const text = readDocumentText(launchDocument);
    if (text === undefined) return;
    const language = await import('../../../packages/services/src/entrypoints/language');
    languageSession = new language.LanguageServerSession({
      process: new NodeProcessPort(),
      clock: createNodeClock(),
      config: resolveLanguageServerConfig(resolvedLanguageId),
      root: workspaceRoot,
      workspaceId: 'xi-workspace',
      workspaceFolders: [{ uri: fileUri(workspaceRoot), name: workspaceRoot }],
      environment: processEnvironment(),
      diagnostics,
    });
    admitBufferToLanguageSession(filePath.path, launchDocument.id, launchDocument);
    // Buffers opened before the session existed (e.g. via the explorer/picker before any
    // LSP-triggering action) never received a didOpen otherwise, since language init is lazy.
    for (const buffer of workbench.buffers()) {
      if (buffer.documentId === launchDocument.id) continue;
      const bufferDocument = host.documents.get(buffer.documentId);
      if (bufferDocument === undefined) continue;
      admitBufferToLanguageSession(buffer.path, buffer.documentId, bufferDocument);
    }
    navigationController = new language.LanguageNavigationController(new language.LanguageServerNavigationProvider(languageSession));
    completionController = new language.CompletionController();
    completionProvider = new language.LanguageServerCompletionProvider(languageSession);
    signatureProvider = new language.LanguageServerSignatureProvider(languageSession);
    signatureController = new language.SignatureController(signatureProvider);
    workspaceEditExecutor = new language.WorkspaceEditResourceExecutor({
      workspaceRoot,
      filesystem,
      openDocument: (uri) => workspaceEditsFeature.openWorkspaceEditDocument(uri),
      loadUnopenedFile: (uri) => workspaceEditsFeature.loadUnopenedWorkspaceFile(uri),
      onResourcePathRenamed: (sourcePath, destinationPath) => {
        const sourceBuffer = workbench.buffers().find((buffer) => buffer.path !== undefined && fileUri(buffer.path) === fileUri(sourcePath));
        if (sourceBuffer !== undefined) workbench.renameBufferPath(sourceBuffer.bufferId, destinationPath);
      },
    });
    workspaceEditProvider = new language.LanguageServerWorkspaceEditProvider({
      session: languageSession,
      document: (uri) => workspaceEditExecutor?.resolveDocument(uri),
    });
    workspaceEditCoordinator = new language.WorkspaceEditCoordinator(workspaceEditExecutor.asPort());
    navigationSubscription = overlayFeature.attachNavigation(navigationController, languageSession);
    const completionSubscriptions = completionFeature.attachLanguage(languageSession, completionController, completionProvider, signatureController);
    completionSubscription = completionSubscriptions.completionSubscription;
    signatureSubscription = completionSubscriptions.signatureSubscription;
    workspaceEditsFeature.attachLanguage(languageSession, workspaceEditProvider);
  }
  async function ensureLanguage(): Promise<void> {
    if (languageSession !== undefined) return;
    languageInitialization ??= initializeLanguage();
    await languageInitialization;
  }

  // Coalesces bursty workspace watch events (a `git` command itself touches many files) into
  // at most one Git status refresh per 500ms window, per AGENTS.md's bounded-background-work rule.
  function scheduleGitRefresh(delayMilliseconds = 500): void {
    if (gitStatusService === undefined || gitWatchRefreshTimer !== undefined) return;
    gitWatchRefreshTimer = setTimeout(() => {
      gitWatchRefreshTimer = undefined;
      void gitStatusService?.refresh();
    }, delayMilliseconds);
  }

  // Git status changes from mutations (stage/unstage/commit) never touch tracked file bytes, so
  // the filesystem watcher that normally drives ExplorerTree's reconcile/refreshDecoration path
  // (see createGitDecorationPort's doc comment) never fires for them. Re-expanding every
  // currently expanded directory forces ExplorerTree's own public re-reconcile, which re-reads
  // decorations for its visible children through the same lazy git port.
  function refreshExplorerGitDecorations(): void {
    // Decoration-only: a forced re-expand would supersede in-flight loads and break reveal.
    explorerTree?.redecorate();
  }

  async function ensureGitAndOpenPicker(): Promise<void> {
    await initializeOptionalServices();
    void gitStatusService?.refresh();
    picker.open('git');
  }

  async function initializeOptionalServices(): Promise<void> {
    if (optionalServicesInitialization !== undefined) return optionalServicesInitialization;
    optionalServicesInitialization = (async () => {
      const [services, git] = await Promise.all([
        import('../../../packages/services/src/entrypoints/launch'),
        import('../../../packages/services/src/entrypoints/git'),
      ]);
      const {
        HostNavigationController,
        ExplorerTree,
        ExplorerNavigationController,
        RealtimeSearchService,
        RipgrepSearchBackend,
        WorkspaceReplaceService,
        createCtagsNavigationHost,
      } = services;
      hostNavigation = new HostNavigationController(createCtagsNavigationHost({ filesystem, workspaceRoot, fileUri }));
      const nextGitStatus = new git.GitStatusService({ process: new NodeProcessPort(), root: workspaceRoot, env: processEnvironment() });
      nextGitStatus.subscribe(() => {
        refreshExplorerGitDecorations();
        host.notifySurfaceChange();
      });
      gitStatusService = nextGitStatus;
      gitMutationCoordinator = new git.GitMutationCoordinator(git.createProcessGitMutationExecutor(new NodeProcessPort(), workspaceRoot, processEnvironment()));
      void nextGitStatus.refresh();
      const nextExplorer = new ExplorerTree(
        createExplorerFilesystem(filesystem, workspaceRoot, () => scheduleGitRefresh()),
        { git: createGitDecorationPort(nextGitStatus, workspaceRoot) },
      );
      const explorerRoot = nextExplorer.addRoot({ id: 'workspace', label: workspaceRoot, path: workspaceRoot });
      if (!explorerRoot.ok) throw new Error(`xi-explorer-root:${explorerRoot.error.kind}`);
      explorerTree = nextExplorer;
      searchService = new RealtimeSearchService({
        backend: new RipgrepSearchBackend({ process: new NodeProcessPort(), environment: processEnvironment() }),
        debounceMilliseconds: 40,
        defaultLimit: 10_000,
        bufferSourceProvider: () => searchFeature.readBuffers(),
      });
      replaceService = new WorkspaceReplaceService(searchFeature.createReplacePort());
      searchFeature.attachServices(searchService, replaceService, services.applyReplacementEdits);
      explorerController = new ExplorerNavigationController({ tree: nextExplorer, onOpen: (node) => explorerFeature.openNode(node) });
      explorerSubscription = explorerFeature.attachTree(nextExplorer, explorerController);
      expandSnippet = services.expandSnippet;
      SnippetSession = services.SnippetSession;
      executeLanguageCodeAction = services.executeLanguageCodeAction;
      host.notifySurfaceChange();
    })();
    return optionalServicesInitialization;
  }

  let taskController: import('../../../packages/services/src/entrypoints/tasks').TaskController | undefined;
  let tasksModuleCache: typeof import('../../../packages/services/src/entrypoints/tasks') | undefined;
  const taskCancellation = new CancellationSource();
  async function loadTasksModule(): Promise<typeof import('../../../packages/services/src/entrypoints/tasks')> {
    tasksModuleCache ??= await import('../../../packages/services/src/entrypoints/tasks');
    return tasksModuleCache;
  }
  async function ensureTaskController(): Promise<import('../../../packages/services/src/entrypoints/tasks').TaskController> {
    if (taskController !== undefined) return taskController;
    const tasksModule = await loadTasksModule();
    const controller = new tasksModule.TaskController(tasksModule.createSpawnTaskProcessFactory(new NodeProcessPort(), taskCancellation.token));
    // The output panel reads live stdout/stderr as it streams in; wake a frame on every
    // snapshot, not just the terminal one the problems feature's own completion subscription
    // reacts to.
    controller.subscribe(() => host.notifySurfaceChange());
    taskController = controller;
    return controller;
  }
  async function readTasksConfig(path: string): Promise<Result<readonly import('../../../packages/services/src/entrypoints/tasks').TaskConfig[], { readonly message: string }>> {
    const read = await filesystem.readFile(path, taskCancellation.token);
    if (!read.ok) return { ok: true, value: [] };
    const { parseTasksConfig } = await loadTasksModule();
    const parsed = parseTasksConfig(new TextDecoder('utf-8').decode(read.value), '.xi/tasks.toml');
    if (!parsed.ok) return { ok: false, error: { message: `xi: .xi/tasks.toml is invalid: ${parsed.error.diagnostics.map((entry) => entry.message).join('; ')}\n` } };
    return { ok: true, value: parsed.value };
  }
  /** Synchronous: `runConfiguredTask` always awaits `ensureTaskController` (which loads this
   * same module) before a task can reach the terminal state that triggers this. */
  function matchTaskProblems(text: string): readonly import('../../../packages/services/src/entrypoints/tasks').TaskMatchedProblem[] {
    if (tasksModuleCache === undefined) throw new Error('xi: tasks module unavailable');
    return tasksModuleCache.matchTaskProblems(text, tasksModuleCache.GENERIC_COMPILER_PROBLEM_MATCHER);
  }
  let toggleMouseMode: (() => boolean) | undefined;
  let navigationSubscription: import('../../../packages/primitives/src/entrypoints/launch').Disposable | undefined;
  let completionSubscription: import('../../../packages/primitives/src/entrypoints/launch').Disposable | undefined;
  let signatureSubscription: import('../../../packages/primitives/src/entrypoints/launch').Disposable | undefined;
  const fileIndex = new FilePathIndex({ maxEntries: 120_000 });
  let fileIndexPopulation: Promise<void> | undefined;
  const rootAdded = fileIndex.addRoot({ id: 'workspace', label: workspaceRoot, path: workspaceRoot });
  if (!rootAdded.ok) throw new Error(`xi-file-index-root:${rootAdded.error.kind}`);
  const commandRegistry = new CommandRegistry({ nativeExNames: DEFAULT_NATIVE_EX_COMMANDS.map((command) => command.name) });
  const contributionRegistry = new ContributionRegistry({
    commands: commandRegistry,
    host: { read: { read: () => ({ ready: true }) }, selectionGeneration: 0 as never },
  });
  const navigationActivation = await contributionRegistry.activate(createNavigationContributionModule({ fileIndex }));
  if (!navigationActivation.ok) throw new Error(`xi-navigation-contributions:${navigationActivation.error.kind}`);

  const bufferProvider = new BufferPickerProvider('xi.navigation.buffers', () => workbench.buffers().map((buffer) => Object.freeze({
    id: String(buffer.bufferId),
    label: buffer.path ?? '[No Name]',
    detail: buffer.dirty ? 'modified' : 'saved',
    value: String(buffer.bufferId),
  })));
  const pickerModel = new BoundedPickerModel({ providers: [
    new FilePickerProvider(fileIndex),
    bufferProvider,
    new StaticPickerProvider('xi.navigation.commands', 'command', [
      { id: 'files.pick', mode: 'command', label: 'Files', detail: 'Open file picker', value: 'file' },
      { id: 'buffers.pick', mode: 'command', label: 'Buffers', detail: 'Switch open buffer', value: 'buffer' },
      { id: 'theme.pick', mode: 'command', label: 'Themes', detail: 'Choose a theme', value: 'theme' },
      { id: 'config.open', mode: 'command', label: 'Config', detail: 'Open configuration', value: 'config' },
      { id: 'mouse.toggle', mode: 'command', label: 'Toggle Mouse', detail: 'Enable/disable mouse reporting; disable for terminal-native click-drag text selection', value: 'toggle-mouse' },
    ]),
    // Live source: custom themes finish loading after the first frame.
    new BufferPickerProvider('xi.navigation.themes', () => [
      { id: 'xi-light', label: 'Xi Light', detail: '', value: 'xi-light' },
      { id: 'xi-dark', label: 'Xi Dark', detail: '', value: 'xi-dark' },
      ...themeController.customThemeEntries().map(({ id: customId, label }) => ({ id: customId, label, detail: '', value: customId })),
    ].sort((left, right) => left.label.localeCompare(right.label)), 'theme'),
    new StaticPickerProvider('xi.navigation.config', 'config', [{ id: 'config.open', mode: 'config', label: 'Open config', value: 'config.open' }]),
    // Live source: the changed-files list follows `gitStatusService`'s snapshot, which is only
    // constructed lazily (see `initializeOptionalServices`); until then this reads as empty.
    new BufferPickerProvider('xi.navigation.git', () => {
      const snapshot = gitStatusService?.snapshot;
      if (snapshot === undefined) return [];
      return [...snapshot.entries]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((entry) => Object.freeze({
          id: entry.path,
          label: entry.path,
          detail: toExplorerGitDecoration(entry).label,
          value: filesystem.resolvePath(workspaceRoot, entry.path),
        }));
    }, 'git'),
  ]});
  host = new BufferHost(workbench, document, {
    openDocument: async (path, documentId) => (path === undefined ? undefined : await directoryDraftController.openDocumentIfDirectory(path, documentId)) ?? openDocument(openTextDocument, persistence, path, documentId),
    workspaceRelativePath: (path) => filesystem.workspaceRelativePath(workspaceRoot, path),
    marker,
    launchViewId: id<ViewId>('xi-launch-view'),
    ...(filePath?.line === undefined ? {} : { launchInitialLine: filePath.line }),
    onMessage: (message) => process.stderr.write(message),
    onSave: async (sessionDocument, viewId, target) => {
      // T041/T042: `:w` on a directory draft compiles a plan and opens review instead of
      // writing draft text to disk; the plan only reaches disk once the review is applied.
      if (directoryDraftController.requestSave(sessionDocument.id)) return true;
      const buffer = workbench.views().find((view) => view.viewId === viewId);
      const path = target ?? (buffer === undefined ? undefined : workbench.buffer(buffer.bufferId)?.path);
      if (path === undefined) {
        process.stderr.write('xi: no file name\n');
        return false;
      }
      return saveCoordinator.requestSave(sessionDocument, path, viewId);
    },
    onExCommand: (source, viewId) => hostCommands.handleWorkbenchCommand(source, viewId),
    onPrefixStateChange: (viewId, state) => inputRouter.schedulePrefixHelp(viewId, state.pendingKeys, state.parserContinuations),
    onCommandLineChange: (state) => inputRouter.handleCommandLineChange(state),
    onHostCommand: (command, viewId) => hostCommands.handleVimHostCommand(command, viewId),
    onBufferOpened: (buffer) => {
      syntaxTracker.openDocument({ documentId: buffer.documentId, languageId: languageIdForPath(buffer.path), snapshot: buffer.document.snapshot() });
      admitBufferToLanguageSession(buffer.path, buffer.documentId, buffer.document);
    },
    onBufferClosed: (buffer) => {
      syntaxTracker.closeDocument(buffer.documentId);
      directoryDraftController.closeDocument(buffer.documentId);
      if (languageSession === undefined || buffer.path === undefined) return;
      if (languageIdForPath(buffer.path) === undefined) return;
      languageSession.closeDocument(fileUri(buffer.path));
    },
  });
  const picker = new PickerController<PickerEntry, WorkbenchTheme>({
    host,
    model: pickerModel,
    theme: themeController,
    marker,
    startFileIndexPopulation: () => startFileIndexPopulation(),
    toggleMouseMode: () => toggleMouseMode?.() ?? true,
    openFile: (path, preview) => host.openBufferAtPath(path, { preview }),
    onSecondaryAction: (entry, key) => {
      const coordinator = gitMutationCoordinator;
      const status = gitStatusService;
      if (coordinator === undefined || status === undefined) return;
      const snapshot = status.snapshot;
      if (snapshot === undefined) return;
      const context = { root: workspaceRoot, generation: snapshot.generation, expectedGeneration: snapshot.generation };
      const action = key === 's' ? coordinator.stage([entry.value], context) : coordinator.unstage([entry.value], context);
      void action.then((result) => {
        if (!result.ok) { marker('XI_GIT_MUTATION_FAILED', { kind: result.error.kind }); return; }
        void status.refresh();
      });
    },
  });
  const explorerFeature = new ExplorerController({
    host,
    session: workbench,
    filesystem,
    marker,
    onError: (message) => process.stderr.write(message),
    workspaceRelativePath: (path) => filesystem.workspaceRelativePath(workspaceRoot, path),
    trashDirectory: `${workspaceRoot}/.xi-trash`,
    ensureServices: () => initializeOptionalServices(),
  });
  // T041/T042: directory-as-editable-text ("Space O", docs/plan/03-ux.md). All orchestration
  // (map of open drafts, review-plan apply, Enter/Esc routing) lives in the workbench
  // controller below -- this composition root only constructs it with structural ports
  // (ARCH-COMPOSITION-ROOT-01 forbids feature-state/handlers living inside `main()` itself).
  const journaledFileOperations = new JournaledFilesystemOperations(filesystem, { trashRoot: `${workspaceRoot}/.xi-trash` });
  const directoryDraftController = new DirectoryDraftController({
    filesystem: {
      isDirectory: async (path) => {
        const cancellation = new CancellationSource();
        try {
          const info = await filesystem.stat(path, cancellation.token);
          return info.ok && info.value.kind === 'directory';
        } finally {
          cancellation.dispose();
        }
      },
      listEntries: async (path) => {
        const cancellation = new CancellationSource();
        try {
          const enumerated = await filesystem.enumerateDirectory(path, path, cancellation.token);
          if (!enumerated.ok) return { ok: false, error: enumerated.error.code };
          const base = path.endsWith('/') ? path : `${path}/`;
          return {
            ok: true,
            value: enumerated.value.map((entry) => ({
              name: entry.name,
              path: `${base}${entry.name}`,
              kind: entry.kind,
              ...(entry.stableIdentity === undefined ? {} : { stableIdentity: entry.stableIdentity }),
              ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
              ...(entry.modifiedMilliseconds === undefined ? {} : { modifiedMilliseconds: entry.modifiedMilliseconds }),
            })),
          };
        } finally {
          cancellation.dispose();
        }
      },
      resolvePath: (base, relative) => filesystem.resolvePath(base, relative),
      directoryPath: (path) => filesystem.directoryPath(path),
    },
    workspaceRoot,
    activeBufferPath: (viewId) => {
      const view = workbench.views().find((candidate) => candidate.viewId === viewId);
      return view === undefined ? undefined : workbench.buffer(view.bufferId)?.path;
    },
    createDraft: (path, documentId, entries) => {
      const draft = DirectoryDraft.create(path, entries, { documentId: String(documentId) });
      if (!draft.ok) return { ok: false, error: draft.error.message };
      return { ok: true, value: { port: draft.value, document: draft.value.document } };
    },
    // T042: `.xi-trash` matches explorerFeature's own trash directory above so both
    // draft-review and explorer deletes recover from one place.
    applyPlan: async (plan) => {
      const cancellation = new CancellationSource();
      try {
        const applied = await journaledFileOperations.apply(plan as DirectoryOperationPlan, cancellation.token);
        return applied.ok ? { ok: true } : { ok: false, error: applied.error.kind };
      } finally {
        cancellation.dispose();
      }
    },
    openBuffer: async (path) => (await host.openBufferAtPath(path)) !== undefined,
    onError: (message) => process.stderr.write(message),
    marker,
    notifySurfaceChange: () => host.notifySurfaceChange(),
  });
  const searchFeature = new SearchController({
    host,
    session: workbench,
    filesystem,
    marker,
    onError: (message) => process.stderr.write(message),
    workspaceRoot,
    ensureServices: () => initializeOptionalServices(),
  });
  const problemsFeature = new ProblemsController({
    host,
    diagnostics,
    marker,
    onError: (message) => process.stderr.write(message),
    workspaceRoot,
    resolvePath: (base, relative) => filesystem.resolvePath(base, relative),
    fileUri,
    workspacePathFromUri,
    processEnvironment,
    readTasksConfig,
    matchTaskProblems,
    ensureTaskController,
  });
  const overlayFeature = new LanguageOverlayController({
    host,
    session: workbench,
    fileUri,
    marker,
    ensureLanguage: () => ensureLanguage(),
  });
  const completionFeature = new CompletionSnippetController({
    host,
    session: workbench,
    marker,
    onError: (message) => process.stderr.write(message),
    fileUri,
    positionToOffset,
    ensureLanguage: () => ensureLanguage(),
    ensureOptionalServices: () => initializeOptionalServices(),
    getSnippetSupport: () => (expandSnippet === undefined || SnippetSession === undefined ? undefined : { expandSnippet, SnippetSession }),
  });
  const workspaceEditsFeature = new WorkspaceEditsController({
    host,
    session: workbench,
    filesystem,
    marker,
    onError: (message) => process.stderr.write(message),
    fileUri,
    workspaceRelativePathFromUri: (uri) => workspaceRelativePathFromUri(filesystem, workspaceRoot, uri),
    workspaceAbsolutePath: (relativePath) => filesystem.workspaceAbsolutePath(workspaceRoot, relativePath),
    nextDocumentId: () => host.nextDocumentId(),
    languageId,
    ensureLanguage: () => ensureLanguage(),
    readDiagnostics: () => diagnostics.model.all,
    runWorkspaceEditProposal: async (proposal) => {
      if (workspaceEditCoordinator === undefined || workspaceEditProvider === undefined || workspaceEditExecutor === undefined || languageSession === undefined) {
        return { ok: false, error: { kind: 'disposed', message: 'workspace edit coordinator is unavailable' } };
      }
      const language = await import('../../../packages/services/src/entrypoints/language');
      return language.applyWorkspaceEditProposal(proposal, {
        coordinator: workspaceEditCoordinator,
        provider: workspaceEditProvider,
        session: languageSession,
        resolveTarget: async (uri) => (await workspaceEditExecutor?.resolveDocument(uri))?.target,
      });
    },
    renameWithRetry: async (request, newName, rename, options) => {
      const language = await import('../../../packages/services/src/entrypoints/language');
      return language.renameWithBoundedRetry(request, newName, rename, options);
    },
    ensureCodeActionExecutor: async () => {
      if (executeLanguageCodeAction !== undefined) return executeLanguageCodeAction;
      await initializeOptionalServices();
      return executeLanguageCodeAction;
    },
  });
  const pointerCapture = new WorkbenchPointerCapture({
    cancelPendingOperator: () => { host.activeSession()?.cancelPendingOperator(); },
    place: (intent) => {
      const session = host.sessions.get(intent.viewId as ViewId);
      const applied = session?.placePointer(intent) ?? false;
      if (process.env.XI_UI_TEST_MARKERS === '1') {
        const state = session?.readView(intent.viewId as ViewId);
        marker('XI_POINTER_STATE', { kind: intent.kind, applied, viewId: intent.viewId, row: intent.head.row, column: intent.head.column, target: intent.head.target, mode: state?.session.mode, selectionCount: state?.selections.members.length, selectionKinds: state?.selections.members.map((member) => member.kind) });
      }
    },
    scroll: (viewId, delta, viewportHeight) => {
      const result = scrollViewBy(workbench, (id) => host.sessions.get(id), viewId as ViewId, delta, viewportHeight);
      marker('XI_POINTER_SCROLL', { viewId, delta, scrollTop: result?.scrollTop });
    },
  });

  saveCoordinator = new SaveCoordinator({
    host,
    session: workbench,
    persistence,
    marker,
    onError: (message) => process.stderr.write(message),
    formatOnSave,
    createFormatterPipeline: async () => {
      const { FormatterPipeline, createExternalFormatter } = await import('../../../packages/services/src/entrypoints/formatting');
      const configuredFormatter = languageId === undefined ? undefined : configuredLanguages?.find((entry) => entry.name === languageId)?.formatter;
      return createFormatterPipelineFromEnvironment(workspaceRoot, FormatterPipeline, createExternalFormatter, NodeProcessPort, configuredFormatter);
    },
    onSaved: () => { void gitStatusService?.refresh(); },
  });
  hostCommands = new WorkbenchHostCommands({
    host,
    session: workbench,
    filesystem,
    marker,
    onError: (message) => process.stderr.write(message),
    workspaceRoot,
    workspacePathFromUri,
    ensureHostNavigation: () => initializeOptionalServices(),
    readHostNavigation: () => hostNavigation,
    workspaceEdits: workspaceEditsFeature,
    problems: problemsFeature,
    saveCoordinator,
    directoryDrafts: { open: (target, viewId) => directoryDraftController.explore(target, viewId) },
  });
  inputRouter = new WorkbenchInputRouter({
    host,
    session: workbench,
    marker,
    onError: (message) => process.stderr.write(message),
    commandRegistry,
    picker,
    explorer: explorerFeature,
    search: searchFeature,
    problems: problemsFeature,
    overlays: overlayFeature,
    completion: completionFeature,
    workspaceEdits: workspaceEditsFeature,
    isExplorerServiceLoaded: () => explorerTree !== undefined,
    isSearchServiceLoaded: () => searchService !== undefined,
    ensureOptionalServices: () => initializeOptionalServices(),
    toggleMouseMode: () => toggleMouseMode?.() ?? true,
    launchViewId: id<ViewId>('xi-launch-view'),
  });
  pointerRouter = new WorkbenchPointerRouter({
    session: workbench,
    marker,
    pointerCapture,
    contextMenu: contextMenuStore,
    picker: {
      activateEntry: async (entryId) => {
        const entry = pickerModel.model.entries.find((candidate) => candidate.id === entryId);
        if (entry !== undefined) await picker.activateEntry(entry);
      },
    },
    pickerModel,
    explorer: explorerFeature,
    search: {
      readModel: () => searchService?.model,
      setSelectedIndex: (index) => searchFeature.setSelectedIndex(index),
      openMatch: (match) => searchFeature.openMatch(match),
    },
    problems: {
      get model() { return diagnostics.model; },
      setSelectedProblemIndex: (index) => problemsFeature.setSelectedProblemIndex(index),
      openProblem: (problem) => problemsFeature.openProblem(problem),
    },
  });
  pointerRouter.publishControls([
    { id: 'sidebar.files', kind: 'tree', enabled: true, activate: () => explorerFeature.open() },
    { id: 'sidebar.search', kind: 'button', enabled: true, activate: () => searchFeature.open() },
    { id: 'sidebar.git', kind: 'button', enabled: true, activate: () => { void ensureGitAndOpenPicker(); } },
    { id: 'status', kind: 'button', enabled: true, activate: () => {} },
    { id: 'tab.active', kind: 'tab', enabled: true, activate: () => { const active = workbench.activeViewId; if (active !== undefined) void workbench.focus(active); } },
  ]);
  /** Every overlay panel is mutually exclusive with every other; opening one must always
   * close the rest, not just the ones a given call site happened to remember. Registered on
   * `host` (not yet extracted into per-feature controllers -- S5-S8) so it, not `main()`,
   * owns exclusivity ordering. */
  host.registerPanel('search', { isOpen: () => searchFeature.isOpen, close: () => searchFeature.close() });
  host.registerPanel('explorer', { isOpen: () => explorerFeature.isOpen, close: () => explorerFeature.close() });
  host.registerPanel('problems', { isOpen: () => problemsFeature.isProblemsOpen, close: () => problemsFeature.closeProblems() });
  host.registerPanel('outline', { isOpen: () => overlayFeature.isOutlineOpen, close: () => overlayFeature.closeOutline() });
  host.registerPanel('hover', { isOpen: () => overlayFeature.isHoverOpen, close: () => overlayFeature.closeHover() });
  host.registerPanel('completion', { isOpen: () => completionFeature.isCompletionOpen, close: () => completionFeature.closeCompletion(), alwaysClose: true });
  host.registerPanel('signature', { isOpen: () => completionFeature.isSignatureOpen, close: () => completionFeature.closeSignature(), alwaysClose: true });
  host.registerPanel('output', { isOpen: () => problemsFeature.isOutputOpen, close: () => problemsFeature.closeOutput() });
  host.registerPanel('directory-review', { isOpen: () => directoryDraftController.isReviewOpen, close: () => directoryDraftController.closeReview() });

  // Deferred until every controller `onPrefixStateChange`/`onCommandLineChange` delegates to
  // (`inputRouter`, constructed above) exists: `createSession`'s initial state publish can
  // invoke those callbacks synchronously.
  host.createSession(document, id<ViewId>('xi-launch-view'));

  let fileIndexStartTimer: ReturnType<typeof setTimeout> | undefined;
  const runWorkbench = runOpenTuiWorkbench(workbench, filePath?.label ?? '[No Name]', {
    renderer,
    theme: themeController.get(themeController.activeId) ?? BUILTIN_WORKBENCH_THEMES['xi-light'],
    syntax: syntaxTracker,
    gitBranch: () => gitStatusService?.snapshot?.branch,
    registerMouseToggle: (toggle) => { toggleMouseMode = toggle; },
    registerThemeSwitch: (setTheme) => { themeController.bindSetTheme(setTheme); },
    registerJobControl: (control: { suspend: () => void; resume: () => void }) => { jobControlDisposables.push(installJobControl(control)); },
    marker,
    subscribeSurfaceChanges: (listener) => host.onSurfaceChange(listener),
    onViewportAnchorChange: (viewId, scrollTop, scrollLeft) => {
      workbench.setViewScroll(viewId as ViewId, scrollTop, scrollLeft);
    },
    onPointer: (event) => pointerRouter.handlePointer(event),
    onPaste: (bytes: Uint8Array) => inputRouter.handlePaste(bytes),
    onPointerCancel: (reason) => pointerRouter.handlePointerCancel(reason),
    onFrame: () => {
      if (process.env.XI_PERF_TRACE === '1') process.stderr.write(`XI_FRAME ${process.hrtime.bigint().toString()}\r\n`);
    },
    prefixHelp: inputRouter.prefixHelp,
    contextMenu: contextMenuStore,
    commandLine: {
      read: inputRouter.commandLine.read,
      isOpen: () => inputRouter.isCommandLineActive(),
      onKeypress: (event) => inputRouter.handleCommandLineKeypress(event),
    },
    onReady: () => {
      startupTrace('ready-callback');
      if (!needsCustomThemeNow) void loadCustomThemes().finally(() => themeStateCancellation.dispose());
      else themeStateCancellation.dispose();
      // Directory enumeration, watching and picker indexing are background
      // work. Starting them before the first frame makes the editor compete
      // with filesystem streams during the user's first interaction.
      fileIndexStartTimer = setTimeout(() => {
        void startFileIndexPopulation();
      }, 1000);
    },
    onKeypress: (event) => inputRouter.handleKeypress(event),
    picker: {
      read: pickerModel,
      isOpen: () => picker.isOpen,
      onKeypress: (event) => picker.handleKeypress(event),
      onPointer: (event: PointerPanelEvent) => pointerRouter.handlePanelPointer(event),
    },
    get explorer() {
      return explorerTree === undefined ? undefined : {
        read: explorerTree,
        isOpen: () => explorerFeature.isOpen,
        onKeypress: (event: LauncherKeyEvent) => explorerFeature.handleKeypress(event),
        onPointer: (event: PointerPanelEvent) => pointerRouter.handlePanelPointer(event),
      };
    },
    get search() {
      return searchService === undefined ? undefined : {
        read: searchService,
        isOpen: () => searchFeature.isOpen,
        selectedId: () => searchService?.model.matches[searchFeature.selectedIndex]?.id,
        onKeypress: (event: LauncherKeyEvent) => searchFeature.handleKeypress(event),
        onPointer: (event: PointerPanelEvent) => pointerRouter.handlePanelPointer(event),
      };
    },
    problems: {
      read: diagnostics,
      isOpen: () => problemsFeature.isProblemsOpen,
      selectedId: () => problemsFeature.selectedProblemId(),
      onKeypress: (event: LauncherKeyEvent) => problemsFeature.handleProblemsKeypress(event),
      onPointer: (event: PointerPanelEvent) => pointerRouter.handlePanelPointer(event),
    },
    get output() {
      return taskController === undefined ? undefined : {
        read: taskController,
        isOpen: () => problemsFeature.isOutputOpen,
        onKeypress: (event: LauncherKeyEvent) => problemsFeature.handleOutputKeypress(event),
      };
    },
    directoryReview: {
      read: {
        get model() {
          return (directoryDraftController.activeReviewPort()?.model as unknown as DirectoryDraftReadModel | undefined) ?? EMPTY_DIRECTORY_REVIEW_MODEL;
        },
        subscribe: (listener: (model: DirectoryDraftReadModel) => void) => {
          const active = directoryDraftController.activeReviewPort();
          return active === undefined ? { dispose: () => {} } : active.subscribe(listener as (model: unknown) => void);
        },
      } satisfies DirectoryDraftReadPort,
      isOpen: () => directoryDraftController.isReviewOpen,
      onKeypress: (event: LauncherKeyEvent) => directoryDraftController.handleKeypress(event),
    },
    outline: {
      read: overlayFeature.outlineRead,
      isOpen: () => overlayFeature.isOutlineOpen,
      onKeypress: (event: LauncherKeyEvent) => overlayFeature.handleOutlineKeypress(event),
    },
    hover: {
      read: overlayFeature.hoverRead,
      isOpen: () => overlayFeature.isHoverOpen,
      onKeypress: (event: LauncherKeyEvent) => overlayFeature.handleHoverKeypress(event),
    },
    completion: {
      read: completionFeature.completionRead,
      isOpen: () => completionFeature.isCompletionOpen,
      onKeypress: (event: LauncherKeyEvent) => completionFeature.handleCompletionKeypress(event),
    },
    signature: {
      read: completionFeature.signatureRead,
      isOpen: () => completionFeature.isSignatureOpen,
      onKeypress: (event: LauncherKeyEvent) => completionFeature.handleSignatureKeypress(event),
    },
  } as Parameters<typeof runOpenTuiWorkbench>[2]);
  startupTrace('renderer-call');
  await runWorkbench;
  marker('XI_TEARDOWN', { step: 'workbench-returned' });
  clearTimeout(fileIndexStartTimer);
  await optionalServicesInitialization;
  pointerRouter.dispose();

  pickerModel.dispose();
  fileIndex.dispose();
  explorerSubscription?.dispose();
  searchFeature.dispose();
  completionSubscription?.dispose();
  signatureSubscription?.dispose();
  searchService?.dispose();
  replaceService?.dispose();
  marker('XI_TEARDOWN', { step: 'language-dispose' });
  await languageSession?.dispose();
  marker('XI_TEARDOWN', { step: 'language-disposed' });
  syntaxResultSubscription.dispose();
  syntaxTracker.dispose();
  syntaxAssetsCancellation.dispose();
  hostNavigation?.dispose();
  navigationController?.dispose();
  navigationSubscription?.dispose();
  overlayFeature.dispose();
  completionController?.dispose();
  signatureController?.dispose();
  workspaceEditCoordinator?.dispose();
  workspaceEditsFeature.dispose();
  diagnostics.dispose();
  problemsFeature.dispose();
  taskController?.dispose();
  taskCancellation.dispose();
  explorerController?.dispose();
  explorerTree?.dispose();
  explorerFeature.dispose();
  marker('XI_TEARDOWN', { step: 'contributions-dispose' });
  await contributionRegistry.dispose();
  marker('XI_TEARDOWN', { step: 'contributions-disposed' });
  commandRegistry.dispose();
  completionFeature.dispose();
  inputRouter.dispose();
  pointerCapture.dispose();
  saveCoordinator.dispose();
  host.dispose();
  persistence.dispose();
  for (const disposable of jobControlDisposables) disposable.dispose();
  marker('XI_TEARDOWN', { step: 'done' });

  function startFileIndexPopulation(): Promise<void> {
    fileIndexPopulation ??= populateFileIndex(fileIndex, filesystem, workspaceRoot).then(() => { host.notifySurfaceChange(); });
    return fileIndexPopulation;
  }


  } catch (error) {
    const created = await renderer.catch(() => undefined);
    if (created !== undefined && !created.isDestroyed) created.destroy();
    throw error;
  }
}

async function openDocument(
  openTextDocument: typeof import('../../../packages/document/src/entrypoints/launch').openTextDocument,
  persistence: PersistenceService,
  path: string | undefined,
  documentId: DocumentId,
): Promise<TextFileDocument | undefined> {
  if (path === undefined) {
    const opened = openTextDocument(documentId, new TextEncoder().encode('// Xi editor\n// Press :q<Enter> to quit\n'));
    if (opened.kind !== 'editable') throw new Error(`xi cannot edit this input: ${opened.kind}`);
    return opened.document;
  }
  const cancellation = new CancellationSource();
  try {
    const opened = await persistence.openFile(path, documentId, cancellation.token);
    if (!opened.ok) {
      process.stderr.write(`xi: cannot open ${path}: ${opened.error.kind}\n`);
      return undefined;
    }
    if (opened.value.kind !== 'editable') {
      process.stderr.write(`xi: cannot edit ${path}: ${opened.value.document.reason}\n`);
      return undefined;
    }
    // E13 crash recovery: a checkpoint from a previous session that never reached a clean
    // save/quit takes over only when the file on disk has not changed since that
    // checkpoint's own baseline -- an unexpected external change always wins, so a crash
    // never silently overwrites someone else's newer edit with older recovered content.
    const recovered = await persistence.recover(path, documentId, cancellation.token);
    if (recovered.ok && recovered.value.kind === 'recovered') {
      process.stderr.write(`xi: recovered unsaved changes for ${path} from an earlier session that did not exit cleanly\n`);
      marker('XI_RECOVERY', { path, kind: 'recovered' });
      return recovered.value.document;
    }
    if (recovered.ok && recovered.value.kind === 'disk-diverged') {
      process.stderr.write(`xi: a recovery checkpoint exists for ${path} but the file changed on disk since; opened the current file instead\n`);
      marker('XI_RECOVERY', { path, kind: 'disk-diverged' });
    }
    return opened.value.document;
  } finally {
    cancellation.dispose();
  }
}

async function populateFileIndex(index: FilePathIndex, filesystem: NodeFilesystemPort, root: string): Promise<void> {
  const cancellation = new CancellationSource();
  try {
    await filesystem.enumerateFiles(root, cancellation.token, (entries) => {
      const indexed = entries.map((entry) => ({ rootId: 'workspace' as const, relativePath: entry.relativePath, absolutePath: entry.absolutePath, hidden: entry.hidden }));
      index.addPaths('workspace', indexed);
    }, { maxEntries: 120_000 });
  } finally {
    index.markReady();
    cancellation.dispose();
  }
}

/** Compose the platform adapter into the service-owned Explorer contract. `onChanged` (piggybacking
 * on the same watch subscription the explorer already owns) lets the composition root coalesce a
 * Git status refresh onto workspace filesystem activity without a second watcher. */
function createExplorerFilesystem(filesystem: NodeFilesystemPort, root: string, onChanged?: () => void): ExplorerFilesystemPort {
  return {
    async enumerateDirectory(path, cancellation): Promise<Result<readonly ExplorerDirectoryEntry[], ExplorerFailure>> {
      const result = await filesystem.enumerateDirectory(path, root, cancellation);
      if (!result.ok) return { ok: false, error: toExplorerFailure(result.error, path) };
      return { ok: true, value: Object.freeze(result.value.map(toExplorerEntry)) };
    },
    async watchDirectory(path, listener, cancellation) {
      const watched = await filesystem.watchDirectory(path, (event) => { onChanged?.(); listener(toExplorerWatchEvent(event, root)); }, cancellation);
      if (!watched.ok) return { ok: false, error: toExplorerFailure(watched.error, path) };
      return watched;
    },
  };
}

/** Maps a Git status entry onto the explorer's decoration vocabulary; `git.<state>` color
 * tokens follow the same naming already exercised by tests/e2e/t040-explorer.test.ts. */
function toExplorerGitDecoration(entry: { readonly state: string; readonly staged: boolean; readonly unstaged: boolean; readonly conflict: boolean }): { readonly state: 'modified' | 'staged' | 'untracked' | 'ignored' | 'conflicted'; readonly label: string; readonly colorToken: string } {
  const label = entry.state === 'added' ? 'A' : entry.state === 'deleted' ? 'D' : entry.state === 'renamed' ? 'R' : entry.state === 'untracked' ? 'U' : entry.state === 'ignored' ? 'I' : entry.state === 'conflicted' ? 'C' : 'M';
  const state = entry.conflict ? 'conflicted' : entry.state === 'untracked' ? 'untracked' : entry.state === 'ignored' ? 'ignored' : entry.staged && !entry.unstaged ? 'staged' : 'modified';
  return { state, label, colorToken: `git.${state}` };
}

/** Read-only adapter from the polled `GitStatusService` snapshot to ExplorerTree's per-path
 * decoration port; ExplorerTree calls this lazily (on node add/refresh), so a decoration can
 * lag the most recent `git.refresh()` by up to one coalesced refresh window. */
function createGitDecorationPort(service: InstanceType<GitServices['GitStatusService']>, root: string): { read(path: string): Promise<Result<{ readonly state: 'modified' | 'staged' | 'untracked' | 'ignored' | 'conflicted'; readonly label: string; readonly colorToken: string } | undefined, ExplorerFailure>> } {
  return {
    async read(path: string) {
      const snapshot = service.snapshot;
      if (snapshot === undefined) return { ok: true, value: undefined };
      const relative = relativeWorkspacePath(root, path);
      const entry = snapshot.entries.find((candidate) => candidate.path === relative);
      return { ok: true, value: entry === undefined ? undefined : toExplorerGitDecoration(entry) };
    },
  };
}

function toExplorerEntry(entry: WorkspaceDirectoryEntry): ExplorerDirectoryEntry {
  return {
    name: entry.name,
    relativePath: entry.relativePath,
    kind: entry.kind,
    hidden: entry.hidden,
    ignored: entry.ignored,
    ...(entry.stableIdentity === undefined ? {} : { stableIdentity: entry.stableIdentity }),
    ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
    ...(entry.modifiedMilliseconds === undefined ? {} : { modifiedMilliseconds: entry.modifiedMilliseconds }),
    ...(entry.symlinkTarget === undefined ? {} : { symlinkTarget: entry.symlinkTarget }),
  };
}

function toExplorerWatchEvent(event: WorkspaceDirectoryWatchEvent, root: string): import('../../../packages/services/src/entrypoints/launch').ExplorerWatchEvent {
  const relativePath = relativeWorkspacePath(root, event.path);
  if (event.kind === 'overflow') return { kind: 'overflow', rootId: 'workspace', relativePath };
  return { kind: 'changed', rootId: 'workspace', relativePath };
}

function relativeWorkspacePath(root: string, path: string): string {
  if (path === root) return '';
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length).replaceAll('\\', '/') : '';
}

function toExplorerFailure(error: { readonly code: string; readonly message: string }, path: string): ExplorerFailure {
  if (error.code === 'EACCES' || error.code === 'EPERM') return { kind: 'permission-denied', path, message: error.message };
  if (error.code === 'ABORT_ERR' || error.code === 'ECANCELED' || error.code === 'cancelled') return { kind: 'cancelled', message: error.message };
  return { kind: 'filesystem', path, message: error.message };
}

interface LauncherKeyEvent {
  readonly name: string;
  readonly raw: string;
  readonly shift: boolean;
  readonly option: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
}

// XI_FORMATTER_COMMAND/XI_FORMATTER_ARGS stay a hard override (tests/e2e/t055-formatting-pty.py
// relies on them); with no env override, the buffer's languages.toml [[language]].formatter
// entry (if any) selects the external formatter for that language.
function createFormatterPipelineFromEnvironment(
  workspaceRoot: string,
  Pipeline: typeof import('../../../packages/services/src/entrypoints/launch').FormatterPipeline,
  createExternal: typeof import('../../../packages/services/src/entrypoints/launch').createExternalFormatter,
  Process: typeof import('../../../packages/platform/src/entrypoints/launch').NodeProcessPort,
  configuredFormatter?: { readonly command: string; readonly args: readonly string[] },
): FormatterPipeline | undefined {
  const envCommand = process.env.XI_FORMATTER_COMMAND?.trim();
  let command = envCommand;
  let args: string[] = [];
  if (command === undefined || command.length === 0) {
    if (configuredFormatter === undefined || configuredFormatter.command.trim().length === 0) return undefined;
    command = configuredFormatter.command;
    args = [...configuredFormatter.args];
  } else {
    const rawArgs = process.env.XI_FORMATTER_ARGS;
    if (rawArgs !== undefined) {
      try {
        const decoded: unknown = JSON.parse(rawArgs);
        if (!Array.isArray(decoded) || !decoded.every((value): value is string => typeof value === 'string')) throw new TypeError('formatter args must be a JSON string array');
        args = [...decoded];
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'formatter args are invalid';
        process.stderr.write(`xi: formatter failed: ${message}\n`);
        marker('XI_FORMAT_ERROR', { kind: 'failed', message });
        return undefined;
      }
    }
  }
  return new Pipeline([createExternal({
    id: 'xi.environment-formatter',
    command,
    args,
    process: new Process(),
    cwd: workspaceRoot,
    env: processEnvironment(),
  })]);
}

function resolveFileArgument(argument: string): { readonly path: string; readonly label: string; readonly line?: number } {
  const match = /^(.*):(\d+)$/u.exec(argument);
  const given = match?.[1] ?? argument;
  const separator = Math.max(given.lastIndexOf('/'), given.lastIndexOf('\\'));
  const label = given.slice(separator + 1) || given;
  // Resolve to an absolute-looking path so this buffer's stored path is directly
  // comparable (via filesystem.workspaceRelativePath, which normalizes with
  // node:path's own resolve()) with every other subsystem's absolute/workspace-
  // relative paths (picker index, Explorer, search, LSP) -- a bare relative CLI
  // argument previously stayed relative and silently failed those comparisons,
  // producing a duplicate buffer for the same file when reopened via the picker.
  // Architecture forbids importing node:path outside packages/platform, so this is
  // a plain prefix join; workspaceRelativePath's own resolve() finishes normalizing
  // any '.'/'..' segments whenever it's actually compared against another path.
  const path = given.startsWith('/') ? given : `${process.cwd()}/${given}`;
  return match === null ? { path, label } : { path, label, line: Number(match[2]) };
}

/** The standard XDG-style `~/.config/xi/` convention every config file (theme state,
 * config.toml, languages.toml) lives under; never throws, since a missing/unreadable/corrupt
 * file must never block startup. */
function themeStateDirectory(): string {
  return `${process.env.HOME ?? process.cwd()}/.config/xi`;
}
function themeStatePath(): string {
  return `${themeStateDirectory()}/state.json`;
}

/** Read `config.toml` and `languages.toml` from the config directory (both optional -- a
 * missing file just means "use defaults", not an error) and compile them through
 * `packages/services/config`'s validated TOML parsers. A parse/schema failure is reported and
 * falls back to defaults rather than blocking startup or partially applying a broken file. */
async function loadStartupConfig(filesystem: NodeFilesystemPort, cancellation: CancellationSource): Promise<CompiledXiConfig | undefined> {
  const configModule = await import('../../../packages/services/src/entrypoints/config');
  const directory = themeStateDirectory();
  const layers: import('../../../packages/services/src/entrypoints/config').ConfigLayer[] = [
    { name: 'defaults', kind: 'defaults', source: configModule.DEFAULT_CONFIG_TOML, fileName: 'config/default.toml' },
  ];
  const configToml = await filesystem.readFile(`${directory}/config.toml`, cancellation.token);
  if (configToml.ok) layers.push({ name: 'user', kind: 'user', source: new TextDecoder('utf-8').decode(configToml.value), fileName: 'config.toml' });
  const languagesToml = await filesystem.readFile(`${directory}/languages.toml`, cancellation.token);
  if (languagesToml.ok) layers.push({ name: 'languages', kind: 'language', source: new TextDecoder('utf-8').decode(languagesToml.value), fileName: 'languages.toml' });
  const compiled = configModule.compileConfig(layers);
  if (!compiled.ok) {
    for (const diagnostic of compiled.error.diagnostics) process.stderr.write(`xi: config: ${diagnostic.message}\n`);
    return undefined;
  }
  return compiled.value;
}

/** Build a full WorkbenchTheme from a parsed theme.toml's free-form token table, requiring
 * every core field explicitly (never partially applies) -- returns undefined, not a
 * partially-filled theme, if any required token is missing. */
/** Token names use the dotted, lowercase convention packages/services/config/index.ts's own
 * DEFAULT_THEME_TOML and tests/config/t036-config.test.ts already established for the optional
 * editor-layer tokens (selection.primary, cursor.primary, motion.trail, operator.preview) --
 * extended with the same style for the required base surface tokens, which that example never
 * covered. A flat/camelCase-named theme.toml is deliberately rejected, not silently accepted
 * under two incompatible naming schemes. */
function workbenchThemeFromTokens(tokens: Readonly<Record<string, string>>, hasRequiredTokens: (tokens: Readonly<Record<string, string>>) => boolean): WorkbenchTheme | undefined {
  if (!hasRequiredTokens(tokens)) return undefined;
  const background = tokens.background as string;
  const surface = tokens.surface as string;
  const surfaceActive = tokens['surface.active'] as string;
  const foreground = tokens.foreground as string;
  const muted = tokens.muted as string;
  const border = tokens.border as string;
  const accent = tokens.accent as string;
  const error = tokens.error as string;
  return Object.freeze({
    background, surface, surfaceActive, foreground, muted, border, accent, error,
    ...(tokens['selection.primary'] === undefined ? {} : { selectionPrimary: tokens['selection.primary'] }),
    ...(tokens['selection.secondary'] === undefined ? {} : { selectionSecondary: tokens['selection.secondary'] }),
    ...(tokens['cursor.primary'] === undefined ? {} : { cursorPrimary: tokens['cursor.primary'] }),
    ...(tokens['cursor.secondary'] === undefined ? {} : { cursorSecondary: tokens['cursor.secondary'] }),
    ...(tokens['motion.trail'] === undefined ? {} : { motionTrail: tokens['motion.trail'] }),
    ...(tokens['operator.preview'] === undefined ? {} : { operatorPreview: tokens['operator.preview'] }),
  });
}

/** Discover user theme.toml files under ~/.config/xi/themes/, and adapt the parsed token
 * tables (owned by `packages/services/config`'s `discoverCustomThemeConfigs`) into the UI's
 * `WorkbenchTheme` launch shape -- the one piece of this that is composition-root wiring, not
 * a services-owned algorithm, since only main.ts knows the UI's launch type. */
interface LoadedCustomTheme { readonly label: string; readonly theme: WorkbenchTheme; }
async function discoverCustomThemes(filesystem: NodeFilesystemPort, cancellation: CancellationSource): Promise<ReadonlyMap<string, LoadedCustomTheme>> {
  const directory = `${themeStateDirectory()}/themes`;
  const { discoverCustomThemeConfigs, hasRequiredWorkbenchThemeTokens } = await import('../../../packages/services/src/entrypoints/theme');
  const { themes: discovered, diagnostics } = await discoverCustomThemeConfigs(filesystem, directory, cancellation.token);
  for (const diagnostic of diagnostics) process.stderr.write(`xi: ${diagnostic.message}\n`);
  const themes = new Map<string, LoadedCustomTheme>();
  for (const [id, discoveredTheme] of discovered) {
    const theme = workbenchThemeFromTokens(discoveredTheme.tokens, hasRequiredWorkbenchThemeTokens);
    if (theme === undefined) {
      process.stderr.write(`xi: theme file ${id}.toml is missing one or more required tokens (background, surface, surface.active, foreground, muted, border, accent, error)\n`);
      continue;
    }
    themes.set(id, { label: discoveredTheme.name, theme });
  }
  return themes;
}

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'xi-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function languageIdForPath(path: string | undefined): string | undefined {
  const extension = path?.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (extension === 'ts' || extension === 'tsx') return 'typescript';
  if (extension === 'js' || extension === 'mjs' || extension === 'cjs' || extension === 'jsx') return 'javascript';
  return undefined;
}

function readDocumentText(document: TextFileDocument): string | undefined {
  const content = fullDocumentText(document.snapshot());
  return content.ok ? content.value : undefined;
}

function fullDocumentText(snapshot: DocumentSnapshot): Result<string, { readonly kind: string }> {
  const start = asUtf16Offset(0);
  const end = asUtf16Offset(snapshot.lengthUtf16);
  if (!start.ok || !end.ok) return { ok: false, error: { kind: 'invalid-range' } };
  const content = snapshot.slice(start.value, end.value);
  return content.ok ? content : { ok: false, error: { kind: content.error.kind } };
}

function processEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  return Object.freeze(environment);
}


main().catch((error: unknown) => {
  process.stderr.write(`xi: fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
