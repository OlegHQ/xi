import type { Disposable, ViewId } from '../../contracts/src/index';
import type { BufferHost } from '../host';
import type { WorkbenchSession } from '../session';
import { CommandRegistry } from '../commands/registry';
import { ExCommandLineSession, type ExCommandLineInput } from '../commands/ex-command-line';
import { PrefixHelpController, buildPrefixHelpReadModel, type PrefixHelpReadModel, type PrefixHelpRequest } from '../commands/prefix-help';
import type { OwnedVimKeyEvent, VimPrefixHelpState } from '../vim-session';

export type { OwnedVimKeyEvent as RouterKeyEvent };

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
  readonly #commandLineListeners = new Set<(model: ReturnType<ExCommandLineSession['readModel']> | undefined) => void>();
  #disposed = false;

  constructor(options: WorkbenchInputRouterOptions) {
    this.#options = options;
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
        bindings: [],
      }),
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
  handleCommandLineChange(state: { readonly source: string; readonly cursorOffset: number } | undefined): void {
    if (state === undefined) {
      this.#exCommandLineSession?.dispose();
      this.#exCommandLineSession = undefined;
    } else if (this.#exCommandLineSession === undefined) {
      this.#exCommandLineSession = new ExCommandLineSession({ registry: this.#options.commandRegistry, source: state.source, cursorOffset: state.cursorOffset });
    } else {
      this.#exCommandLineSession.setSource(state.source, state.cursorOffset);
    }
    this.commandLine.read.model = this.#exCommandLineSession?.readModel();
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
    const active = session.activeViewId === undefined ? undefined : host.sessions.get(session.activeViewId);
    if (active === undefined) return false;
    return active.handleKey(event);
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
    const line = this.#exCommandLineSession;
    if (active === undefined || line === undefined) return false;
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
