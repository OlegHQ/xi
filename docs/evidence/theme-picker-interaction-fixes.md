# Theme picker interaction fixes

- Ticket: T132 / T039 regression repair requested 2026-09-20.
- Outcome: behavioral checks passed; release performance qualification remains unproven.
- Revision: working tree based on `f90db5c`, preserving pre-existing theme/config/UI changes.
- Environment: Linux arm64, Bun 1.3.13, TypeScript 7.0.2, installed OpenTUI 0.5.11 fork;
  real xterm under Xvfb with DejaVu Sans Mono 10 for screenshots.
- Contract: UX theme picker, E16, panel pointer routing and viewport geometry.

## Observable result

Production hover now reaches the controller's theme preview callback. Clicking a theme
applies that entry before committing, even without a prior hover. Opening reveals the
current theme. Ctrl-N/P step one row; Ctrl-U/D step half the measured visible result rows;
PageUp/Down step a full viewport. Escape restores the original theme. Persistence captures
the committed id before asynchronous directory creation, so a new preview cannot leak to disk.

The shared row surface measures its interior separately from its border, header and footer.
The picker uses its full interior height rather than a 20-row limit. The footer stays at the
bottom, the scrollbar paints above row backgrounds, and narrow bounds fit the terminal.
Resize/reopen reveal the selected row. Solid Index preserves row widgets during updates,
preventing bursts of wheel input from losing their hit targets between frames.

## Executed validation

| Command / fixture | Actual result |
|---|---|
| `bun run check` | Passed toolchain, strict types, architecture/public boundary and lint. |
| `bun test tests/ui/theme-picker-layout.test.ts tests/ui/panel-scroll-follow.test.ts tests/ui/t063-surface-matrix.test.ts tests/ui/sidebar-tabs.test.ts tests/workbench/t116-picker-controller.test.ts tests/workbench/t116-pointer-router.test.ts` | All top-level assertion fixtures passed; these files do not register Bun `test()` counts. |
| `bun test tests/e2e/t039-picker.test.ts` (included in initial seven-file run) | Passed functional query/cancellation/identity assertions; printed 83 ms for its 50k-path warm query. This is not a performance pass. |
| `python3 tests/e2e/t132-theme-switch-pty.py` | Passed actual CLI hover on two exact rows, keyboard preview, cancel, commit, other-surface theme consistency and cross-launch persistence. |
| `python3 tests/e2e/t132-custom-theme-pty.py` | Passed valid custom themes, invalid-theme diagnostics and missing-file fallback. |
| `python3 tests/e2e/t129-panel-scroll-picker-search-pty.py` | Passed actual CLI picker and Search wheel scrolling. |
| `python3 tests/e2e/theme-picker-visual.py` | Captured wide/current theme, half-page navigation, dark preview, narrow resize and cancel; source bytes and persisted theme unchanged by preview/cancel. |
| `git diff --check` | Passed. |
| `python3 tools/perf.py check` | Catalog valid; 55 budgets / 1016 obligations. Does not certify measurements. |

## Performance and visual evidence

Reviewed real xterm screenshots under `.artifacts/ui/theme-picker/`: `current-theme.png`,
`dark-preview.png`, `narrow.png`. The 62-theme fixture opens on fixture-50, previews fixture-51
in dark colors, uses all 26 available result rows at 120x40, and retains selection and complete
Apply/Restore hints after narrowing. Scrollbar is visible above list rows. The fixture's very
minimal light palette has a faint frame; no rows overlap it. `half-page-up.png` and `cancel.png`
are also retained. Earlier visual-fixture inheritance references were invalid; replaced with
self-contained valid theme files and reran before accepting screenshots.

Relevant owners/classes: workbench control/input H1/C and UI visible-row rendering;
INPUT-OUTPUT, RENDER, MAIN-STALL and picker lifetime/query budgets remain inherited.
Catalog hash: `1129c2799ffa38d6980cee5ad84d1f9bca9b16307f1ae3ce396f14b2fa25aa51`.
No new worker, cache or dependency. Painting remains bounded to viewport rows.
No paired baseline, latency percentiles/maxima, allocation/RSS qualification, loaded-input
matrix or calibrated physical measurement was run. No release-speed claim is made.

## Failure cases and recovery

Regression fixtures cover direct click without preview, Escape after multiple previews,
pending persistence versus a later preview, selection near the end of a long list, narrow
resize, reopening after scrolling away, frame clicks, same-row hover and wheel bursts.
The wheel fixture initially failed: one update destroyed hit targets, and the scrollbar
was hidden by rows. Index row reuse and explicit scrollbar stacking corrected those defects.
The PTY thumb assertion was updated for the actual bordered interior column and visible glyph;
the same scrolling assertion then passed. No test or budget was disabled.

## Limitations

This closes the reported behavioral regression, not all T039/T132 or release qualification.
Backlog statuses and prior evidence are unchanged. Broader performance measurements listed
above remain with their existing owning tickets. No engine semantics changed, so no Neovim
oracle run was required for these picker-specific navigation bindings.
