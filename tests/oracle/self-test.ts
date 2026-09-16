import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertRuntimeDocsMatch,
  assertVersionMatches,
  compareSnapshot,
  verifyOracleBundle,
} from './oracle-runner';

export async function runHarnessSelfTests(): Promise<readonly string[]> {
  const passed: string[] = [];

  const inclusiveRangeDiff = compareSnapshot({ lines: ['two'] }, { lines: ['wo'] });
  assert(inclusiveRangeDiff.some((line) => line.startsWith('$.lines[0]')));
  passed.push('ORC-MUTATION-RANGE-01');

  const byteColumnDiff = compareSnapshot(
    { cursor: { byteColumn: 3 } },
    { cursor: { byteColumn: 2 } },
  );
  assert(byteColumnDiff.some((line) => line.startsWith('$.cursor.byteColumn')));
  passed.push('ORC-MUTATION-BYTE-01');

  const minimized = await minimizeSequence(['d', 'w', 'x', 'j'], async (keys) => {
    const faultyInclusiveEndpoint = keys.includes('d') && keys.includes('w');
    return faultyInclusiveEndpoint && compareSnapshot({ lines: ['two'] }, { lines: ['wo'] }).length > 0;
  });
  assert.deepEqual(minimized, ['d', 'w']);
  passed.push('ORC-MINIMIZE-RANGE-01');

  assert.throws(
    () => assertVersionMatches(['NVIM v0.12.4'], ['NVIM v0.12.3']),
    /neovim-version-output-mismatch/u,
  );
  assert.throws(
    () => assertRuntimeDocsMatch(136, 'expected-doc-hash', 136, 'stale-doc-hash'),
    /neovim-runtime-doc-hash-mismatch/u,
  );
  passed.push('ORC-MANIFEST-MISMATCH-01');

  const root = await mkdtemp(join(tmpdir(), 'xi-nvim-missing-'));
  try {
    await assert.rejects(
      () => verifyOracleBundle(join(root, 'missing-nvim')),
      /pinned-neovim-oracle-missing/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  passed.push('ORC-MISSING-01');
  return passed;
}

export async function minimizeSequence<T>(
  source: readonly T[],
  stillFails: (candidate: readonly T[]) => Promise<boolean>,
): Promise<T[]> {
  let current = [...source];
  if (!(await stillFails(current))) return current;
  let granularity = 2;

  while (current.length > 1) {
    const chunkSize = Math.ceil(current.length / granularity);
    let reduced = false;
    for (let start = 0; start < current.length; start += chunkSize) {
      const end = Math.min(current.length, start + chunkSize);
      const candidate = current.filter((_item, index) => index < start || index >= end);
      if (await stillFails(candidate)) {
        current = candidate;
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }
    if (reduced) continue;
    if (granularity >= current.length) break;
    granularity = Math.min(current.length, granularity * 2);
  }
  return current;
}
