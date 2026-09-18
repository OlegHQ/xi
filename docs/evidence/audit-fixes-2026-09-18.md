# Ticket evidence

- Ticket ID and title: audit-fixes-2026-09-18 — Second audit pass: ownership, keystroke/render performance, Vim parity, services data-loss fixes, static ownership rules
- Outcome: passed, with one environment-bound benchmark documented as unproven on this host (see Limitations)
- Implementation revision or tree hash: working tree on top of 24c6337 (committed as the next commit on `dev`)
- Environment and pinned dependency/oracle versions: Linux 6.8 arm64 (4 cores), Bun 1.3.13, TypeScript 7.0.2, OpenTUI 0.5.11, web-tree-sitter 0.25.10, Neovim 0.12.4 (`.artifacts/oracle/nvim-linux-arm64/bin/nvim --headless --clean`) as the parity oracle, Xvfb for xterm PTY fixtures
- Specification sections and acceptance items covered: 01-architecture (owner table, composition root, input/effects/rendering, transactions/history, dispose lifecycle), 02-vim (motions, operators, text objects, registers, insert, ex, patterns), 12/15 (keystroke path, render damage, bounded background work), 04-services (files, git, language, syntax, search, persistence)

## Observable result

Five read-only audits (ownership, keystroke/render performance, document/selections/layout core, Vim engine, services/platform/workbench) over commit 24c6337 produced 105 ranked findings; the full list is retained at `.artifacts/audit-2026-09-18/findings.md` (copied from the session scratchpad). Twenty-two Sonnet implementation agents with disjoint file allowlists fixed them in four phases, each fix carrying a regression test, followed by three oracle-reconciliation agents when new Vim semantics disagreed with pinned Neovim traces.

Headline fixes:

