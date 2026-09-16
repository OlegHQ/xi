# Performance remediation and agent handoff

This is an executable refinement of specs 05, 12 and 13, not evidence that their
budgets pass. The canonical work/status/dependency list remains `tickets.json`.
Existing acceptance, corpus sizes, semantic scope and resource thresholds remain
mandatory. No ticket is completed by this planning change.

## Start and stop

The [keystroke contract](15-keystroke-latency.md) now applies: ordinary typing must meet the same 4/8/16/25 ms p50/p95/p99/max output limits idle and loaded, plus calibrated visible-response evidence. Native-level startup and loading budgets remain in spec 05 and AGENTS.md. T106/T115 own accurate action/load coverage and producers; no historical component pass certifies the strengthened contract.

1. Read AGENTS, spec 06 and the assigned ticket with `python3 tools/plan.py show ID`.
   Run `python3 tools/plan.py check` and `python3 tools/plan.py next`.
2. Resume T106 if assigned the current performance foundation: it is already
   `in_progress`, so `next` does not list it. Otherwise select a ready ticket.
   T120 and T121 are independent tooling work; neither authorizes starting T109
   or bypassing T106. Implement one ticket at a time.
3. Read the owner's specs and applicable Xi skills. Record the current failing
   case, affected production callers, catalog IDs, units and completion boundary.
   Inventory all acceptance items as pending before implementing them.
4. Implement and run the named success/failure fixtures through production APIs.
   Run `bun run check`, the affected suites, `python3 tools/plan.py check` and
   `python3 tools/perf.py check`. Record exact commands; a proposed selector that
   does not exist must be implemented and exercised, never reported as run.
5. Complete the evidence template item by item. Separate functional pass, lint
   pass, diagnostic measurements and reference-host qualification. Missing
   counters, host, oracle or visual review leave the relevant gate unproven.
6. Mark done only when every prerequisite and acceptance item has passing
   evidence. If blocked, record the missing capability and exact next action;
   continue only independent ready work. A reference-host shortage does not
   authorize a diagnostic pass. If a ticket needs splitting, preserve each old
   acceptance item in named children and update every downstream gate first.

## Gap ownership and concrete checks

| Gap | Owner tickets | Required distinguishing check |
|---|---|---|
| Strings versus byte/chunk storage | T108 | Same public operations, fidelity, coordinates, retained history and complete memory accounting for every candidate |
| Repeated copying hidden by a lint-clean rewrite | T120; T109/T111/T116 production callers | Adversarial CLI rule fixtures plus measured read/copied units across geometric input sizes |
| Incomplete forward/backward Unicode windows | T109 | Exact long-cluster boundaries in both directions, cold/warm and after edits, with bounded unrelated reads |
| A timer still executes one blocking parse | T112 | Input delivered during a single oversized parse/resync, with MAIN-STALL and loaded E14 evidence |
| Host clipboard contaminates oracle snapshots | T121, then T061/T115 | Per-fixture provider before first capture, hermetic headless/UI runs, no external clipboard access |
| Adapter declarations mistaken for observations | T106 schema/negative checks; T115 production wiring | Exact producer/fixture/metric cross-product, raw artifacts, missing-cell rejection and baseline identity |

### T108: representation decision

A JavaScript string fits Xi's UTF-16 public positions; a `Uint8Array` fits byte IO
and packed indexes. Neither establishes cheap editing, zero-copy substring views
or low retention. A typed-array view can retain its entire backing allocation;
UTF-8 needs measured conversion/index work and valid scalar boundaries. Keep
strings at bounded semantic/API boundaries when useful. The document owner alone
chooses storage; callers must not create another mutable canonical buffer.

Compare the existing representation, packed bounded string chunks and a coalescing
UTF-8 piece/block candidate on the same PF01–PF06 cases and public transactions.
Include dense/mixed EOL, non-ASCII, far seeks, middle edits, giant delete/undo,
retained snapshots and fragmentation. Count payload, indexes, object metadata,
temporary copies, history, native buffers and required encoding conversions.
Record candidate parameters, warm/cold timing, CPU, allocation, peak/retained RSS,
semantic results and rejection reasons in the decision. Private-kernel speed is
only diagnostic. Preserve public UTF-16/version contracts and exact saved bytes.

### T109/T111/T116 and T120: copying and lint

Trace input through helpers to the production operation. Audit `joinLines`, case
transforms, grapheme traversal, quote/paragraph windows, layout segmentation and
input/dispatch byte formatting. Previously removed syntax is not proof that all
paths are now bounded. In particular, inferred string accumulators can escape a
syntactic rule.

Do not replace `s += part` with `parts.push(part); s = parts.join('')` inside the
same growing loop. Do not rename `getLine`, hide it in a helper, downgrade the
execution class or add a blanket exception to obtain a pass. A single final join
can be appropriate for bounded H1 output; its pointer array and resulting string
still count. H0 per-scalar temporary arrays/strings remain prohibited. A bounded
hex conversion may use a packed byte buffer, but account allocation and decoding.

