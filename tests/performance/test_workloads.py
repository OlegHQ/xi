"""Deterministic checks for declared performance workload materialization."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
GENERATOR = ROOT / 'bench/performance/workloads.py'
CATALOG = ROOT / 'docs/plan/performance-adapters.json'


class WorkloadTests(unittest.TestCase):
    def generate(self, variant, output):
        result = subprocess.run([sys.executable, str(GENERATOR), variant, str(output)],
                                cwd=ROOT, capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    def test_representative_unicode_and_eol_variants_are_byte_deterministic(self):
        with tempfile.TemporaryDirectory(prefix='xi-workload-test-') as directory:
            root = Path(directory)
            for variant in ['PF01-2k-source', 'PF02-1MiB-wide-emoji', 'PF03-1MiB-mixed-EOL']:
                first = root / (variant + '-first')
                second = root / (variant + '-second')
                first_result = self.generate(variant, first)
                second_result = self.generate(variant, second)
                self.assertEqual(first.read_bytes(), second.read_bytes(), variant)
                self.assertEqual(first_result, second_result, variant)
                self.assertEqual(first_result['bytes'], first.stat().st_size)
                self.assertEqual(first_result['sha256'], hashlib.sha256(first.read_bytes()).hexdigest())

    def test_every_declared_variant_has_a_real_generator_selector(self):
        data = json.loads(CATALOG.read_text(encoding='utf-8'))
        variants = data['variant_catalog']
        self.assertEqual(len(variants), len({variant['id'] for variant in variants}))
        for variant in variants:
            self.assertEqual(variant['generator']['path'], 'bench/performance/workloads.py')
            self.assertEqual(variant['generator']['selector'], variant['id'])
            self.assertTrue((ROOT / variant['generator']['path']).is_file())


if __name__ == '__main__':
    unittest.main()
