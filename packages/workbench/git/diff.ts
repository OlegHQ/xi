import type { Disposable, Result } from '../../contracts/src/index';
import type { OwnedVimKeyEvent } from '../vim-session';
import type { BufferHost } from '../host';

export type { OwnedVimKeyEvent as GitDiffKeyEvent };

/** Mirrors `packages/services/git/diff`'s line-diff shapes, subset actually read here --
 * workbench cannot import `packages/services`, not even types. */
export interface GitDiffLine { readonly kind: 'context' | 'added' | 'removed'; readonly oldLine?: number; readonly newLine?: number; readonly text: string; }
export interface GitDiffHunk { readonly index: number; readonly oldStart: number; readonly oldCount: number; readonly newStart: number; readonly newCount: number; readonly firstLineIndex: number; }
export type GitDiffTarget = 'index' | 'worktree';
export type GitDiffLoadResult =
  | { readonly kind: 'ready'; readonly leftLabel: string; readonly rightLabel: string; readonly diff: { readonly lines: readonly GitDiffLine[]; readonly hunks: readonly GitDiffHunk[] } }
  | { readonly kind: 'binary'; readonly leftLabel: string; readonly rightLabel: string }
  | { readonly kind: 'unavailable'; readonly message: string };

/** Narrow port onto the composition root's (lazily constructed) `GitDiffService`. */
export interface GitDiffServicePort {
  load(input: { readonly root: string; readonly relativePath: string; readonly target: GitDiffTarget }): Promise<Result<GitDiffLoadResult, { readonly message: string }>>;
}

export type DiffLayout = 'unified' | 'side-by-side';
export type DiffViewState = 'loading' | 'ready' | 'unavailable';

export interface DiffViewReadModel {
  readonly path: string;
  readonly target: GitDiffTarget;
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly layout: DiffLayout;
  readonly lines: readonly GitDiffLine[];
  readonly hunks: readonly GitDiffHunk[];
  readonly selectedHunk: number;
  readonly scrollTop: number;
  readonly state: DiffViewState;
  readonly message: string | undefined;
  readonly generation: number;
}

const SIDE_BY_SIDE_MIN_WIDTH = 110;

export interface DiffViewControllerOptions {
  readonly host: BufferHost;
  readonly service: GitDiffServicePort;
  readonly workspaceRoot: string;
  readonly marker: (name: string, payload?: unknown) => void;
}

/**
 * Owns the Git diff view: async/cancellable load of a `GitDiffService` result into a
 * memoized read model, hunk navigation, scrolling, unified/side-by-side layout selection by
 * viewport width and opening the diffed file at the selected hunk. Never mutates buffers --
 * `Enter`/`o` only navigates an already-open (or newly opened) buffer's cursor.
 */
