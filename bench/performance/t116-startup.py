#!/usr/bin/env python3
"""Measure the production Xi source launcher through a real PTY.

This is diagnostic evidence until a dedicated reference host is available.
Each sample is a fresh process with a filesystem-warm temporary fixture.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import platform
import pty
import resource
import select
import shutil
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[2]
MARKER = b"XI_WORKBENCH_READY"
SOURCE_FILES = (
    "apps/xi/src/main.ts",
    "packages/document/src/entrypoints/launch.ts",
    "packages/services/src/entrypoints/launch-core.ts",
    "packages/services/src/entrypoints/persistence.ts",
    "packages/services/persistence/index.ts",
    "packages/platform/src/entrypoints/launch.ts",
    "packages/platform/src/filesystem.ts",
    "packages/platform/src/process.ts",
    "packages/ui/src/entrypoints/launch.ts",
    "packages/ui/src/terminal.ts",
    "packages/ui/src/workbench.ts",
    "packages/ui/editor/motion-paint.ts",
    "packages/workbench/src/entrypoints/launch.ts",
    "packages/workbench/src/read-model.ts",
    "packages/workbench/session/index.ts",
    "packages/workbench/vim-session/index.ts",
    "packages/vim/src/entrypoints/launch.ts",
)


def digest_sources() -> dict[str, str]:
    return {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in SOURCE_FILES}


def nearest_rank(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    index = max(0, math.ceil(len(ordered) * quantile) - 1)
    return ordered[index]


def run_trial(path: Path, home: Path) -> dict[str, float | int]:
    master, slave = pty.openpty()
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": str(home), "XI_UI_TEST_MARKERS": "1"})
    usage_before = resource.getrusage(resource.RUSAGE_CHILDREN)
    started = time.perf_counter_ns()
    child = subprocess.Popen(
        ["bun", "run", "apps/xi/src/main.ts", str(path)],
        cwd=ROOT,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()
    ready_ns: int | None = None
    deadline = time.monotonic() + 10
    try:
        while time.monotonic() < deadline and ready_ns is None:
            readable, _, _ = select.select([master], [], [], 0.05)
            if not readable:
                continue
            try:
                captured.extend(os.read(master, 65536))
            except OSError:
                break
            if len(captured) > 16384:
                del captured[:-16384]
            if MARKER in captured:
                ready_ns = time.perf_counter_ns()
        if ready_ns is None:
            raise RuntimeError("Xi did not reach XI_WORKBENCH_READY within 10 seconds")
        os.write(master, b"q")
        child.wait(timeout=5)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
    if child.returncode != 0:
        raise RuntimeError(f"Xi startup child exited {child.returncode}")
    usage_after = resource.getrusage(resource.RUSAGE_CHILDREN)
    return {
        "wall_ms": (ready_ns - started) / 1_000_000,
        "cpu_ms": ((usage_after.ru_utime - usage_before.ru_utime)
                   + (usage_after.ru_stime - usage_before.ru_stime)) * 1000,
        "output_bytes_before_ready": len(captured),
    }


def main() -> int:
    if len(sys.argv) != 2:
        raise ValueError("usage: t116-startup.py OUTPUT.json")
    if sys.platform != "linux":
        raise ValueError("the PTY startup adapter is pinned to Linux")
    output = (ROOT / sys.argv[1]).resolve()
    if output.exists() or not output.is_relative_to(ROOT):
        raise ValueError("output must be a new repository-relative path")
    bun = shutil.which("bun")
    if bun is None:
        raise ValueError("bun is required")
    source = digest_sources()
    source_hash = hashlib.sha256(json.dumps(source, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    started = datetime.now(timezone.utc).isoformat()
    with tempfile.TemporaryDirectory(prefix="xi-t116-startup-") as temporary:
        home = Path(temporary) / "home"
        home.mkdir()
        fixture = Path(temporary) / "sample.txt"
        fixture.write_text("hello\n", encoding="utf-8")
        trials = []
        for index in range(30):
            if digest_sources() != source:
                raise RuntimeError("source changed during collection; discard evidence")
            trial = run_trial(fixture, home)
            trials.append({"trial": index + 1, **trial})
            print(f"T116 startup {index + 1}/30 complete", flush=True)
    if digest_sources() != source:
        raise RuntimeError("source changed during collection; discard evidence")
    wall = [float(trial["wall_ms"]) for trial in trials]
    cpu = [float(trial["cpu_ms"]) for trial in trials]
    report = {
        "schema_version": 1,
        "classification": "diagnostic",
        "reference_host": False,
        "source_files": source,
        "source_hash": source_hash,
        "collected_at": started,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "command": ["python3", "bench/performance/t116-startup.py", sys.argv[1]],
        "environment": {
            "platform": platform.platform(),
            "kernel": platform.release(),
            "machine": platform.machine(),
            "cpu_count": os.cpu_count(),
            "python": platform.python_version(),
            "bun": subprocess.run([bun, "--version"], cwd=ROOT, check=True, capture_output=True, text=True).stdout.strip(),
            "working_directory": str(ROOT),
        },
        "protocol": {
            "boundary": "process spawn to XI_WORKBENCH_READY",
            "workload": "PF11-startup-warm",
            "sampling": "30 fresh PTY processes, filesystem-warm fixture",
            "fixture": "hello\\n",
        },
        "trials": trials,
        "summary": {
            "wall_ms": {"p50": nearest_rank(wall, 0.50), "p95": nearest_rank(wall, 0.95), "p99": nearest_rank(wall, 0.99), "max": max(wall)},
            "cpu_ms": {"p50": nearest_rank(cpu, 0.50), "p95": nearest_rank(cpu, 0.95), "p99": nearest_rank(cpu, 0.99), "max": max(cpu)},
        },
        "limitations": [
            "Shared diagnostic VM; no dedicated reference host or physical key-to-photon capture.",
            "The marker is process/PTY readiness, not calibrated visible pixels.",
            "This producer measures PF11 startup only; it does not fill the T106/T115 matrix.",
        ],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report["summary"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
