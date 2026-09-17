"""Run: python3 -m unittest discover -s tests/performance -p 'test_*.py'."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('xi_perf', ROOT / 'tools/perf.py')
perf = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(perf)
IMPORTER_SPEC = importlib.util.spec_from_file_location('xi_import_retention', ROOT / 'tools/import-t114-retention.py')
importer = importlib.util.module_from_spec(IMPORTER_SPEC)
IMPORTER_SPEC.loader.exec_module(importer)


def fake_report(**overrides):
    trial = {'lifecycle': {'leftoverLeases': 0, 'leftoverBytes': 0}}
    report = {
        'classification': 'diagnostic',
        'reference_host': False,
        'source_hash': 'a' * 64,
        'collected_at': '2026-09-17T00:00:00+00:00',
        'environment': {'platform': 'unittest'},
        'command': ['python3', 'bench/performance/t114-retention-trials.py', 'out.json'],
        'trials': [dict(trial) for _ in range(30)],
        'summary': {'retained_growth_bytes': {'p50': 3000000, 'p95': 3500000, 'p99': 3600000, 'max': 3700000}},
    }
    report.update(overrides)
    return report


class RetentionImportTests(unittest.TestCase):
    def setUp(self):
        self.data, self.cat_hash = perf.catalog()
        self.temp = tempfile.TemporaryDirectory()
        self.trials_path = Path(self.temp.name) / 'trials.json'
        self.trials_path.write_text('{"schema_version":1}\n')

    def tearDown(self):
        self.temp.cleanup()

    def test_bundle_covers_only_the_measured_variant(self):
        bundle = importer.build_bundle(fake_report(), self.cat_hash, 'c' * 64, self.trials_path, root=Path(self.temp.name))
        self.assertEqual(len(bundle['observations']), 1)
        observation = bundle['observations'][0]
        self.assertEqual(observation['variant_id'], 'PF10-1000-cycles')
        self.assertEqual(observation['value'], 3700000)

    def test_bundle_imports_cleanly_into_a_fresh_ledger(self):
        bundle = importer.build_bundle(fake_report(), self.cat_hash, 'c' * 64, self.trials_path, root=Path(self.temp.name))
        db = perf.connect(Path(self.temp.name) / 'ledger.sqlite3')
        try:
            perf.build(db, self.data, self.cat_hash)
            count = perf.import_bundle(db, bundle, self.data, self.cat_hash, root=Path(self.temp.name))
            self.assertEqual(count, 1)
            row = db.execute("SELECT assessment FROM observation WHERE budget_id='RETENTION'").fetchone()
            self.assertEqual(row[0], 'within-target-diagnostic')
        finally:
            db.close()

    def test_a_failed_correctness_check_or_reference_classification_is_rejected(self):
        bad_trial_report = fake_report()
        bad_trial_report['trials'][0]['lifecycle']['leftoverLeases'] = 1
        with self.assertRaises(ValueError):
            importer.build_bundle(bad_trial_report, self.cat_hash, 'c' * 64, self.trials_path, root=Path(self.temp.name))
        with self.assertRaises(ValueError):
            importer.build_bundle(fake_report(classification='reference'), self.cat_hash, 'c' * 64, self.trials_path, root=Path(self.temp.name))


if __name__ == '__main__':
    unittest.main()
