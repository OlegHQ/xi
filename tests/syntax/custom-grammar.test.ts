import assert from 'node:assert/strict';
import { createBundledGrammarProvider, type AssetFileReader } from '../../apps/xi/src/syntax-assets';
import { resolveConfiguredLanguageId } from '../../apps/xi/src/wiring/language';
import { CancellationSource } from '../../packages/primitives/src/entrypoints/launch';
import type { LanguageConfig } from '../../packages/services/src/entrypoints/config';

const files = new Map<string, Uint8Array>([
  ['/config/grammars/mylang.wasm', new Uint8Array([1, 2, 3])],
  ['/config/grammars/mylang.scm', new TextEncoder().encode('(identifier) @variable')],
]);
const reader: AssetFileReader = {
  async readFile(path, _cancellation, options) {
    const value = files.get(path);
    if (value === undefined) return { ok: false, error: { code: 'ENOENT', message: 'missing', retryable: false } };
    if (options?.maxBytes !== undefined && value.byteLength > options.maxBytes) return { ok: false, error: { code: 'file-too-large', message: 'too large', retryable: false } };
    return { ok: true, value };
  },
};
const configured: LanguageConfig = { name: 'mylang', fileTypes: ['my'], languageServers: [], indent: undefined, formatter: undefined, formatters: [], autoFormat: false };
assert.equal(resolveConfiguredLanguageId([configured], '/tmp/example.my'), 'mylang');
const cancellation = new CancellationSource();
const provider = createBundledGrammarProvider(reader, cancellation.token, false, '/config/grammars');
const loaded = await provider.resolve('mylang');
assert.equal(loaded.ok, true);
if (loaded.ok) {
  assert.deepEqual(loaded.value.wasm, new Uint8Array([1, 2, 3]));
  assert.equal(loaded.value.highlights, '(identifier) @variable');
}
files.delete('/config/grammars/mylang.scm');
const partial = await createBundledGrammarProvider(reader, cancellation.token, false, '/config/grammars').resolve('mylang');
assert.equal(partial.ok, false, 'an incomplete custom grammar must report failure');
const traversal = await provider.resolve('../outside');
assert.equal(traversal.ok, false, 'a grammar ID cannot escape the config directory');
cancellation.dispose();
