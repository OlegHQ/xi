# Performance and memory engineering

This is the normative resource contract for Xi's **initial editor requirements**, alongside [validation](05-validation.md). Numbers are design targets until measured at the specified production boundary. The [research and current-code audit](13-performance-research.md) explains why the existing storage decision and component benchmarks do not establish editor performance. The machine-readable [budget catalog](performance-budgets.json) assigns numeric bounds, owners, workloads and remediation tickets. A ledger row is not a release certificate.

## Keystroke latency decision

[Spec 15](15-keystroke-latency.md) is the mandatory responsiveness contract. Ordinary idle and loaded input-to-correct-output now share p50/p95/p99/max limits of 4/8/16/25 ms; the previous 12/25 ms loaded allowance is superseded. ENGINE-STEP adds 0.5 ms p50 and 4 ms max; INPUT-LARGE adds 8 ms p50, 25 ms p99 and 50 ms max. INPUT-OUTPUT and INPUT-LOADED also require separate calibrated physical key-to-photon evidence (20/35/50/75 ms). MAIN-STALL adds an 8 ms ordinary interactive ceiling while retaining the 2 ms integration, 8 ms large-preparation and global 50 ms limits. Missing physical instrumentation remains unproven. Catalog and adapter rows declare these obligations; T106/T115 must implement and validate every required action/load condition before qualification.

## Product scope and architecture decision

Build the right engine for Xi: local code editing, the declared Vim motions/operators and composition, multiple selections, Unicode and file fidelity, history, workbench and language integration. Do not copy Vim's implementation or expand into the full Vim/Neovim application, scripting runtime, plugins, pager or APIs. Oracle completeness means coverage of **Xi's declared behavior**, not implementing every upstream help entry. Existing required motion and edit families remain required; classify unrelated upstream commands with a reason. Performance changes preserve these semantics and Xi's own selection extensions.

Keep Bun, strict TypeScript, OpenTUI, one authoritative document in the input isolate, and typed asynchronous ports. Keep versioned UTF-16 public offsets for now; UTF-8 storage is a private representation candidate, not a reason to migrate every consumer or equate bytes with characters. Neither a rope nor a piece tree wins by its name. T108 must compare the current bounded rope, an improved packed/chunk representation, and an append-coalescing UTF-8 piece/block candidate against the **same public workload**, including metadata, history and workers. Select one production representation; retire experimental alternatives. A native/WASM kernel requires demonstrated end-to-end benefit including marshaling, Unicode, memory and packaging; no runtime Neovim and no new language requirement by assumption.

The current treap offers expected logarithmic paths, not worst-case balancing. Record adversarial height, visits, copied nodes and cancellation. Rebalancing is budgeted preparation followed by a version-checked root switch, preserving all retained snapshots; no full-tree repair on a key. A broad representation rewrite is gated by T108 evidence, while the observed per-newline metadata cost is already a concrete T107 remediation.

## Execution classes

| Class | Examples | Required approach |
|---|---|---|
| H0: inner kernels | Chunk traversal, line rank/select, Unicode boundary advance, sorted endpoint map, cell damage iteration | No per-code-unit/cell/endpoint temporary objects or strings; bounded scratch, numeric locals, dense arrays where measured useful. No IO, awaits, closures per iteration, or full-line/document materialization. |
| H1: interactive commands | Parser, motion/operator/Insert preparation, commit, history metadata, selection publication, visible layout | Allocation-light, structurally bounded immutable outcomes; persistent path copies and actual inserted bytes allowed within explicit budgets. UI event/read-model objects are allowed. No input-time scan proportional to unrelated document length or history. |
| B: resumable/background | Search/regex, parsing, index/filter/sort, diagnostics, large edits, encoding, recovery, diff | Work/byte quotas, task-queue yields or measured worker isolation, cancellation and version guards. Async syntax or a microtask alone does not yield to input. |
| C: cold/control | Configuration, contribution registration, settings/help and error UI | Normal idiomatic TypeScript; enforce startup, lifetime, queue and memory budgets. Do not pool arbitrary feature objects. |

A class attaches to a production operation, not an entire package. UI chrome can use objects; the UI's cell loop is H0. Ex parsing is C/H1 but an Ex substitution is B. Vim state is readable H1 code; scalar traversal is H0. The performance catalog covers owner operations rather than every helper function; every new operation must inherit a named row and an end-to-end workload or add a row before implementation.

