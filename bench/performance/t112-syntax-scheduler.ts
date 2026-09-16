#!/usr/bin/env bun
/** Diagnostic T112 probe; it measures resumable syntax scheduling, not a release gate. */
import { IncrementalSyntaxHighlighter, type SyntaxParseRequest } from '../../packages/services/syntax/index';
import type { DocumentId, DocumentVersion, RequestId } from '../../packages/primitives/src/index';

const inputBytes = 1_048_576;
const text = 'x\n'.repeat(Math.floor(inputBytes / 2));
const request: SyntaxParseRequest = {
  documentId: 'T112-bench-document' as DocumentId,
  documentVersion: 1 as DocumentVersion,
  requestId: 'T112-bench-request' as RequestId,
  generation: 1,
  text,
};
const service = new IncrementalSyntaxHighlighter();
const started = performance.now();
const accepted = service.submit(request);
if (!accepted.accepted) throw new Error(`T112-submit:${accepted.error.kind}`);
await service.flush();
const elapsedMilliseconds = performance.now() - started;
const result = service.latest();
if (result === undefined || result.documentVersion !== request.documentVersion) throw new Error('T112-result');
console.log(JSON.stringify({
  diagnosticOnly: true,
  fixture: 'PF09-parse-flood-resumable-syntax',
  host: { platform: process.platform, architecture: process.arch, bun: Bun.version },
  inputUtf16Units: text.length,
  elapsedMilliseconds,
  result: { status: result.status, spans: result.spans.length, lines: result.stats.totalLines },
  diagnostics: service.diagnostics(),
  note: 'single shared-host run; worker/native allocation, loaded input storm, reference host and full adapter matrix remain unmeasured',
}));
service.dispose();
