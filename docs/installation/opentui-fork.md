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

`package.json` applies the fork's `patches/opentui-core-0.5.11.patch` through
Bun's `patchedDependencies`. Both published Bun and Node chunks consume the
same source change. Helix underline colour adds native OpenTUI symbols, so a
source-only Bun patch cannot use the official 0.5.11 platform binaries. The
fork release must publish matching owned platform packages before a fresh
registry install can use underline colours. This checkout is exercised with a
rebuilt Linux/arm64 library; other platforms still need release qualification.

The Linux/arm64 glibc asset in `native-assets.sha256` is built from submodule
`ac9a6156d17680c4b6f8b7ddd45a1a96424c3be7` with Zig 0.16.0:

```sh
cd vendor/opentui/packages/native
bun run prepare:zig
zig build -Doptimize=ReleaseFast
cp lib/aarch64-linux/libopentui.so /tmp/xi-libopentui.so
strip --strip-all /tmp/xi-libopentui.so
sha256sum /tmp/xi-libopentui.so
```

The stripped result is `e1652d0ab20c2c1c23df7a50c54c9445c7496af0197f15fd3cbc7029cdac4681`.
The published 0.5.11 Linux/arm64 asset hashes to
`4cedc1bc049c2e498923f2647280c1f5c0a370feac9de87675a689f6dfa57c23`;
it predates the fork's native underline symbols. `bun run package:audit` checks
that the installed asset matches the manifest.

The pinned Solid 0.5.11 package also receives
`patches/opentui-solid-0.5.11.patch`. It defers Babel until an actual TSX transform
is needed and supports Xi's disposable `.cache/solid` transform cache. Source
changes and compiler/runtime changes invalidate that cache. A fresh cache still
pays compilation cost; it is not an instant cold-source launch.

The generator transpiles the fork's `lazy-library.ts` and
`materialize-library.ts`, appends them to the published bundles, and updates
native initialization. It does not maintain a second handwritten implementation.
It also generates `@opentui/core/renderer` from the fork's re-export-only
`renderer-entry.ts`. Published export aliases are resolved to existing shared
chunks: the narrow entry and full package use identical classes, functions and
native owners. This avoids loading the large all-widgets entrypoint; dependencies
inside the renderer's shared chunks still load. The normal fork build emits the
same public entrypoint for Bun and Node.
To regenerate or verify, obtain the pristine published `@opentui/core@0.5.11`
package in a temporary directory:

```sh
bun vendor/opentui/scripts/xi-startup-patch.ts /path/to/pristine/package
bun vendor/opentui/scripts/xi-startup-patch.ts /path/to/pristine/package --check
bun install --frozen-lockfile
bun run check
bun run test:ui
bun run test:e2e -- --suite interaction
bun run package:smoke
bun run test:startup
```

`bun run package:build` and `bun run package:release` compile ESM bytecode with
`--compile --bytecode --format=esm`. Explicit ESM is required on Bun 1.3.13 because
Xi and its dependencies use top-level await. Run `./dist/xi [file]` after a build;
`bun run apps/xi/src/main.ts [file]` remains the source development command.
Bytecode reduces runtime parsing at the cost of a larger executable. Rebuild
after source or dependency changes.

Both distribution builds and the cached development build use
`tools/solid-build-plugin.ts`: TSX is transformed at build time and the source
compiler preload is omitted from output. `bun run xi` checks and reuses its dev
bundle; it is measured separately from direct source execution. Tests install the
source plugin through Bun's `[test].preload` so TSX is transformed before test
module loading, rather than relying on sibling-import evaluation order.

To regenerate the Solid patch, run
`bun vendor/opentui/scripts/xi-solid-patch.ts /path/to/pristine/solid` (or append
`--check`). Use a fresh Bun installation cache after changing patches, as described
in `vendor/opentui/XI-STARTUP.md`, and verify installed file hashes before timing.

The first native binding opens the library and owns callbacks. Other bindings
load on first access and become cached direct functions. Closing releases every
opened handle before the callback owner, even when one close fails. Unavailable
deferred symbols raise their backend errors when accessed.

Unix Bun executables extract the embedded native library once into a private
temporary directory so all bindings share native state. Orderly exit removes
the directory; SIGKILL cannot run cleanup. Windows embedded DLLs retain eager
binding because Windows cannot delete a loaded DLL. Installed Windows packages
still use lazy binding. Only Linux arm64 was exercised; other platform
qualification remains outstanding. Existing bundle source maps cover the
original code, not appended generated helpers.

See [T122 evidence](../evidence/T122.md) for startup and first-input measurements,
upstream test limitations, and exact revision/artifact identity. Diagnostic
measurements do not certify the full performance release matrix.
