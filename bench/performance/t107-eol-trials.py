#!/usr/bin/env python3
"""PF03 independent diagnostic processes for the DOC-EOL budget's retained_eol:max metric
(retainedBytes from TextFileDocument.lineEndingStorageMetrics()); source changes invalidate
the whole run. Mirrors ledger-trials.py's/t114-retention-trials.py's pattern.

Only retained_eol:max is measured here. DOC-EOL also declares temporary_per_newline:max
(the scalar-loop-to-measured-counter H0 allocation-discipline check); that requires real
allocation instrumentation around the line-ending construction loop, which this diagnostic
does not attempt, so it is deliberately left unimported (see docs/evidence/T106.md's pattern
of never claiming coverage a run does not have)."""
import hashlib
import json
import math
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ['bench/performance/t107-eol-metrics.ts', 'packages/document/src/text-fidelity.ts',
           'packages/document/src/line-endings.ts', 'docs/plan/performance-budgets.json',
           'docs/plan/performance-adapters.json']
VARIANTS = ['PF03-1MiB-LF-dense', 'PF03-1MiB-mixed-EOL', 'PF03-10MiB-LF-dense', 'PF03-10MiB-mixed-EOL']


def identity():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in SOURCES}


def distribution(values):
    values = sorted(values)
    return dict(p50=values[math.ceil(len(values) * .5) - 1], p95=values[math.ceil(len(values) * .95) - 1],
                p99=values[math.ceil(len(values) * .99) - 1], max=values[-1])


def main():
    if len(sys.argv) != 2:
        raise ValueError('usage: t107-eol-trials.py OUTPUT.json (30 fresh diagnostic processes)')
    source = identity()
    started = datetime.now(timezone.utc).isoformat()
    trials = []
    bun_version = None
    for index in range(30):
        if identity() != source:
            raise ValueError('source changed during collection; discard qualification')
        result = subprocess.run(['bun', 'run', 'bench/performance/t107-eol-metrics.ts'], cwd=ROOT,
                                 capture_output=True, text=True, check=True, timeout=30)
        trial = json.loads(result.stdout)
        if not trial['diagnosticOnly'] or len(trial['measurements']) != 4:
            raise ValueError('incorrect PF03 measurement classification/count')
        bun_version = trial['bun']
        by_variant = {}
        for measurement, variant in zip(trial['measurements'], VARIANTS):
            if not measurement['exactSerializedBytes']:
                raise ValueError(f'{variant}: serialization round-trip correctness failed')
            # 'x\r\ny\n' is 5 bytes with 2 breaks per unit; 'x\n' is 2 bytes with 1 break per unit.
            expected_line_breaks = round(measurement['bytes'] * (2 / 5 if measurement['pattern'] == 'alternating-crlf-lf' else 1 / 2))
            if abs(measurement['lineBreaks'] - expected_line_breaks) > 2:
                raise ValueError(f'{variant}: unexpected line-break count {measurement["lineBreaks"]}')
            by_variant[variant] = measurement
        trials.append(by_variant)
        print(f'PF03 {index + 1}/30 complete', flush=True)
    if identity() != source:
        raise ValueError('source changed during collection; discard qualification')
    summary = {
        variant: {'retained_bytes': distribution([trial[variant]['storage']['retainedBytes'] for trial in trials])}
        for variant in VARIANTS
    }
    report = dict(schema_version=1, classification='diagnostic', reference_host=False,
                  source_files=source, source_hash=hashlib.sha256(json.dumps(source, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
                  collected_at=started, completed_at=datetime.now(timezone.utc).isoformat(),
                  command=['python3', 'bench/performance/t107-eol-trials.py', sys.argv[1]],
                  environment=dict(platform=platform.platform(), bun=bun_version, machine=platform.machine()),
                  trials=trials,
                  summary=summary,
                  note='measures TextFileDocument.lineEndingStorageMetrics().retainedBytes only '
                       '(DOC-EOL budget\'s retained_eol:max); temporary_per_newline:max is not measured '
                       'by this diagnostic and remains unimported')
    path = Path(sys.argv[1])
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise ValueError('output already exists; preserve earlier observations with a new path')
    path.write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
