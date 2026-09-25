# Xi

Read the [Xi website](https://oleghq.github.io/xi/) for installation, language support,
themes, keys and configuration.

Xi is a keyboard-first terminal code editor built with Bun, strict TypeScript and
OpenTUI. It owns its Vim engine and combines multiple cursors, LSP, Git, filesystem tools,
tasks, mouse interaction and a restrained terminal UI.

Use Bun 1.4.2 or newer. Run the editor directly from source without building a binary:

```sh
bun run apps/xi/src/main.ts path/to/file
```

```sh
bun install --frozen-lockfile
bun run xi -- path/to/file
```

Initialize submodules before the first install:

```sh
git submodule update --init --recursive
```

The active scope is [Helix-compatible configuration](docs/configuration.md). The
[machine-readable ledger](docs/configuration-ledger.json) tracks every stable key, master
addition and Xi extension; validate it with `bun run check:config-ledger`. Xi retains its
Neovim editing model while matching Helix multi-selection semantics 1:1. Historical
milestone plans, per-ticket evidence and
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
