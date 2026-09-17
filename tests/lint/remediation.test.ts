import { test, expect } from 'bun:test';
import { openTextDocument, type DocumentSnapshot } from '../../packages/document/src/index';
import { resolveVimTextObject, resolveVimWordMotion } from '../../packages/vim/src/index';
import { IncrementalSyntaxHighlighter, type SyntaxParseRequest } from '../../packages/services/syntax/index';
import type { CellColumn, DocumentId, DocumentVersion, RequestId, Utf16Offset } from '../../packages/primitives/src/index';

function observed(text: string) {
  const opened = openTextDocument('lint-window' as DocumentId, new TextEncoder().encode(text));
  if (opened.kind !== 'editable') throw new Error('fixture did not open');
  const original = opened.document.snapshot();
  const reads = { units: 0, max: 0, calls: 0 };
  const snapshot: DocumentSnapshot = {
    id: original.id, version: original.version, revisionId: original.revisionId,
    lengthUtf16: original.lengthUtf16, lineCount: original.lineCount, readOnly: original.readOnly,
    lineIndexAt: at => original.lineIndexAt(at),
    lineStartOffset: line => original.lineStartOffset(line),
    utf8OffsetAt: at => original.utf8OffsetAt(at),
    utf32OffsetAt: at => original.utf32OffsetAt(at),
    offsetAtUtf8: at => original.offsetAtUtf8(at),
    offsetAtUtf32: at => original.offsetAtUtf32(at),
    slice(start, end) {
      reads.units += end - start;
      reads.max = Math.max(reads.max, end - start);
      reads.calls += 1;
      return original.slice(start, end);
    },
  };
  return { snapshot, reads };
}

test('quote escapes survive a read boundary and keep supplementary characters intact', () => {
  for (const escapeCount of [1, 2, 3, 4]) {
    const text = '"' + 'a'.repeat(254) + '\\'.repeat(escapeCount) + '"😀b" tail';
    const { snapshot, reads } = observed(text);
    const range = resolveVimTextObject(snapshot, { documentVersion: snapshot.version, offset: 0 as Utf16Offset }, { key: 'i"' });
    expect(range.ok).toBe(true);
    if (!range.ok) throw new Error(range.error.kind);
    expect(range.value.start as number).toBe(1);
    expect(range.value.end as number).toBe(escapeCount % 2 === 0 ? 255 + escapeCount : text.lastIndexOf('"'));
    expect(reads.max).toBeLessThanOrEqual(256);
  }
});

test('quote pair selection preserves before/inside/after behavior and split surrogate boundaries', () => {
  const text = 'x'.repeat(252) + '"a😀b" next "two"';
  for (const cursor of [0, 252, 254, text.indexOf('next'), text.length - 1]) {
    const { snapshot, reads } = observed(text);
    const range = resolveVimTextObject(snapshot, { documentVersion: snapshot.version, offset: cursor as Utf16Offset }, { key: 'i"' });
    expect(range.ok).toBe(true);
    if (!range.ok) throw new Error(range.error.kind);
    const expected = cursor < text.indexOf('next') ? 'a😀b' : 'two';
    expect(text.slice(range.value.start, range.value.end)).toBe(expected);
    expect(reads.max).toBeLessThanOrEqual(256);
  }
});

test('paragraph inspection does not copy long nonblank lines and scans Unicode blank lines in windows', () => {
  const text = 'x'.repeat(16_384) + '\n' + '\u2003'.repeat(512) + '\nend';
  const { snapshot, reads } = observed(text);
  const range = resolveVimTextObject(snapshot, { documentVersion: snapshot.version, offset: 0 as Utf16Offset }, { key: 'ip' });
  expect(range.ok).toBe(true);
  if (!range.ok) throw new Error(range.error.kind);
  expect(range.value.start as number).toBe(0);
  expect(range.value.end as number).toBe(16_385);
  expect(reads.max).toBeLessThanOrEqual(256);
  expect(reads.units).toBeLessThan(1024);
  console.log('T119 paragraph read counters:', reads);
});

test('text-object scan limits still fail atomically', () => {
  const { snapshot } = observed('"' + 'x'.repeat(100) + '"');
  const range = resolveVimTextObject(snapshot, { documentVersion: snapshot.version, offset: 0 as Utf16Offset }, { key: 'i"' }, { maxScanUtf16: 64 });
  expect(range).toEqual({ ok: false, error: { kind: 'scan-limit-exceeded' } });
});

test('long composing word motion uses linear total window reads and exact next-word position', () => {
  const text = 'a' + '\u0301'.repeat(8192) + ' b';
  const { snapshot, reads } = observed(text);
  const outcome = resolveVimWordMotion(snapshot, {
    documentVersion: snapshot.version, offset: 0 as Utf16Offset, desiredDisplayCellColumn: 0 as CellColumn,
  }, { key: 'w' });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error(outcome.error.kind);
  expect(outcome.value.cursor.offset as number).toBe(text.length - 1);
  expect(reads.units).toBeLessThan(text.length * 8);
  console.log('T119 combining-word read counters:', reads);
});

function request(generation: number): SyntaxParseRequest {
  const opened = openTextDocument('lint-syntax' as DocumentId, new TextEncoder().encode('const x = 1;'));
  if (opened.kind !== 'editable') throw new Error('fixture did not open');
  return {
    documentId: 'lint-syntax' as DocumentId, documentVersion: generation as DocumentVersion,
    requestId: `lint-syntax-${generation}` as RequestId, generation, snapshot: opened.document.snapshot(),
  };
}

test('syntax requests yield an input task between successive parses and flush resolves both', async () => {
  const service = new IncrementalSyntaxHighlighter();
  const events: string[] = [];
  service.onResult(result => {
    events.push(`parse-${result.generation}`);
    if (result.generation === 1) service.submit(request(2));
  });
  try {
    service.submit(request(1));
    const input = new Promise<void>(resolve => setTimeout(() => { events.push('input'); resolve(); }, 0));
    await Promise.resolve();
    expect(service.latest()).toBeUndefined();
    await Promise.all([service.flush(), service.flush(), input]);
    expect(events).toEqual(['parse-1', 'input', 'parse-2']);
    expect(service.pendingRequests()).toBe(0);
  } finally { service.dispose(); }
});

test('disposing syntax completes flush without running an externally scheduled parse', async () => {
  const tasks: (() => void)[] = [];
  const service = new IncrementalSyntaxHighlighter({ schedule: task => { tasks.push(task); } });
  service.submit(request(1));
  const flushed = service.flush();
  service.dispose();
  await flushed;
  for (const task of tasks) task();
  expect(service.pendingRequests()).toBe(0);
  expect(service.latest()).toBeUndefined();
});
