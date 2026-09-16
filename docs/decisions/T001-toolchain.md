# T001 platform and toolchain evidence

## Supported execution hosts

- OS: Linux
- Architecture observed: aarch64

## Toolchain probe

- Bun path: `/home/snowbear/.nix-profile/bin/bun`
- Bun version: `1.3.13`
- Bun binary checksum (sha256): `cd1d783bf24bec76e58e0158df11754eb21db0d3fb332df0a7d147cf95726487`
- TypeScript compiler (pinned in package.json): `7.0.2`
- TypeScript runtime probe command: `bun x tsc --version`

## Scope decisions

- The repository is a planning workspace, so `tests/` suites are intentionally absent.
- Required suite checks intentionally fail today to prevent a release pass until suites are implemented.
- The pinned runtime dependency is `@opentui/core@0.5.11`; its platform package supplies the native library. T002 verified the Linux/aarch64 artifact at `node_modules/@opentui/core-linux-arm64/libopentui.so` and exercised it through the public renderer API.
- Toolchain validation checks the platform native library and calls `resolveRenderLib().getBuildOptions()`. An `opentui` command under `node_modules/.bin` is not part of the runtime requirement.

## Follow-up validation correction (T002)

The original artifact probe searched for an OpenTUI CLI executable and could report `missing` while the required core library was installed and loadable. T002 reproduced the mismatch, replaced the CLI lookup with native-package discovery and a runtime load check, and verified both required-present and forced-missing cases. See [T002 evidence](../evidence/T002.md).
