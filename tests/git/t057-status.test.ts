import assert from 'node:assert/strict';
import { GitStatusCache, parsePorcelainV2Z } from '../../packages/services/git/index';

const output = '# branch.head main\0' + '1 .M N... 100644 100644 100644 abc def file.ts\0' + '1 A. N... 100644 100644 100644 abc def added.ts\0' + '2 R. N... 100644 100644 100644 abc def R100 renamed.ts\0old.ts\0' + 'u UU N... 100644 100644 100644 100644 a b c conflict.ts\0' + '? untracked.txt\0' + '! ignored.log\0';
const parsed = parsePorcelainV2Z('/repo', new TextEncoder().encode(output), 1, 'main');
assert.equal(parsed.ok, true, 'T057-PORCELAIN-01 parses NUL status records');
if (parsed.ok) { assert.equal(parsed.value.entries.length, 6); assert.equal(parsed.value.entries.find((entry) => entry.path === 'renamed.ts')?.state, 'renamed'); assert.equal(parsed.value.entries.find((entry) => entry.path === 'conflict.ts')?.conflict, true); assert.equal(parsed.value.entries.find((entry) => entry.path === 'untracked.txt')?.staged, false); }
const cache = new GitStatusCache(); if (parsed.ok) assert.equal(cache.publish(parsed.value).ok, true); if (parsed.ok) assert.equal(cache.publish({ ...parsed.value, generation: 0 }).ok, false, 'T057-STALE-01 stale status cannot overwrite'); cache.dispose();
const malformed = parsePorcelainV2Z('/repo', new TextEncoder().encode('x invalid\0'), 1); assert.equal(malformed.ok, false, 'T057-FAIL-01 malformed records explicit');
console.log('T057 Git status passed porcelain-v2 NUL parsing, rename/conflict/untracked identity and stale cache rejection');
