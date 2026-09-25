import type { EditorStatePersistence } from '../../../../packages/services/src/entrypoints/config';
import { asIdentifier, asUtf16Offset, CancellationSource, type DocumentId, type Disposable, type ViewId, type Result } from '../../../../packages/primitives/src/entrypoints/launch';
import type { ClipboardPort } from '../../../../packages/contracts/src/entrypoints/launch';
import type { DocumentSnapshot, TextFileDocument } from '../../../../packages/document/src/entrypoints/launch';
import { openTextDocument } from '../../../../packages/document/src/entrypoints/launch';
import type { NodeFilesystemPort, NodeProcessPort, WorkspaceDirectoryEntry, WorkspaceDirectoryWatchEvent, WorkspaceFileEntry, WorkspaceIgnoreOptions, createNodeClock } from '../../../../packages/platform/src/entrypoints/launch';
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
  createPathCompletionProvider,
  createWordCompletionProvider,
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
import { toExplorerGitDecoration, createGitDecorationPort } from '../../../../packages/services/src/entrypoints/git-decorations';
import { resolveFormatOnSave, resolveFormatterSelection } from '../../../../packages/services/src/entrypoints/config';
import type { CompiledConfig, EditorConfigProperties, LanguageConfig, LanguageServerConfig, loadStartupXiConfig } from '../../../../packages/services/src/entrypoints/config';
import { SyntaxDocumentTracker } from '../../../../packages/services/src/entrypoints/syntax';
import { commentContinuationPrefix } from '../../../../packages/vim/src/entrypoints/launch';
import { createBundledGrammarProvider, resolveTreeSitterRuntimeOptions } from '../syntax-assets';
import type { StatusMessageController } from '../../../../packages/workbench/src/entrypoints/launch';
import type { ThemeWiring } from './theme';
import { createTaskWiring, type TaskWiring } from './tasks';
import { createLanguageWiring, type LanguageWiring } from './language';
import { createOptionalServicesWiring, type OptionalServicesWiring } from './optional-services';
import type { WorkspaceTrustWiring } from '../../../../packages/services/src/entrypoints/config';
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
  readonly userConfigPath: string;
  readonly clock: ReturnType<typeof createNodeClock>;
  readonly persistence: PersistenceService;
  readonly document: TextFileDocument;
  readonly filePath: ResolvedFileArgument | undefined;
  readonly languageId: string | undefined;
  readonly NodeProcessPort: typeof NodeProcessPort;
  readonly createClock: typeof createNodeClock;
  readonly positionToOffset: typeof import('../../../../packages/document/src/entrypoints/launch').positionToOffset;
  readonly openDocumentAt: (path: string | undefined, documentId: DocumentId) => Promise<TextFileDocument | undefined>;
  readonly editorConfigForPath: (path: string) => EditorConfigProperties | undefined;
  readonly marker: (name: string, payload?: unknown) => void;
  readonly xiUiTestMarkersEnabled: boolean;
  readonly startupTrace: (label: string) => void;
  readonly startupConfigPromise: ReturnType<typeof loadStartupXiConfig>;
  readonly reloadStartupConfig: () => ReturnType<typeof loadStartupXiConfig>;
  readonly themeWiring: ThemeWiring;
  readonly coreServices: CoreServicesModule;
  readonly ContextMenuStore: UiModule['ContextMenuStore'];
  readonly statusMessages: StatusMessageController;
  readonly clipboard: ClipboardPort;
  readonly workspaceTrust: WorkspaceTrustWiring;
}

export interface Controllers {
  readonly editorState: EditorStatePersistence;
  readonly startupConfig: StartupConfig;
  readonly reloadConfig: () => Promise<boolean>;
  readonly registerUiReload: (listener: () => void) => void;
  readonly statusMessages: StatusMessageController;
  readonly workspaceTrust: WorkspaceTrustWiring;
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
  readonly wrapMode: { readonly registered: (toggle: () => boolean) => void; readonly toggle: () => boolean };
  readonly jobControlDisposables: Disposable[];
  /** Helix-style picker preview: leading lines of a file, read once in the background and
   * cached; `undefined` while loading (a surface change re-renders once it lands). */
  readonly pickerPreview: (entry: PickerEntry) => { readonly title: string; readonly lines: readonly string[]; readonly selectedLine?: number; readonly startLine?: number } | undefined;
  readonly editorDiagnostics: (documentId: import('../../../../packages/primitives/src/entrypoints/launch').DocumentId) => ReturnType<InstanceType<CoreServicesModule['DiagnosticStore']>['diagnosticsFor']>;
  readonly fileIndexStarter: { readonly schedule: () => void; readonly cancel: () => void };
  readonly ensureGitAndOpenPicker: () => Promise<void>;
}

export function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'xi-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function ensureUserConfigDocument(deps: ControllersDeps, host: BufferHost): Promise<void> {
  const cancellation = new CancellationSource();
  try {
    const created = await deps.filesystem.createFileIfMissing(deps.userConfigPath, cancellation.token);
    if (!created.ok) { deps.statusMessages.publish(`xi: cannot create ${deps.userConfigPath}: ${created.error.message}`); return; }
    const opened = await host.openBufferAtPath(deps.userConfigPath);
    if (opened !== undefined) deps.marker('XI_CONFIG_OPEN', { path: deps.userConfigPath, viewId: opened.viewId });
  } finally { cancellation.dispose(); }
}

/** Small mutable cell for a renderer-owned toggle (mouse mode, soft wrap), which only exists
 * once `runOpenTuiWorkbench` registers it -- a tiny owned object instead of a `main()`-scoped `let`. */
