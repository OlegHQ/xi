import type { Disposable } from '../../contracts/src/index';
import type { OwnedVimKeyEvent } from '../vim-session';
import type { BufferHost } from '../host';

export type { OwnedVimKeyEvent as GitKeyEvent };

/** Mirrors `packages/services/git`'s `GitEntryState`/`GitStatusEntry`/`GitStatusSnapshot`
 * structurally -- workbench cannot import `packages/services`, not even types, so only the
 * fields this controller actually reads are declared here. */
export type WorkbenchGitEntryState = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'ignored' | 'conflicted';
export interface WorkbenchGitEntry {
  readonly path: string;
  readonly originalPath?: string;
  readonly state: WorkbenchGitEntryState;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly conflict: boolean;
}
export interface WorkbenchGitSnapshot {
  readonly root: string;
  readonly generation: number;
  readonly entries: readonly WorkbenchGitEntry[];
  readonly branch: string | undefined;
}

/** Mirrors `packages/services/git`'s `GitStatusService`, subset read here. */
export interface GitStatusPort {
  readonly snapshot: WorkbenchGitSnapshot | undefined;
  subscribe(listener: (snapshot: WorkbenchGitSnapshot) => void): Disposable;
  refresh(): Promise<void>;
}

export interface GitMutationContext { readonly root: string; readonly generation: number; readonly expectedGeneration: number; }
export type GitMutationFailure = { readonly kind: string; readonly message: string };
export type GitMutationResult = { readonly ok: true; readonly value: void } | { readonly ok: false; readonly error: GitMutationFailure };
/** Mirrors `packages/services/git`'s `GitMutationCoordinator`, subset read here. */
export interface GitMutationPort {
  stage(paths: readonly string[], context: GitMutationContext): Promise<GitMutationResult>;
  unstage(paths: readonly string[], context: GitMutationContext): Promise<GitMutationResult>;
}

/** Mirrors the small subset of `SearchFilesystemPort` this controller needs to translate
 * workspace-relative Git paths into absolute paths for `host.openBufferAtPath`. */
export interface GitPanelFilesystemPort {
  workspaceRelativePath(root: string, path: string): string | undefined;
  workspaceAbsolutePath(root: string, relativePath: string): string | undefined;
}

export type GitSectionId = 'staged' | 'changes' | 'untracked' | 'conflicts';
export const GIT_SECTION_ORDER: readonly GitSectionId[] = Object.freeze(['staged', 'changes', 'untracked', 'conflicts']);
const GIT_SECTION_LABELS: Readonly<Record<GitSectionId, string>> = Object.freeze({ staged: 'Staged Changes', changes: 'Changes', untracked: 'Untracked', conflicts: 'Merge Conflicts' });

export interface GitPanelRow {
  readonly id: string;
  readonly path: string;
  readonly state: WorkbenchGitEntryState;
  /** Single-letter status glyph the renderer paints (M/A/D/R/U/C). */
  readonly letter: string;
}

export interface GitPanelSection {
  readonly id: GitSectionId;
  readonly label: string;
  readonly count: number;
  readonly collapsed: boolean;
  readonly entries: readonly GitPanelRow[];
}

export interface GitPanelReadModel {
  readonly contractVersion: 1;
  readonly generation: number;
  readonly branch: string | undefined;
  readonly state: 'idle' | 'loading' | 'ready' | 'unavailable';
  readonly message: string | undefined;
  readonly sections: readonly GitPanelSection[];
  readonly selectedId: string | undefined;
}

// Bounded rows: an ordinary repo has at most a few dozen dirty files; a status snapshot with
// thousands of entries (a bulk generated-file checkout, a mis-scoped .gitignore) must never
// make this controller materialize every row on every keystroke.
const MAX_ROWS = 2000;

function letterFor(state: WorkbenchGitEntryState): string {
  switch (state) {
    case 'modified': return 'M';
    case 'added': return 'A';
    case 'deleted': return 'D';
    case 'renamed': return 'R';
    case 'untracked': return 'U';
    case 'conflicted': return 'C';
    case 'ignored': return 'I';
    default: return '?';
  }
}

