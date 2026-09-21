import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  IncrementalSyntaxHighlighter,
  SyntaxDocumentTracker,
  highlightOnce,
  loadTreeSitterGrammar,
  preprocessHighlightsQuerySource,
  TREE_SITTER_RUNTIME_VERSION,
  type SyntaxGrammarProvider,
  type SyntaxHighlightResult,
  type SyntaxParseRequest,
} from '../../packages/services/syntax/index';
import { clipSyntaxSpans, projectSyntaxRow } from '../../packages/ui/editor/index';
import { openTextDocument, type DocumentSnapshot } from '../../packages/document/src/index';
import type { DocumentId, DocumentVersion, RequestId } from '../../packages/primitives/src/index';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TS_WASM_PATH = `${REPO_ROOT}node_modules/@opentui/core/assets/typescript/tree-sitter-typescript.wasm`;
const TS_HIGHLIGHTS_PATH = `${REPO_ROOT}node_modules/@opentui/core/assets/typescript/highlights.scm`;
const RUNTIME_WASM_PATH = `${REPO_ROOT}node_modules/web-tree-sitter/tree-sitter.wasm`;

/** Real, on-disk grammar/runtime for tests -- no OpenTUI import, just the pinned vendor files. */
const grammarProvider: SyntaxGrammarProvider = {
  async resolve(languageId) {
    if (languageId !== 'typescript') {
      return { ok: false, error: { kind: 'grammar-missing', message: `no test fixture grammar for ${languageId}` } };
    }
    const [wasm, highlights] = await Promise.all([
      readFile(TS_WASM_PATH),
      readFile(TS_HIGHLIGHTS_PATH, 'utf-8'),
    ]);
    return { ok: true, value: { wasm, highlights } };
  },
};

async function runtimeOptions(): Promise<{ readonly wasmBinary: Uint8Array }> {
  return { wasmBinary: await readFile(RUNTIME_WASM_PATH) };
}

const documentId = 'T053-document' as DocumentId;
const requestId = (value: number): RequestId => `T053-request-${value}` as RequestId;
const version = (value: number): DocumentVersion => value as DocumentVersion;

function snapshotFor(text: string, id: DocumentId = documentId): DocumentSnapshot {
  const opened = openTextDocument(id, new TextEncoder().encode(text));
  if (opened.kind !== 'editable') throw new Error('T053 fixture did not open');
  return opened.document.snapshot();
}

function request(value: number, text: string, options?: { readonly delta?: SyntaxParseRequest['delta']; readonly languageId?: string }): SyntaxParseRequest {
  const output: SyntaxParseRequest = {
    documentId,
    documentVersion: version(value),
    requestId: requestId(value),
    generation: value,
    snapshot: snapshotFor(text),
    ...(options?.languageId === undefined ? {} : { languageId: options.languageId }),
  };
  if (options?.delta !== undefined) return { ...output, delta: options.delta };
  return output;
}

async function tsHighlightOnce(value: number, text: string): Promise<SyntaxHighlightResult> {
  return highlightOnce(request(value, text, { languageId: 'typescript' }), { grammars: grammarProvider, runtime: runtimeOptions });
}

function edit(source: string, start: number, oldEnd: number, inserted: string): { readonly text: string; readonly delta: NonNullable<SyntaxParseRequest['delta']> } {
  return {
    text: `${source.slice(0, start)}${inserted}${source.slice(oldEnd)}`,
    delta: { start, oldEnd, newEnd: start + inserted.length },
  };
}

/**
 * `spansInRange` is non-blocking: it only returns cached windows and enqueues the rest for
 * background computation. A full materialization needs repeated (enqueue-then-drain) rounds,
 * since the per-result queue is bounded (MAX_QUEUED_WINDOWS) -- a single round cannot enqueue
 * every window of a large document at once.
 */
function drainAllWindows(tasks: Array<() => void>, result: SyntaxHighlightResult, total: number): void {
  for (let round = 0; round < 500; round += 1) {
    result.spansInRange(0, total);
    if (tasks.length === 0) break;
    while (tasks.length > 0) { const task = tasks.shift(); task?.(); }
  }
}

