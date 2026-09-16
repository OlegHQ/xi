# Architecture and ownership

The architecture has a deterministic editing core, asynchronous services, and a terminal presentation adapter. Performance comes from bounded work and clear ownership, not from calling every package a service. Begin with one Bun application process and a small bounded worker pool. Use subprocesses for tools that already provide efficient protocols (ripgrep, Git, LSP). Add a process or worker only where blocking/CPU isolation is measured to help.

## Package graph

```mermaid
flowchart TD
  CLI[apps/xi: composition and lifecycle] --> UI[packages/ui: OpenTUI adapter]
  CLI --> WB[packages/workbench: commands and focus]
  CLI --> SVC[packages/services: feature services]
  CLI --> OS[packages/platform: OS adapters]
  SVC --> RPC[vscode-jsonrpc + LSP 3.17 protocol adapter]
  UI --> WB
  UI --> PORTS
  UI --> LAYOUT[packages/layout: cells and viewport]
  WB --> VIM[packages/vim: own modal engine]
  WB --> DOC[packages/document: text and transactions]
  WB --> SEL[packages/selections: immutable selection sets]
  WB --> PORTS[packages/contracts: service ports]
  SVC --> PORTS
  SVC --> DOC
  OS --> PORTS
  VIM --> DOC
  VIM --> SEL
  VIM --> PORTS
  VIM --> LAYOUT
  SEL --> DOC
  SEL --> PRIM
  LAYOUT --> SEL
  LAYOUT --> DOC
  DOC --> PRIM[packages/primitives: units and immutable types]
  PORTS --> PRIM
```

Arrows mean allowed imports, not callbacks that bypass ownership. Service implementations are injected by the composition root; workbench does not import implementation modules. Split `services` into feature directories (language, syntax, search, files, git, formatting, persistence, tasks), each exporting a narrow public entrypoint. Move a feature into a separate workspace package only when it needs independent build/test ownership. Avoid dozens of empty packages.

Third-party imports have an owner-scoped allowlist enforced by the same graph check: `@opentui/core` belongs only to UI; `vscode-jsonrpc` and `vscode-languageserver-protocol` belong only to `packages/services/language/` for LSP 3.17 framing and dispatch. JSON-RPC reader/writer adapters operate over the typed platform process port; they do not spawn processes themselves, mutate documents, or enter Vim/UI packages. Any additional external package requires a named owner and use case rather than opening a general external-import exception.

| Owner | Owns | May request | Must not own |
|---|---|---|---|
| primitives | Branded positions, IDs, clocks and Result types | Nothing effectful | Generic mutable global state |
| document | Piece/rope storage, revisions, anchors, edit journal, undo tree and saved revision | Pure encoding helpers | Key interpretation, filesystem IO, renderer |
| selections | Immutable selection sets, stable IDs, canonicalization and batch mapping | Document read/change maps, primitives | Live mutable sessions, text, key grammar or UI |
| vim | Per-view editing sessions and semantic sets; modes, parser, counts, motions, ranges, registers, marks, repeat, macros | Document transactions, pure selections/layout; typed effect requests | Disk, network, OpenTUI, LSP transport |
| layout | Wrapping, folds, tab/cell mapping, visible row indexes, cursor projection and versioned hit maps | Versioned document/selection reads | Text mutation, word/range semantics or key handling |
| workbench | Session lifecycle, active buffer/view, focus, panels, command/contribution registries, edit coordination | Service ports and engine actions | Protocol parsing, writable cursor copies or text algorithms |
| UI | OpenTUI renderables, styles, event normalization, cell damage | Read models, dispatch | Mutable document copies, business actions in render callbacks |
| language | LSP transport/client lifecycle, capabilities, request versions, diagnostic/symbol caches | Edit proposals, process port | Direct buffer changes or UI nodes |
| syntax | Incremental parsing, highlight/fold ranges, query versions | Immutable snapshots/deltas | Owning editor semantics |
| search | File index, match streams, dialect/replacement plans | Process/read ports, document snapshots | Direct writes |
| files | Workspace roots, tree metadata, file-operation planning/execution | Platform filesystem and edit coordinator | Inferring filenames from display text without identity |
| git | Repository/index state, porcelain parsing, diffs, stage/commit/history | Process and filesystem ports | Shell interpolation or modifying unsaved buffer text |
| persistence | Save/recovery/session journals, serialization migrations | Document snapshots and platform writes | Independent text history that conflicts with undo |
| platform | Files, processes, watchers, clipboard, clock, terminal capabilities | OS | Product state and Vim semantics |
| apps/xi | Construct, wire, start, stop, CLI parsing | All public entrypoints | Algorithms, feature state, tests' private hooks |

