import type { ClockPort, CommandId, Disposable, ViewId } from '../../contracts/src/index';
import type { BufferHost } from '../host';
import type { WorkbenchSession } from '../session';
import { CommandRegistry } from '../commands/registry';
import { ExCommandLineSession, type ExCommandLineInput } from '../commands/ex-command-line';
import { PrefixHelpController, buildPrefixHelpReadModel, type PrefixHelpBinding, type PrefixHelpReadModel, type PrefixHelpRequest } from '../commands/prefix-help';
import type { OwnedVimKeyEvent, VimPrefixHelpState } from '../vim-session';
import { canonicalKeyToken } from './key-token';
import { DEFAULT_VIEW_BINDINGS, executeViewCommand, isViewCommandId } from './view-commands';

export type { OwnedVimKeyEvent as RouterKeyEvent };

/** Mirrors `packages/services/config`'s `BindingConfig` structurally -- workbench cannot
 * import `packages/services`, not even types. */
export interface RouterBindingConfig {
  readonly mode: string;
  readonly keys: readonly string[];
  readonly commandId: string;
}

/** Mirrors `packages/services/config`'s `normalizeCanonicalKey`: a config-authored token is
 * matched case-insensitively when bracketed (`<C-Up>` == `<c-up>`), case-sensitively as a
 * bare literal character otherwise (`J` != `j`). */
function normalizeConfigToken(token: string): string {
  return token.startsWith('<') ? token.toLowerCase() : token;
}

/** Single-key (non-chord) mode+key -> commandId bindings, resolved before Vim's own key
 * handling gets a chance -- `<C-Up>`/`<C-Down>` line-scroll defaults, overridable (and
 * extensible) by the user's compiled config bindings. Multi-key chord bindings are out of
 * scope for this fast-path lookup (see AGENTS.md ticket-scope note in the class doc below). */
function buildBindingMap(bindings: readonly RouterBindingConfig[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const binding of DEFAULT_VIEW_BINDINGS) map.set(`${binding.mode}\u0000${binding.token}`, binding.commandId);
  for (const binding of bindings) {
    if (binding.keys.length !== 1) continue;
    const token = normalizeConfigToken(binding.keys[0] as string);
    map.set(`${binding.mode}\u0000${token}`, binding.commandId);
  }
  return map;
}

/** Mirrors `packages/services/navigation`'s `PickerMode`; workbench cannot import services. */
export type RouterPickerMode = 'file' | 'buffer' | 'command' | 'theme' | 'config';

export interface RouterPickerPort {
  readonly isOpen: boolean;
  close(cancelPreview: boolean): Promise<void>;
  open(mode: RouterPickerMode): void;
}

export interface RouterExplorerPort {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  handleKeypress(event: OwnedVimKeyEvent): Promise<boolean> | boolean;
}

export interface RouterSearchPort extends RouterExplorerPort {
  startReplace(): void;
}

export interface RouterProblemsPort {
  readonly isProblemsOpen: boolean;
  openProblems(): void;
}

export interface RouterOverlayPort {
  readonly isOutlineOpen: boolean;
  openOutline(): void;
  openHover(): void;
}

export interface RouterCompletionPort {
  isCompletionTrigger(event: OwnedVimKeyEvent, mode: string | undefined): boolean;
  isSignatureTrigger(event: OwnedVimKeyEvent, mode: string | undefined): boolean;
  readonly isSnippetActive: boolean;
  openCompletion(): boolean;
  openSignature(): boolean;
  handleSnippetKeypress(event: OwnedVimKeyEvent): Promise<boolean | 'quit'>;
}

export interface RouterWorkspaceEditsPort {
  requestCodeActions(): Promise<boolean>;
}

/** H1-7: the ordered focus-stack entries `packages/ui/src/terminal.ts` used to walk itself
 * (see `dispatchKey`'s doc comment) -- one UI-owned overlay surface's own keyboard routing,
 * structurally typed here (workbench cannot import `packages/ui`) exactly as
 * `OpenTuiWorkbenchOptions` already declares each port, so `apps/xi/src/wiring/*.ts` can pass
 * the very same controller references to both this router and the UI's read/render options. */
export interface RouterOverlayKeypressPort {
  readonly isOpen: () => boolean;
  readonly onKeypress: (event: OwnedVimKeyEvent) => boolean | void | Promise<boolean | void>;
  /** True while the overlay owns typed characters (a filter/rename prompt); `:` then stays
   * with the overlay instead of opening the editor's command line. Absent means never. */
  readonly capturesTextInput?: () => boolean;
}

export interface RouterVoidOverlayKeypressPort {
  readonly isOpen: () => boolean;
  readonly onKeypress: (event: OwnedVimKeyEvent) => void | Promise<void>;
}

export interface RouterContextMenuOverlayPort {
  readonly open: boolean;
  handleKey(event: OwnedVimKeyEvent): boolean;
}

export interface RouterDirectoryReviewOverlayPort {
  readonly isOpen: () => boolean;
  readonly onKeypress: (event: OwnedVimKeyEvent) => 'handled' | 'unhandled';
}