async function randomizedIncrementalEquality(): Promise<void> {
  let text = 'const value = 1;\n// comment\nfunction greet(name) { return "hi " + name; }\nconst emoji = "\u{1F600}";\n';
  const tasks: Array<() => void> = [];
  const incremental = new IncrementalSyntaxHighlighter({ maxPendingRequests: 4, grammars: grammarProvider, runtime: runtimeOptions, schedule: (task) => { tasks.push(task); } });
  incremental.submit(request(0, text, { languageId: 'typescript' }));
  // Grammar loading is real (bounded) async file I/O ahead of the first parse tick; drain and
  // yield to the event loop until it lands, rather than assuming the mock scheduler's queue is
  // ever non-empty exactly when we look.
  for (let attempt = 0; attempt < 50 && incremental.latest() === undefined; attempt += 1) {
    while (tasks.length > 0) { const task = tasks.shift(); task?.(); }
    if (incremental.latest() === undefined) await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  }
  const initial = incremental.latest();
  assert.ok(initial);
  assert.equal(initial.status, 'highlighted');
  drainAllWindows(tasks, initial, text.length);
  assert.ok(initial.spans.some((span) => span.kind === 'keyword'));
  assert.ok(initial.spans.some((span) => span.kind === 'function'));

  let state = 0x0530_5eed;
  const nextRandom = (): number => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let step = 1; step <= 15; step += 1) {
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
    const result = incremental.submit(request(step, text, { languageId: 'typescript', delta: changed.delta }));
    assert.equal(result.accepted, true, `T053-RANDOM-EDIT-${step} request accepted`);
    while (tasks.length > 0) { const task = tasks.shift(); task?.(); }
    const actual = incremental.latest();
    const expected = await tsHighlightOnce(step, text);
    assert.ok(actual);
    assert.equal(actual.documentVersion, expected.documentVersion);
    assert.equal(actual.status, expected.status, `T053-RANDOM-EDIT-${step} status`);
    drainAllWindows(tasks, actual, text.length);
    assert.deepEqual(actual.spans, expected.spans, `T053-RANDOM-EDIT-${step} incremental spans equal full parse`);
  }
  const diagnostics = incremental.diagnostics();
  assert.ok(diagnostics.completed >= 16);
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

/** Requests with no languageId (or an unrecognized one) never touch Tree-sitter. */
async function grammarMissingFallback(): Promise<void> {
  const noLanguage = await highlightOnce(request(1, 'const value = 1;'));
  assert.equal(noLanguage.status, 'plain-text');
  assert.equal(noLanguage.fallback, 'grammar-missing', 'T053-GRAMMAR-MISSING-01 missing languageId falls back to plain text');
  assert.deepEqual(noLanguage.spans, []);

  const unknownLanguage = await highlightOnce(request(2, 'const value = 1;', { languageId: 'cobol' }), { grammars: grammarProvider });
  assert.equal(unknownLanguage.fallback, 'grammar-missing', 'T053-GRAMMAR-MISSING-02 unresolvable languageId falls back to plain text');

  const missing = await loadTreeSitterGrammar('/xi/grammar/does-not-exist.wasm');
  assert.equal(missing.ok, false, 'T053-GRAMMAR-MISSING-03 missing grammar is reported');
  if (!missing.ok) assert.equal(missing.error.kind, 'grammar-missing');
  assert.equal(TREE_SITTER_RUNTIME_VERSION, '0.25.10');
}