function sectionFor(entry: WorkbenchGitEntry): GitSectionId | undefined {
  if (entry.conflict) return 'conflicts';
  if (entry.state === 'untracked') return 'untracked';
  if (entry.staged) return 'staged';
  if (entry.unstaged) return 'changes';
  return undefined;
}

export interface GitPanelOptions {
  readonly onOpen?: () => void;
  readonly host: BufferHost;
  readonly status: GitStatusPort;
  readonly mutations: GitMutationPort;
  readonly filesystem: GitPanelFilesystemPort;
  readonly workspaceRoot: string;
  readonly marker: (name: string, payload?: unknown) => void;
  readonly onError: (message: string) => void;
  /** Opens a file by absolute path (default action when no `openDiff` is provided). */
  readonly openEntry?: (absolutePath: string) => void;
  /** When provided, Enter/activate on a row opens a diff view instead of the plain file;
   * `target` is `'index'` for a fully-staged entry (diff against HEAD), `'worktree'`
   * otherwise (diff against the index). */
  readonly openDiff?: (relativePath: string, target: 'index' | 'worktree') => Promise<void>;
}

/**
 * Owns the docked Git (Source Control) panel's state: open/close, section collapse, row
 * selection, and stage/unstage mutations -- mirrors `packages/workbench/search`'s
 * `SearchController` shape (open/close/isOpen/readModel/handleKeypress/onPointer) so the UI
 * wiring and terminal adapter can dock it exactly the same way as Search.
 */
export class GitPanelController {
  #open = false;
  #generation = -1;
  #snapshot: WorkbenchGitSnapshot | undefined;
  readonly #collapsed = new Set<GitSectionId>();
  #selectedId: string | undefined;
  #modelCache: GitPanelReadModel | undefined;
  #modelCacheKey = '';
  #pendingG = false;
  #subscription: Disposable | undefined;
  readonly #options: GitPanelOptions;

  constructor(options: GitPanelOptions) {
    this.#options = options;
  }

  get isOpen(): boolean { return this.#open; }

  /** Current read model -- `GitReadPort.model` for `packages/ui/git`'s `GitRenderable`. */
  get model(): GitPanelReadModel { return this.readModel(); }

  /** `GitReadPort.subscribe` -- notified on every state change that can affect the painted
   * model (status snapshot updates, selection, collapse, open/close). */
  subscribe(listener: (model: GitPanelReadModel) => void): Disposable {
    this.#modelListeners.add(listener);
    return { dispose: () => { this.#modelListeners.delete(listener); } };
  }

  readonly #modelListeners = new Set<(model: GitPanelReadModel) => void>();

  #emit(): void {
    const model = this.readModel();
    for (const listener of this.#modelListeners) listener(model);
  }

  open(): void {
    this.#options.onOpen?.();
    this.#options.host.closeAllPanels('git');
    this.#open = true;
    this.#subscription ??= this.#options.status.subscribe((snapshot) => {
      this.#snapshot = snapshot;
      this.#invalidate();
      this.#options.host.notifySurfaceChange();
    });
    this.#snapshot = this.#options.status.snapshot;
    this.#invalidate();
    this.#options.marker('XI_GIT_PANEL_OPEN', {});
    void this.#options.status.refresh();
  }

  close(): void {
    this.#open = false;
    this.#invalidate();
    this.#options.marker('XI_GIT_PANEL_CLOSED', {});
  }

  #invalidate(): void { this.#modelCache = undefined; this.#emit(); }

  /** Every current row, in painted order (section header, then its entries unless
   * collapsed) -- the single source of truth for both `readModel` and up/down navigation. */
  #flatten(sections: readonly GitPanelSection[]): readonly string[] {
    const ids: string[] = [];
    for (const section of sections) {
      ids.push(`git-section:${section.id}`);
      if (!section.collapsed) for (const row of section.entries) ids.push(row.id);
    }
    return ids;
  }

