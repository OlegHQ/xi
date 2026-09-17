#!/usr/bin/env python3
"""Import the real 30-trial PF12 ledger diagnostic (bench/performance/ledger-trials.py) as
honest 'diagnostic' observations for the LEDGER budget (T106's own dogfood metric).

Covers exactly what was measured: import:p95 and rss_peak:max under PF12-100k-import (the
100k-row import phase), lookup:p95 under PF12-1k-indexed-query (the 1,000-query phase). The
malformed/stale-evidence rejection variants are NOT touched here — they were not measured
by this trial run, and this script does not claim coverage it does not have.
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
    """Pure construction of the LEDGER observation bundle from a ledger-trials.py report.
    No filesystem/DB access; kept separate from main() so it is directly unit-testable."""
    if report.get('classification') != 'diagnostic' or report.get('reference_host') is not False:
        raise ValueError('this importer only accepts honest diagnostic (non-reference-host) trial reports')
    if len(report['trials']) < 30:
        raise ValueError('expected the full 30-trial PF12 collection')
    summary = report['summary']
    run = {
        'id': f"t106-ledger-pf12-{report['collected_at']}",
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
        {'budget_id': 'LEDGER', 'variant_id': 'PF12-100k-import', 'metric': 'import', 'statistic': 'p95',
         'unit': 'ms', 'value': summary['import_wall_ms']['p95'], 'samples': len(report['trials']), 'parameters': {}},
        {'budget_id': 'LEDGER', 'variant_id': 'PF12-100k-import', 'metric': 'rss_peak', 'statistic': 'max',
         'unit': 'bytes', 'value': summary['max_rss_kib']['max'] * 1024, 'samples': len(report['trials']), 'parameters': {}},
        {'budget_id': 'LEDGER', 'variant_id': 'PF12-1k-indexed-query', 'metric': 'lookup', 'statistic': 'p95',
         'unit': 'ms', 'value': summary['query_p95_ms']['p95'], 'samples': len(report['trials']), 'parameters': {}},
    ]
    return {'schema_version': 1, 'run': run, 'observations': observations}


def main() -> int:
    if len(sys.argv) != 2:
        raise ValueError('usage: import-t106-ledger-pf12.py TRIALS.json')
    trials_path = Path(sys.argv[1]).resolve()
    report = json.loads(trials_path.read_text())
    data, cat_hash = perf.catalog()
    corpus_path = ROOT / '.artifacts/performance/T106/corpus/PF12-100k-import.bin'
    if not corpus_path.is_file():
        raise ValueError('materialize PF12-100k-import via bench/performance/workloads.py first')
    corpus_hash = sha256_file(corpus_path)

    bundle = build_bundle(report, cat_hash, corpus_hash, trials_path)
    bundle_path = trials_path.with_name(trials_path.stem + '-bundle.json')
    bundle_path.write_text(json.dumps(bundle, indent=2) + '\n')

    with perf.connect() as db:
        perf.build(db, data, cat_hash)
        count = perf.import_bundle(db, bundle, data, cat_hash)
    print(f'Imported {count} real diagnostic observations for LEDGER (bundle: {bundle_path.relative_to(ROOT)}).')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
