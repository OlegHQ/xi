# Solid startup regression: checkpoint, comparison and remediation

- Scope: user-requested pre/post-Solid comparison and startup repair; contributes to T137–T139/T122, without completing their remaining gates.
- Outcome: measurable improvement; **regression elimination and native-level qualification remain unproven**.
- Checkpoint: `2ca870f` commits the migration and preceding UX repairs. Recovery sidecars were excluded.
- Baseline: `83d08ba`, the immediate pre-migration parent, rebuilt in a detached worktree with the same installed Core fork/native ABI.
- Fork: Core unchanged from `ef3901c`; Solid compiler patch at `63b26f7`.
- Host: shared Linux 6.8 arm64, four reported CPUs, Bun 1.3.13, TypeScript 7.0.2, Core/Solid 0.5.11, SolidJS 1.9.12. Clean pinned Neovim is verified by the harness manifest.
- Contracts: specs 01, 05, 06, 12, 15 and 16. Startup is class C; first-key admission remains H1/INPUT-OUTPUT. Catalog validity is not qualification.

## Findings and production changes

The migration statically imported `@opentui/solid/preload`. Its compiler imports
initialized Babel in source and built launches; every source process transformed
the same TSX again. Bun's ordinary JSX lowering cannot substitute for Solid's
universal reactive compiler. The existing dev bundle concealed some source cost
but did not restore the pre-Solid baseline.

The shared Xi build plugin now runs the existing Solid transform and omits the
source-preload module entirely. Both release staging and ordinary package builds
use the same builder; release staging previously bypassed the Solid build plugin.
No compiler is needed at runtime in these outputs. The executable decreased from
about 152 MiB to 135 MiB. Dev builds also omit the preload.

The fork supports an optional per-source transform cache. Xi opts in at
`.cache/solid`; Babel loads only on a miss. Keys include source, filename, runtime
module, Bun version, compiler implementation and the dependency manifest. Custom
resolver functions bypass caching. Atomic replacement, corrupt-cache fallback and
read-only fallback preserve source loading. A fresh source cache still compiles
TSX; warm source results do not describe that cold-transform cost.

The shared Solid row component keeps subscriptions and scroll state but mounts
native widgets only while visible, using Solid's existing `Show`. Previously every
closed panel created a box and a text scrollbar. No service, panel or keyboard
feature was disabled. Snapshot expectations were unchanged.

The fork's Core lazy FFI binding, native image extraction and narrow renderer
entry are still active. Solid's full catalogue imports the all-widget Core entry,
so the old narrow-entry advantage does not cover the entire new UI graph. Profiles
retain module initialization and native widget work. Prior matched batching
experiments in T141 found no reliable improvement; that discarded machinery was
not reintroduced. No native ABI or Zig code changed.

## Matched measurements

`before-fixed/comparison.json`: 30 randomized paired blocks, fresh processes with
warm filesystem, isolated configuration, identical two-line fixture and responsive
120×40 PTY. Boundary: both file lines, appropriate cursor visibility command and
closed synchronized update in output. Immediate Insert/escape/save proves exact
saved bytes. These stream-marker diagnostics are not physical display timings.

| Before remediation | p50 ms | p95 ms | p99/max ms |
|---|---:|---:|---:|
| Pre-Solid source | 114.61 | 136.76 | 148.64 |
| Solid source | 463.94 | 501.23 | 502.67 |
| Pre-Solid bytecode | 65.79 | 79.84 | 85.23 |
| Solid bytecode checkpoint | 122.10 | 146.13 | 183.23 |
| Clean Neovim | 11.52 | 13.03 | 13.34 |
| Helix | 13.04 | 15.85 | 20.31 |

Final run: another 30 randomized blocks, with unchanged pre-Solid binaries/source,
the checkpoint executable, current executable, direct source and cached dev command.

| Final stream-boundary comparison | p50 ms | p95 ms | p99/max ms |
|---|---:|---:|---:|
| Pre-Solid source | 113.72 | 124.19 | 129.48 |
| Current source, warm transform cache | 159.34 | 167.81 | 172.46 |
| Pre-Solid bytecode | 65.06 | 70.23 | 82.37 |
| Checkpoint bytecode | 120.06 | 131.85 | 158.46 |
| Current bytecode | 84.13 | 92.39 | 102.77 |
| Current `bun run xi`, cached dev bundle | 137.03 | 148.11 | 153.77 |
| Clean Neovim | 11.50 | 13.12 | 15.36 |

Current bytecode is 30% faster at the median than the checkpoint, but still 29%
slower than pre-Solid. Source is 40% slower than pre-Solid even with cached TSX.
The >10% regression rule is **not satisfied**. Source p95 also exceeds the 150 ms
warm-start budget. The remaining gap cannot be called instant or resolved.

Paired-block bootstrap (10,000 resamples, seed 20260919): current minus pre-Solid
bytecode median delta 95% interval **+17.34 to +21.16 ms**; p95 delta **+19.07 to
+23.98 ms**. Current minus checkpoint median interval **−37.21 to −34.00 ms**.
Source minus pre-Solid median interval **+41.98 to +47.40 ms**. Shared-host
limitations remain; these intervals do not qualify a reference machine.

Independent parsed-cell confirmation, 30 randomized blocks and 400-line fixture:

| Parsed correct-frame startup | p50 ms | p95 ms | p99/max ms |
|---|---:|---:|---:|
| Pre-Solid | 73.66 | 76.42 | 80.13 |
| Checkpoint | 127.53 | 136.67 | 143.61 |
| Current | 93.13 | 97.06 | 97.51 |

