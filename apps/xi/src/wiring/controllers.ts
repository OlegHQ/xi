import { asIdentifier, asUtf16Offset, CancellationSource, type DocumentId, type Disposable, type ViewId, type Result } from '../../../../packages/primitives/src/entrypoints/launch';
import type { DocumentSnapshot, TextFileDocument } from '../../../../packages/document/src/entrypoints/launch';
import { openTextDocument } from '../../../../packages/document/src/entrypoints/launch';
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
  buildNavigationRequest,
  BufferHost,
  CompletionSnippetController,
  DiffViewController,
  ExplorerController,
  GitPanelController,
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
// Routed through the git entrypoint (not a direct packages/services/git/decorations import)
// so apps/xi only ever imports services via packages/services/src/entrypoints/* -- see H2-7's
// import-graph rule. Both functions are pure/cheap module-level code (no process/filesystem
// work at import time), so statically loading this entrypoint costs a module evaluation, not
// the async round trip optional-services.ts's lazy `import('.../entrypoints/git')` avoids.
import { toExplorerGitDecoration, createGitDecorationPort } from '../../../../packages/services/src/entrypoints/git';
import { resolveFormatOnSave, resolveFormatterSelection } from '../../../../packages/services/src/entrypoints/config';
import type { CompiledConfig, LanguageConfig, LanguageServerConfig, loadStartupXiConfig } from '../../../../packages/services/src/entrypoints/config';
import { SyntaxDocumentTracker } from '../../../../packages/services/src/entrypoints/syntax';
import { createBundledGrammarProvider, resolveTreeSitterRuntimeOptions } from '../syntax-assets';
import type { StatusMessageController } from '../../../../packages/workbench/src/entrypoints/launch';
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
  readonly statusMessages: StatusMessageController;
}

export interface Controllers {
  readonly statusMessages: StatusMessageController;
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
  readonly gitPanelFeature: GitPanelController;
  readonly gitDiffFeature: DiffViewController;
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
  readonly commandAliasRegistration: Disposable | undefined;
  readonly taskWiring: TaskWiring;
  readonly languageWiring: LanguageWiring;
  readonly syntaxTracker: SyntaxDocumentTracker;
  readonly syntaxAssetsCancellation: CancellationSource;
  readonly syntaxResultSubscription: Disposable;
  readonly mouseMode: { readonly registered: (toggle: () => boolean) => void; readonly toggle: () => boolean };
  readonly jobControlDisposables: Disposable[];
  /** Helix-style picker preview: leading lines of a file, read once in the background and
   * cached; `undefined` while loading (a surface change re-renders once it lands). */
  readonly pickerPreview: (path: string) => { readonly title: string; readonly lines: readonly string[] } | undefined;
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

function toExplorerFailure(error: { readonly code: string; readonly message: string }, path: string): ExplorerFailure {
  if (error.code === 'EACCES' || error.code === 'EPERM') return { kind: 'permission-denied', path, message: error.message };
  if (error.code === 'ABORT_ERR' || error.code === 'ECANCELED' || error.code === 'cancelled') return { kind: 'cancelled', message: error.message };
  return { kind: 'filesystem', path, message: error.message };
}

function toExplorerWatchEvent(filesystem: NodeFilesystemPort, event: WorkspaceDirectoryWatchEvent, root: string): import('../../../../packages/services/src/entrypoints/launch').ExplorerWatchEvent {
  const relativePath = filesystem.workspaceRelativePath(root, event.path) ?? '';
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
      const watched = await filesystem.watchDirectory(path, (event) => { onChanged?.(); listener(toExplorerWatchEvent(filesystem, event, root)); }, cancellation);
      if (!watched.ok) return { ok: false, error: toExplorerFailure(watched.error, path) };
      return watched;
    },
  };
}

/** The handful of controllers that a closure created *before* the controller itself exists
 * must still be able to reach once that closure actually runs (e.g. `workbench`'s
 * `onDocumentChange` needs `languageWiring`, defined afterward). `createControllers` used a
 * flat `let` per circular value; splitting construction across feature functions turns each
 * of those into a field on one shared mutable record instead, assigned by the helper that
 * builds it and read (only from callbacks invoked later, never at construction time) by
 * whichever earlier helper's closure needs it -- same forward-reference shape, just crossing
 * function boundaries instead of `let` bindings in one function body. */
interface ForwardRefs {
  syntaxTracker: SyntaxDocumentTracker;
  host: BufferHost;
  saveCoordinator: SaveCoordinator;
  hostCommands: WorkbenchHostCommands;
  inputRouter: WorkbenchInputRouter;
  languageWiring: LanguageWiring;
  completionFeature: CompletionSnippetController;
  explorerFeature: ExplorerController;
  sidebarController: SidebarController;
  overlayFeature: LanguageOverlayController;
  gitPanelOpen: () => boolean;
  searchFeature: SearchController;
  gitPanelFeature: GitPanelController;
  /** Assigned by whichever wiring owns the diff view (unset until then); `GitPanelController`
   * calls it to open a diff instead of the plain file when it is present. */
  gitDiff?: { open(relativePath: string, target: 'index' | 'worktree'): Promise<void> };
  optionalServices: OptionalServicesWiring;
  directoryDraftController: DirectoryDraftController;
  startFileIndexPopulation: () => Promise<void>;
}

type StartupConfig = CompiledConfig | undefined;

/** Values every feature-construction helper below needs and none of them own; threaded
 * through as one bag instead of repeating the same six parameters on every function. */
interface BuildContext {
  readonly deps: ControllersDeps;
  readonly filesystem: NodeFilesystemPort;
  readonly clock: ReturnType<typeof createNodeClock>;
  readonly persistence: PersistenceService;
  readonly marker: (name: string, payload?: unknown) => void;
  readonly workspaceRoot: string;
  readonly startupConfig: StartupConfig;
  readonly configuredLanguages: readonly LanguageConfig[] | undefined;
  readonly formatOnSave: boolean;
}

