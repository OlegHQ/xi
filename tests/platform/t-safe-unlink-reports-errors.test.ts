#!/usr/bin/env bun
// Regression coverage for F2-11: the platform filesystem's temp-file cleanup (safeUnlink) must
// report a genuine non-ENOENT unlink failure (EPERM, EISDIR, EBUSY, ...) instead of silently
// swallowing it -- the old condition returned from the catch block regardless of the error
// code, so both branches behaved identically and any real cleanup failure vanished.
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CancellationSource } from '../../packages/contracts/src/index';
import { NodeFilesystemPort } from '../../packages/platform/src/index';

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'xi-t-safe-unlink-'));
  try {
    const target = join(dir, 'target.txt');
    const filesystem = new NodeFilesystemPort();
    const cancellation = new CancellationSource();
    const encoder = new TextEncoder();

    // Cancels mid-write (after the temp file exists) and, right as the write loop is about to
    // notice the cancellation and clean up, replaces the temp file with a directory of the
    // same name -- unlink on a directory fails with a real (non-ENOENT) error on Linux, the
    // same class of failure (EPERM/EBUSY/EISDIR) the finding is about.
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield encoder.encode('first-chunk');
      cancellation.cancel();
      const entries = await readdir(dir);
      const tempName = entries.find((name) => name.startsWith('.target.txt.xi-tmp-'));
      assert.ok(tempName !== undefined, 'sanity: the atomic write created its temp file');
      const tempPath = join(dir, tempName!);
      await rm(tempPath, { force: true });
      await mkdir(tempPath);
      yield encoder.encode('second-chunk');
    }

    // The cleanup failure happens inside writeFileAtomicChunks's `finally` block, so with the
    // fix it surfaces as a rejection (it runs after the try/catch that would otherwise turn it
    // into a Result) rather than silently letting the function return as if cleanup succeeded.
    let reported: unknown;
    try {
      await filesystem.writeFileAtomicChunks(target, chunks(), cancellation.token);
    } catch (error: unknown) {
      reported = error;
    }
    assert.ok(reported !== undefined, 'F2-11: a real (non-ENOENT) unlink failure during temp-file cleanup must be reported, not silently swallowed');
    assert.notEqual((reported as { code?: string } | undefined)?.code, 'ENOENT', 'F2-11: the reported failure is the genuine non-ENOENT cleanup error');
    console.log('T-SAFE-UNLINK-REPORTS-ERRORS passed: a non-ENOENT cleanup failure surfaces instead of being silently swallowed (F2-11)');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void main();
