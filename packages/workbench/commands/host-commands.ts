import type { CancellationToken, DocumentId, FileInfo, PlatformFailure, Result, ViewId } from '../../contracts/src/index';
import { CancellationSource } from '../../contracts/src/index';
import type { TextFileDocument } from '../../document/src/entrypoints/launch';
import type { VimHostCommand } from '../../vim/src/index';
import type { BufferHost } from '../host';
import type { WorkbenchSession, WorkbenchWindowDirection } from '../session';

/** Mirrors the location shape `packages/services/navigation`'s `HostNavigationController`
 * resolves to; workbench cannot import `packages/services`, not even types. */
export interface HostNavigationLocation {
  readonly uri: string;
  readonly line: number;
  readonly utf16: number;
}

export type HostNavigationFailure = { readonly kind: string; readonly message: string };

/** Narrow port onto the composition root's (lazily constructed) `HostNavigationController`. */
export interface HostNavigationPort {
  openFile(path: string, line?: number, cancellation?: CancellationToken): Promise<Result<{ readonly location: HostNavigationLocation }, HostNavigationFailure>>;
  openTag(name: string, cancellation?: CancellationToken): Promise<Result<{ readonly location: HostNavigationLocation }, HostNavigationFailure>>;
  back(): HostNavigationLocation | undefined;
}

/** `NodeFilesystemPort`'s subset this module needs -- `resolvePath`/`directoryPath` are
 * platform-specific and not part of `packages/contracts`' generic `FilesystemPort`. */
export interface HostCommandsFilesystemPort {
  stat(path: string, cancellation: CancellationToken): Promise<Result<FileInfo, PlatformFailure>>;
  resolvePath(base: string, relative: string): string;
  directoryPath(path: string): string;
}

export interface HostCommandsWorkspaceEditsPort {
  renameCurrent(newName: string): Promise<unknown>;
  requestCodeActions(): Promise<boolean>;
}

export interface HostCommandsProblemsPort {
  runConfiguredTask(taskId: string): Promise<void>;
  runShellCommand(command: string): Promise<void>;
  listConfiguredTasks(): Promise<void>;
  cancelTask(): Promise<void>;
}

/** Narrow port onto `SaveCoordinator`, the S9 sibling controller owning save/format state. */
export interface HostCommandsSaveCoordinatorPort {
  requestSave(document: TextFileDocument, path: string, viewId: ViewId | undefined): Promise<boolean>;
  formatView(viewId: ViewId): Promise<boolean>;
}

/** Narrow port onto the composition root's directory-draft (T041/T042) opener. The
 * composition root resolves the target path (cwd/active-file-parent default, directory
 * listing, `DirectoryDraft` construction) and opens it as a normal buffer -- this file only
 * ever dispatches the `:Explore` Ex command name to it. */
export interface HostCommandsDirectoryDraftPort {
  open(target: string | undefined, viewId: ViewId): Promise<void>;
}

export interface HostCommandsWorkspaceTrustPort {
  trust(): Promise<boolean>;
  untrust(): Promise<boolean>;
  exclude(): Promise<boolean>;
}

