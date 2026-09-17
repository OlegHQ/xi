import { asIdentifier, asUtf16Offset, CancellationSource, type CancellationToken, type Disposable, type DocumentId, type PlatformFailure, type Result, type UndoGroupId } from '../../contracts/src/index';
import type { DocumentEdit, DocumentSnapshot, EditOrigin } from '../../document/src/index';
import type { OwnedVimKeyEvent } from '../vim-session';
import type { BufferHost } from '../host';

export type { OwnedVimKeyEvent as SearchKeyEvent };

/** Mirrors `packages/services/search`'s `SearchQuery` structurally -- workbench cannot import
 * `packages/services`, not even types, so only the fields this controller actually reads or
 * constructs are declared here. */
export interface WorkbenchSearchQuery {
  readonly rootId: string;
  readonly rootPath: string;
  readonly query: string;
  readonly regex?: boolean;
  readonly caseSensitive?: boolean;
  readonly wholeWord?: boolean;
  readonly includeHidden?: boolean;
  readonly maxResults?: number;
}

/** Mirrors `packages/services/search`'s `SearchMatch`, subset actually used here. */
export interface WorkbenchSearchMatch {
  readonly id: string;
  readonly rootId: string;
  readonly path: string;
  readonly line: number;
  readonly endLine?: number;
  readonly range: { readonly startUtf16: number; readonly endUtf16: number };
  readonly source: 'disk' | 'buffer';
  readonly generation: number;
}

/** Mirrors `packages/services/search`'s `SearchReadModel`, subset actually used here. */
export interface WorkbenchSearchModel {
  readonly generation: number;
  readonly query: WorkbenchSearchQuery;
  readonly state: 'idle' | 'loading' | 'ready' | 'empty' | 'stale' | 'error';
  readonly matches: readonly WorkbenchSearchMatch[];
  readonly totalMatches: number;
  readonly message: string | undefined;
}

/** Mirrors `packages/services/search`'s `SearchBufferSource`. */
export interface WorkbenchSearchBufferSource {
  readonly rootId: string;
  readonly path: string;
  readonly version: number;
  readonly text: string;
}

/** Narrow port onto `packages/services/search`'s `RealtimeSearchService`: only the members
 * this controller calls, kept structural so workbench never imports the services package. */
export interface SearchServicePort {
  readonly model: WorkbenchSearchModel;
  subscribe(listener: (model: WorkbenchSearchModel) => void): Disposable;
  query(query: WorkbenchSearchQuery): Promise<unknown>;
  cancel(): void;
}

/** Mirrors `packages/services/search/replace`'s `ReplaceTarget`. */
export interface WorkbenchReplaceTarget {
  readonly path: string;
  readonly rootId: string;
  readonly text: string;
  readonly version?: number;
  readonly diskHash?: string;
  readonly source: 'disk' | 'buffer';
}

/** Mirrors `packages/services/search/replace`'s `ReplacementEdit`. */
export interface WorkbenchReplacementEdit {
  readonly path: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly replacement: string;
  readonly original: string;
}

/** Mirrors `packages/services/search/replace`'s `ReplacePlan`. */
export interface WorkbenchReplacePlan {
  readonly query: WorkbenchSearchQuery;
  readonly replacement: string;
  readonly edits: readonly WorkbenchReplacementEdit[];
  readonly targets: readonly WorkbenchReplaceTarget[];
  readonly generation: number;
}

/** Mirrors `packages/services/search/replace`'s `ReplaceJournalEntry`. */
export interface WorkbenchReplaceJournalEntry {
  readonly path: string;
  readonly source: 'disk' | 'buffer';
  readonly before: string;
  readonly after: string;
  readonly applied: boolean;
  readonly error?: string;
}

/** Mirrors `packages/services/search/replace`'s `ReplaceJournal`. */
export interface WorkbenchReplaceJournal {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly generation: number;
  readonly entries: readonly WorkbenchReplaceJournalEntry[];
  readonly status: 'applied' | 'partial' | 'restored';
}

/** Mirrors `packages/services/search/replace`'s `ReplaceApplyResult`. */
export interface WorkbenchReplaceApplyResult {
  readonly journal: WorkbenchReplaceJournal;
  readonly restored: boolean;
}

