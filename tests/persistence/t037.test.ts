#!/usr/bin/env bun
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
import { PersistenceService, decodeSession, encodeSession, type SessionSnapshot } from '../../packages/services/persistence/index';

const cancellation = new CancellationSource().token;

async function main(): Promise<void> {
  await testExactRoundTripAndSafeBinaryFallback();
  await testFaultRecoveryAndDivergence();
  await testFailurePolicies();
  testSessionSchema();
  console.log('T037 persistence passed UTF-8/EOL round-trip, binary fallback, atomic fault recovery, divergence reporting, failure policies and session schema fixtures');
}

async function testExactRoundTripAndSafeBinaryFallback(): Promise<void> {
  const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('first\r\nsecond\nthird')]);
  const fs = new FakeFilesystem();
  fs.seed('/tmp/T037-roundtrip.txt', bytes);
  const service = new PersistenceService(fs);
  const opened = await service.openFile('/tmp/T037-roundtrip.txt', id('T037-roundtrip'), cancellation);
  assert.equal(opened.ok, true, 'T037-OPEN-01 mixed EOL UTF-8 opens editable');
  if (!opened.ok || opened.value.kind !== 'editable') return;
  assert.equal(opened.value.document.hasUtf8Bom, true, 'T037-OPEN-02 BOM is metadata');
  assert.deepEqual(opened.value.document.snapshot().lineEndings, ['crlf', 'lf'], 'T037-OPEN-03 per-line endings are retained');
  assert.equal(opened.value.document.snapshot().hasFinalNewline, false, 'T037-OPEN-04 final newline state is retained');
  const saved = await service.saveFile(opened.value.document, opened.value.path, cancellation);
  assert.equal(saved.ok, true, 'T037-SAVE-01 unchanged snapshot saves');
  assert.deepEqual(fs.bytes('/tmp/T037-roundtrip.txt'), bytes, 'T037-ROUNDTRIP-01 bytes are exactly preserved');
  assert.equal(opened.value.document.isDirty, false, 'T037-SAVE-02 successful save marks the captured revision');
  const withExplicitFormat = await service.openFile('/tmp/T037-roundtrip.txt', id('T037-roundtrip-format'), cancellation, { fileFormat: 'dos', seed: 19 });
  assert.equal(withExplicitFormat.ok && withExplicitFormat.value.kind === 'editable', true, 'T037-OPEN-05 explicit file format and document seed compose');

  const invalid = new FakeFilesystem();
  invalid.seed('/tmp/T037-invalid', Uint8Array.from([0xff, 0xfe]));
  const invalidOpened = await new PersistenceService(invalid).openFile('/tmp/T037-invalid', id('T037-invalid'), cancellation);
  assert.equal(invalidOpened.ok, true, 'T037-BINARY-01 invalid bytes remain openable as read-only');
  if (invalidOpened.ok) {
    assert.equal(invalidOpened.value.kind, 'read-only');
    assert.equal(invalidOpened.value.document.readOnly, true);
    assert.deepEqual(invalidOpened.value.document.copyOriginalBytes(), Uint8Array.from([0xff, 0xfe]), 'T037-BINARY-02 original bytes are retained');
  }
  const nul = new FakeFilesystem();
  nul.seed('/tmp/T037-nul', Uint8Array.from([0x61, 0x00, 0x62]));
  const nulOpened = await new PersistenceService(nul).openFile('/tmp/T037-nul', id('T037-nul'), cancellation);
  assert.equal(nulOpened.ok, true);
  if (nulOpened.ok) assert.equal(nulOpened.value.kind, 'read-only', 'T037-BINARY-03 NUL input is read-only');
}

