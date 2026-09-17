#!/usr/bin/env python3
"""Import the real 30-trial PF10 workbench-resource retention diagnostic
(bench/performance/t114-retention-trials.py) as an honest 'diagnostic' observation for
the RETENTION budget.

Covers exactly what was measured: retained_growth:max under PF10-1000-cycles (the plain
1,000 admit/dispose lifecycle, correctness-checked for zero leftover leases/bytes).
PF10-pressure-eviction (a different variant with different correctness requirements —
recovery-checksum, not measured here) is deliberately NOT touched.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('xi_perf', ROOT / 'tools/perf.py')
perf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(perf)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_bundle(report: dict, cat_hash: str, corpus_hash: str, trials_path: Path, root: Path = ROOT) -> dict:
    """Pure construction of the RETENTION observation bundle; no filesystem/DB access."""
    if report.get('classification') != 'diagnostic' or report.get('reference_host') is not False:
        raise ValueError('this importer only accepts honest diagnostic (non-reference-host) trial reports')
    if len(report['trials']) < 30:
        raise ValueError('expected the full 30-trial PF10 collection')
    for trial in report['trials']:
        if trial['lifecycle']['leftoverLeases'] != 0 or trial['lifecycle']['leftoverBytes'] != 0:
            raise ValueError('a trial failed its retained-root-and-listener-counts correctness check')
    summary = report['summary']
    run = {
        'id': f"t114-retention-pf10-{report['collected_at']}",
        'catalog_hash': cat_hash,
        'source_hash': report['source_hash'],
        'corpus_hash': corpus_hash,
        'environment': f"diagnostic:{report['environment']['platform']}",
        'collected_at': report['collected_at'],
        'command': report['command'],
        'classification': 'diagnostic',
        'artifact': str(trials_path.relative_to(root)),
        'artifact_sha256': sha256_file(trials_path),
    }
    observations = [
        {'budget_id': 'RETENTION', 'variant_id': 'PF10-1000-cycles', 'metric': 'retained_growth', 'statistic': 'max',
         'unit': 'bytes', 'value': summary['retained_growth_bytes']['max'], 'samples': len(report['trials']), 'parameters': {}},
    ]
    return {'schema_version': 1, 'run': run, 'observations': observations}


def main() -> int:
    if len(sys.argv) != 2:
        raise ValueError('usage: import-t114-retention.py TRIALS.json')
    trials_path = Path(sys.argv[1]).resolve()
    report = json.loads(trials_path.read_text())
    data, cat_hash = perf.catalog()
    corpus_path = ROOT / '.artifacts/performance/T114/corpus/PF10-1000-cycles.bin'
    if not corpus_path.is_file():
        raise ValueError('materialize PF10-1000-cycles via bench/performance/workloads.py first')
    corpus_hash = sha256_file(corpus_path)

    bundle = build_bundle(report, cat_hash, corpus_hash, trials_path)
    bundle_path = trials_path.with_name(trials_path.stem + '-bundle.json')
    bundle_path.write_text(json.dumps(bundle, indent=2) + '\n')

    with perf.connect() as db:
        perf.build(db, data, cat_hash)
        count = perf.import_bundle(db, bundle, data, cat_hash)
    print(f'Imported {count} real diagnostic observations for RETENTION (bundle: {bundle_path.relative_to(ROOT)}).')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
