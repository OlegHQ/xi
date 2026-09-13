# Validation gates and performance

All gates below are future acceptance requirements. The planning repository has not executed editor tests or benchmarks. Test success must refer to a specific revision, environment and fixture corpus. A gate is failed if any mandatory prerequisite is missing, and unproven if it has not been run; neither state can be reported as passed.

## Gate definitions

| Gate | Required evidence | Blocks |
|---|---|---|
| G0 feasibility | Pinned stack/platform probe; OpenTUI visible-row/input prototype; buffer and regex experiments; functioning Neovim oracle | Production architecture lock and feature implementation |
| G1 core | Strict typecheck and import graph; document/position/transaction/history invariants; deterministic input and layout fixtures | Broad engine/UI feature work |
| G2 engine preview | Seed family fixtures and generated traces; documented compatibility inventory; native editor behavior without Neovim runtime | Daily-editor preview label; does not certify final parity |
| G3 workbench | Files/pickers/directory/search/replace/restore journeys through PTY; failure and focus checks; visual review | Workbench completion |
| G4 language | Adversarial fake server, real TS/Go/Rust server tests, capability matrix, stale-edit protection, diagnostics and actions | LSP completion |
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

### Future command contract

These commands are **required scripts to implement in T001 and their owning tickets**, not commands currently available. A missing suite must fail clearly, never pass because it discovered zero tests.

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
| E12 | Legacy/enhanced keys, bracketed paste, mouse optional | One event delivery, no pasted commands, no Ctrl-C accidental exit |
| E13 | Crash after edit/save/directory-step then restart | Bounded recovery loss, external disk changes preserved, journal actionable |
| E14 | Slow LSP + huge search + Git refresh while typing | Functional correctness and loaded interaction latency budget |
| E15 | Read-only/permission errors, missing rg/Git/server | Clear degraded state; plain editing works |
| E16 | Theme preview/cancel, ASCII/256-color, narrow popups | Token consistency, cursor visible, no layout corruption |
| E17 | Task launch, output flood, cancel and quit | Bounded output, accurate exit status, child processes reaped |
| E18 | Packaged CLI with Neovim absent and empty HOME-like test config | All core workflows work; no external editor engine dependency |

Fixtures include spaces, tabs/newlines in POSIX filenames, leading dashes, apostrophes, Unicode normalization variants, symlinks and loops, case-only renames, hidden/ignored files, multi-root duplicates, invalid UTF-8, CRLF/mixed EOL, no final newline, 1 MiB single line, empty file, binary file, nested Git repos, submodules/worktrees, permission errors and external modifications. Platform-specific cases must be tagged, not silently skipped on supported platforms.

## Performance contract

“Fast as native” means measured interaction overhead comparable to a clean pinned Neovim on the same machine and terminal, plus absolute latency and resource limits. It does not mean zero overhead or that Bun/TypeScript inherently guarantees native performance. Define the comparison workload, measure both implementations, and report gaps.

Initial reference host: choose and record a dedicated Linux machine (the planning host is aarch64, but not yet a benchmark-certified runner), CPU model/cores, RAM, kernel, power mode, storage, locale, terminal/version, font, refresh rate, tmux/version, Bun/OpenTUI/native artifact/compiler versions and repository revisions. Use the same machine for before/after measurements. Add macOS qualification before claiming support; Windows remains a separately gated target.

### Proposed release thresholds

