#!/usr/bin/env bun
// Regression coverage for F2-7: GitStatusService.dispose() must cancel an in-flight `git
// status` child process (instead of leaving its CancellationSource never cancelled) and must
// not publish/notify listeners with a stale result that resolves after dispose.
import assert from 'node:assert/strict';
import type { CancellationToken, PlatformFailure, ProcessHandle, ProcessInput, ProcessPort, ProcessSpec, Result } from '../../packages/contracts/src/index';
import { GitStatusService } from '../../packages/services/git/index';

async function run(): Promise<void> {
  let capturedToken: CancellationToken | undefined;
  let disposeCalls = 0;
  let resolveExit: ((value: Result<{ readonly code: number | null; readonly signal: string | null }, PlatformFailure>) => void) | undefined;
  const stdin: ProcessInput = { write: async () => ({ ok: true, value: undefined }), close: async () => ({ ok: true, value: undefined }), dispose() {} };
  const port: ProcessPort = {
    async spawn(spec: ProcessSpec): Promise<Result<ProcessHandle, PlatformFailure>> {
      capturedToken = spec.cancellation;
      const handle: ProcessHandle = {
        stdin,
        stdout: (async function* () { yield new TextEncoder().encode('# branch.head main\0'); })(),
        stderr: (async function* () {})(),
        exit: new Promise((resolve) => { resolveExit = resolve; }),
        terminate: async () => {},
        dispose() { disposeCalls += 1; },
      };
      return { ok: true, value: handle };
    },
  };

  const service = new GitStatusService({ process: port, root: '/repo' });
  let publishedAfterDispose = false;
  service.subscribe(() => { publishedAfterDispose = true; });

  const pending = service.refresh();
  assert.ok(capturedToken !== undefined, 'sanity: the status process was spawned');
  assert.equal(capturedToken?.isCancelled, false, 'sanity: the spawn cancellation token starts uncancelled');

  service.dispose();
  assert.equal(capturedToken?.isCancelled, true, 'F2-7: dispose() cancels the in-flight git status child process instead of leaving it running');

  // The process resolves (as a real, already-running child process would) after dispose has
  // already run; this must not resurrect a publish/notification for a disposed service.
  resolveExit?.({ ok: true, value: { code: 0, signal: null } });
  await pending;
  assert.equal(publishedAfterDispose, false, 'F2-7: a stale in-flight result must not notify listeners after dispose');

  console.log('T-GIT-DISPOSE-INFLIGHT passed: dispose cancels the in-flight status process and suppresses its stale publish');
}

void run();
