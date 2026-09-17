/** Workspace-edit resource semantics: filesystem create/rename/delete planning and execution,
 * and dispatch of a workspace edit's text changes to either an open buffer (workbench-owned) or
 * an unopened file (loader/writer-owned). Extends ./workspace-edits with the parts of the LSP
 * workspace-edit contract that touch the filesystem instead of an already-open document.
 *
 * No OpenTUI, no workbench, no direct filesystem/process access: every effect goes through the
 * typed ports supplied by the caller (the composition root). */
import type { CancellationToken, FileInfo, PlatformFailure, Result } from '../../contracts/src/index';
import { CancellationSource } from '../../contracts/src/index';
import type {
  WorkspaceEditDocument,
  WorkspaceEditFailure,
  WorkspaceEditPort,
  WorkspaceEditProposal,
  WorkspaceEditProviderFailure,
  WorkspaceEditRequest,
  WorkspaceEditTarget,
  WorkspaceFileOperationKind,
  WorkspaceResourceOperation,
  WorkspaceTextEdit,
} from './workspace-edits';
import { WorkspaceEditCoordinator } from './workspace-edits';

/** Decodes a `file://` URI into an absolute filesystem path. Rejects anything that is not an
 * absolute triple-slash file URI or that decodes to a path containing a NUL byte. */
export function workspacePathFromUri(uri: string): string | undefined {
  if (!uri.startsWith('file:///')) return undefined;
  try {
    const path = decodeURIComponent(uri.slice('file://'.length));
    return path.startsWith('/') && !path.includes('\0') ? path : undefined;
  } catch {
    return undefined;
  }
}

/** Encodes an absolute filesystem path as a `file://` URI, percent-encoding each path segment. */
export function fileUri(path: string): string {
  return `file://${path.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

/** Filesystem operations workspace-edit resources need beyond the contracts `FilesystemPort`:
 * atomic rename/remove and root-relative path translation. */
export interface WorkspaceResourceFilesystemPort {
  stat(path: string, cancellation: CancellationToken): Promise<Result<FileInfo, PlatformFailure>>;
  writeFileAtomic(path: string, contents: Uint8Array, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
  renamePath(from: string, to: string, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
  removePath(path: string, recursive: boolean, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
  workspaceRelativePath(root: string, path: string): string | undefined;
  workspaceAbsolutePath(root: string, relativePath: string): string | undefined;
}

export type WorkspacePathState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'present'; readonly info: FileInfo }
  | { readonly kind: 'error'; readonly message: string };

export interface WorkspaceResourcePlanItem {
  readonly resource: WorkspaceResourceOperation;
  readonly sourcePath: string;
  readonly sourceState: WorkspacePathState;
  readonly destinationPath?: string;
  readonly destinationState?: WorkspacePathState;
  readonly skip: boolean;
}

export interface WorkspaceResourcePlanOptions {
  readonly workspaceRoot: string;
  readonly filesystem: WorkspaceResourceFilesystemPort;
}

function failure(kind: WorkspaceEditFailure['kind'], message: string, uri?: string): Result<never, WorkspaceEditFailure> {
  return { ok: false, error: { kind, message, ...(uri === undefined ? {} : { uri }) } };
}

/** Resolves a `file://` URI to a workspace-relative path, or `undefined` when it is outside the
 * workspace root or otherwise unrepresentable. */
export function workspaceRelativePathFromUri(filesystem: WorkspaceResourceFilesystemPort, workspaceRoot: string, uri: string): string | undefined {
  const absolute = workspacePathFromUri(uri);
  return absolute === undefined ? undefined : filesystem.workspaceRelativePath(workspaceRoot, absolute);
}

async function statWorkspacePath(filesystem: WorkspaceResourceFilesystemPort, path: string): Promise<WorkspacePathState> {
  const cancellation = new CancellationSource();
  try {
    const result = await filesystem.stat(path, cancellation.token);
    if (result.ok) return { kind: 'present', info: result.value };
    return result.error.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'error', message: result.error.message };
  } finally {
    cancellation.dispose();
  }
}

/** Plans create/rename/delete resource operations: rejects duplicated sources, invalid or
 * colliding destinations, and applies overwrite/ignoreIfExists/ignoreIfNotExists precedence
 * exactly as a single coherent (but not all-or-nothing) LSP workspace edit requires. Performs no
 * mutation; `applyWorkspaceResources` executes an accepted plan. */
