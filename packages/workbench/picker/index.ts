import { CancellationSource, type CancellationToken, type ClockPort, type PlatformFailure, type Result, type ViewId } from '../../contracts/src/index';
import type { OwnedVimKeyEvent } from '../vim-session';
import type { BufferHost } from '../host';

/** Mirrors `packages/services/navigation`'s `PickerMode`/`PickerEntry` shape structurally --
 * workbench cannot import `packages/services`, not even types, so only the literal union and
 * the fields this controller actually reads are declared here. */
export type WorkbenchPickerMode = 'file' | 'buffer' | 'command' | 'theme' | 'config' | 'git' | 'diagnostic' | 'recovery';

export interface WorkbenchPickerEntry {
  readonly id: string;
  readonly mode: WorkbenchPickerMode;
  readonly value: string;
}

export type WorkbenchPickerFailure = { readonly kind: string };

/** Narrow port onto `BoundedPickerModel` (constructed in the composition root together with
 * its providers, which live in services): only the query/select/cancel surface the controller
 * actually drives. */
export interface PickerModelPort<TEntry extends WorkbenchPickerEntry = WorkbenchPickerEntry> {
  readonly model: { readonly entries: readonly TEntry[]; readonly selectedId: string | undefined };
  query(mode: WorkbenchPickerMode, query: string, options?: { readonly includeHidden?: boolean; readonly includeIgnored?: boolean }): Promise<Result<{ readonly entries: readonly TEntry[] }, WorkbenchPickerFailure>>;
  select(id: string): boolean;
  cancel(): void;
}

export interface PickerControllerOptions<TEntry extends WorkbenchPickerEntry, TTheme = unknown> {
  readonly host: BufferHost;
  readonly model: PickerModelPort<TEntry>;
  readonly theme: ThemeController<TTheme>;
  readonly clock: ClockPort;
  readonly marker: (name: string, payload?: unknown) => void;
  readonly bufferStartPosition?: 'current' | 'previous';
  readonly includeHiddenByDefault?: boolean;
  readonly startFileIndexPopulation: () => Promise<void>;
  /** Populates ignored file paths only after the user enables them in the picker. */
  readonly startIgnoredFileIndexPopulation?: () => Promise<void>;
  /** Loads the custom theme catalog on first theme-picker use. */
  readonly loadThemeCatalog?: () => Promise<void>;
  readonly toggleMouseMode: () => boolean;
  readonly openDiagnostic?: (id: string) => Promise<void>;
  readonly restoreRecovery?: (id: string) => Promise<boolean>;
  /** Opens the user's config.toml for the config picker/`:config-open` command. */
  readonly openConfig?: () => Promise<void>;
  /** Opens a promoted buffer's file (commit) or a preview (no commit); returns the same
   * result shape as `BufferHost.openBufferAtPath` so preview/promote bookkeeping stays here. */
  readonly openFile: (path: string, preview: boolean) => ReturnType<BufferHost['openBufferAtPath']>;
  /** Git-picker-only secondary action (stage/unstage the selected entry), keyed by `s`/`u` in
   * `handleKeypress` below -- the key->action mapping is this controller's policy, not the
   * composition root's; the callback only receives the resolved semantic action. */
  readonly onSecondaryAction?: (entry: TEntry, action: 'stage' | 'unstage') => void;
  readonly onClose?: () => void;
}

/**
 * Owns the "quick open" picker's UI-facing state: open/mode/query/generation, keypress
 * handling, live preview (file buffers and themes) and commit/cancel. Moved out of
 * `apps/xi/src/main.ts`'s `main()` closure; the picker's data (`BoundedPickerModel` and its
 * providers) still lives in `packages/services/navigation` and is only ever reached through
 * `PickerModelPort`.
 */
export class PickerController<TEntry extends WorkbenchPickerEntry = WorkbenchPickerEntry, TTheme = unknown> {
  #open = false;
  #disposed = false;
  #mode: WorkbenchPickerMode = 'file';
  #query = '';
  #generation = 0;
  #visibleRows = 10;
  #includeHidden: boolean;
  #includeIgnored = false;
  readonly #options: PickerControllerOptions<TEntry, TTheme>;

  constructor(options: PickerControllerOptions<TEntry, TTheme>) {
    this.#options = options;
    this.#includeHidden = options.includeHiddenByDefault === true;
  }

