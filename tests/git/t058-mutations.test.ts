import assert from 'node:assert/strict';
import { GitMutationCoordinator, type GitMutationExecutor } from '../../packages/services/git/index';

const argv: string[][] = [];
const executor: GitMutationExecutor = { async run(command, input) { argv.push([...command]); return { ok: true, value: { stdout: '', stderr: '', code: 0 } }; } };
const mutations = new GitMutationCoordinator(executor); const context = { root: '/repo', generation: 2, expectedGeneration: 2 };
assert.equal((await mutations.stage(['a.ts'], context)).ok, true); assert.deepEqual(argv[0], ['git', 'add', '--', 'a.ts']);
assert.equal((await mutations.unstage(['a.ts'], context)).ok, true); assert.equal((await mutations.discard(['a.ts'], context)).ok, true); assert.equal((await mutations.commit('message', context)).ok, true); assert.equal(argv[3]?.includes('-F'), true, 'T058-COMMIT-01 commit message passes stdin flag');
assert.equal((await mutations.commit('', context)).ok, false, 'T058-COMMIT-FAIL-01 empty commit blocked'); assert.equal((await mutations.stage(['a'], { ...context, expectedGeneration: 1 })).ok, false, 'T058-STALE-01 stale status blocks mutation');
mutations.dispose();
console.log('T058 Git mutations passed explicit stage/unstage/discard/commit argv, empty-message and stale-generation safeguards');
