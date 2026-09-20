# Xi

Xi is a keyboard-first terminal code editor built with Bun, strict TypeScript and
OpenTUI. It owns its Vim engine and combines multiple cursors, LSP, Git, filesystem tools,
tasks, mouse interaction and a restrained terminal UI.

```sh
bun install --frozen-lockfile
bun run xi -- path/to/file
```

Initialize submodules before the first install:

```sh
git submodule update --init --recursive
```

The active scope is [Helix-compatible configuration](docs/configuration.md). The matrix in
that document records every stable `[editor]` key, master additions, Xi's current behavior
and the implementation order. Historical milestone plans, per-ticket evidence and
prototype trees were retired after commit `ab211d5`; Git history remains available when a
past decision is needed.

Core contracts:

- [Architecture](docs/architecture.md)
- [Configuration parity](docs/configuration.md)
- [Testing](docs/testing.md)
- [Performance](docs/performance.md)
- [Vim behavior](docs/vim.md)
- [Installation and packaging](docs/installation/README.md)

Common checks:

```sh
bun run check
bun run test:unit
bun run test:services
bun run test:ui
bun run test:e2e -- --suite interaction
bun run test:vim
```

Neovim and Helix are development oracles only and are never required by the shipped
editor. Product readiness still requires the behavioral and native-speed gates described
in the contracts above.