function createRendererToggle(): { readonly registered: (toggle: () => boolean) => void; readonly toggle: () => boolean } {
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

/** Helix's file picker always skips these VCS entries, even when ignore files are off. */
const VCS_DIRECTORY_NAMES = ['.git', '.pijul', '.jj', '.hg', '.svn'];

async function populateFileIndex(index: InstanceType<CoreServicesModule['FilePathIndex']>, filesystem: NodeFilesystemPort, root: string, followSymlinks: boolean, deduplicateLinks: boolean, maxDepth: number | undefined, ignore: WorkspaceIgnoreOptions, shouldPublishEarly: (entries: readonly { readonly relativePath: string }[]) => boolean, onUpdate: () => void, onError: (message: string) => void): Promise<void> {
  const cancellation = new CancellationSource();
  // ponytail: publish the first partial batch immediately, then every 2,048 paths;
  // lower the interval if measured first-match latency requires more frequent refreshes.
  let lastPublishedEntries = 0;
  let indexedEntries = 0;
  let reportedIndexError = false;
  try {
    const result = await filesystem.enumerateFiles(root, cancellation.token, (entries) => {
      const indexed = entries.map((entry) => ({ rootId: 'workspace' as const, relativePath: entry.relativePath, absolutePath: entry.absolutePath, hidden: entry.hidden }));
      const added = index.addPaths('workspace', indexed);
      if (added.ok && added.value > 0 && (lastPublishedEntries === 0 || indexedEntries + added.value - lastPublishedEntries >= 2_048 || shouldPublishEarly(entries))) {
        indexedEntries += added.value;
        lastPublishedEntries = indexedEntries;
        onUpdate();
      }
      else if (added.ok) indexedEntries += added.value;
      else if (!reportedIndexError) { reportedIndexError = true; onError(`xi: file picker index incomplete: ${added.error.kind}`); }
    }, { maxEntries: 120_000, ignoredDirectoryNames: VCS_DIRECTORY_NAMES, followSymlinks, deduplicateLinks, ...(maxDepth === undefined ? {} : { maxDepth }), ignore });
    if (!result.ok) onError(`xi: file picker index incomplete: ${result.error.message}`);
  } finally {
    index.markReady();
    onUpdate();
    cancellation.dispose();
  }
}

/** A single lazily-started, memoized population run -- replaces a bare `let ...Population`
 * closure with one owned handle. */
function createFileIndexPopulator(fileIndex: InstanceType<CoreServicesModule['FilePathIndex']>, filesystem: NodeFilesystemPort, root: string, followSymlinks: boolean, deduplicateLinks: boolean, maxDepth: number | undefined, ignore: WorkspaceIgnoreOptions, shouldPublishEarly: (entries: readonly { readonly relativePath: string }[]) => boolean, onUpdate: () => void, onError: (message: string) => void): () => Promise<void> {
  let population: Promise<void> | undefined;
  return () => {
    population ??= populateFileIndex(fileIndex, filesystem, root, followSymlinks, deduplicateLinks, maxDepth, ignore, shouldPublishEarly, onUpdate, onError);
    return population;
  };
}

function createIgnoredFileIndexPopulator(fileIndex: InstanceType<CoreServicesModule['FilePathIndex']>, filesystem: NodeFilesystemPort, root: string, followSymlinks: boolean, deduplicateLinks: boolean, maxDepth: number | undefined, ignore: WorkspaceIgnoreOptions, startDefaultPopulation: () => Promise<void>, onUpdate: () => void, onError: (message: string) => void): () => Promise<void> {
  let population: Promise<void> | undefined;
  return () => {
    population ??= (async () => {
      await startDefaultPopulation();
      if (![ignore.parents, ignore.ignore, ignore.gitIgnore, ignore.gitGlobal, ignore.gitExclude].some(Boolean)) return;
      const cancellation = new CancellationSource();
      const entries: WorkspaceFileEntry[] = [];
      try {
        const all = await filesystem.enumerateFiles(root, cancellation.token, batch => { entries.push(...batch); }, {
          maxEntries: 120_000, maxVisitedEntries: 500_000, ignoredDirectoryNames: VCS_DIRECTORY_NAMES, followSymlinks, deduplicateLinks,
          ...(maxDepth === undefined ? {} : { maxDepth }),
          ignore: { parents: false, ignore: false, gitIgnore: false, gitGlobal: false, gitExclude: false },
        });
        if (!all.ok) { onError(`xi: ignored file picker index incomplete: ${all.error.message}`); return; }
        const visible = await filesystem.visibleWorkspacePaths(root, entries.map(entry => entry.relativePath), ignore, cancellation.token);
        if (!visible.ok) { onError(`xi: ignored file picker index incomplete: ${visible.error.message}`); return; }
        const ignored = entries.filter(entry => !visible.value.has(entry.relativePath)).map(entry => ({
          rootId: 'workspace' as const, relativePath: entry.relativePath, absolutePath: entry.absolutePath, hidden: entry.hidden, ignored: true,
        }));
        for (let offset = 0; offset < ignored.length; offset += 512) {
          if (cancellation.token.isCancelled) return;
          const added = fileIndex.addPaths('workspace', ignored.slice(offset, offset + 512));
          if (!added.ok) { onError(`xi: ignored file picker index incomplete: ${added.error.kind}`); return; }
          if (added.value > 0) onUpdate();
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      } catch (error: unknown) {
        onError(`xi: ignored file picker index incomplete: ${error instanceof Error ? error.message : String(error)}`);
      } finally { cancellation.dispose(); }
    })();
    return population;
  };
}

function hasNewLiteralMatch(query: string, entries: readonly { readonly relativePath: string }[]): boolean {
  if (query.length < 2) return false;
  // ponytail: fuzzy-only matches still arrive at the regular 2,048-path publication.
  const needle = query.toLowerCase();
  return entries.some((entry) => entry.relativePath.toLowerCase().includes(needle));
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
function createExplorerFilesystem(filesystem: NodeFilesystemPort, root: string, onChanged?: () => void, ignore?: WorkspaceIgnoreOptions): ExplorerFilesystemPort {
  return {
    async enumerateDirectory(path, cancellation): Promise<Result<readonly ExplorerDirectoryEntry[], ExplorerFailure>> {
      const result = await filesystem.enumerateDirectory(path, root, cancellation, ignore === undefined ? {} : { ignore });
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
  workspaceEditsFeature?: WorkspaceEditsController;
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
  startIgnoredFileIndexPopulation: () => Promise<void>;
}

type StartupConfig = CompiledConfig | undefined;

/** Values every feature-construction helper below needs and none of them own; threaded
 * through as one bag instead of repeating the same six parameters on every function. */
interface BuildContext {
  readonly editorState: EditorStatePersistence;
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
function createSyntaxTracker(filesystem: NodeFilesystemPort, rainbowBrackets: boolean): { readonly syntaxAssetsCancellation: CancellationSource; readonly syntaxTracker: SyntaxDocumentTracker } {
  const syntaxAssetsCancellation = new CancellationSource();
  const syntaxTracker = new SyntaxDocumentTracker({
    grammars: createBundledGrammarProvider(filesystem, syntaxAssetsCancellation.token, rainbowBrackets),
    runtime: resolveTreeSitterRuntimeOptions,
    rainbowBrackets,
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
      forward.completionFeature.cancelSnippetOnExternalChange(change);
      forward.saveCoordinator.scheduleCheckpoint(change.snapshot.id);
      forward.saveCoordinator.scheduleAutoSave(change.snapshot.id);
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
  const configuredTheme = startupConfig?.editor.theme;
  const themeVariants = startupConfig?.editor.themeVariants;
  if (themeVariants !== undefined && deps.themeWiring.persistedThemeId === undefined) {
    for (const id of [themeVariants.dark, themeVariants.light, themeVariants.fallback]) {
      if (id !== undefined && !deps.themeWiring.themeController.has(id)) await deps.themeWiring.loadCustomTheme(id);
    }
  }
  if (configuredTheme !== undefined) {
    if (!deps.themeWiring.themeController.has(configuredTheme)) await deps.themeWiring.loadCustomTheme(configuredTheme);
    if (deps.themeWiring.themeController.has(configuredTheme)) deps.themeWiring.themeController.setActiveId(configuredTheme);
    else deps.statusMessages.publish(`xi: configured theme ${configuredTheme} was not found; using ${deps.themeWiring.themeController.activeId}`);
  }
  const configuredLanguages = startupConfig?.languages;
  const formatOnSave = resolveFormatOnSave(process.env, deps.languageId !== undefined && (configuredLanguages?.find((entry) => entry.name === deps.languageId)?.autoFormat ?? false), startupConfig?.editor.autoFormat ?? true);
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
  currentConfig: () => StartupConfig,
): { readonly languageWiring: LanguageWiring; readonly taskWiring: TaskWiring; readonly syntaxResultSubscription: Disposable } {
  const { deps, filesystem, workspaceRoot, configuredLanguages, startupConfig, marker } = ctx;
  const { document, filePath } = deps;
  const languageWiring = createLanguageWiring({
    filesystem,
    ProcessPort: deps.NodeProcessPort,
    createClock: deps.createClock,
    workspaceRoot,
    workspaceLspRoots: startupConfig?.editor.workspaceLspRoots ?? [],
    fileUri,
    processEnvironment,
    diagnostics,
    configuredLanguages,
    configuredLanguageServers: startupConfig?.languageServers,
    lspEnabled: () => (currentConfig()?.editor.lsp.enable ?? true) && deps.workspaceTrust.allowsServers(),
    snippets: startupConfig?.editor.lsp.snippets ?? true,
    displayLspMessages: startupConfig?.editor.lsp.displayMessages ?? true,
    displayLspProgressMessages: startupConfig?.editor.lsp.displayProgressMessages ?? false,
    displayInlayHints: startupConfig?.editor.lsp.displayInlayHints ?? startupConfig?.editor.lsp.inlayHints ?? false,
    inlayHintsLengthLimit: startupConfig?.editor.lsp.inlayHintsLengthLimit,
    displayColorSwatches: startupConfig?.editor.lsp.displayColorSwatches ?? true,
    autoDocumentHighlight: startupConfig?.editor.lsp.autoDocumentHighlight ?? false,
    launchDocument: document,
    launchDocumentPath: filePath?.path,
    readDocumentText,
    workbenchBuffers: () => workbench.buffers(),
    renameBufferPath: (bufferId, path) => workbench.renameBufferPath(bufferId, path),
    statusMessages: deps.statusMessages,
    marker,
    notifySurfaceChange: () => forward.host.notifySurfaceChange(),
  });
  forward.languageWiring = languageWiring;
  // On-demand rendering only paints after a keypress/resize/pointer event requests a frame.
  // Every service/model subscription below that can change what a surface reads (diagnostics,
  // explorer, search, picker, outline/hover/completion/signature, task output, file index) must
  // notify `host` so the next tick's frame reflects it even without further input.
  diagnostics.subscribe(() => forward.host.notifySurfaceChange());
  const syntaxResultSubscription = syntaxTracker.onResult((result) => {
    // spans are lazy/windowed now: sample the first 4,096 units instead of the O(document) spans getter.
    if (deps.xiUiTestMarkersEnabled) {
      const spans = result.spansInRange(0, 4096);
      marker('XI_SYNTAX_STATE', { documentId: result.documentId, version: result.documentVersion, status: result.status, spanCount: spans.length, rainbowScopes: [...new Set(spans.flatMap(span => span.scope?.startsWith('rainbow.') === true ? [span.scope] : []))] });
    }
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
  const fileIndex = new FilePathIndex({ maxEntries: 120_000, includeHidden: ctx.startupConfig?.editor.filePicker.hidden ?? true });
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
  diagnostics: InstanceType<CoreServicesModule['DiagnosticStore']>,
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
    new BufferPickerProvider('xi.navigation.diagnostics', () => diagnostics.model.all.map(problem => ({
      id: problem.id,
      label: `${problem.severity === 1 ? 'E' : problem.severity === 2 ? 'W' : problem.severity === 3 ? 'I' : 'H'} ${problem.code === undefined ? '' : `${problem.code}: `}${problem.message.replace(/\s+/gu, ' ')}`,
      detail: `${deps.coreServices.workspaceRelativePathFromUri(filesystem, workspaceRoot, problem.uri) ?? problem.uri}:${problem.range.startLine + 1}:${problem.range.startUtf16 + 1}`,
      value: problem.id,
      ...(problem.severity === undefined ? {} : { severity: problem.severity }),
    })), 'diagnostic'),
    new StaticPickerProvider('xi.navigation.commands', 'command', [
      { id: 'files.pick', mode: 'command', label: 'Files', detail: 'Open file picker', value: 'file' },
      { id: 'buffers.pick', mode: 'command', label: 'Buffers', detail: 'Switch open buffer', value: 'buffer' },
      { id: 'diagnostics.pick', mode: 'command', label: 'Diagnostics', detail: 'Search diagnostics', value: 'diagnostic' },
      { id: 'theme.pick', mode: 'command', label: 'Themes', detail: 'Choose a theme', value: 'theme' },
      { id: 'config.open', mode: 'command', label: 'Config', detail: 'Open configuration', value: 'config' },
      { id: 'mouse.toggle', mode: 'command', label: 'Toggle Mouse', detail: 'Enable/disable mouse reporting; disable for terminal-native click-drag text selection', value: 'toggle-mouse' },
    ]),
    // Live source: custom themes load when this picker first opens.
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
  const indentHeuristic = ctx.startupConfig?.editor.indentHeuristic;
  const motionTrail = ctx.startupConfig?.editor.motionTrail ?? 'last-motion';
  const continueComment = (snapshot: DocumentSnapshot, lineStart: number, cursorOffset: number): string | undefined => {
    const syntax = syntaxTracker.readSyntax(snapshot.id);
    return commentContinuationPrefix(snapshot, lineStart, cursorOffset, syntax !== undefined && syntax.documentVersion === snapshot.version
      ? (start, end) => syntax.spansInRange(start, end).some((span) => span.kind === 'comment')
      : undefined);
  };
  marker('XI_CONFIG_PROFILE', {
    profile: ctx.startupConfig?.profile ?? 'xi',
    schemaVersion: ctx.startupConfig?.schemaVersion ?? 1,
    motionTrail,
    motionGhost: motionTrail !== 'off',
    mouseModifier: ctx.startupConfig?.editor.mouse.modifier ?? 'none',
    selectionLimit: ctx.startupConfig?.editor.selection.limit ?? 10_000,
    selectionHistoryLimit: ctx.startupConfig?.editor.selection.historyLimit ?? 100,
    hintsDelayMs: ctx.startupConfig?.editor.hintsDelayMs ?? 250,
    searchDebounceMs: ctx.startupConfig?.search.debounceMs ?? 5,
    searchMaxVisibleResults: ctx.startupConfig?.search.maxVisibleResults ?? 10_000,
  });
  // Xi has no syntax-tree indentation queries yet; Helix's documented fallback is simple.
  const autoindent = indentHeuristic !== undefined;
  const host = new BufferHost(workbench, document, {
    motionGhost: motionTrail !== 'off',
    ...(ctx.startupConfig?.editor.selection.limit === undefined ? {} : { selectionLimit: ctx.startupConfig.editor.selection.limit }),
    ...(ctx.startupConfig?.editor.selection.historyLimit === undefined ? {} : { selectionHistoryLimit: ctx.startupConfig.editor.selection.historyLimit }),
    defaultYankRegister: ctx.startupConfig?.editor.defaultYankRegister ?? '"',
    mouseYankRegister: ctx.startupConfig?.editor.mouseYankRegister ?? '*',
    clipboard: deps.clipboard,
    insertOptions: {
      autoindent,
      continueComments: ctx.startupConfig?.editor.continueComments ?? true,
      commentContinuation: continueComment,
      smarttab: ctx.startupConfig?.editor.smartTab.enable ?? true,
      ...(ctx.startupConfig?.editor.autoPairs === undefined ? {} : { autoPairs: ctx.startupConfig.editor.autoPairs }),
    },
    insertOptionsForPath: (path) => {
      const settings = path === undefined ? undefined : deps.editorConfigForPath(path);
      if (settings === undefined) return undefined;
      const tabstop = settings.tabWidth ?? (typeof settings.indentSize === 'number' ? settings.indentSize : 8);
      const shiftwidth = settings.indentSize === 'tab' ? tabstop : settings.indentSize ?? tabstop;
      return { autoindent, continueComments: ctx.startupConfig?.editor.continueComments ?? true,
        commentContinuation: continueComment,
        smarttab: ctx.startupConfig?.editor.smartTab.enable ?? true,
        ...(ctx.startupConfig?.editor.autoPairs === undefined ? {} : { autoPairs: ctx.startupConfig.editor.autoPairs }),
        tabstop, shiftwidth, softtabstop: shiftwidth,
        ...(settings.indentStyle === undefined ? {} : { expandtab: settings.indentStyle === 'space' }),
      };
    },
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
      const currentPath = buffer === undefined ? undefined : workbench.buffer(buffer.bufferId)?.path;
      const path = target === undefined ? currentPath : filesystem.resolvePath(workspaceRoot, target);
      if (path === undefined) {
        ctx.deps.statusMessages.publish('xi: no file name');
        return false;
      }
      const saved = await forward.saveCoordinator.requestSave(sessionDocument, path, viewId);
      if (saved && currentPath === undefined && buffer !== undefined) {
        workbench.renameBufferPath(buffer.bufferId, path);
        forward.host.notifySurfaceChange();
      }
      return saved;
    },
    onExCommand: (source, viewId) => forward.hostCommands.handleWorkbenchCommand(source, viewId),
    onPrefixStateChange: (viewId, state) => forward.inputRouter.schedulePrefixHelp(viewId, state.pendingKeys, state.parserContinuations),
    onCommandLineChange: (state) => forward.inputRouter.handleCommandLineChange(state),
    onHostCommand: (command, viewId) => forward.hostCommands.handleVimHostCommand(command, viewId),
    onStateChange: (sessionDocument, state) => {
      const primary = state.selections.members.find((member) => member.id === state.selections.primaryId) ?? state.selections.members[0];
      if (primary === undefined) return;
      const snapshot = sessionDocument.snapshot();
      const line = snapshot.lineIndexAt(primary.head.at.offset);
      if (!line.ok) return;
      const start = snapshot.lineStartOffset(line.value);
      if (!start.ok) return;
      forward.languageWiring.refreshDocumentHighlights(String(sessionDocument.id), Number(line.value), Number(primary.head.at.offset) - Number(start.value));
      void forward.workspaceEditsFeature?.refreshCodeActionHints();
    },
    onBufferOpened: (buffer) => {
      syntaxTracker.openDocument({ documentId: buffer.documentId, languageId: languageIdForPath(buffer.path), snapshot: buffer.document.snapshot() });
      forward.languageWiring.admitBufferToLanguageSession(buffer.path, buffer.documentId, buffer.document);
      if (forward.languageWiring.hasServerForPath(buffer.path)) void forward.languageWiring.ensureLanguage().catch((error: unknown) => {
        deps.statusMessages.publish(`xi: language server unavailable: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
    onBufferClosed: (buffer) => {
      persistence.closeDocument(buffer.documentId);
      syntaxTracker.closeDocument(buffer.documentId);
      forward.directoryDraftController.closeDocument(buffer.documentId);
      forward.languageWiring.releaseBufferFromLanguageSession(buffer.path);
    },
  });
  marker('XI_SMART_TAB', { enable: ctx.startupConfig?.editor.smartTab.enable ?? true });
  marker('XI_CONTINUE_COMMENTS', { enable: ctx.startupConfig?.editor.continueComments ?? true });
  marker('XI_INDENT_HEURISTIC', { configured: indentHeuristic ?? 'hybrid', applied: autoindent ? 'simple' : 'disabled' });
  marker('XI_AUTO_PAIRS', { enabled: ctx.startupConfig?.editor.autoPairs !== false, pairs: ctx.startupConfig?.editor.autoPairs ?? {} });
  marker('XI_EDITOR_CONFIG', { enabled: ctx.startupConfig?.editor.editorConfig ?? true, lineNumber: ctx.startupConfig?.editor.lineNumber ?? 'absolute' });
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
  mouseMode: ReturnType<typeof createRendererToggle>,
  fileUri: CoreServicesModule['fileUri'],
  openDiagnostic: (id: string) => Promise<void>,
): { readonly optionalServices: OptionalServicesWiring; readonly picker: PickerController<PickerEntry, WorkbenchTheme> } {
  const { deps, filesystem, clock, marker, workspaceRoot } = ctx;
  const optionalServices = createOptionalServicesWiring({
    filesystem,
    explorerIncludeHidden: !(ctx.startupConfig?.editor.fileExplorer.hidden ?? false),
    explorerFollowSymlinks: ctx.startupConfig?.editor.fileExplorer.followSymlinks ?? false,
    explorerFlattenDirs: ctx.startupConfig?.editor.fileExplorer.flattenDirs ?? true,
    ...(ctx.startupConfig?.search.debounceMs === undefined ? {} : { searchDebounceMilliseconds: ctx.startupConfig.search.debounceMs }),
    ...(ctx.startupConfig?.search.maxVisibleResults === undefined ? {} : { searchDefaultLimit: ctx.startupConfig.search.maxVisibleResults }),
    explorerIgnore: {
      parents: ctx.startupConfig?.editor.fileExplorer.parents ?? false,
      ignore: ctx.startupConfig?.editor.fileExplorer.ignore ?? false,
      gitIgnore: ctx.startupConfig?.editor.fileExplorer.gitIgnore ?? false,
      gitGlobal: ctx.startupConfig?.editor.fileExplorer.gitGlobal ?? false,
      gitExclude: ctx.startupConfig?.editor.fileExplorer.gitExclude ?? false,
      homeDirectory: process.env.HOME ?? process.cwd(),
      ...(process.env.XDG_CONFIG_HOME === undefined ? {} : { xdgConfigHome: process.env.XDG_CONFIG_HOME }),
    },
    ProcessPort: deps.NodeProcessPort,
    workspaceRoot,
    fileUri,
    processEnvironment,
    notifySurfaceChange: () => host.notifySurfaceChange(),
    createExplorerFilesystem,
    createGitDecorationPort,
    getExplorerFeature: () => forward.explorerFeature,
    getSearchFeature: () => forward.searchFeature,
    gitEnabled: deps.workspaceTrust.allowsGit,
  });
  forward.optionalServices = optionalServices;
  const picker = new PickerController<PickerEntry, WorkbenchTheme>({
    host,
    model: pickerModel,
    theme: deps.themeWiring.themeController,
    clock,
    marker,
    bufferStartPosition: ctx.startupConfig?.editor.bufferPicker.startPosition ?? 'current',
    includeHiddenByDefault: ctx.startupConfig?.editor.filePicker.hidden ?? true,
    startFileIndexPopulation: () => forward.startFileIndexPopulation(),
    startIgnoredFileIndexPopulation: () => forward.startIgnoredFileIndexPopulation(),
    loadThemeCatalog: () => deps.themeWiring.loadCustomThemes(),
    toggleMouseMode: mouseMode.toggle,
    openDiagnostic,
    openConfig: () => ensureUserConfigDocument(deps, host),
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
    // The default Files load yields to queued startup picker input; resume it once the
    // overlay closes, without starting a second directory scan under the picker.
    onClose: () => setImmediate(() => {
      if (!picker.isDisposed && !picker.isOpen && forward.sidebarController.visible && forward.sidebarController.lastPanel === 'files' && !forward.explorerFeature.isVisible) forward.explorerFeature.show();
    }),
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
  // T041/T042: directory-as-editable-text ("Space O", docs/architecture.md). All orchestration
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
    isPanelSelected: () => forward.sidebarController.visible && forward.sidebarController.lastPanel === 'files',
    onOpen: () => { forward.sidebarController.setPanel('files'); forward.sidebarController.setVisible(true); forward.sidebarController.expandSection('files'); },
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
      // that (docs/architecture.md), and hands the opened document back to the draft
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
    onOpen: () => { forward.sidebarController.setPanel('search'); forward.sidebarController.setVisible(true); },
    host,
    session: workbench,
    filesystem,
    marker,
    onError: (message) => ctx.deps.statusMessages.publish(message),
    workspaceRoot,
    searchSmartCase: ctx.startupConfig?.editor.search.smartCase ?? true,
    searchWrapAround: ctx.startupConfig?.editor.search.wrapAround ?? true,
    ensureServices: async () => { await forward.optionalServices.ensure(); },
  });
  forward.searchFeature = searchFeature;
  // Lazily bound to `optionalServices.current.gitStatusService`/`gitMutationCoordinator`,
  // constructed on first use exactly like `searchFeature`'s own `ensureServices` -- this
  // controller never touches the process/filesystem port directly.
  const gitPanelFeature = new GitPanelController({
    onOpen: () => { forward.sidebarController.setPanel('git'); forward.sidebarController.setVisible(true); },
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
    shell: ctx.startupConfig?.editor.shell ?? ['sh', '-c'],
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
    isOutlineVisible: () => forward.sidebarController.outlineVisible,
    onCollapse: () => { forward.sidebarController.collapseSection('outline'); forward.explorerFeature.open(); },
    revealOutline: () => {
      forward.sidebarController.setVisible(true);
      forward.sidebarController.expandSection('outline');
      if (!forward.explorerFeature.isVisible) forward.explorerFeature.show();
    },
  });
  const sidebarController = new SidebarController({
    initiallyVisible: ctx.startupConfig?.editor.sidebarVisible ?? true,
    initialPanel: ctx.startupConfig?.editor.sidebarPanel ?? 'files',
    onPanelChange: panel => ctx.editorState.setSidebarPanel(panel),
    persistence: { width: ctx.startupConfig?.editor.sidebarWidth, setWidth: width => ctx.editorState.setSidebarWidth(width) },
    onVisibilityChange: visible => ctx.editorState.setSidebarVisible(visible),
    panelState: () => (forward.searchFeature.isOpen ? 'search' : forward.gitPanelFeature.isOpen ? 'git' : 'files'),
  });
  marker('XI_SIDEBAR_CONFIG', { visible: sidebarController.visible, panel: sidebarController.lastPanel, width: sidebarController.width });
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
    createLocalCompletion: async () => new (await import('../../../../packages/services/src/entrypoints/completion')).CompletionController(),
    ensureOptionalServices: async () => { await forward.optionalServices.ensure(); },
    getSnippetSupport: () => (forward.optionalServices.current === undefined ? undefined : { expandSnippet: forward.optionalServices.current.expandSnippet, SnippetSession: forward.optionalServices.current.SnippetSession }),
    autoCompletion: ctx.startupConfig?.editor.autoCompletion ?? true,
    completionTimeoutMs: ctx.startupConfig?.editor.completionTimeout ?? 250,
    completionTriggerLen: ctx.startupConfig?.editor.completionTriggerLen ?? 2,
    wordCompletion: ctx.startupConfig?.editor.wordCompletion.enable ?? true,
    wordCompletionProvider: createWordCompletionProvider(() => [...host.documents.values()].map((document) => document.snapshot()), ctx.startupConfig?.editor.wordCompletion.triggerLength ?? 7),
    pathCompletion: ctx.startupConfig?.editor.pathCompletion ?? true,
    pathCompletionProvider: createPathCompletionProvider(filesystem, workbench, workspaceRoot),
    previewCompletionInsert: ctx.startupConfig?.editor.previewCompletionInsert ?? true,
    completionReplace: ctx.startupConfig?.editor.completionReplace ?? false,
    smartTabSupersedeMenu: ctx.startupConfig?.editor.smartTab.supersedeMenu ?? false,
    snippets: ctx.startupConfig?.editor.lsp.snippets ?? true,
    autoSignatureHelp: ctx.startupConfig?.editor.lsp.autoSignatureHelp ?? true,
    displaySignatureHelpDocs: ctx.startupConfig?.editor.lsp.displaySignatureHelpDocs ?? true,
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
    codeActionHints: ctx.startupConfig?.editor.statusline.left.includes('code-action-hint') === true
      || ctx.startupConfig?.editor.statusline.center.includes('code-action-hint') === true
      || ctx.startupConfig?.editor.statusline.right.includes('code-action-hint') === true
      || ctx.startupConfig?.editor.gutters.includes('code-action-hint') === true,
    notifySurfaceChange: () => forward.host.notifySurfaceChange(),
  });
  forward.workspaceEditsFeature = workspaceEditsFeature;
  forward.languageWiring.connect({ getBufferDocument: (documentId) => host.documents.get(documentId), overlayFeature, completionFeature, workspaceEditsFeature });
  return { completionFeature, workspaceEditsFeature };
}

function createPointerCapture(ctx: BuildContext, host: BufferHost, workbench: WorkbenchSession): WorkbenchPointerCapture {
  const { deps, marker } = ctx;
  return new WorkbenchPointerCapture({
    cancelPendingOperator: () => { host.activeSession()?.cancelPendingOperator(); },
    place: (intent) => {
      workbench.focus(intent.viewId as ViewId);
      const session = host.sessions.get(intent.viewId as ViewId);
      const applied = session?.placePointer(intent) ?? false;
      if (deps.xiUiTestMarkersEnabled) {
        const state = session?.readView(intent.viewId as ViewId);
        marker('XI_POINTER_STATE', { kind: intent.kind, applied, viewId: intent.viewId, row: intent.head.row, column: intent.head.column, target: intent.head.target, mode: state?.session.mode, selectionCount: state?.selections.members.length, selectionKinds: state?.selections.members.map((member) => member.kind) });
      }
    },
    scroll: (viewId, delta, viewportHeight) => {
      const result = scrollViewBy(workbench, (viewIdentifier) => host.sessions.get(viewIdentifier), viewId as ViewId, delta, viewportHeight, ctx.startupConfig?.editor.scrolloff ?? 0);
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
  const { deps, filesystem, clock, persistence, marker, workspaceRoot, formatOnSave, configuredLanguages, startupConfig } = ctx;
  const saveCoordinator = new SaveCoordinator({
    host,
    session: workbench,
    persistence,
    clock,
    marker,
    onError: (message) => ctx.deps.statusMessages.publish(message),
    isTransientEditActive: (documentId) => forward.completionFeature?.isCompletionPreviewActiveFor(documentId) === true,
    formatOnSave,
    formatOnSaveForPath: (path) => {
      const language = languageIdForPath(path);
      return resolveFormatOnSave(process.env, language !== undefined && (configuredLanguages?.find((entry) => entry.name === language)?.autoFormat ?? false), startupConfig?.editor.autoFormat ?? true);
    },
    formatterKeyForPath: (path) => languageIdForPath(path) ?? '',
    insertFinalNewline: startupConfig?.editor.insertFinalNewline ?? true,
    trimFinalNewlines: startupConfig?.editor.trimFinalNewlines ?? false,
    trimTrailingWhitespace: startupConfig?.editor.trimTrailingWhitespace ?? false,
    editorConfigForPath: deps.editorConfigForPath,
    atomicSave: startupConfig?.editor.atomicSave ?? true,
    ...(startupConfig?.editor.autoSave.afterDelay === undefined ? {} : { autoSaveAfterDelay: startupConfig.editor.autoSave.afterDelay }),
    autoSaveFocusLost: startupConfig?.editor.autoSave.focusLost ?? false,
    createFormatterPipeline: async (path) => {
      const { FormatterPipeline, createExternalFormatter } = await import('../../../../packages/services/src/entrypoints/formatting');
      const language = path === undefined ? deps.languageId : languageIdForPath(path);
      const configuredFormatter = language === undefined ? undefined : configuredLanguages?.find((entry) => entry.name === language)?.formatter;
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
    workspaceTrust: deps.workspaceTrust,
    openConfig: () => ensureUserConfigDocument(deps, host),
    lookupDefinition: async () => {
      await forward.languageWiring.ensureLanguage();
      const navigation = forward.languageWiring.navigationController;
      const languageSession = forward.languageWiring.session;
      if (navigation === undefined || languageSession === undefined) return { ok: false, message: 'no language server for this file' };
      const request = buildNavigationRequest(workbench, ctx.deps.coreServices.fileUri);
      if (request === undefined) return { ok: false, message: 'no active buffer' };
      // The server for this buffer's language may still be initializing on the first `gd`;
      // wait (bounded) for its readiness, not for whichever server was opened last.
      if (request.uri === undefined || languageSession.sessionFor(request.uri)?.state !== 'ready') {
        const ready = await Promise.race([languageSession.waitForReady(request.uri), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 8000))]);
        if (ready !== undefined && !ready.ok) return { ok: false, message: ready.error.message };
      }
      const result = await navigation.definition(request);
      if (!result.ok) return { ok: false, message: result.error.message };
      // Servers may list the local import alias first; prefer the declaration in another file.
      const first = result.value.find((location) => location.uri !== request.uri) ?? result.value[0];
      if (first === undefined) return { ok: false, message: 'no definition found' };
      return { ok: true, location: { uri: first.uri, line: first.startLine, utf16: first.startUtf16 } };
    },
    lookupReferences: async () => {
      await forward.languageWiring.ensureLanguage();
      const navigation = forward.languageWiring.navigationController;
      const languageSession = forward.languageWiring.session;
      if (navigation === undefined || languageSession === undefined) return { ok: false, message: 'no language server for this file' };
      const request = buildNavigationRequest(workbench, ctx.deps.coreServices.fileUri);
      if (request === undefined) return { ok: false, message: 'no active buffer' };
      if (request.uri === undefined || languageSession.sessionFor(request.uri)?.state !== 'ready') {
        const ready = await Promise.race([languageSession.waitForReady(request.uri), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 8000))]);
        if (ready !== undefined && !ready.ok) return { ok: false, message: ready.error.message };
      }
      const includeDeclaration = ctx.startupConfig?.editor.lsp.gotoReferenceIncludeDeclaration ?? true;
      const result = await navigation.references(request, includeDeclaration);
      marker('XI_REFERENCES_REQUEST', { includeDeclaration, count: result.ok ? result.value.length : 0 });
      if (!result.ok) return { ok: false, message: result.error.message };
      const first = result.value.find((location) => location.uri !== request.uri || location.startLine !== request.position.line || location.startUtf16 !== request.position.utf16) ?? result.value[0];
      if (first === undefined) return { ok: false, message: 'no references found' };
      return { ok: true, location: { uri: first.uri, line: first.startLine, utf16: first.startUtf16 } };
    },
    focusSidebar: () => {
      const panel = forward.sidebarController.lastPanel;
      if (panel === 'search') forward.searchFeature.open();
      else if (panel === 'git') forward.gitPanelFeature.open();
      else forward.explorerFeature.open();
      return true;
    },
    focusEditorFromSidebar: (direction) => {
      // Files sits above Outline in the sidebar column: Ctrl-W j/k moves between them.
      if (direction === 'down' && forward.explorerFeature.isOpen) { forward.overlayFeature.openOutline(); return true; }
      if (direction === 'up' && forward.overlayFeature.isOutlineOpen) { forward.overlayFeature.closeOutline(); forward.explorerFeature.open(); return true; }
      const focused = forward.explorerFeature.isOpen || forward.searchFeature.isOpen || forward.gitPanelFeature.isOpen || forward.overlayFeature.isOutlineOpen;
      if (!focused || (direction !== 'right' && direction !== 'next' && direction !== 'previous')) return false;
      host.closeAllPanels();
      forward.inputRouter?.focusEditor();
      host.notifySurfaceChange();
      return true;
    },
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
  mouseMode: ReturnType<typeof createRendererToggle>,
  wrapMode: ReturnType<typeof createRendererToggle>,
  directoryDraftController: DirectoryDraftController,
  gitDiffFeature: DiffViewController,
  onConfigReload: () => Promise<boolean>,
): { readonly inputRouter: WorkbenchInputRouter; readonly pointerRouter: WorkbenchPointerRouter } {
  forward.gitPanelOpen = () => picker.isOpen && picker.mode === 'git';
  const { marker, startupConfig, clock } = ctx;
  const canonicalHintsSource = startupConfig?.provenance['xi.hints.delay-ms'];
  const legacyHintsSource = startupConfig?.provenance['editor.hints.delay-ms'];
  const hintsOverride = (canonicalHintsSource !== undefined && canonicalHintsSource !== 'defaults')
    || (legacyHintsSource !== undefined && legacyHintsSource !== 'defaults');
  const prefixHelpDelay = hintsOverride ? startupConfig?.editor.hintsDelayMs : startupConfig?.editor.idleTimeout ?? 250;
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
    autoInfo: startupConfig?.editor.autoInfo ?? true,
    ...(prefixHelpDelay === undefined ? {} : { idleTimeout: prefixHelpDelay }),
    workspaceEdits: workspaceEditsFeature,
    executeWorkbenchCommand: (source, viewId) => forward.hostCommands.handleWorkbenchCommand(source, viewId),
    isExplorerServiceLoaded: () => forward.optionalServices.current !== undefined,
    isSearchServiceLoaded: () => forward.optionalServices.current !== undefined,
    ensureOptionalServices: async () => { await forward.optionalServices.ensure(); },
    toggleMouseMode: mouseMode.toggle,
    toggleWrap: wrapMode.toggle,
    toggleSidebar: () => {
      const panel = sidebarController.readModel().panel;
      sidebarController.setVisible(!sidebarController.visible);
      marker('XI_SIDEBAR_VISIBILITY', { visible: sidebarController.visible });
      if (sidebarController.visible) {
        if (panel === 'search') forward.searchFeature.open();
        else if (panel === 'git') forward.gitPanelFeature.open();
        else forward.explorerFeature.open();
      }
      else { host.closeAllPanels(); forward.explorerFeature.hide(); }
      host.notifySurfaceChange();
    },
    toggleSidebarOutline: () => {
      if (!sidebarController.visible || sidebarController.readModel().panel !== 'files') {
        sidebarController.setVisible(true);
        forward.explorerFeature.open();
      }
      sidebarController.toggleSection('outline');
      marker('XI_SIDEBAR_OUTLINE', { expanded: sidebarController.outlineVisible });
      if (sidebarController.outlineVisible) overlayFeature.openOutline();
      else if (overlayFeature.isOutlineOpen) { overlayFeature.closeOutline(); forward.explorerFeature.open(); }
      host.notifySurfaceChange();
    },
    launchViewId: id<ViewId>('xi-launch-view'),
    bindings: startupConfig?.bindings ?? [],
    ...(startupConfig?.editor.jumpLabelAlphabet === undefined ? {} : { jumpLabelAlphabet: startupConfig.editor.jumpLabelAlphabet }),
    reloadConfig: onConfigReload,
    scrollLines: startupConfig?.editor.mouse.scrollLines ?? 1,
    scrolloff: startupConfig?.editor.scrolloff ?? 0,
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
    onLayoutChange: () => host.notifySurfaceChange(),
    session: workbench,
    marker,
    clock,
    mouseModifier: startupConfig?.editor.mouse.modifier ?? 'none',
    onTabActivate: (bufferId, viewId) => { host.focusBufferById(bufferId, viewId as ViewId | undefined); host.notifySurfaceChange(); },
    onEditorPointerDown: () => {
      inputRouter.focusEditor();
      if (forward.explorerFeature.isOpen || forward.searchFeature.isOpen) { host.closeAllPanels(); host.notifySurfaceChange(); }
    },
    onMiddleClick: (event) => {
      if (startupConfig?.editor.middleClickPaste !== true || event.target === undefined) return false;
      const session = host.sessions.get(event.viewId as ViewId);
      if (session === undefined) return false;
      const cell = { row: event.cell.row, column: event.cell.column, target: event.target };
      if (!session.placePointer({ kind: 'click', viewId: event.viewId, anchor: cell, head: cell, modifiers: { shift: event.modifiers?.shift ?? false, alt: event.modifiers?.alt ?? false, ctrl: event.modifiers?.ctrl ?? false, meta: event.modifiers?.meta ?? false } })) return false;
      void session.handleClipboardPaste('primary');
      marker('XI_MIDDLE_CLICK_PASTE', { viewId: event.viewId, row: event.cell.row, column: event.cell.column });
      return true;
    },
    onTabPin: (bufferId) => { workbench.pinBuffer(id<DocumentId>(bufferId)); host.notifySurfaceChange(); },
    // `closeBuffer` with no decision closes a clean buffer immediately and returns a
    // `dirty-buffer` error (no side effect) for one with unsaved changes -- the tab close
    // glyph never silently discards edits; a dirty buffer just stays open until saved.
    onTabClose: (bufferId, viewId) => {
      if (viewId !== undefined && gitDiffFeature.readComparison(id<ViewId>(bufferId)) === undefined) {
        const active = host.focusBufferById(bufferId, viewId as ViewId);
        if (active !== undefined) void Promise.resolve(forward.hostCommands.handleWorkbenchCommand('q', active)).then(() => host.notifySurfaceChange());
        return;
      }
      if (gitDiffFeature.readComparison(id<ViewId>(bufferId)) !== undefined) { workbench.focus(id<ViewId>(bufferId)); gitDiffFeature.close(); }
      else {
        const buffer = workbench.buffer(id<DocumentId>(bufferId));
        if (buffer === undefined || buffer.dirty) return;
        for (const closedView of buffer.viewIds) host.closeView(closedView);
        host.notifySurfaceChange();
      }
    },
    resizeOutline: (height) => sidebarController.resizeOutline(height),
    sidebar: {
      beginResize: () => sidebarController.beginResize(),
      moveResize: (width) => { sidebarController.moveResize(width); host.notifySurfaceChange(); },
      commitResize: () => { sidebarController.commitResize(); host.notifySurfaceChange(); },
    },
    pointerCapture,
    contextMenu: contextMenuStore,
    picker: {
      previewSelected: () => picker.previewSelected(),
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
  const forward = {} as ForwardRefs; const mouseMode = createRendererToggle(); const wrapMode = createRendererToggle();
  const jobControlDisposables: Disposable[] = [];

  const settings = await loadStartupSettings(deps);
  let currentConfig = settings.startupConfig;
  const { syntaxAssetsCancellation, syntaxTracker } = createSyntaxTracker(filesystem, settings.startupConfig?.editor.rainbowBrackets ?? false);
  forward.syntaxTracker = syntaxTracker;
  const editorState = deps.themeWiring.editorState;
  const ctx: BuildContext = { editorState, deps, filesystem, clock, persistence, marker, ...settings };

  const workbench = createWorkbenchCore(ctx, forward, syntaxTracker);
  const diagnostics = new ctx.deps.coreServices.DiagnosticStore();
  const contextMenuStore = new deps.ContextMenuStore();
  const { languageWiring, taskWiring, syntaxResultSubscription } = createLanguageAndTaskWiring(ctx, forward, workbench, syntaxTracker, diagnostics, fileUri, () => currentConfig);
  const { fileIndex, commandRegistry, contributionRegistry, commandAliasRegistration } = await createRegistries(ctx);
  const pickerModel = createPickerModel(ctx, forward, workbench, fileIndex, diagnostics);
  const host = createHostController(ctx, forward, workbench, syntaxTracker);
  const { optionalServices, picker } = createOptionalServicesAndPicker(ctx, forward, host, pickerModel, mouseMode, fileUri, async diagnosticId => {
    const problem = diagnostics.model.all.find(candidate => candidate.id === diagnosticId);
    if (problem !== undefined) await problemsFeature.openProblem(problem);
  });
  diagnostics.subscribe(() => { if (picker.isOpen && picker.mode === 'diagnostic') picker.refresh(); });
  const { explorerFeature, directoryDraftController } = createExplorerAndDirectory(ctx, forward, host, workbench);
  const { searchFeature, gitPanelFeature, gitDiffFeature, problemsFeature, overlayFeature, sidebarController } = createSearchProblemsOverlaySidebar(ctx, forward, host, workbench, diagnostics, taskWiring, fileUri, workspacePathFromUri);
  forward.sidebarController = sidebarController;
  forward.overlayFeature = overlayFeature;
  const { completionFeature, workspaceEditsFeature } = createCompletionAndWorkspaceEdits(ctx, forward, host, workbench, diagnostics, overlayFeature, fileUri, workspaceRelativePathFromUri);
  const pointerCapture = createPointerCapture(ctx, host, workbench);
  createSaveAndHostCommands(ctx, forward, host, workbench, workspaceEditsFeature, problemsFeature, workspacePathFromUri);
  let applyReloadedConfig: () => Promise<boolean> = async () => false;
  const { inputRouter, pointerRouter } = createInputAndPointerRouters(ctx, forward, host, workbench, commandRegistry, picker, problemsFeature, overlayFeature, workspaceEditsFeature, sidebarController, pointerCapture, contextMenuStore, pickerModel, diagnostics, mouseMode, wrapMode, directoryDraftController, gitDiffFeature, () => applyReloadedConfig());
  let reloadInFlight: Promise<boolean> | undefined;
  let uiReload: (() => void) | undefined;
  const reloadConfig = (): Promise<boolean> => {
    if (reloadInFlight !== undefined) return reloadInFlight;
    const attempt = (async (): Promise<boolean> => {
      const loaded = await deps.reloadStartupConfig();
      if (loaded.config === undefined) {
        const detail = loaded.diagnostics.length === 0 ? 'configuration was rejected' : loaded.diagnostics.join('; ');
        deps.statusMessages.publish(`xi: config reload failed: ${detail}`);
        marker('XI_CONFIG_RELOAD', { ok: false, diagnostics: loaded.diagnostics });
        return false;
      }
      currentConfig = loaded.config;
      forward.saveCoordinator.updateSavePolicy({
        atomicSave: loaded.config.editor.atomicSave ?? true,
        insertFinalNewline: loaded.config.editor.insertFinalNewline,
        trimFinalNewlines: loaded.config.editor.trimFinalNewlines,
        trimTrailingWhitespace: loaded.config.editor.trimTrailingWhitespace,
        autoSaveAfterDelay: loaded.config.editor.autoSave.afterDelay,
        autoSaveFocusLost: loaded.config.editor.autoSave.focusLost,
      });
      optionalServices.reconcileTrust();
      await languageWiring.reconcileTrust();
      inputRouter.updateConfig({
        bindings: loaded.config.bindings,
        autoInfo: loaded.config.editor.autoInfo,
        scrollLines: loaded.config.editor.mouse.scrollLines,
        scrolloff: loaded.config.editor.scrolloff,
        jumpLabelAlphabet: loaded.config.editor.jumpLabelAlphabet,
      });
      uiReload?.();
      deps.statusMessages.publish(`xi: configuration reloaded; restart for remaining settings (generation ${loaded.config.generation})`, 'info');
      marker('XI_CONFIG_RELOAD', { ok: true, generation: loaded.config.generation, restartRequired: true });
      return true;
    })().finally(() => { reloadInFlight = undefined; });
    reloadInFlight = attempt;
    return attempt;
  };
  deps.workspaceTrust.attachReload(reloadConfig);
  applyReloadedConfig = reloadConfig;

  // Deferred until every controller `onPrefixStateChange`/`onCommandLineChange` delegates to
  // (`inputRouter`, constructed above) exists: `createSession`'s initial state publish can
  // invoke those callbacks synchronously.
  host.createSession(deps.document, id<ViewId>('xi-launch-view'));
  if (deps.workspaceTrust.shouldPrompt((currentConfig?.editor.lsp.enable ?? true) && languageWiring.hasServerForPath(deps.filePath?.path))) {
    contextMenuStore.openAt(Math.max(0, Math.floor((process.stdout.columns ?? 80) / 2) - 16), Math.max(0, Math.floor((process.stdout.rows ?? 24) / 2) - 1), [
      { id: 'trust', label: 'Trust workspace', enabled: true },
      { id: 'never', label: 'Never trust workspace', enabled: true },
    ], (choice) => {
      deps.workspaceTrust.dismissPrompt();
      const changed = choice === 'trust' ? deps.workspaceTrust.trust() : deps.workspaceTrust.exclude();
      void changed.then((ok) => { if (!ok) deps.statusMessages.publish('xi: workspace trust change failed'); host.notifySurfaceChange(); }).catch(() => deps.statusMessages.publish('xi: workspace trust change failed'));
    });
  }
  const filePicker = ctx.startupConfig?.editor.filePicker;
  const startFileIndexPopulation = createFileIndexPopulator(fileIndex, filesystem, ctx.workspaceRoot, filePicker?.followSymlinks ?? true, filePicker?.deduplicateLinks ?? true, filePicker?.maxDepth, { parents: filePicker?.parents ?? true, ignore: filePicker?.ignore ?? true, gitIgnore: filePicker?.gitIgnore ?? true, gitGlobal: filePicker?.gitGlobal ?? true, gitExclude: filePicker?.gitExclude ?? true, homeDirectory: process.env.HOME ?? process.cwd(), ...(process.env.XDG_CONFIG_HOME === undefined ? {} : { xdgConfigHome: process.env.XDG_CONFIG_HOME }) }, entries => picker.isOpen && picker.mode === 'file' && pickerModel.model.entries.length === 0 && hasNewLiteralMatch(pickerModel.model.query, entries), () => { if (picker.isOpen && picker.mode === 'file') picker.refresh(); }, message => deps.statusMessages.publish(message));
  forward.startFileIndexPopulation = startFileIndexPopulation;
  forward.startIgnoredFileIndexPopulation = createIgnoredFileIndexPopulator(fileIndex, filesystem, ctx.workspaceRoot, filePicker?.followSymlinks ?? true, filePicker?.deduplicateLinks ?? true, filePicker?.maxDepth, { parents: filePicker?.parents ?? true, ignore: filePicker?.ignore ?? true, gitIgnore: filePicker?.gitIgnore ?? true, gitGlobal: filePicker?.gitGlobal ?? true, gitExclude: filePicker?.gitExclude ?? true, homeDirectory: process.env.HOME ?? process.cwd(), ...(process.env.XDG_CONFIG_HOME === undefined ? {} : { xdgConfigHome: process.env.XDG_CONFIG_HOME }) }, startFileIndexPopulation, () => { if (picker.isOpen && picker.mode === 'file') picker.refresh(); }, message => deps.statusMessages.publish(message));
  const fileIndexStarter = createDeferredStart(1000, () => { void startFileIndexPopulation(); });
  async function ensureGitAndOpenPicker(): Promise<void> {
    const resolved = await optionalServices.ensure();
    void resolved.gitStatusService.refresh();
    picker.open('git');
  }

  return {
    editorState,
    get startupConfig() { return currentConfig; },
    reloadConfig,
    registerUiReload: (listener) => { uiReload = listener; },
    statusMessages: deps.statusMessages,
    workspaceTrust: deps.workspaceTrust,
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
    wrapMode,
    jobControlDisposables,
    fileIndexStarter,
    pickerPreview: createPickerPreview(ctx, host, workbench, diagnostics),
    editorDiagnostics: documentId => {
      const path = workbench.buffer(documentId)?.path;
      return path === undefined ? [] : diagnostics.diagnosticsFor(fileUri(path));
    },
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
function createPickerPreview(ctx: BuildContext, host: BufferHost, workbench: WorkbenchSession, diagnostics: InstanceType<CoreServicesModule['DiagnosticStore']>): Controllers['pickerPreview'] {
  const cache = new Map<string, { readonly title: string; readonly lines: readonly string[] } | 'loading'>();
  // `fatal: true` mirrors `openTextDocument`'s own binary detection (packages/document/src/
  // text-fidelity.ts): a picker preview must never hand raw/invalid-UTF-8 bytes to the
  // renderer -- terminal control bytes (ESC, etc.) inside binary file content would
  // otherwise be written straight to the pty and corrupt the whole screen, not just the
  // preview pane.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return (entry) => {
    const problem = entry.mode === 'diagnostic' ? diagnostics.model.all.find(candidate => candidate.id === entry.value) : undefined;
    const path = problem === undefined ? entry.mode === 'file' ? entry.value : undefined : ctx.deps.coreServices.workspacePathFromUri(problem.uri);
    if (path === undefined) return undefined;
    const live = workbench.buffers().find(buffer => buffer.path === path);
    const snapshot = live === undefined ? undefined : host.documents.get(live.documentId)?.snapshot();
    if (snapshot !== undefined) {
      const target = problem?.range.startLine ?? 0;
      const startLine = Math.max(0, target - 8);
      const lines: string[] = [];
      for (let line = startLine; line < Math.min(snapshot.lineCount, startLine + 40); line++) {
        const start = snapshot.lineStartOffset(line as Parameters<typeof snapshot.lineStartOffset>[0]);
        const next = snapshot.lineStartOffset((line + 1) as Parameters<typeof snapshot.lineStartOffset>[0]);
        if (!start.ok) break;
        const end = Math.min(next.ok ? Number(next.value) - 1 : snapshot.lengthUtf16, Number(start.value) + 500);
        const text = snapshot.slice(start.value, end as Parameters<typeof snapshot.slice>[1]);
        lines.push(text.ok ? text.value : '');
      }
      return { title: ctx.filesystem.workspaceRelativePath(ctx.workspaceRoot, path) ?? path, lines, startLine, selectedLine: target - startLine };
    }
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
