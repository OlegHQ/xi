import type { Disposable, Result } from '../../../../packages/primitives/src/entrypoints/launch';
import type { NodeFilesystemPort, NodeProcessPort, WorkspaceIgnoreOptions } from '../../../../packages/platform/src/entrypoints/launch';
import type { ExplorerFilesystemPort, ExplorerFailure, ExplorerGitDecoration } from '../../../../packages/services/src/entrypoints/launch';
import type { ApplyReplacementEditsFn, ReplaceServicePort, SearchServicePort, WorkbenchReplaceApplyPort, WorkbenchSearchBufferSource } from '../../../../packages/workbench/src/entrypoints/launch';
import type { LaunchServices, GitServices } from './types';

type HostNavigationController = InstanceType<LaunchServices['HostNavigationController']>;
type ExplorerTree = InstanceType<LaunchServices['ExplorerTree']>;
type ExplorerNavigationController = InstanceType<LaunchServices['ExplorerNavigationController']>;
type RealtimeSearchService = InstanceType<LaunchServices['RealtimeSearchService']>;
type WorkspaceReplaceService = InstanceType<LaunchServices['WorkspaceReplaceService']>;
type GitStatusService = InstanceType<GitServices['GitStatusService']>;
type GitMutationCoordinator = InstanceType<GitServices['GitMutationCoordinator']>;
type GitDiffService = InstanceType<GitServices['GitDiffService']>;

export interface OptionalServicesWiringDeps {
  readonly filesystem: NodeFilesystemPort;
  readonly explorerIncludeHidden?: boolean;
  readonly explorerFollowSymlinks?: boolean;
  readonly explorerFlattenDirs?: boolean;
  readonly explorerIgnore?: WorkspaceIgnoreOptions;
  readonly searchDebounceMilliseconds?: number;
  readonly searchDefaultLimit?: number;
  readonly ProcessPort: typeof NodeProcessPort;
  readonly workspaceRoot: string;
  readonly gitEnabled?: () => boolean;
  readonly fileUri: (path: string) => string;
  readonly processEnvironment: () => Readonly<Record<string, string>>;
  readonly notifySurfaceChange: () => void;
  readonly createExplorerFilesystem: (filesystem: NodeFilesystemPort, root: string, onChanged: () => void, ignore?: WorkspaceIgnoreOptions) => ExplorerFilesystemPort;
  readonly createGitDecorationPort: (service: GitStatusService, root: string, filesystem: { workspaceRelativePath(root: string, path: string): string | undefined }) => { read(path: string): Promise<Result<ExplorerGitDecoration | undefined, ExplorerFailure>> };
  readonly getExplorerFeature: () => {
    openNode(node: { readonly path: string; readonly kind: string }): void;
    attachTree(tree: ExplorerTree, controller: ExplorerNavigationController): Disposable;
  };
  readonly getSearchFeature: () => {
    readBuffers(): readonly WorkbenchSearchBufferSource[];
    createReplacePort(): WorkbenchReplaceApplyPort;
    attachServices(search: SearchServicePort, replace: ReplaceServicePort, applyReplacementEdits: ApplyReplacementEditsFn): void;
  };
}

/** H2-4: the bundle `ensure()` resolves to. Every field is populated unconditionally inside
 * `ensure()`'s async block, so once it resolves every field is genuinely present -- consumers
 * that need these services take the whole resolved object (push injection, e.g. via
 * `attachTree`/`attachServices`) instead of reading any field back through an independent
 * nullable getter. */
export interface OptionalServices {
  readonly hostNavigation: HostNavigationController;
  readonly explorerTree: ExplorerTree;
  readonly explorerController: ExplorerNavigationController;
  readonly explorerSubscription: Disposable;
  readonly gitStatusService: GitStatusService;
  readonly gitMutationCoordinator: GitMutationCoordinator;
  readonly gitDiffService: GitDiffService;
  readonly searchService: RealtimeSearchService;
  readonly replaceService: WorkspaceReplaceService;
  readonly expandSnippet: LaunchServices['expandSnippet'];
  readonly SnippetSession: LaunchServices['SnippetSession'];
  readonly executeLanguageCodeAction: LaunchServices['executeLanguageCodeAction'];
}

export interface OptionalServicesWiring {
  ensure(): Promise<OptionalServices>;
  awaitPending(): Promise<OptionalServices | undefined>;
  scheduleGitRefresh(delayMilliseconds?: number): void;
  /** Clears the coalesced git-refresh timer, unsubscribes from git status changes and disposes
   * gitStatusService/gitMutationCoordinator -- none of which main.ts's teardown previously
   * touched. Safe to call whether or not `ensure()` ever resolved. */
  dispose(): void;
  /** The resolved bundle once `ensure()` has completed at least once; `undefined` until then.
   * One typed object pushed atomically on load, in place of the twelve independently-updated
   * nullable getters this replaced -- a field is never individually stale relative to the
   * others because the whole object only exists once every field does. */
  readonly current: OptionalServices | undefined;
}

/** Git status + Explorer tree + realtime search all become reachable through one lazy dynamic
 * import (`packages/services/src/entrypoints/launch` + `.../git`), so the composition root
 * previously bundled their construction into a single `initializeOptionalServices()` promise --
 * splitting that into three separately-imported modules would add two extra `import()` round
 * trips to the same lazy boundary and is exactly the "timing constant" AGENTS.md/the ticket
 * asks not to change. This module keeps them one cohesive cluster instead (still out of
 * `main()`: 13 fewer top-level `let`s), with a git-status-changed subscription that coalesces
 * bursty workspace watch events into at most one refresh per 500ms window per
 * AGENTS.md's bounded-background-work rule. */
