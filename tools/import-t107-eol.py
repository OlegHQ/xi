#!/usr/bin/env python3
"""Import the real 30-trial PF03 EOL-storage diagnostic (bench/performance/t107-eol-trials.py)
as an honest 'diagnostic' observation for the DOC-EOL budget's retained_eol:max metric, across
all four declared PF03-*-LF-dense/mixed-EOL variants.

temporary_per_newline:max (the H0 allocation-discipline half of DOC-EOL) is NOT covered by
this diagnostic -- it needs real allocation instrumentation around the line-ending
construction loop, not attempted here, and is deliberately left unimported.
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

VARIANTS = ['PF03-1MiB-LF-dense', 'PF03-1MiB-mixed-EOL', 'PF03-10MiB-LF-dense', 'PF03-10MiB-mixed-EOL']


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_bundle(report: dict, cat_hash: str, corpus_hashes: dict[str, str], trials_path: Path, root: Path = ROOT) -> dict:
    """Pure construction of the DOC-EOL observation bundle; no filesystem/DB access."""
    if report.get('classification') != 'diagnostic' or report.get('reference_host') is not False:
        raise ValueError('this importer only accepts honest diagnostic (non-reference-host) trial reports')
    if len(report['trials']) < 30:
        raise ValueError('expected the full 30-trial PF03 collection')
    for trial in report['trials']:
        for variant in VARIANTS:
            if not trial[variant]['exactSerializedBytes']:
                raise ValueError(f'{variant}: a trial failed its serialization round-trip correctness check')
    summary = report['summary']
    run = {
        'id': f"t107-eol-pf03-{report['collected_at']}",
        'catalog_hash': cat_hash,
        'source_hash': report['source_hash'],
        'corpus_hash': corpus_hashes[VARIANTS[0]],
        'environment': f"diagnostic:{report['environment']['platform']}",
        'collected_at': report['collected_at'],
        'command': report['command'],
        'classification': 'diagnostic',
        'artifact': str(trials_path.relative_to(root)),
        'artifact_sha256': sha256_file(trials_path),
    }
    observations = [
        {
            'budget_id': 'DOC-EOL', 'variant_id': variant, 'metric': 'retained_eol', 'statistic': 'max',
            'unit': 'bytes', 'value': summary[variant]['retained_bytes']['max'], 'samples': len(report['trials']),
            'parameters': {'newlines': report['trials'][0][variant]['lineBreaks']},
        }
        for variant in VARIANTS
    ]
    return {'schema_version': 1, 'run': run, 'observations': observations}


def main() -> int:
    if len(sys.argv) != 2:
        raise ValueError('usage: import-t107-eol.py TRIALS.json')
    trials_path = Path(sys.argv[1]).resolve()
    report = json.loads(trials_path.read_text())
    data, cat_hash = perf.catalog()
    corpus_hashes = {}
    for variant in VARIANTS:
        corpus_path = ROOT / f'.artifacts/performance/T107/corpus/{variant}.bin'
        if not corpus_path.is_file():
            raise ValueError(f'materialize {variant} via bench/performance/workloads.py first')
        corpus_hashes[variant] = sha256_file(corpus_path)

    bundle = build_bundle(report, cat_hash, corpus_hashes, trials_path)
    bundle_path = trials_path.with_name(trials_path.stem + '-bundle.json')
    bundle_path.write_text(json.dumps(bundle, indent=2) + '\n')

    with perf.connect() as db:
        perf.build(db, data, cat_hash)
        count = perf.import_bundle(db, bundle, data, cat_hash)
    print(f'Imported {count} real diagnostic observations for DOC-EOL (bundle: {bundle_path.relative_to(ROOT)}).')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
