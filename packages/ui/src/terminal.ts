import './entrypoints/preload';
import { createCliRenderer, type CliRenderer, type CliRendererConfig, type KeyEvent } from '@opentui/core/renderer';
import { splitCoalescedEscape } from '../input/coalesced-escape';
import type { PasteEvent } from '@opentui/core';
import type { Disposable, DisposableScope, PlatformFailure, Result, SyntaxReadPort } from '../../contracts/src/index.ts';
import type { UiComposition, UiMountContext, TerminalAdapter, TerminalAdapterFactory } from './contracts';
import { WorkbenchRenderable, themeColor, type WorkbenchPointerEvent, type WorkbenchRenderableOptions, type WorkbenchTheme } from './workbench';
import type { EditorPresentationReadPort } from '../editor/motion-paint';
import type { WorkbenchReadPort } from '../../workbench/src/index.ts';
import { formatPrefixHelpLines, type PrefixHelpReadPort } from '../help/index';
import type { PickerReadPort } from '../picker/index';
import type { ExplorerReadPort } from '../explorer/index';
import type { SidebarReadModel, WorkbenchTabSnapshot } from '../../workbench/src/entrypoints/launch';
import type { SearchReadPort, SearchUiState } from '../search/index';
import type { GitReadPort } from '../git/index';
import type { ProblemsReadPort } from '../problems/index';
import type { GitDiffReadPort } from '../git/diff';
import type { TaskOutputReadPort } from '../output/index';
import type { OutlineReadPort, HierarchyReadPort, HoverReadPort } from '../navigation/index';
import type { CompletionReadPort, SignatureReadPort } from '../completion/index';
import type { ExCommandLineReadPort } from '../commandline/index';
import type { StatusMessageReadPort } from '../status/index';
import type { DirectoryDraftReadPort } from '../directory/index';
import type { WorkbenchPanelPointerEvent } from './panel-pointer';
import type { ContextMenuStore } from './context-menu';
import { createChromeSurfaceNode, createRowsSurfaceNode, createThemeBridge, mountSolidRoot, type SolidNode } from './solid/composition';
import { createWorkbenchAppNode } from './solid/workbench';
export { popupBoundsAtCursor, popupBoundsInEditor } from './solid/layout';


export interface OpenTuiTerminalAdapterOptions {
  readonly rendererConfig?: CliRendererConfig;
  readonly createRenderer?: () => Promise<CliRenderer>;
}

const DEFAULT_RENDERER_CONFIG: CliRendererConfig = Object.freeze({
  screenMode: 'alternate-screen',
  clearOnShutdown: true,
  exitOnCtrlC: false,
  enableMouseMovement: true,
  consoleMode: 'disabled',
});

function createConfiguredRenderer(overrides: CliRendererConfig = {}): Promise<CliRenderer> {
  return createCliRenderer({ ...DEFAULT_RENDERER_CONFIG, ...overrides });
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
        ? await createConfiguredRenderer(this.#options.rendererConfig)
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

export type { OpenTuiWorkbenchOptions } from './options';
import type { OpenTuiWorkbenchOptions } from './options';


/** Start native OpenTUI initialization before the workbench model is ready. */
export function createOpenTuiRenderer(): Promise<CliRenderer> {
  return createConfiguredRenderer();
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
      const theme = createThemeBridge(renderable.theme);
      const nodes: SolidNode[] = [createChromeSurfaceNode({
        workbench: context.workbench,
        theme: renderable.theme,
        fileLabel: options.renderable?.fileLabel ?? '[No Name]',
        ...(options.renderable?.ascii === undefined ? {} : { ascii: options.renderable.ascii }),
        showBottomPanel: options.renderable?.showBottomPanel ?? false,
        ...(options.renderable?.gitBranch === undefined ? {} : { gitBranch: options.renderable.gitBranch }),
        ...(options.renderable?.sidebar === undefined ? {} : { sidebar: options.renderable.sidebar }),
        ...(options.renderable?.tabs === undefined ? {} : { tabs: options.renderable.tabs }),
      }, theme)];
      if (options.prefixHelp !== undefined) {
        nodes.push(createRowsSurfaceNode({
          read: options.prefixHelp,
          isOpen: () => options.prefixHelp?.model !== undefined,
          format: formatPrefixHelpLines,
          maxRows: options.prefixHelpHeight ?? 6,
          background: themeColor(renderable.theme.surface, 'bg'),
          foreground: themeColor(renderable.theme.foreground),
          bounds: (width, height) => ({ width, height: Math.min(height, options.prefixHelpHeight ?? 6), left: 0, top: Math.max(0, height - (options.prefixHelpHeight ?? 6) - 1) }),
        }));
      }
      await mountSolidRoot(renderer, nodes);
      return { dispose: () => {
        if (!renderable.isDestroyed) renderable.destroyRecursively();
      } };
    },
  };
}

