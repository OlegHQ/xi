---
name: xi-vim-parity
description: Implement or diagnose Xi's owned Vim semantics with pinned Neovim differential tests, minimized regressions and coordinate-aware state comparisons.
---

Read [Vim compatibility](../../../docs/plan/02-vim.md) and the assigned ticket. Locate the pinned oracle manifest and compatibility inventory. If they do not exist, implement or report their prerequisite ticket; do not label handwritten expectations as measured Neovim behavior. Never load personal ~/.config/nvim or introduce a production Neovim dependency.

For a behavior change, identify the exact help tag, modes, relevant options, coordinates, operator/visual composition and expected observable state. Add a minimal oracle fixture first, including failed/incomplete commands where relevant. Use real key-input barriers for insert/mapping timing and geometry-matched UI fixtures for screen motions. `normal!` does not exercise every input path.

Compare text, semantic cursor/desired column, mode, selection kind/block width, registers/types, marks/history and relevant repeat/search/undo state. Convert oracle UTF-8 columns against that checkpoint's actual document. Do not normalize away differences that affect later commands. Keep rendering graphemes distinct from Vim character movement and terminal cells.

Implement semantics in the owning parser/motion/range/operator module, never in a widget or a second text store. Run the local regression, neighboring operator/count/option products, and seeded traces. Shrink mismatches into committed fixtures. Update the inventory only to the level demonstrated by evidence. All in-scope unverified motions and edge cases remain release blockers; passing a sample corpus is not full parity.

For repeat/macros/undo, test a second command after the change to expose latent state bugs. For search, use the owned Vim dialect and test cancellation/zero-width progress; JavaScript or ripgrep regex semantics cannot silently replace it. Scope boundaries for scripting/provider-dependent commands must be stated explicitly without excluding built-in motions to make the gate pass.

Optimize for Xi's declared initial editing requirements, not a copy of Vim's storage, pager, scripting runtime or full application. Retain required motions/edge cases and classify unrelated upstream inventory explicitly; do not expand scope just because an upstream help row exists. For kernel changes use the H0/H1 rules in [performance](../../../docs/plan/12-performance.md): bounded window/chunk reads, byte-accounted caches, safe immutable lifetimes and no per-scalar temporary records. Compare cold/warm Unicode behavior as well as ASCII; a fixed regex overlap, truncated grapheme, dropped selection or missing undo is not a performance optimization.