  /** Cancels any open picker so its underlying model query/preview state does not keep running
   * (or leave a stale preview view) after the composition root tears the workbench down. */
  dispose(): void {
    this.#disposed = true;
    if (this.#open) void this.close(true);
  }

  get isOpen(): boolean { return this.#open; }
  get isDisposed(): boolean { return this.#disposed; }
  get mode(): WorkbenchPickerMode { return this.#mode; }
  toggleIncludeHidden(): void { if (this.#mode === 'file') { this.#includeHidden = !this.#includeHidden; this.#runQuery(); } }
  toggleIncludeIgnored(): void {
    if (this.#mode !== 'file') return;
    this.#includeIgnored = !this.#includeIgnored;
    this.#runQuery();
    if (!this.#includeIgnored || this.#options.startIgnoredFileIndexPopulation === undefined) return;
    void this.#options.startIgnoredFileIndexPopulation().then(() => {
      if (this.#open && this.#mode === 'file' && this.#includeIgnored) this.#runQuery();
    });
  }

  setVisibleRows(rows: number): void { this.#visibleRows = Math.max(1, Math.trunc(rows)); }

  open(mode: WorkbenchPickerMode): void {
    if (this.#open) void this.close(true);
    this.#options.host.closeAllPanels('picker');
    this.#mode = mode;
    this.#query = '';
    this.#open = true;
    if (mode === 'file') void this.#options.startFileIndexPopulation();
    if (mode === 'theme') {
      this.#options.theme.beginPreview();
      void this.#options.loadThemeCatalog?.().then(() => { if (this.#open && this.#mode === 'theme') this.refresh(); });
    }
    this.#runQuery();
  }

  async close(cancelPreview: boolean): Promise<void> {
    const wasOpen = this.#open;
    this.#generation += 1;
    this.#open = false;
    this.#options.model.cancel();
    this.#options.theme.endPreview(!cancelPreview);
    if (wasOpen && !this.#disposed) this.#options.onClose?.();
    if (!cancelPreview) return;
    const viewId = this.#options.host.previewViewId;
    if (viewId === undefined) return;
    this.#options.host.previewViewId = undefined;
    const discarded = this.#options.host.discardPreviewView(viewId);
    if (discarded.ok) this.#options.marker('XI_PICKER_CANCELLED', { viewId, activeViewId: discarded.activeViewId });
  }

  async handleKeypress(event: OwnedVimKeyEvent): Promise<void> {
    const key = event.name.toLowerCase();
    if (key === 'escape' || event.raw === '\u001b') {
      await this.close(true);
      return;
    }
    const model = this.#options.model;
    const halfPage = Math.max(1, Math.floor(this.#visibleRows / 2));
    const step = key === 'up' || (event.ctrl && (key === 'p' || key === 'k')) ? -1
      : key === 'down' || (event.ctrl && (key === 'n' || key === 'j')) ? 1
      : event.ctrl && key === 'u' ? -halfPage : event.ctrl && key === 'd' ? halfPage
      : key === 'pageup' ? -this.#visibleRows : key === 'pagedown' ? this.#visibleRows : 0;
    if (step !== 0) {
      const entries = model.model.entries;
      const selected = entries.findIndex((entry) => entry.id === model.model.selectedId);
      const next = Math.max(0, Math.min(entries.length - 1, selected + step));
      const entry = entries[next];
      if (entry !== undefined && model.select(entry.id)) void this.#previewSelected(entry);
      return;
    }
    if (key === 'enter' || key === 'return' || event.raw === '\r' || event.raw === '\n') {
      const selected = model.model.entries.find((entry) => entry.id === model.model.selectedId);
      if (selected !== undefined) await this.activateEntry(selected);
      return;
    }
    if (key === 'backspace' || key === 'backspace2' || event.raw === '\u007f') {
      this.#query = this.#query.slice(0, -1);
      this.#runQuery();
      return;
    }
    if (event.ctrl || event.meta || event.option) return;
    const raw = event.raw;
    if (this.#mode === 'git' && this.#options.onSecondaryAction !== undefined && (raw === 's' || raw === 'u')) {
      const selected = model.model.entries.find((entry) => entry.id === model.model.selectedId);
      if (selected !== undefined) this.#options.onSecondaryAction(selected, raw === 's' ? 'stage' : 'unstage');
      return;
    }
    if (raw.length === 1 && raw >= ' ' && raw !== '\u007f') {
      this.#query += raw;
      this.#runQuery();
    }
  }

  async activateEntry(entry: TEntry): Promise<void> {
    if (entry.mode === 'diagnostic') {
      await this.close(false);
      await this.#options.openDiagnostic?.(entry.value);
      return;
    }
    if (entry.mode === 'recovery') {
      if (await this.#options.restoreRecovery?.(entry.value)) await this.close(false);
      return;
    }
    if (entry.mode === 'command') {
      if (entry.value === 'toggle-mouse') {
        await this.close(false);
        const enabled = this.#options.toggleMouseMode();
        this.#options.marker('XI_MOUSE_MODE', { enabled });
        return;
      }
      const mode = entry.value;
      if (mode === 'file' || mode === 'buffer' || mode === 'command' || mode === 'theme' || mode === 'config' || mode === 'diagnostic') this.open(mode);
      return;
    }
    if (entry.mode === 'file' || entry.mode === 'git') {
      await this.#openFileEntry(entry, true);
      return;
    }
    if (entry.mode === 'buffer') {
      const viewId = this.#options.host.focusBufferById(entry.value);
      if (viewId !== undefined) await this.close(false);
      return;
    }
    if (entry.mode === 'theme') {
      // A click can activate a row without first previewing it.
      if (!this.#options.theme.preview(entry.value)) return;
      this.#options.theme.commit();
      const cancellation = new CancellationSource();
      void this.#options.theme.persistActiveId(cancellation.token).finally(() => cancellation.dispose());
      this.#options.marker('XI_THEME_APPLIED', { id: this.#options.theme.activeId });
      void this.close(false);
      return;
    }
    if (entry.mode === 'config') {
      await this.close(false);
      await this.#options.openConfig?.();
      return;
    }
    await this.close(false);
  }

  /** Uses the same selected-entry preview path for pointer hover and keyboard navigation. */
  previewSelected(): void {
    const selected = this.#options.model.model.entries.find((entry) => entry.id === this.#options.model.model.selectedId);
    void this.#previewSelected(selected);
  }

  /** Requery a live provider without changing the user's query or selected identity. */
  refresh(): void { if (this.#open) this.#runQuery(true); }

  async #previewSelected(entry: TEntry | undefined): Promise<void> {
    if (!this.#open || entry === undefined) return;
    if (entry.mode === 'theme') {
      this.#options.theme.preview(entry.value);
      return;
    }
    if (entry.mode !== 'file') return;
    await this.#openFileEntry(entry, false);
  }

  async #openFileEntry(entry: TEntry, commit: boolean): Promise<void> {
    const opened = await this.#options.openFile(entry.value, !commit);
    if (opened === undefined) return;
    const { viewId, bufferId, created } = opened;
    if (commit) {
      this.#options.host.promoteBuffer(bufferId, viewId);
      await this.close(false);
      return;
    }
    if (created) {
      this.#options.host.discardStalePreview(viewId);
      this.#options.host.previewViewId = viewId;
      this.#options.marker('XI_PICKER_PREVIEW', { viewId, path: entry.value });
    } else {
      this.#options.host.discardStalePreview(viewId);
    }
  }

  #runQuery(retainSelection = false): void {
    const selectedId = retainSelection
      ? this.#options.model.model.selectedId
      : this.#mode === 'buffer' && this.#query.length === 0
        ? this.#options.host.bufferPickerSelection(this.#options.bufferStartPosition ?? 'current')
        : undefined;
    const generation = ++this.#generation;
    const query = this.#query;
    const mode = this.#mode;
    void this.#options.model.query(mode, query, { includeHidden: this.#includeHidden, includeIgnored: this.#includeIgnored }).then((result) => {
      if (generation !== this.#generation) return;
      this.#options.host.notifySurfaceChange();
      if (!result.ok) {
        // 'stale' means the index generation moved while populating (e.g. addPaths
        // bumps generation per batch); retry with the same bounded backoff as
        // 'not-ready' instead of dropping the query on the floor.
        if ((result.error.kind === 'not-ready' || result.error.kind === 'stale') && this.#open) {
          this.#options.clock.schedule(50, () => { if (generation === this.#generation && this.#open) this.#runQuery(); });
        }
        return;
      }
      // A theme picker opens on the applied theme. Other pickers retain their first-result
      // behavior; if filtering hides the active theme, the first match becomes the preview.
      const selected = mode === 'theme'
        ? result.value.entries.find((entry) => entry.value === this.#options.theme.activeId) ?? result.value.entries[0]
        : result.value.entries.find(entry => entry.id === selectedId) ?? result.value.entries[0];
      if (selected !== undefined) this.#options.model.select(selected.id);
      if (selected !== undefined && mode === 'buffer') this.#options.marker('XI_BUFFER_PICKER', { startPosition: this.#options.bufferStartPosition ?? 'current', selectedId: selected.id });
      void this.#previewSelected(selected);
    });
  }
}

export interface ThemeFilesystemPort {
  readFile(path: string, cancellation: CancellationToken): Promise<Result<Uint8Array, PlatformFailure>>;
  writeFileAtomic(path: string, contents: Uint8Array, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
  makeDirectory(path: string, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
}

export interface ThemeControllerOptions<T> {
  readonly initial: ReadonlyMap<string, T>;
  readonly defaultId: string;
  readonly filesystem: ThemeFilesystemPort;
  readonly statePath: string;
  readonly stateDirectory: string;
  readonly persistSelection?: (id: string) => Promise<void>;
  readonly onPersistError?: (message: string) => void;
}

/**
 * Owns the active/persisted theme id, the "before entering the theme picker" id used to
 * revert a live preview on cancel, and the builtin+custom theme table. `T` is opaque
 * (`WorkbenchTheme`, owned by `packages/ui`) -- this module never imports it, only stores it
 * and forwards it to a `setTheme` port the composition root supplies.
 */
export class ThemeController<T> {
  readonly #themes: Map<string, T>;
  readonly #customLabels = new Map<string, string>();
  readonly #filesystem: ThemeFilesystemPort;
  readonly #statePath: string;
  readonly #stateDirectory: string;
  readonly #persistSelection: ((id: string) => Promise<void>) | undefined;
  readonly #onPersistError: ((message: string) => void) | undefined;
  #activeId: string;
  #beforePicker: string | undefined;
  #setTheme: ((theme: T) => void) | undefined;

  constructor(options: ThemeControllerOptions<T>) {
    this.#themes = new Map(options.initial);
    this.#activeId = options.defaultId;
    this.#filesystem = options.filesystem;
    this.#statePath = options.statePath;
    this.#stateDirectory = options.stateDirectory;
    this.#onPersistError = options.onPersistError;
    this.#persistSelection = options.persistSelection;
  }

  get activeId(): string { return this.#activeId; }
  has(id: string): boolean { return this.#themes.has(id); }
  get(id: string): T | undefined { return this.#themes.get(id); }

  /** Bound once the UI adapter constructs its live theme setter; unset before that. */
  bindSetTheme(setTheme: (theme: T) => void): void {
    this.#setTheme = setTheme;
  }

  setActiveId(id: string): void {
    this.#activeId = id;
  }

  addCustomTheme(id: string, label: string, theme: T): void {
    this.#customLabels.set(id, label);
    this.#themes.set(id, theme);
  }

  customThemeEntries(): ReadonlyArray<{ readonly id: string; readonly label: string }> {
    return [...this.#customLabels].map(([id, label]) => ({ id, label }));
  }

  /** Apply a theme immediately for a live-preview flow -- persistence happens separately,
   * only on commit. Returns whether the theme was known and applied. */
  preview(id: string): boolean {
    const theme = this.#themes.get(id);
    if (theme === undefined) return false;
    this.#setTheme?.(theme);
    this.#activeId = id;
    return true;
  }

  beginPreview(): void {
    this.#beforePicker = this.#activeId;
  }

  /** `commit === false` reverts to the id recorded by `beginPreview()`; `commit === true`
   * just stops tracking it (the live preview is kept as the new active theme). */
  endPreview(commit: boolean): void {
    if (!commit && this.#beforePicker !== undefined) this.preview(this.#beforePicker);
    this.#beforePicker = undefined;
  }

  /** Stops tracking a "before" theme to revert to on cancel; call once the picker selection
   * is being kept, before persisting. */
  commit(): void {
    this.#beforePicker = undefined;
    const theme = this.#themes.get(this.#activeId);
    if (theme !== undefined) this.#setTheme?.(theme);
  }

  async readPersistedId(cancellation: CancellationToken): Promise<string | undefined> {
    const read = await this.#filesystem.readFile(this.#statePath, cancellation);
    if (!read.ok) return undefined;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8').decode(read.value));
      const theme = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).theme : undefined;
      return typeof theme === 'string' ? theme : undefined;
    } catch {
      return undefined;
    }
  }

  /** Never throws; a failure is reported through the constructor's `onPersistError` (main.ts
   * writes it to stderr) and otherwise swallowed, since a persistence failure must never
   * block editing. */
  async persistActiveId(cancellation: CancellationToken): Promise<void> {
    const activeId = this.#activeId;
    if (this.#persistSelection !== undefined) {
      try { await this.#persistSelection(activeId); }
      catch (error) { this.#onPersistError?.(`could not persist the selected theme: ${error instanceof Error ? error.message : String(error)}`); }
      return;
    }
    const made = await this.#filesystem.makeDirectory(this.#stateDirectory, cancellation);
    if (!made.ok) { this.#onPersistError?.(`could not create theme state directory: ${made.error.message}`); return; }
    const written = await this.#filesystem.writeFileAtomic(this.#statePath, new TextEncoder().encode(`${JSON.stringify({ theme: activeId })}\n`), cancellation);
    if (!written.ok) this.#onPersistError?.(`could not persist the selected theme: ${written.error.message}`);
  }
}

export type { ViewId };
