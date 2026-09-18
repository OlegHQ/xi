import { createCliRenderer, type CliRenderer, type CliRendererConfig, type KeyEvent } from '@opentui/core/renderer';
import { splitCoalescedEscape } from '../input/coalesced-escape';
import type { PasteEvent } from '@opentui/core';
import type { Disposable, DisposableScope, PlatformFailure, Result, SyntaxReadPort } from '../../contracts/src/index.ts';
import type { UiComposition, UiMountContext, TerminalAdapter, TerminalAdapterFactory } from './contracts';
import { ASCII_WORKBENCH_THEME, calculateWorkbenchLayout, computeSidebarSectionLayout, WorkbenchRenderable, type WorkbenchPointerEvent, type WorkbenchRenderableOptions, type WorkbenchTheme } from './workbench';
import type { WorkbenchReadPort } from '../../workbench/src/index.ts';
import type { PrefixHelpReadPort, PrefixHelpRenderable } from '../help/index';
import type { PickerReadPort, PickerRenderable, PickerTheme } from '../picker/index';
import type { ExplorerReadPort, ExplorerRenderable, ExplorerTheme } from '../explorer/index';
import type { SidebarReadModel, WorkbenchTabSnapshot } from '../../workbench/src/entrypoints/launch';
import type { SearchReadPort, SearchRenderable, SearchTheme } from '../search/index';
import type { ProblemsReadPort, ProblemsRenderable } from '../problems/index';
import type { TaskOutputReadPort, TaskOutputRenderable } from '../output/index';
import type { OutlineReadPort, OutlineRenderable, HierarchyReadPort, HierarchyRenderable, HoverReadPort, HoverRenderable } from '../navigation/index';
import type { CompletionReadPort, CompletionRenderable, SignatureReadPort, SignatureRenderable } from '../completion/index';
import type { ExCommandLineReadPort, ExCommandLineRenderable } from '../commandline/index';
import type { DirectoryDraftReadPort, DirectoryReviewRenderable } from '../directory/index';
import type { WorkbenchPanelPointerEvent } from './panel-pointer';
import type { ContextMenuStore, ContextMenuRenderable, ContextMenuBackdrop, ContextMenuTheme } from './context-menu';

/**
 * Render exactly one frame. OpenTUI's public `CliRenderer.intermediateRender()` sets
 * `immediateRerenderRequested = true` before invoking its internal `loop()`, and `loop()`
 * always schedules a second render via `setTimeout` whenever that flag is true when it
 * checks it -- see `loop()` in `@opentui/core`'s bundled source -- so every
 * `intermediateRender()` call produces two renders per key, not one. `loop()` itself only
 * reschedules when running continuously (`_isRunning`, unused here) or when that flag was
 * set, so calling it directly -- without setting the flag -- renders once. `loop` is typed
 * `private` in OpenTUI's declarations (compile-time only; the field is a plain public class
 * property at runtime), hence the structural cast instead of `any`.
 */
function renderOnce(renderer: CliRenderer): void {
  (renderer as unknown as { loop(): Promise<void> }).loop();
}

export interface OpenTuiTerminalAdapterOptions {
  readonly rendererConfig?: CliRendererConfig;
  readonly createRenderer?: () => Promise<CliRenderer>;
}

/** Owns the OpenTUI renderer and makes terminal cleanup explicit to the app scope. */
export class OpenTuiTerminalAdapter implements TerminalAdapter {
  #renderer: CliRenderer | undefined;
  #disposed = false;
  readonly #options: OpenTuiTerminalAdapterOptions;

  constructor(options: OpenTuiTerminalAdapterOptions = {}) {
    this.#options = options;
  }

