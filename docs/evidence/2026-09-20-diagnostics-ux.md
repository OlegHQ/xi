# Diagnostics UX follow-up

- Scope: user-requested T049/T039 presentation follow-up and last-buffer/scratch lifecycle maintenance.
- Outcome: behavioral and visual checks passed; full performance qualification unproven.
- Revision: working tree based on `3895d07`; the stale tracked recovery file is removed.
- Environment: Linux, Bun 1.3.13, pinned TypeScript 7.0.2, OpenTUI 0.5.11; real typescript-language-server, xterm/Xvfb.
- Contracts: architecture document ownership; UX diagnostics/pickers/focus; E07; existing RENDER, INPUT-OUTPUT, INPUT-LOADED and DIAGNOSTICS resource requirements remain unchanged.

## Observable result

The existing DiagnosticStore feeds editor gutters and wrapped, severity-colored virtual
lines beneath source, including multiple messages at one position. Existing layout filler
rows provide immutable non-editable hit maps, source/virtual-row separation and cursor
projection. Only diagnostics in the logical viewport are considered, message/prefix reads
are bounded, and versioned stale positions are suppressed.

`Space d` opens a diagnostic mode in the existing picker, using BufferPickerProvider,
query cancellation, paging, selection and the shared Solid row surfaces. Messages/codes
and paths filter; Enter uses ProblemsController's existing source navigation; Escape
does not preview-open files or move the editor cursor. The shared preview also serves
the file picker. Live buffers use bounded snapshot reads, so previews include unsaved
text. Narrow terminals omit the preview. `Space e` still opens Problems.

Inspection found an existing Problems repaint defect: controller open/close/selection
changes did not notify the Solid surface. Fixed in the owning controller, and the real
mouse activation fixture now passes.

`:q` after the last view closes returns the existing application quit result. Committed
file opens and preview promotion remove empty clean scratch buffers through BufferHost's
normal cleanup path. Dirty/nonempty scratch buffers and pending preview cancellation
remain protected. No new dependency, language engine or editable text store was added.

## Executed validation

| Command / fixture | Actual result |
|---|---|
| `bun run test:ui` | All 27 discovered fixtures passed, including inline diagnostic rows, clearing, noneditable hit targets, hostile-message bounds and stale positions. |
| `bun test tests/workbench/t116-buffer-host.test.ts tests/workbench/t116-picker-controller.test.ts tests/workbench/t116-host-commands.test.ts tests/workbench/t116-problems-controller.test.ts tests/services/t-buffer-picker.test.ts` | Passed; new scratch replacement, preview promotion, diagnostic activation/refresh and stale navigation checks included. |
| `bun test tests/config/t036-config.test.ts tests/lsp/t049-push-pty.test.ts tests/lsp/t049-diagnostics.test.ts` | Passed config validation, real transport decoding, stale rejection, aggregation, cleanup and per-URI admission/component timing. |
| `python3 tests/e2e/diagnostics-picker-pty.py` | Passed real TypeScript inline diagnostics, empty filter, cancel, exact source-column jump verified by saved bytes, last-buffer quit, clean scratch replacement and dirty scratch refusal/preservation. |
| `python3 tests/e2e/t039-picker-pty.py` | Passed existing file query/preview/cancel restoration. |
| `python3 tests/e2e/t049-problems-pty.py` | Passed retained Problems route, now invoked with `Space e`. |
| `python3 tests/e2e/t127-problems-live-diagnostics-pty.py` | Passed real TypeScript publish and mouse activation after fixing the missing repaint notification. |
| `python3 tests/e2e/diagnostics-visual.py` | Real xterm captures reviewed: light/dark inline errors/hints, Problems, picker, filtered result, jump and narrow picker. |
| `bun run check:public-boundary`, `bun run check:lint`, `bun run check:types` | Passed. |
| `python3 tools/perf.py check` | Catalog valid: 55 budgets, 1,016 obligations; not measurement certification. |
| `python3 bench/performance/t045-typing-under-load.py .artifacts/diagnostics-search-load.json` | Failed: no terminal escape output observed for ordinary `j` under search load. No latency result or pass claimed. |

## Performance and visual evidence

Screenshots: `.artifacts/ui/diagnostics/{inline,inline-dark,problems,picker,picker-dark,filtered,jump,narrow}.png`.
PTY traces: `.artifacts/e2e/diagnostics/{diagnostics,scratch-False,scratch-True}.ansi`.
No private workspace text or LSP logs are included in these disposable-fixture artifacts.

The existing 20-sample per-URI diagnostic publish component probe observed wall times
0.878–1.229 ms and CPU times 0.878–2.061 ms on one run. Its minimum-based assertion passed;
the CPU maximum exceeds the catalog's 2 ms integration target, and 20 samples do not meet
the required 30. This is not a performance pass. No new p50/p95/p99, paired baseline,
allocation/RSS/queue or physical-display qualification was collected. The search-load
probe failure above also leaves loaded input latency unproven.

## Failure cases and recovery

During fixture development, an incorrect expected source length (36 vs 37) was corrected
to the literal source length. The PTY save fixture initially encountered the default
missing `biome` formatter; its isolated language config now disables auto-format so it
tests navigation/save without requiring an unrelated formatter. A mistyped server config
name was corrected to the existing `typescript` configuration and the PTY was rerun.
The first Problems mouse test genuinely failed because its surface never appeared;
controller wake notifications fixed the production defect and the fixture passed on rerun.

## Limitations and next action

Existing mandatory native-speed gates remain unproven: rerun the actual production
loaded-input benchmark with a working search fixture and the T106/T115 reference-host
protocol. Do not treat the successful UI/PTY checks as a release or performance pass.
Inline output is viewport-bounded; very long messages can occupy the visible area.
The existing closed-file preview fallback retains its bounded head-of-file behavior;
live diagnostic documents preview around the selected source line. No ticket prerequisite
or numerical budget was relaxed, and no new performance ticket was marked complete.
