#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import {
  WorkbenchResourceCoordinator,
  largeResourceProfile,
  type WorkbenchResourceCoordinatorOptions,
} from '../../packages/workbench/src/index';
import type { ResourceLease, ResourceRequest } from '../../packages/contracts/src/index';

const request = (overrides: Partial<ResourceRequest> = {}): ResourceRequest => ({
  owner: 'workbench',
  kind: 'retained',
  bytes: 1,
  priority: 'live',
  ...overrides,
});

function coordinator(options: WorkbenchResourceCoordinatorOptions = {}): WorkbenchResourceCoordinator {
  return new WorkbenchResourceCoordinator({ capacityBytes: 100, pressureRatio: 0.8, ...options });
}

function admitted(value: ReturnType<WorkbenchResourceCoordinator['admit']>): ResourceLease {
  if (!value.ok) throw new Error(`expected resource admission: ${value.error.kind}`);
  return value.value;
}

const order: string[] = [];
const pressure = coordinator();
const live = admitted(pressure.admit(request({ bytes: 70, priority: 'live', label: 'unsaved-document' })));
const speculative = admitted(pressure.admit(request({ bytes: 5, priority: 'speculative', reclaimable: true, label: 'preview' , onEvict: () => order.push('speculative') })));
const background = admitted(pressure.admit(request({ bytes: 5, priority: 'background', reclaimable: true, label: 'stale-result', onEvict: () => order.push('background') })));
const interactive = admitted(pressure.admit(request({ bytes: 10, priority: 'interactive', reclaimable: true, label: 'frame', onEvict: () => order.push('interactive') })));
assert.deepEqual(order, ['speculative', 'background'], 'T114-PRESSURE-01 lower priority reconstructible work is evicted first');
assert.equal(speculative.evicted, true, 'T114-PRESSURE-02 speculative preview is released');
assert.equal(background.evicted, true, 'T114-PRESSURE-03 stale background result is released');
assert.equal(interactive.evicted, false, 'T114-PRESSURE-04 higher priority frame is retained');
assert.equal(pressure.stats().processBytes, 80, 'T114-PRESSURE-05 pressure recovery reaches the watermark');
assert.equal(live.bytes, 70, 'T114-PRESSURE-06 live unsaved reservation is retained');
live.dispose();
interactive.dispose();
pressure.dispose();

const hard = coordinator();
const hardLive = admitted(hard.admit(request({ bytes: 80, priority: 'live' })));
const rejectedSpeculative = hard.admit(request({ bytes: 1, priority: 'speculative', reclaimable: true }));
assert.equal(rejectedSpeculative.ok, false, 'T114-ADMISSION-01 speculative work stops at 80 percent pressure');
if (!rejectedSpeculative.ok) assert.equal(rejectedSpeculative.error.kind, 'pressure');
const rejectedLarge = hard.admit(request({ bytes: 21, priority: 'background' }));
assert.equal(rejectedLarge.ok, false, 'T114-ADMISSION-02 hard exhaustion rejects expensive work');
if (!rejectedLarge.ok) assert.equal(rejectedLarge.error.kind, 'capacity');
const beforeUpdate = hard.stats();
const failedUpdate = hardLive.update(101);
assert.equal(failedUpdate.ok, false, 'T114-ADMISSION-03 failed growth is atomic');
assert.deepEqual(hard.stats(), beforeUpdate, 'T114-ADMISSION-04 failed growth leaves counters unchanged');
hardLive.dispose();
hard.dispose();

const owner = coordinator({ ownerLimitsBytes: new Map([['language', 40]]) });
const languageLive = admitted(owner.admit(request({ owner: 'language', bytes: 30, priority: 'live' })));
const languageCache = admitted(owner.admit(request({ owner: 'language', bytes: 5, priority: 'background', reclaimable: true })));
const languageGrowth = owner.admit(request({ owner: 'language', bytes: 10, priority: 'background' }));
assert.equal(languageGrowth.ok, true, 'T114-OWNER-01 owner growth can reclaim its own reconstructible cache');
assert.equal(languageCache.evicted, true, 'T114-OWNER-02 owner reclaim does not evict another owner');
languageLive.dispose();
if (languageGrowth.ok) languageGrowth.value.dispose();
owner.dispose();

const external = coordinator();
const externalLease = admitted(external.admitExternal('language-server', 20, 'separate-process-rss'));
const externalStats = external.stats();
assert.equal(externalStats.externalBytes, 20, 'T114-EXTERNAL-01 external bytes are reported separately');
assert.equal(externalStats.accountedBytes, 0, 'T114-EXTERNAL-02 external bytes are excluded from Xi-owned attribution');
assert.equal(externalStats.processBytes, 20, 'T114-EXTERNAL-03 external bytes remain in the simultaneous process envelope');
externalLease.dispose();
external.dispose();

const lifecycle = coordinator();
let released = 0;
for (let cycle = 0; cycle < 1_000; cycle += 1) {
  const lease = admitted(lifecycle.admit(request({ owner: 'config', bytes: 64, priority: 'background', reclaimable: true })));
  lease.dispose();
}
const retained = admitted(lifecycle.admit(request({ owner: 'view', bytes: 10, priority: 'interactive', reclaimable: true, onEvict: () => { released += 1; } })));
assert.equal(lifecycle.stats().leases, 1, 'T114-LIFECYCLE-01 disposed cycles leave no reservations');
assert.equal(lifecycle.stats().processBytes, 10, 'T114-LIFECYCLE-02 only the live lifecycle resource remains');
lifecycle.dispose();
assert.equal(retained.evicted, true, 'T114-LIFECYCLE-03 coordinator disposal releases retained roots');
assert.equal(released, 1, 'T114-LIFECYCLE-04 disposal callback runs once');
assert.equal(lifecycle.stats().leases, 0, 'T114-LIFECYCLE-05 disposal clears listeners/tasks/root reservations');

const profile = largeResourceProfile(100 * 1024 * 1024);
assert.deepEqual(profile, {
  inputBytes: 100 * 1024 * 1024,
  steadyRssBytes: 450 * 1024 * 1024,
  peakRssBytes: 600 * 1024 * 1024,
}, 'T114-PROFILE-01 large RSS formula matches the normative contract');
console.log('T114 resource coordinator passed pressure, owner, external accounting, atomic rejection and 1,000 lifecycle checks');
