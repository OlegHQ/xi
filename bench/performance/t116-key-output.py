#!/usr/bin/env python3
"""Diagnostic ordinary-key latency through the production Xi PTY."""
from __future__ import annotations

import fcntl
import hashlib
import json
import math
import os
import platform
import pty
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[2]
MARKER = b"XI_WORKBENCH_READY"
SOURCE_FILES = (
    "apps/xi/src/main.ts",
    "packages/document/src/entrypoints/launch.ts",
    "packages/layout/src/index.ts",
    "packages/platform/src/entrypoints/launch.ts",
    "packages/platform/src/filesystem.ts",
    "packages/platform/src/process.ts",
    "packages/services/src/entrypoints/launch-core.ts",
    "packages/ui/editor/motion-paint.ts",
    "packages/ui/src/terminal.ts",
    "packages/ui/src/workbench.ts",
    "packages/workbench/src/entrypoints/launch.ts",
    "packages/workbench/src/read-model.ts",
    "packages/workbench/session/index.ts",
    "packages/workbench/vim-session/index.ts",
    "packages/vim/src/entrypoints/launch.ts",
)


def source_digests() -> dict[str, str]:
    return {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in SOURCE_FILES}


def percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * quantile) - 1)]


def run_trial(path: Path, home: Path) -> list[float]:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": str(home), "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", "apps/xi/src/main.ts", str(path)],
        cwd=ROOT,
        env=environment,
        stdin=slave,
        stdout=slave,
        # stderr is NOT the PTY slave: XI_UI_TEST_MARKERS writes markers (e.g.
        # XI_WORKBENCH_READY, XI_EX_COMMANDLINE_STATE) synchronously to stderr, ahead of the
        # actual rendered frame. Sharing the slave would let a marker satisfy a read before the
        # real terminal output arrives, measuring key->marker instead of key->terminal output.
        # Route stderr to its own pipe, drained on a background thread, and time only stdout
        # bytes read from the PTY master.
        stderr=subprocess.PIPE,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()  # stdout only, via the PTY master.
    stderr_captured = bytearray()
    stderr_lock = threading.Lock()

    def drain_stderr() -> None:
        assert child.stderr is not None
        fd = child.stderr.fileno()
        while True:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            with stderr_lock:
                stderr_captured.extend(chunk)

    stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
    stderr_thread.start()

    def stderr_has_marker() -> bool:
        with stderr_lock:
            return MARKER in stderr_captured

    def read_once(timeout: float) -> int:
        readable, _, _ = select.select([master], [], [], timeout)
        if not readable:
            return 0
        try:
            chunk = os.read(master, 65536)
        except OSError:
            return 0
        captured.extend(chunk)
        return len(chunk)

    try:
        deadline = time.monotonic() + 10
        while not stderr_has_marker() and time.monotonic() < deadline:
            read_once(0.05)
        if not stderr_has_marker():
            raise RuntimeError("Xi did not reach XI_WORKBENCH_READY")
        time.sleep(0.25)
        while read_once(0):
            pass
        samples: list[float] = []
        for _ in range(30):
            started = time.perf_counter_ns()
            os.write(master, b"j")
            # An empty ack cannot count: require the timed stdout bytes to contain a cursor
            # escape sequence (or any other CSI-introduced update), not just any byte.
            saw_escape = False
            chunk_deadline = time.monotonic() + 2
            while time.monotonic() < chunk_deadline:
                if read_once(max(0.0, chunk_deadline - time.monotonic())) == 0:
                    break
                if b"\x1b[" in captured:
                    saw_escape = True
                    break
            if not saw_escape:
                raise RuntimeError("Xi produced no terminal escape output for ordinary j")
            samples.append((time.perf_counter_ns() - started) / 1_000_000)
            time.sleep(0.005)
            while read_once(0):
                pass
        os.write(master, b"q")
        child.wait(timeout=5)
        if child.returncode != 0:
            raise RuntimeError(f"Xi exited {child.returncode}")
        return samples
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
        if child.stderr is not None:
            child.stderr.close()
        stderr_thread.join(timeout=1)


def main() -> int:
    if len(sys.argv) != 2:
        raise ValueError("usage: t116-key-output.py OUTPUT.json")
    output = (ROOT / sys.argv[1]).resolve()
    if output.exists() or not output.is_relative_to(ROOT):
        raise ValueError("output must be a new repository-relative path")
    bun = shutil.which("bun")
    if bun is None:
        raise ValueError("bun is required")
    sources = source_digests()
    source_hash = hashlib.sha256(json.dumps(sources, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    with tempfile.TemporaryDirectory(prefix="xi-t116-key-output-") as temporary:
        home = Path(temporary) / "home"
        home.mkdir()
        fixture = Path(temporary) / "input.txt"
        fixture.write_text("\n".join(f"line {index} value" for index in range(100)) + "\n", encoding="utf-8")
        samples = run_trial(fixture, home)
    report = {
        "schema_version": 1,
        "classification": "diagnostic",
        "reference_host": False,
        "source_files": sources,
        "source_hash": source_hash,
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "command": ["python3", "bench/performance/t116-key-output.py", sys.argv[1]],
        "environment": {
            "platform": platform.platform(),
            "kernel": platform.release(),
            "machine": platform.machine(),
            "cpu_count": os.cpu_count(),
            "python": platform.python_version(),
            "bun": subprocess.run([bun, "--version"], cwd=ROOT, check=True, capture_output=True, text=True).stdout.strip(),
        },
        "protocol": {
            "boundary": "ordinary j write to first subsequent PTY bytes",
            "workload": "PF01 small source, loaded idle services",
            "sampling": "30 sequential events after one fresh production launch",
            "fixture": "100 ASCII lines, 120x40 PTY",
            "note": "PTY arrival is diagnostic output evidence; it is not physical key-to-photon capture or full qualification.",
        },
        "summary_ms": {
            "p50": percentile(samples, 0.50),
            "p95": percentile(samples, 0.95),
            "p99": percentile(samples, 0.99),
            "max": max(samples),
        },
        "samples_ms": samples,
        "limitations": [
            "Shared diagnostic VM; no dedicated reference host, loaded service flood, open-loop schedule or physical capture.",
            "This is a 30-event diagnostic probe, not the required 10,000-event, 30-session matrix.",
            "The first PTY bytes are not a parsed correctness frame and cannot establish visual response.",
        ],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report["summary_ms"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