/** Mirrors `packages/services/search/replace`'s `ReplaceFailure`. */
export type WorkbenchReplaceFailure = {
  readonly kind: 'invalid-regex' | 'invalid-replacement' | 'stale' | 'conflict' | 'overlap' | 'failed' | 'disposed';
  readonly message: string;
  readonly path?: string;
  readonly journal?: WorkbenchReplaceJournal;
};

/** Mirrors `packages/services/search/replace`'s `ReplaceApplyPort`: implemented by this
 * controller (`createReplacePort`) and passed to the composition root's `WorkspaceReplaceService`. */
export interface WorkbenchReplaceApplyPort {
  apply(plan: WorkbenchReplacePlan): Promise<Result<WorkbenchReplaceApplyResult, WorkbenchReplaceFailure>>;
  readTarget(path: string): Promise<Result<WorkbenchReplaceTarget, WorkbenchReplaceFailure>>;
  restore(journal: WorkbenchReplaceJournal): Promise<Result<void, WorkbenchReplaceFailure>>;
}

/** Narrow port onto `packages/services/search/replace`'s `WorkspaceReplaceService`. */
export interface ReplaceServicePort {
  preview(
    query: WorkbenchSearchQuery,
    replacement: string,
    targets: readonly WorkbenchReplaceTarget[],
    matches: readonly WorkbenchSearchMatch[],
    generation: number,
  ): Result<WorkbenchReplacePlan, WorkbenchReplaceFailure>;
  apply(plan: WorkbenchReplacePlan): Promise<Result<WorkbenchReplaceApplyResult, WorkbenchReplaceFailure>>;
}

/** Function type of `packages/services/search/replace`'s `applyReplacementEdits`. */
export type ApplyReplacementEditsFn = (text: string, edits: readonly WorkbenchReplacementEdit[]) => Result<string, WorkbenchReplaceFailure>;

/** Narrow port onto the workbench session's buffer bookkeeping and the document/edit
 * coordinator: replace targets read a dirty open buffer's live text and, on apply, mutate it
 * through `applyDocumentEdits` -- never straight to disk. */
export interface SearchSessionBuffer {
  readonly bufferId: DocumentId;
  readonly path: string | undefined;
  readonly dirty: boolean;
  readonly documentVersion: number;
}

export interface SearchSessionPort {
  buffers(): readonly SearchSessionBuffer[];
  applyDocumentEdits(
    documentId: DocumentId,
    edits: readonly DocumentEdit[],
    undoGroup: UndoGroupId,
    origin: EditOrigin,
  ): Promise<Result<unknown, { readonly kind: string }>>;
}

/** Narrow port onto the platform filesystem adapter's path resolution and file IO; reading a
 * dirty buffer's text goes through `BufferHost.documents` instead. */
export interface SearchFilesystemPort {
  workspaceRelativePath(root: string, path: string): string | undefined;
  workspaceAbsolutePath(root: string, path: string): string | undefined;
  readFile(path: string, cancellation: CancellationToken): Promise<Result<Uint8Array, PlatformFailure>>;
  writeFileAtomic(path: string, contents: Uint8Array, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
}

export interface SearchControllerOptions {
  readonly host: BufferHost;
  readonly session: SearchSessionPort;
  readonly filesystem: SearchFilesystemPort;
  readonly marker: (name: string, payload?: unknown) => void;
  /** PTY-visible stderr sink; never writes to `process.stderr` itself. */
  readonly onError: (message: string) => void;
  readonly workspaceRoot: string;
  /** Lazily constructs the services-owned `RealtimeSearchService`/`WorkspaceReplaceService`
   * (composition-root work, never duplicated here) and resolves once `attachServices` has run. */
  readonly ensureServices: () => Promise<void>;
}

/**
 * Owns the Search/Replace panel's state and key handling: open/query/flags/selection, the
 * replace-input draft and its apply/restore plumbing. Moved out of `apps/xi/src/main.ts`'s
 * `main()` closure; the search/replace services (`RealtimeSearchService`/
 * `WorkspaceReplaceService`) still live in `packages/services/search` and are only ever reached
 * through `SearchServicePort`/`ReplaceServicePort`, bound once by `attachServices` after the
 * composition root constructs them (they are loaded lazily, on first use of any panel).
 */
export class SearchController {
  #open = false;
  #query = '';
  #regex = false;
  #caseSensitive = false;
  #wholeWord = false;
  #includeHidden = false;
  #selectedIndex = 0;
  #replaceInput = '';
  #replaceInputActive = false;
  #replaceOperationNumber = 0;
  #openGeneration = 0;
  #search: SearchServicePort | undefined;
  #replace: ReplaceServicePort | undefined;
  #applyReplacementEdits: ApplyReplacementEditsFn | undefined;
  #subscription: Disposable | undefined;
  // Search runs once per query keystroke; materializing every dirty buffer's full text on
  // every query would repeat work an unchanged buffer already paid for on the prior keystroke.
  readonly #bufferTextCache = new Map<DocumentId, { readonly version: number; readonly text: string }>();
  readonly #options: SearchControllerOptions;