export class DiffViewController implements Disposable {
  readonly #options: DiffViewControllerOptions;
  #open = false;
  #path = '';
  #target: GitDiffTarget = 'worktree';
  #layout: DiffLayout = 'unified';
  #lines: readonly GitDiffLine[] = [];
  #hunks: readonly GitDiffHunk[] = [];
  #selectedHunk = 0;
  #scrollTop = 0;
  #state: DiffViewState = 'loading';
  #message: string | undefined;
  #leftLabel = 'BASE';
  #rightLabel = 'WORKTREE';
  #generation = 0;
  #loadToken = 0;
  #viewportHeight = 20;
  #model: DiffViewReadModel | undefined;
  #modelGeneration = -1;
  #pendingBracket: '[' | ']' | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(options: DiffViewControllerOptions) {
    this.#options = options;
  }

  get isOpen(): boolean { return this.#open; }

  /** For `DiffRenderable`: repaint whenever the read model's generation advances. */
  subscribe(listener: () => void): Disposable {
    this.#listeners.add(listener);
    return { dispose: () => { this.#listeners.delete(listener); } };
  }

  #bump(): void {
    this.#generation += 1;
    for (const listener of this.#listeners) listener();
  }

  async open(relativePath: string, target: GitDiffTarget): Promise<void> {
    // The status panel stays docked beside the diff (VS Code Source Control shape): `q` in
    // the diff returns focus to the still-open panel so `s`/`u` keep working.
    this.#options.host.closeAllPanels(['git-diff', 'git']);
    this.#open = true;
    this.#path = relativePath;
    this.#target = target;
    this.#state = 'loading';
    this.#message = undefined;
    this.#lines = [];
    this.#hunks = [];
    this.#selectedHunk = 0;
    this.#scrollTop = 0;
    this.#bump();
    this.#loadToken += 1;
    const token = this.#loadToken;
    this.#options.marker('XI_GIT_DIFF_OPEN', { path: relativePath, target });
    this.#options.host.notifySurfaceChange();
    const result = await this.#options.service.load({ root: this.#options.workspaceRoot, relativePath, target });
    if (token !== this.#loadToken || !this.#open) return;
    if (!result.ok) { this.#state = 'unavailable'; this.#message = result.error.message; this.#bump(); this.#options.host.notifySurfaceChange(); return; }
    if (result.value.kind === 'unavailable') { this.#state = 'unavailable'; this.#message = result.value.message; this.#bump(); this.#options.host.notifySurfaceChange(); return; }
    if (result.value.kind === 'binary') {
      this.#state = 'unavailable';
      this.#message = 'binary file';
      this.#leftLabel = result.value.leftLabel;
      this.#rightLabel = result.value.rightLabel;
      this.#bump();
      this.#options.host.notifySurfaceChange();
      return;
    }
    this.#state = 'ready';
    this.#leftLabel = result.value.leftLabel;
    this.#rightLabel = result.value.rightLabel;
    this.#lines = result.value.diff.lines;
    this.#hunks = result.value.diff.hunks;
    this.#bump();
    this.#options.marker('XI_GIT_DIFF_READY', { hunks: this.#hunks.length, selectedHunk: this.#selectedHunk });
    this.#options.host.notifySurfaceChange();
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#loadToken += 1;
    this.#bump();
    this.#options.marker('XI_GIT_DIFF_CLOSED', {});
    this.#options.host.notifySurfaceChange();
  }

  setViewport(width: number, height: number): void {
    this.#viewportHeight = Math.max(1, height);
    const nextLayout: DiffLayout = width < SIDE_BY_SIDE_MIN_WIDTH ? 'unified' : 'side-by-side';
    if (nextLayout !== this.#layout) { this.#layout = nextLayout; this.#bump(); }
  }

  readModel(): DiffViewReadModel {
    if (this.#model !== undefined && this.#modelGeneration === this.#generation) return this.#model;
    const model: DiffViewReadModel = Object.freeze({
      path: this.#path,
      target: this.#target,
      leftLabel: this.#leftLabel,
      rightLabel: this.#rightLabel,
      layout: this.#layout,
      lines: this.#lines,
      hunks: this.#hunks,
      selectedHunk: this.#selectedHunk,
      scrollTop: this.#scrollTop,
      state: this.#state,
      message: this.#message,
      generation: this.#generation,
    });
    this.#model = model;
    this.#modelGeneration = this.#generation;
    return model;
  }

  #scrollToHunk(index: number): void {
    const hunk = this.#hunks[index];
    if (hunk === undefined) return;
    this.#selectedHunk = index;
    this.#options.marker('XI_GIT_DIFF_HUNK', { selectedHunk: index });
    if (hunk.firstLineIndex < this.#scrollTop) this.#scrollTop = hunk.firstLineIndex;
    else if (hunk.firstLineIndex >= this.#scrollTop + this.#viewportHeight) this.#scrollTop = Math.max(0, hunk.firstLineIndex - Math.floor(this.#viewportHeight / 2));
    this.#bump();
  }

  #clampScroll(): void {
    const max = Math.max(0, this.#lines.length - Math.max(1, this.#viewportHeight - 1));
    this.#scrollTop = Math.max(0, Math.min(max, this.#scrollTop));
  }

  handleKeypress(event: OwnedVimKeyEvent): boolean {
    const key = event.name.toLowerCase();
    if (key === 'q' || key === 'escape' || event.raw === '') { this.#pendingBracket = undefined; this.close(); return true; }
    // `]c`/`[c` arrive as two keystrokes (bracket, then 'c'); track the pending bracket
    // across one keypress the way the Vim engine's own multi-key sequences do.
    if (event.raw === ']' || event.raw === '[') { this.#pendingBracket = event.raw; return true; }
    if (this.#pendingBracket !== undefined) {
      const bracket = this.#pendingBracket;
      this.#pendingBracket = undefined;
      if (key === 'c') {
        if (bracket === ']') this.#scrollToHunk(Math.min(this.#hunks.length - 1, this.#selectedHunk + 1));
        else this.#scrollToHunk(Math.max(0, this.#selectedHunk - 1));
        return true;
      }
    }
    if (key === 'j' || key === 'down') { this.#scrollTop += 1; this.#clampScroll(); this.#bump(); return true; }
    if (key === 'k' || key === 'up') { this.#scrollTop -= 1; this.#clampScroll(); this.#bump(); return true; }
    if (event.ctrl && key === 'd') { this.#scrollTop += Math.floor(this.#viewportHeight / 2); this.#clampScroll(); this.#bump(); return true; }
    if (event.ctrl && key === 'u') { this.#scrollTop -= Math.floor(this.#viewportHeight / 2); this.#clampScroll(); this.#bump(); return true; }
    if (key === 'g' && !event.shift) { this.#scrollTop = 0; this.#bump(); return true; }
    if (key === 'g' && event.shift) { this.#scrollTop = Math.max(0, this.#lines.length - Math.max(1, this.#viewportHeight - 1)); this.#bump(); return true; }
    if (key === 't') { this.#layout = this.#layout === 'unified' ? 'side-by-side' : 'unified'; this.#bump(); return true; }
    if (key === 'enter' || key === 'return' || key === 'o' || event.raw === '\r' || event.raw === '\n') { void this.#openAtSelectedHunk(); return true; }
    return true;
  }

  selectHunkAt(index: number): void {
    if (index < 0 || index >= this.#hunks.length) return;
    this.#scrollToHunk(index);
    this.#options.host.notifySurfaceChange();
  }

  onPointer(delta: number): void {
    if (delta === 0) return;
    this.#scrollTop += delta;
    this.#clampScroll();
    this.#bump();
    this.#options.host.notifySurfaceChange();
  }

  async #openAtSelectedHunk(): Promise<void> {
    const hunk = this.#hunks[this.#selectedHunk];
    const absolutePath = `${this.#options.workspaceRoot}/${this.#path}`;
    const opened = await this.#options.host.openBufferAtPath(absolutePath);
    if (opened === undefined) return;
    const session = this.#options.host.sessions.get(opened.viewId);
    const line = hunk?.newStart !== undefined && hunk.newStart > 0 ? hunk.newStart - 1 : 0;
    session?.setCursorPosition(line, 0);
    this.close();
  }

  dispose(): void {
    this.#open = false;
    this.#loadToken += 1;
    this.#listeners.clear();
  }
}
