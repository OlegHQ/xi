# Themes

Xi ships `xi-light`, `xi-dark`, `xi-ocean`, and `xi-paper` in the executable. Press Space+t to preview themes, Enter to keep one, or Escape to cancel. Set `editor.theme` in `config.toml` to choose one at startup.

```toml
[editor]
theme = "xi-dark"
```

Custom Helix-style TOML themes live in `~/.config/xi/themes/`. Name the file after the theme ID, then select it in the picker or config. Xi resolves palette values, scope styles, and inheritance. The [theme configuration reference](docs/configuration.html) records the implemented surface and any gaps.

```toml
# ~/.config/xi/themes/my-theme.toml
"ui.background" = { bg = "#151924" }
"ui.text" = "#e8edf5"
"ui.selection.primary" = { bg = "#354d68" }
"ui.cursor.primary" = { fg = "#151924", bg = "#e8edf5" }
"ui.menu" = { fg = "#e8edf5", bg = "#222c3b" }
"ui.menu.selected" = { fg = "#151924", bg = "#a5d6ff" }
error = "#ff8f8f"
```

The built-in dark palette uses [Catppuccin Mocha](https://github.com/catppuccin/catppuccin) colors under MIT. The three other built-in palettes are original Xi themes under MIT. Both license texts ship with the release archive; see [third-party notices](docs/installation/THIRD-PARTY-NOTICES.html). Custom theme authors retain responsibility for their source themes' licenses.