/** Syntax tracking is constructed first and touched by almost everything else (workbench,
 * host, language wiring); grammar/runtime wasm loads lazily on the first request for a known
 * languageId, never here, so this does no filesystem or wasm work. */
function createSyntaxTracker(filesystem: NodeFilesystemPort): { readonly syntaxAssetsCancellation: CancellationSource; readonly syntaxTracker: SyntaxDocumentTracker } {
  const syntaxAssetsCancellation = new CancellationSource();
  const syntaxTracker = new SyntaxDocumentTracker({
    grammars: createBundledGrammarProvider(filesystem, syntaxAssetsCancellation.token),
    runtime: resolveTreeSitterRuntimeOptions,
  });
  return { syntaxAssetsCancellation, syntaxTracker };
}

/** The workbench session itself, plus opening the launch document into it. Its
 * `onDocumentChange`/`saveBuffer` callbacks reach `host`, `saveCoordinator`, `languageWiring`
 * and `completionFeature` only when actually invoked (after every controller below exists),
 * so they read them off `forward` rather than closing over not-yet-constructed locals. */
function createWorkbenchCore(ctx: BuildContext, forward: ForwardRefs, syntaxTracker: SyntaxDocumentTracker): WorkbenchSession {
  const { deps } = ctx;
  const { document, filePath, languageId } = deps;
  const workbench = new WorkbenchSession({
    saveBuffer: async (buffer) => {
      if (buffer.path === undefined) return { ok: false, error: 'no file name' };
      const bufferDocument = forward.host.documents.get(buffer.documentId);
      if (bufferDocument === undefined) return { ok: false, error: 'document is no longer open' };
      const saved = await forward.saveCoordinator.requestSave(bufferDocument, buffer.path, undefined);
      return saved ? { ok: true, value: undefined } : { ok: false, error: 'save failed' };
    },
    onDocumentChange: (change) => {
      syntaxTracker.changeDocument(change);
      forward.languageWiring.changeDocument(change);
      // Vim-originated commits already advanced their owning session during
      // command execution. Remapping those sessions would add avoidable work
      // to every typed character; external LSP/workspace commits still map
      // every live session sharing the document.
      if (change.origin !== 'vim') for (const session of forward.host.sessions.values()) session.applyExternalChange(change);
      forward.completionFeature.cancelSnippetOnExternalChange();
      forward.saveCoordinator.scheduleCheckpoint(change.snapshot.id);
    },
  });
  const opened = workbench.openBuffer(document, {
    ...(filePath?.path === undefined ? {} : { path: filePath.path }),
    viewId: id<ViewId>('xi-launch-view'),
  });
  if (!opened.ok) throw new Error(`xi-workbench-open:${opened.error.kind}`);
  syntaxTracker.openDocument({ documentId: document.id, languageId, snapshot: document.snapshot() });
  deps.startupTrace('workbench');
  return workbench;
}

/** Awaits the startup config (kicked off in parallel with the rest of startup, so it's
 * normally already settled by the time this runs) and derives the handful of values later
 * helpers need from it. */
async function loadStartupSettings(deps: ControllersDeps): Promise<{ readonly startupConfig: StartupConfig; readonly configuredLanguages: readonly LanguageConfig[] | undefined; readonly formatOnSave: boolean; readonly workspaceRoot: string }> {
  const workspaceRoot = process.cwd();
  const startupLoaded = await deps.startupConfigPromise;
  if (startupLoaded.diagnostics.length > 0) deps.statusMessages.publish(`xi: config: ${startupLoaded.diagnostics.join('; ')}`);
  const startupConfig = startupLoaded.config;
  const configuredLanguages = startupConfig?.languages;
  const formatOnSave = resolveFormatOnSave(process.env, deps.languageId !== undefined && (configuredLanguages?.find((entry) => entry.name === deps.languageId)?.autoFormat ?? false));
  return { startupConfig, configuredLanguages, formatOnSave, workspaceRoot };
}

/** Language-server wiring, task wiring and the surface-change subscriptions that make
 * diagnostics/syntax results repaint without further input. */
function createLanguageAndTaskWiring(
  ctx: BuildContext,
  forward: ForwardRefs,
  workbench: WorkbenchSession,
  syntaxTracker: SyntaxDocumentTracker,
  diagnostics: InstanceType<CoreServicesModule['DiagnosticStore']>,
  fileUri: CoreServicesModule['fileUri'],
): { readonly languageWiring: LanguageWiring; readonly taskWiring: TaskWiring; readonly syntaxResultSubscription: Disposable } {
  const { deps, filesystem, workspaceRoot, configuredLanguages, startupConfig, marker } = ctx;
  const { document, filePath } = deps;
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
    statusMessages: deps.statusMessages,
    marker,
  });
  forward.languageWiring = languageWiring;
  // On-demand rendering only paints after a keypress/resize/pointer event requests a frame.
  // Every service/model subscription below that can change what a surface reads (diagnostics,
  // explorer, search, picker, outline/hover/completion/signature, task output, file index) must
  // notify `host` so the next tick's frame reflects it even without further input.
  diagnostics.subscribe(() => forward.host.notifySurfaceChange());
  const syntaxResultSubscription = syntaxTracker.onResult((result) => {
    // spans are lazy/windowed now: sample the first 4,096 units instead of the O(document) spans getter.
    if (deps.xiUiTestMarkersEnabled) marker('XI_SYNTAX_STATE', { documentId: result.documentId, version: result.documentVersion, status: result.status, spanCount: result.spansInRange(0, 4096).length });
    forward.host.notifySurfaceChange();
  });
  const taskWiring = createTaskWiring({ filesystem, ProcessPort: deps.NodeProcessPort, notifySurfaceChange: () => forward.host.notifySurfaceChange() });
  return { languageWiring, taskWiring, syntaxResultSubscription };
}

/** The file index and the command/contribution registries (navigation contributions register
 * against the file index once it exists). */
