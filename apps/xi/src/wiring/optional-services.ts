import type { Disposable, Result } from '../../../../packages/primitives/src/entrypoints/launch';
import type { NodeFilesystemPort, NodeProcessPort } from '../../../../packages/platform/src/entrypoints/launch';
import type { ExplorerFilesystemPort, ExplorerFailure } from '../../../../packages/services/src/entrypoints/launch';
import type { ApplyReplacementEditsFn, ReplaceServicePort, SearchServicePort, WorkbenchReplaceApplyPort, WorkbenchSearchBufferSource } from '../../../../packages/workbench/src/entrypoints/launch';
import type { LaunchServices, GitServices } from './types';

type HostNavigationController = InstanceType<LaunchServices['HostNavigationController']>;
type ExplorerTree = InstanceType<LaunchServices['ExplorerTree']>;
type ExplorerNavigationController = InstanceType<LaunchServices['ExplorerNavigationController']>;
type RealtimeSearchService = InstanceType<LaunchServices['RealtimeSearchService']>;
type WorkspaceReplaceService = InstanceType<LaunchServices['WorkspaceReplaceService']>;
type GitStatusService = InstanceType<GitServices['GitStatusService']>;
type GitMutationCoordinator = InstanceType<GitServices['GitMutationCoordinator']>;

export interface OptionalServicesWiringDeps {
  readonly filesystem: NodeFilesystemPort;
  readonly ProcessPort: typeof NodeProcessPort;
  readonly workspaceRoot: string;
  readonly fileUri: (path: string) => string;
  readonly processEnvironment: () => Readonly<Record<string, string>>;
  readonly notifySurfaceChange: () => void;
  readonly createExplorerFilesystem: (filesystem: NodeFilesystemPort, root: string, onChanged: () => void) => ExplorerFilesystemPort;
  readonly createGitDecorationPort: (service: GitStatusService, root: string) => { read(path: string): Promise<Result<{ readonly state: 'modified' | 'staged' | 'untracked' | 'ignored' | 'conflicted'; readonly label: string; readonly colorToken: string } | undefined, ExplorerFailure>> };
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

export interface OptionalServicesWiring {
  ensure(): Promise<void>;
  awaitPending(): Promise<void>;
  scheduleGitRefresh(delayMilliseconds?: number): void;
  readonly hostNavigation: HostNavigationController | undefined;
  readonly explorerTree: ExplorerTree | undefined;
  readonly explorerController: ExplorerNavigationController | undefined;
  readonly explorerSubscription: Disposable | undefined;
  readonly gitStatusService: GitStatusService | undefined;
  readonly gitMutationCoordinator: GitMutationCoordinator | undefined;
  readonly searchService: RealtimeSearchService | undefined;
  readonly replaceService: WorkspaceReplaceService | undefined;
  readonly expandSnippet: LaunchServices['expandSnippet'] | undefined;
  readonly SnippetSession: LaunchServices['SnippetSession'] | undefined;
  readonly executeLanguageCodeAction: LaunchServices['executeLanguageCodeAction'] | undefined;
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
  let gitWatchRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let searchService: RealtimeSearchService | undefined;
  let replaceService: WorkspaceReplaceService | undefined;
  let expandSnippet: LaunchServices['expandSnippet'] | undefined;
  let SnippetSession: LaunchServices['SnippetSession'] | undefined;
  let executeLanguageCodeAction: LaunchServices['executeLanguageCodeAction'] | undefined;
  let initialization: Promise<void> | undefined;

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

  function ensure(): Promise<void> {
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
      const nextGitStatus = new git.GitStatusService({ process: new deps.ProcessPort(), root: deps.workspaceRoot, env: deps.processEnvironment() });
      nextGitStatus.subscribe(() => {
        refreshExplorerGitDecorations();
        deps.notifySurfaceChange();
      });
      gitStatusService = nextGitStatus;
      gitMutationCoordinator = new git.GitMutationCoordinator(git.createProcessGitMutationExecutor(new deps.ProcessPort(), deps.workspaceRoot, deps.processEnvironment()));
      void nextGitStatus.refresh();
      const nextExplorer = new ExplorerTree(
        deps.createExplorerFilesystem(deps.filesystem, deps.workspaceRoot, () => scheduleGitRefresh()),
        { git: deps.createGitDecorationPort(nextGitStatus, deps.workspaceRoot) },
      );
      const explorerRoot = nextExplorer.addRoot({ id: 'workspace', label: deps.workspaceRoot, path: deps.workspaceRoot });
      if (!explorerRoot.ok) throw new Error(`xi-explorer-root:${explorerRoot.error.kind}`);
      explorerTree = nextExplorer;
      const nextSearch = new RealtimeSearchService({
        backend: new RipgrepSearchBackend({ process: new deps.ProcessPort(), environment: deps.processEnvironment() }),
        debounceMilliseconds: 40,
        defaultLimit: 10_000,
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
      deps.notifySurfaceChange();
    })();
    return initialization;
  }

  return {
    ensure,
    awaitPending: () => initialization ?? Promise.resolve(),
    scheduleGitRefresh,
    get hostNavigation() { return hostNavigation; },
    get explorerTree() { return explorerTree; },
    get explorerController() { return explorerController; },
    get explorerSubscription() { return explorerSubscription; },
    get gitStatusService() { return gitStatusService; },
    get gitMutationCoordinator() { return gitMutationCoordinator; },
    get searchService() { return searchService; },
    get replaceService() { return replaceService; },
    get expandSnippet() { return expandSnippet; },
    get SnippetSession() { return SnippetSession; },
    get executeLanguageCodeAction() { return executeLanguageCodeAction; },
  };
}