| Metric | Target on reference host | Measurement boundary |
|---|---|---|
| Keystroke engine step, small source file | p95 ≤ 1 ms; p99 ≤ 2 ms | Decoded event to committed state; ordinary local edit/motion |
| Input to terminal-output completion | p95 ≤ 8 ms; p99 ≤ 16 ms | PTY injection/arrival to output containing correct cursor/text update |
| Overhead against clean Neovim | p95 ≤ Neovim p95 + 3 ms | Same source fixture/keys/viewport/output boundary |
| Loaded typing (LSP/search/Git active) | p95 ≤ 12 ms; p99 ≤ 25 ms | Same terminal-output boundary under E14 |
| App-attributable main-loop stall | No > 50 ms stall in interactive traces | Exclude documented explicit large operations, report all outliers |
| Warm startup to editable first file | p95 ≤ 150 ms | Process spawn to correct visible editable file; no LSP ready wait |
| Process-cold startup, filesystem warm | p95 ≤ 300 ms | New process/module state; distinguish from cold OS page cache |
| Open 1 MiB source | p95 ≤ 100 ms | Command dispatch to usable viewport |
| Open 10 MiB normal-line file | p95 ≤ 250 ms | Usable viewport; lazy parse deferred explicitly |
| 100 MiB large-file mode | First viewport ≤ 1 s; later typing p95 ≤ 16 ms | Limits apply, no full-file parse/index on foreground |
| File picker warm / 100k paths | First useful result ≤ 30 ms; p95 update ≤ 50 ms | Query dispatch, separate index warm/cold |
| Content search / 100k files, 1 GiB corpus | Warm first match p95 ≤ 100 ms; cancel reflected ≤ 50 ms | Include debounce; no-match completion measured separately |
| Render at 120x40 / 240x70 | p95 ≤ 4 ms / 8 ms for ordinary frame | Layout/style/raster/output enqueue; report terminal separately |
| Idle CPU | < 1% of one core over 60 s | Xi process + workers, inactive services separately reported |
| Warm baseline RSS | ≤ 150 MiB editor + workers for ten small buffers | Report external LSP/Git/rg processes separately and total |
| Memory retention | < 10 MiB retained growth after 1,000 open/close/picker cycles | Stabilized GC windows and native memory included |

These are demanding design budgets, not achieved results. T007 must determine feasibility early. If a budget fails, capture attribution and fix the bottleneck or leave the gate failed. Revising a target requires an explicit documented product decision with original results retained; an implementation agent cannot silently relax it.

The PTY output boundary is not physical key-to-photon latency: OS input queues, emulator rendering and display scanout contribute additional delay. Also measure real terminal visible-frame response via instrumented emulator capture or camera/high-speed measurement for final UX qualification. Report those measurements separately; do not relabel process timestamps as photons.

### Benchmark method

Use deterministic generated corpora with manifest hashes: small 2k-line code; 1/10/100 MiB normal lines; 1 MiB single line; 100k mixed-length file paths; 1 GiB search tree with known match positions; 10k diagnostics; 100k edits with undo branches; large diffs and repeated completion lists. Keep generated corpora out of Git, commit generators/manifests/seeds.

Run a warmup, then at least 30 independent startup/open trials and at least 10,000 input samples per interaction workload across multiple sessions. Report p50/p95/p99/max and sample counts, not averages alone. Preserve cold/warm definitions, order-randomize baseline/candidate runs, and include confidence intervals for regressions. A >10% p95 regression outside measured noise fails even if the absolute threshold passes; retain a documented exception only for an intentional budgeted feature tradeoff.

Trace segments: decode, mapping/parser, motion/regex, transaction/anchor update, invalidation, layout, styling, OpenTUI native rendering, output write/backpressure, worker integration and GC. Use Bun-supported CPU profiles, OS tools (`perf` where available), allocation/heap snapshots and process/native RSS. Pin profiler commands by version in T062; don't invent flags. Benchmark full system subprocess overhead, not just the TypeScript function call. Leak tests include event listeners, file watchers, workers, PTYs and children.

CI uses deterministic correctness on general runners; stable performance gates require a dedicated labeled runner or a recorded reproducible local run. Shared-runner noise is reported as inconclusive, not a free pass. Scheduled broad fuzz/performance runs augment focused PR checks. Native comparison should cover editing and rendering; VS Code screenshots are UX references, not latency baselines.

## Data integrity and release

Fault injection covers write failure before/after temp write, rename, journal flush, directory step, index lock, subprocess crash and cancellation. Check both document state and actual filesystem/index bytes. Recovery must preserve original and pending data, state what succeeded and offer retry/restore. Tests run in disposable temp roots and never in personal projects.

Distribution must prove the OpenTUI native assets load from the packaged installation on every advertised OS/architecture. `bun build --compile` is a candidate, not a packaging promise until exercised. License notices cover dependencies, grammars, fonts/icons and any reused test material. Core startup does not require rg/Git/LSP; feature-specific health explains missing optional tools. Neovim is explicitly test-only. Verify clean installation, config migration, `--help`, `--version`, file:line navigation, session/recovery, interrupt/resize and shutdown.