async function createRegistries(ctx: BuildContext): Promise<{
  readonly fileIndex: InstanceType<CoreServicesModule['FilePathIndex']>;
  readonly commandRegistry: CommandRegistry;
  readonly contributionRegistry: ContributionRegistry;
  readonly commandAliasRegistration: Disposable | undefined;
}> {
  const { deps, workspaceRoot } = ctx;
  const { FilePathIndex, createNavigationContributionModule } = deps.coreServices;
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
  const registeredCommandIds = new Set(commandRegistry.snapshot.commands.map((entry) => String(entry.descriptor.id)));
  const configuredAliases = (ctx.startupConfig?.aliases ?? []).filter((alias) => registeredCommandIds.has(String(alias.commandId)));
  let commandAliasRegistration: Disposable | undefined;
  if (configuredAliases.length > 0) {
    const aliases = commandRegistry.register({
      commands: [],
      aliases: configuredAliases.map((alias) => ({ name: alias.name, target: { kind: 'command' as const, id: alias.commandId } })),
    });
    if (!aliases.ok) throw new Error(`xi-command-aliases:${aliases.error.kind}`);
    commandAliasRegistration = aliases.value;
  }
  return { fileIndex, commandRegistry, contributionRegistry, commandAliasRegistration };
}

/** The buffers/commands/themes/config/git picker providers. The git provider reads
 * `optionalServices.gitStatusService`, constructed after this -- via `forward`. */
function createPickerModel(
  ctx: BuildContext,
  forward: ForwardRefs,
  workbench: WorkbenchSession,
  fileIndex: InstanceType<CoreServicesModule['FilePathIndex']>,
): InstanceType<CoreServicesModule['BoundedPickerModel']> {
  const { deps, filesystem, workspaceRoot } = ctx;
  const { BoundedPickerModel, BufferPickerProvider, FilePickerProvider, StaticPickerProvider } = deps.coreServices;
  const bufferProvider = new BufferPickerProvider('xi.navigation.buffers', () => workbench.buffers().map((buffer) => Object.freeze({
    id: String(buffer.bufferId),
    label: buffer.path ?? '[No Name]',
    detail: buffer.dirty ? 'modified' : 'saved',
    value: String(buffer.bufferId),
  })));
  return new BoundedPickerModel({ providers: [
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
      const snapshot = forward.optionalServices.current?.gitStatusService.snapshot;
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
}

/** `BufferHost`: the buffer/session substrate every feature controller below is constructed
 * with. Its callbacks reach `directoryDraftController`, `saveCoordinator`, `hostCommands` and
 * `inputRouter` -- all constructed after `host` -- via `forward`. */
function createHostController(ctx: BuildContext, forward: ForwardRefs, workbench: WorkbenchSession, syntaxTracker: SyntaxDocumentTracker): BufferHost {
  const { deps, filesystem, persistence, marker, workspaceRoot, clock } = ctx;
  const { document, filePath } = deps;
  const host = new BufferHost(workbench, document, {
    openDocument: async (path, documentId) => (path === undefined ? undefined : await forward.directoryDraftController.openDocumentIfDirectory(path, documentId)) ?? deps.openDocumentAt(path, documentId),
    workspaceRelativePath: (path) => filesystem.workspaceRelativePath(workspaceRoot, path),
    marker,
    launchViewId: id<ViewId>('xi-launch-view'),
    ...(filePath?.line === undefined ? {} : { launchInitialLine: filePath.line }),
    onMessage: (message) => ctx.deps.statusMessages.publish(message, 'info'),
    clock,
    onSave: async (sessionDocument, viewId, target) => {
      // T041/T042: `:w` on a directory draft compiles a plan and opens review instead of
      // writing draft text to disk; the plan only reaches disk once the review is applied.
      if (forward.directoryDraftController.requestSave(sessionDocument.id)) return true;
      const buffer = workbench.views().find((view) => view.viewId === viewId);
      const path = target ?? (buffer === undefined ? undefined : workbench.buffer(buffer.bufferId)?.path);
      if (path === undefined) {
        ctx.deps.statusMessages.publish('xi: no file name');
        return false;
      }
      return forward.saveCoordinator.requestSave(sessionDocument, path, viewId);
    },
    onExCommand: (source, viewId) => forward.hostCommands.handleWorkbenchCommand(source, viewId),
    onPrefixStateChange: (viewId, state) => forward.inputRouter.schedulePrefixHelp(viewId, state.pendingKeys, state.parserContinuations),
    onCommandLineChange: (state) => forward.inputRouter.handleCommandLineChange(state),
    onHostCommand: (command, viewId) => forward.hostCommands.handleVimHostCommand(command, viewId),
    onBufferOpened: (buffer) => {
      syntaxTracker.openDocument({ documentId: buffer.documentId, languageId: languageIdForPath(buffer.path), snapshot: buffer.document.snapshot() });
      forward.languageWiring.admitBufferToLanguageSession(buffer.path, buffer.documentId, buffer.document);
    },
    onBufferClosed: (buffer) => {
      persistence.closeDocument(buffer.documentId);
      syntaxTracker.closeDocument(buffer.documentId);
      forward.directoryDraftController.closeDocument(buffer.documentId);
      forward.languageWiring.releaseBufferFromLanguageSession(buffer.path);
    },
  });
  forward.host = host;
  return host;
}

/** Optional-services wiring (lazy git/search-index/LSP-extra services) and the navigation
 * picker controller that sits on top of it. */
function createOptionalServicesAndPicker(
  ctx: BuildContext,
  forward: ForwardRefs,
  host: BufferHost,
  pickerModel: InstanceType<CoreServicesModule['BoundedPickerModel']>,
  mouseMode: ReturnType<typeof createMouseModeToggle>,
  fileUri: CoreServicesModule['fileUri'],
): { readonly optionalServices: OptionalServicesWiring; readonly picker: PickerController<PickerEntry, WorkbenchTheme> } {
  const { deps, filesystem, clock, marker, workspaceRoot } = ctx;
  const optionalServices = createOptionalServicesWiring({
    filesystem,
    ProcessPort: deps.NodeProcessPort,
    workspaceRoot,
    fileUri,
    processEnvironment,
    notifySurfaceChange: () => host.notifySurfaceChange(),
    createExplorerFilesystem,
    createGitDecorationPort,
    getExplorerFeature: () => forward.explorerFeature,
    getSearchFeature: () => forward.searchFeature,
  });
  forward.optionalServices = optionalServices;
  const picker = new PickerController<PickerEntry, WorkbenchTheme>({
    host,
    model: pickerModel,
    theme: deps.themeWiring.themeController,
    clock,
    marker,
    startFileIndexPopulation: () => forward.startFileIndexPopulation(),
    toggleMouseMode: mouseMode.toggle,
    openFile: async (path, preview) => {
      const opened = await host.openBufferAtPath(path, { preview });
      // The Files tree follows a picker commit (VS Code "reveal in explorer"); previews
      // are transient and would churn the tree on every arrow key.
      if (opened !== undefined && !preview) forward.explorerFeature.revealPath(path);
      return opened;
    },
    onSecondaryAction: (entry, action) => {
      const resolved = optionalServices.current;
      if (resolved === undefined) return;
      const { gitMutationCoordinator: coordinator, gitStatusService: status } = resolved;
      const snapshot = status.snapshot;
      if (snapshot === undefined) return;
      const context = { root: workspaceRoot, generation: snapshot.generation, expectedGeneration: snapshot.generation };
      const mutation = action === 'stage' ? coordinator.stage([entry.value], context) : coordinator.unstage([entry.value], context);
      void mutation.then((result) => {
        if (!result.ok) { marker('XI_GIT_MUTATION_FAILED', { kind: result.error.kind }); return; }
        void status.refresh();
      });
    },
  });
  return { optionalServices, picker };
}

/** The explorer tree controller and the directory-draft ("directory as editable text")
 * controller, both crash-recoverable via the same journaled filesystem operations. */
function createExplorerAndDirectory(
  ctx: BuildContext,
  forward: ForwardRefs,
  host: BufferHost,
  workbench: WorkbenchSession,
): { readonly explorerFeature: ExplorerController; readonly directoryDraftController: DirectoryDraftController; readonly journaledFileOperations: JournaledFilesystemOperations } {
  const { filesystem, clock, marker, workspaceRoot } = ctx;
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
    onError: (message) => ctx.deps.statusMessages.publish(message),
    workspaceRelativePath: (path) => filesystem.workspaceRelativePath(workspaceRoot, path),
    trashDirectory: `${workspaceRoot}/.xi-trash`,
    ensureServices: async () => { await forward.optionalServices.ensure(); },
    onOpen: () => forward.sidebarController.expandSection('files'),
    onCollapse: () => forward.sidebarController.collapseSection('files'),
    focusOutline: () => forward.overlayFeature.openOutline(),
  });
  forward.explorerFeature = explorerFeature;
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
      // DirectoryDraft (a service) never opens documents itself; this composition root owns
      // that (docs/plan/01-architecture.md), and hands the opened document back to the draft
      // through the narrow `DirectoryDraftDocumentPort` it declares.
      let openedDocument: TextFileDocument | undefined;
      const draft = DirectoryDraft.create(path, entries, (draftId, text) => {
        const opened = openTextDocument(draftId as DocumentId, new TextEncoder().encode(text), 41027, { fileFormat: 'unix' });
        if (opened.kind !== 'editable') return { ok: false, error: `directory draft document open failed: ${opened.kind}` };
        openedDocument = opened.document;
        return { ok: true, value: opened.document };
      }, { documentId: String(documentId) });
      if (!draft.ok) return { ok: false, error: draft.error.message };
      if (openedDocument === undefined) return { ok: false, error: 'directory draft document was not opened' };
      return { ok: true, value: { port: draft.value, document: openedDocument } };
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
    onError: (message) => ctx.deps.statusMessages.publish(message),
    marker,
    notifySurfaceChange: () => host.notifySurfaceChange(),
  });
  forward.directoryDraftController = directoryDraftController;
  return { explorerFeature, directoryDraftController, journaledFileOperations };
}