export interface HostCommandsOptions {
  readonly host: BufferHost;
  readonly session: WorkbenchSession;
  readonly filesystem: HostCommandsFilesystemPort;
  readonly marker: (name: string, payload?: unknown) => void;
  /** PTY-visible stderr sink; never writes to `process.stderr` itself. */
  readonly onError: (message: string) => void;
  readonly workspaceRoot: string;
  readonly workspacePathFromUri: (uri: string) => string | undefined;
  /** Lazily constructs (memoized) the services-owned `HostNavigationController`; returns
   * whether one is now available, mirroring `ensureTaskController`'s precedent. */
  readonly ensureHostNavigation: () => Promise<void>;
  readonly readHostNavigation: () => HostNavigationPort | undefined;
  readonly workspaceEdits: HostCommandsWorkspaceEditsPort;
  readonly problems: HostCommandsProblemsPort;
  readonly saveCoordinator: HostCommandsSaveCoordinatorPort;
  readonly directoryDrafts: HostCommandsDirectoryDraftPort;
  readonly workspaceTrust?: HostCommandsWorkspaceTrustPort;
  /** Opens the user config file through the composition-root buffer owner. */
  readonly openConfig?: () => Promise<void>;
  /** `gd`: language-server definition lookup for the active cursor; resolves to the first
   * location, or a user-facing reason when no server/definition is available. */
  readonly lookupDefinition?: () => Promise<{ readonly ok: true; readonly location: HostNavigationLocation } | { readonly ok: false; readonly message: string }>;
  /** `xi references`: language-server reference lookup for the active cursor; resolves to the
   * first workspace location after sending the configured include-declaration context. */
  readonly lookupReferences?: () => Promise<{ readonly ok: true; readonly location: HostNavigationLocation } | { readonly ok: false; readonly message: string }>;
  /** `Ctrl-W h`/`Ctrl-W w` past the leftmost pane: hand focus to the sidebar panel; returns
   * whether a sidebar took it. */
  readonly focusSidebar?: () => boolean;
  /** Complete a window command that starts in the sidebar. The sidebar is a peer in the
   * focus graph, so only directions with an editor neighbour should consume it. */
  readonly focusEditorFromSidebar?: (direction: WorkbenchWindowDirection) => boolean;
}

/**
 * Owns the Ex/host/window command handling that used to live as closure state inside
 * `apps/xi/src/main.ts`'s `main()`: native `gf`/`gd`/tag-jump host commands, window
 * commands (`Ctrl-W` family), the `:e`/`:w`-style Ex dispatch (`handleWorkbenchCommand`)
 * and `format`. Feature controllers it delegates to (workspace-edits, problems, the
 * save coordinator) are injected as narrow ports; `host`/`session` are workbench's own
 * sibling types, used directly.
 */
export class WorkbenchHostCommands {
  readonly #options: HostCommandsOptions;

  constructor(options: HostCommandsOptions) {
    this.#options = options;
  }

  /** No persistent timers/subscriptions are held (every `CancellationSource` above is scoped
   * to, and disposed within, its own method call) -- present so the composition root's
   * teardown can dispose every controller uniformly without special-casing this one. */
  dispose(): void {}

  async formatCurrentDocument(viewId: ViewId): Promise<boolean> {
    return this.#options.saveCoordinator.formatView(viewId);
  }

