import type { ViewId } from '../../../../packages/primitives/src/entrypoints/launch';
import type { DirectoryDraftReadPort, DirectoryDraftReadModel } from '../../../../packages/ui/src/entrypoints/launch';
import { LIGHT_WORKBENCH_THEME, type WorkbenchTheme } from '../../../../packages/ui/src/entrypoints/theme';
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

/** Resolve Helix's true-color override at the terminal boundary. The config only overrides
 * a false capability detection; it does not turn a capable terminal off. */
export function resolveEditorColorMode(forceTrueColor: boolean, environment: Readonly<Record<string, string | undefined>> = process.env): 'truecolor' | 'ansi256' | 'no-color' {
  if (forceTrueColor) return 'truecolor';
  const term = environment.TERM?.toLowerCase();
  const colorTerm = environment.COLORTERM?.toLowerCase();
  if (colorTerm === 'truecolor' || colorTerm === '24bit' || term?.endsWith('-truecolor') === true || term?.endsWith('-direct') === true) return 'truecolor';
  if (term === undefined || term === 'dumb') return 'no-color';
  return 'ansi256';
}

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

function buildStatuslineCallbacks(workbench: Controllers['workbench'], controllers: Controllers): Pick<WorkbenchUiOptions, 'statuslineFileType' | 'statuslineIndentStyle' | 'statuslineLspActivity' | 'statuslineRegister' | 'statuslineCodeActionHints'> {
  return {
    statuslineFileType: () => {
      const viewId = workbench.activeViewId;
      const view = viewId === undefined ? undefined : workbench.readView(viewId);
      const path = view === undefined ? undefined : workbench.buffer(view.document.id)?.path;
      return controllers.languageWiring.resolveLanguageId(path) ?? 'text';
    },
    statuslineIndentStyle: () => {
      const viewId = workbench.activeViewId;
      return viewId === undefined ? undefined : controllers.host.sessions.get(viewId)?.indentStyle;
    },
    statuslineLspActivity: () => (controllers.languageWiring.session?.health.progress.length ?? 0) > 0,
    statuslineRegister: () => controllers.startupConfig?.editor.defaultYankRegister ?? '"',
    statuslineCodeActionHints: () => {
      const viewId = workbench.activeViewId;
      const view = viewId === undefined ? undefined : workbench.readView(viewId);
      return view === undefined ? 0 : controllers.workspaceEditsFeature.codeActionHint(String(view.document.id), Number(view.document.version));
    },
  };
}

/** Workspace-search matches painted in the editor while the Search panel is open. The
 * controller memoizes its result per (generation, document, version), so the presentation
 * object identity only changes when the highlights actually change (the renderer
 * full-repaints on identity change, row-diffs otherwise). */
function buildEditorPresentationPort(workbench: Controllers['workbench'], searchFeature: Controllers['searchFeature'], host: Controllers['host'], languageWiring: Controllers['languageWiring'], renderer: WorkbenchUiOptionsDeps['renderer']): NonNullable<WorkbenchUiOptions['presentation']> {
  const presentations = new Map<string, NonNullable<ReturnType<NonNullable<WorkbenchUiOptions['presentation']>['readPresentation']>>>();
  const closeSubscription = host.onViewClosed(viewId => { presentations.delete(String(viewId)); });
  const clearGhost = (): void => { host.activeSession()?.clearMotionGhost(); host.notifySurfaceChange(); };
  void renderer.then(current => {
    current.on('blur', clearGhost);
    current.once('destroy', () => { current.off('blur', clearGhost); closeSubscription.dispose(); presentations.clear(); });
  });
  return {
    readPresentation: (viewId) => {
      const view = workbench.readView(viewId as ViewId);
      if (view === undefined) return undefined;
      const searchHighlight = searchFeature.readPresentation(String(view.document.id), view.document.version) ?? null;
      const highlightRanges = languageWiring.documentHighlights(String(view.document.id), Number(view.document.version));
      const documentHighlight = highlightRanges.length === 0 ? null : {
        documentId: String(view.document.id),
        documentVersion: Number(view.document.version),
        ranges: highlightRanges.flatMap((range) => {
          const start = view.document.lineStartOffset(range.startLine as Parameters<typeof view.document.lineStartOffset>[0]);
          const end = view.document.lineStartOffset(range.endLine as Parameters<typeof view.document.lineStartOffset>[0]);
          if (!start.ok || !end.ok) return [];
          return [{ start: Number(start.value) + range.startUtf16, end: Number(end.value) + range.endUtf16 }];
        }),
      };
      const motionPreview = workbench.activeViewId === viewId ? host.sessions.get(viewId as ViewId)?.motionGhost?.preview ?? null : null;
      if (searchHighlight === null && documentHighlight === null && motionPreview === null) { presentations.delete(viewId); return undefined; }
      const previous = presentations.get(viewId);
      if (previous?.searchHighlight === searchHighlight && previous?.documentHighlight === documentHighlight && previous.motionPreview === motionPreview) return previous;
      const presentation = Object.freeze({ searchHighlight, documentHighlight, motionPreview, motionTrail: 'last-motion' as const });
      presentations.set(viewId, presentation);
      return presentation;
    },
  };
}