async function boundedFailureCases(): Promise<void> {
  const giant = await highlightOnce(request(1, 'const value = 1;\n' + 'x'.repeat(100), { languageId: 'typescript' }), { grammars: grammarProvider, runtime: runtimeOptions, maxLineUnits: 32 });
  assert.equal(giant.status, 'plain-text');
  assert.equal(giant.fallback, 'giant-line', 'T053-GIANT-LINE-01 giant line falls back to plain text');

  const large = await highlightOnce(request(2, 'x'.repeat(200), { languageId: 'typescript' }), { grammars: grammarProvider, runtime: runtimeOptions, maxDocumentUnits: 64 });
  assert.equal(large.status, 'large-file');
  assert.equal(large.fallback, 'large-file', 'T053-LARGE-FILE-01 large file disables expensive highlighting');

  const start = performance.now();
  const service = new IncrementalSyntaxHighlighter({ maxPendingRequests: 2, grammars: grammarProvider, runtime: runtimeOptions });
  const accepted = service.submit(request(3, 'const typing = 3;', { languageId: 'typescript' }));
  const elapsed = performance.now() - start;
  assert.equal(accepted.accepted, true);
  assert.ok(elapsed < 20, `T053-TYPING-01 submit remained asynchronous (${elapsed.toFixed(2)}ms)`);
  assert.equal(service.latest(), undefined);
  await service.flush();
  assert.equal(service.latest()?.status, 'highlighted');
  service.dispose();
}

/**
 * A ~300k-unit TS document must complete via several bounded parse slices, matching an
 * unsliced parse -- and, now that the highlight-query pass is lazy per-window rather than an
 * eager chunked pass, publishing a result must never itself run any capture pass: only the
 * parse is sliced. A single spansInRange call for a small visible range must be fast.
 */
