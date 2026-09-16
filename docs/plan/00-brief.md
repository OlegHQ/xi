# Xi implementation brief

Xi should make everyday code editing feel immediate: open a project, find a file or symbol, edit with native Vim semantics, inspect diagnostics, apply a code action, replace across files, stage a hunk, and return to the same editing context. The workbench should have the information density of a good terminal tool and the navigability of VS Code. The launch target is a polished local editor, not an extension marketplace.

The prescribed stack is Bun, strict TypeScript, and OpenTUI. **The editing engine is Xi's own implementation.** Neovim exists only in the development test harness. The default theme is an original light theme inspired by OpenCode's restraint; “light” is the interpretation of the requested “kight,” reinforced by the existing Latte configuration. These decisions supersede any earlier embedded-Neovim proposal.

First-class multiple cursors, extensible internal architecture, contextual key/command suggestions with safe aliases, strong mouse support and an attractively painted optional motion trail are required for the initial release. Vim motions and editing remain authoritative. Read [selection composition](08-selections.md), [interaction](09-interaction.md), [extensibility](10-extensibility.md) and the [research and decision record](11-interaction-research.md). A motion trail never changes an edit target, and a multi-cursor extension is not described as native Neovim multi-cursor parity.

## Initial engine and resource scope

The goal is the right engine for Xi's initial requirements, not copying all of Vim. The declared motion/operator/edit contracts and Xi multi-selection behavior stay required; Vim's storage, swap pager, whole application, scripting and plugin compatibility do not become requirements merely because they exist upstream. [Performance engineering](12-performance.md) sets structural hot-path rules and all-owner CPU/memory budgets now; [research](13-performance-research.md) records the implementation audit and representation tradeoffs. SQLite serves only the developer budgets/results ledger. New resource gates are unproven and must complete before release claims.

## Evidence and decisions

OpenTUI provides native rendering with TypeScript bindings and an imperative core surface; it also has renderer/input testing facilities. This makes it a plausible presentation layer, not evidence that a complete editor will be fast. Start with imperative core rendering, a custom virtualized document renderable, and measured dirty-region updates. Do not use its text input buffer as Xi's document model. Verify exported APIs against a pinned installed release before writing integration code. [OpenTUI core](https://github.com/anomalyco/opentui/blob/main/packages/core/README.md), [testing](https://opentui.com/docs/core-concepts/testing/).

Microsoft's text-buffer work is evidence that buffer design and workload measurements matter in JavaScript editors; it is not a benchmark of Xi or proof that moving everything into native code wins. T004 compared an augmented piece tree with a chunked rope under seeded editing, batch, snapshot, anchor and undo workloads, and selected the chunked rope because the piece tree fragmented badly under repeated middle insertion. The evidence and trade-offs are recorded in the [T004 storage decision](../decisions/T004-storage.md). [Text Buffer Reimplementation](https://code.visualstudio.com/blogs/2018/03/23/text-buffer-reimplementation).

