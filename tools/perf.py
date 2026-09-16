#!/usr/bin/env python3
"""Development-only Xi budget/results ledger; never certifies a release.

Canonical catalog: docs/plan/performance-budgets.json.
Observation bundle schema_version=1:
  run: {id, catalog_hash, source_hash, corpus_hash, environment, command,
        collected_at, classification: diagnostic|reference|noisy,
        artifact: repository-relative path, artifact_sha256}
  observations: [{budget_id, variant_id, metric, statistic, unit, value, samples,
                  parameters: {input_bytes?, newlines?, selections?, edits?}}]
Hashes are SHA-256 hex. command is a nonempty argv list; it is never executed.
Artifact bytes are verified before import. Source/corpus identities are provenance
claims to be checked against actual benchmark manifests. compare requires format-2
raw artifacts and reports independent-trial numeric comparisons only; production
coverage, correlated-session analysis and host certification remain T106/T115 work.
See bench/performance/README.md. No command in this tool certifies a release.
"""
import argparse
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path
import re
import random
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / 'docs/plan/performance-budgets.json'
ADAPTER_CATALOG = ROOT / 'docs/plan/performance-adapters.json'
DATABASE = ROOT / '.artifacts/performance/budgets.sqlite3'
MAX_BUNDLE = 64 * 1024 * 1024
HASH = re.compile(r'[0-9a-f]{64}')
SIGNED_METRICS = frozenset(('p95_regression', 'p95_overhead', 'trail_p95_overhead', 'retained_growth'))
_obligation_source = None
_obligation_cache = None


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical_hash(data):
    return digest(json.dumps(data, sort_keys=True, separators=(',', ':'), allow_nan=False).encode())


def artifact_path(run, root):
    path = (root / run['artifact']).resolve()
    if Path(run['artifact']).is_absolute() or not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError('missing/non-repository artifact')
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            hasher.update(chunk)
    if hasher.hexdigest() != run['artifact_sha256']:
        raise ValueError('artifact hash mismatch')
    return path


def read_json(path, limit=MAX_BUNDLE):
    if path.stat().st_size > limit:
        raise ValueError(f'JSON input exceeds {limit} bytes')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f'duplicate JSON key: {key}')
            result[key] = value
        return result
    return json.loads(path.read_text(), object_pairs_hook=unique,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f'nonfinite JSON: {value}')))


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def qualified_reference_host(value):
    return (isinstance(value, dict) and nonempty(value.get('id'))
            and value.get('dedicated') is True
            and nonempty(value.get('qualification_method'))
            and isinstance(value.get('qualification_sha256'), str)
            and HASH.fullmatch(value['qualification_sha256']) is not None)


def metric_key(value):
    if not isinstance(value, str) or value.count(':') != 1:
        return None
    metric, statistic_name = value.split(':')
    if not nonempty(metric) or not nonempty(statistic_name):
        return None
    return metric, statistic_name


def obligation_index(data):
    global _obligation_source, _obligation_cache
    if _obligation_source is not data:
        _obligation_source = data
        _obligation_cache = {(item['budget_id'], item['variant_id'], item['metric'], item['statistic']): item
                             for item in data['measurement_obligations']}
    return _obligation_cache


def runnable_obligations(data):
    """Return declared cells whose producer selector is wired and executable.

    A pending selector is an explicit missing producer. This count is intentionally
    separate from observations: a runnable producer that has not run is unproven.
    """
    runnable = set()
    for adapter in data['production_adapters']:
        producer = adapter['producer']
        entrypoint = ROOT / adapter['entrypoint']
        selector = producer['selector']
        if not entrypoint.is_file() or selector.startswith('pending:'):
            continue
        for variant_id in adapter['workload_variants']:
            for metric_stat in adapter['metrics']:
                metric, statistic_name = metric_key(metric_stat)
                runnable.add((adapter['budget_id'], variant_id, metric, statistic_name))
    return runnable