export async function planWorkspaceResources(
  resources: readonly WorkspaceResourceOperation[],
  options: WorkspaceResourcePlanOptions,
): Promise<Result<readonly WorkspaceResourcePlanItem[], WorkspaceEditFailure>> {
  const { workspaceRoot, filesystem } = options;
  const sourceUris = new Set<string>();
  const renameSources = new Set<string>();
  const resolved: Array<{ readonly resource: WorkspaceResourceOperation; readonly sourcePath: string; readonly sourceState: WorkspacePathState; readonly destinationPath?: string; readonly destinationState?: WorkspacePathState }> = [];
  const states = new Map<string, Promise<WorkspacePathState>>();
  const stateFor = (path: string): Promise<WorkspacePathState> => {
    const existing = states.get(path);
    if (existing !== undefined) return existing;
    const pending = statWorkspacePath(filesystem, path);
    states.set(path, pending);
    return pending;
  };
  for (const resource of resources) {
    if (sourceUris.has(resource.uri)) return failure('collision', `workspace resource source is duplicated: ${resource.uri}`, resource.uri);
    sourceUris.add(resource.uri);
    const source = workspaceRelativePathFromUri(filesystem, workspaceRoot, resource.uri);
    if (source === undefined) return failure('stale', `workspace resource is outside the workspace: ${resource.uri}`, resource.uri);
    const sourcePath = filesystem.workspaceAbsolutePath(workspaceRoot, source);
    if (sourcePath === undefined) return failure('stale', `workspace resource path is invalid: ${source}`, resource.uri);
    const sourceState = await stateFor(sourcePath);
    if (sourceState.kind === 'error') return failure('stale', `cannot inspect workspace resource ${source}: ${sourceState.message}`, resource.uri);
    if (resource.kind === 'rename') {
      const destination = workspaceRelativePathFromUri(filesystem, workspaceRoot, resource.newUri ?? '');
      if (destination === undefined) return failure('stale', `workspace rename destination is outside the workspace: ${resource.newUri ?? ''}`, resource.uri);
      const destinationPath = filesystem.workspaceAbsolutePath(workspaceRoot, destination);
      if (destinationPath === undefined || destinationPath === sourcePath) return failure('collision', `workspace rename destination is invalid: ${destination}`, resource.uri);
      renameSources.add(sourcePath);
      resolved.push({ resource, sourcePath, sourceState, destinationPath, destinationState: await stateFor(destinationPath) });
    } else {
      resolved.push({ resource, sourcePath, sourceState });
    }
  }
  const destinations = new Set<string>();
  const plan: WorkspaceResourcePlanItem[] = [];
  for (const item of resolved) {
    const { resource, sourcePath, sourceState, destinationPath, destinationState } = item;
    if (resource.kind === 'create') {
      if (sourceState.kind === 'error') return failure('stale', `cannot inspect workspace create target: ${sourceState.message}`, resource.uri);
      const skip = sourceState.kind === 'present' && resource.options?.ignoreIfExists === true;
      if (sourceState.kind === 'present' && !skip) return failure('collision', `workspace create target exists: ${resource.uri}`, resource.uri);
      plan.push({ ...item, skip });
      continue;
    }
    if (sourceState.kind === 'missing') {
      if (resource.kind === 'delete' && resource.options?.ignoreIfNotExists === true) { plan.push({ ...item, skip: true }); continue; }
      return failure('stale', `workspace resource is missing: ${resource.uri}`, resource.uri);
    }
    if (resource.kind === 'delete') {
      if (sourceState.kind !== 'present') return failure('stale', `cannot inspect workspace delete target: ${sourceState.message}`, resource.uri);
      if (sourceState.info.kind === 'directory' && resource.options?.recursive !== true) return failure('apply', `workspace directory delete requires recursive=true: ${resource.uri}`, resource.uri);
      plan.push({ ...item, skip: false });
      continue;
    }
    if (destinationPath === undefined || destinationState === undefined) return failure('collision', `workspace rename destination is invalid: ${resource.newUri ?? ''}`, resource.uri);
    if (destinationState.kind === 'error') return failure('stale', `cannot inspect workspace rename destination: ${destinationState.message}`, resource.uri);
    if (destinations.has(destinationPath)) return failure('collision', `workspace rename destination collides: ${resource.newUri ?? ''}`, resource.uri);
    destinations.add(destinationPath);
    if (destinationState.kind === 'present' && !renameSources.has(destinationPath) && resource.options?.overwrite !== true) return failure('collision', `workspace rename destination exists: ${resource.newUri ?? ''}`, resource.uri);
    plan.push({ ...item, skip: false });
  }
  return { ok: true, value: Object.freeze(plan) };
}

