#!/usr/bin/env python3
"""Measure sequential CLI key-to-correct-cell latency on a real PTY."""
from __future__ import annotations

import argparse
import fcntl
import json
import math
import os
import platform
import pty
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "e2e"))
from terminal_screen import Screen  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def percentile(samples: list[float], quantile: float) -> float:
    ordered = sorted(samples)
    return ordered[max(0, math.ceil(len(ordered) * quantile) - 1)]


def measure(pairs: int, file_bytes: int, command: list[str], capture: Path | None = None, nvim: bool = False) -> dict:
    with tempfile.TemporaryDirectory(prefix="xi-input-latency-") as temporary:
        workspace = Path(temporary)
        source = workspace / "main.txt"
        initial = b"seed\n" + b"line data\n" * math.ceil((file_bytes - 5) / 10)
        source.write_bytes(initial)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
        environment = {key: value for key, value in os.environ.items() if not key.startswith(("XI_", "OTUI_", "HELIX_", "NVIM_"))}
        environment.update({"HOME": temporary, "TERM": "xterm-256color", "COLORTERM": "truecolor", "LC_ALL": "C.UTF-8", "XI_UI_TEST_MARKERS": "1"})
        for name in ("CONFIG", "DATA", "CACHE", "STATE"):
            environment[f"XDG_{name}_HOME"] = str(workspace / name.lower())
        child = subprocess.Popen([*command, "main.txt"], cwd=workspace, env=environment, stdin=slave, stdout=slave, stderr=subprocess.PIPE)
        os.close(slave)
        assert child.stderr is not None
        screen = Screen(24, 100)
        diagnostics = bytearray()
        output_bytes = 0
        parse_ns = 0
        output_chunks = 0
        captured = bytearray()

        def pump(timeout: float) -> int | None:
            nonlocal output_bytes, parse_ns, output_chunks
            arrived = None
            for descriptor in select.select([master, child.stderr.fileno()], [], [], timeout)[0]:
                try:
                    data = os.read(descriptor, 65536)
                except OSError:
                    data = b""
                if descriptor == master:
                    arrived = time.perf_counter_ns()
                    output_bytes += len(data)
                    output_chunks += 1
                    if capture is not None and len(captured) < 250_000:
                        captured.extend(data[:250_000 - len(captured)])
                    screen.feed(data)
                    parse_ns += time.perf_counter_ns() - arrived
                else:
                    diagnostics.extend(data)
            return arrived

        def wait_for(predicate, seconds: float = 2) -> int:
            deadline = time.monotonic() + seconds
            arrived = time.perf_counter_ns()
            while not predicate() and time.monotonic() < deadline:
                arrived = pump(0.001) or arrived
            if not predicate():
                raise RuntimeError(f"terminal did not reach expected cells: row={screen.row_text(1)!r} status={screen.row_text(24)!r} stderr={diagnostics[-1000:]!r}")
            return arrived

        samples: list[float] = []
        key_output_bytes: list[int] = []
        try:
            wait_for(lambda: "seed" in screen.row_text(1) and (nvim or b"XI_WORKBENCH_READY" in diagnostics), 5)
            os.write(master, b"i")
            wait_for(lambda: ("INSERT" if nvim else "INS") in screen.row_text(24))
            for _ in range(pairs):
                before_output = output_bytes
                started = time.perf_counter_ns()
                os.write(master, b"z")
                arrived = wait_for(lambda: "zseed" in screen.row_text(1))
                samples.append((arrived - started) / 1e6)
                key_output_bytes.append(output_bytes - before_output)
                before_output = output_bytes
                started = time.perf_counter_ns()
                os.write(master, b"\x7f")
                arrived = wait_for(lambda: "seed" in screen.row_text(1) and "zseed" not in screen.row_text(1))
                samples.append((arrived - started) / 1e6)
                key_output_bytes.append(output_bytes - before_output)
            rss_kib = next(int(line.split()[1]) for line in Path(f"/proc/{child.pid}/status").read_text().splitlines() if line.startswith("VmRSS:"))
            os.write(master, b"\x1b")
            if not nvim:
                wait_for(lambda: "NOR" in screen.row_text(24))
            os.write(master, b":wq\r")
            child.wait(timeout=5)
            saved = source.read_bytes()
            if child.returncode != 0 or saved != initial:
                raise RuntimeError(f"editor/save result changed: exit={child.returncode} expected_bytes={len(initial)} actual_bytes={len(saved)}")
            if capture is not None:
                capture.write_bytes(captured)
            return {"samples": len(samples), "p50_ms": percentile(samples, .5), "p95_ms": percentile(samples, .95), "p99_ms": percentile(samples, .99), "max_ms": max(samples), "all_ms": samples, "terminal_output_bytes": output_bytes, "terminal_output_chunks": output_chunks, "key_output_bytes": key_output_bytes, "screen_parse_ms": round(parse_ns / 1e6, 3), "rss_kib": rss_kib}
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--pairs", type=int, default=50)
    parser.add_argument("--file-bytes", type=int, default=5)
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--nvim", action="store_true")
    parser.add_argument("--capture", type=Path)
    parser.add_argument("--output", type=Path)
    arguments = parser.parse_args()
    if arguments.pairs < 1 or arguments.file_bytes < 5:
        parser.error("--pairs must be positive and --file-bytes must be at least 5")
    command = (["nvim", "--clean", "--cmd", "set noswapfile"] if arguments.nvim else [str(arguments.binary.resolve())] if arguments.binary is not None else ["bun", "run", str(ROOT / "apps/xi/src/main.ts")])
    actual_bytes = 5 + 10 * math.ceil((arguments.file_bytes - 5) / 10)
    report = {"platform": platform.platform(), "cpu_count": os.cpu_count(), "command": command, "boundary": "PTY write to observed document cell after each insert/delete", "scenario": f"default features, {actual_bytes}-byte file, 100x24 xterm-256color", **measure(arguments.pairs, arguments.file_bytes, command, arguments.capture, arguments.nvim)}
    if arguments.output is not None:
        arguments.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key not in ("all_ms", "key_output_bytes")}, indent=2))
