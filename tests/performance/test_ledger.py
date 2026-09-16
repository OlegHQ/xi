"""Run: python3 -m unittest discover -s tests/performance -p 'test_*.py'."""
import copy
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('xi_perf', Path(__file__).resolve().parents[2] / 'tools/perf.py')
perf = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(perf)


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data, self.hash = perf.catalog()
        self.db = perf.connect(self.root / 'ledger.sqlite3')
        perf.build(self.db, self.data, self.hash)
        (self.root / 'trace.json').write_text('{"fixture":"synthetic-ledger-test"}\n')
        self.bundle = {'schema_version': 1, 'run': {
            'id': 'test-run', 'catalog_hash': self.hash, 'source_hash': 'a'*64,
            'corpus_hash': 'b'*64, 'environment': 'unittest', 'collected_at': '2026-09-15T00:00:00Z',
            'command': ['synthetic-test'], 'classification': 'diagnostic',
            'artifact': 'trace.json', 'artifact_sha256': perf.digest((self.root / 'trace.json').read_bytes())},
            'observations': [{'budget_id': 'DOC-OPEN', 'variant_id': 'PF01-2k-source', 'metric': 'wall', 'statistic': 'p95',
                              'unit': 'ms', 'value': 1500, 'samples': 1}]}

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def ingest(self, bundle=None):
        return perf.import_bundle(self.db, bundle or self.bundle, self.data, self.hash, self.root)

    def test_numeric_failure_preserves_provenance_and_insufficient_samples(self):
        self.assertEqual(self.ingest(), 1)
        result = self.db.execute('SELECT value,bound,assessment FROM observation').fetchone()
        self.assertEqual(result, (1500, 100, 'over-target-diagnostic-insufficient-samples'))
        run = json.loads(self.db.execute('SELECT body FROM run').fetchone()[0])
        self.assertEqual(run['artifact_sha256'], self.bundle['run']['artifact_sha256'])

    def test_batch_failure_rolls_back_prior_valid_bundle(self):
        invalid = copy.deepcopy(self.bundle)
        invalid['run']['id'] = 'second'
        invalid['observations'][0]['unit'] = 'seconds'
        with self.assertRaises(ValueError):
            perf.import_bundles(self.db, iter([self.bundle, invalid]), self.data, self.hash, self.root)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM run').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM observation').fetchone()[0], 0)

    def test_duplicate_run_is_immutable(self):
        self.ingest()
        self.bundle['observations'][0]['value'] = 1
        with self.assertRaises(sqlite3.IntegrityError):
            self.ingest()
        self.assertEqual(self.db.execute('SELECT value FROM observation').fetchone()[0], 1500)

    def test_invalid_observations_do_not_partially_import(self):
        for change in [{'unit': 'seconds'}, {'value': float('nan')}, {'value': True}, {'value': -1},
                       {'samples': 0}, {'variant_id': 'PF99-unknown'}, {'variant_id': None},
                       {'metric': 'imagined'}, {'parameters': {'input_bytes': 2}}]:
            with self.subTest(change=change):
                bundle = copy.deepcopy(self.bundle)
                invalid = {**bundle['observations'][0], **change}
                bundle['observations'] = [{**bundle['observations'][0], 'metric': 'cpu'}, invalid]
                with self.assertRaises(ValueError):
                    self.ingest(bundle)
                self.assertEqual(self.db.execute('SELECT COUNT(*) FROM run').fetchone()[0], 0)

    def test_workload_metric_matrix_is_explicit_and_unique(self):
        adapters = self.data['production_adapters']
        expected = sum(len(adapter['workload_variants']) * len(adapter['metrics']) for adapter in adapters)
        obligations = self.data['measurement_obligations']
        keys = {(item['budget_id'], item['variant_id'], item['metric'], item['statistic']) for item in obligations}
        self.assertEqual(len(obligations), expected)
        self.assertEqual(len(keys), expected)
        self.assertTrue(all(item['status'] == 'declared' for item in obligations))
        self.assertTrue(all(item['producer']['selector'].startswith('pending:T115:') for item in obligations))
        self.assertEqual(perf.runnable_obligations(self.data), set())

    def test_missing_stale_tampered_artifacts_fail(self):
        for change in [{'catalog_hash': 'c'*64}, {'artifact': 'missing'},
                       {'artifact': '../outside'}, {'artifact_sha256': 'd'*64}, {'source_hash': 'HEAD'}, {'collected_at': 'yesterday'}, {'collected_at': '2026-09-15T12:00:00'}]:
            with self.subTest(change=change):
                bundle = copy.deepcopy(self.bundle)
                bundle['run'].update(change)
                with self.assertRaises(ValueError):
                    self.ingest(bundle)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM observation').fetchone()[0], 0)

    def test_reference_requires_qualified_host_metadata(self):
        bundle = copy.deepcopy(self.bundle)
        bundle['run']['classification'] = 'reference'
        with self.assertRaisesRegex(ValueError, 'qualified dedicated'):
            self.ingest(bundle)
        bundle['run']['reference_host'] = {
            'id': 'shared-host', 'dedicated': False,
            'qualification_method': 'unit-test', 'qualification_sha256': 'c' * 64,
        }
        with self.assertRaisesRegex(ValueError, 'qualified dedicated'):
            self.ingest(bundle)
        bundle['run']['reference_host']['dedicated'] = True
        self.assertEqual(self.ingest(bundle), 1)

    def test_parameterized_density_bound(self):
        self.bundle['observations'] = [{'budget_id': 'DOC-EOL', 'variant_id': 'PF03-1MiB-LF-dense', 'metric': 'retained_eol',
            'statistic': 'max', 'unit': 'bytes', 'value': 65538, 'samples': 30, 'parameters': {'newlines': 5}}]
        self.ingest()
        self.assertEqual(self.db.execute('SELECT bound,assessment FROM observation').fetchone(),
                         (65538, 'within-target-diagnostic'))

    def test_strict_less_than_and_signed_regression(self):
        self.bundle['observations'] = [
            {'budget_id': 'IDLE', 'variant_id': 'PF10-1000-cycles', 'metric': 'cpu_core_percent', 'statistic': 'mean', 'unit': 'percent', 'value': 1, 'samples': 1},
            {'budget_id': 'REGRESSION', 'variant_id': 'PF12-100k-import', 'metric': 'p95_regression', 'statistic': 'comparison', 'unit': 'percent', 'value': -10, 'samples': 30}]
        self.ingest()
        self.assertEqual(self.db.execute("SELECT assessment FROM observation WHERE budget_id='IDLE'").fetchone()[0], 'over-target-diagnostic')
        self.assertEqual(self.db.execute("SELECT value FROM observation WHERE budget_id='REGRESSION'").fetchone()[0], -10)

    def test_catalog_refresh_retains_old_results_without_current_coverage(self):
        self.ingest()
        changed = copy.deepcopy(self.data)
        changed['budgets'][0]['bounds'][0]['max'] = .9
        new_hash = perf.digest(json.dumps(changed, sort_keys=True, separators=(',', ':')).encode())
        perf.build(self.db, changed, new_hash)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM observation WHERE catalog_hash=?', (new_hash,)).fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM observation WHERE catalog_hash=?', (self.hash,)).fetchone()[0], 1)

    def test_sql_values_are_bound_and_lookup_is_indexed(self):
        self.bundle['run']['id'] = "'; DROP TABLE budget; --"
        self.ingest()
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM budget').fetchone()[0], len(self.data['budgets']))
        plan = self.db.execute('EXPLAIN QUERY PLAN SELECT value FROM observation WHERE catalog_hash=? AND budget_id=? AND metric=?',
                               (self.hash, 'DOC-OPEN', 'wall')).fetchall()
        self.assertTrue(any('observation_lookup' in row[3] for row in plan), plan)

    def test_json_rejects_duplicate_keys_and_nonfinite(self):
        path = self.root / 'invalid.json'
        for text in ['{"x":1,"x":2}', '{"x":NaN}', '{"x":Infinity}']:
            path.write_text(text)
            with self.assertRaises(ValueError):
                perf.read_json(path)


if __name__ == '__main__':
    unittest.main()
