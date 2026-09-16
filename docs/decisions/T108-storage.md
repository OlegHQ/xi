# T108 storage/index decision (in progress)

## Decision slice

Keep the persistent UTF-16 treap as Xi's document representation and replace
each private chunk's JavaScript newline offset array with a checked `Uint16Array`.
Chunks remain surrogate safe and are capped at 1,024 UTF-16 code units, so every
local newline offset fits the packed field. The public coordinate contract stays
UTF-16; UTF-8 and UTF-32 counts remain subtree aggregates.

This is a measured refinement of the selected representation. It does not add a
second writable text store, change snapshot/history identity, or import a native
buffer implementation. The UTF-8 piece/block candidate remains an experiment
until it has an equivalent public operation and lifetime comparison.

## Evidence

- `T108-PACKED-LF-INDEX-01` constructs 524,288 newline breaks, checks the packed
  index kind and exact 1,048,576-byte index accounting, applies a persistent edit,
  and verifies the old snapshot and treap invariants.
- `T009` document reference, batch, giant-line, snapshot and surrogate fixtures
  still pass after the index replacement.
- On the pinned diagnostic VM, the retained probe artifacts record the private rope
  open in 504.929 ms with 25,141,248 bytes RSS growth and the corresponding public
  `openTextDocument` run in 503.366 ms with 28,774,400 bytes RSS growth. These are
  single shared-host diagnostic runs; they are not release measurements.

The existing disposable buffer spike compares a coalescing piece tree and a
chunked rope over the same edit, batch, snapshot, line lookup and undo operations.
Its result is useful design data, but it is not a production adapter and does not
qualify the full T108 acceptance matrix.

## Unmet requirements

T108 remains unproven. A complete ticket result still needs repeated cold/warm
PF01–PF06 public workloads, the UTF-8 piece/block candidate comparison including
metadata and retained history, adversarial height/visit/copy/cancellation
measurements, and a qualified reference-host result. T109 owns bounded semantic
read and coordinate-cache work that must be measured against this storage choice.
