import { strict as assert } from 'node:assert';
import { splitCoalescedEscape } from '../../packages/ui/input/coalesced-escape';

const ESC = String.fromCharCode(0x1b);
const base = { ctrl: false, meta: false, option: false, shift: false };
const colon = splitCoalescedEscape({ ...base, name: '', sequence: `${ESC}:`, raw: `${ESC}:` });
assert.ok(colon !== undefined, 'COALESCED-ESC-01 ESC+":" splits');
assert.equal(colon[0].name, 'escape');
assert.equal(colon[1].name, ':');
const alpha = splitCoalescedEscape({ ...base, name: 'q', meta: true as boolean, sequence: `${ESC}q`, raw: `${ESC}q` });
assert.ok(alpha !== undefined && alpha[1].name === 'q' && alpha[1].meta === false, 'COALESCED-ESC-02 meta chord splits into Esc + key');
const upper = splitCoalescedEscape({ ...base, name: 'x', meta: true as boolean, shift: true as boolean, sequence: `${ESC}X`, raw: `${ESC}X` });
assert.ok(upper !== undefined && upper[1].name === 'x' && upper[1].shift === true, 'COALESCED-ESC-03 shifted letter keeps shift');
assert.equal(splitCoalescedEscape({ ...base, name: 'up', sequence: `${ESC}[A`, raw: `${ESC}[A` }), undefined, 'COALESCED-ESC-04 CSI stays intact');
assert.equal(splitCoalescedEscape({ ...base, name: 'escape', sequence: ESC, raw: ESC }), undefined, 'COALESCED-ESC-05 lone Escape untouched');
assert.equal(splitCoalescedEscape({ ...base, name: 'f1', sequence: `${ESC}OP`, raw: `${ESC}OP` }), undefined, 'COALESCED-ESC-06 SS3 stays intact');
console.log('coalesced-escape passed');
