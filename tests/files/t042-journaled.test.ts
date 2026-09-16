#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CancellationSource, type CancellationToken, type Disposable, type FileWatchEvent, type PlatformFailure, type Result } from '../../packages/contracts/src/index';
import { DirectoryDraft, type DirectoryOperationPlan } from '../../packages/services/files/index';
import {
  JournaledFilesystemOperations,
  type FileOperationFailure,
  type JournaledFilesystemPort,
} from '../../packages/services/files/index';
import { NodeFilesystemPort } from '../../packages/platform/src/index';

const token = new CancellationSource().token;

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'xi-t042-'));
  try {
    await testRenameCycleCaseAndRestore(root);
    await testCopyTrashAndDraftUndoRemainSeparate(root);
    await testExternalDestinationIsNeverClobbered(root);
    await testCrossDeviceFallbackAndRetryAfterPartialFailure(root);
    console.log('T042 journaled filesystem passed cycle/case moves, cross-device fallback, trash/restore, durable partial retry and external-content protection');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testRenameCycleCaseAndRestore(root: string): Promise<void> {
  const directory = join(root, 'cycle');
  const a = join(directory, 'a.txt');
  const b = join(directory, 'b.txt');
  await mkdir(directory);
  await writeFile(a, 'alpha\n');
  await writeFile(b, 'beta\n');
  const created = DirectoryDraft.create(directory, [
    { id: 'a', name: 'a.txt', path: a, stableIdentity: 'a' },
    { id: 'b', name: 'b.txt', path: b, stableIdentity: 'b' },
  ]);
  assert.equal(created.ok, true, 'T042-CYCLE-01 draft initializes');
  if (!created.ok) return;
  assert.equal(created.value.rename('a', 'b.txt').ok, true, 'T042-CYCLE-02 first cycle rename is draft-only');
  assert.equal(created.value.rename('b', 'a.txt').ok, true, 'T042-CYCLE-03 second cycle rename is draft-only');
  const plan = created.value.compilePlan();
  assert.equal(plan.ok, true, 'T042-CYCLE-04 cycle plan compiles');
  if (!plan.ok) return;
  const service = new JournaledFilesystemOperations(new NodeFilesystemPort());
  const applied = await service.apply(plan.value, token, { operationId: 'cycle' });
  assert.equal(applied.ok, true, 'T042-CYCLE-05 cycle applies through temporary names');
  if (!applied.ok) return;
  assert.equal(await readFile(a, 'utf8'), 'beta\n', 'T042-CYCLE-06 a receives b bytes');
  assert.equal(await readFile(b, 'utf8'), 'alpha\n', 'T042-CYCLE-07 b receives a bytes');
  assert.equal(applied.value.journal.steps.some((step) => step.from.includes('.xi-operation-cycle')), true, 'T042-CYCLE-08 journal records durable temporary steps');

  const restored = await service.restoreApplied(applied.value.journal, token);
  assert.equal(restored.ok, true, 'T042-RESTORE-01 applied operation restores');
  assert.equal(await readFile(a, 'utf8'), 'alpha\n', 'T042-RESTORE-02 restore returns original a');
  assert.equal(await readFile(b, 'utf8'), 'beta\n', 'T042-RESTORE-03 restore returns original b');

  const caseDirectory = join(root, 'case');
  const lower = join(caseDirectory, 'readme');
  const upper = join(caseDirectory, 'README');
  await mkdir(caseDirectory);
  await writeFile(lower, 'case');
  const caseDraft = DirectoryDraft.create(caseDirectory, [{ id: 'readme', name: 'readme', path: lower, stableIdentity: 'case' }], { caseSensitive: false });
  assert.equal(caseDraft.ok, true, 'T042-CASE-01 case draft initializes');
  if (!caseDraft.ok) return;
  assert.equal(caseDraft.value.rename('readme', 'README').ok, true, 'T042-CASE-02 case-only draft rename compiles');
  const casePlan = caseDraft.value.compilePlan();
  assert.equal(casePlan.ok, true, 'T042-CASE-03 case-only plan compiles');
  if (!casePlan.ok) return;
  const caseResult = await service.apply(casePlan.value, token, { operationId: 'case' });
  assert.equal(caseResult.ok, true, 'T042-CASE-04 case-only rename uses a temporary path');
  assert.equal(await readFile(upper, 'utf8'), 'case', 'T042-CASE-05 case-only destination has exact bytes');
}

async function testCopyTrashAndDraftUndoRemainSeparate(root: string): Promise<void> {
  const directory = join(root, 'trash');
  await mkdir(directory);
  const source = join(directory, 'source.txt');
  const copy = join(directory, 'copy.txt');
  const removed = join(directory, 'removed.txt');
  await writeFile(source, 'source');
  await writeFile(removed, 'removed');
  const plan: DirectoryOperationPlan = {
    contractVersion: 1,
    directoryPath: directory,
    baseGeneration: 0,
    operations: [
      { kind: 'copy', rowId: 'copy', sourceId: 'source', sourcePath: source, destinationPath: copy },
      { kind: 'trash', rowId: 'trash', sourceId: 'removed', sourcePath: removed },
    ],
  };
  const service = new JournaledFilesystemOperations(new NodeFilesystemPort());
  const applied = await service.apply(plan, token, { operationId: 'trash' });
  assert.equal(applied.ok, true, 'T042-TRASH-01 copy/trash plan applies');
  if (!applied.ok) return;
  assert.equal(await readFile(copy, 'utf8'), 'source', 'T042-TRASH-02 copy preserves source bytes');
  await assert.rejects(readFile(removed, 'utf8'), 'T042-TRASH-03 trash removes source path');
  const trashPath = applied.value.journal.steps.find((step) => step.operationKind === 'trash')?.to;
  assert.ok(trashPath !== undefined && (await readFile(trashPath, 'utf8')) === 'removed', 'T042-TRASH-04 Xi recovery storage retains deleted bytes');
  const restored = await service.restoreApplied(applied.value.journal, token);
  assert.equal(restored.ok, true, 'T042-TRASH-05 applied restore is available');
  assert.equal(await readFile(removed, 'utf8'), 'removed', 'T042-TRASH-06 restore returns trashed bytes');
  await assert.rejects(readFile(copy, 'utf8'), 'T042-TRASH-07 restore removes an applied copy');

  const draft = DirectoryDraft.create(directory, [{ id: 'source', name: 'source.txt', path: source }]);
  assert.equal(draft.ok, true, 'T042-DRAFT-01 draft initializes');
  if (!draft.ok) return;
  assert.equal(draft.value.rename('source', 'renamed.txt').ok, true, 'T042-DRAFT-02 draft mutation is accepted');
  assert.equal(draft.value.undo().ok, true, 'T042-DRAFT-03 draft undo changes only the in-memory plan');
  const undonePlan = draft.value.compilePlan();
  assert.equal(undonePlan.ok, true, 'T042-DRAFT-04 undone draft remains compilable');
  if (undonePlan.ok) assert.equal(undonePlan.value.operations.length, 0, 'T042-DRAFT-05 draft undo is distinct from applied restore');
}

async function testExternalDestinationIsNeverClobbered(root: string): Promise<void> {
  const directory = join(root, 'external');
  await mkdir(directory);
  const source = join(directory, 'source.txt');
  const destination = join(directory, 'destination.txt');
  await writeFile(source, 'original');
  const plan: DirectoryOperationPlan = {
    contractVersion: 1,
    directoryPath: directory,
    baseGeneration: 0,
    operations: [{ kind: 'rename', rowId: 'rename', sourceId: 'source', from: 'source.txt', to: 'destination.txt', sourcePath: source, destinationPath: destination }],
  };
  const service = new JournaledFilesystemOperations(new NodeFilesystemPort(), {
    hooks: {
      will: async () => {
        await writeFile(destination, 'external');
        return { ok: true, value: undefined };
      },
    },
  });
  const result = await service.apply(plan, token, { operationId: 'external' });
  assert.equal(result.ok, false, 'T042-EXTERNAL-01 external destination fails after preflight');
  if (result.ok) return;
  assert.equal(result.error.kind, 'partial', 'T042-EXTERNAL-02 failure retains actionable journal');
  assert.equal(await readFile(destination, 'utf8'), 'external', 'T042-EXTERNAL-03 rollback never overwrites external destination');
  await assert.rejects(readFile(source, 'utf8'), 'T042-EXTERNAL-04 source is staged until the journal is explicitly restored');
  const restored = await new JournaledFilesystemOperations(new NodeFilesystemPort()).restoreApplied(result.error.journal, token);
  assert.equal(restored.ok, true, 'T042-EXTERNAL-05 restore recovers completed steps without touching external destination');
  assert.equal(await readFile(source, 'utf8'), 'original', 'T042-EXTERNAL-06 source is recoverable from the journal');
  assert.equal(await readFile(destination, 'utf8'), 'external', 'T042-EXTERNAL-07 restore still preserves external destination');
}

async function testCrossDeviceFallbackAndRetryAfterPartialFailure(root: string): Promise<void> {
  const directory = join(root, 'partial');
  await mkdir(directory);
  const source = join(directory, 'source.txt');
  const destination = join(directory, 'destination.txt');
  await writeFile(source, 'cross-device');
  const plan: DirectoryOperationPlan = {
    contractVersion: 1,
    directoryPath: directory,
    baseGeneration: 0,
    operations: [{ kind: 'rename', rowId: 'move', sourceId: 'source', from: 'source.txt', to: 'destination.txt', sourcePath: source, destinationPath: destination }],
  };
  const filesystem = new FaultFilesystem(new NodeFilesystemPort());
  filesystem.renameFailures = 1;
  filesystem.removeFailures = 1;
  const service = new JournaledFilesystemOperations(filesystem);
  const partial = await service.apply(plan, token, { operationId: 'partial' });
  assert.equal(partial.ok, false, 'T042-PARTIAL-01 injected delete failure produces partial result');
  if (partial.ok || partial.error.kind !== 'partial') return;
  assert.equal(await readFile(source, 'utf8'), 'cross-device', 'T042-PARTIAL-02 source remains after delete failure');
  const staged = partial.error.journal.steps[0]?.to;
  assert.ok(staged !== undefined && (await readFile(staged, 'utf8')) === 'cross-device', 'T042-PARTIAL-03 staged destination is retained for retry');
  const retried = await service.retry(partial.error.journal, token);
  assert.equal(retried.ok, true, 'T042-PARTIAL-04 retry reconciles a completed copy stage');
  assert.equal(await readFile(destination, 'utf8'), 'cross-device', 'T042-PARTIAL-05 retry preserves destination bytes');
  await assert.rejects(readFile(source, 'utf8'), 'T042-PARTIAL-06 retry completes source deletion');
  assert.equal(retried.ok && retried.value.journal.steps[0]?.method, 'copy-delete', 'T042-PARTIAL-07 journal identifies cross-device fallback');
}

class FaultFilesystem implements JournaledFilesystemPort {
  renameFailures = 0;
  removeFailures = 0;
  readonly #delegate: NodeFilesystemPort;
  constructor(delegate: NodeFilesystemPort) { this.#delegate = delegate; }
  readFile(path: string, cancellation: CancellationToken) { return this.#delegate.readFile(path, cancellation); }
  writeFileAtomic(path: string, contents: Uint8Array, cancellation: CancellationToken) { return this.#delegate.writeFileAtomic(path, contents, cancellation); }
  stat(path: string, cancellation: CancellationToken) { return this.#delegate.stat(path, cancellation); }
  watch(path: string, listener: (event: FileWatchEvent) => void, cancellation: CancellationToken): Promise<Result<Disposable, PlatformFailure>> { return this.#delegate.watch(path, listener, cancellation); }
  makeDirectory(path: string, cancellation: CancellationToken) { return this.#delegate.makeDirectory(path, cancellation); }
  async renamePath(from: string, to: string, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>> {
    if (this.renameFailures > 0) { this.renameFailures -= 1; return { ok: false, error: { code: 'EXDEV', message: 'injected cross-device move', retryable: true } }; }
    return this.#delegate.renamePath(from, to, cancellation);
  }
  copyPath(from: string, to: string, cancellation: CancellationToken) { return this.#delegate.copyPath(from, to, cancellation); }
  async removePath(path: string, recursive: boolean, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>> {
    if (this.removeFailures > 0) { this.removeFailures -= 1; return { ok: false, error: { code: 'EIO', message: 'injected remove failure', retryable: true } }; }
    return this.#delegate.removePath(path, recursive, cancellation);
  }
}

async function mkdir(path: string): Promise<void> {
  const result = await new NodeFilesystemPort().makeDirectory(path, token);
  if (!result.ok) throw new Error(result.error.message);
}

await main();
