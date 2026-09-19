#!/usr/bin/env bun
// Every language apps/xi/src/syntax-assets.ts bundles a grammar for must actually parse and
// classify with the pinned web-tree-sitter runtime: the wasm has to load (ABI compatible),
// its highlights.scm has to compile as a Query, and its capture names have to survive
// `captureNameToKind` as real token kinds. Real on-disk grammars, no fakes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  IncrementalSyntaxHighlighter,
  type SyntaxGrammarProvider,
  type SyntaxTokenKind,
} from '../../packages/services/syntax/index';
import { openTextDocument } from '../../packages/document/src/index';
import type { DocumentId, DocumentVersion, RequestId } from '../../packages/primitives/src/index';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUNTIME_WASM_PATH = `${REPO_ROOT}node_modules/web-tree-sitter/tree-sitter.wasm`;

// Mirrors GRAMMAR_ASSET_LOADERS in apps/xi/src/syntax-assets.ts.
const GRAMMARS: Readonly<Record<string, readonly [string, string]>> = {
  typescript: ['node_modules/@opentui/core/assets/typescript/tree-sitter-typescript.wasm', 'node_modules/@opentui/core/assets/typescript/highlights.scm'],
  javascript: ['node_modules/@opentui/core/assets/javascript/tree-sitter-javascript.wasm', 'node_modules/@opentui/core/assets/javascript/highlights.scm'],
  python: ['node_modules/tree-sitter-python/tree-sitter-python.wasm', 'node_modules/tree-sitter-python/queries/highlights.scm'],
  json: ['node_modules/tree-sitter-json/tree-sitter-json.wasm', 'node_modules/tree-sitter-json/queries/highlights.scm'],
  toml: ['node_modules/@tree-sitter-grammars/tree-sitter-toml/tree-sitter-toml.wasm', 'node_modules/@tree-sitter-grammars/tree-sitter-toml/queries/highlights.scm'],
  markdown: ['node_modules/@opentui/core/assets/markdown/tree-sitter-markdown.wasm', 'node_modules/@opentui/core/assets/markdown/highlights.scm'],
};

// Mirrors the per-language query overrides in apps/xi/src/syntax-assets.ts.
const EXTRA_HIGHLIGHTS: Readonly<Record<string, string>> = { json: '\n(pair key: (_) @string.special.key)\n' };

const grammarProvider: SyntaxGrammarProvider = {
  async resolve(languageId) {
    const entry = GRAMMARS[languageId];
    if (entry === undefined) return { ok: false, error: { kind: 'grammar-missing', message: `no bundled grammar for ${languageId}` } };
    const [wasm, highlights] = await Promise.all([readFile(`${REPO_ROOT}${entry[0]}`), readFile(`${REPO_ROOT}${entry[1]}`, 'utf-8')]);
    return { ok: true, value: { wasm, highlights: `${highlights}${EXTRA_HIGHLIGHTS[languageId] ?? ''}` } };
  },
};
async function runtimeOptions(): Promise<{ readonly wasmBinary: Uint8Array }> { return { wasmBinary: await readFile(RUNTIME_WASM_PATH) }; }

const SAMPLES: readonly (readonly [string, string, readonly SyntaxTokenKind[]])[] = [
  ['typescript', 'const value: number = 1; // note\n', ['keyword', 'number', 'comment']],
  ['javascript', 'const value = "text"; // note\n', ['keyword', 'string', 'comment']],
  ['python', '# note\ndef greet(name):\n    return f"hi {name}"\n', ['comment', 'keyword', 'function', 'string']],
  ['json', '{"key": "value", "count": 12, "flag": true}\n', ['property', 'string', 'number', 'constant']],
  ['toml', '# note\n[table]\nkey = "value"\ncount = 12\n', ['comment', 'property', 'string', 'number']],
  ['markdown', '# Heading\n\n- item\n\n```ts\nconst x = 1;\n```\n', ['keyword', 'punctuation', 'string']],
];

async function main(): Promise<void> {
  for (const [languageId, text, expectedKinds] of SAMPLES) {
    const documentId = `bundled-${languageId}` as DocumentId;
    const opened = openTextDocument(documentId, new TextEncoder().encode(text));
    assert.equal(opened.kind, 'editable', `BUNDLED-OPEN-${languageId} fixture opens`);
    if (opened.kind !== 'editable') continue;
    const tasks: Array<() => void> = [];
    const service = new IncrementalSyntaxHighlighter({ grammars: grammarProvider, runtime: runtimeOptions, schedule: (task) => { tasks.push(task); } });
    service.submit({
      documentId,
      documentVersion: 1 as DocumentVersion,
      requestId: `bundled-${languageId}-1` as RequestId,
      generation: 1,
      snapshot: opened.document.snapshot(),
      languageId,
    });
    // Grammar loading is real async file I/O ahead of the first (scheduled) parse tick.
    for (let attempt = 0; attempt < 200 && service.latest() === undefined; attempt += 1) {
      while (tasks.length > 0) { const task = tasks.shift(); task?.(); }
      if (service.latest() === undefined) await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    }
    const latest = service.latest();
    assert.equal(latest?.status, 'highlighted', `BUNDLED-PARSE-${languageId} grammar loads and highlights (status=${String(latest?.status)})`);
    // Highlight windows are computed lazily in the background; drain them (as tests/syntax/t053-syntax.test.ts does).
    for (let round = 0; round < 50 && latest !== undefined; round += 1) {
      latest.spansInRange(0, text.length);
      if (tasks.length === 0) break;
      while (tasks.length > 0) { const task = tasks.shift(); task?.(); }
    }
    const kinds = new Set((latest?.spans ?? []).map((span) => span.kind));
    for (const kind of expectedKinds) {
      assert.ok(kinds.has(kind), `BUNDLED-KIND-${languageId}-${kind} expected a ${kind} span, got [${[...kinds].join(', ')}]`);
    }
    console.log(`bundled grammar ${languageId}: ${latest?.spans.length ?? 0} spans, kinds=[${[...kinds].sort().join(', ')}]`);
    service.dispose();
  }
  console.log('tests/syntax/bundled-languages.test.ts: ok');
}

await main();