Helix supplies a useful configuration shape: TOML editor settings, nested key tables, separate language/server definitions. Xi adopts that shape with its own validated schema and Vim modes; it does not promise drop-in Helix configuration semantics. [Helix configuration](https://docs.helix-editor.com/configuration.html), [key remapping](https://docs.helix-editor.com/remapping.html), [languages](https://docs.helix-editor.com/languages.html).

Owning Vim semantics is the largest delivery risk. Keep all requested motion/edge-case parity in the release contract, but expose incremental compatibility levels honestly. A small corpus of successful `hjkl` and `dw` tests does not constitute parity. Audit the pinned help inventory against Xi’s declared requirements and register unimplemented in-scope behaviors as release blockers; classify unrelated upstream application commands without automatically expanding scope. The intended compatibility boundary and treatment of arbitrary scripting are in [the Vim contract](02-vim.md).

## Priorities and milestones

| Milestone | Usable outcome | Required gates |
|---|---|---|
| M0: feasibility | Rendering, input, buffer, regex, and oracle prototypes with measured choices | G0 |
| M1: foundation | Strict package graph, selection sets, command descriptors, transactions, coordinate conversions, repeatable harness | G1 |
| M2: editing | Own engine, broad motion/operator/visual/insert/repeat coverage including multi-cursor composition | G2 |
| M3: daily navigation | Polished workbench, file picker, Explorer/Outline shell, directory editing, search/replace | G3 |
| M4: language intelligence | Real LSP lifecycle, diagnostics, completion, navigation and transactional edits | G4 |
| M5: source control | Read/write Git workflows, hunk staging, conflict review, task output | G5 |
| M6: release | Full declared parity gate, performance qualification, UX review, packaging | G6 |

M2/M3 builds can be labeled previews. They cannot be described as Neovim parity or production ready. No calendar estimate is committed before M0; parity is a substantial language/compatibility project, and unknown feature inventory must increase the backlog rather than disappear into a deadline.

## VS Code capability adaptation

This is a broad capability-family survey, not a claim to enumerate every command contributed by every VS Code extension. Each family is explicitly included, adapted, deferred, or excluded. Required work is ticketed; deferred rows are beyond the initial editor release and must not be mistaken for implemented functionality. UI layout, navigation and baseline editing are documented by VS Code. [User interface](https://code.visualstudio.com/docs/editing/getting-started/userinterface), [navigation](https://code.visualstudio.com/docs/editing/editingevolved), [basic editing](https://code.visualstudio.com/docs/editing/codebasics).

| Capability family | Xi adaptation | Release disposition / owner |
|---|---|---|
| Activity bar, primary sidebar, bottom panel | Text tabs, commands and persistent focus; no mandatory icon rail | Required / workbench |
| Explorer, open editors, compact folders | Virtualized tree, dirty and Git badges, stable selected file, optional compact paths | Required / workspace + UI |
| Outline and breadcrumbs | Capability-gated LSP symbols, nested tree and current symbol; stale marker | Required / language + UI |
| Tabs, preview editors, editor groups | Preview slot per group, promotion on edit, buffer picker, horizontal/vertical splits | Required / workbench |
| Quick Open and command palette | One picker grammar with file, command, symbol, line and buffer modes | Required / navigation |
| Back/forward, locations, references and peek | Vim jump history plus explicitly separate result traversal; keyboard peek | Required / navigation + Vim |
| Find and replace, search editor | Native Vim buffer search; streamed workspace search and reviewable replacement plan | Required / search |
| Regex/case/word/include/exclude/preserve case | Labeled search dialect, visible flags, tested replacement semantics | Required / search |
| IntelliSense and snippets | LSP completion, documentation, signature, explicit selection, snippet navigation | Required / language |
| Hover, definitions, type, implementations, references | Capability-aware commands and cancellable results | Required / language |
| Refactor, rename, organize imports and code actions | Workspace-edit preview and version-checked apply | Required / language + document |
| Problems, quick fixes, inline diagnostics | Workspace list, gutter severity, quiet inline current-line view | Required / language + UI |
| Semantic tokens, folding, selection ranges | Layered syntax/semantic styles; versioned fold/selection services | Required / language + layout |
| Format, format on save, indentation, EditorConfig | Ordered formatter policy, one logical undo group, overrides explained | Required / formatting + config |
| Autosave, hot exit, reopen sessions | Explicit save default, opt-in autosave, durable recovery, separate session layout | Required / persistence |
| Encoding, line endings, large files | UTF-8 fidelity first; explicit codec/BOM policy and large-file budgets | Required / document + platform |
| Multi-cursor | Shared Vim grammar over first-class selection sets; occurrence/line/regex creation, atomic edits, repeat/history and language integration | Required / selections + Vim + workbench |
| Mouse | Editor selection, multiple carets, scroll, controls, split resizing, capture and terminal restoration | Required / input + layout + Vim + workbench |
| Command discovery and aliases | Contextual prefix help and Ex completion from shared metadata; native Ex resolution retained | Required / Vim + workbench + UI |
| Motion trail | Optional static motion-extent paint, distinct from actual Visual selections and edit ranges | Required configurable feature / Vim + UI |
| Minimap and sticky-scroll | Breadcrumbs, outline and location indicator; optional sticky context after profiling | Minimap excluded; sticky context deferred |
| Source control groups, diff, stage, commit | Worktree/index distinction; file/hunk actions; multiline Vim commit buffer | Required / Git |
| Branches, worktrees, history, stash, blame | Picker and read-only history; guarded branch/stash commands | Required basic branch/history; advanced worktree management deferred |
| Merge editor | Base/ours/theirs/result navigation with explicit resolution state | Required / Git + diff UI |
| Sync, pull, push, remote hosting | Explicit commands with progress and errors; no commit-and-push default | Basic Git commands required; hosting integrations deferred |
| Terminal and output | Task output first, separately gated PTY terminal and explicit terminal focus mode | Tasks required; general terminal deferred |
| Build tasks, problem matchers, test runner | Configured argv tasks; diagnostics import; output navigation | Basic tasks required; rich test explorer deferred |
| Debugging, breakpoints, watches, DAP | Future adapter behind same workbench contracts | Deferred |
| Multi-root workspaces | Root identity in every document/search/server/repo contract from day one | Required |
| Profiles, keybindings, settings, themes | TOML profiles, configuration diagnostics, theme picker and inspector | Required |
| Accessibility | Keyboard-only paths, contrast, ASCII mode, no-color mode, quiet motion | Required; screen-reader support must be evaluated, not presumed |
| Settings sync, accounts, telemetry | Local config files and exportable profiles | Sync/accounts excluded; local opt-in profiling only |
| Internal extensibility | Typed command/provider/view contributions, deterministic lifecycle, migrations and real consumer tests | Required / architecture + workbench |
| External extensions, webviews, notebooks, custom editors | Future plugin host behind owned contracts; no arbitrary in-process extension API initially | External host deferred; webview/notebook parity excluded |
| Remote SSH/containers/tunnels | Run Xi inside an existing SSH/tmux session | Required terminal compatibility; remote orchestration deferred |
| AI chat/agents/inline generated code | No core dependency; ordinary edit transactions can support future integrations | Excluded from initial scope |

Git staging/commit and merge workflows have separate VS Code documentation. Tasks and debugging are distinct subsystems, which supports separating them in Xi rather than coupling every panel to a single service. [Staging](https://code.visualstudio.com/docs/sourcecontrol/staging-commits), [merges](https://code.visualstudio.com/docs/sourcecontrol/merge-conflicts), [tasks](https://code.visualstudio.com/docs/debugtest/tasks), [debugging](https://code.visualstudio.com/docs/debugtest/debugging), [multi-root](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces).

## Local references

The three supplied screenshots were downloaded with curl and visually inspected. They are source references, not proposed final Xi screenshots:

- [Explorer](../references/explorer.png): files above an Outline section; clear indentation, selection row and disclosure arrows. Retain hierarchy and contextual information; reduce permanent icon/color noise.
- [Search](../references/search.png): query and replacement fields, flags, counts, file groups, match snippets, selected match and editor context. Retain all those jobs with explicit focus and a replacement preview.
- [Git](../references/git.png): changes list, commit entry, two-sided diff, lower output area. Retain worktree/index clarity; keep network publication a separate explicit action.

The inspected `~/.config/nvim/config.toml` uses `catppuccin_latte`, mouse on, no cursorline, block cursors in all modes, no whitespace rendering, and `Space t` for themes. The autoconf defaults supply `Space f`, `/`, `d`, `b`, `o/O`, `s/S`, `k`, `r`, `a`, `e`; normal `gd/gy/gr/gi`; and personal visual/completion mappings. These are configuration observations, not proof of every loaded runtime mapping: Nix-managed plugin sources were not exhaustively inspected and the personal configuration was not executed.

Existing language entries cover Fennel, C, Cucumber, Swift, OCaml, Python, TypeScript, Mojo, JavaScript, Go, and Rust. Preserve language-specific formatters and indentation in an optional migration example. `ts_ls`, `rust_analyzer`, and `sourcekit` are Neovim configuration names, not portable executable names. Xi requires explicit server commands.

Observed planning environment: Linux aarch64, Bun 1.3.13, Neovim 0.12.4. These are observations, not release compatibility promises. Moving upstream docs can differ from installed versions. T001 records exact package versions, native artifacts, checksums and supported platforms; T003 pins an oracle binary and matching docs/options.

## Risk register and decisions still requiring evidence

| Risk | Early experiment | Failure consequence |
|---|---|---|
| Piece-tree fragmentation / GC stalls | 100k edit trace, long-line and undo retention | Revisit data layout before UI features |
| Vim regex differs from JS/ripgrep | Pattern grammar corpus, lookaround/backrefs/magic and cancellation | Implement owned dialect; no silent JS substitution |
| Terminal Unicode width differs from Vim motion units | CJK, combining, ZWJ, tab and ambiguous-width grid | Separate semantic and display units; explicit terminal policy |
| OpenTUI dirty rendering overhead | 60/120 Hz, 240x70, rapid input and resize | Optimize adapter; prove API or narrow release platform |
| Native-equivalent latency claim fails | Same machine/process-output baselines vs clean Neovim | Publish measured gap; do not weaken target silently |
| LSP stale edits corrupt text | Adversarial fake server plus dirty buffers | Versioned edit coordinator blocks apply |
| Directory/Git operation partially succeeds | Inject permissions, locks, external changes and crashes | Journal, report partial state, preserve recoverable content |
| Compatibility inventory expands materially | Pinned help audit plus generated combinations | Add tickets; release stays blocked until coverage is resolved |

All numeric budgets and architecture choices below are proposed requirements until their gates provide measured evidence. Research alone validates none of them.

Additional risks: quadratic multi-cursor mapping, partial register/history commits, mouse hit tests against stale geometry, decorative paint changing Vim state, and contribution APIs bypassed by real features. T074–T095 add explicit experiments and contracts; none permits silent cursor truncation or reduced singleton parity.
