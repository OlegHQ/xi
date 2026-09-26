import assert from 'node:assert/strict';
import { formatCompletionLines, formatSignatureLines } from '../../packages/ui/completion/index';

const lines = formatCompletionLines({
  state: 'ready', selectedId: 'method', documentation: undefined, message: undefined,
  items: [{ id: 'method', label: 'map', kind: 2 }, { id: 'text', label: 'hello', kind: 1 }],
}, 40);
assert.equal(lines[1], '▸ 󰊕 map', 'selected method has a visible kind icon');
assert.equal(lines[2], '  󰉿 hello', 'text completion has a distinct kind icon');
assert.deepEqual(formatCompletionLines({ state: 'idle', selectedId: undefined, documentation: undefined,
  items: [], message: 'No completions' }, 40), ['No completions'], 'an explicitly invoked empty list displays its message rather than a blank rectangle');

assert.deepEqual(formatSignatureLines({ state: 'idle', label: undefined, documentation: undefined, activeParameter: undefined, message: 'No signature help' }, 40, 8), ['No signature help'], 'empty manual signature help displays its explanation');
