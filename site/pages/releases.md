# Releases

The current site is built from the Xi **v{VERSION}** source tree when that release is published. The [latest GitHub release](https://github.com/OlegHQ/xi/releases/latest) contains checksummed archives and installation scripts for Linux, macOS, and Windows. The [full release history](https://github.com/OlegHQ/xi/releases) includes notes and prior versions.

## v{VERSION} highlights

- Hierarchical Files tree with mouse controls and inline Vim editing: deletion, registers, paste, undo, and file or folder creation.
- Review exact filesystem changes before applying them, with free-name proposals for occupied destinations, workspace trash, and **Discard all** for pending drafts.
- Visible tree cursors on startup and compact-folder navigation, Files leader help, half-page scrolling, and right-click menu hover.
- Shared Vim jump history across editor buffers, Ex path completion, and crash recovery stored in private user state.

Every tagged binary passes package checks before the draft release is prepared. Publishing a release deploys this site from the same tag. Installation and dependency notices travel with the archives.

The v{VERSION} aggregate release gate is not green: eight terminal journeys remain failing, and the existing picker latency gate still misses its limit. See the [release notes](https://github.com/OlegHQ/xi/releases/tag/v{VERSION}) for validation details.

Read the [installation guide](docs/installation/README.html), [performance contract](docs/performance.html), and [testing contract](docs/testing.html) for how a build is qualified.
