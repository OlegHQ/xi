import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CancellationSource, asIdentifier, asUtf16Offset, type DocumentId } from '../../packages/primitives/src/index';
import { encodeTextFile, openTextDocumentChunks, TextFileDocument } from '../../packages/document/src/index';
import { NodeFilesystemPort } from '../../packages/platform/src/index';
import { PersistenceService } from '../../packages/services/persistence/index';
import { testDocumentFactory } from './document-factory';

class CancellingWriter extends NodeFilesystemPort {
  constructor(private readonly source: CancellationSource) { super(); }

  override async writeFileAtomicChunks(
    path: string,
    contents: AsyncIterable<Uint8Array>,
    cancellation: CancellationSource['token'],
  ) {
    let count = 0;
    const source = this.source;
    async function* cancelAfterFirst(): AsyncIterable<Uint8Array> {
      for await (const chunk of contents) {
        yield chunk;
        count += 1;
        if (count === 1) source.cancel();
      }
    }
    return super.writeFileAtomicChunks(path, cancelAfterFirst(), cancellation);
  }
}

const root = await mkdtemp('/tmp/xi-t113-');
const path = join(root, 'mixed.txt');
const idResult = asIdentifier<DocumentId>('T113-streaming-document', 'documentId');
if (!idResult.ok) throw new Error(idResult.error.message);
const created = TextFileDocument.create(idResult.value, 'alpha\nbeta\ngamma', ['crlf', 'cr'], 'crlf', true);
assert.equal(created.ok, true, 'T113-STREAM-SAVE-01 document opens with mixed EOL and BOM');
if (!created.ok) throw new Error('T113-document');

const service = new PersistenceService(new NodeFilesystemPort(), undefined, testDocumentFactory);
const cancellationSource = new CancellationSource();
const cancellation = cancellationSource.token;
const saved = await service.saveFile(created.value, path, cancellation, { expectedDisk: null });
assert.equal(saved.ok, true, 'T113-STREAM-SAVE-01 chunked platform writer saves successfully');
const bytes = await readFile(path);
assert.deepEqual(bytes, Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('alpha\r\nbeta\rgamma')]), 'T113-STREAM-SAVE-02 chunked save preserves BOM and mixed endings');
assert.equal(created.value.isDirty, false, 'T113-STREAM-SAVE-03 save acknowledges the captured revision only after atomic write');

const edited = created.value.apply({ start: offset(0), end: offset(0), text: 'z' }, created.value.version);
assert.equal(edited.ok, true, 'T113-STREAM-IO-01 edit is published before the cancellable save');
const partialSource = new CancellationSource();
const partialPath = join(root, 'partial.txt');
await Bun.write(partialPath, 'original');
const partialService = new PersistenceService(new CancellingWriter(partialSource), undefined, testDocumentFactory);
const partialOpenedId = documentId('T113-partial-open');
const partialOpened = await partialService.openFile(partialPath, partialOpenedId, partialSource.token);
assert.equal(partialOpened.ok, true, 'T113-STREAM-IO-01b cancellation harness reads the original target');
if (!partialOpened.ok) throw new Error('T113-partial-open');
const partialSave = await partialService.saveFile(created.value, partialPath, partialSource.token, { expectedDisk: partialOpened.value.identity });
assert.deepEqual(partialSave, { ok: false, error: { kind: 'cancelled' } }, 'T113-STREAM-IO-02 partial chunk IO reports cancellation');
assert.deepEqual(await readFile(partialPath), Buffer.from('original'), 'T113-STREAM-IO-03 cancelled atomic save leaves the prior file intact');
assert.equal(created.value.isDirty, true, 'T113-STREAM-IO-04 cancelled save does not acknowledge the edited revision');
partialSource.dispose();

const reopenedId = asIdentifier<DocumentId>('T113-streaming-reopen', 'documentId');
if (!reopenedId.ok) throw new Error(reopenedId.error.message);
const reopened = await service.openFile(path, reopenedId.value, cancellation);
assert.equal(reopened.ok, true, 'T113-STREAM-OPEN-01 production persistence uses the chunk reader when available');
if (!reopened.ok || reopened.value.kind !== 'editable') throw new Error('T113-reopen');
const reopenedSnapshot = reopened.value.document.snapshot();
const reopenedText = reopenedSnapshot.slice(offset(0), offset(reopenedSnapshot.lengthUtf16));
assert.equal(reopenedText.ok && reopenedText.value, 'alpha\nbeta\ngamma', 'T113-STREAM-OPEN-02 streamed open normalizes saved mixed endings');

const splitBytes = new TextEncoder().encode('\ufeffalpha\r\n😀\rgamma');
async function* splitUtf8(): AsyncIterable<Uint8Array> {
  yield splitBytes.subarray(0, 4);
  yield splitBytes.subarray(4, 8);
  yield splitBytes.subarray(8, 11);
  yield splitBytes.subarray(11);
}
const split = await openTextDocumentChunks(
  documentId('T113-split-utf8'),
  splitUtf8(),
  41027,
  { fileFormat: 'legacy' },
);
assert.equal(split.kind, 'editable', 'T113-STREAM-OPEN-03 UTF-8 scalar and CRLF splits are accepted');
if (split.kind !== 'editable') throw new Error('T113-split-open');
const splitSnapshot = split.document.snapshot();
const splitText = splitSnapshot.slice(offset(0), offset(splitSnapshot.lengthUtf16));
assert.equal(splitText.ok && splitText.value, 'alpha\n😀\ngamma', 'T113-STREAM-OPEN-04 split input has exact normalized text');
assert.deepEqual(splitSnapshot.lineEndings, ['crlf', 'cr'], 'T113-STREAM-OPEN-05 split input retains exact EOL metadata');
const splitBytesOut = encodeTextFile(splitSnapshot);
assert.equal(splitBytesOut.ok, true, 'T113-STREAM-OPEN-06 split input remains serializable');
if (splitBytesOut.ok) assert.deepEqual(splitBytesOut.value, splitBytes, 'T113-STREAM-OPEN-07 split input round-trips exact bytes');

cancellationSource.dispose();
await rm(root, { recursive: true, force: true });
console.log('T113 streaming persistence passed chunked UTF-8/EOL ingestion, bounded save windows and post-atomic acknowledgement');

function documentId(value: string): DocumentId {
  const result = asIdentifier<DocumentId>(value, 'documentId');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function offset(value: number) {
  const result = asUtf16Offset(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
