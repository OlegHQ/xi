#!/usr/bin/env bun
// Regression coverage: the shared IncrementalSyntaxHighlighter tracked a single global
// "latest sequence" that any document's submit() bumped. Opening a second document (or
// simply typing in it) then marked the FIRST document's own still-current queued/active
// request stale, so it was silently dropped and never highlighted. Staleness must be
// tracked per document.
import assert from 'node:assert/strict';
import {
  IncrementalSyntaxHighlighter,
  type SyntaxHighlightResult,
  type SyntaxParseRequest,
} from '../../packages/services/syntax/index';
import { openTextDocument, type DocumentSnapshot } from '../../packages/document/src/index';
import type { DocumentId, DocumentVersion, RequestId } from '../../packages/primitives/src/index';

const documentA = 'PER-DOC-SEQ-a' as DocumentId;
const documentB = 'PER-DOC-SEQ-b' as DocumentId;

function snapshotFor(id: DocumentId, text: string): DocumentSnapshot {
  const opened = openTextDocument(id, new TextEncoder().encode(text));
  if (opened.kind !== 'editable') throw new Error('fixture did not open');
  return opened.document.snapshot();
}

function request(documentId: DocumentId, value: number, text: string): SyntaxParseRequest {
  return {
    documentId,
    documentVersion: value as DocumentVersion,
    requestId: `per-doc-seq-${documentId}-${value}` as RequestId,
    generation: value,
    snapshot: snapshotFor(documentId, text),
  };
}

function main(): void {
  const tasks: Array<() => void> = [];
  const service = new IncrementalSyntaxHighlighter({ maxPendingRequests: 8, schedule: (task) => { tasks.push(task); } });
  const results = new Map<DocumentId, SyntaxHighlightResult>();
  service.onResult((result) => results.set(result.documentId, result));

  // Submit document A's only request, then document B's only request. Neither document is
  // ever resubmitted, so both requests are each document's own latest.
  const submittedA = service.submit(request(documentA, 1, 'const a = 1;'));
  const submittedB = service.submit(request(documentB, 1, 'const b = 2;'));
  assert.equal(submittedA.accepted, true, 'T-PERDOC-01 document A request accepted');
  assert.equal(submittedB.accepted, true, 'T-PERDOC-02 document B request accepted');

  while (tasks.length !== 0) tasks.shift()?.();

  assert.ok(results.has(documentA), 'T-PERDOC-03 document A is highlighted despite document B being submitted after it');
  assert.ok(results.has(documentB), 'T-PERDOC-04 document B is highlighted');
  assert.equal(results.get(documentA)?.documentVersion, 1 as DocumentVersion, 'T-PERDOC-05 document A result carries its own version');
  assert.equal(results.get(documentB)?.documentVersion, 1 as DocumentVersion, 'T-PERDOC-06 document B result carries its own version');
  assert.equal(service.diagnostics().staleIgnored, 0, 'T-PERDOC-07 neither request is treated as stale by the other document');

  // Closing one document must drop its own queued/active work without disturbing the other.
  const tasks2: Array<() => void> = [];
  const service2 = new IncrementalSyntaxHighlighter({ maxPendingRequests: 8, schedule: (task) => { tasks2.push(task); } });
  const results2 = new Map<DocumentId, SyntaxHighlightResult>();
  service2.onResult((result) => results2.set(result.documentId, result));
  service2.submit(request(documentA, 2, 'const a2 = 1;'));
  service2.submit(request(documentB, 2, 'const b2 = 2;'));
  service2.closeDocument(documentA);
  while (tasks2.length !== 0) tasks2.shift()?.();
  assert.equal(results2.has(documentA), false, 'T-PERDOC-08 a closed document never publishes a result for its dropped request');
  assert.ok(results2.has(documentB), 'T-PERDOC-09 the other document is unaffected by closing document A');

  service.dispose();
  service2.dispose();
  console.log('T-PERDOC-SEQ per-document sequence tracking passed: independent documents no longer stale each other, and close drops only its own document');
}

main();
