# Releases

The current site is built from the Xi **v{VERSION}** source tree when that release is published. The [latest GitHub release](https://github.com/OlegHQ/xi/releases/latest) contains checksummed archives and installation scripts for Linux, macOS, and Windows. The [full release history](https://github.com/OlegHQ/xi/releases) includes notes and prior versions.

## v{VERSION} highlights

- OCaml implementation and interface highlighting, `ocamllsp`, and `ocamlformat` defaults; Ruby highlighting, `ruby-lsp`, and RuboCop formatting defaults.
- User grammar pairs for configured languages, plus Ocean and Paper themes with license notices.
- Named writes for scratch buffers and missing paths, Normal-mode terminal paste, Space+Shift+Y clipboard copy, and Space+w wrap toggling.
- Versioned documentation published from the release tag.

Every tagged binary passes package checks before the draft release is prepared. Publishing a release deploys this site from the same tag. Installation and dependency notices travel with the archives.

Read the [installation guide](docs/installation/README.html), [performance contract](docs/performance.html), and [testing contract](docs/testing.html) for how a build is qualified.
