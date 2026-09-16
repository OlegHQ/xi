import assert from 'node:assert/strict';
import {
  IncrementalSyntaxHighlighter,
  highlightOnce,
  loadTreeSitterGrammar,
  TREE_SITTER_RUNTIME_VERSION,
  type SyntaxHighlightResult,
  type SyntaxParseRequest,
} from '../../packages/services/syntax/index';
import { clipSyntaxSpans, projectSyntaxRow } from '../../packages/ui/editor/index';
import type { DocumentId, DocumentVersion, RequestId } from '../../packages/primitives/src/index';

const documentId = 'T053-document' as DocumentId;
const requestId = (value: number): RequestId => `T053-request-${value}` as RequestId;
const version = (value: number): DocumentVersion => value as DocumentVersion;

function request(value: number, text: string, delta?: SyntaxParseRequest['delta']): SyntaxParseRequest {
  const output: SyntaxParseRequest = {
    documentId,
    documentVersion: version(value),
    requestId: requestId(value),
    generation: value,
    text,
  };
  if (delta !== undefined) return { ...output, delta };
  return output;
}

async function parseFull(value: number, text: string): Promise<SyntaxHighlightResult> {
  return highlightOnce(request(value, text));
}

function edit(source: string, start: number, oldEnd: number, inserted: string): { readonly text: string; readonly delta: NonNullable<SyntaxParseRequest['delta']> } {
  return {
    text: `${source.slice(0, start)}${inserted}${source.slice(oldEnd)}`,
    delta: { start, oldEnd, newEnd: start + inserted.length },
  };
}

async function randomizedIncrementalEquality(): Promise<void> {
  let text = 'const value = 1;\n// comment\nfunction greet(name) { return "hi " + name; }\nconst emoji = "😀";\n';
  const incremental = new IncrementalSyntaxHighlighter({ maxPendingRequests: 4 });
  incremental.submit(request(0, text));
  await incremental.flush();
  const initial = incremental.latest();
  assert.ok(initial);
  assert.equal(initial.status, 'highlighted');
  assert.ok(initial.spans.some((span) => span.kind === 'keyword'));
  assert.ok(initial.spans.some((span) => span.kind === 'function'));

  let state = 0x0530_5eed;
  const nextRandom = (): number => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let step = 1; step <= 80; step += 1) {
    const safe = [...text].map((_, index) => index).filter((index) => {
      const code = text.charCodeAt(index);
      return !(code >= 0xDC00 && code <= 0xDFFF) && !(code >= 0xD800 && code <= 0xDBFF);
    });
    const start = safe[Math.floor(nextRandom() * safe.length)] ?? 0;
    const remove = nextRandom() < 0.55 && start < text.length ? Math.min(3, text.length - start) : 0;
    const inserts = ['', 'x', '/*', '*/', '\nconst n = 42;', '"s"', ' true '];
    const inserted = inserts[Math.floor(nextRandom() * inserts.length)] ?? '';
    const changed = edit(text, start, start + remove, inserted);
    text = changed.text;
    const result = incremental.submit(request(step, text, changed.delta));
    assert.equal(result.accepted, true, `T053-RANDOM-EDIT-${step} request accepted`);
    await incremental.flush();
    const actual = incremental.latest();
    const expected = await parseFull(step, text);
    assert.ok(actual);
    assert.equal(actual.documentVersion, expected.documentVersion);
    assert.equal(actual.status, expected.status, `T053-RANDOM-EDIT-${step} status`);
    assert.deepEqual(actual.spans, expected.spans, `T053-RANDOM-EDIT-${step} incremental spans equal full parse`);
  }
  const diagnostics = incremental.diagnostics();
  assert.ok(diagnostics.completed >= 81);
  assert.ok(diagnostics.maxObservedQueue <= 4);
  incremental.dispose();
}

function staleResultIsIgnored(): void {
  const tasks: (() => void)[] = [];
  const service = new IncrementalSyntaxHighlighter({ maxPendingRequests: 4, schedule: (task) => { tasks.push(task); } });
  service.submit(request(1, 'const old = 1;'));
  service.submit(request(2, 'const newest = 2;'));
  assert.equal(service.latest(), undefined, 'T053-STALE-01 typing does not synchronously wait for parse');
  while (tasks.length !== 0) tasks.shift()?.();
  assert.equal(service.latest()?.documentVersion, version(2));
  assert.equal(service.diagnostics().staleIgnored, 1, 'T053-STALE-02 obsolete parse is ignored');
  service.dispose();
}