export interface WorkspaceResourceApplyOptions extends WorkspaceResourcePlanOptions {
  /** Notified after a source path is moved (including through an intermediate temporary path)
   * so the caller can keep an open buffer's recorded path in sync. */
  readonly onResourcePathRenamed?: (sourcePath: string, destinationPath: string) => void | Promise<void>;
  /** Prefix for temporary paths used to break rename cycles (default `.xi-workspace-edit`). */
  readonly temporaryPathPrefix?: string;
}

async function renameWorkspacePath(filesystem: WorkspaceResourceFilesystemPort, sourcePath: string, destinationPath: string, uri: string): Promise<Result<void, WorkspaceEditFailure>> {
  const cancellation = new CancellationSource();
  try {
    const result = await filesystem.renamePath(sourcePath, destinationPath, cancellation.token);
    return result.ok ? { ok: true, value: undefined } : failure('apply', result.error.message, uri);
  } finally {
    cancellation.dispose();
  }
}

let temporaryPathSerial = 0;
async function workspaceRenameTemporaryPath(filesystem: WorkspaceResourceFilesystemPort, workspaceRoot: string, occupied: ReadonlySet<string>, prefix: string): Promise<string> {
  while (true) {
    temporaryPathSerial += 1;
    const relative = `${prefix}-${Date.now().toString(36)}-${temporaryPathSerial}`;
    const path = filesystem.workspaceAbsolutePath(workspaceRoot, relative);
    if (path !== undefined && !occupied.has(path) && (await statWorkspacePath(filesystem, path)).kind === 'missing') return path;
  }
}

/** Executes an accepted plan from `planWorkspaceResources`. Renames are performed in dependency
 * order, breaking cycles (e.g. a->b, b->a) through an intermediate temporary path; each rename is
 * reported through `onResourcePathRenamed` as it lands. Reports the first failure encountered;
 * prior effects are not rolled back, matching the source LSP workspace edit's own guarantee that
 * resource application is per-file, not all-or-nothing. */
export async function applyWorkspaceResources(plan: readonly WorkspaceResourcePlanItem[], options: WorkspaceResourceApplyOptions): Promise<Result<void, WorkspaceEditFailure>> {
  const { workspaceRoot, filesystem, onResourcePathRenamed, temporaryPathPrefix = '.xi-workspace-edit' } = options;
  const renamePlan = plan.filter((item) => item.resource.kind === 'rename' && !item.skip);
  const occupied = new Set<string>();
  const pending = new Map<string, WorkspaceResourcePlanItem>();
  for (const item of renamePlan) {
    occupied.add(item.sourcePath);
    if (item.destinationState?.kind === 'present') occupied.add(item.destinationPath as string);
    pending.set(item.sourcePath, item);
  }
  while (pending.size > 0) {
    let progressed = false;
    for (const [sourcePath, item] of pending) {
      const destinationPath = item.destinationPath as string;
      if (occupied.has(destinationPath)) continue;
      const moved = await renameWorkspacePath(filesystem, sourcePath, destinationPath, item.resource.uri);
      if (!moved.ok) return moved;
      occupied.delete(sourcePath);
      occupied.add(destinationPath);
      pending.delete(sourcePath);
      await onResourcePathRenamed?.(sourcePath, destinationPath);
      progressed = true;
      break;
    }
    if (progressed) continue;
    const first = pending.entries().next().value as [string, WorkspaceResourcePlanItem] | undefined;
    if (first === undefined) break;
    const [sourcePath, item] = first;
    const temporary = await workspaceRenameTemporaryPath(filesystem, workspaceRoot, occupied, temporaryPathPrefix);
    const moved = await renameWorkspacePath(filesystem, sourcePath, temporary, item.resource.uri);
    if (!moved.ok) return moved;
    occupied.delete(sourcePath);
    occupied.add(temporary);
    pending.delete(sourcePath);
    pending.set(temporary, { ...item, sourcePath });
    await onResourcePathRenamed?.(sourcePath, temporary);
  }
  for (const item of plan) {
    if (item.skip || item.resource.kind === 'rename') continue;
    const cancellation = new CancellationSource();
    try {
      const result = item.resource.kind === 'create'
        ? await filesystem.writeFileAtomic(item.sourcePath, new Uint8Array(), cancellation.token)
        : await filesystem.removePath(item.sourcePath, item.resource.options?.recursive === true, cancellation.token);
      if (!result.ok) return failure('apply', result.error.message, item.resource.uri);
    } finally {
      cancellation.dispose();
    }
  }
  return { ok: true, value: undefined };
}

