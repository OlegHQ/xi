#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import * as realFs from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'bun:test';
import { CancellationSource } from '../../packages/contracts/src/index';

// A real removed-directory/EMFILE/inotify-ENOSPC watcher error is flaky to
// reproduce portably (Bun's watcher does not reliably fire 'error' just from
// deleting the watched path). Node's fs.FSWatcher is an EventEmitter though,
// and EventEmitter.emit('error', ...) THROWS synchronously when nothing is
// listening -- which is exactly how the unhandled crash manifests in
// production. Faking `fs.watch` lets the test trigger that exact mechanism
// deterministically and prove NodeFilesystemPort's own 'error' listener
// prevents the throw and reports it as an 'overflow' event instead.
class FakeWatcher extends EventEmitter {
  closed = false;
  close(): void { this.closed = true; }
}
let lastWatcher: FakeWatcher | undefined;
mock.module('node:fs', () => ({
  ...realFs,
  watch: (_path: string, _options: unknown, _listener: unknown) => {
    const watcher = new FakeWatcher();
    lastWatcher = watcher;
    return watcher;
  },
}));

const { NodeFilesystemPort } = await import('../../packages/platform/src/index');

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'xi-fs-watch-'));
  try {
    await testWatchDirectoryErrorDoesNotCrashAndReportsOverflow(root);
    await testWatchErrorDoesNotCrashAndReportsOverflow(root);
    await testEnumerateDirectoryCapsAndBatchesEntries(root);
    console.log('T-FS-WATCH filesystem passed watcher error handling (no crash, overflow surfaced) for watchDirectory and watch, and enumerateDirectory capping');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testWatchDirectoryErrorDoesNotCrashAndReportsOverflow(root: string): Promise<void> {
  const directory = join(root, 'watched-directory');
  await mkdir(directory);
  const filesystem = new NodeFilesystemPort();
  const cancellation = new CancellationSource();
  const events: { readonly kind: string; readonly path: string }[] = [];
  const watched = await filesystem.watchDirectory(directory, (event) => { events.push(event); }, cancellation.token);
  assert.equal(watched.ok, true, 'T-FS-WATCH-DIR-01 watchDirectory installs successfully');
  if (!watched.ok) return;
  assert.ok(lastWatcher !== undefined, 'T-FS-WATCH-DIR-02 the fake watcher was constructed');
  // This is the exact mechanism of the original bug: emitting 'error' with no
  // listener throws synchronously and crashes the process. It not throwing
  // here proves NodeFilesystemPort attached its own error listener.
  assert.doesNotThrow(() => { lastWatcher?.emit('error', new Error('ENOSPC')); }, 'T-FS-WATCH-DIR-03 an inotify/EMFILE-style watcher error does not crash the process');
  assert.equal(lastWatcher?.closed, true, 'T-FS-WATCH-DIR-04 the watcher is closed after an error');
  assert.deepEqual(events, [{ kind: 'overflow', path: directory }], 'T-FS-WATCH-DIR-05 the watcher error is reported through the existing overflow event, not silently dropped');
  watched.value.dispose();
  cancellation.dispose();
}

async function testWatchErrorDoesNotCrashAndReportsOverflow(root: string): Promise<void> {
  const filePath = join(root, 'watched-file.txt');
  await writeFile(filePath, 'content\n');
  const filesystem = new NodeFilesystemPort();
  const cancellation = new CancellationSource();
  const events: { readonly kind: string; readonly path: string }[] = [];
  const watched = await filesystem.watch(filePath, (event) => { events.push(event); }, cancellation.token);
  assert.equal(watched.ok, true, 'T-FS-WATCH-FILE-01 watch installs successfully');
  if (!watched.ok) return;
  assert.ok(lastWatcher !== undefined, 'T-FS-WATCH-FILE-02 the fake watcher was constructed');
  assert.doesNotThrow(() => { lastWatcher?.emit('error', new Error('EMFILE')); }, 'T-FS-WATCH-FILE-03 a watcher error does not crash the process');
  assert.equal(lastWatcher?.closed, true, 'T-FS-WATCH-FILE-04 the watcher is closed after an error');
  assert.deepEqual(events, [{ kind: 'overflow', path: filePath }], 'T-FS-WATCH-FILE-05 the watcher error is reported through the existing overflow event, not silently dropped');
  watched.value.dispose();
  cancellation.dispose();
}

async function testEnumerateDirectoryCapsAndBatchesEntries(root: string): Promise<void> {
  const directory = join(root, 'many-entries');
  await mkdir(directory);
  const total = 150;
  await Promise.all(Array.from({ length: total }, (_unused, index) => writeFile(join(directory, `file-${String(index).padStart(4, '0')}.txt`), '')));
  const filesystem = new NodeFilesystemPort();
  const cancellation = new CancellationSource();
  const capped = await filesystem.enumerateDirectory(directory, directory, cancellation.token, { maxEntries: 100 });
  assert.equal(capped.ok, true, 'T-FS-ENUM-01 enumeration succeeds under a cap');
  if (capped.ok) assert.equal(capped.value.length, 100, 'T-FS-ENUM-02 enumeration is capped rather than unbounded');
  const uncapped = await filesystem.enumerateDirectory(directory, directory, cancellation.token);
  assert.equal(uncapped.ok, true, 'T-FS-ENUM-03 enumeration succeeds under the default cap');
  if (uncapped.ok) assert.equal(uncapped.value.length, total, 'T-FS-ENUM-04 a directory under the default 120k cap is fully enumerated');
  cancellation.dispose();
}

await main();
