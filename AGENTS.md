# Xi contributor contract

Xi is a Bun, strict-TypeScript and OpenTUI terminal editor with an owned Vim engine.
Neovim and Helix are development references only; neither may become a runtime process,
library, remote connection or fallback.

## Current direction

The active product scope is [Helix configuration parity](docs/configuration.md). The
machine-readable [configuration ledger](docs/configuration-ledger.json) is the progress
authority; `bun run check:config-ledger` enforces it. Do not recreate the retired
milestone/ticket ledger or per-ticket evidence archive. A config item is complete only
when its Helix spelling, type, accepted values, default and launched-editor effect agree
and every required ledger dimension names a committed test. Parse-only support is not
parity.

Xi is not rebuilding Helix's editing model. Neovim remains the oracle for Vim modes,
motions, operators, registers, repeat, search and undo. Helix is the oracle for
`config.toml` and for 1:1 multi-selection semantics: selection creation, primary identity,
direction, merge/deduplication, document mapping and simultaneous edits. Helix keybindings
and general modal commands are out of scope unless separately requested.

Use `.agents/skills/xi-implement/SKILL.md` for product changes, `xi-vim-parity` for Vim
semantics, and `xi-validate` for behavioral, PTY, visual or performance validation. Read
only the relevant contracts in `docs/` and the code you are changing.

Use Ponytail whenever changing code: understand the full path, reuse what exists, prefer
stdlib/native features and make the smallest root-cause change. No speculative
abstractions, dependencies or scaffolding.

## Ownership

Follow [architecture](docs/architecture.md). The document package is the only mutable text
owner. Vim produces transactions through document APIs. Services never mutate buffers
directly; UI never implements motion/range/edit semantics. Platform effects pass through
typed ports. OpenTUI stays in the UI adapter. No synchronous process/filesystem calls,
whole-document scans or duplicate writable text stores in a keystroke path.

Use `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`useUnknownInCatchVariables`, `noImplicitOverride` and `noFallthroughCasesInSwitch` with
the pinned TypeScript compiler. Validate unknown data at config, protocol, persistence and
process boundaries. Public coordinates state units and document versions.

## Performance

Read [the performance contract](docs/performance.md) before changing input, rendering,
loading or background work. Ordinary engine steps must meet p95 ≤1 ms / p99 ≤2 ms. CLI
input-to-correct-output must meet p50 ≤4 ms / p95 ≤8 ms / p99 ≤16 ms / max ≤25 ms idle
and loaded, with no Xi-attributable ordinary stall above 8 ms. Preserve exact input,
Unicode, Vim semantics and recovery while optimizing.

No input debounce, blocking service work, unbounded copying or growing input backlog.
Background work is bounded and cancellable. Missing or noisy measurements remain
unproven; never weaken a budget or disable a feature to claim success.

### Open audit: loaded CLI latency

`.artifacts/config-audit/AUDIT.md` is not fully closed. Its remaining release gate is the
`docs/performance.md` requirement that Xi's key-to-correct-terminal-output p95 be within
3 ms of clean pinned Neovim on the same host and corpus, including a loaded 10 MiB file.
The measurement writes each key to a real PTY and stops when the correct edited cell is
observed; it is not physical keyboard-to-screen latency.

Commit `df95a39` removed OpenTUI's 1 ms request-frame throttle. The full
`bun run verify:release`, `bun run package:build`, and `bun run package:smoke` then passed.
Packaged Xi idle p95 was 2.711 ms. Loaded packaged Xi p95 was 3.618 and 3.899 ms across
two 1,000-key runs; paired loaded Neovim p95 was 0.591 ms. The first pair misses the
relative limit by 0.027 ms, and the second misses it more. Source runs also varied, so
the loaded comparison is unproven even though the absolute CLI budgets pass. Raw reports
are under `.artifacts/config-audit/latency-*.json` and are not committed.

Resume with `python3 tests/support/input-latency-pty.py --pairs 500 --file-bytes 10000000
--binary dist/xi --output .artifacts/config-audit/latency-next.json` and the same command
with `--nvim` instead of `--binary dist/xi`. Investigate the loaded path and host variance,
make a root-cause fix if needed, then repeat paired idle/loaded measurements and the
affected release/package checks. Do not declare the audit complete from one borderline run.

## Validation and changes

Follow [testing](docs/testing.md). Run checks proportional to the change, including a real
CLI PTY for user-visible behavior and visual inspection for UI output. A green component
test does not certify the production path. Do not disable tests or approve snapshots
without inspection.

Keep complete reviewable commits when authorized. Git history is the evidence archive;
do not add per-ticket reports back to the tree. Store large traces under `.artifacts/` and
never commit personal workspace data, recovery files or private LSP logs. Preserve
`agentpack.toml` and `pack.lock`; never push or configure a remote without authorization.

`.claude/skills` is a symlink to `.agents/skills`. Run `bun run skills:sync` after changing
a skill and never edit the two trees independently.
