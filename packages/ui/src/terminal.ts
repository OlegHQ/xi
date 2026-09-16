import { createCliRenderer, type CliRenderer, type CliRendererConfig, type KeyEvent } from '@opentui/core/renderer';
import type { Disposable, DisposableScope, PlatformFailure, Result } from '../../contracts/src/index.ts';
import type { UiComposition, UiMountContext, TerminalAdapter, TerminalAdapterFactory } from './contracts';
import { calculateWorkbenchLayout, WorkbenchRenderable, type WorkbenchPointerEvent, type WorkbenchRenderableOptions } from './workbench';
import type { WorkbenchReadPort } from '../../workbench/src/index.ts';
import type { PrefixHelpReadPort, PrefixHelpRenderable } from '../help/index';
import type { PickerReadPort, PickerRenderable } from '../picker/index';
import type { ExplorerReadPort, ExplorerRenderable } from '../explorer/index';
import type { SearchReadPort, SearchRenderable } from '../search/index';
import type { ProblemsReadPort, ProblemsRenderable } from '../problems/index';
import type { OutlineReadPort, OutlineRenderable, HierarchyReadPort, HierarchyRenderable, HoverReadPort, HoverRenderable } from '../navigation/index';
import type { CompletionReadPort, CompletionRenderable, SignatureReadPort, SignatureRenderable } from '../completion/index';
import type { ExCommandLineReadPort, ExCommandLineRenderable } from '../commandline/index';

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
  /** Wake panels whose read ports become available after an asynchronous open. */
  readonly subscribeSurfaceChanges?: (listener: () => void) => Disposable;
  /** Return true when the application consumed the key, or `quit` after an application command. */
  readonly onKeypress?: (event: KeyEvent) => boolean | 'quit' | Promise<boolean | 'quit'>;
  /** Optional editor pointer route; semantic placement remains application-owned. */
  readonly onPointer?: (event: WorkbenchPointerEvent) => boolean;
  readonly onPointerCancel?: (reason: 'resize' | 'dispose' | 'escape' | 'suspend') => void;
  /** Diagnostic hook invoked after an explicit intermediate frame completes. */
  readonly onFrame?: () => void;
  /** Optional passive parser/help read model. It never receives keyboard focus. */
  readonly prefixHelp?: PrefixHelpReadPort;
  /** Optional read-only picker surface and application-owned input behavior. */
  readonly picker?: {
    readonly read: PickerReadPort;
    readonly isOpen: () => boolean;
    readonly onKeypress: (event: KeyEvent) => void | Promise<void>;
  };
  /** Optional focused Explorer surface and application-owned navigation. */
  readonly explorer?: {
    readonly read: ExplorerReadPort;
    readonly isOpen: () => boolean;
    readonly onKeypress: (event: KeyEvent) => boolean | void | Promise<boolean | void>;
  };
  /** Optional workspace search surface and application-owned query behavior. */
  readonly search?: {
    readonly read: SearchReadPort;
    readonly isOpen: () => boolean;
    readonly selectedId?: () => string | undefined;
    readonly onKeypress: (event: KeyEvent) => boolean | void | Promise<boolean | void>;
  };
  /** Optional read-only diagnostics surface and application-owned close behavior. */
  readonly problems?: {
    readonly read: ProblemsReadPort;
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
  let stoppedForJobControl = false;
  const handleTerminalStop = (): void => {
    if (renderer.isDestroyed || stoppedForJobControl) return;
    stoppedForJobControl = true;
    viewport.cancelPointerCapture();
    options.onPointerCancel?.('suspend');
    renderer.suspend();
    process.kill(process.pid, 'SIGSTOP');
  };
  const handleTerminalContinue = (): void => {
    if (!stoppedForJobControl || renderer.isDestroyed) return;
    stoppedForJobControl = false;
    renderer.resume();
  };
  process.on('SIGTSTP', handleTerminalStop);
  process.on('SIGCONT', handleTerminalContinue);
  renderer.once('destroy', () => {
    process.off('SIGTSTP', handleTerminalStop);
    process.off('SIGCONT', handleTerminalContinue);
  });
  const viewport = new WorkbenchRenderable(renderer.root.ctx, {
    workbench,
    fileLabel,
    ...(options.onPointer === undefined ? {} : { onPointer: (event: WorkbenchPointerEvent): boolean => {
      const handled = options.onPointer?.(event) ?? false;
      if (handled) {
        const install = installOpenOptionalSurfaces();
        if (install !== undefined) void install.then(requestFrame);
      }
      return handled;
    } }),
    ...(options.onPointerCancel === undefined ? {} : { onPointerCancel: options.onPointerCancel }),
  });
  renderer.root.add(viewport);
  let explorerSurface: ExplorerRenderable | undefined;
  let pickerSurface: PickerRenderable | undefined;
  let searchSurface: SearchRenderable | undefined;
  let problemsSurface: ProblemsRenderable | undefined;
  let outlineSurface: OutlineRenderable | undefined;
  let hierarchySurface: HierarchyRenderable | undefined;
  let hoverSurface: HoverRenderable | undefined;
  let completionSurface: CompletionRenderable | undefined;
  let signatureSurface: SignatureRenderable | undefined;
  let commandLineSurface: ExCommandLineRenderable | undefined;
  let prefixHelpSurface: PrefixHelpRenderable | undefined;
  let prefixHelpVisibilitySubscription: Disposable | undefined;
  let optionalSurfacesInstallation: Promise<void> | undefined;
  const surfaceWakeSubscription = options.subscribeSurfaceChanges?.(() => {
    if (!renderer.isDestroyed) void installOptionalSurfaces().then(requestFrame);
  });
  const prefixHelpWakeSubscription = options.prefixHelp?.subscribe(() => {
    if (options.prefixHelp?.model !== undefined && prefixHelpSurface === undefined) {
      void installOptionalSurfaces().then(requestFrame);
    }
  });
  const syncPickerVisibility = (): void => {
    if (pickerSurface !== undefined && options.picker !== undefined) pickerSurface.visible = options.picker.isOpen();
  };
  const syncExplorerVisibility = (): void => {
    if (explorerSurface !== undefined && options.explorer !== undefined) explorerSurface.visible = options.explorer.isOpen();
  };
  const syncSearchVisibility = (): void => {
    if (searchSurface !== undefined && options.search !== undefined) searchSurface.visible = options.search.isOpen();
  };
  const syncProblemsVisibility = (): void => {
    if (problemsSurface !== undefined && options.problems !== undefined) problemsSurface.visible = options.problems.isOpen();
  };
  const syncOutlineVisibility = (): void => {
    if (outlineSurface !== undefined && options.outline !== undefined) outlineSurface.visible = options.outline.isOpen();
  };
  const syncHierarchyVisibility = (): void => {
    if (hierarchySurface !== undefined && options.hierarchy !== undefined) hierarchySurface.visible = options.hierarchy.isOpen();
  };
  const syncHoverVisibility = (): void => {
    if (hoverSurface !== undefined && options.hover !== undefined) hoverSurface.visible = options.hover.isOpen();
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
  const pendingKeys: KeyEvent[] = [];
  let pendingKeyHead = 0;
  let drainingKeys = false;
  let framePending = false;
  renderer.keyInput.on('keypress', (event: KeyEvent) => {
    if (event.name.toLowerCase() === 'escape' || event.name === 'ESC') {
      viewport.cancelPointerCapture();
      options.onPointerCancel?.('escape');
    }
    pendingKeys.push(event);
    drainKeys();
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
    flushFrame();
    drainingKeys = false;
  }

  function processKeypress(event: KeyEvent): void | Promise<void> {
    if (options.commandLine?.isOpen() === true) return finishFocusedKey(options.commandLine.onKeypress(event));
    if (options.completion?.isOpen() === true) return finishFocusedKey(options.completion.onKeypress(event));
    if (options.picker?.isOpen() === true) return finishFocusedKey(options.picker.onKeypress(event));
    if (options.explorer?.isOpen() === true) return finishFocusedKey(options.explorer.onKeypress(event));
    if (options.search?.isOpen() === true) return finishFocusedKey(options.search.onKeypress(event));
    if (options.problems?.isOpen() === true) return finishFocusedKey(options.problems.onKeypress(event));
    if (options.outline?.isOpen() === true) return finishFocusedKey(options.outline.onKeypress(event));
    if (options.hierarchy?.isOpen() === true) return finishFocusedKey(options.hierarchy.onKeypress(event));
    if (options.hover?.isOpen() === true) return finishFocusedKey(options.hover.onKeypress(event));
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

  function finishApplicationKey(event: KeyEvent, result: boolean | 'quit'): void | Promise<void> {
    if (result === 'quit') { renderer.destroy(); return; }
    if (result === true) return refreshAfterKey();
    if ((event.ctrl && (event.name === 'c' || event.name === 'C')) || event.name === 'q') renderer.destroy();
  }

  function refreshAfterKey(): void | Promise<void> {
    syncPickerVisibility();
    syncExplorerVisibility();
    syncSearchVisibility();
    syncProblemsVisibility();
    syncOutlineVisibility();
    syncHierarchyVisibility();
    syncHoverVisibility();
    syncCompletionVisibility();
    syncSignatureVisibility();
    syncCommandLineVisibility();
    syncPrefixHelpVisibility();
    viewport.refresh();
    const install = installOpenOptionalSurfaces();
    if (install !== undefined) return install.then(requestFrame);
    requestFrame();
  }

  function requestFrame(): void {
    framePending = true;
    if (!drainingKeys && !renderer.isDestroyed) flushFrame();
  }

  function flushFrame(): void {
    if (!framePending || renderer.isDestroyed) return;
    framePending = false;
    renderer.intermediateRender();
    options.onFrame?.();
  }
  renderer.on('render:error', () => renderer.destroy());
  renderer.on('resize', () => {
    if (explorerSurface !== undefined) {
      const bounds = getExplorerBounds(renderer.width, renderer.height);
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
      if (outlineSurface !== undefined) {
        const bounds = getOutlineBounds(renderer.width, renderer.height);
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
    if (pickerSurface === undefined) {
      renderer.intermediateRender();
      return;
    }
    const width = Math.max(20, Math.min(renderer.width - 2, 100));
    const height = Math.max(3, Math.min(renderer.height - 2, 14));
    pickerSurface.width = width;
    pickerSurface.height = height;
    pickerSurface.left = Math.max(0, Math.floor((renderer.width - width) / 2));
    pickerSurface.top = Math.max(0, Math.floor((renderer.height - height) / 2));
    renderer.intermediateRender();
  });
  let ready = false;
  renderer.on('frame', () => {
    if (ready) return;
    ready = true;
    if (process.env.XI_UI_TEST_MARKERS === '1') process.stderr.write(`XI_WORKBENCH_READY ${JSON.stringify({ width: renderer.width, height: renderer.height })}\r\n`);
    if (options.onReady !== undefined) setTimeout(() => {
      if (renderer.isDestroyed) return;
      try { void Promise.resolve(options.onReady?.()).catch(() => renderer.destroy()); } catch { renderer.destroy(); }
    }, 0);
    // Panels load when opened; prefix help has its own visibility subscription.
  });
  renderer.start();
  await done;
  process.off('SIGTSTP', handleTerminalStop);
  process.off('SIGCONT', handleTerminalContinue);
  prefixHelpWakeSubscription?.dispose();
  surfaceWakeSubscription?.dispose();
  prefixHelpVisibilitySubscription?.dispose();

  function installOpenOptionalSurfaces(): Promise<void> | undefined {
    if (!optionalSurfaceIsOpenAndMissing()) return undefined;
    return installOptionalSurfaces();
  }

  function optionalSurfaceIsOpenAndMissing(): boolean {
    return (options.explorer?.isOpen() === true && explorerSurface === undefined)
      || (options.picker?.isOpen() === true && pickerSurface === undefined)
      || (options.search?.isOpen() === true && searchSurface === undefined)
      || (options.problems?.isOpen() === true && problemsSurface === undefined)
      || (options.outline?.isOpen() === true && outlineSurface === undefined)
      || (options.hierarchy?.isOpen() === true && hierarchySurface === undefined)
      || (options.hover?.isOpen() === true && hoverSurface === undefined)
      || (options.completion?.isOpen() === true && completionSurface === undefined)
      || (options.signature?.isOpen() === true && signatureSurface === undefined)
      || (options.commandLine?.isOpen() === true && commandLineSurface === undefined)
      || (options.prefixHelp?.model !== undefined && prefixHelpSurface === undefined);
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
      if (options.explorer?.isOpen() === true && explorerSurface === undefined) {
        const module = await import('../explorer/index');
        if (renderer.isDestroyed) return;
        const bounds = getExplorerBounds(renderer.width, renderer.height);
        explorerSurface = new module.ExplorerRenderable(renderer.root.ctx, {
          explorer: options.explorer.read,
          width: bounds.width,
          height: bounds.height,
          position: 'absolute',
          left: bounds.left,
          top: bounds.top,
          zIndex: 20,
        });
        explorerSurface.visible = options.explorer.isOpen();
        renderer.root.add(explorerSurface);
      }
      if (options.picker?.isOpen() === true && pickerSurface === undefined) {
        const module = await import('../picker/index');
        if (renderer.isDestroyed) return;
        const width = Math.max(20, Math.min(renderer.width - 2, 100));
        const height = Math.max(3, Math.min(renderer.height - 2, 14));
        pickerSurface = new module.PickerRenderable(renderer.root.ctx, {
          picker: options.picker.read,
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
      if (options.outline?.isOpen() === true && outlineSurface === undefined) {
        const bounds = getOutlineBounds(renderer.width, renderer.height);
        const module = await import('../navigation/index');
        if (renderer.isDestroyed) return;
        outlineSurface = new module.OutlineRenderable(renderer.root.ctx, {
          outline: options.outline.read,
          width: bounds.width,
          height: bounds.height,
          position: 'absolute',
          left: bounds.left,
          top: bounds.top,
          zIndex: 70,
        });
        outlineSurface.visible = options.outline.isOpen();
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
      if (!renderer.isDestroyed) renderer.intermediateRender();
    } catch {
      if (!renderer.isDestroyed) renderer.destroy();
    }
  }
}

function getExplorerBounds(width: number, height: number): { readonly width: number; readonly height: number; readonly left: number; readonly top: number } {
  const layout = calculateWorkbenchLayout(width, height);
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
