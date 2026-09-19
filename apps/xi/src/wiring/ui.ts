import type { ViewId } from '../../../../packages/primitives/src/entrypoints/launch';
import type { DirectoryDraftReadPort, DirectoryDraftReadModel } from '../../../../packages/ui/src/entrypoints/launch';
import { LIGHT_WORKBENCH_THEME } from '../../../../packages/ui/src/entrypoints/theme';
import type { runOpenTuiWorkbench } from '../../../../packages/ui/src/entrypoints/launch';
import type { PointerPanelEvent } from '../../../../packages/workbench/src/entrypoints/launch';
import type { ThemeWiring } from './theme';
import type { Controllers } from './controllers';

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

export interface WorkbenchUiOptionsDeps {
  readonly renderer: ReturnType<typeof import('../../../../packages/ui/src/entrypoints/launch').createOpenTuiRenderer>;
  readonly themeWiring: ThemeWiring;
  readonly marker: (name: string, payload?: unknown) => void;
  readonly startupTrace: (label: string) => void;
  readonly installJobControl: (control: { suspend: () => void; resume: () => void }) => { dispose(): void };
}

// `options` has a default value (`= {}`) in runOpenTuiWorkbench's signature, so indexing
// Parameters<> for it yields `OpenTuiWorkbenchOptions | undefined` (the optional-tuple-slot
// convention) even though this builder always returns a real object; NonNullable narrows that
// back to the type callers actually receive.
type WorkbenchUiOptions = NonNullable<Parameters<typeof runOpenTuiWorkbench>[2]>;

/** `explorer`/`search`/`output` are live getters (packages/ui/src/terminal.ts reads them on
 * every access, not once at construction) that must resolve to `undefined` until
 * `optionalServices.ensure()` finishes -- a genuine runtime "optional key, but the getter is
 * always defined" pattern `exactOptionalPropertyTypes` has no direct syntax for. Relaxing only
 * these three fields (instead of casting the whole return value, which hid the real theme-typing
 * bug fixed alongside this) keeps every other field's assignment fully checked. */
type RelaxedWorkbenchUiOptions = Omit<WorkbenchUiOptions, 'explorer' | 'search' | 'output'> & {
  readonly explorer?: WorkbenchUiOptions['explorer'] | undefined;
  readonly search?: WorkbenchUiOptions['search'] | undefined;
  readonly output?: WorkbenchUiOptions['output'] | undefined;
};

/** Workspace-search matches painted in the editor while the Search panel is open. The
 * controller memoizes its result per (generation, document, version), so the presentation
 * object identity only changes when the highlights actually change (the renderer
 * full-repaints on identity change, row-diffs otherwise). */
function buildSearchPresentationPort(workbench: Controllers['workbench'], searchFeature: Controllers['searchFeature']): NonNullable<WorkbenchUiOptions['presentation']> {
  const searchPresentations = new WeakMap<object, { readonly searchHighlight: NonNullable<ReturnType<typeof searchFeature.readPresentation>> }>();
  return {
    readPresentation: (viewId) => {
      const view = workbench.readView(viewId as ViewId);
      if (view === undefined) return undefined;
      const highlight = searchFeature.readPresentation(String(view.document.id), view.document.version);
      if (highlight === undefined) return undefined;
      let presentation = searchPresentations.get(highlight);
      if (presentation === undefined) { presentation = Object.freeze({ searchHighlight: highlight }); searchPresentations.set(highlight, presentation); }
      return presentation;
    },
  };
}

/** Builds the (large) options object `runOpenTuiWorkbench` takes: frame callbacks, panel read
 * models/handlers, and the `onReady` deferred work -- all sourced from the controllers record
 * `wiring/controllers.ts` already constructed. Mechanical extraction of what used to be
 * main()'s final ~110-line inline object literal. */
