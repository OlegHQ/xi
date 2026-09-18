#!/usr/bin/env bun
// F1-8: `LanguageDocumentSync`'s `editPayloadBytes` (called synchronously in the commit frame,
// once per accepted change, to bound the pending-edit byte budget) allocated a `TextEncoder`
// plus one throwaway `Uint8Array` per edit via `encoder.encode(edit.text).byteLength`, instead of
// `Buffer.byteLength(edit.text, 'utf8')`, which measures UTF-8 length without allocating. This
// runs on the keystroke-adjacent commit path (see AGENTS.md: ordinary engine steps p95 <= 1ms).
//
// Two checks: (a) correctness -- the byte accounting must still be true UTF-8 byte length (not
// UTF-16 length or some other approximation), verified by triggering `maxQueuedBytes` at the
// exact multi-byte boundary through the real `LanguageDocumentSync#acceptChange` path; and (b) a
// timing comparison (p95 over 30+ iterations) of the old allocate-per-edit pattern against
// `Buffer.byteLength` on a realistic multi-cursor-sized edit batch.
import assert from 'node:assert/strict';
import { LanguageDocumentSync, type LanguageSyncDocument } from '../../packages/services/language';
import { TextFileDocument } from '../../packages/document/src/index';
import type { CommittedDocumentChange } from '../../packages/document/src/index';
import { asIdentifier, asUndoGroupId, type DocumentId } from '../../packages/primitives/src/index';

type JsonRecord = Record<string, unknown>;

class FakeTransport {
  readonly messages: JsonRecord[] = [];
  async notify(method: string, params?: unknown): Promise<void> { this.messages.push({ method, params }); }
}

function document(version: number, text: string): LanguageSyncDocument {
  return { uri: 'file:///workspace/payload-bytes.ts', languageId: 'typescript', version, text };
}

function percentile(sorted: readonly number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index] ?? 0;
}

async function testUtf8ByteAccountingIsExact(): Promise<void> {
  // A single emoji edit: 1 UTF-16 code unit pair (2 units), 4 UTF-8 bytes. A char-count or
  // UTF-16-length-based accounting would under-count this and never trip the byte budget where
  // it should.
  const emoji = '\u{1F600}'; // 4 bytes in UTF-8, 2 UTF-16 units
  const transport = new FakeTransport();
  // Budget sized so exactly one emoji edit's true 4 UTF-8 bytes fits, but two do not.
  const sync = new LanguageDocumentSync({ transport, maxQueuedBytes: 4, capabilities: { positionEncoding: 'utf-16', textDocumentSync: { change: 2, openClose: true } } });
  const idResult = asIdentifier<DocumentId>('sync-payload-bytes', 'documentId');
  assert.ok(idResult.ok, 'fixture document id is valid');
  const created = TextFileDocument.create(idResult.ok ? idResult.value : (undefined as never), 'ab', [], 'lf');
  assert.ok(created.ok, 'source document opens');
  const source = created.ok ? created.value : (undefined as never);
  const group = asUndoGroupId('sync-payload-bytes');
  assert.ok(group.ok, 'fixture has an undo group');

  const opened = await sync.openDocument(document(1, 'ab'));
  assert.ok(opened.ok, 'didOpen accepted');
  await sync.whenIdle();

  function commitEmojiInsert(): CommittedDocumentChange {
    const outcome = source.commit({
      documentId: source.id,
      expectedVersion: source.version,
      edits: [{ start: source.snapshot().lengthUtf16 as never, end: source.snapshot().lengthUtf16 as never, text: emoji }],
      origin: 'vim',
      undoGroup: group.ok ? group.value : (undefined as never),
    });
    assert.ok(outcome.ok && outcome.value.kind === 'committed', 'emoji insert commits');
    if (!outcome.ok || outcome.value.kind !== 'committed') throw new Error('unreachable');
    return outcome.value.change;
  }

  // Two 4-byte emoji edits admitted BEFORE the flush macrotask runs, so they accumulate in the
  // same pending-byte window: 4 + 4 = 8 > the 4-byte budget. A char-count or UTF-16-length-based
  // accounting would see this as "2 units + 2 units = 4 <= 4" and never trip the budget; true
  // UTF-8 byte accounting must trip it on the second edit.
  const first = sync.acceptChange(commitEmojiInsert(), 'file:///workspace/payload-bytes.ts');
  assert.ok(first.ok, 'first emoji edit admitted');
  const second = sync.acceptChange(commitEmojiInsert(), 'file:///workspace/payload-bytes.ts');
  assert.ok(second.ok, 'second emoji edit admitted');
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await sync.whenIdle();

  const changeMessages = transport.messages.filter((message) => message.method === 'textDocument/didChange');
  assert.equal(changeMessages.length, 1, 'F1-8a both edits flush together in one message once the budget forces a resync');
  const params = changeMessages[0]?.params as JsonRecord;
  const contentChanges = params.contentChanges as readonly JsonRecord[];
  assert.ok(contentChanges[0]?.range === undefined, 'F1-8b exceeding the true UTF-8 byte budget (4+4 > 4) forces a full-document resync, proving byte-exact (not char-count) accounting');
}

function timingComparison(): void {
  const editCount = 50; // matches the F1-5 multi-cursor scale this same commit path serves
  const text = 'const héllo = "wörld 🎉"; '; // mixed ASCII/BMP/astral, exercises real multi-byte width
  const edits: readonly { readonly text: string }[] = Array.from({ length: editCount }, () => ({ text }));

  function oldWay(): number {
    const encoder = new TextEncoder();
    let bytes = 0;
    for (const edit of edits) bytes += encoder.encode(edit.text).byteLength;
    return bytes;
  }
  function newWay(): number {
    let bytes = 0;
    for (const edit of edits) bytes += Buffer.byteLength(edit.text, 'utf8');
    return bytes;
  }
  assert.equal(oldWay(), newWay(), 'F1-8e both accounting methods must agree on the true UTF-8 byte total');

  const iterations = 60;
  const oldSamples: number[] = [];
  const newSamples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const oldStart = performance.now();
    oldWay();
    oldSamples.push(performance.now() - oldStart);
    const newStart = performance.now();
    newWay();
    newSamples.push(performance.now() - newStart);
  }
  oldSamples.sort((a, b) => a - b);
  newSamples.sort((a, b) => a - b);
  const oldP95 = percentile(oldSamples, 0.95);
  const newP95 = percentile(newSamples, 0.95);
  console.log(`F1-8 editPayloadBytes timing over ${iterations} iterations, ${editCount} edits/call: old(TextEncoder) p95=${oldP95.toFixed(4)}ms, new(Buffer.byteLength) p95=${newP95.toFixed(4)}ms`);

  assert.ok(newP95 < 0.5, `F1-8f Buffer.byteLength p95 stays well within the synchronous commit-frame budget (was ${newP95.toFixed(4)}ms)`);
  assert.ok(newP95 <= oldP95, `F1-8g Buffer.byteLength must not be slower than the allocate-per-edit TextEncoder pattern (new p95 ${newP95.toFixed(4)}ms vs old p95 ${oldP95.toFixed(4)}ms)`);
}

await testUtf8ByteAccountingIsExact();
timingComparison();
console.log('F1-8 sync-edit-payload-bytes-perf: PASS');
