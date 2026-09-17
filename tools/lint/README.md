# Performance lint

Run `bun run check:lint` (also in `bun run check`), or target an owner:

```sh
bun run tools/lint/check.ts packages/vim
bun run test:lint
```

Oxlint 1.83.0 runs the local `xi/performance` rule. The wrapper independently parses
comments using pinned Oxc parser 0.150.0 before invoking Oxlint, preventing native
suppressions from disabling their own audit. Syntax errors and zero files fail.
The root config is explicit and nested configs are disabled. Use the wrapper for
CI; invoking Oxlint directly omits the independent suppression audit.

## Classes and coverage

The [performance contract](../../docs/plan/12-performance.md) remains authoritative.
`.oxlintrc.json` assigns conservative H1 defaults to document, selections, Vim,
layout, workbench editing/input/dispatch and UI editor/input paths. Services and
Vim pattern/search default to B. Other production code defaults to C. These are
syntax-review defaults, not a claim every operation in the package has that class.

An operation can refine the default using the **first comment inside its function
body** (also supports block-bodied arrows and methods):

```ts
function advanceBoundary(text: string): number {
  // @xi-perf H0 DOC-COORDINATES -- Scalar traversal used by interactive coordinate lookup.
  // numeric/chunk traversal
}
```

Annotations require a catalog budget ID and a concrete reason of at least 20
characters. Nested functions inherit their enclosing class unless annotated.
A helper called from another file does not automatically inherit its caller's
class in this syntactic checker: annotate shared hot helpers at their definition.
Two document rank/Unicode validation kernels seed H0 enforcement; owner remediation
tickets must extend coverage to their remaining kernels. An unannotated H0 kernel
in a C file is not automatically discovered. Class downgrades need review against
the actual callers and budget, just like changes to the config itself.

H0 coverage now also reaches the scalar kernels called from an interactive path:
`tokenBoundsAt` (`packages/vim/motions/token-scan.ts`), a bounded scalar run scan; the
grapheme-window scans in `packages/vim/motions/word.ts`; and the layout/selection/render
functions that only ever produce their own escaping read-model output per cell/endpoint
(`buildRelativeMaterializedRows`/`rebaseMaterializedRows` in `packages/layout/src/shaping.ts`,
`mapSelectionSet` in `packages/selections/src/index.ts`, `mapSortedAnchors` in
`packages/document/src/transactions.ts`, and `paintEditorFrame`/`paintPlainFrame` in
`packages/ui/editor/motion-paint.ts`) were reviewed and annotated H1, not H0: their
per-cell/per-endpoint object construction is the escaping selection-publication/visible-layout
read model the H1 class explicitly allows, not throwaway H0 scratch, and the syntax checker
cannot tell escaping output from temporary allocation. Only genuinely scalar, non-allocating
loops (no escaping object per iteration) are annotated H0.

| Code | Classes | Detected syntax |
|---|---|---|
| `allocation` | H0 | Object/array/new/regex literals, closures, spread, interpolated templates, literal string `+`, and known allocating methods inside explicit loops; collection transforms and allocations in iteration callbacks |
| `strings` | H0/H1 | Loop `+=`, `s = s + part`, inferred local string assignments, and joins of a loop-grown local array |
| `sync` | H0/H1 | Direct or member calls ending in `Sync`; H0 async functions/await |
| `materialize` | H0/H1 | Calls named `getText`, `readAll`, `getLine`, `lineText` |
| `microtask` | H0/H1/B | Direct/member `queueMicrotask` calls |

H1 immutable transaction/results and numeric counters are allowed. H0 scratch
initialization outside loops is allowed. Normal cold/control code remains idiomatic.
Numeric `toString` formatting is not treated as full-document materialization.
These rules do not enforce import ownership; the existing import graph check does.

## Import graph rules

`tools/check-import-graph.ts` also restricts external and cross-feature imports beyond
owner-to-owner dependency direction. `web-tree-sitter` is confined to
`packages/services/syntax/`, mirroring how `vscode-jsonrpc`/`vscode-languageserver-protocol`
are confined to `packages/services/language/`; importing it from another service or owner
is an undeclared-dependency failure. `apps/xi` (the composition root) may reach another
owner's package only through that owner's `packages/<owner>/src/entrypoints/` path, never
its plain `src/index.ts` or a deep file; a public-entry-point import that is not also an
entrypoints path fails with a `must import ... via a ... entrypoints/ path` message. Within
`packages/services`, one feature directory (language, syntax, search, files, git,
formatting, persistence, tasks, navigation, config) may import another only via that
feature's own `index.ts` (`../config/index.ts` is fine; `../config/somefile.ts` is a
`deep cross-feature import` failure); import the missing symbol from the feature's index
instead of reaching past it. `tests/architecture/contracts.ts` carries a positive/negative
sentinel pair for each of these three rules (`ARCH-TREE-SITTER-OWNER-01`,
`ARCH-APP-ENTRYPOINT-01`, `ARCH-SERVICES-FEATURE-01`).

## Exceptions

Use one code and budget on a **next-line** comment:

```ts
// @xi-perf-allow allocation DOC-COORDINATES -- At most four immutable boundary results escape to the caller; scratch cannot escape.
results.push({ offset });
```

Explain necessity, the bound/lifetime, and link measurement evidence where relevant.
The checker validates format, known code/budget, minimum reason length and actual
use; reviewers validate the explanation. One exception covers that code on one
source line. Put distinct operations on distinct lines. Blanket/file exceptions,
unknown codes/budgets, missing reasons and unused exceptions fail. Native
`oxlint-disable*` / `eslint-disable*` and enable directives are prohibited in
production comments, including attempts to suppress the auditor itself.

An exception does not waive a performance budget or authorize scratch escaping
into public state. Do not generate bulk exceptions for the existing code.

## Limits and migration

This is a bounded local AST/data-flow guard, not allocation or complexity proof.
It follows declarations and aliases that stay visible through the local scope and
recognizes common string-producing calls. It associates `push`/`unshift`/`splice`
with the same local array identity, including nested loops, while allowing a
single return-path join. Aliased calls, allocations hidden in helpers/native
code, dynamic method names, strings passed as untyped parameters/member fields,
general `+` type inference, whole-document `slice(0, length)` and arbitrary IO
wrappers need caller review, work counters and measurements. B rules do not prove
cancellation, work quotas or worker isolation. String accumulation can sometimes
be optimized by JavaScriptCore; its actual costs still need evidence.

The initial production audit failed on existing string rebuilding and microtask
scheduling. T109 owns Vim reads/strings, T111 UI input/layout, T112 syntax scheduling,
and T116 workbench dispatch. Retain the failing gate until findings are fixed or
individually justified. See [T119 evidence](../../docs/evidence/T119.md).

The subsequent [production remediation](../../docs/evidence/lint-remediation.md)
records the repaired gate separately from that initial failure. T120 and
[spec 14](../../docs/plan/14-remediation-handoff.md) cover inferred accumulators
and repeated joins that the current syntactic checks can miss. Owner performance
tickets remain open; clean lint does not certify copying complexity or budgets.

Upstream API references: [JS plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins)
and [inline comments](https://oxc.rs/docs/guide/usage/linter/ignore-comments).
