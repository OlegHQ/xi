# Neovim compatibility inventory

`neovim-0.12.4.json` is the generated command-index seed for Xi's pinned singleton oracle. It covers the released runtime's Insert, Normal, operator-pending and Visual indexes, and records the exact index/runtime hashes used to generate it.

The inventory deliberately retains `unimplemented` status for every seed row. T016 attaches its pinned cursor-motion fixture IDs to the relevant Normal-mode rows and records the measured snapshots in [t016-oracle-traces.json](t016-oracle-traces.json); these fixtures establish only their recorded option and input cases. The listed option names are candidates from the owning ticket's contract, not passed option matrices. `optionMatrix.review` and `dependencyReview` remain unexpanded until the owning behavior has a complete differential review. Text objects are recorded for both operator-pending and Visual use, matching the help index's scope. Screen-relative `H`, `M`, and `L` belong to T031; `0` is assigned to T016 because it is a line motion, even though the parser also recognizes that key.

Rows already covered by a concrete implementation ticket point to that ticket. Unclassified rows stay attached to T061's compatibility audit, which must assign concrete implementation work or a documented boundary before release. T061 must reconcile the inventory against the pinned help indexes; the generated row count is not a claim that the index is complete for every runtime behavior.

Fetch and validate the pinned Linux ARM64 release, then regenerate the seed:

```sh
bun run oracle:fetch
bun run oracle:inventory
bun run test:vim
```

Oracle execution uses `--clean -u NONE -i NONE --noplugin`, a temporary `HOME`, isolated XDG directories, `C.UTF-8`, UTF-8 text, Unix EOLs, single-width ambiguous characters and plain buffers. The binary and all runtime documentation are hash-checked before use. `XI_NVIM` may select a local binary for negative integrity checks, but it must match the pinned binary hash to run fixtures.
