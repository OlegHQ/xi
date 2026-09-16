import assert from 'node:assert/strict';
import { TaskController, type TaskProcess, type TaskProcessFactory } from '../../packages/services/tasks/index';
import type { Disposable, Result } from '../../packages/contracts/src/index';

let stdout: ((bytes: Uint8Array) => void) | undefined; let stderr: ((bytes: Uint8Array) => void) | undefined; let resolveExit: ((value: Result<{ readonly code: number | null; readonly signal: string | null }, { readonly kind: 'failed'; readonly message: string }>) => void) | undefined;
const process: TaskProcess = { exit: new Promise((resolve) => { resolveExit = resolve; }), onStdout(listener) { stdout = listener; return { dispose() { stdout = undefined; } }; }, onStderr(listener) { stderr = listener; return { dispose() { stderr = undefined; } }; }, async terminate() {}, dispose() {} };
const factory: TaskProcessFactory = { async spawn() { return { ok: true, value: process }; } };
const tasks = new TaskController(factory, 1024); await tasks.start({ id: 'build', argv: ['echo', 'x'], cwd: '/tmp' }); stdout?.(new TextEncoder().encode('x'.repeat(2048))); stderr?.(new TextEncoder().encode('err')); assert.equal(tasks.snapshot.truncated, true, 'T060-OUTPUT-01 output is bounded'); resolveExit?.({ ok: true, value: { code: 0, signal: null } }); await new Promise((resolve) => setTimeout(resolve, 0)); assert.equal(tasks.snapshot.state, 'exited', 'T060-EXIT-01 exit status is retained'); await tasks.cancel(); tasks.dispose();
console.log('T060 tasks passed bounded stdout/stderr retention, exit status and disposal/cancellation lifecycle');
