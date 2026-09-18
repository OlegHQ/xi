import { asIdentifier, asUtf16Offset, CancellationSource, type DocumentId, type Disposable, type ViewId, type Result } from '../../../../packages/primitives/src/entrypoints/launch';
import type { DocumentSnapshot, TextFileDocument } from '../../../../packages/document/src/entrypoints/launch';
import type { NodeFilesystemPort, NodeProcessPort, WorkspaceDirectoryEntry, WorkspaceDirectoryWatchEvent, createNodeClock } from '../../../../packages/platform/src/entrypoints/launch';
import type { WorkbenchTheme } from '../../../../packages/ui/src/entrypoints/launch';
import type {
  FilePathIndex,
  PersistenceService,
  PickerEntry,
  ExplorerDirectoryEntry,
  ExplorerFailure,
  ExplorerFilesystemPort,
  FormatterPipeline,
} from '../../../../packages/services/src/entrypoints/launch';
import {
  BufferHost,
  CompletionSnippetController,
  ExplorerController,
  languageIdForPath,
  LanguageOverlayController,
  PickerController,
  ProblemsController,
  SaveCoordinator,
  SearchController,
  WorkbenchHostCommands,
  SidebarController,
  WorkbenchInputRouter,
  WorkbenchPointerRouter,
  WorkspaceEditsController,
  WorkbenchSession,
  ContributionRegistry,
  CommandRegistry,
  DEFAULT_NATIVE_EX_COMMANDS,
  WorkbenchPointerCapture,
  scrollViewBy,
  DirectoryDraftController,
} from '../../../../packages/workbench/src/entrypoints/launch';
import { DirectoryDraft, JournaledFilesystemOperations, type DirectoryOperationPlan } from '../../../../packages/services/src/entrypoints/files';
import { resolveFormatOnSave, resolveFormatterSelection } from '../../../../packages/services/src/entrypoints/config';
import type { LanguageConfig, LanguageServerConfig, loadStartupXiConfig } from '../../../../packages/services/src/entrypoints/config';
import { SyntaxDocumentTracker } from '../../../../packages/services/src/entrypoints/syntax';
import { createBundledGrammarProvider, resolveTreeSitterRuntimeOptions } from '../syntax-assets';
import type { ThemeWiring } from './theme';
import { createTaskWiring, type TaskWiring } from './tasks';
import { createLanguageWiring, type LanguageWiring } from './language';
import { createOptionalServicesWiring, type OptionalServicesWiring } from './optional-services';
import type { ResolvedFileArgument } from '../cli';

type CoreServicesModule = typeof import('../../../../packages/services/src/entrypoints/launch-core');
type UiModule = typeof import('../../../../packages/ui/src/entrypoints/launch');

/** ARCH-COMPOSITION-ROOT-01 follow-up: everything main() previously held as `let host`,
 * `let saveCoordinator`, `let hostCommands`, `let inputRouter`, `let pointerRouter` plus the
 * ~500 lines of feature-controller construction between them. This module is the mechanical
 * extraction of that block -- same construction order, same closures for the genuinely
 * circular callbacks (workbench <-> host <-> saveCoordinator/hostCommands/inputRouter), no new
 * abstractions. */
export interface ControllersDeps {
  readonly filesystem: NodeFilesystemPort;
  readonly clock: ReturnType<typeof createNodeClock>;
  readonly persistence: PersistenceService;
  readonly document: TextFileDocument;
  readonly filePath: ResolvedFileArgument | undefined;
  readonly languageId: string | undefined;
  readonly NodeProcessPort: typeof NodeProcessPort;
  readonly createClock: typeof createNodeClock;
  readonly positionToOffset: typeof import('../../../../packages/document/src/entrypoints/launch').positionToOffset;
  readonly openDocumentAt: (path: string | undefined, documentId: DocumentId) => Promise<TextFileDocument | undefined>;
  readonly marker: (name: string, payload?: unknown) => void;
  readonly xiUiTestMarkersEnabled: boolean;
  readonly startupTrace: (label: string) => void;
  readonly startupConfigPromise: ReturnType<typeof loadStartupXiConfig>;
  readonly themeWiring: ThemeWiring;
  readonly coreServices: CoreServicesModule;
  readonly ContextMenuStore: UiModule['ContextMenuStore'];
}

