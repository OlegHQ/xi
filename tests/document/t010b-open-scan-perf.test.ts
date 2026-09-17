import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type Utf16Offset } from '../../packages/primitives/src/index';
import { openTextDocument, type TextFileDocument } from '../../packages/document/src/index';

// Regression + benchmark coverage for the openTextDocument scan collapse (AGENTS.md
// performance ticket: eliminate redundant O(n) passes over decoded text -- decode,
// NUL check, CR check, LF count and UTF-16 well-formedness used to run as up to seven
// separate full scans for a plain-LF file; see packages/document/src/text-fidelity.ts).

const idResult = asIdentifier<DocumentId>('T010b-open-scan-perf', 'documentId');
const documentId: DocumentId = idResult.ok
  ? idResult.value
  : (() => { throw new Error(idResult.error.message); })();

function offset(value: number): Utf16Offset { return value as Utf16Offset; }

function readAll(document: TextFileDocument): string {
  const snapshot = document.snapshot();
  const result = snapshot.slice(offset(0), offset(snapshot.lengthUtf16));
  if (!result.ok) throw new Error(`read-failed:${result.error.kind}`);
  return result.value;
}

/**
 * Reproduces the pre-fix scan shape (separate includes/includes/charCodeAt-loop/
 * includes/charCodeAt-loop passes) so the benchmark below reports a genuine
 * before/after without needing a second checked-out copy of the module.
 */
function naiveSevenPassScan(decoded: string): { hasNul: boolean; hasCr: boolean; lineFeedCount: number; wellFormed: boolean } {
  const hasNul = decoded.includes('\0');
  const hasCr1 = decoded.includes('\r');
  let lineFeedCount = 0;
  for (let index = 0; index < decoded.length; index += 1) if (decoded.charCodeAt(index) === 10) lineFeedCount += 1;
  const hasCr2 = decoded.includes('\r');
  let wellFormed = true;
  for (let index = 0; index < decoded.length; index += 1) {
    const unit = decoded.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = decoded.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      else wellFormed = false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) wellFormed = false;
  }
  return { hasNul, hasCr: hasCr1 && hasCr2, lineFeedCount, wellFormed };
}

function generateNormalLineText(byteLength: number): string {
  const line = 'const value = computeSomething(alpha, beta, gamma); // ordinary ASCII source line\n';
  let text = '';
  while (text.length < byteLength) text += line;
  return text.slice(0, byteLength);
}

function checkTrickyFixturesOpenCorrectly(): void {
  const cases: { readonly name: string; readonly bytes: Uint8Array; readonly assertResult: (opened: ReturnType<typeof openTextDocument>) => void }[] = [
    {
      name: 'CRLF',
      bytes: new TextEncoder().encode('a\r\nb\r\n'),
      assertResult: (opened) => {
        assert.equal(opened.kind, 'editable');
        if (opened.kind !== 'editable') return;
        assert.equal(readAll(opened.document), 'a\nb\n');
        assert.deepEqual(opened.document.snapshot().lineEndings, ['crlf', 'crlf']);
      },
    },
    {
      name: 'lone CR (legacy default treats bare CR as a line ending)',
      bytes: new TextEncoder().encode('a\rb'),
      assertResult: (opened) => {
        assert.equal(opened.kind, 'editable');
        if (opened.kind !== 'editable') return;
        assert.equal(readAll(opened.document), 'a\nb');
        assert.deepEqual(opened.document.snapshot().lineEndings, ['cr']);
      },
    },
    {
      name: 'NUL byte',
      bytes: new Uint8Array([0x61, 0, 0x62]),
      assertResult: (opened) => {
        assert.equal(opened.kind, 'read-only');
        if (opened.kind === 'read-only') assert.equal(opened.document.reason, 'binary-content');
      },
    },
    {
      name: 'UTF-8 BOM',
      bytes: new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0a]),
      assertResult: (opened) => {
        assert.equal(opened.kind, 'editable');
        if (opened.kind !== 'editable') return;
        assert.equal(opened.document.snapshot().hasUtf8Bom, true);
        assert.equal(readAll(opened.document), 'a\n');
      },
    },
    {
      name: 'unpaired surrogate (invalid UTF-8)',
      bytes: new Uint8Array([0x61, 0xed, 0xa0, 0x80, 0x62]),
      assertResult: (opened) => {
        assert.equal(opened.kind, 'read-only');
        if (opened.kind === 'read-only') assert.equal(opened.document.reason, 'invalid-utf8');
      },
    },
    {
      name: 'empty',
      bytes: new Uint8Array(),
      assertResult: (opened) => {
        assert.equal(opened.kind, 'editable');
        if (opened.kind !== 'editable') return;
        assert.equal(opened.document.snapshot().lengthUtf16, 0);
        assert.deepEqual(opened.document.snapshot().lineEndings, []);
      },
    },
    {
      name: 'single newline',
      bytes: new TextEncoder().encode('\n'),
      assertResult: (opened) => {
        assert.equal(opened.kind, 'editable');
        if (opened.kind !== 'editable') return;
        assert.equal(opened.document.snapshot().lengthUtf16, 1);
        assert.deepEqual(opened.document.snapshot().lineEndings, ['lf']);
      },
    },
  ];
  for (const testCase of cases) {
    const opened = openTextDocument(documentId, testCase.bytes);
    testCase.assertResult(opened);
  }
  console.log(`T010b-TRICKY-FIXTURES-01 passed: ${cases.length} tricky fixtures (${cases.map((c) => c.name).join(', ')}) open with unchanged results.`);
}

function checkOpenPerformance(byteLength: number, budgetMs: number, label: string): void {
  const text = generateNormalLineText(byteLength);
  const bytes = new TextEncoder().encode(text);
  // Warm up (JIT, allocator) before timing, matching how the editor's process stays warm.
  for (let warm = 0; warm < 2; warm += 1) openTextDocument(documentId, bytes);

  const openStart = performance.now();
  const opened = openTextDocument(documentId, bytes);
  const openMs = performance.now() - openStart;
  assert.equal(opened.kind, 'editable');
  if (opened.kind === 'editable') assert.equal(opened.document.snapshot().lengthUtf16, text.length);

  // "Before": the pre-fix multi-pass scan shape, run over the same decoded text, as a
  // same-process baseline for the eliminated redundant scanning work (not the whole
  // open path, which also includes decode + chunk build, unchanged by this fix).
  const decoded = text;
  const naiveStart = performance.now();
  const naive = naiveSevenPassScan(decoded);
  const naiveMs = performance.now() - naiveStart;
  assert.equal(naive.hasNul, false);
  assert.equal(naive.hasCr, false);
  assert.equal(naive.wellFormed, true);

  console.log(`T010b-OPEN-PERF-01 (${label}, ${byteLength} bytes): openTextDocument=${openMs.toFixed(3)}ms (budget ${budgetMs}ms), naive-scan-baseline=${naiveMs.toFixed(3)}ms`);
  assert.ok(openMs <= budgetMs, `T010b-OPEN-PERF-01 ${label} exceeded budget: ${openMs}ms > ${budgetMs}ms`);
}

checkTrickyFixturesOpenCorrectly();
checkOpenPerformance(1 * 1024 * 1024, 100, '1 MiB');
checkOpenPerformance(10 * 1024 * 1024, 250, '10 MiB');
