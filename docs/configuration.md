# Configuration parity

Xi's next product scope is a Helix-compatible `config.toml` surface. Compatibility means
the same path, type, accepted values, default and observable effect. Accepting a key and
then ignoring it does not count.

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

| Status | Meaning |
| --- | --- |
| Effective | Xi accepts the Helix spelling and the launched editor applies it. |
| Parsed only | Xi accepts it, but production behavior does not consume it. This is not parity. |
| Incompatible | Xi has a related setting under a different path or meaning. |
| Missing | Xi rejects or cannot represent the setting. |

At the audit point, no `[editor]` setting has full end-to-end parity. `scrolloff`,
`line-number`, `mouse`, `cursor-shape.normal`, `cursor-shape.insert` and `lsp.enable` are
parsed but not wired. The few effective settings use Xi-specific paths. This is the gap the
matrix tracks. The canonical fixture at
`tests/fixtures/config/helix-25.07.1.toml` is accepted by the official Helix 25.07.1
binary; Xi currently returns 105 unknown-key/value diagnostics for it.

## Root and loading contract

| Helix-compatible surface | Helix behavior | Xi now | Target |
| --- | --- | --- | --- |
| `theme = "name"` | Top-level theme name | Incompatible: effective as `editor.theme` | Move to the root; keep a diagnosed legacy alias temporarily. |
| `[theme] dark/light/fallback` | Master supports terminal light/dark selection | Missing | Add after string theme parity; preserve explicit persisted selection precedence. |
| `[keys.normal]`, `[keys.insert]`, `[keys.select]` | Static commands, typable commands, command sequences and `@` macros | Incompatible: similar tables, `visual` naming and Xi command IDs | Accept Helix modes and value forms; keep Xi-only contexts under `[xi.keys]`. |
| User `config.toml` | Platform config directory | Effective at `~/.config/xi/config.toml` | Keep the Xi directory but make file contents compatible. |
| Workspace `.helix/config.toml` merge | Built-in → user → workspace | Missing | Read `.xi/config.toml` first; optionally read `.helix/config.toml` as a compatibility source when no Xi file exists. Never execute workspace settings without trust. |
| `-c/--config` | Explicit config path | Missing | Add an explicit CLI override. |
| `:config-open`, `:config-reload`, USR1 | Open/reload atomically | Commands exist in the catalog but startup config is effectively static | Wire last-good atomic reload; failed reload keeps prior behavior and reports source locations. |
| Unknown fields | Rejected by Helix schema | Rejected by Xi's hand-maintained list | Preserve strict rejection. A key enters the list only with a production consumer. |

## `[editor]` scalar and union keys

`Stable` defaults are from 25.07.1. A master change is called out where it changes the
compatibility decision.

