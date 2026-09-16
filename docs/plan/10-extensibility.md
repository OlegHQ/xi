# Extensible ownership contracts

Extensibility means future features can be added through small reviewed contracts without changing document ownership or routing semantics. It is required architecture work now. A public third-party plugin runtime, marketplace, arbitrary scripts and binary ABI remain later products, with their own trust/isolation/versioning decisions. These are separate scopes; deferring a plugin host does not defer modularity.

## Stable boundaries

`packages/contracts` owns inert command/provider/read-model schemas and identifiers, using primitives only. `packages/workbench` owns registry instances, focus, invocation/edit coordination and service orchestration. `packages/vim` owns all modal grammar, built-in command resolution, ranges and editing policies; its command descriptors conform to shared schemas but do not import the workbench registry. `packages/document` owns text/history/anchor mechanics. `packages/selections` owns pure selection values and transforms. `packages/layout` owns cell projection/hit testing. `packages/ui` consumes models and binds presentation slots to commands. Composition in `apps/xi` installs trusted built-in feature modules explicitly.

An editing-session interface exposes immutable state and typed dispatch/planning APIs. A contributed workbench handler receives a scoped context with read-only snapshots, selection generation, cancellation, a declared service capability and proposal submission; it never receives a writable buffer, OpenTUI node or the unrestricted composition root. In-process types are an architecture boundary, not a sandbox: import tests and code review enforce it for trusted code. Untrusted executable features would require a separate process/protocol design.

## Command and contribution descriptors

A descriptor includes namespaced stable `CommandId`, owner, schema version, title/help/category, typed argument/result validation, context availability and disabled reason, selection policy, effect class (`read`, `selection`, `document`, `workspace`, `external`), undo/dot/macro policy, cancellation policy and handler registration. Aliases/keybindings/menu locations are contributions referencing that ID; they are not parallel implementations. Validate arguments at config/persistence/protocol boundaries even if internal callers use TypeScript. Display labels can change without breaking IDs in user config.

The initial registry supports explicit built-in modules registering commands, panel/picker read-model providers, versioned decorations, configuration/theme schemas and language/navigation/formatter providers. Add only a real needed interface. Avoid a universal plugin base class, untyped string event bus, reflection discovery, monkey patching and arbitrary synchronous pre-keystroke hooks. Commands may call typed services via injected ports, never find them through a global locator. Provider interfaces return immutable values/proposals, scoped errors and cancellation, not UI renderables.

Registration builds a candidate immutable registry generation. Duplicate IDs, native Ex alias collisions, missing command references, dependency cycles, invalid schemas and incompatible provider contracts reject the candidate atomically. Existing registry remains usable. Ordering is deterministic by declared priority and stable ID. Equal-priority conflicts are diagnosed; no last-import-wins behavior. Read-only capability queries used in menus are cached/bounded and cannot run a language server or scan a workspace.

Providers have distinct IDs and capability sets; multiple active language servers are resolved by explicit feature arbitration rather than overwriting one slot. An action result carries provider origin so lazy resolve returns to the right service. Provider arbitration decisions and command/key origin are visible through an inspector. The default profile installs modules through an explicit manifest/composition list, not source-file side effects.

## Lifecycle and evolution

Every registration returns a disposable handle owned by a feature scope; scopes form workspace/document/view lifetimes. Activation may be async but opening a file or typing never waits for unrelated feature activation. Scope disposal cancels pending requests, unregisters contributions and invalidates result generations before releasing resources. A late promise cannot resurrect a panel or apply an edit. Handler failure becomes a typed outcome with origin; it does not crash the input loop or leave a half-applied command.

Command invocations capture document, view, selection and registry generations relevant to the action. Editing commands serialize at the coordinator; a provider cannot issue a reentrant document commit from a change notification. Read-model notifications happen after a coherent commit, are scoped, and have queue bounds. Inactive providers must not retain snapshots indefinitely. Slow extension-style features use the existing worker/process ports where measurements justify it; built-in editing has no arbitrary middleware chain.

Public internal contracts have an owner and contract version. Changes use additive fields or explicit migrations; a breaking shape changes the version and all consumers together before merge. Unknown discriminants fail closed with diagnostics. Persisted config/session/selection/undo data has a separate schema version and migration fixtures, including old-to-new and unsupported-future input. Renamed command IDs keep reviewed deprecation aliases for at least one declared config schema transition; removing an alias produces an actionable migration error, not a no-op. Do not claim independent plugin compatibility from internal version numbers.

Config reload compiles schemas, keys, aliases and descriptors against one candidate generation and swaps only after validation. Pending sequences finish under their captured generation as specified in [interaction](09-interaction.md); disposed handlers cancel safely. Executable config changes retain the services trust policy. A new feature cannot bypass it through a command alias. Save/export exclude transient provider objects and live process handles.

## Concrete architecture tests

`EX01`: register a small example picker and read-only command through public contracts, with a default key contribution, alias and help text. Execute via palette, key, `:Xi` and mouse activation; each reaches the same handler exactly once. No edits to the Vim parser, document internals or central UI dispatch switch are allowed. The example is a dev fixture, not a fake production replacement for an actual feature.

`EX02`: install a formatter/provider that returns an edit proposal and demonstrate version checks, one undo group, selection mapping and cancellation through the production coordinator. Verify forbidden direct imports fail architectural checks. Test code must not rely solely on type signatures to prove runtime ordering.

`EX03`: activate/dispose/reload the example 1,000 times with requests in flight. Verify old results cannot act, duplicate contribution failures preserve the old generation, no retained subscriptions/processes/views, and memory retention stays within [the release budget](05-validation.md).

`EX04`: migrate a prior config/session fixture containing aliases and multiple selections; reject unknown future schema without modifying original bytes. Demonstrate command ID stability across label changes, deterministic provider arbitration, missing capabilities and generation capture during a prefix sequence.

`EX05`: add a real built-in feature using the same entrypoints (the file picker and theme/config commands are initial consumers). The gate fails if those features use private wiring that the example did not exercise. Document each new seam with one actual consumer, allowed imports, cancellation/error behavior and a removal path.

## Implementation sequence

T008 establishes import boundaries. T074 establishes inert command descriptors and registry before T013's grammar metadata. T075 establishes selection values before T012/T013/T015 lock core state. T076 implements one-base multi-command preparation; T077–T080 finish motion/Visual/Insert, registers and dot behavior, with T092 macros and T093 history before G2. T081 adds selection manipulation. T082/T083 implement prefix help and command-line discovery. T084–T086 cover pointer feasibility, layout hit testing and editor gestures; T094 finishes workbench mouse controls. T087 adds motion paint; T095 covers session continuity; T088/T089 cover language integration and qualification; T090/T091 implement contributions and prove evolution. Tickets preserve single owners and explicit evidence; none is satisfied by a design-only stub. See [the backlog](tickets.json) for exact prerequisites.

## Resource contract

Every contribution/provider declares or inherits a catalog operation and retained/queued resource allowance. Workbench admission uses typed owner counters, without a generic mutable service lookup or document mutation. Disposal releases callbacks, results, workers and snapshot leases; normal extension/control code need not adopt inner-loop allocation style. See [performance engineering](12-performance.md).
