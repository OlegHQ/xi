# Selection, state recovery and pane resize corrections

- Tickets: T147 (Helix ghost correction), T148 (Visual state and pane geometry).
- Outcome: targeted functional, oracle, frame and real CLI checks passed. Mandatory aggregate latency/resource qualification remains **unproven**; both tickets remain in progress.
- Revision: working tree based on `f90db5c`; substantial pre-existing changes were preserved. Exact changed production-file hashes: `.artifacts/selection-fixes/source-manifest.json`.
- Environment: Linux arm64, Bun 1.3.13, TypeScript 7.0.2, OpenTUI 0.5.11 fork; xterm/Xvfb 120×40, then terminal resize; Helix 24.7 (`079f5442`); pinned Neovim 0.12.4 with verified binary/runtime manifest.
- Contracts: specs 02/08/09, architecture ownership, validation 05, performance 12/15. H1 engine/motion/selection work, H2 viewport painting and input-to-output parent envelopes remain applicable.

## Research and observable behavior

Downloaded and inspected both user screenshots with curl: `.artifacts/selection-fixes/selection.png` and `panels.png`.

Helix uses real selections, not a separate decorative ghost. Its [movement implementation](https://github.com/helix-editor/helix/blob/079a789e8cb08ead67f19e1971a1b7438b37354b/helix-core/src/movement.rs) (`word_move`, `range_to_target`, `reached_target` and the word-motion tests), [selection cursor rules](https://github.com/helix-editor/helix/blob/079a789e8cb08ead67f19e1971a1b7438b37354b/helix-core/src/selection.rs), and command dispatch were read directly. The source revision response and downloaded files are retained under `.artifacts/selection-fixes/helix-*`.

The actual installed Helix was also launched in an isolated PTY for 16 fixtures. `:pipe-to` captured each selected range into a disposable file, including `w`/`W`, `e`, `b`, counts, punctuation, indentation, blank lines, line ends, emoji and combining characters. The checked-in reference is `tests/workbench/helix-word-reference.json`; the executable capture/verification is `tests/e2e/helix-word-reference.py`. Source review and live-reference evidence are distinguished: the live reference is version 24.7, not a claim that the downloaded master source was built.

Xi now computes word ghosts using those half-open range/boundary rules over bounded document windows. `w` selects the word and following spaces, excluding the next word/newline; a new line starts a fresh range. Counts produce the last traversed range. Ordinary h/j/k/l/arrows collapse the ghost, matching Helix normal movement. Find ghosts retain their inclusive resolved range. Xi's actual cursor remains Vim-owned; Normal operators are unchanged, and `v` explicitly adopts the exact ghost. These are Xi presentation semantics, not a switch to Helix's complete editing model.

Visual Ctrl-U/D and cursor-follow scrolling extend the existing anchor. Half-pages use the original cursor once, rather than first clamping it and then moving it again. Host placement clamps to the requested line and a valid Unicode boundary. Visual kind changes and endpoint exchange preserve the selection; repeated Visual entry toggles back to Normal. Text-object result kind and parser mode stay coherent; block text objects keep their block columns.

Unwrapped layout now continues to subsequent logical lines after horizontal clipping. Split-tree changes invalidate the old paint placement. Split drag/cancel notifies declarative chrome so tab strips use the same geometry as the editor.

The CLI captures also exposed a pre-existing red language-sync warning on plain text edits. Wiring now checks the router's existing document-admission map before forwarding a change; unknown direct router changes still fail. Plain buffers no longer report that their language document was closed.

## Executed validation

| Command / fixture | Actual outcome |
|---|---|
| `python3 tests/e2e/helix-word-reference.py` | Captured 16 actual Helix selections; reference verification supported by the same script. Raw PTY bytes retained. |
| `bun run tests/workbench/helix-ghost-reference.test.ts` | All 16 ghost/adopt/delete/undo cases match live Helix selections. |
| `bun run tests/workbench/motion-ghost.test.ts` | Counts, find, Unicode, multi-member adoption, invalidation, strict profile and undo pass. |
| `bun run tests/workbench/visual-recovery-oracle.test.ts` | 18 traces match verified Neovim 0.12.4 text, mode/kind and semantic cursor after input barriers. `.artifacts/selection-fixes/oracle.json`. |
| `bun run tests/workbench/visual-state-recovery.test.ts` | Visual mode matrix, half-page extension, Unicode line clamp, cancelled operator, and 3,000 seeded steps pass. Escape/edit probes remain responsive. |
| `bun run tests/vim/insert-leftovers.test.ts` | Existing literal/register/Insert fixtures pass. |
| Workbench motion, text-object, search-viewport, terminal-key, input-router and pointer-router test files | Passed. Pointer regression also checks chrome notifications on drag and cancellation. |
| `bun run tests/vim/t021/t021.test.ts` and `bun run tests/vim/multi/c3-c9-inclusive-and-preview.test.ts` | Existing Visual geometry/operator and multi-motion comparisons pass. |
| `bun --preload ./packages/ui/src/entrypoints/preload.ts tests/ui/editor-resize-regression.test.ts` | Long lines fill every pane row at 120×40, 150×45 and 90×30 while changing split ratio. Tabs align. |
| Same preload runner for `pane-buffer-strips.test.ts` and `t034-workbench.test.ts` | Pane strips, nesting, layout, resizing and existing shell frame checks pass. |
| `python3 tests/e2e/editor-refinements-visual.py` | Existing actual CLI ghost/adopt/delete/save/undo journey passes with corrected four-character `w` range. |
| `python3 tests/e2e/selection-resize-regression.py` | Actual CLI EOL ghost edit, forward/backward Visual half-page deletion, undo, block/text-object and literal-prompt recovery pass; splitter/nested/terminal resize screenshots captured. |
| `bun run tests/lsp/router.test.ts` | Document admission, change/close routing and unchanged unknown-document rejection pass. |
| `bun run check` | Toolchain, strict types, architecture/public boundaries and performance lint pass. |
| `python3 tools/plan.py check`; `python3 tools/perf.py check` | Backlog/catalog structure valid; no implication of measurement qualification. |

## Reproduced failures and recovery

- Original `<C-v>iw` threw `xi-parser:mode-selection-mismatch`: the text-object owner and session disagreed. Fixed at the owning result/kind and geometry boundaries; the pinned oracle also checks subsequent delete/undo.
- Seed 41027 found an Insert literal prompt crash, minimized to `i<C-v>u<Up>`. Neovim inserts `<Up>` literally when no numeric digits were entered. Xi now does the same. Register-name arrow cancellation and digraph Escape cancellation are also pinned and recoverable.
- A memoized parser could retain an operator even after `cancelPendingOperator`. Parser reuse now requires no pending input; the next `w` cannot become an unintended `dw`.
- The original viewport broke its row loop when an unwrapped long line was clipped. The regression checks every subsequent row, not only the first line.
- The oracle harness drains typed input: incomplete prefixes must be submitted together (`iw`) and Insert episodes include their terminating Escape. Splitting those across drained snapshots produced misleading expectations; the test was corrected explicitly.
- Source TSX tests must preload the production Solid transform. A plain `bun run` rendered nonreactive JSX and gave a stale-status-row false failure; the recorded frame runs use the correct preload.

## Visual and performance evidence

Inspected actual PNGs: `word-at-eol.png` highlights only `two` on the preceding line while the Vim cursor is on the next line; `visual-line-half-page.png` shows the selected destination line. `split-after-drag.png`, `nested-after-drag.png`, and `terminal-resized.png` show all pane rows filled and tab strips aligned with their pane edges. Files are under `.artifacts/selection-fixes/`; prior theme/ghost captures remain under `.artifacts/ui/editor-refinements/`.

No input debounce, runtime oracle, new dependency or second mutable text store was introduced. Source word reads use bounded windows; painting remains viewport-bounded and only split geometry changes force a complete repaint.

Absolute/paired engine and actual CLI latency, service-loaded runs, physical key-to-visible calibration, allocation/retained/native memory and qualification sample counts were not measured here. Catalog validation and functional screenshots do not certify those gates. The 3,000 deterministic steps demonstrate the tested recovery sequences, not a proof that every possible editor state is safe. Continue T147/T148 qualification under specs 12/15 before marking either ticket done.
