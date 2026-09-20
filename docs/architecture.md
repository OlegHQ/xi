# Architecture

Xi is a Bun/strict-TypeScript/OpenTUI terminal editor. The package boundaries are
product contracts, not suggestions.

| Owner | Responsibility |
| --- | --- |
| `packages/document` | The only mutable text owner: text fidelity, coordinates, transactions, snapshots and history. |
| `packages/vim` | Vim parsing and semantics. It requests document transactions; it does not own a second buffer. |
| `packages/selections` | Versioned selection values and transforms. |
| `packages/layout` | Pure projection from document/selection state to visible cells and hit targets. |
| `packages/services` | Config, files, search, Git, LSP, syntax, formatting, tasks and persistence. Services return versioned results and never mutate document text directly. |
| `packages/workbench` | Buffers, views, commands, focus, routing and coordination between owners. |
| `packages/ui` | OpenTUI rendering and terminal input adaptation. It does not implement motions, ranges or edits. |
| `packages/platform` | Typed filesystem, process, clock and terminal effects. |
| `apps/xi` | Composition root only: construct owners, wire ports, start, stop. |

Public coordinates state their unit and document version. LSP positions are UTF-16;
terminal geometry is in cells; storage representation is private. Published snapshots
must not alias mutable scratch or pooled writable views.

Interactive paths may not perform synchronous filesystem/process work, scan whole
documents, debounce input, or create a second writable text store. Background work is
bounded, cancellable and version-checked before publication. Optional services may fail
without blocking basic editing.

Configuration is owned by `packages/services/config`; startup discovery belongs to the
composition root; each consuming owner applies its typed slice. A key is not implemented
until a production consumer changes observable behavior. Parse-only fields are bugs, not
partial support.

The import graph and public-boundary checks enforce the dependency direction:

```sh
bun run check:public-boundary
bun run check:lint
```
