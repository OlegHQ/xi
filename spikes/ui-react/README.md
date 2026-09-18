# Declarative UI evaluation (T134)

An isolated, runnable React shell using Xi's real diagnostic and status controllers.
It does not replace the production editor or introduce another editable text buffer.

```sh
bun install --cwd spikes/ui-react --frozen-lockfile
bun run --cwd spikes/ui-react check
bun run --cwd spikes/ui-react test
bun run --cwd spikes/ui-react start
```

Use `j`/`k` to scroll diagnostics, `t` to switch themes, `m` to publish a controller
message, click a diagnostic to select it, and `q` to exit. Resize below 80 columns
to stack the panels beneath the editor slot. Demo diagnostics are fixture data;
this is a UI experiment, not an LSP session or an editor implementation.

`components.tsx` contains the complete 80-line presentation layer:

- `Shell` composes an editor slot and panels using Core layout through JSX.
- `Panel` and `Row` provide shared layout, colors and presentation.
- Problems and Messages subscribe independently to existing immutable read models
  through React's `useSyncExternalStore`; controllers remain state owners.
- Only the visible diagnostics become nodes. No per-character components or whole
  document subscription is involved.
- Theme propagation uses context; component unmount owns subscription disposal.

The test covers empty/populated/error/cleared states, 1,000 diagnostics with bounded
visible rows, scrolling, stale-result rejection, sibling update isolation, theme,
narrow layout and unmount. Real xterm screenshots were inspected separately.

## Production implications

This supports adopting declarative components for ordinary shell/panel composition.
It can replace repeated creation, visibility/property synchronization, theme fan-out,
layout setters and manual subscription cleanup in `packages/ui/src/terminal.ts`.
Merely wrapping all existing Renderable classes in JSX would leave most of that code.

The editor viewport, command serialization, focus policy, cursor-relative popup placement,
generation-aware pointer dispatch, keyboard navigation and drag scrollbars are not
implemented by this prototype. Preserve those contracts when migrating; this is not
feature parity with the existing Problems panel. Its click callback is deliberately
only a demonstration of handing semantic selection back to a controller.

Core's public scheduler now handles production frame requests independently of this
spike. React must use that same scheduler, with Xi's pre-paint preparation preserved.
Do not revive private loop calls or introduce a second frame timer for React.

React remains an isolated dependency here. Five fresh-process import samples had
median import times of 34.29 ms (narrow renderer), 44.02 ms (Core), and 54.26 ms
(React), with median process RSS of 64.62, 67.63 and 72.48 MB respectively. These
are noisy source-import diagnostics, not compiled startup or allocation measurements.
The broad React catalogue import needs a production startup comparison before adoption.

See [T134 evidence](../../docs/evidence/T134.md). A production migration should first
compare one actual panel and the shell through the compiled CLI, preserving the existing
viewport and input router. Full UI parity and performance qualification remain open.

## Compiled CLI integration (T135)

`bun spikes/ui-react/build-cli.ts` builds the real Core and React CLI variants under
`.artifacts/ui-proof/`. The React variant replaces the real status-message surface;
all editing still uses the production engine. An optional argument supplies a captured
older `terminal.ts` for a third scheduler comparison. Source and binary hashes are saved.

The parsed-screen PTY producer is `bench/performance/ui-proof.py`; install its pinned
requirements in an isolated Python environment. `--scenario surface` exercises the
bounded integration journey. The full workload now includes the T136 terminal-key fix and independent input producer;
results remain diagnostic rather than a release pass. See [T135 evidence](../../docs/evidence/T135.md)
and the [full replacement design](../../docs/plan/16-declarative-ui.md).


Build comparisons use production React and disable development tooling at compile time.
`xi-core` and `xi-react` are minified; `xi-react-unminified` isolates minification's effect
with the same sources and production settings. Set `XI_UI_PROOF_OUTDIR` to retain a new
build alongside previous binaries. The optional old-terminal argument adds `xi-private`.
The first usable frame includes React mounting; no cost is deferred to the first key.

The [Solid comparison](../ui-solid/README.md) builds fresh matched Core/React/Solid
candidates. Its React and Solid adapters both mount stable hidden status nodes before
the editor; status updates change visibility/text without conditionally removing roots.
See [T140](../../docs/evidence/T140.md) for the current startup comparison and limitations.
