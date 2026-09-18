#!/usr/bin/env bun
// F1-5 regression + measured before/after: `SyntaxDocumentTracker#changeDocument` only built a
// single-span `SyntaxDelta` when `change.changedSpans.length === 1`; any multi-cursor edit (many
// disjoint changed spans in one commit) fell back to `delta: undefined`, which
// `IncrementalSyntaxHighlighter`'s `contiguousDelta` check treats as "not contiguous" --
// `oldTree` stays null and the whole document is reparsed from scratch on every multi-cursor
// keystroke, no matter how small each edit is.
//
// The fix: `IncrementalSyntaxHighlighter` now accepts a `deltas` array and applies `tree.edit()`
// once per span (reverse document order) before parsing, so `oldTree` stays non-null and
// Tree-sitter's incremental parse only redoes the touched regions. This test measures the SAME
// 50-cursor single-character-insert edit on a real ~1 MiB TypeScript-like document two ways
// against the real (non-faked) tree-sitter runtime/grammar: with `deltas` (the fixed path, what
// SyntaxDocumentTracker now sends) and with no delta at all (`delta: undefined`, exactly what
// the buggy single-span-only tracker code produced for this case) -- i.e. a genuine before/after
// on the same fixture, not a source-toggle.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  IncrementalSyntaxHighlighter,
  type SyntaxDelta,
  type SyntaxGrammarProvider,
  type SyntaxParseRequest,
} from '../../packages/services/syntax/index';
import { openTextDocument, type DocumentSnapshot } from '../../packages/document/src/index';
import type { DocumentId, DocumentVersion, RequestId } from '../../packages/primitives/src/index';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TS_WASM_PATH = `${REPO_ROOT}node_modules/@opentui/core/assets/typescript/tree-sitter-typescript.wasm`;
const TS_HIGHLIGHTS_PATH = `${REPO_ROOT}node_modules/@opentui/core/assets/typescript/highlights.scm`;
const RUNTIME_WASM_PATH = `${REPO_ROOT}node_modules/web-tree-sitter/tree-sitter.wasm`;

/** Real, on-disk grammar/runtime -- no fakes, matching tests/syntax/t053-syntax.test.ts. */
const grammarProvider: SyntaxGrammarProvider = {
  async resolve(languageId) {
    if (languageId !== 'typescript') return { ok: false, error: { kind: 'grammar-missing', message: `no fixture grammar for ${languageId}` } };
    const [wasm, highlights] = await Promise.all([readFile(TS_WASM_PATH), readFile(TS_HIGHLIGHTS_PATH, 'utf-8')]);
    return { ok: true, value: { wasm, highlights } };
  },
};
async function runtimeOptions(): Promise<{ readonly wasmBinary: Uint8Array }> { return { wasmBinary: await readFile(RUNTIME_WASM_PATH) }; }

const documentId = 'F1-5-document' as DocumentId;
function snapshotFor(text: string): DocumentSnapshot {
  const opened = openTextDocument(documentId, new TextEncoder().encode(text));
  if (opened.kind !== 'editable') throw new Error('F1-5 fixture did not open');
  return opened.document.snapshot();
}
function request(value: number, text: string, extra?: { readonly delta?: SyntaxDelta; readonly deltas?: readonly SyntaxDelta[] }): SyntaxParseRequest {
  return {
    documentId,
    documentVersion: value as DocumentVersion,
    requestId: `F1-5-request-${value}` as RequestId,
    generation: value,
    snapshot: snapshotFor(text),
    languageId: 'typescript',
    ...(extra?.delta === undefined ? {} : { delta: extra.delta }),
    ...(extra?.deltas === undefined ? {} : { deltas: extra.deltas }),
  };
}