async function testFaultRecoveryAndDivergence(): Promise<void> {
  const fs = new FakeFilesystem();
  fs.seed('/tmp/T037-recover', new TextEncoder().encode('before\n'));
  const service = new PersistenceService(fs);
  const opened = await service.openFile('/tmp/T037-recover', id('T037-recover'), cancellation);
  assert.equal(opened.ok, true);
  if (!opened.ok || opened.value.kind !== 'editable') return;
  const document = opened.value.document;
  const edit = document.apply({ start: offset(0), end: offset(0), text: 'after\n' }, document.version);
  assert.equal(edit.ok, true, 'T037-RECOVERY-01 document mutation creates dirty revision');
  const checkpoint = await service.checkpoint(document, '/tmp/T037-recover', cancellation);
  assert.equal(checkpoint.ok, true, 'T037-RECOVERY-02 checkpoint writes before risky save');
  fs.failWritesWith('ENOSPC');
  const failedSave = await service.saveFile(document, '/tmp/T037-recover', cancellation);
  assert.equal(failedSave.ok, false, 'T037-FAULT-01 disk full fails save');
  if (!failedSave.ok) assert.equal(failedSave.error.kind, 'platform');
  assert.equal(document.isDirty, true, 'T037-FAULT-02 failed save preserves modified state');
  assert.deepEqual(fs.bytes('/tmp/T037-recover'), new TextEncoder().encode('before\n'), 'T037-FAULT-03 failed atomic write leaves disk bytes');

  const restarted = new PersistenceService(fs);
  const recovered = await restarted.recover('/tmp/T037-recover', id('T037-recover'), cancellation);
  assert.equal(recovered.ok, true, 'T037-RECOVERY-03 restart reads durable checkpoint');
  if (recovered.ok) {
    assert.equal(recovered.value.kind, 'recovered');
    if (recovered.value.kind === 'recovered') assert.equal(readText(recovered.value.document), 'after\nbefore\n', 'T037-RECOVERY-04 recovered content is from committed snapshot');
  }

  fs.allowWrites();
  fs.seed('/tmp/T037-recover', new TextEncoder().encode('external\n'));
  const divergent = await new PersistenceService(fs).recover('/tmp/T037-recover', id('T037-recover'), cancellation);
  assert.equal(divergent.ok, true, 'T037-DIVERGENCE-01 restart does not overwrite changed disk');
  if (divergent.ok) {
    assert.equal(divergent.value.kind, 'disk-diverged');
    if (divergent.value.kind === 'disk-diverged') {
      assert.equal(readText(divergent.value.document), 'after\nbefore\n');
      assert.deepEqual(fs.bytes('/tmp/T037-recover'), new TextEncoder().encode('external\n'), 'T037-DIVERGENCE-02 external bytes remain untouched');
    }
  }

  // A platform crash after rename leaves the new disk bytes but the old
  // recovery base. Restart must surface that as a reviewable divergence.
  const crashFs = new FakeFilesystem();
  crashFs.seed('/tmp/T037-crash', new TextEncoder().encode('old\n'));
  const crashService = new PersistenceService(crashFs);
  const crashOpened = await crashService.openFile('/tmp/T037-crash', id('T037-crash'), cancellation);
  assert.equal(crashOpened.ok && crashOpened.value.kind === 'editable', true);
  if (crashOpened.ok && crashOpened.value.kind === 'editable') {
    const crashDocument = crashOpened.value.document;
    assert.equal(crashDocument.apply({ start: offset(0), end: offset(0), text: 'new\n' }, crashDocument.version).ok, true);
    assert.equal((await crashService.checkpoint(crashDocument, '/tmp/T037-crash', cancellation)).ok, true);
    crashFs.failAfterRename = true;
    const crashed = await crashService.saveFile(crashDocument, '/tmp/T037-crash', cancellation);
    assert.equal(crashed.ok, false, 'T037-FAIL-RENAME-01 crash between rename acknowledgement is surfaced');
    assert.equal(crashDocument.isDirty, true, 'T037-FAIL-RENAME-02 uncertain save does not clear modified state');
    const crashRecovery = await new PersistenceService(crashFs).recover('/tmp/T037-crash', id('T037-crash'), cancellation);
    assert.equal(crashRecovery.ok && crashRecovery.value.kind === 'disk-diverged', true, 'T037-FAIL-RENAME-03 restart exposes divergence for review');
  }
}

