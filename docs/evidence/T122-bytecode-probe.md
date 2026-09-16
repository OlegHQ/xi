# T122 follow-up: bytecode startup probe

- Outcome: promising diagnostic experiment; no build-script change or release qualification.
- Environment and source: same Linux arm64/Bun 1.3.13 installation as [T122](T122.md). All source/dependency hashes in `corrected-final/comparison.json` were checked against the current tree before measurement.
- Scope: STARTUP-WARM/STARTUP-COLD, startup class C; no budget changes.

## Executed commands and outcomes

`bun build --compile --bytecode apps/xi/src/main.ts --outfile .artifacts/startup-profile-2026-09-16/xi-bytecode-probe` failed at the entrypoint's top-level `await` with the default output format.

`bun build --compile --bytecode --format=esm apps/xi/src/main.ts --outfile .artifacts/startup-profile-2026-09-16/xi-bytecode-esm-probe` succeeded, bundling 198 modules.

The existing `bench/performance/startup-diagnostic.py` `trial()` adapter then compared this executable with the preserved patched executable `xi-patched`: five randomized pairs (seed 122), plus one excluded warmup per executable. Same named fixture, isolated HOME/XDG, 120×40 responsive PTY and corrected visible-content boundary as T122. Every trial accepted immediate `iZ`, saved the exact expected bytes, and exited successfully.

| Executable | p50 | p95 / p99 / max | Samples |
|---|---:|---:|---:|
| Compiled, no bytecode | 120.46 ms | 122.59 ms | 5 |
| Compiled, ESM bytecode | 78.55 ms | 79.67 ms | 5 |

Raw commands, arrivals and samples: `.artifacts/startup-profile-2026-09-16/bytecode-probe/results.json`. This small probe suggests a useful next optimization, not a qualified 35% performance claim. Full distribution/interaction tests, 30-session comparisons, first-input tails, memory and cross-platform validation remain required before changing the shipping build. It does not accelerate the direct source-launch command automatically.

The [Bun executable documentation](https://bun.sh/docs/bundler/executables#bytecode-compilation) describes bytecode as moving JavaScript parsing work into the build. The local pinned-runtime build and PTY experiment above verify applicability here.
