#!/usr/bin/env bun
// Regression coverage for F2-4, F2-5, F2-6 (persistence data-loss findings):
//   F2-4: a corrupt .xi-recovery.json must self-heal on the next checkpoint instead of failing
//         every checkpoint for that path forever.
//   F2-5: dispose() must cancel an in-flight checkpoint instead of letting it write after
//         dispose.
//   F2-6: an mtime within ~2ms of "now" must force a re-hash instead of trusting a stat-only
//         identity match that could hide a same-window external write.
import { strict as assert } from 'node:assert';
import {
  CancellationSource,
  type CancellationToken,
  type FileInfo,
  type FilesystemPort,
  type PlatformFailure,
  type Result,
} from '../../packages/contracts/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId } from '../../packages/primitives/src/index';
import { PersistenceService, recoveryJournalPath } from '../../packages/services/persistence/index';
import { testDocumentFactory } from './document-factory';

const cancellation = new CancellationSource().token;

class FakeFilesystem implements FilesystemPort {
  #files = new Map<string, Uint8Array>();
  #info = new Map<string, FileInfo>();
  #mtime = 1;
  writeCalls = 0;

  seed(path: string, bytes: Uint8Array): void {
    this.#files.set(path, bytes.slice());
    this.#info.set(path, { kind: 'file', sizeBytes: bytes.length, modifiedMilliseconds: this.#mtime++, device: 'fake', inode: path, linkCount: 1 });
  }
  /** Sets the seeded file's mtime to "now" (inside the ~2ms race window F2-6 targets). */
  seedNow(path: string, bytes: Uint8Array): void {
    this.#files.set(path, bytes.slice());
    this.#info.set(path, { kind: 'file', sizeBytes: bytes.length, modifiedMilliseconds: Date.now(), device: 'fake', inode: path, linkCount: 1 });
  }
  /** Overwrites content in place, keeping the exact same (size, mtime) stat -- an external
   * write landing in the same mtime-granularity window as the last observed identity. */
  externallyOverwriteKeepingStat(path: string, bytes: Uint8Array): void {
    const info = this.#info.get(path);
    if (info === undefined) throw new Error('not seeded');
    assert.equal(bytes.length, info.sizeBytes, 'test fixture: same-size overwrite required to keep the stat identical');
    this.#files.set(path, bytes.slice());
  }

  async readFile(path: string, token: CancellationToken): Promise<Result<Uint8Array, PlatformFailure>> {
    if (token.isCancelled) return fail('cancelled');
    const bytes = this.#files.get(path);
    return bytes === undefined ? fail('ENOENT') : { ok: true, value: bytes.slice() };
  }
  async writeFileAtomic(path: string, bytes: Uint8Array, token: CancellationToken): Promise<Result<void, PlatformFailure>> {
    this.writeCalls += 1;
    if (token.isCancelled) return fail('cancelled');
    this.seed(path, bytes);
    return { ok: true, value: undefined };
  }
  async stat(path: string, token: CancellationToken): Promise<Result<FileInfo, PlatformFailure>> {
    if (token.isCancelled) return fail('cancelled');
    const info = this.#info.get(path);
    return info === undefined ? fail('ENOENT') : { ok: true, value: info };
  }
  async watch(): Promise<Result<{ dispose(): void }, PlatformFailure>> { return { ok: true, value: { dispose() {} } }; }
}

function fail(code: string): Result<never, PlatformFailure> { return { ok: false, error: { code, message: code, retryable: code === 'ENOSPC' } }; }
function id(value: string): DocumentId { const result = asIdentifier<DocumentId>(value, 'documentId'); if (!result.ok) throw new Error(result.error.message); return result.value; }
function offset(value: number) { const result = asUtf16Offset(value); if (!result.ok) throw new Error(result.error.message); return result.value; }

