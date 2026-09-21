import assert from 'node:assert/strict';
import type { PlatformFailure, ProcessHandle, ProcessInput, ProcessPort, ProcessSpec, Result } from '../../packages/contracts/src/index';
import { GitStatusService } from '../../packages/services/git/index';

function immediateHandle(stdoutText: string, code: number): ProcessHandle {
  const encoded = new TextEncoder().encode(stdoutText);
  const stdin: ProcessInput = { write: async () => ({ ok: true, value: undefined }), close: async () => ({ ok: true, value: undefined }), dispose() {} };
  return {
    stdin,
    stdout: (async function* () { yield encoded; })(),
    stderr: (async function* () {})(),
    exit: Promise.resolve({ ok: true, value: { code, signal: null } }),
    terminate: async () => {},
    dispose() {},
  };
}

async function run(): Promise<void> {
  const branchOutput = '# branch.head main\0' + '1 .M N... 100644 100644 100644 abc def file.ts\0';
  let callCount = 0;
  const port: ProcessPort = {
    async spawn(_spec: ProcessSpec): Promise<Result<ProcessHandle, PlatformFailure>> {
      callCount += 1;
      const local = callCount;
      if (local === 1) await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, value: immediateHandle(branchOutput, 0) };
    },
  };
  const service = new GitStatusService({ process: port, root: '/repo' });
  const seen: number[] = [];
  service.subscribe((snapshot) => seen.push(snapshot.generation));

  const first = service.refresh();
  const second = service.refresh(); // requested while first is running: coalesced into one rerun
  await Promise.all([first, second]);
  assert.ok(callCount <= 2, 'T073-COALESCE-01 concurrent refresh coalesces into at most one rerun');
  assert.ok(seen.length >= 1, 'T073-PUBLISH-01 status service publishes a snapshot');
  for (let index = 1; index < seen.length; index += 1) {
    assert.ok(seen[index]! > seen[index - 1]!, 'T073-GEN-01 generations increase monotonically');
  }

  const notRepoPort: ProcessPort = { async spawn() { return { ok: false, error: { code: 'not-a-repo', message: 'not a git repository', retryable: false } }; } };
  const notRepoService = new GitStatusService({ process: notRepoPort, root: '/not-repo' });
  let notRepoPublishCount = 0;
  notRepoService.subscribe(() => { notRepoPublishCount += 1; });
  await notRepoService.refresh();
  assert.equal(notRepoService.snapshot?.entries.length, 0, 'T073-NOREPO-01 non-repo publishes an empty snapshot');
  await notRepoService.refresh();
  assert.equal(notRepoPublishCount, 1, 'T073-NOREPO-02 non-repo stops retrying after first empty publish');
  let allowed = true;
  let policySpawns = 0;
  const policyPort: ProcessPort = { async spawn() { policySpawns += 1; return { ok: true, value: immediateHandle(branchOutput, 0) }; } };
  const policyService = new GitStatusService({ process: policyPort, root: '/repo', allowed: () => allowed });
  await policyService.refresh();
  assert.equal(policyService.snapshot?.entries.length, 1, 'T073-TRUST-01 trusted status is visible');
  allowed = false;
  await policyService.refresh();
  assert.equal(policyService.snapshot?.entries.length, 0, 'T073-TRUST-02 revocation clears cached status');
  await policyService.refresh();
  assert.equal(policySpawns, 1, 'T073-TRUST-03 revoked status does not spawn Git');
  allowed = true;
  await policyService.refresh();
  assert.equal(policySpawns, 2, 'T073-TRUST-04 granting trust starts Git without reconstructing the service');
  policyService.dispose();
  service.dispose();
  notRepoService.dispose();
  console.log('T073 Git status service passed coalesced refresh, monotonic generations and non-repo stop-retry');
}

void run();