### Enforced code styles

T119 adds `bun run check:lint` to the normal check gate using pinned Oxlint and
[local execution-class rules](../../tools/lint/README.md). Owner paths provide
conservative defaults; operation annotations refine H0/H1/B/C with a catalog budget
and reason. New and remediated H0 kernels must carry annotations at their definition,
including hot helpers called from other owners. UI/control code remains idiomatic.

Performance exceptions are single-code, next-line comments with a known budget ID
and concrete explanation of necessity and bounds. Missing/unused explanations and
native blanket lint suppressions fail. Review class downgrades and exceptions
against callers and measurements; lint cannot verify prose or runtime allocations.
Existing findings remain failing owner remediation work, never a blanket baseline
or a waiver of the budgets below. H0 loop syntax checks do not establish zero
allocation through callees, scratch lifetime safety, or whole-document complexity.

### Allocation and lifetime rules

- Distinguish transient allocation **rate**, retained live bytes, peak RSS and allocator capacity. An edit preserving history inherently allocates lasting state. Do not claim zero total allocation for immutable transactions or turn every public API into a reused mutable result.
- H0 allows zero **intentional temporary heap allocation** per inner iteration after initialization. H1 local motion has a 4 KiB p95 accounted allocation target; a local edit 16 KiB, including metadata/history deltas and persistent path copies, excluding only its explicitly reported inserted payload. Renderer allocation allowance is 64 KiB per ordinary 120x40 damaged-row frame / 128 KiB at 240x70. Measure runtime allocation separately; wrapper counters alone cannot certify these bytes or GC behavior.
- A 64 KiB reusable scratch arena per active input/frame context is an initial cap, with high-water reporting and an explicit slow resumable path on overflow. Use separate leases for nested/reentrant work. Scratch expires at the end of the synchronous operation: no retained DTO, snapshot, undo, callback, worker, or OpenTUI native reference may alias it. Test use-after-reset/resize and stale frame generations.
- Pool only private nodes/slabs/decode buffers when measurement supports it. Immutable roots keep all reachable storage alive. Never recycle a node/typed array that an old root, view, history entry or worker lease can still read. Reference/epoch ownership and release must be explicit; pooling is not free memory.
- A `readonly Uint8Array` does not make its elements immutable. No writable view into canonical storage escapes the document owner. Provide read iterators or lifetime-bound read handles; copy when crossing an untrusted/retaining boundary. Internal sink APIs write to caller-owned storage without changing coordinate/version validation.
- Avoid object-per-line, object-per-character, string-key-per-cell and eager `{utf8, utf16}` scalar results in kernels. Use bounded chunk-local indexes (packed integer offsets, bitsets or compressed runs as density requires), scalar helpers, and range iterators. Brand units at boundaries; never use bitwise coercion that wraps whole-document positions above 32 bits. Chunk-local `Uint16`/`Uint32` fields require checked bounds.
- `WeakMap` permits collection only when the key dies; it does not bound a cache while snapshots/history remain live. Account entries and bytes, cap by workspace, and invalidate by immutable chunk identity plus options/width generation. Cache one snapshot wrapper per unchanged public version when safe; snapshot identity must not defeat otherwise valid caches on every read.

## Document, positions and history

The public path includes byte ingestion, decoding/normalization, EOL fidelity, indexes, transactions, anchors, undo, selections, notifications and snapshots. Benchmarking `RopeDocument.apply()` alone cannot certify that path.

T107 replaces the per-newline EOL treap with a uniform ending plus sparse exceptions, packed blocks, or compressed runs with a packed fallback for alternating LF/CRLF. Index by newline ordinal. Uniform LF files cannot carry a heap object for each newline. Retained EOL payload + its private index is at most `ceil(newlineCount / 4) + 64 KiB` per document; dense exceptions must not become a Map entry per line. This is a target requiring proof, not a claim the current implementation meets it. Preserve mixed EOL, BOM, literal CR, NUL policy, edits across line boundaries and exact undo/reopen bytes.

Required private read APIs: bounded forward/backward chunk traversal, rank/select for line/UTF-8/UTF-16/scalar coordinates, and bounded read-into/window operations. Whole-line strings remain explicit allocating convenience APIs for bounded/control paths. Insert must not fetch a 10 MiB logical line to insert one character. Unicode/display checkpoints must support cold far seeks without constructing an object for every grapheme; pathological combining sequences need cancellable exact processing, never a silently incorrect fixed overlap. Rendering graphemes, Vim semantic characters, UTF-16 and terminal cells remain separate.

