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

Performance checks follow [performance.md](performance.md). A clean component benchmark
cannot certify the production CLI, and a noisy or missing measurement is unproven rather
than passed.