/** Search, problems, outline/hover/signature overlays and the sidebar model that reads the
 * outline's symbol count. */
function createSearchProblemsOverlaySidebar(
  ctx: BuildContext,
  forward: ForwardRefs,
  host: BufferHost,
  workbench: WorkbenchSession,
  diagnostics: InstanceType<CoreServicesModule['DiagnosticStore']>,
  taskWiring: TaskWiring,
  fileUri: CoreServicesModule['fileUri'],
  workspacePathFromUri: CoreServicesModule['workspacePathFromUri'],
): { readonly searchFeature: SearchController; readonly gitPanelFeature: GitPanelController; readonly gitDiffFeature: DiffViewController; readonly problemsFeature: ProblemsController; readonly overlayFeature: LanguageOverlayController; readonly sidebarController: SidebarController } {
  const { filesystem, marker, workspaceRoot } = ctx;
  const searchFeature = new SearchController({
    host,
    session: workbench,
    filesystem,
    marker,
    onError: (message) => ctx.deps.statusMessages.publish(message),
    workspaceRoot,
    ensureServices: async () => { await forward.optionalServices.ensure(); },
  });
  forward.searchFeature = searchFeature;
  // Lazily bound to `optionalServices.current.gitStatusService`/`gitMutationCoordinator`,
  // constructed on first use exactly like `searchFeature`'s own `ensureServices` -- this
  // controller never touches the process/filesystem port directly.
  const gitPanelFeature = new GitPanelController({
    host,
    status: {
      get snapshot() { return forward.optionalServices.current?.gitStatusService.snapshot; },
      subscribe: (listener) => {
        let disposed = false;
        let inner: { dispose(): void } | undefined;
        void forward.optionalServices.ensure().then((resolved) => {
          if (disposed) return;
          inner = resolved.gitStatusService.subscribe(listener);
          if (resolved.gitStatusService.snapshot !== undefined) listener(resolved.gitStatusService.snapshot);
        });
        return { dispose: () => { disposed = true; inner?.dispose(); } };
      },
      refresh: async () => { await (await forward.optionalServices.ensure()).gitStatusService.refresh(); },
    },
    mutations: {
      stage: async (paths, context) => (await forward.optionalServices.ensure()).gitMutationCoordinator.stage(paths, context),
      unstage: async (paths, context) => (await forward.optionalServices.ensure()).gitMutationCoordinator.unstage(paths, context),
    },
    filesystem,
    workspaceRoot,
    marker,
    onError: (message) => ctx.deps.statusMessages.publish(message),
    openDiff: (relativePath, target) => forward.gitDiff?.open(relativePath, target) ?? Promise.resolve(),
  });
  forward.gitPanelFeature = gitPanelFeature;
  // Lazily bound to `optionalServices.current.gitDiffService`, constructed on first `open()`
  // exactly like `gitPanelFeature`'s own status port -- never touches the process/filesystem
  // port directly.
  const gitDiffFeature = new DiffViewController({
    host,
    workbench,
    workspaceRoot,
    marker,
    openSyntax: (snapshot, path) => forward.syntaxTracker.openDocument({ documentId: snapshot.id, languageId: languageIdForPath(path), snapshot }),
    closeSyntax: (documentId) => forward.syntaxTracker.closeDocument(documentId),
    onError: (message) => ctx.deps.statusMessages.publish(message),
    service: {
      load: async (input) => (await forward.optionalServices.ensure()).gitDiffService.load(input),
      compare: async (left, right, cancellation) => (await forward.optionalServices.ensure()).gitDiffService.compare(left, right, cancellation),
      align: async (lines) => (await forward.optionalServices.ensure()).gitDiffService.align(lines),
    },
  });
  forward.gitDiff = gitDiffFeature;
  const problemsFeature = new ProblemsController({
    host,
    diagnostics,
    marker,
    onError: (message) => ctx.deps.statusMessages.publish(message),
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
    focusExplorer: () => forward.explorerFeature.open(),
    ensureLanguage: () => forward.languageWiring.ensureLanguage(),
  });
  const sidebarController = new SidebarController({
    panelState: () => (forward.searchFeature.isOpen ? 'search' : forward.gitPanelFeature.isOpen ? 'git' : 'files'),
    outline: { get hasSymbols() { return overlayFeature.outlineRead.model.symbols.length > 0; } },
  });
  return { searchFeature, gitPanelFeature, gitDiffFeature, problemsFeature, overlayFeature, sidebarController };
}