async function main(): Promise<void> {
  const unit = 'const value = 1;\nfunction f(x) { return x + 1; }\n';
  const base = unit.repeat(Math.ceil(1_100_000 / unit.length));
  assert.ok(base.length > 1_000_000, `F1-5 fixture must exceed 1 MiB, was ${base.length}`);

  // 50 scattered single-character insertions, mimicking a 50-cursor edit.
  const cursorCount = 50;
  const step = Math.floor((base.length - 2_000) / cursorCount);
  const offsets: number[] = [];
  for (let i = 0; i < cursorCount; i += 1) offsets.push(1_000 + i * step);

  const editedText = (() => {
    let text = base;
    for (const offset of [...offsets].reverse()) text = `${text.slice(0, offset)}X${text.slice(offset)}`;
    return text;
  })();

  // `newEnd` is each span's own LOCAL replacement end (start + insertedLength = offset + 1), not
  // a cumulative final-document position: tree.edit() calls compound automatically across a
  // reverse-order batch (see SyntaxDocumentTracker#changeDocument), so a cumulative value here
  // double-counts shift and corrupts the tree (confirmed while writing this test: it costs far
  // more than a full reparse, not less).
  const deltas: SyntaxDelta[] = offsets.map((offset) => ({
    start: offset,
    oldEnd: offset,
    newEnd: offset + 1,
  })).reverse(); // reverse document order, exactly what SyntaxDocumentTracker#changeDocument now builds

  async function measure(useDeltas: boolean): Promise<{ readonly ms: number; readonly resyncs: number; readonly spans: readonly { readonly start: number; readonly end: number; readonly kind: unknown }[] }> {
    const service = new IncrementalSyntaxHighlighter({ grammars: grammarProvider, runtime: runtimeOptions });
    service.submit(request(1, base));
    await service.flush();
    assert.equal(service.latest()?.status, 'highlighted', 'F1-5 baseline parse highlights successfully');

    const startedAt = performance.now();
    let publishedAt = 0;
    const subscription = service.onResult(() => { publishedAt = performance.now(); });
    service.submit(request(2, editedText, useDeltas ? { deltas } : {}));
    await service.flush();
    subscription.dispose();
    const resyncs = service.diagnostics().resyncs;
    const spans = service.latest()?.spans ?? [];
    service.dispose();
    return { ms: publishedAt - startedAt, resyncs, spans };
  }

  const before = await measure(false); // no delta at all: what the buggy tracker sent for any multi-span commit
  const after = await measure(true); // deltas array: the fixed tracker's output

  // Correctness, not just speed: the incremental multi-delta path must classify the edited
  // document identically to a from-scratch parse of the exact same final text (the `before` run
  // above IS such a from-scratch parse, since it forced a full resync).
  assert.deepEqual(after.spans, before.spans, 'F1-5e the incremental multi-cursor parse must classify identically to a full reparse of the same final text');

  console.log(`F1-5 multi-cursor (50 edits) on a ${base.length}-unit document: before(no delta)=${before.ms.toFixed(2)}ms resyncs=${before.resyncs}, after(deltas)=${after.ms.toFixed(2)}ms resyncs=${after.resyncs}`);

  assert.equal(before.resyncs, 1, 'F1-5a submitting with no delta at all is a forced full resync (the pre-fix behavior for any multi-span commit)');
  assert.equal(after.resyncs, 0, 'F1-5b submitting the deltas array stays a contiguous incremental parse -- no resync');
  // Measured on this host: before (forced full resync) ~450-490ms, after (incremental,
  // deltas) ~64-76ms -- roughly a 6-7x reduction, well under half of the full-reparse cost.
  // The bound below allows headroom over that measured range without being a full reparse.
  assert.ok(after.ms < 150, `F1-5c incremental multi-cursor parse stays bounded, well under a full reparse (was ${after.ms.toFixed(2)}ms)`);
  assert.ok(after.ms < before.ms * 0.5, `F1-5d the incremental path must be substantially faster than the forced full reparse (after ${after.ms.toFixed(2)}ms vs before ${before.ms.toFixed(2)}ms)`);

  console.log('F1-5 multi-cursor-incremental-perf: PASS');
}

await main();