Ordinary edits touch local chunks, changed EOL runs and affected sparse anchors. Sorted `S` endpoints and `E` edits map with one `O(S+E)` sweep after at most one necessary sort; never `S` full scans of `E`. Singleton and 10,000-member paths share semantics. Preparation may yield against an immutable base; publication is a short no-await validated pointer switch with matching text/session/history. Subscribers receive bounded immutable changes, not recycled scratch. Long commands and macros yield between coherent units; cancellation never publishes half a command.

History is byte-accounted across forward/inverse payload, persistent roots, step arrays, selection vectors, repeat data, registers and other-view state. A 256-entry limit or text-unit count alone does not cap a single indefinitely open Insert group. Coalesce adjacent typing, bound step metadata, and share retained document segments for huge deletes/registers. `ggVGd` then undo on the required 100 MiB corpus must remain valid; do not reject it because a 32 Mi-unit inverse-string limit was chosen earlier. Spill history through persistence only if necessary and explicitly implemented; no synchronous paging per key. A resource limit must leave the current command intact with a visible error/recovery action, not silently discard its undo. History eviction follows documented product policy; deleted text needed by a live register/history root remains charged until its last owner releases it.

## Layout, OpenTUI and scheduling

Xi owns visible row layout, hit maps, styles and semantic damage. OpenTUI owns the native terminal buffer/diff and protocol emission. Do not add a second ANSI renderer, duplicate writable input widget, or a JS object grid mirroring every native cell. Prefer reusable packed visible geometry/style spans and clipped overlay runs; bound frame retention and associated hit maps. Publish generation-bound immutable frame leases; old pointer events cannot read a recycled frame.

Cache visible rows plus at most one viewport of overscan in each direction; exact byte limits in the catalog also apply. A one-line edit invalidates touched layout segments; a cursor move does not remeasure all Unicode in a long line. Long lines require viewport windows and sparse wrapping/cell checkpoints, with measured cold seek. Dirty rows and cursor-only frames use OpenTUI's public damage/render path; test native output bytes/cells and wide-glyph erasure. Scroll-region acceleration is optional only if exposed safely by the pinned renderer and measurably beneficial. Correct ordinary rendering must not depend on a new terminal escape implementation.

Input and acknowledgements are ordered and never dropped. Coalesce replaceable pointer-move/preview/diagnostic states with generation guards, preserving press/release and text edits. Ordinary background integration is at most 2 ms per task; explicit large-operation preparation targets 8 ms and never an application-attributable stall over 50 ms, including publication. No permanent idle 60 Hz paint, macro microtask recursion or unbounded result-draining loop. Count output-buffer bytes and pause producers under terminal backpressure while retaining the latest complete frame and restoring terminal state on shutdown.

## Workers, services and IO

Use at most two background CPU workers initially, with one aggregate CPU core of sustained service work during loaded typing (100% of one core), configurable scheduling below that; cold explicit jobs may use two. This CPU bound is aggregate consumption, not a promise that OS scheduling prevents every burst. Keep input on its own isolate and reserve capacity on the reference host. When an in-process algorithm can yield below budget with less memory/copying, prefer that evidence over gratuitous workers. Worker startup, termination, heap, native/WASM trees, message buffers and replicas count in the editor budget.

Queue defaults: at most 8 requests and 4 MiB serialized/in-flight bytes **across** background channels in the ordinary profile; each channel at most 2 requests / 1 MiB, with shared credits. One latest parse/search generation per document, bounded resync, drain stale results without applying them. A full replica is charged explicitly by bytes; it is not hidden in a 1 MiB message cap. Seed at most one active document replica in bounded chunks, send versioned deltas, acknowledge before recycling buffers, and reset once after a gap. Never transfer/detach the canonical buffer. Before worker promotion, measure structured-clone cost, initialization, full resync and cancellation under edit storms. A full snapshot every key is forbidden.

Service limits in the catalog include parser/query caches, line indexes, file/picker path payload, diagnostics/tokens, completion/snippets, Git/diff caches, task output, file watchers, configuration/contributions and persistence queues. Virtualize/paginate output; maintain counts and an explicit more-results action when required results exceed presentation capacity. Do not silently truncate a replacement set or select-all operation. External LSP/Git/rg processes have separate RSS/CPU reports and an aggregate loaded-system gate; arbitrary language-server memory is not an Xi-owned allocation, but their effect on responsiveness still matters.

