import assert from 'node:assert/strict';
import { GitMutationCoordinator, type GitMutationExecutor } from '../../packages/services/git/index';

const commands: string[][] = []; const executor: GitMutationExecutor = { async run(argv) { commands.push([...argv]); return { ok: true, value: { stdout: '', stderr: '', code: 0 } }; } };
const coordinator = new GitMutationCoordinator(executor); const context = { root: '/repo', generation: 1, expectedGeneration: 1 };
assert.equal((await coordinator.checkoutBranch('feature/x', context)).ok, true); assert.equal((await coordinator.stash('push', context, 'save')).ok, true); assert.equal((await coordinator.remote('fetch', 'origin', context)).ok, true); assert.equal(commands.some((command) => command[1] === 'push'), false, 'T072-NET-01 no implicit push occurs'); assert.equal((await coordinator.remote('fetch', '-bad', context)).ok, false, 'T072-FAIL-01 remote args are validated'); coordinator.dispose();
console.log('T072 Git branch/stash/remote passed argv validation and explicit no-automatic-network semantics');