| Path | Stable default | Master delta | Xi now | Target note |
| --- | --- | --- | --- | --- |
| `editor.scrolloff` | `5` | — | Parsed only | Wire viewport/cursor-follow behavior. |
| `editor.mouse` | `true` | — | Parsed only; also accepts a non-Helix table | Wire boolean; move Xi mouse extensions out of this path. |
| `editor.middle-click-paste` | `true` | — | Missing | Gate primary-selection paste. |
| `editor.scroll-lines` | `3` | — | Incompatible: effective as `editor.mouse.scroll-lines` | Adopt the Helix path. |
| `editor.shell` | `['sh','-c']` on Unix | — | Missing | Apply to explicit shell commands only; argv-native tasks remain argv-native. |
| `editor.line-number` | `absolute` | — | Parsed only; also accepts `none` | Wire `absolute`/`relative`; retain `none` only as documented Xi extension if needed. |
| `editor.cursorline` | `false` | — | Missing | Render all cursor lines with theme scopes. |
| `editor.cursorcolumn` | `false` | — | Missing | Render all cursor columns without per-key full-frame work. |
| `editor.continue-comments` | `true` | — | Missing | Requires syntax-aware insert behavior and fallback tests. |
| `editor.gutters` | diagnostics/spacer/line-numbers/spacer/diff | Adds `code-action-hint` kind | Missing; Xi gutter is fixed | Implement array/table union and ordered layout. |
| `editor.auto-completion` | `true` | — | Missing | Gate automatic completion, not manual completion. |
| `editor.path-completion` | `true` | — | Missing | Implement bounded path completion for saved and scratch buffers. |
| `editor.auto-format` | `true` | — | Missing; per-language auto-format exists | Add global gate composed with language settings. |
| `editor.default-yank-register` | `"` | — | Missing | Map into the owned Vim register system. |
| `editor.idle-timeout` | `250` ms | — | Missing | One bounded UI idle clock; never debounce keystrokes. |
| `editor.completion-timeout` | `250` ms | — | Missing | Delay only auto-popup publication. |
| `editor.preview-completion-insert` | `true` | — | Missing | Preview must be reversible and versioned. |
| `editor.completion-trigger-len` | `2` | — | Missing | Apply to automatic LSP completion. |
| `editor.completion-replace` | `false` | — | Missing | Preserve LSP text-edit ranges unless this policy expands them. |
| `editor.auto-info` | `true` | — | Missing | Gate contextual info/prefix UI. |
| `editor.true-color` | `false` | — | Missing; renderer has fixed/detected modes | Wire terminal capability override. |
| `editor.undercurl` | `false` | — | Missing | Wire capability override without changing text semantics. |
| `editor.rulers` | `[]` | — | Missing | Render configured columns, with language override later. |
| `editor.bufferline` | `never` | — | Missing; Xi tab strips are fixed | Support `always`/`never`/`multiple`. |
| `editor.color-modes` | `false` | — | Missing; theme scopes exist | Gate mode-colored statusline scopes. |
| `editor.text-width` | `80` | — | Missing | Shared by reflow and optional wrap-at-width. |
| `editor.workspace-lsp-roots` | `[]` | — | Missing | Workspace-only validation and root routing. |
| `editor.default-line-ending` | `native` | — | Missing | Apply only to new documents; preserve existing mixed EOL data. |
| `editor.insert-final-newline` | `true` | — | Missing | Apply at save without changing the in-memory document unexpectedly. |
| `editor.atomic-save` | `true` | — | Missing key; persistence is currently atomic | Expose the policy and cover watcher/hot-reload behavior. |
| `editor.trim-final-newlines` | `false` | — | Missing | Apply as one visible save transaction. |
| `editor.trim-trailing-whitespace` | `false` | — | Missing | Apply as one visible save transaction with undo/history rules. |
| `editor.popup-border` | `none` | — | Missing; popups currently choose borders internally | Support `none`/`popup`/`menu`/`all`. |
| `editor.indent-heuristic` | `hybrid` | — | Missing | Support `simple` first, then tree-sitter/hybrid with explicit fallback. |
| `editor.jump-label-alphabet` | alphabet | — | Missing | Validate uniqueness and feed jump-label generation. |
| `editor.end-of-line-diagnostics` | `disable` | Master default `hint` | Missing; inline diagnostics are fixed | Implement severity filter; retain stable default until a deliberate default update. |
| `editor.clipboard-provider` | platform-specific union | — | Missing | Built-ins plus custom commands at the process boundary. |
| `editor.editor-config` | `true` | — | Missing | Add bounded EditorConfig discovery and language/document precedence. |
| `editor.mouse-yank-register` | — | `*` on master | Missing | Master-forward item after register/clipboard parity. |
| `editor.rainbow-brackets` | — | `false` on master | Missing | Requires language `rainbows.scm`; keep off by default. |
| `editor.kitty-keyboard-protocol` | — | `auto` on master | Missing | Support `auto`/`enabled`/`disabled` in the terminal adapter. |

## Nested editor sections

Brace notation below classifies every listed child key separately.

