/// <reference types="bun" />
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { directiveFailures } from '../../tools/lint/check';

function lint(source: string, kind = 'H0'): string {
  const dir = mkdtempSync(join(tmpdir(), 'xi-perf-lint-'));
  try {
    const config = join(dir, 'config.json');
    const file = join(dir, 'fixture.ts');
    writeFileSync(config, JSON.stringify({ categories: { correctness: 'off' }, jsPlugins: [{ name: 'xi', specifier: resolve('tools/lint/xi-performance.mjs') }], rules: { 'xi/performance': ['error', { class: kind }] } }));
    writeFileSync(file, source);
    const result = spawnSync(resolve('node_modules/.bin/oxlint'), ['--threads', '1', '--config', config, file], { encoding: 'utf8' });
    if (result.error) throw result.error;
    const output = result.stdout + result.stderr;
    expect(output).not.toContain('Failed to');
    expect(result.status).not.toBeNull();
    return result.status === 0 ? '' : output;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('H0 rejects temporary objects, arrays, closures, templates and allocating methods', () => {
  for (const expression of ['({ x: i })', '[i]', 'new Map()', '() => i', '`cell-${i}`', "text['split']('')", '/x/g']) {
    expect(lint(`function kernel(text: string) { for (let i = 0; i < 4; i++) { consume(${expression}); } }`)).toContain('[allocation]');
  }
});

test('H0 permits scalar loops and scratch initialization; H1 permits immutable results', () => {
  expect(lint('function f() { const scratch = new Uint32Array(4); for (let i = 0; i < 4; i++) scratch[i] = i; return scratch[0]; }')).toBe('');
  expect(lint('function f() { for (let i = 0; i < 4; i++) consume({ i }); return { ok: true }; }', 'H1')).toBe('');
});

test('H1 catches string rebuilding, including computed materialization; numeric counters remain valid', () => {
  expect(lint("function f() { let text = ''; for (let i = 0; i < 4; i++) text += input[i]; }", 'H1')).toContain('[strings]');
  expect(lint("function f() { let text: string; for (let i = 0; i < 4; i++) text = `${text}${i}`; }", 'H1')).toContain('[strings]');
  expect(lint("function f() { let n = 0; for (let i = 0; i < 4; i++) n += i; }", 'H1')).toBe('');
  expect(lint("function f() { return doc['getText'](); }", 'H1')).toContain('[materialize]');
});

test('T120 catches inferred string accumulators and joins of growing local arrays', () => {
  for (const kind of ['H0', 'H1'] as const) {
    expect(lint("function f() { let text = String(); for (let i = 0; i < 4; i++) text = text + input[i]; }", kind)).toContain('[strings]');
    expect(lint("function f(seed: string) { let text = seed.slice(0); for (let i = 0; i < 4; i++) text += input[i]; }", kind)).toContain('[strings]');
    expect(lint("function f() { const parts = []; for (let i = 0; i < 4; i++) { parts.push(input[i]); consume(parts.join('')); } }", kind)).toMatch(/\[(?:strings|allocation)\]/);
  }
  expect(lint("function f() { const parts = []; for (let i = 0; i < 4; i++) parts.push(input[i]); return parts.join(''); }", 'H1')).toBe('');
  expect(lint("function f() { const parts = []; const other = []; for (let i = 0; i < 4; i++) { parts.push(i); consume(other.join('')); } }", 'H1')).toBe('');
  expect(lint("function f() { for (let i = 0; i < 4; i++) { const row = []; row.push(input[i]); consume(row.join('')); } }", 'H1')).toBe('');
  expect(lint("function f() { let value = 0; { let value = 1; for (let i = 0; i < 4; i++) value += i; } }", 'H1')).toBe('');
});

test('hot sync IO and background microtask scheduling fail; cold idiomatic code passes', () => {
  expect(lint("function f() { fs.readFileSync('file'); }", 'H1')).toContain('[sync]');
  expect(lint('async function f() { await work(); }')).toContain('[sync]');
  expect(lint('function f() { queueMicrotask(parse); }', 'B')).toContain('[microtask]');
  expect(lint("function f() { let s = ''; for (let i = 0; i < 4; i++) s += i; return s.toString(); }", 'C')).toBe('');
});

test('operation annotation overrides cold defaults and nested helpers inherit', () => {
  const source = `function f() {
// @xi-perf H0 DOC-COORDINATES -- Scalar traversal in the document coordinate kernel.
function helper() { for (let i = 0; i < 4; i++) consume({ i }); }
}`;
  expect(lint(source, 'C')).toContain('[allocation]');
  expect(lint(source.replace('DOC-COORDINATES', 'UNKNOWN'), 'C')).toContain('concrete reason');
  expect(lint('// @xi-perf H0 DOC-COORDINATES -- A misplaced annotation must never be ignored.\nfunction f() {}', 'C')).toContain('first comment');
});

test('only a justified, budget-linked, next-line exception passes', () => {
  const source = `function f() { for (let i = 0; i < 4; i++) {
// @xi-perf-allow allocation DOC-COORDINATES -- Four immutable boundary results escape to the caller.
consume({ i });
} }`;
  expect(lint(source)).toBe('');
  expect(lint(source.replace(' -- Four immutable boundary results escape to the caller.', ''))).toContain('Exception requires');
  expect(lint(source.replace('DOC-COORDINATES', 'UNKNOWN'))).toContain('Exception requires');
  expect(lint(source.replace('allocation DOC-', 'madeup DOC-'))).toContain('Exception requires');
  expect(lint(source.replace('consume({ i });', 'consume(i);'))).toContain('Unused performance exception');
  expect(lint(source.replace('consume({ i });', '\nconsume({ i });'))).toContain('[allocation]');
  expect(lint(source.replace('consume({ i });', "consume({ i });\nconsume([i]);"))).toContain('[allocation]');
});

test('native suppressions cannot suppress their own audit; strings are not directives', () => {
  for (const directive of ['// oxlint-disable', '/* oxlint-disable xi/performance */', '// eslint-disable-next-line xi/performance -- because']) {
    expect(directiveFailures(`${directive}\nfunction f() {}`, 'fixture.ts')).toHaveLength(1);
  }
  expect(directiveFailures('const example = "// oxlint-disable"; const template = `/* eslint-disable */`;', 'fixture.ts')).toHaveLength(0);
  expect(directiveFailures('function broken( {', 'fixture.ts').length).toBeGreaterThan(0);
});

test('I2: Intl.Segmenter and granularity constructors must be module-level, not per call', () => {
  expect(lint('function f(text: string) { return new Intl.Segmenter("en", { granularity: "word" }).segment(text); }', 'C')).toContain('[segmenter]');
  expect(lint('const f = (text: string) => new Intl.Segmenter("en", { granularity: "word" }).segment(text);', 'C')).toContain('[segmenter]');
  expect(lint('class C { m(text: string) { return new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text); } }', 'C')).toContain('[segmenter]');
  expect(lint('function f() { return new Thing({ granularity: "word" }); }', 'C')).toContain('[segmenter]');
  expect(lint('const segmenter = new Intl.Segmenter("en", { granularity: "word" });\nfunction f(text: string) { return segmenter.segment(text); }', 'C')).toBe('');
  expect(lint('function f() { return new Intl.Segmenter("en"); }', 'C')).toContain('[segmenter]');
  expect(lint('function f() { return new Map(); }', 'C')).toBe('');
});

test('H0 implicit collection loops are covered', () => {
  expect(lint('function f(xs) { return xs.map(x => x + 1); }')).toContain('[allocation]');
  expect(lint('function f(xs) { xs.forEach(x => consume({ x })); }')).toContain('[allocation]');
});

test('real repository overrides and suppression preflight run through check:lint', () => {
  for (const [owner, source, failure] of [
    ['vim', "function f() { let s = ''; while (more()) s += part(); }", '[strings]'],
    ['layout', "function f() { doc.getLine(1); }", '[materialize]'],
    ['services', 'function f() { queueMicrotask(parse); }', '[microtask]'],
    ['ui', "function f() { let s = ''; while (more()) s += part(); }", ''],
    ['vim', '// oxlint-disable xi/performance\nfunction f() {}', 'Native lint suppression'],
  ] as const) {
    const dir = mkdtempSync(resolve('packages', owner, 'lint-fixture-'));
    try {
      const file = join(dir, 'fixture.ts');
      writeFileSync(file, source);
      const result = spawnSync('bun', ['run', 'tools/lint/check.ts', file], { encoding: 'utf8' });
      if (result.error) throw result.error;
      if (failure) {
        expect(result.status).toBe(1);
        expect(result.stdout + result.stderr).toContain(failure);
      } else expect(result.status).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
