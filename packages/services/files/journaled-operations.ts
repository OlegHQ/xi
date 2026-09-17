import type {
  CancellationToken,
  FileInfo,
  FilesystemPort,
  PlatformFailure,
  Result,
} from '../../contracts/src/index.ts';
import type { DirectoryOperation, DirectoryOperationPlan } from './directory-draft';

/** Public contract version for durable workspace file operations. */
export const FILE_OPERATION_CONTRACT_VERSION = 1 as const;

/** Filesystem primitives needed by the service. Implementations are injected. */
export interface JournaledFilesystemPort extends FilesystemPort {
  makeDirectory(path: string, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
  renamePath(from: string, to: string, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
  copyPath(from: string, to: string, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
  removePath(path: string, recursive: boolean, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>>;
}

export interface FileOperationHooks {
  /** LSP `will*` hooks run after local preflight and before the first disk step. */
  readonly will?: (plan: DirectoryOperationPlan, cancellation: CancellationToken) => Promise<Result<void, FileOperationFailure>>;
  /** LSP `did*` hooks run only after every durable step has completed. */
  readonly did?: (plan: DirectoryOperationPlan, result: FileOperationResult, cancellation: CancellationToken) => Promise<void>;
}

export interface JournaledFileOperationOptions {
  readonly operationId?: string;
  readonly journalPath?: string;
  readonly trashRoot?: string;
  readonly hooks?: FileOperationHooks;
}

export interface FileFingerprint {
  readonly path: string;
  readonly kind: FileInfo['kind'];
  readonly sizeBytes: number;
  readonly modifiedMilliseconds: number;
  readonly device: string | undefined;
  readonly inode: string | undefined;
  readonly contentHash: string | undefined;
}

export type FileOperationFailure =
  | { readonly kind: 'cancelled'; readonly message: string }
  | { readonly kind: 'invalid-plan'; readonly message: string; readonly operation?: string }
  | { readonly kind: 'preflight-conflict'; readonly path: string; readonly message: string }
  | { readonly kind: 'external-change'; readonly path: string; readonly message: string }
  | { readonly kind: 'platform'; readonly path: string; readonly failure: PlatformFailure }
  | { readonly kind: 'journal'; readonly path: string; readonly message: string }
  | { readonly kind: 'hook'; readonly phase: 'will' | 'did'; readonly message: string }
  | { readonly kind: 'partial'; readonly path: string; readonly message: string; readonly journal: FileOperationJournal }
  | { readonly kind: 'disposed' };

export interface FileOperationStep {
  readonly id: string;
  readonly kind: 'move' | 'copy';
  readonly operationKind: DirectoryOperation['kind'];
  readonly from: string;
  readonly to: string;
  readonly sourcePath: string;
  readonly expected: FileFingerprint;
  readonly completed: boolean;
  readonly method: 'rename' | 'copy-delete' | 'copy' | undefined;
  readonly after: FileFingerprint | undefined;
}

export interface FileOperationJournal {
  readonly schemaVersion: typeof FILE_OPERATION_CONTRACT_VERSION;
  readonly operationId: string;
  readonly journalPath: string;
  readonly directoryPath: string;
  readonly trashRoot: string;
  readonly plan: DirectoryOperationPlan;
  readonly steps: readonly FileOperationStep[];
  readonly status: 'running' | 'applied' | 'partial' | 'restored' | 'restore-failed';
  readonly failure: string | undefined;
}

export interface FileOperationResult {
  readonly operationId: string;
  readonly status: 'applied' | 'partial';
  readonly journal: FileOperationJournal;
  readonly completedSteps: number;
  /** This result is an applied-operation record; DirectoryDraft.undo is separate. */
  readonly restoreAvailable: true;
}

export interface FileOperationRecoveryResult {
  readonly operationId: string;
  readonly status: 'retried' | 'restored';
  readonly journal: FileOperationJournal;
  readonly completedSteps: number;
}

interface InternalStep extends FileOperationStep {
  expected: FileFingerprint;
}

/**
 * Executes reviewed directory plans through an injected asynchronous platform.
 * Every individual move/copy is journaled before and after it runs. A failed
 * plan remains recoverable and is never silently rolled back over external data.
 */
/** Bounds the fingerprint cache so a long-lived service instance cannot retain unbounded per-path memory. */
const MAX_FINGERPRINT_CACHE_ENTRIES = 256;
/** Journals are small JSON documents describing a plan's steps, never full file content. */
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
/** Fingerprinting reads a whole file into memory to hash it; bound it so a pathologically large
 * file in a move/copy plan cannot be fully materialized just to compute its content hash. */
const MAX_FINGERPRINT_BYTES = 256 * 1024 * 1024;

export class JournaledFilesystemOperations {
  readonly #filesystem: JournaledFilesystemPort;
  readonly #hooks: FileOperationHooks | undefined;
  readonly #defaultTrashRoot: string | undefined;
  // Preflight, executeStep and restoreStep each fingerprint the same source
  // and destination paths; caching by path with a stat-based validity check
  // (below) avoids reading and hashing an unchanged file more than once.
  readonly #fingerprintCache = new Map<string, FileFingerprint>();
  #counter = 0;
  #disposed = false;

  constructor(filesystem: JournaledFilesystemPort, options: Pick<JournaledFileOperationOptions, 'hooks' | 'trashRoot'> = {}) {
    this.#filesystem = filesystem;
    this.#hooks = options.hooks;
    this.#defaultTrashRoot = options.trashRoot;
  }

  /** Idempotent. Releases the fingerprint cache; later calls fail with `{ kind: 'disposed' }`. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#fingerprintCache.clear();
  }

  async apply(
    plan: DirectoryOperationPlan,
    cancellation: CancellationToken,
    options: JournaledFileOperationOptions = {},
  ): Promise<Result<FileOperationResult, FileOperationFailure>> {
    if (this.#disposed) return { ok: false, error: { kind: 'disposed' } };
    const checked = validatePlan(plan);
    if (!checked.ok) return checked;
    const operationId = options.operationId ?? `xi-file-${Date.now()}-${this.#counter += 1}`;
    if (!isSafeOperationId(operationId)) return invalidPlan('operation ID contains a path separator or traversal segment');
    const journalPath = options.journalPath ?? joinPath(plan.directoryPath, '.xi', 'operations', `${operationId}.json`);
    const trashRoot = options.trashRoot ?? this.#defaultTrashRoot ?? joinPath(plan.directoryPath, '.xi-trash');
    const preflight = await this.preflight(plan, cancellation, trashRoot);
    if (!preflight.ok) return preflight;
    const hooks = options.hooks ?? this.#hooks;
    if (hooks?.will !== undefined) {
      const hook = await hooks.will(plan, cancellation);
      if (!hook.ok) return hook;
    }

    const journalDir = parentPath(journalPath);
    const madeDirectory = await this.#filesystem.makeDirectory(journalDir, cancellation);
    if (!madeDirectory.ok) return platformFailure(journalDir, madeDirectory.error);
    if (plan.operations.some((operation) => operation.kind === 'trash')) {
      const trashDirectory = joinPath(trashRoot, operationId);
      const madeTrashDirectory = await this.#filesystem.makeDirectory(trashDirectory, cancellation);
      if (!madeTrashDirectory.ok) return platformFailure(trashDirectory, madeTrashDirectory.error);
    }
    const steps = makeSteps(plan, preflight.value, operationId, trashRoot);
    let journal = freezeJournal({
      schemaVersion: FILE_OPERATION_CONTRACT_VERSION,
      operationId,
      journalPath,
      directoryPath: plan.directoryPath,
      trashRoot,
      plan,
      steps,
      status: 'running',
      failure: undefined,
    });
    const written = await this.writeJournal(journal, cancellation);
    if (!written.ok) return written;

    for (let index = 0; index < steps.length; index += 1) {
      if (cancellation.isCancelled) {
        journal = await this.markFailure(journal, 'operation cancelled', cancellation);
        return { ok: false, error: { kind: 'partial', path: journal.journalPath, message: 'operation cancelled; retry or restore from the journal', journal } };
      }
      const step = journal.steps[index];
      if (step === undefined || step.completed) continue;
      const executed = await this.executeStep(step, cancellation);
      if (!executed.ok) {
        journal = await this.markFailure(journal, executed.error.message, cancellation);
        return { ok: false, error: { kind: 'partial', path: executed.error.path, message: executed.error.message, journal } };
      }
      const completed: InternalStep = {
        ...step,
        completed: true,
        method: executed.value.method,
        after: executed.value.after,
      };
      journal = freezeJournal({ ...journal, steps: replaceStep(journal.steps, index, completed) });
      const persisted = await this.writeJournal(journal, cancellation);
      if (!persisted.ok) {
        journal = await this.markFailure(journal, persisted.error.kind === 'journal' ? persisted.error.message : 'journal write failed', cancellation);
        return { ok: false, error: { kind: 'partial', path: journal.journalPath, message: 'disk step completed but its journal could not be committed', journal } };
      }
    }
    journal = await this.updateStatus(journal, 'applied', undefined, cancellation);
    const result: FileOperationResult = Object.freeze({
      operationId: journal.operationId,
      status: 'applied',
      journal,
      completedSteps: journal.steps.filter((step) => step.completed).length,
      restoreAvailable: true,
    });
    if (hooks?.did !== undefined) {
      try {
        await hooks.did(plan, result, cancellation);
      } catch (error: unknown) {
        // The filesystem transaction is complete. Keep its success and expose
        // the hook failure to the caller without pretending it can be undone.
        return { ok: false, error: { kind: 'hook', phase: 'did', message: errorMessage(error) } };
      }
    }
    return { ok: true, value: result };
  }

  /** Load a persisted operation after a restart without trusting unvalidated JSON. */
  async readJournal(path: string, cancellation: CancellationToken): Promise<Result<FileOperationJournal, FileOperationFailure>> {
    if (this.#disposed) return { ok: false, error: { kind: 'disposed' } };
    const bytes = await this.#filesystem.readFile(path, cancellation, { maxBytes: MAX_JOURNAL_BYTES });
    if (!bytes.ok) return journalFailure(path, platformMessage(bytes.error));
    const decoded = decodeFileOperationJournal(bytes.value);
    return decoded.ok ? decoded : journalFailure(path, failureMessage(decoded.error));
  }

  async retryJournal(path: string, cancellation: CancellationToken): Promise<Result<FileOperationRecoveryResult, FileOperationFailure>> {
    const loaded = await this.readJournal(path, cancellation);
    return loaded.ok ? this.retry(loaded.value, cancellation) : loaded;
  }

  async restoreJournal(path: string, cancellation: CancellationToken): Promise<Result<FileOperationRecoveryResult, FileOperationFailure>> {
    const loaded = await this.readJournal(path, cancellation);
    return loaded.ok ? this.restoreApplied(loaded.value, cancellation) : loaded;
  }

  async preflight(
    plan: DirectoryOperationPlan,
    cancellation: CancellationToken,
    trashRoot = this.#defaultTrashRoot ?? joinPath(plan.directoryPath, '.xi-trash'),
  ): Promise<Result<ReadonlyMap<string, FileFingerprint>, FileOperationFailure>> {
    if (this.#disposed) return { ok: false, error: { kind: 'disposed' } };
    const checked = validatePlan(plan);
    if (!checked.ok) return checked;
    if (cancellation.isCancelled) return cancelled();
    const sources = new Set<string>();
    const destinations = new Set<string>();
    for (const operation of plan.operations) {
      const sourcePath = operation.kind === 'rename' || operation.kind === 'copy' || operation.kind === 'trash' ? operation.sourcePath : '';
      if (!isWithin(plan.directoryPath, sourcePath)) return invalidPlan('operation escapes the reviewed directory', operation.kind);
      sources.add(canonicalPath(sourcePath));
      if (operation.kind === 'rename' || operation.kind === 'copy') {
        if (!isWithin(plan.directoryPath, operation.destinationPath)) return invalidPlan('destination escapes the reviewed directory', operation.kind);
        const destination = canonicalPath(operation.destinationPath);
        if (destinations.has(destination)) return conflict(operation.destinationPath, 'duplicate operation destination');
        destinations.add(destination);
      }
    }
    const fingerprints = new Map<string, FileFingerprint>();
    for (const operation of plan.operations) {
      const sourcePath = operation.sourcePath;
      const key = canonicalPath(sourcePath);
      if (!fingerprints.has(key)) {
        const source = await this.fingerprint(sourcePath, cancellation);
        if (!source.ok) return source;
        if (source.value === undefined) return conflict(sourcePath, 'source changed or disappeared after the directory draft was reviewed');
        fingerprints.set(key, source.value);
      }
      if (operation.kind === 'rename' || operation.kind === 'copy') {
        const destination = await this.fingerprint(operation.destinationPath, cancellation);
        if (!destination.ok) return destination;
        if (destination.value !== undefined && (!sources.has(canonicalPath(operation.destinationPath)) || operation.kind === 'copy')) {
          return conflict(operation.destinationPath, 'destination was created externally or is already occupied');
        }
      }
    }
    // Trash storage is created lazily during execution. It must never be an
    // unreviewed destination inside an operation's source subtree.
    if (isWithin(plan.directoryPath, trashRoot) && plan.operations.some((operation) => operation.sourcePath === trashRoot)) {
      return invalidPlan('trash storage conflicts with an operation source');
    }
    return { ok: true, value: fingerprints };
  }

  async retry(
    journal: FileOperationJournal,
    cancellation: CancellationToken,
  ): Promise<Result<FileOperationRecoveryResult, FileOperationFailure>> {
    if (this.#disposed) return { ok: false, error: { kind: 'disposed' } };
    if (journal.schemaVersion !== FILE_OPERATION_CONTRACT_VERSION) return journalFailure(journal.journalPath, 'unsupported journal schema');
    if (journal.status === 'applied') return { ok: true, value: recoveryResult(journal, 'retried') };
    let current = journal;
    for (let index = 0; index < current.steps.length; index += 1) {
      const step = current.steps[index];
      if (step === undefined || step.completed) continue;
      const reconciled = await this.reconcileStep(step, cancellation);
      if (!reconciled.ok) {
        current = await this.markFailure(current, reconciled.error.message, cancellation);
        return { ok: false, error: { kind: 'partial', path: reconciled.error.path, message: reconciled.error.message, journal: current } };
      }
      current = freezeJournal({ ...current, steps: replaceStep(current.steps, index, { ...step, completed: true, method: reconciled.value.method, after: reconciled.value.after }) });
      const saved = await this.writeJournal(current, cancellation);
      if (!saved.ok) return saved;
    }
    current = await this.updateStatus(current, 'applied', undefined, cancellation);
    return { ok: true, value: recoveryResult(current, 'retried') };
  }

  /** Restore an applied operation after rechecking every affected path. */
  async restoreApplied(
    journal: FileOperationJournal,
    cancellation: CancellationToken,
  ): Promise<Result<FileOperationRecoveryResult, FileOperationFailure>> {
    if (this.#disposed) return { ok: false, error: { kind: 'disposed' } };
    if (journal.schemaVersion !== FILE_OPERATION_CONTRACT_VERSION) return journalFailure(journal.journalPath, 'unsupported journal schema');
    let current = journal;
    const completed = current.steps.filter((step) => step.completed);
    for (let index = completed.length - 1; index >= 0; index -= 1) {
      const step = completed[index];
      if (step === undefined || step.after === undefined) continue;
      const restored = await this.restoreStep(step, cancellation);
      if (!restored.ok) {
        current = await this.updateStatus(current, 'restore-failed', restored.error.message, cancellation);
        return { ok: false, error: { kind: 'partial', path: restored.error.path, message: restored.error.message, journal: current } };
      }
      const absoluteIndex = current.steps.findIndex((candidate) => candidate.id === step.id);
      if (absoluteIndex >= 0) current = freezeJournal({ ...current, steps: replaceStep(current.steps, absoluteIndex, { ...step, completed: false }) });
      const saved = await this.writeJournal(current, cancellation);
      if (!saved.ok) return saved;
    }
    current = await this.updateStatus(current, 'restored', undefined, cancellation);
    return { ok: true, value: recoveryResult(current, 'restored') };
  }

  private async executeStep(step: FileOperationStep, cancellation: CancellationToken): Promise<Result<{ readonly method: FileOperationStep['method']; readonly after: FileFingerprint }, { readonly path: string; readonly message: string }>> {
    const source = await this.fingerprint(step.from, cancellation);
    if (!source.ok) return localFailure(step.from, failureMessage(source.error));
    if (source.value === undefined || !sameContent(source.value, step.expected)) return localFailure(step.from, 'source changed externally after preflight');
    const destination = await this.fingerprint(step.to, cancellation);
    if (!destination.ok) return localFailure(step.to, failureMessage(destination.error));
    if (destination.value !== undefined) return localFailure(step.to, 'destination was created externally after preflight');
    if (step.kind === 'copy') {
      const copied = await this.#filesystem.copyPath(step.from, step.to, cancellation);
      if (!copied.ok) return localFailure(step.from, platformMessage(copied.error));
      const after = await this.requireFingerprint(step.to, cancellation);
      if (!after.ok) return after;
      if (!sameContent(after.value, step.expected)) return localFailure(step.to, 'copy verification did not match the reviewed source');
      return { ok: true, value: { method: 'copy', after: after.value } };
    }
    const renamed = await this.#filesystem.renamePath(step.from, step.to, cancellation);
    if (renamed.ok) {
      const after = await this.requireFingerprint(step.to, cancellation);
      if (!after.ok) return after;
      return { ok: true, value: { method: 'rename', after: after.value } };
    }
    if (renamed.error.code !== 'EXDEV') return localFailure(step.from, platformMessage(renamed.error));
    const copied = await this.#filesystem.copyPath(step.from, step.to, cancellation);
    if (!copied.ok) return localFailure(step.from, platformMessage(copied.error));
    const after = await this.requireFingerprint(step.to, cancellation);
    if (!after.ok) return after;
    if (!sameContent(after.value, step.expected)) return localFailure(step.to, 'cross-device copy verification did not match the reviewed source');
    const removed = await this.#filesystem.removePath(step.from, after.value.kind === 'directory', cancellation);
    if (!removed.ok) return localFailure(step.from, platformMessage(removed.error));
    return { ok: true, value: { method: 'copy-delete', after: after.value } };
  }

  private async reconcileStep(step: FileOperationStep, cancellation: CancellationToken): Promise<Result<{ readonly method: FileOperationStep['method']; readonly after: FileFingerprint }, { readonly path: string; readonly message: string }>> {
    const source = await this.fingerprint(step.from, cancellation);
    if (!source.ok) return localFailure(step.from, failureMessage(source.error));
    const destination = await this.fingerprint(step.to, cancellation);
    if (!destination.ok) return localFailure(step.to, failureMessage(destination.error));
    if (source.value === undefined && destination.value !== undefined && sameContent(destination.value, step.expected)) {
      return { ok: true, value: { method: step.method ?? 'rename', after: destination.value } };
    }
    if (source.value !== undefined && sameFingerprint(source.value, step.expected) && destination.value !== undefined && sameContent(destination.value, step.expected)) {
      const removed = await this.#filesystem.removePath(step.from, source.value.kind === 'directory', cancellation);
      if (!removed.ok) return localFailure(step.from, platformMessage(removed.error));
      return { ok: true, value: { method: 'copy-delete', after: destination.value } };
    }
    return this.executeStep(step, cancellation);
  }

  private async restoreStep(step: FileOperationStep, cancellation: CancellationToken): Promise<Result<void, { readonly path: string; readonly message: string }>> {
    const destination = await this.fingerprint(step.to, cancellation);
    if (!destination.ok) return localFailure(step.to, failureMessage(destination.error));
    if (destination.value === undefined) return localFailure(step.to, 'applied destination disappeared; restore stopped to preserve external changes');
    if (step.after === undefined || !sameContent(destination.value, step.after)) return localFailure(step.to, 'applied destination changed externally; restore stopped without clobbering it');
    const source = await this.fingerprint(step.from, cancellation);
    if (!source.ok) return localFailure(step.from, failureMessage(source.error));
    if (step.kind === 'copy') {
      if (source.value === undefined || sameContent(source.value, step.expected)) {
        const removed = await this.#filesystem.removePath(step.to, destination.value.kind === 'directory', cancellation);
        return removed.ok ? { ok: true, value: undefined } : localFailure(step.to, platformMessage(removed.error));
      }
      return localFailure(step.from, 'copy source changed externally; restore stopped without deleting the copy');
    }
    if (source.value !== undefined) return localFailure(step.from, 'restore destination is occupied by unrelated content');
    const moved = await this.#filesystem.renamePath(step.to, step.from, cancellation);
    if (moved.ok) return { ok: true, value: undefined };
    if (moved.error.code !== 'EXDEV') return localFailure(step.to, platformMessage(moved.error));
    const copied = await this.#filesystem.copyPath(step.to, step.from, cancellation);
    if (!copied.ok) return localFailure(step.to, platformMessage(copied.error));
    const restored = await this.requireFingerprint(step.from, cancellation);
    if (!restored.ok) return restored;
    if (!sameContent(restored.value, step.expected)) return localFailure(step.from, 'restore copy verification did not match the original content');
    const removed = await this.#filesystem.removePath(step.to, destination.value.kind === 'directory', cancellation);
    return removed.ok ? { ok: true, value: undefined } : localFailure(step.to, platformMessage(removed.error));
  }

  private async fingerprint(path: string, cancellation: CancellationToken): Promise<Result<FileFingerprint | undefined, FileOperationFailure>> {
    const stat = await this.#filesystem.stat(path, cancellation);
    if (!stat.ok) {
      if (stat.error.code === 'ENOENT' || stat.error.code === 'ENOTDIR') {
        this.#fingerprintCache.delete(path);
        return { ok: true, value: undefined };
      }
      return platformFailure(path, stat.error);
    }
    const cached = this.#fingerprintCache.get(path);
    if (cached !== undefined && cached.kind === stat.value.kind && cached.sizeBytes === stat.value.sizeBytes
      && cached.modifiedMilliseconds === stat.value.modifiedMilliseconds && cached.device === stat.value.device && cached.inode === stat.value.inode) {
      return { ok: true, value: cached };
    }
    const hash = stat.value.kind === 'file' ? await this.hash(path, cancellation) : { ok: true as const, value: undefined };
    if (!hash.ok) return hash;
    const value: FileFingerprint = Object.freeze({
      path,
      kind: stat.value.kind,
      sizeBytes: stat.value.sizeBytes,
      modifiedMilliseconds: stat.value.modifiedMilliseconds,
      device: stat.value.device,
      inode: stat.value.inode,
      contentHash: hash.value,
    });
    this.#fingerprintCache.set(path, value);
    if (this.#fingerprintCache.size > MAX_FINGERPRINT_CACHE_ENTRIES) {
      const oldest = this.#fingerprintCache.keys().next().value;
      if (oldest !== undefined) this.#fingerprintCache.delete(oldest);
    }
    return { ok: true, value };
  }

  private async requireFingerprint(path: string, cancellation: CancellationToken): Promise<Result<FileFingerprint, { readonly path: string; readonly message: string }>> {
    const result = await this.fingerprint(path, cancellation);
    if (!result.ok) return localFailure(path, failureMessage(result.error));
    if (result.value === undefined) return localFailure(path, 'expected destination was not created');
    return { ok: true, value: result.value };
  }

  private async hash(path: string, cancellation: CancellationToken): Promise<Result<string | undefined, FileOperationFailure>> {
    const bytes = await this.#filesystem.readFile(path, cancellation, { maxBytes: MAX_FINGERPRINT_BYTES });
    if (!bytes.ok) return platformFailure(path, bytes.error);
    if (cancellation.isCancelled) return cancelled();
    return { ok: true, value: stableHash(bytes.value) };
  }

  private async writeJournal(journal: FileOperationJournal, cancellation: CancellationToken): Promise<Result<void, FileOperationFailure>> {
    const encoded = new TextEncoder().encode(JSON.stringify(journal));
    const written = await this.#filesystem.writeFileAtomic(journal.journalPath, encoded, cancellation);
    return written.ok ? written : journalFailure(journal.journalPath, platformMessage(written.error));
  }

  private async markFailure(journal: FileOperationJournal, message: string, cancellation: CancellationToken): Promise<FileOperationJournal> {
    return this.updateStatus(journal, 'partial', message, cancellation);
  }

  private async updateStatus(
    journal: FileOperationJournal,
    status: FileOperationJournal['status'],
    failure: string | undefined,
    cancellation: CancellationToken,
  ): Promise<FileOperationJournal> {
    const updated = freezeJournal({ ...journal, status, ...(failure === undefined ? {} : { failure }) });
    const written = await this.writeJournal(updated, cancellation);
    return written.ok ? updated : journal;
  }
}

export function decodeFileOperationJournal(bytes: Uint8Array): Result<FileOperationJournal, FileOperationFailure> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return journalFailure('', 'journal is not valid UTF-8 JSON');
  }
  if (!isJournal(value)) return journalFailure('', 'journal schema is invalid');
  return { ok: true, value };
}

function makeSteps(
  plan: DirectoryOperationPlan,
  fingerprints: ReadonlyMap<string, FileFingerprint>,
  operationId: string,
  trashRoot: string,
): readonly InternalStep[] {
  const steps: InternalStep[] = [];
  let number = 0;
  const renameOperations = plan.operations.filter((operation): operation is Extract<DirectoryOperation, { readonly kind: 'rename' }> => operation.kind === 'rename');
  // Copies consume the reviewed source before any rename or trash step can
  // move it. This also makes a legal copy-plus-rename plan deterministic.
  for (const operation of plan.operations) {
    if (operation.kind !== 'copy') continue;
    const expected = fingerprints.get(canonicalPath(operation.sourcePath));
    if (expected === undefined) throw new Error('file-operation-source-fingerprint-missing');
    steps.push(step(`copy-${number += 1}`, 'copy', operation.kind, operation.sourcePath, operation.destinationPath, expected));
  }
  for (const operation of renameOperations) {
    const expected = fingerprints.get(canonicalPath(operation.sourcePath));
    if (expected === undefined) throw new Error('file-operation-source-fingerprint-missing');
    const stageIndex = renameOperations.indexOf(operation) + 1;
    const temporary = joinPath(plan.directoryPath, `.xi-operation-${operationId}-${stageIndex}`);
    steps.push(step(`rename-stage-${stageIndex}`, 'move', operation.kind, operation.sourcePath, temporary, expected));
  }
  for (const operation of renameOperations) {
    const expected = fingerprints.get(canonicalPath(operation.sourcePath));
    if (expected === undefined) throw new Error('file-operation-source-fingerprint-missing');
    const stageIndex = renameOperations.indexOf(operation) + 1;
    const temporary = joinPath(plan.directoryPath, `.xi-operation-${operationId}-${stageIndex}`);
    steps.push(step(`rename-commit-${stageIndex}`, 'move', operation.kind, temporary, operation.destinationPath, expected));
  }
  for (const operation of plan.operations) {
    if (operation.kind === 'trash') {
      const expected = fingerprints.get(canonicalPath(operation.sourcePath));
      if (expected === undefined) throw new Error('file-operation-source-fingerprint-missing');
      const trashPath = joinPath(trashRoot, operationId, `${number += 1}-${basename(operation.sourcePath)}`);
      steps.push(step(`trash-${number}`, 'move', operation.kind, operation.sourcePath, trashPath, expected));
    }
  }
  return Object.freeze(steps);
}

function step(id: string, kind: FileOperationStep['kind'], operationKind: DirectoryOperation['kind'], from: string, to: string, expected: FileFingerprint): InternalStep {
  return { id, kind, operationKind, from, to, sourcePath: expected.path, expected, completed: false, method: undefined, after: undefined };
}

function validatePlan(plan: DirectoryOperationPlan): Result<void, FileOperationFailure> {
  if (plan.contractVersion !== 1 || !isSafePath(plan.directoryPath)) return invalidPlan('operation plan has an invalid contract or directory path');
  const ids = new Set<string>();
  for (const operation of plan.operations) {
    const rowId = operation.rowId;
    if (ids.has(rowId)) return invalidPlan('operation plan contains duplicate row identities', operation.kind);
    ids.add(rowId);
    if (!isSafePath(operation.sourcePath)) return invalidPlan('operation source contains NUL or is empty', operation.kind);
    if (operation.kind === 'rename' && (!isSafePath(operation.destinationPath) || operation.from === operation.to)) return invalidPlan('rename has an invalid destination', operation.kind);
    if (operation.kind === 'copy' && !isSafePath(operation.destinationPath)) return invalidPlan('copy has an invalid destination', operation.kind);
  }
  return { ok: true, value: undefined };
}

function sameFingerprint(actual: FileFingerprint, expected: FileFingerprint): boolean {
  return actual.kind === expected.kind && actual.sizeBytes === expected.sizeBytes && actual.modifiedMilliseconds === expected.modifiedMilliseconds
    && actual.device === expected.device && actual.inode === expected.inode && actual.contentHash === expected.contentHash;
}

function sameContent(actual: FileFingerprint, expected: FileFingerprint): boolean {
  return actual.kind === expected.kind && actual.sizeBytes === expected.sizeBytes && actual.contentHash === expected.contentHash;
}

function replaceStep(steps: readonly FileOperationStep[], index: number, stepValue: FileOperationStep): readonly FileOperationStep[] {
  return Object.freeze(steps.map((step, candidate) => candidate === index ? stepValue : step));
}

function freezeJournal(journal: FileOperationJournal): FileOperationJournal {
  return Object.freeze({ ...journal, steps: Object.freeze(journal.steps.map((step) => Object.freeze({ ...step }))), plan: Object.freeze({ ...journal.plan, operations: Object.freeze([...journal.plan.operations]) }) });
}

function recoveryResult(journal: FileOperationJournal, status: FileOperationRecoveryResult['status']): FileOperationRecoveryResult {
  return Object.freeze({ operationId: journal.operationId, status, journal, completedSteps: journal.steps.filter((step) => step.completed).length });
}

function isJournal(value: unknown): value is FileOperationJournal {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === FILE_OPERATION_CONTRACT_VERSION && typeof record.operationId === 'string' && typeof record.journalPath === 'string'
    && typeof record.directoryPath === 'string' && typeof record.trashRoot === 'string' && typeof record.plan === 'object' && Array.isArray(record.steps)
    && (record.status === 'running' || record.status === 'applied' || record.status === 'partial' || record.status === 'restored' || record.status === 'restore-failed');
}

function invalidPlan(message: string, operation?: string): Result<never, FileOperationFailure> {
  return { ok: false, error: { kind: 'invalid-plan', message, ...(operation === undefined ? {} : { operation }) } };
}

function conflict(path: string, message: string): Result<never, FileOperationFailure> {
  return { ok: false, error: { kind: 'preflight-conflict', path, message } };
}

function platformFailure(path: string, failure: PlatformFailure): Result<never, FileOperationFailure> {
  return { ok: false, error: { kind: 'platform', path, failure } };
}

function journalFailure(path: string, message: string): Result<never, FileOperationFailure> {
  return { ok: false, error: { kind: 'journal', path, message } };
}

function cancelled(): Result<never, FileOperationFailure> {
  return { ok: false, error: { kind: 'cancelled', message: 'filesystem operation cancelled' } };
}

function localFailure(path: string, message: string): Result<never, { readonly path: string; readonly message: string }> {
  return { ok: false, error: { path, message } };
}

function failureMessage(failure: FileOperationFailure): string {
  if (failure.kind === 'platform') return failure.failure.message;
  if (failure.kind === 'disposed') return 'journaled filesystem operations service is disposed';
  return failure.message;
}

function platformMessage(failure: PlatformFailure): string { return `${failure.code}: ${failure.message}`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function isSafePath(path: string): boolean { return path.length > 0 && !path.includes('\0'); }
function isSafeOperationId(value: string): boolean { return value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\') && !value.includes('\0'); }
function canonicalPath(path: string): string {
  const absolute = path.startsWith('/') ? '/' : '';
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { parts.pop(); continue; }
    parts.push(part);
  }
  return `${absolute}${parts.join('/')}` || (absolute || '.');
}
function isWithin(root: string, path: string): boolean {
  const canonicalRoot = canonicalPath(root).replace(/\/$/u, '');
  const canonical = canonicalPath(path);
  return canonical === canonicalRoot || canonical.startsWith(`${canonicalRoot}/`);
}
function joinPath(first: string, ...rest: string[]): string { return [first, ...rest].map((part) => part.replace(/^\/+|\/+$/gu, '')).filter(Boolean).join('/').replace(/^([^/])/, '/$1'); }
function parentPath(path: string): string {
  const canonical = canonicalPath(path);
  const index = canonical.lastIndexOf('/');
  return index <= 0 ? '/' : canonical.slice(0, index);
}
function basename(path: string): string { const canonical = canonicalPath(path); return canonical.slice(canonical.lastIndexOf('/') + 1) || 'entry'; }

// Stable non-cryptographic content fingerprint used alongside platform
// identity. Only ever compared for equality within/across journaled
// operations (never validated against a fixed format by isJournal), so the
// algorithm is free to change; Bun's native hash replaces the previous
// per-byte double-BigInt-multiply loop, which ran on the main isolate for
// every fingerprinted file. NOTE: a journal written before this change and
// still 'running' across an app upgrade would carry old-format hashes; a
// restore recomputes fresh hashes and compares by string equality, so such a
// journal would report a (spurious) content mismatch instead of restoring.
// This is an accepted, narrow compatibility gap (crash-during-operation +
// same-moment upgrade), not a schema version bump.
function stableHash(bytes: Uint8Array): string {
  return Bun.hash(bytes).toString(16).padStart(16, '0');
}