  async handleVimHostCommand(command: VimHostCommand, sourceViewId: ViewId): Promise<void> {
    const { session, onError, marker } = this.#options;
    let navigation = this.#options.readHostNavigation();
    if (navigation === undefined) {
      await this.#options.ensureHostNavigation();
      navigation = this.#options.readHostNavigation();
      if (navigation === undefined) return;
    }
    if (command.kind === 'open-file') {
      const source = session.views().find((candidate) => candidate.viewId === sourceViewId);
      const sourcePath = source === undefined ? undefined : session.buffer(source.bufferId)?.path;
      const existingPath = await this.resolveHostFilePath(command.target, sourcePath);
      const targetPath = existingPath ?? (command.allowMissing && command.target.length > 0 && !command.target.includes('\0')
        ? this.#options.filesystem.resolvePath(sourcePath === undefined ? this.#options.workspaceRoot : this.#options.filesystem.directoryPath(sourcePath), command.target)
        : undefined);
      if (targetPath === undefined) {
        onError(`xi: file target not found: ${command.target}\n`);
        return;
      }
      if (existingPath === undefined) {
        await this.#options.host.openBufferAtPath(targetPath, { ...(command.split ? { split: sourceViewId } : {}) });
        this.#options.host.notifySurfaceChange();
        return;
      }
      const fileCancellation = new CancellationSource();
      let opened: Awaited<ReturnType<HostNavigationPort['openFile']>>;
      try {
        opened = await navigation.openFile(targetPath, command.line, fileCancellation.token);
      } finally {
        fileCancellation.dispose();
      }
      if (!opened.ok) {
        onError(`xi: file navigation ${opened.error.kind}: ${opened.error.message}\n`);
        return;
      }
      await this.openHostLocation(opened.value.location, command.split, sourceViewId);
      return;
    }
    if (command.kind === 'open-tag') {
      const tagCancellation = new CancellationSource();
      let opened: Awaited<ReturnType<HostNavigationPort['openTag']>>;
      try {
        opened = await navigation.openTag(command.name, tagCancellation.token);
      } finally {
        tagCancellation.dispose();
      }
      if (!opened.ok) {
        onError(`xi: tag navigation ${opened.error.kind}: ${opened.error.message}\n`);
        return;
      }
      marker('XI_NATIVE_TAG', { uri: opened.value.location.uri, line: opened.value.location.line });
      await this.openHostLocation(opened.value.location, command.split, sourceViewId);
      return;
    }
    if (command.kind === 'include') {
      if (command.list) {
        onError(`xi: include search list is unavailable without an include provider\n`);
        return;
      }
      const source = session.views().find((candidate) => candidate.viewId === sourceViewId);
      const sourcePath = source === undefined ? undefined : session.buffer(source.bufferId)?.path;
      const targetPath = await this.resolveHostFilePath(command.target, sourcePath);
      if (targetPath === undefined) {
        onError(`xi: include target not found: ${command.target}\n`);
        return;
      }
      const includeCancellation = new CancellationSource();
      let opened: Awaited<ReturnType<HostNavigationPort['openFile']>>;
      try {
        opened = await navigation.openFile(targetPath, undefined, includeCancellation.token);
      } finally {
        includeCancellation.dispose();
      }
      if (!opened.ok) {
        onError(`xi: include navigation ${opened.error.kind}: ${opened.error.message}\n`);
        return;
      }
      await this.openHostLocation(opened.value.location, false, sourceViewId);
      return;
    }
    if (command.kind === 'lookup') {
      if (command.lookup === 'definition' && this.#options.lookupDefinition !== undefined) {
        const found = await this.#options.lookupDefinition();
        if (found.ok) await this.openHostLocation(found.location, false, sourceViewId);
        else this.#options.marker('XI_DEFINITION_UNAVAILABLE', { message: found.message });
        return;
      }
      const detail = command.lookup === 'definition' ? 'definition provider' : command.lookup === 'keyword' ? 'keyword provider' : 'command output history';
      onError(`xi: native lookup unavailable: ${detail}\n`);
      return;
    }
    if (command.kind === 'tag-back') {
      const location = navigation.back();
      if (location !== undefined) await this.openHostLocation(location, false, sourceViewId);
      return;
    }
    await this.handleVimWindowCommand(command.action, command.count, sourceViewId);
  }

  async resolveHostFilePath(target: string, sourcePath: string | undefined): Promise<string | undefined> {
    const { filesystem, workspaceRoot } = this.#options;
    if (target.length === 0 || target.includes('\0')) return undefined;
    const normalized = target.replaceAll('\\', '/');
    const candidates = new Set<string>();
    if (normalized.startsWith('/')) candidates.add(filesystem.resolvePath('/', normalized));
    else {
      const base = sourcePath !== undefined && sourcePath.startsWith('/') ? filesystem.directoryPath(sourcePath) : workspaceRoot;
      candidates.add(filesystem.resolvePath(base, normalized));
      candidates.add(filesystem.resolvePath(workspaceRoot, normalized));
      candidates.add(filesystem.resolvePath(workspaceRoot, `include/${normalized}`));
      candidates.add(filesystem.resolvePath(workspaceRoot, `includes/${normalized}`));
    }
    const cancellation = new CancellationSource();
    try {
      for (const candidate of candidates) {
        const info = await filesystem.stat(candidate, cancellation.token);
        if (info.ok && (info.value.kind === 'file' || info.value.kind === 'symlink')) return candidate;
      }
      return undefined;
    } finally {
      cancellation.dispose();
    }
  }

  async openHostLocation(location: HostNavigationLocation, split: boolean, sourceViewId: ViewId): Promise<void> {
    const { host, marker, workspacePathFromUri } = this.#options;
    const path = workspacePathFromUri(location.uri);
    if (path === undefined) {
      this.#options.onError(`xi: cannot open non-file host location: ${location.uri}\n`);
      return;
    }
    const opened = await host.openBufferAtPath(path, { ...(split ? { split: sourceViewId } : {}), line: location.line });
    if (opened === undefined) return;
    host.sessions.get(opened.viewId)?.setCursorPosition(location.line, location.utf16);
    host.notifySurfaceChange();
    marker('XI_NATIVE_JUMP', { path, line: location.line, split });
  }