export type RouterDispatchOutcome = 'consumed' | 'pending' | 'unhandled' | 'quit';

export interface WorkbenchInputRouterOptions {
  readonly host: BufferHost;
  readonly session: WorkbenchSession;
  readonly marker: (name: string, payload?: unknown) => void;
  /** PTY-visible stderr sink; never writes to `process.stderr` itself. */
  readonly onError: (message: string) => void;
  readonly commandRegistry: CommandRegistry;
  readonly picker: RouterPickerPort;
  readonly explorer: RouterExplorerPort;
  readonly search: RouterSearchPort;
  readonly problems: RouterProblemsPort;
  readonly overlays: RouterOverlayPort;
  readonly completion: RouterCompletionPort;
  readonly workspaceEdits: RouterWorkspaceEditsPort;
  /** Workbench-level Ex fallback used when no editable Vim session owns a command line. */
  readonly executeWorkbenchCommand?: (source: string, viewId: ViewId) => 'handled' | 'unhandled' | 'quit' | Promise<'handled' | 'unhandled' | 'quit'>;
  /** Lazily-constructed explorer/search backing services; composition-root work this
   * router never duplicates -- it only asks whether they are ready yet. */
  readonly isExplorerServiceLoaded: () => boolean;
  readonly isSearchServiceLoaded: () => boolean;
  readonly ensureOptionalServices: () => Promise<void>;
  readonly toggleSidebar?: () => void;
  readonly toggleMouseMode: () => boolean;
  readonly launchViewId: ViewId;
  /** Compiled config key bindings (`compileConfig(...).bindings`); `<C-Up>`/`<C-Down>` line
   * scroll are always available as defaults and config may override or add to them. */
  readonly bindings: readonly RouterBindingConfig[];
  /** Lines per `view.scroll-up`/`view.scroll-down` step; from `editor.mouse.scrollLines`. */
  readonly scrollLines: number;
  readonly getViewportHeight: (viewId: ViewId) => number | undefined;
  /** Drives `PrefixHelpController`'s schedule/cancel timer through the shared platform port
   * instead of a raw `setTimeout`, so fake clocks can drive it in tests. */
  readonly clock: ClockPort;
  /**
   * H1-7: the ordered overlay-focus stack `dispatchKey` walks, in precedence order, before
   * ever reaching this router's own `handleKeypress` fallthrough. Every entry is optional so
   * a caller that never wires a given overlay (e.g. no `overlayHierarchy` controller exists
   * yet) simply never matches it -- `dispatchKey` treats a missing port exactly like a closed
   * one. `overlayCommandLine` is intentionally absent: the router already owns that state via
   * `isCommandLineActive()`/`handleCommandLineKeypress()`.
   */
  readonly overlayContextMenu?: RouterContextMenuOverlayPort;
  readonly overlayCompletion?: RouterOverlayKeypressPort;
  readonly overlayPicker?: RouterVoidOverlayKeypressPort;
  readonly overlayExplorer?: RouterOverlayKeypressPort;
  readonly overlaySearch?: RouterOverlayKeypressPort;
  readonly overlayGit?: RouterOverlayKeypressPort;
  readonly overlayGitDiff?: RouterOverlayKeypressPort & { readonly isReadOnly?: () => boolean };
  readonly overlayProblems?: RouterOverlayKeypressPort;
  readonly overlayOutput?: RouterOverlayKeypressPort;
  readonly overlayOutline?: RouterOverlayKeypressPort;
  readonly overlayHierarchy?: RouterOverlayKeypressPort;
  readonly overlayHover?: RouterOverlayKeypressPort;
  /** `onKeypress` reports whether it consumed the key ('handled') or wants it to fall through
   * to the rest of the stack ('unhandled') -- the one entry in this stack that can decline. */
  readonly overlayDirectoryReview?: RouterDirectoryReviewOverlayPort;
  readonly overlaySignature?: RouterOverlayKeypressPort;
  /** `Space v d`: opens the worktree diff for the active buffer's workspace-relative path.
   * Composition-root work (path resolution, `GitDiffService`) this router never duplicates. */
  readonly openGitDiffForActiveBuffer?: () => Promise<void> | void;
  readonly openGitPanel?: () => Promise<void> | void;
}

/**
 * Owns leader/macro-register pending state, prefix-help scheduling, the Ex command-line
 * session lifecycle/read port and the top-level keypress/paste decision chain that used to
 * live as closure state inside `apps/xi/src/main.ts`'s `main()`. Feature controllers
 * (picker/explorer/search/problems/overlays/completion/workspace-edits) are injected as
 * narrow ports; `host`/`session`/`commandRegistry`/`ExCommandLineSession`/`PrefixHelpController`
 * are workbench's own sibling types, used directly.
 */
