# Ruby language support

- Outcome: Ruby is a built-in syntax language and default LSP language.
- Environment: Linux arm64; Bun 1.3.13; TypeScript 7.0.2; web-tree-sitter 0.25.10;
  tree-sitter-ruby 0.23.1.

## Behavior

Xi recognizes `.rb`, `.rake`, `.gemspec`, `Gemfile`, `Rakefile`, `Guardfile`, `Podfile`,
`Vagrantfile`, and `.irbrc`. The bundled Ruby grammar and highlight query load lazily. The
default language configuration selects `ruby-lsp`, roots at `Gemfile`, `gems.rb`,
`.ruby-version`, or `.git`, and uses two-space indentation with automatic formatting off.

## Checks

- `bun test tests/workbench/file-language.test.ts tests/config/t036-config.test.ts tests/syntax/bundled-languages.test.ts`: passed; the real Ruby grammar emitted 12 spans including comment, function, keyword, string, punctuation, and variable kinds.
- `python3 tests/distribution/t053-syntax-compiled-pty.py`: passed with the standalone binary and an isolated `.rb` fixture; its final marker reported `highlighted` with 12 spans.
- `bun run check`: passed strict types, public boundary, architecture and lint.
- `bun run test:services`: passed all 71 fixtures, including language routing/lifecycle and
  the Ruby bundled-grammar regression.
- `bun run package:audit`: unrelated existing native-asset checksum failure for
  `node_modules/@opentui/core-linux-arm64/libopentui.so`; Ruby packaging itself passed the
  stronger compiled PTY check above.

`ruby-lsp` is not installed on this validation host, so a live server initialize/diagnostic
journey remains unverified. Xi reports the normal language-server-unavailable state when the
configured executable is absent; syntax highlighting does not depend on the LSP process.
