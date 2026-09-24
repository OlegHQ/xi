# OpenTUI startup fork

Xi pins [OlegHQ/opentui](https://github.com/OlegHQ/opentui/tree/xi-lazy-ffi) in
`vendor/opentui`, based on upstream `v0.5.11`
(`6b9863ea7c5fae22bfebb23c242ddcc4c2b0aa0e`). The submodule commit is the source
pin; the branch is a convenient place to review changes.

For a fresh checkout:

```sh
git submodule update --init --recursive
bun install --frozen-lockfile
bun run apps/xi/src/main.ts
```

`package.json` installs the fork from committed tarballs in
`vendor/opentui/xi-packages/`: `@opentui/core` and `@opentui/solid` built from the
submodule source, and all eight `@opentui/core-<platform>` native packages through
`overrides`. A plain `bun install` therefore gets the fork everywhere (local
checkouts and every release runner) with no Zig toolchain, patching or native
overlay step. Bun installs every overridden native package, but compiled builds
fold `process.platform`/`process.arch`, so an executable embeds only its target's
library.

The fork's Solid package defers Babel until an actual TSX transform is needed and
supports Xi's disposable `.cache/solid` transform cache. Source changes and
compiler/runtime changes invalidate that cache. A fresh cache still pays
compilation cost; it is not an instant cold-source launch. `@opentui/core/renderer`
is the fork's re-export-only `renderer-entry.ts`: it exposes renderer primitives
from the same shared chunks as the full package without loading the all-widgets
entrypoint.

The native libraries are built and stripped by the manual `OpenTUI native
libraries` workflow (`.github/workflows/opentui-native.yml`) with Zig 0.16.0,
which also checks for the fork's underline exports. The published OpenTUI 0.5.11
binaries lack those exports and cannot replace them. `native-assets.sha256` lists
the committed libraries; `bun run package:audit`, which every release build runs,
rejects any other installed library.

After changing fork source or native code, commit it in the submodule, run the
native workflow on a branch that pins that commit, then repack and verify:

```sh
gh run download <run id> -n opentui-native -D /tmp/opentui-native
cd vendor/opentui
bun scripts/xi-packages.ts /tmp/opentui-native
bun scripts/xi-packages.ts /tmp/opentui-native --check
cd ../..
cp /tmp/opentui-native/native-assets.sha256 docs/installation/native-assets.sha256
bun install
bun run check
bun run test:ui
bun run test:e2e -- --suite interaction
bun run package:smoke
bun run test:startup
```

`bun run package:build` and `bun run package:release` compile an ESM executable.
Explicit ESM is required because Xi and its dependencies use top-level await.
ESM bytecode is enabled: it skips bundle parsing and roughly halves time to first
frame. An earlier picker-latency regression attributed to bytecode did not reproduce
with a non-full disk; `bun run perf-gates` guards it. Run `./dist/xi [file]`
after a build; `bun run apps/xi/src/main.ts [file]` remains the source development
command. Rebuild after source or dependency changes.

Both distribution builds and the cached development build use
`tools/solid-build-plugin.ts`: TSX is transformed at build time and the source
compiler preload is omitted from output. `bun run xi` checks and reuses its dev
bundle; it is measured separately from direct source execution. Tests install the
source plugin through Bun's `[test].preload` so TSX is transformed before test
module loading, rather than relying on sibling-import evaluation order.

The first native binding opens the library and owns callbacks. Other bindings
load on first access and become cached direct functions. Closing releases every
opened handle before the callback owner, even when one close fails. Unavailable
deferred symbols raise their backend errors when accessed.

Unix Bun executables extract the embedded native library into
`$XDG_CACHE_HOME/opentui` (default `~/.cache/opentui`), named by content hash, so
all bindings share native state; later launches reuse the file and killed
processes leave nothing behind. If the cache is unusable they fall back to a
private temporary copy removed on orderly exit. Windows embedded DLLs retain eager
binding because Windows cannot delete a loaded DLL. Installed Windows packages
still use lazy binding.

See [T122 evidence](../evidence/T122.md) for startup and first-input measurements,
upstream test limitations, and exact revision/artifact identity. Diagnostic
measurements do not certify the full performance release matrix.
