import { CancellationSource, asIdentifier, type Disposable, type Result, type ViewId, type DocumentId, type Utf16Offset } from '../../contracts/src/index';
import { openTextDocument, type DocumentSnapshot } from '../../document/src/entrypoints/launch';
import type { OwnedVimKeyEvent } from '../vim-session';
import type { BufferHost } from '../host';
import type { WorkbenchSession } from '../session';
export interface ComparisonAlignment { readonly rows: readonly { readonly left: number | null; readonly right: number | null; readonly added: boolean; readonly removed: boolean }[]; readonly rowForRightLine: readonly number[]; }

export type { OwnedVimKeyEvent as GitDiffKeyEvent };
export interface GitDiffLine { readonly kind: 'context' | 'added' | 'removed'; readonly oldLine?: number; readonly newLine?: number; readonly text: string; }
export interface GitDiffHunk { readonly index: number; readonly oldStart: number; readonly oldCount: number; readonly newStart: number; readonly newCount: number; readonly firstLineIndex: number; }
export interface GitLineDiff { readonly lines: readonly GitDiffLine[]; readonly hunks: readonly GitDiffHunk[]; }
export type GitDiffTarget = 'index' | 'worktree';
export type GitDiffLoadResult =
  | { readonly kind: 'ready'; readonly leftLabel: string; readonly rightLabel: string; readonly leftText: string; readonly rightText: string; readonly diff: GitLineDiff }
  | { readonly kind: 'binary'; readonly leftLabel: string; readonly rightLabel: string }
  | { readonly kind: 'unavailable'; readonly message: string };
export interface GitDiffServicePort {
  align(lines: readonly GitDiffLine[]): Promise<{ readonly unified: ComparisonAlignment; readonly split: ComparisonAlignment }>;
  load(input: { readonly root: string; readonly relativePath: string; readonly target: GitDiffTarget; readonly cancellation?: CancellationSource['token'] }): Promise<Result<GitDiffLoadResult, { readonly message: string }>>;
  compare(leftText: string, rightText: string, cancellation?: CancellationSource['token']): Promise<GitLineDiff>;
}
export type DiffLayout = 'unified' | 'side-by-side';
export type DiffViewState = 'loading' | 'ready' | 'unavailable';
/** A comparison editor shares the worktree's document, undo and save identity. */
export interface DiffViewReadModel {
  readonly viewId: ViewId;
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
  readonly left: DocumentSnapshot;
  readonly right: DocumentSnapshot;
  readonly editable: boolean;
  readonly unified: ComparisonAlignment;
  readonly split: ComparisonAlignment;
}
interface Comparison {
  model: DiffViewReadModel;
  readonly leftText: string;
  readonly documentId: DocumentId;
  readonly subscription: Disposable;
  pending: ReturnType<typeof setTimeout> | undefined;
  running: boolean;
  disposed: boolean;
  cancellation: CancellationSource | undefined;
}
export interface DiffViewControllerOptions {
  readonly host: BufferHost;
  readonly workbench: WorkbenchSession;
  readonly service: GitDiffServicePort;
  readonly workspaceRoot: string;
  readonly marker: (name: string, payload?: unknown) => void;
  readonly openSyntax: (snapshot: DocumentSnapshot, path: string) => void;
  readonly closeSyntax: (documentId: DocumentId) => void;
  readonly onError: (message: string) => void;
}

export class DiffViewController implements Disposable {
  readonly #options: DiffViewControllerOptions;
  readonly #entries = new Map<ViewId, Comparison>();
  readonly #listeners = new Set<() => void>();
  readonly #viewClosedSubscription: Disposable;
  #load: CancellationSource | undefined;
  #sequence = 0;
  #pendingBracket: '[' | ']' | undefined;

