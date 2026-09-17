# Performance research and implementation audit

Reviewed 2026-09-15 against the worktree based on `555ed0ce3c2475a10844824468e6fddbb6e49755`. Bun 1.3.13, strict TypeScript 7.0.2, OpenTUI 0.5.11, Linux aarch64. This is research and planning evidence, not release qualification. The worktree contains product code and historical evidence; the old description of a planning-only repository is no longer a description of current state.

The two supplied attachments were read in full. The user subsequently clarified that the objective is **the right engine for Xi's initial requirements**, not copying all of Vim, and confirmed SQLite means a **budgets/results ledger**. [12-performance](12-performance.md) makes those distinctions normative. No personal Neovim configuration was executed or modified.

## Findings that change the plan

1. The public document path is a materially different workload from the storage-only spike. Newline metadata and normalization can dominate a small file. Fix data density before generic TypeScript micro-optimization.
2. Bounded UTF-16 chunks are not inherently a bad choice. Keep public units stable and compare actual lifetime/copy/coordinate costs before choosing UTF-8 leaves. The current piece-tree rejection was a comparison of two particular prototypes, not a result about all piece trees.
3. The real hot path includes semantic reads, metadata, history, selection mapping, layout and consumers. A fast tree edit cannot compensate for materializing a whole long line on Insert or duplicating a full snapshot in services.
4. Object-free public APIs conflict with the current immutable snapshot/history contract. Enforce zero intentional temporary allocation in inner loops and measured bounded command allocation, with safe lifetimes. Never reuse a published change object.
5. Background work needs CPU and byte admission, actual task yielding/worker isolation and lifecycle accounting. Async/microtask syntax is insufficient.
6. Keep OpenTUI's native diff and focus Xi optimization on packed visible geometry, bounded long-line layout, invalidation and queue pressure. Building another terminal renderer would duplicate ownership.
7. Performance evidence needs catalogued boundaries and a baseline comparator. The existing benchmark runner discovers scripts but does not compare a baseline, enforce every threshold, or certify release coverage.

## Checking the attachments against primary sources

| Attachment claim | Evidence and conclusion for Xi |
|---|---|
| TypeScript cannot match Vim | No universal language-level conclusion follows. Vim uses packed line blocks and file-backed memory; its design supports workloads Xi has not promised. Match the required interactions and memory envelope on identical fixtures. Do not silently add a multi-gigabyte pager project. |
| V8 string limits and ConsStrings determine the design | Xi runs JavaScriptCore. WebKit has both 8-bit and 16-bit string representations and shared substring storage. Exact limits/retention depend on the runtime build; V8 constants and flags are not Xi specifications. Bounded leaves and peak-memory measurements remain necessary. |
| Prefer a piece tree; undo is just swapping its root | Root-swap undo requires persistence/versioning; a mutable piece tree does not automatically supply it. Xi must retain session selections, EOL metadata, anchors, repeat and saved identity too. Compare the complete history path. |
| UTF-8 typed arrays always save memory | They provide explicit density but impose decoding/checkpoint/scan costs, backing-buffer retention and transfer ownership hazards. ASCII JSC strings may already use 8-bit storage. Use measured byte/chunk representation, preserve branded public coordinates. |
| One object per line is a memory trap | Supported by the VS Code experience and the local density reproduction. Xi currently does it indirectly through EOL nodes. Dense typed index arrays can also be expensive for all-newline data; test compressed/bitset representations. |
| Hot paths must allocate zero objects | Useful for inner iterations; impossible as a blanket promise for retained immutable history/persistent roots. Bounded allocations with inclusive heap/native evidence are the acceptance mechanism. Pools cannot recycle data still reachable by history. |
| Put everything heavy in workers | Worker startup, replicas, queues and synchronization can dominate. Keep authoritative text next to input. Isolate or slice work according to measured cost and give every replica/transfer a byte budget. |
| Regex chunks with overlap are enough | Only for patterns with a proven finite context bound. Xi's owned dialect includes unbounded multiline/backreference/lookaround behavior; fixed overlap can miss or invent matches. Require resumable state and cancellation without narrowing semantics. |
| Emit terminal diffs and scrolling escapes | OpenTUI already owns native diff/output. Xi should supply bounded damaged viewport data, not implement competing ANSI emission. Terminal scroll optimizations require pinned API support and visual/PTY proof. |
| WASM/native is the escape hatch | A coarse pure kernel may help after profiling, but frequent JS/native crossings and copies may erase the gain. Measure the complete command and lifetime; keep owned semantics and strict TypeScript unless a documented decision warrants a kernel. |
| RSS ≤2.5×file +20 MB is a universal bound | That ignores runtime, native renderer, history, multiple buffers and workers. Use separate document-density targets and a simultaneous process envelope; retain the original 150 MiB ten-buffer target. |

