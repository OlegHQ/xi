---
name: xi-implement
description: Implement Xi editor changes through its ownership contracts and production-path acceptance checks.
---

Read the repository `AGENTS.md`, [architecture](../../../docs/architecture.md) and the
contract relevant to the requested behavior. For configuration work, start with the exact
item in [the configuration ledger](../../../docs/configuration-ledger.json), using
[the parity matrix](../../../docs/configuration.md) for design context. The ledger is the
roadmap; do not create ticket IDs, milestone graphs or per-ticket evidence reports.

Xi uses Bun, strict TypeScript and OpenTUI with an owned Vim engine. Neovim and Helix are
development references only. The document owner is the sole mutable text authority;
renderables display it, Vim requests transactions and asynchronous services submit
versioned proposals.

Do not adopt Helix's editing model while implementing its configuration. Neovim owns Vim
semantics; Helix owns the config contract and 1:1 multi-selection behavior only.

Trace the production path before editing and implement one reviewable vertical slice. A
configuration slice includes the exact key/type/default, legacy migration when applicable,
the production consumer, invalid-input coverage and an observable behavioral check. Never
add a parse-only key to make the matrix look greener. Update the item's ledger validation
paths in the same change and run `bun run check:config-ledger`; `effective` is reserved for
items with every required committed test.

For Vim behavior use `xi-vim-parity`. For UI, integration or performance work use
`xi-validate`. Run the actual checks in [testing](../../../docs/testing.md); a missing suite
or future test is not a pass. Keep decisions in the durable contract or code test, not a
chat-only handoff or revived evidence directory.

Before changing an interactive operation, read [performance](../../../docs/performance.md).
Keep scalar/chunk/cell loops free of temporary allocations, published values immutable and
background work bounded/cancellable. Normal control code stays idiomatic TypeScript.

Finish with the implemented behavior, exact checks and any matrix rows that remain
non-effective. Do not claim broad parity from one accepted fixture.