/** A workspace-edit document that can also apply validated text edits to itself: an open buffer
 * (applied through the workbench, which keeps ownership of open-buffer mutation) or an unopened
 * file (loaded, committed and written back atomically by the port implementation). */
export interface WorkspaceEditableDocument extends WorkspaceEditDocument {
  apply(edits: readonly WorkspaceTextEdit[]): Promise<Result<void, WorkspaceEditFailure>>;
}

export interface WorkspaceEditResourceExecutorOptions extends WorkspaceResourcePlanOptions {
  /** Returns the editable handle for an already-open buffer, or `undefined` if `uri` is not open. */
  readonly openDocument: (uri: string) => WorkspaceEditableDocument | undefined;
  /** Loads (and can later persist edits to) an unopened file, or `undefined` if it is unavailable. */
  readonly loadUnopenedFile: (uri: string) => Promise<WorkspaceEditableDocument | undefined>;
  readonly onResourcePathRenamed?: (sourcePath: string, destinationPath: string) => void | Promise<void>;
  readonly temporaryPathPrefix?: string;
}

/** Implements `WorkspaceEditPort` (see ./workspace-edits) over typed filesystem/document ports:
 * plans and applies resource operations, and dispatches each URI's text edits to whichever of the
 * open-buffer or unopened-file ports currently owns that document. Preserves the source
 * composition root's semantics: per-URI failure reporting, no all-or-nothing rollback. */
export class WorkspaceEditResourceExecutor {
  readonly #workspaceRoot: string;
  readonly #filesystem: WorkspaceResourceFilesystemPort;
  readonly #openDocument: (uri: string) => WorkspaceEditableDocument | undefined;
  readonly #loadUnopenedFile: (uri: string) => Promise<WorkspaceEditableDocument | undefined>;
  readonly #onResourcePathRenamed: ((sourcePath: string, destinationPath: string) => void | Promise<void>) | undefined;
  readonly #temporaryPathPrefix: string | undefined;

  constructor(options: WorkspaceEditResourceExecutorOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#filesystem = options.filesystem;
    this.#openDocument = options.openDocument;
    this.#loadUnopenedFile = options.loadUnopenedFile;
    this.#onResourcePathRenamed = options.onResourcePathRenamed;
    this.#temporaryPathPrefix = options.temporaryPathPrefix;
  }

  /** Adapts this executor to the `WorkspaceEditPort` contract consumed by `WorkspaceEditCoordinator`. */
  asPort(): WorkspaceEditPort {
    return { preflight: (targets, resources) => this.preflight(targets, resources), apply: (edits, resources, targets) => this.apply(edits, resources, targets ?? []) };
  }

