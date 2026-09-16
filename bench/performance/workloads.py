#!/usr/bin/env python3
"""Generate deterministic performance workload bytes from the declared catalog.

This is a corpus generator for benchmark adapters, not an editor implementation.
The catalog owns variant identity; this command only materializes a selected
variant and records its output hash so a producer can bind measurements to bytes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / 'docs/plan/performance-adapters.json'
SQLITE = ROOT / '.artifacts/performance-planning/sqlite3.c'
SQLITE_SHA256 = 'e3f5d6901e7492af4a1fc8c4d745cae84c264942524c3fbfc02b82a5ca8818c8'


def read_variant(variant_id: str) -> dict:
    data = json.loads(CATALOG.read_text(encoding='utf-8'))
    for variant in data['variant_catalog']:
        if variant['id'] == variant_id:
            return variant
    raise ValueError(f'unknown performance workload variant: {variant_id}')


def write_repeated(path: Path, payload: bytes, size: int) -> None:
    with path.open('wb') as stream:
        full, remainder = divmod(size, len(payload))
        for _ in range(full):
            stream.write(payload)
        stream.write(payload[:remainder])


def materialize(variant: dict, output: Path) -> dict:
    parameters = variant.get('parameters', {})
    output.parent.mkdir(parents=True, exist_ok=True)
    if variant['family'] == 'PF04':
        if not SQLITE.is_file():
            raise ValueError(f'missing pinned SQLite corpus: {SQLITE}')
        digest = hashlib.sha256(SQLITE.read_bytes()).hexdigest()
        if digest != SQLITE_SHA256:
            raise ValueError('pinned SQLite corpus hash mismatch')
        shutil.copyfile(SQLITE, output)
    else:
        size = parameters.get('input_bytes')
        if not isinstance(size, int) or size < 0:
            raise ValueError(f'{variant["id"]}: generator requires nonnegative input_bytes')
        pattern = parameters.get('pattern', 'x')
        if not isinstance(pattern, str) or not pattern:
            raise ValueError(f'{variant["id"]}: generator pattern must be nonempty')
        encoded = pattern.encode('utf-8')
        write_repeated(output, encoded, size)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    return {
        'variant': variant['id'],
        'family': variant['family'],
        'bytes': output.stat().st_size,
        'sha256': digest,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('variant')
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    print(json.dumps(materialize(read_variant(args.variant), args.output), sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
