import assert from 'node:assert/strict';
import { NodeProcessPort } from '../../packages/platform/src/entrypoints/launch';
import { parseLanguageConfig } from '../../packages/services/config/index';
import { FormatterPipeline, createExternalFormatter, type FormatDocument } from '../../packages/services/formatting/index';

// A languages.toml [[language]].formatter entry should be enough, on its own (no env
// override), to build a working FormatterPipeline for that language's buffers.
const toml = `
[[language]]
name = "typescript"
file-types = ["ts"]
formatter = { command = "${process.execPath}", args = ["-e", "const text = await new Response(Bun.stdin).text(); process.stdout.write(text.trim());"] }
auto-format = true
`;
const parsed = parseLanguageConfig(toml);
assert.equal(parsed.ok, true, 'T075-PARSE-01 languages.toml formatter entry parses');
if (!parsed.ok) throw new Error('unreachable');
const typescript = parsed.value.find((entry) => entry.name === 'typescript');
assert.ok(typescript?.formatter !== undefined, 'T075-FIELD-01 language config carries a formatter field');
assert.equal(typescript?.autoFormat, true, 'T075-AUTO-01 auto-format is read from the same entry');

const environment = Object.freeze(Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)));
const pipeline = new FormatterPipeline([createExternalFormatter({
  id: 'xi.language-formatter',
  command: typescript!.formatter!.command,
  args: typescript!.formatter!.args,
  process: new NodeProcessPort(),
  cwd: process.cwd(),
  env: environment,
  timeoutMilliseconds: 2_000,
})]);
const document: FormatDocument = { documentId: 'doc', version: 1, path: '/tmp/a.ts', text: '  const x = 1;  ' };
const result = await pipeline.format(document, () => 1);
assert.equal(result.ok, true, 'T075-RUN-01 language-selected formatter runs the configured command');
if (result.ok) assert.equal(result.value.text, 'const x = 1;');
console.log('T075 languages.toml formatter selection passed config parsing and pipeline execution');
