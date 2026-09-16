# Vim-first interaction and architecture research

## Recommendation

Make a versioned selection set a foundation of the editor, with the singleton case exercising the same production path. Extend Vim command execution over that set while preserving Vim's grammar and per-cursor range semantics. Borrow selection creation and discovery from Helix and VS Code, provide comprehensive terminal mouse interaction, and render an optional motion trail independently of semantic selections. Establish typed command/provider contributions now; introduce an external plugin runtime only as a separate future product.

This recommendation balances familiar editing with extensibility. It avoids a second modal engine and prevents cursor state, mouse ranges or language edits from becoming independent writable stores. Its performance advantage is a design hypothesis to measure in G0/G1 and the release scale tests, not a claim established by another editor's implementation.

## What the primary sources establish

### Helix selections are real editing state

Helix describes selection-first editing and multiple selections as central interactions. Its cursor is presented as a narrow selection. That explains why movement can appear to leave a highlight: the selected region is part of the editing model, not necessarily a decorative trail. The observed experience therefore supports borrowing visible feedback, but does not justify changing what Vim `d`, `w` or `x` mean. No screenshot or runtime trace of the particular reported “ghost” was supplied, so that identification is an interpretation, not a confirmed diagnosis of a specific Helix setting.[^1]

The keymap confirms material semantic differences: Helix find/till can cross lines; it has explicit selection splitting/filtering and primary-selection operations; and familiar keys have different roles from Vim. Directly importing its keymap would violate Xi's Vim requirement. Xi consequently exposes comparable selection-management actions through named commands and leader mappings while preserving the native editing keys.[^2]

Source inspection shows a nonempty collection with a primary member, directed anchor/head ranges and transformations through document changes. Helix uses character gap offsets and grapheme-aware cursor helpers. Its precise endpoint and merge conventions cannot be copied into Xi's UTF-16 document/Vim endpoint model without adaptation. The reusable idea is a first-class collection with explicit direction, primary identity and mapping—not the literal position representation.[^3]

The transaction implementation includes batch position mapping. Its documented fast path traverses sorted positions and changes together, while unsorted inputs can fall back to worse behavior. This is especially relevant when an edit has as many changed ranges as cursors. Xi therefore requires sorting once and measured batched mapping instead of repeatedly transforming each cursor against every edit.[^4]

### VS Code provides useful multi-cursor ergonomics

VS Code documents additional cursors by modifier-click and above/below commands, next-occurrence and all-occurrence selection, skip-next behavior and configurable modifier conflicts. It also distinguishes box selection. Xi can adapt these workflows, but desktop chords cannot be assumed to arrive intact through a terminal, multiplexer or remote session. Named commands and plain leader sequences are therefore required alternatives.[^5]

The inspected cursor collection maintains a primary cursor and normalizes overlaps with deliberate treatment of touching ranges and collapsed cursors. This is evidence that overlap and primary identity need explicit policies; it is not a reason to adopt every upstream policy. Xi separates selection canonicalization from edit-conflict resolution so range merging cannot silently choose replacement text.[^6]

### Discoverability is metadata plus correct routing

Helix documents typable commands with aliases, while editor configuration exposes automatic information boxes. Inspected code connects pending keymap nodes to an information box and places aliases/help alongside typable command definitions. This supports a shared description model for execution and discovery. It does not establish that Helix's command abbreviations, bang behavior or timing match Vim.[^7][^8][^9]

Neovim documents command-line completion separately from execution, and write/quit commands have distinct effects. In particular, closing a window is not invariably exiting the application; writing-and-quitting is not identical to writing only if modified. Xi preserves those semantics and uses friendly exact aliases only after collision checks. The suggestion UI is allowed to explain a native error; it is not allowed to force a quit because that makes the journey shorter.[^10][^11]

VS Code's contribution documentation separates command descriptors, menu visibility and command enablement. Its public API also demonstrates command registration and disposal. Xi adopts the separation between metadata, routing and handlers, while using its own small typed contracts rather than promising compatibility with the VS Code API or extension host.[^12][^13]

### Terminal mouse support needs a complete boundary

Xterm distinguishes mouse event reporting modes from coordinate encodings. SGR encoding and button-motion reporting are separate controls; pixel reporting is another mode. Xi must negotiate/configure and restore them coherently, retain press/release ordering and treat terminal-native selection as a terminal-dependent interaction. A Boolean mouse preference alone is not a mouse architecture.[^14]

The inspected OpenTUI source contains a mouse parser with SGR/basic sequence handling, coordinates, modifiers, button state and scroll information. Renderer source includes event dispatch and mouse lifecycle behavior. This makes the existing adapter the first integration point to prototype. It does not prove chunking, capture, hit testing or all advertised terminals work for Xi; those require pinned-package experiments and actual PTY journeys.[^15]

### Appearance should communicate different states