def catalog(path=CATALOG):
    data = read_json(path)
    if not isinstance(data, dict) or data.get('schema_version') != 1 or not isinstance(data.get('budgets'), list) or not data['budgets']:
        raise ValueError('expected schema_version 1 and nonempty budgets')
    if not (ROOT / data['specification']).is_file():
        raise ValueError('missing performance specification')
    adapter_path = ROOT / data.get('adapter_specification', 'docs/plan/performance-adapters.json')
    adapters = read_json(adapter_path)
    if not isinstance(adapters, dict) or adapters.get('schema_version') != 1 or adapters.get('specification') != data['specification']:
        raise ValueError('invalid production adapter specification')
    adapter_rows = adapters.get('adapters')
    if not isinstance(adapter_rows, list) or len(adapter_rows) != len(data['budgets']):
        raise ValueError('production adapter catalog must cover every budget exactly once')
    variant_rows = adapters.get('variant_catalog')
    if not isinstance(variant_rows, list) or not variant_rows:
        raise ValueError('production adapter catalog requires a nonempty workload variant catalog')
    variant_by_id = {}
    for variant in variant_rows:
        if not isinstance(variant, dict) or not nonempty(variant.get('id')) or not re.fullmatch(r'PF\d{2}', variant.get('family', '')):
            raise ValueError('invalid workload variant identity')
        variant_id = variant['id']
        if variant_id in variant_by_id:
            raise ValueError(f'duplicate workload variant: {variant_id}')
        generator = variant.get('generator')
        if (not isinstance(generator, dict) or not nonempty(generator.get('path'))
            or not nonempty(generator.get('selector')) or not nonempty(variant.get('description'))
            or not nonempty(variant.get('correctness'))):
            raise ValueError(f'{variant_id}: incomplete workload variant declaration')
        generator_path = ROOT / generator['path']
        if not generator_path.is_file():
            raise ValueError(f'{variant_id}: missing workload generator')
        states = variant.get('states')
        if (not isinstance(states, list) or not states or len(set(states)) != len(states)
            or any(state not in ('cold', 'warm', 'loaded') for state in states)):
            raise ValueError(f'{variant_id}: invalid cold/warm state declaration')
        if not isinstance(variant.get('parameters'), dict):
            raise ValueError(f'{variant_id}: missing workload parameters')
        variant_by_id[variant_id] = variant
    data['production_adapters'] = adapter_rows
    data['workload_variants'] = variant_rows
    tickets = {t['id'] for t in read_json(ROOT / 'docs/plan/tickets.json')['tickets']}
    seen = set()
    adapter_seen = set()
    adapter_by_id = {}
    for adapter in adapter_rows:
        if not isinstance(adapter, dict) or not nonempty(adapter.get('budget_id')):
            raise ValueError('invalid production adapter row')
        budget_id = adapter['budget_id']
        if budget_id in adapter_seen:
            raise ValueError('duplicate production adapter row')
        adapter_seen.add(budget_id)
        adapter_by_id[budget_id] = adapter
        if (not nonempty(adapter.get('id')) or not nonempty(adapter.get('owner'))
            or not nonempty(adapter.get('entrypoint')) or not nonempty(adapter.get('boundary'))
            or not nonempty(adapter.get('fixture')) or not isinstance(adapter.get('metrics'), list)
            or not adapter['metrics'] or len(set(adapter['metrics'])) != len(adapter['metrics'])
            or any(metric_key(metric) is None for metric in adapter['metrics'])):
            raise ValueError(f'{budget_id}: incomplete production adapter obligation')
        workload_variants = adapter.get('workload_variants')
        if (not isinstance(workload_variants, list) or not workload_variants
            or len(set(workload_variants)) != len(workload_variants)
            or any(not isinstance(variant_id, str) or variant_id not in variant_by_id for variant_id in workload_variants)):
            raise ValueError(f'{budget_id}: incomplete workload variant obligations')
        producer = adapter.get('producer')
        if (not isinstance(producer, dict)
            or any(not nonempty(producer.get(key)) for key in ('selector', 'start', 'end', 'metric_source', 'sample_policy'))):
            raise ValueError(f'{budget_id}: incomplete production measurement boundary')
        entrypoint = ROOT / adapter['entrypoint']
        if not entrypoint.is_file():
            raise ValueError(f'{budget_id}: missing production adapter entrypoint')
    for entry in data['budgets']:
        if not isinstance(entry, dict) or not re.fullmatch(r'[A-Z][A-Z0-9-]+', entry.get('id', '')):
            raise ValueError('invalid budget ID')
        if entry['id'] in seen:
            raise ValueError('duplicate budget ID')
        seen.add(entry['id'])
        adapter = adapter_by_id.get(entry['id'])
        if adapter is None or adapter['owner'] != entry['owner']:
            raise ValueError(f"{entry['id']}: missing/mismatched production adapter")
        if entry.get('ticket') not in tickets or any(not nonempty(entry.get(k)) for k in ('owner', 'workload', 'failure_policy')):
            raise ValueError(f"{entry['id']}: missing owner/ticket/workload/policy")
        if entry.get('execution_class') not in ('H0', 'H1', 'B', 'C') or type(entry.get('min_samples')) is not int or entry['min_samples'] < 1:
            raise ValueError('invalid execution class/sample count')
        if not isinstance(entry.get('bounds'), list) or not entry['bounds']:
            raise ValueError('missing numeric bounds')
        keys = set()
        for bound in entry['bounds']:
            if not isinstance(bound, dict) or any(not nonempty(bound.get(k)) for k in ('metric', 'unit', 'statistic')):
                raise ValueError('invalid bound identity')
            key = (bound['metric'], bound['statistic'])
            if key in keys or bound.get('operator') not in ('<', '<=') or not number(bound.get('max')) or bound['max'] < 0:
                raise ValueError('duplicate/invalid bound')
            keys.add(key)
            if not isinstance(bound.get('per', {}), dict) or any(k not in data['parameters'] or not number(v) or v < 0 for k, v in bound.get('per', {}).items()):
                raise ValueError('invalid parametric bound')
        required_metrics = {f"{bound['metric']}:{bound['statistic']}" for bound in entry['bounds']}
        if set(adapter['metrics']) != required_metrics:
            raise ValueError(f"{entry['id']}: adapter metric obligations do not match bounds")
        required_families = set(re.findall(r'PF\d{2}', entry['workload']))
        declared_families = {variant_by_id[variant_id]['family'] for variant_id in adapter['workload_variants']}
        if not required_families.issubset(declared_families):
            raise ValueError(f"{entry['id']}: workload variant obligations omit a required PF family")
    if adapter_seen != seen:
        raise ValueError('production adapter catalog has unknown budget rows')
    obligations = []
    obligation_seen = set()
    for adapter in adapter_rows:
        for variant_id in adapter['workload_variants']:
            for metric_stat in adapter['metrics']:
                metric, statistic_name = metric_key(metric_stat)
                key = (adapter['budget_id'], variant_id, metric, statistic_name)
                if key in obligation_seen:
                    raise ValueError(f'duplicate production measurement obligation: {key}')
                obligation_seen.add(key)
                bound = next(bound_row for budget_row in data['budgets'] if budget_row['id'] == adapter['budget_id']
                             for bound_row in budget_row['bounds']
                             if bound_row['metric'] == metric and bound_row['statistic'] == statistic_name)
                obligations.append({
                    'budget_id': adapter['budget_id'],
                    'variant_id': variant_id,
                    'metric': metric,
                    'statistic': statistic_name,
                    'unit': bound['unit'],
                    'adapter_id': adapter['id'],
                    'owner': adapter['owner'],
                    'producer': adapter['producer'],
                    'generator': variant_by_id[variant_id]['generator'],
                    'correctness': variant_by_id[variant_id]['correctness'],
                    'states': variant_by_id[variant_id]['states'],
                    'sample_policy': adapter['producer']['sample_policy'],
                    'status': 'declared',
                })
    data['measurement_obligations'] = obligations
    encoded = json.dumps(data, sort_keys=True, separators=(',', ':')).encode()
    return data, digest(encoded)


