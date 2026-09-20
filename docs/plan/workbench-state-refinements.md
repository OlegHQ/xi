# Workbench state refinements (2026-09-20)

User-requested corrections, tracked separately from release qualification. Preserve Helix
source themes; adapt their tokens at Xi's surface boundary.

- `:q` closes the active view/buffer and keeps Xi running, including after the final buffer.
  A dirty buffer's last view refuses without `!`; another view may close while its shared
  document survives. `:qa` exits after checking every buffer; `:qa!` explicitly discards.
  This is Xi's requested workbench behavior, not a claim of strict Neovim quit parity.
- `Ctrl-W s` and `Ctrl-W v` must split from normal editor and comparison views. Each pane
  must have its own usable buffer strip, with activation and close scoped to that pane.
  Closing a pane restores focus to a visible surviving pane; failures must be atomic.
- `Ctrl-W h/j/k/l` uses one spatial focus graph for editor panes and the visible sidebar.
  Moving left from the leftmost editor enters the sidebar; moving right from the sidebar
  restores the preserved editor pane. Prefix routing must not depend on help-panel timing.
- A horizontal pane's buffer strip is also its split handle. A click activates its tab;
  movement promotes the same press into ratio resizing without activating or closing a tab.
  When no strip occupies a boundary, retain the one-cell splitter hit target.
- `<leader>s` toggles the whole sidebar on/off, including when the sidebar has focus.
- `~/.xi.toml` persists user state/overrides (including visible panels) over defaults across
  restarts. Preserve unrelated user settings; validate invalid input, report write failures,
  and avoid synchronous disk work on input. Document precedence with existing user config
  and theme state.
- Additional application key commands must be represented in the default configuration
  and remappable through the same command registry. Audit existing hard-coded additions,
  not only the new sidebar shortcut; native editing prefixes must remain intact.
- Automate rendering/contrast analysis for all panels across available themes. Diagnose
  Catppuccin Latte's gray sidebar and muted text from the supplied screenshot, choose
  appropriate Xi token mappings and verify light/dark and selected/inactive states without
  editing Helix themes. Retain rendered artifacts and quantitative results, plus visual
  inspection; do not treat scalar token tests as a complete rendered audit.

Input/rendering changes retain the absolute and paired latency requirements in spec 15.
Missing reference-host or physical measurements remain unproven, never waived.

## Current state file contract

Startup merges built-in defaults, legacy `~/.config/xi/config.toml` and language settings,
then `~/.xi.toml`. The home override layer supports the same validated config schema and key
maps. An explicit `editor.theme` in that layer also takes precedence over the legacy
`~/.config/xi/state.json` selection. New theme commits write only the TOML state file;
previews and cancellation do not persist a theme.

The currently persisted editor fields are `theme`, `sidebar-visible`, `sidebar-panel`
(`files`, `search`, `git`) and `sidebar-width` (22–40 terminal cells). Width writes occur
on resize commit, not on each drag frame. The last panel is restored when reopening a
hidden sidebar, including after restart. Writes preserve unrelated supported TOML settings
and comments, run asynchronously, coalesce pending values per field and flush on shutdown.
A write/parse failure reports an error and leaves the existing file intact. Concurrent
external modification between read and atomic rename is not yet detected.
