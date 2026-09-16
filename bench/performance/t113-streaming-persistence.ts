#!/usr/bin/env bun
/** Diagnostic T113 probe; it measures the production chunk reader/writer only. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CancellationSource, asIdentifier, type DocumentId } from '../../packages/primitives/src/index';
import { NodeFilesystemPort } from '../../packages/platform/src/index';
import { PersistenceService } from '../../packages/services/persistence/index';

const bytesTarget = 10 * 1024 * 1024;
const root = await mkdtemp('/tmp/xi-t113-bench-');
const path = join(root, 'dense-mixed-eol.txt');
const text = 'x\r\ny\n'.repeat(Math.ceil(bytesTarget / 5)).slice(0, bytesTarget);
await writeFile(path, Buffer.from(text));
const idResult = asIdentifier<DocumentId>('T113-production-bench', 'documentId');
if (!idResult.ok) throw new Error(idResult.error.message);
const cancellation = new CancellationSource();
const service = new PersistenceService(new NodeFilesystemPort());
const rss = (): number => process.memoryUsage().rss;
const before = rss();
const openStarted = performance.now();
const opened = await service.openFile(path, idResult.value, cancellation.token, { fileFormat: 'legacy' });
const openMilliseconds = performance.now() - openStarted;
if (!opened.ok || opened.value.kind !== 'editable') throw new Error(`T113-open:${opened.ok ? opened.value.kind : opened.error.kind}`);
const afterOpen = rss();
const saveStarted = performance.now();
const saved = await service.saveFile(opened.value.document, path, cancellation.token);
const saveMilliseconds = performance.now() - saveStarted;
if (!saved.ok) throw new Error(`T113-save:${saved.error.kind}`);
const afterSave = rss();
console.log(JSON.stringify({
  diagnosticOnly: true,
  fixture: 'PF11-streaming-persistence-production-path',
  host: { platform: process.platform, architecture: process.arch, bun: Bun.version },
  inputBytes: Buffer.byteLength(text),
  openMilliseconds,
  saveMilliseconds,
  rssKiB: { before: Math.round(before / 1024), afterOpen: Math.round(afterOpen / 1024), afterSave: Math.round(afterSave / 1024) },
  document: {
    utf16Units: opened.value.document.snapshot().lengthUtf16,
    lineBreaks: opened.value.document.snapshot().lineCount - 1,
    lineEndingStorage: opened.value.document.lineEndingStorageMetrics(),
  },
  note: 'single shared-host diagnostic; PF11 fault matrix, cancellation/partial-IO trials, dirty-age recovery, reference storage and repeated distributions remain unmeasured',
}));
cancellation.dispose();
await rm(root, { recursive: true, force: true });
