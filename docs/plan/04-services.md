# Services, configuration and consistency

## Language support

Use LSP 3.17 as the initial explicitly pinned protocol contract; advertise only implemented capabilities. Evaluate the maintained `vscode-jsonrpc` and `vscode-languageserver-protocol` packages under Bun, without importing VS Code's extension host or Node-only assumptions. Pin successful versions. A minimal owned transport is acceptable only if library incompatibility is reproduced and its required protocol surface is covered. LSP defines capability negotiation and versioned document communication; implementing all UI features is Xi's responsibility. [LSP specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/), [reference TypeScript libraries](https://github.com/microsoft/vscode-languageserver-node).

Transport must handle byte-counted Content-Length, split/coalesced frames, UTF-8 multibyte bodies, malformed/oversized messages, interleaved requests/notifications, server-to-client requests, unknown methods, cancellation, error responses and EOF. Drain stderr separately. Timeouts and logging are bounded; logs redact document contents by default. Fake-server tests inject each condition. Real server tests cannot substitute for adversarial protocol tests.

Client identity is `(server config, root, environment, workspace folders)`. Discover roots via ordered markers, with explicit single-file fallback. One server can serve compatible documents; separate roots/configs must not share accidental state. Model stopped → starting → initializing → ready → stopping/failed, with progress, retry limit/backoff, restart and disabled reasons. Crash/restart replays current open documents and relevant config exactly once. No activation blocks opening or typing.

Sync uses committed document deltas and monotonically increasing LSP versions; didOpen precedes didChange and didClose invalidates pending requests. Debounce/coalesce carefully while preserving the server's expected base text; incremental changes are expressed against the correct sequential versions. Negotiate UTF-8/16/32 positions and test conversion of astral characters, combining sequences, CRLF-normalized buffers and out-of-range server positions. If a server supports only full sync, send snapshots asynchronously with a documented large-file limit.

### Capability matrix

| Feature | Client behavior | Required validation |
|---|---|---|
| Diagnostics push and pull | Per-server/source stores, severity filters, version/generation checks | Late publish, unversioned publish policy, resultId refresh, closed file |
| Completion | Trigger chars, incomplete lists, resolve, insert/replace edits, commit chars | Stale cursor/version, additional edits, empty result, item acceptance |
| Snippets | Placeholders, mirrors, final stop, nested transforms as declared | Undo, cancel, multi-line indent, completion overlap; unsupported syntax explicit |
| Signature/hover | Cancellable requests, sanitized Markdown, scrollable docs | Overlapping requests, malicious terminal escapes, offscreen anchor |
| Navigation | Definitions/declarations/type/implementation/references, Location/LocationLink | URI conversion, duplicate results, missing files, external roots, jump return |
| Symbols | Document and workspace symbols with hierarchy/lazy resolve | Rapid buffer switch, empty/stale tree, stable selection |
| Code actions | Context diagnostics, kind filter, disabled reasons, lazy resolve, commands | Text edit plus command order, unsupported command, failed execution |
| Rename | Prepare rename, validation, workspace edit preview | Dirty documents, resource operations, version mismatch, cancellation |
| Formatting | Document/range formatting and external formatter policy | Cursor anchors, undo grouping, stale output, idempotence, process failure |
| Semantic tokens | Full/delta/range, legends and token modifiers | Delta base mismatch → full refresh; old version ignored |
| Inlay hints and code lens | Off/quiet defaults, lazy resolve and explicit activation | Viewport limits, no input delay, stale anchors |
| Folding/selection range | Validated nested ranges, layout integration | Overlap, invalid nesting, partial capability, visual selection integration |
| Call/type hierarchy and links | Picker/peek/tree via capability-aware commands | Cycles, partial results, location history, explicit external link opening |
| Workspace protocol | Configuration, folders, watched files, dynamic registration, progress | Duplicate registration, unregister, refresh, cancellation and restart |
| File operations | Will/did create/rename/delete around explicit file transactions | Server edits participate in preflight; notification only after success |

This table is an implementation contract, not a claim that every language server offers every feature. Completion snippets and commands must be checked against the server's actual capabilities and Xi's tested support.

### Applying edits

All LSP edits pass through one edit coordinator. Normalize URIs, check versions, decode ranges, reject overlaps or invalid boundaries, resolve ordered create/rename/delete operations and show change annotations. Snapshot open dirty buffers, stat/hash closed files, preflight permissions and destination collisions. Apply text in a single logical group per document and journal the overall workspace operation. Versions absent from `WorkspaceEdit` do not grant permission to clobber changed text: bind the request to a snapshot and require revalidation.

If the user types during a request, keep typing and mark the response stale or recompute; do not lock the editor for network latency. Save-format obtains a snapshot, runs configured formatters, verifies revision before apply, then persists the resulting revision. Never write a formatter's stale output over newer typing. Automatic save can reschedule; explicit save reports conflict/retry clearly.

## Search and file index

Use ripgrep via argv and machine-readable JSON for workspace content search. It supports explicit ignore/hidden behavior; do not parse human-colored output. Search flags in the UI must map to tested arguments and the selected dialect. Do not assume Vim, JS and ripgrep regular expressions are interchangeable. [ripgrep guide](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md).

Index filenames lazily and incrementally with a worker-side fuzzy scorer; seed visible/nearby files first and stream results. Preserve root identity and stable paths; one file list cannot erase duplicate relative paths in different roots. Default ignores: repository ignore files honored, `.git` metadata excluded, hidden files visible as a selectable policy consistent with the personal profile. Symlink following is opt-in with cycle detection and canonical deduplication; retain display path independently.

Realtime query debounce starts at 40 ms (configurable); cancellation immediately invalidates the generation and terminates obsolete searches. Batch presentation no more often than once per frame with bounded result parsing. Default displayed match cap 10,000 with explicit truncated/continue controls; virtualization is mandatory below and above the cap. Lazy snippets avoid retaining every full file. Filename and content caches have memory budgets and eviction, not unbounded maps.

Open dirty documents replace disk results for their URI. Either exclude those files from rg and search snapshots separately, or filter their disk results before display; never show contradictory duplicates. Every result contains root/URI, source version or disk hash, match range in an explicit coordinate unit, query generation and snippet. Invalid-byte filenames use rg's encoded path representation where available; do not assume all JSON paths are plain UTF-8 strings.

Replacement is a two-phase plan. Match offsets come from the same search semantics as the preview; do not rerun a different JS regex. For regex capture replacement, retain or deterministically recompute captures using the selected engine/dialect, then verify exact matched bytes/text. Support `$1`/named captures and preserve-case only with explicit grammar and tests; no heuristic mixing with Vim `\1`. Zero-width and multiline matches require termination and non-overlap rules. Preflight all selected targets, stage backups, apply checked transactions, persist according to the selected scope, and report partial failures. Operation undo checks for subsequent edits. Saved and unsaved buffers cannot be accidentally normalized to one disk-only operation.

## Files and directory editing

Tree node identity contains root, path and stable generation; an inode alone is not portable or stable enough. Enumeration is lazy per expanded directory, with ignore and hidden policy. Watchers invalidate nodes and reconcile selection. Permission-denied nodes stay visible with a retry action. Symlink loops, broken links, long names, unreadable directories, case sensitivity and external renames have fixtures.

Directory draft lines represent stable entries with immutable IDs held in anchors/metadata. Parsing reconstructs intended names and operations against the base listing. Unknown IDs, duplicate destination paths, traversal outside the permitted operation scope and malformed escaped names block apply with exact row errors. Renames are identified by ID, not similarity matching. Copies require explicit destination interpretation and must not mutate original identity accidentally.

Plan execution resolves rename cycles through temporary names; handles case-only rename on case-insensitive filesystems; uses copy + verify + delete for cross-device moves; and records each completed step durably. Trash is default for deletes, with Xi recovery storage if system trash is unavailable and configured. Permanent delete is explicit. Metadata/symlink handling is part of the operation, not a plain text copy. External change between preview and apply triggers revalidation. File operations coordinate open buffers, LSP file-operation hooks and tree invalidation. A failure leaves an actionable journal and draft; rollback never overwrites newly created external content.

## Git

Use `git status --porcelain=v2 -z` and parse NUL-delimited records, including rename and unmerged records. Repo detection handles worktrees, submodules and nested repositories without assuming `.git` is a directory. Cache by repository generation and serialize mutating commands per repo. Status refresh is coalesced; filesystem events alone are not proof the index is current. [Git status](https://git-scm.com/docs/git-status).

Keep HEAD↔index, index↔worktree, and worktree↔unsaved-buffer diffs distinct. Binary files have metadata-only actions. Diff render models contain line mappings, hunks, context and source identities; unified and side-by-side views share one model. A Git patch is generated/validated against exact index/worktree identities; hunk staging rechecks before execution. Use `git apply --check`/appropriate cached or reverse flags under a tested contract; do not fabricate patches from styled screen lines. Partial-line staging is a later enhancement unless separately ticketed. [Git apply](https://git-scm.com/docs/git-apply).

Stage/unstage files and hunks, commit, amend with explicit indication, branch checkout/create, log/show/blame, fetch/pull/push and stash basics have command contracts. Never commit/push from an automatic save action. Commit input passes through stdin/file arguments, not shell interpolation. Preserve draft on hooks/signing/auth failures. Treat index locks and concurrent Git clients as ordinary conflicts, with refresh and retry, not deletion of another process's lock. Resolve merges with explicit base/ours/theirs/result identity, and verify Git's unmerged state before showing resolved.

## Configuration

Use `~/.config/xi/config.toml`, `languages.toml`, `themes/*.toml` and optional workspace `.xi/config.toml`/`languages.toml`. Layer defaults → user → selected profile → workspace → language-specific settings → explicit CLI overrides. Declare field-level merge behavior: tables deep-merge; scalar/ordinary arrays replace; languages/servers merge by name; explicit removal uses a documented disabled field. Do not concatenate formatter arrays implicitly. Explain each effective value's source in a config inspector.

Parse into unknown, validate with a schema, compile command references and key tries, then atomically swap the immutable config generation. Unknown fields/commands, duplicate normalized keys, conflicting exact/prefix bindings and wrong types get filename/line/column diagnostics where supported. Keep last-good config on failed reload. Hot-reload appearance and keymaps immediately; restart affected servers only when their effective configuration changed, with state replay. Do not silently swallow unsupported settings.

Workspace settings can configure executable servers/formatters/tasks. Treat executable changes in an untrusted project as an explicit trust boundary; ordinary appearance settings remain usable. Trusted user config commands are argv arrays and explicit cwd/env, never automatic shell evaluation. A shell task is a separately declared task type. This is product behavior for opening untrusted repositories, not a requirement to seek approval for routine implementation work.

The following is the **proposed Xi schema**, not a currently functioning config or a drop-in Helix file:

```toml
schema-version = 1
profile = "xi"

[editor]
theme = "xi-light"
line-number = "absolute"
scrolloff = 5
mouse = true
wrap = false

[editor.cursor-shape]
normal = "block"
insert = "block"
visual = "block"

[editor.lsp]
enable = true
inlay-hints = false

[search]
debounce-ms = 40
max-visible-results = 10000
hidden = true
follow-symlinks = false

[keys.normal.space]
f = "files.pick"
b = "buffers.pick"
"/" = "search.workspace"
o = "files.edit-directory"
O = "files.edit-buffer-directory"
t = "theme.pick"
a = "lsp.code-action"
r = "lsp.rename"

[keys.normal.space.v]
f = "panel.files.focus"
s = "panel.search.focus"
g = "panel.git.focus"
o = "panel.outline.focus"
```

```toml
# languages.toml
schema-version = 1

[language-server.typescript]
command = "typescript-language-server"
args = ["--stdio"]
root-markers = ["tsconfig.json", "package.json", ".git"]

[language-server.rust]
command = "rust-analyzer"
args = []
root-markers = ["Cargo.toml", ".git"]

[[language]]
name = "typescript"
file-types = ["ts", "tsx"]
language-servers = ["typescript"]
indent = { tab-width = 2, unit = "\t" }
formatter = { command = "biome", args = ["format", "--stdin-file-path", "{file}"] }
auto-format = true

[[language]]
name = "go"
file-types = ["go"]
language-servers = ["gopls"]
formatters = [{ command = "goimports", args = [] }, { command = "gofmt", args = [] }]

[language-server.gopls]
command = "gopls"
args = []
root-markers = ["go.work", "go.mod", ".git"]
```

Formatter chains pass stdout of one successful formatter to the next on the same snapshot; any failure aborts application. File placeholders are substituted as individual argument values and URI/path conversion is explicit. T036 supplies schema-validated defaults, a personal migration profile and complete examples for the observed languages. Configuring a server does not install it. A health command reports executable resolution, versions, root, capabilities, startup errors and suggested next action.

## Syntax, persistence and tasks

Use Tree-sitter incrementally behind the syntax owner; choose and pin grammar/runtime bindings that pass Bun/platform tests. Workers receive versioned edits and cancel obsolete parses; viewport styling need not wait for a whole-workspace parse. Grammar downloads are explicit, cached with hashes, and licensed appropriately. Very large files disable expensive features with an explanation and a command to opt in. [Tree-sitter parsers](https://tree-sitter.github.io/tree-sitter/using-parsers/).

Save uses a snapshot, external-change detection and same-directory temporary write/rename where appropriate; preserve permissions and handle symlink/hardlink semantics explicitly rather than silently replacing link identity. Implement data/parent-directory flush policy for supported platforms and distinguish committed-in-memory from persisted-on-disk state. Recovery journal records incremental committed edits on a bounded cadence; a crash can lose only the documented unsynced window. On restart, compare recovery base to disk and offer a diff if disk changed. Sessions restore roots, buffers, layout and cursors separately from recovered text.

Basic tasks are configured argv commands with explicit cwd, cancellation, bounded output, exit status and optional problem matchers feeding a separate diagnostic source. General terminal emulation, DAP and rich test explorers remain deferred per the capability matrix. A future PTY terminal must implement terminal input mode and escape routing separately; a scrollbox of ANSI text is not a terminal emulator.
