# Installing Xi

Xi is currently distributed as a self-contained Bun executable for **Linux
ARM64**. The target is the glibc build on the reference host; the musl asset is
recorded separately and is not advertised as a supported runtime until it has
been exercised on a musl host. macOS and Windows packages are not advertised
yet because their OpenTUI native assets have not been exercised in this
repository.

The reproducible local packaging command is:

```sh
bun install --frozen-lockfile
bun build --compile apps/xi/src/main.ts --outfile dist/xi
bun run tools/package-audit.ts --check
```

The resulting `dist/xi` contains the OpenTUI native asset selected by Bun for
the build target. Run it from a directory without the source checkout to check
that it does not depend on the workspace:

```sh
env -i HOME="$(mktemp -d)" TERM=xterm-256color PATH=/usr/bin:/bin ./dist/xi --health
./dist/xi --help
./dist/xi --version
./dist/xi path/to/file:12
```

`--health` checks the local OpenTUI runtime and reports optional tools when the
full workbench wires them. Core startup does not require Git, ripgrep, an LSP
server or Neovim. Neovim is a development oracle only and is not part of the
package.

The current CLI is a launchable workbench shell with Vim Insert (`i`, `a`, `o`),
normal motions, common operators (`dw`, `dd`, `yy`), register put (`p`), direct
deletion/toggle and character replacement commands, Escape, Ctrl-S atomic save,
native Ex write/quit and `q`/Ctrl-C shutdown. Its release label must remain an editor preview until the
G6 report proves the complete editing and packaging workflow. Terminal cleanup
is exercised through the real PTY tests in `tests/distribution/`.

Dependency notices are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), and
the native library checksums are in [native-assets.sha256](native-assets.sha256).
