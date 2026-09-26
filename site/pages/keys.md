# Keys and commands

Xi owns Vim modes, motions, operators, registers, repeat, search, and undo. Press `i` to insert, `Esc` to return to Normal mode, and `:` to enter an Ex command. The [Vim behavior contract](docs/vim.html) describes the current semantics.

| Keys | Action |
| --- | --- |
| `:w` | Save the current named buffer. |
| `:w path` | Save an unnamed buffer and give it that path. |
| `:q` / `:q!` | Quit, or discard unsaved changes. |
| `Space f` / `Space b` | Open file / buffer picker. |
| `Space ;` | Open command picker. |
| `Space /` | Search the workspace. |
| `Space t` | Preview and select a theme. |
| `Space w` | Toggle soft wrap. |
| `Space p` | Toggle rendered Markdown preview for the current Markdown file. |
| `Space Shift+Y` | Copy the current line to the system clipboard. |
| `"+p` / `"+P` | Put from the system clipboard through Vim registers. |

Terminal bracketed paste puts text in Normal mode and inserts it atomically in Insert mode. Xi also accepts user keybindings in `config.toml`; see [configuration](docs/configuration.html) for the exact syntax and priority.

Markdown preview uses OpenTUI’s native renderer. Vim navigation, Visual selection and yank still use the source document; vertical motions scroll the viewer, and `gg`/`G` reach its ends. Insert or Replace temporarily shows the source. Rendered cells and source selections may differ.