/** Start the small standalone shell used by `bun run xi`. */
export async function runOpenTuiWorkbench(
  workbench: WorkbenchReadPort,
  fileLabel = '[No Name]',
  options: OpenTuiWorkbenchOptions,
): Promise<void> {
  let finish!: () => void;
  const done = new Promise<void>((resolveDone) => { finish = resolveDone; });
  const renderer = await (options.renderer ?? createConfiguredRenderer({ onDestroy: finish }));
  renderer.on('destroy', finish);
  // Bound request throttling to 1 ms without starting a continuous render loop.
  renderer.maxFps = 1000;
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
    ...(options.comparison === undefined ? {} : { comparison: options.comparison }),
    fileLabel,
    ...(options.theme === undefined ? {} : { theme: options.theme }),
    ...(options.syntax === undefined ? {} : { syntax: options.syntax }),
    ...(options.presentation === undefined ? {} : { presentation: options.presentation }),
    ...(options.gitBranch === undefined ? {} : { gitBranch: options.gitBranch }),
    ...(options.sidebar === undefined ? {} : { sidebar: options.sidebar }),
    ...(options.tabs === undefined ? {} : { tabs: options.tabs }),
    ...(options.onPointer === undefined ? {} : { onPointer: (event: WorkbenchPointerEvent): boolean => {
      const handled = options.onPointer?.(event) ?? false;
      // A handled click can change any panel's read model; request the resulting frame.
      if (handled) void refreshAfterKey();
      return handled;
    } }),
    ...(options.onPointerCancel === undefined ? {} : { onPointerCancel: options.onPointerCancel }),
    ...(options.onViewportAnchorChange === undefined ? {} : { onViewportAnchorChange: options.onViewportAnchorChange }),
    ...(options.onViewportSizeChange === undefined ? {} : { onViewportSizeChange: options.onViewportSizeChange }),
  });
  renderer.root.add(viewport);
  const solidTheme = createThemeBridge(viewport.theme);
  options.registerThemeSwitch?.((theme) => {
    viewport.setTheme(theme);
    solidTheme.set(theme);
    requestFrame(true);
  });
  const pendingKeys: KeyEvent[] = [];
  let pendingKeyHead = 0;
  let drainingKeys = false;
  // Admit input before mounting the declarative shell. Solid can paint a usable viewport
  // while its mount promise is still settling; registering afterward dropped a first key
  // typed against that already-visible frame.
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
  await mountSolidRoot(renderer, [createWorkbenchAppNode({
    workbench,
    fileLabel,
    viewport,
    options,
    theme: viewport.theme,
    themeBridge: solidTheme,
    requestFrame,
  })], viewport.forwardPointerEvent.bind(viewport));
  const surfaceWakeSubscription = options.subscribeSurfaceChanges?.(requestFrame);

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
    drainingKeys = false;
  }

  /**
   * H1-7: `WorkbenchInputRouter.dispatchKey` owns the ordered overlay-focus stack (context
   * menu, command line, completion, picker, explorer, search, problems, output, outline,
   * hierarchy, hover, directory review, signature) and its own fallthrough; this is the one
   * and only per-key dispatch call `processKeypress` makes. `packages/ui` no longer holds a
   * second copy of that precedence policy -- the overlay ports below (`options.picker`,
   * `options.explorer`, ...) stay only for read models/`isOpen`/`onPointer`, which rendering
   * still needs; their `onKeypress`/`handleKey` methods are no longer read from here.
   */
  function finishDispatchOutcome(outcome: 'consumed' | 'pending' | 'unhandled' | 'quit'): void | Promise<void> {
    if (outcome === 'quit') { renderer.destroy(); return; }
    if (outcome === 'consumed') return refreshAfterKey();
  }

  function processKeypress(event: KeyEvent): void | Promise<void> {
    const outcome = options.dispatchKey(event);
    return isPromiseLike(outcome) ? outcome.then(finishDispatchOutcome) : finishDispatchOutcome(outcome);
  }

  function refreshAfterKey(): void {
    viewport.refresh();
    requestFrame();
  }

  function requestFrame(forceFullRepaint = false): void {
    if (forceFullRepaint) {
      renderer.currentRenderBuffer.clear();
      renderer.nextRenderBuffer.clear();
    }
    renderer.requestRender();
  }

  const prepareFrame = async (): Promise<void> => {
    viewport.syncAnchors();
    // An overlay may have owned the hardware cursor in the preceding frame.
    renderer.setCursorPosition(0, 0, false);
  };
  renderer.setFrameCallback(prepareFrame);

  renderer.on('render:error', () => renderer.destroy());
  renderer.on('resize', () => requestFrame());
  let ready = false;
  renderer.on('frame', () => {
    options.onFrame?.();
    if (ready) return;
    ready = true;
    options.marker?.('XI_WORKBENCH_READY', { width: renderer.width, height: renderer.height });
    if (options.onReady !== undefined) setTimeout(() => {
      if (renderer.isDestroyed) return;
      try { void Promise.resolve(options.onReady?.()).catch(() => renderer.destroy()); } catch { renderer.destroy(); }
    }, 0);
  });
  requestFrame();
  await done;
  renderer.removeFrameCallback(prepareFrame);
  surfaceWakeSubscription?.dispose();
}

function failure(code: string, message: string, retryable: boolean): Result<never, PlatformFailure> {
  return { ok: false, error: { code, message, retryable } };
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return value !== null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function';
}