  #buildSections(): readonly GitPanelSection[] {
    const entries = this.#snapshot?.entries ?? [];
    const grouped = new Map<GitSectionId, GitPanelRow[]>();
    let counted = 0;
    let truncated = false;
    for (const entry of entries) {
      const section = sectionFor(entry);
      if (section === undefined) continue;
      if (counted >= MAX_ROWS) { truncated = true; continue; }
      counted += 1;
      const row: GitPanelRow = { id: `git:${entry.path}`, path: entry.path, state: entry.state, letter: letterFor(entry.state) };
      const bucket = grouped.get(section);
      if (bucket === undefined) grouped.set(section, [row]);
      else bucket.push(row);
    }
    const sections = GIT_SECTION_ORDER.map((id): GitPanelSection => {
      const rows = grouped.get(id) ?? [];
      return { id, label: GIT_SECTION_LABELS[id], count: rows.length, collapsed: this.#collapsed.has(id), entries: Object.freeze(rows) };
    });
    if (truncated) this.#truncatedMore = entries.length - counted;
    else this.#truncatedMore = 0;
    return Object.freeze(sections);
  }

  #truncatedMore = 0;

  readModel(): GitPanelReadModel {
    const generation = this.#snapshot?.generation ?? -1;
    const key = `${generation}|${this.#selectedId ?? ''}|${[...this.#collapsed].sort().join(',')}`;
    if (this.#modelCache !== undefined && this.#modelCacheKey === key) return this.#modelCache;
    const sections = this.#buildSections();
    const flat = this.#flatten(sections);
    // Do not let the synthetic section headers in the initial loading model become the
    // persistent default selection. Once status arrives, focus the first actionable file.
    if (this.#snapshot !== undefined && (this.#selectedId === undefined || !flat.includes(this.#selectedId))) {
      this.#selectedId = flat.find((id) => !id.startsWith('git-section:')) ?? flat[0];
    }
    const state: GitPanelReadModel['state'] = this.#snapshot === undefined ? 'loading' : this.#snapshot.entries.length === 0 && generation < 0 ? 'unavailable' : 'ready';
    const message = this.#truncatedMore > 0 ? `+${String(this.#truncatedMore)} more` : undefined;
    const model: GitPanelReadModel = Object.freeze({
      contractVersion: 1,
      generation,
      branch: this.#snapshot?.branch,
      state,
      message,
      sections,
      selectedId: this.#selectedId,
    });
    this.#modelCache = model;
    this.#modelCacheKey = key;
    return model;
  }

  #context(): GitMutationContext | undefined {
    const snapshot = this.#snapshot;
    if (snapshot === undefined) return undefined;
    return { root: this.#options.workspaceRoot, generation: snapshot.generation, expectedGeneration: snapshot.generation };
  }

  #rowFor(id: string): GitPanelRow | undefined {
    for (const section of this.readModel().sections) {
      const found = section.entries.find((entry) => entry.id === id);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  #entryFor(path: string): WorkbenchGitEntry | undefined {
    return this.#snapshot?.entries.find((entry) => entry.path === path);
  }

  async stageSelected(): Promise<void> {
    const row = this.#selectedId === undefined ? undefined : this.#rowFor(this.#selectedId);
    if (row === undefined) return;
    const context = this.#context();
    if (context === undefined) return;
    const result = await this.#options.mutations.stage([row.path], context);
    if (!result.ok) { this.#options.onError(`xi: git stage failed: ${result.error.message}\n`); return; }
    this.#options.marker('XI_GIT_STAGE', { path: row.path });
    void this.#options.status.refresh();
  }

  async unstageSelected(): Promise<void> {
    const row = this.#selectedId === undefined ? undefined : this.#rowFor(this.#selectedId);
    if (row === undefined) return;
    const context = this.#context();
    if (context === undefined) return;
    const result = await this.#options.mutations.unstage([row.path], context);
    if (!result.ok) { this.#options.onError(`xi: git unstage failed: ${result.error.message}\n`); return; }
    this.#options.marker('XI_GIT_UNSTAGE', { path: row.path });
    void this.#options.status.refresh();
  }

  refresh(): void { void this.#options.status.refresh(); }

  async openRow(id: string): Promise<void> {
    const row = this.#rowFor(id);
    if (row === undefined) return;
    const relativePath = this.#options.filesystem.workspaceRelativePath(this.#options.workspaceRoot, row.path) ?? row.path;
    const absolutePath = this.#options.filesystem.workspaceAbsolutePath(this.#options.workspaceRoot, relativePath);
    if (absolutePath === undefined) return;
    this.#options.openEntry?.(absolutePath);
    if (this.#options.openEntry === undefined) await this.#options.host.openBufferAtPath(absolutePath);
    this.close();
  }

  async openDiffRow(id: string): Promise<void> {
    const row = this.#rowFor(id);
    const entry = row === undefined ? undefined : this.#entryFor(row.path);
    if (row === undefined || this.#options.openDiff === undefined) return;
    const relativePath = this.#options.filesystem.workspaceRelativePath(this.#options.workspaceRoot, row.path) ?? row.path;
    const target: 'index' | 'worktree' = entry !== undefined && entry.staged && !entry.unstaged ? 'index' : 'worktree';
    await this.#options.openDiff(relativePath, target);
  }

  toggleCollapsed(sectionId: GitSectionId): void {
    if (this.#collapsed.has(sectionId)) this.#collapsed.delete(sectionId);
    else this.#collapsed.add(sectionId);
    this.#invalidate();
    this.#options.host.notifySurfaceChange();
  }

  setSelectedId(id: string): void {
    this.#selectedId = id;
    this.#invalidate();
  }

  #moveSelection(delta: number): void {
    const flat = this.#flatten(this.readModel().sections);
    if (flat.length === 0) return;
    const currentIndex = this.#selectedId === undefined ? -1 : flat.indexOf(this.#selectedId);
    const nextIndex = Math.max(0, Math.min(flat.length - 1, (currentIndex < 0 ? 0 : currentIndex) + delta));
    this.#selectedId = flat[nextIndex];
    this.#invalidate();
    this.#options.host.notifySurfaceChange();
  }

  /** Pointer click: selects a row, or toggles collapse for a `git-section:<id>` header. */
  onPointer(itemId: string): void {
    if (itemId.startsWith('git-section:')) {
      const sectionId = itemId.slice('git-section:'.length) as GitSectionId;
      this.toggleCollapsed(sectionId);
      return;
    }
    this.setSelectedId(itemId);
    this.#options.host.notifySurfaceChange();
  }

  /** Pointer activate previews the row's diff while the Git panel stays docked. */
  onPointerActivate(itemId: string): void {
    if (itemId.startsWith('git-section:')) { this.onPointer(itemId); return; }
    this.setSelectedId(itemId);
    void this.openDiffRow(itemId);
  }

  async handleKeypress(event: OwnedVimKeyEvent): Promise<boolean> {
    const key = event.name.toLowerCase();
    if (key === 'escape' || event.raw === '\x1b' || key === 'q') { this.close(); return true; }
    if (event.ctrl && key === 'd') { this.#moveSelection(5); return true; }
    if (event.ctrl && key === 'u') { this.#moveSelection(-5); return true; }
    if (key === 'down' || key === 'j') { this.#moveSelection(1); return true; }
    if (key === 'up' || key === 'k') { this.#moveSelection(-1); return true; }
    if (key === 'g' && event.shift) { this.#pendingG = false; this.#moveSelection(Number.MAX_SAFE_INTEGER); return true; }
    if (key === 'g') {
      if (this.#pendingG) { this.#pendingG = false; this.#moveSelection(-Number.MAX_SAFE_INTEGER); }
      else this.#pendingG = true;
      return true;
    }
    this.#pendingG = false;
    if (key === 's') { void this.stageSelected(); return true; }
    if (key === 'u') { void this.unstageSelected(); return true; }
    if (key === 'r') { this.refresh(); return true; }
    if (key === 'l') {
      const id = this.#selectedId;
      if (id !== undefined && !id.startsWith('git-section:')) void this.openDiffRow(id);
      return true;
    }
    if (key === 'enter' || key === 'return' || event.raw === '\r' || event.raw === '\n') {
      const id = this.#selectedId;
      if (id !== undefined) {
        if (id.startsWith('git-section:')) this.onPointer(id);
        else void this.openDiffRow(id);
      }
      return true;
    }
    return true;
  }

  dispose(): void {
    this.#subscription?.dispose();
    this.#subscription = undefined;
    this.#modelListeners.clear();
  }
}
