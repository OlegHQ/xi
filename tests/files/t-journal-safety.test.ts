#!/usr/bin/env bun
// Regression coverage for F2-9:
//  - validatePlan must reject a relative directoryPath (joinPath used to silently rewrite it
//    into an absolute path rooted at "/", writing the journal/trash outside the workspace).
//  - a final journal write failure (marking an otherwise fully-applied operation 'applied')
//    must be reported as a failure, not silently reported as success while the on-disk journal
//    still says something else -- a crash right after would leave recovery reading a journal
//    that disagrees with what the caller was told happened.
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CancellationSource, type CancellationToken, type FileWatchEvent, type PlatformFailure, type Result } from '../../packages/contracts/src/index';
import { JournaledFilesystemOperations, type JournaledFilesystemPort } from '../../packages/services/files/journaled-operations';
import { NodeFilesystemPort } from '../../packages/platform/src/index';

const token = new CancellationSource().token;

function withSelectiveWriteFailure(real: NodeFilesystemPort, failPath: string, failOnCall: number): JournaledFilesystemPort {
  let calls = 0;
  return {
    readFile: real.readFile.bind(real),
    watch: real.watch.bind(real) as (path: string, listener: (event: FileWatchEvent) => void, cancellation: CancellationToken) => Promise<Result<{ dispose(): void }, PlatformFailure>>,
    stat: real.stat.bind(real),
    makeDirectory: real.makeDirectory.bind(real),
    renamePath: real.renamePath.bind(real),
    copyPath: real.copyPath.bind(real),
    removePath: real.removePath.bind(real),
    async writeFileAtomic(path: string, contents: Uint8Array, cancellation: CancellationToken) {
      if (path === failPath) {
        calls += 1;
        if (calls === failOnCall) return { ok: false, error: { code: 'EIO', message: 'simulated journal write failure', retryable: false } } as Result<void, PlatformFailure>;
      }
      return real.writeFileAtomic(path, contents, cancellation);
    },
  };
}

async function relativeDirectoryPathIsRejected(root: string): Promise<void> {
  const service = new JournaledFilesystemOperations(new NodeFilesystemPort());
  const a = join(root, 'a.txt');
  await writeFile(a, 'alpha\n');
  const applied = await service.apply({
    contractVersion: 1,
    directoryPath: 'relative/path',
    baseGeneration: 0,
    operations: [{ kind: 'trash', rowId: 'a', sourceId: 'a', sourcePath: a }],
  }, token);
  assert.equal(applied.ok, false, 'F2-9: a relative directoryPath must be rejected outright');
  if (!applied.ok) assert.equal(applied.error.kind, 'invalid-plan', 'F2-9: a relative directoryPath is reported as an invalid plan, not silently rewritten to root');
}

async function finalJournalWriteFailureIsReportedNotSilentlySuccess(root: string): Promise<void> {
  const directory = join(root, 'final-write-fail');
  await mkdir(directory);
  const a = join(directory, 'a.txt');
  await writeFile(a, 'alpha\n');
  const operationId = 'final-fail';
  const journalPath = join(directory, '.xi', 'operations', `${operationId}.json`);
  // No operations: the loop over steps never runs, so the only remaining journal write for
  // this path after the initial 'running' write is the final updateStatus(..., 'applied', ...)
  // this test targets.
  const filesystem = withSelectiveWriteFailure(new NodeFilesystemPort(), journalPath, 2);
  const service = new JournaledFilesystemOperations(filesystem);
  const applied = await service.apply({
    contractVersion: 1,
    directoryPath: directory,
    baseGeneration: 0,
    operations: [],
  }, token, { operationId });
  assert.equal(applied.ok, false, 'F2-9: apply() must not report success when the final "applied" journal write itself failed');
  if (!applied.ok) assert.equal(applied.error.kind, 'partial', 'F2-9: the failure is reported as partial, not swallowed');
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'xi-t-journal-safety-'));
  try {
    await relativeDirectoryPathIsRejected(root);
    await finalJournalWriteFailureIsReportedNotSilentlySuccess(root);
    console.log('T-JOURNAL-SAFETY passed: relative directoryPath rejected and a failed final journal write is reported, not masked as success (F2-9)');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main();
