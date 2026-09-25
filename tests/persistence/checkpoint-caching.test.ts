#!/usr/bin/env bun
// Regression coverage for the checkpoint/save fast paths: a second checkpoint
// of the same document must not re-read and re-parse the recovery journal
// from disk, and saveFile must not re-read and re-hash an unchanged file.
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
import { TextFileDocument } from '../../packages/document/src/index';
import { PersistenceService } from '../../packages/services/persistence/index';
import { testDocumentFactory } from './document-factory';

const cancellation = new CancellationSource().token;

class CountingFilesystem implements FilesystemPort {
  #files = new Map<string, Uint8Array>();
  #info = new Map<string, FileInfo>();
  #mtime = 1;
  readFileCalls = 0;
  statCalls = 0;

  seed(path: string, bytes: Uint8Array): void {
    this.#files.set(path, bytes.slice());
    this.#info.set(path, { kind: 'file', sizeBytes: bytes.length, modifiedMilliseconds: this.#mtime++, device: 'fake', inode: path, linkCount: 1 });
  }
  bytes(path: string): Uint8Array { return this.#files.get(path)?.slice() ?? new Uint8Array(); }

  async readFile(path: string, token: CancellationToken): Promise<Result<Uint8Array, PlatformFailure>> {
    this.readFileCalls += 1;
    if (token.isCancelled) return fail('cancelled');
    const bytes = this.#files.get(path);
    return bytes === undefined ? fail('ENOENT') : { ok: true, value: bytes.slice() };
  }
  async writeFileAtomic(path: string, bytes: Uint8Array, token: CancellationToken): Promise<Result<void, PlatformFailure>> {
    if (token.isCancelled) return fail('cancelled');
    this.seed(path, bytes);
    return { ok: true, value: undefined };
  }
  async stat(path: string, token: CancellationToken): Promise<Result<FileInfo, PlatformFailure>> {
    this.statCalls += 1;
    if (token.isCancelled) return fail('cancelled');
    const info = this.#info.get(path);
    return info === undefined ? fail('ENOENT') : { ok: true, value: info };
  }
  async watch(): Promise<Result<{ dispose(): void }, PlatformFailure>> { return { ok: true, value: { dispose() {} } }; }
}

function fail(code: string): Result<never, PlatformFailure> { return { ok: false, error: { code, message: code, retryable: code === 'ENOSPC' } }; }
function id(value: string): DocumentId { const result = asIdentifier<DocumentId>(value, 'documentId'); if (!result.ok) throw new Error(result.error.message); return result.value; }
function offset(value: number) { const result = asUtf16Offset(value); if (!result.ok) throw new Error(result.error.message); return result.value; }

async function secondCheckpointDoesNotReparseJournal(): Promise<void> {
  const fs = new CountingFilesystem();
  fs.seed('/tmp/cache-checkpoint.txt', new TextEncoder().encode('one\n'));
  const service = new PersistenceService(fs, undefined, testDocumentFactory);
  const opened = await service.openFile('/tmp/cache-checkpoint.txt', id('cache-checkpoint'), cancellation);
  assert.equal(opened.ok, true);
  if (!opened.ok || opened.value.kind !== 'editable') return;
  const document = opened.value.document;
  assert.equal(document.apply({ start: offset(4), end: offset(4), text: 'two\n' }, document.version).ok, true);

  const first = await service.checkpoint(document, '/tmp/cache-checkpoint.txt', cancellation);
  assert.equal(first.ok, true, 'first checkpoint succeeds and creates the journal');
  const readsAfterFirst = fs.readFileCalls;
  assert.equal(readsAfterFirst, 1, 'first checkpoint reads the source file once (open); the absent journal is detected via stat alone');

  assert.equal(document.apply({ start: offset(8), end: offset(8), text: 'three\n' }, document.version).ok, true);
  const second = await service.checkpoint(document, '/tmp/cache-checkpoint.txt', cancellation);
  assert.equal(second.ok, true, 'second checkpoint succeeds');
  assert.equal(fs.readFileCalls, readsAfterFirst, 'second checkpoint reuses the cached decoded journal instead of re-reading and re-parsing it from disk');

  // The document's checkpoint entry is replaced in place on each call (same documentId), so
  // recovery still finds the latest content rather than a stale first checkpoint.
  const recovered = await new PersistenceService(fs, undefined, testDocumentFactory).recover('/tmp/cache-checkpoint.txt', id('cache-checkpoint'), cancellation);
  assert.equal(recovered.ok, true);
  if (recovered.ok) assert.equal(recovered.value.kind === 'recovered' || recovered.value.kind === 'disk-diverged', true, 'journal round-trips through the cache');
}

async function saveDoesNotRereadUnchangedFile(): Promise<void> {
  const fs = new CountingFilesystem();
  fs.seed('/tmp/cache-save.txt', new TextEncoder().encode('hello'));
  const service = new PersistenceService(fs, undefined, testDocumentFactory);
  const opened = await service.openFile('/tmp/cache-save.txt', id('cache-save'), cancellation);
  assert.equal(opened.ok, true);
  if (!opened.ok || opened.value.kind !== 'editable') return;
  const document = opened.value.document;
  assert.equal(document.apply({ start: offset(5), end: offset(5), text: ' world' }, document.version).ok, true);

  const readsBeforeSave = fs.readFileCalls;
  const saved = await service.saveFile(document, '/tmp/cache-save.txt', cancellation);
  assert.equal(saved.ok, true, 'save succeeds');
  // saveFile must not re-read+hash the current on-disk bytes for the
  // external-change check when the last known identity's stat (from open)
  // still matches: only the write path touches the file.
  assert.equal(fs.readFileCalls, readsBeforeSave, 'save does not re-read the unchanged on-disk file to recompute its identity');
}

async function checkpointOfOversizedDocumentBailsQuickly(): Promise<void> {
  const fs = new CountingFilesystem();
  fs.seed('/tmp/cache-oversized.txt', new TextEncoder().encode('x'));
  const service = new PersistenceService(fs, undefined, testDocumentFactory);
  const opened = await service.openFile('/tmp/cache-oversized.txt', id('cache-oversized'), cancellation);
  assert.equal(opened.ok, true);
  if (!opened.ok || opened.value.kind !== 'editable') return;
  const document = opened.value.document;
  const maxBytes = 1024;
  const oversizedText = 'y'.repeat(maxBytes * 2);
  assert.equal(document.apply({ start: offset(1), end: offset(1), text: oversizedText }, document.version).ok, true);

  const readsBeforeCheckpoint = fs.readFileCalls;
  const started = performance.now();
  const result = await service.checkpoint(document, '/tmp/cache-oversized.txt', cancellation, { maxBytes });
  const elapsedMilliseconds = performance.now() - started;

  assert.equal(result.ok, false, 'checkpoint of an oversized document reports too-large instead of writing a truncated journal');
  if (!result.ok) assert.equal(result.error.kind, 'journal-too-large', 'failure reason is journal-too-large');
  assert.equal(fs.readFileCalls, readsBeforeCheckpoint, 'the oversized-document check bails before reading/parsing the journal');
  assert.equal(elapsedMilliseconds < 50, true, `oversized checkpoint must bail in under 50ms, took ${elapsedMilliseconds}ms`);
}

async function repeatedCheckpointsRetainBoundedVersions(): Promise<void> {
  const fs = new CountingFilesystem();
  fs.seed('/tmp/cache-bounded.txt', new TextEncoder().encode('one\n'));
  const service = new PersistenceService(fs, undefined, testDocumentFactory);
  const opened = await service.openFile('/tmp/cache-bounded.txt', id('cache-bounded'), cancellation);
  assert.equal(opened.ok, true);
  if (!opened.ok || opened.value.kind !== 'editable') return;
  const document = opened.value.document;

  for (let round = 0; round < 20; round += 1) {
    const end = offset(document.snapshot().lengthUtf16);
    assert.equal(document.apply({ start: end, end, text: 'x' }, document.version).ok, true);
    const result = await service.checkpoint(document, '/tmp/cache-bounded.txt', cancellation);
    assert.equal(result.ok, true, `checkpoint ${round} succeeds`);
    assert.ok(fs.bytes('/tmp/cache-bounded.txt.xi-recovery.json').length <= 16 * 1024 * 1024, 'T-PERSIST-CHECKPOINT-BOUND-01 journal remains within the byte cap');
  }

  const versions = await service.listRecovery('/tmp/cache-bounded.txt', cancellation);
  assert.equal(versions.ok, true);
  if (versions.ok) {
    assert.equal(versions.value.length, 20, 'T-PERSIST-CHECKPOINT-BOUND-03 distinct revisions remain selectable');
    assert.equal(versions.value[0]?.normalizedText, `one\n${'x'.repeat(20)}`, 'T-PERSIST-CHECKPOINT-BOUND-04 newest version appears first');
  }

  const recovered = await new PersistenceService(fs, undefined, testDocumentFactory).recover('/tmp/cache-bounded.txt', id('cache-bounded'), cancellation);
  assert.equal(recovered.ok, true);
  if (recovered.ok && recovered.value.kind === 'recovered') {
    assert.equal(recovered.value.checkpoint.normalizedText, `one\n${'x'.repeat(20)}`, 'T-PERSIST-CHECKPOINT-BOUND-02 recovery still returns the latest content after in-place replacement');
  }
}

await secondCheckpointDoesNotReparseJournal();
await repeatedCheckpointsRetainBoundedVersions();
await saveDoesNotRereadUnchangedFile();
await checkpointOfOversizedDocumentBailsQuickly();
console.log('checkpoint-caching passed journal reuse, save identity-hint, and oversized-document fixtures');
