#!/usr/bin/env bun
/** Diagnostic T109 production Insert planner probe; run from the repository root. */
import { asIdentifier, type DocumentId, type Utf16Offset } from '../../packages/primitives/src/index';
import { openTextDocument } from '../../packages/document/src/index';
import { beginVimInsert, planVimInsertInput, type VimInsertSession } from '../../packages/vim/insert/index';

const idResult = asIdentifier<DocumentId>('T109-long-line-bench', 'documentId');
const documentId: DocumentId = idResult.ok
  ? idResult.value
  : (() => { throw new Error(idResult.error.message); })();
const source = 'x'.repeat(1_048_576);
const opened = openTextDocument(documentId, new TextEncoder().encode(source));
if (opened.kind !== 'editable') throw new Error('long-line-open-failed');
const snapshot = opened.document.snapshot();
const entered = beginVimInsert(snapshot, 524_288 as Utf16Offset, 'i');
if (!entered.ok) throw new Error(`long-line-entry-failed:${entered.error.kind}`);

let session: VimInsertSession = entered.value.session;
const samples: number[] = [];
for (let warmup = 0; warmup < 100; warmup += 1) {
  const planned = planVimInsertInput(snapshot, session, { kind: 'key', key: 'x' });
  if (!planned.ok) throw new Error(`long-line-warmup-failed:${planned.error.kind}`);
  session = planned.value.session ?? session;
}
for (let sample = 0; sample < 10_000; sample += 1) {
  const started = performance.now();
  const planned = planVimInsertInput(snapshot, session, { kind: 'key', key: 'x' });
  samples.push(performance.now() - started);
  if (!planned.ok || planned.value.session === null) throw new Error('long-line-plan-failed');
  session = planned.value.session;
}
samples.sort((left, right) => left - right);
const percentile = (fraction: number): number => samples[Math.ceil(samples.length * fraction) - 1] ?? 0;
console.log(JSON.stringify({
  diagnosticOnly: true,
  fixture: 'PF02-1MiB-single-line-ASCII-middle-insert-planner',
  samples: samples.length,
  sourceUtf16: source.length,
  p50Ms: percentile(.5),
  p95Ms: percentile(.95),
  p99Ms: percentile(.99),
  maxMs: samples.at(-1) ?? 0,
  note: 'planning only; document commit, terminal output and reference-host qualification remain unmeasured',
}));
