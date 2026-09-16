# T005 decision: owned Vim pattern strategy

- Status: feasibility decision; production implementation remains unproven.
- Oracle: pinned Neovim 0.12.4, executable SHA-256 `d9635db0b272b7c81cd705ef0d8bbf16edfeb05b08b36b4228ab0d6a92ec384f`; runtime-doc tree SHA-256 `79b80909bf8f5fe1d89a0fb66200388e651c88d49d565fdc51780ef4b24d7b1e`.
- Source help: the pinned `runtime/doc/pattern.txt` and `runtime/doc/change.txt`; upstream [Neovim pattern help](https://neovim.io/doc/user/pattern/).

## Decision

Xi will own a Vim-dialect parser and explicit pattern IR. Do not translate Vim syntax to JavaScript `RegExp`, and do not use Neovim in a product runtime. The T005 recursive-descent parser and bounded AST evaluator demonstrate a feasible route for a deliberately small syntax subset; they are disposable spike code, not production dependencies.

T026 owns production parsing and evaluation. Its regular subset must use a bounded NFA path; features such as backreferences and assertions may use bounded backtracking where needed. Both paths must return typed, source-located errors on unsupported syntax, budget exhaustion, cancellation and output limits. Evaluation must be resumable/cooperatively cancellable over an immutable, versioned document snapshot. T027 owns search/substitution state and replacement/command integration. The complete acceptance route is listed in the [pattern requirement inventory](../../spikes/vim-pattern/requirements.md); T061 continues the global help-index audit.

## Feasibility evidence

The prototype parses magic switches, literals, common classes, captures, alternation, simple greedy/lazy quantifiers, backreferences, four lookaround forms, newline-inclusive atoms, word/line/file anchors, cursor/line position atoms and `\zs`/`\ze`. It rejects the recognized but unsupported `\%#=2` selector with a typed source span (`PATT-UNSUPPORTED-ENGINE-01`). The evaluator stores reported ranges separately from consumed offsets, maps UTF-8 cursor byte columns at valid character boundaries into its UTF-16-offset prototype, bounds AST work and output count, and checks a cancellation callback at configured step intervals. It uses no native JS regex translation or replacement.

All 16 substitution fixtures matched the pinned oracle's resulting lines: `PATT-MAGIC-01`, `PATT-MAGIC-SWITCH-01`, `PATT-BACKREF-01`, `PATT-LOOKAHEAD-01`, `PATT-NEGATIVE-LOOKAHEAD-01`, `PATT-LOOKBEHIND-01`, `PATT-NEGATIVE-LOOKBEHIND-01`, `PATT-ZS-01`, `PATT-ZE-01`, `PATT-ZERO-01`, `PATT-NEWLINE-01`, `PATT-EMPTY-01`, `PATT-POSITION-FILE-01`, `PATT-POSITION-LINE-01`, `PATT-POSITION-CURSOR-01` and `PATT-POSITION-CURSOR-UNICODE-01`. These compare observable substitute output, not the oracle's private regex spans or engine state; direct span/capture/error parity remains a T026 requirement.

The latest reproducibility run of the known expensive case `PATT-CATASTROPHIC-01` stopped at 50,001 counted AST steps for a 50,000-step budget, in 25,570.070 µs. `PATT-ZERO-LOOP-01` terminated with offsets `[0, 2]` in 8 counted steps, and `PATT-EMPTY-01` matched the oracle's multiline output. `PATT-CANCEL-01` cancelled on the eighth callback at 512 steps in each of 31 runs; latest elapsed time was p50 211.792 µs, p95 414.334 µs and max 2,269.752 µs on the recorded host. These are in-process spike measurements, not input-to-paint latency or a release budget.

## Unresolved requirements and limits

The inventory is exhaustive enough to route the surfaced constructs, not to replace the later help-index audit. Notable unimplemented or partial areas include branch intersection `\&`, atomic `\@>`, the full quantifier/magic precedence matrix, POSIX and option-dependent classes (`iskeyword`, `isident`, `isfname`, `isprint`), Vim's complete Unicode/case-fold behavior, Visual/mark/byte/virtual-column positions, engine selectors, numeric/combining-character atoms, the complete replacement language, and search command flags, ranges, offsets, direction and state. Lookbehind is artificially limited to a statically measured width of at most 1,024 UTF-16 units and does not implement Vim's line-based lookbehind semantics.

The evaluator is synchronous bounded backtracking even for regular patterns. It materializes a complete input string and scans it to build a line-start table for each evaluation; candidate attempts also rescan by offset. The cancellation predicate is polled at step boundaries but cannot yield the event loop, so the latency sample must not be read as UI responsiveness. Pathological alternations can allocate many candidate states before a work limit fires. T026 must evaluate immutable document snapshots without whole-document materialization/scans on a keystroke path, add the regular NFA path, cooperative slicing, state-preserving timeout behavior and allocation/resource tests before the production architecture is accepted.

The evaluator and source-span offsets use UTF-16 code units. Only the oracle-fixture adapter converts UTF-8 byte columns, and it rejects positions inside a multibyte code point. The prototype's ASCII word class, case folding and class-negation behavior need expanded Unicode/option differential tests. No full parity claim follows from the 16 fixture results.

## Reproduction

Run `bun run ./spikes/vim-pattern/probe.ts` with the verified pinned oracle bundle. It writes `.artifacts/patterns/T005-results.json`. The fixtures, candidate implementation and result artifact are respectively `tests/fixtures/vim/T005-pattern-cases.json`, `spikes/vim-pattern/` and `.artifacts/patterns/T005-results.json`.
