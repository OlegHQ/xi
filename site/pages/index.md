# Xi, a terminal editor that stays close to your code

Xi combines an owned Vim engine with multiple selections, language servers, Tree-sitter highlighting, Git, search, tasks, and a keyboard-first workspace. It runs from source with Bun and ships as a self-contained executable for Linux, macOS, and Windows.

```sh
curl -fsSL https://github.com/OlegHQ/xi/releases/latest/download/install.sh | sh
xi path/to/file
```

On Windows, use the [PowerShell installer](getting-started.html). Open a file that does not exist yet, type, and save it with `:w`; start with no filename and use `:w new-name.txt` to name the buffer.

## Find your way around

| Explore | What it covers |
| --- | --- |
| [Getting started](getting-started.html) | Install, launch, save, quit, and workspace basics. |
| [Languages](languages.html) | Bundled grammars and optional language server and formatter commands. |
| [Themes](themes.html) | Built-in and custom themes, picker, and configuration. |
| [Keys](keys.html) | Vim basics and Xi's Space shortcuts. |
| [Configuration](docs/configuration.html) | The precise current configuration contract and parity matrix. |
| [Vim behavior](docs/vim.html) | Editing semantics and Neovim oracle boundaries. |
| [Releases](releases.html) | Published binaries and what a release includes. |

## Built for the terminal

Xi keeps text in one document owner. Editing stays responsive while language servers, syntax, Git, search, and tasks run through bounded services. [Architecture](docs/architecture.html) and [performance targets](docs/performance.html) are public contracts.

Xi uses Vim editing semantics and Helix-style configuration and multi-selection behavior where those contracts apply. Helix and Neovim are development references; neither runs inside the installed editor.
