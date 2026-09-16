import { openTextDocument } from '../../packages/document/src/index';
import { asIdentifier, type DocumentId } from '../../packages/primitives/src/index';

const id = asIdentifier<DocumentId>('T107-eol-metrics', 'documentId');
if (!id.ok) throw new Error(id.error.message);

function fixture(size: number, alternating: boolean): Uint8Array {
  const unit = alternating ? 'x\r\ny\n' : 'x\n';
  return new TextEncoder().encode(unit.repeat(Math.ceil(size / unit.length)).slice(0, size));
}

function measure(size: number, alternating: boolean): Record<string, unknown> {
  const bytes = fixture(size, alternating);
  const opened = openTextDocument(id.value, bytes);
  if (opened.kind !== 'editable') throw new Error(`fixture-not-editable:${size}:${alternating}`);
  const snapshot = opened.document.snapshot();
  const storage = opened.document.lineEndingStorageMetrics();
  return {
    bytes: size,
    pattern: alternating ? 'alternating-crlf-lf' : 'uniform-lf',
    lineBreaks: snapshot.lineCount - 1,
    storage,
    exactSerializedBytes: opened.document.serialize().ok,
  };
}

console.log(JSON.stringify({
  diagnosticOnly: true,
  bun: Bun.version,
  platform: process.platform,
  arch: process.arch,
  measurements: [
    measure(1 * 1024 * 1024, false),
    measure(1 * 1024 * 1024, true),
    measure(10 * 1024 * 1024, false),
    measure(10 * 1024 * 1024, true),
  ],
}, null, 2));
