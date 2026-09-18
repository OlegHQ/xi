import type { ViewId } from '../../../../packages/primitives/src/entrypoints/launch';
import type { WorkbenchTheme, DirectoryDraftReadPort, DirectoryDraftReadModel } from '../../../../packages/ui/src/entrypoints/launch';
import { BUILTIN_WORKBENCH_THEMES } from '../../../../packages/ui/src/entrypoints/theme';
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

interface LauncherKeyEvent {
  readonly name: string;
  readonly raw: string;
  readonly shift: boolean;
  readonly option: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
}

export interface WorkbenchUiOptionsDeps {
  readonly renderer: ReturnType<typeof import('../../../../packages/ui/src/entrypoints/launch').createOpenTuiRenderer>;
  readonly themeWiring: ThemeWiring;
  readonly marker: (name: string, payload?: unknown) => void;
  readonly startupTrace: (label: string) => void;
  readonly installJobControl: (control: { suspend: () => void; resume: () => void }) => { dispose(): void };
}

/** Builds the (large) options object `runOpenTuiWorkbench` takes: frame callbacks, panel read
 * models/handlers, and the `onReady` deferred work -- all sourced from the controllers record
 * `wiring/controllers.ts` already constructed. Mechanical extraction of what used to be
 * main()'s final ~110-line inline object literal. */
export function buildWorkbenchUiOptions(controllers: Controllers, deps: WorkbenchUiOptionsDeps): Parameters<typeof runOpenTuiWorkbench>[2] {
  const {
    host, inputRouter, pointerRouter, sidebarController, contextMenuStore, syntaxTracker, optionalServices,
    mouseMode, jobControlDisposables, workbench, picker, pickerModel, explorerFeature, searchFeature,
    diagnostics, problemsFeature, taskWiring, directoryDraftController, overlayFeature, completionFeature,
    fileIndexStarter,
  } = controllers;
  const { renderer, themeWiring, marker, startupTrace, installJobControl } = deps;

  return {
    renderer,
    theme: themeWiring.themeController.get(themeWiring.themeController.activeId) ?? BUILTIN_WORKBENCH_THEMES['xi-light'],
    syntax: syntaxTracker,
    gitBranch: () => optionalServices.gitStatusService?.snapshot?.branch,
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
      if (process.env.XI_PERF_TRACE === '1') process.stderr.write(`XI_FRAME ${process.hrtime.bigint().toString()}\r\n`);
    },
    sidebar: () => sidebarController.readModel(),
    tabs: () => workbench.readTabs(),
    prefixHelp: inputRouter.prefixHelp,
    contextMenu: contextMenuStore,
    commandLine: {
      read: inputRouter.commandLine.read,
      isOpen: () => inputRouter.isCommandLineActive(),
      onKeypress: (event) => inputRouter.handleCommandLineKeypress(event),
    },
    onReady: () => {
      startupTrace('ready-callback');
      if (!themeWiring.needsCustomThemeNow) void themeWiring.loadCustomThemes().finally(() => themeWiring.disposeStateCancellation());
      else themeWiring.disposeStateCancellation();
      // Directory enumeration, watching and picker indexing are background
      // work. Starting them before the first frame makes the editor compete
      // with filesystem streams during the user's first interaction.
      fileIndexStarter.schedule();
    },
    onKeypress: (event) => inputRouter.handleKeypress(event),
    picker: {
      read: pickerModel,
      isOpen: () => picker.isOpen,
      onKeypress: (event) => picker.handleKeypress(event),
      onPointer: (event: PointerPanelEvent) => pointerRouter.handlePanelPointer(event),
    },
    get explorer() {
      return optionalServices.explorerTree === undefined ? undefined : {
        read: optionalServices.explorerTree,
        isOpen: () => explorerFeature.isOpen,
        onKeypress: (event: LauncherKeyEvent) => explorerFeature.handleKeypress(event),
        onPointer: (event: PointerPanelEvent) => pointerRouter.handlePanelPointer(event),
      };
    },
    get search() {
      const searchService = optionalServices.searchService;
      return searchService === undefined ? undefined : {
        read: searchService,
        isOpen: () => searchFeature.isOpen,
        selectedId: () => searchService.model.matches[searchFeature.selectedIndex]?.id,
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
      return taskWiring.taskController === undefined ? undefined : {
        read: taskWiring.taskController,
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
  } as Parameters<typeof runOpenTuiWorkbench>[2];
}