  constructor(options: DiffViewControllerOptions) {
    this.#options = options;
    this.#viewClosedSubscription = options.host.onViewClosed(viewId => {
      const entry = this.#entries.get(viewId);
      if (entry === undefined) return;
      this.#release(entry);
      this.#entries.delete(viewId);
    });
  }
  get isOpen(): boolean { return this.readComparison() !== undefined; }
  subscribe(listener: () => void): Disposable { this.#listeners.add(listener); return { dispose: () => { this.#listeners.delete(listener); } }; }
  #emit(): void { for (const listener of this.#listeners) listener(); this.#options.host.notifySurfaceChange(); }
  readComparison(viewId = this.#options.workbench.activeViewId): DiffViewReadModel | undefined {
    if (viewId === undefined) return undefined;
    const entry = this.#entries.get(viewId);
    if (entry === undefined) return undefined;
    if (this.#options.workbench.readView(viewId) === undefined) { this.#release(entry); this.#entries.delete(viewId); return undefined; }
    const document = this.#options.host.documents.get(entry.documentId);
    if (entry.model.editable && document !== undefined) {
      const snapshot = document.snapshot();
      if (snapshot.version !== entry.model.right.version || document.isDirty !== (entry.model.rightLabel === 'BUFFER (unsaved)')) {
        return { ...entry.model, right: snapshot, state: snapshot.version === entry.model.right.version ? 'ready' : 'loading', rightLabel: document.isDirty ? 'BUFFER (unsaved)' : 'WORKTREE' };
      }
    }
    return entry.model;
  }

  async open(path: string, target: GitDiffTarget): Promise<void> {
    const o = this.#options;
    for (const [viewId, entry] of this.#entries) {
      if (o.workbench.readView(viewId) === undefined) { this.#release(entry); this.#entries.delete(viewId); continue; }
      if (entry.model.path === path && entry.model.target === target) { o.workbench.focus(viewId); this.#emit(); return; }
    }
    this.#load?.dispose();
    const cancellation = new CancellationSource();
    this.#load = cancellation;
    o.marker('XI_GIT_DIFF_OPEN', { path, target });
    const loaded = await o.service.load({ root: o.workspaceRoot, relativePath: path, target, cancellation: cancellation.token });
    if (cancellation.token.isCancelled || this.#load !== cancellation) return;
    if (!loaded.ok || loaded.value.kind !== 'ready') {
      o.onError(!loaded.ok ? loaded.error.message : loaded.value.kind === 'unavailable' ? loaded.value.message : 'Binary comparison: no editable text');
      return;
    }
    const { unified, split } = await o.service.align(loaded.value.diff.lines);
    if (cancellation.token.isCancelled) return;
    const opened = await o.host.openBufferAtPath(`${o.workspaceRoot}/${path}`);
    if (opened === undefined || cancellation.token.isCancelled) return;
    const document = o.host.documents.get(opened.bufferId);
    if (document === undefined) return;
    const label = `${path.split('/').pop() ?? path} (${target === 'index' ? 'Index' : 'Working Tree'})`;
    const created = o.workbench.openComparisonView(opened.viewId, label);
    if (!created.ok) { o.onError(created.error.kind); return; }
    const viewId = created.value.viewId;
    o.host.createSession(document, viewId, created.value.session.selections);
    const left = this.#snapshot(loaded.value.leftText, path);
    const right = target === 'index' ? this.#snapshot(loaded.value.rightText, path) : document.snapshot();
    const model: DiffViewReadModel = {
      viewId, path, target, leftLabel: loaded.value.leftLabel,
      rightLabel: target === 'worktree' && document.isDirty ? 'BUFFER (unsaved)' : loaded.value.rightLabel,
      layout: 'side-by-side', lines: loaded.value.diff.lines, hunks: loaded.value.diff.hunks,
      selectedHunk: 0, scrollTop: 0, state: 'ready', message: undefined, generation: 1,
      left, right, editable: target === 'worktree', unified, split,
    };
    const entry: Comparison = {
      model, leftText: loaded.value.leftText.replace(/\r\n/g, '\n'), documentId: opened.bufferId,
      subscription: document.subscribeChanges(() => { if (target === 'worktree') this.#schedule(entry); }),
      pending: undefined, running: false, disposed: false, cancellation: undefined,
    };
    this.#entries.set(viewId, entry);
    if (target === 'worktree' && document.isDirty) await this.#refresh(entry);
    o.host.closeAllPanels(['git', 'git-diff']);
    this.#jump(entry, 0);
    o.marker('XI_GIT_DIFF_READY', { hunks: entry.model.hunks.length, selectedHunk: 0, viewId });
    this.#emit();
  }
  #snapshot(text: string, path: string): DocumentSnapshot {
    const id = asIdentifier<DocumentId>(`xi-diff-original-${++this.#sequence}`, 'diff snapshot');
    if (!id.ok) throw new Error(id.error.message);
    const opened = openTextDocument(id.value, new TextEncoder().encode(text));
    if (opened.kind !== 'editable') throw new Error(`Cannot decode comparison: ${opened.kind}`);
    const snapshot = opened.document.snapshot();
    this.#options.openSyntax(snapshot, path);
    return snapshot;
  }
  #schedule(entry: Comparison): void {
    entry.cancellation?.cancel();
    if (entry.disposed || entry.pending !== undefined || entry.running) return;
    entry.pending = setTimeout(() => { entry.pending = undefined; void this.#refresh(entry).catch(error => this.#options.onError(String(error))); }, 0);
  }
  async #refresh(entry: Comparison): Promise<void> {
    const document = this.#options.host.documents.get(entry.documentId);
    if (document === undefined || entry.disposed) return;
    entry.running = true;
    const cancellation = new CancellationSource();
    entry.cancellation = cancellation;
    const snapshot = document.snapshot();
    const text = snapshot.slice(0 as Utf16Offset, snapshot.lengthUtf16 as Utf16Offset);
    try {
      if (!text.ok) return;
      const diff = await this.#options.service.compare(entry.leftText, text.value, cancellation.token);
      if (entry.disposed || document.snapshot().version !== snapshot.version) return;
      const { unified, split } = await this.#options.service.align(diff.lines);
      if (entry.disposed || document.snapshot().version !== snapshot.version) return;
      entry.model = { ...entry.model, ...diff, unified, split, right: snapshot, rightLabel: document.isDirty ? 'BUFFER (unsaved)' : 'WORKTREE', generation: entry.model.generation + 1 };
      this.#emit();
    } finally {
      cancellation.dispose();
      entry.cancellation = undefined;
      entry.running = false;
      if (!entry.disposed && document.snapshot().version !== snapshot.version) this.#schedule(entry);
    }
  }
  #jump(entry: Comparison, index: number): void {
    const hunk = entry.model.hunks[index];
    if (hunk === undefined) return;
    const end = entry.model.hunks[index + 1]?.firstLineIndex ?? entry.model.lines.length;
    let changedIndex = hunk.firstLineIndex;
    while (changedIndex < end && entry.model.lines[changedIndex]?.kind === 'context') changedIndex += 1;
    let line = Math.max(1, entry.model.right.lineCount);
    for (let row = changedIndex; row < entry.model.lines.length; row += 1) {
      const candidate = entry.model.lines[row]?.newLine;
      if (candidate !== undefined) { line = candidate; break; }
    }
    this.#options.host.sessions.get(entry.model.viewId)?.setCursorPosition(Math.max(0, line - 1), 0);
    entry.model = { ...entry.model, selectedHunk: index, scrollTop: Math.max(0, line - 3), generation: entry.model.generation + 1 };
    this.#options.marker('XI_GIT_DIFF_HUNK', { selectedHunk: index });
  }
  handleKeypress(event: OwnedVimKeyEvent): boolean {
    const model = this.readComparison();
    if (model === undefined) return false;
    const entry = this.#entries.get(model.viewId)!;
    const session = this.#options.host.activeSession();
    const mode = this.#options.workbench.readView(model.viewId)?.session.mode;
    if (mode !== 'normal' || session?.commandLineActive) return !model.editable;
    if (this.#pendingBracket !== undefined) {
      const bracket = this.#pendingBracket;
      this.#pendingBracket = undefined;
      if (event.raw === 'c') { this.#jump(entry, Math.max(0, Math.min(model.hunks.length - 1, model.selectedHunk + (bracket === ']' ? 1 : -1)))); this.#emit(); return true; }
      void session?.handleKey({ ...event, name: bracket, raw: bracket });
      return false;
    }
    if ((event.raw === '[' || event.raw === ']') && session?.prefixHelp.pendingKeys.length === 0) { this.#pendingBracket = event.raw; return true; }
    if (event.name === 'escape') { this.close(); return true; }
    if (!model.editable) {
      if (event.raw === 'q') { this.close(); return true; }
      if (event.raw === 'j' || event.name === 'down') this.onPointer(1);
      if (event.raw === 'k' || event.name === 'up') this.onPointer(-1);
      return true;
    }
    return false;
  }
  onPointer(delta: number): void {
    const model = this.readComparison();
    if (model === undefined) return;
    const entry = this.#entries.get(model.viewId)!;
    entry.model = { ...model, scrollTop: Math.max(0, Math.min(Math.max(model.left.lineCount, model.right.lineCount) - 1, model.scrollTop + delta)), generation: model.generation + 1 };
    this.#emit();
  }
  close(): void {
    this.#load?.dispose();
    const id = this.#options.workbench.activeViewId;
    const entry = id === undefined ? undefined : this.#entries.get(id);
    if (entry === undefined) return;
    const closed = this.#options.host.closeView(entry.model.viewId);
    if (!closed.ok) { this.#options.onError(closed.error.kind === 'dirty-buffer' ? 'buffer has unsaved changes (use :q! to discard)' : closed.error.kind); return; }
    this.#options.marker('XI_GIT_DIFF_CLOSED', {});
    this.#emit();
  }
  #release(entry: Comparison): void {
    entry.disposed = true;
    entry.cancellation?.dispose();
    entry.subscription.dispose();
    if (entry.pending !== undefined) clearTimeout(entry.pending);
    this.#options.closeSyntax(entry.model.left.id);
    if (!entry.model.editable) this.#options.closeSyntax(entry.model.right.id);
  }
  dispose(): void { this.#viewClosedSubscription.dispose(); this.#load?.dispose(); for (const entry of this.#entries.values()) this.#release(entry); this.#entries.clear(); this.#listeners.clear(); }
}
