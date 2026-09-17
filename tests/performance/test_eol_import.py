"""Run: python3 -m unittest discover -s tests/performance -p 'test_*.py'."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('xi_perf', ROOT / 'tools/perf.py')
perf = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(perf)
IMPORTER_SPEC = importlib.util.spec_from_file_location('xi_import_eol', ROOT / 'tools/import-t107-eol.py')
importer = importlib.util.module_from_spec(IMPORTER_SPEC)
IMPORTER_SPEC.loader.exec_module(importer)

VARIANTS = importer.VARIANTS
RETAINED = {'PF03-1MiB-LF-dense': 5632, 'PF03-1MiB-mixed-EOL': 109434,
            'PF03-10MiB-LF-dense': 56320, 'PF03-10MiB-mixed-EOL': 1093632}
LINE_BREAKS = {'PF03-1MiB-LF-dense': 524288, 'PF03-1MiB-mixed-EOL': 419430,
               'PF03-10MiB-LF-dense': 5242880, 'PF03-10MiB-mixed-EOL': 4194304}


def fake_report(**overrides):
    trial = {variant: {'exactSerializedBytes': True, 'lineBreaks': LINE_BREAKS[variant]} for variant in VARIANTS}
    report = {
        'classification': 'diagnostic',
        'reference_host': False,
        'source_hash': 'a' * 64,
        'collected_at': '2026-09-17T00:00:00+00:00',
        'environment': {'platform': 'unittest'},
        'command': ['python3', 'bench/performance/t107-eol-trials.py', 'out.json'],
        'trials': [dict(trial) for _ in range(30)],
        'summary': {variant: {'retained_bytes': {'p50': RETAINED[variant], 'p95': RETAINED[variant],
                                                   'p99': RETAINED[variant], 'max': RETAINED[variant]}}
                    for variant in VARIANTS},
    }
    report.update(overrides)
    return report


class EolImportTests(unittest.TestCase):
    def setUp(self):
        self.data, self.cat_hash = perf.catalog()
        self.temp = tempfile.TemporaryDirectory()
        self.trials_path = Path(self.temp.name) / 'trials.json'
        self.trials_path.write_text('{"schema_version":1}\n')
        self.corpus_hashes = {variant: 'c' * 64 for variant in VARIANTS}

    def tearDown(self):
        self.temp.cleanup()

    def test_bundle_covers_all_four_declared_variants_and_only_those(self):
        bundle = importer.build_bundle(fake_report(), self.cat_hash, self.corpus_hashes, self.trials_path, root=Path(self.temp.name))
        self.assertEqual({o['variant_id'] for o in bundle['observations']}, set(VARIANTS))
        for observation in bundle['observations']:
            self.assertEqual(observation['metric'], 'retained_eol')
            self.assertEqual(observation['value'], RETAINED[observation['variant_id']])
            self.assertEqual(observation['parameters'], {'newlines': LINE_BREAKS[observation['variant_id']]})

    def test_bundle_imports_cleanly_into_a_fresh_ledger(self):
        bundle = importer.build_bundle(fake_report(), self.cat_hash, self.corpus_hashes, self.trials_path, root=Path(self.temp.name))
        db = perf.connect(Path(self.temp.name) / 'ledger.sqlite3')
        try:
            perf.build(db, self.data, self.cat_hash)
            count = perf.import_bundle(db, bundle, self.data, self.cat_hash, root=Path(self.temp.name))
            self.assertEqual(count, 4)
            rows = db.execute("SELECT assessment FROM observation WHERE budget_id='DOC-EOL'").fetchall()
            self.assertEqual(len(rows), 4)
            for (assessment,) in rows:
                self.assertEqual(assessment, 'within-target-diagnostic')
        finally:
            db.close()

    def test_a_failed_correctness_check_or_reference_classification_is_rejected(self):
        bad_trial_report = fake_report()
        bad_trial_report['trials'][0]['PF03-1MiB-LF-dense']['exactSerializedBytes'] = False
        with self.assertRaises(ValueError):
            importer.build_bundle(bad_trial_report, self.cat_hash, self.corpus_hashes, self.trials_path, root=Path(self.temp.name))
        with self.assertRaises(ValueError):
            importer.build_bundle(fake_report(classification='reference'), self.cat_hash, self.corpus_hashes, self.trials_path, root=Path(self.temp.name))


if __name__ == '__main__':
    unittest.main()
