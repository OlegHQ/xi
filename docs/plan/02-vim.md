# Owned Vim engine and parity

Xi implements its engine in strict TypeScript. Neovim may be started by tests in an isolated temporary workspace to provide expected behavior; the editor and distributed runtime must work with no Neovim binary on PATH. Importing a Vim emulator, embedding Neovim, sending keystrokes to a Neovim subprocess, or silently falling back to one does not fulfill this requirement.

## Initial requirements and engine design

Xi needs its own efficient engine for the declared initial editing requirements. Neovim supplies expected behavior for supported singleton commands; it is not a prescription for Xi's text storage, object model, UI, paging, plugins or full application. Keep the required motion/edit families below and Xi multi-selection extensions. Audit upstream indexes to find relevant omissions, and explicitly boundary unrelated commands instead of treating every help row as a new product requirement. Structural refactors follow [performance](12-performance.md) while preserving those semantics.

## Compatibility target

The release target is all built-in motions and text objects, their counts and operator/visual compositions, and editing behaviors needed to make those compositions match a pinned Neovim reference. Parity includes state transitions and boundary effects, not merely the final text. The test oracle is one exact released binary plus matching runtime docs, options, locale, filetype, Unicode width policy and key input protocol. Record hashes and version output in `tests/oracle/manifest.json` when T003 implements it. Do not depend on changing `latest` or the author's installed configuration.

The strict profile preserves native built-in mappings and relevant options. The Xi profile adds leader-based workbench commands; a personal profile opts into the existing non-native mappings. Test all three separately. “Native parity” describes strict mode; it cannot describe `gd` repurposed for LSP or `U` repurposed for redo. Mappings are a separate layer above semantic commands. Neovim's mapping rules, mode distinctions and timeouts require explicit tests. [Neovim mappings](https://neovim.io/doc/user/map/).

First-class multiple cursors use this same engine/parser with the [selection composition contract](08-selections.md). Every inventory command declares its selection/effect policy and singleton/Xi fixture families; no local editing family is dropped to fit a multi-cursor subset. Neovim is the singleton oracle; Xi vector registers and overlapping batches use explicit specification fixtures. Normal remains Vim Normal, not Helix selection-first mode. Decorative [motion trails](09-interaction.md) cannot alter cursor state, registers, Visual marks, repeat or edit ranges.

Full Neovim application/plugin/API compatibility is a different scope: Lua/Vimscript runtimes, arbitrary user functions, plugin APIs and UI embedding are not included. Built-in motions influenced by options, syntax, folds, tags or matching delimiters remain in scope. Extension-dependent operations (`g@`, expression registers, custom `operatorfunc`, `indentexpr`, `includeexpr`, expression replacement) must be inventoried with their dependency boundary: implement a documented Xi command/provider equivalent or mark unsupported. Never call that arbitrary-script parity. If the final help audit finds an in-scope motion that needs additional semantics, add a ticket; do not exclude the motion to meet a date.

## Semantic pipeline

`KeyEvent` → mapping expansion → modal grammar → command intent → motion/text-object resolution → operator-range normalization → edit transaction → register/history/mark updates → view intent. Each stage has typed outputs and independent fixtures. Operators must not each contain a copy of motion logic. The resolver returns endpoint, direction, motion kind, inclusivity, preferred column, failure reason, and contextual metadata; normalization resolves line/character/block regions in operator context.

This is a semantic pipeline, not permission to publish text before matching engine state. For multiple selections resolve/prepare against one base, validate all deltas, commit coherently, then publish. Command descriptors and parser continuation metadata exist at G1 for discovery; UI never maintains its own table of legal motion prefixes. Pointer intents enter engine selection APIs after layout hit testing. Friendly aliases cannot override native Ex names/abbreviations; see [command discovery](09-interaction.md).

The parser tracks register prefix, operator count, motion count, force kind, command prefix and literal argument. Treat incomplete input as a valid state. Recognize count-leading zero separately from the `0` motion. Use bounded integer handling; very large counts cannot block input indefinitely or overflow silently. Invalid and failed commands follow oracle behavior for cursor, pending state, registers and last-repeat state.