export class WorkbenchInputRouter implements Disposable {
  readonly #options: WorkbenchInputRouterOptions;
  readonly #prefixHelp: PrefixHelpController;
  readonly #bindings: ReadonlyMap<string, string>;
  #leaderPending = false;
  #leaderKeys: readonly string[] = Object.freeze([]);
  #macroRegisterPending = false;
  #prefixGeneration = 0;
  // schedulePrefixHelp fires on every key via onPrefixStateChange. vim-session hands back
  // the same VimPrefixHelpState object (same pendingKeys/parserContinuations array
  // references) whenever nothing prefix-related actually changed, so caching those two
  // references lets the overwhelmingly common no-op key skip the generation bump, the
  // array copies and any timer churn entirely.
  #lastPrefixPendingKeys: readonly string[] | undefined;
  #lastPrefixContinuations: VimPrefixHelpState['parserContinuations'] | undefined;
  // Comparison editors and the Git panel can remain open together.
  #gitPanelFocused = false;
  #lastGitDiffOpen = false;
  #exCommandLineSession: ExCommandLineSession | undefined;
  #commandLineWithoutSession = false;
  #searchPromptModel: ReturnType<ExCommandLineSession['readModel']> | undefined;
  readonly #commandLineListeners = new Set<(model: ReturnType<ExCommandLineSession['readModel']> | undefined) => void>();
  #disposed = false;