- Syntax uses chunked versioned read replicas/deltas and a real worker or resumable parser. `queueMicrotask(parseFull)` is not isolation. Parse-tree edits and UTF encodings follow the pinned binding; background byte caps include WASM tree memory. Long-line/large-file degradation is visible and leaves plain editing correct.
- Vim regex keeps the owned dialect and step-bounded evaluator. Fixed chunk overlap cannot implement unbounded captures/lookbehind/multiline/backreferences. Use a resumable chunk iterator with explicit state and counted work; budget exhaustion is a typed error, never no-match. Workspace ripgrep is a separate labeled dialect.
- LSP incremental sync builds bounded changed-range payloads; full-sync-only servers have an explicit size/debounce capability policy. Large `didOpen`/serialization is background work with versioned progress; JSON stringify of whole text on the input loop is not made asynchronous by awaiting a transport later.
- File load uses streaming byte validation/decoding and bounded construction. Retain original bytes only when fidelity/read-only/recovery needs them, and account them. Saving streams snapshot chunks and EOL reconstruction through typed platform writes, with external-change checks and flush/rename policy. No per-line output arrays or giant temporary string are required.
- Recovery records committed deltas, with incremental checkpoints/compaction. Normal target: flush acknowledged recovery data within 1 s, queued dirty recovery bytes at most 4 MiB, background serialization slices at most 2 ms, cancellation within 50 ms. If durable IO cannot keep up, expose the unsynced age and preserve data; do not lie about the 1 s target or block each character on fsync. Existing save/directory integrity requirements still apply.

## Remediation acceptance

[Spec 14](14-remediation-handoff.md) defines concrete checks for string/byte representation choices, repeated-copy lint evasions, exact forward/backward Unicode windows, single-task syntax stalls, deterministic oracle state and adapter coverage. Its owner-ticket mapping supplements these budgets. A clean lint result, timer yield or declared adapter row is not measurement evidence.

## Resource accounting and pressure

Every catalog metric has a unit, boundary, fixture and owner. Budgets are simultaneous ceilings, not additive permission for every subsystem to consume the entire process limit. For ten small buffers (each at most 64 KiB), the existing **150 MiB editor + workers RSS** target remains. Initial attribution envelopes total 150 MiB: runtime/native fixed 60, document 12, history/registers 16, engine 4, selections 4, layout 8, UI 8, workbench/config 4, service caches 12, shared queues 4, worker bootstrap 18. Shared resources count once. These are diagnostic attribution reservations, not reliably enforceable partitions of the GC heap; process RSS is the ultimate gate. If measured runtime exceeds its envelope, preserve the total and revise the allocation design with evidence.

For larger data let `B` be the sum of live documents' original UTF-8 byte lengths plus currently retained inserted payload bytes, excluding duplicate representations. Report history-deleted payload separately, not as phantom live B. Per-document retained storage including fidelity/indexes, excluding separately identified history, targets `2.5B + 2 MiB`; opening transient storage targets `4B + 8 MiB`. Large-workload editor + workers steady RSS targets `150 MiB + 3B`, peak `200 MiB + 4B` **including history, replicas, native buffers and queues**; at B=100 MiB these are 450/600 MiB. The formula cannot excuse a ten-small-buffer result over 150 MiB. Dense newlines, alternating EOLs and non-ASCII must fit too. Giant delete/undo is tested against the pre-delete workload B to avoid a fictitious zero-byte denominator; sustained history growth still meets the explicit retention/pressure policy.

History normal-workload retained bytes target 16 MiB workspace-wide, with 64 MiB metadata/private-copy ceiling in explicit large-delete/batch tests; shared root payload is charged once to physical storage and enumerated in history attribution. Layout caches at most 8 MiB workspace-wide, Unicode/coordinate caches 2 MiB, shared queues 4 MiB. Large active syntax replica+tree starts with a 32 MiB cap at 1 MiB input; above it degrade explicitly or prove a documented larger profile within process totals. Service-specific envelopes are maxima for isolated workload diagnosis and share their parent aggregate.

