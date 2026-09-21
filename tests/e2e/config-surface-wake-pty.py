#!/usr/bin/env python3
"""A surface-change notification must not clear the whole terminal frame."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("input_latency", ROOT / "tests/support/input-latency-pty.py")
assert spec is not None and spec.loader is not None
latency = importlib.util.module_from_spec(spec)
spec.loader.exec_module(latency)

result = latency.measure(30, 5, ["bun", "run", str(ROOT / "apps/xi/src/main.ts")])
p95_bytes = latency.percentile(result["key_output_bytes"], .95)
assert p95_bytes < 1_000, f"ordinary key repainted the terminal: p95={p95_bytes} bytes"
print(f"CONFIG-SURFACE-WAKE-PTY-01 passed: correct visible cells and saved bytes; p95 key output={p95_bytes} bytes")
