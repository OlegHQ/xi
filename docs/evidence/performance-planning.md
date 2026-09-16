# Performance and architecture planning refinement

- Task: refine Xi's initial engine plan, resource budgets, ownership and implementation skills using the supplied performance notes and deep research.
- Outcome: planning refinement and developer ledger validated; **product performance remains unproven**.
- Base revision: `555ed0ce3c2475a10844824468e6fddbb6e49755`, existing uncommitted implementation preserved. No commit/push or remote changes.
- Environment: Linux aarch64 shared VM, Bun 1.3.13, TypeScript 7.0.2, OpenTUI 0.5.11, Python 3.13.15, developer SQLite 3.51.2. No terminal involved in the diagnostic probes. No dedicated performance runner was certified.
- Normative artifacts: [performance engineering](../plan/12-performance.md), [research](../plan/13-performance-research.md), [budget catalog](../plan/performance-budgets.json), [118-ticket backlog](../plan/tickets.json).
- Small retained measurements: [diagnostic JSON](performance-planning-diagnostics.json); [source manifest](performance-planning-source-manifest.sha256). Source manifest hashes current planning/tool/probe and product files, not a claim that historical evidence was rerun.

## Observable result

The plan is oriented around Xi's initial requirements and its owned engine, with Neovim serving as a behavior oracle. It preserves required motion/operator/edit families, multiple selections, Unicode/fidelity/history, workbench and services without prescribing Vim's storage/pager/full application. No runtime Neovim, duplicate text owner or new native engine was introduced.

There are 55 budgeted owner operations and 148 numeric bounds, covering engine/coordinates/document/EOL/history/registers/selections, layout/native output, input, startup, service CPU/queues/replicas, all service families, process memory/pressure/lifetimes, and developer ledger performance. The original 150 MiB warm RSS, latency, multi-selection and release requirements remain. Explicit initial targets and whole-process accounting replace vague advice to avoid objects everywhere.

Three existing skills now distinguish H0 inner loops from bounded immutable H1 command state and ordinary control/UI code, enforce snapshot/scratch/pool lifetimes, require public-path measurements, and use Bun/JSC accounting correctly. Existing public coordinate units and package owners remain authoritative. The document representation is requalified by evidence before a migration; packed EOL remediation has an immediate measured reason.

The developer-only [SQLite tool](../../tools/perf.py) builds an indexed catalog, imports immutable versioned observation bundles with atomic batched transactions, and reports numeric coverage separately from release certification. It validates units, statistics, finite numbers, artifact hashes, parameters and catalog identity. JSON thresholds remain canonical; the ignored DB is rebuildable. No runtime SQLite dependency, persistence migration or performance dashboard was added.

## Executed validation

| Command / inspection | Actual outcome |
|---|---|
| Read both requested attachment files in full; inspect current worktree, skills, architecture, validation/services/selection plans, storage/engine/layout/service/CLI paths and runner | Completed. Their proposals were treated as research questions, not assumed facts about Bun or immutable history. |
| Primary web/source research, pinned download and SHA-256 extraction | Completed; sources and limitations in [research](../plan/13-performance-research.md) and [source provenance](../plan/performance-sources.json). One optional WebKit source returned 429; the successfully fetched StringImpl source supports the cited observations. |
| Six fresh `bun run bench/performance/planning-probe.ts <public|rope> <normal|dense|long> 1048576` children | Completed. Public dense open: 1500.08 ms, reported post-GC heap growth 137.12 MiB, RSS growth 248.22 MiB. Single diagnostic samples, not quantile/release qualification. |
| `bun --cpu-prof-md --cpu-prof-dir=.artifacts/performance-planning --cpu-prof-name=dense-open.md run bench/performance/planning-probe.ts public dense 1048576` | Completed; profile self-time reports native freeze 66.2%, LineEndingSequence 10.9%, GC 5.2%. Corroborates expensive persistent metadata construction; does not justify deleting immutability checks blindly. Profiled open itself is slower and is not compared as a latency candidate. |
| `python3 bench/performance/ledger-probe.py` before/after atomic multi-bundle import | 100,000 synthetic rows in 1.427 s on the final rerun versus 13.901 s with 1,000 separate commits; the first batched result was 1.206 s and remains retained. Final CPU 1.331 s; 1,000 indexed queries p50/p95/p99/max 0.007333/0.008375/0.013125/0.082583 ms; peak RSS 27,052 KiB. Each invocation has one import trial on shared host; within numerical targets locally, not reference-host PF12 qualification. Synthetic observations never enter the real ledger. |
| `python3 -m unittest discover -s tests/performance -p 'test_*.py'` | 10 tests pass: numeric failure/provenance, immutable duplicate run, invalid observation rollback, stale/missing/tampered artifact, parametric density bound, strict inequality/signed regression, catalog refresh without false coverage, SQL parameterization/index use, strict JSON parsing, multi-bundle rollback. |
| `python3 tools/perf.py check`; `build`; `status`; `show DOC-OPEN` | Catalog validates and builds. Current editor numeric coverage is **0/148, release unproven**. Kernel-only diagnostic open measurements were deliberately not mislabeled as usable-viewport timings. |
| `python3 tools/plan.py check`; `next`; `show T106` | 118 tickets, valid acyclic graph; T106 is the only next-ready ticket. Every non-release ticket is now a transitive T066 prerequisite. |
| Compare with `.artifacts/performance-planning/tickets-before.json` | All 105 prior statuses/report references preserved; all original acceptance/failure/dependency/step/evidence items retained. Added T106–T118 with concrete owners, checks and release edges. T029's existing aggregate now depends explicitly on its completed T102–T105 children and G6 depends on T029. |
| Bundled `skill-creator/scripts/quick_validate.py` for all three modified Xi skills | All valid. System Python lacked YAML/pip; `uv pip install --target .artifacts/performance-planning/python-deps PyYAML==6.0.2` supplied the validator dependency locally, and the actual bundled validator was rerun. No project dependency/lockfile changed. |
| `bun run check:types` | Pinned TypeScript check passed. The new TS diagnostic under bench was additionally included in an explicit temporary strict project check; no assertion that Bun execution alone type-checks it. |
| Local Markdown links, catalog ticket mapping/G6 ancestry, scope-preservation audit and `git diff --check` | Passed after fixes. Initial proposed edges exposed a cycle through packaging/final parity; T116 now depends on completed input/UI/session foundations. An initially incorrect skill path edit was caught by the link audit and corrected before finalization. |
| `sha256sum -c .artifacts/performance-planning/protected-before.sha256` | `agentpack.toml` and `pack.lock` unchanged. Personal Neovim config was neither modified nor executed. |

