import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { IncrementalSyntaxHighlighter, type SyntaxGrammarProvider, type SyntaxParseRequest } from '../../packages/services/syntax/index';
import { openTextDocument } from '../../packages/document/src/index';
import type { DocumentId, DocumentVersion, RequestId } from '../../packages/primitives/src/index';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TS_WASM_PATH = `${REPO_ROOT}node_modules/@opentui/core/assets/typescript/tree-sitter-typescript.wasm`;
const TS_HIGHLIGHTS_PATH = `${REPO_ROOT}node_modules/@opentui/core/assets/typescript/highlights.scm`;
const RUNTIME_WASM_PATH = `${REPO_ROOT}node_modules/web-tree-sitter/tree-sitter.wasm`;

/** Real, on-disk grammar/runtime -- same loading as tests/syntax/t053-syntax.test.ts. */
const grammarProvider: SyntaxGrammarProvider = {
  async resolve(languageId) {
    if (languageId !== 'typescript') {
      return { ok: false, error: { kind: 'grammar-missing', message: `no test fixture grammar for ${languageId}` } };
    }
    const [wasm, highlights] = await Promise.all([readFile(TS_WASM_PATH), readFile(TS_HIGHLIGHTS_PATH, 'utf-8')]);
    return { ok: true, value: { wasm, highlights } };
  },
};
async function runtimeOptions(): Promise<{ readonly wasmBinary: Uint8Array }> {
  return { wasmBinary: await readFile(RUNTIME_WASM_PATH) };
}

const documentId = 'T112-document' as DocumentId;
const request = (version: number, text: string, languageId?: string): SyntaxParseRequest => {
  const opened = openTextDocument(documentId, new TextEncoder().encode(text));
  if (opened.kind !== 'editable') throw new Error('fixture did not open');
  return {
    documentId,
    documentVersion: version as DocumentVersion,
    requestId: `T112-request-${version}` as RequestId,
    generation: version,
    snapshot: opened.document.snapshot(),
    ...(languageId === undefined ? {} : { languageId }),
  };
};

async function staleParseYieldsToNewInput(): Promise<void> {
  const tasks: Array<() => void> = [];
  const service = new IncrementalSyntaxHighlighter({
    schedule: (task) => { tasks.push(task); },
    maxPendingRequests: 2,
    grammars: grammarProvider,
    runtime: runtimeOptions,
    sliceBudgetMilliseconds: 1.5,
  });
  // A real TypeScript grammar parse, large enough that the parse phase alone (not any capture
  // pass -- publishing no longer runs one) genuinely spans multiple bounded slices.
  const large = 'const value = 1;\nfunction f(x) { return x + 1; }\n'.repeat(7_000);
  assert.equal(service.submit(request(1, large, 'typescript')).accepted, true, 'T112-MAIN-STALL-01 oversized parse is accepted asynchronously');
  assert.equal(tasks.length, 1, 'T112-MAIN-STALL-01 first parse is scheduled instead of running on submit');
  // Grammar loading is real (bounded) async file I/O ahead of the first parse slice, not a
  // synchronous scheduler tick; drain ticks and yield to the event loop between them until the
  // parser has actually started yielding, rather than assuming the very first tick is a slice.
  for (let attempt = 0; attempt < 50 && service.diagnostics().resumableSlices === 0; attempt += 1) {
    tasks.shift()?.();
    if ((tasks.length as number) === 0) await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  }
  assert.ok(service.diagnostics().resumableSlices >= 1, 'T112-MAIN-STALL-01 parser yields before completing the large request');

  assert.equal(service.submit(request(2, 'const newest = true;', 'typescript')).accepted, true, 'T112-MAIN-STALL-01 input arriving during parse is accepted');
  while (tasks.length > 0) tasks.shift()?.();
  await service.flush();
  assert.equal(service.latest()?.documentVersion, 2 as DocumentVersion, 'T112-MAIN-STALL-01 newest input publishes after stale work is cancelled');
  assert.ok(service.diagnostics().staleIgnored >= 1, 'T112-MAIN-STALL-01 stale parser work is never published');
  assert.ok(service.diagnostics().maxObservedQueuedUtf16Units <= 4 * 1024 * 1024, 'T112-QUEUES-01 queued text stays within the shared UTF-16 credit');
  assert.equal(service.submit(request(4, 'const resync = true;', 'typescript')).accepted, true, 'T112-RESYNC-01 missing delta is accepted as a bounded full resync');
  while (tasks.length > 0) tasks.shift()?.();
  await service.flush();
  assert.ok(service.diagnostics().resyncs >= 1, 'T112-RESYNC-01 missing delta increments the explicit resync counter');
  service.dispose();
}

function rejectsUnadmittablePayloadAndDisposesPendingWork(): void {
  const tasks: Array<() => void> = [];
  const service = new IncrementalSyntaxHighlighter({
    maxPendingUtf16Units: 64,
    schedule: (task) => { tasks.push(task); },
  });
  const rejected = service.submit(request(1, 'x'.repeat(65)));
  assert.equal(rejected.accepted, false, 'T112-QUEUES-02 payload over the byte credit is rejected atomically');
  if (!rejected.accepted) assert.equal(rejected.error.kind, 'queue-full');
  assert.equal(service.pendingRequests(), 0, 'T112-QUEUES-02 rejected work is not retained');

  service.dispose();

  const disposalTasks: Array<() => void> = [];
  const disposalService = new IncrementalSyntaxHighlighter({
    schedule: (task) => { disposalTasks.push(task); },
  });
  const accepted = disposalService.submit(request(2, 'x\n'.repeat(20_000)));
  assert.equal(accepted.accepted, true);
  disposalTasks.shift()?.();
  disposalService.dispose();
  while (disposalTasks.length > 0) disposalTasks.shift()?.();
  assert.equal(disposalService.pendingRequests(), 0, 'T112-DISPOSE-01 disposal releases active and scheduled parser work');
}

await staleParseYieldsToNewInput();
rejectsUnadmittablePayloadAndDisposesPendingWork();
console.log('T112 scheduler passed resumable parse yielding, stale cancellation, UTF-16 queue credits and disposal fixtures');