def connect(path=DATABASE):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=1)
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('PRAGMA cache_size=-4096')
    db.execute('PRAGMA mmap_size=0')
    db.executescript('''
      CREATE TABLE IF NOT EXISTS catalog(hash TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budget(
        catalog_hash TEXT NOT NULL REFERENCES catalog(hash), id TEXT NOT NULL,
        owner TEXT NOT NULL, ticket TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(catalog_hash,id));
      CREATE TABLE IF NOT EXISTS run(
        id TEXT PRIMARY KEY, catalog_hash TEXT NOT NULL REFERENCES catalog(hash),
        source_hash TEXT NOT NULL, corpus_hash TEXT NOT NULL, environment TEXT NOT NULL,
        body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS run_identity ON run(environment,source_hash,corpus_hash);
      CREATE TABLE IF NOT EXISTS run_revision(
        run_id TEXT PRIMARY KEY REFERENCES run(id), revision TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS revision_lookup ON run_revision(revision,run_id);
      CREATE TABLE IF NOT EXISTS observation(
        run_id TEXT NOT NULL REFERENCES run(id), catalog_hash TEXT NOT NULL,
        budget_id TEXT NOT NULL, variant_id TEXT NOT NULL, metric TEXT NOT NULL, statistic TEXT NOT NULL,
        unit TEXT NOT NULL, value REAL NOT NULL, bound REAL NOT NULL,
        samples INTEGER NOT NULL, assessment TEXT NOT NULL, parameters TEXT NOT NULL,
        PRIMARY KEY(run_id,budget_id,variant_id,metric,statistic),
        FOREIGN KEY(catalog_hash,budget_id) REFERENCES budget(catalog_hash,id));
      CREATE INDEX IF NOT EXISTS observation_lookup
        ON observation(catalog_hash,budget_id,variant_id,metric,run_id);
    ''')
    columns = {row[1] for row in db.execute('PRAGMA table_info(observation)')}
    if 'variant_id' not in columns:
        # Preserve old diagnostic rows while making them ineligible for the new
        # cross-product coverage calculation. They cannot be silently promoted.
        db.execute('DROP INDEX IF EXISTS observation_lookup')
        db.execute('ALTER TABLE observation RENAME TO observation_legacy')
        db.executescript('''
          CREATE TABLE observation(
            run_id TEXT NOT NULL REFERENCES run(id), catalog_hash TEXT NOT NULL,
            budget_id TEXT NOT NULL, variant_id TEXT NOT NULL, metric TEXT NOT NULL, statistic TEXT NOT NULL,
            unit TEXT NOT NULL, value REAL NOT NULL, bound REAL NOT NULL,
            samples INTEGER NOT NULL, assessment TEXT NOT NULL, parameters TEXT NOT NULL,
            PRIMARY KEY(run_id,budget_id,variant_id,metric,statistic),
            FOREIGN KEY(catalog_hash,budget_id) REFERENCES budget(catalog_hash,id));
          INSERT INTO observation
            (run_id,catalog_hash,budget_id,variant_id,metric,statistic,unit,value,bound,samples,assessment,parameters)
            SELECT run_id,catalog_hash,budget_id,'__legacy__',metric,statistic,unit,value,bound,samples,assessment,parameters
            FROM observation_legacy;
          DROP TABLE observation_legacy;
          CREATE INDEX observation_lookup
            ON observation(catalog_hash,budget_id,variant_id,metric,run_id);
        ''')
    return db