async function testFailurePolicies(): Promise<void> {
  const fs = new FakeFilesystem();
  fs.seed('/tmp/T037-policy', new TextEncoder().encode('one\n'));
  const service = new PersistenceService(fs);
  const opened = await service.openFile('/tmp/T037-policy', id('T037-policy'), cancellation);
  assert.equal(opened.ok, true);
  if (!opened.ok || opened.value.kind !== 'editable') return;
  const document = opened.value.document;
  assert.equal(document.apply({ start: offset(0), end: offset(0), text: 'x' }, document.version).ok, true);
  fs.makeSymlink('/tmp/T037-policy');
  const symlink = await service.saveFile(document, '/tmp/T037-policy', cancellation, { expectedDisk: null });
  assert.equal(symlink.ok, false, 'T037-FAIL-SYMLINK-01 symlink replacement is rejected');
  if (!symlink.ok) assert.equal(symlink.error.kind, 'external-change');
  const symlinkOpened = await service.openFile('/tmp/T037-policy', id('T037-policy-symlink'), cancellation);
  assert.equal(symlinkOpened.ok, true);
  if (symlinkOpened.ok && symlinkOpened.value.kind === 'editable') {
    const symlinkSave = await service.saveFile(symlinkOpened.value.document, '/tmp/T037-policy', cancellation);
    assert.equal(symlinkSave.ok, false, 'T037-FAIL-SYMLINK-02 an opened symlink cannot be atomically replaced');
    if (!symlinkSave.ok) assert.equal(symlinkSave.error.kind, 'symlink-save');
  }

  fs.seed('/tmp/T037-hardlink', new TextEncoder().encode('one\n'));
  const hardOpened = await service.openFile('/tmp/T037-hardlink', id('T037-hardlink'), cancellation);
  assert.equal(hardOpened.ok, true);
  if (!hardOpened.ok || hardOpened.value.kind !== 'editable') return;
  assert.equal(hardOpened.value.document.apply({ start: offset(0), end: offset(0), text: 'x' }, hardOpened.value.document.version).ok, true);
  fs.setLinks('/tmp/T037-hardlink', 2);
  const hardlink = await service.saveFile(hardOpened.value.document, '/tmp/T037-hardlink', cancellation);
  assert.equal(hardlink.ok, false, 'T037-FAIL-HARDLINK-01 hardlink replacement is rejected');
  if (!hardlink.ok) assert.equal(hardlink.error.kind, 'hardlink-save');

  fs.seed('/tmp/T037-permission', new TextEncoder().encode('one\n'));
  const permissionOpened = await service.openFile('/tmp/T037-permission', id('T037-permission'), cancellation);
  assert.equal(permissionOpened.ok, true);
  if (permissionOpened.ok && permissionOpened.value.kind === 'editable') {
    assert.equal(permissionOpened.value.document.apply({ start: offset(0), end: offset(0), text: 'x' }, permissionOpened.value.document.version).ok, true);
    fs.failWritesWith('EACCES');
    const denied = await service.saveFile(permissionOpened.value.document, '/tmp/T037-permission', cancellation);
    assert.equal(denied.ok, false, 'T037-FAIL-PERM-01 permission denial is surfaced');
    assert.equal(permissionOpened.value.document.isDirty, true, 'T037-FAIL-PERM-02 permission failure retains dirty state');
  }
}

function testSessionSchema(): void {
  const session: SessionSnapshot = {
    schemaVersion: 1,
    workspaceId: 'T037-workspace',
    roots: ['/tmp/project'],
    documents: [{ documentId: 'T037-doc', path: '/tmp/project/a.ts', viewIds: ['T037-view'] }],
    activeDocumentId: 'T037-doc',
  };
  const encoded = encodeSession(session);
  assert.equal(encoded.ok, true, 'T037-SESSION-01 session schema encodes');
  if (!encoded.ok) return;
  const decoded = decodeSession(encoded.value);
  assert.equal(decoded.ok, true, 'T037-SESSION-02 session schema decodes');
  assert.equal(decodeSession(new TextEncoder().encode('{"schemaVersion":99}')).ok, false, 'T037-SESSION-03 unknown schema is rejected');
}

class FakeFilesystem implements FilesystemPort {
  #files = new Map<string, Uint8Array>();
  #info = new Map<string, FileInfo>();
  #mtime = 1;
  #writeFailure: string | undefined;
  failAfterRename = false;

  seed(path: string, bytes: Uint8Array): void {
    this.#files.set(path, bytes.slice());
    this.#info.set(path, { kind: 'file', sizeBytes: bytes.length, modifiedMilliseconds: this.#mtime++, device: 'fake', inode: path, linkCount: 1 });
  }
  bytes(path: string): Uint8Array { return this.#files.get(path)?.slice() ?? new Uint8Array(); }
  failWritesWith(code: string): void { this.#writeFailure = code; }
  allowWrites(): void { this.#writeFailure = undefined; }
  makeSymlink(path: string): void { const old = this.#info.get(path); this.#info.set(path, { kind: 'symlink', sizeBytes: old?.sizeBytes ?? 0, modifiedMilliseconds: this.#mtime++, device: 'fake', inode: path, linkCount: 1 }); }
  setLinks(path: string, linkCount: number): void { const old = this.#info.get(path); if (old) this.#info.set(path, { ...old, linkCount }); }

  async readFile(path: string, token: CancellationToken): Promise<Result<Uint8Array, PlatformFailure>> {
    if (token.isCancelled) return fail('cancelled');
    const bytes = this.#files.get(path);
    return bytes === undefined ? fail('ENOENT') : { ok: true, value: bytes.slice() };
  }
  async writeFileAtomic(path: string, bytes: Uint8Array, token: CancellationToken): Promise<Result<void, PlatformFailure>> {
    if (token.isCancelled) return fail('cancelled');
    if (this.#writeFailure !== undefined) return fail(this.#writeFailure);
    this.seed(path, bytes);
    if (this.failAfterRename) {
      this.failAfterRename = false;
      return fail('crash-between-rename-and-ack');
    }
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
function readText(document: TextFileDocument): string { const snapshot = document.snapshot(); const result = snapshot.slice(offset(0), offset(snapshot.lengthUtf16)); if (!result.ok) throw new Error(result.error.kind); return result.value; }

await main();