async function slicingBoundProducesSameResult(): Promise<void> {
  const big = `${'const value = 1;\nfunction f(x) { return x + 1; }\n'.repeat(7_000)}const tail = true;\n`;
  assert.ok(big.length > 300_000, 'T053-SLICE-00 fixture is large enough to force slicing');
  const sliceDurations: number[] = [];
  const sliceTasks: Array<() => void> = [];
  const windowTickDurations: number[] = [];
  let snapshotSliceCalls = 0;
  const service = new IncrementalSyntaxHighlighter({
    grammars: grammarProvider,
    runtime: runtimeOptions,
    sliceBudgetMilliseconds: 1.5,
    // Manually drained (not real timers) so later sections in this test can deterministically
    // step through background capture-window ticks one at a time. Nothing has called
    // spansInRange yet at this point, so every task drained here is a parse tick.
    schedule: (task) => sliceTasks.push(() => {
      const started = performance.now();
      task();
      sliceDurations.push(performance.now() - started);
    }),
    onCaptureWindowMeasured: (elapsed) => { windowTickDurations.push(elapsed); },
    onSnapshotSliceCall: () => { snapshotSliceCalls += 1; },
  });
  service.submit(request(1, big, { languageId: 'typescript' }));
  for (let attempt = 0; attempt < 50 && service.latest() === undefined; attempt += 1) {
    while (sliceTasks.length > 0) { const task = sliceTasks.shift(); task?.(); }
    if (service.latest() === undefined) await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  }
  const sliced = service.latest();
  assert.ok(sliced);
  assert.equal(sliced.status, 'highlighted');
  assert.ok(service.diagnostics().resumableSlices >= 1, 'T053-SLICE-01 the large parse yielded at least once');
  // web-tree-sitter's progressCallback is only checked at limited internal points, so a
  // single *cold, non-incremental* first parse can have one coarse-grained outlier slice.
  // The steady-state median stays tightly bounded; every tick here is a parse tick, since
  // publishing a result no longer runs any capture pass.
  const sorted = [...sliceDurations].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  assert.ok(median < 4, `T053-SLICE-02 the median parse slice stays bounded (median ${median.toFixed(2)}ms of ${sliceDurations.length} ticks)`);
  console.log('T053 parse slice durations (ms), max', Math.max(...sliceDurations).toFixed(2), 'median', median.toFixed(2), 'count', sliceDurations.length);

  // (a) spansInRange never blocks: a cold call over an uncached range returns in well under
  // 0.5ms (it only enqueues background work), and the identical call after draining that
  // background work returns the real, non-empty spans.
  snapshotSliceCalls = 0; // isolate the count to window-computation, excluding the parse phase above
  const coldStarted = performance.now();
  const coldSpans = sliced.spansInRange(50_000, 52_000);
  const coldElapsed = performance.now() - coldStarted;
  assert.ok(coldElapsed < 0.5, `T053-SLICE-05a a cold spansInRange call never blocks (was ${coldElapsed.toFixed(3)}ms)`);
  console.log('T053 cold spansInRange(50000,52000) elapsed ms:', coldElapsed.toFixed(3), 'spans (pre-drain):', coldSpans.length);
  while (sliceTasks.length > 0) { const task = sliceTasks.shift(); task?.(); }
  const drainedSpans = sliced.spansInRange(50_000, 52_000);
  assert.ok(drainedSpans.length > 0, 'T053-SLICE-05b spansInRange over the same range returns real spans once drained');

  // The chunk-cache fix: computing one window's captures (hundreds of predicate-bearing
  // captures) must issue only a handful of DocumentSnapshot#slice calls (one per newly-touched
  // 4,096-unit-aligned chunk), not one per capture -- predicate text retrieval during
  // query.captures() replays the same ParseCallback the tree was parsed with, once per
  // captured node, and an uncached callback previously re-sliced the snapshot every time.
  assert.ok(drainedSpans.length > 20, 'T053-SLICE-05e the drained window has many captures (a meaningful sample for the slice-count check)');
  assert.ok(snapshotSliceCalls <= 12, `T053-SLICE-05f computing one window issues only a handful of snapshot.slice calls, not one per capture (was ${snapshotSliceCalls} for ${drainedSpans.length}+ spans)`);
  console.log('T053 snapshot.slice calls for the drained window:', snapshotSliceCalls, 'spans:', drainedSpans.length);

  // (b) each background window tick (CAPTURE_WINDOW_UNITS=256, padded 64 each side) stays
  // bounded on this densely-tokenized 300k+-unit fixture. Printed, not just asserted.
  assert.ok(windowTickDurations.length > 0, 'T053-SLICE-05c background window ticks ran');
  const worstWindowTick = Math.max(...windowTickDurations);
  const windowMedianSorted = [...windowTickDurations].sort((left, right) => left - right);
  const windowMedian = windowMedianSorted[Math.floor(windowMedianSorted.length / 2)] ?? 0;
  assert.ok(worstWindowTick < 4, `T053-SLICE-05d no background capture-window tick exceeds ~4ms (worst ${worstWindowTick.toFixed(3)}ms, median ${windowMedian.toFixed(3)}ms of ${windowTickDurations.length} ticks)`);
  console.log('T053 background window tick ms: worst', worstWindowTick.toFixed(3), 'median', windowMedian.toFixed(3), 'count', windowTickDurations.length);


  // (d) Full-document spansInRange (after draining) crosses many windows; the merged result
  // must be strictly sorted and non-overlapping -- no span duplicated/re-emitted at a seam.
  drainAllWindows(sliceTasks, sliced, big.length);
  const full = sliced.spans;
  assert.ok(full.length > 100, 'T053-SLICE-06 the full document has many classified spans');
  for (let index = 1; index < full.length; index += 1) {
    const previous = full[index - 1] as { readonly end: number };
    const current = full[index] as { readonly start: number };
    assert.ok(current.start >= previous.end, `T053-SLICE-07 span ${index} does not overlap or duplicate the previous span (window-boundary dedup)`);
  }
  service.dispose();

  const unsliced = await highlightOnce(request(1, big, { languageId: 'typescript' }), { grammars: grammarProvider, runtime: runtimeOptions, sliceBudgetMilliseconds: 1_000 });
  assert.deepEqual(full, unsliced.spans, 'T053-SLICE-03 sliced parse (fully drained) spans equal an unsliced, fully-drained parse');

  // (c) A result superseded by a newer parse for the same document must free its tree copy,
  // drop its queue and compute nothing further -- draining scheduled tasks after supersession
  // must not grow its cache or fire its background work.
  const supersedeTasks: Array<() => void> = [];
  const supersedeMeasurements: number[] = [];
  const supersedeService = new IncrementalSyntaxHighlighter({
    grammars: grammarProvider,
    runtime: runtimeOptions,
    schedule: (task) => { supersedeTasks.push(task); },
    onCaptureWindowMeasured: (elapsed) => { supersedeMeasurements.push(elapsed); },
  });
  supersedeService.submit(request(1, big, { languageId: 'typescript' }));
  for (let attempt = 0; attempt < 50 && supersedeService.latest() === undefined; attempt += 1) {
    while (supersedeTasks.length > 0) { const task = supersedeTasks.shift(); task?.(); }
    if (supersedeService.latest() === undefined) await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  }
  const firstResult = supersedeService.latest();
  assert.ok(firstResult);
  firstResult.spansInRange(0, 500); // enqueue, but deliberately do not drain before superseding
  const queuedTaskCountBeforeSupersede = supersedeTasks.length;
  assert.ok(queuedTaskCountBeforeSupersede > 0, 'T053-SLICE-08 the first result queued background work before being superseded');
  const edited2 = `${big}\n// x`;
  supersedeService.submit(request(2, edited2, { languageId: 'typescript', delta: { start: big.length, oldEnd: big.length, newEnd: edited2.length } }));
  while (supersedeTasks.length > 0) { const task = supersedeTasks.shift(); task?.(); }
  assert.notEqual(supersedeService.latest(), firstResult, 'T053-SLICE-09 a newer result replaces the superseded one');
  const measurementsAfterFirstDrain = supersedeMeasurements.length;
  assert.doesNotThrow(() => firstResult.spansInRange(0, 500), 'T053-SLICE-10 a superseded result does not throw');
  assert.deepEqual(firstResult.spansInRange(0, 500), [], 'T053-SLICE-11 a superseded result returns empty spans, never re-enqueuing');
  assert.equal(supersedeTasks.length, 0, 'T053-SLICE-12 a superseded result never schedules new background work');
  assert.equal(supersedeMeasurements.length, measurementsAfterFirstDrain, 'T053-SLICE-13 a superseded result computes nothing further');
  supersedeService.dispose();

  // The product-relevant case: submit-to-publish for a warm single-character edit on the same
  // 300k+-unit document is bounded only by parse slices -- publishing never runs a capture
  // pass, and the paint path never blocks on spansInRange either.
  const warmService = new IncrementalSyntaxHighlighter({ grammars: grammarProvider, runtime: runtimeOptions });
  warmService.submit(request(1, big, { languageId: 'typescript' }));
  await warmService.flush();
  const edited = `${big}\n// x`;
  const editStarted = performance.now();
  let publishedAt = 0;
  const subscription = warmService.onResult(() => { publishedAt = performance.now(); });
  warmService.submit(request(2, edited, { languageId: 'typescript', delta: { start: big.length, oldEnd: big.length, newEnd: edited.length } }));
  await warmService.flush();
  subscription.dispose();
  const editToPublishMs = publishedAt - editStarted;
  assert.equal(warmService.latest()?.status, 'highlighted');
  assert.ok(editToPublishMs < 30, `T053-SLICE-04 a warm single-character incremental edit publishes without any capture pass (${editToPublishMs.toFixed(2)}ms)`);
  console.log('T053 warm incremental edit submit->publish ms:', editToPublishMs.toFixed(2));
  warmService.dispose();
}

