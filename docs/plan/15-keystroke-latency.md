# Keystroke responsiveness — mandatory release contract

Decision: 2026-09-15, following the user's request for immediate, consistently fast editing. These are mandatory, unmeasured product requirements. They supersede the older ordinary loaded-typing allowance of p95 12 / p99 25 ms. All stricter existing bounds and independent resource/parity requirements still apply.

## What “blazing fast” means for Xi

Ordinary typing and cursor movement must respond promptly and consistently while real services are running. A low average with occasional freezes is a failure. The editor must preserve every key and exact Vim/document state; a speculative character, spinner, scheduled repaint or fake acknowledgment is not completion.

These are engineering targets, not a universal human perception threshold. A physical-keyboard study with 31 participants compared 20 ms with 200 ms and found text correction performance suffered at the higher latency; it did not determine that any particular low value is imperceptible. [Schmid et al., MUM 2023](https://epub.uni-regensburg.de/55007/1/text-input-latency.pdf). Independent instrumented [computer measurements](https://danluu.com/input-lag/) and [terminal measurements](https://danluu.com/term-latency/) illustrate why keyboard, terminal and display delay must be measured in addition to application time. Sources reviewed 2026-09-15.

## Required limits

All values are milliseconds, measured on a declared qualified reference configuration. p95 means at least 95% of samples satisfy the bound; max is the largest recorded sample, not a percentile.

| Boundary / workload | p50 | p95 | p99 | Maximum |
|---|---:|---:|---:|---:|
| Ordinary engine step: decoded actionable input to coherent state | 0.5 | 1 | 2 | 4 |
| Ordinary key to correct terminal output, idle services | 4 | 8 | 16 | 25 |
| Same ordinary keys with LSP/search/Git/syntax/task activity | 4 | 8 | 16 | 25 |
| Large-file/giant-line ordinary local editing under INPUT-LARGE | 8 | 16 | 25 | 50 |
| Physical key actuation to correct visible pixels, ordinary idle and loaded typing | 20 | 35 | 50 | 75 |

The physical limit covers the complete reference keyboard/OS/terminal/display chain. Record refresh rate, scanout target position, keyboard polling/debounce, compositor, terminal/version and direct versus tmux runs. Certify only measured configurations. A slow terminal or display does not justify relaxing Xi's separate 8/16/25 ms output limits. Results from a shared VM or an uncalibrated capture are diagnostic, not a pass.

Ordinary editing means one cursor on the existing small-source and 1/10 MiB normal-line corpora, at 120x40 and 240x70, including line crossing and viewport scroll. Apply the engine row to ordinary local actions; operations whose required work scales with a requested range are explicitly measured in their batch family. 100 MiB files and 1/10 MiB giant lines use INPUT-LARGE. Existing 10/100/1,000/10,000-cursor limits remain separately mandatory; these are not ordinary-singleton latency claims.

A user-issued whole-file substitution, enormous paste, far semantic scan or 10,000-cursor batch is not promised a 1 ms completion. Its input admission, progress and cancellation remain responsive under the original batch/resource contracts. Agents may not relabel an ordinary single-character edit, arrow motion or local backspace as a batch to escape a bound. Cold caches and long retained history are required workload states, not exclusions.

## Exact timestamps and correctness

- Engine: begin when a complete decoded actionable event is available; end at atomic committed text, selections, mode, registers and relevant history state. Prefixes that intentionally wait for another key are measured for correct pending-state publication; human think time between keys is not execution time.
- Application output: timestamp scheduled input delivery and actual PTY write/arrival before Xi decodes or queues it. End when an external terminal parser has received the output that represents the correct resulting text/cursor/mode. Include decoder, queue, command execution, GC, layout, renderer scheduling, writes and backpressure. Report injection slippage separately and include it in externally observed delay; do not move the start after a stall.
- Physical: timestamp instrumented key actuation (or equivalent calibrated hardware input) and the first correct target pixels using a synchronized photodiode or high-speed camera. Software/emulator frame callbacks do not measure physical photons. Record temporal resolution and clock error; a bound crossed by the measurement uncertainty stays unproven.
- Maintain event sequence IDs in the external harness. For a coalesced output frame, each earlier event completes only at the frame reflecting its cumulative effect, using its own original arrival time. No dropped, duplicated, reordered or selectively unmeasured keys. Final saved bytes, cursor, mode and selection must match the expected stream.
- No-state-change boundary keys still count: record handled-state timing and prove the correct frame remains displayed without forcing a production-only test acknowledgment. Report these separately; they cannot dilute changed-frame latency distributions.

## Input and load matrix

Run each action family separately; never hide slow arrows or Escape by pooling them with cheap insertions:

- ASCII and mixed Unicode insertion, Enter, backspace/delete, local undo/redo, local dot repeat, h/j/k/l and all four arrows, Normal/Insert/Replace/Visual transitions, Escape, and viewport-crossing movement.
- First key after startup and after idle, first edit/motion in cold caches, first key after service results, long history, saved and dirty views. Startup completion cannot stand in for first-key responsiveness.
- Normal human-paced input (5, 10 and 20 events/s), held movement/deletion (30 and 60 events/s for at least 5 seconds), and 100-event bursts at 1 ms spacing. Preserve the predetermined schedule when Xi stalls. Burst overload is a separate queue stress result, not a claim of human typing speed: no loss/reorder and correct final output within 50 ms after the last delivered event, with per-event delays retained.
- Real LSP completion/diagnostics, one oversized syntax parse, full worker resync, workspace search, Git diff and task-output flooding, both individually and simultaneously. Disabled services and mock-only replies cannot qualify loaded typing.
- Test direct terminal and tmux, both viewport sizes, and prefix hints/motion trails on and off. Late service results cannot corrupt newer edits or make old frames replace current ones.

For ordinary interactive runs, no Xi-attributable event-loop stall may exceed 8 ms. Background integration slices remain ≤2 ms. Explicit large-operation preparation remains ≤8 ms per slice, and the original global ≤50 ms stall ceiling including atomic publication remains mandatory. Ordinary-run limits remain 25 ms per output response even if an individual subsystem meets its own allowance; subsystem budgets are not permission to add delays beyond the parent budget.

## Qualification and failure rules

Use the same production CLI/composition as the distributed editor. No optimized harness-only editor, direct helper substitution, timer-only acknowledgment, forced GC, disabled highlighting or reduced workload to pass.

Collect at least 10,000 actionable events per required workload/action/load condition across at least 30 independent sessions, including first-key/cold cases reported separately. Physical capture must meet the same per-condition sample requirement; unavailable instrumentation leaves that gate unproven. Repeated events within a session are correlated: use session/block confidence analysis, never describe them as 10,000 independent trials. Retain input schedules, observed arrivals, raw response times, all maxima, count over 16/25/50 ms, longest backlog interval, correctness results and measurement uncertainty.

Paced/held/open-loop schedules are mandatory: a harness that waits for a response before sending the next event can hide queuing stalls (coordinated omission). Such acknowledged runs may supplement, but cannot replace, the open-loop runs. Slow-reader and burst stress remain separately reported, preserving all bounded queue/cancellation obligations; environmental overload cannot be used as an ordinary-typing pass.

Any correctness failure, exceeded absolute bound, missing required condition, missing physical measurement or unsupported counter leaves its gate failed or unproven. Retain every outlier, including GC; OS/thermal/host interference needs raw attribution and an unproven run followed by a clean rerun, not sample deletion. Maxima bound observed qualification runs; they are not a mathematical hard-real-time guarantee on arbitrary operating systems.

Compare randomized paired runs against the clean pinned Neovim and a real compatible Xi baseline on the same host/terminal. Keep the existing ≤Neovim p95 +3 ms constraint and >10% significant p95 regression rule. A slower Neovim or baseline never overrides the absolute limits.

## Ownership and resumption

- T106: catalog/adapter coverage, honest timestamp provenance, session/block statistics and rejection of incomplete evidence.
- T109/T110: engine and large-input limits, bounded reads/allocation/history with exact semantics.
- T111: layout/render scheduling, damage/output and parent input-to-output envelope.
- T112: ordinary 8 ms stall bound, service CPU isolation and 2 ms integration slices.
- T116: production input normalization/dispatch, arrow/mode routing and one shared application composition.
- T115: executable workload/action/load matrix and calibrated output/physical measurement producers.
- T062/T063: complete performance and real-terminal visible-response qualification; G6 remains dependent.

Numeric obligations are in performance-budgets.json and performance-adapters.json. An adapter declaration does not create a producer or pass a test. Expand every action/load condition in the executable manifest under the existing PF variants; missing variants or conditions must fail coverage before qualification. Keep existing ticket statuses and concurrent implementation work intact.
