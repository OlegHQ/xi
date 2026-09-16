#!/usr/bin/env python3
"""PF12 independent diagnostic processes; source changes invalidate the whole run."""
import hashlib
import json
import math
from pathlib import Path
import platform
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ['tools/perf.py', 'bench/performance/ledger-probe.py',
           'bench/performance/ledger-trials.py', 'bench/performance/workloads.py',
           'docs/plan/performance-budgets.json', 'docs/plan/performance-adapters.json']


def identity():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in SOURCES}


def distribution(values):
    values = sorted(values)
    return dict(p50=values[math.ceil(len(values)*.5)-1], p95=values[math.ceil(len(values)*.95)-1],
                p99=values[math.ceil(len(values)*.99)-1], max=values[-1])


def main():
    if len(sys.argv) != 2:
        raise ValueError('usage: ledger-trials.py OUTPUT.json (30 fresh diagnostic processes)')
    if sys.platform != 'linux':
        raise ValueError('PF12 ru_maxrss KiB adapter is pinned to Linux')
    source = identity()
    started = datetime.now(timezone.utc).isoformat()
    trials = []
    for index in range(30):
        if identity() != source:
            raise ValueError('source changed during collection; discard qualification')
        result = subprocess.run([sys.executable, 'bench/performance/ledger-probe.py'], cwd=ROOT,
                                capture_output=True, text=True, check=True, timeout=30)
        trial = json.loads(result.stdout)
        if trial['rows'] != 100_000 or trial['query_samples'] != 1000 or not trial['diagnostic_only']:
            raise ValueError('incorrect PF12 corpus/sample count/classification')
        trials.append(trial)
        print(f'PF12 {index+1}/30 complete', flush=True)
    if identity() != source:
        raise ValueError('source changed during collection; discard qualification')
    report = dict(schema_version=1, classification='diagnostic', reference_host=False,
                  source_files=source, source_hash=hashlib.sha256(json.dumps(source, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
                  collected_at=started, completed_at=datetime.now(timezone.utc).isoformat(),
                  command=['python3', 'bench/performance/ledger-trials.py', sys.argv[1]],
                  environment=dict(platform=platform.platform(), python=platform.python_version(), machine=platform.machine()),
                  trials=trials,
                  summary={key: distribution([trial[key] for trial in trials]) for key in
                           ['import_wall_ms', 'import_cpu_ms', 'query_p95_ms', 'max_rss_kib']})
    path = Path(sys.argv[1])
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise ValueError('output already exists; preserve earlier observations with a new path')
    path.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report['summary'], indent=2))


if __name__ == '__main__':
    main()
