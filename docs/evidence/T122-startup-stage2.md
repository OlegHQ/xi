# T122 follow-on startup optimizations

- Outcome: T122 implementation and listed acceptance checks passed; performance release qualification **unproven** under T115.
- Parent revision: `555ed0ce3c2475a10844824468e6fddbb6e49755` plus working tree recorded in `T122-stage2-manifest.sha256`.
- OpenTUI fork: `f299f165950810ababb70b7cf664d7657985c86d` (`xi-lazy-ffi`), unchanged 0.5.11 native ABI.
- Host: shared Linux arm64, 4 CPUs; Bun 1.3.13, TypeScript 7.0.2, Node 26.4.0 for upstream portable checks. Helix 24.7 (079f5442), pinned clean Neovim 0.12.4.
- Covers T122 source/compiled startup, first-use correctness, dependency identity and packaging; specs 01/05/12/15. No release budget changed.

## Observable result

The production build and release staging use `--compile --bytecode --format=esm`; distribution fixtures exercise these flags. Explicit ESM preserves top-level await on the pinned Bun runtime. `bun run apps/xi/src/main.ts` remains the source command, and `bun run package:build` produces `./dist/xi`.

Xi imports `@opentui/core/renderer`. The fork exposes eight shared renderer primitives; the patch generator resolves their existing published chunk aliases from a single re-export-only source. This skips the roughly 529 KB all-widgets Bun entry without duplicating classes or native ownership. The remaining shared renderer chunks still load. Regular fork builds expose the same entry for Bun and Node.

Optional services no longer import immediately after the first frame. Panels load individually when visible, including transitions from another focused surface. A subscription wakes panels when asynchronous service read ports become available; queued first-panel keys retain focus. Formatting initializes separately and is awaited on explicit formatting and format-on-save. Passive help still wakes on its subscription, and the existing file-index prewarm is cancelled on exit. No feature was removed.

## Paired production measurements

Thirty randomized paired blocks per configuration, fresh processes with warm filesystem, same isolated configuration, fixture and responsive 120×40 PTY. Named-file boundary is spawn to both fixture lines, cursor-visibility command and closed synchronized update in terminal output. Immediate `iZ`, Escape and `:wq` verify exact saved bytes. Empty-buffer readiness is a separate Xi frame marker, not a cross-editor comparison.

| Launch | p50 ms | p95 ms | p99/max ms |
|---|---:|---:|---:|
| Xi source, current | 123.37 | 125.16 | 127.25 |
| Xi bytecode, current | 68.07 | 70.29 | 75.32 |
| Xi source, previous lazy-FFI revision | 133.69 | 137.28 | 140.65 |
| Xi compiled, previous lazy-FFI revision | 116.16 | 119.15 | 119.67 |
| Helix | 13.23 | 13.85 | 14.03 |
| Clean pinned Neovim | 11.68 | 12.59 | 13.33 |
| Xi empty, current (separate boundary) | 120.53 | 128.04 | 130.41 |

The source baseline is a pre-edit snapshot of apps/packages and the previously patched OpenTUI package, with shared unchanged dependencies; both commands run from the same working directory. The earlier original unpatched measurements remain in [T122](T122.md): approximately 201 ms empty source median and 185 ms named-file compiled median, from a separate earlier run. They are not part of this final paired experiment.

| First input → Insert-mode output | p50 ms | p95 ms | max ms |
|---|---:|---:|---:|
| Xi source, previous lazy-FFI revision | 15.98 | 17.07 | 17.63 |
| Xi source, current | 11.78 | 12.79 | 13.15 |
| Xi compiled, previous lazy-FFI revision | 11.84 | 12.62 | 12.88 |
| Xi bytecode, current | 12.12 | 14.08 | 14.24 |

The remaining ~12 ms first-input feedback is not a pass of spec 15. Compiled first-input p95 was 1.46 ms higher than its paired baseline in this run; source first input improved. Mode-output detection and eventual exact saved bytes do not substitute for correct-cell latency or the required 10,000-event matrix.

| Xi launch | Median RSS at usable output (MiB) | Median CPU to boundary (ms) |
|---|---:|---:|
| Xi source, previous lazy-FFI revision | 84.76 | 140 |
| Xi source, current | 82.51 | 130 |
| Xi compiled, previous lazy-FFI revision | 92.06 | 120 |
| Xi bytecode, current | 107.19 | 70 |

Bytecode increases executable size from 120,260,928 to 136,710,464 bytes (114.69 → 130.38 MiB) and increases main-process RSS. CPU values use `/proc` scheduler ticks (10 ms resolution), may include runtime threads, and are not allocation totals. No retained-heap/native/worker allocation certification is inferred.

Reproduce with:

```sh
bun run package:build
python3 bench/performance/startup-diagnostic.py .artifacts/NEW-RUN --compiled dist/xi --baseline-compiled .artifacts/startup-profile-2026-09-16/xi-patched --baseline-source .artifacts/startup-stage2-2026-09-16/baseline-source/apps/xi/src/main.ts --samples 30
```

Use the retained baseline executables/source snapshot, not rebuilt current code under the old filenames. Raw results, commands, current source hashes, arrivals, first-key outcomes and ANSI traces: `.artifacts/startup-stage2-2026-09-16/final-paired/comparison.json`. The final binary is retained as `xi-bytecode` in that directory’s parent. `paired/` records the preceding iteration; the final focused-surface transition correction is measured in `final-paired/`.

## Executed validation

| Command/fixture | Actual outcome | Artifact under `.artifacts/startup-stage2-2026-09-16/` |
|---|---|---|
| `bun run check` | Passed pinned toolchain, strict TypeScript, public boundary/DAG and lint | `check-complete.log` |
| `bun run test:ui` | 7 fixtures passed; no snapshot changes | `ui.log` |
| `bun run test:e2e -- --suite interaction` | All 24 fixtures passed on final tree | `e2e-complete.log` |
| `bun run test:startup` and final identity test | Shipping bytecode build; mixed renderer/full/testing native render/dispose; immediate Unicode and 208-character bursts preserved exact bytes on source and bytecode | `startup-tests.log`, `identity.log`; `.artifacts/e2e/t122-startup-input/` |
| `python3 tests/e2e/t055-formatting-pty.py` | Formatter runs on demand, concurrent typing preserved, failed formatting prevents save | `formatting.log` |
| `bun run package:smoke` | Native audit; isolated packaged startup, resize, q/Ctrl-C, Ex save/dirty quit/refusal and restoration passed | `package-smoke.log` |
| Fork `bun run build:lib`, `bun run typecheck`, formatting and lint | Passed | `upstream-build.log`, `upstream-types-final.log`, `upstream-format-check.log`, `upstream-lint.log` |
| Fork focused lazy/materialization/scrollback tests | 19 passed, 0 failed | `upstream-focused.log` |
| Fork `PATH=<Node26>/bin:$PATH bun run test:dist -- --skip-build` | Packed Bun + Node + CommonJS passed, including shared renderer-export identity | `upstream-dist-identity.log` |
| Patch generator `--check`; fresh frozen install; fresh Bun/Node render | Reproducible patch; installed entries/chunks byte-identical to measured install; both runtimes rendered/disposed | `fresh-install.py`, `fresh-install-final.log` |
| `python3 bench/performance/test_startup_diagnostic.py` | 2 matcher regression tests passed | Console output |
| `python3 tools/plan.py check`; `python3 tools/perf.py check` | Valid DAG/reports and 55-budget/1016-obligation catalog; not qualification | Console output |

Current bytecode executable captured in xterm/Xvfb at 100×30: `normal.png` and `search.png`, produced by retained `capture.py`. Visually inspected sidebar, status/cursor placement and the bounded demand-loaded Search overlay. No expected snapshots were changed. These are static virtual-display screenshots, not physical latency evidence.

## Failures encountered and recovery

- Build initially failed with ENOSPC. Verified disposable `/tmp/xi-t064-release-*/xi` executables against their retained manifests before removing them; cleanup list is recorded. The distribution release fixture now removes its temporary directory on exit. Preserved profiling baselines and unrelated files.
- One original mouse-fixture run timed out because its final click left Visual selection and `q` entered a Vim macro prefix. The fixture now explicitly Escapes that final gesture before quitting, retaining every gesture/capture assertion. Final corrected fixture and full interaction suite pass.
- The new renderer identity fixture initially instantiated an abstract TypeScript base; a concrete empty subclass fixes the strict-type failure. Final checks and render pass.
- An initial fresh Node invocation omitted the upstream-required `--experimental-ffi` flag; the corrected fresh Node 26.4 invocation passes. A first screenshot attempt lacked X input focus; corrected capture focuses its own xterm and exits normally.

## Remaining qualification

T122 acceptance is complete. This shared-host diagnostic has no confidence interval/reference-host qualification, physical key-to-visible capture, 10,000-event idle/loaded correctness matrix, complete cold-feature/large-file matrix, or aggregate allocations. Helix remains materially faster. First-use work still needs full tail qualification; compiled bytecode adds memory/size and does not solve input latency.

Prior full upstream failures remain recorded in [T122](T122.md): 13 Bun / 12 Node Kitty/source-asset cases reproduced on unchanged upstream. This follow-on changed only exports/build/patch generation there; affected type/build/packed-runtime/focused tests were rerun, not the entire upstream suite. Native binaries were unchanged; Zig is unavailable. Windows/macOS and physical terminals remain unqualified. No gate or prerequisite was marked complete.