A workbench-owned resource coordinator aggregates owner counters and schedules eviction/admission through typed ports; it never mutates text or reads private storage. At 80% of a configured process/profile envelope, release obsolete frames, previews, stale results and reconstructible caches first, then stop admitting speculative service work. Bound history under its documented policy, without evicting live referenced data or discarding unsaved edits. At hard exhaustion reject new expensive work atomically and visibly; plain editing must have its reserved capacity. Test pressure, recovery after eviction, split sharing and disposal. OS RSS sampling is periodic control work, not a syscall per key. No user-visible runtime performance dashboard is required by this planning change.

## Workloads and evidence

Retain every original [05-validation](05-validation.md) threshold, Neovim comparison for matching singleton commands, MC01–MC12 and loaded E14. Add PF01–PF12 below. Every run checks semantic output/hash first; fast incorrect work fails. Commands below refer to future runner selectors until T106/T115 implement them; the diagnostic probe and ledger commands already exist.

| ID | Corpus and operation | Required evidence |
|---|---|---|
| PF01 | 2k-line source; 1/10/100 MiB normal lines; 200k lines, insert at top and random/far jumps | Public open/commit/first editable viewport; memory after open and loaded typing; CPU per operation |
| PF02 | 1 MiB and 10 MiB **single lines**: ASCII, tabs, combining, wide/emoji; head/middle/end insert/delete/jump/wrap | Cold and warm read work, allocation, frame output, exact cursor/bytes; no warmed-ASCII shortcut claim for all Unicode |
| PF03 | 1 MiB and 10 MiB newline-dense text including all LF; mixed LF/CRLF alternating | EOL/index bytes, transient/retained/peak memory; open/save/undo byte fidelity |
| PF04 | Pinned SQLite 3.50.4 `sqlite3.c`, 9,282,866 bytes / 262,899 LF bytes | Source/archive hash from corpus manifest; open, gg/G/middle, top insert, search, delete/undo; its actual size, not the attachment's approximate 4 MB |
| PF05 | 100k adjacent/random edits, 10k inserts then undo-all, 1M characters within one Insert group | Total allocated/retained bytes, pieces/chunks/height, history and repeat step growth; branch/delete/undo, exact checksums |
| PF06 | `ggVGd` then undo with 100 MiB, populated named registers, two views and retained snapshots | No flatten/inverse copy explosion, metadata cap, exact text/selections/EOLs restored; accounting after releasing owners |
| PF07 | Hold j for 5 s and repeat at controlled rates, plus 10,000 acknowledged input samples | Queue age, engine/frame/output timings and bytes, GC, backpressure; real CLI at 120x40/240x70 |
| PF08 | Literal and Vim multiline/zero-width/adversarial regex across chunk boundaries | Correctness, no-match work/throughput, step/memory quotas, cancel response; no fixed-overlap approximation |
| PF09 | Parse/search/LSP/Git flooding while typing; full worker resync and slow reader | CPU, worker/native RSS, queued/in-flight bytes, version guards, p95/p99 loaded output |
| PF10 | 1,000 open/close/picker/view/contribution cycles and repeated pressure eviction | Original <10 MiB retained growth gate, listeners/watchers/processes, retained roots, native grids and worker termination |
| PF11 | Startup/cold/warm/open/save/recovery with delayed/failing disk and external edits | CPU+wall split, first usable frame, flush age, streaming peak, bounded cancellation and exact recovery |
| PF12 | Budget ledger with 100k observations and absent/stale/malformed evidence | Indexed bounded queries, measured import/RSS, immutable provenance, missing evidence stays unproven |

For H0, instrument visits/copies/index bytes and semantic results; for H1 include p50/p95/p99/max, actual allocations and GC; for B include first result, completion throughput, no-match/full scan, queue age, cancellation and CPU; for C include startup/idle/disposal. CPU time is user+system, with workers/process tree separately attributed; wall-time bounds do not substitute for CPU evidence. Require 30 independent startup/open/batch trials and 10,000 interactive samples across sessions, randomized baseline/candidate ordering and confidence intervals. Small diagnostic runs explain what to fix; they never pass a release row.

