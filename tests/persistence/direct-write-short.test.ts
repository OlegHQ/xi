import assert from 'node:assert/strict';
import { constants, promises as fs } from 'node:fs';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CancellationSource, asIdentifier, asUtf16Offset, type DocumentId } from '../../packages/primitives/src/index';
import { NodeFilesystemPort } from '../../packages/platform/src/index';
import { PersistenceService } from '../../packages/services/persistence/index';
import { testDocumentFactory } from './document-factory';

const root = await mkdtemp(join(tmpdir(), 'xi-direct-write-'));
const path = join(root, 'document.txt');
const originalOpen = fs.open;
try {
  await writeFile(path, 'old');
  const service = new PersistenceService(new NodeFilesystemPort(), undefined, testDocumentFactory);
  const cancellation = new CancellationSource();
  const identifier = asIdentifier<DocumentId>('direct-write', 'documentId');
  if (!identifier.ok) throw new Error(identifier.error.message);
  const opened = await service.openFile(path, identifier.value, cancellation.token);
  assert.equal(opened.ok && opened.value.kind === 'editable', true);
  if (!opened.ok || opened.value.kind !== 'editable') throw new Error('document did not open');
  const document = opened.value.document;
  const start = asUtf16Offset(0);
  const end = asUtf16Offset(3);
  if (!start.ok || !end.ok) throw new Error('invalid offset');
  assert.equal(document.apply({ start: start.value, end: end.value, text: 'replacement' }, document.version).ok, true);

  let failAfterFirstWrite = false;
  let writes = 0;
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (typeof args[1] === 'number' && (args[1] & constants.O_TRUNC) !== 0) {
      const originalWrite = handle.write.bind(handle);
      handle.write = (async (bytes: Uint8Array, offset: number, length: number) => {
        writes += 1;
        if (failAfterFirstWrite && writes > 1) throw new Error('injected write failure');
        return originalWrite(bytes, offset, Math.min(length, 2));
      }) as typeof handle.write;
    }
    return handle;
  }) as typeof fs.open;

  const saved = await service.saveFile(document, path, cancellation.token, { atomic: false });
  assert.equal(saved.ok, true, 'short writes are retried until the entire snapshot is persisted');
  assert.equal(await readFile(path, 'utf8'), 'replacement');
  assert.equal(document.isDirty, false);
  assert.ok(writes > 1, 'the injected writer really returned a partial write');

  assert.equal(document.apply({ start: start.value, end: end.value, text: 'different' }, document.version).ok, true);
  writes = 0;
  failAfterFirstWrite = true;
  const failed = await service.saveFile(document, path, cancellation.token, { atomic: false });
  assert.equal(failed.ok, false, 'a later write error is reported');
  assert.equal(document.isDirty, true, 'a failed save retains the dirty revision');
  assert.equal(await readFile(path, 'utf8'), 'di', 'the disk contains only the written prefix after a non-atomic failure');
  cancellation.dispose();
} finally {
  fs.open = originalOpen;
  await rm(root, { recursive: true, force: true });
}