def build(db, data, cat_hash):
    with db:
        db.execute('INSERT OR IGNORE INTO catalog VALUES(?,?)', (cat_hash, json.dumps(data)))
        db.executemany('INSERT OR IGNORE INTO budget VALUES(?,?,?,?,?)',
                       ((cat_hash, r['id'], r['owner'], r['ticket'], json.dumps(r)) for r in data['budgets']))


def validate_bundle(bundle, data, cat_hash, root=ROOT):
    if not isinstance(bundle, dict) or bundle.get('schema_version') != 1:
        raise ValueError('observation bundle requires schema_version 1')
    run = bundle.get('run')
    if not isinstance(run, dict) or any(not nonempty(run.get(k)) for k in ('id', 'environment', 'collected_at', 'artifact')):
        raise ValueError('missing run provenance')
    stamp = datetime.fromisoformat(run['collected_at'].replace('Z', '+00:00'))
    if stamp.tzinfo is None:
        raise ValueError('collected_at requires an ISO timestamp with timezone')
    for key in ('catalog_hash', 'source_hash', 'corpus_hash', 'artifact_sha256'):
        if not isinstance(run.get(key), str) or HASH.fullmatch(run[key]) is None:
            raise ValueError(f'invalid {key}')
    if 'revision' in run and (not isinstance(run['revision'], str) or re.fullmatch(r'[0-9a-f]{40}', run['revision']) is None):
        raise ValueError('revision must be a full Git commit hash; source_hash identifies dirty content separately')
    if run['catalog_hash'] != cat_hash:
        raise ValueError('stale catalog hash')
    if run.get('classification') not in ('diagnostic', 'reference', 'noisy'):
        raise ValueError('invalid run classification')
    if run['classification'] == 'reference' and not qualified_reference_host(run.get('reference_host')):
        raise ValueError('reference run requires qualified dedicated host metadata')
    if not isinstance(run.get('command'), list) or not run['command'] or any(not nonempty(v) for v in run['command']):
        raise ValueError('missing command argv')
    artifact_path(run, root)
    observations = bundle.get('observations')
    if not isinstance(observations, list) or not observations or len(observations) > 100_000:
        raise ValueError('expected 1..100000 observations')
    by_id = {b['id']: b for b in data['budgets']}
    obligations = obligation_index(data)
    seen, output = set(), []
    for item in observations:
        if not isinstance(item, dict):
            raise ValueError('invalid observation')
        budget_id = item.get('budget_id')
        variant_id = item.get('variant_id')
        metric = item.get('metric')
        statistic_name = item.get('statistic')
        if any(not nonempty(value) for value in (budget_id, variant_id, metric, statistic_name)):
            raise ValueError('observation requires nonempty budget, variant, metric and statistic')
        entry = by_id.get(budget_id)
        key = (budget_id, variant_id, metric, statistic_name)
        obligation = obligations.get(key)
        bound = next((b for b in entry['bounds'] if b['metric'] == metric and b['statistic'] == statistic_name), None) if entry else None
        if obligation is None or bound is None or item.get('unit') != bound['unit']:
            raise ValueError('unknown workload variant/metric/statistic or mismatched unit')
        if key in seen:
            raise ValueError('duplicate observation')
        seen.add(key)
        if (not number(item.get('value'))
            or (item['value'] < 0 and bound['metric'] not in SIGNED_METRICS)
            or type(item.get('samples')) is not int or item['samples'] < 1):
            raise ValueError('invalid finite measurement/sample count')
        params = item.get('parameters', {})
        if not isinstance(params, dict) or set(params) != set(bound.get('per', {})) or any(not number(v) or v < 0 for v in params.values()):
            raise ValueError('missing/extra/invalid bound parameters')
        limit = bound['max'] + sum(params[k] * v for k, v in bound.get('per', {}).items())
        if not math.isfinite(limit):
            raise ValueError('nonfinite computed bound')
        if bound['unit'] == 'bytes':
            limit = math.ceil(limit)
        fits = item['value'] < limit if bound['operator'] == '<' else item['value'] <= limit
        assessment = 'within-target' if fits else 'over-target'
        if run['classification'] != 'reference':
            assessment += '-' + run['classification']
        if item['samples'] < entry['min_samples']:
            assessment += '-insufficient-samples'
        output.append((run['id'], cat_hash, entry['id'], item['variant_id'], bound['metric'], bound['statistic'],
                       bound['unit'], item['value'], limit, item['samples'], assessment, json.dumps(params)))
    return run, output


