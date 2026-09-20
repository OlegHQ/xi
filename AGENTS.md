# Xi contributor contract

Xi is a Bun, strict-TypeScript and OpenTUI terminal editor with an owned Vim engine.
Neovim and Helix are development references only; neither may become a runtime process,
library, remote connection or fallback.

## Current direction

The active product scope is [Helix configuration parity](docs/configuration.md). The parity
matrix is the roadmap. Do not recreate the retired milestone/ticket ledger or per-ticket
evidence archive. A config key is complete only when its Helix spelling, type, accepted
values, default and launched-editor effect agree; parse-only support is not parity.

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
