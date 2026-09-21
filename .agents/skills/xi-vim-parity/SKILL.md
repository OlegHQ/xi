---
name: xi-vim-parity
description: Implement or diagnose Xi's owned Vim semantics with pinned Neovim differential tests.
---

Read [Vim behavior](../../../docs/vim.md), the affected engine code and neighboring tests.
Use the pinned oracle manifest and compatibility inventory. Never load personal
`~/.config/nvim` or introduce a production Neovim dependency.

Neovim remains the oracle for Vim commands and state. Do not replace it with Helix's modal
editing model. Use Helix separately for 1:1 multi-selection creation, primary identity,
direction, merge/deduplication, change mapping and simultaneous-edit behavior.

Identify the exact help tag, modes, options, coordinates and operator/select composition.
Add a minimal oracle fixture first, including incomplete commands where relevant. Compare
text, semantic cursor/desired column, mode, selection kind, registers, marks, repeat/search
state and undo history. Convert oracle UTF-8 columns against the exact checkpoint text.

Implement in the owning parser/motion/range/operator module, never in a widget or second
text store. Run the local regression, neighboring combinations and a second command after
repeat/macro/history changes. Shrink mismatches into committed fixtures.

Search uses Xi's owned Vim dialect and explicit cancellation/zero-width progress. Scope
boundaries for scripting/provider behavior must be stated without excluding built-in
motions to make a gate pass.

For hot-path changes follow [performance](../../../docs/performance.md): bounded reads,
immutable published lifetimes, Unicode coverage and no per-scalar temporary records.
