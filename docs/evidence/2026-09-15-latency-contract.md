# Latency requirement refinement — 2026-09-15

Outcome: requirements/catalog consistency checked; runtime performance remains unproven.

The user requested explicit blazing-fast keystroke requirements and native-level typing/loading requirements in AGENTS.md. This change adds spec 15, updates AGENTS.md and specs 05/06/12/14, aligns numeric bounds and adapter obligations, and adds acceptance to T062/T063/T106/T115/T116. Existing statuses and dependency edges are unchanged; T106 remains in progress. No runtime code, tests, measurement tools or concurrent implementation were edited.

## Decision and evidence boundary

- Ordinary loaded output p95/p99 tightens from 12/25 ms to 8/16 ms, matching idle. Both add p50 4 ms and observed max 25 ms.
- Engine retains 1/2 ms p95/p99 and adds 0.5 ms p50 / 4 ms max.
- Large-input output retains p95 16 ms and adds p50 8 / p99 25 / max 50 ms.
- Ordinary event-loop stalls add an 8 ms ceiling. Existing global 50 ms and background integration/preparation bounds remain.
- Ordinary idle/loaded physical key-to-photon p50/p95/p99/max is 20/35/50/75 ms on qualified hardware. This is a new explicit product target, not a measured result or a universal perception threshold.
- Startup/open targets are preserved and elevated into AGENTS.md. Same-host clean-Neovim comparisons remain mandatory; no Neovim runtime is introduced.
- New p50/max/physical obligations increase the catalog from 148 to 166 numeric bounds and from 897 to 1,016 declared variant/metric obligations, retaining 55 owner operations. Declaration does not establish runnable producers or full action/load coverage.

Source context: [Schmid et al. 2023 physical-keyboard experiment](https://epub.uni-regensburg.de/55007/1/text-input-latency.pdf) compared 20 and 200 ms; it supports caring about editing latency but does not identify an imperceptible cutoff. [Dan Luu's instrumented computer measurements](https://danluu.com/input-lag/) and [terminal measurements](https://danluu.com/term-latency/) motivate separately measuring the full display chain. Reviewed via web on 2026-09-15; Xi's numeric targets are an engineering decision.

## Executed validation

- `python3 tools/plan.py check`: passed, 121 tickets; graph/report references valid.
- `python3 tools/perf.py check`: passed, 55 budgets / 1,016 declared obligations; catalog hash `1129c2799ffa38d6980cee5ad84d1f9bca9b16307f1ae3ce396f14b2fa25aa51`.
- `git diff --check`: passed.
- Direct status check: T106 still `in_progress`.

Validation ran in the shared Linux workspace with pre-existing uncommitted implementation. These were documentation/schema checks, not product tests, benchmark runs or visual qualification. Pending adapters, physical instrumentation, per-action/load manifests and session/block analysis remain work for T106/T115 and the owner tickets. Old artifacts are historical and cannot certify the changed catalog; no existing evidence or failed run was deleted.
