#!/usr/bin/env bun
// Regression coverage for two related bugs:
// 1. porcelain v2 'u' (unmerged/conflict) records: path is field index 10, not 11.
// 2. GitStatusService must only latch #notRepo permanently for an actual
//    "not a git repository" failure (exit 128 + that stderr text); any other non-zero
//    exit is transient and refresh() must keep retrying.
import assert from 'node:assert/strict';
import type { PlatformFailure, ProcessHandle, ProcessInput, ProcessPort, ProcessSpec, Result } from '../../packages/contracts/src/index';
import { GitStatusService, parsePorcelainV2Z } from '../../packages/services/git/index';

function testUnmergedRecordPathField(): void {
  const output = 'u UU N... 100644 100644 100644 100644 aaaa1111 bbbb2222 cccc3333 conflicted/path with spaces.ts\0';
  const parsed = parsePorcelainV2Z('/repo', new TextEncoder().encode(output), 1);
  assert.equal(parsed.ok, true, 'T-PORC-U-01 unmerged record parses');
  if (!parsed.ok) return;
  const entry = parsed.value.entries[0];
  assert.equal(entry?.path, 'conflicted/path with spaces.ts', 'T-PORC-U-02 path is field index 10, not shifted by one');
  assert.equal(entry?.conflict, true, 'T-PORC-U-03 unmerged record is a conflict');
}

function handle(code: number, stderrText: string): ProcessHandle {
  return {
    stdin: { write: async () => ({ ok: true, value: undefined }), close: async () => ({ ok: true, value: undefined }), dispose() {} },
    stdout: (async function* () {})(),
    stderr: (async function* () { yield new TextEncoder().encode(stderrText); })(),
    exit: Promise.resolve({ ok: true, value: { code, signal: null } }),
    terminate: async () => {},
    dispose() {},
  };
}

async function testTransientFailureKeepsRetrying(): Promise<void> {
  let callCount = 0;
  const port: ProcessPort = {
    async spawn(_spec: ProcessSpec): Promise<Result<ProcessHandle, PlatformFailure>> {
      callCount += 1;
      // A transient failure unrelated to repo existence (e.g. a lock file held briefly).
      return { ok: true, value: handle(128, 'fatal: Unable to create index.lock: File exists.') };
    },
  };
  const service = new GitStatusService({ process: port, root: '/repo' });
  await service.refresh();
  await service.refresh();
  assert.equal(callCount, 2, 'T-PORC-NOTREPO-01 a non-"not a git repository" failure keeps retrying');
  service.dispose();
}

async function testActualNotRepoLatches(): Promise<void> {
  let callCount = 0;
  const port: ProcessPort = {
    async spawn(_spec: ProcessSpec): Promise<Result<ProcessHandle, PlatformFailure>> {
      callCount += 1;
      return { ok: true, value: handle(128, 'fatal: not a git repository (or any of the parent directories): .git') };
    },
  };
  const service = new GitStatusService({ process: port, root: '/not-repo' });
  await service.refresh();
  await service.refresh();
  assert.equal(callCount, 1, 'T-PORC-NOTREPO-02 an actual not-a-git-repository failure latches and stops retrying');
  service.dispose();
}

async function main(): Promise<void> {
  testUnmergedRecordPathField();
  await testTransientFailureKeepsRetrying();
  await testActualNotRepoLatches();
  console.log('T-PORC-CONFLICT porcelain unmerged path field and not-repo latching passed');
}

await main();
