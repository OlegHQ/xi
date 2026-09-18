# Declarative UI replacement

Decision proposal, 2026-09-19. User requirement: a simple declarative UI with reusable
components, ultimately replacing the imperative shell and panels. T134 demonstrates
component composition; T135 adds a compiled CLI integration experiment. Adoption is
conditional on parity and measured budgets, not approved by the existence of this plan.

## Evidence and limits

The isolated React CLI replaces the real status-message surface, sharing the production
renderer, document, Vim engine, controllers and input router. The legacy status surface
is not instantiated. A PTY checks motion, Unicode insertion, status display, command-line
takeover and exact saved bytes, idle and while an actual configured task produces output.
See [T135](../evidence/T135.md) for results and retained failures. This is one migrated
surface, not a complete React editor or panel-parity claim.

T136 traced the original 50-of-80 movement failure to missing lowercase arrow-key
translation at the Vim adapter, fixed it and verified actual Core input against pinned
Neovim. The producer now injects from an independent prepared process and validates
captured PTY output afterward. See T136 for corrected compiled results, including
production/minified build cost. Full migrated-UI, service/corpus/resource and physical
qualification remain required; a one-surface experiment cannot certify the whole UI.

T140 compares compiled Solid against the optimized React and Core candidates after the
user raised startup concerns. See [T140](../evidence/T140.md): Solid has a modest measured
startup/memory advantage, but neither framework eliminates the overhead or resolves the
common first-key failure. The React-specific migration below remains a proposal; selecting
Solid would preserve the same ownership, parity and performance requirements.

## End state

One React root owns shell composition and the lifetime of UI surfaces. Components read
existing controller snapshots and call existing semantic commands. No new app-wide store,
component registry, generic widget framework or second focus system is required.

```text
WorkbenchApp
  ThemeProvider
    Shell
      Sidebar: Tabs, Explorer, Search, Git, Outline
      EditorArea: FileTabs, SplitLayout, EditorViewport per pane
      BottomPanel: Problems, TaskOutput, CallHierarchy
      StatusBar / StatusMessage / CommandLine
      OverlayLayer: Picker, Completion, Signature, Hover,
                    PrefixHelp, ContextMenu, DirectoryReview, Diff
```

`Panel`, `PanelHeader` and a bounded visible-row list are the initial reusable pieces.
Add a shared row component only where two real surfaces use the same behavior. Keep
surface-specific formatting and commands local. Use Core boxes/text/layout through JSX;
reuse existing pure formatters when their Unicode/truncation behavior is correct.

`EditorViewport` remains a custom Core renderable exposed as a JSX component. Its job
is incremental cell painting, Unicode shaping, selections, software cursor and viewport
hit testing. Do not create a React node per character, copy buffer text into React state,
or use an editable OpenTUI widget as a second document. This is a full replacement of
imperative **UI composition**, not a rewrite of the optimized rendering backend. The
React host itself ultimately draws imperatively too.

## What disappears and what remains

| Current owner/code | Replacement / retained responsibility |
| --- | --- |
| `terminal.ts` surface creation, lazy install flags, visibility setters, theme fan-out, subscription disposal lists | Conditional components, component effects and theme context; deferred modules must preserve startup and first-open bounds |
| Per-panel `*Renderable` classes with repeated paint/lifecycle plumbing | JSX panels using shared layout/rows; delete each old surface when its replacement passes |
| `WorkbenchRenderable` shell/background/tab/sidebar/status painting | Shell, FileTabs, Sidebar and StatusBar components; remove corresponding shell damage caches |
| Editor frame/damage caches, `motion-paint.ts`, layout shaping | Retain inside EditorViewport, with pane-local bounds |
| Custom private render loop / coalescing timer | Already removed in T133 candidate; Core's public requestRender and prepaint lifecycle |
| Ordered async key drain and WorkbenchInputRouter | Retain: command order and overlay focus are semantic contracts, not React reconciliation responsibilities |
| Model/view adapters and pointer generation checks | Retain required semantics; remove only redundant presentation synchronization |
| Platform setup, suspend/resume, terminal restoration | Small terminal adapter outside React, with one teardown owner |

