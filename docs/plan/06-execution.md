# Implementation execution

The canonical backlog is [tickets.json](tickets.json). Each ticket contains dependency IDs, one owner, allowed paths, implementation steps, acceptance checks, failure cases and required evidence. The small local runner makes readiness inspectable without an issue tracker:

```sh
python3 tools/plan.py check
python3 tools/plan.py next
python3 tools/plan.py show T001
```

The runner validates the dependency graph and report references; it does not certify test truth. At the planning baseline, tickets were all `todo` and the repository had no editor implementation. Current implementation statuses, evidence reports and the scope-preserving T029 split into T102–T105 are authoritative in [tickets.json](tickets.json). Agentpack files are preserved. Local Git is initialized independently of any hosting service.

## Performance refinement lane

The [resource contract](12-performance.md), [research audit](13-performance-research.md) and [catalog](performance-budgets.json) add T106–T118. Existing statuses/reports are historical evidence, not passes for new budgets. T106 is the unfinished foundation; remediation then precedes final compatibility/performance qualification through explicit edges. Preserve all prior acceptance/failure requirements. SQLite holds derived developer observations and does not enter runtime architecture.

T119 adds the independently reviewable performance lint foundation and explained exception protocol; T109/T111/T112/T116 resolve owned findings before qualification. See [lint rules](../../tools/lint/README.md).

Current handoff: T106 is already `in_progress`; resume its remaining acceptance rather than expecting it in `next`. [Spec 14](14-remediation-handoff.md) makes the discovered copying, scheduling, oracle and measurement gaps executable. T120 hardens lint against repeated-copy rewrites before owner remediation; T121 isolates oracle clipboard state before T061/T115 qualification. These independent tooling tickets may proceed while T106 remains unfinished. No existing prerequisite, acceptance item or reference-host requirement is waived.

The 2026-09-16 G4 CLI audit found production wiring gaps that the original T056 dependency list did not cover: the launcher recognizes only TypeScript paths, its LSP client capabilities omit implemented completion/snippet support, and the launched workbench does not activate syntax or Git refresh. T123–T126 add those concrete prerequisites. T115 owns measured E14 qualification; T056 now waits for those production paths and the E14 evidence. Existing TypeScript PTY results and fake-peer passes remain valid component evidence, but they do not close G4 or E14.

Before an operation is implemented/refactored, identify its catalog owner/class and functional fixtures. Record CPU/wall, temporary allocation, retained/peak memory, queue/replica costs and the parent aggregate envelope relevant to that operation. A helper inherits its caller's budget; do not invent a separate benchmark for every function. No new unbudgeted service/cache/hot path may hide inside a done ticket.

## Work protocol

For input, rendering, startup/loading and background-work changes, read [spec 15](15-keystroke-latency.md) and the native-level speed requirement in AGENTS.md. The latency decision tightens loaded typing and adds p50/max/physical measurements without completing any ticket. Preserve concurrent T106 work; updated catalog hashes invalidate old comparisons until compatible current-contract evidence is collected.

The [2026-09-15 completion audit](../evidence/2026-09-15-completion-audit.md) supersedes earlier completion claims for 46 reopened tickets. Preserve historical component results, but complete the original production acceptance before restoring done status. A script running component APIs inside a PTY is not an actual CLI journey, and exported-constructor checks do not qualify a workbench or language milestone. T106 remains independently in progress; use the live backlog for readiness. Arrow/Vim input, mouse controls, workbench UX and loaded keystroke latency require the concrete production regressions listed in the audit.

Select the first ready ticket unless an assignment names another ready ticket. Read its referenced spec and relevant local skill. Inspect the current tree before creating paths; adapt structure only within the ownership contract. Record current state and a concrete expected behavior, then implement the smallest reviewable slice. Run the specified success and failure cases plus applicable architecture/performance checks. Inspect actual UI output for visual changes.

Do not start a dependent ticket until prerequisites have completed evidence. Independent tickets can be implemented in a different order; that is not permission to delegate or create agents automatically. Each assigned implementation agent can work serially from the ready list. A large ticket discovered during work should be split into stable child IDs with dependencies, owner, acceptance and evidence; update downstream edges before proceeding. Never create a generic “finish the rest” task that hides unimplemented Vim commands.

Ticket status values are `todo`, `in_progress`, `blocked`, `done`. `blocked` needs a specific missing fact/failure and next resolution action. `done` requires a checked-in report path, all acceptance checks and dependency completion. Update JSON deliberately; the runner offers no auto-complete command because file existence cannot establish acceptance. A failed check stays visible in the report until repaired and rerun.

Each report uses [evidence-template.md](evidence-template.md). Each implementation commit is a complete reviewable unit; references ticket ID and includes code/tests/evidence summary together. Do not mark a whole milestone complete based on one component screenshot. If the build cannot run, report it accurately and resolve that prerequisite instead of simulating success.

## Reading order by work type

| Work | Required specs / skills |
|---|---|
| Any implementation | AGENTS, ticket, architecture, xi-implement |
| Selection/document/history/multi-cursor | 08-selections + Vim + validation; singleton oracle and explicit Xi composition cases |
| Input/help/Ex aliases/mouse/paint | 09-interaction + affected selection contracts + validation |
| Commands/providers/config/lifecycle | 10-extensibility + architecture + relevant service contract |
| Document/input/Vim/layout | Vim + validation; xi-vim-parity |
| Panel/picker/theme/focus | UX + validation; xi-validate for PTY and visual evidence |
| LSP/search/files/Git/config | Services + relevant UX journey + validation |
| Performance/release | 12-performance + assigned catalog rows + 13-research findings; all affected gates and evidence; xi-validate |

## Milestone stop rules

G0 is a deliberate feasibility checkpoint: prototypes are disposable and cannot become unchecked production dependencies. It locks actual stack versions, text representation, keyboard boundary and regex strategy based on evidence. G1 locks the core public contracts. G2 certifies an editing preview and tracks incomplete parity. G3/G4/G5 certify complete workbench/language/tool families. G6 alone permits the release claims in the brief.

The plan has parallelizable architectural work but serial execution is the default. Building panels while the engine cannot preserve transaction/position invariants creates throwaway glue, so the main path puts those foundations first. Language transport prototyping can occur independently but its edit application waits for document/workbench ownership to exist.

Ticket numbers are stable identifiers, not chronological phases: T074–T095 insert prerequisites into the graph. T084 pointer feasibility belongs in G0, T074 command metadata and T075 selection state in G1, multi-command composition/history/replay in G2, discovery/gestures/contributions in G3, and language/session/scale qualification downstream. `next` remains authoritative. Do not implement singleton-only signatures and defer migration to added tickets. [Research](11-interaction-research.md) explains the changes; normative behavior is in specs 08–10.

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
