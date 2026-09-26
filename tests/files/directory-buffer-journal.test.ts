import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CancellationSource, type CancellationToken, type PlatformFailure, type Result } from '../../packages/contracts/src/index';
import { NodeFilesystemPort } from '../../packages/platform/src/filesystem';
import { JournaledFilesystemOperations } from '../../packages/services/files/journaled-operations';
import type { DirectoryOperationPlan } from '../../packages/services/files/directory-draft';

class FailingCreationFilesystem extends NodeFilesystemPort {
  fail = false;
  override async createFileExclusive(path: string, cancellation: CancellationToken): Promise<Result<void, PlatformFailure>> {
    return this.fail && path.endsWith('/second.txt') ? { ok: false, error: { code: 'injected', message: 'injected create failure', retryable: false } } : super.createFileExclusive(path, cancellation);
  }
}
const root = await mkdtemp(join(tmpdir(), 'xi-files-create-journal-'));
const filesystem = new FailingCreationFilesystem();
const service = new JournaledFilesystemOperations(filesystem);
const cancellation = new CancellationSource();
const plan = (entries: readonly [string, boolean][]): DirectoryOperationPlan => ({ contractVersion: 1, directoryPath: root, baseGeneration: 0, operations: entries.map(([name, directory], index) => ({ kind: 'create', rowId: String(index), sourcePath: `${root}/${name}`, destinationPath: `${root}/${name}`, directory })) });
try {
  const created = await service.apply(plan([['nested', true], ['nested/deep', true], ['nested/deep/file.txt', false]]), cancellation.token);
  assert.ok(created.ok, 'reviewed nested creates apply');
  const persisted = await service.readJournal(created.value.journal.journalPath, cancellation.token);
  assert.ok(persisted.ok, 'create steps survive the validated journal boundary');
  assert.equal(await readFile(`${root}/nested/deep/file.txt`, 'utf8'), '');
  const restored = await service.restoreApplied(created.value.journal, cancellation.token);
  assert.ok(restored.ok, 'create restore safely removes own children and their now-empty parents');
  assert.ok(!(await readdir(root)).includes('nested'));

  await writeFile(`${root}/occupied.txt`, 'external');
  const collision = await service.apply(plan([['first.txt', false], ['occupied.txt', false]]), cancellation.token);
  assert.equal(collision.ok, false, 'preflight refuses existing create destination');
  assert.ok(!(await readdir(root)).includes('first.txt'), 'preflight failure creates nothing');
  assert.equal(await readFile(`${root}/occupied.txt`, 'utf8'), 'external', 'collision preserves external content');

  filesystem.fail = true;
  const partial = await service.apply(plan([['first.txt', false], ['second.txt', false]]), cancellation.token);
  assert.ok(!partial.ok && partial.error.kind === 'partial', 'failure after one create leaves a recoverable journal');
  if (partial.ok || partial.error.kind !== 'partial') throw new Error('expected partial creation');
  assert.equal(partial.error.journal.steps[0]?.completed, true, 'completed create was journaled');
  filesystem.fail = false;
  const retried = await service.retry(partial.error.journal, cancellation.token);
  assert.ok(retried.ok, 'retry resumes only the missing create');
  await writeFile(`${root}/second.txt`, 'changed externally');
  const refused = await service.restoreApplied(retried.value.journal, cancellation.token);
  assert.equal(refused.ok, false, 'restore refuses edited created content');
  assert.equal(await readFile(`${root}/second.txt`, 'utf8'), 'changed externally');

  const uncertain = await service.retry({ ...retried.value.journal, status: 'running', steps: retried.value.journal.steps.map((step) => ({ ...step, completed: false, after: undefined })) }, cancellation.token);
  assert.equal(uncertain.ok, false, 'crash without completion evidence refuses to adopt an existing path');
  assert.equal(await readFile(`${root}/second.txt`, 'utf8'), 'changed externally');
  cancellation.cancel();
  assert.equal((await service.apply(plan([['cancelled.txt', false]]), cancellation.token)).ok, false, 'cancelled apply does not create');
  assert.ok(!(await readdir(root)).includes('cancelled.txt'));
  console.log('Directory creates passed journal round-trip, nested restore, collision, partial failure/retry, ambiguous crash, external-change refusal and cancellation');
} finally { cancellation.dispose(); service.dispose(); await rm(root, { recursive: true, force: true }); }
