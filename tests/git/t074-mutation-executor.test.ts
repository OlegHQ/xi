import assert from 'node:assert/strict';
import type { PlatformFailure, ProcessHandle, ProcessInput, ProcessPort, ProcessSpec, Result } from '../../packages/contracts/src/index';
import { createProcessGitMutationExecutor } from '../../packages/services/git/index';

function fakeHandle(writes: string[]): ProcessHandle {
  const decoder = new TextDecoder();
  const stdin: ProcessInput = {
    write: async (bytes) => { writes.push(decoder.decode(bytes)); return { ok: true, value: undefined }; },
    close: async () => ({ ok: true, value: undefined }),
    dispose() {},
  };
  return {
    stdin,
    stdout: (async function* () { yield new TextEncoder().encode('ok\n'); })(),
    stderr: (async function* () {})(),
    exit: Promise.resolve({ ok: true, value: { code: 0, signal: null } }),
    terminate: async () => {},
    dispose() {},
  };
}

async function run(): Promise<void> {
  const writes: string[] = [];
  let capturedArgv: readonly string[] = [];
  const port: ProcessPort = {
    async spawn(spec: ProcessSpec): Promise<Result<ProcessHandle, PlatformFailure>> {
      capturedArgv = spec.argv;
      return { ok: true, value: fakeHandle(writes) };
    },
  };
  const executor = createProcessGitMutationExecutor(port, '/repo');
  const result = await executor.run(['git', 'commit', '-F', '-'], 'my message');
  assert.equal(result.ok, true, 'T074-RUN-01 executor reports success');
  if (result.ok) { assert.equal(result.value.code, 0); assert.equal(result.value.stdout, 'ok\n'); }
  assert.deepEqual(capturedArgv, ['git', 'commit', '-F', '-'], 'T074-ARGV-01 argv passed through unchanged');
  assert.equal(writes.join(''), 'my message', 'T074-STDIN-01 commit message goes through stdin, not argv');
  console.log('T074 Git mutation executor passed argv passthrough and stdin commit message delivery');
}

void run();