Enforce this graph with import analysis in CI. No cycles, deep imports into another owner's internals, wildcard “utils” dumping ground, global event bus, or hidden service lookup. Cross-feature notifications use typed events scoped to a workspace/document and disposable subscriptions. Every long-lived owner has `dispose()` and lifecycle tests.

`contracts` holds inert command/provider schemas using primitives only; Vim imports those schemas, not the workbench registry. UI/service adapters consume public schemas and immutable read-model DTOs, never live selection owners. Inert serialized selection-history values live in primitives so document history never imports Vim or selections. Composition wires registry handlers and the UI implementation of terminal-capability ports. [Extensibility](10-extensibility.md) defines contribution registration, evolution and tests; [selections](08-selections.md) defines the shared singleton/multi-cursor path.

## Resource ownership

[Performance engineering](12-performance.md) defines execution classes, safe private reuse, all-owner CPU/memory budgets and the PF01–PF12 corpus. Immutable public contracts remain; private chunk/position/cell loops avoid per-element objects and strings. Workbench aggregates admission/pressure through typed counters; document alone owns storage/history; platform owns worker/process/IO mechanisms; services own bounded read replicas; UI retains sole ownership of OpenTUI/native terminal output. SQLite is an offline development results ledger with no runtime import.

The initial requirements determine engine design. Preserve declared Vim behavior and Xi selection semantics without copying Vim storage/paging or implementing the entire Vim application. The current code audit and corrective ownership tickets are in [performance research](13-performance-research.md); in particular, `apps/xi` must return to composition/lifecycle rather than owning edit-session algorithms.

## Positions and text

