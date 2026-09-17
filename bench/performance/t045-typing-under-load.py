#!/usr/bin/env python3
"""Diagnostic ordinary-key latency through the production Xi PTY while search/navigation
services are actively running in the background (T045's own "profile navigation/search under
typing load" step).

This mirrors bench/performance/t116-key-output.py's own idle-latency protocol exactly (same
key-to-first-output-byte boundary, same 30-sample diagnostic sampling, same report schema and
the same honest "diagnostic, not reference_host" classification) but adds a genuinely active
background workload: a real workspace search left open and continuously re-querying (via
distinct queries sent between latency samples) while ordinary navigation keystrokes are timed.

This is explicitly NOT the certified AGENTS.md keystroke-latency gate (that requires a
dedicated reference host and a paired Neovim comparison on identical hardware -- T106/T115's
scope, hardware-gated and unavailable in this shared sandboxed VM). It is a diagnostic
snapshot of whether ordinary typing visibly degrades while search is actively working, run
once, on this shared machine, and reported as such.
"""
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
import sys
import tempfile
import termios
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MARKER = b"XI_WORKBENCH_READY"
SOURCE_FILES = (
    "apps/xi/src/main.ts",
    "packages/services/navigation/index.ts",
    "packages/services/src/entrypoints/launch-core.ts",
    "packages/ui/editor/motion-paint.ts",
    "packages/ui/src/terminal.ts",
    "packages/ui/src/workbench.ts",
    "packages/workbench/session/index.ts",
    "packages/workbench/vim-session/index.ts",
    "packages/vim/src/entrypoints/launch.ts",
)


def source_digests() -> dict[str, str]:
    return {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in SOURCE_FILES}


def percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * quantile) - 1)]


def run_trial(workspace: Path, home: Path) -> list[float]:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    environment = os.environ.copy()
    environment.update({"TERM": "xterm-256color", "HOME": str(home), "XI_UI_TEST_MARKERS": "1"})
    child = subprocess.Popen(
        ["bun", "run", str(ROOT / "apps/xi/src/main.ts"), "target.txt"],
        cwd=workspace,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
    )
    os.close(slave)
    captured = bytearray()

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
        while MARKER not in captured and time.monotonic() < deadline:
            read_once(0.05)
        if MARKER not in captured:
            raise RuntimeError("Xi did not reach XI_WORKBENCH_READY")
        time.sleep(0.25)
        while read_once(0):
            pass

        # Open a real workspace search and let its first query settle -- this is a genuine
        # RealtimeSearchService instance actively scanning the fixture files, not a mock.
        os.write(master, b" /")
        deadline = time.monotonic() + 5
        while b"XI_SEARCH_OPEN" not in captured and time.monotonic() < deadline:
            read_once(0.05)
        os.write(master, b"line")
        deadline = time.monotonic() + 5
        while b'"state":"ready"' not in captured and time.monotonic() < deadline:
            read_once(0.05)
        while read_once(0):
            pass

        # Move focus back to the editor while search stays open in the background, then
        # interleave ordinary keystrokes with distinct re-queries (each forcing a fresh
        # background scan) and measure key-to-first-output-byte latency throughout.
        os.write(master, b"\x1b")
        while read_once(0):
            pass
        queries = [b"line 1", b"line 2", b"line 3", b"line 5", b"line 7", b"line 9"]
        samples: list[float] = []
        for index in range(30):
            if index % 5 == 0:
                os.write(master, b" /")
                time.sleep(0.1)
                read_once(0.1)
                query = queries[(index // 5) % len(queries)]
                os.write(master, query)
                time.sleep(0.3)
                read_once(0.3)
                os.write(master, b"\x1b")
                time.sleep(0.2)
                read_once(0.2)
                while read_once(0):
                    pass
            started = time.perf_counter_ns()
            os.write(master, b"j")
            if read_once(2) == 0:
                raise RuntimeError("Xi produced no terminal output for ordinary j under search load")
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


def main() -> int:
    if len(sys.argv) != 2:
        raise ValueError("usage: t045-typing-under-load.py OUTPUT.json")
    output = (ROOT / sys.argv[1]).resolve()
    if output.exists() or not output.is_relative_to(ROOT):
        raise ValueError("output must be a new repository-relative path")
    bun = shutil.which("bun")
    if bun is None:
        raise ValueError("bun is required")
    sources = source_digests()
    source_hash = hashlib.sha256(json.dumps(sources, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    with tempfile.TemporaryDirectory(prefix="xi-t045-typing-load-") as temporary:
        workspace = Path(temporary) / "workspace"
        workspace.mkdir()
        home = Path(temporary) / "home"
        home.mkdir()
        (workspace / "target.txt").write_text("\n".join(f"line {index} value" for index in range(200)) + "\n", encoding="utf-8")
        for fixture_index in range(20):
            (workspace / f"other{fixture_index}.txt").write_text(
                "\n".join(f"line {index} in file {fixture_index}" for index in range(200)) + "\n", encoding="utf-8"
            )
        samples = run_trial(workspace, home)
    report = {
        "schema_version": 1,
        "classification": "diagnostic",
        "reference_host": False,
        "source_files": sources,
        "source_hash": source_hash,
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "command": ["python3", "bench/performance/t045-typing-under-load.py", sys.argv[1]],
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
            "workload": "T045 typing-load profiling: a real, actively re-querying workspace search open in the background (21 fixture files, ~200 lines each), re-queried every 5th sample",
            "sampling": "30 sequential events after one fresh production launch, interleaved with 6 distinct background search re-queries",
            "fixture": "21 files, ~200 lines each, 120x40 PTY",
            "note": "PTY arrival is diagnostic output evidence; it is not physical key-to-photon capture or the certified AGENTS.md keystroke-latency gate (T106/T115, hardware-gated).",
        },
        "summary_ms": {
            "p50": percentile(samples, 0.50),
            "p95": percentile(samples, 0.95),
            "p99": percentile(samples, 0.99),
            "max": max(samples),
        },
        "samples_ms": samples,
        "limitations": [
            "Shared diagnostic VM; no dedicated reference host, no paired Neovim comparison, no physical capture.",
            "This is a 30-event diagnostic probe under one specific background-search workload, not a full loaded-interaction matrix (T106/T115's scope).",
            "The first PTY bytes are not a parsed correctness frame and cannot establish visual response.",
        ],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report["summary_ms"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
