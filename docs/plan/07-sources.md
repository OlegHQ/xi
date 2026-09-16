# Sources and research record

The [interaction research report](11-interaction-research.md) adds primary-source comparisons, exact inspected Helix/VS Code/OpenTUI revisions, architectural tradeoffs and the gap audit behind specs 08–10. Those are research pins, not chosen Xi runtime dependencies; moving help still requires the matching T003 oracle pin.

Primary sources below were accessed on 2026-09-14. Unless stated otherwise, they are living documentation without a fixed publication date. They establish the cited upstream behavior or available interfaces, not Xi's implementation quality or benchmark results. T001/T003 must pin package releases, binary hashes and corresponding source/docs before relying on specific APIs or oracle semantics.

## Rendering, runtime and architecture

1. Anomaly. [OpenTUI repository](https://github.com/anomalyco/opentui) and [Core README](https://github.com/anomalyco/opentui/blob/main/packages/core/README.md). Native/TypeScript boundary, runtime compatibility and imperative core. Read via official repository and raw source.
2. Anomaly. [OpenTUI quickstart](https://opentui.com/docs/getting-started/quickstart/) and [renderables](https://opentui.com/docs/core-concepts/renderables/). Composition and custom rendering surface.
3. Anomaly. [OpenTUI testing](https://opentui.com/docs/core-concepts/testing/) and [testing source README](https://github.com/anomalyco/opentui/blob/main/packages/core/src/testing/README.md). Real available test-renderer and input facilities. Source tree inspected through GitHub API; moving main is not a version pin.
4. Anomaly. [OpenTUI keymap source](https://github.com/anomalyco/opentui/blob/main/packages/keymap/README.md). Focus/layer routing exists; evaluate reuse for workbench routing only. Its Neovim-style disambiguation addon is not a Vim editing engine.
5. Bun. [Subprocesses](https://bun.sh/docs/runtime/child-process) and [workers](https://bun.sh/docs/runtime/workers). Asynchronous process/worker facilities; verify availability on chosen Bun version.
6. Microsoft. [TypeScript strict](https://www.typescriptlang.org/tsconfig/strict.html). Strict compiler options; Bun execution does not replace typechecking.
7. Microsoft, Peng Lyu. [Text Buffer Reimplementation](https://code.visualstudio.com/blogs/2018/03/23/text-buffer-reimplementation), 2018-03-23. Piece-tree design and editor workload motivation. Historical architecture evidence, not current comparative performance data.
8. Anomaly. [OpenCode themes](https://opencode.ai/docs/themes/). Theme configuration and light/dark design reference; no exact palette copied.
9. Kovid Goyal / kitty project. [Comprehensive keyboard handling in terminals](https://sw.kovidgoyal.net/kitty/keyboard-protocol/). Enhanced keyboard protocol and terminal-key ambiguity considerations.
10. Tree-sitter project. [Using parsers](https://tree-sitter.github.io/tree-sitter/using-parsers/). Incremental syntax parsing integration reference.

## Vim semantics and oracle

11. Neovim project. [Motion](https://neovim.io/doc/user/motion/). Operators, counts, motion kinds, special range rules and motion inventory.
12. Neovim project. [Change](https://neovim.io/doc/user/change/). Editing, registers, put and repeat-related command reference.
13. Neovim project. [Visual](https://neovim.io/doc/user/visual/). Character/line/block selections and mode behavior.
14. Neovim project. [Undo](https://neovim.io/doc/user/undo/). History grouping and branching reference.
15. Neovim project. [Map](https://neovim.io/doc/user/map/). Mode mappings, recursion and disambiguation.
16. Neovim project. [Pattern](https://neovim.io/doc/user/pattern/). Vim search dialect, offsets, search history and patterns.
17. Neovim project. [Insert](https://neovim.io/doc/user/insert/). Insert/replace and control-key behavior.
18. Neovim project. [Options](https://neovim.io/doc/user/options/). Relevant option semantics; oracle must record actual values.
19. Neovim project. [API source documentation](https://raw.githubusercontent.com/neovim/neovim/master/runtime/doc/api.txt). Test-only RPC oracle interface. Embedding was considered early, then explicitly rejected by the product requirement. No runtime embedding design remains.

## Workbench capability survey

20. Microsoft. [VS Code user interface](https://code.visualstudio.com/docs/editing/getting-started/userinterface). Sidebar, groups, views, tabs and layout families.
21. Microsoft. [Basic editing](https://code.visualstudio.com/docs/editing/codebasics). Search/replace, search editor, folding, encoding, save and multi-selection families.
22. Microsoft. [Code navigation](https://code.visualstudio.com/docs/editing/editingevolved). Breadcrumbs, outline, symbols, locations, peek and navigation.
23. Microsoft. [Source control overview](https://code.visualstudio.com/docs/sourcecontrol/overview). Source control family organization.
24. Microsoft. [Staging and committing](https://code.visualstudio.com/docs/sourcecontrol/staging-commits). Stage, commit, diff and source-control workflow reference.
25. Microsoft. [Merge conflicts](https://code.visualstudio.com/docs/sourcecontrol/merge-conflicts). Conflict review and merge editor workflow reference.
26. Microsoft. [Tasks](https://code.visualstudio.com/docs/debugtest/tasks). Build/task and problem-matcher family reference.
27. Microsoft. [Debugging](https://code.visualstudio.com/docs/debugtest/debugging). Debug capability family; deferred from first Xi release.
28. Microsoft. [Terminal basics](https://code.visualstudio.com/docs/terminal/basics). Terminal workflow family; full terminal emulation is separately deferred.
29. Microsoft. [Multi-root workspaces](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces). Root-aware configuration/navigation/source-control context.
30. Microsoft. [Accessibility](https://code.visualstudio.com/docs/configure/accessibility/accessibility). Keyboard and accessibility capability reference, not certification of Xi.

## Language, files and configuration

31. Microsoft. [LSP 3.17 specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) and [specification source](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/specification.md). Negotiation, document versions and feature protocol definitions. Initial pinned protocol baseline; capability support must be tested individually.
32. Microsoft. [vscode-languageserver-node](https://github.com/microsoft/vscode-languageserver-node). Candidate maintained JSON-RPC/protocol libraries, subject to Bun compatibility experiment.
33. Helix contributors. [Configuration](https://docs.helix-editor.com/configuration.html), [remapping](https://docs.helix-editor.com/remapping.html), [languages](https://docs.helix-editor.com/languages.html). TOML structure reference; Xi defines its own schema.
34. nvim-mini contributors. [mini.files](https://github.com/nvim-mini/mini.files). Directory navigation/manipulation and Miller-column interaction inspiration.
35. Steve Arc and contributors. [oil.nvim](https://github.com/stevearc/oil.nvim). Buffer-based filesystem editing inspiration. Xi owns its directory model and operation journal.
36. Andrew Gallant and contributors. [ripgrep guide](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md). Search behavior, ignore/hidden policy and dialect considerations.
37. Git project. [git-status](https://git-scm.com/docs/git-status). Porcelain v2 and NUL-delimited filename-safe parsing.
38. Git project. [git-apply](https://git-scm.com/docs/git-apply). Checked patch application and index/worktree distinctions.

## Supplied screenshots

Downloaded with curl and visually inspected; original files preserved without alteration. Access is private to the supplied network endpoint; local copies make the plan independent of that service.

| Reference | Original supplied URL | Local file | SHA-256 |
|---|---|---|---|
| Explorer / Outline | http://oracle-vm.taild870b7.ts.net:7777/s/oIYV5FhE.png | [explorer.png](../references/explorer.png) | `22b7c31c60e29119f9df18f544798761cd729adeacfd180ed46404ee74540f04` |
| Search / replace | http://oracle-vm.taild870b7.ts.net:7777/s/JZxU5aS1.png | [search.png](../references/search.png) | `fb252c3d1f0e887f23b99f1d6f528b3542c5c36da364f92d915b910ccfec5aee` |
| Git / diff | http://oracle-vm.taild870b7.ts.net:7777/s/d6lXk8jW.png | [git.png](../references/git.png) | `5d434cf64f1b7a333fcd639286f3c7d91f77f81d764c75b6bfd1bc237b1a5459` |

## Local configuration observations

Read-only inspection of `/home/snowbear/.config/nvim`:

- `config.toml`, `languages.toml`, README and AGENTS: theme, mouse/cursor/whitespace, theme key, per-language server/formatter/indent choices and performance intent.
- `pack/plugins/start/autoconf.nvim/lua/autoconf/sys/defaults/init.lua`: default editor settings and keymaps.
- `.../defaults/base.lua`, `lsp.lua`, `plugins.lua`, `tabs.lua`: leader, completion mappings, plugin dependency names and language indentation behavior.
- `.../resolvers/editor/mini_files.lua`: configured mini.files integration surface.

These observations informed the optional personal profile. The directory was not modified; personal Lua was not executed. Plugin names in a manifest are not proof that each plugin is installed or active in a session. No exhaustive import of the separate Nix configuration was performed.

## Research limitations

No finished Xi prototype existed during planning, so all proposed latency/memory/UX targets remain unproven. Several moving upstream pages redirected; sources above use the resolved readable pages. A historical/raw Neovim UI path and some ancillary VS Code pages failed to load; they are not relied on for claims. This is a capability-family survey and an implementation design, not an exhaustive inventory of VS Code extensions or proof of complete Vim compatibility. The pinned-help inventory audit and production validation gates are required implementation work.

## Performance refinement, 2026-09-15

The current implementation audit and primary-source research are in [13-performance-research](13-performance-research.md), with pinned source/archive hashes in [performance-sources.json](performance-sources.json). Sources cover actual VS Code coalescing/index code, Vim packed blocks, JSC string representation and inclusive heap accounting, Bun profiling/workers, Tree-sitter incremental input, and SQLite allocation/index/journal behavior. The two supplied performance attachments informed questions; their runtime-specific/generalized claims are not accepted without verification. The user confirmed SQLite is a developer budgets/results ledger and engine design serves Xi's initial requirements.
