"""Exercise actual suite CLI discovery in disposable fixture roots."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class SuiteRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='xi-suite-test-')
        self.root = Path(self.temp.name)
        self.bun = shutil.which('bun')
        self.assertIsNotNone(self.bun, 'pinned Bun is required')

    def tearDown(self):
        self.temp.cleanup()

    def file(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def invoke(self, *args):
        return subprocess.run([self.bun, str(ROOT / 'tools/verify-suite.ts'), *args],
                              cwd=self.root, capture_output=True, text=True, timeout=15)

    def manifest(self, suite, **fields):
        directory = 'bench' if suite == 'bench' else 'tests/unit'
        self.file(directory + '/manifest.json', json.dumps(dict(schemaVersion=1, suite=suite, fixtures=['synthetic'], **fields)))

    def test_missing_option_value_is_not_silently_ignored(self):
        for args in [('bench', '--baseline'), ('unit', '--suite'), ('unit', '--suite', ''),
                     ('unit', '--suite', 'contributions', '--suite', 'contributions')]:
            with self.subTest(args=args):
                result = self.invoke(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('requires exactly one nonempty value', result.stderr)

    def test_missing_explicit_fixture_fails_before_any_test_executes(self):
        self.manifest('unit')
        result = self.invoke('unit', '--suite', 'contributions')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Required fixture path is missing', result.stderr)
        self.assertNotIn('passed', result.stdout)

    def test_unknown_selector_or_missing_manifest_fails(self):
        self.manifest('unit')
        result = self.invoke('unit', '--suite', 'not-a-suite')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('no fixtures for selector', result.stderr)
        (self.root / 'tests/unit/manifest.json').unlink()
        self.assertNotEqual(self.invoke('unit').returncode, 0)

    def test_benchmark_manifest_requires_real_registered_entrypoints(self):
        self.manifest('bench', executables=['bench/missing.ts'])
        result = self.invoke('bench')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Required fixture path is missing', result.stderr)
        self.file('bench/real.ts', "console.log('ACTUAL-FIXTURE-RAN');")
        self.file('bench/helper.ts', "throw new Error('helper must not execute');")
        self.manifest('bench', executables=['bench/real.ts'])
        result = self.invoke('bench')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('ACTUAL-FIXTURE-RAN', result.stdout)
        result = self.invoke('bench', '--suite', 'interaction')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('declare every selected executable', result.stderr)

    def test_invalid_manifest_schema_duplicate_and_traversal_rejected(self):
        for fields in [dict(schemaVersion=2), dict(fixtures=['x', 'x']),
                       dict(executables=['../outside.ts']), dict(executables=['bench/x.ts', 'bench/x.ts'])]:
            data = dict(schemaVersion=1, suite='bench', fixtures=['synthetic'], executables=['bench/x.ts']) | fields
            self.file('bench/manifest.json', json.dumps(data))
            result = self.invoke('bench')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('no valid manifest', result.stderr)

    def test_summary_baseline_label_cannot_pass(self):
        for name in ['tools/perf.py', 'docs/plan/performance-budgets.json', 'docs/plan/performance-adapters.json', 'docs/plan/tickets.json', 'docs/plan/12-performance.md']:
            self.file(name, (ROOT / name).read_text())
        adapters = json.loads((ROOT / 'docs/plan/performance-adapters.json').read_text())['adapters']
        variants = json.loads((ROOT / 'docs/plan/performance-adapters.json').read_text())['variant_catalog']
        for variant in variants:
            generator = variant['generator']['path']
            self.file(generator, (ROOT / generator).read_text())
        for adapter in adapters:
            entrypoint = adapter['entrypoint']
            self.file(entrypoint, (ROOT / entrypoint).read_text())
        result = self.invoke('bench', '--baseline', 'revision')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('must resolve to exactly one', result.stderr)
        self.assertNotIn('passed', result.stdout)

    def test_standalone_document_scripts_execute_and_are_required(self):
        self.manifest('unit')
        for directory in ['architecture', 'config', 'layout', 'persistence', 'selections', 'workbench']:
            self.file(f'tests/{directory}/fixture.test.ts', "import { test, expect } from 'bun:test'; test('fixture', () => expect(1).toBe(1));")
        self.file('tests/performance/test_fixture.py', "print('PYTHON-PERFORMANCE-RAN')")
        scripts = ['verify.ts', 't010-text-fidelity.ts', 't011-transactions.ts', 't012-undo-history.ts', 't101-literal-controls.ts']
        for script in scripts:
            self.file('tests/document/' + script, f"if (import.meta.main) console.log('RAN-{script}');")
        result = self.invoke('unit')
        self.assertEqual(result.returncode, 0, result.stderr)
        for script in scripts:
            self.assertEqual(result.stdout.count('RAN-' + script), 1)
        (self.root / 'tests/document/t011-transactions.ts').unlink()
        result = self.invoke('unit')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Required fixture path is missing', result.stderr)
        self.assertNotIn('RAN-', result.stdout)


if __name__ == '__main__':
    unittest.main()
