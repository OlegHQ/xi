# Production lint remediation

- Outcome: **passed for current lint, strict checks and targeted behavior**;
  performance and broad oracle recapture qualification remain **unproven**.
- Revision: worktree based on `555ed0ce3c2475a10844824468e6fddbb6e49755`;
  source identities: `.artifacts/lint-remediation/source-sha256.json`.
- Environment: Linux aarch64; Bun 1.3.13, TypeScript 7.0.2, Oxlint 1.83.0,
  Oxc parser 0.150.0, OpenTUI 0.5.11; oracle uses the repository-pinned bundle.
- Scope: follow-up to T119's historical 17 findings under T109/T111/T112/T116.
  None of these performance tickets is completed here.

## Observable result

Layout slices completed grapheme clusters once; input/dispatch hex formatting
uses packed bytes and one decode. Case transforms join once at the end; padding
counts cells before making spaces. Forward grapheme reads grow geometrically.
Quote/paragraph queries use bounded windows, retaining escape and scan-limit
semantics. Syntax uses a cancellable timer between requests and completion
waiters; disposal settles pending flushes. No lint rule, class or exception was
weakened to obtain the clean gate.

## Executed validation

| Command | Actual result | Evidence |
|---|---|---|
| `bun run check` | Passed toolchain, strict types, ownership and lint | `.artifacts/lint-remediation/xi-final-check.log` |
| `bun run test:lint` | 18 passed, 0 failed, 157 assertions including live oracle regressions | `.artifacts/lint-remediation/xi-final-lint.log` |
| `python3 -m unittest discover -s tests/performance` | 31 passed | `.artifacts/lint-remediation/xi-final-performance.log` |
| `bun test tests/syntax/t053-syntax.test.ts` | Top-level assertions passed; zero registered Bun test cases | `.artifacts/lint-remediation/xi-final-syntax.log` |
| `bun test tests/ui/t034-workbench.test.ts tests/ui/t063-surface-matrix.test.ts` | Top-level workbench/surface assertions passed, including 36 surface states | Session output |
| `python3 tests/distribution/t064-vim-pty.py` | Passed actual PTY edit/write/quit and cleanup | Session output |

The earlier focused T016/T017/T020/T021 motion/text-object, T103 transform,
T032 direct-change, T014 layout, T035 dispatch and T053 syntax assertions passed.
Final lint regressions cover escape/surrogate window edges, paragraph early exit,
atomic scan-limit failure, 8192 combining marks, input timer ordering, concurrent
flush and disposal before scheduling.

## Failures and limitations

An initial test wrapper spread a class instance and lost prototype methods;
explicit delegation repaired the harness. Branded-offset expectation typing was
corrected before the passing rerun.

`bun test --timeout 30000 tests/vim/motions/t017-oracle.test.ts tests/vim/t020/t020-oracle.test.ts tests/vim/t021/t021-oracle.test.ts tests/vim/operators/t103-oracle.test.ts`
completed with exit 1. Full-state recapture exposed host clipboard differences in
`registers['+']` and `registers['*']`. No broad goldens were re-recorded or fields
removed. Private payloads are omitted. T121 owns deterministic initialization,
complete mismatch audit and reruns; not every broad mismatch is asserted resolved.
New scoped oracle tests initialize a local provider and passed.

Diagnostic work counters recorded 768 UTF-16 units across four paragraph reads
(maximum 256) and 32,769 units across 16 long-word reads (maximum 8,195). These
are regressions, not PF02 qualification. Total allocation, CPU distributions,
native/worker memory, backward/full-line paths and reference budgets remain
unmeasured here. No visual appearance change or screenshot approval is claimed.

A timer cannot bound one synchronous parse; inferred accumulators such as
`joinLines` can escape current lint. Replica costs and executable adapter coverage
remain open. [Spec 14](../plan/14-remediation-handoff.md) and T120/T121 record the
follow-ups without treating their existence as a pass. The [T119 report](T119.md)
retains its original failing audit.