export function createOptionalServicesWiring(deps: OptionalServicesWiringDeps): OptionalServicesWiring {
  let hostNavigation: HostNavigationController | undefined;
  let explorerTree: ExplorerTree | undefined;
  let explorerController: ExplorerNavigationController | undefined;
  let explorerSubscription: Disposable | undefined;
  let gitStatusService: GitStatusService | undefined;
  let gitMutationCoordinator: GitMutationCoordinator | undefined;
  let gitDiffService: GitDiffService | undefined;
  let gitStatusSubscription: Disposable | undefined;
  let gitWatchRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let searchService: RealtimeSearchService | undefined;
  let replaceService: WorkspaceReplaceService | undefined;
  let expandSnippet: LaunchServices['expandSnippet'] | undefined;
  let SnippetSession: LaunchServices['SnippetSession'] | undefined;
  let executeLanguageCodeAction: LaunchServices['executeLanguageCodeAction'] | undefined;
  let current: OptionalServices | undefined;
  let initialization: Promise<OptionalServices> | undefined;

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

  function ensure(): Promise<OptionalServices> {
    if (initialization !== undefined) return initialization;
    initialization = (async () => {
      const [services, git] = await Promise.all([
        import('../../../../packages/services/src/entrypoints/launch'),
        import('../../../../packages/services/src/entrypoints/git'),
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
      hostNavigation = new HostNavigationController(createCtagsNavigationHost({ filesystem: deps.filesystem, workspaceRoot: deps.workspaceRoot, fileUri: deps.fileUri }));
      const gitEnabled = deps.gitEnabled?.() ?? true;
      const nextGitStatus = new git.GitStatusService({ process: new deps.ProcessPort(), root: deps.workspaceRoot, env: deps.processEnvironment(), allowed: gitEnabled });
      gitStatusSubscription = nextGitStatus.subscribe(() => {
        refreshExplorerGitDecorations();
        deps.notifySurfaceChange();
      });
      gitStatusService = nextGitStatus;
      gitMutationCoordinator = new git.GitMutationCoordinator(git.createProcessGitMutationExecutor(new deps.ProcessPort(), deps.workspaceRoot, deps.processEnvironment()), gitEnabled);
      gitDiffService = new git.GitDiffService({ process: new deps.ProcessPort(), filesystem: deps.filesystem, env: deps.processEnvironment(), allowed: gitEnabled });
      if (gitEnabled) void nextGitStatus.refresh();
      const nextExplorer = new ExplorerTree(
        deps.createExplorerFilesystem(deps.filesystem, deps.workspaceRoot, () => scheduleGitRefresh(), deps.explorerIgnore),
        { includeHidden: deps.explorerIncludeHidden ?? false, followSymlinks: deps.explorerFollowSymlinks ?? false, flattenDirs: deps.explorerFlattenDirs ?? true, git: deps.createGitDecorationPort(nextGitStatus, deps.workspaceRoot, deps.filesystem) },
      );
      const explorerRoot = nextExplorer.addRoot({ id: 'workspace', label: deps.workspaceRoot, path: deps.workspaceRoot });
      if (!explorerRoot.ok) throw new Error(`xi-explorer-root:${explorerRoot.error.kind}`);
      explorerTree = nextExplorer;
      const nextSearch = new RealtimeSearchService({
        backend: new RipgrepSearchBackend({ process: new deps.ProcessPort(), environment: deps.processEnvironment() }),
        debounceMilliseconds: deps.searchDebounceMilliseconds ?? 40,
        defaultLimit: deps.searchDefaultLimit ?? 10_000,
        bufferSourceProvider: () => deps.getSearchFeature().readBuffers(),
      });
      searchService = nextSearch;
      const nextReplace = new WorkspaceReplaceService(deps.getSearchFeature().createReplacePort());
      replaceService = nextReplace;
      deps.getSearchFeature().attachServices(nextSearch, nextReplace, services.applyReplacementEdits);
      const nextExplorerController = new ExplorerNavigationController({ tree: nextExplorer, onOpen: (node) => deps.getExplorerFeature().openNode(node) });
      explorerController = nextExplorerController;
      explorerSubscription = deps.getExplorerFeature().attachTree(nextExplorer, nextExplorerController);
      expandSnippet = services.expandSnippet;
      SnippetSession = services.SnippetSession;
      executeLanguageCodeAction = services.executeLanguageCodeAction;
      // Every field above is assigned unconditionally in this block, so by the time `ensure()`
      // resolves the bundle is fully populated; this is the one value pushed to consumers.
      current = {
        hostNavigation, explorerTree, explorerController, explorerSubscription,
        gitStatusService, gitMutationCoordinator, gitDiffService, searchService, replaceService,
        expandSnippet, SnippetSession, executeLanguageCodeAction,
      };
      deps.notifySurfaceChange();
      return current;
    })();
    return initialization;
  }

  return {
    ensure,
    awaitPending: () => initialization ?? Promise.resolve(undefined),
    scheduleGitRefresh,
    dispose(): void {
      if (gitWatchRefreshTimer !== undefined) { clearTimeout(gitWatchRefreshTimer); gitWatchRefreshTimer = undefined; }
      gitStatusSubscription?.dispose();
      gitStatusSubscription = undefined;
      gitMutationCoordinator?.dispose();
      gitStatusService?.dispose();
    },
    get current() { return current; },
  };
}
