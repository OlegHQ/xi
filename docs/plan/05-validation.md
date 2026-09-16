# Validation gates and performance

The gates below are acceptance requirements. The current worktree has implementation and evidence; consult tickets/reports for actual outcomes rather than the original planning-only baseline. The new [performance contract](12-performance.md) and [budget catalog](performance-budgets.json) add unmeasured obligations; historical component passes do not certify them. Test success must refer to a specific revision, environment and fixture corpus. A gate is failed if any mandatory prerequisite is missing, and unproven if it has not been run; neither state can be reported as passed.

## Gate definitions

| Gate | Required evidence | Blocks |
|---|---|---|
| G0 feasibility | Pinned stack/platform probe; OpenTUI visible-row/key/pointer prototype; buffer including multi-edit scale and regex experiments; functioning Neovim oracle | Production architecture lock and feature implementation |
| G1 core | Strict typecheck/import graph; versioned selection sets and command descriptors; document/position/transaction/history invariants; deterministic input, layout and hit maps | Broad engine/UI feature work |
| G2 engine preview | Seed fixtures and generated traces; singleton and multi-cursor composition/register/repeat/macro/history checks; compatibility inventory; no Neovim runtime | Daily-editor preview label; does not certify final parity |
| G3 workbench | Files/pickers/directory/search/replace/restore plus selection/discovery/mouse/trail journeys through PTY; contributions/evolution; focus and visual review | Workbench completion |
| G4 language | Adversarial/real servers, capability matrix, stale text/selection protection, diagnostics/actions and multi-cursor completion/snippets | LSP completion |
| G5 tools/data integrity | Git index/worktree fixtures, file operations/recovery failures, tasks, mutation/error UX | Tooling completion |
| G6 release | G0–G5 evidence, complete in-scope parity inventory, performance thresholds, UX/accessibility/platform review, packaged no-Neovim smoke | Release/parity/performance claims |

Each gate report names the tickets it covers, exact commands and results, baseline revisions, fixture hashes, environment, evidence locations and remaining limitations. Existing reports become stale if a subsequent change invalidates their assumptions. A cross-owner change reruns affected contracts plus its feature tests; avoid rerunning everything repeatedly without a reason.

## Test layers

