# Planning refinement validation

Latest follow-up: [remediation plan validation](../evidence/remediation-planning.md)
records 121 tickets, preservation of all 119 prior contracts and the concrete
[agent handoff](14-remediation-handoff.md). Earlier results below are historical.

This report validates planning artifacts at the 2026-09-14 refinement baseline. At that revision all **95 product tickets were `todo`**; G0–G6 were unproven. Current implementation status is maintained in [tickets.json](tickets.json), which now includes the scope-preserving T029 children T102–T105. This historical report does not claim that later runtime work, benchmarks, differential suites, mouse implementation or UI screenshots have passed. The original baseline had 73 tickets; that refinement added T074–T095 and preserved every original acceptance check, failure case and dependency edge.

Reviewed on 2026-09-14 in the worktree based on revision `555ed0ce3c2475a10844824468e6fddbb6e49755`. Environment: Linux aarch64, Python 3.13.15. No product toolchain or personal Neovim configuration was installed, modified or executed. Research provenance and exact inspected upstream revisions are in [the research report](11-interaction-research.md).

## Executed planning checks

| Command / inspection | Actual result |
|---|---|
| `python3 tools/plan.py check` | 95 tickets; schema, specification paths and acyclic graph valid; explicitly does not certify product evidence |
| `python3 tools/plan.py next` | T001 remains the only initially ready ticket |
| `python3 tools/plan.py show T075` and `show T089` | Selection foundation and qualification contracts display owner, paths, dependencies, implementation steps, acceptance/failure cases and evidence requirements |
| `python3 .artifacts/planning-research/audit.py` | All 94 non-release tickets are transitive prerequisites of T066; required G0/G1/G2/G3/G4 additions occur in their gate ancestry |
| Same audit: negative inputs to existing validator | Rejects cycle, unknown dependency, duplicate ID, invalid status, done without report, in-progress before prerequisite and missing specification |
| Same audit: document references | Local Markdown file/directory links resolve; referenced ticket IDs exist; all 16 numbered research footnotes are defined and used |
| Same audit: baseline preservation | Every original ticket acceptance/failure item and dependency edge retained; all statuses remain todo with no report claims |
| Same audit: protected/reference files | `agentpack.toml` and `pack.lock` byte-identical to HEAD; all three retained screenshot hashes match the original source record |
| `git diff --check` | No whitespace errors |
| Manual cross-specification review | Removed multi-cursor deferral and optional-mouse gate; checked shared state, single-owner text/selection boundaries, alias/native Ex separation, lifecycle, evolution and runtime-evidence distinctions |

The supplemental audit script and downloaded upstream source cache are local artifacts under `.artifacts/planning-research/`, intentionally outside Git. The script imports the unchanged `tools/plan.py`, mutates copies for seven negative cases, traverses release/gate dependencies, checks references/hashes and compares original ticket requirements with `git show HEAD:docs/plan/tickets.json`. The baseline revision above identifies the comparison target; after committing, use that revision rather than a newer HEAD to reproduce the baseline comparison. The canonical runner remains the durable backlog validation entrypoint.

## Objective coverage audit

| Explicit requirement | Authoritative planning artifacts | Implementation and proof obligations |
|---|---|---|
| First-class multiple cursors informed by Helix/VS Code | [08-selections](08-selections.md), [11-research](11-interaction-research.md), required brief capability | T075–T081/T092/T093/T095; MC01–MC12; T089 and G6 dependency closure |
| Extensible architecture for future feature work | [Architecture graph](01-architecture.md), [10-extensibility](10-extensibility.md) | T074/T090/T091; EX01–EX05 with actual built-in consumers, disposal and schema migration |
| Helix-like key suggestions, command discovery and aliases | [09-interaction](09-interaction.md), updated UX/config contracts | T074/T082/T083; E20; native Ex abbreviation/quit/write and registry-generation fixtures |
| Strong mouse support | Protocol, hit testing, capture and gesture contracts in [09-interaction](09-interaction.md) | T084–T086/T094; MP01–MP04, E12/E21/E22, named terminal/PTY and restoration evidence |
| Nicely painted motion feedback with Vim semantics | Three-concept separation in [08-selections](08-selections.md); tokens, precedence and lifetime in [09-interaction](09-interaction.md) | Engine preview in T077, paint in T087; E23 equivalence plus named real-terminal visual review |
| Vim/Neovim feel remains primary | [02-vim](02-vim.md), singleton/multi policy split and native Ex reservations | Full original T003/T061 oracle inventory preserved; MC01 singleton equivalence; no-runtime-Neovim packaged checks |
| Heavy research, boundaries, work plan and prior gaps | [11-research](11-interaction-research.md), specs 08–10, updated execution and canonical backlog | Primary documentation plus source inspection, decision/tradeoff tables, gap-to-ticket mapping, dependency and scope-preservation checks |
| Performance and agent-proof acceptance | [05-validation](05-validation.md), per-ticket acceptance/failure/evidence lists | Explicit 1–10,000 cursor budgets, loaded input, mapping growth, lifecycle retention, negative fixtures, no empty-suite success or silent truncation |

Manual review found and corrected additional ambiguities: shared find/search/mark/jump state across cursors; native `:q` versus workbench close review; selection-only generations; exact versus friendly Ex alias matching; declaration of command cardinality; pointer behavior during pending operators/Insert; Visual-kind conversion during mouse selection; engine-owned preview generation; and dependency order for selection-aware layout and contribution consumers.

This is evidence that the requested planning refinement is complete and internally checked, not that its runtime design has passed. Proposed thresholds, colors, terminal support, core data-structure performance and complete Vim behavior still require the pinned experiments, production tests and named reviews in the backlog. Future discoveries must add scope-preserving tickets and edges rather than narrowing these requirements.

## Performance refinement, 2026-09-15

The subsequent user request for deep performance/memory/ownership research and a fully refined initial-engine plan is recorded in [performance planning evidence](../evidence/performance-planning.md). It adds [spec 12](12-performance.md), [research 13](13-performance-research.md), 55 budget operations / 148 bounds, a developer-only SQLite ledger, and T106–T118. The user clarified that the engine serves Xi's initial requirements and SQLite means budgets/results, not runtime text persistence. Existing 105 ticket statuses/reports and all prior acceptance/failure/dependency requirements were preserved; all 117 non-release tickets now lead to T066. T106 is next ready. This planning validation does not certify product budgets or implement the queued structural refactors.
