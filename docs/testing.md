# Testing

The test tree is the durable evidence. Historical milestone reports and their ticket
ledger were removed after commit `ab211d5`; Git history remains the archive.

Run the smallest relevant checks while iterating, then the owner suite and strict checks:

```sh
bun run check
bun run test:unit
bun run test:services
bun run test:ui
bun run test:e2e -- --suite interaction
```

`bun run test:vim` uses the pinned Neovim bundle in `tests/oracle/manifest.json` as a
development oracle. Xi never invokes Neovim at runtime. UI work needs both renderable
tests and a real CLI PTY journey. Inspect generated screenshots rather than accepting a
snapshot by filename. Filesystem, LSP and Git tests use disposable roots and cover stale
responses, cancellation, malformed input and process failure.

`bun run verify:release` also runs `bun run ./tools/verify-suite.ts vim --suite config`
for Vim-owned configuration evidence. Its interaction gate rejects any ledger test file
that the release suites do not select.

Tests should describe behavior even when an older filename still contains a retired
ticket number. Rename such files when they are already being substantially edited; do not
delete a useful regression merely to remove historical naming.

For configuration parity, validate three distinct facts:

1. The pinned Helix reference accepts the canonical fixture.
2. Xi accepts the same key, type, enum and default.
3. The launched Xi editor visibly applies the value.

A parser-only assertion proves only parsing. Unknown keys, wrong types, invalid enum
values and unsafe workspace executable settings need negative tests. Reference Helix
binaries and source checkouts live under ignored `.artifacts/reference/helix/`; no external
editor is a Xi runtime dependency.
The master trust reference PTY uses the `hx` binary at pinned commit `079a789e8cb08ead67f19e1971a1b7438b37354b`.
Build it in `.artifacts/reference/helix/master` with
`HELIX_DISABLE_AUTO_GRAMMAR_BUILD=1 cargo build --locked --release -p helix-term`
after expanding the sparse checkout.

Every config change updates [`configuration-ledger.json`](configuration-ledger.json).
`bun run check:config-ledger` rejects duplicate or unsealed inventory entries, fixture
paths missing from the ledger, invalid status transitions, nonexistent evidence and an
`effective` claim without schema, default, runtime, invalid-input, unit, PTY and Helix
tests. Xi-only extensions require the same dimensions except Helix comparison.
An anchored evidence reference must name one unique assertion label. Bare paths are
reserved for dedicated config PTYs; the interaction gate checks that every referenced
file is selected by a release suite.

Performance checks follow [performance.md](performance.md). A clean component benchmark
cannot certify the production CLI, and a noisy or missing measurement is unproven rather
than passed.

For startup work, measure the ordinary source command and packaged executable separately
through a responsive PTY:

```sh
python3 tests/support/startup-ready-pty.py --source --samples 30 --output .artifacts/source-startup.json
python3 tests/support/startup-ready-pty.py --binary dist/xi --samples 30 --output .artifacts/package-startup.json
python3 tests/support/picker-latency-pty.py --source --samples 20 --output .artifacts/picker-source.json
python3 tests/support/lsp-ready-pty.py --source --samples 20 --output .artifacts/lsp-source.json
```

Run timing jobs sequentially on the same host; concurrent profiles and checks can move
these tails by tens of milliseconds. The harnesses warm their fixture/cache once and
record the real command, corpus and per-run values. `XI_STARTUP_TRACE` provides stage
times, while [Bun's CPU profiler](https://bun.com/docs/project/benchmarking#cpu-profiling)
helps locate source import costs. `bun --cpu-prof-md --cpu-prof-dir=.artifacts run apps/xi/src/main.ts --help`
isolates pre-`main()` loading. A `--help` profile cannot
prove first-frame speed, and a profiler changes timing; use the PTY measurements for
release claims. Bun's runtime transpiler cache stores transformed source, but [ESM
bytecode that skips parsing requires compilation](https://bun.com/docs/bundler/bytecode#esm-bytecode),
so it cannot stand in for the ordinary source-run check.
For picker latency after Explorer has populated, add `--settle-ms 500`; the PTY is
drained during that interval so queued terminal output does not inflate the key timing.
