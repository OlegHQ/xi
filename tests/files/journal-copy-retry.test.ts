#!/usr/bin/env bun
// Regression coverage: retrying a journal whose 'copy' step already completed on disk (but
// was not yet marked completed in the persisted journal, e.g. a crash between the copy and
// the journal write) must never delete the user's original file. Only 'move' steps may
// remove their source during reconciliation.
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CancellationSource } from '../../packages/contracts/src/index';
import { JournaledFilesystemOperations, type FileOperationJournal } from '../../packages/services/files/index';
import { NodeFilesystemPort } from '../../packages/platform/src/index';

const token = new CancellationSource().token;

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'xi-copy-retry-'));
  try {
    await testRetryAfterUnrecordedCopyKeepsSource(root);
    console.log('T-COPY-RETRY retry never deletes an intact copy source');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testRetryAfterUnrecordedCopyKeepsSource(root: string): Promise<void> {
  const directory = join(root, 'copy');
  await new NodeFilesystemPort().makeDirectory(directory, token);
  const source = join(directory, 'source.txt');
  const destination = join(directory, 'destination.txt');
  await writeFile(source, 'keep-me');
  const plan = {
    contractVersion: 1 as const,
    directoryPath: directory,
    baseGeneration: 0,
    operations: [{ kind: 'copy' as const, rowId: 'copy', sourceId: 'source', sourcePath: source, destinationPath: destination }],
  };
  const service = new JournaledFilesystemOperations(new NodeFilesystemPort());
  const applied = await service.apply(plan, token, { operationId: 'copy-retry' });
  assert.equal(applied.ok, true, 'T-COPY-RETRY-01 copy plan applies');
  if (!applied.ok) return;
  assert.equal(await readFile(source, 'utf8'), 'keep-me', 'T-COPY-RETRY-02 copy leaves source intact');
  assert.equal(await readFile(destination, 'utf8'), 'keep-me', 'T-COPY-RETRY-03 copy writes destination');

  // Simulate a crash between the physical copy completing and the journal recording it: the
  // step is marked incomplete even though the disk already reflects the finished copy.
  const staleJournal: FileOperationJournal = {
    ...applied.value.journal,
    status: 'partial',
    steps: applied.value.journal.steps.map((step) => ({ ...step, completed: false })),
  };
  const retried = await service.retry(staleJournal, token);
  assert.equal(retried.ok, true, 'T-COPY-RETRY-04 retry reconciles the already-applied copy');
  assert.equal(await readFile(source, 'utf8'), 'keep-me', 'T-COPY-RETRY-05 retry does not delete the copy source');
  assert.equal(await readFile(destination, 'utf8'), 'keep-me', 'T-COPY-RETRY-06 destination bytes are unaffected');
  if (retried.ok) {
    assert.equal(retried.value.journal.steps[0]?.method, 'copy', 'T-COPY-RETRY-07 reconciled step keeps a copy method, not copy-delete');
  }
}

await main();