Use supported Bun 1.3.13 flags verified by `bun --help`: `--cpu-prof`, `--cpu-prof-dir`, `--cpu-prof-name`, `--cpu-prof-md`, and `--heap-prof`. Record runtime and profiler versions. Output being `.heapsnapshot`/V8-compatible does not make Bun V8. Probe `bun:jsc` exports on the pinned runtime; inspect documented inclusive accounting before adding heap/extraMemory numbers. Do not force GC inside latency traces. Separate post-GC retained measurements from normal GC-inclusive typing, process high-water RSS and native/worker allocations. Preserve signed deltas; a negative heap delta is not zero allocation. A debug arena counter measures only that arena. Additional CPU/throughput targets: literal document scanning ≤2 CPU ms/MiB, snapshot encoding ≤5 CPU ms/MiB; a warm 1 GiB workspace no-match scan completes in ≤3 s with ≤3 CPU s including the child. Measure full scans, not just first-match latency.

## SQLite performance ledger

User-confirmed scope: **development budgets/results ledger**, not editor persistence or document storage. The editor imports neither the ledger nor SQLite. Canonical thresholds live in reviewable JSON; the ignored SQLite database is a derived indexed local view of those thresholds and immutable JSON observation bundles. Raw traces stay under `.artifacts/`; retain small sanitized summaries and source/corpus manifests in evidence. No buffer text, personal paths or private LSP payloads enter the ledger.

Available now:

```sh
python3 tools/perf.py check
python3 tools/perf.py build
python3 tools/perf.py status
python3 tools/perf.py show DOC-OPEN
# Import an observation bundle matching the schema described by tools/perf.py:
python3 tools/perf.py import path/to/observations.json [more-bundles.json ...]
```

Catalog revision hash, run ID, source-tree hash, corpus hash, environment ID, command, metric/statistic/unit, sample count, artifact path/hash and collection time are required. Record diagnostic/reference/noisy run classification. Index `(catalog_hash, budget_id, metric, run_id)` and environment/source/fixture identity; bound list output. A threshold-only comparison is reported as `within-target`, **never release passed**. Missing rows, stale catalog, noisy host, insufficient samples, incompatible fixtures or missing artifact mean no certification. T106 adds full baseline compatibility/regression/coverage enforcement; T115 attaches actual production adapters and the complete gate. `--baseline` must resolve to real compatible measurements, not print a label.

Use Python's stdlib SQLite in this developer tool: one short-lived connection, parameterized batched writes (multiple bundles stream into one atomic transaction), explicit transaction rollback, foreign keys, 4 MiB suggested page cache, mmap disabled, bounded inputs and queries. Default rollback journal is sufficient for one local writer; do not introduce WAL/checkpoint contention without measured concurrent-reader demand. The cache setting is not a total process hard limit. The PF12 targets are p95 indexed lookup ≤10 ms, 100k-row import ≤5 s, tool peak RSS ≤96 MiB on the reference host; report actual SQLite version. Derived database loss is recoverable by replaying catalog and retained bundles. Runtime persistence design remains the incremental journal already required by services; no SQLite migration is implied.

## Implementation order and stop rules

T122 independently addresses the measured OpenTUI 0.5.11 startup binding cost through a pinned dependency fork
and follow-on module loading: shared renderer entrypoints, ESM bytecode in
packaged builds, and demand-loaded optional surfaces/services. First commands,
format-on-save, Unicode bursts, cross-entrypoint identity and late disposal must
remain correct; shifting work to the first key is not a startup improvement.
Keep source and compiled launches measured
separately; deferred native binding must not hide first-input work or remove
features. Native handles, callbacks and compiled-library extraction have explicit
lifetimes and regression tests. T064/T115 consume this dependency without
waiving their existing prerequisites or any startup/input budget. See the
[fork installation contract](../installation/opentui-fork.md) and
[diagnostic evidence](../evidence/T122.md).

T106 establishes trustworthy measurements and budget coverage before optimization qualification. T107 fixes EOL density; T108 selects/qualifies storage including packed indexes; T109 bounds read/coordinate/snapshot paths; T110 caps history/register/repeat retention; T111 packs viewport state; T112 implements background scheduling and byte credits; T113 streams save/load/recovery; T114 owns aggregate pressure; T116 restores CLI/workbench ownership; T117 bounds LSP payloads; T118 qualifies regex streaming. T115 integrates these into full production performance evidence, and T062 remains the final measured qualification. All are release prerequisites, not a way to mark existing work complete. Existing done reports remain historical and do not certify these new obligations.

No threshold reduction, excluded required corpus, new unsupported Vim semantic, or silent count/file-size cap may repair a red metric. Improve the owner, split an oversized ticket with the same acceptance edges, or leave the gate unproven/failed. Structural budget rows, runtime distributions, and source review are complementary; none alone proves the entire editor fast.
