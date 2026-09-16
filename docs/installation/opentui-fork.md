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

`package.json` retains the exact `@opentui/core` 0.5.11 ABI and applies the fork's
`patches/opentui-core-0.5.11.patch` through Bun's `patchedDependencies`. Both
published Bun and Node chunks consume the same source change. Official native
binaries, optional dependencies, grammar assets and licenses are retained. No
Zig or upstream monorepo build is needed to install Xi.

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