def write_bundle(db, run, rows, cat_hash):
    db.execute('INSERT INTO run VALUES(?,?,?,?,?,?)', (run['id'], cat_hash, run['source_hash'], run['corpus_hash'], run['environment'], json.dumps(run)))
    if 'revision' in run:
        db.execute('INSERT INTO run_revision VALUES(?,?)', (run['id'], run['revision']))
    db.executemany('INSERT INTO observation VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', rows)


def import_bundles(db, bundles, data, cat_hash, root=ROOT):
    count = 0
    # Streaming bundles keep memory bounded; one durable transaction amortizes IO.
    # Any validation/IO/SQL error rolls back every run in this batch.
    with db:
        for bundle in bundles:
            run, rows = validate_bundle(bundle, data, cat_hash, root)
            write_bundle(db, run, rows, cat_hash)
            count += len(rows)
    if count == 0:
        raise ValueError('empty import batch')
    return count


def import_bundle(db, bundle, data, cat_hash, root=ROOT):
    return import_bundles(db, [bundle], data, cat_hash, root)


def resolve_run(db, reference, cat_hash):
    """Exact run ID or unique full source/revision hash; never HEAD/latest."""
    rows = db.execute('SELECT body FROM run WHERE id=? AND catalog_hash=?', (reference, cat_hash)).fetchall()
    if not rows and HASH.fullmatch(reference):
        rows = db.execute('SELECT body FROM run WHERE source_hash=? AND catalog_hash=? LIMIT 2',
                          (reference, cat_hash)).fetchall()
    if not rows and re.fullmatch(r'[0-9a-f]{40}', reference):
        rows = db.execute('SELECT run.body FROM run_revision JOIN run ON run.id=run_revision.run_id '
                          'WHERE revision=? AND catalog_hash=? LIMIT 2', (reference, cat_hash)).fetchall()
    if len(rows) != 1:
        raise ValueError('baseline/candidate must resolve to exactly one current-catalog run')
    return json.loads(rows[0][0])


