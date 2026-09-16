#!/usr/bin/env python3
"""Synthetic ledger performance only; contains no editor benchmark observations."""
import hashlib
import importlib.util
import json
from pathlib import Path
import resource
import sqlite3
import statistics
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('xi_perf', ROOT / 'tools/perf.py')
perf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(perf)
data, cat_hash = perf.catalog()
with tempfile.TemporaryDirectory(prefix='xi-ledger-probe-') as directory:
    root = Path(directory)
    artifact = root / 'synthetic.json'
    artifact.write_text('{"synthetic":true,"editor_measurements":false}\n')
    db = perf.connect(root / 'ledger.sqlite3')
    perf.build(db, data, cat_hash)
    observations = []
    for entry in data['budgets']:
        for bound in entry['bounds']:
            variant_id = next(item['variant_id'] for item in data['measurement_obligations']
                              if item['budget_id'] == entry['id'] and item['metric'] == bound['metric']
                              and item['statistic'] == bound['statistic'])
            observations.append(dict(budget_id=entry['id'], variant_id=variant_id, metric=bound['metric'],
                statistic=bound['statistic'], unit=bound['unit'], value=0,
                samples=entry['min_samples'], parameters={k: 1 for k in bound.get('per', {})}))
    observations = observations[:100]
    run = dict(id='synthetic-0', catalog_hash=cat_hash, source_hash='a'*64, corpus_hash='b'*64,
        environment='synthetic-ledger-load', collected_at='2026-09-15T00:00:00Z',
        command=['python3', 'bench/performance/ledger-probe.py'], classification='diagnostic',
        artifact='synthetic.json', artifact_sha256=hashlib.sha256(artifact.read_bytes()).hexdigest())
    path = root / 'bundle.json'
    bundle = dict(schema_version=1, run=run, observations=observations)
    started = time.perf_counter()
    cpu_start = time.process_time()
    def bundles():
        for index in range(1000):
            run['id'] = 'synthetic-' + str(index)
            path.write_text(json.dumps(bundle))
            yield perf.read_json(path)
    perf.import_bundles(db, bundles(), data, cat_hash, root)
    import_ms = (time.perf_counter()-started)*1000
    cpu_ms = (time.process_time()-cpu_start)*1000
    count = db.execute('SELECT COUNT(*) FROM observation').fetchone()[0]
    assert count == 100000
    times = []
    for index in range(1000):
        started = time.perf_counter_ns()
        result = db.execute('SELECT value,assessment FROM observation WHERE catalog_hash=? AND budget_id=? AND variant_id=? AND metric=? AND run_id=?',
            (cat_hash, 'DOC-OPEN', 'PF01-2k-source', 'wall', 'synthetic-'+str(index))).fetchone()
        assert result is not None
        times.append((time.perf_counter_ns()-started)/1e6)
    times.sort()
    plan = db.execute('EXPLAIN QUERY PLAN SELECT value FROM observation WHERE catalog_hash=? AND budget_id=? AND variant_id=? AND metric=?',
        (cat_hash, 'DOC-OPEN', 'PF01-2k-source', 'wall')).fetchall()
    print(json.dumps(dict(diagnostic_only=True, editor_observations=False, rows=count,
        import_trials=1, import_wall_ms=import_ms, import_cpu_ms=cpu_ms, query_samples=len(times),
        query_p50_ms=statistics.median(times), query_p95_ms=times[949], query_p99_ms=times[989], query_max_ms=max(times),
        max_rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        sqlite_version=sqlite3.sqlite_version, query_plan=plan), indent=2))
    db.close()