| Area | Fix | Test |
|---|---|---|
| Hang | Ctrl-Space / signature help in a file with no language server looped forever on a resolved promise | tests/workbench/language-completion-hang.test.ts |
| Data loss | Undo of a batch containing a >1 MiB deletion restored empty text (inverse-source indices not remapped through merge) | tests/document/audit-fixes.test.ts |
| Data loss | Second `:w` during an in-flight save returned the older save; `:wq` discarded edits typed during the write; format-on-save replaced the whole document without a version guard | tests/workbench/editing-save-coordinator.test.ts, session-close-async-save.test.ts |
| Data loss | `$&` in search-replace inserted a literal `&`; multi-root replace grouped by path only; no durable replace journal; corrupt recovery journal disabled checkpoints forever | tests/search/t044-replace.test.ts, tests/workbench/t116-search-controller.test.ts, tests/persistence/t-persistence-safety.test.ts |
| Vim | `}` at end of buffer wedged all later motions; final newline counted as a phantom line; `d0` deleted one char too many; exclusive-linewise rule 2; J/gJ; `2n` wrap; `\/`; empty-match suppression; very-magic `%`; count before register; visual `gu`; mark/`<Space>`/`<CR>` motions; `dvj`/`dVj`/`d<C-v>j`; `:g` sequential bodies and `\|` chains; `:s` missing delimiters, `&`/`r` flags, trailing count; `:t`, `:&`, `:,$d`; `a"`; `<C-w>`/`<C-u>`/`<Tab>` with smarttab; dot-repeat after arrow keys; register append; put on surrogates; `{count}iw`; `ß` case mapping; indent in cells; `<C-a>` on `abc123`; `;` after `t` | tests/vim/motions/c*.test.ts, tests/vim/multi/p2-*.test.ts, tests/vim/ranges/c4-*.test.ts, tests/vim/operators/d*.test.ts, tests/vim/text-objects/d*.test.ts, tests/vim/registers/d*.test.ts, tests/vim/insert-*.test.ts, tests/vim/t013-input-parser.test.ts, tests/vim/ex/*.test.ts, tests/vim/search/*.test.ts, tests/vim/pattern/e2-audit-fixes.test.ts, tests/workbench/vim-session-operator-*.test.ts |
| Render perf | ~20 full render passes per keystroke (surface-change fan-out through `intermediateRender`) reduced to exactly one | tests/ui/perf-render-count.test.ts |
| Layout perf | Horizontal scroll O(scroll offset) 85 ms → <2 ms; cursor column measure 29 ms → <0.1 ms; whole-viewport cell rebase per edit → unchanged rows reused by reference; stale middle-annotation render; display-key stride collision | tests/layout/perf-findings-b.test.ts, tests/layout/findings-b.test.ts |
| Engine perf | Per-call `Intl.Segmenter` construction (24 sites) hoisted and forbidden by lint; motion previews opt-in; rest-of-line grapheme materialization bounded; readLine measurement cached; insert-mode backward reads bounded on giant lines; sliced interactive search (adversarial regex 170 ms → ≤8 ms stall) | tests/vim/motions/perf-c8-c10-c11.test.ts, tests/vim/insert-perf-giant-line.test.ts, tests/vim/search/e2-7-perf.test.ts, tests/workbench/vim-session-search-slicing.test.ts, tests/lint/performance.test.ts |
| Services perf | Multi-cursor edit no longer forces a full tree-sitter reparse (440 ms → 62 ms on 1.1 MiB); dirty-buffer search yields every 2 ms; git decoration fan-out bounded and cancellable; BigInt undo fingerprint replaced (116 ms/MiB → <10 ms); directory-draft keystroke no longer O(rows) | tests/syntax/multi-cursor-incremental-perf.test.ts, tests/search/t-buffer-scan-latency.test.ts, tests/files/t-redecorate-safety.test.ts, tests/document/audit-fixes.test.ts, tests/files/directory-draft-keystroke-perf.test.ts |
| Ownership | Focus/overlay dispatch policy moved from the OpenTUI adapter into WorkbenchInputRouter (single `dispatchKey`); services no longer construct or import mutable documents (directory draft, persistence get caller-supplied ports); git decoration vocabulary, picker key policy, theme decoding moved out of apps/xi; service-locator getters replaced by a typed bundle; `createControllers` split under 150 lines; typed surface-change payloads; dispose() on every long-lived owner with a lifecycle test | tests/workbench/input-router-dispatch.test.ts, tests/architecture/h2-*.test.ts |
| Static rules | Import-graph check now enforces: services read-only document surface, apps/xi function length ≤150, no workbench setters in `renderSelf`, module-level segmenters; lint rule `[segmenter]` | tools/check-import-graph.ts sentinels, tests/architecture/h2-7-static-rules.test.ts, tests/lint/performance.test.ts |

## Executed validation

Results of the final sequential chain on the settled tree (no other suites or agents running):

| Command / fixture | Actual result | Evidence path / retained CI artifact |
|---|---|---|
| `bun run check` (toolchain, tsc, public-boundary incl. new static rules, lint) | see final-results below | `.artifacts/audit-2026-09-18/z-check.log` |
| `bun run test:unit` | see final-results below | `.artifacts/audit-2026-09-18/z-unit.log` |
| `bun run test:services` | see final-results below | `.artifacts/audit-2026-09-18/z-services.log` |
| `bun run test:ui` | see final-results below | `.artifacts/audit-2026-09-18/z-ui.log` |
| `bun run tests/vim/**/*.test.ts` (every script, 60+ files) | see final-results below | `.artifacts/audit-2026-09-18/final-results.txt` |
| `bun run test:vim -- --profile xi --suite multi-selection --seed 41027` | see final-results below | `.artifacts/audit-2026-09-18/z-oracle.log` |
| `bun run test:e2e -- --suite interaction` (PTY fixtures) | see final-results below | `.artifacts/audit-2026-09-18/z-e2e.log` |
| `bun run bench -- --suite interaction` | see final-results below | `.artifacts/audit-2026-09-18/z-bench.log` |

Final results (`.artifacts/audit-2026-09-18/final-results.txt`):

| Gate | Result |
|---|---|
| `bun run check` | pass (exit 0): toolchain, tsc, public boundary with the four new static rules, lint with the segmenter rule |
| `test:unit` / `test:services` / `test:ui` | pass / pass / pass |
| every `tests/vim/**/*.test.ts` via `bun run` | 0 failures |
| `test:vim --profile xi --suite multi-selection --seed 41027` | pass |
| `test:e2e --suite interaction` | one fixture, `t128-e22-splitter-xterm-pty.py`, failed in the chained run with `xterm: Xt error: Can't open display :88` (Xvfb display race) and passed on standalone rerun; the 28 fixtures after it in the selector were then run individually and all passed (`e2e-rest.txt`) |
| `bench --suite interaction` | T015 core costs and T089 selection scale executed (one-unit commit p95 0.53–0.68 ms, matching the previous commit's 0.65–0.69 ms); T039 picker 100k executes again (p95 118 ms, was broken); T043 search first-result p95 fails the 100 ms budget on this host, before and after, see Limitations |


## Performance and visual evidence

All perf regression tests use `performance.now()` over ≥30 samples and assert p95 (best of three rounds where GC pauses made a single round's p95 its second-worst sample). Numbers below are from the fixing agents' before/after runs on this host (4-core arm64, shared with other agents at the time, so "before" values are noisier than "after"):

| Workload | Before | After | Test threshold |
|---|---|---|---|
| Horizontal scroll to column 20 000 on a 200k-char line, 120×50 | ~85 ms/frame | p95 0.6–5 ms | 8 ms |
| Cursor column measure at column 38 000 | ~29 ms | p95 0.01–0.06 ms | 1 ms |
| Single-char edit, 50-row viewport: unchanged rows reused | 0/50 | 49/50 by identity, <0.5 ms | 1 ms |
| 2000 on-screen cursors per frame | p95 94–121 ms | p95 4.7–6.7 ms | 20 ms (multi-cursor contract) |
| Re-key a cacheable 65k-unit line, 340×50 | p95 4–12 ms | p95 2–3.7 ms | 6 ms |
| Render passes per keystroke / per 7-notification burst | ~20 | 1 / 1 | exactly 1 |
| h/l/j/k on a 10k-char non-ASCII line | O(rest of line) | p95 0.01–0.04 ms | 0.2 ms |
| Insert BS/Enter/Tab/C-w/C-u/Esc on a 1 MiB line | O(line) | p95 ≤0.57 ms | 1 ms |
| Adversarial regex `\v(x)@<=(a+)+b` on the keystroke path | 95–225 ms stall | slice p95 3 ms, max 4.6 ms; session stall ≤8 ms | 8 ms |
| 50-cursor edit, 1.1 MiB file, tree-sitter | 440–570 ms full reparse | 62–76 ms incremental | 5× ratio |
| Undo fingerprint, 1 MiB | 116 ms | <10 ms | 10 ms |
| Directory draft keystroke, 10k rows | 4–6 ms | p95 0.3–0.5 ms | 1 ms |
| Dirty-buffer search, 8 MiB buffer | one synchronous split | max event-loop gap <8 ms | 8 ms |
| Parser continuation lists per pending key | copied | p95 0.012 ms, identity-stable | 1 ms |

Not measured here: physical key-to-visible response (calibrated gate) and paired Neovim startup/open comparisons; those remain owned by their existing tickets (T106/T115) and are not claimed by this evidence.

### Resource provenance

Budget IDs: ENGINE-STEP (p95 ≤1 ms), INPUT-OUTPUT (p95 ≤8 ms), STALL (≤8 ms). Execution classes per `.oxlintrc.json` defaults. Workload parameters are stated inline in each test file. CPU/wall split, retained bytes and worker bytes were not measured for these unit-level tests; the interaction bench retains its own ledger output.

## Failure cases and recovery

- Search: a coalesced intermediate publish could land after the final model, flipping `ready` back to `loading` and blocking replace (`tests/search/publish-order.test.ts`, found by `tests/e2e/t045-e06-replace-dirty-closed-pty.py`); the first publish of a run is now synchronous and pending timers are cleared before the final publish (`tests/search/t-first-publish-immediate.test.ts`).
- LSP: `#readyAt` never cleared → 100 ms restart storm after 30 s of health (`tests/lsp/lifecycle-healthy-reset.test.ts`); failed `didChange` restores pending and schedules resync; a throwing notification handler no longer tears down the transport.
- Persistence: dispose cancels in-flight checkpoints; corrupt journal is treated as empty and reported once; stat-only identity re-hashes within mtime granularity.
- Git/tasks: dispose cancels the running `git status`; task cancel does not overwrite an already-exited state.
- Oracle reconciliation: `w` onto a trailing empty line (fixture text lost its final newline in the test harness), `;` after `t` when the adjacent char is not a match, `dw` from column 0 (word-motion special case precedes exclusive-linewise rule 2), `<Tab>` at line start (smarttab). Two trace files were regenerated where the only diff was the sandbox clipboard registers (`*`/`+`), verified by a key-order-independent JSON diff.

## Limitations and next action

- `bench/t043-search.bench.ts` first-result p95 (budget 100 ms) fails on this host both before and after this work: `python3 time.sleep(0.04)` itself measures p50 53 ms / p95 100 ms here, so the 40 ms debounce timer alone overshoots the budget through OS wake latency, while the Xi-side path (rg spawn to first publish) measures ≈5 ms. The budget was not changed. Gate status: unproven on this host; rerun on a host whose 40 ms timer fires within ~2 ms.
- `bench/t039-picker.bench.ts` was already broken at 24c6337 (called a removed synchronous `query`); switched to `queryAsync` so the interaction bench executes.
- `DirectoryDraft` still invokes `applyBatch`/`undo`/`redo` through a caller-injected port owned by the composition root; the static rule forbids the service from importing document constructors, but the edit path does not yet go through the workbench edit coordinator. Follow-up: route draft edits as `EditProposal`s through `WorkbenchSession.applyDocumentEdits`.
- Verify-suite `vim` id has no manifest (pre-existing); the Vim gate is the oracle validator plus per-file scripts.
