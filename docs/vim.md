# Vim behavior

Xi owns its Vim engine. Neovim 0.12.4 is a pinned development oracle only; there is no
runtime process, library, remote connection or fallback.

Neovim is the semantic oracle for Vim modes, motions, operators, registers, repeat,
search and undo. Xi does not adopt Helix's general editing model or keybindings. Helix is
the separate 1:1 oracle for multi-selection behavior: creation, primary identity,
direction, merge/deduplication, mapping through document changes and simultaneous edits.
When the two models intersect, Vim determines the command and Helix determines how that
command is applied across the selection set.

Behavior comparisons include text, semantic cursor and desired column, mode, selection
shape, registers and types, marks, repeat/search state and undo history. UTF-8 oracle
columns are converted against the exact checkpoint document before comparison. Rendering
graphemes, Vim characters and terminal cells remain distinct coordinate spaces.

Implement semantics in the parser/motion/range/operator owner, never in the UI. For a
change, add the smallest differential fixture first, cover counts and operator/select
composition, then test a following command so latent repeat or history state is visible.
Search uses Xi's owned Vim dialect with explicit cancellation and zero-width progress.

The pinned binary, runtime hashes and generated inventory live under `tests/oracle` and
`docs/compatibility`. Personal `~/.config/nvim` is research data only and must not be
executed or modified.
