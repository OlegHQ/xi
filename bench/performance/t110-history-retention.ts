import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { asIdentifier, asUndoGroupId, type DocumentId, type UndoGroupId, type Utf16Offset } from '../../packages/primitives/src/index';
import { LineEndingSequence, TextFileDocument } from '../../packages/document/src/index';

const BYTES = 100 * 1024 * 1024;
const source = 'x\n'.repeat(BYTES / 2);
const documentId = checked<DocumentId>('T110-PF06-document');
const undoGroup = checked<UndoGroupId>('T110-PF06-delete');

const openStart = performance.now();
const created = TextFileDocument.create(documentId, source, LineEndingSequence.fromUniform(source.length / 2, 'lf'), 'lf');
if (!created.ok) throw new Error(`T110-PF06-create:${created.error.kind}`);
const document = created.value;
const openWallMs = performance.now() - openStart;
const before = document.snapshot();
const commitStart = performance.now();
const deleted = document.commit({
  documentId,
  expectedVersion: before.version,
  edits: [{ start: 0 as Utf16Offset, end: source.length as Utf16Offset, text: '' }],
  origin: 'vim',
  undoGroup,
});
if (!deleted.ok) throw new Error(`T110-PF06-delete:${deleted.error.kind}`);
const deleteWallMs = performance.now() - commitStart;
const afterDelete = document.undoHistoryStats();
const undoStart = performance.now();
const undone = document.undo();
if (!undone.ok) throw new Error(`T110-PF06-undo:${undone.error.kind}`);
const undoWallMs = performance.now() - undoStart;
const restored = document.snapshot().slice(0 as Utf16Offset, source.length as Utf16Offset);
if (!restored.ok || restored.value !== source) throw new Error('T110-PF06-bytes-not-restored');
const stats = document.undoHistoryStats();
const artifact = {
  schemaVersion: 1,
  fixture: 'PF06',
  sourceUtf16Units: source.length,
  lineBreaks: source.length / 2,
  openWallMs,
  deleteWallMs,
  undoWallMs,
  statsAfterDelete: afterDelete,
  statsAfterUndo: stats,
  exactRestore: true,
  note: 'Diagnostic single process; no reference-host qualification or allocator census.',
};
await mkdir(resolve('.artifacts/performance/T110'), { recursive: true });
const artifactPath = resolve('.artifacts/performance/T110/pf06-100MiB-source-backed.json');
await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({ ...artifact, artifactPath }, null, 2));

function checked<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T110-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
