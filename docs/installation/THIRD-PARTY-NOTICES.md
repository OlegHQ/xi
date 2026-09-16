# Xi third-party notices

This file describes runtime dependencies included by the Xi package at the
current lockfile revision. License text is retained in each dependency's
package directory when the source installation is available. A release bundle
must copy the referenced files beside the executable or include equivalent
text in its installer notice.

| Package | Version | License | Notice source |
|---|---:|---|---|
| `@opentui/core` | 0.5.11 | MIT | `@opentui/core/LICENSE` |
| `@opentui/core-linux-arm64` | 0.5.11 | MIT | `@opentui/core-linux-arm64/LICENSE` |
| `@opentui/core-linux-arm64-musl` | 0.5.11 | MIT | `@opentui/core-linux-arm64-musl/LICENSE` |
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

No grammar binary or font/icon asset is currently bundled by the Xi CLI. The
source tree pins `web-tree-sitter` as the runtime parser dependency and has no
checked-in grammar files. A release that enables a grammar must add its name,
version, license and checksum here and to the native/package manifest before
advertising that language support.

## Neovim policy

Neovim and its runtime files are not package dependencies. Xi owns its Vim
engine; Neovim appears only in development oracle fixtures and test tooling.