Helix theme documentation names primary and secondary selection/cursor-related styles. That supports making the primary visually distinguishable. Xi additionally needs separate motion-trail and operator-preview styles because its Vim-first design has different semantic states. The proposed light colors are Xi candidates, not copied appearance guarantees or measured contrast results.[^16]

## Alternatives and tradeoffs

| Alternative | Benefit | Problem for Xi | Decision |
|---|---|---|---|
| Keep one cursor and emulate batches with macros | Minimal initial engine changes | Does not meet first-class multiple-cursor requirement; weak shared undo and visibility | Reject |
| Implement Helix selection-first mode alongside Vim | Familiar Helix selection behavior | Two grammars, duplicated range/repeat semantics and ambiguous default editing | Reject as initial architecture |
| One complete engine instance per cursor, run sequentially | Appears to reuse singleton execution | Later cursors observe changed text; conflicting registers, history and effects; can scale quadratically | Reject |
| One shared Vim grammar with per-selection resolution and one transaction | Reuses semantics; coherent state and undo; explicit policies | Requires overlap, register and command-cardinality decisions up front | Adopt |
| Treat every visible highlight as editable selection | Simple view model | Decorative motion feedback changes destructive edit scope | Reject |
| Put text-selection logic in mouse/render widgets | Quick prototype integration | Bypasses Vim word/block rules and version validation | Reject |
| Build generic third-party plugin host now | Broad extensibility story | Premature compatibility/security/process obligations without real consumers | Defer host; require internal contribution contracts now |
| Delay command metadata until panels are finished | Fewer foundation tickets | Help, aliases and mappings grow separate routing logic | Move metadata/registry into G1 prerequisites |

The largest deliberate semantic extension is the multi-cursor command contract. Independent local motions can be compared with isolated Neovim runs. Composition, overlaps and vector registers have no assumed Neovim multi-cursor oracle; Xi must publish and test those choices directly. Singleton parity remains a full independent release gate. Unsupported provider capabilities are visible context states, not permission to omit built-in editing families.

A batch model also changes failure behavior: a conflicting mutating command rejects the entire batch before changing text or registers. This is preferable for inspectability to half a rename-like operation, but must be explained and tested. Nonmutating motion failures can leave only the failing cursors still. Selection-management commands have bounded history separate from text undo. These decisions are specified in [08-selections](08-selections.md), not left to an implementation agent's intuition.

Completion deserves a separate boundary. A server-supplied edit for one cursor is not intrinsically an edit for every cursor. Xi validates equivalent local contexts, deduplicates shared additional edits, and commits once. Incompatible cases expose an explicit primary-only action. This preserves useful ordinary multi-cursor completion without inventing a server protocol or sending thousands of implicit requests. All position-sensitive responses must validate selection generation as well as text version.

Mouse quality is largely a layout and lifecycle issue: the engine must receive a versioned semantic hit, not a screen row guessed by a widget. Capture must survive leaving the target but end on focus loss/disposal; autoscroll must not outlive the gesture. Terminal protocol limitations are real and need keyboard alternatives. These are implementation acceptance cases, not reasons to call strong mouse support optional.

## Gaps found in the prior plan

| Prior gap | Consequence if left unresolved | Plan correction / owner |
|---|---|---|
| True multi-cursor explicitly deferred | An agent could correctly follow the old brief and omit the feature | Required capability in brief; T075–T081/T092/T093 |
| Cursors mentioned per view, without a set/version contract | Special-case singleton APIs and stale cursor-sensitive results | Selection set, stable IDs and generation; T075/T095 |
| Transactions reject overlaps but callers lack composition rules | Sequential edits or arbitrary merging could corrupt batch intent | Preflight, conflict rules and coherent commit; T076 |
| Register/repeat/macro semantics only singleton | Cursor count multiplies effects or loses fragments/history | Vector register, replay and history policies; T079/T080/T092/T093 |
| Command registry late in workbench work | Engine, aliases and help grow independent command inventories | T074 before parser metadata, T082/T083 |
| Mouse only a setting/optional journey | Missing geometry, capture, restoration and terminal qualification | T084–T086/T094 plus mandatory journeys |
| No definition of motion “ghost” | Accidental adoption of selection-first deletion behavior | Separate engine preview and paint, equivalence checks; T087 |
| Extensibility described as narrow ports without an evolution exercise | Private coupling may pass superficial graph checks | Contributions, lifecycle, migrations and real consumers; T090/T091 |
| No cursor-count performance dimension | Quadratic anchor work remains hidden by single-cursor benchmark | 1–10,000 scale, cancellation and retention gates; T089/T062 |
| Language edits validate text but not selection changes | Late completion can apply at a moved/removed cursor | Selection-sensitive generations and shared-edit policy; T088 |
| UI close review could replace native Ex failure behavior | `:q` loses Neovim feel despite correct text editing | Separate native Ex and explicit workbench close actions; T083 |

