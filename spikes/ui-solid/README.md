# Compiled Solid comparison (T140)

This replaces the real CLI status surface with Solid, using the same controller,
editor, input router, patched Core instance and scheduler as the React experiment.
It is a benchmark candidate, not a full UI migration or shipping dependency.

```sh
bun install --cwd spikes/ui-react --frozen-lockfile
bun install --cwd spikes/ui-solid --frozen-lockfile
bun run --cwd spikes/ui-solid check
bun run --cwd spikes/ui-solid test
XI_UI_PROOF_OUTDIR=.artifacts/ui-solid/comparison-build bun spikes/ui-solid/build-cli.ts
```

The builder compiles Core, React and Solid from the same application sources with
production definitions, minification and bytecode. Solid's official JSX transform
runs during the build and selects its reactive client runtime. Babel is build tooling;
the application does not install a runtime JSX loader. All Core imports resolve to
the root patched dependency. Source, installed Core JavaScript and binary hashes are retained in the build manifest.
`XI_UI_CORE_ROOT` can select a separate installed Core package root for comparisons.
`XI_UI_PROFILE_DIR` enables CPU profiling in compiled executables; those instrumented
runs must not be used as startup or input-latency evidence. See [T141](../../docs/evidence/T141.md)
for the fork initialization comparison and its remaining qualification failures.

Both framework candidates mount the same stable hidden box/text nodes before the
usable editor frame. The editor keeps its existing custom renderer. Updating status
changes visibility/text; neither candidate defers framework mounting until interaction.
Keeping the root stable matters: the initial Solid conditional-root experiment removed
imperative editor siblings when status was cleared. The compiled regression verifies
reactive updates, sibling preservation and subscription cleanup on renderer destruction.
A complete migration should give the framework sole ownership of the composition root.

Use the existing PTY producer after installing its pinned Python requirements:

```sh
.artifacts/ui-proof/venv/bin/python bench/performance/ui-proof.py .artifacts/ui-solid/startup-new \
  --binary core=.artifacts/ui-solid/comparison-build/xi-core \
  --binary react=.artifacts/ui-solid/comparison-build/xi-react \
  --binary solid=.artifacts/ui-solid/comparison-build/xi-solid \
  --scenario startup --sessions 60 --load idle
.artifacts/ui-proof/venv/bin/python bench/performance/ui-proof.py .artifacts/ui-solid/full-new \
  --binary core=.artifacts/ui-solid/comparison-build/xi-core \
  --binary react=.artifacts/ui-solid/comparison-build/xi-react \
  --binary solid=.artifacts/ui-solid/comparison-build/xi-solid --sessions 12 --load both
```

Output paths must be new. Startup checks parsed usable cells, the first correct motion,
clean exit and unchanged file bytes. The full run additionally checks paced and burst
Unicode edits, held arrows, the real error status, command-line takeover and exact saved
bytes, idle and with a real output-producing task. It retains input delivery slippage
and per-action completion distributions. These shared-host measurements do not qualify
physical latency, full service load or a fully declarative UI.

See [T140 evidence](../../docs/evidence/T140.md) for results and source-tree limitations.
