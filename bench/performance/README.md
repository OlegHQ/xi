# Performance evidence tooling (T106, in progress)

`python3 tools/perf.py check/build/status/import/show` retain the version-1
observation bundle schema documented in the module. An import is a numeric
observation, not certification. Diagnostic planning bundles remain usable.

## Actual baseline resolution and comparison

```sh
python3 tools/perf.py resolve BASELINE
python3 tools/perf.py compare BASELINE CANDIDATE DOC-OPEN
# Omitting budget IDs requires every current catalog metric:
python3 tools/perf.py compare BASELINE CANDIDATE
```

References are exact immutable run IDs, unique full source-manifest SHA-256 hashes,
or unique full Git commit hashes recorded in the optional run `revision` field.
Ambiguous revisions require an exact run ID. Missing/stale runs, `HEAD`, `latest`,
and a literal `revision` placeholder do not resolve implicitly. A dirty source
manifest has its own hash independently of the base Git revision.

Comparisons rehash both artifacts on every invocation. A version-1 artifact
containing only a summary is insufficient. Each run's referenced format-2 artifact
has this shape (values below illustrate structure, not editor evidence):

```json
{
  "schema_version": 2,
  "source": {"revision": "FULL_GIT_HASH", "files": {"packages/example.ts": "SHA256"}},
  "corpus": {"fixture": "PF01-1MiB-normal", "sha256": "SHA256", "input_bytes": 1048576},
  "environment": {
    "host": "HOST_ID", "runtime": "Bun 1.3.13", "terminal": "RECORDED_TERMINAL",
    "reference_host": {
      "id": "QUALIFIED_HOST_ID", "dedicated": true,
      "qualification_method": "QUALIFICATION_PROCEDURE",
      "qualification_sha256": "SHA256"
    }
  },
  "protocol": {
    "adapter": "public-open", "version": "1", "boundary": "dispatch-to-usable-viewport",
    "workload": "PF01-1MiB-normal", "sampling": "independent-trials"
  },
  "observations": [
    {"budget_id": "DOC-OPEN", "variant_id": "PF01-1MiB-normal", "metric": "wall", "statistic": "p95", "unit": "ms", "values": [1, 2, 3]}
  ]
}
```

The run's `source_hash`, `corpus_hash`, and `environment` are SHA-256 over the
respective manifest's canonical sorted compact JSON (UTF-8, Python `ensure_ascii`
default). These hashes bind manifests to the run. Reference runs must include
matching qualified dedicated-host metadata in both the run and raw artifact
environment. The qualification digest identifies the recorded host qualification
evidence; the qualification procedure itself remains a production T106 obligation.
If the run records `revision`, the source manifest must agree.

Every raw row must match its imported workload variant, metric/statistic/unit,
parameters, sample count, and recomputed value. Each ledger row requires raw
evidence. Quantiles use
nearest rank; mean uses compensated summation. Unknown units, negative unsigned
measurements and nonfinite values fail. Signed retained deltas remain signed.
Parameter dictionaries compare by contents rather than JSON key order.

Source identities may differ; corpus, environment and full protocol must match.
Every declared workload-variant/metric/statistic cell for the selected operations
must exist in **both** runs. A budget row or representative PF family does not
cover its other declared variants.
The catalog's minimum samples apply to both. Diagnostic/noisy classifications and
missing coverage yield `unproven`, never `comparison-satisfied`.

For independent-trial p95 metrics, 2,000 deterministic bootstrap resamples (seed
41027) estimate a 95% percentile interval for relative regression. A lower endpoint
above 10% fails; an interval crossing 10% is unproven. Candidate absolute-limit
failures also fail. Zero baselines cannot establish relative regression and are
rejected. Correlated per-key samples require a session/block bootstrap adapter;
the independent-trial protocol must not be used to qualify typing sessions.
Derived `comparison` catalog metrics also need their own production adapter.

`comparison-satisfied` describes selected numeric evidence only. Every comparison
returns `release: unproven`; it does not establish randomized collection order,
production adapter coverage, allocation accuracy or host authenticity. T106 and
T115 remain incomplete until those obligations have evidence.

## Aggregate suite discovery

`bench/manifest.json` explicitly lists benchmark executables so utility modules
and argument-requiring diagnostic probes are not launched as no-argument suites.
Selectors must reference registered files. Missing paths, empty roots, invalid
manifests and missing/repeated option values fail before executing fixtures.
The unit suite also runs the standalone document check scripts under `bun run`.

`bun run bench -- --baseline BASELINE` now resolves and verifies retained baseline
evidence. It then fails explicitly because the legacy aggregate benchmarks do not
yet produce invocation-bound candidate bundles. The standalone comparator is
functional; merely finding an old candidate run cannot certify a new invocation.
T115 must connect production producers before the aggregate gate can pass.

## Reproduction

```sh
python3 -m unittest discover -s tests/performance -p 'test_*.py'
bun run check
bun run test:unit
python3 bench/performance/ledger-probe.py
```

The ledger probe imports 100,000 **synthetic** rows in a temporary database,
checks exact row count, verifies indexed query results, and reports CPU/wall/RSS.
It neither imports editor measurements nor qualifies a reference host. Raw traces
and repeated trial output belong under `.artifacts/performance/T106/`.

The production startup probe runs 30 fresh PTY processes through
`bun run apps/xi/src/main.ts`, waits for the real `XI_WORKBENCH_READY` frame
marker, records wall and child CPU time, and writes diagnostic evidence:

```sh
python3 bench/performance/t116-startup.py .artifacts/performance/T116/startup-run.json
```

The probe is bound to the current launcher source hashes and reports readiness
through the PTY boundary. It remains diagnostic on a shared host and does not
qualify the STARTUP-WARM budget or the broader production matrix.

The ordinary-key diagnostic uses the same production launcher and records the
time from each `j` write to the first subsequent PTY bytes:

```sh
python3 bench/performance/t116-key-output.py .artifacts/performance/T116/key-output-run.json
```

It is a small idle-load probe for regression diagnosis. It does not replace the
required open-loop 10,000-event, 30-session matrix or physical capture.
