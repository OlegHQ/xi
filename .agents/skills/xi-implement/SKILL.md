---
name: xi-implement
description: Implement dependency-ready Xi editor tickets with the repository's ownership contracts and acceptance evidence. Use for Xi product implementation, not unrelated projects.
---

Read the repository's AGENTS.md and [execution contract](../../../docs/plan/06-execution.md). Run `python3 tools/plan.py next` from the repository root and `show <ID>` for the assigned or first ready ticket. Read its listed specifications. The ticket is a behavior contract, not permission to change unrelated files or execute external publishing actions.

Xi uses Bun, strict TypeScript and OpenTUI with an owned Vim engine. Neovim is a test oracle only. Product code must run without it. The document owner is the sole mutable text authority; renderables display it, Vim requests transactions, and asynchronous services submit versioned proposals. Read [architecture](../../../docs/plan/01-architecture.md) before changing a public boundary.

Implement one reviewable slice. If a ticket proves too broad, split it into concrete children with preserved dependencies/acceptance and update downstream edges. Do not substitute a broad follow-up for completing required semantics. Missing APIs or uncertain upstream behavior require checking the pinned installed package/source, not inventing APIs from the plan's sketches.

For Vim behavior use [xi-vim-parity](../xi-vim-parity/SKILL.md). For UI, performance, integration or release gates use [xi-validate](../xi-validate/SKILL.md). Run the ticket's actual checks; a future script or missing suite is not a pass. Save an evidence report using [the template](../../../docs/plan/evidence-template.md), then update tickets.json status/report only when prerequisites and acceptance pass. Finish with the implemented behavior, evidence and next ready task or concrete blocker. Keep decisions and results in repository files so the next agent does not need the chat.

Before touching a production operation, read its execution class and owner budgets in [performance](../../../docs/plan/12-performance.md); `python3 tools/perf.py show <BUDGET-ID>` prints the exact boundary. Preserve Xi's initial requirements; Neovim is a behavioral oracle for declared commands, not a design to copy or a reason to expand scope to its whole application. Resource remediation tickets precede final parity/performance qualification through the dependency graph.

Keep H0 scalar/chunk/cell loops free of intentional temporary objects/strings; H1 may allocate bounded immutable outcomes and persistent history. Public snapshots/change events cannot alias reusable scratch, pooled storage or writable typed-array views. Include EOL/index/history/selection/worker/native costs when modifying storage; a raw-rope benchmark does not qualify the public edit path. Avoid full logical-line reads on Insert, per-key full snapshots, and microtask-only CPU isolation. Normal feature/UI-control code stays idiomatic TypeScript within its lifecycle budgets.

A changed budget or ownership boundary requires updating the catalog/specification and explicit acceptance edges before coding around it. Preserve existing failed results. Split structural refactors by owner with semantic fixtures and production measurements; do not introduce a second text store or pool published objects to claim zero allocation.
