"""Adversarial tests for raw baseline/candidate evidence, using synthetic trials."""
import json
import unittest
import test_ledger as ledger

perf = ledger.perf


class ComparisonTests(unittest.TestCase):
    setUp = ledger.LedgerTests.setUp
    tearDown = ledger.LedgerTests.tearDown

    reference_host = {
        'id': 'synthetic-unit-test',
        'dedicated': True,
        'qualification_method': 'unit-test-only',
        'qualification_sha256': 'c' * 64,
    }

    def record(self, name, value=1, samples=30, classification='reference', change=None, revision=None):
        artifact = {
            'schema_version': 2,
            'source': {'revision': revision or name, 'files': {'synthetic.py': 'a'*64}},
            'corpus': {'fixture': 'PF01-synthetic-comparator-only', 'sha256': 'b'*64},
            'environment': {'host': 'synthetic-unit-test', 'runtime': 'none'},
            'protocol': {'adapter': 'synthetic-test', 'version': '1', 'boundary': 'none',
                         'workload': 'PF01-2k-source', 'sampling': 'independent-trials'},
            'observations': [dict(budget_id=item['budget_id'], variant_id=item['variant_id'], metric=item['metric'],
                                  statistic=item['statistic'], unit=item['unit'], values=[value]*samples)
                             for item in self.data['measurement_obligations'] if item['budget_id'] == 'DOC-OPEN']}
        artifact['environment']['reference_host'] = self.reference_host.copy()
        if change:
            change(artifact)
        path = self.root / (name + '.json')
        path.write_text(json.dumps(artifact))
        run = {**self.bundle['run'], 'id': name, 'classification': classification,
               'source_hash': perf.canonical_hash(artifact['source']),
               'corpus_hash': perf.canonical_hash(artifact['corpus']),
               'environment': perf.canonical_hash(artifact['environment']),
               'artifact': path.name, 'artifact_sha256': perf.digest(path.read_bytes())}
        if classification == 'reference':
            run['reference_host'] = self.reference_host.copy()
        if revision is not None:
            run['revision'] = revision
        observations = [{k: v for k, v in item.items() if k != 'values'} | {
            'samples': len(item['values']), 'value': perf.statistic(item['values'], item['statistic'])}
            for item in artifact['observations']]
        perf.import_bundle(self.db, dict(schema_version=1, run=run, observations=observations), self.data, self.hash, self.root)
        return run

    def compare(self, budgets=('DOC-OPEN',)):
        return perf.compare_runs(self.db, 'before', 'after', self.data, self.hash, budgets, self.root)

    def test_real_run_resolution_and_stable_improvement(self):
        run = self.record('before')
        self.record('after', .9)
        self.assertEqual(perf.resolve_run(self.db, run['source_hash'], self.hash)['id'], 'before')
        result = self.compare()
        self.assertEqual(result['status'], 'comparison-satisfied')
        self.assertEqual(result['release'], 'unproven')
        self.assertEqual(result['compared_metrics'], len([item for item in self.data['measurement_obligations'] if item['budget_id'] == 'DOC-OPEN']))
        self.assertAlmostEqual(result['comparisons'][0]['regression_percent'], -10)

    def test_significant_regression_fails_inside_absolute_budget(self):
        self.record('before')
        self.record('after', 1.2)
        result = self.compare()
        self.assertEqual(result['status'], 'failed')
        self.assertGreater(result['comparisons'][0]['regression_ci95_percent'][0], 10)

    def test_exact_ten_percent_does_not_fail_from_floating_point_roundoff(self):
        self.record('before')
        self.record('after', 1.1)
        self.assertEqual(self.compare()['status'], 'comparison-satisfied')

    def test_absolute_failure_even_with_improvement(self):
        self.record('before', 200)
        self.record('after', 150)
        self.assertEqual(self.compare()['status'], 'failed')

    def test_diagnostic_noisy_and_insufficient_samples_never_qualify(self):
        for classification, samples in [('diagnostic', 30), ('noisy', 30), ('reference', 1)]:
            with self.subTest(classification=classification, samples=samples):
                self.db.execute('DELETE FROM observation')
                self.db.execute('DELETE FROM run')
                self.db.commit()
                self.record('before')
                self.record('after', .9, samples, classification)
                self.assertEqual(self.compare()['status'], 'unproven')

    def test_full_catalog_missing_metrics_remain_unproven(self):
        self.record('before')
        self.record('after')
        result = self.compare(None)
        self.assertEqual(result['status'], 'unproven')
        self.assertGreater(result['required_metrics'], result['compared_metrics'])
        with self.assertRaises(ValueError):
            self.compare(())
        with self.assertRaises(ValueError):
            self.compare(('unknown',))

    def test_full_revision_resolves_uniquely_without_hiding_dirty_source(self):
        revision = 'd'*40
        before = self.record('before', revision=revision)
        self.assertEqual(perf.resolve_run(self.db, revision, self.hash)['id'], 'before')
        self.record('after', revision=revision, change=lambda a: a['source']['files'].update(changed='e'*64))
        with self.assertRaises(ValueError):
            perf.resolve_run(self.db, revision, self.hash)
        self.assertEqual(perf.resolve_run(self.db, before['source_hash'], self.hash)['id'], 'before')
        with self.assertRaises(ValueError):
            self.record('invalid', revision='HEAD')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM run_revision').fetchone()[0], 2)

    def test_missing_ambiguous_stale_or_self_baseline_rejected(self):
        before = self.record('before')
        self.record('after')
        with self.assertRaises(ValueError):
            perf.resolve_run(self.db, 'revision', self.hash)
        with self.assertRaises(ValueError):
            perf.resolve_run(self.db, 'before', 'c'*64)
        with self.assertRaises(ValueError):
            perf.compare_runs(self.db, 'before', 'before', self.data, self.hash, ['DOC-OPEN'], self.root)
        self.db.execute('UPDATE run SET source_hash=? WHERE id=?', (before['source_hash'], 'after'))
        with self.assertRaises(ValueError):
            perf.resolve_run(self.db, before['source_hash'], self.hash)

    def test_mismatched_corpus_environment_protocol_rejected(self):
        for key in ('corpus', 'environment', 'protocol'):
            with self.subTest(key=key):
                self.db.execute('DELETE FROM observation')
                self.db.execute('DELETE FROM run')
                self.db.commit()
                self.record('before')
                self.record('after', change=lambda a: a[key].update(different=True))
                with self.assertRaises(ValueError):
                    self.compare()

    def test_retained_artifact_deleted_or_modified_after_import_rejected(self):
        self.record('before')
        self.record('after')
        path = self.root / 'before.json'
        path.write_text('{}')
        with self.assertRaises(ValueError):
            self.compare()
        path.unlink()
        with self.assertRaises(ValueError):
            self.compare()

    def test_raw_values_cannot_disagree_with_imported_summary(self):
        self.record('before')
        self.record('after')
        path = self.root / 'after.json'
        artifact = json.loads(path.read_text())
        artifact['observations'][0]['values'] = [2]*30
        path.write_text(json.dumps(artifact))
        # Simulate an incorrectly produced bundle whose artifact hash was correct.
        run = json.loads(self.db.execute("SELECT body FROM run WHERE id='after'").fetchone()[0])
        run['artifact_sha256'] = perf.digest(path.read_bytes())
        self.db.execute("UPDATE run SET body=? WHERE id='after'", (json.dumps(run),))
        with self.assertRaisesRegex(ValueError, 'raw statistic'):
            self.compare()

    def test_reference_artifact_requires_matching_qualified_host(self):
        self.record('before')
        self.record('after')
        path = self.root / 'before.json'
        artifact = json.loads(path.read_text())
        artifact['environment']['reference_host']['id'] = 'different-qualified-host'
        path.write_text(json.dumps(artifact))
        run = json.loads(self.db.execute("SELECT body FROM run WHERE id='before'").fetchone()[0])
        run['artifact_sha256'] = perf.digest(path.read_bytes())
        run['environment'] = perf.canonical_hash(artifact['environment'])
        self.db.execute("UPDATE run SET body=? WHERE id='before'", (json.dumps(run),))
        with self.assertRaisesRegex(ValueError, 'matching qualified dedicated host'):
            self.compare()

    def test_legacy_summary_only_artifacts_cannot_compare(self):
        perf.import_bundle(self.db, self.bundle, self.data, self.hash, self.root)
        with self.assertRaisesRegex(ValueError, 'version 2'):
            perf.comparison_evidence(self.db, self.bundle['run'], self.root)

    def test_manifest_mismatch_and_correlated_sampling_rejected(self):
        for field in ('source', 'corpus', 'environment', 'protocol'):
            with self.subTest(field=field):
                self.db.execute('DELETE FROM observation')
                self.db.execute('DELETE FROM run')
                self.db.commit()
                self.record('before')
                self.record('after')
                path = self.root / 'after.json'
                artifact = json.loads(path.read_text())
                artifact[field]['sampling' if field == 'protocol' else 'tampered'] = 'correlated-keys'
                path.write_text(json.dumps(artifact))
                run = json.loads(self.db.execute("SELECT body FROM run WHERE id='after'").fetchone()[0])
                run['artifact_sha256'] = perf.digest(path.read_bytes())
                self.db.execute("UPDATE run SET body=? WHERE id='after'", (json.dumps(run),))
                with self.assertRaises(ValueError):
                    self.compare()

    def test_zero_baseline_and_confidence_interval_crossing_are_not_passes(self):
        with self.assertRaises(ValueError):
            perf.regression_interval([0]*30, [1]*30)
        self.record('before')
        def varied(a):
            for row in a['observations']:
                row['values'] = [.5]*29 + [2]
        self.record('after', change=varied)
        self.assertEqual(self.compare()['status'], 'unproven')


if __name__ == '__main__':
    unittest.main()