export interface Controllers {
  readonly workbench: InstanceType<typeof WorkbenchSession>;
  readonly host: BufferHost;
  readonly saveCoordinator: SaveCoordinator;
  readonly hostCommands: WorkbenchHostCommands;
  readonly inputRouter: WorkbenchInputRouter;
  readonly pointerRouter: WorkbenchPointerRouter;
  readonly pointerCapture: WorkbenchPointerCapture;
  readonly picker: PickerController<PickerEntry, WorkbenchTheme>;
  readonly explorerFeature: ExplorerController;
  readonly directoryDraftController: DirectoryDraftController;
  readonly searchFeature: SearchController;
  readonly problemsFeature: ProblemsController;
  readonly overlayFeature: LanguageOverlayController;
  readonly sidebarController: SidebarController;
  readonly completionFeature: CompletionSnippetController;
  readonly workspaceEditsFeature: WorkspaceEditsController;
  readonly optionalServices: OptionalServicesWiring;
  readonly diagnostics: InstanceType<CoreServicesModule['DiagnosticStore']>;
  readonly contextMenuStore: InstanceType<UiModule['ContextMenuStore']>;
  readonly pickerModel: InstanceType<CoreServicesModule['BoundedPickerModel']>;
  readonly fileIndex: InstanceType<CoreServicesModule['FilePathIndex']>;
  readonly commandRegistry: CommandRegistry;
  readonly contributionRegistry: ContributionRegistry;
  readonly taskWiring: TaskWiring;
  readonly languageWiring: LanguageWiring;
  readonly syntaxTracker: SyntaxDocumentTracker;
  readonly syntaxAssetsCancellation: CancellationSource;
  readonly syntaxResultSubscription: Disposable;
  readonly mouseMode: { readonly registered: (toggle: () => boolean) => void; readonly toggle: () => boolean };
  readonly jobControlDisposables: Disposable[];
  readonly fileIndexStarter: { readonly schedule: () => void; readonly cancel: () => void };
  readonly ensureGitAndOpenPicker: () => Promise<void>;
}

export function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'xi-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** Small mutable cell for the renderer's own mouse-toggle callback, which only exists once
 * `runOpenTuiWorkbench` registers it -- a tiny owned object instead of a `main()`-scoped `let`. */
function createMouseModeToggle(): { readonly registered: (toggle: () => boolean) => void; readonly toggle: () => boolean } {
  let current: (() => boolean) | undefined;
  return {
    registered: (toggle) => { current = toggle; },
    toggle: () => current?.() ?? true,
  };
}

/** A single deferred one-shot call, cancellable -- replaces a bare `let ...Timer` +
 * `clearTimeout` pair with one owned handle. */
function createDeferredStart(delayMilliseconds: number, start: () => void): { readonly schedule: () => void; readonly cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule: () => { timer = setTimeout(() => { timer = undefined; start(); }, delayMilliseconds); },
    cancel: () => clearTimeout(timer),
  };
}