  constructor(options: SearchControllerOptions) {
    this.#options = options;
  }

  get isOpen(): boolean { return this.#open; }
  get selectedIndex(): number { return this.#selectedIndex; }
  get replaceInputActive(): boolean { return this.#replaceInputActive; }
  get replaceInput(): string { return this.#replaceInput; }

  /** Binds the lazily-constructed search/replace services once the composition root has
   * created them, and starts forwarding search results as `XI_SEARCH_RESULT` markers. */
  attachServices(search: SearchServicePort, replace: ReplaceServicePort, applyReplacementEdits: ApplyReplacementEditsFn): void {
    this.#search = search;
    this.#replace = replace;
    this.#applyReplacementEdits = applyReplacementEdits;
    this.#openGeneration = search.model.generation;
    this.#subscription = search.subscribe((model) => {
      this.#options.host.notifySurfaceChange();
      if (!this.#open || model.generation <= this.#openGeneration) return;
      const first = model.matches[0];
      this.#options.marker('XI_SEARCH_RESULT', {
        generation: model.generation,
        query: model.query.query,
        state: model.state,
        totalMatches: model.totalMatches,
        firstPath: first?.path,
        firstSource: first?.source,
        message: model.message,
      });
    });
  }

  /** Reads current dirty buffers for the search service's `bufferSourceProvider`, outside the
   * keypress handler. */
  readBuffers(): readonly WorkbenchSearchBufferSource[] {
    const sources: WorkbenchSearchBufferSource[] = [];
    for (const buffer of this.#options.session.buffers()) {
      if (!buffer.dirty) continue;
      const documentForBuffer = this.#options.host.documents.get(buffer.bufferId);
      if (documentForBuffer === undefined) continue;
      const cached = this.#bufferTextCache.get(buffer.bufferId);
      let text: string;
      if (cached !== undefined && cached.version === buffer.documentVersion) {
        text = cached.text;
      } else {
        const content = fullDocumentText(documentForBuffer.snapshot());
        if (!content.ok) continue;
        text = content.value;
        this.#bufferTextCache.set(buffer.bufferId, { version: buffer.documentVersion, text });
      }
      const relativePath = buffer.path === undefined ? undefined : this.#options.filesystem.workspaceRelativePath(this.#options.workspaceRoot, buffer.path);
      if (relativePath === undefined) continue;
      sources.push({ rootId: 'workspace', path: relativePath, version: buffer.documentVersion, text });
    }
    return Object.freeze(sources);
  }

  /** Implements `ReplaceApplyPort` for the composition root's `WorkspaceReplaceService`:
   * a dirty open buffer is read/written through the session's document/edit coordinator, and
   * a closed file goes through the filesystem port -- never the other way around. */
  createReplacePort(): WorkbenchReplaceApplyPort {
    return {
      readTarget: async (path) => this.#readReplaceTarget(path),
      apply: async (plan) => {
        const cancellation = new CancellationSource();
        const entries: WorkbenchReplaceJournalEntry[] = [];
        try {
          const applyEdits = this.#applyReplacementEdits;
          if (applyEdits === undefined) return { ok: false, error: { kind: 'failed', message: 'replace service is still loading', path: plan.targets[0]?.path ?? '' } };
          // Revalidate every source before the first mutation, including the
          // disk hash and the open-buffer version captured by the preview.
          for (const target of plan.targets) {
            const current = await this.#readReplaceTarget(target.path);
            if (!current.ok) return { ok: false, error: { kind: 'failed', message: current.error.message, path: target.path } };
            if (current.value.text !== target.text || current.value.source !== target.source || current.value.version !== target.version || current.value.diskHash !== target.diskHash) {
              return { ok: false, error: { kind: 'conflict', message: `replace target changed: ${target.path}`, path: target.path } };
            }
          }
          const byPath = new Map<string, WorkbenchReplacementEdit[]>();
          for (const edit of plan.edits) (byPath.get(edit.path) ?? (byPath.set(edit.path, []), byPath.get(edit.path)!)).push(edit);
          for (const target of plan.targets) {
            const edits = byPath.get(target.path) ?? [];
            const after = applyEdits(target.text, edits);
            if (!after.ok) return { ok: false, error: after.error };
            const buffer = this.#options.session.buffers().find((candidate) => candidate.path !== undefined && this.#options.filesystem.workspaceRelativePath(this.#options.workspaceRoot, candidate.path) === target.path);
            if (target.source === 'buffer' && buffer !== undefined) {
              const documentForBuffer = this.#options.host.documents.get(buffer.bufferId);
              if (documentForBuffer === undefined || target.version === undefined) return { ok: false, error: { kind: 'failed', message: `dirty buffer is unavailable: ${target.path}`, path: target.path } };
              const group = asIdentifier<UndoGroupId>(`xi-replace-${Date.now()}-${this.#replaceOperationNumber += 1}`, 'undoGroupId');
              if (!group.ok) return { ok: false, error: { kind: 'failed', message: group.error.message, path: target.path } };
              const documentEdits: DocumentEdit[] = [];
              for (const edit of edits) {
                const start = asUtf16Offset(edit.startUtf16);
                const end = asUtf16Offset(edit.endUtf16);
                if (!start.ok || !end.ok) return this.#partialReplaceFailure(entries, target, after.value, 'replacement range is invalid');
                documentEdits.push({ start: start.value, end: end.value, text: edit.replacement });
              }
              const committed = await this.#options.session.applyDocumentEdits(documentForBuffer.id, documentEdits, group.value, 'workspace-replace');
              if (!committed.ok) return this.#partialReplaceFailure(entries, target, after.value, committed.error.kind);
            } else {
              const absolute = this.#options.filesystem.workspaceAbsolutePath(this.#options.workspaceRoot, target.path);
              if (absolute === undefined) return this.#partialReplaceFailure(entries, target, after.value, 'path escaped workspace');
              const written = await this.#options.filesystem.writeFileAtomic(absolute, new TextEncoder().encode(after.value), cancellation.token);
              if (!written.ok) return this.#partialReplaceFailure(entries, target, after.value, written.error.message);
            }
            entries.push(Object.freeze({ path: target.path, source: target.source, before: target.text, after: after.value, applied: true }));
          }
          const journal: WorkbenchReplaceJournal = Object.freeze({ schemaVersion: 1, operationId: `xi-replace-${Date.now()}-${this.#replaceOperationNumber += 1}`, generation: plan.generation, entries: Object.freeze(entries), status: 'applied' });
          return { ok: true, value: { journal, restored: false } };
        } finally {
          cancellation.dispose();
        }
      },
      restore: async (journal) => {
        const cancellation = new CancellationSource();
        try {
          for (const entry of [...journal.entries].reverse()) {
            if (!entry.applied) continue;
            const buffer = this.#options.session.buffers().find((candidate) => candidate.path !== undefined && this.#options.filesystem.workspaceRelativePath(this.#options.workspaceRoot, candidate.path) === entry.path);
            if (entry.source === 'buffer' && buffer !== undefined) {
              const documentForBuffer = this.#options.host.documents.get(buffer.bufferId);
              if (documentForBuffer === undefined) return { ok: false, error: { kind: 'failed', message: `cannot restore closed buffer: ${entry.path}`, path: entry.path } };
              const snapshot = documentForBuffer.snapshot();
              const current = fullDocumentText(snapshot);
              if (!current.ok || current.value !== entry.after) return { ok: false, error: { kind: 'conflict', message: `buffer changed after replace: ${entry.path}`, path: entry.path } };
              const group = asIdentifier<UndoGroupId>(`xi-restore-${Date.now()}-${this.#replaceOperationNumber += 1}`, 'undoGroupId');
              if (!group.ok) return { ok: false, error: { kind: 'failed', message: group.error.message, path: entry.path } };
              const start = asUtf16Offset(0);
              const end = asUtf16Offset(snapshot.lengthUtf16);
              if (!start.ok || !end.ok) return { ok: false, error: { kind: 'failed', message: `cannot restore invalid buffer range: ${entry.path}`, path: entry.path } };
              const restored = await this.#options.session.applyDocumentEdits(documentForBuffer.id, [{ start: start.value, end: end.value, text: entry.before }], group.value, 'workspace-replace');
              if (!restored.ok) return { ok: false, error: { kind: 'failed', message: restored.error.kind, path: entry.path } };
              continue;
            }
            const absolute = this.#options.filesystem.workspaceAbsolutePath(this.#options.workspaceRoot, entry.path);
            if (absolute === undefined) return { ok: false, error: { kind: 'failed', message: `restore path escaped workspace: ${entry.path}`, path: entry.path } };
            const current = await this.#readReplaceTarget(entry.path);
            if (!current.ok || current.value.text !== entry.after) return { ok: false, error: { kind: 'conflict', message: `file changed after replace: ${entry.path}`, path: entry.path } };
            const restored = await this.#options.filesystem.writeFileAtomic(absolute, new TextEncoder().encode(entry.before), cancellation.token);
            if (!restored.ok) return { ok: false, error: { kind: 'failed', message: restored.error.message, path: entry.path } };
          }
          return { ok: true, value: undefined };
        } finally {
          cancellation.dispose();
        }
      },
    };
  }

  open(): void {
    this.#options.host.closeAllPanels('search');
    this.#open = true;
    this.#selectedIndex = 0;
    if (this.#search === undefined) {
      void this.#options.ensureServices().then(() => { if (this.#open) this.open(); });
      return;
    }
    this.#openGeneration = this.#search.model.generation;
    this.#options.marker('XI_SEARCH_OPEN', { rootId: 'workspace' });
    this.#runQuery();
  }

  close(): void {
    this.#search?.cancel();
    this.#open = false;
    this.#replaceInputActive = false;
    this.#options.marker('XI_SEARCH_CANCELLED', { generation: this.#search?.model.generation });
  }

  /** Opens the panel (if not already open) and starts a replace-input draft. */
  startReplace(): void {
    if (!this.#open) this.open();
    this.#replaceInputActive = true;
    this.#replaceInput = '';
  }

  async handleKeypress(event: OwnedVimKeyEvent): Promise<boolean> {
    if (this.#search === undefined) {
      await this.#options.ensureServices();
      return true;
    }
    const search = this.#search;
    const key = event.name.toLowerCase();
    if (key === 'escape' || event.raw === '') {
      if (this.#replaceInputActive) { this.#replaceInputActive = false; this.#replaceInput = ''; return true; }
      this.close();
      return true;
    }
    if (this.#replaceInputActive) {
      if (event.ctrl && (key === 'x' || key === 'r')) { this.#replaceInputActive = false; return true; }
      if (key === 'enter' || key === 'return' || event.raw === '\r' || event.raw === '\n') { await this.applyReplacement(false); return true; }
      if (key === 'backspace' || key === 'backspace2' || event.raw === '') { this.#replaceInput = this.#replaceInput.slice(0, -1); return true; }
      if (event.ctrl || event.meta || event.option) return true;
      if (event.raw.length === 1 && event.raw >= ' ' && event.raw !== '') { this.#replaceInput += event.raw; return true; }
      return true;
    }
    if (event.ctrl) {
      if (key === 'r') { this.#regex = !this.#regex; this.#selectedIndex = 0; this.#runQuery(); return true; }
      if (key === 'i') { this.#caseSensitive = !this.#caseSensitive; this.#selectedIndex = 0; this.#runQuery(); return true; }
      if (key === 'w') { this.#wholeWord = !this.#wholeWord; this.#selectedIndex = 0; this.#runQuery(); return true; }
      if (key === 'h') { this.#includeHidden = !this.#includeHidden; this.#selectedIndex = 0; this.#runQuery(); return true; }
      if (key === 'n' || key === 'p') {
        this.#moveSelection(key === 'n' ? 1 : -1);
        return true;
      }
    }
    if (key === 'down' || key === 'j') { this.#moveSelection(1); return true; }
    if (key === 'up' || key === 'k') { this.#moveSelection(-1); return true; }
    if (key === 'enter' || key === 'return' || event.raw === '\r' || event.raw === '\n') {
      const match = search.model.matches[this.#selectedIndex];
      if (match !== undefined) await this.openMatch(match);
      return true;
    }
    if (key === 'backspace' || key === 'backspace2' || event.raw === '') {
      this.#query = this.#query.slice(0, -1);
      this.#selectedIndex = 0;
      this.#runQuery();
      return true;
    }
    if (event.ctrl || event.meta || event.option) return true;
    if (event.raw.length === 1 && event.raw >= ' ' && event.raw !== '') {
      this.#query += event.raw;
      this.#selectedIndex = 0;
      this.#runQuery();
    }
    return true;
  }

  /** Direct pointer-driven selection, mirroring `handleKeypress`'s up/down clamp bypassed --
   * the caller has already validated `index` against the current model's generation. */
  setSelectedIndex(index: number): void {
    this.#selectedIndex = index;
  }

  async openMatch(match: WorkbenchSearchMatch): Promise<void> {
    if (match.path.startsWith('base64:')) return;
    const relativePath = this.#options.filesystem.workspaceRelativePath(this.#options.workspaceRoot, match.path);
    if (relativePath === undefined) return;
    const absolutePath = this.#options.filesystem.workspaceAbsolutePath(this.#options.workspaceRoot, relativePath);
    if (absolutePath === undefined) return;
    const opened = await this.#options.host.openBufferAtPath(absolutePath);
    if (opened === undefined) return;
    this.close();
    this.#options.marker('XI_SEARCH_OPENED', { path: relativePath, source: match.source });
  }

  async applyReplacement(selectedOnly: boolean): Promise<void> {
    if (this.#search === undefined || this.#replace === undefined) {
      await this.#options.ensureServices();
      if (this.#search === undefined || this.#replace === undefined) return;
    }
    const service = this.#search;
    const replacement = this.#replace;
    const model = service.model;
    if (model.state !== 'ready' || model.matches.length === 0 || this.#replaceInput.length === 0) {
      this.#options.onError('xi: replace requires a ready search result and a non-empty replacement\n');
      return;
    }
    const matches = selectedOnly ? [model.matches[this.#selectedIndex]].filter((match): match is WorkbenchSearchMatch => match !== undefined) : model.matches;
    const paths = [...new Set(matches.map((match) => `${match.rootId}\0${match.path}`))];
    const targets: WorkbenchReplaceTarget[] = [];
    for (const key of paths) {
      const separator = key.indexOf('\0');
      const path = key.slice(separator + 1);
      const target = await this.#readReplaceTarget(path);
      if (!target.ok) { this.#options.onError(`xi: replace preview failed for ${path}: ${target.error.message}\n`); return; }
      targets.push(target.value);
    }
    const plan = replacement.preview(model.query, this.#replaceInput, targets, matches, model.generation);
    if (!plan.ok) { this.#options.onError(`xi: replace preview failed: ${plan.error.message}\n`); return; }
    const applied = await replacement.apply(plan.value);
    if (!applied.ok) {
      this.#options.onError(`xi: replace failed${applied.error.path === undefined ? '' : ` at ${applied.error.path}`}: ${applied.error.message}\n`);
      return;
    }
    const journal = applied.value.journal;
    this.#options.onError(`xi: replaced ${String(journal.entries.filter((entry) => entry.applied).length)} file(s)\n`);
    this.#options.marker('XI_REPLACE_APPLIED', { operationId: journal.operationId, files: journal.entries.filter((entry) => entry.applied).length, edits: plan.value.edits.length });
    this.#replaceInputActive = false;
    this.#runQuery();
  }

  dispose(): void {
    this.#subscription?.dispose();
    this.#subscription = undefined;
    this.#bufferTextCache.clear();
  }

  #moveSelection(delta: number): void {
    const count = this.#search?.model.matches.length ?? 0;
    if (count === 0) { this.#selectedIndex = 0; return; }
    this.#selectedIndex = Math.max(0, Math.min(count - 1, this.#selectedIndex + delta));
  }

  #runQuery(): void {
    const service = this.#search;
    if (service === undefined) {
      void this.#options.ensureServices().then(() => { if (this.#open) this.#runQuery(); });
      return;
    }
    void service.query({
      rootId: 'workspace',
      rootPath: this.#options.workspaceRoot,
      query: this.#query,
      regex: this.#regex,
      caseSensitive: this.#caseSensitive,
      wholeWord: this.#wholeWord,
      includeHidden: this.#includeHidden,
      maxResults: 10_000,
    });
  }

  async #readReplaceTarget(path: string): Promise<Result<WorkbenchReplaceTarget, { readonly kind: 'failed'; readonly message: string }>> {
    const buffer = this.#options.session.buffers().find((candidate) => candidate.path !== undefined && this.#options.filesystem.workspaceRelativePath(this.#options.workspaceRoot, candidate.path) === path);
    if (buffer?.dirty === true) {
      const documentForBuffer = this.#options.host.documents.get(buffer.bufferId);
      if (documentForBuffer === undefined) return { ok: false, error: { kind: 'failed', message: 'dirty buffer is no longer open' } };
      const snapshot = documentForBuffer.snapshot();
      const text = fullDocumentText(snapshot);
      if (!text.ok) return { ok: false, error: { kind: 'failed', message: `cannot read dirty buffer: ${text.error.kind}` } };
      return { ok: true, value: { path, rootId: 'workspace', text: text.value, source: 'buffer', version: buffer.documentVersion } };
    }
    const absolute = this.#options.filesystem.workspaceAbsolutePath(this.#options.workspaceRoot, path);
    if (absolute === undefined) return { ok: false, error: { kind: 'failed', message: 'replace path escapes workspace' } };
    const cancellation = new CancellationSource();
    try {
      const read = await this.#options.filesystem.readFile(absolute, cancellation.token);
      if (!read.ok) return { ok: false, error: { kind: 'failed', message: read.error.message } };
      try {
        return { ok: true, value: { path, rootId: 'workspace', text: new TextDecoder('utf-8', { fatal: true }).decode(read.value), source: 'disk', diskHash: textHash(read.value) } };
      } catch {
        return { ok: false, error: { kind: 'failed', message: `replace target is not valid UTF-8 (${String(read.value.byteLength)} bytes)` } };
      }
    } finally {
      cancellation.dispose();
    }
  }

  #partialReplaceFailure(entries: readonly WorkbenchReplaceJournalEntry[], target: WorkbenchReplaceTarget, after: string, message: string): { ok: false; error: WorkbenchReplaceFailure } {
    const journal: WorkbenchReplaceJournal = Object.freeze({
      schemaVersion: 1,
      operationId: `xi-replace-${Date.now()}-${this.#replaceOperationNumber += 1}`,
      generation: 0,
      entries: Object.freeze([...entries, Object.freeze({ path: target.path, source: target.source, before: target.text, after, applied: false, error: message })]),
      status: 'partial',
    });
    return { ok: false, error: { kind: 'failed', message: `partial replacement: ${message}`, path: target.path, journal } };
  }
}

function fullDocumentText(snapshot: DocumentSnapshot): Result<string, { readonly kind: string }> {
  const start = asUtf16Offset(0);
  const end = asUtf16Offset(snapshot.lengthUtf16);
  if (!start.ok || !end.ok) return { ok: false, error: { kind: 'invalid-range' } };
  const content = snapshot.slice(start.value, end.value);
  return content.ok ? content : { ok: false, error: { kind: content.error.kind } };
}

// Content identity only needs a stable, collision-resistant digest for
// equality checks. Bun's native CryptoHasher is hardware-accelerated, unlike
// the previous per-byte BigInt FNV loop.
function textHash(bytes: Uint8Array): string {
  return Bun.CryptoHasher.hash('sha256', bytes, 'hex');
}