/** Completion/snippets and workspace-edit (rename/code-action) controllers, plus connecting
 * `languageWiring` to the feature controllers it dispatches LSP notifications into. */
function createCompletionAndWorkspaceEdits(
  ctx: BuildContext,
  forward: ForwardRefs,
  host: BufferHost,
  workbench: WorkbenchSession,
  diagnostics: InstanceType<CoreServicesModule['DiagnosticStore']>,
  overlayFeature: LanguageOverlayController,
  fileUri: CoreServicesModule['fileUri'],
  workspaceRelativePathFromUri: CoreServicesModule['workspaceRelativePathFromUri'],
): { readonly completionFeature: CompletionSnippetController; readonly workspaceEditsFeature: WorkspaceEditsController } {
  const { deps, filesystem, marker, workspaceRoot } = ctx;
  const { languageId } = deps;
  const completionFeature = new CompletionSnippetController({
    host,
    session: workbench,
    marker,
    onError: (message) => ctx.deps.statusMessages.publish(message),
    fileUri,
    positionToOffset: deps.positionToOffset,
    ensureLanguage: () => forward.languageWiring.ensureLanguage(),
    ensureOptionalServices: async () => { await forward.optionalServices.ensure(); },
    getSnippetSupport: () => (forward.optionalServices.current === undefined ? undefined : { expandSnippet: forward.optionalServices.current.expandSnippet, SnippetSession: forward.optionalServices.current.SnippetSession }),
  });
  forward.completionFeature = completionFeature;
  const workspaceEditsFeature = new WorkspaceEditsController({
    host,
    session: workbench,
    filesystem,
    marker,
    onError: (message) => ctx.deps.statusMessages.publish(message),
    fileUri,
    workspaceRelativePathFromUri: (uri) => workspaceRelativePathFromUri(filesystem, workspaceRoot, uri),
    workspaceAbsolutePath: (relativePath) => filesystem.workspaceAbsolutePath(workspaceRoot, relativePath),
    nextDocumentId: () => host.nextDocumentId(),
    languageId,
    ensureLanguage: () => forward.languageWiring.ensureLanguage(),
    readDiagnostics: () => diagnostics.model.all,
    runWorkspaceEditProposal: async (proposal) => {
      const session = forward.languageWiring.session;
      const coordinator = forward.languageWiring.workspaceEditCoordinator;
      const provider = forward.languageWiring.workspaceEditProvider;
      const executor = forward.languageWiring.workspaceEditExecutor;
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
      if (forward.optionalServices.current !== undefined) return forward.optionalServices.current.executeLanguageCodeAction;
      const resolved = await forward.optionalServices.ensure();
      return resolved.executeLanguageCodeAction;
    },
  });
  forward.languageWiring.connect({ getBufferDocument: (documentId) => host.documents.get(documentId), overlayFeature, completionFeature, workspaceEditsFeature });
  return { completionFeature, workspaceEditsFeature };
}

