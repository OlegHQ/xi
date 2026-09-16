# Xi

A keyboard-first terminal code editor: Bun, strict TypeScript, OpenTUI, an **owned Vim engine**, first-class multiple cursors and LSP, strong mouse support, discoverable commands, extensible internal contracts, and a restrained light interface.

The repository now contains the document, Vim, workbench, language, Git, filesystem and task implementation covered by the completed tickets. `bun run xi` launches the first document-backed OpenTUI editor shell; `bun run xi -- path/to/file:line` opens a file, and the launch loop routes Vim Insert (`i`, `a`, `o` and related entries), normal motions, operators such as `dw`/`dd`/`yy`, register put (`p`), `x`/`X`/`D`/`~`, character replacement (`r`/`gr`), `u`, Escape, Ctrl-S atomic save and native Ex write/quit commands. The complete compatibility, performance, accessibility, package and release qualification gates remain unproven. Neovim is permitted only in development tests as an oracle. It must not be embedded, invoked, or required by the shipped editor.

For a fresh checkout, run `git submodule update --init --recursive` before `bun install --frozen-lockfile`. Xi applies its [pinned OpenTUI startup fork](docs/installation/opentui-fork.md) through Bun's dependency patch support.

Start with [the implementation brief](docs/plan/00-brief.md), then [the ticket runner instructions](docs/plan/06-execution.md). The canonical backlog is [tickets.json](docs/plan/tickets.json).

Completion correction (2026-09-16): the [application integration audit](docs/evidence/2026-09-15-completion-audit.md) reopened tickets whose required journeys or prerequisites were incomplete. Implemented service/engine modules do not imply working features in `bun run xi`: LSP, mouse controls and substantial workbench integration remain unfinished. The backlog now records 92 done, 3 in progress and 27 todo (75.4% of tickets marked done); this is not a product-readiness percentage. Keyboard UX and loaded input-to-output latency remain unproven release requirements.

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
| [Selections](docs/plan/08-selections.md) | Multi-cursor ownership, Vim composition, conflicts, registers, repeat and services |
| [Interaction](docs/plan/09-interaction.md) | Contextual hints, Ex aliases, mouse protocols/gestures and motion-trail paint |
| [Extensibility](docs/plan/10-extensibility.md) | Typed contributions, lifecycle, contract evolution and real consumer checks |
| [Performance engineering](docs/plan/12-performance.md) | Execution classes, CPU/memory budgets, lifetime/pressure rules and required workloads |
| [Performance research](docs/plan/13-performance-research.md) | Primary-source review, current-code findings and measured density reproduction |
| [Remediation handoff](docs/plan/14-remediation-handoff.md) | Concrete gap checks, ticket ownership, stop rules and a copyable agent assignment |
| [Budget catalog](docs/plan/performance-budgets.json) | 55 owner operations / 166 numeric bounds; SQLite developer ledger via `python3 tools/perf.py` |
| [Keystroke responsiveness](docs/plan/15-keystroke-latency.md) | Mandatory idle/loaded latency, physical visible response, maxima and actual-CLI qualification |
| [Interaction research](docs/plan/11-interaction-research.md) | Helix/VS Code/Neovim comparison, pinned sources, decisions and planning gaps |

Local skills live in [.agents/skills](.agents/skills). Reference screenshots are preserved in [docs/references](docs/references). Initial Git setup is local; no remote or publication is implied.

The latest refinement targets the right engine for Xi's initial requirements, with bounded core allocation and all-owner CPU/memory budgets. SQLite is an offline budgets/results ledger, not editor storage. Run `python3 tools/perf.py check`, `build`, and `status`; numerical coverage remains separate from release qualification. T106 remains in progress for trustworthy benchmark comparison before structural resource refactors. Run `python3 tools/plan.py next` for current dependency-ready acceptance repairs.
