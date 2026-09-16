import assert from 'node:assert/strict';
import { CancellationSource } from '../../packages/contracts/src/index';
import { PullDiagnosticStore, type PullDiagnosticProvider, type PullDiagnosticReport } from '../../packages/services/language/pull-diagnostics';

type Item = { readonly message: string };
const full = (resultId: string, message: string): PullDiagnosticReport<Item> => ({ kind: 'full', resultId, items: [{ message }] });

let documentCalls = 0;
let workspaceMode: 'full' | 'partial' = 'full';
let raceCalls = 0;
let resolveRaceFirst!: (value: { ok: true; value: PullDiagnosticReport<Item> }) => void;
let resolveRaceSecond!: (value: { ok: true; value: PullDiagnosticReport<Item> }) => void;
let resolveCancelled!: (value: { ok: true; value: PullDiagnosticReport<Item> }) => void;
const provider: PullDiagnosticProvider<Item> = {
  async request(uri, previousResultId) {
    if (uri === 'race') {
      raceCalls += 1;
      return new Promise((resolve) => {
        if (raceCalls === 1) resolveRaceFirst = resolve;
        else resolveRaceSecond = resolve;
      });
    }
    if (uri === 'cancel') return new Promise((resolve) => { resolveCancelled = resolve; });
    documentCalls += 1;
    if (uri === 'a' && documentCalls === 1) return { ok: true, value: full('r1', 'old') };
    if (uri === 'a' && previousResultId === 'r1') return { ok: true, value: { kind: 'unchanged', resultId: 'r1', items: [] } };
    if (uri === 'invalid-id') return { ok: true, value: { kind: 'unchanged', resultId: 'wrong', items: [] } };
    return { ok: true, value: full(`r-${uri}`, uri) };
  },
  async requestWorkspace(items) {
    const reports = items.map((item) => ({ uri: item.uri, report: full(`workspace-${item.uri}`, item.uri) }));
    return { ok: true, value: { items: workspaceMode === 'full' ? reports : reports.slice(0, 1) } };
  },
};

const store = new PullDiagnosticStore(provider);
const first = await store.refresh('a');
assert.equal(first.ok, true, 'T068-RESULT-ID-01 full report is retained');
if (first.ok) assert.equal(first.value.items[0]?.message, 'old');
const second = await store.refresh('a');
assert.equal(second.ok, true, 'T068-RESULT-ID-01 unchanged report is accepted only with the current result ID');
if (second.ok) assert.equal(second.value.items[0]?.message, 'old');

const invalidBaseline = new PullDiagnosticStore<Item>({
  async request() { return { ok: true, value: { kind: 'unchanged', resultId: 'orphan', items: [] } }; },
});
const invalid = await invalidBaseline.refresh('invalid-id');
assert.equal(invalid.ok, false, 'T068-RESULT-ID-FAIL-01 unchanged report without a valid baseline is rejected');
assert.equal(invalidBaseline.get('invalid-id')?.items.length, 0, 'T068-RESULT-ID-FAIL-01 invalid reports cannot resurrect prior items');

const workspace = await store.refreshWorkspace(['b', 'c']);
assert.equal(workspace.ok, true, 'T068-WORKSPACE-01 complete workspace reports apply together');
assert.equal(store.get('b')?.items[0]?.message, 'b');
workspaceMode = 'partial';
const partial = await store.refreshWorkspace(['b', 'c']);
assert.equal(partial.ok, false, 'T068-WORKSPACE-FAIL-01 partial workspace responses are rejected');
assert.equal(store.get('b')?.items.length, 0, 'T068-WORKSPACE-FAIL-01 partial response does not leave a mixed old/new workspace');
assert.equal(store.get('c')?.items.length, 0, 'T068-WORKSPACE-FAIL-01 every affected URI is invalidated together');

const raceFirst = store.refresh('race');
const raceSecond = store.refresh('race');
resolveRaceSecond({ ok: true, value: full('race-new', 'current-after-edit') });
assert.equal((await raceSecond).ok, true, 'T068-STALE-01 newest refresh becomes current');
resolveRaceFirst({ ok: true, value: full('race-old', 'stale-before-edit') });
assert.equal((await raceFirst).ok, false, 'T068-STALE-01 late refresh is rejected');
assert.equal(store.get('race')?.items[0]?.message, 'current-after-edit', 'T068-STALE-01 late refresh cannot resurrect stale errors');

const cancellation = new CancellationSource();
const cancelled = store.refresh('cancel', cancellation.token);
cancellation.cancel();
resolveCancelled({ ok: true, value: full('cancelled', 'should-not-publish') });
assert.equal((await cancelled).ok, false, 'T068-CANCEL-01 cancelled refresh is rejected');
assert.equal(store.get('cancel')?.items.length, 0, 'T068-CANCEL-01 cancelled refresh clears the loading snapshot');
cancellation.dispose();

store.restart();
assert.equal(store.get('a')?.resultId, undefined, 'T068-RESTART-01 restart clears document result IDs');
assert.equal(store.get('a')?.items.length, 0, 'T068-RESTART-01 restart clears stale document errors');
store.dispose();
assert.equal((await store.refresh('a')).ok, false, 'T068-DISPOSE-01 disposed store rejects refresh');
console.log('T068 pull diagnostics passed valid result-id reuse, atomic workspace refresh, stale/cancelled barriers, restart reset and disposal');