### Text storage and runtime

The VS Code team's 2018 report describes about 600 MB used for a 35 MB / 13.7-million-line file in its former line-array model. Its selected piece tree reduced per-line overhead, used typed line indexes and kept JavaScript after testing native-boundary costs. This supports measuring representation plus access patterns, not a prohibition on either strings or native code. [VS Code report](https://code.visualstudio.com/blogs/2018/03/23/text-buffer-reimplementation).

The pinned VS Code 1.104.0 implementation chooses `Uint16Array` or `Uint32Array` for line starts and includes an append-to-existing-node path. Xi's T004 prototype did not establish equivalent append coalescing. Comparing that prototype's 100,002 descriptors with a coalescing rope does not show that production piece trees inherently fragment once per character. T108 must compare equivalent editing/coalescing/retention workloads, without importing VS Code's engine. [Pinned piece-tree source](https://raw.githubusercontent.com/microsoft/vscode/1.104.0/src/vs/editor/common/model/pieceTreeTextBuffer/pieceTreeBase.ts).

Vim 9.1.0000 stores pointer blocks and packed line data blocks with offsets. Oversized lines can span pages. Its memory-file layer manages cached blocks backed by a file. This explains why a file-backed paging editor and a resident JavaScript editor have different memory behavior; it does not provide Xi with paging automatically or dictate Xi's multi-selection/history architecture. [memline.c](https://raw.githubusercontent.com/vim/vim/v9.1.0000/src/memline.c), [memfile.c](https://raw.githubusercontent.com/vim/vim/v9.1.0000/src/memfile.c).

WebKit's inspected `StringImpl` supports 8-bit/16-bit storage, substring-backed sharing and an implementation length ceiling. This is upstream research at `webkitgtk-2.48.0`, **not a claim that the installed Bun includes precisely that revision**. Avoid deriving an exact Bun maximum string size from it. Source-of-truth bytes, JSC string wrappers and their backing buffers must all appear in memory measurements. [Pinned StringImpl.h](https://raw.githubusercontent.com/WebKit/WebKit/webkitgtk-2.48.0/Source/WTF/wtf/text/StringImpl.h).