  constructor(options: WorkbenchInputRouterOptions) {
    this.#options = options;
    this.#bindings = buildBindingMap(options.bindings);
    this.#prefixHelp = new PrefixHelpController({
      readGenerations: () => ({
        registryGeneration: options.commandRegistry.snapshot.generation,
        configGeneration: this.#prefixGeneration,
        focusGeneration: this.#prefixGeneration,
      }),
      readPrefixHelp: (request: PrefixHelpRequest): PrefixHelpReadModel => buildPrefixHelpReadModel({
        request,
        registry: options.commandRegistry,
        registrySnapshot: options.commandRegistry.snapshot,
        focusGeneration: this.#prefixGeneration,
        bindings: this.#leaderBindings().map((binding): PrefixHelpBinding => Object.freeze({
          targetId: request.targetId ?? '',
          keys: binding.keys,
          command: { kind: 'command' as const, id: binding.commandId as CommandId },
          contexts: Object.freeze([]),
          description: undefined,
        })),
      }),
    }, {
      clock: {
        setTimeout: (callback: () => void, milliseconds: number) => options.clock.schedule(milliseconds, callback),
        clearTimeout: (handle: unknown) => { (handle as Disposable).dispose(); },
      },
    });
  }

  get prefixHelp(): PrefixHelpController { return this.#prefixHelp; }
  get leaderPending(): boolean { return this.#leaderPending; }

  /** Structurally matches `packages/ui`'s `ExCommandLineReadPort`; declared here instead of
   * imported since workbench cannot import `packages/ui`. */
  readonly commandLine = {
    read: {
      model: undefined as ReturnType<ExCommandLineSession['readModel']> | undefined,
      subscribe: (listener: (model: ReturnType<ExCommandLineSession['readModel']> | undefined) => void): Disposable => {
        this.#commandLineListeners.add(listener);
        return Object.freeze({ dispose: () => { this.#commandLineListeners.delete(listener); } });
      },
    },
  };

  /** Called from `BufferHostOptions.onCommandLineChange`. */
  handleCommandLineChange(state: { readonly source: string; readonly cursorOffset: number; readonly kind?: 'ex' | 'search-forward' | 'search-backward' } | undefined): void {
    this.#commandLineWithoutSession = false;
    this.#searchPromptModel = undefined;
    if (state === undefined) {
      this.#exCommandLineSession?.dispose();
      this.#exCommandLineSession = undefined;
    } else if (state.kind !== undefined && state.kind !== 'ex') {
      // A '/' or '?' prompt is Vim's own: no Ex discovery, and every key (typing, <BS>,
      // Enter, Esc) is handled by the session itself in handleCommandLineKeypress.
      this.#exCommandLineSession?.dispose();
      this.#exCommandLineSession = undefined;
      this.#searchPromptModel = searchPromptModel(state.source, state.cursorOffset);
    } else if (this.#exCommandLineSession === undefined) {
      this.#exCommandLineSession = new ExCommandLineSession({ registry: this.#options.commandRegistry, source: state.source, cursorOffset: state.cursorOffset });
    } else {
      this.#exCommandLineSession.setSource(state.source, state.cursorOffset);
    }
    this.commandLine.read.model = this.#searchPromptModel ?? this.#exCommandLineSession?.readModel();
    for (const listener of [...this.#commandLineListeners]) listener(this.commandLine.read.model);
    this.#options.marker('XI_EX_COMMANDLINE_STATE', state);
  }

  isCommandLineActive(): boolean {
    return this.#commandLineWithoutSession || this.#options.host.activeSession()?.commandLineActive === true;
  }

  /** Called from `BufferHostOptions.onPrefixStateChange`. */
  schedulePrefixHelp(viewId: ViewId, pendingKeys: readonly string[], parserContinuations: VimPrefixHelpState['parserContinuations']): void {
    if (pendingKeys === this.#lastPrefixPendingKeys && parserContinuations === this.#lastPrefixContinuations) return;
    this.#lastPrefixPendingKeys = pendingKeys;
    this.#lastPrefixContinuations = parserContinuations;
    if (pendingKeys.length === 0 && parserContinuations.length === 0) {
      this.#prefixHelp.cancel();
      return;
    }
    this.#prefixGeneration += 1;
    this.#prefixHelp.schedule({
      targetId: String(viewId),
      pendingKeys: Object.freeze([...pendingKeys]),
      parserContinuations: Object.freeze([...parserContinuations]),
      configGeneration: this.#prefixGeneration,
    });
  }

  scheduleLeaderHelp(): void {
    const targetViewId = this.#options.session.activeViewId ?? this.#options.launchViewId;
    const pendingKeys = this.#leaderKeys.length === 0 ? Object.freeze(['<Space>']) : this.#leaderKeys;
    this.schedulePrefixHelp(targetViewId, pendingKeys, []);
  }

  /** Reproduces the original `onKeypress` chain exactly, except that it no longer forces a
   * microtask hop on every ordinary keystroke: only the two branches below actually await
   * (loading the explorer/search services on first use), and every other branch returns its
   * callee's result -- synchronous or not -- directly, so the vim-session fast path
   * (`canHandleSynchronously`) reaches the caller without an added `await`. */
  /**
   * Typed wrapper for the eventual ordered-focus-stack contract (H1-7,
   * docs/plan/01-architecture.md's UI/workbench boundary): today this only covers what
   * this router actually owns -- its own fallthrough key handling (`handleKeypress`) --
   * because the higher-priority overlay ports (context menu, command line, completion,
   * picker, explorer, search, problems, output, outline, hierarchy, hover, directory
   * review, signature) are constructed and injected into `packages/ui/src/terminal.ts`'s
   * `OpenTuiTerminalAdapterOptions` by `apps/xi/src/wiring/*.ts`, not into this router, so
   * `terminal.ts`'s own ordered focus stack still decides which surface a key goes to
   * before ever reaching here (see its doc comment). Once that wiring hands this router
   * the same port instances, `dispatch()` is where their ordered precedence moves to, and
   * `terminal.ts` calls this one method instead of walking its own list. `'pending'` is
   * reserved for that future leader/chord-in-progress case; `handleKeypress` itself never
   * produces it today.
   */
  dispatch(event: OwnedVimKeyEvent): 'consumed' | 'unhandled' | 'quit' | Promise<'consumed' | 'unhandled' | 'quit'> {
    const result = this.handleKeypress(event);
    const finish = (value: boolean | 'quit'): 'consumed' | 'unhandled' | 'quit' => value === 'quit' ? 'quit' : value ? 'consumed' : 'unhandled';
    return typeof result === 'object' ? result.then(finish) : finish(result);
  }

  /**
   * H1-7: the single entry point `packages/ui/src/terminal.ts` calls for every keypress --
   * the ordered overlay-focus stack (context menu, command line, completion popup, picker,
   * explorer, search, problems, output, outline, hierarchy, hover, directory review,
   * signature help) that used to be a 13-branch array walked inside `terminal.ts` itself,
   * followed by this router's own `handleKeypress` fallthrough. Each stack entry is
   * mutually exclusive by construction: the loop returns on the first surface that reports
   * itself open, so a key that reaches an open surface never also reaches a later one or the
   * fallthrough. Only `overlayDirectoryReview` may decline ('unhandled') and let the key
   * continue down the stack; every other overlay entry treats "open" as "this key is mine".
   */
  dispatchKey(event: OwnedVimKeyEvent): RouterDispatchOutcome | Promise<RouterDispatchOutcome> {
    const o = this.#options;
    if (event.raw !== 'v' || event.ctrl || event.meta || event.option) o.host.activeSession()?.clearMotionGhost();
    // The leader key is global even while a navigational panel is focused: it is how users
    // reach terminal controls such as mouse-mode toggle without first dismissing the panel.
    const activeMode = o.session.activeViewId === undefined ? undefined : o.session.readView(o.session.activeViewId)?.session.mode;
    if ((event.raw === ' ' && activeMode === 'normal') || this.#leaderPending) return finishOverlay(this.handleKeypress(event));
    if (o.overlayContextMenu?.open === true) return finishOverlay(o.overlayContextMenu.handleKey(event));
    if (this.isCommandLineActive()) return finishOverlay(this.handleCommandLineKeypress(event));
    if (o.overlayCompletion?.isOpen() === true) return finishOverlay(o.overlayCompletion.onKeypress(event));
    if (o.overlayPicker?.isOpen() === true) return finishOverlay(o.overlayPicker.onKeypress(event));
    // Window commands belong to the Vim prefix parser. A sidebar must not consume the
    // prefix or its continuation (in particular Ctrl-W s/v while a diff is open).
    if ((activeMode === 'normal' && event.ctrl && event.name.toLowerCase() === 'w')
      || o.host.activeSession()?.prefixHelp?.pendingKeys.includes('<C-w>') === true) {
      this.#gitPanelFocused = false;
      return this.dispatch(event);
    }
    const panelMode = this.#bindingMode();
    if (panelMode !== 'normal') {
      const panel = panelMode === 'files-panel' ? o.overlayExplorer : panelMode === 'search-panel' ? o.overlaySearch : o.overlayGit;
      const commandId = panel?.capturesTextInput?.() === true ? undefined : this.#resolveBoundCommand(panelMode, event);
      if (commandId !== undefined) return finishOverlay(this.#executeWorkbenchCommandId(commandId));
    }
    // `:` works everywhere a panel is only navigated, not typed into (explorer, problems,
    // output, outline, hierarchy, hover): it opens the editor's command line so `:q`, `:w`
    // and friends never depend on which panel has focus.
    if (event.raw === ':' && !event.ctrl && !event.meta && !event.option && this.#colonPanelOpen()) return finishOverlay(this.handleKeypress(event));
    if (o.overlayGitDiff?.isReadOnly?.() === true && !this.#gitPanelFocused) return finishOverlay(o.overlayGitDiff.onKeypress(event));
    if (o.overlayExplorer?.isOpen() === true) return finishOverlay(o.overlayExplorer.onKeypress(event));
    if (o.overlaySearch?.isOpen() === true) return finishOverlay(o.overlaySearch.onKeypress(event));
    {
      const gitDiffOpen = o.overlayGitDiff?.isOpen() === true;
      const gitPanelOpen = o.overlayGit?.isOpen() === true;
      if (gitDiffOpen && !this.#lastGitDiffOpen) this.#gitPanelFocused = false;
      this.#lastGitDiffOpen = gitDiffOpen;
      if (!gitPanelOpen) this.#gitPanelFocused = false;
      if (gitDiffOpen && !this.#gitPanelFocused) {
        const handled = o.overlayGitDiff!.onKeypress(event);
        if (handled !== false) return finishOverlay(handled);
      }
      if (gitPanelOpen && (!gitDiffOpen || this.#gitPanelFocused)) return finishOverlay(o.overlayGit!.onKeypress(event));
    }
    if (o.overlayProblems?.isOpen() === true) return finishOverlay(o.overlayProblems.onKeypress(event));
    if (o.overlayOutput?.isOpen() === true) return finishOverlay(o.overlayOutput.onKeypress(event));
    if (o.overlayOutline?.isOpen() === true) return finishOverlay(o.overlayOutline.onKeypress(event));
    if (o.overlayHierarchy?.isOpen() === true) return finishOverlay(o.overlayHierarchy.onKeypress(event));
    // Hover is dismiss-on-next-key: a `false` from it means "closed, now give the key to the
    // editor", so the stack keeps walking instead of swallowing the motion.
    if (o.overlayHover?.isOpen() === true) {
      const outcome = o.overlayHover.onKeypress(event);
      if (outcome !== false) return finishOverlay(outcome);
    }
    if (o.overlayDirectoryReview?.isOpen() === true && o.overlayDirectoryReview.onKeypress(event) === 'handled') return 'consumed';
    if (o.overlaySignature?.isOpen() === true) return finishOverlay(o.overlaySignature.onKeypress(event));
    return this.dispatch(event);
  }

  #colonPanelOpen(): boolean {
    const o = this.#options;
    const activeViewId = o.session.activeViewId;
    const mode = activeViewId === undefined ? undefined : o.session.readView(activeViewId)?.session.mode;
    if (mode !== 'normal' && mode !== undefined && !mode.startsWith('visual')) return false;
    const navigated = (port: RouterOverlayKeypressPort | undefined): boolean => port?.isOpen() === true && port.capturesTextInput?.() !== true;
    return navigated(o.overlayExplorer) || navigated(o.overlaySearch) || navigated(o.overlayGit) || navigated(o.overlayGitDiff) || navigated(o.overlayProblems) || navigated(o.overlayOutput) || navigated(o.overlayOutline) || navigated(o.overlayHierarchy) || navigated(o.overlayHover);
  }

  handleKeypress(event: OwnedVimKeyEvent): boolean | 'quit' | Promise<boolean | 'quit'> {
    const { explorer, search, host, session, completion } = this.#options;
    // Preserve focus and queued keys while the first panel's services load.
    if (explorer.isOpen && !this.#options.isExplorerServiceLoaded()) {
      return (async () => {
        await this.#options.ensureOptionalServices();
        await explorer.handleKeypress(event);
        return true;
      })();
    }
    if (search.isOpen && !this.#options.isSearchServiceLoaded()) {
      return (async () => {
        await this.#options.ensureOptionalServices();
        await search.handleKeypress(event);
        return true;
      })();
    }
    const activeCommandSession = host.activeSession();
    if (activeCommandSession?.commandLineActive === true) return activeCommandSession.handleKey(event);
    const activeViewId = session.activeViewId;
    const activeMode = activeViewId === undefined ? undefined : session.readView(activeViewId)?.session.mode;
    if (completion.isCompletionTrigger(event, activeMode)) return completion.openCompletion();
    if (completion.isSignatureTrigger(event, activeMode)) return completion.openSignature();
    if (completion.isSnippetActive) return completion.handleSnippetKeypress(event);
    if ((activeMode === 'normal' || activeMode === undefined) && ((this.#bindingMode() !== 'normal' && (event.raw === ' ' || event.name.toLowerCase() === 'space')) || isNormalSpace(event, activeMode))) {
      this.#leaderPending = true;
      this.#leaderKeys = Object.freeze(['<Space>']);
      this.scheduleLeaderHelp();
      return true;
    }
    if (this.#leaderPending) return this.handleLeaderKeypress(event);
    {
      const commandId = this.#resolveBoundCommand(activeMode ?? 'normal', event);
      if (commandId !== undefined && !isViewCommandId(commandId)) return this.#executeWorkbenchCommandId(commandId);
      if (activeViewId !== undefined && commandId !== undefined && isViewCommandId(commandId)) {
        const handled = executeViewCommand(commandId, {
          workbench: session,
          getSession: (viewId) => host.sessions.get(viewId),
          viewId: activeViewId,
          viewportHeight: this.#options.getViewportHeight(activeViewId),
          scrollLines: this.#options.scrollLines,
        });
        if (handled) { this.#options.marker('XI_VIEW_COMMAND', { commandId, viewId: activeViewId }); return true; }
      }
    }
    const active = session.activeViewId === undefined ? undefined : host.sessions.get(session.activeViewId);
    if (active === undefined) {
      if (event.raw === ':' && !event.ctrl && !event.meta && !event.option) {
        this.#commandLineWithoutSession = true;
        this.#exCommandLineSession = new ExCommandLineSession({ registry: this.#options.commandRegistry, source: ':', cursorOffset: 1 });
        this.#publishCommandLine();
        return true;
      }
      return false;
    }
    return active.handleKey(event);
  }

  /** Config-overridable mode+key -> commandId lookup, consulted before Vim's own key
   * handling (item DOC-INPUT-BINDINGS). Only single-key (non-chord) bindings resolve here;
   * multi-key chord config bindings are out of scope for this fast path. */
  #resolveBoundCommand(mode: string, event: OwnedVimKeyEvent): string | undefined {
    const token = canonicalKeyToken(event);
    const lookupToken = token.startsWith('<') ? token.toLowerCase() : token;
    return this.#bindings.get(`${mode}\u0000${lookupToken}`);
  }

  handlePaste(bytes: Uint8Array): void {
    if (this.#options.overlayGitDiff?.isReadOnly?.() === true || this.#gitPanelFocused) return;
    const { explorer, search, problems, overlays, picker, host } = this.#options;
    // Only the editor's own Insert/Replace/Virtual-replace mode consumes paste today;
    // pasting while any overlay/panel is focused is a disclosed, un-wired gap (T045/E12).
    if (explorer.isOpen || search.isOpen || problems.isProblemsOpen || overlays.isOutlineOpen || picker.isOpen || this.#leaderPending) return;
    const active = host.activeSession();
    if (active?.commandLineActive === true) return;
    active?.handlePaste(bytes);
    this.#options.marker('XI_PASTE', { length: bytes.length });
  }

  focusEditor(): void { this.#gitPanelFocused = false; }

  async handleLeaderKeypress(event: OwnedVimKeyEvent): Promise<boolean> {
    const { host } = this.#options;
    this.#prefixHelp.cancel();
    this.#prefixGeneration += 1;
    // <space>q<register> starts a macro recording. This uses the leader-key layer rather
    // than bare Normal-mode 'q' (real Vim's own trigger) because 'q' alone already means
    // "quick quit" in Xi (docs/evidence/T038.md) and that shipped, widely-tested shortcut
    // is out of scope to remove here; stopping (bare 'q' while recording) and playback
    // (real '@'/'@@') have no such conflict and use their natural Vim keys directly.
    if (this.#macroRegisterPending) {
      this.#macroRegisterPending = false;
      this.#leaderPending = false;
      const register = event.raw.length === 1 ? event.raw : undefined;
      const vim = host.activeSession();
      const started = register !== undefined && vim !== undefined && vim.beginMacroRecording(register);
      this.#options.marker('XI_MACRO_STATE', { recording: started === true, register: started === true ? register : undefined });
      if (!started) this.#options.onError('xi: invalid macro register\n');
      return true;
    }
    const keys = [...this.#leaderKeys, canonicalKeyToken(event)];
    const matches = (binding: RouterBindingConfig): boolean => binding.keys.length >= keys.length
      && keys.every((key, index) => normalizeConfigToken(key) === normalizeConfigToken(binding.keys[index] ?? ''));
    const candidates = this.#leaderBindings().filter(matches);
    const configured = candidates.find(binding => binding.keys.length === keys.length);
    if (configured !== undefined) {
      this.#leaderPending = false;
      this.#leaderKeys = Object.freeze([]);
      return this.#executeWorkbenchCommandId(configured.commandId);
    }
    if (candidates.length > 0) {
      this.#leaderKeys = Object.freeze(keys);
      this.scheduleLeaderHelp();
      return true;
    }
    this.#leaderPending = false;
    this.#leaderKeys = Object.freeze([]);
    return true;
  }

  async #executeWorkbenchCommandId(commandId: string): Promise<boolean> {
    const { picker, explorer, search, problems, overlays, workspaceEdits } = this.#options;
    switch (commandId) {
      case 'macro.record': this.#macroRegisterPending = true; this.#leaderPending = true; return true;
      case 'files.pick': picker.open('file'); return true;
      case 'buffers.pick': picker.open('buffer'); return true;
      case 'command.pick': picker.open('command'); return true;
      case 'theme.pick': picker.open('theme'); return true;
      case 'config.open': picker.open('config'); return true;
      case 'config.reload': this.#options.onError('xi: config reload is unavailable in this session\n'); return true;
      case 'search.workspace': search.open(); return true;
      case 'search.replace': search.startReplace(); return true;
      case 'panel.files.focus': explorer.open(); return true;
      case 'panel.search.focus': search.open(); return true;
      case 'panel.git.focus': await this.#options.openGitPanel?.(); return true;
      case 'panel.outline.focus': overlays.openOutline(); return true;
      case 'panel.problems.focus': problems.openProblems(); return true;
      case 'git.diff': await this.#options.openGitDiffForActiveBuffer?.(); return true;
      case 'lsp.hover': overlays.openHover(); return true;
      case 'lsp.code-action': return workspaceEdits.requestCodeActions();
      case 'sidebar.toggle': this.#options.toggleSidebar?.(); return true;
      case 'editor.mouse.toggle': this.#options.toggleMouseMode(); return true;
      case 'panel.preview': return this.#dispatchPanelKey('l', 'l');
      case 'panel.open': return this.#dispatchPanelKey('enter', '\r');
      case 'panel.close': return this.#dispatchPanelKey('q', 'q');
      case 'files.edit-directory':
      case 'files.edit-buffer-directory': {
        const viewId = this.#options.session.activeViewId ?? this.#options.launchViewId;
        await this.#options.executeWorkbenchCommand?.('Explore', viewId);
        return true;
      }
      default: return false;
    }
  }

  #leaderBindings(): readonly RouterBindingConfig[] {
    const mode = this.#bindingMode();
    const local = this.#options.bindings.filter(binding => binding.mode === mode);
    if (mode === 'normal') return local;
    const inherited = this.#options.bindings.filter(binding => binding.mode === 'normal' && !local.some(override => {
      const length = Math.min(binding.keys.length, override.keys.length);
      return binding.keys.slice(0, length).every((key, index) => normalizeConfigToken(key) === normalizeConfigToken(override.keys[index] ?? ''));
    }));
    return [...local, ...inherited];
  }

  #bindingMode(): string {
    const o = this.#options;
    if (o.overlayExplorer?.isOpen() === true) return 'files-panel';
    if (o.overlaySearch?.isOpen() === true) return 'search-panel';
    if (o.overlayGitDiff?.isOpen() === true && !this.#gitPanelFocused) return 'normal';
    if (o.overlayGit?.isOpen() === true) return 'git-panel';
    return 'normal';
  }

  async #dispatchPanelKey(name: string, raw: string): Promise<boolean> {
    const event = keyEvent(raw, { name, shift: false, option: false, ctrl: false, meta: false });
    const o = this.#options;
    const port = o.overlayExplorer?.isOpen() === true ? o.overlayExplorer
      : o.overlaySearch?.isOpen() === true ? o.overlaySearch
        : o.overlayGitDiff?.isOpen() === true ? o.overlayGitDiff
          : o.overlayGit?.isOpen() === true ? o.overlayGit
            : undefined;
    if (port === undefined) return false;
    await port.onKeypress(event);
    return true;
  }

  async handleCommandLineKeypress(event: OwnedVimKeyEvent): Promise<boolean | 'quit'> {
    const active = this.#options.host.activeSession();
    if (active === undefined && !this.#commandLineWithoutSession) return false;
    if (this.#searchPromptModel !== undefined) {
      if (active === undefined) return false;
      await active.handleKey(event);
      return true;
    }
    const line = this.#exCommandLineSession;
    if (line === undefined) return false;
    const input = toExCommandLineInput(event);
    if (input === undefined) return true;
    const result = line.handleInput(input);
    if (result.kind === 'cancel') {
      if (active !== undefined) await active.handleKey(event);
      else this.#closeStandaloneCommandLine();
      return true;
    }
    if (result.kind === 'execute' || result.kind === 'error') {
      if (result.kind === 'execute' && (result.execution.kind === 'xi-alias' || result.execution.kind === 'xi-command')) {
        if (active !== undefined) await active.handleKey(keyEvent('\x1b', { name: 'escape', shift: false, option: false, ctrl: false, meta: false }));
        else this.#closeStandaloneCommandLine();
        return this.#executeWorkbenchCommandId(String(result.execution.commandId));
      }
      if (active !== undefined) return active.submitCommandLine(result.source);
      const source = result.source.startsWith(':') ? result.source.slice(1) : result.source;
      this.#closeStandaloneCommandLine();
      const outcome = await this.#options.executeWorkbenchCommand?.(source, this.#options.launchViewId) ?? 'unhandled';
      if (outcome === 'quit') return 'quit';
      if (outcome === 'unhandled') this.#options.onError('xi: command requires an editable buffer\n');
      return true;
    }
    if (active !== undefined) active.setCommandLineSource(result.source, result.cursorOffset);
    else this.#publishCommandLine();
    return true;
  }

  #publishCommandLine(): void {
    this.commandLine.read.model = this.#exCommandLineSession?.readModel();
    for (const listener of [...this.#commandLineListeners]) listener(this.commandLine.read.model);
    this.#options.marker('XI_EX_COMMANDLINE_STATE', this.commandLine.read.model === undefined ? undefined : {
      source: this.commandLine.read.model.source,
      cursorOffset: this.commandLine.read.model.cursorOffset,
      kind: 'ex',
    });
  }

  #closeStandaloneCommandLine(): void {
    this.#commandLineWithoutSession = false;
    this.#exCommandLineSession?.dispose();
    this.#exCommandLineSession = undefined;
    this.commandLine.read.model = undefined;
    for (const listener of [...this.#commandLineListeners]) listener(undefined);
    this.#options.marker('XI_EX_COMMANDLINE_STATE', undefined);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#prefixHelp.dispose();
    this.#exCommandLineSession?.dispose();
    this.#commandLineListeners.clear();
  }
}

/** An overlay stack entry that reports itself open always consumes the key it's handed --
 * `terminal.ts`'s original `finishFocusedKey` never inspected the per-panel boolean/void
 * result either, only whether the panel asked to quit. Preserves the synchronous-result fast
 * path (no `await`/microtask hop) when the panel's own handler answers synchronously. */
function finishOverlay(result: void | boolean | 'quit' | Promise<void | boolean | 'quit'>): RouterDispatchOutcome | Promise<RouterDispatchOutcome> {
  const finish = (value: void | boolean | 'quit'): RouterDispatchOutcome => value === 'quit' ? 'quit' : 'consumed';
  return typeof result === 'object' ? result.then(finish) : finish(result);
}

function isNormalSpace(event: { readonly name: string; readonly raw: string }, mode: string | undefined): boolean {
  if (event.raw !== ' ' && event.name.toLowerCase() !== 'space') return false;
  return mode === 'normal';
}

function keyEvent(raw: string, source: { readonly name: string; readonly shift: boolean; readonly option: boolean; readonly ctrl: boolean; readonly meta: boolean }): OwnedVimKeyEvent {
  return { name: raw === ' ' ? '<Space>' : raw, raw, shift: source.shift, option: source.option, ctrl: source.ctrl, meta: source.meta };
}

function toExCommandLineInput(event: OwnedVimKeyEvent): ExCommandLineInput | undefined {
  const name = event.name.toLowerCase();
  if (name === 'enter' || name === 'return' || event.raw === '\r' || event.raw === '\n') return { kind: 'key', key: 'Enter' };
  if (name === 'tab' || event.raw === '\t') return { kind: 'key', key: 'Tab' };
  if (name === 'escape' || event.raw === '') return { kind: 'key', key: 'Escape' };
  if (name === 'backspace') return { kind: 'key', key: 'Backspace' };
  if (name === 'delete') return { kind: 'key', key: 'Delete' };
  if (name === 'arrowleft') return { kind: 'key', key: 'ArrowLeft' };
  if (name === 'arrowright') return { kind: 'key', key: 'ArrowRight' };
  if (name === 'arrowup') return { kind: 'key', key: 'ArrowUp' };
  if (name === 'arrowdown') return { kind: 'key', key: 'ArrowDown' };
  if (!event.ctrl && !event.meta && !event.option) {
    const text = event.raw.length === 0 && name === 'space' ? ' ' : event.raw;
    if (text.length === 1) return { kind: 'text', text };
  }
  return undefined;
}

function searchPromptModel(source: string, cursorOffset: number): ReturnType<ExCommandLineSession['readModel']> {
  const empty = { source, segmentStart: 0, segmentEnd: source.length, rangeStart: 0, rangeEnd: 0, commandNameStart: 0, commandNameEnd: 0, argumentStart: 1, argumentEnd: source.length, separatorStart: null, typedName: '', typedBang: false };
  return Object.freeze({
    source, cursorOffset, registryGeneration: 0, position: empty, parsed: undefined, parseFailure: undefined,
    candidates: Object.freeze([]), selectedIndex: 0, acceptanceHint: 'Enter: search · Esc: cancel', typedCommandExact: false,
    canExecute: source.length > 1, execution: undefined,
  });
}