1. Pure unit/property tests: document edits against a simple reference string model; balanced-node aggregates; range and anchor transformations; line/EOL/byte/UTF-16/cell conversions; parser state and key normalization; undo graph invariants. Seed randomness and save failing seeds. Simple reference models are test-only and must not define Vim expectations circularly.
2. Differential engine tests: pinned Neovim state and UI oracles, complete command fixtures, generated traces, minimization and option matrices as specified in [Vim](02-vim.md). Inject known semantic bugs to prove detection.
3. Service contracts: fake filesystem/process/clock; real temporary filesystem/Git repos; scripted LSP peers with malformed, delayed, out-of-order and stale messages; real language servers on small pinned projects.
4. OpenTUI component/frame tests: virtual renderer, real key normalization where possible, cells/styles/cursor/focus snapshots and controlled resizes. OpenTUI documents a test renderer and input utilities; freeze actual exports at the pinned version. [OpenTUI testing](https://opentui.com/docs/core-concepts/testing/).
5. PTY end-to-end: launch the real CLI in a pseudoterminal, send real terminal byte sequences, parse emitted VT output into a screen grid, assert screen and resulting files. Do not drive only internal command functions or inspect private UI state. Test hooks may expose readiness/trace markers but never bypass production routing.
6. Visual review and performance: real terminal screenshots/casts plus CPU/memory/latency traces. Character snapshots cannot reveal bad color contrast, font width or terminal cursor restoration.

Use Bun test for TypeScript suites and explicit pinned TypeScript `tsc --noEmit` for typechecking. T001 chooses test/property/parser dependencies after compatibility checks. A maintained VT parser/headless terminal can serve the PTY harness; assess Unicode handling against the release terminal matrix. Do not invent a PTY library API. CI should use a genuine OS PTY and provide an alternate tmux/script-based local capture path where needed.

### Required command contract

These are required script contracts. Some scripts now exist; their names and successful discovery do not prove that every required test, baseline comparator or threshold is implemented. Inspect the current adapters and evidence. A missing suite must fail clearly, never pass because it discovered zero tests.

```text
bun run check             # typecheck + lint + import boundaries
bun run test:unit
bun run test:vim -- --profile strict --seed 41027
bun run test:services
bun run test:ui
bun run test:e2e
bun run bench -- --suite interaction --baseline <revision>
bun run verify:release
```

`verify:release` checks actual reports/manifests and runs required suites; it must not merely read manually checked boxes. Ordinary feature work runs relevant subsets; release validation runs the complete release contract. Lockfile installation is frozen in CI. Type suppression, ignored errors and expected failures require explicit reasons and cannot conceal in-scope gate failures.

Add required suite selectors under these scripts: `bun run test:vim -- --profile xi --suite multi-selection --seed 41027`, `bun run test:e2e -- --suite interaction`, `bun run test:unit -- --suite contributions`, and `bun run bench -- --suite selections --baseline <revision>`. Their current implementation must be checked against the owning evidence; selectors alone do not certify coverage. MC01–MC12 are specified in [selections](08-selections.md); EX01–EX05 in [extensibility](10-extensibility.md). MP01 is protocol/ordering, MP02 terminal lifecycle/capability fallback, MP03 coordinate hit testing, MP04 gesture/capture/focus. Each family expands into identified success, failure and cancellation fixtures; a selector discovering zero cases fails.

## PTY journey corpus

| ID | Journey | Observable assertions |
|---|---|---|
| E01 | Open file, insert Unicode, escape, `ciw`, dot, undo/redo, `:wq` | Exact bytes, cursor/mode at checkpoints, terminal restored |
| E02 | File picker preview/cancel/pin, switch split, return | Source view restored, no dirty preview discarded, same buffer text in two views |
| E03 | Tree expand/filter/reveal and watcher insertion | Stable selected path, no unsolicited focus/scroll |
| E04 | Directory rename/copy/delete draft → cancel → apply → restore | Exact filesystem diff, journal, no unintended deletion |
| E05 | Search rapid typing, cancel, late old output | Only latest generation displayed, typing remains responsive |
| E06 | Replace selected matches in dirty and closed files | Preview matches applied bytes, stale file blocked, partial failure explained |
| E07 | LSP definition/return, hover, outline, diagnostics/action | Correct URI/range, capability-aware state, focus returned |
| E08 | Completion/snippet/rename with concurrent edits | One acceptance, correct undo groups, stale result cannot overwrite typing |
| E09 | Git stage hunk, unstage, commit with failing hook | Actual index diff correct; draft preserved; no network operation |
| E10 | Merge resolve base/ours/theirs and external index change | Correct result, conflict state validated, stale stage refused |
| E11 | Resize 160x50 → 80x24 → 60x18 → restore | No text loss or orphan focus; unified diff; hidden layout restored |
| E12 | Legacy/enhanced keys, bracketed paste, required supported mouse protocols | One event delivery, no pasted commands, no Ctrl-C accidental exit; limitations recorded by terminal |
| E13 | Crash after edit/save/directory-step then restart | Bounded recovery loss, external disk changes preserved, journal actionable |
| E14 | Slow LSP + huge search + Git refresh while typing | Functional correctness and loaded interaction latency budget |
| E15 | Read-only/permission errors, missing rg/Git/server | Clear degraded state; plain editing works |
| E16 | Theme preview/cancel, ASCII/256-color, narrow popups | Token consistency, cursor visible, no layout corruption |
| E17 | Task launch, output flood, cancel and quit | Bounded output, accurate exit status, child processes reaped |
| E18 | Packaged CLI with Neovim absent and empty HOME-like test config | All core workflows work; no external editor engine dependency |
| E19 | Create/skip/filter multiple selections, edit, dot, macro, undo/redo, split and restore | Correct text, one batch per command, primary/count and independent sets survive; selection undo changes no text |
| E20 | Prefix hints, remap/reload, Ex completion/aliases and dirty `:q` | No input delay/focus theft; typed command executes; native abbreviations and write/quit distinctions preserved |
| E21 | Text/word/line/block/multi-cursor drag across wrapped Unicode, wheel and controls | Correct semantic ranges through real terminal reports; one target per event; no unexpected operator completion |
| E22 | Splitter/autoscroll capture, stale layout, focus loss, resize, suspend and quit | Capture stops; no stuck timers/buttons; text retained; terminal modes restored; keyboard fallback works |
| E23 | Motion trail on/off with Visual/search/diagnostics and multiple cursors | Identical semantic state/bytes; distinct reviewed paint in truecolor/256/no-color, EOL/Unicode/narrow views |
| E24 | Multi-completion/snippets/imports, move-only staleness and formatter edits | One coherent transaction, additional import once, generation guards, explicit incompatible-context action |
| E25 | Add/dispose/reload contribution, aliases and old session/config migration | Real production registration path, one handler invocation, no stale action/leak, original future-schema bytes preserved |

Fixtures include spaces, tabs/newlines in POSIX filenames, leading dashes, apostrophes, Unicode normalization variants, symlinks and loops, case-only renames, hidden/ignored files, multi-root duplicates, invalid UTF-8, CRLF/mixed EOL, no final newline, 1 MiB single line, empty file, binary file, nested Git repos, submodules/worktrees, permission errors and external modifications. Platform-specific cases must be tagged, not silently skipped on supported platforms.

## Performance contract

“Fast as native” means measured interaction overhead comparable to a clean pinned Neovim on the same machine and terminal, plus absolute latency and resource limits. It does not mean zero overhead or that Bun/TypeScript inherently guarantees native performance. Define the comparison workload, measure both implementations, and report gaps.

Initial reference host: choose and record a dedicated Linux machine (the planning host is aarch64, but not yet a benchmark-certified runner), CPU model/cores, RAM, kernel, power mode, storage, locale, terminal/version, font, refresh rate, tmux/version, Bun/OpenTUI/native artifact/compiler versions and repository revisions. Use the same machine for before/after measurements. Add macOS qualification before claiming support; Windows remains a separately gated target.

### Resource coverage and catalog

[Spec 12](12-performance.md) extends these thresholds with per-owner CPU, transient allocation, retained/peak memory, history/register/replica/queue and pressure limits; it preserves every original target below. [Spec 13](13-performance-research.md) records source-backed design tradeoffs and actual current-code defects. PF01–PF12 add 10 MiB single lines, newline-dense and mixed-EOL files, pinned SQLite source, long history groups, giant delete/undo, CPU isolation and resource-pressure workloads. `python3 tools/perf.py check/build/status` validates/indexes the development catalog and reports missing observations; it cannot certify runtime behavior. T106/T115 implement real comparison/coverage, and T062/G6 remain unproven until their entire contract passes.

### Mandatory release thresholds

[Spec 15](15-keystroke-latency.md) defines the binding keystroke action/load matrix, p50 and observed maxima, physical capture, open-loop scheduling and per-session evidence rules. The 2026-09-15 product decision tightens ordinary loaded typing to the same limits as idle typing; prior measurements remain historical, not passes for these requirements.

| Metric | Target on reference host | Measurement boundary |
|---|---|---|
| Keystroke engine step, small source file | p50 ≤ 0.5 ms; p95 ≤ 1 ms; p99 ≤ 2 ms; max ≤ 4 ms | Decoded event to committed state; ordinary local edit/motion |
| Input to terminal-output completion | p50 ≤ 4 ms; p95 ≤ 8 ms; p99 ≤ 16 ms; max ≤ 25 ms | PTY injection/arrival to output containing correct cursor/text update |
| Overhead against clean Neovim | p95 ≤ Neovim p95 + 3 ms | Same source fixture/keys/viewport/output boundary |
| Loaded typing (LSP/search/Git/syntax/tasks active) | p50 ≤ 4 ms; p95 ≤ 8 ms; p99 ≤ 16 ms; max ≤ 25 ms | Same terminal-output boundary under E14; individual and simultaneous loads |
| Physical key to correct visible pixels, idle and loaded | p50 ≤ 20 ms; p95 ≤ 35 ms; p99 ≤ 50 ms; max ≤ 75 ms | Calibrated hardware actuation to photons on qualified reference terminal/display |
| App-attributable main-loop stall | Ordinary interactive max ≤ 8 ms; global max ≤ 50 ms | Include GC and atomic publication; explicit batch slices retain their own bounds; report all outliers |
| Warm startup to editable first file | p95 ≤ 150 ms | Process spawn to correct visible editable file; no LSP ready wait |
| Process-cold startup, filesystem warm | p95 ≤ 300 ms | New process/module state; distinguish from cold OS page cache |
| Open 1 MiB source | p95 ≤ 100 ms | Command dispatch to usable viewport |
| Open 10 MiB normal-line file | p95 ≤ 250 ms | Usable viewport; lazy parse deferred explicitly |
| 100 MiB large-file mode | First viewport ≤ 1 s; later typing p50 ≤ 8 ms; p95 ≤ 16 ms; p99 ≤ 25 ms; max ≤ 50 ms | Limits apply, no full-file parse/index on foreground; INPUT-LARGE also covers giant lines |
| File picker warm / 100k paths | First useful result ≤ 30 ms; p95 update ≤ 50 ms | Query dispatch, separate index warm/cold |
| Content search / 100k files, 1 GiB corpus | Warm first match p95 ≤ 100 ms; cancel reflected ≤ 50 ms | Include debounce; no-match completion measured separately |
| Render at 120x40 / 240x70 | p95 ≤ 4 ms / 8 ms for ordinary frame | Layout/style/raster/output enqueue; report terminal separately |
| Idle CPU | < 1% of one core over 60 s | Xi process + workers, inactive services separately reported |
| Warm baseline RSS | ≤ 150 MiB editor + workers for ten small buffers | Report external LSP/Git/rg processes separately and total |
| Memory retention | < 10 MiB retained growth after 1,000 open/close/picker cycles | Stabilized GC windows and native memory included |

These are demanding design budgets, not achieved results. T007 must determine feasibility early. If a budget fails, capture attribution and fix the bottleneck or leave the gate failed. Revising a target requires an explicit documented product decision with original results retained; an implementation agent cannot silently relax it.

### Selection and interaction scale requirements

These additional budgets are mandatory release targets with the same reference-host/noise rules. One-cursor editing retains every original latency requirement with the selection-set path enabled. Neovim comparison applies to matching singleton behavior, not invented native multi-cursor support. Record 1/10/100/1,000/10,000 members, sorted/reversed creation, overlaps, Visual blocks, mixed Unicode, short and long lines, and two views of one document.

| Workload | Required target / measurement |
|---|---|
| 10 cursors, ordinary insert/motion | Input-to-output p95 ≤ 12 ms; p99 ≤ 25 ms |
| 100 cursors, ordinary insert/motion | Input-to-output p95 ≤ 16 ms; p99 ≤ 32 ms |
| 1,000 cursors, ordinary insert/motion | Input-to-output p95 ≤ 50 ms; p99 ≤ 100 ms |
| 10,000 cursors, explicit batch edit on 1 MiB normal-line fixture | Complete coherent output p95 ≤ 500 ms; p99 ≤ 1 s; cancellable preparation, no intermediate partial text |
| Selection all-match creation on 1 MiB fixture up to 10,000 matches | Complete set p95 ≤ 500 ms; progress and cancel reflected ≤ 50 ms; zero-match completion measured |
| Main-loop work during explicit large selection operations | Cooperative preparation slices ≤ 8 ms target; no app-attributable > 50 ms stall, including atomic publication |
| Pointer selection and splitter drag at 120x40 / 240x70 | Latest event-to-correct output p95 ≤ 16 ms / 25 ms; press/release never dropped; loaded typing still meets E14 |
| Prefix help | Default display at 250 ms ± 50 ms on controlled integration runner; completed command latency unchanged within measured noise; fake-clock boundary checks |
| Motion trail on/off | Original frame/typing/idle budgets pass in both modes; no permanent render loop or >10% unexplained p95 regression |
| Selection mapping | Sorted endpoint traversal bounded by selections + edits; instrument operation counts and adversarial growth to detect per-cursor full edit scans |

Selection and contribution state is included in original process RSS/retention budgets, not excluded as overhead. Exercise 1,000 selection-create/collapse, view-close and contribution-dispose cycles with histories populated. Bound selection undo history and release snapshots/ID maps when no live owner/history entry needs them. T004/T084 expose feasibility risks early, T089 qualifies composition/scale, and T062 verifies final loaded-system results. A maximum-count limit is a visible product policy, not permission to benchmark fewer cursors or silently truncate requested results.

The PTY output boundary is not physical key-to-photon latency: OS input queues, emulator rendering and display scanout contribute additional delay. Also measure real terminal visible-frame response via instrumented emulator capture or camera/high-speed measurement for final UX qualification. Report those measurements separately; do not relabel process timestamps as photons.

### Benchmark method

Use deterministic generated corpora with manifest hashes: small 2k-line code; 1/10/100 MiB normal lines; 1 MiB single line; 100k mixed-length file paths; 1 GiB search tree with known match positions; 10k diagnostics; 100k edits with undo branches; large diffs and repeated completion lists. Keep generated corpora out of Git, commit generators/manifests/seeds.

Run a warmup, then at least 30 independent startup/open trials and at least 10,000 input samples per interaction workload across multiple sessions. Report p50/p95/p99/max and sample counts, not averages alone. Preserve cold/warm definitions, order-randomize baseline/candidate runs, and include confidence intervals for regressions. A >10% p95 regression outside measured noise fails even if the absolute threshold passes; retain a documented exception only for an intentional budgeted feature tradeoff.

Trace segments: decode, mapping/parser, motion/regex, transaction/anchor update, invalidation, layout, styling, OpenTUI native rendering, output write/backpressure, worker integration and GC. Use Bun-supported CPU profiles, OS tools (`perf` where available), allocation/heap snapshots and process/native RSS. Pin profiler commands by version in T062; don't invent flags. Benchmark full system subprocess overhead, not just the TypeScript function call. Leak tests include event listeners, file watchers, workers, PTYs and children.

CI uses deterministic correctness on general runners; stable performance gates require a dedicated labeled runner or a recorded reproducible local run. Shared-runner noise is reported as inconclusive, not a free pass. Scheduled broad fuzz/performance runs augment focused PR checks. Native comparison should cover editing and rendering; VS Code screenshots are UX references, not latency baselines.

## Data integrity and release

Fault injection covers write failure before/after temp write, rename, journal flush, directory step, index lock, subprocess crash and cancellation. Check both document state and actual filesystem/index bytes. Recovery must preserve original and pending data, state what succeeded and offer retry/restore. Tests run in disposable temp roots and never in personal projects.

Distribution must prove the OpenTUI native assets load from the packaged installation on every advertised OS/architecture. `bun build --compile` is a candidate, not a packaging promise until exercised. License notices cover dependencies, grammars, fonts/icons and any reused test material. Core startup does not require rg/Git/LSP; feature-specific health explains missing optional tools. Neovim is explicitly test-only. Verify clean installation, config migration, `--help`, `--version`, file:line navigation, session/recovery, interrupt/resize and shutdown.
