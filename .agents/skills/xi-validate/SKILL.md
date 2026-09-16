---
name: xi-validate
description: Validate Xi editor changes through relevant behavioral, PTY, visual and performance gates, with reproducible evidence and truthful pass/fail reporting.
---

Read the assigned ticket and [validation specification](../../../docs/plan/05-validation.md). Choose the required suites for that change; run the complete contract for a milestone/release. Confirm scripts exercise production paths and fail on missing tests. Do not repeatedly broaden tests after the required checks pass unless new failures or changes justify it.

For UI work, use OpenTUI frame/input tests plus the real CLI in a genuine PTY. Assert visible state and resulting files, not only private controller state. Cover success/cancel/error/stale response and focus restoration for the affected [UX journey](../../../docs/plan/03-ux.md). Inspect actual terminal screenshots for palette, alignment, cursor, truncation and small-viewport behavior before accepting snapshots. Text snapshots alone do not prove good visual UX.

For performance, use the specified corpus, pinned versions and recorded host/terminal. Report p50/p95/p99/max, sample count, baseline/candidate and memory/CPU including native allocations and workers. Input-to-output timestamps are not physical key-to-photon latency. A shared-runner noisy result is inconclusive, not passed. Fix measured bottlenecks through the owner; do not weaken thresholds or omit slow cases.

For filesystem/Git/LSP changes, inject stale versions, cancellation, partial failures and crashes in disposable test roots. Inspect actual disk/index bytes and recovery outcomes. Never run destructive fixtures against personal projects. Real language server tests supplement, rather than replace, a malicious/delayed fake peer.

Write [evidence](../../../docs/plan/evidence-template.md) with exact executed commands and actual outcomes. Missing oracle, unavailable server, unmeasured required budget or unreviewed snapshot leaves the relevant gate unproven. Record limitations and the concrete next action; never auto-approve a gate from a report filename.

For resource work read [performance classes, budgets and PF01–PF12](../../../docs/plan/12-performance.md). Run `python3 tools/perf.py check` and inspect assigned budget rows. The SQLite ledger is development-only: `within-target` is a numeric observation, never a release pass. Verify source/corpus/environment/artifact identity, metric units/statistics, required samples and a real compatible baseline. The existing aggregate runner printing `--baseline` is not comparison evidence; T106/T115 own that gap.

Measure public operations including EOL metadata, undo/register roots, selection vectors, full/partial snapshots, native OpenTUI/WASM allocations, workers and in-flight bytes. Separate total allocation from retained heap and RSS; retain signed deltas. Bun uses JavaScriptCore: verify profiling APIs on the pinned runtime, do not assume V8 flags/counters, and do not double-count inclusive `extraMemorySize`. Arena counters cannot prove total zero allocation; forced GC belongs in retained-memory probes, not typing traces.

Cover cold and warm long-line Unicode, dense/alternating EOL, long Insert groups, giant delete/undo, pressure/backpressure and stale retained frame/snapshot lifetimes for affected owners. Check exact semantic output before timing. Required per-owner bounds and aggregate process caps must hold together; zero observations, inadequate samples, noisy hosts or missing allocation evidence remain unproven.
