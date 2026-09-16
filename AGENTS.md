# Xi implementation contract

## Product requirements

Bun, strict TypeScript, OpenTUI. Xi owns its Vim engine. Neovim is a development oracle only; no runtime Neovim process, library, remote connection, or fallback. Implement the plan in docs/plan. Performance, keyboard UX, Vim correctness, and architecture are release requirements, not later polish.

This is initially a planning repository. Product code and test commands described in the plan are future work unless the corresponding ticket has evidence. Do not claim they already exist.

## Native-level speed and snappiness

Xi must feel blazingly fast: immediate keystrokes, cursor movement, mouse interaction, startup and file loading, including while LSP, syntax, search, Git and tasks are active. This is a product requirement for every relevant implementation decision. Read `docs/plan/15-keystroke-latency.md`, the applicable bounds in `docs/plan/05-validation.md`, and the owner/resource budgets in `docs/plan/12-performance.md` before changing an input, rendering, loading or background-work path.

Ordinary engine steps must meet p95 ≤1 ms / p99 ≤2 ms. Actual CLI input to correct terminal output must meet p50 ≤4 ms / p95 ≤8 ms / p99 ≤16 ms / observed max ≤25 ms, both idle and under service load. No Xi-attributable ordinary interactive stall may exceed 8 ms. Physical key-to-visible response is a separate calibrated gate; process timestamps are not visible latency. Large-file and multi-cursor workloads retain their explicit contracts; ordinary edits cannot be relabeled as batch operations to escape limits.

Loading must reach a correct usable editor quickly: warm startup p95 ≤150 ms, process-cold/filesystem-warm startup p95 ≤300 ms, opening 1 MiB p95 ≤100 ms, 10 MiB normal-line files p95 ≤250 ms, and a 100 MiB first viewport ≤1 s. Input must work immediately at the usable viewport; do not wait for language servers, grammars, indexing or full-file background work. These are measured targets, not claims of current speed.

“Native-level” requires paired measurements against clean pinned Neovim on the same host, terminal, corpus and completion boundary, while satisfying Xi's absolute budgets. Keystroke p95 overhead must stay ≤3 ms above Neovim. Report startup/open comparisons too; a fast kernel, average-only result, empty shell, fake acknowledgment or component test cannot certify the running editor. Preserve all keys, exact text, Unicode, Vim semantics and recovery behavior while optimizing.

Measure tails and maxima, cold/first-key behavior, held arrows, bursts, GC, long lines and simultaneous background activity through the actual production path. No input debounce, blocking service work, unbounded copying or growing input backlog. Keep background CPU work bounded and cancellable. Missing measurements, unexplained stalls or significant regressions leave the relevant ticket/gate unproven; never weaken budgets or disable features to declare success.

## Starting work

Use `.agents/skills/xi-implement/SKILL.md` for ticket implementation. Use `xi-vim-parity` for engine semantics and `xi-validate` for relevant behavioral, PTY, or performance validation. Read only the relevant specifications after reading `docs/plan/06-execution.md`. `python3 tools/plan.py next` lists tickets whose dependencies are done. `show ID` prints the full contract. Never mark a prerequisite done merely to unlock a ticket.

Keep tickets small. A ticket that cannot be independently reviewed should be split with acceptance checks and dependency edges preserved. New discoveries update the relevant specification and backlog; they do not silently narrow parity or performance requirements.

## Ownership

Follow `docs/plan/01-architecture.md`. The document package is the sole mutable text owner. Vim produces transactions through document APIs. Services never mutate buffers directly; UI never implements motion/range/edit semantics. Platform effects pass through typed ports. OpenTUI is confined to the UI adapter. No synchronous process/filesystem calls or whole-document scans in a keystroke path. No duplicate writable text store inside an OpenTUI input widget.

Use `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, `noImplicitOverride`, and `noFallthroughCasesInSwitch`; enforce with a pinned TypeScript compiler. Bun running a .ts file is not type checking. Validate unknown data at process/config/protocol/persistence boundaries. Core public contracts must state coordinate units and document versions.

## Evidence and changes

Each completed ticket needs its listed acceptance checks and a report at `docs/evidence/<ticket>.md`, using `docs/plan/evidence-template.md`. Report executed commands, actual outcomes, relevant fixture IDs, environment and revision, limitations, and artifact paths. Store large raw traces under `.artifacts/` and summarize or link retained CI artifacts. Do not commit personal workspace contents or raw private LSP logs.

A failing required test, unmeasured mandatory budget, unexplained snapshot change, or missing oracle is not a pass. Do not disable tests, weaken thresholds, replace production paths with test-only behavior, or approve snapshots without visual inspection. Test harness defects are fixed explicitly with reproductions. Gate status remains unproven until rerun.

Use local commits for complete reviewable units when authorized; never push or configure a remote without authorization. Preserve agentpack.toml and pack.lock. Changes to this guide or the plan must preserve the latest explicit user requirements. Reference ~/.config/nvim as research data only; do not modify or execute the personal configuration.