async function oversizedParseYieldsToInput(): Promise<void> {
  const events: string[] = [];
  let slices = 0;
  const service = new IncrementalSyntaxHighlighter({
    maxDocumentUnits: 300_000,
    schedule: (task) => setTimeout(() => {
      slices += 1;
      events.push(`slice-${slices}`);
      task();
    }, 0),
  });
  service.onResult(() => events.push('complete'));
  service.submit(request(30, `${'x\n'.repeat(100_000)}tail`));
  const firstInputWindow = new Promise<void>((resolve) => {
    setTimeout(() => {
      events.push('input');
      resolve();
    }, 0);
  });
  // The first scheduled parse slice starts before this timer can fire. Its
  // cooperative yield schedules another slice, allowing the input timer to
  // run while the full resync is still pending.
  await Promise.all([service.flush(), firstInputWindow]);
  const inputIndex = events.indexOf('input');
  const completeIndex = events.indexOf('complete');
  assert.ok(inputIndex > 0, `T053-STALL-01 input ran after parsing began (${events.join(',')})`);
  assert.ok(completeIndex > inputIndex, `T053-STALL-02 input ran before parse completion (${events.join(',')})`);
  assert.ok(service.diagnostics().resumableSlices > 0, 'T053-STALL-03 large resync yielded between bounded slices');
  slices = service.diagnostics().resumableSlices;
  assert.ok(slices >= 2, `T053-STALL-04 full resync produced multiple slices (${slices})`);
  service.dispose();
}

async function boundedFailureCases(): Promise<void> {
  const giant = await highlightOnce(request(1, 'const value = 1;\n' + 'x'.repeat(100)), { maxLineUnits: 32 });
  assert.equal(giant.status, 'plain-text');
  assert.equal(giant.fallback, 'giant-line', 'T053-GIANT-LINE-01 giant line falls back to plain text');
  const large = await highlightOnce(request(2, 'x'.repeat(200)), { maxDocumentUnits: 64 });
  assert.equal(large.status, 'large-file');
  assert.equal(large.fallback, 'large-file', 'T053-LARGE-FILE-01 large file disables expensive highlighting');
  const crashed = await highlightOnce(request(20, 'const malformed = "\uD800";'));
  assert.equal(crashed.status, 'plain-text');
  assert.equal(crashed.fallback, 'parser-crash', 'T053-PARSER-CRASH-01 malformed UTF-16 is contained by parser fallback');

  const start = performance.now();
  const service = new IncrementalSyntaxHighlighter({ maxPendingRequests: 2 });
  const accepted = service.submit(request(3, 'const typing = 3;'));
  const elapsed = performance.now() - start;
  assert.equal(accepted.accepted, true);
  assert.ok(elapsed < 20, `T053-TYPING-01 submit remained asynchronous (${elapsed.toFixed(2)}ms)`);
  assert.equal(service.latest(), undefined);
  await service.flush();
  assert.equal(service.latest()?.status, 'highlighted');
  service.dispose();

  const missing = await loadTreeSitterGrammar('/xi/grammar/does-not-exist.wasm');
  assert.equal(missing.ok, false, 'T053-GRAMMAR-MISSING-01 missing grammar is reported');
  if (!missing.ok) assert.equal(missing.error.kind, 'grammar-missing');
  assert.equal(TREE_SITTER_RUNTIME_VERSION, '0.25.10');
}

function clippedRowsAreBounded(): void {
  const spans = [
    { start: 12, end: 20, kind: 'keyword' as const },
    { start: 2, end: 8, kind: 'comment' as const },
    { start: 7, end: 14, kind: 'string' as const },
  ];
  assert.deepEqual(clipSyntaxSpans(spans, 5, 13), [
    { start: 0, end: 3, kind: 'comment' },
    { start: 2, end: 8, kind: 'string' },
    { start: 7, end: 8, kind: 'keyword' },
  ]);
  const row = projectSyntaxRow(spans, 5, 13, 1);
  assert.equal(row.spans.length, 1);
  assert.equal(row.truncated, true);
  assert.deepEqual(clipSyntaxSpans(spans, 0, 100, 0), []);
  console.log('T053 syntax passed randomized incremental/full equality, stale suppression, bounded typing, grammar/large-file failures and clipped rows');
}

await randomizedIncrementalEquality();
staleResultIsIgnored();
await oversizedParseYieldsToInput();
await boundedFailureCases();
clippedRowsAreBounded();
