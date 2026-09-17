import assert from 'node:assert/strict';
import { BufferPickerProvider } from '../../packages/services/navigation';
import type { CancellationToken } from '../../packages/contracts/src/index';

function token(isCancelled: boolean): CancellationToken {
  return { isCancelled, onCancel: () => ({ dispose: () => {} }) };
}
const cancellation = token(false);

const buffers = [
  { id: '1', label: '/ws/src/main.ts', detail: 'modified', value: '1' },
  { id: '2', label: '/ws/src/Main.spec.ts', detail: 'saved', value: '2' },
  { id: '3', label: '/ws/README.md', detail: 'saved', value: '3' },
  { id: '4', label: '[No Name]', detail: 'saved', value: '4' },
];

const provider = new BufferPickerProvider('xi.navigation.buffers', () => buffers);
assert.equal(provider.mode, 'buffer');

const all = await provider.query({ mode: 'buffer', query: '' }, cancellation);
assert.equal(all.ok, true);
if (all.ok) assert.equal(all.value.length, 4, 'T-BUFPICK-01 an empty query returns every open buffer');

const substring = await provider.query({ mode: 'buffer', query: 'main' }, cancellation);
assert.equal(substring.ok, true);
if (substring.ok) {
  assert.equal(substring.value.length, 2, 'T-BUFPICK-02 substring match is case-insensitive and NFKC-normalized');
  assert.deepEqual(new Set(substring.value.map((entry) => entry.id)), new Set(['1', '2']));
}

const noMatch = await provider.query({ mode: 'buffer', query: 'nonexistent' }, cancellation);
assert.equal(noMatch.ok, true);
if (noMatch.ok) assert.equal(noMatch.value.length, 0, 'T-BUFPICK-03 an unmatched substring returns no entries');

const limited = await provider.query({ mode: 'buffer', query: '', limit: 2 }, cancellation);
assert.equal(limited.ok, true);
if (limited.ok) assert.equal(limited.value.length, 2, 'T-BUFPICK-04 the limit bounds the result count');

const cancelled = await provider.query({ mode: 'buffer', query: '' }, token(true));
assert.equal(cancelled.ok, false, 'T-BUFPICK-05 a pre-cancelled query is rejected');

// A dynamic source is re-read on every query, so buffer list changes since the last query show up immediately.
let live = buffers.slice(0, 1);
const dynamicProvider = new BufferPickerProvider('xi.navigation.buffers.dynamic', () => live);
const before = await dynamicProvider.query({ mode: 'buffer', query: '' }, cancellation);
if (before.ok) assert.equal(before.value.length, 1, 'T-BUFPICK-06 initial dynamic source size');
live = buffers;
const after = await dynamicProvider.query({ mode: 'buffer', query: '' }, cancellation);
if (after.ok) assert.equal(after.value.length, 4, 'T-BUFPICK-07 the source is re-read, not cached, on each query');

console.log('T-BUFPICK buffer picker provider passed NFKC substring matching, limits, cancellation and live re-querying');