The current production representation is the chunked rope selected by [T004's measured storage decision](../decisions/T004-storage.md): surrogate-safe text leaves capped at 1,024 UTF-16 code units, with balanced nodes augmented by subtree UTF-16 length and line-break count. The piece-tree prototype had lower single-edit and 10,000-edit batch latency, but retained 100,002 nodes and about 40 MB of heap after 100,000 same-middle inserts; the rope retained 539 chunks and about 0.6 MB. Keep the public `Document` interface independent of storage and implement only the selected layout; do not maintain both implementations indefinitely. T009 owns the original production fragmentation acceptance. That newline-free storage trace does not cover public EOL/history/worker costs. T107 fixes the demonstrated per-newline metadata overhead; T108 requalifies the representation and packed indexes against full public workloads before selecting a replacement. See spec 12 for density, copying, snapshot-safe compaction and adversarial balancing requirements.

Use zero-based branded `Utf16Offset`, `Utf8ByteOffset`, `LineIndex`, `CellColumn`, `DocumentVersion`, and `RevisionId`. Internal edits use UTF-16 offsets because the owned engine and protocol client are TypeScript; this is an implementation choice, not permission to split surrogate pairs. Vim semantic character advancement must match the oracle, even where a grapheme cluster contains multiple semantic positions. Rendering clusters and terminal cells are separate. Normalized boundaries must never be obtained by naïve `offset + 1` across arbitrary text.

Document stores normalized LF text plus explicit encoding/BOM/EOL metadata. Retain per-line EOL metadata for mixed-EOL preservation or open mixed files with a clearly declared conversion action; do not silently normalize on save. Lossless support is required for accepted editable UTF-8 inputs. Invalid UTF-8 and binary inputs initially open read-only with an explanation and explicit reopen/convert command; preserving raw bytes is mandatory until conversion is accepted. NUL, CRLF, final newline, empty file, and a file containing one newline are distinct fixtures.

Edit intent distinguishes semantic literal control characters from line-ending payloads. The LF-normalized document text may contain a literal U+000D code point as content; only LF separates logical lines. The document edit API carries `textIntent: 'literal-control'` when a Vim digraph inserts CR, while Enter and untagged CR/CRLF paste retain T010 normalization. Opening accepts `fileFormat: 'unix'` (CR bytes remain content), `'dos'` (CRLF is a line ending and lone CR remains content), or `'mac'` (lone CR is a line ending). Strict `'auto'` detection returns a typed read-only ambiguity result when lone CR could mean content or a legacy line ending, preserving the original bytes. The no-options entry point retains T010's legacy mixed-ending detection for existing callers. A live NUL may be edited and serialized, while reopening a NUL-containing file remains read-only under the binary-input policy until an explicit conversion is chosen.

Coordinate conversion belongs in one tested module with cached per-line checkpoints. LSP uses the negotiated encoding; UTF-16 is the default only if negotiation selects it. Neovim oracle byte columns are decoded against that checkpoint's actual text. Terminal x coordinates use display cells, never byte or UTF-16 indexes. A tab's width depends on its starting cell; emoji width is terminal-policy dependent. Document snapshots and conversions carry a version; conversions across revisions fail or use explicit anchor transforms.

## Transactions and history

```ts
// Contract sketch; implementation must use opaque validated constructors.
type EditOrigin = 'vim' | 'lsp' | 'formatter' | 'workspace-replace' | 'directory';
interface TextEdit { readonly start: Utf16Offset; readonly end: Utf16Offset; readonly text: string }
interface EditProposal {
  readonly document: DocumentId;
  readonly expectedVersion: DocumentVersion;
  readonly edits: readonly TextEdit[];
  readonly origin: EditOrigin;
  readonly undoGroup: UndoGroupId;
}
```

An edit transaction validates version, range ordering, non-overlap, Unicode boundaries and read-only state before any mutation. Batch ranges refer to one base revision; transform/apply in a documented order. Commit produces a new revision, changed spans, transformed anchors, and one ordered change event. Services receive that committed stream. Editing the same buffer in two views has one history and separate view cursors; undo updates all views from the same revision. `DocumentVersion` increases for every committed text transition; `RevisionId` identifies a content/history node and may later be restored by undo.

Anchor affinity is explicit. At a pure insertion point, left affinity stays before inserted text and right affinity moves after it. At the start of or inside a nonempty replacement/deletion, left maps to the replacement's new start and right to its new end. At the old exclusive end, the anchor follows the text after the edit; if another adjacent edit begins there, that edit's start rule applies. The generic transaction API rejects coincident insertions and insertions directly touching a nonempty replacement; callers must compose such edits under a command-specific rule. Adjacent nonempty edits are valid. Sorted anchor endpoints are mapped in one sweep over the sorted change spans. Sparse anchor indexes must avoid scanning every unrelated mark per key; count work and retained bytes under the same resource contract.

Multi-command preparation resolves all member intents before document validation, deduplicates compatible edits and rejects conflicting replacements. A document may expose a side-effect-free candidate snapshot for a validated edit batch; it shares immutable rope structure, carries the predicted document version and publishes neither history nor events. The coordinator uses that snapshot to validate mapped selections and the complete next session state before mutation. It installs those immutable state pointers immediately before the synchronous document commit, with no await or notification between installation and commit, and restores the prior state if commit rejects. Observers of the committed change therefore see matching text and session state. Observers cannot run reentrant edits during publication. Batch-map anchors and all view selections through the same change map. Selection-only changes have a separate generation and no text revision. Exact originating/other-view undo restoration and register-vector rules are in [08-selections](08-selections.md).

The document owns the undo tree; Vim decides group boundaries and which history operation to request. Each entry retains inverse data or persistent roots, before/after selections, group origin and save identity. Avoid storing entire documents per keystroke. Save state compares revision identity/content policy rather than a Boolean toggled by arbitrary callers. Persistent undo is versioned and corruption-checked.

Vim produces a semantic command outcome: new mode/parser state, cursor intent, transaction(s), and optional effect requests. Services' edits pass through the workbench edit coordinator and document API, never through fake keystrokes. Define whether a service action becomes Vim's dot target: default no; preserve the most recent native repeat target and expose an explicit repeat-service command. Snippet insertion and insert completion need fixtures for undo breaks and ensuing dot behavior.

Cross-file edits are not globally atomic on a normal filesystem. Preflight every file/version, stage reversible data, journal operation steps, and report per-file outcomes if execution fails. Never advertise all-or-nothing persistence unless the platform actually provides it. Do not undo unrelated external changes during rollback. An operation undo checks post-operation versions/hashes before applying inverse edits; conflicts open a recovery review.

## Input, effects and rendering

Input path: terminal bytes → OpenTUI input adapter → canonical key/paste/pointer event → context dispatcher (versioned layout hit test for pointers) → Vim engine or widget controller → document/selection commit → dirty read-model update → visible cell render → terminal output. No network or disk awaits are on the ordinary keystroke path. Autopairs, indentation and completion insertion are explicit editing policies with strict-profile fixtures; they do not sit in widget callbacks.

When the pinned input API carries protocol bytes in a string (notably legacy X10 mouse bytes), diagnostics such as `rawHex` must reconstruct each 0–255 character as its original byte. UTF-8 re-encoding those carrier characters changes the wire trace and invalidates reproduction evidence. This byte-fidelity rule is separate from decoding key and paste text.

The dispatcher returns exactly one of consumed, pending, or unhandled. A keystroke cannot reach both a panel shortcut and the engine. Pending operator/register/count input belongs to Vim and survives irrelevant service updates. Changing focus uses an explicit transition policy and cancels incompatible pending input visibly. Esc handling separates terminal escape-sequence decoding, Vim mode escape, overlay dismissal, and configured mapping timeout. With pinned OpenTUI 0.5.11, the renderer's low-level parser uses a fixed 20 ms timeout that is not exposed in `CliRendererConfig` (see [T006](../decisions/T006-input.md)); this is a parser threshold, not an end-to-end latency bound. UTF-8 code points split across input chunks must remain text and must never be reinterpreted as command chords; UTF-8 completeness is separate from Escape ambiguity.

Render only visible rows plus small overscan. Cache line layout by document revision segment, width, fold generation and style generation; editing one line cannot invalidate every file or panel. Decorations (selection, diagnostics, search, syntax, semantic tokens, Git) have stable precedence and clipped ranges. Store row/span runs, not one reactive component per character. Repaint on damage and cursor changes; idle state must not drive a permanent 60 Hz loop. Prioritize input/cursor paint above worker result integration.

Background work carries `{workspaceId, documentId?, documentVersion?, requestId, generation}` and cancellation. Limit inbound queues and integrate results in time-bounded batches. Search/diagnostic UI updates may be coalesced; input, text edits and operation acknowledgements may not be dropped. Old generations must not resurrect dismissed UI or overwrite new data. A worker may keep a versioned read replica for parsing, not an independently writable document.

Selection-sensitive work additionally carries `viewId`, `selectionGeneration` and primary/member identity; layout-sensitive input carries frame/layout generation; command invocations capture registry/config generation. Required fields depend on a discriminated request kind, not a bag of optional fields callers can forget. Motion previews are immutable, versioned presentation outputs and can never become text-edit inputs. Mouse capture and terminal mode restoration are specified in [09-interaction](09-interaction.md).

Vim regex/search can be expensive. A search operation can suspend as a typed pending effect over an immutable snapshot with cancellation; Esc cancels and restores pre-search state. Resume only against the expected version or rerun deliberately. Macro and long-command execution is cooperatively sliced while preserving command ordering. “Yielding” must not expose half-applied edits.

## Processes and resilience

Use argv arrays and explicit cwd/env through process ports; Bun supports asynchronous subprocess streams. Bound stderr retention and drain both pipes to avoid deadlocks. Every process gets timeout/cancellation policy, exit reporting and shutdown escalation. Every watcher has event coalescing, overflow recovery and invalidation rules. [Bun subprocesses](https://bun.sh/docs/runtime/child-process), [workers](https://bun.sh/docs/runtime/workers).

On crash or shutdown, restore terminal state in `finally`, stop workers and process groups, flush eligible recovery journals, and dispose renderables. SIGINT is routed according to editing context (native Vim Ctrl-C is not unconditional process exit). SIGTERM requests orderly shutdown with a bounded deadline. Suspend/resume and resize produce a fresh terminal capability/layout pass without losing buffers. Test injected errors at every initialization stage.

## Architectural acceptance

G1 requires an enforced import graph; owner-level contract tests; versioned Unicode-safe transactions; deterministic fake clocks; lifecycle leak checks; and evidence that the UI uses Xi's text model. Any package that needs an exception must provide a concrete dependency/use case and revised diagram before using it. Native optimization may accelerate pure kernels after profiling, but Xi continues to own Vim semantics and no external editor engine is substituted.
