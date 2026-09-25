# Xi third-party notices

## Bundled themes

`xi-light`, `xi-ocean`, and `xi-paper` are original Xi palettes licensed under
MIT (`packages/ui/theme/LICENSE`). `xi-dark` uses Catppuccin Mocha colors,
licensed under MIT by Catppuccin (`packages/ui/theme/CATPPUCCIN-LICENSE`).
Both license texts are included in release archives.

This file describes runtime dependencies included by the Xi package at the
current lockfile revision. License text is retained in each dependency's
package directory when the source installation is available. A release bundle
must copy the referenced files beside the executable or include equivalent
text in its installer notice.

| Package | Version | License | Notice source |
|---|---:|---|---|
| `@opentui/core` | 0.5.11 | MIT | `@opentui/core/LICENSE` |
| `@opentui/core-linux-x64` | 0.5.11 | MIT | `@opentui/core-linux-x64/LICENSE` |
| `@opentui/core-linux-arm64` | 0.5.11 | MIT | `@opentui/core-linux-arm64/LICENSE` |
| `@opentui/core-linux-arm64-musl` | 0.5.11 | MIT | `@opentui/core-linux-arm64-musl/LICENSE` |
| `@opentui/core-darwin-x64` | 0.5.11 | MIT | `@opentui/core-darwin-x64/LICENSE` |
| `@opentui/core-darwin-arm64` | 0.5.11 | MIT | `@opentui/core-darwin-arm64/LICENSE` |
| `@opentui/core-win32-x64` | 0.5.11 | MIT | `@opentui/core-win32-x64/LICENSE` |
| `@opentui/core-win32-arm64` | 0.5.11 | MIT | `@opentui/core-win32-arm64/LICENSE` |
| `bun-ffi-structs` | 0.3.1 | MIT | `bun-ffi-structs/LICENSE` |
| `diff` | 9.0.0 | BSD-3-Clause | `diff/LICENSE` |
| `marked` | 17.0.1 | MIT | `marked/LICENSE.md` |
| `string-width` | 7.2.0 | MIT | `string-width/license` |
| `strip-ansi` | 7.1.2 | MIT | `strip-ansi/license` |
| `ansi-regex` | 6.3.0 | MIT | `ansi-regex/license` |
| `emoji-regex` | 10.6.0 | MIT | `emoji-regex/LICENSE-MIT.txt` |
| `get-east-asian-width` | 1.6.0 | MIT | `get-east-asian-width/license` |
| `vscode-jsonrpc` | 8.2.1 | MIT | `vscode-jsonrpc/License.txt` |
| `vscode-languageserver-protocol` | 3.17.5 | MIT | `vscode-languageserver-protocol/License.txt` |
| `vscode-languageserver-types` | 3.17.5 | MIT | `vscode-languageserver-types/License.txt` |
| `web-tree-sitter` | 0.25.10 | MIT | `web-tree-sitter/LICENSE` |
| `undici-types` | 8.9.0 | MIT | `undici-types/LICENSE` |

The OpenTUI native package also ships notices for the libraries linked into its
native asset. These files must travel with an artifact that includes the
corresponding asset:

* `LICENSE-GHOSTTY` — MIT
* `LICENSE-LCMS2` — MIT
* `LICENSE-LIBWEBP` — BSD-style
* `LICENSE-STB` — MIT / public-domain dedication
* `LICENSE-WUFFS` — Apache-2.0

The exact text is in each `@opentui/core-<target>/` package directory. The
package audit checks that the dependency table, grammar statement and native
checksums are present before a target is called packaged.

## Grammar assets

The compiled Xi CLI embeds the Tree-sitter runtime wasm plus one grammar wasm
and highlights query per supported language (`apps/xi/src/syntax-assets.ts`
imports them with `type: "file"`, so `bun build --compile` bundles the bytes).
No grammar file is checked into the source tree; every one comes from a pinned
package below. A release that enables another language must add its name,
version, license and notice source here first.

| Grammar | Version | License | Notice source |
|---|---:|---|---|
| `@opentui/core` (typescript, javascript, markdown assets) | 0.5.11 | MIT | `@opentui/core/LICENSE` |
| `tree-sitter-python` | 0.25.0 | MIT | `tree-sitter-python/LICENSE` |
| `tree-sitter-ruby` | 0.23.1 | MIT | `tree-sitter-ruby/LICENSE` |
| `tree-sitter-json` | 0.24.8 | MIT | `tree-sitter-json/LICENSE` |
| `tree-sitter-ocaml` (implementation and interface) | 0.23.0 | MIT | `tree-sitter-ocaml/LICENSE` |
| `@tree-sitter-grammars/tree-sitter-toml` | 0.7.0 | MIT | `@tree-sitter-grammars/tree-sitter-toml/LICENSE` |

Markdown ships the block-level grammar only; inline emphasis and link styling
need Tree-sitter query injections, which the syntax service does not implement.

## Neovim policy

Neovim and its runtime files are not package dependencies. Xi owns its Vim
engine; Neovim appears only in development oracle fixtures and test tooling.