def statistic(values, name):
    if name in ('p95', 'p99'):
        return sorted(values)[math.ceil(len(values) * int(name[1:]) / 100) - 1]
    if name == 'max':
        return max(values)
    if name == 'mean':
        return math.fsum(values) / len(values)
    raise ValueError('derived comparison requires a dedicated adapter, not a submitted summary')


def comparison_evidence(db, run, root=ROOT):
    """Revalidate retained bytes and bind raw distributions to immutable ledger summaries.

    Format 2 artifacts are measurement evidence, not an attestation of host trust or
    production coverage. Legacy artifacts remain readable numeric diagnostics.
    """
    artifact = read_json(artifact_path(run, root))
    if not isinstance(artifact, dict) or artifact.get('schema_version') != 2:
        raise ValueError('comparison requires a version 2 raw-measurement artifact')
    for key, expected in [('source', run['source_hash']), ('corpus', run['corpus_hash']), ('environment', run['environment'])]:
        value = artifact.get(key)
        if not isinstance(value, dict) or not value or canonical_hash(value) != expected:
            raise ValueError(f'{key} manifest identity mismatch')
    if run['classification'] == 'reference':
        artifact_host = artifact['environment'].get('reference_host')
        if not qualified_reference_host(artifact_host) or artifact_host != run.get('reference_host'):
            raise ValueError('reference artifact lacks matching qualified dedicated host metadata')
    if 'revision' in run and artifact['source'].get('revision') != run['revision']:
        raise ValueError('source manifest revision mismatch')
    protocol = artifact.get('protocol')
    if (not isinstance(protocol, dict)
        or any(not nonempty(protocol.get(key)) for key in ('adapter', 'version', 'boundary', 'workload', 'sampling'))
        or protocol['sampling'] != 'independent-trials'):
        raise ValueError('missing adapter/boundary/workload or unsupported sampling protocol')
    # Session-correlated typing needs a session/block bootstrap adapter in T115;
    # never pretend that resampling correlated keys independently supplies a CI.
    observations = artifact.get('observations')
    if not isinstance(observations, list) or not observations or len(observations) > 1000:
        raise ValueError('missing/bounded raw observations required')
    ledger = {tuple(row[:4]): row[4:] for row in db.execute(
        'SELECT budget_id,variant_id,metric,statistic,unit,value,samples,parameters,assessment FROM observation WHERE run_id=?', (run['id'],))}
    result = {}
    for item in observations:
        if not isinstance(item, dict):
            raise ValueError('invalid raw observation')
        key = tuple(item.get(k) for k in ('budget_id', 'variant_id', 'metric', 'statistic'))
        if any(not nonempty(k) for k in key) or key in result or key not in ledger:
            raise ValueError('duplicate/unknown raw observation')
        unit, value, samples, parameters, assessment = ledger[key]
        values = item.get('values')
        if (not isinstance(values, list) or len(values) != samples or len(values) > 100_000
            or any(not number(v) or (v < 0 and key[2] not in SIGNED_METRICS) for v in values) or item.get('unit') != unit
            or item.get('parameters', {}) != json.loads(parameters)):
            raise ValueError('raw samples/unit/parameters disagree with ledger')
        if not math.isclose(statistic(values, key[3]), value, rel_tol=1e-12, abs_tol=1e-12):
            raise ValueError('raw statistic disagrees with ledger')
        result[key] = dict(values=values, value=value, unit=unit, parameters=json.loads(parameters), assessment=assessment)
    if result.keys() != ledger.keys():
        raise ValueError('raw artifact does not cover every ledger observation')
    return artifact, result


