# Implementation execution

The canonical backlog is [tickets.json](tickets.json). Each ticket contains dependency IDs, one owner, allowed paths, implementation steps, acceptance checks, failure cases and required evidence. The small local runner makes readiness inspectable without an issue tracker:

```sh
python3 tools/plan.py check
python3 tools/plan.py next
python3 tools/plan.py show T001
```

The runner validates the dependency graph and report references; it does not certify test truth. Initial tickets are all `todo`. The repository has no editor implementation, product dependencies or passing gates yet. Agentpack files are preserved. Local Git is initialized independently of any hosting service.

## Work protocol

Select the first ready ticket unless an assignment names another ready ticket. Read its referenced spec and relevant local skill. Inspect the current tree before creating paths; adapt structure only within the ownership contract. Record current state and a concrete expected behavior, then implement the smallest reviewable slice. Run the specified success and failure cases plus applicable architecture/performance checks. Inspect actual UI output for visual changes.

Do not start a dependent ticket until prerequisites have completed evidence. Independent tickets can be implemented in a different order; that is not permission to delegate or create agents automatically. Each assigned implementation agent can work serially from the ready list. A large ticket discovered during work should be split into stable child IDs with dependencies, owner, acceptance and evidence; update downstream edges before proceeding. Never create a generic “finish the rest” task that hides unimplemented Vim commands.

Ticket status values are `todo`, `in_progress`, `blocked`, `done`. `blocked` needs a specific missing fact/failure and next resolution action. `done` requires a checked-in report path, all acceptance checks and dependency completion. Update JSON deliberately; the runner offers no auto-complete command because file existence cannot establish acceptance. A failed check stays visible in the report until repaired and rerun.

Each report uses [evidence-template.md](evidence-template.md). Each implementation commit is a complete reviewable unit; references ticket ID and includes code/tests/evidence summary together. Do not mark a whole milestone complete based on one component screenshot. If the build cannot run, report it accurately and resolve that prerequisite instead of simulating success.

## Reading order by work type

| Work | Required specs / skills |
|---|---|
| Any implementation | AGENTS, ticket, architecture, xi-implement |
| Document/input/Vim/layout | Vim + validation; xi-vim-parity |
| Panel/picker/theme/focus | UX + validation; xi-validate for PTY and visual evidence |
| LSP/search/files/Git/config | Services + relevant UX journey + validation |
| Performance/release | All affected gates and evidence; xi-validate |

## Milestone stop rules

G0 is a deliberate feasibility checkpoint: prototypes are disposable and cannot become unchecked production dependencies. It locks actual stack versions, text representation, keyboard boundary and regex strategy based on evidence. G1 locks the core public contracts. G2 certifies an editing preview and tracks incomplete parity. G3/G4/G5 certify complete workbench/language/tool families. G6 alone permits the release claims in the brief.

The plan has parallelizable architectural work but serial execution is the default. Building panels while the engine cannot preserve transaction/position invariants creates throwaway glue, so the main path puts those foundations first. Language transport prototyping can occur independently but its edit application waits for document/workbench ownership to exist.

## Definition of done

A ticket is done when its observable behavior works through the production path; public contract is documented; stated edge cases pass; dependencies remain acyclic; cancellation/errors preserve state; relevant budgets have measured evidence; all introduced resources dispose correctly; and its evidence report states the actual outcome. Tests should assert behavior and invariants, not mirror the implementation or merely count lines/components.

No fake “coming soon” handler can satisfy a feature ticket. No production path may consult Neovim, oracle snapshots or a hidden test-only shortcut. No requirement is removed to match a partial implementation. Packaging and end-to-end tests must make these constraints observable.

## Handoff template

```text
Ticket and status:
Implemented behavior:
Changed owner/public contract:
Checks run and outcomes:
Performance/visual evidence where relevant:
Known failure or remaining acceptance item:
Exact next command or ready ticket:
```

The next agent must be able to continue using the report and repository alone. Avoid chat-only decisions. Keep measured benchmark results distinct from target numbers, and keep “supports this subset” distinct from “parity.”