function createPointerCapture(ctx: BuildContext, host: BufferHost, workbench: WorkbenchSession): WorkbenchPointerCapture {
  const { deps, marker } = ctx;
  return new WorkbenchPointerCapture({
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
}

/** Save orchestration and the ex-command/Vim-host-command dispatcher. */
function createSaveAndHostCommands(
  ctx: BuildContext,
  forward: ForwardRefs,
  host: BufferHost,
  workbench: WorkbenchSession,
  workspaceEditsFeature: WorkspaceEditsController,
  problemsFeature: ProblemsController,
  workspacePathFromUri: CoreServicesModule['workspacePathFromUri'],
): { readonly saveCoordinator: SaveCoordinator; readonly hostCommands: WorkbenchHostCommands } {
  const { deps, filesystem, clock, persistence, marker, workspaceRoot, formatOnSave, configuredLanguages } = ctx;
  const { languageId } = deps;
  const saveCoordinator = new SaveCoordinator({
    host,
    session: workbench,
    persistence,
    clock,
    marker,
    onError: (message) => ctx.deps.statusMessages.publish(message),
    formatOnSave,
    createFormatterPipeline: async () => {
      const { FormatterPipeline, createExternalFormatter } = await import('../../../../packages/services/src/entrypoints/formatting');
      const configuredFormatter = languageId === undefined ? undefined : configuredLanguages?.find((entry) => entry.name === languageId)?.formatter;
      return createFormatterPipelineFromEnvironment(workspaceRoot, FormatterPipeline, createExternalFormatter, deps.NodeProcessPort, marker, ctx.deps.statusMessages, configuredFormatter);
    },
    onSaved: () => { void forward.optionalServices.current?.gitStatusService.refresh(); },
  });
  forward.saveCoordinator = saveCoordinator;
  const hostCommands = new WorkbenchHostCommands({
    host,
    session: workbench,
    filesystem,
    marker,
    onError: (message) => ctx.deps.statusMessages.publish(message),
    workspaceRoot,
    workspacePathFromUri,
    ensureHostNavigation: async () => { await forward.optionalServices.ensure(); },
    readHostNavigation: () => forward.optionalServices.current?.hostNavigation,
    workspaceEdits: workspaceEditsFeature,
    problems: problemsFeature,
    saveCoordinator,
    directoryDrafts: { open: (target, viewId) => forward.directoryDraftController.explore(target, viewId) },
    lookupDefinition: async () => {
      await forward.languageWiring.ensureLanguage();
      const navigation = forward.languageWiring.navigationController;
      const languageSession = forward.languageWiring.session;
      if (navigation === undefined || languageSession === undefined) return { ok: false, message: 'no language server for this file' };
      const request = buildNavigationRequest(workbench, ctx.deps.coreServices.fileUri);
      if (request === undefined) return { ok: false, message: 'no active buffer' };
      // The server for this buffer's language may still be initializing on the first `gd`;
      // wait (bounded) for its readiness, not for whichever server was opened last.
      const ready = await Promise.race([languageSession.waitForReady(request.uri), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 8000))]);
      if (ready !== undefined && !ready.ok) return { ok: false, message: ready.error.message };
      const result = await navigation.definition(request);
      if (!result.ok) return { ok: false, message: result.error.message };
      // Servers may list the local import alias first; prefer the declaration in another file.
      const first = result.value.find((location) => location.uri !== request.uri) ?? result.value[0];
      if (first === undefined) return { ok: false, message: 'no definition found' };
      return { ok: true, location: { uri: first.uri, line: first.startLine, utf16: first.startUtf16 } };
    },
    focusSidebar: () => { forward.explorerFeature.open(); return true; },
  });
  forward.hostCommands = hostCommands;
  return { saveCoordinator, hostCommands };
}

/** The key-input focus-stack router and the pointer/click router; both are the last
 * controllers built, so every dependency they read (including the forward ones) already has
 * its real value by the time either is constructed. */
