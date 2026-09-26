import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CancellationSource } from '../../packages/primitives/src/index';
import { NodeFilesystemPort } from '../../packages/platform/src/index';
import { loadJumpHistory, saveJumpHistory } from '../../packages/services/persistence/jumps';

const directory = await mkdtemp(join(tmpdir(), 'xi-jump-history-'));
const path = join(directory, 'jumps.json');
const filesystem = new NodeFilesystemPort();
const cancellation = new CancellationSource();
try {
  assert.deepEqual(await loadJumpHistory(filesystem, path, cancellation.token), { ok: true, value: [] });
  const entries = [{ path: '/workspace/unicode-雪.md', line: 3, columnUtf16: 2 }];
  assert.ok((await saveJumpHistory(filesystem, path, entries, cancellation.token)).ok);
  assert.deepEqual(await loadJumpHistory(filesystem, path, cancellation.token), { ok: true, value: entries });
  for (const contents of [
    '{broken', JSON.stringify({ version: 2, entries }),
    JSON.stringify({ version: 1, entries: [{ path: 'relative', line: 0, columnUtf16: 0 }] }),
    JSON.stringify({ version: 1, entries: [{ path: '/file', line: -1, columnUtf16: 0 }] }),
    JSON.stringify({ version: 1, entries: [{ path: '/file', line: 0, columnUtf16: 0.5 }] }),
    JSON.stringify({ version: 1, entries: Array(101).fill(entries[0]) }),
    ' '.repeat(1024 * 1024 + 1),
  ]) {
    await writeFile(path, contents);
    assert.equal((await loadJumpHistory(filesystem, path, cancellation.token)).ok, false);
  }
  assert.ok((await saveJumpHistory(filesystem, path, Array(120).fill(entries[0]), cancellation.token)).ok);
  const bounded = await loadJumpHistory(filesystem, path, cancellation.token);
  assert.ok(bounded.ok && bounded.value.length === 100);
  cancellation.cancel();
  assert.equal((await loadJumpHistory(filesystem, path, cancellation.token)).ok, false);
  assert.equal((await saveJumpHistory(filesystem, path, entries, cancellation.token)).ok, false);
} finally {
  cancellation.dispose();
  await rm(directory, { recursive: true, force: true });
}
console.log('Jump history persistence: bounds, schema, Unicode, missing state and cancellation passed');