function resolveStartupColorMode(controllers: Controllers, marker: WorkbenchUiOptionsDeps['marker']): NonNullable<WorkbenchUiOptions['colorMode']> {
  const colorMode = resolveEditorColorMode(controllers.startupConfig?.editor.trueColor ?? false);
  if (process.env.XI_UI_TEST_MARKERS === '1') marker('XI_COLOR_MODE', { colorMode, trueColor: controllers.startupConfig?.editor.trueColor ?? false, undercurl: controllers.startupConfig?.editor.undercurl ?? false, term: process.env.TERM, colorTerm: process.env.COLORTERM });
  return colorMode;
}

function resolveThemeVariants(controllers: Controllers, themeWiring: ThemeWiring): WorkbenchUiOptions['themeVariants'] {
  const configured = controllers.startupConfig?.editor.themeVariants;
  if (configured === undefined || themeWiring.persistedThemeId !== undefined) return undefined;
  const variants: { dark?: { readonly id: string; readonly theme: WorkbenchTheme }; light?: { readonly id: string; readonly theme: WorkbenchTheme }; fallback?: { readonly id: string; readonly theme: WorkbenchTheme } } = {};
  for (const mode of ['dark', 'light', 'fallback'] as const) {
    const id = configured[mode];
    const theme = id === undefined ? undefined : themeWiring.themeController.get(id);
    if (id !== undefined && theme !== undefined) variants[mode] = { id, theme };
  }
  return Object.keys(variants).length === 0 ? undefined : variants;
}