Ropey's chunk-oriented UTF-8 design illustrates that byte-packed text can expose character/line indexes and efficient chunk access. It is a comparison candidate and API inspiration, not an imported dependency or proof that Rust/WASM wins across Xi's JS boundary. [Ropey documentation](https://docs.rs/ropey/latest/ropey/).

### Profiling, workers and parsing

Bun documents JavaScript and native memory separately, explicit GC diagnostics, CPU profiles and heap tools. The installed `bun --help` confirms the CPU/heap flags named in spec 12. Forced-GC retained snapshots and normal GC-inclusive latency are different measurements. [Bun benchmarking](https://bun.com/docs/project/benchmarking).

Current `bun:jsc` documentation says `heapSize` and `heapCapacity` already include `extraMemorySize`; summing them again double-counts external string/ArrayBuffer memory. Its object counts describe live/recently collected objects, not total allocation over an operation. T106 must verify the pinned runtime's exports/accounting and add allocation profiling rather than treating a GC delta as bytes allocated. [HeapStats reference](https://bun.com/reference/bun/jsc/HeapStats).

Bun workers are separate JavaScript instances sharing process resources; current documentation marks termination behavior experimental and describes structured cloning and specialized messaging paths. That supports explicit shutdown/resync tests. Current documentation advertises Bun 1.4.2, while Xi pins 1.3.13: messaging fast-path performance is not assumed to apply unchanged. Measure actual clone/transfer and scheduling on the pinned binary. [Workers documentation](https://bun.com/docs/runtime/workers).

Tree-sitter supports custom read callbacks and incremental tree edits; a flat whole-document string is not inherent to incremental parsing. The specific `web-tree-sitter` 0.25.10 callback encoding and tree deletion/cancellation behavior must be verified locally. Xi needs versioned chunk replicas, explicit tree lifetime and native/WASM accounting. [Tree-sitter parsing](https://tree-sitter.github.io/tree-sitter/using-parsers/2-basic-parsing.html).

### SQLite decision

Bun's SQLite API is synchronous. Putting SQL queries on the input isolate would add a new blocking path; the confirmed development-ledger use avoids it entirely. Python's stdlib is sufficient for this repository's existing planning toolchain; no editor dependency, runtime database or new background daemon is needed. [Bun SQLite](https://bun.com/docs/runtime/sqlite).

SQLite page-cache settings are suggested cache limits, not a hard total RSS budget. mmap adds mapped memory; temporary data and statement resources need their own accounting. SQLite supports allocator accounting/limits at its C API, but those controls do not cap a Python/Bun process or replace measurement. The ledger uses bounded transactions, indexed queries, a small cache and mmap disabled. [PRAGMA reference](https://sqlite.org/pragma.html), [SQLite allocation](https://sqlite.org/malloc.html).

WAL permits concurrent readers and a writer but checkpoints and long readers introduce additional lifetime/size considerations. A short-lived local ledger writer does not need WAL by default. The derived database can be rebuilt from JSON; runtime save durability is a separate document/persistence contract. [SQLite WAL](https://sqlite.org/wal.html).

## Current-code audit and remediation map

These are inspected code paths, not claims that every feature is connected to the CLI. Follow the owning ticket to audit callers and production integration.

| Finding | Current path / boundary | Required work |
|---|---|---|
| Historical per-newline immutable treap, plus normalization arrays/segments | T107 replaces the EOL node/normalization path with packed persistent blocks; `packages/document/src/rope.ts` still owns the unpacked LF index | T108 packed rope indexes; T113 streaming ingestion |
| LF index `number[]`, scalar metric object per iteration, persistent node/chunk metadata | `packages/document/src/rope.ts` `lineBreakOffsets/scalarWidthsAt/makeChunk` | T108 packed density/representation evidence; benchmark private and full public layers |
| Fresh public snapshot wrapper, per-snapshot unbounded Map | `text-fidelity.ts` `snapshot`; `coordinates.ts` `lineBaseCache` | T109 stable version handles, byte-capped caches, old-snapshot correctness |
| Full logical-line slice for Insert; rich whole-line cell maps on general motion path | `packages/vim/insert/index.ts` `readLineWindow`; `motions/index.ts` `readLine/measureDisplayCells` | T109 range/window traversal and cold Unicode/long-line matrix |
| Text-unit/entry-count history policy misses step/vector/root costs | `packages/document/src/undo.ts` `UNDO_HISTORY_POLICY`; Insert repeat and registers | T110 full retained accounting, long-group coalescing and giant delete/undo |
| Object cells, per-cell target records and string-keyed display positions | `packages/layout/src/index.ts` materialization/projected frames | T111 packed visible spans, generation-safe leases, native renderer stays UI-owned |
| Syntax pump defaults to `queueMicrotask`, full/incremental helpers split full request text | `packages/services/syntax/index.ts` scheduler and parse functions | T112 real yielding/worker isolation, measured replicas and quotas |
| Full text strings in language sync contract/helper | `packages/services/language/sync.ts` `LanguageSyncDocument/readSnapshotText` | T117 bounded delta/full-sync policy and streaming serialization |
| Recovery checkpoint materializes document and EOL array, then retains checkpoint history | `packages/services/persistence/index.ts` `checkpoint` | T113 incremental journals, streaming snapshots and bounded dirty age |
| CLI owns substantial session/Vim command orchestration | `apps/xi/src/main.ts` launch/command handlers | T116 move state/coordinator to workbench/Vim owners, retain thin composition CLI and genuine PTY tests |
| Baseline argument is only logged; aggregate scripts are not threshold/coverage proof | `tools/verify-suite.ts`, `package.json` `verify:release` | T106 comparator + T115 exact production/reference-host coverage; preserve unproven status |
| Owner-local caps lack a simultaneous memory/CPU envelope | Scattered service/cache/history limits | T114 aggregate accounting/admission; keep features and unsaved data correct under pressure |

The architecture's typed ports, document-only mutations, branded positions and owned selection composition remain appropriate. The missing distinction is between immutable public values and private reusable storage, and between logically asynchronous work and CPU isolation. Those distinctions are now explicit in spec 12 and the skills. OpenTUI remains exclusively the UI adapter; workbench owns scheduling policy, platform owns worker/process/IO mechanisms, each service owns its read replica/cache. Document snapshots are read capabilities, not service permission to mutate buffers.

## Follow-up audit, 2026-09-15

The original table is a historical inspection. The lint remediation now uses a
timer between syntax requests, bounded quote/paragraph reads and geometric
forward grapheme windows; it does not establish the complete T109/T112 budgets.
Inferred string rebuilding (including `joinLines`), backward/full-line fallbacks,
single-parse CPU duration and full replica costs still require owner work.
The new adapter catalog declares obligations, not executed production coverage.
Broader oracle recapture also exposed host `+`/`*` register contamination; the
failure must be repaired in the harness, not accepted by omitting register state.

T107's compact EOL slice is now implemented in the shared worktree: uniform
blocks store one code, mixed blocks store two-bit codes, and normalization uses
a packed builder. The 1 MiB dense public diagnostic fell from the historical
roughly 1.5 s / 248 MiB RSS growth to about 0.26 s / 56 MiB RSS growth on the
same shared host. The 10 MiB public result remains dominated by the rope's
unpacked line-break index; this is a diagnostic observation and keeps T107 and
T108's release gates unproven until controlled production adapters exist.

[Spec 14](14-remediation-handoff.md) binds these findings to concrete acceptance
checks. T120 owns lint hardening; T121 owns hermetic oracle initialization and
explained golden repair. T108/T109/T111/T112/T116 retain production work and
T106/T115 retain measurement and qualification. No reference budget is certified
by this follow-up.

## Follow-up audit and remediation, 2026-09-17

A fresh ownership and hot-path audit of the worktree (not a release qualification)
found defects the 2026-09-15 table did not list. They were fixed in the shared
worktree the same day; each fix carries a unit or PTY test named below. Two rows
of the original table are now stale: `TextFileDocument.snapshot()` is cached until
the next commit, and the rope's line-break index is already packed.

| Finding | Owner / path | Fix and evidence |
|---|---|---|
| Language server killed 5 s after spawn: the platform process port armed an unconditional SIGTERM timer and the session used a 5 000 ms default; this was the unexplained `ready → failed` loop in T127 | `platform/src/process.ts`, `services/language/lifecycle.ts` | `timeoutMilliseconds` is optional and long-lived servers pass none; timeout/dispose escalate to SIGKILL. `tests/platform/t-process-lifetime.test.ts`, `tests/services/t-lifecycle-process-spec.test.ts` |
| Unnamed buffer's display label `[No Name]` used as a filesystem path by checkpoint and save, writing `[No Name]` and `[No Name].xi-recovery.json` into the cwd | `workbench/session`, `apps/xi` | `path` is `undefined` for unnamed buffers; save reports E32; label derived at the UI edge. `tests/e2e/t038-session.test.ts` |
| Production render never passed a viewport anchor, so the editor pinned line 0 and never scrolled; wheel wrote `scrollTop` that nothing read | `ui/src/workbench.ts`, `layout`, `workbench/src/read-model.ts` | `resolveScrollAnchor` follows the primary cursor from the read model's `scrollTop`/`scrollLeft`; anchor changes flow back through `setViewScroll`. `tests/ui/t111-render-scheduling.test.ts`, `tests/workbench/t123-scroll-read-model.test.ts` |
| Permanent 30 fps render loop while idle (`renderer.start()`), every tick re-reading the view and re-projecting | `ui/src/terminal.ts`, `apps/xi` | On-demand frames only; every service/model subscription in the composition root requests a coalesced frame. Idle renders zero frames over 200 ms in `t111-render-scheduling` |
| Materialized-row cache keyed by absolute offsets: one typed character re-materialized and repainted every row below it; per-frame `project()` p50 ≈ 7 ms at 200×50 | `layout/src/index.ts`, `ui/src/workbench.ts` | Content-relative row templates rebased per frame, no per-frame deep freeze, single position-index build, display index only for visual-block. `T014-LAYOUT-PRODUCTION-SHAPE-TYPING-01`: p50 7.2 → ≈0.9 ms, p95 14.0 → 2.4–3.4 ms; paint ranges compare `ScreenRow.contentKey`, ≤2 rows repaint per keystroke (`tests/ui/t123-paint-contentkey.test.ts`). Published rows/cells are no longer deep-frozen; hit-test targets are frozen on return. Remaining p95 is the O(visible cells) rebase allocation; a typed-array cell representation is the next step |
| Vim-origin commit mapped selections and replaced coordinator state twice per key; `views()` rebuilt every snapshot | `workbench/session`, `workbench/editing/atomic-command.ts` | Single-view Vim commits skip external mapping; identical state short-circuits. `tests/workbench/keystroke-fanout.test.ts` |
| Replace-mode session was quadratic (`replaceStack` spread and full re-validation per key) | `vim/insert` | In-place append/pop, per-increment validation. `tests/vim/replace-session-scaling.test.ts` (20 000 keys ≈ linear) |
| Watchers had no `'error'` listener (process crash on inotify limits); `overflow` never emitted; tasks ran with a scrubbed environment; task output split UTF-8 across chunks | `platform/src/filesystem.ts`, `services/tasks`, `services/config` | Error → close + `overflow`; tasks inherit the process environment with explicit keys overriding; streaming decoder. `tests/files/filesystem-watch-and-enumerate.test.ts`, `tests/tasks/t060-tasks.test.ts` |
| Cancelled LSP requests counted against the pending limit forever and the limit failed the whole transport; protocol oddities consumed restart retries; `$/progress` tokens never freed; push diagnostics uncapped; error messages erased | `services/language/transport.ts`, `lifecycle.ts`, `diagnostics.ts` | Bounded cancelled history, per-request rejection, `recordProtocolIssue` separate from crashes, healthy-window reset, 10 000-item cap, incremental diagnostic store |
| Search re-scanned dirty buffers and re-sorted all matches per ripgrep batch; explorer re-enumerated and republished per raw watch event; picker query scanned 250k entries synchronously | `services/search`, `services/files`, `services/navigation` | Buffers scanned once per query, sort once at completion; watch events coalesced per parent with one publish; `queryAsync` time-sliced with cancellation. `tests/search/t043-search.test.ts`, `tests/e2e/t040-explorer.test.ts`, `tests/e2e/t039-picker.test.ts` |
| Recovery checkpoint re-parsed and re-encoded the whole journal (≤16 MiB) per checkpoint; per-byte BigInt/FNV hashing on open, save and every file operation; language sync allocated a per-scalar array of the document on open and stalled after a flush failure | `services/persistence`, `services/files/journaled-operations.ts`, `services/language/sync.ts` | In-memory journal cache with per-entry encodings, identity reuse when stat matches, `Bun.CryptoHasher`/`Bun.hash`, `isWellFormed`, single snapshot per open, one automatic resync retry. `tests/persistence/checkpoint-caching.test.ts`, `tests/lsp/sync-resilience.test.ts` |
| Composition root owned workspace-edit resource semantics, a ctags parser, the buffer picker provider, five divergent open-file flows, and 75 inline test-marker branches | `apps/xi/src/main.ts` | Extracted to `services/language/workspace-edit-resources.ts` and `services/navigation/ctags.ts`, `BufferPickerProvider`; one `openBufferAtPath`; one `marker()` helper parsed at the process boundary; `main()` wrapped so the renderer is destroyed on any startup failure; `workbench.dispose()` and `OwnedVimSession.dispose()` run at teardown. `main.ts` 3 835 → ≈3 540 lines |

Two regressions introduced during this remediation were caught by PTY tests and fixed
the same day: the CLI clock's `sleep` ignored cancellation, so the new healthy-window
reset kept the process alive 30 s after quit (`t051-completion-pty`); and the new
`closeAllPanels()` closed a panel's own deferred re-open, emitting a spurious
`XI_SEARCH_CANCELLED` (`t045-e05-search-rapid-typing-pty`). `closeAllPanels(keep)`
now skips the panel being opened.

Still open after this pass, for T116/T111/T112: Ex dispatch through `CommandRegistry`
(discovery and dispatch remain two tables), panel keymaps and the leader state machine
still in `main.ts`, the explorer `publish()` node-list rebuild, the layout rebase
allocation noted above, and full production-path latency qualification (T115). No
release gate is certified by this follow-up.

## Diagnostic reproduction

Executed `bun run bench/performance/planning-probe.ts <public|rope> <normal|dense|long> 1048576` in six fresh children. Normal uses 79 `x` plus LF; dense uses `x` plus LF; long is all `x`. The public path calls `openTextDocument`; the private comparator calls `RopeDocument.create`. Both verify successful length; source SHA-256, line count, memory snapshots, CPU and max RSS are retained in `.artifacts/performance-planning/open-probe.json`. Source generation is outside open wall time but inside the recorded CPU interval. Imported modules are present in the pre-open baseline. Full fidelity correctness still requires owner tests.

| 1 MiB fixture | Rope open ms | Public open ms | Rope reported heap growth MiB | Public reported heap growth MiB | Public RSS growth MiB |
|---|---:|---:|---:|---:|---:|
| Normal 80-byte lines | 25.07 | 39.05 | 0.00 | 8.38 | 53.12 |
| Dense `x\n` | 128.16 | 1500.08 | 19.41 | 137.12 | 248.22 |
| One line | 15.09 | 16.93 | 0.00 | 0.00 | 30.12 |

These are **one sample per case**, GC/RSS diagnostics on a shared VM, not p95, a release pass, or an exact allocator census. Zero reported retained growth does not establish zero allocation. Nevertheless, the density-dependent public-path expansion plus source inspection justifies immediate structural remediation; the older repeated-middle-insert benchmark contains no newlines and cannot expose this workload. A CPU profile was also collected with the installed Bun profiler; inspect it through the evidence report before making function-level attribution claims.

The pinned SQLite amalgamation was downloaded as public research data. Version 3.50.4 archive SHA-256 `1d3049dd0f830a025a53105fc79fd2ab9431aea99e137809d064d8ee8356b032`; extracted `sqlite3.c` SHA-256 `e3f5d6901e7492af4a1fc8c4d745cae84c264942524c3fbfc02b82a5ca8818c8`, 9,282,866 bytes and 262,899 LF bytes. This provides a reproducible real-code workload instead of relying on the attachment's approximate historical size. [SQLite 3.50.4 archive](https://sqlite.org/2025/sqlite-amalgamation-3500400.zip).

## Source provenance and limits

Pinned downloaded source hashes are retained in [performance-sources.json](performance-sources.json). Large originals and profile traces live under `.artifacts/performance-planning/`; URLs/revisions/hashes make the source audit reproducible. One optional WebKit `WTFString.h` fetch returned HTTP 429; conclusions above use the successfully retrieved `StringImpl.h`, not the unavailable file. Current Bun/SQLite/Tree-sitter web documentation was read on the review date; version-specific APIs still require pinned local probes. No unverified worker speedup, hard string limit, native allocation counter, or zero-copy guarantee is promoted to a requirement.

This refinement chooses constraints and experiment criteria now. It does not claim to have performed T107–T118 refactors, certified a dedicated runner, met all resource budgets, or completed all Xi command families. Their explicit tickets and release dependencies are the deliverable for the requested plan refinement; measurable production completion remains gated separately.

## Second-pass audit and remediation plan, 2026-09-17

Fresh read of the worktree at `b6b5692` (after T116). `bun run check` passes; the
import graph, perf lint and type check are green. Every row below was confirmed by
reading the code. Work is split into groups with disjoint file sets so they can be
fixed in parallel; each group leaves one small test behind and runs the listed gates.

| # | Group / files | Defect | Fix |
|---|---|---|---|
| A1 | `apps/xi/src/main.ts:791` | `host.registerPanel(...)` runs after `await runWorkbench` and `host.dispose()`; panel exclusivity is inert in production | register before `host.createSession`, or each controller registers itself |
| A2 | `main.ts:187`, `workbench/host/index.ts:133` | only the launch document is registered with the LSP session; other buffers get no diagnostics/completion and a sync stderr write per keystroke | `openBufferAtPath`/close call `languageSession.openDocument`/`closeDocument`; never write to stderr on the key path |
| A3 | `main.ts:898`, `platform/src/filesystem.ts:209` | explorer watch events all mapped to `changed`; overflow recovery never runs, watcher never re-armed; watch is non-recursive | forward `event.kind`; re-arm on overflow; recursive or per-expanded-directory watch |
| A4 | `main.ts:1099` | dead per-byte BigInt `textHash` | delete |
| B1 | `services/language/lifecycle.ts:436` | `restart()` never resolves: run loop treats the wake as a crash, burns a retry, respawns | explicit restart flag; cycle returns instead of retrying |
| B2 | `workbench/language/completion.ts:255`, `services/language/completion.ts` | completion/signature requests never cancelled; one in-flight request per typed char | per-open cancellation source cancelled on close/retrigger |
| B3 | `services/language/sync.ts:229` | flush microtask runs before paint; on backpressure or full-sync it materializes and stringifies the whole document on the key path | defer flush behind a macrotask; bound work per slice |
| C1 | `layout/src/viewport.ts:264` | projection cache keyed on `selectionGeneration`; every cursor key re-materializes all visible rows | key rows on geometry only; recompute selections separately |
| C2 | `ui/src/workbench.ts`, `layout/src/viewport.ts:597` | `horizontalScrollCells` never passed; anchor always column 0; caret clipped past ~4×width | derive horizontal cell offset from the primary head; feed through `scrollLeft` |
| C3 | `ui/commandline/index.ts:56` | duplicate writable `ExCommandLineSession` in UI, unused | delete class and export |
| D1 | `vim/registers/index.ts:677`, `vim/search/index.ts:539,694`, `vim/motions/structural.ts:139`, `vim/motions/find.ts:158` | slice to end of document to read one code point; 1 MiB eager scan for `%`; whole-line segmentation for `f/t` | bounded windows, `slice(offset, offset+2)`, directional scans with early exit |
| D2 | `vim/insert/index.ts:318,1096`, `vim/operators/direct-changes.ts:341`, `vim/ranges/normalize.ts:376`, `vim/visual/index.ts:395`, `vim/motions/viewport.ts:705`, `vim/motions/word.ts:566` | whole-line materialization and per-grapheme objects for `<BS>`, Replace, `x/s/r/~`, `cw`, `v`, scroll keys; 64× window amplification for `b` | bounded windows (64–256 units, extended on demand); one module-level segmenter; ASCII fast paths |
| E1 | `document/src/undo.ts:361`, `selections/src/index.ts:200`, `vim/pattern/parser.ts:39` | per-commit reduce over all steps + canonical JSON of selections; O(n²) member lookup and spread-max; step budget counted per code unit | running metadata sum; id map + loop max; budget by characters advanced, outputs by matches needed |
| E2 | `document/src/text-fidelity.ts:126,198`, `document/src/rope.ts:198` | two strings pushed per line on chunked open even for pure LF; unconditional full byte copy; per-chunk merge build | `indexOf('\r')` per chunk, append whole chunks; copy only on read-only fallback; O(n) bulk build |
| F1 | `services/persistence/index.ts:296` | checkpoint materializes + stringifies whole document before the size check | bail on `lengthUtf16 > maxBytes` first; stream via `encodeTextFileChunks` |
| F2 | `workbench/search/index.ts:574`, `workbench/language/workspace-edits.ts:314` | per-byte BigInt FNV hashing on replace/rename | `Bun.hash` / `Bun.CryptoHasher` |
| F3 | `workbench/picker/index.ts:188`, `services/navigation/index.ts:189` | picker query returns `stale` during index population and is not retried | retry `stale` like `not-ready`, or do not bump generation on additions |
| F4 | `services/search/index.ts:206` | accumulated match list copied per 32-match batch | append in place, publish frozen view |
| G1 | `bench/performance/t116-key-output.py`, `t045-typing-under-load.py` | stderr shares the PTY and the sync `XI_EX_COMMANDLINE_STATE` marker lands before the frame; numbers are key→marker | separate stderr fd; time stdout only; require the moved cursor in the parsed frame |

Deferred to a second phase (ownership drift, no user-visible defect): UI deciding
quit on `q`/Ctrl-C and owning SIGTSTP (`ui/src/terminal.ts:494,290`); `renderSelf`
mutating scroll state through a callback; scroll-wheel cursor semantics, ctags
provider, theme mapping, recovery policy and the only `ClockPort` implementation
still in `main.ts`; missing `dispose()` on `PersistenceService`, `ConfigStore`,
`JournaledFilesystemOperations`, `AtomicCommandCoordinator`; unused
`ui/input/adapter.ts`, `workbench/dispatch`, `WorkbenchHistoryCoordinator`; syntax
highlighter not wired and O(document) per request; grapheme segmentation gaps
(Hangul jamo, Indic conjuncts). No release gate is certified by this pass.

Outcome, same day: groups A–G were applied in the worktree with one new test per
group (`tests/workbench/t-panel-registration`, `tests/lsp/t-restart-resolves`,
`tests/layout` T014-HSCROLL-01, `tests/vim/bounded-reads`, `tests/vim/bounded-line-reads`,
`tests/document/undo-metadata-linear`, `tests/selections/update-large-set`,
`tests/vim/pattern/literal-fast-path-budget`, extended `checkpoint-caching`).
`bun run check` and `test:startup` pass. Single-run diagnostics on this host, not gates:
10 MiB public open 206 → ≈90 ms (normal) and 225 → ≈110 ms (dense); motion-only
`project()` p95 5.05 → 0.05 ms; typing-under-load key→stdout p95 8.6 → 2.8 ms with the
corrected probe boundary. The remaining `t019`/`t024` oracle failures are the T121
host-clipboard class and are independent of these changes.