async function corruptJournalSelfHealsInsteadOfFailingForever(): Promise<void> {
  const path = '/tmp/f2-4-corrupt.txt';
  const fs = new FakeFilesystem();
  fs.seed(path, new TextEncoder().encode('one\n'));
  fs.seed(recoveryJournalPath(path), new TextEncoder().encode('{not valid json'));
  let errors = 0;
  const service = new PersistenceService(fs, () => { errors += 1; }, testDocumentFactory);
  const opened = await service.openFile(path, id('f2-4-corrupt'), cancellation);
  assert.equal(opened.ok, true);
  if (!opened.ok || opened.value.kind !== 'editable') return;
  const document = opened.value.document;
  assert.equal(document.apply({ start: offset(4), end: offset(4), text: 'two\n' }, document.version).ok, true);

  const first = await service.checkpoint(document, path, cancellation);
  assert.equal(first.ok, true, 'F2-4: a corrupt existing journal must not permanently block checkpointing this path');
  assert.equal(errors, 1, 'F2-4: the corrupt journal is reported once via onError');

  assert.equal(document.apply({ start: offset(8), end: offset(8), text: 'three\n' }, document.version).ok, true);
  const second = await service.checkpoint(document, path, cancellation);
  assert.equal(second.ok, true, 'F2-4: subsequent checkpoints of the now-healed journal keep succeeding');
  assert.equal(errors, 1, 'F2-4: the corruption is reported once, not on every subsequent checkpoint');
}

async function disposeCancelsInFlightCheckpoint(): Promise<void> {
  const path = '/tmp/f2-5-dispose.txt';
  const fs = new FakeFilesystem();
  fs.seed(path, new TextEncoder().encode('one\n'));
  const service = new PersistenceService(fs, undefined, testDocumentFactory);
  const opened = await service.openFile(path, id('f2-5-dispose'), cancellation);
  assert.equal(opened.ok, true);
  if (!opened.ok || opened.value.kind !== 'editable') return;
  const document = opened.value.document;
  assert.equal(document.apply({ start: offset(4), end: offset(4), text: 'two\n' }, document.version).ok, true);

  const writesBefore = fs.writeCalls;
  const pending = service.checkpoint(document, path, cancellation);
  // Synchronous: runs before the checkpoint's own internal awaits get a chance to reach the
  // journal write, exercising the same race a real dispose() mid-checkpoint would hit.
  service.dispose();
  const result = await pending;
  assert.equal(result.ok, false, 'F2-5: a checkpoint in flight when dispose() runs must not silently report success');
  if (!result.ok) assert.equal(result.error.kind, 'cancelled', 'F2-5: dispose cancels the in-flight checkpoint');
  assert.equal(fs.writeCalls, writesBefore, 'F2-5: no journal write happens once dispose has cancelled the in-flight checkpoint');
}

async function freshMtimeForcesRehashInsteadOfTrustingStaleHint(): Promise<void> {
  const path = '/tmp/f2-6-mtime-race.txt';
  const fs = new FakeFilesystem();
  // Date.now() is pinned for the whole scenario so the hint's captured mtime and the "now" the
  // fix compares against stay exactly equal, deterministically reproducing "an external write
  // landed within the same mtime-granularity tick" instead of depending on how much real wall
  // clock time this test happens to take between open and save.
  const realNow = Date.now;
  const FIXED_NOW = 1_700_000_000_000;
  Date.now = () => FIXED_NOW;
  try {
    fs.seedNow(path, new TextEncoder().encode('original'));
    const service = new PersistenceService(fs, undefined, testDocumentFactory);
    const opened = await service.openFile(path, id('f2-6-mtime-race'), cancellation);
    assert.equal(opened.ok, true);
    if (!opened.ok || opened.value.kind !== 'editable') return;
    const document = opened.value.document;
    assert.equal(document.apply({ start: offset(0), end: offset(0), text: 'X' }, document.version).ok, true);

    // Same byte length, same (fresh) mtime: a stat-only identity check cannot distinguish this
    // from "unchanged" -- only re-hashing can.
    fs.externallyOverwriteKeepingStat(path, new TextEncoder().encode('changed!'));

    const saved = await service.saveFile(document, path, cancellation);
    assert.equal(saved.ok, false, 'F2-6: a same-mtime external write must not be silently clobbered');
    if (!saved.ok) assert.equal(saved.error.kind, 'external-change', 'F2-6: a fresh mtime forces re-hashing and detects the divergence');
  } finally {
    Date.now = realNow;
  }
}

await corruptJournalSelfHealsInsteadOfFailingForever();
await disposeCancelsInFlightCheckpoint();
await freshMtimeForcesRehashInsteadOfTrustingStaleHint();
console.log('T-PERSISTENCE-SAFETY passed: corrupt-journal self-heal (F2-4), dispose cancels in-flight checkpoint (F2-5), mtime-race re-hash (F2-6)');
