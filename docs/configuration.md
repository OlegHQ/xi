# Configuration parity

Xi's next product scope is a Helix-compatible `config.toml` surface. Compatibility means
the same path, type, accepted values, default and observable effect. Accepting a key and
then ignoring it does not count.

The machine-readable [`configuration-ledger.json`](configuration-ledger.json) is the
progress authority. It contains one entry per key, union variant or loading contract and
seals the audited inventory. This document explains the baseline and design; its “Xi at
audit” columns are historical context, not mutable status. Validate ledger edits with
`bun run check:config-ledger`.

This scope does not adopt Helix's editing model. Xi retains its Neovim-compatible Vim
model. Helix is also a behavioral oracle for Xi's multi-selection semantics, which must
match selection creation, primary identity, direction, merge/deduplication, document
mapping and simultaneous edits 1:1.

## Reference baseline

- Stable contract: Helix 25.07.1, tag commit
  [`a05c151`](https://github.com/helix-editor/helix/tree/a05c151bb6e8e9c65ec390b0ae2afe7a5efd619b),
  especially its
  [`editor.rs`](https://github.com/helix-editor/helix/blob/a05c151bb6e8e9c65ec390b0ae2afe7a5efd619b/helix-view/src/editor.rs)
  schema and [editor documentation](https://docs.helix-editor.com/editor.html).
- Forward look: Helix master commit
  [`079a789`](https://github.com/helix-editor/helix/tree/079a789e8cb08ead67f19e1971a1b7438b37354b),
  whose [editor schema](https://github.com/helix-editor/helix/blob/079a789e8cb08ead67f19e1971a1b7438b37354b/helix-view/src/editor.rs)
  adds the rows marked `master` below.
- Behavioral oracle: official ARM64 Helix 25.07.1 binary, version output
  `helix 25.07.1 (a05c151b)`, kept only under ignored
  `.artifacts/reference/helix/25.07.1/`.
- Xi audit point: `ab211d5`. The current compiler is
  `packages/services/config/index.ts`; production consumption is in `apps/xi/src/wiring/`.

The stable release is the compatibility floor. Master-only fields may land early when the
underlying Xi feature already exists and semantics are stable. Helix source wins when the
published page and released binary disagree.

## Status terms

| Audit status | Meaning |
| --- | --- |
| Effective | Xi accepts the Helix spelling and the launched editor applies it. |
| Parsed only | Xi accepts it, but production behavior does not consume it. This is not parity. |
| Incompatible | Xi has a related setting under a different path or meaning. |
| Missing | Xi rejects or cannot represent the setting. |

The historical audit point predates the current effective slices; it recorded `scrolloff`,
`line-number`, `mouse`, `cursor-shape.normal`, `cursor-shape.insert` and `lsp.enable` as
parsed but not wired. The canonical fixture at
`tests/fixtures/config/helix-25.07.1.toml` is accepted by the official Helix 25.07.1
binary; Xi currently returns 106 unknown-key/value diagnostics for it.

## Working the ledger

Each ledger item has a stable ID, exact path or contract, upstream reference, default,
current status and a `validation` object. A missing validation dimension means unfinished;
adding a dimension means its array names the committed test files that prove it. Stable
and master items require `schema`, `default`, `runtime`, `invalid`, `unit`, `pty` and
`helix`; Xi extensions require all except `helix`.

Update one vertical slice and its evidence together. `bun run check:config-ledger` reports
item/status/check totals and rejects duplicate IDs, nonexistent tests, impossible status
combinations, canonical-fixture paths absent from the ledger, and `effective` without full
proof. The inventory hash prevents silent additions or removals. If upstream changes,
audit the new pinned source first, then deliberately reseal using the hash printed by the
failed check.

## Root and loading contract

| Helix-compatible surface | Helix behavior | Xi at `ab211d5` | Target |
| --- | --- | --- | --- |
| `theme = "name"` | Top-level theme name | Effective; legacy `editor.theme` remains accepted | Root spelling feeds the existing theme consumer; legacy spelling remains a migration alias. |
| `[theme] dark/light/fallback` | Master supports terminal light/dark selection | Effective | OpenTUI terminal theme-mode events select the configured theme live; fallback is used when the terminal has no declared preference. An explicit configured theme wins over persisted theme state. |
| `[keys.normal]`, `[keys.insert]`, `[keys.select]` | Static commands, typable commands, command sequences and `@` macros | Incompatible: similar tables, `visual` naming and Xi command IDs | Accept Helix modes and value forms; keep Xi-only contexts under `[xi.keys]`. |
| User `config.toml` | Platform config directory | Effective at `$XDG_CONFIG_HOME/xi/config.toml` when XDG_CONFIG_HOME is absolute, otherwise `~/.config/xi/config.toml` | Xi reads this path in source and release builds. |
| Workspace `.helix/config.toml` merge | Built-in → user → workspace | Effective when no explicit `-c`/Xi config overrides it | Reads the optional `.helix/config.toml` workspace layer after defaults and user config, preserving explicit CLI precedence. |
| `-c/--config` | Explicit config path | Effective | Loads the selected file in place of the user config and above the legacy home state layer; trusted workspace config is skipped. |
| `:config-open`, `:config-reload`, USR1 | Open/reload atomically | Partial live reload; invalid reloads retain the last-good behavior | Reload is serialized and validated before publication. Bindings, input, trust, line numbers, rulers and save policy update live; other settings require restart, which Xi reports. |
| Unknown fields | Rejected by Helix schema | Rejected by Xi's hand-maintained list | Preserve strict rejection. A key enters the list only with a production consumer. |

For this release, `~/.xi.toml` remains a lower-priority compatibility input and the
persisted sidebar/theme state file. Move hand-written settings and keymaps to the canonical
`config.toml`: defaults → `~/.xi.toml` → user or explicit `-c` config → trusted workspace
config. A canonical value wins over the same saved/legacy value. `:config-open` creates
the canonical file when absent and opens that path. Explicit `-c` skips workspace config;
without it, workspace loading still follows the workspace-trust policy.

[`config/default.toml`](../config/default.toml) is the built-in configuration and Xi-owned
keymap in both source and packaged launches. The compiler retains conditional fallbacks
for profile-specific motion trail, legacy wrap, and automatic platform clipboard selection.
Vim motions, operators, registers, and mode keys follow the [Vim parity contract](vim.md)
rather than this keymap. In a checkout, copy `config/default.toml` to
`~/.config/xi/config.toml` to start from the full defaults, or create a smaller file with
only the values and bindings you want to override. The user file merges above these
built-ins; `$XDG_CONFIG_HOME/xi/config.toml` is used when XDG_CONFIG_HOME is absolute.

## `[editor]` scalar and union keys

`Stable` defaults are from 25.07.1. A master change is called out where it changes the
compatibility decision.

| Path | Stable default | Master delta | Xi at `ab211d5` | Target note |
| --- | --- | --- | --- | --- |
| `editor.scrolloff` | `5` | — | Effective | Applies the configured cursor margin to the launched viewport and view-scroll commands. |
| `editor.mouse` | `true` | — | Effective; legacy table accepted for migration | Keep the Helix boolean as the canonical path; legacy mouse extensions remain compatibility-only. |
| `editor.middle-click-paste` | `true` | — | Effective | Gates primary-selection paste on a real editor pointer event. |
| `editor.scroll-lines` | `3` | — | Incompatible: effective as `editor.mouse.scroll-lines` | Adopt the Helix path. |
| `editor.shell` | `['sh','-c']` on Unix | — | Effective | Applies to `:sh`/`:shell`; argv-native tasks remain argv-native. |
| `editor.line-number` | `absolute` | — | Effective: `absolute` or `relative` | Uses the configured gutter labels in the launched editor. |
| `editor.cursorline` | `false` | — | Effective | Gates the bounded active-row paint and uses `ui.cursorline` when supplied. |
| `editor.cursorcolumn` | `false` | — | Effective | Gates the bounded active-column paint and uses `ui.cursorcolumn` when supplied. |
| `editor.continue-comments` | `true` | — | Effective | Continues a recognized line-comment prefix through the owned Vim newline path, using current cached syntax when available and a bounded lexical fallback before parsing completes. |
| `editor.gutters` | diagnostics/spacer/line-numbers/spacer/diff | Adds `code-action-hint` kind | Effective for stable gutter kinds | Scalar arrays and table `layout` reorder or omit the existing diagnostic, spacer, line-number and diff slots in the launched editor. |
| `editor.statusline` | mode/spinner/file-name/... | Adds `code-action-hint` element | Effective | When configured, shows the number of enabled LSP code actions at the current cursor position. |
| `editor.auto-completion` | `true` | — | Effective | Gates automatic LSP completion while preserving manual completion. |
| `editor.path-completion` | `true` | stable | Effective | Recognized saved/scratch-buffer paths enumerate a bounded directory and use the shared versioned completion edit path. |
| `editor.auto-format` | `true` | — | Effective; composes with per-language auto-format | Global gate composed with language settings. |
| `editor.default-yank-register` | `"` | — | Effective | Selects the owned Vim register for implicit yank and paste commands; explicit registers remain authoritative. |
| `editor.idle-timeout` | `250` ms | — | Effective | Drives the existing bounded contextual-help idle timer; it never debounces keystrokes. |
| `editor.completion-timeout` | `250` ms | — | Effective | Delays only character-triggered completion; manual completion remains immediate. |
| `editor.preview-completion-insert` | `true` | — | Effective | Preview is reversible and versioned; accepting keeps it, while moving or closing restores the prior text. |
| `editor.completion-trigger-len` | `2` | — | Effective | Opens automatic LSP completion after the configured identifier length. |
| `editor.completion-replace` | `false` | — | Effective | Expands fallback completion edits to the full word; explicit LSP ranges remain authoritative. |
| `editor.auto-info` | `true` | `true` | Effective | Gates Xi’s contextual prefix-help information panel. |
| `editor.true-color` | `false` | — | Effective | Forces truecolor when terminal capability detection reports a false negative; otherwise Xi uses detected terminal color support. |
| `editor.undercurl` | `false` | — | Effective | Overrides terminal undercurl capability handling without changing text semantics. |
| `editor.rulers` | `[]` | stable | Effective | Renders configured 1-based display columns through the existing editor paint path. |
| `editor.bufferline` | `never` | — | Effective | Controls whether the existing tab strip is always hidden, always shown or shown only for multiple buffers. |
| `editor.color-modes` | `false` | — | Effective | Gates the mode-specific statusline theme scopes. |
| `editor.text-width` | `80` | stable | Effective | Supplies the configured content wrap width when wrap-at-text-width is enabled. |
| `editor.workspace-lsp-roots` | `[]` | — | Effective | Validated relative directories select the deepest matching LSP session root. |
| `editor.default-line-ending` | `native` | — | Effective | Applies `native`/`lf`/`crlf`/`ff`/`cr`/`nel` to new documents and preserves existing file EOL metadata. FF and NEL bytes reopen as line endings in the default file format; use explicit `unix` or `dos` file format to keep them as literal controls. |
| `editor.insert-final-newline` | `true` | — | Effective | Adds the final line ending through the document transaction before persistence, preserving the save version boundary. |
| `editor.atomic-save` | `true` | — | Effective | Selects atomic replacement or direct writes for persistence. |
| `editor.trim-final-newlines` | `false` | — | Effective | Removes line endings after the final one through one document transaction before persistence. |
| `editor.trim-trailing-whitespace` | `false` | — | Effective | Removes spaces and tabs preceding line endings through one document transaction before persistence. |
| `editor.popup-border` | `none` | — | Effective | Controls borders for popup, menu, or all transient surfaces. |
| `editor.indent-heuristic` | `hybrid` | — | Effective | Accepts `simple`, `tree-sitter`, and `hybrid`; Xi uses Helix's documented `simple` fallback because syntax-tree indentation queries are unavailable. |
| `editor.jump-label-alphabet` | `abcdefghijklmnopqrstuvwxyz` | — | Effective | Validated unique Unicode characters; `editor.goto-word` generates bounded two-character labels from the visible viewport in configured order and selecting one moves the cursor. |
| `editor.end-of-line-diagnostics` | `disable` | Master default `hint` | Effective | Shows the highest-severity diagnostic not rendered inline at the source line end; `disable` suppresses it. |
| `editor.preview-completion-insert` | `true` | `true` | Effective | Selecting a completion applies a reversible, versioned preview; accepting keeps it, while moving or closing restores the prior text. |
| `editor.clipboard-provider` | platform-specific union | — | Effective | Built-ins use Helix’s provider-specific commands, `termcode` emits OSC52, `none` disables reads/writes, and custom commands remain argv-native. |
| `editor.editor-config` | `true` | — | Partial | Workspace `.helix/config.toml` loading is governed by workspace trust. When enabled, `.editorconfig` applies indentation, line endings, final-newline insertion, and trailing-whitespace trimming per file. |
| `editor.mouse-yank-register` | — | `*` on master | Effective | Completed mouse selections are yanked into this owned Vim register; explicit register commands remain authoritative. |
| `editor.rainbow-brackets` | `false` | — | Effective | Colors Tree-sitter `punctuation.bracket` spans by containing delimiter depth using `rainbow.N` theme scopes; keep off by default. |
| `editor.kitty-keyboard-protocol` | — | `auto` on master | Effective | Controls the existing OpenTUI Kitty keyboard negotiation and parser. |

## Nested editor sections

Brace notation below classifies every listed child key separately.

| Section / paths | Default | Version | Xi at `ab211d5` | Target note |
| --- | --- | --- | --- | --- |
| `editor.cursor-shape.{normal,insert,select}` | all `block` | stable | `normal`/`insert`/`select` effective; `visual` remains a migration spelling | Uses Helix names and values `block`/`bar`/`underline`/`hidden`; `visual` maps to `select`. |
| `editor.file-picker.hidden` | `true` | stable | Effective; picker index defaults to the configured hidden-file policy | Wired through the canonical config snapshot into the production file picker. |
| `editor.file-picker.follow-symlinks` | `true` | stable | Effective; filesystem traversal follows symlink directories with real-path cycle protection | The platform enumerator owns async traversal and bounds the index population. |
| `editor.file-picker.deduplicate-links` | `true` | stable | Effective; real-path deduplication is configurable while cycles remain bounded | Controls whether followed symlink paths collapse onto one real directory. |
| `editor.file-picker.max-depth` | unset | stable | Effective; filesystem traversal stops at the configured directory depth | Bounds background picker enumeration without blocking input. |
| `editor.file-picker.{parents,ignore,git-ignore,git-global,git-exclude}` | all true | stable | Effective; the bounded picker index reads workspace, parent, Helix and Git ignore sources | The async platform walker applies ordered negation rules and honors `core.excludesfile` without blocking input. |
| `editor.file-explorer.hidden` | `false` | master | Effective | `true` hides hidden entries in the existing Explorer; `false` includes them. |
| `editor.file-explorer.follow-symlinks` | `false` | master | Effective | Passes the policy to the existing Explorer tree; symlink traversal is disabled or enabled accordingly. |
| `editor.file-explorer.{parents,ignore,git-ignore,git-global,git-exclude}` | `false` | master | Effective | Applies the existing bounded ignore matcher to Explorer entries; parent, `.ignore`, `.gitignore`, global Git and `.git/info/exclude` sources are independently configurable. |
| `editor.file-explorer.flatten-dirs` | `true` | master | Effective | Flattens loaded single-child directory chains into one stable Explorer row; disabling it preserves separate directory rows. |
| `editor.buffer-picker.start-position` | `current` | master | Effective | Opens the buffer picker on the active buffer or the tracked alternate buffer, as configured. |
| `editor.statusline.{left,center,right,separator}` | Helix lists | stable | Layout lists effective; separator effective | Declarative layout with bounded rendering. |
| `editor.statusline.mode.{normal,insert,select}` | `NOR`/`INS`/`SEL` | stable | Effective | Configures the text for the existing mode-owned statusline indicator. |
| `editor.statusline.separator` | `│` | stable | Effective | Configures the separator between the existing statusline elements. |
| `editor.statusline.{diagnostics,workspace-diagnostics}` | warning/error | stable | Effective | Severity filters over the existing document and workspace diagnostic stores. |
| Statusline element catalog | mode, spinner, file paths/name, modification/read-only, encoding/EOL/indent/type, line counts, diagnostics, selections, register, position/percentage, spacer/separator, VCS | stable | Effective; master `current-working-directory` is also effective | All stable names are accepted and routed to the existing statusline renderer; unsupported metadata stays empty rather than fabricating a value. |
| `editor.lsp.enable` | `true` | stable | Effective | Gates language-server startup and dependent LSP UI in the launched editor. |
| `editor.lsp.{display-messages,display-progress-messages}` | true/false | stable | Effective | Routes validated LSP window messages and progress updates through transient status messages. |
| `editor.lsp.{auto-signature-help,display-signature-help-docs}` | true/true | stable | Effective | Separate automatic trigger and documentation visibility. |
| `editor.lsp.{display-inlay-hints,inlay-hints-length-limit}` | false/unset | stable | Effective; versioned LSP inlay hints are decoded, length-limited and rendered as virtual annotations | Uses exact Helix names, accepts string and label-part results, and rejects invalid coordinates or limits. |
| `editor.lsp.snippets` | `true` | stable | Effective; capability advertisement and snippet completion filtering are configurable | Controls LSP snippet support in the launched editor. |
| `editor.lsp.display-color-swatches` | `true` | stable | Effective | Requests negotiated LSP document colors and paints validated one-cell RGB swatches inline; `false` suppresses the request and annotation. |
| `editor.lsp.goto-reference-include-declaration` | `true` | stable | Effective | Controls the LSP `textDocument/references` `includeDeclaration` context used by `:xi references` and the `lsp.references` command binding. |
| `editor.lsp.auto-document-highlight` | `false` | master | Effective | Requests negotiated LSP document highlights at the primary cursor and paints validated ranges with `ui.highlight`. |
| `editor.auto-pairs` or `editor.auto-pairs.'x'` | `true`, standard pairs | stable | Effective | Boolean disables pairing; a validated single-character table reaches the owned Vim insert engine, including closer-skip and paired backspace. |
| `editor.auto-save` or `editor.auto-save.focus-lost` | `false`; table form defaults false | stable | Effective | Boolean/table schema and focus-loss saves use the guarded versioned save path. |
| `editor.auto-save.after-delay.{enable,timeout}` | false/3000 ms | stable | Effective | Resets on edits and routes through the guarded versioned save path; cancellation and quit clear pending timers. |
| `editor.search.{smart-case,wrap-around}` | true/true | stable | Effective for Xi's owned workspace-search panel; Vim search remains Neovim-owned | Smart-case matching and wrap-around result navigation are loaded from the launched editor config. |
| `editor.whitespace.render` and `.render.{default,space,nbsp,nnbsp,tab,newline}` | `none` | stable | Effective | String/table render modes and per-kind visibility reach the bounded viewport painter. |
| `editor.whitespace.characters.{space,nbsp,nnbsp,tab,tabpad,newline}` | Helix glyphs | stable | Effective | Validated single-cell glyphs render spaces, tabs, non-breaking spaces and line endings in the launched editor. |
| `editor.indent-guides.{render,character,skip-levels}` | false/`│`/0 | stable | Effective | Visible leading indentation renders the configured glyph, honoring skipped levels in the launched editor. |
| `editor.gutters.layout` | standard five entries | stable | Effective | Ordered gutter components reach the bounded viewport geometry; scalar `gutters` and table `layout` forms share validation. |
| `editor.gutters.line-numbers.min-width` | `3` | stable | Effective | Reserves the configured minimum number width and composes with absolute/relative numbering. |
| `editor.soft-wrap.{enable,max-wrap,max-indent-retain,wrap-indicator}` | false/20/40/`↪ ` | stable | Effective | Soft-wrap limits now control bounded word breaks and continuation indentation; indicators remain non-editable layout annotations. |
| `editor.soft-wrap.wrap-at-text-width` | `false` | stable | Effective | Uses `editor.text-width` as a bounded layout wrap width. |
| `editor.smart-tab.enable` | `true` | stable | Effective; maps the launched editor setting to owned Vim insertion | |
| `editor.smart-tab.supersede-menu` | `false` | stable | Effective | When a completion menu is open, configured `true` routes Tab to the owned smart-tab insertion path instead of accepting the selected item. |
| `editor.inline-diagnostics.{cursor-line,other-lines}` | disable/disable | stable | Effective | Filters inline diagnostics by severity on the cursor line and other lines; master changes only `cursor-line` default to warning. |
| `editor.inline-diagnostics.prefix-len` | 1 | stable | Effective; diagnostic branch prefixes use the configured number of horizontal bars | |
| `editor.inline-diagnostics.max-wrap` | 20 | stable | Effective; diagnostic wrapping honors the configured maximum trailing free space | |
| `editor.inline-diagnostics.min-diagnostic-width` | 40 | stable | Effective; narrow viewports suppress diagnostics and edge anchors receive the configured minimum text width | |
| `editor.inline-diagnostics.max-diagnostics` | `10` | stable | Effective | Caps the number of inline diagnostics rendered for each source line. |
| `editor.word-completion.{enable,trigger-length}` | true/7 | master | Effective | Bounded open-buffer word completion is wired into the launched automatic completion path and honors enable/trigger-length. |
| `editor.workspace-trust.{level,prompt,trusted}` | servers/true/[] | master | Effective | Gates workspace config, LSP/DAP and Git execution; hashes trusted `.helix` inputs and detects changes. |
| `editor.clipboard-provider.custom.{yank,paste,primary-yank,primary-paste}` | required yank/paste; primary optional | stable | Effective | Each command is validated argv; stdin/stdout carry contents. |
| `editor.terminal.{command,args}` | optional | source schema | Missing | Treat as source-backed, not documented stable compatibility. |

The pinned Helix binaries reject empty `[editor.gutters.diagnostics]`, `.diff`,
`.spacer`, and `.code-action-hint` tables despite headings in the reference docs.
Xi rejects them too; enable a gutter through `editor.gutters.layout` instead.

## Xi extensions and migration

Xi-specific functionality stays, but it must not overload a Helix path with different
semantics. New extensions live under `[xi]`; legacy spellings receive a source-located
deprecation diagnostic for one development cycle and are then removed.

| Current Xi path | Replacement |
| --- | --- |
| `schema-version`, `profile` | `[xi].schema-version`, `[xi].profile` |
| `editor.theme` | top-level `theme` |
| `editor.wrap` | `editor.soft-wrap.enable` |
| `editor.cursor-shape.visual` | `editor.cursor-shape.select` |
| `editor.lsp.inlay-hints` | `editor.lsp.display-inlay-hints` |
| `editor.mouse.enabled` | `editor.mouse` |
| `editor.mouse.scroll-lines` | `editor.scroll-lines` |
| `editor.mouse.modifier` | `xi.mouse.modifier` |
| `editor.sidebar-visible/width/panel` | `[xi.sidebar].{visible,width,panel}` |
| `editor.motion-trail` | `xi.motion-trail` |
| `editor.selection-limit/history-limit` | `xi.selection.limit/history-limit` |
| `editor.hints.delay-ms` | `xi.hints.delay-ms` |
| `search.debounce-ms/max-visible-results` | `xi.search.debounce-ms/max-visible-results` |
| `search.hidden/follow-symlinks` | Migrate carefully to `editor.file-picker`: Xi's old `hidden=true` means include hidden files, opposite Helix's ignore-hidden meaning. |
| `aliases` | `xi.aliases` until a compatible command form exists |
| Xi panel key contexts | `xi.keys.<context>`; Helix-compatible modes remain under `[keys]` |

The existing sidebar, motion trail, selection safety limits, mouse modifier, command
discovery, aliases, tasks, multi-cursor controls and richer panels are intentional Xi
features. Parity must not remove them.

## Implementation order

The configuration ledger is the roadmap; there is no ticket ledger.

1. Make root loading, `theme`, key-mode names, strict schema data and migration diagnostics
   Helix-shaped. Add a canonical 25.07.1 fixture validated by both editors.
2. Wire the already-parsed core keys end to end, then adopt persistence keys whose product
   behavior already exists (`atomic-save`, line endings, trims).
3. Implement rendering/layout sections: cursor shapes, line numbers, gutters, statusline,
   picker/explorer/buffer options, whitespace, rulers, guides, borders, wrapping and
   diagnostics.
4. Implement completion/LSP/search/auto-pair/smart-tab settings with stale-response and
   input-latency coverage.
5. Implement shell, clipboard, EditorConfig and workspace trust last because they cross
   executable trust boundaries.
6. Re-audit against the pinned stable release and current master. Every row must be
   Effective or carry a documented intentional Xi divergence before claiming parity.

Each change should complete a vertical slice: schema, default, migration, production
consumer, negative validation, behavioral test, PTY-visible effect and Helix comparison.
Update that item's ledger evidence in the same change. Do not bulk-add accepted keys ahead
of their consumers or mark an item `effective` before the ledger gate accepts it.