## Objective coverage audit

| Requirement / supplied-note topic | Concrete artifact and evidence |
|---|---|
| Initial requirements, not copying full Vim | Brief, architecture, Vim scope and spec 12; required families preserved; unrelated upstream application/scripting rows explicitly classified. |
| Text structure day-one decision, UTF-8/UTF-16 and native/WASM tradeoffs | Spec 12 representation decision criteria; spec 13 primary sources and T004 comparison limitations; T107/T108 public-path experiments. |
| CPU/runtime and memory budgets for everything | 55 operations / 148 bounds with owners/fixtures/units/statistics/classes; per-owner/aggregate envelopes and inherited helper budgets; full scan CPU/throughput added alongside first-result timings. |
| Stop object/string proliferation in core | H0/H1 rules, packed indexes/EOL/visible spans, bounded windows/checkpoints, allocation-rate versus retention accounting, safe scratch/pool lifetimes; normal feature/UI-control TypeScript retained. |
| Undo, registers, marks, selections, long Insert/repeat | T110 full retention and shared chunks, million-character group, 100 MiB delete/undo, sorted mapping, sparse anchors and pressure policy. |
| Rendering, long lines, damage, keyboard UX | T109/T111, 10 MiB ASCII/tab/combining/wide/emoji cold/warm workloads, packed viewport/frame leases, native OpenTUI diff, idle/output/backpressure gates. |
| Search, highlight, LSP, threads and incremental processing | T112/T117/T118 scheduling/byte credits/replicas; owned resumable regex rather than fixed overlaps; exact cancellation/stale semantics. |
| Save/crash recovery, startup and services | T113 streaming/deltas/durability age, T114 service accounting, T116 thin CLI/startup, typed ownership ports. |
| SQLite budgets/results ledger must be fast | Confirmed scope, working developer tool, immutable provenance and indexed schema, measured 100k-row batching improvement, test and benchmark sources retained. |
| Bench corpus: SQLite, 200k lines, 10 MiB line, giant delete/undo, search, hold-j, heap after edits | PF01–PF12 plus original validation corpus; pinned actual SQLite source size/hashes; complete production adapters and certification explicitly assigned T106/T115/T062. |
| Refine scope, architecture, skills and actionable plan | Specs 00–13 aligned, three skills updated, 13 small owner tickets, complete G6 ancestry and original requirements preserved. |
| Do not mistake planning for runtime success | No product ticket marked done; no zero-observation or kernel-only pass; report/ledger/README all state remaining qualification truthfully. |

## Limitations and next action

This completes the requested **plan refinement**, not the future editor refactors. Current code still has the identified EOL density, full-line reads, history/replica/layout and scheduling risks. New design targets, actual allocation/GC distributions, dedicated runner evidence, supported terminal output and complete initial behavior qualification remain implementation gates.

Next ready work is **T106**, trustworthy benchmark/provenance/coverage enforcement, followed by packed EOL remediation T107 and the other dependency-ready owner refactors. The ledger's current numeric importer is useful infrastructure; source/corpus compatibility, baseline resolution, noise/confidence, metric coverage and production adapters are explicitly unfinished T106/T115 work. Local synthetic ledger speed is not a release claim.