function handleWorkbenchReady(controllers: Controllers, themeWiring: ThemeWiring, startupTrace: WorkbenchUiOptionsDeps['startupTrace']): void {
  startupTrace('ready-callback');
  void controllers.languageWiring.ensureLanguage().catch((error: unknown) => {
    controllers.statusMessages.publish(`xi: language server unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });
  void themeWiring.loadCustomThemes().finally(() => themeWiring.disposeStateCancellation());
  controllers.fileIndexStarter.schedule();
  if (controllers.sidebarController.visible) {
    if (controllers.sidebarController.lastPanel === 'search') controllers.searchFeature.open();
    else if (controllers.sidebarController.lastPanel === 'git') controllers.gitPanelFeature.open();
    else controllers.explorerFeature.show();
  }
}

/** Builds the (large) options object `runOpenTuiWorkbench` takes: frame callbacks, panel read
 * models/handlers, and the `onReady` deferred work -- all sourced from the controllers record
 * `wiring/controllers.ts` already constructed. Mechanical extraction of what used to be
 * main()'s final ~110-line inline object literal. */
export function buildWorkbenchUiOptions(controllers: Controllers, deps: WorkbenchUiOptionsDeps): WorkbenchUiOptions {
  const {
    host, inputRouter, pointerRouter, sidebarController, contextMenuStore, syntaxTracker, optionalServices,
    mouseMode, jobControlDisposables, workbench, picker, pickerModel, explorerFeature, searchFeature, gitPanelFeature, gitDiffFeature, diagnostics, problemsFeature, taskWiring, directoryDraftController, overlayFeature, completionFeature,
    fileIndexStarter, pickerPreview, statusMessages,
  } = controllers;
  const { renderer, themeWiring, marker, startupTrace, installJobControl } = deps;
  const themeVariants = resolveThemeVariants(controllers, themeWiring); const colorMode = resolveStartupColorMode(controllers, marker); const options: RelaxedWorkbenchUiOptions = {
    renderer,
    startupTrace,
    colorMode, undercurl: controllers.startupConfig?.editor.undercurl ?? false,
    theme: themeWiring.themeController.get(themeWiring.themeController.activeId) ?? LIGHT_WORKBENCH_THEME,
    registerViewportConfig: (update) => controllers.registerUiReload(() => update({
      lineNumber: controllers.startupConfig?.editor.lineNumber ?? 'absolute',
      rulers: controllers.startupConfig?.editor.rulers ?? [],
    })),
    ...(themeVariants === undefined ? {} : { themeVariants, onThemeMode: (mode: 'dark' | 'light' | 'fallback', id: string) => { themeWiring.themeController.setActiveId(id); marker('XI_THEME_MODE', { mode, id }); } }),
    mouseEnabled: controllers.startupConfig?.editor.mouse.enabled ?? true, kittyKeyboardProtocol: controllers.startupConfig?.editor.kittyKeyboardProtocol ?? 'auto',
    syntax: syntaxTracker,
    editorDiagnostics: controllers.editorDiagnostics,
    presentation: buildEditorPresentationPort(workbench, searchFeature, host, controllers.languageWiring, renderer),
    virtualAnnotations: (documentId, documentVersion) => [
      ...controllers.languageWiring.virtualAnnotations(documentId, documentVersion),
      ...controllers.inputRouter.jumpLabelAnnotations(documentId, documentVersion),
    ],
    editorCodeActionHints: (documentId, documentVersion) => controllers.workspaceEditsFeature.codeActionHint(documentId, documentVersion),
    comparison: gitDiffFeature,
    gitBranch: () => optionalServices.current?.gitStatusService.snapshot?.branch, workspaceRoot: process.cwd(),
    ...buildStatuslineCallbacks(workbench, controllers),
    workspaceTrustRestricted: () => {
      const viewId = workbench.activeViewId;
      const view = viewId === undefined ? undefined : workbench.readView(viewId);
      const path = view === undefined ? undefined : workbench.buffer(view.document.id)?.path;
      return controllers.workspaceTrust.restricted((controllers.startupConfig?.editor.lsp.enable ?? true) && controllers.languageWiring.hasServerForPath(path));
    },
    registerMouseToggle: mouseMode.registered,
    registerThemeSwitch: (setTheme) => { themeWiring.themeController.bindSetTheme(setTheme); },
    registerJobControl: (control: { suspend: () => void; resume: () => void }) => { jobControlDisposables.push(installJobControl(control)); },
    marker,
    onFocusChange: (focused) => controllers.saveCoordinator.handleFocusChange(focused),
    subscribeSurfaceChanges: (listener) => host.onSurfaceChange(listener),
    onViewportAnchorChange: (viewId, scrollTop, scrollLeft) => { marker('XI_VIEWPORT_ANCHOR', { viewId, scrollTop, scrollLeft, scrolloff: controllers.startupConfig?.editor.scrolloff ?? 0 }); workbench.setViewScroll(viewId as ViewId, scrollTop, scrollLeft); },
    scrolloff: controllers.startupConfig?.editor.scrolloff ?? 0,
    lineNumber: controllers.startupConfig?.editor.lineNumber ?? 'absolute', lineNumberMinWidth: controllers.startupConfig?.editor.lineNumberMinWidth ?? 3, gutters: controllers.startupConfig?.editor.gutters ?? ['diagnostics', 'spacer', 'line-numbers', 'spacer', 'diff'], indentGuides: controllers.startupConfig?.editor.indentGuides ?? { render: false, character: '│', skipLevels: 0 }, whitespace: controllers.startupConfig?.editor.whitespace ?? { render: { default: false, space: false, nbsp: false, nnbsp: false, tab: false, newline: false }, characters: { space: '·', nbsp: '⍽', nnbsp: '␣', tab: '→', tabpad: ' ', newline: '⏎' } }, statusline: controllers.startupConfig?.editor.statusline ?? { left: ['mode', 'spinner', 'file-name', 'read-only-indicator', 'file-modification-indicator'], center: [], right: ['diagnostics', 'selections', 'register', 'position', 'file-encoding'], separator: '│', mode: { normal: 'NOR', insert: 'INS', select: 'SEL' }, diagnostics: ['warning', 'error'], workspaceDiagnostics: ['warning', 'error'] }, workspaceDiagnostics: () => diagnostics.model.all,
    wrap: controllers.startupConfig?.editor.wrap ?? false, ...(controllers.startupConfig?.editor.wrapAtTextWidth === true ? { wrapWidth: controllers.startupConfig.editor.textWidth } : {}), maxWrap: controllers.startupConfig?.editor.softWrapMaxWrap ?? 20, maxIndentRetain: controllers.startupConfig?.editor.softWrapMaxIndentRetain ?? 40, wrapIndicator: controllers.startupConfig?.editor.wrapIndicator ?? '↪ ', inlineDiagnosticsCursorLine: controllers.startupConfig?.editor.inlineDiagnosticsCursorLine ?? 'warning', inlineDiagnosticsOtherLines: controllers.startupConfig?.editor.inlineDiagnosticsOtherLines ?? 'disable', endOfLineDiagnostics: controllers.startupConfig?.editor.endOfLineDiagnostics ?? 'hint', inlineDiagnosticsPrefixLen: controllers.startupConfig?.editor.inlineDiagnosticsPrefixLen ?? 1, inlineDiagnosticsMaxWrap: controllers.startupConfig?.editor.inlineDiagnosticsMaxWrap ?? 20, inlineDiagnosticsMinDiagnosticWidth: controllers.startupConfig?.editor.inlineDiagnosticsMinDiagnosticWidth ?? 40, inlineDiagnosticsMaxDiagnostics: controllers.startupConfig?.editor.inlineDiagnosticsMaxDiagnostics ?? 10, cursorLine: controllers.startupConfig?.editor.cursorline ?? false, cursorColumn: controllers.startupConfig?.editor.cursorcolumn ?? false, colorModes: controllers.startupConfig?.editor.colorModes ?? false, bufferline: controllers.startupConfig?.editor.bufferline ?? 'never', popupBorder: controllers.startupConfig?.editor.popupBorder ?? 'none', rulers: controllers.startupConfig?.editor.rulers ?? [], cursorShape: controllers.startupConfig?.editor.cursorShape ?? { normal: 'block', insert: 'block', select: 'block' },
    onViewportSizeChange: (viewId, heightCells) => { marker('XI_VIEWPORT_SIZE', { viewId, heightCells }); workbench.setViewViewportHeight(viewId as ViewId, heightCells); },
    onPointer: (event) => {
      if (event.phase === 'down') host.activeSession()?.clearMotionGhost();
      return pointerRouter.handlePointer(event);
    },
    onPaste: (bytes: Uint8Array) => inputRouter.handlePaste(bytes),
    onPointerCancel: (reason) => pointerRouter.handlePointerCancel(reason),
    onFrame: () => {
      sidebarController.refreshOutline();
    },
    sidebar: () => sidebarController.readModel(),
    tabs: viewId => workbench.readTabs(viewId as ViewId | undefined),
    prefixHelp: inputRouter.prefixHelp,
    contextMenu: contextMenuStore,
    commandLine: {
      read: inputRouter.commandLine.read,
      isOpen: () => inputRouter.isCommandLineActive(),
    },
    statusMessage: { read: statusMessages },
    onReady: () => handleWorkbenchReady(controllers, themeWiring, startupTrace),
    // H1-7: the router owns the ordered overlay-focus stack (and its own fallthrough) as the
    // one and only per-key dispatch `processKeypress` calls; the overlay port objects below
    // (`picker`, `explorer`, ...) stay for their read models/`isOpen`/`onPointer`, which
    // rendering still needs -- `packages/ui` holds no keyboard-dispatch logic of its own.
    dispatchKey: (event) => inputRouter.dispatchKey(event),
    picker: {
      read: pickerModel,
      isOpen: () => picker.isOpen,
      onViewportRows: rows => picker.setVisibleRows(rows),
      onPointer: (event: PointerPanelEvent) => pointerRouter.handlePanelPointer(event),
      preview: () => {
        const selected = pickerModel.model.entries.find((entry) => entry.id === pickerModel.model.selectedId);
        return selected === undefined ? undefined : pickerPreview(selected);
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
  }; return options as WorkbenchUiOptions;
}
