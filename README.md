# Xi

A keyboard-first terminal code editor: Bun, strict TypeScript, OpenTUI, an **owned Vim engine**, TOML configuration, first-class LSP, and a restrained light interface.

This repository currently contains an implementation plan and local agent skills. **The editor has not been implemented; no performance or Vim-parity gates have passed.** Neovim is permitted only in development tests as an oracle. It must not be embedded, invoked, or required by the shipped editor.

Start with [the implementation brief](docs/plan/00-brief.md), then [the ticket runner instructions](docs/plan/06-execution.md). The canonical backlog is [tickets.json](docs/plan/tickets.json).

```sh
python3 tools/plan.py check
python3 tools/plan.py next
python3 tools/plan.py show T001
```

Give an implementation agent this instruction:

> Read AGENTS.md and use .agents/skills/xi-implement/SKILL.md. Run `python3 tools/plan.py next`, select the first ready ticket, and implement only that ticket. Read its referenced specifications. Run its acceptance checks and applicable gates; save actual evidence. Update status only when the evidence supports it. Do not reduce requirements to make tests pass. Continue with the next ready ticket if the assignment allows it.

| Document | Purpose |
|---|---|
| [Brief and research](docs/plan/00-brief.md) | Product scope, decisions, VS Code capability adaptation |
| [Architecture](docs/plan/01-architecture.md) | Owners, dependency rules, transactions, positions, performance path |
| [Vim contract](docs/plan/02-vim.md) | Native engine semantics, parity inventory, oracle and fuzzing |
| [UX specification](docs/plan/03-ux.md) | Layout, focus, keymaps, visual tokens, panel journeys |
| [Services and configuration](docs/plan/04-services.md) | LSP, search, filesystem operations, Git, TOML |
| [Validation](docs/plan/05-validation.md) | Functional, PTY, visual, performance, failure and release gates |
| [Execution](docs/plan/06-execution.md) | Ticket lifecycle, milestones, evidence and handoffs |
| [Sources](docs/plan/07-sources.md) | Primary research sources and local observations |

Local skills live in [.agents/skills](.agents/skills). Reference screenshots are preserved in [docs/references](docs/references). Initial Git setup is local; no remote or publication is implied.
