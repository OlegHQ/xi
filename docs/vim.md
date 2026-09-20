# Vim behavior

Xi owns its Vim engine. Neovim 0.12.4 is a pinned development oracle only; there is no
runtime process, library, remote connection or fallback.

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
