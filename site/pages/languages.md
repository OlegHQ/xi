# Language support

Xi ships Tree-sitter parser and highlight assets inside the executable. Language servers and formatters are external commands selected from the built-in `languages.toml` and can be changed in your own `languages.toml`. Missing language servers leave the buffer editable; automatic formatting stays off for OCaml and Ruby until you opt in.

For another language, add a `[[language]]` entry with its `name` and `file-types`, then put matching `name.wasm` and `name.scm` files in `~/.config/xi/grammars/` (or the Xi configuration directory on your platform). Xi loads this pair when the file opens; it can also override a bundled grammar. Both files are required. Grammar IDs contain lowercase letters, digits, underscores, or hyphens and must start with a letter. Restart Xi after changing language or grammar files. Check the grammar author's license before sharing those files.

| Language | Files | Bundled highlighting | Default server | Default formatter |
| --- | --- | --- | --- | --- |
| TypeScript | `.ts`, `.tsx` | Yes | `typescript-language-server` | `biome` |
| JavaScript | `.js`, `.mjs`, `.cjs`, `.jsx` | Yes | TypeScript server fallback | Configure one |
| Python | `.py`, `.pyi` | Yes | `pyright-langserver` | Configure one |
| Ruby | `.rb`, `.rake`, `.gemspec`, common Ruby filenames | Yes | `ruby-lsp` | `rubocop --fix-layout` |
| OCaml | `.ml`, `.mli` | Yes, separate implementation/interface grammars | `ocamllsp` | `ocamlformat` |
| JSON | `.json`, `.jsonc` | Yes | Configure one | Configure one |
| TOML | `.toml` | Yes | Configure one | Configure one |
| Markdown | `.md`, `.markdown` | Block grammar | Configure one | Configure one |

The bundled Markdown grammar highlights blocks; inline injections are not yet supported. A configured language server or formatter must be installed separately on your `PATH` or supplied by your project environment. OCaml uses the `ocaml-lsp-server` and `ocamlformat` packages; Ruby uses `ruby-lsp` and RuboCop. Use `:format` when a formatter is installed, or set `auto-format = true` in your language entry to run it on save. A missing automatic formatter causes the save to report an error rather than silently write unformatted text.

```toml
# ~/.config/xi/languages.toml
[language-server.my-server]
command = "my-language-server"
args = ["--stdio"]

[[language]]
name = "mylang"
file-types = ["my"]
language-servers = ["my-server"]
formatter = { command = "my-formatter", args = ["--stdin", "{file}"] }
auto-format = true
```

For this example, the grammar files would be `~/.config/xi/grammars/mylang.wasm` and `~/.config/xi/grammars/mylang.scm`.

See the [configuration reference](docs/configuration.html) for the supported `languages.toml` schema and trust rules. The [grammar asset notices](docs/installation/THIRD-PARTY-NOTICES.html) identify bundled parser licenses.