export function buildWorkbenchUiOptions(controllers: Controllers, deps: WorkbenchUiOptionsDeps): WorkbenchUiOptions {
  const {
    host, inputRouter, pointerRouter, sidebarController, contextMenuStore, syntaxTracker, optionalServices,
    mouseMode, jobControlDisposables, workbench, picker, pickerModel, explorerFeature, searchFeature,
    gitPanelFeature, gitDiffFeature, diagnostics, problemsFeature, taskWiring, directoryDraftController, overlayFeature, completionFeature,
    fileIndexStarter, pickerPreview, statusMessages,
  } = controllers;
  const { renderer, themeWiring, marker, startupTrace, installJobControl } = deps;
  const perfTraceEnabled = process.env.XI_PERF_TRACE === '1';

  const options: RelaxedWorkbenchUiOptions = {
    renderer,
    theme: themeWiring.themeController.get(themeWiring.themeController.activeId) ?? LIGHT_WORKBENCH_THEME,
    syntax: syntaxTracker,
    presentation: buildSearchPresentationPort(workbench, searchFeature),
    comparison: gitDiffFeature,
    gitBranch: () => optionalServices.current?.gitStatusService.snapshot?.branch,
    registerMouseToggle: mouseMode.registered,
    registerThemeSwitch: (setTheme) => { themeWiring.themeController.bindSetTheme(setTheme); },
    registerJobControl: (control: { suspend: () => void; resume: () => void }) => { jobControlDisposables.push(installJobControl(control)); },
    marker,
    subscribeSurfaceChanges: (listener) => host.onSurfaceChange(listener),
    onViewportAnchorChange: (viewId, scrollTop, scrollLeft) => {
      workbench.setViewScroll(viewId as ViewId, scrollTop, scrollLeft);
    },
    onViewportSizeChange: (viewId, heightCells) => {
      workbench.setViewViewportHeight(viewId as ViewId, heightCells);
    },
    onPointer: (event) => pointerRouter.handlePointer(event),
    onPaste: (bytes: Uint8Array) => inputRouter.handlePaste(bytes),
    onPointerCancel: (reason) => pointerRouter.handlePointerCancel(reason),
    onFrame: () => {
      sidebarController.refreshOutline();
      if (perfTraceEnabled) process.stderr.write(`XI_FRAME ${process.hrtime.bigint().toString()}\r\n`);
    },
    sidebar: () => sidebarController.readModel(),
    tabs: () => workbench.readTabs(),
    prefixHelp: inputRouter.prefixHelp,
    contextMenu: contextMenuStore,
    commandLine: {
      read: inputRouter.commandLine.read,
      isOpen: () => inputRouter.isCommandLineActive(),
    },
    statusMessage: { read: statusMessages },
    onReady: () => {
      startupTrace('ready-callback');
      // Start configured language support after the first frame instead of waiting for the
      // first hover/completion command. Initialization remains off the editable startup path.
      void controllers.languageWiring.ensureLanguage().catch((error: unknown) => {
        statusMessages.publish(`xi: language server unavailable: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (!themeWiring.needsCustomThemeNow) void themeWiring.loadCustomThemes().finally(() => themeWiring.disposeStateCancellation());
      else themeWiring.disposeStateCancellation();
      // Directory enumeration, watching and picker indexing are background
      // work. Starting them before the first frame makes the editor compete
      // with filesystem streams during the user's first interaction.
      fileIndexStarter.schedule();
      // The Files tree is visible by default; it loads in the background and never takes
      // keyboard focus from the editor.
      explorerFeature.show();
    },
    // H1-7: the router owns the ordered overlay-focus stack (and its own fallthrough) as the
    // one and only per-key dispatch `processKeypress` calls; the overlay port objects below
    // (`picker`, `explorer`, ...) stay for their read models/`isOpen`/`onPointer`, which
    // rendering still needs -- `packages/ui` holds no keyboard-dispatch logic of its own.
    dispatchKey: (event) => inputRouter.dispatchKey(event),
    picker: {
      read: pickerModel,
      isOpen: () => picker.isOpen,
      onPointer: (event: PointerPanelEvent) => pointerRouter.handlePanelPointer(event),
      preview: () => {
        const selected = pickerModel.model.entries.find((entry) => entry.id === pickerModel.model.selectedId);
        return selected?.mode === 'file' ? pickerPreview(selected.value) : undefined;
      },
    },
    get explorer() {
      const explorerTree = optionalServices.current?.explorerTree;
      return explorerTree === undefined ? undefined : {
        read: explorerTree,
        isOpen: () => explorerFeature.isVisible && sidebarController.readModel().panel === 'files',
        isFocused: () => explorerFeature.isOpen,
        onPointer: (event: PointerPanelEvent) => pointerRouter.handlePanelPointer(event),
        prompt: () => explorerFeature.promptText,
      };
    },
    get search() {
      const searchService = optionalServices.current?.searchService;
      return searchService === undefined ? undefined : {
        read: searchService,
        isOpen: () => searchFeature.isOpen,
        selectedId: () => searchService.model.matches[searchFeature.selectedIndex]?.id,
        state: () => searchFeature.uiState,
        onPointer: (event: PointerPanelEvent) => pointerRouter.handlePanelPointer(event),
      };
    },
    git: {
      read: gitPanelFeature,
      isOpen: () => gitPanelFeature.isOpen,
      onPointer: (event: PointerPanelEvent) => pointerRouter.handlePanelPointer(event),
    },
    problems: {
      read: diagnostics,
      isOpen: () => problemsFeature.isProblemsOpen,
      selectedId: () => problemsFeature.selectedProblemId(),
      onPointer: (event: PointerPanelEvent) => pointerRouter.handlePanelPointer(event),
    },
    get output() {
      return taskWiring.taskController === undefined ? undefined : {
        read: taskWiring.taskController,
        isOpen: () => problemsFeature.isOutputOpen,
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
    },
    outline: {
      read: overlayFeature.outlineRead,
      isOpen: () => overlayFeature.isOutlineOpen,
    },
    hover: {
      read: overlayFeature.hoverRead,
      isOpen: () => overlayFeature.isHoverOpen,
    },
    completion: {
      read: completionFeature.completionRead,
      isOpen: () => completionFeature.isCompletionOpen,
    },
    signature: {
      read: completionFeature.signatureRead,
      isOpen: () => completionFeature.isSignatureOpen,
    },
  };
  return options as WorkbenchUiOptions;
}
