import { strict as assert } from 'node:assert';
import { languageIdForPath } from '../../packages/workbench/language/index';

// Extension -> languageId defaults. Every id here must have a bundled Tree-sitter grammar in
// apps/xi/src/syntax-assets.ts, otherwise the syntax service falls back to plain text.
const cases: readonly (readonly [string | undefined, string | undefined])[] = [
  ['src/main.ts', 'typescript'],
  ['src/app.tsx', 'typescript'],
  ['src/app.js', 'javascript'],
  ['src/app.mjs', 'javascript'],
  ['src/app.cjs', 'javascript'],
  ['src/app.jsx', 'javascript'],
  ['tools/run.py', 'python'],
  ['tools/run.pyi', 'python'],
  ['src/main.ml', 'ocaml'],
  ['src/main.mli', 'ocaml_interface'],
  ['lib/example.rb', 'ruby'],
  ['Rakefile.rake', 'ruby'],
  ['example.gemspec', 'ruby'],
  ['Gemfile', 'ruby'],
  ['tasks/Rakefile', 'ruby'],
  ['.irbrc', 'ruby'],
  ['package.json', 'json'],
  ['tsconfig.jsonc', 'json'],
  ['config/languages.toml', 'toml'],
  ['README.md', 'markdown'],
  ['README.MARKDOWN', 'markdown'],
  ['LICENSE.txt', undefined],
  [undefined, undefined],
];

for (const [path, expected] of cases) {
  assert.equal(languageIdForPath(path), expected, `FILE-LANGUAGE-01 ${String(path)} resolves to ${String(expected)}`);
}

console.log('tests/workbench/file-language.test.ts: ok');
