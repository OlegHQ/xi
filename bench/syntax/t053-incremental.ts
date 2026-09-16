import {
  IncrementalSyntaxHighlighter,
  type SyntaxParseRequest,
} from '../../packages/services/syntax/index';
import type { DocumentId, DocumentVersion, RequestId } from '../../packages/primitives/src/index';

const id = 'T053-bench' as DocumentId;
const requestId = (value: number): RequestId => `T053-bench-${value}` as RequestId;
const version = (value: number): DocumentVersion => value as DocumentVersion;
const source = Array.from({ length: 2_000 }, (_, line) => `const value${line} = ${line}; // line ${line}`).join('\n');

function request(documentVersion: number, text: string, delta?: SyntaxParseRequest['delta']): SyntaxParseRequest {
  const base: SyntaxParseRequest = { documentId: id, documentVersion: version(documentVersion), requestId: requestId(documentVersion), generation: documentVersion, text };
  return delta === undefined ? base : { ...base, delta };
}

const service = new IncrementalSyntaxHighlighter();
let text = source;
service.submit(request(0, text));
await service.flush();
const started = performance.now();
for (let iteration = 1; iteration <= 200; iteration += 1) {
  const lineStart = text.indexOf('\n', 0) + 1;
  const insertion = `// edit ${iteration}\n`;
  text = `${text.slice(0, lineStart)}${insertion}${text.slice(lineStart)}`;
  service.submit(request(iteration, text, { start: lineStart, oldEnd: lineStart, newEnd: lineStart + insertion.length }));
  await service.flush();
}
const elapsed = performance.now() - started;
const result = service.latest();
console.log(JSON.stringify({
  ticket: 'T053',
  iterations: 200,
  totalLines: result?.stats.totalLines ?? 0,
  lastReparsedLines: result?.stats.reparsedLines ?? 0,
  lastReusedLines: result?.stats.reusedLines ?? 0,
  elapsedMilliseconds: Number(elapsed.toFixed(3)),
  maxObservedQueue: service.diagnostics().maxObservedQueue,
}, null, 2));
service.dispose();
