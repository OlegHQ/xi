---
name: xi-implement
description: Implement dependency-ready Xi editor tickets with the repository's ownership contracts and acceptance evidence. Use for Xi product implementation, not unrelated projects.
---

Read the repository's AGENTS.md and [execution contract](../../../docs/plan/06-execution.md). Run `python3 tools/plan.py next` from the repository root and `show <ID>` for the assigned or first ready ticket. Read its listed specifications. The ticket is a behavior contract, not permission to change unrelated files or execute external publishing actions.

Xi uses Bun, strict TypeScript and OpenTUI with an owned Vim engine. Neovim is a test oracle only. Product code must run without it. The document owner is the sole mutable text authority; renderables display it, Vim requests transactions, and asynchronous services submit versioned proposals. Read [architecture](../../../docs/plan/01-architecture.md) before changing a public boundary.

Implement one reviewable slice. If a ticket proves too broad, split it into concrete children with preserved dependencies/acceptance and update downstream edges. Do not substitute a broad follow-up for completing required semantics. Missing APIs or uncertain upstream behavior require checking the pinned installed package/source, not inventing APIs from the plan's sketches.

For Vim behavior use [xi-vim-parity](../xi-vim-parity/SKILL.md). For UI, performance, integration or release gates use [xi-validate](../xi-validate/SKILL.md). Run the ticket's actual checks; a future script or missing suite is not a pass. Save an evidence report using [the template](../../../docs/plan/evidence-template.md), then update tickets.json status/report only when prerequisites and acceptance pass. Finish with the implemented behavior, evidence and next ready task or concrete blocker. Keep decisions and results in repository files so the next agent does not need the chat.