**90/90** usable-cell, immediate first-motion, unchanged-file and clean-exit checks
passed. This boundary includes parsing and uses a different corpus, so these
numbers are not pooled with the two-line stream diagnostics. First-motion
write-to-correct-cell p50/p95/max: pre-Solid **6.34/8.26/8.47 ms**, checkpoint
**12.68/14.19/14.22 ms**, current **12.75/14.56/19.41 ms**. First-key performance
remains outside the ordinary 4/8/16 ms targets; startup improvement is not an input
latency pass. The automatically visible Files tree also starts optional service
initialization just after readiness; its shared service loading and Solid frame
cost remain investigation targets without delaying/removing Files to improve a score.

At the stream boundary, median main-process RSS/CPU: pre-Solid bytecode
**107.04 MiB / 70 ms**, checkpoint **163.88 MiB / 145 ms**, current **121.96 MiB /
90 ms**. Current source: **107.53 MiB / 205 ms**, pre-Solid source **93.39 MiB /
160 ms**. CPU includes process threads and has 10 ms tick granularity. The dev
command's parent-process counters belong to Bun's script wrapper, not the child
editor, and must not be used as editor memory/CPU evidence.

One explicitly cold transform-cache probe took **552.39 ms**, followed by
**160.83 ms** warm; both saved exact bytes. The prior generated cache was moved
recoverably to `transform-cache-before-cold/`, not deleted. Two samples are a
diagnostic, not cold-start qualification. The staged release separately preserved
immediate Unicode edits and exact saved bytes.

All raw evidence is under `.artifacts/startup-solid-comparison/`: `before/` retains
the rejected initial probe; `before-fixed/`, `final/`, `parsed-final-fixed/` retain
commands, hashes, traces and outcomes; `profile/` retains CPU profiles;
`cold-transform/` retains cold/warm trials. `summary.json` is produced by the
retained `summarize.py`. No raw private workspace contents are committed.

Reproduce the paired stream test with `python3 bench/performance/startup-diagnostic.py
<fresh-output> --compiled dist/xi --baseline-compiled <pre-solid>/dist/xi
--baseline-source <pre-solid>/apps/xi/src/main.ts --samples 30`. The JSON report
records the additional checkpoint/dev argv arrays. Reproduce the cell check with
the isolated Python from `.artifacts/ui-proof/venv`, `bench/performance/ui-proof.py
<fresh-output> --binary pre-solid=<binary> --binary checkpoint=<binary>
--binary current=dist/xi --scenario startup --sessions 30 --load idle`.

## Executed checks

- `bun run check`: passed strict types, ownership/architecture and lint.
- `python3 tools/perf.py check`: catalog valid, 55 budgets / 1,016 obligations; not a measured pass.
- `bun run test:ui`: all 20 fixtures passed, including visibility, shared surfaces, scrolling and one-render-per-input checks.
- `bun run package:build`, `bun run xi:dev:build`, and `bun run package:release -- --output .artifacts/startup-solid-comparison/release`: passed.
- `python3 tests/distribution/t122-startup-input.py`: source and bytecode preserved immediate Unicode and 208-character bursts exactly.
- Git panel, Git diff, Explorer wheel/drag, sidebar/tab and Search production PTYs passed.
- Fork compiler-cache/runtime-plugin tests: 11 passed, including late runtime configuration, source/runtime cache invalidation and corrupt entries.
- Fork Solid declaration/library build passed. Packed Bun and Node 26.4 consumers passed with `test:dist -- --skip-build`, using existing native assets.
- Fork full Solid suite: 270 passed / two timing-sensitive textarea paste failures. A clean `ef3901c` worktree reproduces a >4-sample assertion failure; focused current reruns vary in which sample-count assertion fails. Full-suite status remains failed, not waived.
- Patch regeneration `--check` and Git whitespace checks passed. Fresh isolated Bun install caches were used and installed JS was fingerprinted for timing.

## Harness corrections and limitations

The old startup diagnostic incorrectly required a hidden hardware cursor from
Neovim, which uses the terminal cursor. The first run timed out despite content
being present; its ANSI trace is retained in `before/`. The cursor condition now
distinguishes Neovim from Xi/Helix without changing Xi's completion boundary.
Both existing OSC/control-string matcher regression checks pass.

The cell-parser comparison initially rejected the pre-Solid cursor because its
hard-coded Light palette covered only the newer `#14202E` token. The retained
ANSI trace and baseline source confirm the old token is `#1A2835`. The parser now
accepts both pinned tokens, still requiring exactly one correctly positioned
cursor. A regression test rejects ordinary background-colored text; all four
cell-parser tests pass. The rejected attempt remains in `parsed-final/`.

Moving compiler loading exposed reliance on sibling static-import evaluation
order in UI tests. Bun's normal `[test].preload` now installs the source compiler
before test modules load. No production branch depends on a test-only marker.

The first packed-consumer attempt found Node 24 rather than the required 26.4;
the pinned existing Node binary corrected that. The next attempt requested a
native rebuild and found no Zig. Reusing the already-built library and unchanged
native assets with the supported `--skip-build` option passed both consumers.

First-input mode detection is not correct-cell latency. CPU observations have
`/proc` tick resolution; RSS/HWM cover the main process, not allocation totals or
all service children. No physical capture, cold OS-cache qualification, complete
large-file matrix or 10,000-event loaded latency qualification is claimed. Source
cache misses, the remaining pre-Solid regression and native baseline gap remain
explicit work, not passed tickets. No thresholds or ticket prerequisites changed.