/** `#lua-match?` predicates translate to `#match?`; FOO is classified @constant, foo stays @variable. */
async function luaMatchTranslation(): Promise<void> {
  assert.equal(preprocessHighlightsQuerySource('((identifier) @type\n  (#lua-match? @type "^[A-Z]"))'), '((identifier) @type\n  (#match? @type "^[A-Z]"))');
  const untranslatable = preprocessHighlightsQuerySource('((identifier) @x (#lua-match? @x "%bxy"))');
  assert.equal(untranslatable, '((identifier) @x (#eq? @x "\0-xi-untranslatable-lua-pattern"))', 'T053-LUA-01 an untranslatable Lua class is neutered to a never-matching predicate in place');

  const result = await tsHighlightOnce(1, 'const FOO = 1; const foo = 2;');
  const constantSpan = result.spans.find((span) => span.kind === 'constant');
  const variableSpan = result.spans.find((span) => span.kind === 'variable');
  assert.ok(constantSpan, 'T053-LUA-02 FOO is classified as a constant');
  assert.ok(variableSpan, 'T053-LUA-03 foo is classified as a variable');
}

/** node.startIndex/endIndex and the resolved span offsets are UTF-16 code units, not bytes. */
async function utf16UnitsAreVerified(): Promise<void> {
  const text = 'const emoji = "\u{1F600}"; const after = 1;';
  const result = await tsHighlightOnce(1, text);
  const afterKeyword = result.spans.find((span) => text.slice(span.start, span.end) === 'const' && span.start > 10);
  assert.ok(afterKeyword, 'T053-UTF16-01 a span after the astral character is found');
  // `text` is a JS (UTF-16) string; if spans were byte offsets this slice would not equal "const".
  assert.equal(text.slice((afterKeyword as { start: number }).start, (afterKeyword as { end: number }).end), 'const');
  assert.equal(text.length, [...text].length + 1, 'T053-UTF16-02 the fixture contains exactly one surrogate pair');
}

