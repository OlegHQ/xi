import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CancellationSource } from '../../packages/contracts/src/index';
import { NodeFilesystemPort } from '../../packages/platform/src/entrypoints/launch';

const root = await mkdtemp(join(tmpdir(), 'xi-exclusive-create-'));
try {
  const filesystem = new NodeFilesystemPort();
  const existingPath = join(root, 'existing.txt');
  await writeFile(existingPath, 'preserve me\n');
  const existing = await filesystem.createFileExclusive(existingPath, new CancellationSource().token);
  assert.equal(existing.ok, false, 'T-EXCLUSIVE-CREATE-01 existing files reject exclusive creation');
  if (!existing.ok) assert.equal(existing.error.code, 'EEXIST', 'T-EXCLUSIVE-CREATE-02 conflict is distinguishable');
  assert.equal(await readFile(existingPath, 'utf8'), 'preserve me\n', 'T-EXCLUSIVE-CREATE-03 conflict preserves existing content');

  const newPath = join(root, 'new.txt');
  const created = await filesystem.createFileExclusive(newPath, new CancellationSource().token);
  assert.equal(created.ok, true, 'T-EXCLUSIVE-CREATE-04 missing target is created');
  assert.equal(await readFile(newPath, 'utf8'), '', 'T-EXCLUSIVE-CREATE-05 new file starts empty');

  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(workspace, 'inside.txt'), 'inside');
  await writeFile(join(outside, 'secret.txt'), 'outside');
  await symlink(outside, join(workspace, 'escape'));
  const inside = await filesystem.isWithinRealWorkspace(workspace, join(workspace, 'inside.txt'), new CancellationSource().token);
  assert.deepEqual(inside, { ok: true, value: true }, 'T-EXCLUSIVE-CREATE-06 real path under workspace is allowed');
  const escaped = await filesystem.isWithinRealWorkspace(workspace, join(workspace, 'escape', 'secret.txt'), new CancellationSource().token);
  assert.deepEqual(escaped, { ok: true, value: false }, 'T-EXCLUSIVE-CREATE-07 symlink target outside workspace is rejected');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('T-EXCLUSIVE-CREATE passed atomic conflict preservation and empty creation');
