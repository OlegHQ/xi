import type { ClockPort, Disposable, ViewId } from '../../contracts/src/index';
import type { BufferHost } from '../host';
import type { WorkbenchSession } from '../session';
import { CommandRegistry } from '../commands/registry';
import { ExCommandLineSession, type ExCommandLineInput } from '../commands/ex-command-line';
import { PrefixHelpController, buildPrefixHelpReadModel, type PrefixHelpReadModel, type PrefixHelpRequest } from '../commands/prefix-help';
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
  /** Lazily-constructed explorer/search backing services; composition-root work this
   * router never duplicates -- it only asks whether they are ready yet. */
  readonly isExplorerServiceLoaded: () => boolean;
  readonly isSearchServiceLoaded: () => boolean;
  readonly ensureOptionalServices: () => Promise<void>;
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
  #leaderPanelPending = false;
  #macroRegisterPending = false;
  #prefixGeneration = 0;
  // schedulePrefixHelp fires on every key via onPrefixStateChange. vim-session hands back
  // the same VimPrefixHelpState object (same pendingKeys/parserContinuations array
  // references) whenever nothing prefix-related actually changed, so caching those two
  // references lets the overwhelmingly common no-op key skip the generation bump, the
  // array copies and any timer churn entirely.
  #lastPrefixPendingKeys: readonly string[] | undefined;
  #lastPrefixContinuations: VimPrefixHelpState['parserContinuations'] | undefined;
  #exCommandLineSession: ExCommandLineSession | undefined;
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
        // Leader/macro pending-key sequences only; config key bindings are ordinary
        // mode+key -> commandId mappings (resolved directly in `handleKeypress`), not
        // pending-sequence discovery hints, so there is nothing config-sourced to add here.
        bindings: [],
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
    return this.#options.host.activeSession()?.commandLineActive === true;
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
    this.schedulePrefixHelp(targetViewId, ['<Space>'], [{ kind: 'keys', keys: ['v', 'f', 'b', 's', 'p', 'o', 'k', 'a', 'd', 'e', '/', 'r'], label: 'Leader workbench command' }]);
  }

  /** Reproduces the original `onKeypress` chain exactly, except that it no longer forces a
   * microtask hop on every ordinary keystroke: only the two branches below actually await
   * (loading the explorer/search services on first use), and every other branch returns its
   * callee's result -- synchronous or not -- directly, so the vim-session fast path
   * (`canHandleSynchronously`) reaches the caller without an added `await`. */
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
    if (isNormalSpace(event, activeMode)) {
      this.#leaderPending = true;
      this.#leaderPanelPending = false;
      this.scheduleLeaderHelp();
      return true;
    }
    if (this.#leaderPending) return this.handleLeaderKeypress(event);
    if (activeViewId !== undefined && activeMode !== undefined) {
      const commandId = this.#resolveBoundCommand(activeMode, event);
      if (commandId !== undefined && isViewCommandId(commandId)) {
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
    if (active === undefined) return false;
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
    const { explorer, search, problems, overlays, picker, host } = this.#options;
    // Only the editor's own Insert/Replace/Virtual-replace mode consumes paste today;
    // pasting while any overlay/panel is focused is a disclosed, un-wired gap (T045/E12).
    if (explorer.isOpen || search.isOpen || problems.isProblemsOpen || overlays.isOutlineOpen || picker.isOpen || this.#leaderPending) return;
    const active = host.activeSession();
    if (active?.commandLineActive === true) return;
    active?.handlePaste(bytes);
    this.#options.marker('XI_PASTE', { length: bytes.length });
  }

  async handleLeaderKeypress(event: OwnedVimKeyEvent): Promise<boolean> {
    const { picker, explorer, search, problems, overlays, workspaceEdits, host } = this.#options;
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
    if (!this.#leaderPanelPending && event.name.toLowerCase() === 'v') {
      this.#leaderPanelPending = true;
      return true;
    }
    if (!this.#leaderPanelPending && event.name.toLowerCase() === 'q') {
      this.#macroRegisterPending = true;
      return true;
    }
    const panelPrefix = this.#leaderPanelPending;
    this.#leaderPending = false;
    this.#leaderPanelPending = false;
    if (panelPrefix && event.name.toLowerCase() === 'f') {
      if (picker.isOpen) await picker.close(true);
      if (search.isOpen) search.close();
      explorer.open();
      return true;
    }
    if (panelPrefix && event.name.toLowerCase() === 's') {
      if (picker.isOpen) await picker.close(true);
      if (explorer.isOpen) explorer.close();
      search.open();
      return true;
    }
    if (panelPrefix && event.name.toLowerCase() === 'p') {
      if (picker.isOpen) await picker.close(true);
      if (explorer.isOpen) explorer.close();
      if (search.isOpen) search.close();
      problems.openProblems();
      return true;
    }
    if (panelPrefix && event.name.toLowerCase() === 'o') {
      if (picker.isOpen) await picker.close(true);
      if (explorer.isOpen) explorer.close();
      if (search.isOpen) search.close();
      overlays.openOutline();
      return true;
    }
    if (!panelPrefix && event.name.toLowerCase() === 'k') {
      if (picker.isOpen) await picker.close(true);
      if (explorer.isOpen) explorer.close();
      if (search.isOpen) search.close();
      overlays.openHover();
      return true;
    }
    if (!panelPrefix && event.name.toLowerCase() === 'a') return workspaceEdits.requestCodeActions();
    if (!panelPrefix && event.name.toLowerCase() === 'm') {
      const enabled = this.#options.toggleMouseMode();
      this.#options.marker('XI_MOUSE_MODE', { enabled });
      return true;
    }
    if (!panelPrefix && (event.name.toLowerCase() === 'd' || event.name.toLowerCase() === 'e')) {
      if (picker.isOpen) await picker.close(true);
      if (explorer.isOpen) explorer.close();
      if (search.isOpen) search.close();
      problems.openProblems();
      return true;
    }
    if (!panelPrefix && event.name === '/') {
      if (picker.isOpen) await picker.close(true);
      if (explorer.isOpen) explorer.close();
      search.open();
      return true;
    }
    if (!panelPrefix && event.name.toLowerCase() === 'r') {
      search.startReplace();
      return true;
    }
    const mode = pickerModeForLeader(event);
    if (mode !== undefined) {
      if (explorer.isOpen) explorer.close();
      if (search.isOpen) search.close();
      picker.open(mode);
      return true;
    }
    const activeBeforeLeader = host.activeSession();
    if (activeBeforeLeader !== undefined) await activeBeforeLeader.handleKey(keyEvent(' ', event));
    return true;
  }

  async handleCommandLineKeypress(event: OwnedVimKeyEvent): Promise<boolean | 'quit'> {
    const active = this.#options.host.activeSession();
    if (active === undefined) return false;
    if (this.#searchPromptModel !== undefined) {
      await active.handleKey(event);
      return true;
    }
    const line = this.#exCommandLineSession;
    if (line === undefined) return false;
    const input = toExCommandLineInput(event);
    if (input === undefined) return true;
    const result = line.handleInput(input);
    if (result.kind === 'cancel') {
      await active.handleKey(event);
      return true;
    }
    if (result.kind === 'execute' || result.kind === 'error') {
      return active.submitCommandLine(result.source);
    }
    active.setCommandLineSource(result.source, result.cursorOffset);
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#prefixHelp.dispose();
    this.#exCommandLineSession?.dispose();
    this.#commandLineListeners.clear();
  }
}

function isNormalSpace(event: { readonly name: string; readonly raw: string }, mode: string | undefined): boolean {
  if (event.raw !== ' ' && event.name.toLowerCase() !== 'space') return false;
  return mode === 'normal';
}

function pickerModeForLeader(event: { readonly name: string }): RouterPickerMode | undefined {
  switch (event.name.toLowerCase()) {
    case 'f': return 'file';
    case 'b': return 'buffer';
    case ';': return 'command';
    case 't': return 'theme';
    case 'c': return 'config';
    default: return undefined;
  }
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
