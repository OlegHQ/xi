---
name: xi-validate
description: Validate Xi editor changes through relevant behavioral, PTY, visual and performance gates.
---

Read [testing](../../../docs/testing.md) and the affected product contract. Select the
smallest suite that covers the owner, then run the production path for user-visible work.
Do not broaden repeatedly after the required checks pass unless a failure or new change
justifies it.

For UI work, use render/input tests plus the real CLI in a genuine PTY. Assert visible
state and resulting files, not private controller state. Inspect screenshots for palette,
alignment, cursor, truncation and small viewports.

For configuration parity, prove the pinned Helix reference accepts the fixture, Xi accepts
the same shape, and launched Xi behavior changes. Test unknown keys, wrong types, invalid
values, reload rollback and unsafe workspace executable settings. Parse-only acceptance is
a failure of the parity claim. Run `bun run check:config-ledger` and verify each passing
dimension names the test that proves it; never infer completion from another key in the
same section.

For filesystem, Git and LSP changes, inject stale versions, cancellation, malformed input,
partial failure and crashes in disposable roots. Real language servers supplement rather
than replace a delayed or malicious fake peer.

For performance, follow [performance](../../../docs/performance.md): report p50/p95/p99/max,
sample count, corpus, environment, CPU/wall time and memory/allocation data where relevant.
A noisy run is inconclusive. Input-to-output timestamps are not physical key-to-visible
latency, and a component benchmark does not qualify the CLI.

Report exact commands and truthful outcomes in the handoff and commit, not a per-ticket
evidence file. Missing oracle, unreviewed visual output or unmeasured mandatory budget
remains unproven.