async function treeCleanupOnCloseAndDispose(): Promise<void> {
  const tracker = new SyntaxDocumentTracker({ grammars: grammarProvider, runtime: runtimeOptions });
  const id = 'T053-tracker-document' as DocumentId;
  tracker.openDocument({ documentId: id, languageId: 'typescript', snapshot: snapshotFor('const value = 1;', id) });
  await new Promise<void>((resolve) => {
    const subscription = tracker.onResult(() => { subscription.dispose(); resolve(); });
  });
  assert.ok(tracker.readSyntax(id) !== undefined, 'T053-CLEANUP-01 a read is published after the first parse');
  assert.ok((tracker.readSyntax(id) as { spansInRange(a: number, b: number): unknown }).spansInRange(0, 5) !== undefined);
  tracker.closeDocument(id);
  assert.equal(tracker.readSyntax(id), undefined, 'T053-CLEANUP-02 closing a document drops its read');
  // Re-opening after close must not throw (no stale/freed Tree is reused).
  tracker.openDocument({ documentId: id, languageId: 'typescript', snapshot: snapshotFor('const again = 2;', id) });
  await new Promise<void>((resolve) => {
    const subscription = tracker.onResult(() => { subscription.dispose(); resolve(); });
  });
  assert.ok(tracker.readSyntax(id) !== undefined);
  tracker.dispose();
  assert.equal(tracker.readSyntax(id), undefined, 'T053-CLEANUP-03 dispose drops every retained read');
}

async function rainbowBracketsUseContainingDepth(): Promise<void> {
  const text = 'function f(a) { return [a, {x: (a)}]; }';
  const tasks: Array<() => void> = [];
  const service = new IncrementalSyntaxHighlighter({ grammars: grammarProvider, runtime: runtimeOptions, rainbowBrackets: true, schedule: task => tasks.push(task) });
  service.submit(request(1, text, { languageId: 'typescript' }));
  for (let attempt = 0; attempt < 100 && service.latest() === undefined; attempt += 1) {
    while (tasks.length > 0) tasks.shift()?.();
    if (service.latest() === undefined) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  const result = service.latest();
  assert.ok(result, 'T053-RAINBOW-01 syntax result is published');
  drainAllWindows(tasks, result, text.length);
  const at = (token: string, from = 0): number => text.indexOf(token, from);
  const expected = [
    [at('(', 0), 'rainbow.0'],
    [at('{', at('(', 0)), 'rainbow.0'],
    [at('[', at('{', at('(', 0))), 'rainbow.1'],
    [at('{', at('[', at('{', at('(', 0)))), 'rainbow.2'],
    [at('(', at('{', at('[', at('{', at('(', 0))))), 'rainbow.3'],
  ] as const;
  for (const [offset, scope] of expected) {
    const bracketSpan: SyntaxHighlightResult['spans'][number] | undefined = result.spans.find((candidate: SyntaxHighlightResult['spans'][number]) => candidate.start === offset && candidate.end === offset + 1);
    assert.equal(bracketSpan?.scope, scope, `T053-RAINBOW-02 bracket at ${offset} uses ${scope}`);
  }
  service.dispose();
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
await grammarMissingFallback();
await boundedFailureCases();
await slicingBoundProducesSameResult();
await luaMatchTranslation();
await utf16UnitsAreVerified();
await treeCleanupOnCloseAndDispose();
await rainbowBracketsUseContainingDepth();
clippedRowsAreBounded();
