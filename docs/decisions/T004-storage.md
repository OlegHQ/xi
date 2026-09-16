# T004: Document storage layout

## Decision

Select a chunked rope for Xi's document storage. Use surrogate-safe leaves bounded to 1,024 UTF-16 code units and balanced nodes augmented with subtree UTF-16 length and LF count. Keep the public `Document` contract independent of leaf representation and implement only this selected layout in T009. This supersedes the architecture's provisional piece-tree preference; the measured reason is the piece tree's severe retained-node and heap growth under repeated middle insertion.

Both candidates in this spike use the same persistent implicit treap and aggregate logic. The comparison changes the leaf representation: piece descriptors point into immutable source buffers, while rope leaves own bounded text chunks and coalesce adjacent chunks up to the limit. The result therefore compares these storage strategies within one deterministic scaffold; it does not certify a production tree implementation.

## Evidence

The final run is retained at `.artifacts/buffer/T004-results.json`; fixture definitions and hashes are in [T004-traces.json](../../bench/fixtures/T004-traces.json). It ran on Linux ARM64, kernel `6.8.0-139-generic`, Bun `1.3.13`, Node compatibility runtime `v24.3.0`, four logical CPUs, 7.7 GiB reported memory and `en_US.UTF-8`. The virtual host does not expose a CPU model. The terminal is not involved in this in-process data-structure benchmark. Timings are microseconds and use nearest-rank percentiles; there is no shared-runner release-performance claim.

| Workload | Augmented piece tree | Chunked rope |
|---|---:|---:|
| Open 1 MiB long line, 30 opens, p95 / p99 | 1,063.668 / 1,096.876 | 1,652.835 / 2,364.794 |
| Unicode 2,000-line lookup, 10,000 samples, p95 / p99 | 0.375 / 0.417 | 0.250 / 0.292 |
| Snapshot capture, 10,000 samples, p95 / p99 | 0.084 / 0.417 | 0.083 / 0.084 |
| Materialize 1 MiB snapshot, 30 samples, p95 / p99 | 5.084 / 12.459 | 105.583 / 1,096.001 |
| Insert-delete pair on 1 MiB line, 10,000 samples, p95 / p99 | 1.833 / 2.834 | 2.959 / 4.084 |
| 10,000 sorted batch edits, 30 trials, p95 / p99 | 30,829.113 / 31,869.365 | 46,260.628 / 46,526.837 |
| 10,000 reversed batch edits, 30 trials, p95 / p99 | 29,381.612 / 29,597.112 | 46,771.629 / 47,598.088 |
| 100,000 same-middle inserts, p95 / p99 per edit | 5.042 / 8.625 | 4.959 / 6.917 |
| 100,000 inserts: final content chunks/nodes | 100,002 | 539 |
| 100,000 inserts: retained JS heap / process RSS delta after GC in fresh Bun child | 40,212,685 / 95,412,224 bytes | 616,212 / 66,752,512 bytes |
| 1,000 retained undo roots: unique nodes / retained UTF-16 payload units | 8,830 / 1,049,576 | 13,021 / 1,549,076 |
| 1,000 retained undo roots: JS heap / RSS delta after GC in fresh Bun child | 0 / 655,360 bytes | 0 / 2,490,368 bytes |

The rope's retained middle-insert heap was about 65 times lower, with about 186 times fewer live content nodes, while both candidates produced the same 108,192-unit final text and SHA-256. This is the decisive result: at this edit count the piece tree's per-insert descriptor nodes dwarf the actual 108,192 UTF-16 units of content. The selected rope pays for the bounded representation elsewhere: the 10,000-edit batch was slower, snapshot materialization was slower, and the measured undo roots retain 499,500 additional UTF-16 payload units. T009 must preserve the rope's bounded chunks while measuring and reducing undo-related copying.

The shared anchor mapper was checked against the expected mapping at every anchor for 1, 10, 100, 1,000 and 10,000 edits/anchors in sorted and reversed order. At 10,000, it advanced through 10,000 anchors and 9,999 edits; already sorted inputs needed no sort and reversed inputs needed one anchor sort and one edit sort. The latest reproducibility run measured 0.997/1.465 ms p95/p99 sorted and 1.109/2.204 ms reversed over 50 trials. It emitted one document version for successful batches. Cancellation at 5,000 of 10,000 prepared edits left text and version unchanged.

The reference checks covered 250 seeded edits per candidate against a simple string model, LF lookup, immutable snapshots, undo, sorted/reversed batches, Unicode boundaries and cancellation. Failure fixtures are `FC-T004-SURROGATE-01`, `FC-T004-CANCEL-01` and `FC-T004-FRAGMENT-01`. The fragmentation fixture asserts exact final text, UTF-16 length and SHA-256.

## Complexity and rejection reasons

Both prototypes use persistent treaps. With `n` piece descriptors or rope chunks, lookup/split/merge and single edits are expected `O(log n)` time with `O(log n)` copied tree nodes; the randomized treap has an `O(n)` worst case. A batch of `m` base-version edits costs `O(m log m + m log n)` when sorting is needed, plus leaf work, and publishes one root. Rope leaf split/coalescing copies at most 1,024 UTF-16 code units per touched leaf. Line lookup is `O(log n + log b)`, where `b` is the number of LF offsets in the selected leaf/source index. Anchor mapping is `O(a + m)` for sorted anchors and edits, or `O(a log a + m log m)` when either input needs sorting. Snapshot capture is `O(1)` by root identity; materialization is `O(L)` for `L` UTF-16 code units.

The piece tree is rejected as the selected layout because the measured 100,000-insert trace retained 100,002 descriptors and 40,212,685 heap bytes for 108,192 UTF-16 units. The rope is slower for 10,000-edit batches and materialization, and it retains more chunk payload across undo roots. Those are explicit costs to monitor in T009; they do not outweigh the measured fragmentation bound for the chosen editor workload.

## T009 implementation budget

Use the same T004 corpus and isolated-after-GC measurement boundary for the 100,000 middle-insert acceptance trace. Keep at most 2,048 live content chunks, retained JS heap growth at or below 4 MiB, and process RSS growth at or below 80 MiB. The latest reproduced rope baseline was 539 chunks, 616,212 heap bytes and 66,752,512 RSS bytes. These are document-spike limits for the pinned Linux ARM64 environment, not a revision of Xi's release-wide memory or latency goals. Record actual p95/p99 and all outliers; do not use these limits to claim end-to-end performance.

## Limitations

These are TypeScript prototypes on a virtualized ARM64 host with no model string exposed. The heap/RSS deltas are one isolated sample per candidate and allocator/runtime dependent; the node and logical UTF-16 payload counts are deterministic structural measures. The 1 MiB payload figure is twice UTF-16 code-unit count for comparison, not a claim about Bun's internal string encoding. Rendering, terminal output, service load, startup, larger files, real undo branching and the full G0/G6 performance gates remain unmeasured.