Counts can multiply across an operator and motion; characterwise exclusive motions have context-sensitive end-at-column-zero rules. Those rules belong in a central range normalizer, along with the `cw` special case and forced motion kinds. Derive fixture expectations from the pinned oracle rather than “intuitive Vim.” [Neovim motions and operators](https://neovim.io/doc/user/motion/).

## Required inventory

T003 creates a machine-readable inventory from the pinned help, then T061 audits those normal/visual/operator/insert indexes for coverage of Xi’s declared behavior and explicitly classifies unrelated application/scripting commands. The following is a seed checklist; it is not an exhaustive substitute for that audit. Each expanded row must name keys, modes, option matrix, dependency, fixture IDs, implementing ticket and status (`unimplemented`, `partial`, `verified`, `excluded-with-boundary`). All in-scope rows must be verified at release.

| Family | Seed commands | Required adversarial dimensions |
|---|---|---|
| Horizontal/line | `h l 0 ^ $ g_ \| + - _ Enter Backspace Space` | Empty lines, count zero, EOL, startofline, whichwrap, tabs |
| Vertical/file | `j k gg G H M L` | Sticky desired cell column, short lines, scrolloff, count, window height |
| Screen-relative | `gj gk g0 g^ g$ gm gM`, scrolling `z` and Ctrl keys | Wrapping, horizontal scroll, wide cells, folds, viewport-only movement |
| Word/WORD | `w W b B e E ge gE` | Keyword option, punctuation, Unicode, blank paragraphs, EOF |
| Find/till | `f F t T ; ,` | Missing/repeated target, count, reverse repeat, composed literal argument |
| Structural | `% ( ) { } [[ ]] [] ][`, bracket families | Nesting, comments/strings, paragraphs/sections options, matchpairs, percentage |
| Search | `/ ? n N * # g* g#` | Empty pattern, wrap/no-wrap, offsets, zero-width, smartcase/ignorecase, cancel |
| Marks/history | `m`, backtick, quote, Ctrl-O/I, `g; g,`, special marks | Local/global marks, deleted ranges, file switching, jump deduplication |
| Text objects | `iw aw iW aW is as ip ap`, quote/bracket/tag objects | Inside whitespace, nesting, escaping, malformed pairs, counts, selections |
| Operators | `d c y > < = gq gw gu gU g~ g? ! zf` | Every compatible motion/object; forward/reverse; line/char/block coercion |
| Direct changes | `x X s S D C r R gR J gJ ~`, numeric Ctrl-A/X variants | Last char/line, tab replace, joined spaces, nrformats, sequential visual numbers |
| Visual/select | `v V Ctrl-V`, `o O gv`, count reselect, Select mode | Exclusive/inclusive, reversed anchor, ragged rows, partial tabs and wide glyphs |
| Insert | `i I a A o O gi gI`, counts, Ctrl-O, Ctrl-R, Ctrl-W/U/T/D, digraphs/literal | Indentation, backspace options, replace stack, newline, Escape/Ctrl-C differences |
| Registers/put | unnamed, named/append, numbered, small-delete, black-hole, clipboard, `p P gp gP` | Type/width metadata, append, delete rotation, visual put source preservation |
| Undo/repeat | `u U Ctrl-R .`, undo branches, earlier/later | Insert breaks, change+insert grouping, repeat count replacement, service edits |
| Macros | `q{reg} ... q @{reg} @@`, nested and counted execution | Recording versus expanded input, recursion, errors, cancellation and stable ordering |
| Ex editing | Ranges/marks/search addresses, `:s`, `:&`, `:~`, `:g`, `:v`, `:normal`, moves/copies/deletes | Escaped delimiters, flags, confirm, range offsets, empty matches, nested commands |
| Host navigation | `gf gF`, tags, include searches, folds, `Ctrl-W` families | Providers unavailable, multiple buffers, file line numbers, split geometry |
| Error and option behavior | Relevant `cpoptions`, `selection`, `virtualedit`, `iskeyword`, `backspace`, `tabstop`, `shiftwidth`, `joinspaces` | Option changes mid-sequence and persistence across buffers/views |

Visual selections are not simply half-open offsets: preserve selection kind, anchor, cursor, virtual cells and block width before deriving edit ranges. Undo grouping and replace-mode backspace must be tested independently of normal insertion. [Visual mode](https://neovim.io/doc/user/visual/), [undo](https://neovim.io/doc/user/undo/), [insert mode](https://neovim.io/doc/user/insert/), [change commands](https://neovim.io/doc/user/change/).

Insert digraphs follow observed live-buffer behavior, not only the static table query: on pinned Neovim 0.12.4, `i<C-K>NU<Esc>` and `i<C-K>LF<Esc>` each produce an in-line NUL through `nvim_buf_get_lines()`, while `CR` produces literal U+000D content. Preserve the digraph sequence through input planning so `NU` and `LF` are not guessed from their shared table value. Ordinary Enter and generic paste payloads retain CR/CRLF line-ending normalization at the document boundary. Saving literal CR content and reopening ambiguous raw CR bytes must follow the explicit document fileformat policy above; reopening NUL-containing files follows the documented binary read-only path.

## Vim pattern engine

Do not translate Vim patterns with a few string replacements into JS RegExp. Own a parser and explicit intermediate representation with source spans and Vim magic switches. Cover word boundaries, groups, alternation, quantifiers, `\zs`/`\ze`, newline classes, captures/backreferences, lookaround, case switches, positional atoms and substitution replacement rules. Use a bounded NFA where possible; isolate backtracking features behind a step budget with a cancellable execution path. A timeout is an explicit error preserving the pre-command state, not a successful no-match.

Buffer `/` and `:s` use the Vim dialect. Workspace search uses a labeled ripgrep dialect; default literal mode avoids accidental regex surprises. Keep repeat-search state separate from workspace query state. Search has preview state and committed state; cancellation restores the original cursor/scroll state and must not alter dot repeat. [Neovim patterns](https://neovim.io/doc/user/pattern/).

T005's [pattern requirement inventory](../../spikes/vim-pattern/requirements.md) records the full syntax, option, coordinate, replacement and search surface against pinned Neovim help. Its parser/evaluator is feasibility evidence only. T026 must close or explicitly boundary every parser/evaluator requirement with source-aware failures and oracle fixtures; T027 owns command-level search/substitution state and replacement integration. Unsupported syntax cannot be treated as successful no-match or silently accepted as another regex dialect.

## Repeat, macro and undo contracts

A dot target is a semantic replay description plus required inserted text and relevant command metadata. It is not the last screen key and not just a stored diff at old offsets. Store enough to rerun at a new location with count rules and current document context. Whether registers are read at replay time is case-specific and oracle-tested. Visual repeat includes prior selection shape. Completion/snippet edits during insert are classified explicitly.

Macro recording must specify raw user tokens versus mapping expansion semantics, register writes, nested macro calls and errors. Execution shares the parser/engine path, is cooperatively scheduled, has recursion/work budgets, and can be interrupted. Deterministic budgets are configurable; exceeding them must report interruption rather than silently pretending parity. History branches remain accessible after undo then edit; repeated insert sessions must not merge accidentally.

## Differential harness

Use two harness levels. A headless state oracle drives literal input with a documented draining/barrier mechanism and snapshots after each complete command (and selected incomplete states). A separate Neovim UI/PTY harness supplies matching geometry for screen motions, wrap, folds and scroll. API `normal!` alone is insufficient for mapping/insert/timeout/terminal parity; direct state setup is permitted only for arranging identical fixtures.

Snapshots compare text including EOL metadata, semantic cursor and desired column, mode/submode, pending input, selection/block dimensions, relevant register contents/types, marks, jump/change lists, last find/search state, undo/redo outcomes and errors. Compare stable observable behavior, not private memory layout or arbitrary internal undo IDs. A mapping fixture checks output and timing using controlled clocks where possible and bounded real-time integration where necessary.

Generate grammar-aware traces: valid command prefixes, operator-motion products, counts, options and randomized adversarial documents. Shrink a mismatch by reducing keys, text and options while preserving failure. Commit the minimized fixture and source help tag. The harness must detect deliberately injected bugs (inclusive endpoint off by one, UTF-8 column treated as UTF-16, incorrect register rotation, lost sticky column). A fuzzer that passes because it skips difficult commands is a failing harness.

CI smoke: all deterministic fixtures and at least 10,000 seeded generated traces across engine families. Nightly: at least 100,000 longer traces plus targeted Unicode/option matrices and crash/cancellation cases; tune wall-time distribution without removing families. Counts are minimum workload proposals, not proof of completeness. G6 requires zero unexplained mismatches, all inventory rows resolved, and no stale expected-failure entry for in-scope behavior.

Packaging tests remove Neovim from PATH and run editor workflows. Oracle fixtures can be generated with test-only Neovim RPC, but production code must not import that harness or depend on oracle-generated runtime execution.