## Confidence and open measurements

The architectural recommendation has direct support from official behavior documentation and inspected source, but no Xi runtime exists in this planning baseline. No interaction/performance/visual gate is passed by this report. Exact storage choice, OpenTUI package/native artifact, Neovim oracle version, terminal matrix and all numeric budgets still require their planned experiments. No claim is made to have executed Helix, imported a personal editor configuration, or proven an optimal implementation by benchmarking.

Research was reviewed on 2026-09-14. Source code links below use exact inspected revisions, which are research pins rather than Xi dependency selections or claims of released versions. Documentation links can move; T003 must use help matching its actual oracle pin. Raw downloaded source is disposable under `.artifacts/planning-research/`; durable claims, symbol names and revision links are recorded here so the plan does not depend on that cache. The GitHub API returned the Helix revision dated 2026-07-23, VS Code revision dated 2026-09-14 and OpenTUI revision dated 2026-09-09; this report does not infer release support from those dates.

The earlier objective's general phrase “extensible” is interpreted as maintainable internal extension points for future product work, with external plugins deferred separately. “Ghost selection” is interpreted as a motion-extent visual aid that preserves native edits; it is implemented as a named configurable feature rather than an undocumented imitation. These assumptions preserve the explicit Vim-first and first-class multi-cursor requirements.

## Sources

[^1]: Helix contributors. [Using Helix](https://docs.helix-editor.com/usage.html), sections “Selection-first editing” and “Multiple selections”; accessed 2026-09-14.
[^2]: Helix contributors. [Keymap](https://docs.helix-editor.com/keymap.html), movement and selection manipulation; accessed 2026-09-14.
[^3]: Helix contributors. [selection.rs](https://github.com/helix-editor/helix/blob/079a789e8cb08ead67f19e1971a1b7438b37354b/helix-core/src/selection.rs), `Range`, `Selection`, `normalize`, `map`; inspected revision `079a789e8cb08ead67f19e1971a1b7438b37354b`.
[^4]: Helix contributors. [transaction.rs](https://github.com/helix-editor/helix/blob/079a789e8cb08ead67f19e1971a1b7438b37354b/helix-core/src/transaction.rs), `ChangeSet::update_positions`; same inspected revision.
[^5]: Microsoft. [Basic editing](https://code.visualstudio.com/docs/editing/codebasics), multiple selections and column selection; accessed 2026-09-14.
[^6]: Microsoft. [cursorCollection.ts](https://github.com/microsoft/vscode/blob/2c252a11069d2790ec0f96da0d40850505cae493/src/vs/editor/common/cursor/cursorCollection.ts), `CursorCollection.normalize`; inspected revision `2c252a11069d2790ec0f96da0d40850505cae493`.
[^7]: Helix contributors. [Commands](https://docs.helix-editor.com/commands.html), typable command aliases; accessed 2026-09-14. Moving documentation can lag source and is not Xi's native Ex authority.
[^8]: Helix contributors. [Editor configuration](https://docs.helix-editor.com/editor.html), `auto-info`; accessed 2026-09-14.
[^9]: Helix contributors. [editor.rs](https://github.com/helix-editor/helix/blob/079a789e8cb08ead67f19e1971a1b7438b37354b/helix-term/src/ui/editor.rs), pending keymap `infobox`; [typed.rs](https://github.com/helix-editor/helix/blob/079a789e8cb08ead67f19e1971a1b7438b37354b/helix-term/src/commands/typed.rs), `TypableCommand`; inspected revision as above.
[^10]: Neovim contributors. [Command-line editing](https://neovim.io/doc/user/cmdline/); accessed 2026-09-14. Implementation expectations require matching pinned help.
[^11]: Neovim contributors. [Editing](https://neovim.io/doc/user/editing/), writing and quitting; accessed 2026-09-14.
[^12]: Microsoft. [Contribution points](https://code.visualstudio.com/api/references/contribution-points), commands, menus and enablement; accessed 2026-09-14.
[^13]: Microsoft. [VS Code API](https://code.visualstudio.com/api/references/vscode-api), commands and disposable registrations; accessed 2026-09-14.
[^14]: Thomas E. Dickey / Xterm project. [Xterm control sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html), mouse tracking and SGR 1006; accessed 2026-09-14.
[^15]: Anomaly. [parse.mouse.ts](https://github.com/anomalyco/opentui/blob/ac753b48d386707a931dcf881d0741905b64b4f9/packages/core/src/lib/parse.mouse.ts), `MouseParser`; [renderer.ts](https://github.com/anomalyco/opentui/blob/ac753b48d386707a931dcf881d0741905b64b4f9/packages/core/src/renderer.ts); inspected revision `ac753b48d386707a931dcf881d0741905b64b4f9`.
[^16]: Helix contributors. [Themes](https://docs.helix-editor.com/themes.html), UI selection and cursor scopes; accessed 2026-09-14.