| Section / paths | Default | Version | Xi now | Target note |
| --- | --- | --- | --- | --- |
| `editor.cursor-shape.{normal,insert,select}` | all `block` | stable | `normal`/`insert` parsed only; incompatible `visual`; no `select` or `hidden` | Use Helix names and values `block`/`bar`/`underline`/`hidden`; migrate `visual` to `select`. |
| `editor.file-picker.{hidden,follow-symlinks,deduplicate-links,parents,ignore,git-ignore,git-global,git-exclude,max-depth}` | all true except unset depth | stable | Missing; top-level `search.hidden/follow-symlinks` are parsed-only and `hidden` has opposite wording | Share one ignore walker with exact Helix semantics. |
| `editor.file-explorer.{hidden,follow-symlinks,parents,ignore,git-ignore,git-global,git-exclude,flatten-dirs}` | false except `flatten-dirs=true` | master | Missing | Configure the existing Explorer independently from picker/search. |
| `editor.buffer-picker.start-position` | `current` | master | Missing | Support `current`/`previous`. |
| `editor.statusline.{left,center,right,separator}` | Helix lists | stable | Missing; Xi statusline fixed | Declarative layout with bounded rendering. |
| `editor.statusline.mode.{normal,insert,select}` | `NOR`/`INS`/`SEL` | stable | Missing | Text only; mode remains engine-owned. |
| `editor.statusline.{diagnostics,workspace-diagnostics}` | warning/error | stable | Missing | Severity filters over existing stores. |
| Statusline element catalog | mode, spinner, file paths/name, modification/read-only, encoding/EOL/indent/type, line counts, diagnostics, selections, register, position/percentage, spacer/separator, VCS | stable | Partial fixed equivalents | Accept exact names; master also adds `current-working-directory` and `code-action-hint`. |
| `editor.lsp.enable` | `true` | stable | Parsed only | Gate server startup and all LSP UI. |
| `editor.lsp.{display-messages,display-progress-messages}` | true/false | stable | Missing | Route through transient status messages. |
| `editor.lsp.{auto-signature-help,display-signature-help-docs}` | true/true | stable | Missing | Separate trigger and documentation visibility. |
| `editor.lsp.{display-inlay-hints,inlay-hints-length-limit}` | false/unset | stable | Incompatible parsed-only `inlay-hints` | Adopt exact names and non-zero limit validation. |
| `editor.lsp.{display-color-swatches,snippets,goto-reference-include-declaration}` | all `true` | stable | Missing | Wire to negotiated capabilities and consumers. |
| `editor.lsp.auto-document-highlight` | `false` | master | Missing | Versioned highlight request/cancel path. |
| `editor.auto-pairs` or `editor.auto-pairs.'x'` | `true`, standard pairs | stable | Missing | Boolean/table union; language override composes with global false. |
| `editor.auto-save` or `editor.auto-save.focus-lost` | `false`; table form defaults false | stable | Missing | Support the boolean shorthand and table union; focus-save requires terminal focus events and ordinary save guards. |
| `editor.auto-save.after-delay.{enable,timeout}` | false/3000 ms | stable | Missing | Reset on edits; cancellation and quit cannot lose data. |
| `editor.search.{smart-case,wrap-around}` | true/true | stable | Missing; Xi top-level search keys mean something else | Feed owned Vim/search state consistently. |
| `editor.whitespace.render` and `.render.{default,space,nbsp,nnbsp,tab,newline}` | `none` | stable | Missing | String/table union (`none`/`all`) and per-kind visibility. |
| `editor.whitespace.characters.{space,nbsp,nnbsp,tab,tabpad,newline}` | Helix glyphs | stable | Missing | Validate one character and terminal-cell behavior. |
| `editor.indent-guides.{render,character,skip-levels}` | false/`│`/0 | stable | Missing | Viewport-bounded rendering only. |
| `editor.gutters.layout` | standard five entries | stable | Missing | Same semantics as scalar `gutters` form. |
| `editor.gutters.line-numbers.min-width` | `3` | stable | Missing | Compose with absolute/relative numbering. |
| Empty `editor.gutters.{diagnostics,diff,spacer}` sections | no children | stable | Missing | Accept empty tables only; unknown children still fail. |
| Empty `editor.gutters.code-action-hint` section | no children | master | Missing | Master-forward layout kind. |
| `editor.soft-wrap.{enable,max-wrap,max-indent-retain,wrap-indicator,wrap-at-text-width}` | false/20/40/`↪ `/false | stable | Incompatible parsed-only `editor.wrap` | Replace the alias with the full section and real layout behavior. |
| `editor.smart-tab.{enable,supersede-menu}` | true/false | stable | Missing as editor config; Vim insert has its own smart-tab semantics | Define precedence between menu routing and owned Vim insertion. |
| `editor.inline-diagnostics.{cursor-line,other-lines,prefix-len,max-wrap,max-diagnostics}` | disable/disable/1/20/10 | stable | Missing; rendering is currently fixed | Severity filters and bounds; master changes only `cursor-line` default to warning. |
| `editor.word-completion.{enable,trigger-length}` | true/7 | master | Missing | Complete from bounded open-buffer indexes. |
| `editor.workspace-trust.{level,prompt,trusted}` | servers/true/[] | master | Missing | Gate workspace config, LSP/DAP and Git execution; hash trusted `.xi` inputs and detect changes. |
| `editor.clipboard-provider.custom.{yank,paste,primary-yank,primary-paste}` | required yank/paste; primary optional | stable | Missing | Each command is validated argv; stdin/stdout carry contents. |
| `editor.terminal.{command,args}` | optional | source schema | Missing | Treat as source-backed, not documented stable compatibility. |

## Xi extensions and migration

Xi-specific functionality stays, but it must not overload a Helix path with different
semantics. New extensions live under `[xi]`; legacy spellings receive a source-located
deprecation diagnostic for one development cycle and are then removed.

| Current Xi path | Replacement |
| --- | --- |
| `schema-version`, `profile` | `xi.schema-version`, `xi.profile` |
| `editor.theme` | top-level `theme` |
| `editor.wrap` | `editor.soft-wrap.enable` |
| `editor.cursor-shape.visual` | `editor.cursor-shape.select` |
| `editor.lsp.inlay-hints` | `editor.lsp.display-inlay-hints` |
| `editor.mouse.enabled` | `editor.mouse` |
| `editor.mouse.scroll-lines` | `editor.scroll-lines` |
| `editor.mouse.modifier` | `xi.mouse.modifier` |
| `editor.sidebar-visible/width/panel` | `xi.sidebar.visible/width/panel` |
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

The matrix is the roadmap; there is no separate ticket ledger.

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
consumer, negative validation, behavioral test and PTY-visible effect. Do not bulk-add
accepted keys ahead of their consumers.
