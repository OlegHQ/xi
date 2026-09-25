# Xi release plan

The target is a release in which the installed editor has useful bundled languages and
themes, the requested Vim and file workflows work in a real terminal, and the GitHub Pages
site documents the released behavior. Keep this plan until every item is verified.

1. **Language assets and defaults.** Make grammar assets configurable and bundle the
   supported grammars and highlight queries in source and compiled installs. Add OCaml
   (`.ml`/`.mli`, `ocamllsp`, `ocamlformat`) and finish Ruby (`ruby-lsp`, a working formatter)
   in the default `languages.toml`. Check startup, syntax, LSP and format-on-save in real
   source and packaged sessions; optional external tools must fail without losing edits.
2. **Themes and installs.** Bundle a useful set of default themes in the binary and release
   archives, make them discoverable in the picker, retain user theme overrides, and include
   each theme's actual license and attribution. Verify clean Unix and Windows installs.
3. **Editing workflow.** Make Space+Shift+Y copy to the system clipboard; accept terminal
   clipboard paste in Normal mode with Vim put semantics; retain the path of a nonexistent
   CLI/`:edit` target; and make `:w {name}` assign that name to an unnamed buffer. Keep
   Space+w as the default wrap toggle. Cover each through the actual CLI PTY and relevant
   owner tests, including save failures and paths with spaces.
4. **Site.** Publish a GitHub Pages site with installation, getting started, language and
   theme support, configuration, commands/keybindings, and release notes. Generate the
   version and release-facing pages from the same version/docs used by packaging so a
   tagged release updates the site. Check links and the built pages locally.
5. **Release.** Run affected suites, `bun run check`, `bun run perf-gates`, real PTY checks,
   `bun run verify:release`, package build and smoke checks. Investigate misses against
   `docs/performance.md` (including loaded CLI latency); do not relabel an unproven gate.
   Commit reviewable changes, tag the next version and verify release artifacts and the
   published Pages site.

Existing behavior to preserve: Space+w is already bound in `config/default.toml`; Ruby
already has `ruby-lsp` and a bundled Tree-sitter grammar; explicit `"+p` and clipboard
paste via the editor's clipboard port already exist. These are starting points, not proof
that the requested release behavior is complete.
