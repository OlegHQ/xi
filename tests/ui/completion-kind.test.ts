import assert from 'node:assert/strict';
import { formatCompletionLines } from '../../packages/ui/completion/index';

const lines = formatCompletionLines({
  state: 'ready', selectedId: 'method', documentation: undefined, message: undefined,
  items: [{ id: 'method', label: 'map', kind: 2 }, { id: 'text', label: 'hello', kind: 1 }],
}, 40);
assert.equal(lines[1], '▸ 󰊕 map', 'selected method has a visible kind icon');
assert.equal(lines[2], '  󰉿 hello', 'text completion has a distinct kind icon');
