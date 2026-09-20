# Neovim compatibility data

`neovim-0.12.4.json` is the generated command-index seed for Xi's pinned development
oracle. The smaller JSON files are measured motion/boundary fixtures consumed by tests.
They establish only their recorded options and inputs; an inventory row is not a parity
claim.

Fetch and validate the pinned Linux ARM64 release, then run the oracle suite:

```sh
bun run oracle:fetch
bun run test:vim
```

Oracle execution uses `--clean -u NONE -i NONE --noplugin`, a temporary `HOME`, isolated
XDG directories, `C.UTF-8`, UTF-8 text, Unix EOLs, single-width ambiguous characters and
plain buffers. The binary and runtime documentation are hash-checked before use.
`XI_NVIM` may select a local binary for integrity checks, but it must match the pinned
binary hash. See [Vim behavior](../vim.md).
