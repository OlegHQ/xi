# Performance lint

Run `bun run check:lint`, or target one owner:

```sh
bun run tools/lint/check.ts packages/vim
bun run test:lint
```

The local Oxlint rule protects interactive code from common accidental allocations,
repeated string rebuilding, synchronous I/O, whole-text materialization, microtask-only
CPU scheduling and per-call `Intl.Segmenter` construction. It is a static guard, not
performance evidence; the numeric contract is [docs/performance.md](../../docs/performance.md).

Functions can refine their execution class with the first comment in the body:

```ts
function advanceBoundary(text: string): number {
  // @xi-perf H0 DOC-COORDINATES -- Scalar traversal used by interactive coordinate lookup.
  return text.length;
}
```

Classes are H0 scalar kernels, H1 interactive operations, B bounded background work and C
cold/control code. Existing annotation IDs are intentionally a tiny stable vocabulary:
`DOC-COORDINATES`, `ENGINE-MOVE-ALLOC`, `ENGINE-STEP`, `RENDER-120` and `SELECTION-MAP`.

Use one next-line exception only when the bound and lifetime are concrete:

```ts
// @xi-perf-allow allocation DOC-COORDINATES -- At most four immutable results escape to the caller.
results.push({ offset });
```

Native Oxlint/ESLint suppression directives are forbidden in production. The checker is
local and syntactic: aliases, helper internals, native allocations and general complexity
still require review and measurement.