def regression_interval(baseline, candidate):
    """Seeded percentile bootstrap over independent trials, 95% ratio interval.

    An interval crossing the 10% threshold is inconclusive, never a pass. Zero
    baselines cannot establish a finite relative regression.
    """
    if min(baseline) <= 0 or min(candidate) < 0:
        raise ValueError('relative p95 comparison requires positive baseline and nonnegative candidate')
    rng = random.Random(41027)
    ratios = sorted(100 * (statistic(rng.choices(candidate, k=len(candidate)), 'p95') /
                            statistic(rng.choices(baseline, k=len(baseline)), 'p95') - 1)
                    for _ in range(2000))
    return ratios[49], ratios[1949]


def compare_runs(db, baseline_ref, candidate_ref, data, cat_hash, budget_ids=None, root=ROOT):
    baseline = resolve_run(db, baseline_ref, cat_hash)
    candidate = resolve_run(db, candidate_ref, cat_hash)
    if baseline['id'] == candidate['id']:
        raise ValueError('baseline and candidate must be distinct measured runs')
    left_artifact, left = comparison_evidence(db, baseline, root)
    right_artifact, right = comparison_evidence(db, candidate, root)
    for key in ('corpus_hash', 'environment'):
        if baseline[key] != candidate[key]:
            raise ValueError(f'incompatible {key}')
    if left_artifact['protocol'] != right_artifact['protocol']:
        raise ValueError('incompatible adapter/workload/boundary/sampling protocol')
    known = {b['id'] for b in data['budgets']}
    selected = known if budget_ids is None else set(budget_ids)
    if not selected or not selected <= known:
        raise ValueError('empty/unknown budget selector')
    required = {(item['budget_id'], item['variant_id'], item['metric'], item['statistic'])
                for item in data['measurement_obligations'] if item['budget_id'] in selected}
    missing = required - (left.keys() & right.keys())
    issues, comparisons = [], []
    if missing:
        issues.append(f'missing {len(missing)} required baseline/candidate metrics')
    if baseline['classification'] != 'reference' or candidate['classification'] != 'reference':
        issues.append('diagnostic/noisy runs cannot qualify a comparison')
    failed = False
    for key in sorted(required & left.keys() & right.keys()):
        before, after = left[key], right[key]
        if (before['unit'], before['parameters']) != (after['unit'], after['parameters']):
            raise ValueError('incompatible metric unit or workload parameters')
        for role, row in [('baseline', before), ('candidate', after)]:
            if 'insufficient-samples' in row['assessment']:
                issues.append(f'{key}: {role} has insufficient samples')
        if after['assessment'].startswith('over-target'):
            failed = True
        item = dict(budget_id=key[0], variant_id=key[1], metric=key[2], statistic=key[3],
                    baseline=before['value'], candidate=after['value'])
        if key[3] == 'p95':
            low, high = regression_interval(before['values'], after['values'])
            item['regression_percent'] = 100 * (after['value'] / before['value'] - 1)
            item['regression_ci95_percent'] = [low, high]
            if low > 10 and not math.isclose(low, 10, rel_tol=0, abs_tol=1e-10):
                failed = True
            elif high > 10 and not math.isclose(high, 10, rel_tol=0, abs_tol=1e-10):
                issues.append(f'{key}: regression confidence interval crosses 10 percent')
        comparisons.append(item)
    return dict(status='failed' if failed else 'unproven' if issues else 'comparison-satisfied',
                release='unproven', baseline=baseline['id'], candidate=candidate['id'],
                required_metrics=len(required), compared_metrics=len(comparisons), issues=issues, comparisons=comparisons)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=['check', 'build', 'status', 'show', 'import', 'resolve', 'compare'])
    parser.add_argument('arguments', nargs='*')
    args = parser.parse_args()
    try:
        data, cat_hash = catalog()
        if args.command in ('check', 'build', 'status') and args.arguments:
            raise ValueError('unexpected arguments')
        if args.command == 'check':
            print(f"Valid: {len(data['budgets'])} budgets, {len(data['measurement_obligations'])} declared workload/metric obligations, catalog {cat_hash}")
            print('Catalog validity does not certify measurements.')
            return 0
        if args.command == 'show':
            entry = next((b for b in data['budgets'] if len(args.arguments) == 1 and b['id'] == args.arguments[0]), None)
            if entry is None:
                raise ValueError('show requires an existing budget ID')
            print(json.dumps(entry, indent=2))
            return 0
        with connect() as db:
            build(db, data, cat_hash)
            if args.command == 'resolve':
                if len(args.arguments) != 1:
                    raise ValueError('resolve requires one immutable run ID or full source/revision hash')
                run = resolve_run(db, args.arguments[0], cat_hash)
                comparison_evidence(db, run)
                print(json.dumps(run, indent=2))
            elif args.command == 'compare':
                if len(args.arguments) < 2:
                    raise ValueError('compare requires BASELINE CANDIDATE [BUDGET-ID ...]')
                result = compare_runs(db, *args.arguments[:2], data, cat_hash, args.arguments[2:] or None)
                print(json.dumps(result, indent=2))
                return 0 if result['status'] == 'comparison-satisfied' else 1
            elif args.command == 'import':
                if not args.arguments:
                    raise ValueError('import requires observation JSON paths')
                count = import_bundles(db, (read_json(Path(path)) for path in args.arguments), data, cat_hash)
                print(f'Imported {count} immutable numeric observations. Release status remains unproven.')
            elif args.command == 'build':
                print(f'Indexed {len(data["budgets"])} budgets: {DATABASE.relative_to(ROOT)}')
            else:
                observed = {(r[0],r[1],r[2],r[3]) for r in db.execute('SELECT DISTINCT budget_id,variant_id,metric,statistic FROM observation WHERE catalog_hash=?', (cat_hash,))}
                required = {(item['budget_id'], item['variant_id'], item['metric'], item['statistic'])
                            for item in data['measurement_obligations']}
                runnable = runnable_obligations(data)
                reference_observed = set()
                for row in db.execute(
                    'SELECT o.budget_id,o.variant_id,o.metric,o.statistic,o.assessment,r.body '
                    'FROM observation AS o JOIN run AS r ON r.id=o.run_id '
                    'WHERE o.catalog_hash=?', (cat_hash,)):
                    key = tuple(row[:4])
                    if json.loads(row[5]).get('classification') == 'reference' and row[4] == 'within-target-reference':
                        reference_observed.add(key)
                print(f"Workload/metric coverage: declared {len(required)}; runnable {len(runnable & required)}; observed {len(observed & required)}; reference-classified {len(reference_observed & required)}.")
                print('Reference-classified cells are still not release-qualified until the complete matrix and host/protocol gates pass.')
                for row in db.execute('SELECT budget_id,variant_id,metric,statistic,value,assessment FROM observation WHERE catalog_hash=? ORDER BY rowid DESC LIMIT 20', (cat_hash,)):
                    print(' | '.join(map(str, row)))
                print(f'Missing {len(required-observed)} workload/metric cells; source/fixture coverage and baseline comparison require T106/T115.')
        return 0
    except (ValueError, OSError, KeyError, TypeError, OverflowError, sqlite3.Error) as exc:
        print(f'Performance ledger error: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
