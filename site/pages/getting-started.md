# Getting started

## Install

For macOS and Linux:

```sh
curl -fsSL https://github.com/OlegHQ/xi/releases/latest/download/install.sh | sh
```

For Windows PowerShell:

```powershell
irm https://github.com/OlegHQ/xi/releases/latest/download/install.ps1 | iex
```

The installers verify release checksums before replacing an existing binary. [Installation details](docs/installation/README.html) cover supported platforms, manual archives, and repair steps.

To run from source, install Bun 1.4.2 or newer, initialize submodules, and run:

```sh
git submodule update --init --recursive
bun install --frozen-lockfile
bun run xi -- path/to/file
```

## Your first buffer

Run `xi example.txt`. Press `i` to insert text, `Esc` to return to Normal mode, `:w` then Enter to save, and `:q` then Enter to quit. A missing path opens an empty buffer; the first write creates the file. Starting with `xi` opens an unnamed buffer; `:w example.txt` names and saves it.

Press Space+f for files, Space+b for buffers, Space+; for commands, Space+/ for workspace search, Space+t for themes, and Space+w to toggle soft wrap. Space+Shift+Y copies the current line to the system clipboard. Terminal paste works in Normal and Insert modes.

## Configure

Place `config.toml` and `languages.toml` in `~/.config/xi/` on Unix, or the Xi configuration directory on Windows. User files layer over the built-in defaults. A project can provide trusted workspace configuration. See the [configuration reference](docs/configuration.html) for types, defaults, safety rules, and the exact parity status.