function createInputAndPointerRouters(
  ctx: BuildContext,
  forward: ForwardRefs,
  host: BufferHost,
  workbench: WorkbenchSession,
  commandRegistry: CommandRegistry,
  picker: PickerController<PickerEntry, WorkbenchTheme>,
  problemsFeature: ProblemsController,
  overlayFeature: LanguageOverlayController,
  workspaceEditsFeature: WorkspaceEditsController,
  sidebarController: SidebarController,
  pointerCapture: WorkbenchPointerCapture,
  contextMenuStore: InstanceType<UiModule['ContextMenuStore']>,
  pickerModel: InstanceType<CoreServicesModule['BoundedPickerModel']>,
  diagnostics: InstanceType<CoreServicesModule['DiagnosticStore']>,
  mouseMode: ReturnType<typeof createMouseModeToggle>,
  directoryDraftController: DirectoryDraftController,
  gitDiffFeature: DiffViewController,
): { readonly inputRouter: WorkbenchInputRouter; readonly pointerRouter: WorkbenchPointerRouter } {
  forward.gitPanelOpen = () => picker.isOpen && picker.mode === 'git';
  const { marker, startupConfig, clock } = ctx;
  const inputRouter = new WorkbenchInputRouter({
    host,
    session: workbench,
    marker,
    onError: (message) => ctx.deps.statusMessages.publish(message),
    commandRegistry,
    picker,
    explorer: forward.explorerFeature,
    search: forward.searchFeature,
    problems: problemsFeature,
    overlays: overlayFeature,
    completion: forward.completionFeature,
    workspaceEdits: workspaceEditsFeature,
    executeWorkbenchCommand: (source, viewId) => forward.hostCommands.handleWorkbenchCommand(source, viewId),
    isExplorerServiceLoaded: () => forward.optionalServices.current !== undefined,
    isSearchServiceLoaded: () => forward.optionalServices.current !== undefined,
    ensureOptionalServices: async () => { await forward.optionalServices.ensure(); },
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
    // H1-7: the ordered overlay-focus stack `dispatchKey` walks -- the same controller
    // references `apps/xi/src/wiring/ui.ts` hands to `packages/ui/src/terminal.ts` for
    // rendering/read models, now also reachable from the router for key dispatch.
    overlayContextMenu: contextMenuStore,
    overlayCompletion: { isOpen: () => forward.completionFeature.isCompletionOpen, onKeypress: (event) => forward.completionFeature.handleCompletionKeypress(event) },
    overlayPicker: { isOpen: () => picker.isOpen, onKeypress: (event) => picker.handleKeypress(event) },
    overlayExplorer: { isOpen: () => forward.explorerFeature.isOpen, onKeypress: (event) => forward.explorerFeature.handleKeypress(event), capturesTextInput: () => forward.explorerFeature.capturesTextInput },
    overlaySearch: { isOpen: () => forward.searchFeature.isOpen, onKeypress: (event) => forward.searchFeature.handleKeypress(event), capturesTextInput: () => forward.searchFeature.capturesTextInput },
    overlayGit: { isOpen: () => forward.gitPanelFeature.isOpen, onKeypress: (event) => forward.gitPanelFeature.handleKeypress(event) },
    overlayGitDiff: { isOpen: () => gitDiffFeature.isOpen, isReadOnly: () => gitDiffFeature.readComparison()?.editable === false, onKeypress: (event) => gitDiffFeature.handleKeypress(event) },
    openGitDiffForActiveBuffer: async () => {
      const activeViewId = workbench.activeViewId;
      const buffer = activeViewId === undefined ? undefined : workbench.buffers().find((candidate) => candidate.viewIds.includes(activeViewId));
      const path = buffer?.path;
      if (path === undefined) return;
      const relativePath = ctx.filesystem.workspaceRelativePath(ctx.workspaceRoot, path);
      if (relativePath === undefined) return;
      await gitDiffFeature.open(relativePath, 'worktree');
    },
    openGitPanel: async () => { forward.gitPanelFeature.open(); },
    overlayProblems: { isOpen: () => problemsFeature.isProblemsOpen, onKeypress: (event) => problemsFeature.handleProblemsKeypress(event) },
    overlayOutput: { isOpen: () => problemsFeature.isOutputOpen, onKeypress: (event) => problemsFeature.handleOutputKeypress(event) },
    overlayOutline: { isOpen: () => overlayFeature.isOutlineOpen, onKeypress: (event) => overlayFeature.handleOutlineKeypress(event) },
    overlayHover: { isOpen: () => overlayFeature.isHoverOpen, onKeypress: (event) => overlayFeature.handleHoverKeypress(event) },
    overlayDirectoryReview: { isOpen: () => directoryDraftController.isReviewOpen, onKeypress: (event) => directoryDraftController.handleKeypress(event) },
    overlaySignature: { isOpen: () => forward.completionFeature.isSignatureOpen, onKeypress: (event) => forward.completionFeature.handleSignatureKeypress(event) },
  });
  forward.inputRouter = inputRouter;
  const pointerRouter = new WorkbenchPointerRouter({
    session: workbench,
    marker,
    clock,
    onTabActivate: (bufferId) => { workbench.activateBuffer(id<DocumentId>(bufferId)); host.notifySurfaceChange(); },
    onEditorPointerDown: () => {
      inputRouter.focusEditor();
      if (forward.explorerFeature.isOpen || forward.searchFeature.isOpen) { host.closeAllPanels(); host.notifySurfaceChange(); }
    },
    onTabPin: (bufferId) => { workbench.pinBuffer(id<DocumentId>(bufferId)); host.notifySurfaceChange(); },
    // `closeBuffer` with no decision closes a clean buffer immediately and returns a
    // `dirty-buffer` error (no side effect) for one with unsaved changes -- the tab close
    // glyph never silently discards edits; a dirty buffer just stays open until saved.
    onTabClose: (bufferId) => {
      if (gitDiffFeature.readComparison(id<ViewId>(bufferId)) !== undefined) { workbench.focus(id<ViewId>(bufferId)); gitDiffFeature.close(); }
      else if (workbench.closeBuffer(id<DocumentId>(bufferId)).ok) host.notifySurfaceChange();
    },
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
    explorer: forward.explorerFeature,
    search: {
      readModel: () => forward.optionalServices.current?.searchService.model,
      setSelectedIndex: (index) => forward.searchFeature.setSelectedIndex(index),
      openMatch: (match) => forward.searchFeature.openMatch(match),
      previewSelected: () => forward.searchFeature.previewSelected(),
      focusQuery: () => forward.searchFeature.focusQuery(),
      focusReplace: () => forward.searchFeature.focusReplace(),
      toggleCollapsed: (path) => forward.searchFeature.toggleCollapsed(path),
    },
    git: { onPointerActivate: (itemId) => forward.gitPanelFeature.onPointerActivate(itemId) },
    problems: {
      get model() { return diagnostics.model; },
      setSelectedProblemIndex: (index) => problemsFeature.setSelectedProblemIndex(index),
      openProblem: (problem) => problemsFeature.openProblem(problem),
    },
  });
  return { inputRouter, pointerRouter };
}

/** Constructs BufferHost, SaveCoordinator, HostCommands, InputRouter, PointerRouter and every
 * picker/explorer/search/problems/directory/sidebar controller in dependency order by calling
 * the feature-grouped helpers above in sequence, resolving the genuinely-circular ones
 * (`host` <-> `workbench`/`saveCoordinator`/`hostCommands`/`inputRouter`, and a few feature
 * controllers referenced by `optionalServices`/`pickerModel` before they exist) through the
 * shared `forward` record instead of same-function `let` forward declarations. */
