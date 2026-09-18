import assert from 'node:assert/strict';
import { InMemorySearchBackend, RealtimeSearchService, type SearchQuery } from '../../packages/services/search/index';

// Regression: the coalesced per-macrotask intermediate publish used to fire AFTER the final
// model when the backend delivered its batch and completed in the same tick, flipping a
// 'ready' result back to 'loading' (tests/e2e/t045-e06-replace-dirty-closed-pty.py then
// refused to replace). The last published state for a generation must be terminal.
const query: SearchQuery = { rootId: 'root', rootPath: '/workspace', query: 'needle' };
const service = new RealtimeSearchService({
  backend: new InMemorySearchBackend([{ rootId: 'root', path: 'beta.txt', text: 'needle in beta', diskHash: 'b' }]),
  debounceMilliseconds: 0,
});
const states: string[] = [];
service.subscribe((model) => { states.push(model.state); });
const result = await service.query(query);
assert.equal(result.ok, true);
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(states.at(-1), 'ready', `SEARCH-PUBLISH-ORDER-01 last published state must be terminal, got ${states.join(' > ')}`);
assert.equal(service.model.state, 'ready', 'SEARCH-PUBLISH-ORDER-01 read model stays ready after the run');
service.dispose();
console.log(`SEARCH-PUBLISH-ORDER-01 passed: ${states.join(' > ')}`);
