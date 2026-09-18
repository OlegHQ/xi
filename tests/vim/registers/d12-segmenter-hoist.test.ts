#!/usr/bin/env bun
// D12 perf regression: packages/vim/registers/index.ts's grapheme-cluster lookup (used by
// `p`/`P` to land the cursor past a full grapheme, e.g. base char + combining mark) must
// not construct a new Intl.Segmenter on every call -- it must be hoisted once at module
// scope. We can't re-import the module fresh per assertion (it's already loaded process-
// wide), so instead we spy on the global Intl.Segmenter constructor and confirm repeated
// `p` puts create zero additional segmenters.
import { strict as assert } from 'node:assert';
import { openTextDocument } from '../../../packages/document/src/index';
import type { DocumentId, Utf16Offset } from '../../../packages/primitives/src/index';
// Import first so the module's hoisted segmenter (if any) is constructed before the spy
// starts counting -- that construction must happen at most once, at import time.
import { prepareVimPut, type VimRegisterValue } from '../../../packages/vim/registers/index';

const character = (lines: readonly string[]): VimRegisterValue => ({ lines, type: 'characterwise' });

let constructedCount = 0;
const RealSegmenter = Intl.Segmenter;
class SpySegmenter extends RealSegmenter {
  constructor(...args: ConstructorParameters<typeof RealSegmenter>) {
    super(...args);
    constructedCount += 1;
  }
}
Object.defineProperty(Intl, 'Segmenter', { value: SpySegmenter, configurable: true, writable: true });

try {
  const opened = openTextDocument('d12-segmenter' as DocumentId, new TextEncoder().encode('éx')); // "e" + combining acute + "x"
  assert.equal(opened.kind, 'editable');
  if (opened.kind !== 'editable') throw new Error('unreachable');
  const snapshot = opened.document.snapshot();
  const ITERATIONS = 200;
  for (let index = 0; index < ITERATIONS; index += 1) {
    const result = prepareVimPut({ snapshot, cursor: 0 as Utf16Offset, register: character(['Z']), command: 'p' });
    assert.equal(result.ok, true, `D12-01 put #${index} succeeds`);
  }
  assert.equal(constructedCount, 0,
    `D12-02 repeated puts through the grapheme-boundary path construct zero new Intl.Segmenter instances (got ${constructedCount})`);
} finally {
  Object.defineProperty(Intl, 'Segmenter', { value: RealSegmenter, configurable: true, writable: true });
}

console.log('d12-segmenter-hoist: all assertions passed');