React does **not** replace input serialization or make service work nonblocking. Each
keypress must still reach the engine in order, including across asynchronous commands.
Do not move this ordering into state effects or transition queues. React and the custom
viewport must use the same Core renderer and scheduler; no second frame timer.

## Integration rules

- Mount a single root before attaching any managed content. The temporary experiment
  mounts a stable hidden status surface before legacy attachments because container
  setup/conditional-root cleanup can clear children. T140 verifies this boundary in
  Solid too. Production must not retain mixed ownership of the root.
- Expose the viewport using the pinned React host's custom-renderable mechanism; verify
  mount/update/dispose ownership with a focused check before shell extraction. Do not
  imperatively attach children React can later remove.
- Use `useSyncExternalStore` on existing read ports. Unchanged snapshots must have stable
  identity. If a current getter allocates every read, fix caching at that owner; never
  build a duplicate mutable store to accommodate React.
- Subscribe at the smallest surface that changes. Cursor movement must not reconcile
  the whole sidebar or traverse all diagnostics/files. Lists mount only visible rows;
  offscreen results remain in their existing controllers.
- Keep the existing focus priority and semantic input router. React mouse handlers
  forward typed intents with the current generation/version; they do not implement
  Vim ranges, motion, edits or a parallel keyboard routing hierarchy.
- Preserve terminal-cell versus document-coordinate distinctions. Cursor-relative
  popups consume the last committed viewport geometry and share existing bounds logic.
  They must not read speculative React layout or accept stale pointer hit maps.
- Preserve scrolling, capture/drag cancellation, resize, narrow layouts, split panes,
  focus restoration and keyboard-only accessibility. A convenient flex layout is not
  evidence of equivalent geometry.
- Preserve prepaint anchor resolution. Rendering is a read-only projection; no commands
  or document mutation from component render or viewport painting.
- React/Core must resolve to one pinned patched Core instance, including the compiled
  executable. Check native identity, packaging, terminal shutdown and startup cost.

## Reviewable migration stages

1. **T136: establish a trustworthy adoption comparison.** Keep the terminal-key regression passing, validate the observer against known frames and exact saved-state checks,
   move input injection off the Python parser's GIL if necessary, and compare compiled
   private/Core/React paths against pinned clean Neovim. Keep all 4/8/16/25 ms limits,
   the 8 ms stall rule and startup/resource budgets. Qualify T133 before production
   adoption. Complete required service/action/size matrices; physical capture remains
   a separate calibrated gate.
2. **T137: one root and declarative shell.** Extract viewport-only drawing from
   WorkbenchRenderable; compose shell, tabs, sidebar sections and status/message in
   React. Delete the corresponding imperative paint and synchronization. Preserve
   existing panels temporarily as explicitly owned custom children, without dual paint.
   Check real resize/theme/splits/tab clicks, keyboard flow, first key and shutdown.
3. **T138: migrate sidebar and bottom panels.** Explorer, search/replace, Git, outline,
   problems, tasks/output and hierarchy move to shared bounded-row presentation. Delete
   their legacy renderables and terminal installer branches. Check selection-follow,
   pointer generations, drag/wheel, huge results, stale/error/cancel and focus restore.
4. **T139: overlays and final retirement.** Migrate command line, picker, completion,
   signature, hover, prefix help, context menu, directory review and diff. Delete old
   surface imports, installers, manual subscriptions and visibility/theme chains.
   Reuse existing semantic controllers rather than reimplementing behavior in JSX.
   Re-run full UI/PTY/visual, packaging, startup, latency and resource gates.

Every stage removes the old implementation of the migrated surface in the same change;
no permanent runtime selector or parallel UI is proposed. Split these stages further if
review size demands it, preserving dependency edges and acceptance checks.

Completion means the ordinary shell/panels are declarative, reusable composition is
visible in real production code, terminal.ts has no per-surface installation/sync chains,
and only the viewport/native adapter remains custom painting. Required parity and
performance evidence must pass; a reduction in lines alone is not acceptance.

## Production build invariant

Compile production React/reconciler branches and disable development-tool loading in
shipping binaries; minify the compiled build. Use the same settings in package builds,
release builds and compiled PTY tests. Source development commands keep development
behavior. T136 measures the minified and unminified production React candidates from
identical application sources, against an identically optimized Core candidate.
This saves code/runtime cost without delaying shell readiness or first interaction.
