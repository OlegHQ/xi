#!/usr/bin/env python3
"""PF10 independent diagnostic processes for the RETENTION budget; source changes
invalidate the whole run. Mirrors ledger-trials.py's pattern for PF12."""
import hashlib
import json
import math
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ['bench/performance/t114-workbench-resources.ts', 'bench/performance/runtime-accounting.ts',
           'packages/workbench/src/index.ts', 'docs/plan/performance-budgets.json',
           'docs/plan/performance-adapters.json']


def identity():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in SOURCES}


def distribution(values):
    values = sorted(values)
    return dict(p50=values[math.ceil(len(values) * .5) - 1], p95=values[math.ceil(len(values) * .95) - 1],
                p99=values[math.ceil(len(values) * .99) - 1], max=values[-1])


def main():
    if len(sys.argv) != 2:
        raise ValueError('usage: t114-retention-trials.py OUTPUT.json (30 fresh diagnostic processes)')
    source = identity()
    started = datetime.now(timezone.utc).isoformat()
    trials = []
    for index in range(30):
        if identity() != source:
            raise ValueError('source changed during collection; discard qualification')
        result = subprocess.run(['bun', 'run', 'bench/performance/t114-workbench-resources.ts'], cwd=ROOT,
                                 capture_output=True, text=True, check=True, timeout=30)
        trial = json.loads(result.stdout)
        if trial['lifecycle']['cycles'] != 1000 or not trial['diagnosticOnly']:
            raise ValueError('incorrect PF10 cycle count/classification')
        if trial['lifecycle']['leftoverLeases'] != 0 or trial['lifecycle']['leftoverBytes'] != 0:
            raise ValueError('retained-root-and-listener-counts correctness failed')
        trial['retainedGrowthBytes'] = trial['runtime']['rssAfterBytes'] - trial['runtime']['rssBeforeBytes']
        trials.append(trial)
        print(f'PF10 {index + 1}/30 complete', flush=True)
    if identity() != source:
        raise ValueError('source changed during collection; discard qualification')
    report = dict(schema_version=1, classification='diagnostic', reference_host=False,
                  source_files=source, source_hash=hashlib.sha256(json.dumps(source, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
                  collected_at=started, completed_at=datetime.now(timezone.utc).isoformat(),
                  command=['python3', 'bench/performance/t114-retention-trials.py', sys.argv[1]],
                  environment=dict(platform=platform.platform(), bun=trials[0]['host']['bun'], machine=platform.machine()),
                  trials=trials,
                  summary={'retained_growth_bytes': distribution([trial['retainedGrowthBytes'] for trial in trials])},
                  note='measures WorkbenchResourceCoordinator admit/dispose lifecycle RSS growth only; '
                       'production service wiring, native renderer/workers and external process RSS remain unmeasured')
    path = Path(sys.argv[1])
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise ValueError('output already exists; preserve earlier observations with a new path')
    path.write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
