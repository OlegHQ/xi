#!/usr/bin/env bun
// F1-5 integration: `SyntaxDocumentTracker#changeDocument` must build a `deltas` array (not
// `delta: undefined`) for a real multi-span `CommittedDocumentChange` (the shape a genuine
// multi-cursor edit produces), and `IncrementalSyntaxHighlighter` must consume it as a
// contiguous incremental parse (no forced full resync), classifying identically to a from-
// scratch parse of the resulting text. Uses the real document commit path (TextFileDocument) to
// get genuine `changedSpans`, and the real tree-sitter runtime/grammar (no fakes).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SyntaxDocumentTracker, highlightOnce, type SyntaxGrammarProvider } from '../../packages/services/syntax/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { asIdentifier, asUndoGroupId, type DocumentId } from '../../packages/primitives/src/index';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TS_WASM_PATH = `${REPO_ROOT}node_modules/@opentui/core/assets/typescript/tree-sitter-typescript.wasm`;
const TS_HIGHLIGHTS_PATH = `${REPO_ROOT}node_modules/@opentui/core/assets/typescript/highlights.scm`;
const RUNTIME_WASM_PATH = `${REPO_ROOT}node_modules/web-tree-sitter/tree-sitter.wasm`;

const grammarProvider: SyntaxGrammarProvider = {
  async resolve(languageId) {
    if (languageId !== 'typescript') return { ok: false, error: { kind: 'grammar-missing', message: `no fixture grammar for ${languageId}` } };
    const [wasm, highlights] = await Promise.all([readFile(TS_WASM_PATH), readFile(TS_HIGHLIGHTS_PATH, 'utf-8')]);
    return { ok: true, value: { wasm, highlights } };
  },
};
async function runtimeOptions(): Promise<{ readonly wasmBinary: Uint8Array }> { return { wasmBinary: await readFile(RUNTIME_WASM_PATH) }; }

async function main(): Promise<void> {
  const idResult = asIdentifier<DocumentId>('F1-5-tracker-document', 'documentId');
  assert.ok(idResult.ok, 'fixture document id is valid');
  const documentId = idResult.ok ? idResult.value : (undefined as never);

  const baseText = 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nfunction f() { return a + b + c + d; }\n';
  const created = TextFileDocument.create(documentId, baseText, Array.from({ length: baseText.split('\n').length - 1 }, () => 'lf' as const), 'lf');
  assert.ok(created.ok, 'fixture document opens');
  const source = created.ok ? created.value : (undefined as never);
  const group = asUndoGroupId('F1-5-tracker');
  assert.ok(group.ok, 'fixture has an undo group');

  const tracker = new SyntaxDocumentTracker({ grammars: grammarProvider, runtime: runtimeOptions });
  tracker.openDocument({ documentId, languageId: 'typescript', snapshot: source.snapshot() });
  await new Promise<void>((resolve) => { const subscription = tracker.onResult(() => { subscription.dispose(); resolve(); }); });
  assert.equal(tracker.readSyntax(documentId)?.documentVersion, source.version, 'F1-5f tracker published the initial parse');

  // Four disjoint insertions ("four cursors"), each inserting one character -- a genuine
  // multi-span commit, not a synthetic delta.
  const insertions = [
    { start: baseText.indexOf('a = 1') + 1, text: 'X' },
    { start: baseText.indexOf('b = 2') + 1, text: 'X' },
    { start: baseText.indexOf('c = 3') + 1, text: 'X' },
    { start: baseText.indexOf('d = 4') + 1, text: 'X' },
  ];
  const outcome = source.commit({
    documentId: source.id,
    expectedVersion: source.version,
    edits: insertions.map((insertion) => ({ start: insertion.start as never, end: insertion.start as never, text: insertion.text })),
    origin: 'vim',
    undoGroup: group.ok ? group.value : (undefined as never),
  });
  assert.ok(outcome.ok && outcome.value.kind === 'committed', 'multi-span commit succeeds');
  if (!outcome.ok || outcome.value.kind !== 'committed') return;
  const change = outcome.value.change;
  assert.ok(change.changedSpans.length === 4, `F1-5g the commit produced 4 disjoint changed spans, got ${change.changedSpans.length}`);

  tracker.changeDocument(change);
  await new Promise<void>((resolve) => { const subscription = tracker.onResult(() => { subscription.dispose(); resolve(); }); });

  assert.equal(tracker.diagnostics().resyncs, 0, 'F1-5h a genuine multi-cursor commit through the tracker stays a contiguous incremental parse, not a forced resync');
  const read = tracker.readSyntax(documentId);
  assert.ok(read !== undefined, 'F1-5i a read is published for the edited document');
  assert.equal(read?.documentVersion, change.snapshot.version, 'F1-5j the published read reflects the edited version');

  // Correctness: the incremental result must classify identically to a from-scratch parse of
  // the exact same final text.
  const finalLength = change.snapshot.lengthUtf16 as number;
  const reference = await highlightOnce(
    { documentId, documentVersion: change.snapshot.version, requestId: 'F1-5-reference' as never, generation: 999, snapshot: change.snapshot, languageId: 'typescript' },
    { grammars: grammarProvider, runtime: runtimeOptions },
  );
  // spansInRange is non-blocking: a cold call only enqueues background work (real timers here,
  // since the tracker owns its own default scheduler). Poll until the window materializes.
  const referenceSpans = reference.spansInRange(0, finalLength);
  let incrementalSpans = read?.spansInRange(0, finalLength) ?? [];
  for (let attempt = 0; attempt < 200 && incrementalSpans.length === 0 && referenceSpans.length > 0; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    incrementalSpans = read?.spansInRange(0, finalLength) ?? [];
  }
  assert.deepEqual(incrementalSpans, referenceSpans, 'F1-5k incremental multi-cursor spans match a from-scratch parse of the same text');

  tracker.dispose();
  console.log('F1-5 tracker-multi-cursor-delta: PASS');
}

await main();
