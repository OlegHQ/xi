#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { openTextDocument, type DocumentSnapshot } from '../../../packages/document/src/index';
import { asIdentifier, asUtf16Offset, type DocumentId, type LineIndex } from '../../../packages/primitives/src/index';
import {
  normalizeVimOperatorRange,
  prepareVimAdvancedOperator,
  prepareVimNumericOperator,
  type VimNormalizedOperatorRange,
} from '../../../packages/vim/src/index';

function offset(value: number) {
  const result = asUtf16Offset(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('invalid offset');
  return result.value;
}
function open(text: string, id = 't104'): DocumentSnapshot {
  const documentId = asIdentifier<DocumentId>(id, 'documentId');
  assert.equal(documentId.ok, true);
  if (!documentId.ok) throw new Error('invalid id');
  const result = openTextDocument(documentId.value, new TextEncoder().encode(text));
  assert.equal(result.kind, 'editable');
  if (result.kind !== 'editable') throw new Error('read-only fixture');
  return result.document.snapshot();
}
function range(snapshot: DocumentSnapshot, start: number, end: number): VimNormalizedOperatorRange {
  const result = normalizeVimOperatorRange(snapshot, {
    origin: { documentVersion: snapshot.version, offset: offset(start) }, target: { documentVersion: snapshot.version, offset: offset(end) },
    direction: 'forward', motionKind: 'characterwise', inclusive: true, motionKey: 'l', operator: 'delete',
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('range failed');
  return result.value;
}

const source = open('one 42\n');
const whole = range(source, 0, source.lengthUtf16 - 1);
const filtered = await prepareVimAdvancedOperator({
  snapshot: source, range: whole, operator: '!', argv: ['tr', 'a-z', 'A-Z'],
  provider: { id: 'upper', provide: ({ snapshot, range: selected }) => {
    const text = snapshot.slice(selected.start, selected.end);
    assert.equal(text.ok, true);
    return { ok: true, value: { text: text.ok ? text.value.toUpperCase() : '' } };
  } },
});
assert.equal(filtered.ok, true, 'T104-FILTER-01 provider output prepares a transaction');
if (filtered.ok && filtered.value.operator === '!') {
  assert.notEqual(filtered.value.transaction, null);
  if (filtered.value.transaction !== null) {
    assert.equal(filtered.value.transaction.expectedVersion, source.version);
    assert.equal(filtered.value.transaction.edits[0]?.text, 'ONE 42');
  }
}
assert.deepEqual(await prepareVimAdvancedOperator({ snapshot: source, range: whole, operator: '!', argv: ['cat'] }),
  { ok: false, error: { kind: 'provider-unavailable', provider: 'filter' } }, 'T104-FILTER-02 missing provider never guesses');
assert.deepEqual(await prepareVimAdvancedOperator({ snapshot: source, range: whole, operator: '!', argv: ['cat'], isCancelled: () => true,
  provider: { id: 'cancelled', provide: () => ({ ok: true, value: { text: 'unreachable' } }) } }),
  { ok: false, error: { kind: 'cancelled' } }, 'T104-FILTER-02b cancellation is checked before provider work');
assert.deepEqual(await prepareVimAdvancedOperator({ snapshot: source, range: whole, operator: '!', argv: ['flood'], outputLimitBytes: 2,
  provider: { id: 'flood', provide: () => ({ ok: true, value: { text: 'overflow' } }) } }),
  { ok: false, error: { kind: 'provider-output-limit', limitBytes: 2 } }, 'T104-FILTER-03 output flood is bounded');
assert.deepEqual(await prepareVimAdvancedOperator({ snapshot: source, range: whole, operator: '!', argv: ['bad'],
  provider: { id: 'bad', provide: () => ({ ok: true, value: { text: '\ud800' } }) } }),
  { ok: false, error: { kind: 'provider-invalid-output', provider: 'filter' } }, 'T104-FILTER-04 malformed output is rejected');

const folded = await prepareVimAdvancedOperator({ snapshot: source, range: whole, operator: 'zf',
  provider: { id: 'fold', provide: () => ({ ok: true, value: { changes: [{ kind: 'create', startLine: 0 as LineIndex, endLineExclusive: 1 as LineIndex }] } }) } });
assert.equal(folded.ok, true, 'T104-FOLD-01 provider fold effect is typed');
if (folded.ok && folded.value.operator === 'zf') { assert.equal(folded.value.transaction, null); assert.equal(folded.value.foldChanges[0]?.kind, 'create'); }
assert.deepEqual(await prepareVimAdvancedOperator({ snapshot: source, range: whole, operator: 'zf' }),
  { ok: false, error: { kind: 'provider-unavailable', provider: 'fold' } }, 'T104-FOLD-02 missing fold provider is explicit');

const numberSource = open('hex 0x0f dec 007 bin 0b11\n', 't104-numbers');
const numberText = numberSource.slice(offset(0), offset(numberSource.lengthUtf16));
assert.equal(numberText.ok, true);
if (!numberText.ok) throw new Error('text unavailable');
const hexOffset = numberText.value.indexOf('0x0f');
const increment = prepareVimNumericOperator({ snapshot: numberSource, operator: '<C-A>', cursorOffset: offset(hexOffset), options: { nrformats: 'bin,hex' } });
assert.equal(increment.ok, true, 'T104-NUMBER-01 hexadecimal Ctrl-A prepares');
if (increment.ok) assert.equal(increment.value.transaction?.edits[0]?.text, '0x10');
const decimalOffset = numberText.value.indexOf('007');
const decrement = prepareVimNumericOperator({ snapshot: numberSource, operator: '<C-X>', cursorOffset: offset(decimalOffset), options: { nrformats: 'bin,hex' } });
assert.equal(decrement.ok, true, 'T104-NUMBER-02 decimal Ctrl-X prepares');
if (decrement.ok) assert.equal(decrement.value.transaction?.edits[0]?.text, '006');
const binaryOffset = numberText.value.indexOf('0b11');
const binary = prepareVimNumericOperator({ snapshot: numberSource, operator: '<C-A>', cursorOffset: offset(binaryOffset), options: { nrformats: 'bin' } });
assert.equal(binary.ok, true, 'T104-NUMBER-03 binary increment prepares');
if (binary.ok) assert.equal(binary.value.transaction?.edits[0]?.text, '0b100');
assert.deepEqual(prepareVimNumericOperator({ snapshot: numberSource, operator: '<C-A>', cursorOffset: offset(binaryOffset), options: { nrformats: 'bad' } }),
  { ok: false, error: { kind: 'invalid-option' } }, 'T104-NUMBER-04 invalid nrformats is explicit');

console.log('T104 advanced operators passed provider, fold, output-limit and numeric nrformats cases');