  get renderer(): CliRenderer | undefined { return this.#renderer; }

  async start(): Promise<Result<void, PlatformFailure>> {
    if (this.#disposed) return failure('terminal-adapter-disposed', 'terminal adapter is disposed', false);
    if (this.#renderer !== undefined) return { ok: true, value: undefined };
    try {
      this.#renderer = this.#options.createRenderer === undefined
        ? await createCliRenderer({
          screenMode: 'alternate-screen',
          clearOnShutdown: true,
          exitOnCtrlC: false,
          enableMouseMovement: false,
          consoleMode: 'disabled',
          ...(this.#options.rendererConfig ?? {}),
        })
        : await this.#options.createRenderer();
      return { ok: true, value: undefined };
    } catch (error: unknown) {
      return failure('terminal-adapter-start-failed', error instanceof Error ? error.message : String(error), true);
    }
  }

  async suspend(): Promise<Result<void, PlatformFailure>> {
    if (this.#renderer === undefined || this.#renderer.isDestroyed) return failure('terminal-not-started', 'terminal renderer is not running', false);
    this.#renderer.suspend();
    return { ok: true, value: undefined };
  }

  async resume(): Promise<Result<void, PlatformFailure>> {
    if (this.#renderer === undefined || this.#renderer.isDestroyed) return failure('terminal-not-started', 'terminal renderer is not running', false);
    this.#renderer.resume();
    return { ok: true, value: undefined };
  }

  async restore(): Promise<void> {
    const renderer = this.#renderer;
    if (renderer !== undefined && !renderer.isDestroyed) renderer.destroy();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const renderer = this.#renderer;
    if (renderer !== undefined && !renderer.isDestroyed) renderer.destroy();
    this.#renderer = undefined;
  }
}

export interface OpenTuiUiCompositionOptions {
  readonly terminal?: OpenTuiTerminalAdapterOptions;
  readonly renderable?: Omit<WorkbenchRenderableOptions, 'workbench'>;
  /** Optional passive model; the panel has no keyboard or focus handlers. */
  readonly prefixHelp?: PrefixHelpReadPort;
  readonly prefixHelpHeight?: number;
}

export interface OpenTuiWorkbenchOptions {
  /** Renderer creation may begin while the application composes its workbench. */
  readonly renderer?: Promise<CliRenderer>;
  /** Called after the first frame starts; nonessential services may activate here. */
  readonly onReady?: () => void | Promise<void>;
  /**
   * Hands the application a toggle for the renderer's own mouse-reporting mode, so a documented
   * keybinding can flip it and let the terminal's native click-drag text selection work again.
   * The callback returns the mode's new enabled state.
   */
  readonly registerMouseToggle?: (toggle: () => boolean) => void;
  /** Hands the application a live theme setter, so a documented keybinding/picker action can
   * repaint the whole workbench with a new theme immediately (preview), and revert it just as
   * immediately (cancel) -- no renderer teardown/recreation involved. */
  readonly registerThemeSwitch?: (setTheme: (theme: WorkbenchTheme) => void) => void;
  /**
   * Hands the application the renderer-side half of terminal job control (Ctrl-Z/`fg`):
   * `suspend` releases pointer capture and stops the renderer painting; `resume` starts it
   * painting again. The platform layer owns the actual `SIGTSTP`/`SIGCONT` handling and the
   * process's own `SIGSTOP`; this adapter never touches process signals directly.
   */
  readonly registerJobControl?: (control: { readonly suspend: () => void; readonly resume: () => void }) => void;
  /** The theme every renderable surface starts painted with, before any picker interaction --
   * e.g. a persisted selection restored at launch. Defaults to the built-in light theme. */
  readonly theme?: WorkbenchTheme;
  /** Read-only syntax spans for the editor viewport; see `WorkbenchRenderableOptions.syntax`. */
  readonly syntax?: SyntaxReadPort;
  /** Current Git branch for the status line; undefined hides it. */
  readonly gitBranch?: () => string | undefined;
  /** Live sidebar section/width read model; see `WorkbenchRenderableOptions.sidebar`. Also
   * used to bound `getExplorerBounds`'s sidebar-docked region below the section headers. */
  readonly sidebar?: () => SidebarReadModel;
  /** Live buffer tab strip; see `WorkbenchRenderableOptions.tabs`. */
  readonly tabs?: () => readonly WorkbenchTabSnapshot[];
  /** Wake panels whose read ports become available after an asynchronous open. */
  readonly subscribeSurfaceChanges?: (listener: () => void) => Disposable;
  /** Forwarded to the main viewport renderable; see `WorkbenchRenderableOptions.onViewportAnchorChange`. */
  readonly onViewportAnchorChange?: (viewId: string, scrollTop: number, scrollLeft: number) => void;
  /** Forwarded to the main viewport renderable; see `WorkbenchRenderableOptions.onViewportSizeChange`. */
  readonly onViewportSizeChange?: (viewId: string, heightCells: number) => void;
  /** Return true when the application consumed the key, or `quit` after an application command. */
  readonly onKeypress?: (event: KeyEvent) => boolean | 'quit' | Promise<boolean | 'quit'>;
  /** Bracketed-paste bytes, delivered as one opaque event; never re-parsed as keystrokes. */
  readonly onPaste?: (bytes: Uint8Array) => void;
  /** Optional editor pointer route; semantic placement remains application-owned. */
  readonly onPointer?: (event: WorkbenchPointerEvent) => boolean;
  readonly onPointerCancel?: (reason: 'resize' | 'dispose' | 'escape' | 'suspend') => void;
  /** Diagnostic hook invoked after an explicit intermediate frame completes. */
  readonly onFrame?: () => void;
  /** Optional test/diagnostic marker sink; replaces a direct env-var/stderr write so the
   * platform layer decides whether and how a marker is emitted. */
  readonly marker?: (name: string, payload?: unknown) => void;
  /** Optional passive parser/help read model. It never receives keyboard focus. */
  readonly prefixHelp?: PrefixHelpReadPort;
  /** Optional right-click context menu state; the application owns items/activation. */
  readonly contextMenu?: ContextMenuStore;
  /** Optional read-only picker surface and application-owned input behavior. */
  readonly picker?: {
    readonly read: PickerReadPort;
    readonly isOpen: () => boolean;
    readonly onKeypress: (event: KeyEvent) => void | Promise<void>;
    readonly onPointer?: (event: WorkbenchPanelPointerEvent) => boolean;
  };
  /** Optional focused Explorer surface and application-owned navigation. */
  readonly explorer?: {
    readonly read: ExplorerReadPort;
    readonly isOpen: () => boolean;
    readonly onKeypress: (event: KeyEvent) => boolean | void | Promise<boolean | void>;
    readonly onPointer?: (event: WorkbenchPanelPointerEvent) => boolean;
  };
  /** Optional workspace search surface and application-owned query behavior. */
  readonly search?: {
    readonly read: SearchReadPort;
    readonly isOpen: () => boolean;
    readonly selectedId?: () => string | undefined;
    readonly onKeypress: (event: KeyEvent) => boolean | void | Promise<boolean | void>;
    readonly onPointer?: (event: WorkbenchPanelPointerEvent) => boolean;
  };
  /** Optional read-only diagnostics surface and application-owned close behavior. */
  readonly problems?: {
    readonly read: ProblemsReadPort;
    readonly isOpen: () => boolean;
    readonly selectedId?: () => string | undefined;
    readonly onKeypress: (event: KeyEvent) => boolean | void | Promise<boolean | void>;
    readonly onPointer?: (event: WorkbenchPanelPointerEvent) => boolean;
  };
  /** Optional read-only task output surface and application-owned close behavior. */
  readonly output?: {
    readonly read: TaskOutputReadPort;
    readonly isOpen: () => boolean;
    readonly onKeypress: (event: KeyEvent) => boolean | void | Promise<boolean | void>;
  };
  /** Optional read-only language outline and application-owned navigation. */
  readonly outline?: {
    readonly read: OutlineReadPort;
    readonly isOpen: () => boolean;
    readonly onKeypress: (event: KeyEvent) => boolean | void | Promise<boolean | void>;
  };
  /** Optional lazy hierarchy surface; host owns expansion, cancellation and link actions. */
  readonly hierarchy?: {
    readonly read: HierarchyReadPort;
    readonly isOpen: () => boolean;
    readonly onKeypress: (event: KeyEvent) => boolean | void | Promise<boolean | void>;
  };
  /** Optional read-only hover surface and application-owned close behavior. */
  readonly hover?: {
    readonly read: HoverReadPort;
    readonly isOpen: () => boolean;
    readonly onKeypress: (event: KeyEvent) => boolean | void | Promise<boolean | void>;
  };
  /**
   * Optional directory-draft review surface (a rename/move/copy plan before it is
   * applied). The UI never applies or closes it -- `onKeypress` returns whether the
   * composition root consumed the key so an unhandled key can still fall through to
   * the ordinary key path.
   */
  readonly directoryReview?: {
    readonly read: DirectoryDraftReadPort;
    readonly isOpen: () => boolean;
    readonly onKeypress: (event: KeyEvent) => 'handled' | 'unhandled';
  };
  /** Optional insert-mode completion popup and application-owned keyboard routing. */
  readonly completion?: {
    readonly read: CompletionReadPort;
    readonly isOpen: () => boolean;
    readonly onKeypress: (event: KeyEvent) => boolean | void | Promise<boolean | void>;
  };
  /** Optional signature help popup and application-owned close behavior. */
  readonly signature?: {
    readonly read: SignatureReadPort;
    readonly isOpen: () => boolean;
    readonly onKeypress: (event: KeyEvent) => boolean | void | Promise<boolean | void>;
  };
  /** Focused Ex command line; parsing and execution remain application-owned. */
  readonly commandLine?: {
    readonly read: ExCommandLineReadPort;
    readonly isOpen: () => boolean;
    readonly onKeypress: (event: KeyEvent) => boolean | 'quit' | void | Promise<boolean | 'quit' | void>;
  };
}

/** Start native OpenTUI initialization before the workbench model is ready. */
export function createOpenTuiRenderer(): Promise<CliRenderer> {
  return createCliRenderer({
    screenMode: 'alternate-screen',
    clearOnShutdown: true,
    exitOnCtrlC: false,
    enableMouseMovement: false,
    consoleMode: 'disabled',
  });
}

/** Composition adapter used by the application root after services/workbench exist. */
export function createOpenTuiUiComposition(options: OpenTuiUiCompositionOptions = {}): UiComposition {
  const terminalFactory: TerminalAdapterFactory = {
    async create(scope: DisposableScope): Promise<OpenTuiTerminalAdapter> {
      const adapter = scope.add(new OpenTuiTerminalAdapter(options.terminal));
      return adapter;
    },
  };
  return {
    terminal: terminalFactory,
    async mount(context: UiMountContext): Promise<Disposable> {
      if (!(context.terminal instanceof OpenTuiTerminalAdapter)) {
        throw new Error('open-tui-composition-requires-open-tui-terminal');
      }
      const renderer = context.terminal.renderer;
      if (renderer === undefined || renderer.isDestroyed) throw new Error('open-tui-renderer-not-started');
      const renderable = new WorkbenchRenderable(renderer.root.ctx, {
        ...options.renderable,
        workbench: context.workbench,
      });
      renderer.root.add(renderable);
      const helpModule = options.prefixHelp === undefined ? undefined : await import('../help/index');
      const help = options.prefixHelp === undefined || helpModule === undefined ? undefined : new helpModule.PrefixHelpRenderable(renderer.root.ctx, {
          help: options.prefixHelp,
          width: '100%',
          height: options.prefixHelpHeight ?? 6,
          position: 'absolute',
          left: 0,
          bottom: 1,
          zIndex: 10,
        });
      if (help !== undefined) renderer.root.add(help);
      return { dispose: () => {
        if (help !== undefined && !help.isDestroyed) help.destroyRecursively();
        if (!renderable.isDestroyed) renderable.destroyRecursively();
      } };
    },
  };
}

/** Derive each lazily-loaded panel's own narrower theme shape from the one WorkbenchTheme the
 * host application switches, so every themed surface repaints in step -- fixed git-status
 * accent colors are kept theme-independent (a disclosed simplification, not yet themed). */
function panelThemesFromWorkbench(theme: WorkbenchTheme): { readonly picker: PickerTheme; readonly explorer: ExplorerTheme; readonly search: SearchTheme; readonly contextMenu: ContextMenuTheme } {
  return {
    picker: { background: theme.background, surface: theme.surface, surfaceActive: theme.surfaceActive, foreground: theme.foreground, muted: theme.muted, accent: theme.accent, error: theme.error },
    explorer: { background: theme.background, surface: theme.surface, surfaceActive: theme.surfaceActive, foreground: theme.foreground, muted: theme.muted, border: theme.border, accent: theme.accent, error: theme.error, gitModified: '#9B6A16', gitAdded: '#367C4A', gitConflict: '#A52A36' },
    search: { background: theme.background, foreground: theme.foreground, muted: theme.muted, accent: theme.accent, border: theme.border, selectedBackground: theme.surfaceActive, hoverBackground: theme.surface },
    contextMenu: { background: theme.surface, foreground: theme.foreground, muted: theme.muted, selectedBackground: theme.surfaceActive },
  };
}

/** Start the small standalone shell used by `bun run xi`. */
export async function runOpenTuiWorkbench(
  workbench: WorkbenchReadPort,
  fileLabel = '[No Name]',
  options: OpenTuiWorkbenchOptions = {},
): Promise<void> {
  let finish!: () => void;
  const done = new Promise<void>((resolveDone) => { finish = resolveDone; });
  const renderer = await (options.renderer ?? createCliRenderer({
    screenMode: 'alternate-screen',
    clearOnShutdown: true,
    exitOnCtrlC: false,
    enableMouseMovement: false,
    consoleMode: 'disabled',
    onDestroy: finish,
  }));
  renderer.on('destroy', finish);
  options.registerMouseToggle?.(() => {
    renderer.useMouse = !renderer.useMouse;
    return renderer.useMouse;
  });
  // Suspending/resuming the terminal for job control (Ctrl-Z) is a platform effect
  // (sending SIGSTOP to our own process); this adapter only owns what the renderer
  // itself must do around that -- release pointer capture and stop painting before
  // the platform layer stops the process, then resume painting after it wakes us.
  let stoppedForJobControl = false;
  options.registerJobControl?.({
    suspend: () => {
      if (renderer.isDestroyed || stoppedForJobControl) return;
      stoppedForJobControl = true;
      viewport.cancelPointerCapture();
      options.onPointerCancel?.('suspend');
      renderer.suspend();
    },
    resume: () => {
      if (!stoppedForJobControl || renderer.isDestroyed) return;
      stoppedForJobControl = false;
      renderer.resume();
    },
  });
  const viewport = new WorkbenchRenderable(renderer.root.ctx, {
    workbench,
    fileLabel,
    ...(options.theme === undefined ? {} : { theme: options.theme }),
    ...(options.syntax === undefined ? {} : { syntax: options.syntax }),
    ...(options.gitBranch === undefined ? {} : { gitBranch: options.gitBranch }),
    ...(options.sidebar === undefined ? {} : { sidebar: options.sidebar }),
    ...(options.tabs === undefined ? {} : { tabs: options.tabs }),
    ...(options.onPointer === undefined ? {} : { onPointer: (event: WorkbenchPointerEvent): boolean => {
      const handled = options.onPointer?.(event) ?? false;
      if (handled) {
        syncSidebarSurfaceBounds();
        syncExplorerVisibility();
        syncOutlineVisibility();
        const install = installOpenOptionalSurfaces();
        // `WorkbenchRenderable.refresh()`/its own pointer-up handling only mark the
        // renderable dirty now (see workbench.ts); this is what actually schedules the
        // one synchronous frame a handled pointer event needs.
        if (install !== undefined) void install.then(requestFrame);
        else requestFrame();
      }
      return handled;
    } }),
    ...(options.onPointerCancel === undefined ? {} : { onPointerCancel: options.onPointerCancel }),
    ...(options.onViewportAnchorChange === undefined ? {} : { onViewportAnchorChange: options.onViewportAnchorChange }),
    ...(options.onViewportSizeChange === undefined ? {} : { onViewportSizeChange: options.onViewportSizeChange }),
  });
  renderer.root.add(viewport);
  let currentTheme = viewport.theme;
  options.registerThemeSwitch?.((theme) => {
    currentTheme = theme;
    viewport.setTheme(theme);
    const panelThemes = panelThemesFromWorkbench(theme);
    explorerSurface?.setTheme(panelThemes.explorer);
    pickerSurface?.setTheme(panelThemes.picker);
    searchSurface?.setTheme(panelThemes.search);
    contextMenuSurface?.setTheme(panelThemes.contextMenu);
    // `setTheme()` only marks the renderable dirty now (see workbench.ts); drive the
    // one synchronous frame the live preview/cancel/commit flow needs here.
    requestFrame();
  });
  let explorerSurface: ExplorerRenderable | undefined;
  let pickerSurface: PickerRenderable | undefined;
  let searchSurface: SearchRenderable | undefined;
  let problemsSurface: ProblemsRenderable | undefined;
  let outputSurface: TaskOutputRenderable | undefined;
  let outlineSurface: OutlineRenderable | undefined;
  let hierarchySurface: HierarchyRenderable | undefined;
  let hoverSurface: HoverRenderable | undefined;
  let directoryReviewSurface: DirectoryReviewRenderable | undefined;
  let completionSurface: CompletionRenderable | undefined;
  let signatureSurface: SignatureRenderable | undefined;
  let commandLineSurface: ExCommandLineRenderable | undefined;
  let prefixHelpSurface: PrefixHelpRenderable | undefined;
  let prefixHelpVisibilitySubscription: Disposable | undefined;
  let contextMenuSurface: ContextMenuRenderable | undefined;
  let contextMenuBackdropSurface: ContextMenuBackdrop | undefined;
  let contextMenuVisibilitySubscription: Disposable | undefined;
  let contextMenuModule: typeof import('./context-menu') | undefined;
  let optionalSurfacesInstallation: Promise<void> | undefined;
  const surfaceWakeSubscription = options.subscribeSurfaceChanges?.(() => {
    if (!renderer.isDestroyed) void installOptionalSurfaces().then(requestFrame);
  });
  const prefixHelpWakeSubscription = options.prefixHelp?.subscribe(() => {
    if (options.prefixHelp?.model !== undefined && prefixHelpSurface === undefined) {
      void installOptionalSurfaces().then(requestFrame);
    }
  });
  const contextMenuWakeSubscription = options.contextMenu?.subscribe(() => {
    if (options.contextMenu?.open === true && contextMenuSurface === undefined) {
      void installOptionalSurfaces().then(requestFrame);
      return;
    }
    if (contextMenuSurface === undefined) return;
    const state = options.contextMenu?.state;
    if (state !== undefined && contextMenuModule !== undefined) {
      const bounds = contextMenuModule.contextMenuBounds(state.items, state.left, state.top, renderer.width, renderer.height);
      contextMenuSurface.width = bounds.width;
      contextMenuSurface.height = bounds.height;
      contextMenuSurface.left = bounds.left;
      contextMenuSurface.top = bounds.top;
    }
    syncContextMenuVisibility();
    requestFrame();
  });
  const syncPickerVisibility = (): void => {
    if (pickerSurface !== undefined && options.picker !== undefined) pickerSurface.visible = options.picker.isOpen();
  };
  // The inline sidebar surfaces (Explorer/Outline) resize whenever a section's expand state
  // changes -- not just on a terminal resize -- because that changes the 60/40 split (or
  // hands one section the other's rows back). Re-applied every key/pointer refresh, which is
  // cheap (four field writes) and idempotent when nothing about the split actually moved.
  const syncSidebarSurfaceBounds = (): void => {
    if (explorerSurface !== undefined) {
      const bounds = getExplorerBounds(renderer.width, renderer.height, options.sidebar?.());
      explorerSurface.width = bounds.width;
      explorerSurface.height = bounds.height;
      explorerSurface.left = bounds.left;
      explorerSurface.top = bounds.top;
    }
    if (outlineSurface !== undefined) {
      const bounds = getSidebarOutlineBounds(renderer.width, renderer.height, options.sidebar?.());
      outlineSurface.width = bounds.width;
      outlineSurface.height = bounds.height;
      outlineSurface.left = bounds.left;
      outlineSurface.top = bounds.top;
    }
  };
  // Once the sidebar is showing, a section's own expand state is what shows/hides its inline
  // content -- opening a file closes the Explorer panel (returning keyboard focus to the
  // editor, `ExplorerController#openNode`) without hiding a still-expanded Files section,
  // exactly like every other always-visible sidebar tree. Narrower terminals (no sidebar; the
  // old floating overlay) keep the previous isOpen()-gated behavior.
  const explorerShouldBeVisible = (): boolean => {
    if (options.explorer === undefined) return false;
    const sidebar = options.sidebar?.();
    const sidebarVisible = calculateWorkbenchLayout(renderer.width, renderer.height, false, sidebar?.width).sidebarVisible;
    return sidebarVisible && sidebar !== undefined
      ? getExplorerBounds(renderer.width, renderer.height, sidebar).height > 0
      : options.explorer.isOpen();
  };
  const outlineShouldBeVisible = (): boolean => {
    if (options.outline === undefined) return false;
    const sidebar = options.sidebar?.();
    const sidebarVisible = calculateWorkbenchLayout(renderer.width, renderer.height, false, sidebar?.width).sidebarVisible;
    return sidebarVisible && sidebar !== undefined
      ? getSidebarOutlineBounds(renderer.width, renderer.height, sidebar).height > 0
      : options.outline.isOpen();
  };
  const syncExplorerVisibility = (): void => {
    if (explorerSurface !== undefined) explorerSurface.visible = explorerShouldBeVisible();
  };
  const syncSearchVisibility = (): void => {
    if (searchSurface !== undefined && options.search !== undefined) searchSurface.visible = options.search.isOpen();
  };
  const syncProblemsVisibility = (): void => {
    if (problemsSurface !== undefined && options.problems !== undefined) problemsSurface.visible = options.problems.isOpen();
  };
  const syncOutlineVisibility = (): void => {
    if (outlineSurface !== undefined) outlineSurface.visible = outlineShouldBeVisible();
  };
  const syncOutputVisibility = (): void => {
    if (outputSurface !== undefined && options.output !== undefined) outputSurface.visible = options.output.isOpen();
  };
  const syncHierarchyVisibility = (): void => {
    if (hierarchySurface !== undefined && options.hierarchy !== undefined) hierarchySurface.visible = options.hierarchy.isOpen();
  };
  const syncHoverVisibility = (): void => {
    if (hoverSurface !== undefined && options.hover !== undefined) hoverSurface.visible = options.hover.isOpen();
  };
  const syncDirectoryReviewVisibility = (): void => {
    if (directoryReviewSurface !== undefined && options.directoryReview !== undefined) directoryReviewSurface.visible = options.directoryReview.isOpen();
  };
  const syncCompletionVisibility = (): void => {
    if (completionSurface !== undefined && options.completion !== undefined) completionSurface.visible = options.completion.isOpen();
  };
  const syncSignatureVisibility = (): void => {
    if (signatureSurface !== undefined && options.signature !== undefined) signatureSurface.visible = options.signature.isOpen();
  };
  const syncCommandLineVisibility = (): void => {
    if (commandLineSurface !== undefined && options.commandLine !== undefined) commandLineSurface.visible = options.commandLine.isOpen();
  };
  const syncPrefixHelpVisibility = (): void => {
    if (prefixHelpSurface !== undefined && options.prefixHelp !== undefined) prefixHelpSurface.visible = options.prefixHelp.model !== undefined;
  };
  const syncContextMenuVisibility = (): void => {
    if (contextMenuSurface !== undefined && options.contextMenu !== undefined) contextMenuSurface.visible = options.contextMenu.open;
    if (contextMenuBackdropSurface !== undefined && options.contextMenu !== undefined) contextMenuBackdropSurface.visible = options.contextMenu.open;
  };
  const pendingKeys: KeyEvent[] = [];
  let pendingKeyHead = 0;
  let drainingKeys = false;
  let framePending = false;
  renderer.keyInput.on('keypress', (incoming: KeyEvent) => {
    const split = splitCoalescedEscape(incoming);
    for (const event of split ?? [incoming]) {
      if (event.name.toLowerCase() === 'escape' || event.name === 'ESC') {
        viewport.cancelPointerCapture();
        options.onPointerCancel?.('escape');
      }
      pendingKeys.push(event);
    }
    drainKeys();
  });
  renderer.keyInput.on('paste', (event: PasteEvent) => {
    options.onPaste?.(event.bytes);
    requestFrame();
  });

  function drainKeys(): void {
    if (drainingKeys) return;
    drainingKeys = true;
    while (pendingKeyHead < pendingKeys.length && !renderer.isDestroyed) {
      const event = pendingKeys[pendingKeyHead];
      pendingKeyHead += 1;
      if (event === undefined) break;
      let result: void | Promise<void>;
      try {
        result = processKeypress(event);
      } catch {
        renderer.destroy();
        break;
      }
      if (isPromiseLike(result)) {
        void result.then(() => {
          drainingKeys = false;
          drainKeys();
        }).catch(() => {
          drainingKeys = false;
          renderer.destroy();
        });
        return;
      }
    }
    if (pendingKeyHead === pendingKeys.length) {
      pendingKeys.length = 0;
      pendingKeyHead = 0;
    } else if (pendingKeyHead >= 64 && pendingKeyHead * 2 >= pendingKeys.length) {
      pendingKeys.splice(0, pendingKeyHead);
      pendingKeyHead = 0;
    }
    scheduleFlush();
    drainingKeys = false;
  }

  function processKeypress(event: KeyEvent): void | Promise<void> {
    if (options.contextMenu?.open === true) return finishFocusedKey(options.contextMenu.handleKey(event));
    if (options.commandLine?.isOpen() === true) return finishFocusedKey(options.commandLine.onKeypress(event));
    if (options.completion?.isOpen() === true) return finishFocusedKey(options.completion.onKeypress(event));
    if (options.picker?.isOpen() === true) return finishFocusedKey(options.picker.onKeypress(event));
    if (options.explorer?.isOpen() === true) return finishFocusedKey(options.explorer.onKeypress(event));
    if (options.search?.isOpen() === true) return finishFocusedKey(options.search.onKeypress(event));
    if (options.problems?.isOpen() === true) return finishFocusedKey(options.problems.onKeypress(event));
    if (options.output?.isOpen() === true) return finishFocusedKey(options.output.onKeypress(event));
    if (options.outline?.isOpen() === true) return finishFocusedKey(options.outline.onKeypress(event));
    if (options.hierarchy?.isOpen() === true) return finishFocusedKey(options.hierarchy.onKeypress(event));
    if (options.hover?.isOpen() === true) return finishFocusedKey(options.hover.onKeypress(event));
    if (options.directoryReview?.isOpen() === true && options.directoryReview.onKeypress(event) === 'handled') return refreshAfterKey();
    if (options.signature?.isOpen() === true) return finishFocusedKey(options.signature.onKeypress(event));
    const result = options.onKeypress === undefined ? false : options.onKeypress(event);
    if (isPromiseLike(result)) return result.then((value) => finishApplicationKey(event, value));
    return finishApplicationKey(event, result);
  }

  function finishFocusedKey(result: void | boolean | 'quit' | Promise<void | boolean | 'quit'>): void | Promise<void> {
    const finish = (value: void | boolean | 'quit'): void | Promise<void> => {
      if (value === 'quit') renderer.destroy();
      else return refreshAfterKey();
    };
    return isPromiseLike(result) ? result.then(finish) : finish(result);
  }

  function finishApplicationKey(_event: KeyEvent, result: boolean | 'quit'): void | Promise<void> {
    if (result === 'quit') { renderer.destroy(); return; }
    if (result === true) return refreshAfterKey();
  }

  function refreshAfterKey(): void | Promise<void> {
    syncSidebarSurfaceBounds();
    syncPickerVisibility();
    syncExplorerVisibility();
    syncSearchVisibility();
    syncProblemsVisibility();
    syncOutputVisibility();
    syncOutlineVisibility();
    syncHierarchyVisibility();
    syncHoverVisibility();
    syncDirectoryReviewVisibility();
    syncCompletionVisibility();
    syncSignatureVisibility();
    syncCommandLineVisibility();
    syncPrefixHelpVisibility();
    syncContextMenuVisibility();
    viewport.refresh();
    const install = installOpenOptionalSurfaces();
    if (install !== undefined) return install.then(requestFrame);
    requestFrame();
  }

  function requestFrame(): void {
    framePending = true;
    if (!drainingKeys && !renderer.isDestroyed) scheduleFlush();
  }

  /**
   * OpenTUI parses and emits every key in one stdin chunk synchronously (see
   * chunk-bun-37s3zwb6.js), and each key's own `drainKeys()` pass used to flush
   * (render) immediately, so a burst of keys arriving in the same chunk painted one
   * frame per key instead of one frame for the whole burst. Deferring the actual
   * flush to a microtask -- queued once per burst, not once per key -- coalesces
   * every key processed before the current synchronous stack unwinds into a single
   * render, without delaying (a microtask is not a timer) or reordering key
   * processing, which still happens synchronously and in order in `drainKeys()`.
   */
  let flushScheduled = false;
  function scheduleFlush(): void {
    if (flushScheduled || renderer.isDestroyed) return;
    flushScheduled = true;
    // @xi-perf-allow microtask INPUT-OUTPUT -- Same-tick frame coalescing across keys parsed from one stdin chunk; no CPU work is deferred, the frame is still painted before the event loop yields.
    queueMicrotask(() => {
      flushScheduled = false;
      flushFrame();
    });
  }

  function forwardPanelPointer(
    route: ((event: WorkbenchPanelPointerEvent) => boolean) | undefined,
    event: WorkbenchPanelPointerEvent,
  ): boolean {
    const handled = route?.(event) ?? false;
    if (handled) requestFrame();
    return handled;
  }

  function flushFrame(): void {
    if (!framePending || renderer.isDestroyed) return;
    framePending = false;
    // Resolve (and report back) every visible view's cursor-follow scroll anchor as a
    // pre-render step, so `WorkbenchRenderable.renderSelf`/`renderSplit` stay a
    // read-only projection of already-resolved anchors instead of deciding and
    // writing back scroll state while painting (see `syncAnchors`'s doc comment).
    viewport.syncAnchors();
    renderOnce(renderer);
    options.onFrame?.();
  }
  renderer.on('render:error', () => renderer.destroy());
  renderer.on('resize', () => {
    if (explorerSurface !== undefined) {
      const bounds = getExplorerBounds(renderer.width, renderer.height, options.sidebar?.());
      explorerSurface.width = bounds.width;
      explorerSurface.height = bounds.height;
      explorerSurface.left = bounds.left;
      explorerSurface.top = bounds.top;
    }
      if (searchSurface !== undefined) {
      const bounds = getSearchBounds(renderer.width, renderer.height);
      searchSurface.width = bounds.width;
      searchSurface.height = bounds.height;
      searchSurface.left = bounds.left;
        searchSurface.top = bounds.top;
      }
      if (problemsSurface !== undefined) {
        const bounds = getProblemsBounds(renderer.width, renderer.height);
        problemsSurface.width = bounds.width;
        problemsSurface.height = bounds.height;
        problemsSurface.left = bounds.left;
        problemsSurface.top = bounds.top;
      }
      if (outputSurface !== undefined) {
        const bounds = getProblemsBounds(renderer.width, renderer.height);
        outputSurface.width = bounds.width;
        outputSurface.height = bounds.height;
        outputSurface.left = bounds.left;
        outputSurface.top = bounds.top;
      }
      if (outlineSurface !== undefined) {
        const bounds = getSidebarOutlineBounds(renderer.width, renderer.height, options.sidebar?.());
        outlineSurface.width = bounds.width;
        outlineSurface.height = bounds.height;
        outlineSurface.left = bounds.left;
        outlineSurface.top = bounds.top;
      }
      if (hierarchySurface !== undefined) {
        const bounds = getOutlineBounds(renderer.width, renderer.height);
        hierarchySurface.width = bounds.width;
        hierarchySurface.height = bounds.height;
        hierarchySurface.left = bounds.left;
        hierarchySurface.top = bounds.top;
      }
      if (hoverSurface !== undefined) {
        const bounds = getHoverBounds(renderer.width, renderer.height);
        hoverSurface.width = bounds.width;
        hoverSurface.height = bounds.height;
        hoverSurface.left = bounds.left;
        hoverSurface.top = bounds.top;
      }
      if (directoryReviewSurface !== undefined) {
        const bounds = getDirectoryReviewBounds(renderer.width, renderer.height);
        directoryReviewSurface.width = bounds.width;
        directoryReviewSurface.height = bounds.height;
        directoryReviewSurface.left = bounds.left;
        directoryReviewSurface.top = bounds.top;
      }
      if (completionSurface !== undefined) {
        const bounds = getCompletionBounds(renderer.width, renderer.height);
        completionSurface.width = bounds.width;
        completionSurface.height = bounds.height;
        completionSurface.left = bounds.left;
        completionSurface.top = bounds.top;
      }
      if (signatureSurface !== undefined) {
        const bounds = getSignatureBounds(renderer.width, renderer.height);
        signatureSurface.width = bounds.width;
        signatureSurface.height = bounds.height;
        signatureSurface.left = bounds.left;
        signatureSurface.top = bounds.top;
      }
      if (commandLineSurface !== undefined) {
        const bounds = getCommandLineBounds(renderer.width, renderer.height);
        commandLineSurface.width = bounds.width;
        commandLineSurface.height = bounds.height;
        commandLineSurface.left = bounds.left;
        commandLineSurface.top = bounds.top;
      }
      if (prefixHelpSurface !== undefined) {
        const bounds = getPrefixHelpBounds(renderer.width, renderer.height);
        prefixHelpSurface.width = bounds.width;
        prefixHelpSurface.height = bounds.height;
        prefixHelpSurface.left = bounds.left;
        prefixHelpSurface.top = bounds.top;
      }
      if (contextMenuSurface !== undefined && contextMenuModule !== undefined) {
        const state = options.contextMenu?.state;
        if (state !== undefined) {
          const bounds = contextMenuModule.contextMenuBounds(state.items, state.left, state.top, renderer.width, renderer.height);
          contextMenuSurface.width = bounds.width;
          contextMenuSurface.height = bounds.height;
          contextMenuSurface.left = bounds.left;
          contextMenuSurface.top = bounds.top;
        }
      }
      if (contextMenuBackdropSurface !== undefined) {
        contextMenuBackdropSurface.width = renderer.width;
        contextMenuBackdropSurface.height = renderer.height;
      }
    if (pickerSurface === undefined) {
      viewport.syncAnchors();
      renderer.intermediateRender();
      return;
    }
    const width = Math.max(20, Math.min(renderer.width - 2, 100));
    const height = Math.max(3, Math.min(renderer.height - 2, 14));
    pickerSurface.width = width;
    pickerSurface.height = height;
    pickerSurface.left = Math.max(0, Math.floor((renderer.width - width) / 2));
    pickerSurface.top = Math.max(0, Math.floor((renderer.height - height) / 2));
    viewport.syncAnchors();
    renderer.intermediateRender();
  });
  let ready = false;
  renderer.on('frame', () => {
    if (ready) return;
    ready = true;
    options.marker?.('XI_WORKBENCH_READY', { width: renderer.width, height: renderer.height });
    if (options.onReady !== undefined) setTimeout(() => {
      if (renderer.isDestroyed) return;
      try { void Promise.resolve(options.onReady?.()).catch(() => renderer.destroy()); } catch { renderer.destroy(); }
    }, 0);
    // Panels load when opened; prefix help has its own visibility subscription.
  });
  // Xi renders on demand, not on a permanent frame-rate loop: idle state must
  // not drive continuous work (docs/plan/15-keystroke-latency.md). Every path
  // that can change what is visible (keys, resize, pointer, panel visibility,
  // and `subscribeSurfaceChanges`/prefix-help/context-menu wake subscriptions
  // above) already calls `requestFrame`/`intermediateRender`; a single explicit
  // render here paints the first frame without starting the continuous loop.
  viewport.syncAnchors();
  renderer.intermediateRender();
  await done;
  prefixHelpWakeSubscription?.dispose();
  contextMenuWakeSubscription?.dispose();
  surfaceWakeSubscription?.dispose();
  prefixHelpVisibilitySubscription?.dispose();
  contextMenuVisibilitySubscription?.dispose();

  function installOpenOptionalSurfaces(): Promise<void> | undefined {
    if (!optionalSurfaceIsOpenAndMissing()) return undefined;
    return installOptionalSurfaces();
  }

  function optionalSurfaceIsOpenAndMissing(): boolean {
    return (explorerShouldBeVisible() && explorerSurface === undefined)
      || (options.picker?.isOpen() === true && pickerSurface === undefined)
      || (options.search?.isOpen() === true && searchSurface === undefined)
      || (options.problems?.isOpen() === true && problemsSurface === undefined)
      || (options.output?.isOpen() === true && outputSurface === undefined)
      || (outlineShouldBeVisible() && outlineSurface === undefined)
      || (options.hierarchy?.isOpen() === true && hierarchySurface === undefined)
      || (options.hover?.isOpen() === true && hoverSurface === undefined)
      || (options.directoryReview?.isOpen() === true && directoryReviewSurface === undefined)
      || (options.completion?.isOpen() === true && completionSurface === undefined)
      || (options.signature?.isOpen() === true && signatureSurface === undefined)
      || (options.commandLine?.isOpen() === true && commandLineSurface === undefined)
      || (options.prefixHelp?.model !== undefined && prefixHelpSurface === undefined)
      || (options.contextMenu?.open === true && contextMenuSurface === undefined);
  }

  function installOptionalSurfaces(): Promise<void> {
    if (optionalSurfacesInstallation !== undefined) return optionalSurfacesInstallation;
    optionalSurfacesInstallation = (async () => {
      do {
        await installOptionalSurfacesNow();
      } while (!renderer.isDestroyed && optionalSurfaceIsOpenAndMissing());
    })().finally(() => { optionalSurfacesInstallation = undefined; });
    return optionalSurfacesInstallation;
  }

  async function installOptionalSurfacesNow(): Promise<void> {
    try {
      if (options.explorer !== undefined && explorerShouldBeVisible() && explorerSurface === undefined) {
        const explorer = options.explorer;
        const module = await import('../explorer/index');
        if (renderer.isDestroyed) return;
        const bounds = getExplorerBounds(renderer.width, renderer.height, options.sidebar?.());
        explorerSurface = new module.ExplorerRenderable(renderer.root.ctx, {
          explorer: explorer.read,
          theme: panelThemesFromWorkbench(currentTheme).explorer,
          ascii: currentTheme === ASCII_WORKBENCH_THEME,
          onPointer: (event) => forwardPanelPointer(options.explorer?.onPointer, event),
          width: bounds.width,
          height: bounds.height,
          position: 'absolute',
          left: bounds.left,
          top: bounds.top,
          zIndex: 20,
        });
        explorerSurface.visible = explorerShouldBeVisible();
        renderer.root.add(explorerSurface);
      }
      if (options.picker?.isOpen() === true && pickerSurface === undefined) {
        const module = await import('../picker/index');
        if (renderer.isDestroyed) return;
        const width = Math.max(20, Math.min(renderer.width - 2, 100));
        const height = Math.max(3, Math.min(renderer.height - 2, 14));
        pickerSurface = new module.PickerRenderable(renderer.root.ctx, {
          picker: options.picker.read,
          theme: panelThemesFromWorkbench(currentTheme).picker,
          onPointer: (event) => forwardPanelPointer(options.picker?.onPointer, event),
          width,
          height,
          position: 'absolute',
          left: Math.max(0, Math.floor((renderer.width - width) / 2)),
          top: Math.max(0, Math.floor((renderer.height - height) / 2)),
          zIndex: 100,
        });
        pickerSurface.visible = options.picker.isOpen();
        renderer.root.add(pickerSurface);
      }
      if (options.search?.isOpen() === true && searchSurface === undefined) {
        const module = await import('../search/index');
        if (renderer.isDestroyed) return;
        const bounds = getSearchBounds(renderer.width, renderer.height);
        searchSurface = new module.SearchRenderable(renderer.root.ctx, {
          search: options.search.read,
          ...panelThemesFromWorkbench(currentTheme).search,
          onPointer: (event) => forwardPanelPointer(options.search?.onPointer, event),
          ...(options.search.selectedId === undefined ? {} : { selectedId: options.search.selectedId }),
          width: bounds.width,
          height: bounds.height,
          position: 'absolute',
          left: bounds.left,
          top: bounds.top,
          zIndex: 90,
        });
        searchSurface.visible = options.search.isOpen();
        renderer.root.add(searchSurface);
      }
      if (options.problems?.isOpen() === true && problemsSurface === undefined) {
        const bounds = getProblemsBounds(renderer.width, renderer.height);
        const module = await import('../problems/index');
        if (renderer.isDestroyed) return;
        problemsSurface = new module.ProblemsRenderable(renderer.root.ctx, {
          problems: options.problems.read,
          ...(options.problems.selectedId === undefined ? {} : { selectedId: options.problems.selectedId }),
          onPointer: (event) => forwardPanelPointer(options.problems?.onPointer, event),
          width: bounds.width,
          height: bounds.height,
          position: 'absolute',
          left: bounds.left,
          top: bounds.top,
          zIndex: 80,
        });
        problemsSurface.visible = options.problems.isOpen();
        renderer.root.add(problemsSurface);
      }
      if (options.output?.isOpen() === true && outputSurface === undefined) {
        const bounds = getProblemsBounds(renderer.width, renderer.height);
        const module = await import('../output/index');
        if (renderer.isDestroyed) return;
        outputSurface = new module.TaskOutputRenderable(renderer.root.ctx, {
          output: options.output.read,
          width: bounds.width,
          height: bounds.height,
          position: 'absolute',
          left: bounds.left,
          top: bounds.top,
          zIndex: 80,
        });
        outputSurface.visible = options.output.isOpen();
        renderer.root.add(outputSurface);
      }
      if (options.outline !== undefined && outlineShouldBeVisible() && outlineSurface === undefined) {
        const outline = options.outline;
        const bounds = getSidebarOutlineBounds(renderer.width, renderer.height, options.sidebar?.());
        const module = await import('../navigation/index');
        if (renderer.isDestroyed) return;
        outlineSurface = new module.OutlineRenderable(renderer.root.ctx, {
          outline: outline.read,
          width: bounds.width,
          height: bounds.height,
          position: 'absolute',
          left: bounds.left,
          top: bounds.top,
          zIndex: 70,
        });
        outlineSurface.visible = outlineShouldBeVisible();
        renderer.root.add(outlineSurface);
      }
      if (options.hierarchy?.isOpen() === true && hierarchySurface === undefined) {
        const bounds = getOutlineBounds(renderer.width, renderer.height);
        const module = await import('../navigation/index');
        if (renderer.isDestroyed) return;
        hierarchySurface = new module.HierarchyRenderable(renderer.root.ctx, {
          hierarchy: options.hierarchy.read,
          width: bounds.width,
          height: bounds.height,
          position: 'absolute',
          left: bounds.left,
          top: bounds.top,
          zIndex: 75,
        });
        hierarchySurface.visible = options.hierarchy.isOpen();
        renderer.root.add(hierarchySurface);
      }
      if (options.hover?.isOpen() === true && hoverSurface === undefined) {
        const bounds = getHoverBounds(renderer.width, renderer.height);
        const module = await import('../navigation/index');
        if (renderer.isDestroyed) return;
        hoverSurface = new module.HoverRenderable(renderer.root.ctx, {
          hover: options.hover.read,
          width: bounds.width,
          height: bounds.height,
          position: 'absolute',
          left: bounds.left,
          top: bounds.top,
          zIndex: 110,
        });
        hoverSurface.visible = options.hover.isOpen();
        renderer.root.add(hoverSurface);
      }
      if (options.directoryReview?.isOpen() === true && directoryReviewSurface === undefined) {
        const bounds = getDirectoryReviewBounds(renderer.width, renderer.height);
        const module = await import('../directory/index');
        if (renderer.isDestroyed) return;
        directoryReviewSurface = new module.DirectoryReviewRenderable(renderer.root.ctx, {
          draft: options.directoryReview.read,
          width: bounds.width,
          height: bounds.height,
          position: 'absolute',
          left: bounds.left,
          top: bounds.top,
          zIndex: 105,
        });
        directoryReviewSurface.visible = options.directoryReview.isOpen();
        renderer.root.add(directoryReviewSurface);
      }
      if (options.completion?.isOpen() === true && completionSurface === undefined) {
        const bounds = getCompletionBounds(renderer.width, renderer.height);
        const module = await import('../completion/index');
        if (renderer.isDestroyed) return;
        completionSurface = new module.CompletionRenderable(renderer.root.ctx, {
          completion: options.completion.read,
          width: bounds.width,
          height: bounds.height,
          position: 'absolute',
          left: bounds.left,
          top: bounds.top,
          zIndex: 120,
        });
        completionSurface.visible = options.completion.isOpen();
        renderer.root.add(completionSurface);
      }
      if (options.signature?.isOpen() === true && signatureSurface === undefined) {
        const bounds = getSignatureBounds(renderer.width, renderer.height);
        const module = await import('../completion/index');
        if (renderer.isDestroyed) return;
        signatureSurface = new module.SignatureRenderable(renderer.root.ctx, {
          signature: options.signature.read,
          width: bounds.width,
          height: bounds.height,
          position: 'absolute',
          left: bounds.left,
          top: bounds.top,
          zIndex: 115,
        });
        signatureSurface.visible = options.signature.isOpen();
        renderer.root.add(signatureSurface);
      }
      if (options.commandLine?.isOpen() === true && commandLineSurface === undefined) {
        const bounds = getCommandLineBounds(renderer.width, renderer.height);
        const module = await import('../commandline/index');
        if (renderer.isDestroyed) return;
        commandLineSurface = new module.ExCommandLineRenderable(renderer.root.ctx, {
          commandLine: options.commandLine.read,
          width: bounds.width,
          height: bounds.height,
          position: 'absolute',
          left: bounds.left,
          top: bounds.top,
          zIndex: 130,
        });
        commandLineSurface.visible = options.commandLine.isOpen();
        renderer.root.add(commandLineSurface);
      }
      if (options.prefixHelp?.model !== undefined && prefixHelpSurface === undefined) {
        const bounds = getPrefixHelpBounds(renderer.width, renderer.height);
        const module = await import('../help/index');
        if (renderer.isDestroyed) return;
        prefixHelpSurface = new module.PrefixHelpRenderable(renderer.root.ctx, {
          help: options.prefixHelp,
          width: bounds.width,
          height: bounds.height,
          position: 'absolute',
          left: bounds.left,
          top: bounds.top,
          zIndex: 10,
        });
        prefixHelpSurface.visible = options.prefixHelp.model !== undefined;
        renderer.root.add(prefixHelpSurface);
        prefixHelpVisibilitySubscription = options.prefixHelp.subscribe(syncPrefixHelpVisibility);
      }
      if (options.contextMenu?.open === true && contextMenuSurface === undefined) {
        const module = await import('./context-menu');
        if (renderer.isDestroyed) return;
        contextMenuModule = module;
        const state = options.contextMenu.state;
        const bounds = state === undefined ? { width: 1, height: 1, left: 0, top: 0 } : module.contextMenuBounds(state.items, state.left, state.top, renderer.width, renderer.height);
        contextMenuSurface = new module.ContextMenuRenderable(renderer.root.ctx, {
          store: options.contextMenu,
          theme: panelThemesFromWorkbench(currentTheme).contextMenu,
          width: bounds.width,
          height: bounds.height,
          position: 'absolute',
          left: bounds.left,
          top: bounds.top,
          zIndex: 200,
        });
        contextMenuSurface.visible = options.contextMenu.open;
        contextMenuBackdropSurface = new module.ContextMenuBackdrop(renderer.root.ctx, {
          store: options.contextMenu,
          width: renderer.width,
          height: renderer.height,
          position: 'absolute',
          left: 0,
          top: 0,
          zIndex: 199,
        });
        contextMenuBackdropSurface.visible = options.contextMenu.open;
        renderer.root.add(contextMenuBackdropSurface);
        renderer.root.add(contextMenuSurface);
        contextMenuVisibilitySubscription = options.contextMenu.subscribe(syncContextMenuVisibility);
      }
      if (!renderer.isDestroyed) {
        viewport.syncAnchors();
        renderer.intermediateRender();
      }
    } catch {
      if (!renderer.isDestroyed) renderer.destroy();
    }
  }
}

/** Bounds the Explorer surface: docked inline under the sidebar's `▾ Files` header, bounded
 * to that section's own rows (`computeSidebarSectionLayout`), whenever the sidebar is visible
 * (terminal width >= 100 cols) -- the old full-height/floating overlay is used only for
 * narrower terminals, where the sidebar itself is hidden. A collapsed Files section reports a
 * zero-height rect, which the caller pairs with `visible = false`. */
function getExplorerBounds(width: number, height: number, sidebar?: SidebarReadModel): { readonly width: number; readonly height: number; readonly left: number; readonly top: number } {
  const layout = calculateWorkbenchLayout(width, height, false, sidebar?.width);
  if (layout.sidebarVisible && sidebar !== undefined) {
    const sections = computeSidebarSectionLayout(sidebar, layout.statusRow);
    return { width: layout.sidebarWidth, height: sections.filesContentHeight, left: 0, top: sections.filesContentTop };
  }
  if (layout.sidebarVisible) return { width: layout.sidebarWidth, height: Math.max(1, height), left: 0, top: 0 };
  const panelWidth = Math.max(1, Math.min(60, width - 2));
  const panelHeight = Math.max(1, Math.min(24, height - 2));
  return {
    width: panelWidth,
    height: panelHeight,
    left: Math.max(0, Math.floor((width - panelWidth) / 2)),
    top: Math.max(0, Math.floor((height - panelHeight) / 2)),
  };
}

function getSearchBounds(width: number, height: number): { readonly width: number; readonly height: number; readonly left: number; readonly top: number } {
  const panelWidth = Math.max(1, Math.min(100, width - 2));
  const panelHeight = Math.max(3, Math.min(14, height - 2));
  return {
    width: panelWidth,
    height: panelHeight,
    left: Math.max(0, Math.floor((width - panelWidth) / 2)),
    top: Math.max(0, Math.floor((height - panelHeight) / 2)),
  };
}

function getProblemsBounds(width: number, height: number): { readonly width: number; readonly height: number; readonly left: number; readonly top: number } {
  const panelWidth = Math.max(1, Math.min(120, width - 2));
  const panelHeight = Math.max(3, Math.min(12, height - 2));
  return {
    width: panelWidth,
    height: panelHeight,
    left: Math.max(0, Math.floor((width - panelWidth) / 2)),
    top: Math.max(0, height - panelHeight - 1),
  };
}

/** Floating bounds, unrelated to the sidebar's own Outline section: used only by the call
 * hierarchy panel (`hierarchySurface`), which happens to share this shape, and by the
 * sidebar Outline surface itself on narrow terminals (sidebar hidden, `sidebar` omitted). */
function getOutlineBounds(width: number, height: number): { readonly width: number; readonly height: number; readonly left: number; readonly top: number } {
  const panelWidth = Math.max(1, Math.min(80, width - 2));
  const panelHeight = Math.max(3, Math.min(20, height - 2));
  return {
    width: panelWidth,
    height: panelHeight,
    left: Math.max(0, width - panelWidth - 1),
    top: 1,
  };
}

/** Bounds the sidebar Outline surface: docked inline under its `▾ Outline` header, bounded to
 * that section's own rows, whenever the sidebar is visible; falls back to the floating
 * `getOutlineBounds` shape on narrow terminals (sidebar hidden). */
function getSidebarOutlineBounds(width: number, height: number, sidebar?: SidebarReadModel): { readonly width: number; readonly height: number; readonly left: number; readonly top: number } {
  const layout = calculateWorkbenchLayout(width, height, false, sidebar?.width);
  if (layout.sidebarVisible && sidebar !== undefined) {
    const sections = computeSidebarSectionLayout(sidebar, layout.statusRow);
    return { width: layout.sidebarWidth, height: sections.outlineContentHeight, left: 0, top: sections.outlineContentTop };
  }
  return getOutlineBounds(width, height);
}

function getDirectoryReviewBounds(width: number, height: number): { readonly width: number; readonly height: number; readonly left: number; readonly top: number } {
  const panelWidth = Math.max(1, Math.min(110, width - 2));
  const panelHeight = Math.max(3, Math.min(20, height - 2));
  return {
    width: panelWidth,
    height: panelHeight,
    left: Math.max(0, Math.floor((width - panelWidth) / 2)),
    top: Math.max(0, Math.floor((height - panelHeight) / 2)),
  };
}

function getHoverBounds(width: number, height: number): { readonly width: number; readonly height: number; readonly left: number; readonly top: number } {
  const panelWidth = Math.max(1, Math.min(100, width - 2));
  const panelHeight = Math.max(3, Math.min(14, height - 2));
  return {
    width: panelWidth,
    height: panelHeight,
    left: Math.max(0, Math.floor((width - panelWidth) / 2)),
    top: Math.max(0, Math.floor((height - panelHeight) / 2)),
  };
}

function getCompletionBounds(width: number, height: number): { readonly width: number; readonly height: number; readonly left: number; readonly top: number } {
  const panelWidth = Math.max(1, Math.min(100, width - 2));
  const panelHeight = Math.max(2, Math.min(10, height - 2));
  return { width: panelWidth, height: panelHeight, left: Math.max(0, Math.floor((width - panelWidth) / 2)), top: Math.max(0, height - panelHeight - 2) };
}

function getSignatureBounds(width: number, height: number): { readonly width: number; readonly height: number; readonly left: number; readonly top: number } {
  const panelWidth = Math.max(1, Math.min(110, width - 2));
  const panelHeight = Math.max(2, Math.min(8, height - 2));
  return { width: panelWidth, height: panelHeight, left: Math.max(0, Math.floor((width - panelWidth) / 2)), top: Math.max(0, height - panelHeight - 2) };
}

function getCommandLineBounds(width: number, height: number): { readonly width: number; readonly height: number; readonly left: number; readonly top: number } {
  const panelWidth = Math.max(1, width);
  const panelHeight = Math.max(2, Math.min(8, Math.max(2, height - 1)));
  return { width: panelWidth, height: panelHeight, left: 0, top: Math.max(0, height - panelHeight) };
}

function getPrefixHelpBounds(width: number, height: number): { readonly width: number; readonly height: number; readonly left: number; readonly top: number } {
  const panelWidth = Math.max(1, width);
  const panelHeight = Math.max(1, Math.min(6, Math.max(1, height - 1)));
  return { width: panelWidth, height: panelHeight, left: 0, top: Math.max(0, height - panelHeight - 1) };
}

function failure(code: string, message: string, retryable: boolean): Result<never, PlatformFailure> {
  return { ok: false, error: { code, message, retryable } };
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return value !== null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function';
}