  async resolveDocument(uri: string): Promise<WorkspaceEditableDocument | undefined> {
    if (workspaceRelativePathFromUri(this.#filesystem, this.#workspaceRoot, uri) === undefined) return undefined;
    return this.#openDocument(uri) ?? this.#loadUnopenedFile(uri);
  }

  async preflight(targets: readonly WorkspaceEditTarget[], resources: readonly WorkspaceResourceOperation[]): Promise<Result<void, WorkspaceEditFailure>> {
    const targetCheck = await this.verifyTargets(targets);
    if (!targetCheck.ok) return targetCheck;
    const planned = await this.plan(resources);
    return planned.ok ? { ok: true, value: undefined } : planned;
  }

  async apply(edits: readonly WorkspaceTextEdit[], resources: readonly WorkspaceResourceOperation[], targets: readonly WorkspaceEditTarget[] = []): Promise<Result<void, WorkspaceEditFailure>> {
    const targetCheck = await this.verifyTargets(targets);
    if (!targetCheck.ok) return targetCheck;
    const plan = await this.plan(resources);
    if (!plan.ok) return plan;
    const byUri = new Map<string, WorkspaceTextEdit[]>();
    for (const edit of edits) (byUri.get(edit.uri) ?? (byUri.set(edit.uri, []), byUri.get(edit.uri)!)).push(edit);
    for (const [uri, uriEdits] of byUri) {
      const applied = await this.applyDocumentEdits(uri, uriEdits);
      if (!applied.ok) return applied;
    }
    return applyWorkspaceResources(plan.value, {
      workspaceRoot: this.#workspaceRoot,
      filesystem: this.#filesystem,
      ...(this.#onResourcePathRenamed === undefined ? {} : { onResourcePathRenamed: this.#onResourcePathRenamed }),
      ...(this.#temporaryPathPrefix === undefined ? {} : { temporaryPathPrefix: this.#temporaryPathPrefix }),
    });
  }

  private async verifyTargets(targets: readonly WorkspaceEditTarget[]): Promise<Result<void, WorkspaceEditFailure>> {
    for (const target of targets) {
      const current = await this.resolveDocument(target.uri);
      if (current === undefined || current.target.version !== target.version || current.target.textLength !== target.textLength || target.contentHash !== undefined && current.target.contentHash !== target.contentHash) {
        return failure('stale', `workspace edit target changed: ${target.uri}`, target.uri);
      }
    }
    return { ok: true, value: undefined };
  }

  private async plan(resources: readonly WorkspaceResourceOperation[]): Promise<Result<readonly WorkspaceResourcePlanItem[], WorkspaceEditFailure>> {
    return planWorkspaceResources(resources, { workspaceRoot: this.#workspaceRoot, filesystem: this.#filesystem });
  }

  private async applyDocumentEdits(uri: string, edits: readonly WorkspaceTextEdit[]): Promise<Result<void, WorkspaceEditFailure>> {
    if (workspaceRelativePathFromUri(this.#filesystem, this.#workspaceRoot, uri) === undefined) return failure('stale', `workspace edit is outside the workspace: ${uri}`, uri);
    const document = await this.resolveDocument(uri);
    if (document === undefined) return failure('stale', `workspace edit target is unavailable: ${uri}`, uri);
    return document.apply(edits);
  }
}

/** Validates raw LSP edit ranges (already resolved to UTF-16 offsets) against a target's known
 * length. Pure range validation only; converting to a document engine's own branded offsets and
 * committing the transaction is the document owner's job, done by the port implementation. */
export function validateWorkspaceTextEditRanges(target: WorkspaceEditTarget, edits: readonly WorkspaceTextEdit[]): Result<void, string> {
  for (const edit of edits) {
    if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) || edit.start < 0 || edit.end < edit.start || edit.end > target.textLength) {
      return { ok: false, error: 'workspace edit range is outside the document' };
    }
  }
  return { ok: true, value: undefined };
}

/** Reports whether the language server has negotiated a `workspace/{will,did}{Create,Rename,Delete}Files`
 * notification, preferring the session's own capability negotiation and falling back to a raw
 * capabilities-record lookup for sessions that do not implement `supportsRequest`. */
export function serverSupportsFileOperation(
  session: { readonly health: { readonly capabilities: unknown }; supportsRequest?(method: string, uri?: string): boolean },
  kind: WorkspaceFileOperationKind,
  phase: 'will' | 'did',
): boolean {
  const capitalized = kind === 'create' ? 'Create' : kind === 'rename' ? 'Rename' : 'Delete';
  const method = `workspace/${phase}${capitalized}Files`;
  if (session.supportsRequest !== undefined) return session.supportsRequest(method);
  const capabilities = asRecord(session.health.capabilities);
  const workspace = asRecord(capabilities?.workspace);
  const fileOperations = asRecord(workspace?.fileOperations);
  return fileOperations?.[`${phase}${capitalized}`] !== undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export interface WorkspaceEditProposalProvider {
  willFileOperation(kind: WorkspaceFileOperationKind, files: readonly WorkspaceResourceOperation[]): Promise<Result<WorkspaceEditProposal | undefined, WorkspaceEditProviderFailure>>;
  didFileOperation(kind: WorkspaceFileOperationKind, files: readonly WorkspaceResourceOperation[]): Promise<Result<void, WorkspaceEditProviderFailure>>;
}

export interface ApplyWorkspaceEditProposalOptions {
  readonly coordinator: Pick<WorkspaceEditCoordinator, 'apply'>;
  readonly provider: WorkspaceEditProposalProvider;
  readonly session: { readonly health: { readonly capabilities: unknown }; supportsRequest?(method: string, uri?: string): boolean };
  readonly resolveTarget: (uri: string) => Promise<WorkspaceEditTarget | undefined>;
}

/** Applies one code-action/rename proposal: negotiates `willCreate/willRename/willDelete` file
 * operations first (merging any edits/resources the server adds), resolves fresh targets for
 * every edited URI, applies the combined proposal through the coordinator, then fires
 * `didCreate/didRename/didDelete` notifications on success. Returns the combined proposal
 * actually applied so the caller can report exact edit/resource counts. */
export async function applyWorkspaceEditProposal(
  proposal: WorkspaceEditProposal,
  options: ApplyWorkspaceEditProposalOptions,
): Promise<Result<{ readonly applied: WorkspaceEditProposal }, WorkspaceEditFailure>> {
  const { coordinator, provider, session, resolveTarget } = options;
  let combined = proposal;
  const resources = proposal.resources ?? [];
  for (const kind of ['create', 'rename', 'delete'] as const) {
    const group = resources.filter((resource) => resource.kind === kind);
    if (group.length === 0 || !serverSupportsFileOperation(session, kind, 'will')) continue;
    const will = await provider.willFileOperation(kind, group);
    if (!will.ok) return failure('apply', `language server file-operation preflight failed: ${will.error.message}`);
    if (will.value !== undefined) combined = Object.freeze({
      requestId: `${proposal.requestId}:will:${kind}`,
      edits: Object.freeze([...combined.edits, ...will.value.edits]),
      resources: Object.freeze([...(combined.resources ?? []), ...(will.value.resources ?? [])]),
    });
  }
  const uris = [...new Set(combined.edits.map((edit) => edit.uri))];
  const resolved = await Promise.all(uris.map((uri) => resolveTarget(uri)));
  if (resolved.some((target) => target === undefined)) return failure('stale', 'workspace edit target is unavailable');
  const targets = resolved.filter((target): target is WorkspaceEditTarget => target !== undefined);
  const applied = await coordinator.apply(combined, targets);
  if (!applied.ok) return applied;
  for (const kind of ['create', 'rename', 'delete'] as const) {
    const group = resources.filter((resource) => resource.kind === kind);
    if (group.length === 0 || !serverSupportsFileOperation(session, kind, 'did')) continue;
    await provider.didFileOperation(kind, group);
  }
  return { ok: true, value: { applied: combined } };
}

export interface RenameRetryOptions {
  /** Number of additional rename attempts beyond the first (0 disables retrying). */
  readonly attempts: number;
  readonly delayMs: number;
}

/** Retries a `textDocument/rename` request while the result still only touches the requested
 * document, up to `options.attempts` times. Some language servers answer a rename while their
 * project graph has only the open file loaded, so an immediate result can be incomplete; a bounded
 * retry lets the normal request settle. This was previously a hardcoded TypeScript-only check;
 * callers now opt in explicitly (e.g. only for `languageId === 'typescript'`) by passing `options`. */
export async function renameWithBoundedRetry(
  request: WorkspaceEditRequest,
  newName: string,
  rename: (request: WorkspaceEditRequest, newName: string) => Promise<Result<WorkspaceEditProposal, WorkspaceEditProviderFailure>>,
  options?: RenameRetryOptions,
  sleep: (delayMs: number) => Promise<void> = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<Result<WorkspaceEditProposal, WorkspaceEditProviderFailure>> {
  let result = await rename(request, newName);
  const attempts = options?.attempts ?? 0;
  for (let attempt = 0; attempt < attempts && result.ok && result.value.edits.length > 0 && result.value.edits.every((edit) => edit.uri === request.uri); attempt += 1) {
    await sleep(options?.delayMs ?? 0);
    result = await rename(request, newName);
  }
  return result;
}
