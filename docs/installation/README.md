# Installing Xi

Xi release packages are built and checked on Linux x64 and ARM64 (glibc),
macOS x64 and ARM64, and Windows x64 and ARM64. The release workflow creates
a draft GitHub release with a versioned archive for each target, `SHA256SUMS`,
and install scripts. Linux musl is not yet advertised.

Install the latest published release:

```sh
curl -fsSL https://github.com/OlegHQ/xi/releases/latest/download/install.sh | sh
```

On Windows, run in PowerShell:

```powershell
irm https://github.com/OlegHQ/xi/releases/latest/download/install.ps1 | iex
```

The installer checks the host before downloading, verifies the archive against
the release `SHA256SUMS`, extracts into a temporary directory and replaces
`~/.local/bin/xi` only after verification succeeds. It requires `curl` or
`wget`, `tar`, and `sha256sum` or `shasum`. Set `XI_INSTALL_DIR` to choose a
different user-writable destination, `XI_VERSION` to install a specific tag
(for example `v0.0.2`), or `XI_REPO` to use another GitHub repository. The
installer consumes published releases; draft releases are available only for
review in GitHub.

The Windows installer verifies the matching zip archive with `SHA256SUMS`,
checks `xi.exe --version`, installs it under `$HOME\.local\bin` and adds that
directory to the user PATH. Set `XI_INSTALL_DIR`, `XI_VERSION`, or `XI_REPO`
to override those defaults.

The release currently has **no cryptographic signature or provenance
attestation**. `SHA256SUMS` detects corrupted downloads when obtained from the
same GitHub release, but does not independently authenticate the release
publisher. Review the repository, tag and draft assets before publication;
do not present the checksums as a signing substitute.

For a manual install, download the `xi-<version>-<target>.tar.gz` Unix archive
or `xi-<version>-win32-<arch>.zip` Windows archive
and `SHA256SUMS` from the same published release, verify the archive with
`sha256sum -c SHA256SUMS`, extract it, and copy `xi` to a directory on your
`PATH`. The archive contains the executable, package manifest, dependency
notices, native asset checksums and dependency license texts.

The local packaging command is:

```sh
bun install --frozen-lockfile
bun run tools/package-audit.ts --check
bun run package:build
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