T120 adds positive/negative fixtures using the real CLI for loop-carried inferred
local strings, `s = s + part`, and repeated join of a growing local parts array.
It must still accept numeric counters, cold code, bounded immutable H1 outcomes
and joins after the loop. Do not promise whole-program alias/type analysis:
document unsupported helper/member/dynamic cases and require caller review plus
work counters. Production remediation remains in its owner ticket.

Measure geometric fixture sizes including PF02's 1/10 MiB lines. Record total
read units, largest read, copied units and allocations, not just call count.
Separate necessary work inside the requested range/cluster from unrelated text.
An arbitrarily long combining/ZWJ cluster must remain exact: a fixed overlap or
truncated result is not a valid bound. Exercise forward/backward traversal,
surrogates at window edges, tabs/wide characters, regional indicators, long
combining/ZWJ sequences, retained versions and option invalidation. Existing
8192-combining and 256-unit quote/paragraph tests are regressions, not full PF02
qualification. Semantic scan-limit failures must remain atomic and typed.

### T112: CPU scheduling

The syntax timer yields between requests; `setTimeout(parseFull, 0)` does not
interrupt one parse. Test one large parse and one full resync while delivering
input, as well as a storm of small requests. Use production scheduler/parser
entrypoints, correct-output timing and native/WASM/replica accounting. A real
worker or resumable bounded parser must satisfy the existing MAIN-STALL,
SYNTAX, WORKERS, QUEUES and loaded E14 limits together.

Queue limits apply to in-flight bytes plus pending work across channels, not
just task count. Test cancellation/disposal before scheduling, during work and
after a stale result; flush waiters must settle without microtask polling. Test
delta gaps, one bounded resync, generation acknowledgments, initialization
failure and worker termination. Never detach canonical document storage.

### T121: deterministic oracle clipboard

Install a fixture-local Neovim clipboard provider before any snapshot or provider
probe in both headless and UI oracle startup. Explicitly seed separate `+` and
`*` registers, register type and provider cache behavior; preserve normal unnamed
register semantics. Reset state for every fixture. Fixture commands may opt into
specified clipboard behavior through this provider, never the desktop clipboard.
Do not execute or modify personal Neovim configuration.

Use temporary fake clipboard executables/environment sentinels to prove the
default harness does not invoke an OS clipboard provider; do not seed or inspect
the user's clipboard. Run fixtures in different orders and twice in clean roots.
Keep full state comparisons. Minimize mismatches before changing expected files.
For contaminated goldens, record fixture IDs and affected field paths with a
reviewed explanation; re-record only changes attributable to deterministic
initialization. Do not blanket-normalize registers or approve unrelated diffs.
Do not retain private clipboard payloads in reports or new tracked artifacts.

### T106/T115: evidence coverage

`performance-adapters.json` currently declares obligations. An existing package
entrypoint and a first PF family are not proof of a runnable adapter or complete
workload coverage. Expand the executable matrix to every required catalog
workload variant, metric/statistic, size, cold/warm state and relevant aggregate
journey. Each cell must name the concrete production function/launch path,
executable selector, fixture generator/hash, correctness assertion, measurement
start/end, unit, metric source, sample policy and owner. One arbitrary PF fixture
must not stand in for several required families.

Distinguish declared, runnable, observed and qualified coverage in reports. T106
validates obligations/provenance and measurement accounting; T115 wires and
qualifies all production cells. A declared or runnable row cannot count as an
observation. Reject absent cells, duplicate/conflicting observations, mismatched
versions/fixtures, wrong units, stale/missing raw artifacts, fabricated baseline
labels and inadequate independent samples. Test each rejection deliberately.

Total allocation, retained live heap, allocator capacity, native/worker memory
and peak RSS are different metrics. Wrapper counters and signed heap deltas
cannot prove total allocated bytes; retain negative deltas and verify pinned JSC
inclusive `extraMemorySize` accounting. If no credible total-allocation source is
available, identify it as missing and leave that acceptance item unproven.

Keep the PF12 reference-host requirement in T106 and the full production matrix
in T115. Preserve all noisy/failed trials and the original sample counts,
confidence intervals, absolute thresholds and regression rules. Neither a clean
lint run nor a catalog validator certifies runtime performance.

## Suggested agent assignment

```text
Implement one dependency-ready Xi ticket using AGENTS.md and xi-implement.
Read docs/plan/06-execution.md and docs/plan/14-remediation-handoff.md.
Run tools/plan.py check/next/show; if resuming T106, read its existing evidence.
Preserve all acceptance and thresholds. Implement, validate, and write evidence.
Stop after this reviewable ticket, or report the concrete blocker and next action.
Do not push, mark missing evidence passed, or start a dependent ticket early.
```
