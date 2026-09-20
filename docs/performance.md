# Performance contract

Responsiveness is a release requirement for every input, render, load and background-work
change.

| Boundary | Required result |
| --- | --- |
| Ordinary engine step | p95 ≤ 1 ms, p99 ≤ 2 ms |
| CLI input to correct terminal output, idle and loaded | p50 ≤ 4 ms, p95 ≤ 8 ms, p99 ≤ 16 ms, observed max ≤ 25 ms |
| Xi-attributable ordinary interactive stall | ≤ 8 ms |
| Warm startup | p95 ≤ 150 ms |
| Process-cold/filesystem-warm startup | p95 ≤ 300 ms |
| Open 1 MiB | p95 ≤ 100 ms |
| Open 10 MiB normal-line file | p95 ≤ 250 ms |
| First viewport of 100 MiB file | ≤ 1 s |

Native-level comparisons use clean pinned Neovim on the same host, terminal, corpus and
completion boundary. Xi keystroke p95 overhead must stay within 3 ms of Neovim while also
meeting the absolute limits. Physical key-to-visible latency is measured separately from
process timestamps.

Measure tails and maxima, cold/first-key behavior, held arrows, bursts, Unicode, long
lines, GC and simultaneous LSP/syntax/search/Git/task activity through the production
path. Record sample count, environment, corpus, CPU, wall time, allocations, retained/peak
memory and queued bytes when relevant. Do not disable features or substitute a component
harness to make a result pass.

H0 scalar/chunk/cell kernels avoid temporary objects and strings. H1 interactive
operations may allocate bounded immutable outcomes. Background CPU work is sliced or
isolated, cancellable and backpressured; a microtask is not CPU isolation. The local
performance lint protects common regressions but is not measurement evidence.