export async function createControllers(deps: ControllersDeps): Promise<Controllers> {
  const { fileUri, workspacePathFromUri, workspaceRelativePathFromUri } = deps.coreServices;
  const { filesystem, clock, persistence, marker } = deps;
  const forward = {} as ForwardRefs;
  const mouseMode = createMouseModeToggle();
  const jobControlDisposables: Disposable[] = [];

  const { syntaxAssetsCancellation, syntaxTracker } = createSyntaxTracker(filesystem);
  forward.syntaxTracker = syntaxTracker;
  const settings = await loadStartupSettings(deps);
  const ctx: BuildContext = { deps, filesystem, clock, persistence, marker, ...settings };

  const workbench = createWorkbenchCore(ctx, forward, syntaxTracker);
  const diagnostics = new ctx.deps.coreServices.DiagnosticStore();
  const contextMenuStore = new deps.ContextMenuStore();
  const { languageWiring, taskWiring, syntaxResultSubscription } = createLanguageAndTaskWiring(ctx, forward, workbench, syntaxTracker, diagnostics, fileUri);
  const { fileIndex, commandRegistry, contributionRegistry, commandAliasRegistration } = await createRegistries(ctx);
  const pickerModel = createPickerModel(ctx, forward, workbench, fileIndex);
  const host = createHostController(ctx, forward, workbench, syntaxTracker);
  const { optionalServices, picker } = createOptionalServicesAndPicker(ctx, forward, host, pickerModel, mouseMode, fileUri);
  const { explorerFeature, directoryDraftController } = createExplorerAndDirectory(ctx, forward, host, workbench);
  const { searchFeature, gitPanelFeature, gitDiffFeature, problemsFeature, overlayFeature, sidebarController } = createSearchProblemsOverlaySidebar(ctx, forward, host, workbench, diagnostics, taskWiring, fileUri, workspacePathFromUri);
  forward.sidebarController = sidebarController;
  forward.overlayFeature = overlayFeature;
  const { completionFeature, workspaceEditsFeature } = createCompletionAndWorkspaceEdits(ctx, forward, host, workbench, diagnostics, overlayFeature, fileUri, workspaceRelativePathFromUri);
  const pointerCapture = createPointerCapture(ctx, host, workbench);
  createSaveAndHostCommands(ctx, forward, host, workbench, workspaceEditsFeature, problemsFeature, workspacePathFromUri);
  const { inputRouter, pointerRouter } = createInputAndPointerRouters(ctx, forward, host, workbench, commandRegistry, picker, problemsFeature, overlayFeature, workspaceEditsFeature, sidebarController, pointerCapture, contextMenuStore, pickerModel, diagnostics, mouseMode, directoryDraftController, gitDiffFeature);

  // Deferred until every controller `onPrefixStateChange`/`onCommandLineChange` delegates to
  // (`inputRouter`, constructed above) exists: `createSession`'s initial state publish can
  // invoke those callbacks synchronously.
  host.createSession(deps.document, id<ViewId>('xi-launch-view'));

  const startFileIndexPopulation = createFileIndexPopulator(fileIndex, filesystem, ctx.workspaceRoot, () => host.notifySurfaceChange());
  forward.startFileIndexPopulation = startFileIndexPopulation;
  const fileIndexStarter = createDeferredStart(1000, () => { void startFileIndexPopulation(); });
  async function ensureGitAndOpenPicker(): Promise<void> {
    const resolved = await optionalServices.ensure();
    void resolved.gitStatusService.refresh();
    picker.open('git');
  }

  return {
    statusMessages: deps.statusMessages,
    workbench,
    host,
    saveCoordinator: forward.saveCoordinator,
    hostCommands: forward.hostCommands,
    inputRouter,
    pointerRouter,
    pointerCapture,
    picker,
    explorerFeature,
    directoryDraftController,
    searchFeature,
    gitPanelFeature,
    gitDiffFeature,
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
    commandAliasRegistration,
    taskWiring,
    languageWiring,
    syntaxTracker,
    syntaxAssetsCancellation,
    syntaxResultSubscription,
    mouseMode,
    jobControlDisposables,
    fileIndexStarter,
    pickerPreview: createPickerPreview(ctx, host),
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
  statusMessages: StatusMessageController,
  configuredFormatter?: { readonly command: string; readonly args: readonly string[] },
): FormatterPipeline | undefined {
  const selection = resolveFormatterSelection(process.env, configuredFormatter);
  if (!selection.ok) {
    statusMessages.publish(`xi: formatter failed: ${selection.error.message}`);
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

/** Bounded (32 entries) preview cache for the file picker; reads go through the platform
 * filesystem port off the input path and wake one frame via `notifySurfaceChange`. */
function createPickerPreview(ctx: BuildContext, host: BufferHost): Controllers['pickerPreview'] {
  const cache = new Map<string, { readonly title: string; readonly lines: readonly string[] } | 'loading'>();
  // `fatal: true` mirrors `openTextDocument`'s own binary detection (packages/document/src/
  // text-fidelity.ts): a picker preview must never hand raw/invalid-UTF-8 bytes to the
  // renderer -- terminal control bytes (ESC, etc.) inside binary file content would
  // otherwise be written straight to the pty and corrupt the whole screen, not just the
  // preview pane.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return (path) => {
    const cached = cache.get(path);
    if (cached !== undefined) return cached === 'loading' ? undefined : cached;
    cache.set(path, 'loading');
    if (cache.size > 32) { const oldest = cache.keys().next().value; if (oldest !== undefined) cache.delete(oldest); }
    const cancellation = new CancellationSource();
    void ctx.filesystem.readFile(path, cancellation.token).then((read) => {
      // ponytail: whole-file read capped by taking the first 200 lines after decoding; large
      // binary/huge files still cost one read. Upgrade path: a bounded head read on the port.
      const lines = read.ok ? decodePreviewLines(decoder, read.value) : [`(unreadable: ${read.ok ? '' : read.error.message})`];
      cache.set(path, { title: ctx.filesystem.workspaceRelativePath(ctx.workspaceRoot, path) ?? path, lines });
      host.notifySurfaceChange();
    }).finally(() => cancellation.dispose());
    return undefined;
  };
}

function decodePreviewLines(decoder: TextDecoder, bytes: Uint8Array): readonly string[] {
  let decoded: string;
  try {
    decoded = decoder.decode(bytes.subarray(0, 64 * 1024));
  } catch {
    return ['(binary file, no preview)'];
  }
  if (decoded.includes('\0')) return ['(binary file, no preview)'];
  return decoded.split(/\r?\n/u).slice(0, 200);
}
