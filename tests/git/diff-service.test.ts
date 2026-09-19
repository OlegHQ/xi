import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CancellationSource } from '../../packages/contracts/src/index';
import { NodeProcessPort } from '../../packages/platform/src/entrypoints/launch';
import { NodeFilesystemPort } from '../../packages/platform/src/entrypoints/launch';
import { GitDiffService } from '../../packages/services/git/diff';

async function git(root: string, args: readonly string[]): Promise<void> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
}

async function run(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'xi-diff-service-'));
  try {
    await git(root, ['init', '-q']);
    await git(root, ['config', 'user.email', 'test@example.com']);
    await git(root, ['config', 'user.name', 'Test']);
    await Bun.write(join(root, 'file.txt'), 'one\ntwo\nthree\n');
    await git(root, ['add', 'file.txt']);
    await git(root, ['commit', '-q', '-m', 'initial']);

    const service = new GitDiffService({ process: new NodeProcessPort(), filesystem: new NodeFilesystemPort() });

    // worktree target: no staged change, modify on disk only.
    await Bun.write(join(root, 'file.txt'), 'one\nTWO\nthree\n');
    const worktreeResult = await service.load({ root, relativePath: 'file.txt', target: 'worktree' });
    assert.ok(worktreeResult.ok, 'DIFF-SVC-01 worktree load succeeds');
    if (!worktreeResult.ok) return;
    assert.equal(worktreeResult.value.kind, 'ready', 'DIFF-SVC-02 worktree diff is ready');
    if (worktreeResult.value.kind !== 'ready') return;
    assert.equal(worktreeResult.value.leftLabel, 'INDEX');
    assert.equal(worktreeResult.value.rightLabel, 'WORKTREE');
    assert.equal(worktreeResult.value.diff.hunks.length, 1, 'DIFF-SVC-03 one hunk for the single-line worktree change');

    // Compare hunk line counts against `git diff --unified=3` (minimal parse: count @@ hunks).
    const diffProc = Bun.spawn({ cmd: ['git', 'diff', '--unified=3', '--', 'file.txt'], cwd: root, stdout: 'pipe' });
    const diffText = await new Response(diffProc.stdout).text();
    await diffProc.exited;
    const gitHunkCount = (diffText.match(/^@@/gm) ?? []).length;
    assert.equal(worktreeResult.value.diff.hunks.length, gitHunkCount, 'DIFF-SVC-04 hunk count matches `git diff` output');

    // index target: stage the change, HEAD vs INDEX now differs; worktree matches index.
    await git(root, ['add', 'file.txt']);
    const indexResult = await service.load({ root, relativePath: 'file.txt', target: 'index' });
    assert.ok(indexResult.ok);
    if (!indexResult.ok) return;
    assert.equal(indexResult.value.kind, 'ready', 'DIFF-SVC-05 index diff is ready');
    if (indexResult.value.kind !== 'ready') return;
    assert.equal(indexResult.value.leftLabel, 'BASE');
    assert.equal(indexResult.value.rightLabel, 'INDEX');
    assert.equal(indexResult.value.diff.hunks.length, 1, 'DIFF-SVC-06 staged single-line change is one hunk');

    // Missing side: a brand-new untracked file has no INDEX/HEAD side for the index target.
    await Bun.write(join(root, 'new.txt'), 'brand new\n');
    const missingIndexResult = await service.load({ root, relativePath: 'new.txt', target: 'index' });
    assert.ok(missingIndexResult.ok);
    if (!missingIndexResult.ok) return;
    assert.equal(missingIndexResult.value.kind, 'ready');
    if (missingIndexResult.value.kind !== 'ready') return;
    assert.ok(missingIndexResult.value.diff.lines.every((line) => line.kind !== 'removed'), 'DIFF-SVC-07 missing BASE side has no removed lines');

    // Binary content: NUL in the first 8 KiB.
    await Bun.write(join(root, 'binary.bin'), new Uint8Array([0, 1, 2, 3, 0, 5]));
    const binaryResult = await service.load({ root, relativePath: 'binary.bin', target: 'worktree' });
    assert.ok(binaryResult.ok);
    if (!binaryResult.ok) return;
    assert.equal(binaryResult.value.kind, 'binary', 'DIFF-SVC-08 NUL bytes classify as binary');

    // Cancellation
    const cancellation = new CancellationSource();
    cancellation.cancel();
    const cancelledResult = await service.load({ root, relativePath: 'file.txt', target: 'worktree', cancellation: cancellation.token });
    assert.ok(!cancelledResult.ok, 'DIFF-SVC-09 a pre-cancelled load reports failure, not a stale result');

    console.log('T-diff-service GitDiffService passed index/worktree/missing/binary/cancellation cases against a real git repo');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await run();
