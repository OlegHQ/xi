"""Run: python3 -m unittest discover -s tests/performance -p 'test_*.py'."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('xi_perf', ROOT / 'tools/perf.py')
perf = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(perf)
IMPORTER_SPEC = importlib.util.spec_from_file_location('xi_import_pf12', ROOT / 'tools/import-t106-ledger-pf12.py')
importer = importlib.util.module_from_spec(IMPORTER_SPEC)
IMPORTER_SPEC.loader.exec_module(importer)


def fake_report(**overrides):
    report = {
        'classification': 'diagnostic',
        'reference_host': False,
        'source_hash': 'a' * 64,
        'collected_at': '2026-09-17T00:00:00+00:00',
        'environment': {'platform': 'unittest'},
        'command': ['python3', 'bench/performance/ledger-trials.py', 'out.json'],
        'trials': [{}] * 30,
        'summary': {
            'import_wall_ms': {'p50': 1000.0, 'p95': 1200.0, 'p99': 1250.0, 'max': 1300.0},
            'query_p95_ms': {'p50': 0.01, 'p95': 0.02, 'p99': 0.03, 'max': 0.04},
            'max_rss_kib': {'p50': 20000, 'p95': 20100, 'p99': 20200, 'max': 20300},
        },
    }
    report.update(overrides)
    return report


class LedgerPf12ImportTests(unittest.TestCase):
    def setUp(self):
        self.data, self.cat_hash = perf.catalog()
        self.temp = tempfile.TemporaryDirectory()
        self.trials_path = Path(self.temp.name) / 'trials.json'
        self.trials_path.write_text('{"schema_version":1}\n')

    def tearDown(self):
        self.temp.cleanup()

    def test_bundle_maps_measured_metrics_to_their_specific_variants(self):
        bundle = importer.build_bundle(fake_report(), self.cat_hash, 'c' * 64, self.trials_path, root=Path(self.temp.name))
        by_metric = {(o['variant_id'], o['metric']): o['value'] for o in bundle['observations']}
        self.assertEqual(by_metric[('PF12-100k-import', 'import')], 1200.0)
        self.assertEqual(by_metric[('PF12-100k-import', 'rss_peak')], 20300 * 1024)
        self.assertEqual(by_metric[('PF12-1k-indexed-query', 'lookup')], 0.02)
        # Deliberately narrow: the rejection-path variants were not measured and must not appear.
        variant_ids = {o['variant_id'] for o in bundle['observations']}
        self.assertNotIn('PF12-malformed-evidence', variant_ids)
        self.assertNotIn('PF12-stale-evidence', variant_ids)

    def test_bundle_imports_cleanly_into_a_fresh_ledger(self):
        bundle = importer.build_bundle(fake_report(), self.cat_hash, 'c' * 64, self.trials_path, root=Path(self.temp.name))
        db = perf.connect(Path(self.temp.name) / 'ledger.sqlite3')
        try:
            perf.build(db, self.data, self.cat_hash)
            count = perf.import_bundle(db, bundle, self.data, self.cat_hash, root=Path(self.temp.name))
            self.assertEqual(count, 3)
            rows = db.execute("SELECT assessment FROM observation WHERE budget_id='LEDGER'").fetchall()
            self.assertEqual(len(rows), 3)
            for (assessment,) in rows:
                self.assertEqual(assessment, 'within-target-diagnostic')
        finally:
            db.close()

    def test_reference_classified_or_short_trial_reports_are_rejected(self):
        with self.assertRaises(ValueError):
            importer.build_bundle(fake_report(classification='reference'), self.cat_hash, 'c' * 64, self.trials_path, root=Path(self.temp.name))
        with self.assertRaises(ValueError):
            importer.build_bundle(fake_report(trials=[{}] * 29), self.cat_hash, 'c' * 64, self.trials_path, root=Path(self.temp.name))


if __name__ == '__main__':
    unittest.main()