async function populateFileIndex(index: InstanceType<CoreServicesModule['FilePathIndex']>, filesystem: NodeFilesystemPort, root: string): Promise<void> {
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

/** A single lazily-started, memoized population run -- replaces a bare `let ...Population`
 * closure with one owned handle. */
function createFileIndexPopulator(fileIndex: InstanceType<CoreServicesModule['FilePathIndex']>, filesystem: NodeFilesystemPort, root: string, onDone: () => void): () => Promise<void> {
  let population: Promise<void> | undefined;
  return () => {
    population ??= populateFileIndex(fileIndex, filesystem, root).then(onDone);
    return population;
  };
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

/** Maps a Git status entry onto the explorer's decoration vocabulary; `git.<state>` color
 * tokens follow the same naming already exercised by tests/e2e/t040-explorer.test.ts. */
function toExplorerGitDecoration(entry: { readonly state: string; readonly staged: boolean; readonly unstaged: boolean; readonly conflict: boolean }): { readonly state: 'modified' | 'staged' | 'untracked' | 'ignored' | 'conflicted'; readonly label: string; readonly colorToken: string } {
  const label = entry.state === 'added' ? 'A' : entry.state === 'deleted' ? 'D' : entry.state === 'renamed' ? 'R' : entry.state === 'untracked' ? 'U' : entry.state === 'ignored' ? 'I' : entry.state === 'conflicted' ? 'C' : 'M';
  const state = entry.conflict ? 'conflicted' : entry.state === 'untracked' ? 'untracked' : entry.state === 'ignored' ? 'ignored' : entry.staged && !entry.unstaged ? 'staged' : 'modified';
  return { state, label, colorToken: `git.${state}` };
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

function toExplorerWatchEvent(event: WorkspaceDirectoryWatchEvent, root: string): import('../../../../packages/services/src/entrypoints/launch').ExplorerWatchEvent {
  const relativePath = relativeWorkspacePath(root, event.path);
  if (event.kind === 'overflow') return { kind: 'overflow', rootId: 'workspace', relativePath };
  return { kind: 'changed', rootId: 'workspace', relativePath };
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

/** Read-only adapter from the polled `GitStatusService` snapshot to ExplorerTree's per-path
 * decoration port; ExplorerTree calls this lazily (on node add/refresh), so a decoration can
 * lag the most recent `git.refresh()` by up to one coalesced refresh window. */
function createGitDecorationPort(service: { readonly snapshot: { readonly entries: readonly { readonly path: string; readonly state: string; readonly staged: boolean; readonly unstaged: boolean; readonly conflict: boolean }[] } | undefined }, root: string): { read(path: string): Promise<Result<{ readonly state: 'modified' | 'staged' | 'untracked' | 'ignored' | 'conflicted'; readonly label: string; readonly colorToken: string } | undefined, ExplorerFailure>> } {
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

/** Constructs BufferHost, SaveCoordinator, HostCommands, InputRouter, PointerRouter and every
 * picker/explorer/search/problems/directory/sidebar controller in one call, in dependency
 * order, resolving the genuinely-circular ones (`host` <-> `workbench`/`saveCoordinator`/
 * `hostCommands`/`inputRouter`) with `let` forward declarations exactly as main() did before
 * this extraction. */
export async function createControllers(deps: ControllersDeps): Promise<Controllers> {
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
  } = deps.coreServices;
  const { filesystem, clock, persistence, document, filePath, languageId, marker } = deps;
  let host: BufferHost;
  // Constructed once the feature controllers they delegate to exist (below); every
  // reference to them before that point is a closure invoked only later, matching the
  // existing `host` forward-declaration pattern.
  let saveCoordinator: SaveCoordinator;
  let hostCommands: WorkbenchHostCommands;
  let inputRouter: WorkbenchInputRouter;
  let pointerRouter: WorkbenchPointerRouter;
  const mouseMode = createMouseModeToggle();
  const jobControlDisposables: Disposable[] = [];
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
      languageWiring.changeDocument(change);
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
  syntaxTracker.openDocument({ documentId: document.id, languageId, snapshot: document.snapshot() });
  deps.startupTrace('workbench');
  const workspaceRoot = process.cwd();
  // Config finished loading (started above, in parallel with the rest of startup) by the time
  // any of it is actually needed: format-on-save/formatter selection here, and language-server
  // selection inside languageWiring below.
  const startupLoaded = await deps.startupConfigPromise;
  for (const message of startupLoaded.diagnostics) process.stderr.write(`xi: config: ${message}\n`);
  const startupConfig = startupLoaded.config;
  const configuredLanguages = startupConfig?.languages;
  const formatOnSave = resolveFormatOnSave(process.env, languageId !== undefined && (configuredLanguages?.find((entry) => entry.name === languageId)?.autoFormat ?? false));
  const diagnostics = new DiagnosticStore();
  const contextMenuStore = new deps.ContextMenuStore();
  const languageWiring = createLanguageWiring({
    filesystem,
    ProcessPort: deps.NodeProcessPort,
    createClock: deps.createClock,
    workspaceRoot,
    fileUri,
    processEnvironment,
    diagnostics,
    configuredLanguages,
    configuredLanguageServers: startupConfig?.languageServers,
    launchDocument: document,
    launchDocumentPath: filePath?.path,
    readDocumentText,
    workbenchBuffers: () => workbench.buffers(),
    renameBufferPath: (bufferId, path) => workbench.renameBufferPath(bufferId, path),
  });
  // On-demand rendering only paints after a keypress/resize/pointer event requests a frame.
  // Every service/model subscription below that can change what a surface reads (diagnostics,
  // explorer, search, picker, outline/hover/completion/signature, task output, file index) must
  // notify `host` so the next tick's frame reflects it even without further input.
  diagnostics.subscribe(() => host.notifySurfaceChange());
  const syntaxResultSubscription = syntaxTracker.onResult((result) => {
    // spans are lazy/windowed now: sample the first 4,096 units instead of the O(document) spans getter.
    if (deps.xiUiTestMarkersEnabled) marker('XI_SYNTAX_STATE', { documentId: result.documentId, version: result.documentVersion, status: result.status, spanCount: result.spansInRange(0, 4096).length });
    host.notifySurfaceChange();
  });
  const taskWiring = createTaskWiring({ filesystem, ProcessPort: deps.NodeProcessPort, notifySurfaceChange: () => host.notifySurfaceChange() });
  const fileIndex = new FilePathIndex({ maxEntries: 120_000 });
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
      ...deps.themeWiring.themeController.customThemeEntries().map(({ id: customId, label }) => ({ id: customId, label, detail: '', value: customId })),
    ].sort((left, right) => left.label.localeCompare(right.label)), 'theme'),
    new StaticPickerProvider('xi.navigation.config', 'config', [{ id: 'config.open', mode: 'config', label: 'Open config', value: 'config.open' }]),
    // Live source: the changed-files list follows the git wiring's snapshot, which is only
    // constructed lazily (see `optionalServices.ensure()`); until then this reads as empty.
    new BufferPickerProvider('xi.navigation.git', () => {
      const snapshot = optionalServices.gitStatusService?.snapshot;
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
    openDocument: async (path, documentId) => (path === undefined ? undefined : await directoryDraftController.openDocumentIfDirectory(path, documentId)) ?? deps.openDocumentAt(path, documentId),
    workspaceRelativePath: (path) => filesystem.workspaceRelativePath(workspaceRoot, path),
    marker,
    launchViewId: id<ViewId>('xi-launch-view'),
    ...(filePath?.line === undefined ? {} : { launchInitialLine: filePath.line }),
    onMessage: (message) => process.stderr.write(message),
    clock,
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
      languageWiring.admitBufferToLanguageSession(buffer.path, buffer.documentId, buffer.document);
    },
    onBufferClosed: (buffer) => {
      persistence.closeDocument(buffer.documentId);
      syntaxTracker.closeDocument(buffer.documentId);
      directoryDraftController.closeDocument(buffer.documentId);
      languageWiring.releaseBufferFromLanguageSession(buffer.path);
    },
  });
  const optionalServices = createOptionalServicesWiring({
    filesystem,
    ProcessPort: deps.NodeProcessPort,
    workspaceRoot,
    fileUri,
    processEnvironment,
    notifySurfaceChange: () => host.notifySurfaceChange(),
    createExplorerFilesystem,
    createGitDecorationPort,
    getExplorerFeature: () => explorerFeature,
    getSearchFeature: () => searchFeature,
  });
  const picker = new PickerController<PickerEntry, WorkbenchTheme>({
    host,
    model: pickerModel,
    theme: deps.themeWiring.themeController,
    clock,
    marker,
    startFileIndexPopulation: () => startFileIndexPopulation(),
    toggleMouseMode: mouseMode.toggle,
    openFile: (path, preview) => host.openBufferAtPath(path, { preview }),
    onSecondaryAction: (entry, key) => {
      const coordinator = optionalServices.gitMutationCoordinator;
      const status = optionalServices.gitStatusService;
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
  // T041/T042: directory-as-editable-text ("Space O", docs/plan/03-ux.md). All orchestration
  // (map of open drafts, review-plan apply, Enter/Esc routing) lives in the workbench
  // controller below -- this composition root only constructs it with structural ports
  // (ARCH-COMPOSITION-ROOT-01 forbids feature-state/handlers living inside `main()` itself).
  // Also used by the explorer controller below for crash-recoverable rename/copy/trash.
  const journaledFileOperations = new JournaledFilesystemOperations(filesystem, { trashRoot: `${workspaceRoot}/.xi-trash` });
  const explorerFeature = new ExplorerController({
    host,
    session: workbench,
    filesystem,
    fileOperations: journaledFileOperations,
    clock,
    marker,
    onError: (message) => process.stderr.write(message),
    workspaceRelativePath: (path) => filesystem.workspaceRelativePath(workspaceRoot, path),
    trashDirectory: `${workspaceRoot}/.xi-trash`,
    ensureServices: () => optionalServices.ensure(),
  });
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
    ensureServices: () => optionalServices.ensure(),
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
    readTasksConfig: taskWiring.readTasksConfig,
    matchTaskProblems: taskWiring.matchTaskProblems,
    ensureTaskController: taskWiring.ensureTaskController,
  });
  const overlayFeature = new LanguageOverlayController({
    host,
    session: workbench,
    fileUri,
    marker,
    ensureLanguage: () => languageWiring.ensureLanguage(),
  });
  const sidebarController = new SidebarController({
    outline: { get hasSymbols() { return overlayFeature.outlineRead.model.symbols.length > 0; } },
  });
  const completionFeature = new CompletionSnippetController({
    host,
    session: workbench,
    marker,
    onError: (message) => process.stderr.write(message),
    fileUri,
    positionToOffset: deps.positionToOffset,
    ensureLanguage: () => languageWiring.ensureLanguage(),
    ensureOptionalServices: () => optionalServices.ensure(),
    getSnippetSupport: () => (optionalServices.expandSnippet === undefined || optionalServices.SnippetSession === undefined ? undefined : { expandSnippet: optionalServices.expandSnippet, SnippetSession: optionalServices.SnippetSession }),
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
    ensureLanguage: () => languageWiring.ensureLanguage(),
    readDiagnostics: () => diagnostics.model.all,
    runWorkspaceEditProposal: async (proposal) => {
      const session = languageWiring.session;
      const coordinator = languageWiring.workspaceEditCoordinator;
      const provider = languageWiring.workspaceEditProvider;
      const executor = languageWiring.workspaceEditExecutor;
      if (coordinator === undefined || provider === undefined || executor === undefined || session === undefined) {
        return { ok: false, error: { kind: 'disposed', message: 'workspace edit coordinator is unavailable' } };
      }
      const language = await import('../../../../packages/services/src/entrypoints/language');
      return language.applyWorkspaceEditProposal(proposal, {
        coordinator,
        provider,
        session,
        resolveTarget: async (uri) => (await executor.resolveDocument(uri))?.target,
      });
    },
    renameWithRetry: async (request, newName, rename, options) => {
      const language = await import('../../../../packages/services/src/entrypoints/language');
      return language.renameWithBoundedRetry(request, newName, rename, options);
    },
    ensureCodeActionExecutor: async () => {
      if (optionalServices.executeLanguageCodeAction !== undefined) return optionalServices.executeLanguageCodeAction;
      await optionalServices.ensure();
      return optionalServices.executeLanguageCodeAction;
    },
  });
  languageWiring.connect({ getBufferDocument: (documentId) => host.documents.get(documentId), overlayFeature, completionFeature, workspaceEditsFeature });
  const pointerCapture = new WorkbenchPointerCapture({
    cancelPendingOperator: () => { host.activeSession()?.cancelPendingOperator(); },
    place: (intent) => {
      const session = host.sessions.get(intent.viewId as ViewId);
      const applied = session?.placePointer(intent) ?? false;
      if (deps.xiUiTestMarkersEnabled) {
        const state = session?.readView(intent.viewId as ViewId);
        marker('XI_POINTER_STATE', { kind: intent.kind, applied, viewId: intent.viewId, row: intent.head.row, column: intent.head.column, target: intent.head.target, mode: state?.session.mode, selectionCount: state?.selections.members.length, selectionKinds: state?.selections.members.map((member) => member.kind) });
      }
    },
    scroll: (viewId, delta, viewportHeight) => {
      const result = scrollViewBy(workbench, (viewIdentifier) => host.sessions.get(viewIdentifier), viewId as ViewId, delta, viewportHeight);
      marker('XI_POINTER_SCROLL', { viewId, delta, scrollTop: result?.scrollTop });
    },
  });

  saveCoordinator = new SaveCoordinator({
    host,
    session: workbench,
    persistence,
    clock,
    marker,
    onError: (message) => process.stderr.write(message),
    formatOnSave,
    createFormatterPipeline: async () => {
      const { FormatterPipeline, createExternalFormatter } = await import('../../../../packages/services/src/entrypoints/formatting');
      const configuredFormatter = languageId === undefined ? undefined : configuredLanguages?.find((entry) => entry.name === languageId)?.formatter;
      return createFormatterPipelineFromEnvironment(workspaceRoot, FormatterPipeline, createExternalFormatter, deps.NodeProcessPort, marker, configuredFormatter);
    },
    onSaved: () => { void optionalServices.gitStatusService?.refresh(); },
  });
  hostCommands = new WorkbenchHostCommands({
    host,
    session: workbench,
    filesystem,
    marker,
    onError: (message) => process.stderr.write(message),
    workspaceRoot,
    workspacePathFromUri,
    ensureHostNavigation: () => optionalServices.ensure(),
    readHostNavigation: () => optionalServices.hostNavigation,
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
    isExplorerServiceLoaded: () => optionalServices.explorerTree !== undefined,
    isSearchServiceLoaded: () => optionalServices.searchService !== undefined,
    ensureOptionalServices: () => optionalServices.ensure(),
    toggleMouseMode: mouseMode.toggle,
    launchViewId: id<ViewId>('xi-launch-view'),
    bindings: startupConfig?.bindings ?? [],
    scrollLines: startupConfig?.editor.mouse.scrollLines ?? 1,
    getViewportHeight: () => {
      const active = workbench.activeViewId;
      const reported = active === undefined ? undefined : workbench.viewViewportHeight(active);
      return reported ?? Math.max(1, (process.stdout.rows ?? 24) - 2);
    },
    clock,
  });
  pointerRouter = new WorkbenchPointerRouter({
    session: workbench,
    marker,
    clock,
    onTabActivate: (bufferId) => { workbench.activateBuffer(id<DocumentId>(bufferId)); host.notifySurfaceChange(); },
    onTabPin: (bufferId) => { workbench.pinBuffer(id<DocumentId>(bufferId)); host.notifySurfaceChange(); },
    // `closeBuffer` with no decision closes a clean buffer immediately and returns a
    // `dirty-buffer` error (no side effect) for one with unsaved changes -- the tab close
    // glyph never silently discards edits; a dirty buffer just stays open until saved.
    onTabClose: (bufferId) => { if (workbench.closeBuffer(id<DocumentId>(bufferId)).ok) host.notifySurfaceChange(); },
    sidebar: {
      beginResize: () => sidebarController.beginResize(),
      moveResize: (width) => { sidebarController.moveResize(width); host.notifySurfaceChange(); },
      commitResize: () => { sidebarController.commitResize(); host.notifySurfaceChange(); },
    },
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
      readModel: () => optionalServices.searchService?.model,
      setSelectedIndex: (index) => searchFeature.setSelectedIndex(index),
      openMatch: (match) => searchFeature.openMatch(match),
    },
    problems: {
      get model() { return diagnostics.model; },
      setSelectedProblemIndex: (index) => problemsFeature.setSelectedProblemIndex(index),
      openProblem: (problem) => problemsFeature.openProblem(problem),
    },
  });

  // Deferred until every controller `onPrefixStateChange`/`onCommandLineChange` delegates to
  // (`inputRouter`, constructed above) exists: `createSession`'s initial state publish can
  // invoke those callbacks synchronously.
  host.createSession(document, id<ViewId>('xi-launch-view'));

  const fileIndexStarter = createDeferredStart(1000, () => { void startFileIndexPopulation(); });
  const startFileIndexPopulation = createFileIndexPopulator(fileIndex, filesystem, workspaceRoot, () => host.notifySurfaceChange());
  async function ensureGitAndOpenPicker(): Promise<void> {
    await optionalServices.ensure();
    void optionalServices.gitStatusService?.refresh();
    picker.open('git');
  }

  return {
    workbench,
    host,
    saveCoordinator,
    hostCommands,
    inputRouter,
    pointerRouter,
    pointerCapture,
    picker,
    explorerFeature,
    directoryDraftController,
    searchFeature,
    problemsFeature,
    overlayFeature,
    sidebarController,
    completionFeature,
    workspaceEditsFeature,
    optionalServices,
    diagnostics,
    contextMenuStore,
    pickerModel,
    fileIndex,
    commandRegistry,
    contributionRegistry,
    taskWiring,
    languageWiring,
    syntaxTracker,
    syntaxAssetsCancellation,
    syntaxResultSubscription,
    mouseMode,
    jobControlDisposables,
    fileIndexStarter,
    ensureGitAndOpenPicker,
  };
}

/** XI_FORMATTER_COMMAND/XI_FORMATTER_ARGS stay a hard override (tests/e2e/t055-formatting-pty.py
 * relies on them); with no env override, the buffer's languages.toml [[language]].formatter
 * entry (if any) selects the external formatter for that language. Environment/config parsing
 * itself lives in packages/services/config's `resolveFormatterSelection`; this composition-root
 * helper only constructs the actual platform-backed `FormatterPipeline`. */
function createFormatterPipelineFromEnvironment(
  workspaceRoot: string,
  Pipeline: typeof import('../../../../packages/services/src/entrypoints/launch').FormatterPipeline,
  createExternal: typeof import('../../../../packages/services/src/entrypoints/launch').createExternalFormatter,
  Process: typeof NodeProcessPort,
  marker: (name: string, payload?: unknown) => void,
  configuredFormatter?: { readonly command: string; readonly args: readonly string[] },
): FormatterPipeline | undefined {
  const selection = resolveFormatterSelection(process.env, configuredFormatter);
  if (!selection.ok) {
    process.stderr.write(`xi: formatter failed: ${selection.error.message}\n`);
    marker('XI_FORMAT_ERROR', { kind: 'failed', message: selection.error.message });
    return undefined;
  }
  if (selection.value === undefined) return undefined;
  return new Pipeline([createExternal({
    id: 'xi.environment-formatter',
    command: selection.value.command,
    args: selection.value.args,
    process: new Process(),
    cwd: workspaceRoot,
    env: processEnvironment(),
  })]);
}
