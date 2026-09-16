import assert from 'node:assert/strict';
import { HostNavigationController, type HostNavigationProvider } from '../../../packages/services/navigation/host';

const provider: HostNavigationProvider = {
  async file(path) { return path === 'missing' ? { ok: false, error: { kind: 'missing', message: 'missing' } } : { ok: true, value: { uri: `file://${path}`, line: 0, utf16: 0 } }; },
  async tag(name) { return name === 'ambiguous' ? { ok: true, value: [{ uri: 'file:///a', line: 1, utf16: 0 }, { uri: 'file:///b', line: 2, utf16: 0 }] } : { ok: true, value: [{ uri: `file:///${name}`, line: 0, utf16: 0 }] }; },
};
const navigation = new HostNavigationController(provider);
assert.equal((await navigation.openFile('a.ts')).ok, true, 'T071-FILE-01 file navigation opens location');
assert.equal((await navigation.openTag('symbol')).ok, true, 'T071-TAG-01 tag navigation opens unique location');
assert.equal((await navigation.openTag('ambiguous')).ok, false, 'T071-TAG-FAIL-01 ambiguous tag is explicit');
assert.equal(navigation.back()?.uri, 'file://a.ts', 'T071-BACK-01 history returns original location');
assert.equal((await navigation.openFile('missing')).ok, false, 'T071-MISSING-01 missing file is explicit');
navigation.dispose();
console.log('T071 host navigation passed file/tag outcomes, jump history and missing/ambiguous failures');