  async handleVimWindowCommand(
    action: Extract<VimHostCommand, { readonly kind: 'window' }>['action'],
    count: number,
    sourceViewId: ViewId,
  ): Promise<void> {
    const { host, session, onError } = this.#options;
    const repeats = Math.max(1, Math.min(100, Number.isSafeInteger(count) ? count : 1));
    const direction = action === 'focus-left' ? 'left' : action === 'focus-right' ? 'right' : action === 'focus-up' ? 'up' : action === 'focus-down' ? 'down' : action === 'focus-next' ? 'next' : action === 'focus-previous' ? 'previous' : action === 'focus-first' ? 'first' : action === 'focus-last' ? 'last' : undefined;
    if (direction !== undefined) {
      if (this.#options.focusEditorFromSidebar?.(direction) === true) return;
      let current = sourceViewId;
      for (let index = 0; index < repeats; index += 1) {
        const moved = session.focusAdjacent(current, direction);
        // `focusAdjacent` reports the same view when nothing lies in that direction: past the
        // leftmost pane (or cycling with `w`/`p` in a single pane) the sidebar is the next window.
        if (!moved.ok || moved.value === current) {
          if ((direction === 'left' || direction === 'next' || direction === 'previous') && this.#options.focusSidebar?.() === true) return;
          break;
        }
        current = moved.value;
      }
      return;
    }
    if (action === 'split-horizontal' || action === 'split-vertical' || action === 'new-window') {
      await this.handleWorkbenchCommand(action === 'split-vertical' ? 'vsplit' : 'split', sourceViewId);
      return;
    }
    if (action === 'close') {
      await this.handleWorkbenchCommand('q!', sourceViewId);
      return;
    }
    if (action === 'only') {
      const closingViews = session.views().filter((view) => view.viewId !== sourceViewId);
      const reduced = session.closeOtherViews(sourceViewId, 'discard');
      if (!reduced.ok) { onError(`xi: ${reduced.error.kind}\n`); return; }
      for (const view of closingViews) {
        host.sessions.get(view.viewId)?.dispose();
        host.sessions.delete(view.viewId);
        if (session.buffer(view.bufferId) === undefined) host.documents.delete(view.bufferId);
      }
      return;
    }
    onError(`xi: native window command unavailable: ${action}\n`);
  }

  handleWorkbenchCommand(source: string, viewId: ViewId): 'handled' | 'unhandled' | 'quit' | Promise<'handled' | 'unhandled' | 'quit'> {
    const { host, session, onError, marker, workspaceEdits, problems, saveCoordinator } = this.#options;
    const normalized = source.trim();
    const command = normalized.toLowerCase();
    const rename = /^xi\s+rename\s+(\S+)$/iu.exec(normalized);
    if (rename?.[1] !== undefined) return workspaceEdits.renameCurrent(rename[1]).then(() => 'handled' as const);
    if (command === 'xi code-action') return workspaceEdits.requestCodeActions().then(() => 'handled' as const);
    if (command === 'xi references') return (async (): Promise<'handled'> => {
      const found = await this.#options.lookupReferences?.();
      if (found?.ok === true) await this.openHostLocation(found.location, false, viewId);
      else if (found !== undefined) this.#options.marker('XI_REFERENCES_UNAVAILABLE', { message: found.message });
      return 'handled';
    })();
    if (command === 'format') return this.formatCurrentDocument(viewId).then(() => 'handled' as const);
    if (command === 'config-open') return (this.#options.openConfig?.() ?? Promise.resolve()).then(() => 'handled' as const);
    if (command === 'workspace-trust' || command === 'workspace-untrust' || command === 'workspace-exclude') {
      const trust = this.#options.workspaceTrust;
      if (trust === undefined) { onError('xi: workspace trust is unavailable\n'); return 'handled'; }
      const changed = command === 'workspace-trust' ? trust.trust() : command === 'workspace-untrust' ? trust.untrust() : trust.exclude();
      return changed.then(ok => { if (!ok) onError(`xi: ${command} failed\n`); return 'handled' as const; });
    }
    const tag = /^(?:tag|tjump|tj)\s+(\S+)$/iu.exec(normalized);
    if (tag?.[1] !== undefined) return this.handleVimHostCommand({ kind: 'open-tag', name: tag[1], split: false }, viewId).then(() => 'handled' as const);
    // `Space O`/`Space o` (docs/architecture.md "Directory as editable text") route through
    // this same Ex dispatch once a leader binding calls `:Explore [path]`.
    const explore = /^(?:explore|expl)(?:\s+(\S.*))?$/iu.exec(normalized);
    if (explore) return this.#options.directoryDrafts.open(explore[1]?.trim(), viewId).then(() => 'handled' as const);
    const task = /^task\s+(\S+)$/iu.exec(normalized);
    if (task?.[1] !== undefined) return problems.runConfiguredTask(task[1]).then(() => 'handled' as const);
    const shell = /^(?:sh|shell|!)\s*(.*)$/isu.exec(normalized);
    if (shell !== null) return problems.runShellCommand(shell[1] ?? '').then(() => 'handled' as const);
    if (command === 'tasks') return problems.listConfiguredTasks().then(() => 'handled' as const);
    if (command === 'taskstop') return problems.cancelTask().then(() => 'handled' as const);
    if (
      command !== 'split' && command !== 'vsplit' && command !== 'q' && command !== 'q!'
      && command !== 'wa' && command !== 'wa!' && command !== 'qa' && command !== 'qa!'
    ) return 'unhandled';
    if (command === 'split' || command === 'vsplit') {
      const split = session.splitView(viewId, command === 'split' ? 'horizontal' : 'vertical');
      if (!split.ok) {
        onError(`xi: ${split.error.kind}\n`);
        return 'handled';
      }
      const splitDocument = host.documents.get(split.value.session.documentId);
      if (splitDocument !== undefined) host.createSession(splitDocument, split.value.viewId, split.value.session.selections);
      marker('XI_WORKBENCH_SPLIT', { viewId: split.value.viewId });
      host.notifySurfaceChange();
      return 'handled';
    }
    if (command === 'wa' || command === 'wa!') {
      return (async (): Promise<'handled'> => {
        const dirtyBuffers = session.buffers().filter((candidate) => candidate.dirty);
        let failures = 0;
        for (const dirtyBuffer of dirtyBuffers) {
          const dirtyDocument = host.documents.get(dirtyBuffer.documentId);
          if (dirtyDocument === undefined || dirtyBuffer.path === undefined) {
            if (dirtyBuffer.path === undefined) onError('xi: no file name\n');
            failures += 1;
            continue;
          }
          const saved = await saveCoordinator.requestSave(dirtyDocument, dirtyBuffer.path, dirtyBuffer.viewIds[0]);
          if (!saved) failures += 1;
        }
        if (failures > 0) onError(`xi: :wa failed to save ${failures} of ${dirtyBuffers.length} buffer(s)\n`);
        marker('XI_WORKBENCH_WRITE_ALL', { saved: dirtyBuffers.length - failures, failed: failures });
        return 'handled';
      })();
    }
    if (command === 'qa' || command === 'qa!') {
      const dirtyBuffers = session.buffers().filter((candidate) => candidate.dirty);
      if (dirtyBuffers.length > 0 && command === 'qa') {
        onError(`xi: ${dirtyBuffers.length} buffer(s) have unsaved changes (use :qa! to discard)\n`);
        return 'handled';
      }
      return 'quit';
    }
    const current = session.views().find((view) => view.viewId === viewId);
    const buffer = current === undefined ? undefined : session.buffer(current.bufferId);
    if (current === undefined) return 'handled';
    if (command === 'q' && buffer?.dirty === true && buffer.viewIds.length === 1) {
      onError('xi: buffer has unsaved changes (use :q! to discard)\n');
      return 'handled';
    }
    const closed = host.closeView(viewId, command === 'q!');
    if (!closed.ok) {
      onError(`xi: ${closed.error.kind}\n`);
      return 'handled';
    }
    marker('XI_WORKBENCH_VIEW_CLOSED', { activeViewId: closed.value.activeViewId });
    host.notifySurfaceChange();
    return closed.value.activeViewId === undefined ? 'quit' : 'handled';
  }
}
